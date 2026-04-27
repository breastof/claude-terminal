# 02 — Scan: PTY Pipeline (Claude CLI → tmux → node-pty → server.js → WS)

> Phase 2 deliverable for `scanner-pty-pipeline`. SCAN ONLY — no remediation here.
> All file:line references are absolute paths in `/root/projects/claude-terminal/`.

---

## 0. TL;DR (you can skip if you read the body)

- **Transport encoding**: node-pty is in **UTF-8 string mode** (default). Chunks arrive as JS strings already decoded by Node.js `StringDecoder`. There is no Buffer→string boundary crossed in user code on the output path.
- **WS framing**: every output chunk is wrapped in `JSON.stringify({type:"output", data})` and sent as a **text frame**. No binary frames, no seq/ack, no backpressure check.
- **Replay buffer**: a single JS string per session, hard-cap **2,000,000 characters** (NOT 500 KB as documented in `CLAUDE.md:28` — see §5), bumper-style trimmed via `.slice(-2_000_000)`. Slice is char-boundary safe but **NOT escape-sequence aware** — a CSI/OSC at the head of the trim window will be cut and the surviving prefix is still injected into the new client.
- **tmux attach mode**: raw `tmux -L claude-terminal -f tmux.conf attach-session -t <id>` over a node-pty PTY. **No `-CC` (control mode), no `pipe-pane`, no `capture-pane` for live data.** `capture-pane` is only used to *prime* `session.buffer` once, at PTY-attach time, with the full scrollback.
- **Resize**: `pty.resize(cols,rows)` is called **per WS `resize` message**. No debounce, no coalescing. xterm’s `ResizeObserver` triggers on every container size change and a `fit()` is run synchronously.
- **Biggest single risk found**: the replay buffer is a `String += chunk` accumulator that is then **also re-seeded** from a fresh `tmux capture-pane -p -e -S -` on each lazy attach (lines 177, 247, 489). Concurrent writes from `onData` (line 294) and the `capture-pane` re-seed (line 489) overwrite each other under deploy/reconnect overlap, so a reconnecting client can receive a stale snapshot and then the *live* delta — producing duplicated regions or, worse, a snapshot that ends mid-escape with new live bytes appended. Combined with the 2 MB hard cut, this is the most plausible source of the user-reported "broken stream / lost packets".

---

## 1. Sequence diagram (ASCII)

```
        ┌──────────────────────────────────────────────────────────────────────┐
        │                              HOST                                     │
        │                                                                      │
        │   Claude CLI                                                          │
        │   (or codex/etc.)                                                    │
        │       │                                                              │
        │       │ stdout/stderr (raw bytes, often UTF-8 + ANSI CSI/OSC/SGR)    │
        │       ▼                                                              │
        │   ┌────────────────────────┐                                         │
        │   │ tmux pane              │   tmux server, socket -L claude-terminal│
        │   │  - alt screen ON       │   tmux.conf:                            │
        │   │  - history-limit 50000 │     escape-time 0                       │
        │   │  - mouse off           │     default-terminal xterm-256color     │
        │   │  - status off          │     status off                          │
        │   └────────────┬───────────┘                                         │
        │                │ tmux internal protocol (binary)                     │
        │                │   ─ NOT control mode (-CC)                          │
        │                │   ─ NO pipe-pane attached                           │
        │                │   ─ classic interactive ATTACH                      │
        │                ▼                                                     │
        │   ┌────────────────────────┐   spawned via:                          │
        │   │ tmux client            │   pty.spawn("tmux", [                   │
        │   │ (a regular tmux        │     "-L", TMUX_SOCKET,                  │
        │   │  process talking the   │     "-f", TMUX_CONF,                    │
        │   │  TTY API)              │     "attach-session", "-t", sessionId   │
        │   │                        │   ], { name:"xterm-256color",           │
        │   │  This client sits on   │     cols:120, rows:40,                  │
        │   │  the slave side of a   │     env:PTY_ENV })                      │
        │   │  PTY allocated by      │                                         │
        │   │  node-pty.             │   (terminal-manager.js:92-103)          │
        │   └────────────┬───────────┘                                         │
        │                │  PTY master fd → tty.ReadStream                     │
        │                │  setEncoding('utf8') ← node-pty default             │
        │                │  (node-pty/lib/unixTerminal.js:64,95)               │
        │                ▼                                                     │
        │   ┌────────────────────────────────────────┐                         │
        │   │ node-pty IPty.onData(chunk: string)    │                         │
        │   │   chunk is ALREADY decoded UTF-8       │                         │
        │   │   StringDecoder respects multi-byte    │                         │
        │   │   boundaries between chunks            │                         │
        │   └────────────┬───────────────────────────┘                         │
        │                │  onData callback (terminal-manager.js:279)          │
        │                ▼                                                     │
        │   ┌────────────────────────────────────────┐                         │
        │   │ TerminalManager._setupPty.onData       │                         │
        │   │   1. data = rawData.replace(           │                         │
        │   │        /\x1b\[\?(1049|1047|47)[hl]/g,  │  ← strips alt-screen    │
        │   │        "")                             │     enter/leave         │
        │   │   2. extend grace window if active     │                         │
        │   │   3. session.buffer += data            │  ← REPLAY BUFFER        │
        │   │   4. if buffer.length > 2_000_000      │                         │
        │   │        buffer = buffer.slice(-2e6)     │  ← LOSSY TRIM           │
        │   │   5. for client in connectedClients:   │                         │
        │   │        client.send(                    │                         │
        │   │          JSON.stringify({              │                         │
        │   │            type:"output", data}))      │  ← TEXT FRAME, JSON     │
        │   └────────────┬───────────────────────────┘                         │
        │                │                                                     │
        │                │  ws.send (TEXT frame, utf-8)                        │
        │                ▼                                                     │
        │   ┌────────────────────────────────────────┐                         │
        │   │ ws (npm `ws` 8.19.0) — WebSocketServer │                         │
        │   │   noServer:true; upgrade in server.js  │                         │
        │   │   no perMessageDeflate config          │                         │
        │   │   no maxPayload override (default 100M)│                         │
        │   │   no ping/pong/heartbeat               │                         │
        │   └────────────┬───────────────────────────┘                         │
        │                │  TLS + WS                                           │
        │                ▼                                                     │
        │   ┌────────────────────────────────────────┐                         │
        │   │ nginx                                  │                         │
        │   │   proxy_http_version 1.1               │                         │
        │   │   Upgrade $http_upgrade                │                         │
        │   │   Connection "upgrade"                 │                         │
        │   │   proxy_read_timeout 86400             │                         │
        │   │   proxy_buffering: DEFAULT (= on)      │ ← see §6.6 risk        │
        │   │   /etc/nginx/sites-available/          │                         │
        │   │     claude-terminal:26-38              │                         │
        │   │   upstream switches blue↔green via     │                         │
        │   │   /etc/nginx/claude-terminal-          │                         │
        │   │     upstream.conf (one-line file)      │                         │
        │   └────────────┬───────────────────────────┘                         │
        └────────────────┼─────────────────────────────────────────────────────┘
                         │  WSS to public                                      
                         ▼                                                     
        ┌────────────────────────────────────────────┐                         
        │  Browser                                   │                         
        │   WebSocket (default `binaryType=blob`,    │                         
        │     but only TEXT frames are sent here)    │                         
        │     ws.onmessage(event)                    │                         
        │       msg = JSON.parse(event.data)         │  Terminal.tsx:171       
        │       switch(msg.type){                    │                         
        │         case "output": term.write(msg.data)│  Terminal.tsx:174       
        │         case "exit": ...                   │                         
        │         case "stopped": ...                │                         
        │         case "error": ...                  │                         
        │       }                                    │                         
        │     term.write IS NOT awaited (fire&forget)│                         
        └────────────────────────────────────────────┘                         

  Inputs (browser → server) flow back:
  term.onData(d) → ws.send(JSON.stringify({type:"input"|"resize"|"image", ...}))
  → server.js wssTerminal handleUpgrade → terminalManager.attachToSession.ws.on("message")
  → session.pty.write(d) | session.pty.resize(cols,rows) | xclip+pty.write("\x16")
```

---

## 2. Data shape at each hop

| Hop | Type at producer | Type after handler | Encoding | Chunk size (observed) | Normalization |
|---|---|---|---|---|---|
| Claude CLI → tmux pane | bytes (process stdout) | tmux internal | depends on process; usually UTF-8 + ANSI escapes | line- or write-syscall sized; no upper bound | none |
| tmux pane → tmux client (attach process) | bytes via tmux protocol | bytes on stdout of tmux client | xterm-256color (`tmux.conf:15`) + 24-bit color override (`tmux.conf:16`) | depends on tmux's internal scheduler; typically 1–8 KB in TTY land | tmux already filters for the active client's geometry; with `aggressive-resize on` and `window-size latest` (`tmux.conf:33-34`), pane redraws happen on every attach/resize |
| tmux client (PTY slave) → node-pty (PTY master) | raw bytes on master fd | **JS `string`** | UTF-8 decoded by Node's `StringDecoder` (set via `_socket.setEncoding('utf8')` in `node-pty/lib/unixTerminal.js:95`); `pty.fork(... encoding==='utf8' ...)` enabled at line 92 | typically a few hundred bytes to a few KB per `read()`; node-pty's `tty.ReadStream` uses Node defaults | StringDecoder handles split UTF-8 codepoints between chunks — partial leading bytes are buffered into the next chunk. **No splitting concerns at this layer.** |
| `onData` arg → `data` after `ALT_SCREEN_RE.replace` | `string` | `string` | UTF-8 string | same | `terminal-manager.js:282` strips `\x1b[?1049[hl]`, `\x1b[?1047[hl]`, `\x1b[?47[hl]` so xterm.js stays in the *normal* buffer (so xterm scrollback works). **This is a per-chunk regex on a string** — if a chunk happens to end in `\x1b[?104` and the next starts `9h`, the replace WILL miss the split sequence and the user's xterm.js will switch to alt screen until something redraws. (Verdict: rare in practice because tmux emits the sequence atomically, but theoretically possible.) |
| `data` → `session.buffer` | `string` (chunk) | `string` (concatenated) | UTF-8 string | accumulator | `+=` (terminal-manager.js:294); when `length > 2_000_000` → `slice(-2_000_000)` (terminal-manager.js:295-296). This is a **char-count** trim (UTF-16 code units in V8), NOT a byte trim — but ALSO **NOT an escape-sequence aware trim**. |
| `session.buffer` → `tmuxCapture` re-seed | `string` | `string` | `execSync(... { encoding: "utf-8", maxBuffer: 8 * 1024 * 1024 })` (terminal-manager.js:42) | **up to 8 MiB** per capture | Whole replay is replaced; not appended. (terminal-manager.js:177, 247, 489) |
| `data` → `JSON.stringify({type:"output", data})` | `string` | JSON string | UTF-8 in the wire envelope | depends on chunk | JSON escapes lone `\x00`, control chars become `\uXXXX` strings — works because xterm.js parses JSON and writes the unescaped result. **However, a UTF-16 lone surrogate can break JSON.stringify silently**: V8's `JSON.stringify` will pass surrogates through as `\udxxx` literal escapes, then xterm gets fed an invalid surrogate in `term.write`. This is theoretical only if upstream produces lone surrogates, which UTF-8 cannot. |
| `client.send(jsonString)` | string | WS TEXT frame | UTF-8 | per ws frame; default fragmentation is automatic by `ws` library | No `bufferedAmount` check, no compression configured. |
| nginx | TEXT frame in, TEXT frame out | TEXT frame | UTF-8 | unchanged | `proxy_buffering` not explicitly set → defaults to `on`. For WebSocket Upgrade traffic nginx will not buffer message bodies once Upgrade succeeds, but it WILL buffer the initial response headers. Practical effect on long sessions: usually none. **proxy_read_timeout 86400** (24h) is fine. |
| Browser ws.onmessage → JSON.parse → term.write | `string` | xterm.js internal | UTF-8 | unchanged | `term.write` is async/queued internally. Code at `Terminal.tsx:174` does **not** chain via the optional callback — multiple incoming messages enqueue independently. xterm.js is documented to preserve order for sequential `write` calls so this is fine **as long as no concurrent write source races it** (none observed). |

### What is NEVER seen on the path

- No `Buffer` is ever read from node-pty in this code (encoding is utf8 by default, `terminal-manager.js:97-103` does not pass `encoding:null`).
- No `setEncoding` is called on the WS messages — but they're already strings since `ws` decodes TEXT frames to strings by default.
- No use of `crypto`/`zlib`/`Buffer.concat` on the output path.
- No `for await` over a stream; all data flow is event-driven `onData`.

---

## 3. Call-site inventory

### 3.1 `pty.spawn` — PTY creation

| File:line | Call | Encoding | Notes |
|---|---|---|---|
| `terminal-manager.js:93-103` | `pty.spawn("tmux", ["-L", TMUX_SOCKET, "-f", TMUX_CONF, "attach-session", "-t", sessionId], { name:"xterm-256color", cols, rows, cwd, env: PTY_ENV })` | default = utf8 | Used for **persistent** sessions. NO `encoding:null`, NO `handleFlowControl`. |
| `terminal-manager.js:715-721` | `pty.spawn("/bin/bash", [], { name:"xterm-256color", cols:120, rows:15, cwd, env: PTY_ENV })` | default = utf8 | Used for **ephemeral** sessions (provider-wizard auth terminal). |

### 3.2 `pty.onData` — output emission

| File:line | Handler | Side effects |
|---|---|---|
| `terminal-manager.js:279-303` | `(rawData) => { data = rawData.replace(ALT_SCREEN_RE, ""); if(!data) return; … }` | (a) extends grace window (lines 288-292), (b) appends to `session.buffer` and trims (294-297), (c) JSON-stringifies and `client.send`s to every connected WS (298-302). |
| `terminal-manager.js:745-755` | Ephemeral path: `(data) => { … }` | (a) appends to `session.buffer` and trims (746-749), (b) JSON-stringifies + `client.send` to every connected WS (750-754). NO alt-screen strip, NO grace window. |

### 3.3 `pty.onExit`

| File:line | Behavior |
|---|---|
| `terminal-manager.js:305-322` | Sets `session.pty = null`. If tmux session still alive → log "PTY detached"; if tmux gone → mark `session.exited = true` and broadcast `{type:"exit", exitCode:0, signal:0}` to clients. |
| `terminal-manager.js:757-764` | Ephemeral: forwards `{exitCode, signal}` directly from node-pty (so the ephemeral path receives the *real* exit code, unlike the persistent path which always sends `0,0`). |

### 3.4 `pty.write`

| File:line | What is written |
|---|---|
| `terminal-manager.js:523` | `session.pty.write(message.data)` — user keystrokes from WS `{type:"input"}` |
| `terminal-manager.js:566` | `session.pty.write('\x16')` — Ctrl+V after image is staged in xclip |
| `terminal-manager.js:788` | Ephemeral: `session.pty.write(message.data)` — same shape as 523 but no echo/waiting tracking |

### 3.5 `pty.resize`

| File:line | When |
|---|---|
| `terminal-manager.js:528` | Persistent: on every `{type:"resize", cols, rows}` WS message. **No debounce.** |
| `terminal-manager.js:790` | Ephemeral: same. **No debounce.** |

### 3.6 `pty.kill`

| File:line | Caller |
|---|---|
| `terminal-manager.js:456` | `stopSession` |
| `terminal-manager.js:497` | catch-block during lazy attach failure in `attachToSession` |
| `terminal-manager.js:614` | `deleteSession` |
| `terminal-manager.js:654` | `deleteSessionKeepFiles` |
| `terminal-manager.js:807` | `destroyEphemeralSession` |
| `server.js:285` | `gracefulShutdown` — iterates `terminalManager.sessions`, calls `session.pty.kill()` |

### 3.7 `ws.send` / `client.send` (server → browser)

All payloads are `JSON.stringify(...)` text frames. None of these check `ws.readyState !== 1` plus `bufferedAmount`; they only check `readyState === 1` (i.e. OPEN).

| File:line | Type | Source |
|---|---|---|
| `server.js:128` | `{type:..., ...}` (symphony broadcast) | `symphonyBroadcast` |
| `server.js:174` | `{type:"error", message:"No sessionId provided"}` | terminal upgrade |
| `server.js:215` | `{type:"welcome", peerId, colorIndex}` | presence upgrade |
| `server.js:257` | `{type:"connected"}` | symphony upgrade |
| `terminal-manager.js:300` | `{type:"output", data}` | persistent live stream |
| `terminal-manager.js:318` | `{type:"exit", exitCode:0, signal:0}` | persistent exit broadcast |
| `terminal-manager.js:469` | `{type:"error", message:"Session not found"}` | attach failure |
| `terminal-manager.js:507` | `{type:"output", data: session.buffer}` | **REPLAY** dump on attach |
| `terminal-manager.js:511` | `{type:"stopped"}` | session is dead at attach time |
| `terminal-manager.js:553` | `{type:"output", data:"\r\n\x1b[31m✗ xclip error: …\x1b[0m\r\n"}` | xclip stderr surface |
| `terminal-manager.js:562` | same | xclip post-error |
| `terminal-manager.js:570` | same | catch around xclip |
| `terminal-manager.js:620` | `{type:"exit", …}` | `deleteSession` broadcast then `client.close()` |
| `terminal-manager.js:660` | same | `deleteSessionKeepFiles` |
| `terminal-manager.js:752` | `{type:"output", data}` | ephemeral live stream |
| `terminal-manager.js:760` | `{type:"exit", exitCode, signal}` | ephemeral exit |
| `terminal-manager.js:770` | `{type:"error", message:"Ephemeral session not found"}` | ephemeral attach failure |
| `terminal-manager.js:778` | `{type:"output", data: session.buffer}` | ephemeral REPLAY |
| `terminal-manager.js:813` | `{type:"exit", …}` | `destroyEphemeralSession` |

### 3.8 `ws.on('message')` (browser → server)

| File:line | Path | Allowed types |
|---|---|---|
| `server.js:217` | `/api/presence` | `join`, `switch`, `cursor`, `chat`, `chat_close` (presence-only, never reaches PTY) |
| `terminal-manager.js:514` | `/api/terminal` (persistent) | `input` → pty.write; `resize` → pty.resize; `image` → xclip + Ctrl+V |
| `terminal-manager.js:781` | `/api/terminal?ephemeral=true` | `input`, `resize` only |

### 3.9 `replayBuffer` (in code: `session.buffer`) — every push/slice/set

| File:line | Op | What |
|---|---|---|
| `terminal-manager.js:177` | **set** | `session.buffer = tmuxCapture(sessionId, -1) \|\| ""` — at server-startup reattach |
| `terminal-manager.js:247` | **set** | same as 177, in `_syncFromDisk` (cross-instance after blue-green flip) |
| `terminal-manager.js:294` | **push** (`+=`) | `session.buffer += data` — every onData chunk |
| `terminal-manager.js:295-296` | **slice** | `if (session.buffer.length > 2_000_000) session.buffer = session.buffer.slice(-2_000_000)` — keep the **tail** 2M chars |
| `terminal-manager.js:433` | **set/clear** | `session.buffer = ""` at `resumeSession` start |
| `terminal-manager.js:489` | **set** | `session.buffer = tmuxCapture(sessionId, -1) \|\| session.buffer` — at lazy attach |
| `terminal-manager.js:506-508` | **read+send** | replays the entire `session.buffer` as a single `{type:"output"}` frame to the new client |
| `terminal-manager.js:746` | **push** | ephemeral `+=` |
| `terminal-manager.js:747-748` | **slice** | ephemeral 2M trim |
| `terminal-manager.js:777-779` | **read+send** | ephemeral replay on attach |

There is no `slice` other than the trim and the implicit substring inside `JSON.stringify`. **Specifically, there is no escape-aware trim, no chunk-aligning, no codepoint-aligning anywhere.**

### 3.10 Buffer-as-Buffer occurrences (sanity check)

| File:line | What |
|---|---|
| `terminal-manager.js:42` | `execSync(... { maxBuffer: 8 * 1024 * 1024 })` — sizing for `capture-pane` output |
| `terminal-manager.js:533` | `Buffer.from(message.data, "base64")` — image bytes from browser, NOT touching the PTY output path |

These are the **only** Buffer references; the PTY output path itself never sees a Buffer.

---

## 4. tmux attach mode (how the PTY connects to tmux)

```
const TMUX_SOCKET = "claude-terminal";                      // terminal-manager.js:7
const TMUX_CONF   = path.join(__dirname, "tmux.conf");      // terminal-manager.js:8

function attachTmux(sessionId, cols=120, rows=40, cwd) {    // terminal-manager.js:92-103
  return pty.spawn("tmux", [
    "-L", TMUX_SOCKET, "-f", TMUX_CONF,
    "attach-session", "-t", sessionId,
  ], {
    name: "xterm-256color",
    cols, rows,
    cwd: cwd || process.env.HOME || "/root",
    env: PTY_ENV,
  });
}
```

- Mode: **plain interactive `attach-session`**. NOT `tmux -CC` (control mode), NOT `tmux -CC attach` either.
- No `pipe-pane` is ever invoked anywhere in the repo (verified by grep — only the planner file 01-planner-tmux.md mentions the term, in hypothesis form).
- `capture-pane` IS used, but only as a *one-shot* snapshot to seed the replay buffer:

  | File:line | Command | Purpose |
  |---|---|---|
  | `terminal-manager.js:36-47` | `tmux -L claude-terminal capture-pane -t <id> -p -e -S <start> 2>/dev/null` | snapshot helper |
  | `terminal-manager.js:177` | `tmuxCapture(sessionId, -1)` | seed buffer at startup-reattach |
  | `terminal-manager.js:247` | `tmuxCapture(entry.sessionId, -1)` | seed buffer when learning about a session via cross-instance file-sync |
  | `terminal-manager.js:489` | `tmuxCapture(sessionId, -1)` | seed buffer right before lazy PTY attach |

  Flags: `-p` (print to stdout), `-e` (include ANSI escape codes for color/format), `-S -` (start from beginning of history). Notably, **no `-J`** (join wrapped lines), so wrapping is preserved as-is.

- `tmux.conf` settings that affect output framing:

  | Line | Setting | Effect |
  |---|---|---|
  | `tmux.conf:9` | `escape-time 0` | passthrough escape immediately (no 500 ms delay) — good |
  | `tmux.conf:12` | `history-limit 50000` | scrollback retained inside tmux for `capture-pane -S -` |
  | `tmux.conf:15` | `default-terminal "xterm-256color"` | matches PTY env `TERM` |
  | `tmux.conf:16` | `terminal-overrides ",xterm-256color:Tc"` | enables truecolor |
  | `tmux.conf:24` | `mouse off` | xterm.js handles mouse natively (no SGR mouse sequences come through) |
  | `tmux.conf:30` | `remain-on-exit off` | session destroys when CLI exits |
  | `tmux.conf:33-34` | `window-size latest` + `aggressive-resize on` | tmux re-renders the pane to the geometry of the **most recent** attaching client; under blue-green overlap with two attaches this can cause an immediate full repaint of the pane → bursty output |

- tmux session creation: `terminal-manager.js:354-357` for new, `terminal-manager.js:419-423` for resume. Both use shell concatenation:

  ```
  tmux -L claude-terminal -f tmux.conf new-session -d -s "<sessionId>" -x 120 -y 40 -c "<projectDir>" -- env <ENV=...> <command>
  ```

  Initial geometry is hard-coded at **120×40**. The first browser-side `resize` (sent immediately on `ws.onopen`, `Terminal.tsx:160-166`) re-sizes the pane to whatever xterm.js fitted to.

- Strip applied AFTER tmux: `ALT_SCREEN_RE = /\x1b\[\?(1049|1047|47)[hl]/g` (`terminal-manager.js:34`). Reason given in the comment: keep xterm.js in the normal buffer so its scrollback works. This is a **per-chunk regex on the decoded string**, applied at `terminal-manager.js:282`.

---

## 5. Replay buffer semantics

### 5.1 Storage

- `session.buffer` is a single mutable JS string per session, held in the per-session record inside `TerminalManager.sessions: Map<string, Session>`.
- Initialized to `""` in `_loadSessions` (`terminal-manager.js:151`) and `createSession` (`terminal-manager.js:371`).

### 5.2 Total size

- **Hard cap: 2,000,000 characters** (UTF-16 code units in V8). Enforced in two places:
  - persistent: `terminal-manager.js:295-296`
  - ephemeral:  `terminal-manager.js:747-748`

- **Discrepancy**: the project README/CLAUDE doc states this as "500 KB circular":
  - `CLAUDE.md:28` — "Replay buffer: 500KB circular."

  The actual value is `2_000_000` chars ≈ **2 MB** of UTF-16 in memory, ≈ 2 MB of UTF-8 on the wire (more if multi-byte glyphs dominate). Documentation drift; bring it up in Phase 5/6.

### 5.3 Eviction policy

- "Tail-keep" via `String.prototype.slice(-2_000_000)`. There is no rolling-window list, no per-line ring, no segment headers. The trim happens **only** when the cumulative string crosses the threshold; in steady state with low-throughput output, the buffer is never trimmed.
- After trim, the *new* head of the buffer is whatever character happened to be at index `length - 2_000_000` after the most recent `+=`. This is not aligned to anything meaningful (line, escape sequence, or even codepoint — see §5.5 below).

### 5.4 Where slicing happens

- `terminal-manager.js:295-296` — the *only* lossy slice on the live path:

  ```js
  session.buffer += data;
  if (session.buffer.length > 2000000) {
    session.buffer = session.buffer.slice(-2000000);
  }
  ```

- `terminal-manager.js:507` — the entire `session.buffer` is then sent as `{type:"output", data: session.buffer}` to a freshly attached client. The browser xterm.js does `term.write(data)` with no special handling of the boundary.

- `terminal-manager.js:489` — on lazy attach, `session.buffer` is REPLACED by `tmuxCapture(sessionId, -1)` (the full tmux scrollback, ANSI-escaped, up to 8 MiB cap on `execSync`). This bypasses the trim entirely — the snapshot is whatever tmux's history-limit (50000 lines) holds.

- Race window: between `tmuxCapture` returning (line 489) and `attachTmux` finishing (line 490), node-pty has not yet produced any onData, so there is no immediate race against `+=`. **However**, if a SECOND client attaches after the first one already triggered the lazy attach, the `tmuxCapture` on line 489 will OVERWRITE a `session.buffer` that was being mutated by ongoing onData (line 294). With JS being single-threaded this does not corrupt data structurally, but it does mean the second client may receive a snapshot that does NOT include the most recent onData chunks (which were appended after the snapshot was taken). The next live chunk arrives only via line 300 — so the second client sees stale snapshot, then jump-cut to live.

### 5.5 Mid-escape-sequence safety

- `slice(-2_000_000)` operates on UTF-16 code units, not bytes. So:
  - Multi-byte UTF-8 chars are NOT mid-byte cut at this layer (because we already have a string).
  - Surrogate pairs CAN be split at the boundary (a high surrogate at position L-2_000_000 with low surrogate at L-2_000_000+1 is fine; the boundary lands BEFORE the pair so both halves are in the kept tail — actually safe). The dangerous case is a high surrogate at position L-2_000_001, low at L-2_000_000 — `slice(-2_000_000)` would keep the low surrogate and drop the high. That produces a lone-surrogate string. JSON.stringify would then emit `\udxxx` and xterm would receive an isolated surrogate. Rare, but not zero.

- **Escape-sequence safety**: NONE. A common scenario:
  1. tmux emits `\x1b[38;2;255;128;0m` (truecolor SGR set).
  2. The `+=` happens to push the buffer over 2 MB at the byte after `\x1b[38;2;255;`.
  3. `slice(-2_000_000)` cuts and the new head starts with `128;0m…` — a CSI fragment with no introducer.
  4. The first client to attach receives this as its replay; xterm.js parser sees `128;0m` as printable text.

  The same hazard applies to OSC sequences (e.g. `\x1b]0;title\x07`), CSI mode toggles (`\x1b[?2004h` bracketed paste), and SS3 cursor reports.

### 5.6 Order of dispatch on attach

Inside `attachToSession` (`terminal-manager.js:466-583`):

1. Add `ws` to `connectedClients` (line 474).
2. **If** PTY not attached and tmux still alive: lazy-attach a fresh `pty.spawn`, replacing `session.buffer` from `tmuxCapture` (lines 478-503).
3. Send the entire `session.buffer` as one `{type:"output"}` frame (lines 506-508).
4. If exited, additionally send `{type:"stopped"}` (lines 510-512).
5. Register `ws.on("message")` and `ws.on("close")`.

Note: the snapshot send (step 3) happens BEFORE any `await`, but JS is single-threaded so there's no ordering issue with itself. **But** between step 2 and step 3, if onData fires (e.g. tmux pushes a redraw triggered by the lazy attach itself), those bytes will be (a) appended to `session.buffer` and (b) immediately broadcast to *all* connected clients including the just-added `ws`. Result: the new client receives `[snapshot]` + `[live chunks]`, but the live chunks may also be PRESENT inside the snapshot if they arrived after `tmuxCapture` ran but before `client.send(snapshot)` ran. → potential duplication of the tail of the snapshot.

### 5.7 Inputs are not buffered

There is no client-side or server-side queue of user keystrokes. `pty.write` is called inline on every WS `input` message. No backpressure on the reverse path.

---

## 6. Hypothesis checklist (accept/reject with citations)

### 6.1 H1 — UTF-8 cut on WS frame boundary (Buffer→string conversion before chunk-aligning)

**Verdict: REJECTED on the producer path; PARTIALLY ACCEPTED at the trim boundary.**

Evidence:
- node-pty defaults to `encoding: 'utf8'` (`terminal-manager.js:97-103` does NOT pass encoding, and `node-pty/lib/unixTerminal.js:64` falls through to default `'utf8'`). The PTY output stream is a Node `tty.ReadStream` with `setEncoding('utf8')` applied (`node-pty/lib/unixTerminal.js:95`). Node's `StringDecoder` accumulates partial lead bytes between chunks and only emits complete codepoints — there is no scenario where `onData` hands back a half-codepoint.
- Chunks are JS strings throughout. `JSON.stringify(string)` is encoding-correct. `ws.send(string)` produces a TEXT frame, which the spec mandates be UTF-8.
- The browser receives a TEXT frame, the WS API decodes it to a string for `event.data`, and `JSON.parse` returns a string. `term.write(string)` is given a JS string.

→ No raw byte split occurs on the live path.

**Caveat — replay tail**: `session.buffer.slice(-2_000_000)` operates on code units, so it can split a UTF-16 surrogate pair (see §5.5). UTF-8 itself is not the issue; UTF-16 string slicing introduces a *different* but related boundary risk. Probability low because non-BMP codepoints (emoji etc.) are uncommon in tmux/terminal output.

### 6.2 H2 — Replay buffer truncation mid-escape-sequence (slice on raw byte count)

**Verdict: ACCEPTED.**

Evidence:
- `terminal-manager.js:295-296`: `session.buffer.slice(-2_000_000)` is taken at an **arbitrary char index** with no awareness of `\x1b[`, OSC, SOS/PM/APC, DCS, or any escape framing.
- Once trimmed, the entire (potentially head-corrupt) buffer is shipped as one frame on the next attach (`terminal-manager.js:507`).
- xterm.js parser is robust against unknown sequences (it'll just print the orphan bytes), but a CSI fragment like `128;0m` arriving at the start of a buffer will appear as visible text — this is a known reproducer for "garbage at top of replay" complaints.

Also note: even `tmuxCapture` on lazy attach (line 489) inherits this risk because its output is also dropped into the same buffer slot, but `capture-pane -e` emits well-formed ANSI sequences and tmux pads the output line by line — so the `tmux capture-pane`-sourced buffer is generally safer than the `+=` accumulator.

### 6.3 H3 — PTY resize storms (no debounce on resize handler)

**Verdict: ACCEPTED.**

Evidence:
- Server side: `terminal-manager.js:528` calls `session.pty.resize(message.cols, message.rows)` synchronously on every `{type:"resize"}` message. No debounce, no coalescing.
- Client side: `Terminal.tsx:362-376` defines `handleResize`:
  ```ts
  const handleResize = () => {
    fitAddon.fit();
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    }
    requestAnimationFrame(() => publishScroll());
  };
  const resizeObserver = new ResizeObserver(handleResize);
  ```
  `ResizeObserver` fires for every container resize observed by the browser — during a window-drag this is **per animation frame**, ~60 messages/second.
- Every `pty.resize` propagates to tmux which, with `aggressive-resize on` + `window-size latest` (`tmux.conf:33-34`), forces a pane redraw. A redraw is itself a burst of output that travels back up the pipeline — i.e. resize storms spawn output storms.
- There is also a refit on fullscreen toggle (`Terminal.tsx:57-82`) and on initial connect (`Terminal.tsx:160-166`) — these are bounded, not the storm source. The storm source is the `ResizeObserver`.

### 6.4 H4 — tmux pipe-pane vs control-mode mismatch (raw pipe-pane loses redraw/resize semantics)

**Verdict: REJECTED (the project does NOT use pipe-pane).** But the *spirit* of the hypothesis applies — the project uses *raw attach* instead of `-CC`, which has its own trade-offs.

Evidence:
- Grep across the repo for `pipe-pane` returns 0 hits in source code; only the planner doc (`01-planner-tmux.md`) mentions it as a hypothesis.
- The actual attach is `tmux attach-session` over node-pty (`terminal-manager.js:93-103`), see §4.
- Control-mode (`-CC`) is not used either; there is no `%output` parser anywhere.

The current setup means: the node-pty stream IS the rendered xterm-256color byte stream, with all of tmux's redraw/resize/title-set/SGR sequences inline. There is no structured event boundary the server can use to know "this byte was tmux's redraw vs. CLI's output". For Phase 3+ research: control-mode would give per-pane `%output` framing with explicit boundaries — eliminating §6.2 because each `%output` is delimited.

### 6.5 H5 — Server-side throttling/coalescing that splits escape sequences across batches

**Verdict: REJECTED.**

Evidence:
- There is **no** batching/throttling on the output path. `pty.onData` callback runs synchronously and fans out to all clients via `client.send(JSON.stringify({type:"output", data}))` immediately (`terminal-manager.js:298-302`).
- No `setInterval` or `setTimeout` is used to flush output. (Confirmed via grep — the only timeouts are: grace window calc 290-291, busy timer 265-268, ephemeral auto-destroy 732, xclip post-write 560-568, graceful-shutdown timer 303-306.)
- Therefore, "escape sequence split across batches" *cannot happen because there are no batches*. Each onData chunk → one WS frame.

What CAN happen, and is a different issue: a single pty.onData chunk MAY itself contain an incomplete escape sequence at the trailing edge, IF the upstream (tmux) split a write call. tmux is generally good about emitting whole sequences, but it is not guaranteed. The current code does not buffer trailing partial escape sequences. This is a latent risk, not the same as the rejected hypothesis.

### 6.6 H6 — nginx blue/green flip can sever WS without graceful drain → fresh server has empty replay

**Verdict: ACCEPTED.**

Evidence:
- Deploy script (`deploy.sh:104-110`):
  ```bash
  log "Switching nginx to port $new_port..."
  echo "server 127.0.0.1:$new_port;" > "$UPSTREAM_CONF"
  nginx -t && nginx -s reload
  log "Draining old instance (${DRAIN_WAIT}s)..."   # DRAIN_WAIT=5
  sleep "$DRAIN_WAIT"
  log "Stopping $old_name..."
  pm2 stop "$old_name"
  ```
  After `nginx -s reload`, **existing WS connections to the old upstream are kept alive by nginx** until they close themselves (this is normal nginx behavior — workers finish in-flight requests, but reload spawns new workers for new connections). The 5-second drain plus PM2 `kill_timeout: 45000` (`ecosystem.config.js:21,42`) gives the server some time.
- HOWEVER, on the new instance:
  - `_reconnectTmuxSessions` runs at constructor time and calls `tmuxCapture(sessionId, -1)` to seed `session.buffer` (`terminal-manager.js:177`). So the new server is NOT empty — it has the tmux scrollback.
  - But: clients reconnect via WS exponential backoff (`Terminal.tsx:84-94`, base 1s, cap 10s). Their `onopen` clears the local xterm with `term.clear()` (`Terminal.tsx:155`) and waits for the server-pushed buffer.
  - `attachToSession` (`terminal-manager.js:466-583`) sends `session.buffer` (which is the tmux capture) as one frame. So replay is **not empty**, but it IS the tmux scrollback, not the *prior* server's exact byte stream — meaning bytes that the old server emitted during its drain window may have already been displayed on the OLD client's xterm, then on reconnect the NEW server sends a `tmux capture-pane` which contains those same bytes again (visible duplication) plus possibly omits any uncommitted in-flight chunks.
- Add to that: during the overlap window (both blue and green running), if the user reconnects to the new instance while the old one's PTY was *still attached* to the same tmux session, you have **dual node-pty attaches** to one tmux session. tmux's `aggressive-resize on` (`tmux.conf:34`) + `window-size latest` will cause it to redraw to whichever client most recently attached — bursty redraws will travel up *both* PTYs. The old PTY's chunks will fan out to old clients; the new PTY's chunks will fan out to new clients — but the underlying tmux is producing the *same* bytes for both, doubled in time.

### 6.7 H7 — Two clients on one session → multiplexed broadcast without per-client cursor

**Verdict: ACCEPTED (latent, but observable).**

Evidence:
- `terminal-manager.js:298-302`: every onData chunk is sent to *every* member of `session.connectedClients` with no per-client cursor or seq number.
- `terminal-manager.js:506-508`: each new attach receives the *current* `session.buffer` (not a cursor-based slice). If client A is connected and has been receiving live chunks, then client B attaches mid-stream, B will see the full buffer (which already includes everything A has seen via live), then B and A will both receive subsequent live chunks. → A sees no double, B sees a snapshot then live (which overlaps with the tail of the snapshot — duplication risk because there's no seq).

### 6.8 H8 — xterm.js write() not awaited

**Verdict: NOT IN SCOPE FOR THIS SCAN (client-side scanner owns it), but flagged.**

Evidence: `Terminal.tsx:174` does `term.write(message.data)` with no second-arg callback and no chaining. xterm.js's docs say sequential `term.write` calls preserve order; not awaiting is normally OK. Do not block on this.

### 6.9 H9 — Reconnect race: late buffer flush vs. live stream

**Verdict: ACCEPTED.**

Evidence:
- See §5.6 and §6.7. The order on reconnect is: snapshot (`session.buffer`) → live chunks via the same ws send loop. There is no fence/boundary marker; the snapshot includes the bytes that arrived up to whatever moment `tmuxCapture` ran on the new server, but the live broadcast then begins with whatever onData fires next. If onData fires *while* the snapshot is being constructed/sent, the snapshot will include those bytes AND they will also be broadcast as live → duplicate.

---

## 7. Decisions closed

### 7.1 Are buffers passed as Buffer or string anywhere on the path?

**STRING the entire way.** node-pty defaults to UTF-8 string mode (`node-pty/lib/unixTerminal.js:64,95`); `terminal-manager.js:97-103` and `:715-721` do NOT override this. The only `Buffer` that touches anything in `terminal-manager.js` is the inbound base64-decoded image at line 533, which goes to xclip stdin and never to the PTY output path.

### 7.2 Is there ANY UTF-8 boundary handling?

**No explicit handling, but it's not needed at the producer.** Node's `StringDecoder` (under `setEncoding('utf8')`) handles codepoint boundary bookkeeping invisibly — partial leading bytes at chunk boundaries are buffered by the decoder until the next chunk completes them. Application code (this project) does no UTF-8 boundary work because it doesn't see bytes at all.

The *only* place a string is sliced by char index is `session.buffer.slice(-2_000_000)` (terminal-manager.js:295-296, 747-748). That is UTF-16 code-unit indexed, so it can theoretically split a surrogate pair (rare but non-zero — see §5.5).

### 7.3 Where exactly is the 500 KB replay sliced?

It is **NOT 500 KB** — that figure in `CLAUDE.md:28` is stale documentation. The actual cap is `2_000_000` chars, and the slice is at:
- `terminal-manager.js:295-296` (persistent sessions)
- `terminal-manager.js:747-748` (ephemeral sessions)

Both: `session.buffer = session.buffer.slice(-2000000);` — keep the trailing 2 million chars.

### 7.4 Is `pipe-pane`, `tmux -CC`, or raw attach used?

**Raw `tmux attach-session` over a node-pty PTY.** See §4 for the exact `pty.spawn` invocation. `tmux -CC` and `pipe-pane` are not used anywhere in the codebase. `capture-pane` is used only as a one-shot snapshot to seed `session.buffer` on three specific code paths (terminal-manager.js:177, 247, 489), never for live data flow.

---

## 8. Open questions (could not resolve from source alone)

1. **Does `tmux capture-pane -p -e -S -` return content with trailing newlines per visible row, or wrapped to terminal width?** This affects whether the snapshot we ship to a reconnecting browser will look correct in xterm.js's normal buffer (especially after we strip the alt-screen toggle). Confirming requires running a live tmux session and diffing capture output against what xterm renders. (For Phase 3 researchers: tmux man page says without `-J` lines are returned as wrapped, and `-e` injects ANSI for color; need to confirm behavior with backslash-r vs backslash-n line endings on multi-line wraps.)
2. **What exact code path triggers `_setupPty` to be called twice for the same session?** I see `_setupPty` invoked at `createSession:377`, `resumeSession:438`, and lazy-attach in `attachToSession:492`. If `attachToSession` runs more than once for a session whose `session.pty` was just nulled by `onExit` (line 306), can we end up with a duplicate `onData` listener stacked on a stale pty ref? Risk is low because `session.pty = null` is set in onExit before the next attach, but the dispatch order between events warrants a focused trace.
3. **How does node-pty's `tty.ReadStream` behave on backpressure when the WS sink is slow?** Since `ws.send` does not check `bufferedAmount` and the `ws` library buffers internally, a very slow client could OOM the server-side ws socket buffer. The `ws` library defaults are large but not infinite. Quantifying needs a benchmark. (Out of scope for Phase 2 — flagged for Phase 8.)
4. **Behavior of `aggressive-resize on` (`tmux.conf:34`) when blue & green are both attached during the deploy overlap window.** Observed risk (§6.6) but not directly proven without tcpdump'ing the upstream during a deploy.
5. **Does nginx's default `proxy_buffering on` cause any user-visible latency on WSS frames?** Per nginx docs, buffering applies to non-Upgrade responses; once the WebSocket Upgrade handshake completes, frames pass through. Worth verifying with `curl -v` during a stress test (Phase 8). The current `claude-terminal` config does not set `proxy_buffering off` (`/etc/nginx/sites-available/claude-terminal:26-38`).
6. **When `_syncFromDisk` (terminal-manager.js:226-255) discovers a new session created by the OTHER instance during blue-green overlap, can we end up with both instances calling `attachTmux` lazily on the same session at almost the same moment?** The `if (!session.exited && !session.pty && tmuxHasSession(sessionId))` gate at line 478 prevents same-instance double-attach, but does NOT coordinate across instances. A real dual-attach is only blocked by tmux itself (which permits multiple attaches to one session) — so the symptom would be both PTY processes receiving the same redraw burst and forwarding it to disjoint client sets. Needs a deploy-overlap reproduction to confirm.

---

## 9. Quick reference — every file touched in this scan

- `/root/projects/claude-terminal/server.js` — HTTP + WS upgrade, graceful shutdown
- `/root/projects/claude-terminal/terminal-manager.js` — PTY lifecycle, replay buffer, tmux glue
- `/root/projects/claude-terminal/tmux.conf` — tmux session settings
- `/root/projects/claude-terminal/CLAUDE.md` — project doc (stale 500 KB note)
- `/root/projects/claude-terminal/package.json` — node-pty 1.1.0, ws 8.19.0, @xterm/xterm 6.0.0
- `/root/projects/claude-terminal/deploy.sh` — blue-green deploy script (drain 5s, kill_timeout 45s)
- `/root/projects/claude-terminal/ecosystem.config.js` — PM2 blue & green configs
- `/etc/nginx/sites-available/claude-terminal` — WSS proxy (read for §6.6)
- `/etc/nginx/claude-terminal-upstream.conf` — single-line upstream pointer
- `/root/projects/claude-terminal/src/components/Terminal.tsx` — xterm.js client, WS reconnect
- `/root/projects/claude-terminal/src/components/EphemeralTerminal.tsx` — ephemeral terminal client
- `/root/projects/claude-terminal/node_modules/node-pty/lib/unixTerminal.js` — encoding default verification
- `/root/projects/claude-terminal/node_modules/node-pty/typings/node-pty.d.ts` — `encoding?: string | null` semantics

---

## 10. Tally for the controller

- Hypotheses confirmed (ACCEPTED): **5** — H2 (mid-escape trim), H3 (resize storms), H6 (blue/green replay drift), H7 (multi-client no cursor), H9 (reconnect race).
- Hypotheses rejected: **2** — H4 (no pipe-pane in code), H5 (no batching).
- Hypothesis partially rejected/mixed: **1** — H1 (UTF-8 byte cut not present, but UTF-16 surrogate cut at trim is theoretically possible).
- Hypothesis deferred to client-side scanner: **1** — H8 (xterm.js write not awaited).
- Biggest single risk: §5.5 + §6.2 — the **2 MB string trim with no escape-sequence awareness**, combined with the fact that the trimmed buffer is shipped verbatim as the *first thing* a reconnecting browser sees (`terminal-manager.js:507`). Every long-running session is one trim away from injecting a CSI fragment into a fresh xterm parser state.
