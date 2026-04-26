const pty = require("node-pty");
const fs = require("fs");
const path = require("path");
const { execSync, execFileSync, spawn } = require("child_process");

// Reliable-streaming feature flag — see agent-workflow/05-decision-tmux.md and 06-integration-plan-tmux.md
// When "1": new chunk-list + per-client cursor + binary frames + ping/pong + eviction path.
// When unset/"0": legacy string-buffer + synchronous broadcast path (byte-for-byte unchanged).
const RELIABLE_STREAMING = process.env.CT_RELIABLE_STREAMING === "1";

// Eviction / backpressure constants (see plan §3.4, §3.7)
const CHUNK_BYTES_CAP = 2 * 1024 * 1024;        // 2 MiB total in chunk-list
const BUFFERED_CEILING = 8 * 1024 * 1024;       // 8 MiB per-client bufferedAmount cap
const HEARTBEAT_INTERVAL_MS = 25_000;           // ping cadence
const HELLO_TIMEOUT_MS = 2000;                  // AWAIT_HELLO timer (plan §2.7)

// Binary frame opcodes (plan §2.2)
const OPCODE_OUTPUT = 0x01;
const OPCODE_SNAPSHOT = 0x02;

// ── tmux configuration ──
const TMUX_SOCKET = "claude-terminal";
const TMUX_CONF = path.join(__dirname, "tmux.conf");

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

// Strip alternate screen sequences so xterm.js stays in normal buffer.
// tmux uses alt screen internally — but xterm.js needs normal buffer
// for scrollback to work (mouse wheel scroll through history).
const ALT_SCREEN_RE = /\x1b\[\?(1049|1047|47)[hl]/g;

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

  // 2. Capture pane (with -a if in alt-screen)
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

  return {
    data: "\x1b[2J\x1b[H" + body + `\x1b[${cy + 1};${cx + 1}H`,
    cursor: { x: cx, y: cy },
    cols,
    rows,
    alternate: altOn,
  };
}

// Binary frame encoders (plan §2.2)
function encodeBinaryFrame(opcode, seqBig, data) {
  const payload = Buffer.from(data, "utf-8");
  const frame = Buffer.allocUnsafe(9 + payload.length);
  frame.writeUInt8(opcode, 0);
  frame.writeBigUInt64BE(seqBig, 1);
  payload.copy(frame, 9);
  return frame;
}

function encodeBinaryOutput(seqBig, data) {
  return encodeBinaryFrame(OPCODE_OUTPUT, seqBig, data);
}

function encodeBinarySnapshot(seqBig, data) {
  return encodeBinaryFrame(OPCODE_SNAPSHOT, seqBig, data);
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
    this.reliableStreaming = RELIABLE_STREAMING;
    this.heartbeatInterval = null;
    // Observability counters (logged periodically)
    this.attachCounters = { v1: 0, v2: 0 };
    this.streamCounters = { fastPath: 0, slowPath: 0, evictions: 0, pingTerminations: 0 };
    this._loadSessions();              // Load known sessions FIRST
    this._cleanupOrphanedTmux();       // THEN clean orphans not in the loaded set
    this._reconnectTmuxSessions();
    this._backfillHooksConfig();       // Prepare hook settings for existing sessions
    this._watchSessionsFile();

    if (this.reliableStreaming) {
      // Ping/pong watchdog (plan §2.5). Cleared in destroy().
      this.heartbeatInterval = setInterval(() => this._heartbeatTick(), HEARTBEAT_INTERVAL_MS);
      if (this.heartbeatInterval.unref) this.heartbeatInterval.unref();
    }
  }

  // Factory: shape every restored/loaded session uniformly.
  // The new fields are allocated unconditionally (~200 B each) so the session shape
  // does not diverge between flag-on and flag-off processes.
  _makeSession(entry) {
    return {
      pty: null,
      projectDir: entry.projectDir,
      connectedClients: new Set(),               // legacy synchronous broadcast list
      createdAt: new Date(entry.createdAt),
      lastActivityAt: entry.lastActivityAt
        ? new Date(entry.lastActivityAt)
        : new Date(entry.createdAt),
      buffer: "",
      exited: true,                              // updated by _reconnectTmuxSessions
      displayName: entry.displayName || null,
      providerSlug: entry.providerSlug || "claude",
      // Reliable-streaming fields (plan §3.3) — populated only when flag is on
      chunks: [],
      chunkBytes: 0,
      totalSeq: 0n,
      prunedSeq: 0n,
      cols: 200,
      rows: 50,
      clients: new Map(),                        // Map<WebSocket, ClientRecord>
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
      // Strip alternate screen sequences — keeps xterm.js in normal buffer
      // so scrollback works. tmux still uses alt screen internally.
      const data = rawData.replace(ALT_SCREEN_RE, "");
      if (!data) return;

      // Продление grace-окна пока летят байты после reattach (капаем на 15с от
      // attach). Busy/waiting detection делается в _pollBusy() — он читает
      // полный буфер tmux, а не инкрементальные ANSI-чанки из onData.
      const now = Date.now();
      if (now < (session.graceEndsAt || 0)) {
        const maxEnd = (session.attachedAt || now) + 15000;
        session.graceEndsAt = Math.min(now + 1500, maxEnd);
      }

      // ── Legacy path (always runs; carries the string accumulator and the
      //    synchronous broadcast for legacy-attached clients) ──
      session.buffer += data;
      if (session.buffer.length > 2000000) {
        session.buffer = session.buffer.slice(-2000000);
      }
      for (const client of session.connectedClients) {
        if (client.readyState === 1) {
          client.send(JSON.stringify({ type: "output", data }));
        }
      }

      // ── New path (only fans out when reliable streaming is on AND there are
      //    clients in the new collection). Coexists with the legacy fan-out so
      //    a single session can serve both old and new attaches. ──
      if (this.reliableStreaming && session.clients && session.clients.size > 0) {
        const newChunk = this._pushChunk(session, data);
        for (const [, clientRec] of session.clients) {
          clientRec.queue.push(newChunk);
          if (!clientRec.drainScheduled) {
            clientRec.drainScheduled = true;
            setImmediate(() => this._drainClient(clientRec, session));
          }
        }
      } else if (this.reliableStreaming) {
        // No new-path clients — still maintain chunk list so a future attach
        // within the rolling window can FAST_PATH instead of SLOW_PATH.
        this._pushChunk(session, data);
      }
    });

    ptyProcess.onExit(() => {
      // node-pty (tmux attach) exited. Always clear PTY ref.
      session.pty = null;

      if (tmuxHasSession(sessionId)) {
        // tmux still alive — our attachment just died (server restart, deploy, etc.)
        // Don't mark as exited. Clients will auto-reconnect and get a new PTY attachment.
        console.log(`> PTY detached from tmux ${sessionId} (tmux still alive)`);
      } else {
        // tmux session gone — CLI actually exited
        session.exited = true;
        const exitEnvelope = { type: "exit", exitCode: 0, signal: 0 };
        for (const client of session.connectedClients) {
          if (client.readyState === 1) {
            client.send(JSON.stringify(exitEnvelope));
          }
        }
        if (this.reliableStreaming) {
          this._broadcastControlV2(session, exitEnvelope);
        }
      }
    });
  }

  // ── Reliable-streaming helpers (plan §3) ──

  // Append chunk, advance totalSeq, prune at chunk granularity to 2 MiB cap.
  // Returns the newly-added {seq, data} so the broadcaster can fan it out
  // without re-scanning session.chunks.
  _pushChunk(session, data) {
    const seq = session.totalSeq;
    const chunk = { seq, data };
    session.chunks.push(chunk);
    session.chunkBytes += data.length;
    session.totalSeq = session.totalSeq + BigInt(data.length);
    while (session.chunkBytes > CHUNK_BYTES_CAP && session.chunks.length > 1) {
      const evicted = session.chunks.shift();
      session.chunkBytes -= evicted.data.length;
      session.prunedSeq = evicted.seq + BigInt(evicted.data.length);
    }
    return chunk;
  }

  // Returns chunks where chunk.seq > lastSeqBig. Linear scan is acceptable —
  // chunk list is bounded by 2 MiB (≈256 entries at avg 8 KiB).
  _chunksSince(session, lastSeqBig) {
    const out = [];
    for (const chunk of session.chunks) {
      if (chunk.seq > lastSeqBig) out.push(chunk);
    }
    return out;
  }

  // Per-client async drain (plan §3.6). One slow client cannot block another.
  _drainClient(clientRec, session) {
    clientRec.drainScheduled = false;
    while (clientRec.queue.length > 0) {
      if (!clientRec.ws || clientRec.ws.readyState !== 1) {
        clientRec.queue = [];
        session.clients.delete(clientRec.ws);
        return;
      }
      if (clientRec.ws.bufferedAmount > BUFFERED_CEILING) {
        try { clientRec.ws.close(4503, "lagging"); } catch {}
        session.clients.delete(clientRec.ws);
        this.streamCounters.evictions++;
        return;
      }
      const chunk = clientRec.queue.shift();
      try {
        if (clientRec.binaryCapable) {
          clientRec.ws.send(encodeBinaryOutput(chunk.seq, chunk.data));
        } else {
          clientRec.ws.send(JSON.stringify({
            type: "output",
            seq: String(chunk.seq),
            data: chunk.data,
          }));
        }
      } catch {
        // Send failure: drop client (next tick will see readyState !== 1).
        clientRec.queue = [];
        session.clients.delete(clientRec.ws);
        return;
      }
      clientRec.lastSentSeq = chunk.seq;
    }
  }

  // Broadcast a JSON control envelope (exit / stopped / error) through the
  // SAME per-client drain so bufferedAmount/binaryCapable rules are honoured
  // (per plan §10.3 — no third broadcast pattern).
  _broadcastControlV2(session, envelope) {
    if (!session.clients) return;
    const text = JSON.stringify(envelope);
    for (const [, clientRec] of session.clients) {
      if (!clientRec.ws || clientRec.ws.readyState !== 1) continue;
      try { clientRec.ws.send(text); } catch {}
    }
  }

  // Heartbeat watchdog (plan §2.5): every 25 s, ping every tracked client.
  // If the prior tick's ping didn't get a pong, terminate. Iterates BOTH
  // session.clients (new path) and session.connectedClients (legacy path) —
  // protocol-level ping is transparent to the client, free upgrade for legacy.
  _heartbeatTick() {
    for (const [, session] of this.sessions) {
      if (session.clients) {
        for (const [, clientRec] of session.clients) {
          const ws = clientRec.ws;
          if (!ws) continue;
          if (clientRec.isAlive === false) {
            try { ws.terminate(); } catch {}
            session.clients.delete(ws);
            this.streamCounters.pingTerminations++;
            continue;
          }
          clientRec.isAlive = false;
          try { ws.ping(); } catch {}
        }
      }
      if (session.connectedClients) {
        for (const ws of session.connectedClients) {
          if (!ws || ws.readyState !== 1) continue;
          if (ws._ctIsAlive === false) {
            try { ws.terminate(); } catch {}
            continue;
          }
          ws._ctIsAlive = false;
          try { ws.ping(); } catch {}
        }
      }
    }
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
      // Reliable-streaming fields (plan §3.3)
      chunks: [],
      chunkBytes: 0,
      totalSeq: 0n,
      prunedSeq: 0n,
      cols: 120,
      rows: 40,
      clients: new Map(),
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

    // Attach node-pty
    const ptyProcess = attachTmux(sessionId, 120, 40, session.projectDir);

    session.pty = ptyProcess;
    session.exited = false;
    session.buffer = "";
    session.busy = false;
    session.waiting = false;
    session._lastHookAt = 0;
    if (session.busyTimer) { clearTimeout(session.busyTimer); session.busyTimer = null; }

    // Reset reliable-streaming chunk state on resume — new epoch.
    // session.clients (existing connections) is preserved; their next reconnect
    // will SLOW_PATH because their lastSeq is from the prior epoch (lastSeq >
    // new totalSeq = 0n).
    if (session.chunks) {
      session.chunks = [];
      session.chunkBytes = 0;
      session.totalSeq = 0n;
      session.prunedSeq = 0n;
    }

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

    this.attachCounters.v1++;
    // Pre-empt uncaught WS error crashes (WS scan §3.5).
    ws.on("error", () => {});
    // Heartbeat liveness flag for legacy clients (used by _heartbeatTick).
    ws._ctIsAlive = true;
    ws.on("pong", () => { ws._ctIsAlive = true; });

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
          const ptyProcess = attachTmux(sessionId, 120, 40, session.projectDir);
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

    // Replay snapshot — ANSI-safe full scrollback from tmux, prefixed with
    // \x1b[2J\x1b[H and suffixed with cursor restore. Sent BEFORE add to
    // broadcast (see comment above on attach order).
    if (!session.exited && tmuxHasSession(sessionId)) {
      try {
        const snap = tmuxSnapshot(sessionId);
        if (snap && snap.data) {
          ws.send(JSON.stringify({ type: "output", data: snap.data }));
        } else if (session.buffer) {
          ws.send(JSON.stringify({ type: "output", data: session.buffer }));
        }
      } catch {
        if (session.buffer) {
          ws.send(JSON.stringify({ type: "output", data: session.buffer }));
        }
      }
    } else if (session.buffer) {
      ws.send(JSON.stringify({ type: "output", data: session.buffer }));
    }

    // NOW join the broadcast set — every subsequent live chunk reaches us
    // strictly after the snapshot.
    session.connectedClients.add(ws);

    if (session.exited) {
      ws.send(JSON.stringify({ type: "stopped" }));
    }

    ws.on("message", (rawMessage) => {
      try {
        const message = JSON.parse(rawMessage.toString());
        switch (message.type) {
          case "input":
            if (!session.exited && session.pty) {
              session.echoUntil = Date.now() + 600;
              session.waiting = false;
              session.lastActivityAt = new Date();
              session.pty.write(message.data);
            }
            break;
          case "resize":
            if (!session.exited && session.pty && message.cols && message.rows) {
              session.pty.resize(message.cols, message.rows);
            }
            break;
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
        }
      } catch {
        // Ignore malformed messages
      }
    });

    ws.on("close", () => {
      session.connectedClients.delete(ws);
    });
  }

  // ── Reliable-streaming attach path (plan §2.7, §4.2) ──
  // Implements AWAIT_HELLO state machine, FAST_PATH (resume from chunk-list)
  // and SLOW_PATH (tmux capture-pane snapshot). Backwards-compatible with old
  // clients via 2 s timer + first-message-not-hello fallback.
  attachToSessionV2(sessionId, ws) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      try { ws.send(JSON.stringify({ type: "error", message: "Session not found" })); } catch {}
      try { ws.close(); } catch {}
      return;
    }

    this.attachCounters.v2++;
    ws.on("error", () => {});

    // Lazy PTY attachment (mirror legacy lines 478-503): if tmux is alive but
    // no node-pty is attached, spawn it now. This MUST happen before any
    // snapshot fork so capture-pane sees the live pane.
    if (!session.exited && !session.pty && tmuxHasSession(sessionId)) {
      if (!tmuxPaneAlive(sessionId)) {
        console.log(`> Dead tmux pane on attach (v2): ${sessionId} — cleaning up`);
        try {
          execSync(`tmux -L ${TMUX_SOCKET} kill-session -t "${sessionId}" 2>/dev/null`);
        } catch {}
        session.exited = true;
      } else {
        try {
          // Pre-warm legacy buffer too (non-V2 attaches may still occur on this session).
          session.buffer = tmuxCapture(sessionId, -1) || session.buffer;
          const ptyProcess = attachTmux(sessionId, session.cols || 200, session.rows || 50, session.projectDir);
          session.pty = ptyProcess;
          this._setupPty(session, sessionId);
          console.log(`> Lazy PTY attached to tmux (v2): ${sessionId}`);
        } catch (err) {
          if (session.pty) {
            try { session.pty.kill(); } catch {}
            session.pty = null;
          }
          console.error(`> Failed to lazy-attach PTY to tmux (v2) ${sessionId}:`, err.message);
        }
      }
    }

    // AWAIT_HELLO state. The first message must be "hello"; if not, treat as
    // legacy (binary_capable=false, lastSeq=0) and re-dispatch the message
    // through the steady-state handler.
    let helloHandled = false;
    let helloTimer = null;

    const fallbackToLegacy = () => {
      if (helloHandled) return;
      helloHandled = true;
      if (helloTimer) { clearTimeout(helloTimer); helloTimer = null; }
      const clientRec = this._registerClientV2(session, ws, { binary_capable: false, lastSeq: 0n });
      this._sendSnapshotPath(session, sessionId, clientRec);
      if (session.exited) {
        try { ws.send(JSON.stringify({ type: "stopped" })); } catch {}
      }
      this._wireSteadyStateHandlers(session, ws, sessionId, clientRec);
    };

    helloTimer = setTimeout(() => {
      // 2 s with no message at all — treat as legacy (e.g. silent old client).
      if (!helloHandled) fallbackToLegacy();
    }, HELLO_TIMEOUT_MS);
    if (helloTimer.unref) helloTimer.unref();

    const firstMessageHandler = (rawMessage) => {
      if (helloHandled) return;
      let message;
      try {
        message = JSON.parse(rawMessage.toString());
      } catch {
        // Malformed first frame — fall back to legacy treatment.
        ws.off("message", firstMessageHandler);
        fallbackToLegacy();
        return;
      }

      if (message && message.type === "hello") {
        helloHandled = true;
        if (helloTimer) { clearTimeout(helloTimer); helloTimer = null; }
        ws.off("message", firstMessageHandler);

        if (message.protocol_version !== 2) {
          console.warn(`[ct] hello with unsupported protocol_version=${message.protocol_version} — falling back`);
          const clientRec = this._registerClientV2(session, ws, { binary_capable: false, lastSeq: 0n });
          this._sendSnapshotPath(session, sessionId, clientRec);
          if (session.exited) {
            try { ws.send(JSON.stringify({ type: "stopped" })); } catch {}
          }
          this._wireSteadyStateHandlers(session, ws, sessionId, clientRec);
          return;
        }

        let lastSeqBig = 0n;
        try { lastSeqBig = BigInt(message.lastSeq || "0"); } catch { lastSeqBig = 0n; }
        const binaryCapable = message.binary_capable === true;

        const clientRec = this._registerClientV2(session, ws, { binary_capable: binaryCapable, lastSeq: lastSeqBig });

        // Route per plan §2.7
        if (
          session.totalSeq > 0n &&
          lastSeqBig >= session.prunedSeq &&
          lastSeqBig < session.totalSeq
        ) {
          this._sendResumePath(session, clientRec, lastSeqBig);
          this.streamCounters.fastPath++;
        } else {
          this._sendSnapshotPath(session, sessionId, clientRec);
          this.streamCounters.slowPath++;
        }

        if (session.exited) {
          try { ws.send(JSON.stringify({ type: "stopped" })); } catch {}
        }

        this._wireSteadyStateHandlers(session, ws, sessionId, clientRec);
        return;
      }

      // First message wasn't hello — register as legacy fallback then
      // re-dispatch this same message through the steady-state handler.
      ws.off("message", firstMessageHandler);
      helloHandled = true;
      if (helloTimer) { clearTimeout(helloTimer); helloTimer = null; }
      const clientRec = this._registerClientV2(session, ws, { binary_capable: false, lastSeq: 0n });
      this._sendSnapshotPath(session, sessionId, clientRec);
      if (session.exited) {
        try { ws.send(JSON.stringify({ type: "stopped" })); } catch {}
      }
      this._wireSteadyStateHandlers(session, ws, sessionId, clientRec);
      this._handleSteadyStateMessage(session, ws, sessionId, message);
    };

    ws.on("message", firstMessageHandler);

    ws.on("close", () => {
      if (helloTimer) { clearTimeout(helloTimer); helloTimer = null; }
      session.clients.delete(ws);
    });
  }

  // Add a ClientRecord to session.clients. Idempotent.
  _registerClientV2(session, ws, { binary_capable, lastSeq }) {
    const clientRec = {
      ws,
      lastSentSeq: lastSeq,
      queue: [],
      drainScheduled: false,
      binaryCapable: !!binary_capable,
      isAlive: true,
    };
    ws.on("pong", () => { clientRec.isAlive = true; });
    session.clients.set(ws, clientRec);
    return clientRec;
  }

  // FAST_PATH: send {resume, from} + chunks > lastSeq + {replay_complete}.
  // All sends bypass the per-client async drain (initial replay is one-shot
  // and ordering matters); subsequent live broadcasts go through the drain.
  _sendResumePath(session, clientRec, lastSeqBig) {
    const ws = clientRec.ws;
    if (!ws || ws.readyState !== 1) return;
    const fromBig = lastSeqBig + 1n;
    try {
      ws.send(JSON.stringify({ type: "resume", from: String(fromBig) }));
    } catch { return; }

    const replayChunks = this._chunksSince(session, lastSeqBig);
    for (const chunk of replayChunks) {
      try {
        if (clientRec.binaryCapable) {
          ws.send(encodeBinaryOutput(chunk.seq, chunk.data));
        } else {
          ws.send(JSON.stringify({
            type: "output",
            seq: String(chunk.seq),
            data: chunk.data,
          }));
        }
        clientRec.lastSentSeq = chunk.seq;
      } catch { return; }
    }

    try {
      ws.send(JSON.stringify({ type: "replay_complete" }));
    } catch {}
  }

  // SLOW_PATH: capture-pane snapshot + replay_complete.
  _sendSnapshotPath(session, sessionId, clientRec) {
    const ws = clientRec.ws;
    if (!ws || ws.readyState !== 1) return;

    let snap;
    try {
      snap = tmuxSnapshot(sessionId);
    } catch {
      snap = { data: "", cursor: { x: 0, y: 0 }, cols: 200, rows: 50, alternate: false };
    }
    const epochSeq = session.totalSeq;
    try {
      if (clientRec.binaryCapable) {
        ws.send(encodeBinarySnapshot(epochSeq, snap.data));
      } else {
        ws.send(JSON.stringify({
          type: "snapshot",
          seq: String(epochSeq),
          data: snap.data,
          cols: snap.cols,
          rows: snap.rows,
          cursor: snap.cursor,
        }));
      }
      clientRec.lastSentSeq = epochSeq;
    } catch { return; }

    try {
      ws.send(JSON.stringify({ type: "replay_complete" }));
    } catch {}
  }

  // Wire steady-state input/resize/image handlers on a V2 client.
  _wireSteadyStateHandlers(session, ws, sessionId) {
    ws.on("message", (rawMessage) => {
      let message;
      try {
        message = JSON.parse(rawMessage.toString());
      } catch {
        return;
      }
      this._handleSteadyStateMessage(session, ws, sessionId, message);
    });
  }

  // Process one parsed steady-state message. Mirrors the legacy switch with
  // the addition of (1) resize coalesce, (2) explicit warns on unknown types,
  // (3) drop of stray "hello" frames.
  _handleSteadyStateMessage(session, ws, sessionId, message) {
    if (!message || typeof message !== "object") return;
    switch (message.type) {
      case "input":
        if (!session.exited && session.pty) {
          session.echoUntil = Date.now() + 600;
          session.waiting = false;
          session.lastActivityAt = new Date();
          try { session.pty.write(message.data); } catch {}
        }
        break;
      case "resize":
        if (!session.exited && session.pty && message.cols && message.rows) {
          // Server-side coalesce (plan §2.4.4): drop no-op resizes.
          if (message.cols === session.cols && message.rows === session.rows) break;
          try {
            session.pty.resize(message.cols, message.rows);
            session.cols = message.cols;
            session.rows = message.rows;
          } catch {}
        }
        break;
      case "image": {
        const imgData = Buffer.from(message.data, "base64");
        try {
          if (session._xclipPid) {
            try { process.kill(session._xclipPid); } catch {}
            session._xclipPid = null;
          }
          const xclipProc = spawn("xclip", ["-selection", "clipboard", "-t", "image/png"], {
            env: { ...process.env, DISPLAY: ":99" },
            stdio: ["pipe", "ignore", "pipe"],
          });
          session._xclipPid = xclipProc.pid;

          let xclipError = "";
          xclipProc.stderr.on("data", (chunk) => { xclipError += chunk.toString(); });
          xclipProc.on("error", (err) => {
            try {
              ws.send(JSON.stringify({ type: "output", data: `\r\n\x1b[31m✗ xclip error: ${err.message}\x1b[0m\r\n` }));
            } catch {}
          });
          xclipProc.stdin.end(imgData);

          setTimeout(() => {
            if (xclipError) {
              try {
                ws.send(JSON.stringify({ type: "output", data: `\r\n\x1b[31m✗ xclip: ${xclipError}\x1b[0m\r\n` }));
              } catch {}
              return;
            }
            if (!session.exited && session.pty) {
              try { session.pty.write("\x16"); } catch {}
            }
          }, 200);
        } catch (err) {
          try {
            ws.send(JSON.stringify({ type: "output", data: `\r\n\x1b[31m✗ Ошибка clipboard: ${err.message}\x1b[0m\r\n` }));
          } catch {}
        }
        break;
      }
      case "hello":
        // Stray hello on an already-handshaked socket — ignore with warn.
        console.warn(`[ct] stray hello on session ${sessionId}, ignored`);
        break;
      case "ack":
        // Reserved (plan §2.4.2) — discard with warn for forward-compat hygiene.
        console.warn(`[ct] received unsupported ack frame on session ${sessionId}`);
        break;
      default:
        console.warn(`[ct] unknown WS message type "${message.type}" on session ${sessionId}`);
    }
  }

  detachFromSession(sessionId, ws) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.connectedClients.delete(ws);
      if (session.clients) session.clients.delete(ws);
    }
  }

  // Iterate every WebSocket attached to a session — both legacy and v2.
  // Used by deleteSession / deleteSessionKeepFiles for shutdown broadcasts.
  _allSessionClients(session) {
    const out = new Set(session.connectedClients);
    if (session.clients) {
      for (const ws of session.clients.keys()) out.add(ws);
    }
    return out;
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

    for (const client of this._allSessionClients(session)) {
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

    for (const client of this._allSessionClients(session)) {
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
          session.echoUntil = Date.now() + 600;
          session.waiting = false;
          session.lastActivityAt = new Date();
          session.pty.write(message.data);
        } else if (message.type === "resize" && !session.exited && message.cols && message.rows) {
          session.pty.resize(message.cols, message.rows);
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
      const v2Count = session.clients ? session.clients.size : 0;
      result.push({
        sessionId: id,
        displayName: session.displayName || null,
        projectDir: session.projectDir,
        createdAt: session.createdAt,
        lastActivityAt: session.lastActivityAt || session.createdAt,
        isActive: !session.exited,
        busy: !!session.busy,
        waiting: !!session.waiting && !session.busy,
        connectedClients: session.connectedClients.size + v2Count,
        hasFiles,
        providerSlug: session.providerSlug || "claude",
      });
    }
    return result;
  }
}

module.exports = { TerminalManager };
