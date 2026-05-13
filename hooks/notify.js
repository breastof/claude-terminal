#!/usr/bin/env node
// Claude Code hook → записывает состояние сессии в <cwd>/.claude/state.json.
// Вызывается с одним из аргументов: busy | idle | waiting.
// На stdin получает JSON от Claude Code (нам нужно cwd и опционально prompt).
// ВАЖНО: всегда exit 0, чтобы не блокировать работу пользователя в Claude.
//
// Дополнительная задача (только для busy = UserPromptSubmit): если в .claude
// нет title.json и пришёл первый prompt — отдетачить процесс, который
// попросит Haiku дать короткое название чату и запишет в title.json.
// Сервер потом подхватит это название как displayName сессии.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const state = process.argv[2] || "unknown";

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

    // 1. Записать state.json (как раньше — атомарная запись через rename)
    const tmp = path.join(dir, ".state.json.tmp");
    const dst = path.join(dir, "state.json");
    fs.writeFileSync(tmp, JSON.stringify({ state, at: Date.now() }));
    fs.renameSync(tmp, dst);

    // 2. На UserPromptSubmit (state=busy) — попробовать сгенерить название
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
  const titleFile = path.join(dir, "title.json");
  // Уже сгенерили (или генерим) — выходим
  if (fs.existsSync(titleFile)) return;
  if (!prompt || typeof prompt !== "string") return;
  const trimmed = prompt.trim();
  if (trimmed.length < 4) return;

  // Сразу ставим маркер «генерация в процессе» — защита от повторных
  // запусков на быстрых подряд промптах. Стандалоновый title-gen.js
  // (запускается ниже detached) либо перепишет файл финальным title,
  // либо удалит pending при ошибке/таймауте.
  try {
    fs.writeFileSync(titleFile, JSON.stringify({ pending: true, at: Date.now() }));
  } catch {
    return;
  }

  // Обрезаем длинные промпты до 800 символов и кодируем base64, чтобы
  // безопасно передать через argv (newlines, кавычки, юникод).
  const promptForArg = trimmed.length > 800 ? trimmed.slice(0, 800) + "…" : trimmed;
  const promptB64 = Buffer.from(promptForArg, "utf8").toString("base64");

  const wrapper = path.join(__dirname, "title-gen.js");
  // Detached + унаследованная сессия (detached:true, stdio:ignore, unref) —
  // дочерний процесс переживает exit notify.js и сам обработает claude'овский
  // close-event, поэтому pending-маркер всегда снимается корректно.
  const child = spawn(process.execPath, [wrapper, cwd, promptB64], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
}
