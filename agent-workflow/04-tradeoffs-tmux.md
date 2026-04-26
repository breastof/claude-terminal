# 04 — Tradeoffs: claude-terminal Streaming Reliability

> Phase 4 deliverable for `analyst-tradeoffs-tmux`.
> Mode: ANALYSIS ONLY — no winner picked. Arbiter (Phase 5) chooses.
> Inputs synthesised: `02-scan-pty.md`, `02-scan-ws.md`, `02-scan-client.md`, `03-research-streaming.md`, `03-research-tmux.md`.

---

## 1. Confirmed problem ledger

These are the Phase 2 problems every candidate solution must be scored against. IDs (`P1`–`P12`) are reused throughout the matrix. Each problem cites (a) the proximate code site, (b) the scan section that ACCEPTED the hypothesis, (c) the user-visible failure mode.

- **P1. Replay buffer trim cuts mid ANSI escape.** `session.buffer = session.buffer.slice(-2_000_000)` at `terminal-manager.js:295-296` (and ephemeral twin at `:747-748`) operates on UTF-16 code units, with no awareness of CSI/OSC/SGR framing. The trimmed prefix is then shipped verbatim as the first `output` frame to a new attaching client (`terminal-manager.js:506-508`). Reproduction: long-running session > 2 MB output, then any reconnect — the head of the replay frame is whatever character happened to be at index `length - 2_000_000` after the most recent `+=`. Concretely, if tmux emitted `\x1b[38;2;255;128;0m` and the slice landed mid-sequence, the new head starts with `128;0m...` which xterm.js parses as printable text. PTY scan H2 / §5.5 / §6.2 ACCEPTED; WS scan §6.1 frame-loss surface #3. **User-visible:** "garbage at top of replay" — colored escape fragments rendered as visible text after reconnect.
- **P2. Reconnect race: snapshot vs live overlap.** Lazy attach replaces `session.buffer` from a fresh `tmuxCapture(-1)` at `terminal-manager.js:489`, then ships it at `:506-508`; in the same tick or the next, the new node-pty's `onData` (`:279-303`) starts broadcasting live chunks to every client including the just-attached one. Resulting bytes can appear in both the snapshot (because they were in tmux's scrollback when the snapshot was taken) and the live stream (because the new node-pty also picked them up). Window: from a few microseconds to seconds-class on slow networks (because `ws.send` of the snapshot may be buffering while live `onData` continues). PTY scan H9 / §5.6 / §6.9 ACCEPTED; WS scan §6.2 #10, §6.3 #14, §6.3 #15; client scan §5.2 / hypothesis H2 ACCEPTED at screen-state level. **User-visible:** duplicated output regions immediately after reconnect; in worst cases, a momentary visual scramble before the screen settles.
- **P3. Multi-client divergence — no per-client cursor.** `session.connectedClients` is a `Set<WebSocket>` (`terminal-manager.js:147, 474`); the broadcast loop at `:298-302` fans the same JSON-stringified chunk to every member with no offset, seq or backpressure decision per client. New attach gets the *current* shared `session.buffer` (`:506-508`) regardless of when it joined. Two clients attaching at different times receive different "starts" of the same conversation. After both are attached they converge for new content, but the snapshot a late-joiner sees may end mid-line and the live stream picks up on a different visual position. PTY scan H7 / §6.7 ACCEPTED; WS scan §5.3 / §5.4 / §5.7 / hypothesis H3 ACCEPTED. **User-visible:** when joining mid-`tail -f` from a second tab, the snapshot does not visually align with the subsequent live updates.
- **P4. No backpressure anywhere.** `grep -rn "bufferedAmount" /root/projects/claude-terminal` → 0 hits. Every `client.send(...)` call (`server.js:128, 174, 215, 257`; `terminal-manager.js:300, 318, 469, 507, 511, 553, 562, 570, 620, 660, 752, 760, 770, 778, 813`; `presence-manager.js:40-122`; `chat-manager.js:147`) only checks `readyState === 1`. Producer rate (PTY `onData`) decoupled from slowest consumer; nothing reads `bufferedAmount`, no eviction, no max-buffer-size, no drop-newest, no signal back to node-pty. Slow client's outgoing buffer grows until the OS rejects further writes (libuv emits an error → `ws` may emit `error` then `close`) or Node's heap pressure triggers GC pauses slowing every other client behind the same event loop. WS scan §3 hypothesis H1 ACCEPTED. **User-visible:** under sustained high output (e.g. piping a large log) on a slow link, the entire session can become unresponsive; in worst cases, the server process degrades for ALL sessions sharing the event loop.
- **P5. Resize storms.** `Terminal.tsx:362-380` defines a `ResizeObserver` whose `handleResize` calls `fitAddon.fit()` and `ws.send({type:"resize",...})` synchronously per layout pass — no debounce. Server side at `terminal-manager.js:528` calls `pty.resize(...)` for every incoming resize, which propagates to tmux which (with `aggressive-resize on` + `window-size latest` per `tmux.conf:33-34`) re-paints the pane and emits a byte burst back. During mobile keyboard show/hide or window-drag, ResizeObserver can fire dozens of times per second; each fire causes a tmux pane redraw which is itself a burst of bytes that travels back up the pipeline. PTY scan H3 / §6.3 ACCEPTED; client scan §4 / §10.1 / hypothesis H3 ACCEPTED. **User-visible:** noticeable stuttering during window resize or mobile keyboard appearance; high CPU on both client and server during these events.
- **P6. Blue/green replay drift across deploy.** `deploy.sh:101-110` switches the upstream then `sleep 5` before `pm2 stop $old_name`; `gracefulShutdown` (`server.js:272-307`) calls `pty.kill()` on every session, then closes WSS, with a 40 s force-exit fallback. Each instance has its own in-memory `session.buffer`; on flip the new instance bootstraps from `tmuxCapture(-1)` (`terminal-manager.js:166-181`) — but bytes that were in flight in the old `onData` and not yet committed to tmux's scrollback are lost; bytes that *were* in the old buffer AND tmux's scrollback get re-shipped (overlap). The 5 s drain is non-cooperative: it does not signal old clients to disconnect, just waits 5 wall-seconds. PTY scan H6 / §6.6 ACCEPTED; WS scan §2.2.d / §6.1 #9 ACCEPTED. **User-visible:** every deploy produces 1-2 seconds of duplicated/missing bytes per active session; reconnect storms hit the new instance roughly 5-15 seconds after the upstream switch.
- **P7. xterm.js `term.write` calls fire-and-forget.** All 8 call sites (`Terminal.tsx:174, 177, 182, 187, 193`; `EphemeralTerminal.tsx:52, 54, 57`) discard the return and pass no callback. There is no flush barrier between the snapshot write at `Terminal.tsx:174` (when message #1 happens to be the replay) and subsequent live `output` writes; no barrier between `term.clear()` at `:155` and the snapshot write either; no barrier between any write and side effects like `fit()`, theme change, focus, scroll-to-bottom. xterm's WriteBuffer preserves arrival order intra-process, but the application takes no action contingent on parse completion. Client scan §2.3 / §10.2 / hypothesis H1 PARTIALLY ACCEPTED (sequential ordering preserved, but no parser-flush barrier for side effects). **User-visible:** under burst load (snapshot + many live chunks immediately on reconnect), the xterm internal write buffer can grow large, increasing render latency on the slow DOM renderer; visible stutter during replay.
- **P8. `term.clear()` instead of `term.reset()` on reconnect.** `Terminal.tsx:155` calls `term.clear()` inside `ws.onopen` if `isReconnectRef.current`. `clear()` clears the viewport but preserves parser state (CSI/OSC partial buffer), SGR attributes (color/style), cursor mode (DECSC/DECRC), alt-screen flag, application-cursor-keys mode (DECCKM), modes set by tmux on prior attach, scrollback. `term.reset()` is never called anywhere (`grep -rn "term\.reset" src` → 0 hits). If the prior connection died mid-CSI, the next replay byte is interpreted with stale parser state. Client scan §5.2 / §10 #3 / hypothesis H4 ACCEPTED. **User-visible:** rare, but reproducible on flaky networks where a connection dies during a CSI sequence — the next replay shows wrong colors or modes until something resets parser state.
- **P9. No ping/pong heartbeat anywhere.** `grep -n "ping\|pong\|heartbeat\|keepalive" server.js terminal-manager.js Terminal.tsx EphemeralTerminal.tsx presence-manager.js` → zero hits outside CSS classes. Liveness depends on nginx `proxy_read_timeout 86400` (`/etc/nginx/sites-available/claude-terminal:35-36`) and the OS TCP keepalive defaults. Half-open TCP from cellular handoff or NAT timeout sits indefinitely until the next `ws.send` triggers an RST. The browser tab keeps believing it's connected; `ws.send` on the input path queues into the kernel buffer. WS scan §1.7 / §6 hypothesis H6 (bonus) ACCEPTED. **User-visible:** "frozen terminal" symptom — user types and nothing happens, no reconnect indicator; manual page reload required to trigger a fresh WS handshake.
- **P10. JSON envelope + UTF-16 surrogate hazards on output frames.** Server wraps every chunk in `JSON.stringify({type:"output", data})` (`terminal-manager.js:300, 752`); browser does `JSON.parse(event.data)` (`Terminal.tsx:171`, `EphemeralTerminal.tsx:50`). `slice(-2_000_000)` operates on UTF-16 code units; a high surrogate at position L-2_000_001 with low surrogate at L-2_000_000 means slice keeps the low surrogate and drops the high. The lone surrogate is then emitted by JSON.stringify as `\udxxx` literal escape and xterm receives an invalid surrogate via `term.write`. Rare because non-BMP codepoints (emoji etc.) are uncommon in tmux output but non-zero. PTY scan §5.5 / §6.1 partial accept; WS scan §6.1 #3. **User-visible:** very rare emoji corruption at trim boundaries; usually invisible.
- **P11. JSON.parse fallback writes raw frame.** `Terminal.tsx:191-194` and `EphemeralTerminal.tsx:55-58` both fall through to `term.write(event.data)` on any JSON.parse exception. Today the server emits only JSON (verified at all `JSON.stringify` sites in WS scan §1), so dormant — but the moment a binary frame, a Blob, or a malformed text frame appears on the wire, the screen is corrupted. If a future code path on the server were to call `ws.send(Buffer)`, the browser would deliver it as a `Blob`, `JSON.parse(Blob)` would throw, and the catch branch writes the Blob's `toString()` ("`[object Blob]`") into the terminal. Client scan §10 #4 ACCEPTED. **User-visible:** dormant today; activated by any binary protocol change.
- **P12. Default `binaryType = "blob"` and shared-buffer fan-out coupling.** Browser never sets `ws.binaryType` (`grep -rn "binaryType" /root/projects/claude-terminal/src` → 0 hits). The default is `"blob"`. If any future code path sends a binary frame, `event.data` arrives as a `Blob`, `JSON.parse(Blob)` throws, and P11 fires. Coupled to P11: the impossibility of switching to binary frames without changing the receive path is a meta-problem that constrains the protocol-evolution surface. Client scan §3.1 / §4 / §10 #6. **User-visible:** dormant today; active constraint on what the protocol can become.

A handful of additional observations from the scans are intentionally OUT of scope here — they are real but do not belong in the streaming-reliability rubric:
- Dead `4401/4404` close codes referenced at `Terminal.tsx:201` but never emitted by server (auth failure path uses raw TCP RST; `event.code === 1006` instead).
- `EphemeralTerminal.tsx` has no reconnect logic at all (acceptable because ephemeral sessions are short-lived).
- Symphony WS path mismatch (`SymphonyContext.tsx:256` connects to `/api/symphony-ws` but server only handles `/api/symphony-events`).
- Documentation drift at `CLAUDE.md:28` ("500 KB circular" vs actual 2 MB).
- Theme hot-swap on `Terminal.tsx:50-54` doesn't reset/clear buffer (consistent with intended UX).

---

## 2. Candidate solution roster

Every candidate technique surfaced in Phase 3 is enumerated below with a stable ID. Each citation is `(Project §)` for streaming research and `(Recipe §)` for tmux research.

**C1. Chunk-list replay buffer with per-client cursor.** Replace the `String += chunk` accumulator at `terminal-manager.js:294` plus the `slice(-2_000_000)` trim at `:295-296` with a `Vec<{seq, data}>`-style list capped by total bytes; evict oldest *whole* chunks (chunks are exactly what `pty.onData` produced, so node-pty's `StringDecoder` already aligned them on UTF-8 codepoints); track `chunk_offset` and `byte_offset` counters so absolute seq numbers stay valid across eviction; allow clients to subscribe at a specific `lastSeq`. The sshx `Vec<Bytes>` data structure (03-streaming 1.4 `crates/sshx-server/src/session.rs:add_data`) is the canonical reference: 2 MiB cap (`SHELL_STORED_BYTES: u64 = 1 << 21`), eviction by chunk granularity, no per-byte slicing. (`03-streaming P5 / sshx 1.4 / 03-tmux 10.3 Recipe Z`).

**C2. PAUSE/RESUME backpressure on `term.write` callback.** Add PAUSE and RESUME messages (or binary opcodes if paired with C9). Client tracks bytes-since-last-ack with high/low watermarks (ttyd defaults: ~2 MiB high, ~512 KiB low); on crossing high-water, client emits PAUSE; server calls `node-pty.pause()`. On crossing low-water, client emits RESUME; server calls `node-pty.resume()`. Optionally tie ack emission to xterm's `term.write(data, callback)` so the throttle gates on actual parser drain rather than `bufferedAmount` — wetty's pattern (03-streaming 1.3 `client/wetty.ts:51-66`) gives end-to-end backpressure including the slow-rendering DOM-renderer case. ttyd's binary opcode discipline (`'2'` = PAUSE, `'3'` = RESUME, 03-streaming 1.1 `protocol.c:316-325`) is the production reference. (`03-streaming P4 / ttyd 1.1 / wetty 1.3`).

**C3. Segmented `(cols, rows, data)[]` replay with per-segment flush + `replayComplete` marker.** VS Code's recorder model: the replay buffer is a list of `ReplayEntry { cols, rows, data }` segments where a new segment starts on every resize (`terminalRecorder.ts:39-60`, 03-streaming 1.6). Trim evicts head bytes within the head segment via substr, never crosses a resize boundary. On the wire, the replay event ships the entire array; client iterates: applies `OverrideDimensions(cols, rows)`, then writes the data with `await writePromise`, then loops to next segment. After the last segment, server fires explicit `OnProcessReplayComplete` (`basePty.ts:handleReplay`). Total cap 10 MiB (`MaxRecorderDataSize`). (`03-streaming P8 + P17 + P18 / VS Code 1.6`).

**C4. Switch to tmux `-CC` control mode (Recipe Y).** Change `pty.spawn("tmux", ["...", "attach-session", "-t", sessionId])` at `terminal-manager.js:93-103` to include the `-CC` flag (`["...", "-CC", "attach-session", "-t", sessionId]`). Add a `ControlModeParser` (sketch in 03-tmux §2.11) that consumes line-oriented input: `%output %paneId <octal-escaped-bytes>\n` for live data; `%begin/%end/%error` for command replies; ~24 other notification types (03-tmux §2.4) for layout, sessions, panes. Input via `send-keys -l <bytes>` (or `-H` hex for non-printable). Sizing via `refresh-client -C cols×rows`. Flow control via `pause-after=N` (C18). (`03-tmux 10.2 Recipe Y / iTerm2 8.1`).

**C5. `tmux capture-pane` snapshot on reconnect (Recipe X).** Replace ad-hoc `tmuxCapture(sessionId, -1)` calls (`terminal-manager.js:177, 247, 489`) with a robust `tmuxSnapshot()` that: (a) reads alt-screen state via `display-message -p '#{alternate_on}'`; (b) reads cursor position via `display-message -p '#{cursor_x},#{cursor_y}'`; (c) executes `capture-pane -t <id> -p -e -J -S - -E -` (with `-a` if in alt-screen); (d) CRLF-normalises (`\n` → `\r\n`); (e) prefixes with `\x1b[2J\x1b[H` clear+home and suffixes with `\x1b[Y;XH` cursor-position. Ship as a single ANSI-clean snapshot frame. Stop using `session.buffer` for new-attach replay path; the live `+=` accumulator becomes optional (kept for forward streaming, no longer the snapshot source). (`03-tmux 10.1 Recipe X / capture-pane §4`).

**C6. `term.reset()` instead of `term.clear()` on reconnect.** Replace the single line at `Terminal.tsx:155` (and ephemeral counterpart if applicable) inside the `isReconnectRef.current` branch from `term.clear()` to `term.reset()`. `term.clear()` clears the viewport but preserves parser state, SGR attributes, alt-screen flag, mode flags, scrollback. `term.reset()` is a hard reset of all of those. ttyd's pattern: `terminal.reset()` on every `onSocketOpen` after the first (03-streaming 1.1 `xterm/index.ts:onSocketOpen`). (`03-streaming P19 / ttyd 1.1 / 03-tmux §11.4 D8`).

**C7. Chain `term.write` calls via callback.** Switch all 8 `term.write(data)` call sites (`Terminal.tsx:174, 177, 182, 187, 193`; `EphemeralTerminal.tsx:52, 54, 57`) to use the second-arg callback signature `term.write(data, callback)` for the cases where downstream operations (next write, geometry override, fit, focus, scroll-to-bottom, replay-complete handler) must wait for parser drain. xterm.js v6 callback API is the documented mechanism for sequencing operations against the WriteBuffer; without it, `fit()` or `term.options.theme = X` mutations applied between writes can race the parser. (`03-streaming P17 / VS Code BasePty.handleReplay 1.6`).

**C8. Debounce client FitAddon + debounce server-side resize.** Client side: wrap the `Terminal.tsx:362-380` `handleResize` body in a 50–100 ms `setTimeout`-based debounce (or coalesce via `requestAnimationFrame`); same for `EphemeralTerminal.tsx:69-71`. Server side: in the WS message handler at `terminal-manager.js:528`, check `if (cols === session.cols && rows === session.rows) return;` before calling `pty.resize`. VS Code's `TerminalRecorder.handleResize` (`terminalRecorder.ts:43-46`) shows the cleanup pattern for empty back-to-back resize entries. (`03-streaming P15 / VS Code TerminalRecorder / 03-tmux §11.3`).

**C9. Switch WS `binaryType` to arraybuffer + send Buffer for output frames.** Server: emit `output` and `snapshot` payloads as binary frames via `ws.send(Buffer.from(data))` (or `ws.send(uint8)` for opcode-prefixed binary). Browser: set `ws.binaryType = "arraybuffer"` (currently the default `"blob"` per WS scan §4.1, never assigned in client); receive handler dispatches by reading the first byte of the ArrayBuffer (ttyd opcode pattern, 03-streaming 1.1) or by length-prefix; xterm.js v6 accepts `Uint8Array` directly via `term.write(uint8)` (verified in `addon-attach`, 03-streaming 1.8 with explicit comment "always set binary type to arraybuffer, we do not handle blobs"). (`03-streaming P1 / ttyd 1.1 / sshx 1.4 / addon-attach 1.8`).

**C10. Add seq+ack protocol (Recipe Z).** Every server→client `output` and `snapshot` frame carries an absolute `seq: bigint` field (cumulative byte count since session start, monotonically increasing). Client persists `lastSeq` per session in `sessionStorage` (or in-memory if cross-tab persistence isn't needed). On reconnect, client emits `{type:"hello", protocol_version: 2, lastSeq}` as the first message after `ws.onopen`. Server: if `lastSeq >= session.prunedSeq`, replay only chunks where `seq > lastSeq`; if behind the rolling buffer window (`lastSeq < session.prunedSeq`), fall back to a capture-pane snapshot (C5) and assign a new seq epoch starting at `session.totalSeq`. sshx's `WsClient::Subscribe(sid, chunknum)` + `WsServer::Chunks(sid, seqnum, Vec<Bytes>)` is the canonical reference. (`03-streaming P5 / sshx 1.4 / 03-tmux Recipe Z 10.3`).

**C11. Add ping/pong + idle-disconnect detection.** Two viable mechanisms: (a) application-level `{type:"ping", ts}` / `{type:"pong", ts}` every 15–30 s; client tracks last-pong time, triggers reconnect if no pong > 60 s. (b) Protocol-level `ws.ping()` server-side every 30 s with `ws.on('pong', () => isAlive=true)` watchdog; standard `ws@8` pattern. Either gives RTT measurement as a side effect. The current state per WS scan §1.7 is zero matches for `ping|pong|heartbeat|keepalive` outside CSS classes; nginx's `proxy_read_timeout 86400` is the only liveness mechanism. (`03-streaming P16 / sshx 1.4 / ttyd --ping-interval=5`).

**C12. Per-client broadcast cursor.** Replace the synchronous `for (client of session.connectedClients) { if (client.readyState === 1) client.send(JSON.stringify({type:"output", data})); }` loop at `terminal-manager.js:298-302` with a per-client async subscription model. Each `connectedClients` entry becomes a `{ ws, lastSeq, queue }` record; new chunks are pushed to all queues; per-client send loops drain their own queues independently. sshx's per-`Subscribe` `tokio::spawn` (03-streaming 1.4 `socket.rs handle_socket loop body`) is the canonical pattern; in Node, an async iterator or a bounded queue per client is the equivalent. Slow clients no longer block fast ones; each can be independently paused/drained/dropped. (`03-streaming P20 / sshx 1.4`).

**C13. Persist replay to disk/Redis across blue/green flips.** Add a snapshot store. On graceful shutdown (`server.js:272-307`), serialize each session's `{seqnum, prunedSeq, last K bytes}` to either Redis (sshx-style zstd+protobuf, 03-streaming 1.4 `session/snapshot.rs`) or SQLite (already a project dep). New instance restores from the store before accepting WS upgrades; clients with their own seq (from C10) can `subscribe-with-offset` and get clean replay across the flip. sshx caps snapshot at 32 KiB (`SHELL_SNAPSHOT_BYTES: u64 = 1 << 15`) — small enough to be cheap, large enough to "draw the screen the user just saw". (`03-streaming P14 / sshx 1.4`).

**C14. xterm.js `SerializeAddon` round-trip as snapshot source.** `npm install @xterm/addon-serialize`. Load alongside `FitAddon` and `WebLinksAddon` (`Terminal.tsx:248-249`). On `ws.onclose`, call `serializeAddon.serialize()` and store the resulting ANSI string in `sessionStorage` keyed by sessionId; capture cursor position separately. On `ws.onopen` (reconnect), restore the snapshot via `term.write(stored)` as immediate visual before the server snapshot arrives. Server-side replay still authoritative — Serializer is a perceived-latency reducer for same-tab reconnects. Marked experimental in xterm.js master (03-tmux §8.8 limitations: SGR/combining-mark/CJK edge cases). (`03-streaming P10 / addon-serialize 1.8 / 03-tmux 8.8`).

**C15. Tighten `tmux.conf` knobs.** At minimum: `window-size manual` + `default-size 200x50` + `aggressive-resize off` — eliminates the "tmux resizes pane and emits redraw burst" cascade that drives P5 (03-tmux §6.2). Server `pty.resize` becomes effectively a no-op; xterm.js letterboxes locally to its container. Supporting changes: `default-terminal "tmux-256color"` (more accurate than `xterm-256color`), `terminal-features ",*256col*:RGB,clipboard,focus,sync"` (enables synchronized updates for atomic redraws), `focus-events on`, `automatic-rename off`, `monitor-bell off`, `set-clipboard off`. (`03-tmux §7 / §11.3`).

**C16. Server-side throttled batcher (`tinybuffer`).** Per-session (or per-client if C12 adopted) accumulator that coalesces PTY chunks into one WS frame per N ms (typical: 2–5 ms) or per K bytes (typical: 512 KiB), whichever comes first. Wetty's `tinybuffer(socket, 2, 524288)` (03-streaming 1.3 `server/flowcontrol.ts:6-29`) and VS Code's `TerminalDataBufferer(throttleBy=5)` (03-streaming 1.6 `terminalDataBuffering.ts:23-46`) are both production-proven. Concatenation within one batch is escape-safe (adjacent chunks join, completing partial CSIs). (`03-streaming P11`).

**C17. Drop slow clients (broadcast-channel `Lagged` eviction).** Before each `client.send`, check `client.bufferedAmount > THRESHOLD` (e.g. 8 MiB); if exceeded, `client.close(4503, "lagging")` and let the client reconnect. sshx's design with `tokio::sync::broadcast::channel(64)` and `BroadcastStreamRecvError::Lagged(n)` (03-streaming 1.4 `session.rs:101`, `socket.rs:154`) gives the same semantics — slow clients dropped, producer never throttled. Pairs naturally with C2 (PAUSE/RESUME first as graceful throttling, eviction as last-resort ceiling) and C10 (kicked client's reconnect with `lastSeq` resumes cleanly). (`03-streaming P12 / P13`).

**C18. `pause-after` flow control over `-CC`.** When on `-CC` (C4), set `pause-after=N` (typically N=5 seconds) via `refresh-client -f pause-after=5`. When a pane has been buffering more than N seconds, tmux emits `%pause %paneId` and stops reading from the pane. Gateway issues `refresh-client -A '%paneId:continue'` to resume. While paused, `%output` is replaced by `%extended-output %paneId <age-ms> ... : value` giving telemetry on buffer age. (`03-tmux §2.7`).

**C19. Snapshot+delta with full screen state model (mosh SSP).** Server runs a full UTF-8-aware ANSI parser (mosh: `Parser::UTF8Parser`) feeding a complete framebuffer model (`Terminal::Emulator` + `Terminal::Framebuffer`). Each side maintains a state object indexed by monotonic state numbers; communication is `Instruction { old_num, new_num, ack_num, diff }` where the diff is the byte-stream that transforms `state[old_num]` into `state[new_num]`. Idempotent: re-applying the same `new_num` is a no-op; out-of-order applied via reference-state lookup. Bandwidth bounded on long disconnects because only the diff from the last ack is sent. (`03-streaming P9 / mosh 1.7`).

**C20. `pipe-pane` redundant byte tap.** Run `pipe-pane -O -t %paneId 'cat >> /var/log/sessions/%paneId.log'` to grow an authoritative byte log of the application's stdout alongside the attach. The log is byte-for-byte what the application produced (no tmux re-encoding, no SGR translation, 03-tmux §3.2); useful as a backup, for cross-instance reconciliation, or for offline log analysis. Critically: pipe-pane gets only application bytes — no tmux redraws, no resize-driven repaints, no status-line updates (03-tmux §3.3). One pipe per pane (tmux refuses to attach a second). (`03-tmux §3`).

**C21. Authoritative `replay_complete` end marker.** Even without seq numbers (C10), the server sends an explicit `{type:"replay_complete"}` (or equivalent) frame after the snapshot is fully sent and before live data flows. Client uses this to perform one-shot post-replay actions: `fitAddon.fit()`, `term.focus()`, `term.scrollToBottom()`, hide the reconnecting banner, switch the connection-status indicator to "live". VS Code's `OnProcessReplayComplete` (03-streaming 1.6 `basePty.ts handleReplay`) is the reference. (`03-streaming P18 / VS Code OnProcessReplayComplete`).

**C22. Side-band `-CC no-output` gateway client.** One server-side `tmux -CC` client per session configured with `refresh-client -f no-output,ignore-size,read-only`. This client receives only structured notifications (`%layout-change @windowId layout ...`, `%window-add @windowId`, `%window-renamed @windowId name`, `%session-changed $sessionId name`, `%pane-mode-changed %paneId`, `%subscription-changed name $s @w win-idx %p ... : value`) without ever receiving `%output` for actual byte traffic. Useful for surfacing tmux state changes to a dedicated UI channel without doubling byte fan-out. (`03-tmux §2.9, §5.3`).

This is the candidate roster the matrix scores.

---

## 3. Scoring matrix

Columns:
- **Fixes** — Phase-2 problem IDs the candidate addresses.
- **LoC** — rough new-code estimate.
- **Files** — primary files touched.
- **Deploy risk** — blue/green safety, rollback, hot-swap.
- **Latency cost** — extra ms per byte / per reconnect.
- **Mobile/UX** — interaction with the mobile-first workstream coming next.
- **Ops cost** — monitoring, debugging, on-call.
- **Rollback** — feature-flag possible? per-session toggle? revert-by-redeploy?
- **Coupling** — what other items it requires or implies.

Latency / cost cells use ~ for "approximate at typical claude-terminal rates" (sub-KB/s steady state, occasional bursts).

| ID  | Fixes | LoC | Files | Deploy risk | Latency cost | Mobile/UX | Ops cost | Rollback | Coupling |
|---|---|---|---|---|---|---|---|---|---|
| C1  | P1, P2, P3, P10 | ~150 | `terminal-manager.js` | Low (server-only; chunk push is shape-compatible with current append) | ~0 ms/byte; ~1 ms/reconnect | None — strictly improves replay correctness | Add per-session memory metric (chunks×size) | High — flag-gated `useChunkedBuffer` per session | Implies C10 in any per-client cursor scenario; needed by C12 |
| C2  | P4, indirectly P3 (per-client throttle) | ~200 | `terminal-manager.js`, `Terminal.tsx`, `EphemeralTerminal.tsx` | Medium (PAUSE/RESUME asymmetry between blue & green during overlap can produce mismatched pause states; node-pty.pause()/resume() is well-tested) | +1 RTT per high-water crossing (tens of ms on mobile) | Mobile is the main beneficiary — slow links no longer OOM the server | Add metric: pauses/min/session, time-paused | Medium — disable by raising high-water to infinity (effectively no-op) | Conflicts with C19 (state model has its own throttling); pairs with C9 if binary opcode pattern adopted |
| C3  | P1, P2, P5 (geometry-correct replay), P10 | ~250 | `terminal-manager.js`, `Terminal.tsx` | Medium (protocol shape change for `output` frames; backwards-incompatible without versioning) | ~0 ms/byte; ~1 ms/reconnect; segment iteration adds <5 ms total at typical replay sizes | Strong fit — geometry-correct replay matters more on small viewports | Add metric: segment count per session | Medium — server can fall back to single-segment if client doesn't advertise capability | Implies C7 (per-segment flush barrier requires write-callback chaining); compatible with C5 |
| C4  | P1, P2, P3, P5 (per-pane structure), P6 (clean reattach), partially P4 (via C18 pause-after) | ~600–1000 | `terminal-manager.js`, new `cm-parser.js`, `Terminal.tsx` for protocol bump, `tmux.conf` | High — largest behavioural change; `send-keys` semantics for input differ from `pty.write`; non-UTF-8 in `%output` requires Buffer-mode node-pty (contradicts current setup); deploy in canary mode mandatory | +1.0–4.0× overhead from octal-escape on bursty ANSI output; <1 ms latency steady state | Acceptable on mobile (latency dominated by network); large pastes via `send-keys -l` need batching | Significant — parser bugs are subtle; `%layout-change` parser is iTerm2-class complexity | Low — entire migration is one large flip; per-session toggle infeasible without parallel `attach-session` path | Excludes raw-attach codepath (mutually exclusive transports); pairs naturally with C18 (pause-after only meaningful in -CC) and C22 (side-band gateway) |
| C5  | P1, P2, P6 (snapshot is tmux-authoritative), partially P10 (snapshot is well-formed) | ~80 | `terminal-manager.js` only | **Lowest** — server-only, behaviour-preserving on the live path; can ship gated behind a flag and roll back instantly | +5–50 ms per reconnect (one `capture-pane` + 2 `display-message` forks) | Strictly improves: smaller viewports get a clean redraw on reconnect | Add metric: capture-pane fork count, p99 ms | High — gate by env var; fallback to current `tmuxCapture(-1)` on error | Pairs with C7+C8+C6 in Bundle "Surgical"; compatible with everything else |
| C6  | P8 (parser state hangover) | 1 | `Terminal.tsx:155` | Trivially low — single-line client change; ship via static file, immediate reload by clients (auto-reconnect handles it) | Zero | Zero | Zero | Trivial — revert one line | Standalone; compatible with everything; complements C7 (reset before replay write barrier) |
| C7  | P7, indirectly P2 (snapshot-to-live boundary) | ~30 | `Terminal.tsx`, `EphemeralTerminal.tsx` | Low — client-only; xterm v6 callback API is stable | Zero on steady state; replay parses in same wall-time but with explicit fence | Strong fit — slow rendering on mobile DOM renderer benefits from explicit drain | Zero | Trivial — feature flag in xterm config | Required by C3 (per-segment barriers); enhances C5 (clear → snapshot → live transition); composes with C21 |
| C8  | P5 | ~40 | `Terminal.tsx`, `EphemeralTerminal.tsx`, `terminal-manager.js` (server coalesce) | Low — client+server tweak; debounce delay tunable via const | -50 ms typical resize cycle (debounce introduces 50–100 ms tail latency for the *last* resize event but eliminates intermediate ones) | **Critical** for mobile (keyboard show/hide spams ResizeObserver) | Zero | Trivial — set debounce to 0 to disable | Standalone; complements C15 (`window-size manual` makes server-side coalesce a no-op) |
| C9  | P10 (no JSON for high-volume), P12 (forces binaryType decision); indirectly P4 by enabling opcode-based PAUSE/RESUME | ~150 | `server.js`, `terminal-manager.js`, `Terminal.tsx`, `EphemeralTerminal.tsx` | Medium — both ends must change in lockstep; mid-deploy clients with old code see binary frames they can't decode (P11 hazard); requires versioned upgrade path | -20–30% bandwidth on output; binary parse is faster than JSON.parse | Strict improvement on mobile (less bytes, less JSON parse) | Update Wireshark dissectors / debug helpers; binary-frame logs less readable | Medium — feature flag at server: emit JSON if client capability missing; client fallback to JSON | Pairs with C2 (binary opcode for PAUSE/RESUME); enables C10 (seq as binary header is cheaper); excludes "JSON only" assumption in P11 fallback path |
| C10 | P1 (deduplication), P2, P3, P6 | ~250 | `terminal-manager.js`, `Terminal.tsx`, `EphemeralTerminal.tsx` (no — out of scope) | Medium — protocol versioning needed; mid-deploy seq epoch handling is subtle | +8 bytes/frame (BigInt seq); zero on reconnect; enables incremental replay (cheap) | Strong fit — dropped frames on mobile recover by lastSeq, no full replay needed | Add metric: seq gap detected, replay-from-offset count | Medium — fall back to "blind reconnect" if client/server seq mismatch | Builds on C1 (chunk list is the natural seq carrier); pairs with C13 for cross-instance continuity; pairs with C12 for per-client offsets |
| C11 | P9 | ~80 | `server.js`, `terminal-manager.js`, `Terminal.tsx` | Low — independent layer | +small constant (one frame per 15–30 s); detection latency 60 s default | Critical for cellular handoff — half-open TCP is the single biggest mobile reliability hole | Add metric: ping RTT, missed-pong count | Trivial — disable by setting interval to ∞ | Standalone; orthogonal to all other candidates |
| C12 | P3, P4 (per-client throttle decisions) | ~200 | `terminal-manager.js` | Medium — fan-out shape change; broadcast loop becomes per-client async iterator; debugging concurrency requires care | Per-client queue overhead ~constant memory; potential micro-latency | Strong fit — fast clients no longer wait on slowest in fan-out | Add per-client queue depth metric | Medium — per-session toggle feasible but adds branching | Requires C1 (per-client cursor needs chunk list); enhances C2/C17 (per-client backpressure decisions); enables C10 fully |
| C13 | P6 | ~300 | `terminal-manager.js`, new `snapshot-store.js`, `deploy.sh`, possibly `ecosystem.config.js`, possibly Redis dep | High — adds external dep (Redis) OR new SQLite schema; persistence write/read on the hot path of shutdown/startup; race with PM2 SIGKILL at 45 s | +1–10 ms per snapshot write (every N seconds); +50–500 ms restore on startup | Indirect — better cross-deploy continuity = fewer reconnect storms = better mobile UX | Significant — Redis monitoring, snapshot size tracking, restore failure alerting | Medium — feature flag at startup; fall back to capture-pane bootstrap | Builds on C1+C10 (without seq, snapshot is just "another capture"); paired with C5 it provides byte-accurate continuity |
| C14 | P2 (client-side immediate paint), P8 (alternative to reset) | ~120 | `Terminal.tsx`, package.json (`@xterm/addon-serialize`) | Low — client-only addon; experimental marking warrants caution | +5–50 ms serialize on disconnect (browser-local); zero on live | Strong fit — instant repaint on reconnect (no server roundtrip wait) | Browser memory grows; serialize cost scales with scrollback | Trivial — disable addon | Standalone; complements but does not replace server-side replay |
| C15 | P5 (window-size manual + aggressive-resize off — biggest single delta) | ~10 | `tmux.conf` | Low — config change; existing sessions need detach+reattach to pick up some options (`focus-events`); blue/green can roll old `tmux.conf` until next reattach | Zero direct latency; eliminates resize-storm bytes | Critical — fixed `default-size 200x50` means mobile xterm.js letterboxes locally instead of triggering tmux redraws | Add metric: window-size change events | Trivial — revert config file | Pairs with C8 (server-side coalesce becomes mostly no-op); orthogonal to transport choice |
| C16 | P4 (smooths bursts), partially P3 (fewer broadcast iterations) | ~50 | `terminal-manager.js` | Low — server-only; concatenation is escape-safe within one batch | +2–5 ms tail latency per chunk (imperceptible) | Strict improvement on mobile (fewer frames = fewer JSON.parse cycles) | Add metric: batch size distribution | Trivial — set throttleBy to 0 | Pairs with C12 (one batch per client per tick); compatible with C9 (binary frames batch the same way) |
| C17 | P4 (hard ceiling against OOM) | ~30 | `terminal-manager.js` | Medium — kicked clients may struggle to reconnect on slow links (loop) | Zero in steady state | Risk: bad-network mobile users get repeatedly kicked unless threshold is generous | Add metric: clients kicked per hour | Trivial — set threshold to ∞ | Standalone; pairs with C2 (PAUSE/RESUME first, evict as last resort) |
| C18 | P4 (via tmux), partially P3 (per-pane pause) | ~50 | `terminal-manager.js`, requires C4 first | Tied to C4 — only meaningful in `-CC`; deploy risk inherited | Zero steady; +1 RTT on `%pause` → `%continue` | Strong fit — tmux holds bytes, no client OOM | Add metric: pauses/pane/min | Medium — set `pause-after=0` to disable | Requires C4; excludes C2 in the -CC path (pause-after replaces app-level PAUSE) |
| C19 | P1, P2, P3, P4, P6 — most thorough fix | ~3000+ | Full server rewrite | **Highest** — full architectural rewrite; new state model, new parser, new diff engine; not feasible in one milestone | Tens of ms per state diff; bandwidth far below raw replay on long disconnects | Best possible mobile experience (bounded bandwidth on flaky links) | Significant new complexity surface | Effectively no rollback short of redeploying the old server | Excludes everything else — alternative architecture |
| C20 | P6 (redundant byte log), partially P1 (raw bytes for reconciliation) | ~80 | `terminal-manager.js`, log rotation script | Medium — pipe-pane is one-consumer per pane; blue/green overlap means one instance loses the tap | Zero on hot path | Indirect | Add log rotation, disk-usage monitoring | Trivial — turn off the pipe | Conflicts with multiple-instance attach during blue/green overlap; complements C5 (raw bytes are the diff source for snapshot reconciliation) |
| C21 | P2 (boundary clarity), P7 (post-replay actions) | ~20 | `terminal-manager.js`, `Terminal.tsx` | Trivially low | Zero | Strong fit — explicit "now you can fit and focus" event | Zero | Trivial — ignore the marker on client | Pairs with C7 (callback-chained snapshot write fires the marker handler); complements C3 (which already has its own marker) |
| C22 | P3 (structured layout/title sync without doubling bytes) | ~100 | `terminal-manager.js` | Tied to C4 — only meaningful in `-CC` | Zero on bytes path | Indirect | Add notification handler | Medium — disable side-band client | Requires C4 |

---

## 4. Per-candidate pros/cons (evidence-backed)

### C1 — Chunk-list replay buffer with per-client cursor
- **Pro.** Eliminates P1 mid-CSI cut by construction: chunks are exactly what `pty.onData` produced (`terminal-manager.js:279-303`), so eviction at chunk granularity never crosses an internal sequence (Node `StringDecoder` already guarantees full UTF-8 codepoints per chunk per `node-pty/lib/unixTerminal.js:95`).
- **Pro.** Eliminates P10 surrogate-pair cut at trim boundary (PTY scan §5.5) — the slice never operates inside a code-point pair, only at chunk seams that node-pty already aligned.
- **Pro.** Foundation for C10 seq numbering (chunks have natural absolute byte offsets) and C12 per-client cursors (sshx 1.4 pattern: `Vec<Bytes>` with `chunk_offset` / `byte_offset`).
- **Pro.** Cap at chunk granularity stays under 2 MiB total, like sshx (`SHELL_STORED_BYTES: u64 = 1 << 21`, 03-streaming 1.4) — coincidentally identical to today's number, but evicted cleanly.
- **Pro.** Idempotent eviction: prune semantics are "drop oldest whole chunk" — easy to reason about for testing, no edge cases inside a single chunk.
- **Con.** Doesn't address P5 (resize storms) or P9 (ping/pong) — orthogonal.
- **Con.** Memory overhead per chunk record (object header in V8 ~24 B + key strings) for very small chunks (single-keystroke echoes); a chatty session may pay ~30 % more memory than today's flat string.
- **Con.** Without C10, late-attaching clients still see the full-tail dump, just via a different mechanism — solves the corruption, not the volume.
- **Con.** The "send `session.buffer` as one frame" replay path (`terminal-manager.js:507`) becomes "send a list of strings as one concatenated frame OR as N frames" — small protocol-shape decision must be made even if seq is not yet adopted.

### C2 — PAUSE/RESUME backpressure
- **Pro.** First real backpressure mechanism in the project. WS scan §3.2 documents the current state: "Backpressure does not exist in this codebase. Producer rate (PTY) is decoupled from consumer rate (slowest WS)."
- **Pro.** ttyd's libwebsockets implementation (03-streaming 1.1) provides production proof at scale, with the same opcode discipline ttyd uses (binary `'2'`/`'3'`).
- **Pro.** Wetty's variant (03-streaming 1.3) uses `term.write(data, callback)` to gate the ack on the parser drain, not just `bufferedAmount` — prevents xterm DOM-renderer queue blowup (client scan §10 #5). Particularly relevant given the project uses the slow DOM renderer (no WebGL/Canvas addon, client scan §1.5).
- **Pro.** node-pty exposes `pause()` / `resume()` natively (03-streaming §6 misc); minimal infra cost to wire up.
- **Pro.** Eliminates the silent "kernel TCP send buffer fills → libuv emits error → ws closes" failure mode (WS scan §3.2): producer is throttled long before that point.
- **Con.** Pausing node-pty pauses the upstream process — tmux holds the bytes, but if the gateway is paused for too long, claude CLI sees a stuck stdout. For interactive prompts this is benign; for non-interactive scripts it could deadlock.
- **Con.** Mid-deploy asymmetry: blue may have paused a session that green has not yet seen — the resume message is never honored across the flip.
- **Con.** Adds protocol surface (PAUSE/RESUME messages) requiring versioning; conflicts with the JSON-only assumption in P11 unless paired with C9.
- **Con.** Watermark tuning (high=2 MiB, low=512 KiB in ttyd) needs validation against typical claude-terminal output rates — too tight = thrashing, too loose = slow recovery.

### C3 — Segmented `(cols, rows, data)[]` replay
- **Pro.** Geometry-correct replay across resize history — the only candidate that does this. VS Code's `terminalRecorder.ts:39-60` (03-streaming 1.6) is the canonical reference.
- **Pro.** Trim never crosses a segment boundary, so a corrupted prefix (if it happens) is contained within one segment; the resize barrier resets parser/grid state for segment N+1 (client scan §5.2).
- **Pro.** Pairs naturally with C7 + C21 — `await writePromise` between segments + explicit `replayComplete` event = no spurious resize redraws during replay (03-streaming P17 + P18).
- **Pro.** VS Code's `MaxRecorderDataSize` cap of 10 MiB is more generous than today's 2 MB, with eviction at substr granularity inside the head segment — gives more replay history without per-frame protocol cost.
- **Con.** Backwards-incompatible without versioning — server must detect old clients and fall back to single-segment.
- **Con.** Bookkeeping in the recorder is non-trivial (handle empty back-to-back segments — `terminalRecorder.ts:43-46` shows the cleanup).
- **Con.** Doesn't fix P3 multi-client divergence (segment list is still one shared object).
- **Con.** Within a single segment, eviction still uses `substr` at character index (`terminalRecorder.ts:51-58`) — same UTF-16 code-unit hazard as today's `slice`, just contained within one segment. Real-world: rarely hit because segments are typically <1 MB each.

### C4 — Switch to tmux `-CC` control mode
- **Pro.** Eliminates P1 at the framing layer: every `%output %p value\n` is a complete line (03-tmux §2.2, §2.3). Mid-escape cut by the gateway becomes structurally impossible.
- **Pro.** Solves P3 cleanly: each browser is one `-CC` client with `refresh-client -C cols×rows`; tmux fans `%output` per pane independently (03-tmux §5.1).
- **Pro.** P6 blue/green: new instance attaches as a fresh `-CC` client and immediately starts receiving structured `%output`; combined with seq numbers (C10) and snapshots (C5) it's clean.
- **Pro.** Enables C18 `pause-after` flow control — tmux holds bytes when a client lags, no `node-pty.pause()` needed.
- **Pro.** iTerm2 has been running on this protocol for 10+ years (03-tmux §8.1); spec is stable.
- **Pro.** Side-band events (`%layout-change`, `%window-add`, `%session-changed`, `%pane-mode-changed`, `%subscription-changed`) become structured first-class signals — no more inferring intent from byte streams.
- **Pro.** `refresh-client -B 'name:type:format'` (format subscriptions, 03-tmux §2.8) gives a push-based way to surface arbitrary tmux state to the UI (current path, alt-screen flag, custom user options).
- **Con.** Largest single change in the project. ~600–1000 LoC (03-tmux 10.2). Per-session toggle is impractical because the *transport* changes.
- **Con.** `send-keys` for input has subtle differences vs `pty.write` — must use `-l` for literal bytes, batch large pastes (iTerm2's pattern), handle bracketed paste explicitly. Latency on typing is fine (10 keys/sec); paste of MB-sized clipboard is slower.
- **Con.** `%output` value MAY be non-UTF-8 (03-tmux §2.5). Currently node-pty is in UTF-8 string mode (`terminal-manager.js:97-103` doesn't override `encoding`). Either switch to Buffer mode for the control PTY (regression risk for the rest of the code that assumes string), or accept loss for non-UTF-8 apps (iTerm2's choice).
- **Con.** Octal escape adds 1.0–4.0× bandwidth overhead on ANSI-heavy bursts (03-tmux §2.12). Negligible at typical CLI rates.
- **Con.** Doesn't fix P5 resize storms — the physics (resize → tmux redraw → byte burst) is the same.
- **Con.** Forces a parser dependency: the `ControlModeParser` sketch (03-tmux §2.11) is ~80 LoC for happy path; edge cases (line-split inside reply blocks, octal escapes near `%end`, line-buffered partial reads) add another ~100 LoC.

### C5 — `tmux capture-pane` snapshot on reconnect (Recipe X)
- **Pro.** Smallest server-only change that fixes P1 in the visible failure mode (garbage at top of replay). `capture-pane -p -e -J` always emits well-formed ANSI per cell (03-tmux §4).
- **Pro.** P6 blue/green: snapshot is from tmux's authoritative pane state, not from per-instance in-memory `session.buffer` — eliminates the in-flight-byte loss class.
- **Pro.** Existing code already uses `tmuxCapture` at three sites (`terminal-manager.js:177, 247, 489`) — change is mostly "make it the only path for new-attach replay and add cursor-position + alt-screen detection".
- **Pro.** Runs only on reconnect, not on every byte — bounded cost (~10–50 ms per reconnect, 03-tmux §4.3).
- **Pro.** Compatible with every other candidate; never excludes a future architectural choice.
- **Pro.** SGR state is line-resetting (03-tmux §4.4) — each line begins with `\x1b[0m...` if attributes are set, no leakage between rows.
- **Con.** Doesn't fix P5 resize storms or P3 multi-client divergence.
- **Con.** Snapshot is screen-state, not byte-stream — can't resume "in the middle of a CSI"; if live data arrives between `capture-pane` and the next live byte, those bytes might be in the snapshot AND in the live stream (the very P2 race we're fixing) — needs C10 seq or C21 marker to fully close.
- **Con.** Two known gotchas: CRLF normalisation (`\n` → `\r\n` since claude-terminal doesn't set `convertEol`, 03-tmux §4.2), and alt-screen detection (`-a` only when `#{alternate_on}` is `1`, 03-tmux §6.3).
- **Con.** Cursor position must be sent separately via `display-message -p '#{cursor_x},#{cursor_y}'` — capture-pane does NOT emit cursor-motion sequences (03-tmux §4.1).
- **Con.** Some screen-mode sequences (cursor visible/invisible, mouse mode, application-keypad mode) are NOT captured (03-tmux §4.4) — for vim/htop, the user may see slight visual artifacts until the app re-emits its UI state. For Claude CLI specifically this is benign because it re-emits its UI state on every prompt.
- **Con.** The 8 MiB `maxBuffer` on `execSync` (`terminal-manager.js:42`) becomes a hard ceiling on snapshot size — at 200 cols × 50000 lines history with ANSI overhead, ~12 MB worst case (03-tmux §4.3); needs raising or accepting truncation.

### C6 — `term.reset()` instead of `term.clear()` on reconnect
- **Pro.** Cheapest possible client-side fix for P8 — one-line change at `Terminal.tsx:155`.
- **Pro.** ttyd's pattern: `terminal.reset()` on `onSocketOpen` (03-streaming 1.1 / `xterm/index.ts:onSocketOpen`).
- **Pro.** Wipes parser state, SGR, alt-screen flag, mode flags — interrupted CSI from previous connection no longer corrupts replay (client scan §10 #3).
- **Pro.** Pairs cleanly with C7 (chained writes) — `term.reset()` then `term.write(snapshot, () => liveStart())` gives the cleanest possible reconnect baseline.
- **Pro.** Standalone change with zero protocol impact — can ship today.
- **Con.** Loses local scrollback for the user during replay (often desired anyway since replay rewrites the screen).
- **Con.** Conflicts mildly with C14 (Serializer): if the addon is meant to preserve user state, `term.reset()` discards it — order matters (serialize → store → reset → restore).
- **Con.** Standalone, doesn't fix anything else — but it's so cheap that "doesn't fix more" isn't a real con.

### C7 — Chain `term.write` calls via callback
- **Pro.** Gates downstream operations (`fit()`, geometry override, focus, scroll-to-bottom, `replayComplete` handling) on actual parser drain, not on the synchronous return of `term.write` (client scan §2.3 / §10 #2).
- **Pro.** Required by C3 segmented replay (per-segment `await writePromise`) and enhances C5 + C21 (snapshot → live transition is a real boundary).
- **Pro.** xterm.js v6 callback API is stable and well-documented; the second-arg callback signature has been in the public API since pre-6.0.
- **Pro.** Critical on slow renderers — DOM renderer (the project's default since no WebGL/Canvas addon is loaded, client scan §1.5) drops frames under high write throughput; explicit drain prevents the WriteBuffer from growing unbounded.
- **Con.** All 8 call sites (client scan §2.3) need updating; risk of accidentally serializing fast paths that don't need a barrier.
- **Con.** Slightly slower replay for very long buffers (each segment waits for parse completion — but at typical sizes <50 ms total).
- **Con.** The fallback path (Sites E and H, `Terminal.tsx:193` and `EphemeralTerminal.tsx:57`) for non-JSON frames also needs updating — easy to forget and leaves a residual ordering hazard.

### C8 — Debounce client FitAddon + server-side resize coalesce
- **Pro.** Direct fix for P5. `Terminal.tsx:362-380` `ResizeObserver` is the documented storm source (client scan §4.1, PTY scan §6.3). One client-side wrap + one server-side equality check.
- **Pro.** Critical for the imminent mobile workstream — soft keyboard show/hide spams `ResizeObserver` independently of layout-viewport (client scan §4.3 notes `visualViewport` is not subscribed; debounce captures both).
- **Pro.** Server-side coalesce defends against any *client* misbehaving (a bug in Terminal.tsx, a malicious client, an experimental dev mode); belt-and-braces.
- **Pro.** Drop-in: rAF or 50 ms `setTimeout` debounce wraps the existing `handleResize` function — no shape change.
- **Con.** Adds 50–100 ms tail latency to the *last* resize event of a sequence — imperceptible.
- **Con.** Standalone, doesn't fix the resize-burst-after-resize physics — pairs best with C15 (`window-size manual` removes tmux's repaint contribution).
- **Con.** Server-side coalesce becomes effectively a no-op once C15 is adopted (server doesn't honor browser-side resize anyway), so the server-side half is "future-proofing" or "defense-in-depth" rather than a load-bearing fix.

### C9 — Switch WS `binaryType` to arraybuffer + send Buffer
- **Pro.** Eliminates JSON envelope overhead (~30% bandwidth savings at high throughput) and JSON.stringify/JSON.parse CPU cost (WS scan §4.4).
- **Pro.** xterm.js v6 accepts `Uint8Array` directly via `term.write(uint8)` (`addon-attach` 03-streaming 1.8 explicitly enforces `binaryType='arraybuffer'`).
- **Pro.** Closes the latent P11 / P12 hazard — once binary is the canonical path, the JSON-fallback at `Terminal.tsx:193` and `EphemeralTerminal.tsx:57` becomes dead defensive code rather than a live trap.
- **Pro.** Enables single-byte opcode protocols (ttyd 03-streaming 1.1) for future protocol additions (PAUSE/RESUME, seq+ack).
- **Pro.** No `perMessageDeflate` is configured today (WS scan §4.4); switching to binary recovers some of what compression would have given without paying CPU cost.
- **Pro.** ttyd, sshx, and `addon-attach` all use `binaryType='arraybuffer'` (03-streaming §6 misc). The Blob default is broken for terminal data and not used by any surveyed project.
- **Con.** Both ends must change in lockstep. Mid-deploy old clients will see binary frames they decode as `[object Blob]` (P11). Versioning needed: server emits JSON when the client doesn't advertise `binary` capability.
- **Con.** Wireshark / debugging frame contents becomes harder.
- **Con.** Slightly less convenient for `JSON.stringify({type, data})` envelope on control frames — most projects keep JSON for control + binary for data (sshx uses CBOR for everything; ttyd uses opcode + binary).
- **Con.** Hybrid approach (binary for `output`, JSON for control) adds protocol complexity (two parsers on the client), but is safer migration path than all-binary.

### C10 — Seq+ack protocol (Recipe Z)
- **Pro.** The only candidate that gives true exactly-once delivery on reconnect within the rolling-buffer window (sshx 1.4).
- **Pro.** Trivial deduplication on reconnect: client tells server `lastSeq`, server replays only `seq > lastSeq`. Eliminates P2 race entirely.
- **Pro.** Per-client cursor (C12) becomes natural — each client tracks its own lastSeq.
- **Pro.** Combined with C13 (Redis snapshot), enables clean cross-instance continuity for P6.
- **Pro.** sshx's `WsServer::Chunks(sid, seqnum, Vec<Bytes>)` (03-streaming 1.4 protocol section) ships a *batch* with the seqnum of the first chunk — client sanity-checks; we can reuse the pattern verbatim.
- **Pro.** Idempotent retransmits become safe: re-applying the same seq is a no-op.
- **Con.** Requires C1 chunk list as foundation (where else would seq numbers attach?).
- **Con.** Cross-blue/green seq epoch handling is subtle — the new instance must either persist seqs (C13) or assign a new epoch and ship a fresh capture (C5) so the client knows to reset its `lastSeq` baseline.
- **Con.** Adds 8 bytes (BigInt as string) per output frame — negligible.
- **Con.** Mosh's full SSP (C19) is the Platonic ideal of this; we're picking up only a subset.
- **Con.** "What if client is behind by more than buffer?" requires a degraded-mode fallback (snapshot+resume from new epoch) — adds branching to the reconnect handler.

### C11 — Ping/pong + idle-disconnect
- **Pro.** Detects half-open TCP within ~60 s regardless of nginx's 24 h `proxy_read_timeout` (WS scan §1.7). The single highest-value fix for cellular handoff and NAT timeout.
- **Pro.** Multiple production references: ttyd `--ping-interval=5`, sshx `WsClient::Ping(u64)` → `WsServer::Pong(u64)`, gotty Ping/Pong opcodes (03-streaming 1.1, 1.4, 1.2). Standard `ws@8` pattern documented in their docs (referenced in WS scan §11 notes).
- **Pro.** Independent of every other candidate — orthogonal layer.
- **Pro.** Two viable mechanisms (app-level JSON `{type:"ping"}` or protocol-level `ws.ping()`); protocol-level is cleaner because browsers handle pong frames transparently and cost is just `ws.on('pong')` server-side.
- **Pro.** Doubles as latency telemetry (timestamp echo gives RTT) — useful for the connection-status indicator UI.
- **Con.** Adds a small constant traffic overhead (~50 bytes/min at 30 s interval per session).
- **Con.** Fires false positives on very slow links (>60 s for a round-trip) — tune the threshold.
- **Con.** A short threshold (15–30 s) plus an aggressive deploy-overlap can multiply reconnects: client decides server is dead during graceful shutdown, reconnects to new instance, old graceful shutdown finishes 5 s later — net result one extra reconnect cycle per deploy per client.

### C12 — Per-client broadcast cursor
- **Pro.** Solves P3 root cause: today's `for (client of session.connectedClients) client.send(...)` (`terminal-manager.js:298-302`) is one shared loop with no per-client decisions; sshx's per-`Subscribe` `tokio::spawn` (03-streaming 1.4) is the canonical replacement.
- **Pro.** Per-client backpressure decisions (C2 / C17) become natural — each subscription queue can be paused / drained / dropped independently.
- **Pro.** Eliminates the §5.4.2 "slow client cascade" risk (WS scan).
- **Pro.** Late-joiners no longer impact existing clients — sshx's design lets a new `Subscribe(sid, 0)` walk the whole rolling buffer at the new client's pace while live broadcast continues for everyone else.
- **Con.** Requires C1 (per-client offset needs a chunked log).
- **Con.** More moving parts in the reactor — per-client async iterator or queue, with explicit cleanup on close.
- **Con.** Memory grows with per-client queue depth — needs eviction policy (C17).
- **Con.** Per-client iteration changes the synchronous `for ... client.send` (`terminal-manager.js:298-302`) into an async-iteration model; subtle ordering bugs possible around close-during-iteration. sshx uses a Tokio broadcast channel with `Lagged` error to handle this — Node-side equivalent is a `tokio-style` queue with overflow handling.

### C13 — Persist replay across blue/green
- **Pro.** Only candidate that gives byte-accurate continuity across deploy. Without it, P6 best-case is "tmux scrollback gives correct screen state" (which C5 already ensures); seq continuity requires this.
- **Pro.** sshx-style zstd+protobuf to Redis is a mature pattern (03-streaming 1.4, 03-tmux §8.4); SQLite (already a dep — see WS scan §11 deploy refs) could host it without new infrastructure.
- **Pro.** sshx caps snapshot at 32 KiB (`SHELL_SNAPSHOT_BYTES: u64 = 1 << 15`, 03-streaming 1.4) — enough to "draw the screen the user just saw" plus a small history; cheap to write/restore.
- **Pro.** Provides a graceful path for future horizontal scaling (multi-host) even if not used today.
- **Con.** Highest deploy risk — adds a hot-path persistence step on shutdown; race with PM2 SIGKILL at 45 s (`ecosystem.config.js:19,39`); restore path on startup adds latency before WS upgrades are accepted.
- **Con.** Effectively no rollback short of redeploying the old server (state is persisted).
- **Con.** On a single-VPS self-hosted deployment, the operational case for cross-instance state persistence is weak — blue/green is on the same host, tmux already survives, the marginal gain is 5–10 seconds of byte-accurate continuity per deploy.
- **Con.** sshx's secondary persistence layer assumes a stateless server tier in front of the snapshot store; claude-terminal's PM2 blue/green doesn't have that separation, so the architectural fit is awkward.

### C14 — `SerializeAddon` round-trip
- **Pro.** Pure client-side immediate visual on reconnect — no server roundtrip wait. Even if the server is mid-`capture-pane`, the user sees their last screen instantly.
- **Pro.** No protocol changes; addon is ~30 KB; opt-in per session via `localStorage`.
- **Pro.** Complements (does NOT replace) server-side replay — useful as the "snapshot for the same browser tab reconnect" cache (03-tmux §8.8).
- **Pro.** Best-of-both-worlds when paired with C5 (server snapshot for fresh tabs, client snapshot for same-tab reconnects) — eliminates the perceived latency of reconnect.
- **Pro.** xterm.js maintainers explicitly designed it for snapshotting (03-streaming 1.8) — tab restoration, debugging, HTML export — so the API matches the use case.
- **Con.** Marked experimental in xterm.js master (03-tmux §8.8). May not handle every SGR / combining-mark / CJK case.
- **Con.** Browser memory grows with serialized scrollback.
- **Con.** Useless for fresh browser tabs / cross-device handoff — those still need an authoritative server snapshot.
- **Con.** Cursor position is NOT preserved automatically — must extract `term.buffer.active.cursorX/Y` and append a manual cursor-position sequence (03-tmux §8.8 limitations).

### C15 — Tighten `tmux.conf` knobs
- **Pro.** `window-size manual` + `default-size 200x50` + `aggressive-resize off` is the single biggest lever against P5 — eliminates the "tmux resizes pane and emits redraw burst" cascade entirely (03-tmux §6.2, §11.3). With this, server-side `pty.resize` becomes effectively a no-op (xterm.js letterboxes locally).
- **Pro.** `terminal-features ":sync"` lets apps emit DEC sync sequences for atomic redraws (03-tmux §7).
- **Pro.** `focus-events on` enables editor blur/focus correctness.
- **Pro.** Config-only — instant rollback by reverting one file.
- **Pro.** `set-clipboard off` is a small but real security hardening — blocks accidental OSC 52 leaks from app to client (03-tmux §7).
- **Pro.** `automatic-rename off` + `monitor-bell off` reduce spurious `%window-renamed` and bell-driven notifications, useful especially if C4 is later adopted.
- **Con.** `default-size 200x50` (or any fixed size) means clients with very small viewports (mobile portrait) see horizontal scrolling on long lines instead of word-wrap. Trade-off vs. the resize-storm cost.
- **Con.** Some options (`focus-events`, terminal-features) require detach + re-attach to take effect — first deploy is half-effective.
- **Con.** Doesn't address any non-resize problem.
- **Con.** Choosing the right `default-size` is a UX decision (mobile vs desktop) that may need per-client overrides — could become complex if the project grows multi-tenant.

### C16 — Server-side throttled batcher
- **Pro.** Wetty `tinybuffer(socket, 2, 524288)` (03-streaming 1.3) and VS Code `TerminalDataBufferer(throttleBy=5)` (03-streaming 1.6) are both production-proven; reduces frame count by 1–2 orders of magnitude during bursty output.
- **Pro.** Concatenation within one batch is escape-safe (adjacent chunks join, completing partial CSIs).
- **Pro.** Reduces backpressure pressure (fewer frames = fewer socket writes = less queue buildup) — complements but does not replace C2.
- **Pro.** Cheap to implement: ~50 LoC for a per-session/per-client setTimeout-based batcher.
- **Pro.** Survives the bursty resize-driven repaint storms produced by P5 — even if C8 + C15 don't fully eliminate them, batching means each storm is one frame instead of many.
- **Con.** Adds 2–5 ms tail latency per chunk (imperceptible for output, irrelevant for input which isn't on this path).
- **Con.** A single PTY chunk > batch threshold still flushes at an arbitrary boundary (wetty's 512 KiB threshold makes this rare).
- **Con.** Doesn't fix P1 (the trim hazard is independent of frame count).
- **Con.** Per-client batcher (paired with C12) means N timers running per session — minor scheduler overhead at high client counts.

### C17 — Drop slow clients
- **Pro.** Hard ceiling against OOM from a single bad-network client; no producer-side throttling needed (sshx 1.4 `client fell behind on broadcast stream`).
- **Pro.** Trivial implementation (`client.bufferedAmount > 8 MiB → client.close(4503)`); brutal but correct.
- **Pro.** Pairs well with C2: PAUSE/RESUME first as graceful throttling, eviction as ultimate ceiling for clients that are truly hopelessly behind.
- **Pro.** Pairs well with C10 (seq+ack): kicked client reconnects, sends `lastSeq`, gets resumed cleanly from where it was — minimal user-visible disruption.
- **Con.** Bad-network mobile users get repeatedly kicked unless threshold is generous.
- **Con.** Doesn't address P1/P2/P3 — only the OOM symptom.
- **Con.** Without C2 first, the client will just reconnect and immediately hit the same wall.
- **Con.** Without C10 (seq+ack) the kick-then-reconnect cycle reissues a full snapshot, doubling the byte traffic the slow client can't keep up with — making the eviction self-defeating.

### C18 — `pause-after` flow control
- **Pro.** tmux holds bytes for paused panes; gateway acks via `refresh-client -A '%p:continue'`. No app-level PAUSE/RESUME needed (03-tmux §2.7).
- **Pro.** Replaces `%output` with `%extended-output %p age ... : value` while paused — gives telemetry on buffer age (`age-ms` field).
- **Pro.** Per-pane granularity: paused pane stays paused independently of others on the same tmux session (03-tmux §2.7).
- **Pro.** Configured by single command `refresh-client -f pause-after=N` — no protocol changes required at the WS layer.
- **Pro.** `refresh-client -A '%p:off'` lets a backgrounded pane stop producing output entirely (e.g. for a hidden tab); when all clients say off, tmux stops reading the pane (03-tmux §2.7).
- **Con.** Only meaningful on `-CC` (C4); requires whole-protocol migration first.
- **Con.** Pausing a pane means the application sees stuck stdout — same caveat as C2 for non-interactive scripts.
- **Con.** Telemetry through `%extended-output` is not enabled by default — needs explicit `pause-after=N` set on the client to switch from `%output` to `%extended-output`.

### C19 — Snapshot+delta with full screen state model (mosh SSP)
- **Pro.** The only architecturally complete answer to long disconnects with bounded bandwidth (mosh 1.7).
- **Pro.** Idempotent state numbers eliminate dedup logic — re-applying the same instruction is a no-op.
- **Pro.** Predictive echo (mosh's UI feature, 03-tmux §8.4) is a separate but related feature that gives buttery-smooth typing on high-latency links — a real mobile-UX win if implemented.
- **Pro.** Cuts in the byte stream are absorbed by the server-side parser; the framebuffer state is always self-consistent (03-streaming 1.7) — P1 closed by construction.
- **Con.** Requires running a full ANSI parser + framebuffer server-side. Complete server rewrite. ~3000+ LoC. Effectively a new product.
- **Con.** UDP transport and per-packet auth are mosh's wins over TCP/WS; we'd inherit only a subset of benefits over WSS.
- **Con.** Conflicts with every other candidate — alternative architecture, not an addition.
- **Con.** The state-diff model assumes you can render diffs of the *visible screen*; tmux's role as the source of truth for scrollback complicates this — you'd need to merge two state models (mosh's framebuffer + tmux's scrollback grid) or abandon scrollback entirely (mosh does the latter).
- **Con.** GPL v3 license on mosh source means no direct code reuse; pattern only.

### C20 — `pipe-pane` redundant byte tap
- **Pro.** Raw application bytes, byte-for-byte, in order, with no tmux re-encoding (03-tmux §3.2). Useful as backup or for cross-instance reconciliation.
- **Pro.** Cheap on the host (just a pipe + cat).
- **Pro.** Useful for log retention / audit (every byte the app produced, regardless of UI subsequent state).
- **Pro.** Could backfill C13 persistence cheaply: instead of serialising state, just rotate the pipe-pane log; on restart, re-parse from cursor position.
- **Con.** Loses tmux's redraws, status repaints, resize-driven rendering (03-tmux §3.3) — not a replacement for any other mechanism, only a complement.
- **Con.** One pipe per pane — blue/green overlap means one instance silently loses the tap.
- **Con.** Doesn't pair with anything else cleanly without a separate reconciliation engine; effectively only useful for offline log analysis.
- **Con.** Disk usage grows linearly; needs rotation/retention policy.

### C21 — `replay_complete` end marker
- **Pro.** Trivially cheap (one extra frame after snapshot); removes ambiguity about "did I get all the replay yet" (03-streaming P18 / VS Code OnProcessReplayComplete).
- **Pro.** Lets client perform one-shot post-replay actions at the right moment: `fitAddon.fit()`, focus, scroll-to-bottom, hide reconnecting banner.
- **Pro.** Backwards compatible because the existing client switch (`Terminal.tsx:171-194`) has no default case — unknown types are silently dropped.
- **Pro.** Works with or without seq+ack — the marker provides the boundary even when bytes aren't individually addressable.
- **Con.** Requires versioning if combined with new client behaviour gated on the marker.
- **Con.** Doesn't fix anything alone — just enables other candidates to do their job correctly.

### C22 — Side-band `-CC no-output` gateway client
- **Pro.** Structured layout/title/session events without doubling byte traffic (03-tmux §5.3).
- **Pro.** Useful for surfacing tmux state changes (window add/close, layout-change) to a separate UI channel.
- **Pro.** With `refresh-client -B 'name:type:format'` (03-tmux §2.8) any tmux format value can be subscribed to (rate-limited to 1/sec) — push-based UI updates for `#{pane_current_path}`, `#{client_session}`, custom `@my-state` user options.
- **Pro.** Risk-free first-contact path for adopting `-CC` — this client only receives notifications, never `%output`, so parser bugs cannot corrupt user data. Safe sandbox for parser development.
- **Con.** Requires C4; only meaningful in the `-CC` world.
- **Con.** No current consumer in claude-terminal — "for free if we go to `-CC`" not "valuable on its own".
- **Con.** Adds one extra tmux client per session; minor resource cost.

---

## 5. Hard conflicts

These are pairwise (or higher) conflicts where the choice of one candidate excludes or strictly requires another. Read this carefully before composing bundles.

### 5.1 Hard "excludes" relationships

- **C19 (mosh SSP) excludes C1, C3, C4, C5, C9, C10, C12, C13, C14, C16, C18, C22.** Full state-model rewrite is its own architecture; bolting any of the other patterns on top is incoherent. Mosh ships diffs of a parsed framebuffer, not bytes — there is no rolling buffer (so C1 is moot), no replay event (so C3 is moot), no tmux integration (so C4/C5/C18/C22 are moot), no seq numbers in the byte sense (so C10 doesn't apply), no broadcast model (so C12/C16 don't apply), no separate snapshot store (the state object IS the snapshot, so C13 is moot). Only C2/C8/C11/C15 survive as orthogonal layers (you still want resize debounce, ping/pong, tmux config tightening; C2 is replaced by mosh's own adaptive throttling but the principle survives).
- **C4 (-CC migration) excludes raw-attach codepath.** The `pty.spawn` invocation at `terminal-manager.js:93-103` switches transports; you can't run both paths for the same session. Per-session toggle is infeasible without parallel attach machinery (one socket per mode). The bundle "Future-proof" plans an explicit migration window where both modes run side-by-side at the *fleet* level (different sessions on different modes), but never for the same session.
- **C18 (`pause-after`) effectively excludes C2 in the same path.** Both are flow control. `pause-after` is the tmux-layer equivalent of app-level PAUSE/RESUME. Running both means double-pausing; the second pause has no effect. Pick one based on transport choice.
- **C20 (pipe-pane) conflicts with multi-instance attach during blue/green overlap.** tmux refuses a second `pipe-pane` per pane — one instance wins and the other silently loses its tap. Either gate pipe-pane to a designated active instance (e.g. via a heartbeat file), or drop C20 from the candidate set if you keep blue/green overlap as today's deploy script does.
- **C5 (capture-pane snapshot) conflicts subtly with C19 (mosh SSP).** mosh has its own snapshot mechanism (full framebuffer state); using `capture-pane` as a secondary source would reintroduce double-state and require reconciliation.

### 5.2 Hard "requires" relationships

- **C18 (`pause-after`) requires C4.** `refresh-client -f pause-after=N` is a tmux command — only available when the gateway is a tmux client (i.e., `-CC`). On raw attach the gateway doesn't speak commands.
- **C22 (side-band `-CC` client) requires C4.** Same reason — `-CC` infrastructure must exist for the side-band client to attach.
- **C10 (seq+ack) requires C1 (chunk list).** Where else would seq numbers attach? You can't address a position inside a `String += chunk` accumulator after a `slice(-2_000_000)`. Each chunk in C1 has a natural absolute byte offset; that's what becomes the seq.
- **C12 (per-client cursor) requires C1.** Same reason — per-client offsets need a chunked log to address.
- **C3 (segmented replay) requires C7 (write-callback chaining).** The per-segment `OverrideDimensions(cols, rows)` MUST happen AFTER the previous segment finishes parsing, otherwise xterm applies geometry to bytes from the old segment. C7 is the per-segment fence; without it, C3 is structurally incoherent.
- **C13 (cross-instance persist) implicitly requires C10.** Without seq, persistence is "just another snapshot" — doesn't add anything over capture-pane. With seq, persistence is what makes seq epochs survive a deploy.

### 5.3 Soft "tightens" / "completes" relationships

- **C9 (binary frames) tightens P11 closure.** Once binary is the canonical path, P11's "JSON.parse fallback writes raw" becomes a documented capability ("we accept binary"); without C9, P11 stays as a latent footgun. Not a hard requirement but P11 cannot be fully closed without C9.
- **C15 `window-size manual` interacts with C8 server-side resize coalesce.** If the server is configured to ignore size differences from `default-size`, the server-side coalesce in C8 becomes a no-op (it always drops). Not a conflict, but C8 server-side becomes dead code if C15 is fully adopted; C8 client-side debounce is still useful as defence against client-side resize storms hitting server CPU.
- **C6 (`term.reset()`) and C14 (Serializer round-trip) lightly conflict.** `term.reset()` discards the buffer that `serializeAddon.serialize()` would have produced. If both are adopted, the order matters: serialize → ship/store → reset → restore (replay). Coherent but adds a pre-reset step in the disconnect handler.
- **C2 (PAUSE/RESUME) + C16 (batcher) are complementary.** C16 reduces the rate at which C2's high-water threshold is crossed; C2 handles the case where C16 cannot keep up. Neither replaces the other.
- **C17 (slow-client eviction) + C2 are complementary.** C2 is graceful throttling; C17 is the hard ceiling for clients that are truly hopelessly behind.
- **C5 (capture-pane snapshot) + C10 (seq+ack) are complementary.** C5 is the snapshot for clients behind the rolling-buffer window; C10 is the resume-from-offset for clients within the window. They are the two halves of a complete reconnect story.

### 5.4 Compatibility nucleus

C5, C6, C7, C8, C11, C15, C16, C21 form a "compatibility nucleus" — all eight can co-exist with any larger architecture choice (raw-attach, `-CC`, mosh) without changes. They are pure improvements with no transport assumption baked in. The Surgical bundle is essentially this nucleus plus the alt-screen detection that C5 needs.

### 5.5 Mutually-exclusive choice points

When composing a bundle, the arbiter must pick one option from each of the following:
- **Transport for `output`:** JSON-text (status quo) | JSON-text + binary opcode hybrid | pure binary frames (C9).
- **Snapshot source on reconnect:** in-memory `session.buffer` (status quo) | `capture-pane` (C5) | mosh framebuffer (C19) | client-side Serializer (C14, supplemental only).
- **Backpressure mechanism:** none (status quo) | PAUSE/RESUME at app layer (C2) | `pause-after` at tmux layer (C18) | drop slow clients (C17) | combination of the above.
- **Per-client multiplex:** shared `session.buffer` broadcast (status quo) | per-client cursor with chunked log (C1+C12).
- **Cross-instance state:** in-memory only (status quo) | snapshot store (C13) | rely entirely on tmux (C5 + tmux scrollback).
- **tmux attach mode:** raw `attach-session` (status quo) | `-CC` control mode (C4) | hybrid (C5 snapshot + raw stream).

---

## 6. Recommended bundles

Three coherent bundles for the arbiter. None is endorsed; each is a self-consistent point in the design space.

### Bundle "Surgical" — smallest fix that addresses confirmed pain
**Members:** C5 (capture-pane snapshot) + C6 (`term.reset`) + C7 (write-callback chaining) + C8 (resize debounce + server coalesce) + C11 (ping/pong) + C15 (`tmux.conf` `window-size manual` + `aggressive-resize off`) + C21 (`replay_complete` marker).

**Total LoC estimate:** ~250 (server: ~80 for capture-pane + cursor + alt-screen detection + replay_complete; client: ~30 for reset + write-callback + replay_complete handler; both: ~40 for resize debounce; ops: ~80 for ping/pong; config: ~10 for tmux.conf).

**Problems addressed:**
- P1 (mid-CSI cut) — closed by C5 (capture-pane is well-formed).
- P2 (snapshot vs live race) — partially closed by C7 + C21 (snapshot fence) + C5 (well-formed snapshot).
- P5 (resize storms) — closed by C8 + C15.
- P6 (blue/green drift) — closed by C5 (snapshot is tmux-authoritative).
- P7 (write fire-and-forget) — closed by C7.
- P8 (`clear` not `reset`) — closed by C6.
- P9 (no ping/pong) — closed by C11.

**Problems NOT addressed:**
- P3 (per-client divergence) — late joiners still get the same shared snapshot.
- P4 (no backpressure) — slow clients still hammer the producer.
- P10 (UTF-16 surrogate hazard) — partially mitigated by capture-pane (snapshot path) but live `+=` accumulator still slices.
- P11 (JSON-parse fallback) — dormant.
- P12 (default `binaryType=blob`) — dormant.

**Deploy plan (in order):**
1. **Phase 4a: Config-only (C15).** Apply the `tmux.conf` knobs in a single config change: `window-size manual`, `default-size 200x50`, `aggressive-resize off`, plus the supporting `terminal-features :sync`, `focus-events on`, `automatic-rename off`, `monitor-bell off`, `set-clipboard off`. Deploy via standard `bash ~/projects/claude-terminal/deploy.sh`. Observe the existing metrics for tmux-byte-burst frequency over a 24 h baseline. Trivial rollback: `git revert tmux.conf`.
2. **Phase 4b: Server snapshot (C5 + C21).** Wrap the existing `tmuxCapture(sessionId, -1)` call (currently used at `terminal-manager.js:177, 247, 489`) in a new `tmuxSnapshot()` function that adds: alt-screen detection (`display-message -p '#{alternate_on}'`), cursor position read (`display-message -p '#{cursor_x},#{cursor_y}'`), CRLF normalisation (`\n` → `\r\n`), explicit `\x1b[2J\x1b[H` clear-prefix and `\x1b[Y;XH` cursor-position-suffix. Add a new `{type:"snapshot", data, replayComplete:true}` frame on the wire (or follow `output` with an empty `{type:"replay_complete"}`). Gate behind env var `USE_CAPTURE_SNAPSHOT=1`. Deploy to one PM2 color first, observe replay correctness on `tail -f` and `htop` reproductions. Rollback: flip env var.
3. **Phase 4c: Client write-callback chaining (C6 + C7).** Update `Terminal.tsx:155` from `term.clear()` to `term.reset()`. Update `Terminal.tsx:174` (and ephemeral counterpart `EphemeralTerminal.tsx:52`) to chain via callback when in replay mode. Add the `replay_complete` handler that triggers `fitAddon.fit()` + `term.scrollToBottom()`. Deploy as static-file change; clients pick up on next reload. Auto-reconnect handles the transition (per project conventions, no need to suggest page refresh). Rollback: `git revert` client commits.
4. **Phase 4d: Resize debounce (C8).** Wrap `Terminal.tsx:362-380` `handleResize` in 50 ms `setTimeout` debounce (or rAF coalesce); add server-side equality check `if (cols === session.cols && rows === session.rows) return;` before `pty.resize` at `terminal-manager.js:528`. Deploy as one PR. Rollback: revert.
5. **Phase 4e: Ping/pong (C11).** Add server-side `setInterval(30000, () => clients.forEach(ws => ws.ping()))` plus `ws.on('pong', () => isAlive=true)` watchdog. Add client-side `ws.onclose` reconnect path is already there; just ensure ping detection triggers it. Rollback: set interval to 0.

**Risk profile:** Lowest in the set. Every change is server-only or client-only with established patterns. No protocol shape change beyond the additive `replay_complete` marker (which old clients ignore). No external dependencies. Each phase is independently revertable. Recommended baseline for any subsequent work.

---

### Bundle "Robust" — Surgical plus per-client correctness and backpressure
**Members:** Surgical bundle + C1 (chunk-list buffer) + C2 (PAUSE/RESUME) + C9 (binary frames + arraybuffer) + C10 (seq+ack) + C12 (per-client cursor) + C16 (throttled batcher) + C17 (slow-client eviction).

**Total LoC estimate:** ~1100 (Surgical's 250 + chunk list ~150 + PAUSE/RESUME ~200 + binary frames ~150 + seq+ack ~250 + per-client cursor ~200 + batcher ~50 + eviction ~30, with some overlap).

**Problems addressed:** All twelve. Specifically:
- P1, P2, P10 closed by C1 + C10.
- P3 closed by C12.
- P4 closed by C2 + C17 (with C16 reducing pressure).
- P5 closed (Surgical inheritance).
- P6 closed at the byte level by C10 within rolling-buffer window; falls back to C5 for older clients.
- P7, P8 closed (Surgical inheritance).
- P9 closed (Surgical inheritance).
- P11, P12 closed by C9 (binary is the canonical path; JSON fallback becomes dead defensive code rather than a live trap).

**Deploy plan (in order):**
1. **Bake Surgical bundle for at least 1 week.** All five Surgical phases must be in production with no regressions before starting Robust deltas. The Surgical bundle's metrics give the baseline against which Robust changes are evaluated.
2. **Phase 5a: Chunk-list buffer (C1).** Replace `session.buffer = ""` initialisation (`terminal-manager.js:151, 371`) with `session.chunks = []`, replace `session.buffer += data` (`terminal-manager.js:294`) with `session.chunks.push({ seq: session.totalSeq, data }); session.totalSeq += data.length`, replace `slice(-2_000_000)` with chunk-granularity prune. Update the new-attach replay path at `:506-508` to concatenate chunks before send (preserves wire compatibility). Gate behind `USE_CHUNK_BUFFER=1`. Verify memory metrics over 24 h baseline (chunks × avg size vs flat-string equivalent).
3. **Phase 5b: Seq+ack on top of C1 (C10).** Add `seq: <bigint-as-string>` field to every server→client `output` and `snapshot` frame. Client persists `lastSeq` per session in `sessionStorage`. On `ws.onopen`, send `{type:"hello", lastSeq}`. Server: if `lastSeq >= session.prunedSeq`, replay only chunks where `seq > lastSeq`; else fall back to full snapshot via C5 with new seq epoch. Backwards compat: server skips seq emission for clients that don't include `protocol_version: 2` in their initial `hello`. Deploy server-first, client-second to ensure compat.
4. **Phase 5c: Per-client cursor (C12).** Replace the broadcast loop at `terminal-manager.js:298-302` with a per-client async iterator. Each `connectedClients` entry becomes `{ ws, lastSeq, queue }`; new chunks push to all queues; per-client send loop drains its own queue. Handle close-during-iteration cleanly. Test extensively with multi-tab on the same session. Rollback: feature flag for the per-client model.
5. **Phase 5d: Binary frames (C9).** Server: emit `output` and `snapshot` as binary frames (`ws.send(Buffer.from(frame))`) when client advertises `binary_capable: true` in `hello`; otherwise keep JSON. Client: set `ws.binaryType = "arraybuffer"`, dispatch by examining first byte of `event.data`. Use 1-byte opcode prefix for binary frames (similar to ttyd: `0x30`=output, `0x31`=control-json, `0x32`=pause, `0x33`=resume). Old clients (no capability advertisement) keep getting JSON.
6. **Phase 5e: PAUSE/RESUME (C2).** Client tracks `bytesSinceAck` in xterm `term.write(data, callback)` continuation; emits PAUSE opcode at high-water (e.g. 2 MiB), RESUME at low-water (e.g. 512 KiB). Server calls `node-pty.pause()` / `.resume()` on receipt. Tune watermarks based on observed claude-terminal output rates from Surgical baseline.
7. **Phase 5f: Tuning (C16 + C17).** Add server-side throttled batcher (`tinybuffer(client, 5, 524288)` per-client). Add slow-client eviction at `client.bufferedAmount > 8 MiB → client.close(4503)`.

**Risk profile:** Medium. Five protocol changes (C9, C10, C2 control opcodes, C12 subscription model, C21 marker) — needs disciplined version negotiation. Per-client async fan-out adds concurrency surface that requires careful error handling. The binary-frame migration (C9) is the trickiest because both ends must change in lockstep — version negotiation via `hello` frame is the standard mitigation. Each phase is independently flag-gated and revertable.

---

### Bundle "Future-proof" — Robust plus tmux-native architecture
**Members:** Robust bundle + C4 (`-CC` migration) + C13 (cross-instance persistence) + C14 (Serializer client-side cache) + C18 (`pause-after` flow control replacing C2) + C22 (side-band gateway).

Note: in this bundle, C18 replaces C2 (the conflict in §5); C4 displaces the raw-attach codepath. C9 (binary frames) is still used between server and browser; C4 changes the server↔tmux side.

**Total LoC estimate:** ~2000 (Robust's 1100 + `-CC` migration parser + send-keys + layout sync ~700 + persistence ~300 + Serializer ~120, minus C2 ~200 since replaced by C18 ~50).

**Problems addressed:** All twelve, with stronger guarantees on P3 (per-pane structure native to `-CC`), P6 (cross-instance state survives via C13), P2 (Serializer gives instant local repaint).

**Deploy plan (in order):**
1. **Ship Surgical bundle. Bake at least 1 week.**
2. **Ship Robust bundle increments through Phase 5e. Bake at each step.** At this point seq+ack, per-client cursor, binary frames, PAUSE/RESUME are all in production for raw-attach mode.
3. **Phase 6a: Build the `ControlModeParser` as a standalone library.** Reference the sketch in 03-tmux §2.11. Write extensive test fixtures from real `tmux -CC` traffic capture (record from a local sandbox). Cover all 24 notification types (03-tmux §2.4) plus reply guard handling. Octal-escape decoder must handle every C0 byte plus `\134`. Ship as `lib/cm-parser.js` with no production wiring yet.
4. **Phase 6b: Add side-band `-CC` gateway client (C22).** One server-side `-CC` client per session with `refresh-client -f no-output,ignore-size,read-only`. Receives only `%layout-change`, `%window-add`, `%window-renamed`, `%session-changed` notifications. No `%output`. Uses the new parser. Run alongside the existing raw-attach for a few weeks; verify all event types are correctly parsed and there are no crashes. This is the safe-by-design first contact with `-CC`.
5. **Phase 6c: Build the `-CC` data path as a parallel attach mode.** Add a new `attachMode` flag per session ("raw" or "cc"). When "cc", the gateway uses `tmux -CC attach-session` instead of raw `attach-session` (`terminal-manager.js:93-103`). Input goes via `send-keys -l <bytes>` (with `-H` for non-printable); output comes via `%output %p value`. Sizing via `refresh-client -C cols×rows`. Replace C2 PAUSE/RESUME with C18 `pause-after` for cc-mode sessions. Default `attachMode = "raw"` for all existing sessions.
6. **Phase 6d: Per-session opt-in to cc-mode.** Add a UI toggle to flip individual sessions to cc-mode. Test with internal team. Monitor for parser bugs, octal-escape edge cases, send-keys input edge cases (large pastes, bracketed paste).
7. **Phase 6e: Default-flip to cc-mode for new sessions.** After 2-4 weeks of opt-in stability. Existing sessions stay on raw until detached. Old code path stays warm for emergency rollback.
8. **Phase 6f: Add C13 persistence (Redis or SQLite).** Now that seq numbers (from Phase 5b) and structured framing (from cc-mode) are both stable, persistence has something meaningful to persist. Snapshot every N seconds (sshx-style 32 KiB cap) on shutdown; restore on startup before accepting WS upgrades.
9. **Phase 6g: Add C14 (`SerializeAddon` client cache).** `npm install @xterm/addon-serialize`. On `ws.onclose`, call `serializeAddon.serialize()` and store in `sessionStorage` keyed by sessionId. On `ws.onopen` (reconnect to same tab), restore as immediate visual before server snapshot arrives. Server snapshot still authoritative — Serializer is a perceived-latency reducer.
10. **Phase 6h: Decommission raw-attach codepath.** After cc-mode default has been stable for 2+ months. Remove the `attachMode` flag, the raw-attach branch in `attachToSession`, the C2 PAUSE/RESUME opcodes (C18 has replaced them), the C5 capture-pane snapshot for new attaches (C5 still useful as cross-instance bootstrap and as fallback for clients behind seq window — keep that path).

**Risk profile:** High. C4 alone is the largest behavioural change in the project (03-tmux §11.4). Long timeline, multiple deploy windows (likely 6+ months from first Surgical to Phase 6h). The end state is iTerm2-class architectural soundness; the journey is months, not weeks. Every phase is independently flag-gated; rollback at any phase is well-defined. Recommended ONLY if the project has multi-pane UI ambitions or multi-tenancy / per-client backpressure needs that Robust does not satisfy.

---

## 7. Decisions punted to Phase 5

The arbiter must make these binary or n-ary decisions. Each is binding on the bundle choice; some compound (D11 implies D5's value, D2 forces D1's hand, etc.).

### 7.1 Protocol-shape decisions

- **D1. Transport for `output` frames: JSON-text envelope, JSON-text + binary opcode hybrid, or pure binary frames?** (Gates C9 and indirectly C2, C10, C16.) Bundle Surgical is JSON-text; Robust and Future-proof require pure binary or hybrid. Hybrid is the safest migration path: keep JSON for control (resize, exit, error, hello) and switch ONLY high-volume `output` and `snapshot` to binary. Pure binary is more elegant once both ends are migrated. **Recommendation framing:** if "no protocol changes ever" is a hard constraint, Surgical is the only option. If a single coordinated protocol bump is acceptable, hybrid is a sweet spot.
- **D2. Add seq+ack at all?** (Gates C10 and indirectly C1, C12, C13.) Surgical = no (snapshot is sufficient because it's well-formed); Robust and Future-proof = yes. **Recommendation framing:** seq+ack is the foundational primitive for everything beyond snapshot-only correctness. Without it, P3 multi-client divergence and P6 cross-instance continuity stay best-effort.
- **D3. Snapshot source: always capture-pane, capture-pane + chunked replay, or full mosh-style framebuffer?** (Gates C5 vs C19.) Surgical and Robust use C5; Future-proof can layer Serializer (C14) on top for client-side immediate paint. **Recommendation framing:** C5 is the only option short of a full rewrite. Layering C14 on top is cheap.
- **D4. Per-client broadcast cursor or shared buffer broadcast?** (Gates C12.) Surgical = shared; Robust and Future-proof = per-client. **Recommendation framing:** the cost of per-client cursor is moderate (~200 LoC), the benefit (P3 root cause closure + foundation for per-client backpressure decisions) is high. The argument for staying shared is "we don't have multi-client semantically meaningful workflows" — but the project DOES support multi-tab presence, so this is overstated.
- **D5. Backpressure mechanism: drop-oldest (status quo), PAUSE/RESUME, evict-slow-client, `pause-after`?** (Gates C2 vs C17 vs C18.) Surgical = drop-oldest; Robust = C2 + C17 (PAUSE for steady state, evict as ceiling); Future-proof = C18 + C17 (`pause-after` requires `-CC`). **Recommendation framing:** drop-oldest masks a real problem (slow clients silently degrade entire session). Even Surgical should include C17 as a defensive ceiling regardless of other choices.

### 7.2 Client-side decisions

- **D6. Replay barrier marker (`replay_complete`)?** (Gates C21.) All bundles include it (cheapest possible). **Recommendation framing:** there is no scenario where this is wrong to add.
- **D7. Resize debounce: client only, server only, both?** (Gates C8.) All bundles include both (defensive). **Recommendation framing:** client-side debounce is the load-bearing fix. Server-side coalesce is defensive against client bugs and is also a forward-compatibility hedge if C15 gets reverted.
- **D8. Reset vs clear vs Serializer round-trip on reconnect?** (Gates C6 vs C14.) Surgical = C6; Robust = C6; Future-proof = C6 + C14. **Recommendation framing:** C6 is a one-line change with no downside; ship it in any bundle. C14 is "nice to have" — adds ~120 LoC and an experimental addon, gives instant repaint on same-tab reconnect.
- **D14. `binaryType` switch: keep `blob` default, switch to `arraybuffer`?** (Gates C9 + closes P11/P12 latent.) Surgical = keep blob (text-only path stays defensive); Robust and Future-proof = arraybuffer. **Recommendation framing:** switching to `arraybuffer` is benign even without C9 server-side (no binary frames are sent today, so the default doesn't matter operationally — but the change forecloses future surprises).

### 7.3 Server-side architectural decisions

- **D9. Persistence story: in-memory only, snapshot to SQLite/Redis, rely on tmux only?** (Gates C13.) Surgical and Robust = tmux only (relies on C5 to bootstrap from `capture-pane`); Future-proof = SQLite/Redis snapshot. **Recommendation framing:** for a single-VPS deployment with PM2 blue/green on the same host, the marginal value of cross-instance persistence is small — tmux already survives. C13 is more interesting if/when the project grows multi-host.
- **D10. Throttled batcher on live output path?** (Gates C16.) Optional in all bundles; recommended once per-client cursor (C12) is in place. **Recommendation framing:** C16 is a tuning knob, not a fix; defer until measurement shows frame count is the bottleneck.
- **D11. Switch from raw `attach-session` to `-CC`?** (Gates C4 and consequents C18, C22.) Surgical and Robust = no; Future-proof = yes. **Recommendation framing:** the deciding question is "does the project anticipate multi-pane UI in the browser, or per-client backpressure that Robust does not satisfy?" If yes, `-CC` is the natural end state. If no, Robust is sufficient indefinitely.
- **D12. Tighten `tmux.conf` (especially `window-size manual` + `aggressive-resize off`)?** (Gates C15.) All bundles include it (cheapest single lever against P5). **Recommendation framing:** the only meaningful UX trade-off is `default-size` for mobile portrait viewports — solved by either accepting horizontal scroll or by per-client dynamic sizing (which is itself a Future-proof feature).
- **D13. Add ping/pong?** (Gates C11.) All bundles include it (orthogonal layer). **Recommendation framing:** highest-value-per-LoC orthogonal fix in the entire candidate set.

### 7.4 Cross-cutting concerns

- **D15. Mobile workstream interaction.** Several candidates have outsized mobile impact: C8 (debounce — critical for keyboard show/hide), C11 (ping/pong — critical for cellular handoff), C2/C17 (slow links no longer OOM the server), C15 (no resize storms on viewport change), C9 (less bandwidth, less JSON.parse). C14 (Serializer) gives instant visual on cellular reconnect. The arbiter should consider whether the mobile workstream's needs prioritize Surgical (mobile-impact-only subset: C8 + C11 + C15) versus Robust (full backpressure for cellular). The Surgical bundle DOES address mobile's biggest pain points (resize storms, half-open TCP) but does NOT address the slow-link OOM hazard.
- **D16. Acceptable per-reconnect latency budget.** C5 adds ~5–50 ms per reconnect (one capture-pane fork + 2 display-message forks). C13 restore adds ~50–500 ms on cold start. C7 + C21 (per-segment flush in C3) add ~10–100 ms per replay depending on size. Bundle choice depends on what the user-perceived budget is. Today's reconnect latency is dominated by network RTT (~50–200 ms) and the auth round-trip (`Terminal.tsx:119` token fetch); any of these additions is small in comparison.
- **D17. Acceptable additional dependencies.** C13 implies Redis or new SQLite schema. C14 implies a new npm package (`@xterm/addon-serialize`, ~30 KB). C9 implies no new dep but version-negotiation discipline. Self-hosted single-VPS deployment may want zero new deps for ops simplicity. The Surgical bundle adds zero deps.
- **D18. Documentation drift (CLAUDE.md:28 says 500 KB but actual cap is 2 MB — PTY scan §5.2 / §7.3).** Cosmetic but worth fixing in whichever bundle ships. Symbolic of "what other docs are stale?" — worth a wider sweep during the bundle PR.
- **D19. Ephemeral terminal scope.** Today `EphemeralTerminal.tsx:47-79` has no reconnect logic, no DA/CPR filter, no ResizeObserver debounce. The scans treat ephemeral as out of scope but every candidate should at least decide: "is the ephemeral path inheriting this fix?" The default answer is "no" (ephemeral sessions are short-lived per `terminal-manager.js:732-734`), but C8 and C11 specifically benefit ephemeral too.
- **D20. Symphony WS path mismatch (WS scan §7 H7).** Out of scope for terminal reliability but cleanly observable; if the bundle ships PR is large, fixing this alongside avoids fragmentation.

---

## 8. Appendix: candidate-by-problem coverage matrix

This is a compressed view of "which candidates close which problems," for arbiters who want to think in terms of specific failure modes rather than candidate bundles.

| Problem | Closed by | Mitigated by | Untouched by |
|---|---|---|---|
| **P1** mid-CSI cut in replay | C1, C3, C4, C5 (snapshot path), C19 | C20 (raw-byte log for offline reconciliation) | C2, C6–C18 (other than C9 which closes the JSON-quoting hazard component) |
| **P2** snapshot vs live race | C10 (seq dedupes), C19 (state-model idempotent), C21 (boundary marker) | C5 + C7 (clean snapshot + flush barrier), C14 (client-side immediate paint), C3 (per-segment fence) | C1, C2, C6, C8–C13, C15–C18 |
| **P3** multi-client divergence | C4 (per-pane structure), C12 (per-client cursor), C19 (per-client state model) | C18 (per-pane pause), C22 (structured layout sync) | C1, C2, C5–C11, C13–C17 |
| **P4** no backpressure | C2 (PAUSE/RESUME), C17 (drop slow), C18 (pause-after via -CC) | C12 (enables per-client decisions), C16 (reduces pressure), C19 (adaptive throttling) | C1, C3–C11, C13–C15, C20–C22 |
| **P5** resize storms | C8 (debounce), C15 (window-size manual + aggressive-resize off) | (no others — physics is at the tmux layer) | All other candidates |
| **P6** blue/green replay drift | C5 (tmux-authoritative snapshot), C13 (cross-instance persistence) | C10 (seq lets clients dedupe across flip), C19 (state model survives) | C1–C4, C6–C9, C11, C14–C18, C20–C22 |
| **P7** xterm.js write fire-and-forget | C7 (callback chaining) | C3 (per-segment writes use callback by definition) | All other candidates |
| **P8** clear vs reset | C6 (use reset) | C14 (Serializer round-trip preserves state across reset) | All other candidates |
| **P9** no ping/pong | C11 (dedicated layer) | (no others) | All other candidates |
| **P10** UTF-16 surrogate hazard | C1 (chunk granularity), C9 (binary frames bypass UTF-16) | C3 (segment isolation), C5 (snapshot path doesn't slice) | C2, C4, C6–C8, C11–C22 |
| **P11** JSON.parse fallback raw write | C9 (binary canonical, JSON fallback dead) | (no others — needs explicit defensive code) | All other candidates |
| **P12** `binaryType=blob` default | C9 (forces decision) | (no others) | All other candidates |

Reading this matrix: **C5 and C9 are the two highest-multiplier candidates** — C5 closes or mitigates 4 problems (P1, P2, P6, P10) and is the cheapest non-trivial change; C9 closes or mitigates 3 problems (P9 actually requires C11; correction: C9 closes P10/P11/P12) and is the foundation for any future binary protocol. **C19 (mosh) covers the most problems at once but is architecturally exclusive.**

---

## 9. Appendix: implementation gotchas surfaced by the scans

These are not candidates per se — they are concrete implementation details that any bundle must handle correctly.

- **CRLF normalisation for capture-pane output.** Snapshot output uses bare `\n` (03-tmux §4.1). xterm.js does not set `convertEol` (client scan §1.2), so `\n` alone produces a staircase. Either rewrite `\n` → `\r\n` server-side (Recipe X step 1, 03-tmux §10.1) or set `convertEol: true` on the xterm constructor.
- **Alt-screen detection for capture-pane.** If pane is in alt-screen mode (`#{alternate_on}` is `1`), use `capture-pane -a` (03-tmux §6.3). Otherwise capture-pane returns the *normal* screen which is NOT what the user is looking at (e.g. inside vim).
- **`maxBuffer: 8 MiB` on `execSync` for capture-pane** (`terminal-manager.js:42`) is a hard ceiling. At 200 cols × 50000 lines history with ANSI overhead, ~12 MB worst case (03-tmux §4.3); raise to 16 MB or accept truncation.
- **`ALT_SCREEN_RE` per-chunk regex hazard.** `terminal-manager.js:282` strips `\x1b\[\?(1049|1047|47)[hl]` per chunk; if a chunk ends with `\x1b\[\?104` and the next starts with `9h`, the split sequence escapes the strip (PTY scan §2). Latent risk for any bundle that retains the raw-attach path.
- **node-pty Buffer mode for `-CC`.** `%output` value MAY be non-UTF-8 (03-tmux §2.5); switching to Buffer mode for the `-CC` PTY (`encoding: null` in `terminal-manager.js:97-103`) is the only way to handle non-UTF-8 apps correctly. Risk: rest of the code assumes string mode.
- **WS auth token re-fetch per reconnect.** `Terminal.tsx:119` does `fetch("/api/auth/ws-token")` on every retry. In an exponential-backoff reconnect storm, this hits the auth endpoint many times. Auth path issues `expiresIn:"30s"` (`route.ts:17-28`) and clients increment `authFailureCountRef` (`Terminal.tsx:122`) — there is no token caching. Worth considering caching for 25 s.
- **`4401`/`4404` close codes referenced but never emitted.** `Terminal.tsx:201` checks for these but server's auth failure path uses raw TCP RST (`server.js:166-168`) which fires `event.code === 1006` instead. WS scan §10.3 documents this is a latent bug in the reconnect logic; auth failures retry forever silently.
- **PM2 `kill_timeout: 45000` vs `gracefulShutdown` 40 s force-exit.** Tight margins (`server.js:303-306` and `ecosystem.config.js:21,42`); a misbehaving WS flush could keep the process alive long enough to overlap with PM2's SIGKILL deadline. WS scan §2.2.d.
- **EphemeralTerminal has no reconnect logic at all.** `EphemeralTerminal.tsx:47-79`. Every bundle must explicitly decide whether ephemeral sessions inherit the same reconnect behaviour or stay one-shot.
- **Symphony WS path mismatch (H7 from WS scan).** `SymphonyContext.tsx:256` connects to `/api/symphony-ws` but server (`server.js:245`) only handles `/api/symphony-events`. Out of scope for terminal reliability but worth fixing alongside.
- **Documentation drift at CLAUDE.md:28** — says "500 KB circular" but actual cap is 2 MB (PTY scan §5.2 and §7.3). Whichever bundle ships should also update the docs.

---

## 10. Appendix: candidate ranking within each criterion

Per the spec, candidates are ranked WITHIN each criterion only — no winner is picked overall. Lower number = better on this axis (1 = best). Ties indicated with `=`.

### 10.1 Ranked by correctness gain (number + severity of P-IDs closed)

1. C19 (closes P1, P2, P3, P4, P6 by alternate architecture)
2. C4 (closes P1, P2, P3, P6; major step toward P4 via C18)
3. C10 (closes P1, P2, P3, P6 — within rolling-buffer window)
4. C5 (closes P1, P6; partial P2, P10)
5. C1 (closes P1, P10; foundational for C10/C12)
6. C12 (closes P3 root cause)
7. C3 (closes geometry-correct replay component of P2; partial P1 within segment)
8. C2 (closes P4)
9. C13 (closes P6 fully when paired with C10)
10. C9 (closes P10/P11/P12 latency)
11. C8 (closes P5)
12. C15 (closes P5 at the tmux layer — orthogonal to C8)
13. C11 (closes P9)
14. C6 (closes P8 — small but cheap)
15. C7 (closes P7)
16. C14 (mitigates P2 perceived latency)
17. C21 (mitigates P2 boundary clarity)
18. C16 (mitigates P4 pressure, doesn't close)
19. C17 (mitigates P4 ceiling, doesn't close)
20. C18 (closes P4 in the -CC world only)
21. C22 (mitigates P3 layout-sync component only)
22. C20 (mitigates P6 byte-log component only; no other coverage)

### 10.2 Ranked by implementation cost (LoC + new deps)

1. C6 (~1 LoC, no deps)
2. C15 (~10 LoC config, no deps)
3. C21 (~20 LoC, no deps)
4. C7 (~30 LoC, no deps)
5. C17 (~30 LoC, no deps)
6. C8 (~40 LoC, no deps)
7. C16 (~50 LoC, no deps)
8. C18 (~50 LoC, requires C4 first)
9. C5 (~80 LoC, no deps)
10. C11 (~80 LoC, no deps)
11. C20 (~80 LoC plus log rotation script, no deps)
12. C22 (~100 LoC, requires C4 first)
13. C14 (~120 LoC plus 1 npm dep)
14. C1 (~150 LoC, no deps)
15. C9 (~150 LoC, no deps; requires version negotiation)
16. C2 (~200 LoC, no deps)
17. C12 (~200 LoC, no deps)
18. C3 (~250 LoC, no deps; backwards-compat needed)
19. C10 (~250 LoC, no deps; backwards-compat needed)
20. C13 (~300 LoC plus 1 dep — Redis or schema; deploy machinery changes)
21. C4 (~600–1000 LoC, no deps but large surface)
22. C19 (~3000+ LoC, complete rewrite)

### 10.3 Ranked by deploy risk (lowest first)

1. C6, C15, C21 — config-only or one-line client-only; trivial revert.
2. C7, C8, C11 — server or client only; established patterns; revert by feature flag or commit revert.
3. C5, C16, C17 — server-only changes that don't reshape the protocol; revertable behind env var.
4. C1, C12 — restructure server data model but preserve wire protocol; flag-gated.
5. C14 — adds an experimental npm package; fail-closed by removing the addon import.
6. C18, C22 — tied to C4's deploy risk.
7. C20 — pipe-pane file-system writes, log-rotation new operational concern.
8. C9, C10 — protocol changes requiring synchronized client+server deploy or version negotiation.
9. C2, C3 — protocol changes plus PAUSE/RESUME state machine to maintain across deploys.
10. C13 — adds external dep + persistence-on-shutdown race with PM2 SIGKILL.
11. C4 — largest behavioural change in the project; long migration window.
12. C19 — full rewrite; no rollback path short of redeploying old server.

### 10.4 Ranked by latency cost (lowest first)

1. C6, C7, C8, C9, C11, C15, C16, C17, C20, C21, C22 — zero or sub-millisecond steady-state cost.
2. C12, C13 (steady state) — small per-client queue overhead; no per-byte cost.
3. C5 — ~5–50 ms per reconnect (capture-pane fork). Zero on live path.
4. C1, C3, C10 — micro-overhead per chunk (object header, seq field) but no perceptible latency.
5. C2, C18 — RTT for PAUSE/RESUME crossing on slow links, otherwise zero.
6. C14 — ~5–50 ms serialize on disconnect (browser-local).
7. C13 — ~50–500 ms restore on cold start; ~1–10 ms snapshot write per N seconds.
8. C19 — tens of ms per state diff (acceptable, but a new latency surface).
9. C4 — 1.0–4.0× bandwidth overhead from octal-escape on bursty output (vs raw); steady-state latency unchanged.

### 10.5 Ranked by mobile/UX benefit (highest first)

1. C8 (resize debounce — keyboard show/hide is the #1 mobile reliability hole).
2. C15 (tmux-layer resize fix — eliminates physics, complementary to C8).
3. C11 (ping/pong — cellular handoff is #2 mobile reliability hole).
4. C2, C17 (slow-link OOM no longer kills the session).
5. C9 (less bandwidth, less JSON.parse cost on mobile CPU).
6. C14 (instant local repaint on reconnect — perceived latency win).
7. C16 (fewer frames = fewer JSON.parse cycles).
8. C5 (cleaner snapshot = less visual noise on small viewports).
9. C12 (per-client cursor — late joiner experience improves).
10. C10 (resume-from-offset = no full replay on reconnect).
11. C6, C7, C19, C21 — mobile-neutral; benefits all clients equally.
12. C1, C3, C4, C13, C18, C20, C22 — orthogonal to mobile.

### 10.6 Ranked by operational cost (lowest first)

1. C6, C8, C11, C15, C17, C21 — no new metrics, no new alerts.
2. C5, C7, C16 — one new metric (capture-pane fork count, write-callback latency, batch size distribution).
3. C1, C9, C10, C12 — protocol changes need new monitoring (seq gap detection, binary-frame parse errors, queue depths).
4. C2, C18, C22 — flow-control state needs to be monitored (pauses/min/session, time-paused).
5. C3, C14 — moderate (segment count, serialize cost).
6. C13 — significant (Redis/SQLite snapshot size, restore failure alerting, write latency).
7. C4 — significant (parser bugs, octal-escape correctness, send-keys input edge cases, layout-parser regressions).
8. C20 — disk-usage monitoring, log rotation.
9. C19 — entire new operational surface.

### 10.7 Ranked by rollback ease (highest first)

1. C6, C15, C21 — instant revert; one-line / config-only.
2. C7, C8, C11, C14 — feature-flag or commit-revert; no protocol implications.
3. C5, C16, C17 — env-var flag; fail back to previous behaviour.
4. C1, C12 — feature-flag at server; preserves wire protocol.
5. C9, C10 — version-negotiation lets old clients fall back to JSON / no-seq.
6. C2, C3, C18, C22 — protocol-coordinated revert needed; both ends must roll back together.
7. C13 — persistence is hard to undo without state loss.
8. C20 — turn off the pipe; stale logs remain.
9. C4 — entire migration must be reversed; mid-state rollback complex.
10. C19 — effectively no rollback short of redeploying old server.

### 10.8 Ranked by coupling (most-coupled first — i.e., requires the most other candidates)

1. C19 (mosh) — excludes 12 candidates; demands its own architecture; coupling-via-exclusion is total.
2. C4 (`-CC` migration) — required by C18 + C22; excludes raw-attach codepath; deeply changes input/output/sizing semantics; touches every protocol decision.
3. C13 (cross-instance persist) — implicitly requires C10; deploy-machinery changes; influences D9 entirely.
4. C12 (per-client cursor) — requires C1; enables C2/C17 to make per-client decisions; changes broadcast loop fundamentally.
5. C10 (seq+ack) — requires C1; enables C12+C13 to make sense; protocol-version-bump catalyst.
6. C3 (segmented replay) — requires C7; constrains how `output` is framed.
7. C18 (`pause-after`) — requires C4; conflicts with C2.
8. C22 (side-band gateway) — requires C4.
9. C2 (PAUSE/RESUME) — naturally pairs with C9 + C16 + C17 for full backpressure picture.
10. C9 (binary frames) — version-negotiation discipline for any protocol change downstream.
11. C1 (chunk list) — foundation for C10/C12 but standalone-improvable.
12. C5 (capture-pane snapshot) — standalone; pairs well with everything; no exclusions.
13. C14 (Serializer) — standalone; complements but does not require anything.
14. C6, C7, C8, C11, C15, C16, C17, C20, C21 — fully standalone or weakly coupled.

**Most-coupled candidate: C19 (mosh SSP).** It excludes every architectural alternative simultaneously. Even C4, the second-most-coupled, only requires migration; C19 demands a complete rewrite that displaces all other choices.

---

## 11. Appendix: full citation index

Every claim in the document above traces to one of the following sources. Cited inline as `(scan §)` or `(03-streaming §)` / `(03-tmux §)`.

**Phase 2 scans (project-internal):**
- `/root/projects/claude-terminal/agent-workflow/02-scan-pty.md` — PTY pipeline scan; replay buffer semantics; tmux attach mode; UTF-8 boundary handling; hypothesis verdicts H1–H9.
- `/root/projects/claude-terminal/agent-workflow/02-scan-ws.md` — WebSocket transport scan; backpressure audit; reconnect state machine; multi-client fan-out; frame-loss surface enumeration.
- `/root/projects/claude-terminal/agent-workflow/02-scan-client.md` — xterm.js client render path; FitAddon usage; write-loop audit; reconnect ordering; IME/composition/paste; addon load order.

**Phase 3 research (project-internal, citing external sources):**
- `/root/projects/claude-terminal/agent-workflow/03-research-streaming.md` — survey of ttyd / gotty / wetty / sshx / upterm / VS Code Remote / mosh / xterm.js addons; pattern catalogue P1–P20; problem-to-recipe mapping A–H; arbiter decision framing D1–D10.
- `/root/projects/claude-terminal/agent-workflow/03-research-tmux.md` — tmux attach-modes deep dive; control-mode protocol primer; `pipe-pane` semantics; `capture-pane` flag matrix; Recipe X/Y/Z; `tmux.conf` knob recommendations.

**Project source files referenced by line:**
- `/root/projects/claude-terminal/server.js` — HTTP + WS upgrade; graceful shutdown; symphony broadcast.
- `/root/projects/claude-terminal/terminal-manager.js` — PTY lifecycle; replay buffer; tmux glue; broadcast loop; lazy attach.
- `/root/projects/claude-terminal/tmux.conf` — tmux session settings.
- `/root/projects/claude-terminal/CLAUDE.md` — project doc (stale 500 KB note).
- `/root/projects/claude-terminal/deploy.sh` — blue/green deploy.
- `/root/projects/claude-terminal/ecosystem.config.js` — PM2 configs.
- `/root/projects/claude-terminal/src/components/Terminal.tsx` — xterm.js client; WS reconnect; FitAddon; key handlers.
- `/root/projects/claude-terminal/src/components/EphemeralTerminal.tsx` — ephemeral terminal client.
- `/etc/nginx/sites-available/claude-terminal` — WSS proxy config.
- `/etc/nginx/claude-terminal-upstream.conf` — single-line upstream pointer.

**External references cited by Phase 3 research (verified live during that phase):**
- ttyd: `https://github.com/tsl0922/ttyd`
- gotty: `https://github.com/yudai/gotty`
- wetty: `https://github.com/butlerx/wetty`
- sshx: `https://github.com/ekzhang/sshx`
- upterm: `https://github.com/owenthereal/upterm`
- VS Code remote terminal: `https://github.com/microsoft/vscode/main/src/vs/{workbench,platform}/terminal`
- mosh: `https://github.com/mobile-shell/mosh`
- xterm.js addons: `https://github.com/xtermjs/xterm.js/tree/master/addons`
- tmux Control Mode wiki: `https://raw.githubusercontent.com/wiki/tmux/tmux/Control-Mode.md`
- iTerm2 tmux integration: `https://iterm2.com/documentation-tmux-integration.html`
- tmux(1) man page: local copy via `man tmux | col -bx`, 3959 lines, tmux 3.4.

---

## 12. Appendix: Phase 2 hypothesis-to-candidate trace

Each Phase 2 hypothesis was either ACCEPTED or REJECTED in the scans. Below is an explicit trace from each ACCEPTED hypothesis to the candidate(s) that close it, plus the rejection rationale for those not pursued.

### 12.1 PTY scan hypotheses
- **H1 (UTF-8 cut on WS frame boundary).** REJECTED on producer path (Node `StringDecoder` ensures full codepoints); PARTIALLY ACCEPTED at trim boundary as the UTF-16 surrogate hazard. **Closes via:** C1 (chunk granularity) and C9 (binary frames bypass UTF-16 entirely).
- **H2 (Replay buffer truncation mid-escape).** ACCEPTED. **Closes via:** C1, C5 (snapshot path), C3 (segment isolation), C19 (alternate architecture). C5 is the cheapest fix.
- **H3 (PTY resize storms).** ACCEPTED. **Closes via:** C8 (debounce), C15 (`window-size manual`).
- **H4 (tmux pipe-pane vs control-mode mismatch).** REJECTED — pipe-pane not used in code; raw attach is. The spirit applies to C4 vs status quo.
- **H5 (Server-side throttling splits escapes).** REJECTED — no batching exists. C16 would *introduce* batching but in an escape-safe way (concatenation within batch).
- **H6 (Blue/green flip drift).** ACCEPTED. **Closes via:** C5 (tmux-authoritative snapshot), C13 (cross-instance persistence).
- **H7 (Multi-client without per-client cursor).** ACCEPTED. **Closes via:** C12 (per-client cursor on chunked log via C1).
- **H8 (xterm.js write not awaited).** Deferred to client scan — PARTIALLY ACCEPTED. **Closes via:** C7 (callback chaining).
- **H9 (Reconnect race).** ACCEPTED. **Closes via:** C10 (seq dedupes), C21 (boundary marker), C5+C7 (clean snapshot+fence).

### 12.2 WS scan hypotheses
- **H1 (No backpressure).** ACCEPTED. **Closes via:** C2, C17, C18 (in -CC world). C12 enables per-client backpressure decisions.
- **H2 (Reconnect race).** ACCEPTED at duplication, partial at reorder. **Closes via:** C10 (seq dedupes), C21 (boundary marker).
- **H3 (Multi-client divergence).** ACCEPTED. **Closes via:** C12 + C1.
- **H4 (Blue/green flip).** PARTIAL ACCEPT. **Closes via:** C5 (snapshot is tmux-authoritative), C13 (cross-instance state).
- **H5 (Write not chained).** ACCEPTED. **Closes via:** C7.
- **H6 (No ping/pong, bonus).** ACCEPTED. **Closes via:** C11.
- **H7 (Symphony WS path mismatch, bonus).** Out of scope for terminal reliability; flag for separate fix (D20).

### 12.3 Client scan hypotheses
- **H1 (xterm.js write not awaited).** PARTIALLY ACCEPTED. **Closes via:** C7.
- **H2 (Reconnect race at screen-state level).** ACCEPTED at screen-state level, REJECTED at wire/protocol level. **Closes via:** C5 (well-formed snapshot), C6 (clean baseline), C7 (write-callback flush).
- **H3 (FitAddon called per-keystroke during resize).** ACCEPTED. **Closes via:** C8 (debounce), C15 (kill physics at tmux layer).
- **H4 (Replay applied without `term.reset()`).** ACCEPTED. **Closes via:** C6.

### 12.4 Coverage completeness
Every ACCEPTED hypothesis from Phase 2 has at least one candidate that addresses it. The `compatibility nucleus` (§5.4) — C5, C6, C7, C8, C11, C15, C16, C21 — addresses 8 of the 12 P-IDs (P1, P2 partial, P5, P6, P7, P8, P9, P10 partial). The remaining four (P3, P4, P11, P12) require Robust-bundle additions (C12, C2/C17, C9).

---

## 13. Appendix: when each candidate is "free"

For Phase 5 prioritisation, useful to know which candidates impose effectively no cost beyond their own LoC:

- **Free with Surgical bundle:** C5, C6, C7, C8, C11, C15, C21 — these are the Surgical members; pay once.
- **Free if C4 (-CC) is adopted:** C18 (`pause-after`) and C22 (side-band gateway) — both require C4 anyway, so adoption cost is just the few hundred extra LoC each.
- **Free if C1 (chunk list) is adopted:** C10 (seq+ack) becomes natural — chunks already have absolute byte offsets. C12 (per-client cursor) becomes natural for the same reason.
- **Free if C9 (binary frames) is adopted:** C2 (PAUSE/RESUME) opcodes are trivially added to the binary frame vocabulary; C16 (batcher) is unchanged but compresses better in binary; C10 (seq) gets a fixed-width binary representation rather than BigInt-as-string.
- **Free if C12 (per-client cursor) is adopted:** C2 and C17 backpressure decisions become per-client (correct semantics) rather than per-session (over-aggressive).
- **Free if C13 (cross-instance persist) is adopted:** C20 (`pipe-pane` log) becomes a debugging tool rather than a backup mechanism; could be flagged off in production.

---

## 14. Appendix: risk register for the arbiter

Risks the arbiter should weigh before committing to a bundle.

| Risk | Likelihood | Impact | Mitigation in candidates |
|---|---|---|---|
| Mid-deploy protocol mismatch (old client + new server, or vice-versa) | High during any deploy of Robust/Future-proof | Frame parse errors → P11 fallback → corrupt screen | Version negotiation in `hello` frame; server emits old-format if client doesn't advertise capability |
| Per-client async fan-out concurrency bugs (close-during-iteration, queue eviction races) | Medium with C12 | Memory leak per-client or dropped frames | Standard Tokio-style patterns: bounded queue, explicit close handler, eviction on Lagged |
| `-CC` parser bugs (octal-escape edge cases, line-split inside reply blocks, partial reads) | Medium with C4 | Silent data corruption or session lockup | Build parser as standalone library with extensive fixtures; deploy via side-band gateway (C22) first as risk-free first contact |
| `send-keys` for input loses fidelity vs `pty.write` (binary pastes, bracketed paste, large pastes) | Medium with C4 | Typing/paste UX degradation | iTerm2's batched-paste pattern; `send-keys -l` for literal bytes; `-H` for hex |
| Serializer addon (C14) renders incorrectly for some SGR/CJK/combining-mark cases | Low-medium with C14 | Wrong visual on same-tab reconnect (server snapshot still authoritative on next frame) | Use as supplemental immediate-render only; never as authoritative state |
| Persistence (C13) write race with PM2 SIGKILL at 45 s | Medium with C13 | Lost state on hard kill | Atomic writes; checkpoint every N seconds rather than only on shutdown |
| Resize debounce (C8) loses the *last* resize event | Low with C8 | User sees stale geometry briefly | Trailing-edge debounce ensures last event always fires |
| Ping interval too short relative to deploy graceful-shutdown window | Medium with C11 + aggressive interval | Spurious reconnect cycles per deploy | Set ping interval to 30 s, threshold to 60 s — comfortably above the 45 s PM2 kill timeout |
| `tmux.conf` change (C15) requires detach+reattach for `focus-events` | Certain with C15 | First deploy is half-effective; users need to reload | Acceptable; project conventions don't require manual page refresh (auto-reconnect handles it per global rules) |
| Fixed `default-size` (C15) bad for mobile portrait viewport | Medium with C15 | Horizontal scroll on mobile | Choose 200×50 as a reasonable middle ground; revisit if mobile workstream surfaces concrete complaints |

End of `04-tradeoffs-tmux.md`.
