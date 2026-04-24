#!/usr/bin/env node
// Claude Code hook → записывает состояние сессии в <cwd>/.claude/state.json.
// Вызывается с одним из аргументов: busy | idle | waiting.
// На stdin получает JSON от Claude Code (нам нужно только поле cwd).
// ВАЖНО: всегда exit 0, чтобы не блокировать работу пользователя в Claude.

const fs = require("fs");
const path = require("path");

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
    const tmp = path.join(dir, ".state.json.tmp");
    const dst = path.join(dir, "state.json");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ state, at: Date.now() }));
    fs.renameSync(tmp, dst);
  } catch {}
  process.exit(0);
});

// Защита от зависшего stdin
setTimeout(() => process.exit(0), 1500);
