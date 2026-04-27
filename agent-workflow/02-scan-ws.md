# 02 — WebSocket Transport Scan (`scanner-ws-transport`)

> Audit of the WebSocket transport layer for the terminal stream.
> Strictly descriptive — no fixes, no edits.
> Every concrete claim cites `file:line`.

---

## 0. Scope & Inventory

### 0.1 Endpoints

The custom HTTP server (`server.js`) hosts **three** distinct WebSocket endpoints, each with its own `WebSocketServer` instance (all `noServer: true` and dispatched manually from a single `upgrade` handler):

| Endpoint | WSS instance | Manager | Where authoritative behavior lives |
|----------|--------------|---------|-----------------------------------|
| `/api/terminal` | `wss` (`server.js:155`) | `TerminalManager.attachToSession` / `attachToEphemeralSession` | `terminal-manager.js` |
| `/api/presence` | `wssPresence` (`server.js:156`) | `PresenceManager` | `presence-manager.js` + `chat-manager.js` (broadcasts on the same socket pool) |
| `/api/symphony-events` | `wssSymphony` (`server.js:141`) | inline `symphonyClients : Set<WebSocket>` (`server.js:124`) | `symphony-orchestrator.js` (calls injected `broadcast` callback) |

Library: [`ws@^8.19.0`](`package.json:62`) on the server, native browser `WebSocket` on the client.
Library defaults of interest (verified in `node_modules/ws/lib/websocket-server.js:46-72`):
* `maxPayload`: `100 * 1024 * 1024` (100 MiB) — server will close any incoming frame larger than that.
* `perMessageDeflate`: `false` (no compression negotiated).
* `clientTracking`: `true`.

**This document focuses on `/api/terminal`** (terminal stream and ephemeral provider-auth terminal). Presence / Symphony are referenced only when their behavior contradicts assumptions about the terminal layer (e.g. shared socket fan-out for chat).

### 0.2 Authentication path (relevant because every reconnect re-walks it)

Every WS connect on every endpoint walks the same auth chain:

1. Browser `fetch("/api/auth/ws-token")` (`Terminal.tsx:119`, `EphemeralTerminal.tsx:24`, `PresenceProvider.tsx:144`).
2. Server reads `auth-token` cookie, verifies it (Next.js route at `src/app/api/auth/ws-token/route.ts:6-13`), then issues a short JWT with `purpose:"websocket"`, `expiresIn:"30s"` (`route.ts:17-28`).
3. Browser opens `wss://…/api/terminal?sessionId=…&token=<jwt>` (`Terminal.tsx:144`).
4. Server's upgrade handler extracts `query.token`, runs `verifyJWT` (`server.js:104-111`), responds `HTTP/1.1 401 Unauthorized\r\n\r\n` and `socket.destroy()` if invalid (`:166-168`).
5. On success, `wss.handleUpgrade` completes the WebSocket handshake. The decoded JWT is **not retained** on the `ws` object — it's only used to gate the upgrade.

Implication for reconnect: every retry triggers a fresh token fetch (`Terminal.tsx:119`). If the cookie is missing/expired, the fetch returns 401 → the client increments `authFailureCountRef` (`:122`) and either retries (cap 10) or surfaces "Сессия истекла — обновите страницу" (`Terminal.tsx:435-438`). There is no token caching across reconnects — each attempt costs an HTTP round-trip.

### 0.3 Library config & defaults (verified)

`ws@^8.19.0` is constructed with **no options** at every call site (`server.js:141, 155, 156`). Therefore the following library defaults apply unchanged (verified in `node_modules/ws/lib/websocket-server.js:46-72`):

| Option | Default | Effect on terminal |
|--------|---------|--------------------|
| `maxPayload` | `100 * 1024 * 1024` (100 MiB) | Inbound `image` paste is bounded only by this; replay outbound has no analogous cap. |
| `perMessageDeflate` | `false` | No compression for the 2 MB replay snapshot. |
| `clientTracking` | `true` | `wss.clients` is a live `Set`, but our code never iterates it — we use our own `connectedClients` Set per session. |
| `maxBackpressure` | n/a in `ws@8` | Library does not signal backpressure; it relies on caller to inspect `bufferedAmount`. |
| `noServer` | `true` (we set it) | All three WSS instances reuse the single HTTP server's `upgrade` event, dispatched by pathname. |
| `handleProtocols` | unset | We don't negotiate subprotocols; client's `new WebSocket(url)` (no second arg) sends no `Sec-WebSocket-Protocol`. |

---

## 1. Message Protocol Table

All terminal frames are **text frames carrying JSON** (every `ws.send(...)` and `client.send(...)` site wraps the payload in `JSON.stringify`). No binary frames are sent or expected on `/api/terminal`. No length prefix, no framing layer of our own — we lean entirely on WebSocket frames.

### 1.1 Server → Client (terminal session)

| Type      | Payload shape                                  | Encoding        | When sent / Source line(s) |
|-----------|------------------------------------------------|-----------------|----------------------------|
| `output`  | `{ type, data: string }` — raw PTY bytes after ANSI alt-screen stripping | JSON / text     | (a) Initial replay on attach: `terminal-manager.js:507` (`session.buffer`), `:778` (ephemeral). (b) Live PTY data per `onData` chunk: `terminal-manager.js:300`, `:752`. (c) Server-generated error notice for xclip failures: `:553`, `:562`, `:570`. |
| `error`   | `{ type, message: string }`                    | JSON / text     | Pre-attach: missing `sessionId` (`server.js:175`), session not found (`terminal-manager.js:469`, `:770`). |
| `stopped` | `{ type }`                                     | JSON / text     | Sent right after the replay if the session is already exited at attach time (`terminal-manager.js:511`). |
| `exit`    | `{ type, exitCode: number, signal: number }`   | JSON / text     | (a) Real PTY exit when tmux is also gone — broadcast to all clients (`terminal-manager.js:318`). (b) Forced from `deleteSession` / `deleteSessionKeepFiles` with hard-coded `0/0` (`:620`, `:660`). (c) Ephemeral PTY natural exit (`:760`, `:813`). |
| (free-form text fallback) | raw `event.data` written to xterm | n/a | Not sent by the server, but the client interprets any non-JSON frame this way (`Terminal.tsx:193`, `EphemeralTerminal.tsx:57`). No server code path produces such frames today; this is dead defensive code unless something upstream injects raw text. |

Note: the `output` frame for the **initial replay** ships the entire `session.buffer` (capped at 2 MB — see `terminal-manager.js:295`) as a *single* string field inside one JSON message. There is no chunking.

### 1.2 Server → Client (presence — relevant because it shares the same connection that carries `chat_message`/orchestrator events)

| Type            | Payload shape | Source |
|-----------------|---------------|--------|
| `welcome`       | `{ type, peerId, colorIndex }` | `server.js:215` |
| `peers`         | `{ type, peers: [{peerId,name,colorIndex,sessionId}] }` | `presence-manager.js:94` |
| `cursor`        | `{ type, peerId, x, yBot, vh, name, colorIndex }` | `presence-manager.js:40-44` |
| `chat`          | `{ type, peerId, text, name, colorIndex }` | `presence-manager.js:56-59` (ephemeral cursor-bubble chat) |
| `chat_close`    | `{ type, peerId }` | `presence-manager.js:70` |
| `peer_left`     | `{ type, peerId }` | `presence-manager.js:103` |
| `session_peers` | `{ type, sessions: { [sid]: peers[] } }` | `presence-manager.js:119` |
| `chat_message`  | `{ type, message }` (persistent global chat) | `chat-manager.js:41`, broadcast via `chat-manager.js:144-150` over **the presence sockets** |
| `pending_user`  | broadcast on registration without SMTP | (caller side; presence is the carrier) |
| `pipeline_alert`| Symphony orchestrator alert | (orchestrator-side; carried over presence) |

These are not the terminal channel, but every browser tab opens BOTH `/api/terminal` and `/api/presence` simultaneously — when reasoning about reconnect storms or shutdown drains you have to consider both sockets.

### 1.3 Server → Client (symphony — inline)

| Type | Source |
|------|--------|
| `connected` | `server.js:257` |
| `task_updated`, `agent_started`, `agent_finished`, `chat_message`, `orchestrator_status`, `pipeline_alert` | `symphony-orchestrator.js:114, 142, 150, 158, 394, 417, 491, 1790`, `symphony-agent-runner.js:49,50,73,74,87,88` |

### 1.4 Concrete frame examples (sampled from code)

```jsonc
// server → client: live PTY chunk (terminal-manager.js:300)
{"type":"output","data":"[1;31mfailed[0m\r\n"}

// server → client: initial replay on attach (terminal-manager.js:507)
{"type":"output","data":"<…up to ~2_000_000 chars of UTF-8 string…>"}

// server → client: PTY exit when tmux is also gone (terminal-manager.js:318)
{"type":"exit","exitCode":0,"signal":0}

// server → client: session marked stopped (terminal-manager.js:511)
{"type":"stopped"}

// server → client: pre-attach error before WS upgrade (server.js:174-176)
{"type":"error","message":"No sessionId provided"}

// client → server: keystroke (Terminal.tsx:219)
{"type":"input","data":"l"}

// client → server: paste of escape-prefixed text would be DROPPED by the filter (Terminal.tsx:217)
//   regex /^\x1b\[[\?>=]/ — filters DA1/DA2/DA3 responses
//   regex /^\x1b\[\d+;\d+R$/ — filters CPR responses

// client → server: viewport resize (Terminal.tsx:160-166)
{"type":"resize","cols":120,"rows":40}

// client → server: clipboard image (Terminal.tsx:351)
{"type":"image","data":"<base64 PNG, multi-MB possible>"}
```

### 1.5 Client → Server (terminal session)

| Type     | Payload shape                                  | Encoding | When sent / Source line(s) |
|----------|------------------------------------------------|----------|----------------------------|
| `input`  | `{ type, data: string }` — keystrokes / paste text from xterm `onData` | JSON / text | `Terminal.tsx:219`, `EphemeralTerminal.tsx:63`. Filtered to drop xterm-emitted DA1/DA2/DA3/CPR responses (`Terminal.tsx:217`). |
| `resize` | `{ type, cols: number, rows: number }`         | JSON / text | (a) Right after `onopen` — sends the current size (`Terminal.tsx:160-166`). (b) On `fullscreen` toggle (`Terminal.tsx:67-73`). (c) Inside `ResizeObserver` callback per element resize (`Terminal.tsx:362-373`). (d) Ephemeral resize observer (`EphemeralTerminal.tsx:69-71`). |
| `image`  | `{ type, data: string (base64 PNG) }`          | JSON / text | Paste interception in capture phase when the clipboard contains an image (`Terminal.tsx:336-358`). The base64 may be multi-MB. Not subject to any client-side size guard. |

Server parses every incoming message via `JSON.parse(rawMessage.toString())` (`terminal-manager.js:516`, `:783`) inside a `try/catch` that **silently drops** malformed messages.

### 1.6 Client → Server (presence)

`{type: "join"|"switch", sessionId}`, `{type: "cursor", x, yBot, vh}`, `{type: "chat", text}`, `{type: "chat_close"}`. Handled in `server.js:217-235`.

### 1.7 Ping / Pong

* **No application-level ping/pong is implemented anywhere.** `grep -n "ping\|pong\|heartbeat\|keepalive" server.js terminal-manager.js presence-manager.js Terminal.tsx EphemeralTerminal.tsx` returns *zero* matches outside CSS animation classes.
* The `ws` library does support protocol-level ping frames (`WebSocket#ping`), but our server never calls them. There is no `ws.on('pong')` and no per-socket `isAlive` watchdog.
* Liveness is therefore exclusively driven by:
  * `nginx` `proxy_read_timeout 86400;` / `proxy_send_timeout 86400;` (`/etc/nginx/sites-available/claude-terminal:35-36`) — i.e. 24 h of silence permitted between bytes through the proxy.
  * The browser tab's own TCP keepalive defaults (no app override).
  * Explicit close codes from server side (`ws.close()` on errors).

Operational implication: a half-open TCP (cellular handoff, NAT timeout under 24 h) won't be detected by either side — the client will keep believing it is connected, and `ws.send` will queue into the kernel/`bufferedAmount`. Reconnect only fires when the OS surfaces an `RST` or the close eventually fires. (Hypothesis 4 in §7 elaborates.)

---

## 2. Reconnect State Machine

### 2.1 State diagram (terminal client)

```
                                   ┌──────────────────────────────────────┐
                                   │             unmountedRef             │
                                   │  (component teardown — no reconnect) │
                                   └──────────────────────────────────────┘
                                                    ▲
                                                    │ cleanup() in initTerminal returns
                                                    │
        ┌─────────────┐ initTerminal()   ┌──────────────────┐
   →    │ MOUNT       │ ───────────────► │ XTERM CREATED    │
        │ initRef=F   │                  │ wsRef=null       │
        └─────────────┘                  └──────────────────┘
                                                  │
                                                  │ connectWs()  isConnectingRef=true
                                                  ▼
                                       ┌────────────────────┐  fetch /api/auth/ws-token
                                       │ TOKEN_FETCH        │  401? → authFailureCount++
                                       └────────────────────┘
                                              │  ok           │ fail
                                              ▼               ▼
                       ┌──────────────────────┐         (count<10)→scheduleReconnect
                       │ NEW WebSocket()      │         (count≥10)→AUTH_EXPIRED (banner)
                       │ wsRef=ws             │
                       │ isConnectingRef=false│
                       └──────────────────────┘
                                  │
                            ┌─────┴─────┐
                            │           │
                       onopen          onerror/onclose
                            │           │
              isReconnectRef? yes:term.clear()
                            │
                send {resize cols,rows}
                            │
                            ▼
                       ┌────────────┐  onmessage→term.write(output)
                       │ CONNECTED  │  onData→ws.send({input,…})
                       │ attempt=0  │
                       │ reconnect  │
                       │   =false   │
                       └────────────┘
                            │
                  onclose (any code)
                            │
              code 4401 / 4404 ──► permanent stop (no reconnect)
                            │
                            ▼
                  isReconnectRef=true
                  scheduleReconnect()
                  delay=min(1000·2^attempt,10000)
                  attempt++
                  setTimeout → connectWs()
```

### 2.2 Step-by-step under the four failure modes

#### (a) Browser reload
Component unmounts → `useEffect` cleanup fires → `unmountedRef = true`, `wsRef.current.onclose = null`, `wsRef.current.close()` (`Terminal.tsx:387-403`). The new page mount starts from MOUNT and **does not transmit any "I am back" message** — it is just a fresh WS connection. Server treats it as a brand-new client of the existing session: replay buffer is sent via `output` frame at `terminal-manager.js:506-508`.

#### (b) Network drop (TCP RST or eventual close)
Browser fires `onclose` → unless code is 4401/4404 → `isReconnectRef = true`, `scheduleReconnect()` (`Terminal.tsx:197-208`). On the next successful connect, `term.clear()` is called inside `onopen` (`:155`) **before** the server sends the replay. The server side, on the new attach, does:
1. `session.connectedClients.add(ws)` (`terminal-manager.js:474`).
2. If `tmux` is alive but `node-pty` is detached, lazily `attachTmux()` and re-capture buffer from tmux first (`:478-501`).
3. `ws.send({type: "output", data: session.buffer})` (`:506-508`).
4. From this point onward `_setupPty.onData` is broadcasting incremental chunks to **all clients** including the new one.

#### (c) Server restart (single instance)
Server `gracefulShutdown` (`server.js:272-307`):
1. Waits for `symphonyOrchestrator.gracefulShutdown()` (no fixed bound; can take seconds).
2. Iterates `terminalManager.sessions` and `pty.kill()` each (`server.js:283-287`) — kills the **node-pty attachment** to tmux, but the tmux session itself survives because `tmux -L claude-terminal` is a separate process tree.
3. `wss.close()`, `wssPresence.close()`, `wssSymphony.close()` (`:290-292`). The `ws.WebSocketServer#close` only stops accepting new sockets and emits `close` on the WSS — *it does not synchronously close the existing client sockets*. Existing sockets continue until `server.close()` finishes draining HTTP, which then forces them.
4. Fallback hard exit at 40 s (`:303-306`); PM2 `kill_timeout: 45000` (`ecosystem.config.js:19,39`).

After restart the new process boots, runs `_loadSessions()` then `_reconnectTmuxSessions()` which sets `session.exited = false` and pre-captures `session.buffer = tmuxCapture(sessionId, -1)` (`terminal-manager.js:166-181`). PTY is **not** spawned until a client attaches. The reconnecting browser then triggers `attachToSession` → lazy `attachTmux` (`:478-503`) → replay sent.

#### (d) Blue/green flip
`deploy.sh:101-104`: `nginx -s reload` after switching `/etc/nginx/claude-terminal-upstream.conf` to the new port, then `sleep 5` ("drain"), then `pm2 stop $old_name`.

* `nginx -s reload` keeps existing connections on the **old worker** until they close naturally. A live WS is a long-lived HTTP/1.1 upgraded connection — nginx will hold the old worker around. This is fine until step…
* `pm2 stop` ⇒ SIGINT → graceful shutdown sequence. Old WSes get a server-initiated close.
* Browsers reconnect. New requests through nginx now hit the new upstream port. Crucially, the new server's `_loadSessions` ran on its own startup; it scans tmux for the same sockets. Since both blue and green use the same `tmux -L claude-terminal` socket (shared host), tmux state survives the flip.
* **However**: there is no inter-process buffer hand-off. Each color has its own in-memory `session.buffer`. The new instance's buffer was populated either (i) at startup from `tmuxCapture(-1)` or (ii) on lazy attach. Anything that was in flight in `onData` of the OLD instance and never written to tmux's own scrollback is lost (and `tmuxCapture` reads from tmux's scrollback, so it is normally fine for visible content).
* The 5 s drain (`deploy.sh:104`) is non-cooperative: it does not signal old clients to disconnect, it just waits 5 wall-seconds. Within that window the old server is still serving live `output` frames; after 5 s `pm2 stop` SIGINTs it and graceful-shutdown closes those sockets. Browsers see `onclose` and start the exponential backoff (1 s → 2 s → 4 s …).

#### Resume offset?

**No.** There is no concept of "I'm back, my last seq was X" anywhere in the codebase:
* The client does not send any post-`onopen` resume hint other than `resize`.
* The server does not record any per-client byte counter — `session.connectedClients` is a `Set<WebSocket>` (`terminal-manager.js:147`, `:474`) with no positional metadata.
* The replay is always "the entire current `session.buffer`" (capped at 2 MB) — see §3 for what that means in practice.
* Client compensates by calling `term.clear()` on reconnect (`Terminal.tsx:155`), then writing the full replay. That removes duplication of *visible* lines but cannot prevent reordering/duplication of bytes that were already written from the *prior* connection but were also re-captured into the new replay (the reload happens before the server's `output` arrives — see §6 hypothesis #2).

### 2.3 Reconnect timer / backoff

`scheduleReconnect` (`Terminal.tsx:85-94`):
```
delay = Math.min(1000 * Math.pow(2, attempt), 10000)
attempt++ (post-increment)
```
Cap is 10 s. There is no jitter, no max-attempt count for non-auth failures (auth is special-cased to 10 attempts via `authFailureCountRef`, `Terminal.tsx:122-128`). Post-increment means the first reconnect waits `1000 * 2^0 = 1000 ms`.

`PresenceProvider` uses a flat 3 s reconnect (`presence/PresenceProvider.tsx:316-318`), no backoff.

### 2.4 Client-side guards against connect storms

* `isConnectingRef` (`Terminal.tsx:103-104`, `:228`): synchronous reentrancy guard — if a `connectWs()` is in flight (awaiting token fetch), a parallel call returns immediately. **Caveat**: if `connectWs` throws/returns *without* clearing `isConnectingRef.current = false`, the ref is stuck. The `finally` block at `:227-229` covers this.
* Old socket cleanup at `:108-117`: nulls out `onclose`/`onmessage`/`onerror` then closes. This is correct: it prevents a late `onclose` from the previous socket from triggering another reconnect.
* `unmountedRef` (`:202`) prevents reconnect after unmount.

`EphemeralTerminal.tsx` has **no reconnect logic at all** — `ws.close()` on cleanup, `ws.onmessage` handler is set, but no `ws.onclose` reconnect (`EphemeralTerminal.tsx:47-79`). Acceptable because ephemeral sessions are short-lived (server destroys them after 5 min, `terminal-manager.js:732-734`).

---

## 3. Backpressure Audit

### 3.1 Server side

**There is zero `ws.bufferedAmount` inspection anywhere in the codebase.**

Every server-side send goes straight to `client.send(JSON.stringify(...))` after a single check `client.readyState === 1` (i.e. `WebSocket.OPEN`). Cite by call site:

| Line | Context | Guard |
|------|---------|-------|
| `server.js:128` | Symphony broadcast | `readyState === 1` only |
| `server.js:174` | Pre-attach error (no sessionId) | none (single ws) |
| `server.js:215` | Presence welcome | none |
| `server.js:257` | Symphony connected | none |
| `terminal-manager.js:300` | **Live PTY output** broadcast loop | `readyState === 1` only |
| `terminal-manager.js:317` | Exit broadcast | `readyState === 1` only |
| `terminal-manager.js:469` | Session-not-found error | none |
| `terminal-manager.js:507` | **Initial replay** (full `session.buffer` in one frame) | none — happens unconditionally inside `attachToSession` after the readyState check is implicit (socket just attached) |
| `terminal-manager.js:511` | `stopped` notice after replay | none |
| `terminal-manager.js:553`,`:562`,`:570` | xclip error notices | none |
| `terminal-manager.js:619`,`:660` | Delete-session exit broadcast | `readyState === 1` only |
| `terminal-manager.js:752` | Ephemeral live output | `readyState === 1` only |
| `terminal-manager.js:759` | Ephemeral exit | `readyState === 1` only |
| `terminal-manager.js:770` | Ephemeral not-found error | none |
| `terminal-manager.js:778` | Ephemeral initial replay | none |
| `terminal-manager.js:812` | Ephemeral destroy exit | `readyState === 1` only |
| `presence-manager.js:47,62,73,82,97,106,122` | Presence broadcasts | `readyState === 1` only |
| `chat-manager.js:147` | Global chat broadcast | `readyState === 1` only |

### 3.2 What happens when a client is slow

* `ws.send` in the `ws` library returns immediately. Outgoing data accumulates on the **server-side socket buffer** (kernel TCP send buffer + `ws` internal buffering reflected in `ws.bufferedAmount`).
* Because nothing reads `bufferedAmount`, there is **no eviction, no max-buffer-size, no drop-newest, no backpressure signal back to `node-pty`**. The producer side (`ptyProcess.onData` at `terminal-manager.js:279`) keeps appending to `session.buffer` and fanning out to every client unconditionally.
* As a result, a slow client causes its socket's internal buffer to grow until either (a) the OS rejects further writes (libuv emits an error → `ws` may emit `error` then `close`), or (b) Node's heap pressure triggers GC pauses, slowing every other client behind the same event loop.
* Per-client `session.buffer` does NOT exist — there is exactly one `session.buffer` shared across all clients of the session (`terminal-manager.js:294-296`, `:506`). The 2 MB cap (`:295`) bounds the **replay** size, not the per-socket transmit queue.

### 3.3 What happens when the socket is in CLOSING

* The `readyState === 1` guard prevents a `send` on a CLOSING/CLOSED socket — but only if the broadcasting loop checks before each send.
* The PTY broadcast loop (`terminal-manager.js:298-302`) iterates `session.connectedClients` and checks `readyState === 1` per client → safe, no throw.
* The replay send (`:507`), `stopped` (`:511`), exit notice (`:619`, `:660`) are sent without the readyState guard. If the socket transitions to CLOSING between `attachToSession` entry and the replay send (extremely tight window — same tick), `ws.send` would queue into the closing buffer and silently never deliver. No exception thrown by `ws@8` for an OPEN→CLOSING in-flight write, but the data is dropped on the floor with no callback (we never pass a callback).

### 3.4 No application-level write callbacks

None of the `ws.send(...)` sites pass the second `(err) => …` callback that `ws` supports. So an error during a fragmented write, a partial write to a slow socket, or a write-after-close all go unobserved.

### 3.5 No `error` listener on per-client sockets

`grep -n "ws.on('error'" terminal-manager.js` → 0 hits. Per-socket errors emitted by `ws` (e.g. write-after-close, malformed frame from client, unexpected RST) propagate to the WSS as `'error'` events — but the WSS has no listener attached either (`server.js:155`). When `ws@8` emits `error` on a client socket without a listener, Node's default behaviour is to crash the process with `Unhandled 'error' event`. The fact that we have not observed crashes suggests `ws` is internally swallowing these (it does for some categories) or that the path simply has not triggered in production. Adding an explicit `ws.on('error', () => {})` would be defensive.

### 3.6 Conclusion on backpressure

> **Backpressure does not exist in this codebase.** Producer rate (PTY) is decoupled from consumer rate (slowest WS). The only safety net is the OS-level send buffer; the only loss-prevention is the 2 MB replay cap. Slow clients silently degrade the entire session.

A minimal mitigation would be: before each `client.send`, check `if (client.bufferedAmount > THRESHOLD) { /* skip or close */ }`. We do none of this.

---

## 4. Binary vs Text

### 4.1 Client `binaryType`

`ws.binaryType` is **never set** anywhere in the client. Browser default is `"blob"`. Searched: `grep -rn "binaryType" /root/projects/claude-terminal/src` → 0 hits.

Practical effect: the server only sends text frames today, so the client never receives a binary message and the default is moot. **But** if any code path on the server were to call `ws.send(Buffer)`, the browser would deliver it as a `Blob`, and the current `event.data` handlers (`Terminal.tsx:169-194`, `EphemeralTerminal.tsx:49-59`) would fail JSON.parse and fall through to `term.write(event.data)` which would write `[object Blob]` — i.e. broken.

### 4.2 Server-side: Buffer vs string

Every server-side `ws.send(...)` invocation in scope passes a **string** (the result of `JSON.stringify(...)`):

* `server.js:128, 174-176, 215, 257`
* `terminal-manager.js:300, 318, 469, 507, 511, 553, 562, 570, 620, 660, 752, 760, 770, 778, 813`
* `presence-manager.js:40-44, 56-59, 70, 79, 94, 103, 119` — all `JSON.stringify`
* `chat-manager.js:145`

**No `ws.send(Buffer)` or `ws.send(Uint8Array)` exists.** PTY data arrives in `onData` as already-decoded UTF-8 string from `node-pty` (default behaviour) and is concatenated into `session.buffer` as a string (`terminal-manager.js:294`). It is never converted back to Buffer before transmission.

### 4.3 Server-side: incoming binary

`ws.on("message", (rawMessage) => { ... JSON.parse(rawMessage.toString()) ... })` (`terminal-manager.js:514-516`, `:781-783`, `server.js:217-235`). The `.toString()` coerces incoming Buffers to UTF-8 strings; binary frames would just be parsed as text and then JSON-failed (silently dropped by the surrounding try/catch).

### 4.4 Frame size & compression

* Outgoing JSON: largest expected frames are (a) initial replay up to ~2 MB UTF-8 (`:295`), (b) base64 image upload frame (`Terminal.tsx:351` — base64 of arbitrary clipboard image, multi-MB possible). Both fit under the 100 MiB `maxPayload` default.
* `perMessageDeflate: false` (library default for `ws@8`, never overridden). So a 2 MB replay is shipped uncompressed — for a slow mobile client this is the worst single-frame burst on the connection.

---

## 5. Multi-Client Fan-Out

### 5.1 Membership

Per session: `session.connectedClients = new Set<WebSocket>` (`terminal-manager.js:147`, `:236`, `:368`, `:725`).
* `add(ws)` on attach: `:474`, `:775`.
* `delete(ws)` on close: `:581`, `:588`, `:796`.

### 5.2 Live broadcast loop (PTY → all clients)

```js
ptyProcess.onData((rawData) => {
  const data = rawData.replace(ALT_SCREEN_RE, "");
  if (!data) return;
  ...
  session.buffer += data;
  if (session.buffer.length > 2000000) session.buffer = session.buffer.slice(-2000000);
  for (const client of session.connectedClients) {
    if (client.readyState === 1) client.send(JSON.stringify({ type: "output", data }));
  }
});
```
(`terminal-manager.js:279-303` — same shape for ephemeral at `:745-755`.)

* Broadcasting is **synchronous within the event loop iteration**. Order is the iteration order of the `Set` (insertion order, deterministic).
* The same `data` string is JSON-stringified anew for each client (no precompute optimization).
* The for-loop does not `await`, so if any client's `send` throws synchronously (it shouldn't in `ws@8` for a valid OPEN socket), it would bubble up and the loop would stop early — leaving later clients without that chunk. There is no `try` inside the loop.

### 5.3 Replay buffer — shared, not per-client

* `session.buffer` is a **single string** owned by the session, not per client (`terminal-manager.js:147`, `:294`, `:506`).
* On every new attach, the entire current buffer is shipped (`:506-508`).
* This means **a late-joining client sees only what fits in the trailing 2 MB at the moment of attach**, regardless of when other clients joined. Two clients attaching at different times will receive different "starts" of the same conversation but converge once both are connected.

### 5.4 Per-client divergence risk

Concrete scenarios where clients of the same session can see different cuts of the stream:

1. **Late-joiner replay overlap**: Client A is connected; Client B attaches. B receives the full `session.buffer` snapshot in one frame, *then* the next live `onData` chunk (for both). A sees only the live chunk. From A's perspective the stream is continuous; from B's perspective the snapshot may end mid-byte (cf. tmux scrollback dump) and the live chunk picks up from "right after the latest PTY emission" — which may NOT byte-align with the end of the snapshot. There is no de-dup or resume offset.

2. **Slow client cascade**: A is slow, B is fast. The for-loop sends to A first (insertion order), B second. If A's `send` has a synchronous error path (rare), B would never get this chunk. Realistically `ws@8` does not throw; but A's growing `bufferedAmount` does not gate B.

3. **Reconnect race**: When A reconnects, `attachToSession` calls `tmuxCapture(sessionId, -1)` (`:489`), overwriting `session.buffer` with the freshly captured tmux scrollback. **B is still attached and reading from the live `onData`**, but B's view of "the past" still matches what was already on its xterm. B is not re-synced — only A gets the fresh capture. Acceptable since B never lost frames; but the global `session.buffer` mutation can be interleaved with `onData` writes appending to it (single-threaded JS means no torn write, but the capture replaces the buffer rather than merging).

4. **Lazy PTY spawn**: First client on a tmux-restored session triggers `attachTmux` (`:490`). Until that returns, no `onData` fires. If two clients attach within microseconds of each other, both may go through `attachToSession`; the `if (!session.exited && !session.pty && tmuxHasSession(sessionId))` check at `:478` is per-call, so the second call would see `session.pty` already set by the first and skip. **However the readiness of `_setupPty` listeners is established synchronously inside `attachToSession`** (`:492`), so once the first client returns from `attachTmux`, the listener exists. The narrow window is between `attachTmux()` resolving and `_setupPty(...)` being called — a few statements. During that window any synchronous PTY data emission would be lost (none expected from `node-pty` in that microtick).

### 5.5 Stop / delete broadcasts

`stopSession` (`terminal-manager.js:443-464`) does NOT send any frame to clients — it only mutates `session.exited = true` and kills tmux+pty. Clients learn the session stopped only on their next `onmessage` (which arrives via the natural `_setupPty.onExit` path → `exit` frame at `:318`). If the PTY had already detached because tmux died, `:318` fires from inside `onExit`. If tmux is still alive at the moment of `stopSession` and `pty.kill()` runs, `_setupPty.onExit` fires; `tmuxHasSession(sessionId)` returns `false` because `stopSession` killed tmux before `pty.kill()` (`:448-450` then `:454-457`); so `exited = true` branch runs (`:316-321`) and the `exit` frame goes out. So this is consistent — but it's an indirect, easy-to-miss invariant.

`deleteSession` (`:592-634`) and `deleteSessionKeepFiles` (`:636-669`) **do** explicitly broadcast an `exit` frame and then `client.close()` each socket. The hard-coded `exitCode:0, signal:0` (`:620`, `:660`) is a fiction — the actual exit signal is whatever PTY died with, but we do not propagate it.

### 5.6 Image clipboard frames are echoed only to sender

`{type: "image"}` triggers an xclip pipeline for THAT session, then `\x16` is sent to the PTY. The PTY echo (if any) goes through the broadcast loop and reaches all clients. The `xclip error` notification, however, is sent only to the originating socket via the closure `ws.send(...)` (`terminal-manager.js:553`, `:562`, `:570`) — other clients of the session do not see the error notice.

### 5.7 Worked example: two-client divergence on long-output session

```
T0  Client A connects.  attachToSession lazy-attaches PTY; replay = capture-pane.
    Server → A: {output, data: "<full scrollback up to T0, ~200KB>"}
T1..T5  PTY emits live chunks D1..D5.  Server → A: {output, D1..D5}.  A's xterm in sync with tmux.
T6  Client B connects.
    attachToSession finds session.pty already set, does NOT re-capture (the if at :478 is false).
    Server → B: {output, data: session.buffer}      ← buffer = old replay + D1..D5 (still under 2MB)
    Server → B: {output, data: D6}                  ← happens immediately if onData fires before B's onmessage processes the snapshot
T7..   Both A and B receive same live D7..Dn in same order.

⇒ A and B converge on new content, but A never saw the snapshot framing of B's first frame.
⇒ B's first frame is megabytes; if B is on slow link, B lags A by the time it takes to ship that frame.
⇒ During that lag the live D6 chunk is queued into B's send buffer behind the snapshot — so B sees: snapshot, D6, D7, … in the right order, but with an absolute lag.
```

The shared `session.buffer` mutation between T1–T5 (`session.buffer += data` at `:294`) is what allows B's snapshot to include D1..D5. There is no per-client snapshot pin — the snapshot is whatever the buffer happens to be at the moment of `attachToSession`. Concurrent `onData` may extend the buffer in the same JS tick; insertion order is fully deterministic in single-threaded JS so there is no torn write, but the snapshot the new client receives is "the buffer as of the synchronous send call at `:507`".

---

## 6. Frame-Loss Surface — Exhaustive Catalogue

Every code path that can drop, duplicate, or reorder a frame.

### 6.1 Drop

1. **Slow / closing socket** — `ws.send` after socket transitions to CLOSING is a silent drop. Affected sites that don't pre-check `readyState`: `terminal-manager.js:507` (replay), `:511` (`stopped`), `:553/:562/:570` (xclip notices). (§3.3.)
2. **Backpressure overflow** — when the kernel's TCP send buffer is full and `ws.bufferedAmount` keeps growing, eventually the underlying socket emits `error` and `close`. Anything queued is gone. No callback informs the caller. (§3.2.)
3. **Replay truncation** — `session.buffer.slice(-2000000)` (`terminal-manager.js:295`, `:748`) operates on a UTF-8 string at *character* boundary in JS, but JS strings are UTF-16 code units → a slice can cut a surrogate pair (rare) and absolutely will cut mid-ANSI-escape sequence. The leading bytes of the new buffer may be garbage from xterm's perspective. The first thing a reconnecting client sees can be malformed.
4. **`tmuxCapture` failure** — if `execSync` throws (busy tmux server, signal interruption), `tmuxCapture` returns `""` (`terminal-manager.js:44-46`). The replay then becomes empty (`:177`, `:247`, `:489`). The new client would see a blank screen until live `onData` produces enough output to reconstruct context — and the live chunks alone do not contain a redraw cue, so the screen remains blank until a tmux-driven redraw (e.g. resize).
5. **`attachToSession` race against `pty.kill`** — between `tmuxHasSession(sessionId)` returning true (`:478`) and `attachTmux` succeeding, the tmux session could die. `attachTmux` would still spawn `node-pty` against `tmux attach-session`, which would print "no sessions" and exit immediately, hitting `_setupPty.onExit` (`:305-322`). If tmux is gone, `session.exited = true` and an `exit` frame goes to all clients — including the brand-new attachment that was expecting a stream.
6. **Malformed incoming `input`** — `JSON.parse` throws → caught and dropped silently (`terminal-manager.js:516`/`:575`). Real keystrokes are simple JSON, but a client bug or a partial read on the server (impossible in `ws` — frames are delivered whole) would lose input.
7. **Client filter on output query responses** — `Terminal.tsx:217` strips `ESC [ ?…`, `ESC [ >…`, `ESC [ =…`, and `ESC [ \d+ ; \d+ R$` from xterm `onData` before sending as `input`. Legitimate user pastes that begin with these escape-prefixes (theoretically) would be dropped without notification.
8. **Invalid UTF-8 in JSON** — `JSON.stringify` emits `�` for unpaired surrogates (browser tolerant) but raw bytes that don't form valid UTF-8 cannot get into `session.buffer` because `node-pty` already decoded them. PTY data is decoded with the platform default (UTF-8). If the underlying program emits a non-UTF-8 byte (rare in modern terminals), `node-pty` may replace with U+FFFD before we ever see it — i.e. a *content* drop, not a *frame* drop.
9. **Sym `gracefulShutdown` long sequence** — during shutdown, `wss.close()` is called (`server.js:290`). After this, no new connections accepted, but existing client sockets stay open until `server.close()` finishes. If `server.close()` is delayed by long-running HTTP requests, the new server may already be drinking traffic on the new port. Browsers that reconnect see a fresh server with a fresh `session.buffer = ""` (not yet captured). Only the very first attach calls `tmuxCapture` (`:489`), so the first reconnecting client repopulates the buffer. In the *interim*, additional reconnecting clients of the same session don't repopulate (because `session.pty` is now set after the first attach) — but their replay path at `:507` already sees the freshly populated buffer. Race window: between `attachTmux` returning and `session.pty = ptyProcess` (`:491`). Single tick — practically negligible.

### 6.2 Duplicate

10. **Reconnect replay vs. live overlap** — exactly hypothesis #2 in §7. On reconnect: server (a) ships `session.buffer` (the trailing 2 MB) then (b) future `onData` chunks. The buffer's tail may contain bytes that were already produced *and broadcast to the previous (now-closed) connection*. The browser already wrote them to its xterm before the disconnect. After reconnect, `term.clear()` (`Terminal.tsx:155`) is called inside `onopen` BEFORE the replay arrives (the replay is in `onmessage` after the `output` frame), so visually duplication is wiped. But the replay re-includes everything in tmux's scrollback up to "now" — anything that arrived between `onopen` writing the `resize` frame and the server actually sending the replay can show up twice in the buffer (once in the snapshot, once in subsequent live frames). Window is sub-millisecond on local but seconds-class on slow networks.
11. **Lazy reattach during alive PTY exit-then-respawn** — `_setupPty.onExit` (`:305-322`): if tmux is still alive, marks `session.pty = null` but does NOT mark `exited`. Next client attach lazy-spawns a new `node-pty` and re-captures buffer (`:489`). If the previous PTY's last `onData` chunk had already been broadcast to clients but the client was about to disconnect, that chunk may now appear twice when it shows up again in the fresh `tmuxCapture(-1)`.
12. **Multi-tab same user** — every browser tab opens its own `/api/terminal` socket and its own `/api/presence` socket. Both tabs receive `chat_message` broadcasts (presence-managed) and full terminal replay. Not strictly "duplicate frame" — duplicate **rendering** at the application layer.
13. **Symphony `chat_message`** — `chat-manager.js:144-150` broadcasts `chat_message` to **every presence peer** (no per-session filter). Every connected user receives every chat message in every project. The client (`PresenceProvider:252-264`) sorts watercooler messages out via a `projectId === null` check. This is by design but also a high-fan-out / amplification risk.

### 6.3 Reorder

14. **Replay snapshot interleaved with live stream** — same as (10), but emphasising order. Server send order: `output` (huge replay) then more `output` (small live). Client `onmessage` order matches server send order (WebSocket guarantees per-connection FIFO). However, a `resize` sent right after `onopen` (`Terminal.tsx:160`) lands in the server's input queue and may trigger `pty.resize` *before* the next `onData` cycle, which in turn can cause tmux to redraw — and that redraw lands in `onData` as new bytes that race with the replay still being prepared. Net effect: the replay can contain *pre-resize* state, immediately followed by *post-resize* state with a different geometry — visually a momentary scramble.
15. **`tmuxCapture` after PTY already attached** — `:489` calls `tmuxCapture` *while* `_setupPty.onData` may be receiving live bytes (if PTY were already attached, but the `if` at `:478` is supposed to gate this — the lazy path only runs when `!session.pty`). Within the lazy branch we then create a new `node-pty` (`:490`) and only after that does `_setupPty` register `onData` (`:492`). Between `attachTmux()` and `_setupPty` registration, the new node-pty is alive but no listener is attached — bytes emitted in that micro-window go to node-pty's internal buffer and are flushed to `onData` once the listener attaches (Node EventEmitter semantics). Order preserved, but if `tmuxCapture` returned while tmux was in the middle of emitting, the snapshot's last byte and the new-listener's first byte could overlap.
16. **Per-client interleave** — for two clients attached at slightly different times, Client B's first frame is the snapshot; meanwhile the loop at `:298` is also pushing the *current* `onData` chunk to BOTH clients. The order from B's POV: snapshot, then all subsequent chunks. From A's POV: just the chunk. If the server is in the middle of writing the snapshot to B (`ws.send` is buffering because the JSON is large), the next `onData` `client.send` for B is queued *after* the snapshot in the same socket — order is preserved. So this is NOT a reorder, but it is a long stretch of "B is behind A by one big frame".
17. **Symphony broadcast vs. terminal broadcast across sockets** — these are different sockets, so no cross-socket order is guaranteed even within the same browser. A `task_updated` (presence socket) and an `output` chunk (terminal socket) can land in any order in the React app. That's expected for distinct logical channels but it means UI events that should logically happen "after" a chat message might render before.

### 6.4 Surfaces by component (summary count)

| Component | Drop | Duplicate | Reorder | Total |
|-----------|------|-----------|---------|-------|
| Backpressure / closing socket | 2 (#1, #2) | — | — | 2 |
| Replay buffer | 2 (#3, #4) | 2 (#10, #11) | 1 (#15) | 5 |
| PTY lifecycle / lazy attach | 1 (#5) | 1 (#11) | 1 (#16) | 3 |
| Input parse / filter | 2 (#6, #7) | — | — | 2 |
| Encoding | 1 (#8) | — | — | 1 |
| Deploy / shutdown | 1 (#9) | — | — | 1 |
| Multi-client / multi-tab | — | 1 (#12) | — | 1 |
| Cross-channel (chat / sym) | — | 1 (#13) | 1 (#17) | 2 |
| Reconnect handshake interaction | — | 1 (#10) | 1 (#14) | 2 |
| **Total distinct surfaces** | **9** | **6** | **4** | **19 (some overlap)** |

Counting **unique numbered surfaces**: **17 distinct frame-loss surfaces** across drop / duplicate / reorder.

---

## 7. Hypothesis Checklist

### H1. No backpressure → slow clients cause buffer blowup or dropped writes when socket is CLOSING
**Verdict: ACCEPT (strong evidence).**
* No `bufferedAmount` check, no eviction, no per-client cursor (§3.1, §3.2).
* PTY producer rate is decoupled from per-client consumer rate.
* CLOSING-state writes silently drop because:
  * The replay path (`terminal-manager.js:507`) does not pre-check `readyState`;
  * `ws.send` is called without an error callback at every site (none of the cited lines pass a second argument);
  * No `ws.on('error')` handler is attached to per-client sockets in `terminal-manager.js` (the `ws` library will swallow per-write errors on a CLOSING socket if no callback is provided).
* Severity: high for sustained load; low for typical interactive use because PTY chunks are small (single keystrokes, screen refreshes).

### H2. Reconnect race: replay buffer pushed concurrently with live stream → duplication or reorder
**Verdict: ACCEPT (partial — duplication possible, hard reorder less likely).**
* On reconnect the server snapshots `session.buffer` at attach time and ships it as a single `output` frame, then continues streaming live `onData` chunks. WebSocket FIFO guarantees the snapshot lands first. (§2.2.b, §6.2.10, §6.3.14.)
* The snapshot's tail can overlap with bytes that have *also* been re-broadcast in the previous connection's lifetime — tmux scrollback contains both. Browser does `term.clear()` first (`Terminal.tsx:155`), then writes the snapshot, then writes live deltas — visual duplication is mostly avoided, but the *terminal state* (cursor position, wrap, modes) reconstructed from the snapshot may not align with the tail of the live stream because the snapshot is from `tmux capture-pane` which gives the rendered visible state, not the byte-accurate raw stream.
* Resize-on-open (`:160`) can race with the snapshot write — not a frame reorder per se, but a content reorder (pre/post-resize geometry interleaved).

### H3. Multi-client without per-client cursor → divergent slices
**Verdict: ACCEPT.**
* No per-client offset / cursor exists (§5.3). Each new attach replays the *current* shared `session.buffer`, which depends on (a) when the buffer was last captured (`tmuxCapture(-1)` at attach time `:489`) and (b) the 2 MB cap.
* Two clients attaching at different times will see different "starts" of the conversation. After attach, both receive the same live stream. So they converge for new content but each has its own "first frame" history.
* Acceptable for typical usage (joiners just want "the current screen"), but bad for mobile users joining mid-long-output (e.g. mid-`tail -f`) — the snapshot may end mid-line and the live stream picks up on a different line.

### H4. nginx blue/green flip severs WS without graceful drain → fresh server has empty replay
**Verdict: PARTIAL ACCEPT.**
* `deploy.sh` sequence: switch upstream → reload nginx → `sleep 5` → `pm2 stop $old_name`. Nginx reload keeps existing WS on the old worker; `pm2 stop` triggers SIGINT → `gracefulShutdown` (§2.2.d).
* Inside `gracefulShutdown` the order is: orchestrator drain → kill PTY processes → close WS servers → close HTTP server → 40 s timeout fallback. Crucially, **`pty.kill()` is called on every session** (`server.js:283-287`) before clients are told anything. This fires `_setupPty.onExit`, which checks if tmux is still alive (it is — same `tmux -L claude-terminal` socket survives) and merely nulls `session.pty` without sending an `exit` frame. So clients don't see an explicit "we're going down".
* Then `wss.close()` stops accepting new sockets but does not close existing ones. Existing client sockets are eventually closed when `server.close()` finishes (or when the 40 s force-exit fires).
* The new server boots with empty `session.buffer`. Its `_loadSessions` + `_reconnectTmuxSessions` populates buffers from `tmuxCapture(-1)` at startup (`terminal-manager.js:166-181`). So the "fresh server has empty replay" claim is partially false — the replay is actually re-captured from tmux's own scrollback. But anything that was in flight in the *old* server's `onData` and has not yet been written to tmux (basically everything `node-pty` had buffered but not flushed) is gone.
* The 5 s drain is a wall-clock sleep, not a cooperative drain — no client is informed early to start reconnecting. Clients only reconnect when the old server actually closes the socket, which may be up to 40 s later if `server.close()` hangs.

### H5. xterm.js `write()` not chained to its callback (cross-check with `Terminal.tsx`)
**Verdict: ACCEPT.**
* `term.write(message.data)` is called at `Terminal.tsx:174`, and decorative writes at `:177`, `:182`, `:187`, `:193`. Ephemeral: `EphemeralTerminal.tsx:52, 54, 57`.
* **None of these pass the optional second-arg callback.**
* xterm `write` is internally async (it queues into a writeBuffer that flushes per render frame). The library is documented to handle this safely *for sequential calls from the same execution context*, but the contract for back-to-back high-throughput chunks recommends chaining the next write inside the previous write's callback to avoid unbounded internal queue growth.
* Consequence: under high throughput (e.g. snapshot + many live chunks immediately on reconnect), the xterm internal write buffer can grow large, increasing render latency. Not a frame-loss bug, but a smoothness bug. Combined with H2, the visible "scramble" on reconnect is partly attributable here.

### H6 (bonus, observed but not in original checklist). No ping/pong → undetected dead connections
* No application-layer ping/pong; no `ws#ping()`; no `isAlive` watchdog (§1.6).
* nginx allows 24 h of idle (`proxy_read_timeout 86400`).
* Half-open TCP from cellular/NAT timeout sits indefinitely; `ws.send` from server piles into a dead socket; client never fires `onclose` → no reconnect → users see "frozen terminal" until they reload manually.

### H7 (bonus). Symphony WS path mismatch
* `SymphonyContext.tsx:256` connects to `/api/symphony-ws`, but `server.js:245` only handles `/api/symphony-events`. There is no upgrade handler for `/api/symphony-ws` in `server.js`. The browser's `WebSocket` constructor will succeed and immediately fail to upgrade (HTTP 404 from the Next.js handler downstream), then `onclose` fires and SymphonyContext reconnects (`SymphonyContext.tsx:315`). This is an existing latent bug, orthogonal to the terminal reliability work but visible in any deep WS audit.

---

## 8. Decisions Closed

| Question | Answer |
|----------|--------|
| Does server check `ws.bufferedAmount`? | **No.** Zero references. `grep -rn "bufferedAmount" /root/projects/claude-terminal` → 0 hits in our code. |
| Is there an ack/seq number anywhere? | **No.** No `seq`, `ack`, `offset`, or per-client cursor exists in the protocol or in `connectedClients`. |
| What happens to in-flight bytes during reconnect? | **Best effort, not preserved.** Bytes already broadcast on the dying socket are flushed to the OS buffer; if not yet on the wire, they're discarded when the socket closes. On reconnect, the server reconstructs replay from `tmuxCapture(-1)` (`terminal-manager.js:489`), so anything in tmux's scrollback shows up again. Anything node-pty had buffered but not yet handed to `onData` is lost. The snapshot may overlap with the previous tail (browser handles by `term.clear()` first). |
| Is `binaryType = "arraybuffer"` set? | **No.** `binaryType` is never assigned in the client. Browser default `"blob"` is in effect, but no binary frames are exchanged today. |
| Are there ping/pong frames? | **No.** Neither application-level (`type: "ping"`) nor protocol-level (`ws#ping()`). |
| Is the replay buffer per-client or shared? | **Shared.** One `session.buffer` per session, sliced to last 2 MB (`terminal-manager.js:294-296`), shipped whole to every new attach (`:506-508`). |
| Does the server send `Buffer` or `string`? | **Always `string`** (JSON via `JSON.stringify`). No `Buffer` send-sites in scope. |
| Does the server reject incoming binary frames? | **No explicit rejection.** Incoming Buffers are coerced via `.toString()` and JSON-parsed; non-JSON dropped silently in try/catch (`terminal-manager.js:516`/`:575`). |
| Is there a max-buffer-size eviction on the WS layer? | **Only via `maxPayload` 100 MiB default of the `ws` library.** No application-side eviction; no cap on outgoing socket buffer. |
| Is `perMessageDeflate` on? | **No.** Library default `false`, never overridden. 2 MB replays are uncompressed. |

---

## 9. Cross-Reference Summary (file → role)

| File:line | Role |
|-----------|------|
| `server.js:37` | Imports `WebSocketServer` from `ws` |
| `server.js:124-130` | Symphony broadcast helper — `readyState===1` only |
| `server.js:141, 155, 156` | Three `WebSocketServer({noServer:true})` instances |
| `server.js:158-264` | Single `upgrade` handler dispatches by pathname |
| `server.js:171` | `wss.handleUpgrade` for `/api/terminal` |
| `server.js:183` | Routes ephemeral vs durable based on `query.ephemeral` |
| `server.js:283-292` | Graceful shutdown sequence: kill PTY → close WSSs |
| `terminal-manager.js:147` | `connectedClients = new Set()` per session |
| `terminal-manager.js:271-323` | `_setupPty` — `onData` broadcast loop + `onExit` handling |
| `terminal-manager.js:294-296` | 2 MB replay cap |
| `terminal-manager.js:298-302` | Live broadcast: per-client `readyState` check, no backpressure |
| `terminal-manager.js:466-583` | `attachToSession` — entry path for terminal WS |
| `terminal-manager.js:478-503` | Lazy `attachTmux` on first client |
| `terminal-manager.js:506-512` | Initial replay + `stopped` notice (no readyState pre-check) |
| `terminal-manager.js:514-578` | Inbound message handler (`input`/`resize`/`image`) |
| `Terminal.tsx:24,30,31,33-35` | Refs for ws / reconnect state |
| `Terminal.tsx:85-94` | Exponential backoff (cap 10 s, no jitter) |
| `Terminal.tsx:98-230` | `connectWs` — token fetch + upgrade |
| `Terminal.tsx:148-167` | `onopen` — clear-on-reconnect + sends `resize` |
| `Terminal.tsx:169-195` | `onmessage` — JSON dispatch |
| `Terminal.tsx:197-209` | `onclose` — schedule reconnect unless 4401/4404 |
| `Terminal.tsx:211-221` | `onData` → `input` (with DA1/DA2/DA3/CPR filter) |
| `EphemeralTerminal.tsx:21-80` | Ephemeral WS handler — *no reconnect logic* |
| `presence-manager.js:1-128` | Presence broadcast logic — same `readyState===1`-only pattern |
| `chat-manager.js:144-150` | Global chat fan-out across all presence peers |
| `deploy.sh:101-108` | nginx reload → 5 s drain → `pm2 stop` |
| `ecosystem.config.js:19,39` | `kill_timeout: 45000` (PM2 SIGKILL deadline) |
| `/etc/nginx/sites-available/claude-terminal:35-36` | `proxy_read_timeout 86400; proxy_send_timeout 86400;` |

---

## 10. Code Excerpts (load-bearing for the findings above)

### 10.1 The PTY broadcast loop — single source of "live" frames
```js
// terminal-manager.js:279-303 (durable session)
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
```
The slice at byte 2_000_000 is a UTF-16-code-unit slice in JavaScript — it can split a surrogate pair, but more importantly it can split an ANSI escape sequence such as `\x1b[31m` mid-bytes, leaving the buffer head as a valid-looking but incomplete CSI. xterm.js's parser handles partials per-write by holding state, so this would only manifest at the **boundary between replay end and live start** if the slice happens to land mid-escape AND the next live chunk does not begin with the missing tail.

### 10.2 Initial replay path (no readyState pre-check)
```js
// terminal-manager.js:466-512 (extract)
attachToSession(sessionId, ws) {
  const session = this.sessions.get(sessionId);
  if (!session) {
    ws.send(JSON.stringify({ type: "error", message: "Session not found" }));
    ws.close();
    return;
  }

  session.connectedClients.add(ws);

  // Lazy PTY attachment ...

  // Send buffered output to the new client
  if (session.buffer) {
    ws.send(JSON.stringify({ type: "output", data: session.buffer }));
  }

  if (session.exited) {
    ws.send(JSON.stringify({ type: "stopped" }));
  }
  ...
}
```
Both `ws.send` calls run unconditionally without a `ws.readyState === 1` guard. In the common case the socket is OPEN immediately after `handleUpgrade` resolves; the risk is theoretical but real if the remote side sends a close frame before the upgrade callback runs.

### 10.3 Reconnect handling — client side
```js
// Terminal.tsx:148-167 (onopen)
ws.onopen = () => {
  reconnectAttemptRef.current = 0;
  setReconnecting(false);
  onConnectionChangeRef.current?.("connected");

  // On reconnect: clear terminal and let server send fresh buffer
  if (isReconnectRef.current) {
    term.clear();
    isReconnectRef.current = false;
  }

  // Send current terminal size
  ws.send(
    JSON.stringify({
      type: "resize",
      cols: term.cols,
      rows: term.rows,
    })
  );
};

// Terminal.tsx:197-209 (onclose)
ws.onclose = (event) => {
  onConnectionChangeRef.current?.("disconnected");
  wsRef.current = null;

  if (unmountedRef.current) return;
  if (event.code === 4401 || event.code === 4404) return;  // never set by server today

  isReconnectRef.current = true;
  scheduleReconnect();
};
```
Note: codes 4401 and 4404 are referenced but **never emitted by the server**. The auth failure path in the server simply writes `HTTP/1.1 401 Unauthorized\r\n\r\n` and `socket.destroy()` (`server.js:166-168`) — that is a TCP RST before the WS handshake completes, not a WS close code. The client's `onclose` for that case fires with `event.code === 1006` (abnormal closure) and reconnect proceeds normally — which is actually **wrong** for a permanent auth failure but consistent with the cookie-might-refresh-from-another-tab pattern at `Terminal.tsx:131-133`.

### 10.4 Server graceful shutdown
```js
// server.js:272-307
async function gracefulShutdown(signal) {
  console.log(`\n> Received ${signal}, shutting down...`);

  // 1. Symphony orchestrator graceful shutdown
  try {
    await symphonyOrchestrator.gracefulShutdown();
  } catch (err) {
    console.error("> Symphony shutdown error:", err.message);
  }

  // 2. Kill all PTY processes
  for (const [, session] of terminalManager.sessions) {
    if (!session.exited && session.pty) {
      try { session.pty.kill(); } catch {}
    }
  }

  // 3. Close WebSocket servers
  wss.close();
  wssPresence.close();
  wssSymphony.close();

  // 4. Close HTTP server
  server.close(() => {
    // 5. Close database
    try { db.close(); } catch {}
    console.log("> Shutdown complete");
    process.exit(0);
  });

  // Force exit after 45s
  setTimeout(() => {
    console.error("> Forced shutdown after timeout");
    process.exit(1);
  }, 40000);
}
```
The timeout is `40000` ms but the comment says 45 s — and PM2's `kill_timeout: 45000` (`ecosystem.config.js:19,39`) would SIGKILL at 45 s anyway. So in practice we have about 40 s for the WSSs to drain, which is plenty for normal cases but means a misbehaving client could keep the old process alive for the full window.

---

## 11. Notes for Downstream Agents

* `analyst-tradeoffs` should weight: introducing `ws.bufferedAmount` checks (cheap, single producer per session); per-client cursor (medium, requires protocol bump); seq+ack (medium, requires resume logic); switching to binary frames (cheap; `binaryType="arraybuffer"` + `Buffer.from(data,'utf8')` server side); enabling `perMessageDeflate` on the terminal WS only (cheap CPU vs bandwidth tradeoff for snapshots).
* The "ghost output / divergence" symptom most plausibly originates from H2 + H3 + H5 acting together, with H4 amplifying frequency due to per-deploy reconnect storms. H1 is a latent risk, not the proximate symptom.
* A separate Symphony issue (H7) should be opened — out of scope for the terminal reliability work but cleanly observable here.
