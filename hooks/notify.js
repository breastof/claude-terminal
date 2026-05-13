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

  // Сразу ставим маркер «генерация в процессе», чтобы повторные вызовы
  // (быстрые подряд промпты) не запускали несколько claude-процессов.
  // Маркер перепишется на финальное название по завершении.
  try {
    fs.writeFileSync(titleFile, JSON.stringify({ pending: true, at: Date.now() }));
  } catch {
    return;
  }

  // Обрезаем длинные промпты — Haiku хватит первых 800 символов.
  const promptForModel = trimmed.length > 800 ? trimmed.slice(0, 800) + "…" : trimmed;
  const systemPrompt = "Ты придумываешь очень короткие названия чатов на русском. Дай ОДНУ строку: 3-5 слов, без кавычек, без точки в конце, без двоеточия, смысловое ядро сообщения. Никаких пояснений, никакого preamble.";

  const args = [
    "--print",
    "--bare",
    "--model", "haiku",
    "--append-system-prompt", systemPrompt,
    promptForModel,
  ];

  // Detached child — родитель (hook) сразу exit 0, не блокирует Claude.
  const logFile = path.join(dir, ".title.log");
  let logFd;
  try {
    logFd = fs.openSync(logFile, "a");
  } catch {
    logFd = "ignore";
  }

  const child = spawn("claude", args, {
    detached: true,
    stdio: ["ignore", "pipe", logFd],
    env: { ...process.env, CLAUDE_CODE_SIMPLE: "1" },
  });

  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk.toString(); });
  child.on("close", (code) => {
    try {
      const title = sanitizeTitle(out);
      if (code === 0 && title) {
        fs.writeFileSync(titleFile, JSON.stringify({ title, at: Date.now() }));
      } else {
        // Не получилось — снимаем маркер, чтобы при следующем промпте
        // была ещё одна попытка.
        try { fs.unlinkSync(titleFile); } catch {}
      }
    } catch {}
  });
  child.on("error", () => {
    try { fs.unlinkSync(titleFile); } catch {}
  });

  child.unref();
}

function sanitizeTitle(raw) {
  if (!raw) return null;
  let s = raw.trim();
  // Убираем обрамляющие кавычки и обратные апострофы
  s = s.replace(/^["'`«»\s]+|["'`«»\s]+$/g, "");
  // Берём первую непустую строку (Haiku иногда добавляет лишний newline)
  const firstLine = s.split("\n").find((l) => l.trim().length > 0);
  if (!firstLine) return null;
  s = firstLine.trim();
  // Хард-капы: длиннее 60 символов — обрезаем по слову
  if (s.length > 60) {
    s = s.slice(0, 60).replace(/\s+\S*$/, "") + "…";
  }
  if (s.length < 2) return null;
  return s;
}
