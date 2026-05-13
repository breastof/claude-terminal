#!/usr/bin/env node
// Standalone title generator. Запускается detached из hooks/notify.js
// и переживает смерть родителя — поэтому close-handler здесь надёжно
// срабатывает и pending-маркер всегда либо превращается в title, либо
// удаляется.
//
// Использование:
//   node hooks/title-gen.js <cwd> <prompt-base64> [sessionId]
//
// sessionId опционален: если задан — пишем в title-<sessionId>.json,
// иначе legacy title.json. Нужно чтобы несколько сессий в одной папке
// не перезаписывали имя друг другу.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const cwd = process.argv[2];
const promptB64 = process.argv[3];
const sessionId = process.argv[4] || "";
if (!cwd || !promptB64) process.exit(2);

const dir = path.join(cwd, ".claude");
const titleFile = sessionId
  ? path.join(dir, `title-${sessionId}.json`)
  : path.join(dir, "title.json");
const logFile = path.join(dir, ".title.log");

let prompt;
try {
  prompt = Buffer.from(promptB64, "base64").toString("utf8");
} catch {
  cleanup();
  process.exit(2);
}

const promptForModel = prompt.length > 800 ? prompt.slice(0, 800) + "…" : prompt;
const systemPrompt = "Ты придумываешь очень короткие названия чатов на русском. Дай ОДНУ строку: 3-5 слов, без кавычек, без точки в конце, без двоеточия, смысловое ядро сообщения. Никаких пояснений, никакого preamble.";

const args = [
  "--print",
  "--model", "haiku",
  "--append-system-prompt", systemPrompt,
  promptForModel,
];

let logFd;
try {
  logFd = fs.openSync(logFile, "a");
} catch {
  logFd = "ignore";
}

// cwd: $HOME — чтобы не подхватить settings.json из сессионной папки и
// не запустить хуки рекурсивно (UserPromptSubmit на этом же claude → loop).
const child = spawn("claude", args, {
  cwd: os.homedir(),
  stdio: ["ignore", "pipe", logFd],
  env: process.env,
});

let out = "";
child.stdout.on("data", (chunk) => { out += chunk.toString(); });

// Жёсткий таймаут — если claude завис, через 60с убиваем и снимаем pending.
const killTimer = setTimeout(() => {
  try { child.kill("SIGTERM"); } catch {}
  setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5000);
}, 60_000);

child.on("close", (code) => {
  clearTimeout(killTimer);
  const title = sanitizeTitle(out);
  if (code === 0 && title) {
    try {
      fs.writeFileSync(titleFile, JSON.stringify({ title, at: Date.now() }));
    } catch {
      cleanup();
    }
  } else {
    cleanup();
  }
  process.exit(0);
});

child.on("error", () => {
  clearTimeout(killTimer);
  cleanup();
  process.exit(1);
});

function cleanup() {
  try { fs.unlinkSync(titleFile); } catch {}
}

function sanitizeTitle(raw) {
  if (!raw) return null;
  let s = raw.trim();
  s = s.replace(/^["'`«»\s]+|["'`«»\s]+$/g, "");
  const firstLine = s.split("\n").find((l) => l.trim().length > 0);
  if (!firstLine) return null;
  s = firstLine.trim();
  if (s.length > 60) {
    s = s.slice(0, 60).replace(/\s+\S*$/, "") + "…";
  }
  if (s.length < 2) return null;
  return s;
}
