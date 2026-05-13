#!/usr/bin/env node
// Claude Code hook → записывает состояние сессии в
//   <cwd>/.claude/state-<CT_SESSION_ID>.json   (per-session, если есть env)
//   <cwd>/.claude/state.json                   (legacy fallback)
// Без per-session файла несколько сессий, живущих в одной папке (yacht-club,
// book-ai-nontech и т.д.), переписывали единый state.json и красили друг
// друга busy-индикатором.
//
// Аргументы: busy | idle | waiting.
// stdin: JSON от Claude Code (нужен cwd и опционально prompt).
// ВСЕГДА exit 0 — нельзя блокировать пользователя.
//
// Дополнительно (только для busy = UserPromptSubmit): если ещё нет title
// у этой сессии — стартуем title-gen.js detached, который попросит Haiku
// придумать короткое имя чату.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const state = process.argv[2] || "unknown";
const sessionId = process.env.CT_SESSION_ID || "";

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  try {
    const payload = JSON.parse(raw || "{}");
    const cwd = payload.cwd;
    if (!cwd) return;
    const dir = path.join(cwd, ".claude");
    fs.mkdirSync(dir, { recursive: true });

    // 1. Записать state-файл — per-session если есть CT_SESSION_ID, иначе legacy.
    const stateFile = sessionId
      ? path.join(dir, `state-${sessionId}.json`)
      : path.join(dir, "state.json");
    const tmp = stateFile + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ state, at: Date.now() }));
    fs.renameSync(tmp, stateFile);

    // 2. На UserPromptSubmit — попробовать сгенерить название чата
    if (state === "busy") {
      maybeGenerateTitle(cwd, payload.prompt);
    }
  } catch {}
  process.exit(0);
});

// Защита от зависшего stdin
setTimeout(() => process.exit(0), 1500);

function maybeGenerateTitle(cwd, prompt) {
  const dir = path.join(cwd, ".claude");
  const titleFile = sessionId
    ? path.join(dir, `title-${sessionId}.json`)
    : path.join(dir, "title.json");

  // Существующий файл: настоящий title — выходим; pending свежий (<60с)
  // — тоже выходим; pending протухший — игнорируем и перегенерируем,
  // потому что title-gen.js мог тихо упасть и pending застрял навсегда.
  try {
    const existing = JSON.parse(fs.readFileSync(titleFile, "utf8"));
    if (existing && typeof existing.title === "string" && existing.title) return;
    if (existing && existing.pending && Date.now() - (existing.at || 0) < 60_000) return;
  } catch {
    // Файла нет / битый JSON — продолжаем генерить
  }

  if (!prompt || typeof prompt !== "string") return;
  const trimmed = prompt.trim();
  if (trimmed.length < 4) return;

  // Маркер «генерация в процессе» — защита от параллельных запусков.
  try {
    fs.writeFileSync(titleFile, JSON.stringify({ pending: true, at: Date.now() }));
  } catch {
    return;
  }

  // Промпт в base64 — чтобы спокойно пролетал через argv.
  const promptForArg = trimmed.length > 800 ? trimmed.slice(0, 800) + "…" : trimmed;
  const promptB64 = Buffer.from(promptForArg, "utf8").toString("base64");

  const wrapper = path.join(__dirname, "title-gen.js");
  // Detached — переживает exit notify.js и сам обработает close-event.
  // sessionId передаётся 4-м аргументом, чтобы title-gen писал в правильный файл.
  const child = spawn(process.execPath, [wrapper, cwd, promptB64, sessionId], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
}
