"use strict";

/**
 * Proxy management — list/add/delete сохранённых прокси, активация роли
 * (primary | fallback) с записью в ~/.config/ai-proxy.env, тест через curl.
 *
 * Не делает SOCKS, не управляет system-wide прокси (.bashrc/with-proxy остаются
 * как есть). Скоуп ровно тот же, что у текущего ai-proxy.env — AI-инструменты
 * (Claude CLI, Anthropic SDK) через child PTY claude-terminal'а.
 *
 * При активации:
 *   1. Записываем PRIMARY_PROXY / FALLBACK_PROXY в ai-proxy.env (атомарно).
 *   2. Запускаем ~/bin/ai-proxy-pick (он перезаписывает HTTPS_PROXY/HTTP_PROXY
 *      в том же файле, выбирая живой прокси через 5с CONNECT-чек).
 *   3. Новые PTY-сессии подхватывают новый прокси сами — terminal-manager
 *      теперь читает ai-proxy.env при каждом spawn (см. buildPtyEnv).
 *      Старые открытые сессии живут на старом прокси до Stop+Resume или
 *      рестарта сервиса.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const { parseProxyString, serializeProxyUrl, maskProxyForDisplay } = require("./proxy-parse");

const ENV_FILE = path.join(os.homedir(), ".config", "ai-proxy.env");
const AI_PROXY_PICK = path.join(os.homedir(), "bin", "ai-proxy-pick");

const TEST_TARGET = "https://api.anthropic.com/";
const TEST_TIMEOUT_SEC = 5;

function execFileP(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: opts.timeout ?? 10_000, encoding: "utf-8", maxBuffer: 1024 * 1024, env: opts.env || process.env },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          stdout: (stdout || "").toString(),
          stderr: (stderr || "").toString(),
          exitCode: error && typeof error.code === "number" ? error.code : error ? 1 : 0,
        });
      }
    );
  });
}

class ProxyManager {
  constructor(db) {
    this.db = db;
    try {
      this._seedFromEnvFileIfEmpty();
    } catch (err) {
      console.error("[proxy-manager] seed failed:", err && err.message || err);
    }
  }

  /**
   * При первом запуске — импортируем существующие PRIMARY_PROXY и
   * FALLBACK_PROXY из ai-proxy.env в БД, чтобы UI показывал текущую
   * конфигурацию, а не пустой список. Делается ровно один раз: если в
   * БД уже есть хоть одна запись — пропускаем.
   */
  _seedFromEnvFileIfEmpty() {
    const count = this.db.prepare("SELECT COUNT(*) AS c FROM proxies").get();
    if (count && count.c > 0) return;

    let raw;
    try {
      raw = fs.readFileSync(ENV_FILE, "utf-8");
    } catch {
      return; // env-файла нет — нечего импортировать
    }

    const get = (key) => {
      const m = raw.match(new RegExp(`^${key}=(.+)$`, "m"));
      return m ? m[1].trim() : null;
    };

    const primaryUrl = get("PRIMARY_PROXY");
    const fallbackUrl = get("FALLBACK_PROXY");

    const insertOne = (url, label, isPrimary, isFallback) => {
      if (!url) return null;
      const parsed = parseProxyString(url);
      if (!parsed) return null;
      const result = this.db.prepare(
        "INSERT INTO proxies (label, host, port, login, password, is_primary, is_fallback) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(label, parsed.host, parsed.port, parsed.login, parsed.password, isPrimary ? 1 : 0, isFallback ? 1 : 0);
      return result.lastInsertRowid;
    };

    if (primaryUrl && fallbackUrl && primaryUrl === fallbackUrl) {
      // Один и тот же прокси в обеих ролях — одна запись с двумя флагами
      insertOne(primaryUrl, "Основной", true, true);
    } else {
      insertOne(primaryUrl, "Основной", true, false);
      insertOne(fallbackUrl, "Резервный", false, true);
    }
  }

  _row(p) {
    if (!p) return null;
    return {
      id: p.id,
      label: p.label,
      host: p.host,
      port: p.port,
      login: p.login || null,
      hasPassword: !!p.password,
      isPrimary: !!p.is_primary,
      isFallback: !!p.is_fallback,
      display: maskProxyForDisplay({ host: p.host, port: p.port, login: p.login, password: p.password }),
      createdAt: p.created_at,
    };
  }

  list() {
    const rows = this.db.prepare("SELECT * FROM proxies ORDER BY created_at DESC").all();
    return rows.map((r) => this._row(r));
  }

  get(id) {
    const row = this.db.prepare("SELECT * FROM proxies WHERE id = ?").get(id);
    return this._row(row);
  }

  /** Полные данные с паролем — только для внутреннего использования (write env, test). */
  _getRaw(id) {
    return this.db.prepare("SELECT * FROM proxies WHERE id = ?").get(id);
  }

  add({ label, raw }) {
    const parsed = parseProxyString(raw);
    if (!parsed) return { ok: false, error: "invalid_format" };
    const finalLabel = (label || "").trim() || `${parsed.host}:${parsed.port}`;
    const stmt = this.db.prepare(
      "INSERT INTO proxies (label, host, port, login, password) VALUES (?, ?, ?, ?, ?)"
    );
    const result = stmt.run(finalLabel, parsed.host, parsed.port, parsed.login, parsed.password);
    return { ok: true, id: result.lastInsertRowid };
  }

  remove(id) {
    const row = this._getRaw(id);
    if (!row) return { ok: false, error: "not_found" };
    this.db.prepare("DELETE FROM proxies WHERE id = ?").run(id);
    // Если удалили активный — env-файл остаётся со старыми значениями до
    // следующей активации; ai-proxy-pick при рестарте всё равно проверит CONNECT
    // и если строка мёртвая — сделает что может. Это не блокер.
    return { ok: true };
  }

  /** role: "primary" | "fallback" */
  async activate(id, role) {
    if (role !== "primary" && role !== "fallback") {
      return { ok: false, error: "invalid_role" };
    }
    const row = this._getRaw(id);
    if (!row) return { ok: false, error: "not_found" };

    // Снимаем флаг с других + ставим на этот атомарно
    const tx = this.db.transaction(() => {
      const col = role === "primary" ? "is_primary" : "is_fallback";
      this.db.prepare(`UPDATE proxies SET ${col} = 0`).run();
      this.db.prepare(`UPDATE proxies SET ${col} = 1 WHERE id = ?`).run(id);
    });
    tx();

    // Перезаписываем ai-proxy.env
    try {
      this._writeEnvFile();
    } catch (err) {
      return { ok: false, error: "env_write_failed", details: String(err && err.message || err) };
    }

    // Дёргаем ai-proxy-pick для обновления HTTPS_PROXY/HTTP_PROXY
    let pickResult = { ok: true, stdout: "", stderr: "" };
    if (fs.existsSync(AI_PROXY_PICK)) {
      pickResult = await execFileP(AI_PROXY_PICK, [], { timeout: 15_000 });
    }

    return {
      ok: true,
      pickStdout: pickResult.stdout,
      pickStderr: pickResult.stderr,
    };
  }

  _writeEnvFile() {
    // Берём текущий primary и fallback из БД. Если кого-то нет — оставляем
    // прежнее значение из файла (не затираем).
    const primary = this.db.prepare("SELECT * FROM proxies WHERE is_primary = 1 LIMIT 1").get();
    const fallback = this.db.prepare("SELECT * FROM proxies WHERE is_fallback = 1 LIMIT 1").get();

    let existing = "";
    try {
      existing = fs.readFileSync(ENV_FILE, "utf-8");
    } catch {
      // Файла нет — создадим с нуля
    }

    const currentLines = existing.split("\n");
    const setLine = (lines, key, value) => {
      const newLine = `${key}=${value}`;
      const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
      if (idx >= 0) {
        lines[idx] = newLine;
      } else {
        // Вставляем в начало (после комментариев) — но проще в конец
        lines.push(newLine);
      }
      return lines;
    };

    let lines = currentLines;
    if (primary) {
      const url = serializeProxyUrl({ host: primary.host, port: primary.port, login: primary.login, password: primary.password });
      lines = setLine(lines, "PRIMARY_PROXY", url);
      // HTTPS/HTTP_PROXY сразу синхронизируем на primary — ai-proxy-pick
      // потом при необходимости переключит на fallback после CONNECT-чека.
      lines = setLine(lines, "HTTPS_PROXY", url);
      lines = setLine(lines, "HTTP_PROXY", url);
    }
    if (fallback) {
      const url = serializeProxyUrl({ host: fallback.host, port: fallback.port, login: fallback.login, password: fallback.password });
      lines = setLine(lines, "FALLBACK_PROXY", url);
    }

    // Выкидываем подряд идущие пустые строки в конце
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

    const content = lines.join("\n") + "\n";
    const tmp = ENV_FILE + ".tmp";
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    fs.renameSync(tmp, ENV_FILE);
  }

  async test(id) {
    const row = this._getRaw(id);
    if (!row) return { ok: false, error: "not_found" };
    const url = serializeProxyUrl({ host: row.host, port: row.port, login: row.login, password: row.password });
    const start = Date.now();
    const result = await execFileP(
      "curl",
      [
        "-sS", "-o", "/dev/null",
        "--connect-timeout", String(TEST_TIMEOUT_SEC),
        "--max-time", String(TEST_TIMEOUT_SEC + 3),
        "-x", url,
        "-w", "%{http_code}",
        TEST_TARGET,
      ],
      { timeout: 15_000 }
    );
    const ms = Date.now() - start;
    const code = parseInt((result.stdout || "0").trim(), 10);
    // 200 = ok, 401/403 = auth/refused но прокси ответил → норм для нас
    // (важно что трафик прошёл), 0 = curl error.
    const ok = result.exitCode === 0 && code > 0 && code < 500;
    return { ok, code: Number.isFinite(code) ? code : null, ms, error: ok ? null : (result.stderr || "").trim().slice(0, 200) };
  }
}

module.exports = { ProxyManager };
