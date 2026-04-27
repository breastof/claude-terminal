const pty = require("node-pty");
const fs = require("fs");
const path = require("path");
const { execSync, execFileSync, spawn } = require("child_process");

// ── tmux configuration ──
const TMUX_SOCKET = "claude-terminal";
const TMUX_CONF = path.join(__dirname, "tmux.conf");

// ── WS debug logger ──
// Set CT_WS_DEBUG=1 in env to log every WS attach + raw byte chunks to
// /root/projects/claude-terminal/logs/ws-debug.log. Helps diagnose
// "часть переписки исчезла" / "снимки в истории" by capturing the
// exact byte stream the client receives. Truncated to 16 KB per write
// to keep the log readable.
const WS_DEBUG = process.env.CT_WS_DEBUG === "1";
const WS_DEBUG_LOG = path.join(__dirname, "logs", "ws-debug.log");

function wsLog(tag, sessionId, payload) {
  if (!WS_DEBUG) return;
  try {
    const head = typeof payload === "string"
      ? payload.length > 16384 ? payload.slice(0, 16384) + `…[+${payload.length - 16384}]` : payload
      : `<bytes:${payload?.length || 0}>`;
    const line = `${new Date().toISOString()} [${tag}] ${sessionId} | ` +
      head.replace(/\x1b/g, "\\x1b").replace(/\r/g, "\\r").replace(/\n/g, "\\n") + "\n";
    fs.appendFileSync(WS_DEBUG_LOG, line);
  } catch {
    /* logger must never throw */
  }
}

function tmuxHasSession(sessionId) {
  try {
    execSync(`tmux -L ${TMUX_SOCKET} has-session -t "${sessionId}" 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
}

function tmuxPaneAlive(sessionId) {
  try {
    const output = execSync(
      `tmux -L ${TMUX_SOCKET} list-panes -t "${sessionId}" -F "#{pane_dead}" 2>/dev/null`,
      { encoding: "utf-8" }
    ).trim();
    return output === "0";
  } catch {
    return false;
  }
}

// Alt-screen sequences (\x1b[?1049h/l etc) are passed through to the
// browser xterm. Apps like claude code, vim, htop run in the alt screen
// and use absolute cursor moves keyed to that buffer. Stripping the
// toggles kept xterm stuck in the normal buffer while live updates
// landed at coordinates only meaningful in the alt buffer — only the
// rows the app actively rewrote (status line) appeared updated, the
// rest looked stale and overlaid. The new replay (tmuxSnapshot) emits
// the matching \x1b[?1049h prefix when the pane is in alt-screen so
// the client lands in the same buffer the live stream targets.

function tmuxCapture(sessionId, lines = -1) {
  // lines = -1 → capture full history (`-S -`); otherwise last N lines.
  const start = lines < 0 ? "-" : `-${lines}`;
  try {
    return execSync(
      `tmux -L ${TMUX_SOCKET} capture-pane -t "${sessionId}" -p -e -S ${start} 2>/dev/null`,
      { encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 }
    );
  } catch {
    return "";
  }
}

// New snapshot helper for the reliable-streaming path (plan §3.5).
// Returns a self-contained replay payload + cursor + alt-screen state.
// Uses execFileSync to avoid shell-injection on sessionId.
function tmuxSnapshot(sessionId) {
  // 1. Detect alt-screen state
  let altOn = false;
  try {
    const out = execFileSync(
      "tmux",
      ["-L", TMUX_SOCKET, "display-message", "-t", sessionId, "-p", "#{alternate_on}"],
      { encoding: "utf-8" }
    ).trim();
    altOn = out === "1";
  } catch {
    /* default false */
  }

  // 2. Capture pane — FULL history (user wants to scroll back through past
  //    conversation turns, not just see the current screen).
  //    - `-S -` = from start of scrollback (oldest)
  //    - `-E -` = to end (newest visible)
  //    - `-J` = join wrapped lines (avoids reflow artifacts)
  //    - `-e` = include ANSI escape sequences (colors etc)
  //    - `-a` (alt-on only) = grab alternate buffer for TUI apps in alt-screen
  //
  //    NOTE: tmux history-limit is now capped at 1000 lines (tmux.conf) to
  //    bound the size of the duplication mess Claude Code's normal-screen
  //    TUI redraws produce. A proper fix requires either intercepting
  //    Claude Code's clear sequences (complex) or persuading Claude Code
  //    to use alt-screen mode (would need an upstream change).
  const captureArgs = [
    "-L", TMUX_SOCKET,
    "capture-pane", "-t", sessionId,
    "-p", "-e", "-J", "-S", "-", "-E", "-",
  ];
  if (altOn) captureArgs.push("-a");
  let raw = "";
  try {
    raw = execFileSync("tmux", captureArgs, {
      encoding: "utf-8",
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    raw = "";
  }

  // 3. CRLF-normalise (xterm.js doesn't set convertEol)
  const body = raw.replace(/(?<!\r)\n/g, "\r\n");

  // 4. Cursor position (best-effort)
  let cx = 0, cy = 0;
  try {
    const cur = execFileSync(
      "tmux",
      ["-L", TMUX_SOCKET, "display-message", "-t", sessionId, "-p", "#{cursor_x},#{cursor_y}"],
      { encoding: "utf-8" }
    ).trim().split(",").map((n) => parseInt(n, 10));
    if (Number.isFinite(cur[0]) && Number.isFinite(cur[1])) {
      cx = cur[0];
      cy = cur[1];
    }
  } catch {
    /* default 0,0 */
  }

  // 5. Tmux pane geometry (informational; client letterboxes)
  let cols = 200, rows = 50;
  try {
    const dims = execFileSync(
      "tmux",
      ["-L", TMUX_SOCKET, "display-message", "-t", sessionId, "-p", "#{pane_width},#{pane_height}"],
      { encoding: "utf-8" }
    ).trim().split(",").map((n) => parseInt(n, 10));
    if (Number.isFinite(dims[0]) && Number.isFinite(dims[1])) {
      cols = dims[0];
      rows = dims[1];
    }
  } catch {
    /* defaults */
  }

  // Do NOT prepend \x1b[?1049h even if tmux says the pane is in alt-screen.
  // We want xterm to stay in the normal buffer so scrollback accumulates and
  // touch-scroll has something to move through. Alt-buffer = no scrollback.
  // The PTY stream now has alt-screen toggles stripped (see _setupPty above)
  // so the live updates also land in the normal buffer — keeping snapshot
  // and live in the same buffer regime.
  const cleanBody = body
    .replace(/\x1b\[\?1049[hl]/g, "")
    .replace(/\x1b\[\?1047[hl]/g, "")
    .replace(/\x1b\[\?47[hl]/g, "");
  return {
    data: "\x1b[2J\x1b[H" + cleanBody + `\x1b[${cy + 1};${cx + 1}H`,
    cursor: { x: cx, y: cy },
    cols,
    rows,
    alternate: altOn,
  };
}

// Allowlist of safe env vars for PTY sessions.
// NEVER spread process.env — it leaks JWT_SECRET, SMTP_PASS, etc.
const SAFE_ENV_KEYS = [
  "HOME", "USER", "LOGNAME", "SHELL", "PATH",
  "LANG", "LC_ALL", "LC_CTYPE", "LANGUAGE",
  "EDITOR", "VISUAL", "PAGER",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR",
  "HOSTNAME", "TMPDIR", "TZ",
  // Proxy (needed for codex, etc.)
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY",
  "https_proxy", "http_proxy", "no_proxy",
  "NODE_OPTIONS",
];

const PTY_ENV = {
  TERM: "xterm-256color",
  COLORTERM: "truecolor",
  CLAUDECODE: "",
  DISPLAY: ":99",
};

for (const key of SAFE_ENV_KEYS) {
  if (process.env[key]) PTY_ENV[key] = process.env[key];
}

const DATA_DIR = path.join(process.env.HOME || "/root", "projects", "Claude");
const SESSIONS_FILE = path.join(DATA_DIR, ".sessions.json");

// Build env string for tmux session command
function buildEnvPrefix() {
  return Object.entries(PTY_ENV)
    .map(([k, v]) => `${k}='${v.replace(/'/g, "'\\''")}'`)
    .join(" ");
}

// Validate command string: no shell metacharacters
function validateCommand(cmd) {
  if (/[;|&$`\\]/.test(cmd)) {
    throw new Error("Command contains forbidden shell metacharacters");
  }
}

// Attach node-pty to an existing tmux session
function attachTmux(sessionId, cols = 120, rows = 40, cwd) {
  return pty.spawn("tmux", [
    "-L", TMUX_SOCKET, "-f", TMUX_CONF,
    "attach-session", "-t", sessionId,
  ], {
    name: "xterm-256color",
    cols,
    rows,
    cwd: cwd || process.env.HOME || "/root",
    env: PTY_ENV,
  });
}

class TerminalManager {
  constructor() {
    this.sessions = new Map();
    this.ephemeralSessions = new Map();
    this._watchCallback = null;
    this._loadSessions();              // Load known sessions FIRST
    this._cleanupOrphanedTmux();       // THEN clean orphans not in the loaded set
    this._reconnectTmuxSessions();
    this._backfillHooksConfig();       // Prepare hook settings for existing sessions
    this._watchSessionsFile();
  }

  // Factory: shape every restored/loaded session uniformly.
  _makeSession(entry) {
    return {
      pty: null,
      projectDir: entry.projectDir,
      connectedClients: new Set(),
      createdAt: new Date(entry.createdAt),
      lastActivityAt: entry.lastActivityAt
        ? new Date(entry.lastActivityAt)
        : new Date(entry.createdAt),
      buffer: "",
      exited: true,                              // updated by _reconnectTmuxSessions
      displayName: entry.displayName || null,
      providerSlug: entry.providerSlug || "claude",
      cols: 200,
      rows: 50,
    };
  }

  _saveSessions() {
    const data = [];
    for (const [id, session] of this.sessions) {
      data.push({
        sessionId: id,
        projectDir: session.projectDir,
        createdAt: session.createdAt,
        lastActivityAt: session.lastActivityAt || session.createdAt,
        displayName: session.displayName,
        providerSlug: session.providerSlug || "claude",
      });
    }
    try {
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
    } catch {
      // Ignore write errors
    }
  }

  _loadSessions() {
    try {
      const raw = fs.readFileSync(SESSIONS_FILE, "utf-8");
      const data = JSON.parse(raw);
      for (const entry of data) {
        // Only restore if the project directory still exists
        if (fs.existsSync(entry.projectDir)) {
          this.sessions.set(entry.sessionId, this._makeSession(entry));
        }
      }
    } catch {
      // No saved sessions or corrupt file — start fresh
    }
  }

  // Check tmux sessions that survived server restart — lazy re-attach
  // Does NOT spawn node-pty here. PTY is attached lazily when a client connects
  // via attachToSession(). This prevents dual-attach during blue-green deploy overlap.
  _reconnectTmuxSessions() {
    for (const [sessionId, session] of this.sessions) {
      if (session.exited && tmuxHasSession(sessionId)) {
        if (!tmuxPaneAlive(sessionId)) {
          // tmux session exists but pane is dead — clean up
          console.log(`> Dead tmux pane: ${sessionId} — killing session`);
          try {
            execSync(`tmux -L ${TMUX_SOCKET} kill-session -t "${sessionId}" 2>/dev/null`);
          } catch {}
          continue;
        }
        session.exited = false;
        // Pre-capture buffer so first client gets history immediately
        session.buffer = tmuxCapture(sessionId, -1) || "";
        console.log(`> tmux session alive: ${sessionId} (PTY will attach on client connect)`);
      }
    }
  }

  // Kill tmux sessions not tracked in .sessions.json
  _cleanupOrphanedTmux() {
    try {
      const output = execSync(
        `tmux -L ${TMUX_SOCKET} list-sessions -F "#{session_name}" 2>/dev/null`,
        { encoding: "utf-8" }
      );
      const tmuxSessions = output.trim().split("\n").filter(Boolean);
      const knownIds = new Set(this.sessions.keys());

      for (const tmuxName of tmuxSessions) {
        if (!knownIds.has(tmuxName)) {
          console.log(`> Killing orphaned tmux session: ${tmuxName}`);
          try {
            execSync(`tmux -L ${TMUX_SOCKET} kill-session -t "${tmuxName}" 2>/dev/null`);
          } catch {}
        }
      }
    } catch {
      // No tmux server running — nothing to clean
    }
  }

  // Watch .sessions.json for changes from another instance (blue-green deploy)
  _watchSessionsFile() {
    try {
      this._watchCallback = () => {
        this._syncFromDisk();
      };
      fs.watchFile(SESSIONS_FILE, { interval: 2000 }, this._watchCallback);
    } catch {
      // Ignore watch errors
    }
  }

  // Cleanup: remove file watcher and heartbeat interval (call from server.js graceful shutdown)
  destroy() {
    if (this._watchCallback) {
      fs.unwatchFile(SESSIONS_FILE, this._watchCallback);
      this._watchCallback = null;
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  _syncFromDisk() {
    try {
      const raw = fs.readFileSync(SESSIONS_FILE, "utf-8");
      const data = JSON.parse(raw);
      for (const entry of data) {
        if (!this.sessions.has(entry.sessionId) && fs.existsSync(entry.projectDir)) {
          const session = this._makeSession(entry);

          // Check if tmux session exists with alive pane (created by another instance)
          if (tmuxHasSession(entry.sessionId) && tmuxPaneAlive(entry.sessionId)) {
            session.exited = false;
            session.buffer = tmuxCapture(entry.sessionId, -1) || "";
            console.log(`> Synced tmux session from disk: ${entry.sessionId} (lazy)`);
          }

          this.sessions.set(entry.sessionId, session);
        }
      }
    } catch {}
  }

  _markBusy(session, sessionId, durationMs) {
    session.busy = true;
    session.lastActivityAt = new Date();
    if (!this._lastActivitySave || Date.now() - this._lastActivitySave > 60000) {
      this._lastActivitySave = Date.now();
      this._saveSessions();
    }
    if (session.busyTimer) clearTimeout(session.busyTimer);
    session.busyTimer = setTimeout(() => {
      session.busy = false;
      session.busyTimer = null;
    }, durationMs);
  }

  _setupPty(session, sessionId) {
    const ptyProcess = session.pty;
    // Grace-окно после PTY-attach: tmux переигрывает историю буфера и/или
    // CLI показывает приветствие — это не «работа». Продлеваем окно пока
    // идут байты (пауза 1с между чанками → grace закончилось), cap 15с.
    session.attachedAt = Date.now();
    session.graceEndsAt = Date.now() + 2500;

    ptyProcess.onData((rawData) => {
      // Strip alternate-screen toggles BEFORE anything else sees them.
      // Claude Code (and any TUI app) emits \x1b[?1049h to enter alt-screen
      // and \x1b[?1049l to leave. The alt buffer in xterm by design has NO
      // SCROLLBACK — touch-scroll and wheel-scroll have nothing to move
      // through, even though every redraw lands cleanly. The user can SEE
      // history (Claude TUI redraws cover the same conversation) but can't
      // scroll back to past frames.
      //
      // By rewriting the toggles away the entire stream stays in the normal
      // buffer. Each Claude redraw cycle still uses cursor-home + write,
      // which overwrites the visible region in place, but the previous
      // frames push into normal scrollback as fossils — exactly what the
      // user wants ("вся история, чтобы можно было пальцем поскроллить").
      //
      // Also strip the older \x1b[?47h/l and \x1b[?1047h/l variants for
      // good measure — same semantic, less common.
      const data = rawData
        .replace(/\x1b\[\?1049[hl]/g, "")
        .replace(/\x1b\[\?1047[hl]/g, "")
        .replace(/\x1b\[\?47[hl]/g, "");
      if (!data) return;

      // Продление grace-окна пока летят байты после reattach (капаем на 15с от
      // attach). Busy/waiting detection делается в _pollBusy() — он читает
      // полный буфер tmux, а не инкрементальные ANSI-чанки из onData.
      const now = Date.now();
      if (now < (session.graceEndsAt || 0)) {
        const maxEnd = (session.attachedAt || now) + 15000;
        session.graceEndsAt = Math.min(now + 1500, maxEnd);
      }

      // Accumulate live data — this is the PRIMARY snapshot replay source
      // on reconnect (preferred over a fresh tmux capture-pane to avoid
      // double-fossilising Claude Code's normal-screen TUI redraws).
      // 500 KB cap = roughly the last 5-10k visible cells worth of stream,
      // bounded so a long-lived session doesn't grow without limit.
      session.buffer += data;
      if (session.buffer.length > 500000) {
        session.buffer = session.buffer.slice(-500000);
      }
      wsLog("LIVE", sessionId, data);
      for (const client of session.connectedClients) {
        if (client.readyState === 1) {
          client.send(JSON.stringify({ type: "output", data }));
        }
      }
    });

    ptyProcess.onExit(() => {
      session.pty = null;

      if (tmuxHasSession(sessionId)) {
        // tmux still alive — our attachment just died (server restart, deploy, etc.)
        // Don't mark as exited. Clients will auto-reconnect and get a new PTY attachment.
        console.log(`> PTY detached from tmux ${sessionId} (tmux still alive)`);
      } else {
        session.exited = true;
        const exitEnvelope = { type: "exit", exitCode: 0, signal: 0 };
        for (const client of session.connectedClients) {
          if (client.readyState === 1) {
            client.send(JSON.stringify(exitEnvelope));
          }
        }
      }
    });
  }

  createSession(providerSlug = "claude", customProjectDir = null) {
    // Look up provider from DB
    const db = global.db;
    const provider = db.prepare("SELECT * FROM cli_providers WHERE slug = ?").get(providerSlug);
    if (!provider) {
      throw new Error(`Provider "${providerSlug}" not found`);
    }

    const now = new Date();
    const pad = (n) => n.toString().padStart(2, "0");
    const sessionId = [
      pad(now.getDate()),
      pad(now.getMonth() + 1),
      now.getFullYear(),
      pad(now.getHours()),
      pad(now.getMinutes()),
      pad(now.getSeconds()),
    ].join("-");

    let projectDir;
    if (customProjectDir) {
      const resolved = path.resolve(customProjectDir);
      const home = process.env.HOME || "/home/user1";
      if (!resolved.startsWith(home + path.sep) && resolved !== home) {
        throw new Error("projectDir must be inside HOME");
      }
      if (!fs.existsSync(resolved)) {
        throw new Error("projectDir does not exist");
      }
      if (!fs.statSync(resolved).isDirectory()) {
        throw new Error("projectDir is not a directory");
      }
      projectDir = resolved;
      // Remove stale hook-state from a previous session in this dir
      try { fs.unlinkSync(path.join(projectDir, ".claude", "state.json")); } catch {}
    } else {
      projectDir = path.join(DATA_DIR, sessionId);
      fs.mkdirSync(projectDir, { recursive: true });
    }
    this._ensureHooksConfig(projectDir);

    validateCommand(provider.command);
    const command = provider.command;
    const envPrefix = buildEnvPrefix();

    // Create tmux session with the CLI command
    try {
      execSync(
        `tmux -L ${TMUX_SOCKET} -f ${TMUX_CONF} new-session -d -s "${sessionId}" -x 120 -y 40 -c "${projectDir}" -- env ${envPrefix} ${command}`,
        { stdio: ["pipe", "pipe", "pipe"] }
      );
    } catch (err) {
      throw new Error(`Failed to create tmux session: ${err.message}`);
    }

    // Attach node-pty to the tmux session
    const ptyProcess = attachTmux(sessionId, 120, 40, projectDir);

    const session = {
      pty: ptyProcess,
      projectDir,
      connectedClients: new Set(),
      createdAt: now,
      lastActivityAt: now,
      buffer: "",
      exited: false,
      displayName: null,
      providerSlug,
      cols: 120,
      rows: 40,
    };

    this._setupPty(session, sessionId);
    this.sessions.set(sessionId, session);
    this._saveSessions();
    return { sessionId, projectDir };
  }

  resumeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return { ok: false, error: "not_found" };
    if (!session.exited) return { ok: false, error: "already_active" };

    // Clean up any leftover tmux session
    if (tmuxHasSession(sessionId)) {
      try {
        execSync(`tmux -L ${TMUX_SOCKET} kill-session -t "${sessionId}" 2>/dev/null`);
      } catch {}
    }

    // Re-apply hooks config — перезаписывает наши hook-entry свежим путём
    this._ensureHooksConfig(session.projectDir);

    // Удаляем stale-стейт от предыдущего запуска
    try { fs.unlinkSync(path.join(session.projectDir, ".claude", "state.json")); } catch {}

    // Look up provider for resume command
    const db = global.db;
    const provider = db.prepare("SELECT * FROM cli_providers WHERE slug = ?").get(session.providerSlug || "claude");

    let command;
    if (provider && provider.resume_command) {
      validateCommand(provider.resume_command);
      command = provider.resume_command;
    } else if (provider) {
      validateCommand(provider.command);
      command = provider.command;
    } else {
      command = "/bin/bash";
    }

    const envPrefix = buildEnvPrefix();

    // Create new tmux session with the resume command
    try {
      execSync(
        `tmux -L ${TMUX_SOCKET} -f ${TMUX_CONF} new-session -d -s "${sessionId}" -x 120 -y 40 -c "${session.projectDir}" -- env ${envPrefix} ${command}`,
        { stdio: ["pipe", "pipe", "pipe"] }
      );
    } catch (err) {
      return { ok: false, error: `tmux: ${err.message}` };
    }

    // Attach node-pty — use last known client geometry if available so the
    // resumed pane doesn't snap back to 120×40 and force a re-render cascade.
    const ptyProcess = attachTmux(sessionId, session.cols || 120, session.rows || 40, session.projectDir);

    session.pty = ptyProcess;
    session.exited = false;
    session.buffer = "";
    session.busy = false;
    session.waiting = false;
    session._lastHookAt = 0;
    if (session.busyTimer) { clearTimeout(session.busyTimer); session.busyTimer = null; }

    this._setupPty(session, sessionId);

    return { ok: true };
  }

  stopSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || session.exited) return false;

    // Kill the tmux session (kills CLI inside it)
    if (tmuxHasSession(sessionId)) {
      try {
        execSync(`tmux -L ${TMUX_SOCKET} kill-session -t "${sessionId}" 2>/dev/null`);
      } catch {}
    }

    // Also kill the node-pty attachment
    if (session.pty) {
      try { session.pty.kill(); } catch {}
    }

    session.exited = true;
    session.busy = false;
    session.waiting = false;
    if (session.busyTimer) { clearTimeout(session.busyTimer); session.busyTimer = null; }
    return true;
  }

  attachToSession(sessionId, ws) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      ws.send(JSON.stringify({ type: "error", message: "Session not found" }));
      ws.close();
      return;
    }

    // Pre-empt uncaught WS error crashes.
    ws.on("error", () => {});

    // ── Attach order matters: snapshot MUST be sent BEFORE this ws joins
    //    the broadcast set, otherwise live bytes that fire between
    //    connectedClients.add(ws) and tmuxSnapshot() get sent first, then
    //    the snapshot's \x1b[2J\x1b[H clears them, and the user sees
    //    "часть переписки исчезла". WS messages are TCP-ordered, so by
    //    sending snapshot first then adding to the broadcast we guarantee
    //    each byte arrives at the client exactly once and in order. ──

    // Lazy PTY attachment: if tmux is alive but no node-pty is attached,
    // spawn PTY now (first client to connect gets it). Note: connectedClients
    // is still empty at this point, so any pty.on('data') firing during
    // setup is a no-op for fan-out — the snapshot below captures the same
    // state.
    if (!session.exited && !session.pty && tmuxHasSession(sessionId)) {
      if (!tmuxPaneAlive(sessionId)) {
        console.log(`> Dead tmux pane on attach: ${sessionId} — cleaning up`);
        try {
          execSync(`tmux -L ${TMUX_SOCKET} kill-session -t "${sessionId}" 2>/dev/null`);
        } catch {}
        session.exited = true;
      } else {
        try {
          session.buffer = tmuxCapture(sessionId, -1) || session.buffer;
          const ptyProcess = attachTmux(sessionId, session.cols || 120, session.rows || 40, session.projectDir);
          session.pty = ptyProcess;
          this._setupPty(session, sessionId);
          console.log(`> Lazy PTY attached to tmux: ${sessionId}`);
        } catch (err) {
          if (session.pty) {
            try { session.pty.kill(); } catch {}
            session.pty = null;
          }
          console.error(`> Failed to lazy-attach PTY to tmux ${sessionId}:`, err.message);
        }
      }
    }

    wsLog("ATTACH", sessionId, `exited=${session.exited} hasTmux=${tmuxHasSession(sessionId)} bufferLen=${session.buffer?.length || 0}`);

    // Replay history. PRIMARY = session.buffer (the live byte-stream
    // accumulator from pty.onData). FALLBACK = tmuxSnapshot.
    //
    // Why buffer beats snapshot: tmux's capture-pane reads the FINAL state
    // of the pane (with all of Claude Code's normal-screen TUI redraws
    // already fossilised into tmux scrollback). Sending that AND letting
    // live bytes continue produces 2× of every Claude Code redraw — the
    // "kal из надоженных друг на друга снапшотов" the user reports. The
    // buffer is a single linear copy of what already streamed: replaying
    // it gives the client the same view it would have had if it never
    // disconnected, no double-fossilisation.
    try {
      if (!session.exited && session.buffer && session.buffer.length > 0) {
        wsLog("REPLAY-BUFFER", sessionId, session.buffer);
        ws.send(JSON.stringify({ type: "output", data: session.buffer }));
      } else if (!session.exited && tmuxHasSession(sessionId)) {
        // Buffer empty — first-ever attach with no live data accumulated yet.
        // Bootstrap from tmux capture so the user sees current pane content.
        const snap = tmuxSnapshot(sessionId);
        if (snap && snap.data) {
          wsLog("SNAPSHOT-BOOTSTRAP", sessionId, snap.data);
          ws.send(JSON.stringify({ type: "output", data: snap.data }));
        }
      } else if (session.buffer) {
        wsLog("REPLAY-EXITED", sessionId, session.buffer);
        ws.send(JSON.stringify({ type: "output", data: session.buffer }));
      }
    } catch {
      if (session.buffer) {
        try { ws.send(JSON.stringify({ type: "output", data: session.buffer })); } catch {}
      }
    }

    session.connectedClients.add(ws);

    if (session.exited) {
      try { ws.send(JSON.stringify({ type: "stopped" })); } catch {}
    }

    ws.on("message", (rawMessage) => {
      try {
        const message = JSON.parse(rawMessage.toString());
        switch (message.type) {
          case "input":
            if (!session.exited && session.pty) {
              // echoUntil was previously set here but never read anywhere —
              // dead state, removed.
              session.waiting = false;
              session.lastActivityAt = new Date();
              const data = message.data ?? "";
              if (data.length > 1 || data.includes("\r") || data.includes("\n")) {
                console.log(`[input] writing to pty: ${data.length}b "${data.slice(0, 60).replace(/\r/g, "\\r").replace(/\n/g, "\\n")}"`);
              }
              session.pty.write(data);
            } else {
              console.log(`[input] DROPPED: sessionExited=${session.exited} ptyAlive=${!!session.pty}`);
            }
            break;
          case "resize": {
            // Clamp: clients may transiently send cols=1 while their container
            // is still laying out (FitAddon on a 0×N div). Such a resize used
            // to propagate all the way to tmux pane and stick — every char
            // ended up on its own line. Floor at 20×5; reject anything below.
            const cols = Math.max(0, parseInt(message.cols, 10) || 0);
            const rows = Math.max(0, parseInt(message.rows, 10) || 0);
            if (cols < 20 || rows < 5) break;
            session.cols = cols;
            session.rows = rows;
            if (!session.exited && session.pty) {
              try { session.pty.resize(cols, rows); } catch {}
            }
            break;
          }
          case "image": {
            // Browser clipboard bridge: receive base64 image and put it into X11 clipboard
            const imgData = Buffer.from(message.data, "base64");
            try {
              // Kill previous xclip for THIS session (tracked by PID)
              if (session._xclipPid) {
                try { process.kill(session._xclipPid); } catch {}
                session._xclipPid = null;
              }

              // Spawn xclip async — it stays alive as daemon serving clipboard
              const xclipProc = spawn('xclip', ['-selection', 'clipboard', '-t', 'image/png'], {
                env: { ...process.env, DISPLAY: ':99' },
                stdio: ['pipe', 'ignore', 'pipe'],
              });

              session._xclipPid = xclipProc.pid;

              let xclipError = '';
              xclipProc.stderr.on('data', (chunk) => { xclipError += chunk.toString(); });

              xclipProc.on('error', (err) => {
                ws.send(JSON.stringify({ type: "output", data: `\r\n\x1b[31m✗ xclip error: ${err.message}\x1b[0m\r\n` }));
              });

              // Pipe image data to xclip stdin and close
              xclipProc.stdin.end(imgData);

              // After xclip takes clipboard ownership, send Ctrl+V to PTY
              setTimeout(() => {
                if (xclipError) {
                  ws.send(JSON.stringify({ type: "output", data: `\r\n\x1b[31m✗ xclip: ${xclipError}\x1b[0m\r\n` }));
                  return;
                }
                if (!session.exited && session.pty) {
                  session.pty.write('\x16');
                }
              }, 200);
            } catch (err) {
              ws.send(JSON.stringify({ type: "output", data: `\r\n\x1b[31m✗ Ошибка clipboard: ${err.message}\x1b[0m\r\n` }));
            }
            break;
          }
          case "submit": {
            // Atomic submit: server orchestrates image clipboard staging + text + Enter
            // in the correct order with proper timing, eliminating client-side sleep guessing.
            //
            // Protocol: { type: "submit", text: string, images: string[] (base64 PNG) }
            //
            // CRITICAL: serialised via session._submitQueue. If two submits arrive
            // back-to-back, the second waits for the first to fully resolve. Without
            // this queue, submit2's xclip would kill submit1's xclip mid-paste via
            // the shared session._xclipPid, scrambling the output (and explaining
            // "иногда одна картинка вставится вместо нескольких / иногда вообще
            // ничего").
            const submitText = typeof message.text === "string" ? message.text : "";
            const submitImages = Array.isArray(message.images) ? message.images : [];
            console.log(`[submit] received: textLen=${submitText.length} images=${submitImages.length} sessionExited=${session.exited} ptyAlive=${!!session.pty}`);

            if (!session.exited && session.pty) {
              session._submitQueue = (session._submitQueue || Promise.resolve())
                .then(async () => {
                  console.log(`[submit] starting work: textLen=${submitText.length} images=${submitImages.length}`);
                  for (let i = 0; i < submitImages.length; i++) {
                    const imgBase64 = submitImages[i];
                    console.log(`[submit] image ${i + 1}/${submitImages.length}: base64 length=${imgBase64?.length ?? 0}`);
                    let imgBuf;
                    try {
                      imgBuf = Buffer.from(imgBase64, "base64");
                    } catch {
                      continue; // skip malformed image
                    }

                    // Defensive: another path may have left an xclip alive.
                    if (session._xclipPid) {
                      try { process.kill(session._xclipPid); } catch {}
                      session._xclipPid = null;
                    }

                    // CRITICAL — xclip semantics correction:
                    // `xclip -i -selection clipboard` reads stdin, then STAYS
                    // ALIVE as the clipboard owner until another X11 client
                    // requests the selection (only then does xclip exit and
                    // emit the "close" event). Previously we awaited "close"
                    // BEFORE writing Ctrl+V to the PTY — but Ctrl+V is exactly
                    // what triggers the CLI's paste consumer to request the
                    // clipboard (which would close xclip). Classic deadlock —
                    // we'd hit the 5s timeout EVERY time, kill xclip, and the
                    // paste would be empty. That's the user's "5000ms лаг".
                    //
                    // Correct flow: spawn xclip, write image bytes, wait a
                    // short fixed delay (200ms) for it to settle into being
                    // the selection owner, then write Ctrl+V. The CLI's paste
                    // handler reads the clipboard which causes xclip to exit
                    // — we don't care about waiting for the close, we just
                    // give the CLI 150ms to render the placeholder.
                    const XCLIP_OWN_DELAY_MS = 200;
                    const PASTE_RENDER_DELAY_MS = 150;
                    await new Promise((resolve) => {
                      let xclipErr = "";
                      let xclipProc;
                      let resolved = false;
                      const finish = () => {
                        if (resolved) return;
                        resolved = true;
                        resolve();
                      };

                      try {
                        xclipProc = spawn("xclip", ["-selection", "clipboard", "-t", "image/png"], {
                          env: { ...process.env, DISPLAY: ":99" },
                          stdio: ["pipe", "ignore", "pipe"],
                        });
                      } catch (spawnErr) {
                        try { ws.send(JSON.stringify({ type: "output", data: `\r\n\x1b[31m✗ xclip spawn: ${spawnErr.message}\x1b[0m\r\n` })); } catch {}
                        return finish();
                      }

                      session._xclipPid = xclipProc.pid;
                      xclipProc.stderr.on("data", (chunk) => { xclipErr += chunk.toString(); });

                      xclipProc.on("error", (err) => {
                        try { ws.send(JSON.stringify({ type: "output", data: `\r\n\x1b[31m✗ xclip error: ${err.message}\x1b[0m\r\n` })); } catch {}
                        finish();
                      });

                      xclipProc.on("close", (code) => {
                        // xclip exited (CLI consumed clipboard, or we killed it).
                        // We log but do NOT block on this — the resolve() below
                        // happens on the timer regardless.
                        session._xclipPid = null;
                        console.log(`[submit] xclip exited: code=${code} stderr="${xclipErr.trim()}"`);
                        if (xclipErr && !resolved) {
                          try { ws.send(JSON.stringify({ type: "output", data: `\r\n\x1b[31m✗ xclip: ${xclipErr}\x1b[0m\r\n` })); } catch {}
                          finish();
                        }
                      });

                      try {
                        xclipProc.stdin.end(imgBuf);
                      } catch (writeErr) {
                        console.log(`[submit] xclip stdin write error: ${writeErr.message}`);
                        return finish();
                      }

                      // Give xclip a moment to register as clipboard owner,
                      // then poke the CLI with Ctrl+V. The CLI will request
                      // the clipboard, xclip will exit, we move on.
                      setTimeout(() => {
                        if (resolved) return;
                        if (!session.exited && session.pty) {
                          console.log(`[submit] writing Ctrl+V to pty (after ${XCLIP_OWN_DELAY_MS}ms own-delay)`);
                          try { session.pty.write("\x16"); } catch {}
                        }
                        // Give CLI a moment to render the paste placeholder
                        // before we move to the next image / text.
                        setTimeout(finish, PASTE_RENDER_DELAY_MS);
                      }, XCLIP_OWN_DELAY_MS);
                    });
                  }

                  // All images staged. Append text, then Enter — with a small
                  // gap between them. CRITICAL: writing "text\r" in a single
                  // pty.write call makes Claude CLI's input handler see the
                  // bytes as ONE paste event (multi-char chunk in one tick),
                  // which doesn't trigger submit. Splitting into two writes
                  // separated by ~50 ms makes Enter arrive as a separate
                  // keypress event → submit fires. Desktop already worked
                  // because xterm sends each typed char in its own ws frame
                  // (one byte per pty.write); we simulate that here.
                  if (!session.exited && session.pty) {
                    if (submitText) {
                      console.log(`[submit] writing text to pty: "${submitText.slice(0, 50)}${submitText.length > 50 ? "..." : ""}"`);
                      session.pty.write(submitText);
                      await new Promise((r) => setTimeout(r, 50));
                    }
                    if (submitText || submitImages.length > 0) {
                      console.log(`[submit] writing Enter (\\r) to pty as separate keypress`);
                      session.pty.write("\r");
                    }
                  } else {
                    console.log(`[submit] cannot write final: sessionExited=${session.exited} ptyAlive=${!!session.pty}`);
                  }
                  console.log(`[submit] done`);
                })
                .catch((err) => {
                  // Don't let one bad submit poison the queue for subsequent ones.
                  console.error("[submit] queue error:", err);
                });
            }
            break;
          }
        }
      } catch {
        // Ignore malformed messages
      }
    });

    ws.on("close", () => {
      session.connectedClients.delete(ws);
    });
  }

  deleteSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    // Safety: only auto-rm dirs we created ourselves under DATA_DIR.
    // If the session was opened in a user-chosen path, fall back to keep-files.
    const resolved = path.resolve(session.projectDir);
    if (!resolved.startsWith(DATA_DIR + path.sep)) {
      return this.deleteSessionKeepFiles(sessionId);
    }

    // Kill xclip process if alive
    if (session._xclipPid) {
      try { process.kill(session._xclipPid); } catch {}
      session._xclipPid = null;
    }

    // Kill tmux session if alive
    if (tmuxHasSession(sessionId)) {
      try {
        execSync(`tmux -L ${TMUX_SOCKET} kill-session -t "${sessionId}" 2>/dev/null`);
      } catch {}
    }

    if (!session.exited && session.pty) {
      try { session.pty.kill(); } catch {}
      session.exited = true;
    }

    for (const client of session.connectedClients) {
      if (client.readyState === 1) {
        try { client.send(JSON.stringify({ type: "exit", exitCode: 0, signal: 0 })); } catch {}
      }
      try { client.close(); } catch {}
    }

    try {
      fs.rmSync(session.projectDir, { recursive: true, force: true });
    } catch {
      // Directory might not exist
    }

    this.sessions.delete(sessionId);
    this._saveSessions();
    return true;
  }

  deleteSessionKeepFiles(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    // Kill xclip process if alive
    if (session._xclipPid) {
      try { process.kill(session._xclipPid); } catch {}
      session._xclipPid = null;
    }

    // Kill tmux session if alive
    if (tmuxHasSession(sessionId)) {
      try {
        execSync(`tmux -L ${TMUX_SOCKET} kill-session -t "${sessionId}" 2>/dev/null`);
      } catch {}
    }

    if (!session.exited && session.pty) {
      try { session.pty.kill(); } catch {}
      session.exited = true;
    }

    for (const client of session.connectedClients) {
      if (client.readyState === 1) {
        try { client.send(JSON.stringify({ type: "exit", exitCode: 0, signal: 0 })); } catch {}
      }
      try { client.close(); } catch {}
    }

    // Do NOT delete projectDir — keep files
    this.sessions.delete(sessionId);
    this._saveSessions();
    return true;
  }

  sessionHasFiles(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    try {
      const entries = fs.readdirSync(session.projectDir).filter((e) => !e.startsWith("."));
      return entries.length > 0;
    } catch {
      return false;
    }
  }

  renameSession(sessionId, newName) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const safeName = newName.replace(/[^a-zA-Zа-яА-ЯёЁ0-9\-_ ]/g, "").trim();
    if (!safeName) return null;

    session.displayName = safeName;
    this._saveSessions();
    return safeName;
  }

  getSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return {
      sessionId,
      projectDir: session.projectDir,
      isActive: !session.exited,
      providerSlug: session.providerSlug || "claude",
    };
  }

  // ── Ephemeral sessions (for provider wizard auth terminal) ──
  // These remain as direct node-pty — they're short-lived and non-critical

  createEphemeralSession() {
    if (this.ephemeralSessions.size >= 3) {
      throw new Error("Max ephemeral sessions reached (3)");
    }

    const id = `eph-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    const ptyProcess = pty.spawn("/bin/bash", [], {
      name: "xterm-256color",
      cols: 120,
      rows: 15,
      cwd: process.env.HOME || "/root",
      env: PTY_ENV,
    });

    const session = {
      pty: ptyProcess,
      connectedClients: new Set(),
      buffer: "",
      exited: false,
      createdAt: Date.now(),
    };

    // Auto-destroy after 5 minutes
    session._timeout = setTimeout(() => {
      this.destroyEphemeralSession(id);
    }, 5 * 60 * 1000);

    this._setupEphemeralPty(session);
    this.ephemeralSessions.set(id, session);
    return id;
  }

  // Separate setup for ephemeral sessions (no tmux check on exit)
  _setupEphemeralPty(session) {
    const ptyProcess = session.pty;

    ptyProcess.onData((data) => {
      session.buffer += data;
      if (session.buffer.length > 2000000) {
        session.buffer = session.buffer.slice(-2000000);
      }
      for (const client of session.connectedClients) {
        if (client.readyState === 1) {
          client.send(JSON.stringify({ type: "output", data }));
        }
      }
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      for (const client of session.connectedClients) {
        if (client.readyState === 1) {
          client.send(JSON.stringify({ type: "exit", exitCode, signal }));
        }
      }
      session.exited = true;
    });
  }

  attachToEphemeralSession(id, ws) {
    const session = this.ephemeralSessions.get(id);
    if (!session) {
      ws.send(JSON.stringify({ type: "error", message: "Ephemeral session not found" }));
      ws.close();
      return;
    }

    session.connectedClients.add(ws);

    if (session.buffer) {
      ws.send(JSON.stringify({ type: "output", data: session.buffer }));
    }

    ws.on("message", (rawMessage) => {
      try {
        const message = JSON.parse(rawMessage.toString());
        if (message.type === "input" && !session.exited) {
          // echoUntil removed — dead state.
          session.waiting = false;
          session.lastActivityAt = new Date();
          session.pty.write(message.data);
        } else if (message.type === "resize" && !session.exited) {
          const cols = Math.max(0, parseInt(message.cols, 10) || 0);
          const rows = Math.max(0, parseInt(message.rows, 10) || 0);
          if (cols >= 20 && rows >= 5) {
            try { session.pty.resize(cols, rows); } catch {}
          }
        }
      } catch {}
    });

    ws.on("close", () => {
      session.connectedClients.delete(ws);
    });
  }

  destroyEphemeralSession(id) {
    const session = this.ephemeralSessions.get(id);
    if (!session) return false;

    if (session._timeout) clearTimeout(session._timeout);

    if (!session.exited) {
      session.pty.kill();
      session.exited = true;
    }

    for (const client of session.connectedClients) {
      if (client.readyState === 1) {
        client.send(JSON.stringify({ type: "exit", exitCode: 0, signal: 0 }));
      }
      client.close();
    }

    this.ephemeralSessions.delete(id);
    return true;
  }

  _ensureHooksConfig(projectDir) {
    // Пишем в <projectDir>/.claude/settings.json хуки для отслеживания
    // busy/idle/waiting. Сохраняем существующие (если были) — только наши перезаписываем.
    const dir = path.join(projectDir, ".claude");
    const settingsPath = path.join(dir, "settings.json");
    const hookScript = path.join(__dirname, "hooks", "notify.js");

    let existing = {};
    try {
      existing = JSON.parse(fs.readFileSync(settingsPath, "utf8")) || {};
    } catch {}
    if (!existing.hooks || typeof existing.hooks !== "object") existing.hooks = {};

    const eventMap = [
      ["UserPromptSubmit", "busy"],
      ["Stop", "idle"],
      ["PermissionRequest", "waiting"],
    ];

    for (const [event, state] of eventMap) {
      const command = `${hookScript} ${state}`;
      // Удаляем наши старые entries (по пути к скрипту), сохраняем прочее
      const prior = Array.isArray(existing.hooks[event]) ? existing.hooks[event] : [];
      const kept = prior.filter((entry) => {
        if (!entry || !Array.isArray(entry.hooks)) return true;
        return !entry.hooks.some((h) => typeof h?.command === "string" && h.command.includes(hookScript));
      });
      kept.push({
        matcher: "*",
        hooks: [{ type: "command", command, async: true }],
      });
      existing.hooks[event] = kept;
    }

    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2));
    } catch (err) {
      console.error(`> Failed to write hooks config for ${projectDir}:`, err.message);
    }
  }

  _backfillHooksConfig() {
    for (const [, session] of this.sessions) {
      if (session.projectDir && fs.existsSync(session.projectDir)) {
        this._ensureHooksConfig(session.projectDir);
      }
    }
  }

  _readHookStates() {
    // Читаем <projectDir>/.claude/state.json для каждой активной сессии.
    // Hook пишет сюда на события UserPromptSubmit/Stop/PermissionRequest.
    for (const [, session] of this.sessions) {
      if (session.exited || !session.projectDir) continue;
      const stateFile = path.join(session.projectDir, ".claude", "state.json");
      try {
        const raw = fs.readFileSync(stateFile, "utf8");
        const parsed = JSON.parse(raw);
        const age = Date.now() - (parsed.at || 0);
        if (age > 3600000) continue; // старше часа — игнорируем (вдруг стейл)

        // Чтобы не перезаписывать тем же самым значением каждый тик,
        // сравниваем с предыдущим состоянием
        if (session._lastHookAt === parsed.at) continue;
        session._lastHookAt = parsed.at;

        // Любое hook-событие = реальная активность. Обновляем lastActivityAt
        // для сортировки и unread-детекции.
        session.lastActivityAt = new Date(parsed.at);
        if (!this._lastActivitySave || Date.now() - this._lastActivitySave > 60000) {
          this._lastActivitySave = Date.now();
          this._saveSessions();
        }

        if (parsed.state === "busy") {
          session.busy = true;
          session.waiting = false;
        } else if (parsed.state === "idle") {
          session.busy = false;
          session.waiting = false;
        } else if (parsed.state === "waiting") {
          session.waiting = true;
          session.busy = false;
        }
        if (session.busyTimer) { clearTimeout(session.busyTimer); session.busyTimer = null; }
      } catch {
        // Нет файла / невалидный JSON — пропускаем.
        // Для сессий где Claude ещё не перезапустился после установки хуков
        // состояние просто не меняется от автодетекции.
      }
    }
  }

  listSessions() {
    this._readHookStates();
    const result = [];
    for (const [id, session] of this.sessions) {
      let hasFiles = false;
      try {
        const entries = fs.readdirSync(session.projectDir).filter((e) => !e.startsWith("."));
        hasFiles = entries.length > 0;
      } catch {
        // Directory might not exist
      }
      result.push({
        sessionId: id,
        displayName: session.displayName || null,
        projectDir: session.projectDir,
        createdAt: session.createdAt,
        lastActivityAt: session.lastActivityAt || session.createdAt,
        isActive: !session.exited,
        busy: !!session.busy,
        waiting: !!session.waiting && !session.busy,
        connectedClients: session.connectedClients.size,
        hasFiles,
        providerSlug: session.providerSlug || "claude",
      });
    }
    return result;
  }
}

module.exports = { TerminalManager };
