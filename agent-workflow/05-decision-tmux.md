# 05 — Decision: claude-terminal Streaming Reliability

> Phase 5 deliverable for `arbiter-tech-lead-tmux`.
> Mode: BINDING DECISIONS — Phase 6 produces a file-by-file plan from this; Phase 7 splits it across three implementer agents.
> Inputs synthesised: `02-scan-pty.md`, `02-scan-ws.md`, `02-scan-client.md`, `03-research-streaming.md`, `03-research-tmux.md`, `04-tradeoffs-tmux.md`.

---

## 1. Decision summary

We ship **Bundle "Robust-Lite"** — the Surgical nucleus made permanent (`C5+C6+C7+C8+C11+C15+C21`) with the seq+ack/per-client cursor backbone bolted on (`C1+C10+C12`), the latent multi-client/binary hazards closed (`C9` hybrid, `C17` ceiling), and the resize storm killed at the tmux layer (`C15` `window-size manual` is load-bearing). We DO NOT migrate to `-CC` (`C4`), DO NOT ship cross-instance persistence (`C13`), and DO NOT add the experimental Serializer (`C14`) — these are deferred to a future ticket. The philosophy is **"раз и навсегда" = fix the byte-stream invariant, not the symptom**: every byte that leaves the PTY gets an absolute monotonic seq, the replay buffer is a chunk-list that can NEVER cut mid-escape (because we never slice inside a chunk), every reconnect either resumes from `lastSeq` (cheap, exact) or falls back to a `tmux capture-pane` snapshot (well-formed by construction), and every client gets its own cursor so a slow tab cannot poison a fast one. With this, the user's "пакеты теряются" symptom becomes **structurally impossible** — not "less likely after a patch" but "the data structure has no way to express the bug." Resize storms, half-open TCP, mid-CSI snapshots, blue/green drift, and parser-state hangover are all closed in the same drop. We deliberately stop short of `-CC` because the project has no multi-pane UI ambition (single-pane Claude CLI), and the octal-escape + send-keys + parser surface is months of work for marginal gain over Robust-Lite.

---

## 2. Binary decisions

For each decision: **YES / NO**, candidate ID(s) from `04-tradeoffs-tmux.md`, two-sentence rationale.

### D-Q1. Replace raw `slice(-2_000_000)` with chunk-list buffer + per-client cursor?
**YES.** `C1` (chunk list) + `C12` (per-client cursor).
This is the foundational data-structure fix that closes P1 (mid-CSI cut) and P10 (UTF-16 surrogate split) **by construction** — chunks are exactly what `node-pty.onData` produced, the StringDecoder already aligned them on UTF-8 codepoints, so eviction at chunk granularity never crosses an escape sequence. Per-client cursor on top closes P3 (multi-client divergence) and is the only way to make per-client backpressure (C17) and seq-resume (C10) coherent later.

### D-Q2. Add `tmux capture-pane` snapshot on reconnect (and DROP raw replay)?
**YES.** `C5` (snapshot) — and yes, drop the raw `session.buffer` replay path for new attaches.
`tmux capture-pane -p -e -J` always emits well-formed ANSI per cell, so the snapshot path is structurally clean (PTY scan §6.2, 03-tmux §4); the existing chunk-list buffer (C1) only serves the fast path (resume from `lastSeq` within rolling window). For clients beyond the rolling window or fresh tabs, capture-pane is the authoritative source of truth across blue/green flips — no in-memory state has to be persisted across deploys (P6 closed without C13).

### D-Q3. Switch tmux attach mode to `-CC` control mode?
**NO.** `C4` deferred to out-of-scope.
The project is single-pane with no roadmap for multi-pane UI (which is `-CC`'s killer feature) — paying ~600-1000 LoC for a parser, send-keys input layer, layout-change handler, and Buffer-mode node-pty switch is not justified by the residual benefit once C1+C5+C10 are in place (03-tmux §11.4). Octal-escape overhead (1.0-4.0×) and the operational surface (parser bugs are subtle; iTerm2 still ships edge-case fixes after a decade) make this a poor fit for a self-hosted single-VPS deployment that wants "fix it permanently" without months of migration.

### D-Q4. Add seq+ack protocol on the WS layer?
**YES.** `C10` (seq+ack) + `C21` (`replay_complete` marker).
Every server→client `output` and `snapshot` frame carries an absolute `seq: bigint` (cumulative bytes since session start); on reconnect the client sends `{type:"hello", lastSeq}` and the server resumes from `seq > lastSeq` if within rolling window, else falls back to capture-pane snapshot with a new seq epoch (sshx pattern, 03-streaming P5 / 1.4). This closes P2 (snapshot/live race) and P9 (boundary clarity) by construction — duplicates and reorders become impossible when each byte has a globally unique address.

### D-Q5. Switch WS `binaryType` to `arraybuffer` + send `Buffer` instead of strings?
**YES, hybrid.** `C9` (binary frames) — only for high-volume `output` and `snapshot`; KEEP JSON for control (resize, exit, error, hello, ping, pong).
Pure binary for output is ~30% bandwidth saving and zero JSON.parse CPU on every hot-path message; control messages stay JSON because they're rare, debuggable, and easy to extend (03-streaming P1 / ttyd 1.1 / addon-attach 1.8). The hybrid is the safest migration: client sets `binaryType="arraybuffer"`, dispatches by `event.data instanceof ArrayBuffer`, and keeps the JSON parser for text frames — closes P10/P11/P12 latent hazards in one stroke without forcing all-binary discipline.

### D-Q6. Add ws ping/pong + heartbeat?
**YES.** `C11` — protocol-level `ws.ping()` server-side every 25 s + `ws.on('pong', () => isAlive=true)` watchdog (terminate at 60 s no-pong).
Half-open TCP from cellular handoff or NAT timeout is the single biggest invisible failure mode (WS scan §1.7) — nginx's `proxy_read_timeout 86400` lets connections sit dead for 24 h; users see "frozen terminal" with no reconnect indicator. Standard `ws@8` pattern (referenced WS scan §11), zero protocol surface change, orthogonal to every other decision.

### D-Q7. Chain `term.write` calls via callback (await flush)?
**YES, selectively.** `C7` — chain ONLY at the snapshot→live boundary and the per-segment fence (if/when C3 is added later).
The replay-write needs to fully drain before the `replay_complete` handler fires `fitAddon.fit()` + `term.scrollToBottom()` + reveals the live UI; without the callback the parser may still be processing snapshot bytes when fit() recomputes geometry, producing the "scramble" bug (client scan §10 #2). For live `output` frames we keep fire-and-forget (single-threaded JS guarantees order; chaining every chunk would serialize the pipeline unnecessarily).

### D-Q8. Replace `term.clear()` with `term.reset()` on reconnect?
**YES.** `C6` — one-line change at `Terminal.tsx:155`.
`term.clear()` preserves parser state, SGR attributes, alt-screen flag, mode flags — if the prior connection died mid-CSI, the next replay byte is interpreted with stale parser state (client scan §10 #3). `term.reset()` is a hard reset of all of those; ttyd does this on every `onSocketOpen` (03-streaming 1.1) and it's the cheapest possible correctness improvement in the entire candidate set.

### D-Q9. Debounce FitAddon (client) AND debounce server-side `resize` event?
**YES, both.** `C8` — client `requestAnimationFrame`-coalesce + 80 ms `setTimeout` tail; server equality check `if (cols === session.cols && rows === session.rows) return;` before `pty.resize`.
`ResizeObserver` on mobile keyboard show/hide spams dozens of events per second (PTY scan §6.3, client scan §4.1) — each one round-trips to tmux which redraws the pane and emits a byte burst back. Server-side equality check is defense-in-depth against client misbehavior and survives even if the client-side debounce regresses.

### D-Q10. Add backpressure (PAUSE/RESUME on client ack OR check `bufferedAmount` before send)?
**NO PAUSE/RESUME, YES `bufferedAmount` ceiling.** `C17` (drop slow client at `bufferedAmount > 8 MiB`) — REJECT `C2` (PAUSE/RESUME).
PAUSE/RESUME (C2) requires watermark tuning, a new opcode pair, and pausing node-pty makes Claude CLI see stuck stdout (which can deadlock non-interactive scripts) — too many moving parts for a "ship and forget" fix. C17 is brutal but correct: any client whose `bufferedAmount` exceeds 8 MiB gets `client.close(4503, "lagging")` and the seq-resume protocol (C10) lets them reconnect cleanly from `lastSeq` — the kicked client picks up exactly where it was, and the producer is never throttled by the slowest consumer.

### D-Q11. Per-client broadcast cursor on `terminal-manager` fan-out?
**YES.** `C12` — see D-Q1.
This is the same decision as D-Q1's per-client cursor — replacing the synchronous `for (client of session.connectedClients) client.send(...)` loop at `terminal-manager.js:298-302` with a per-client async record `{ ws, lastSeq, queue, bufferedBytes }`. Slow clients no longer block fast ones; per-client `bufferedAmount` checks (C17) become natural; sshx's `tokio::spawn` per-`Subscribe` (03-streaming 1.4) is the canonical pattern, adapted to Node async iteration.

### D-Q12. Persist replay state across blue/green flips (file? sqlite? in-memory only?)?
**NO — in-memory only, with tmux as the cross-instance source of truth.** REJECT `C13` (cross-instance persistence).
On a single-VPS PM2 blue/green deployment, tmux already survives the process flip (the tmux server is a separate process on a stable socket); the new instance bootstraps `session.chunks` from a fresh `tmux capture-pane -p -e -J -S -` (C5) on first attach, and clients with `lastSeq` outside the rolling buffer fall back to that snapshot. Adding Redis or a SQLite snapshot table to the hot path of `gracefulShutdown` (which races PM2's 45 s SIGKILL deadline at `ecosystem.config.js:21,42`) buys ~10 seconds of byte-accurate continuity per deploy at the cost of significant operational surface — not worth it.

### D-Q13. Tighten `tmux.conf`: `escape-time 0`, `aggressive-resize on`, `history-limit ↑`, `set -g focus-events on`?
**YES, but invert two settings.** `C15` — keep `escape-time 0`, **flip `aggressive-resize` to OFF**, switch `window-size` to `manual` with `default-size 200x50`, keep `history-limit 50000`, add `focus-events on`.
The single load-bearing change is `window-size manual` + `aggressive-resize off` — this kills the "tmux re-renders pane on every client geometry change → byte burst back through the pipe" cascade that drives P5 (03-tmux §6.2, §11.3). Browser xterm.js letterboxes locally; the server tmux runs at fixed 200×50; resize messages from the browser become advisory and are dropped by C8's server-side equality check. Plus: `terminal-features ",*256col*:RGB,clipboard,focus,sync"` for atomic redraws, `automatic-rename off` for clean state, `monitor-bell off` to suppress bell-driven notifications, `set-clipboard off` for security hardening.

---

## 3. Chosen architecture diagram

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                                       HOST                                          │
│                                                                                     │
│   Claude CLI (or any TUI)                                                           │
│        │                                                                            │
│        │ raw bytes (UTF-8 + ANSI)                                                   │
│        ▼                                                                            │
│   ┌─────────────────────────┐                                                       │
│   │ tmux pane (server)      │  tmux.conf NEW:                                       │
│   │  - alt screen ON        │     window-size  manual         ◄── kills P5 storms   │
│   │  - history-limit 50000  │     default-size 200x50         ◄── fixed grid        │
│   │  - escape-time 0        │     aggressive-resize off       ◄── no repaint cascade│
│   │  - status off           │     focus-events on             ◄── editor blur/focus │
│   │  - mouse off            │     terminal-features :sync     ◄── atomic redraws    │
│   │  - allow-rename off     │     automatic-rename off        ◄── no spurious notif │
│   │  - remain-on-exit off   │     monitor-bell off            ◄── no bell notif     │
│   └────────────┬────────────┘     set-clipboard off           ◄── no OSC 52 leak    │
│                │                                                                    │
│                │ tmux internal protocol (raw attach, NOT -CC)                       │
│                ▼                                                                    │
│   ┌─────────────────────────┐                                                       │
│   │ tmux client (PTY slave) │   pty.spawn("tmux", ["-L", SOCK,                      │
│   │                         │     "attach-session", "-t", id], { cols:200, rows:50 })│
│   └────────────┬────────────┘                                                       │
│                │ utf8 string chunks (StringDecoder-aligned)                         │
│                ▼                                                                    │
│   ┌─────────────────────────────────────────────────────────────────┐               │
│   │  TerminalManager._setupPty.onData                               │               │
│   │  ─────────────────────────────────                              │               │
│   │  1. data = rawData.replace(ALT_SCREEN_RE, "")                   │               │
│   │  2. session.totalSeq += data.length                             │ ◄── absolute  │
│   │  3. session.chunks.push({ seq, data })       [C1 chunk list]    │     byte addr │
│   │  4. while totalBytes(chunks) > 2_000_000:                       │               │
│   │       evicted = chunks.shift()                                  │ ◄── chunk-    │
│   │       session.prunedSeq = evicted.seq + evicted.data.length     │     gran. cut │
│   │  5. for client of session.clients:           [C12 per-client]   │               │
│   │       client.queue.push({seq, data})                            │               │
│   │       if client.bufferedAmount > 8 MiB:      [C17 ceiling]      │               │
│   │         client.close(4503, "lagging")                           │               │
│   │       else schedule client.flush()                              │               │
│   └────────────┬────────────────────────────────────────────────────┘               │
│                │                                                                    │
│                │ per-client async drain loop                                        │
│                ▼                                                                    │
│   ┌─────────────────────────────────────────────────────────────────┐               │
│   │  perClientFlush(client)                      [C9 hybrid binary] │               │
│   │  ──────────────────────                                         │               │
│   │  for {seq, data} in client.queue:                               │               │
│   │    if client.binaryCapable:                                     │               │
│   │      frame = [0x01 OPCODE_OUTPUT][8B BE seq][utf8 bytes]        │ ◄── binary    │
│   │      client.ws.send(frame)              // BINARY frame         │     output    │
│   │    else:                                                        │               │
│   │      client.ws.send(JSON.stringify({                            │ ◄── fallback  │
│   │        type:"output", seq:String(seq), data}))                  │     for old   │
│   │  client.lastSentSeq = seq                                       │     clients   │
│   └────────────┬────────────────────────────────────────────────────┘               │
│                │                                                                    │
│                ▼                                                                    │
│   ┌─────────────────────────────────────────────────────────────────┐               │
│   │  ws (npm `ws` 8.19.0) — WebSocketServer                         │               │
│   │   + ws.ping() every 25 s                     [C11 heartbeat]    │               │
│   │   + ws.on('pong', () => isAlive=true)                           │               │
│   │   + isAlive watchdog terminates if no pong in 60 s              │               │
│   └────────────┬────────────────────────────────────────────────────┘               │
│                │ TLS+WSS                                                            │
│                ▼                                                                    │
│   ┌─────────────────────────────────────────────────────────────────┐               │
│   │  nginx                                                          │               │
│   │   proxy_http_version 1.1; Upgrade $http_upgrade;                │               │
│   │   Connection "upgrade"; proxy_read_timeout 86400;               │               │
│   │   upstream switches blue↔green via                              │               │
│   │     /etc/nginx/claude-terminal-upstream.conf                    │               │
│   └────────────┬────────────────────────────────────────────────────┘               │
└────────────────┼────────────────────────────────────────────────────────────────────┘
                 │  WSS to public
                 ▼
┌────────────────────────────────────────────────────────────────────┐
│  Browser                                                           │
│   ws.binaryType = "arraybuffer"             [C9 — closes P11/P12] │
│   ws.onmessage(event):                                             │
│     if event.data instanceof ArrayBuffer:                          │
│       view = new DataView(event.data)                              │
│       opcode = view.getUint8(0)                                    │
│       seq = view.getBigUint64(1)                                   │
│       payloadBytes = new Uint8Array(event.data, 9)                 │
│       lastSeqRef.current = seq                                     │
│       term.write(payloadBytes)             // xterm v6 accepts Uint8│
│     else:                                                          │
│       msg = JSON.parse(event.data)                                 │
│       switch (msg.type):                                           │
│         case "snapshot":                                           │
│           term.reset()                     [C6 — closes P8]        │
│           term.write(msg.data, () => {     [C7 — flush barrier]   │
│             lastSeqRef.current = BigInt(msg.seq)                   │
│             // wait for replay_complete to fit/scroll              │
│           })                                                       │
│         case "replay_complete":            [C21 — boundary marker] │
│           fitAddon.fit()                                           │
│           term.scrollToBottom()                                    │
│           setReconnecting(false)                                   │
│         case "output": (text fallback)                             │
│           lastSeqRef.current = BigInt(msg.seq)                     │
│           term.write(msg.data)                                     │
│         case "exit"/"stopped"/"error": (existing handlers)         │
│   ws.onopen:                                                       │
│     ws.send(JSON.stringify({                                       │
│       type: "hello",                                               │
│       protocol_version: 2,                                         │
│       binary_capable: true,                                        │
│       lastSeq: lastSeqRef.current?.toString() ?? "0",              │
│     }))                                                            │
│     // server replies with EITHER:                                 │
│     //   - {type:"resume", from:lastSeq+1} + chunks where seq>lastSeq│
│     //   - {type:"snapshot", seq, data} (capture-pane) + replay_complete│
│   ws.onclose:                                                      │
│     scheduleReconnect()  // exponential backoff (existing)         │
│                                                                    │
│   ResizeObserver(handleResize):            [C8 — closes P5]        │
│     clearTimeout(resizeTimerRef.current)                           │
│     resizeTimerRef.current = setTimeout(() => {                    │
│       fitAddon.fit()                                               │
│       if cols/rows changed: ws.send({type:"resize", ...})          │
│     }, 80)                                                         │
└────────────────────────────────────────────────────────────────────┘

  Reconnect path (NEW):
  ws.onopen → send {hello, lastSeq=N}
    Server lookup:
      if N >= session.prunedSeq:
        // fast path: resume from chunk list
        send {type:"resume", from:N+1}
        for chunk in session.chunks where chunk.seq > N:
          send binary [OPCODE_OUTPUT][seq=chunk.seq][chunk.data]
        send {type:"replay_complete"}
        register client in session.clients (live broadcast continues)
      else:
        // slow path: client is behind window OR fresh tab
        snapshot = tmuxSnapshot(sessionId)   // see §3.x
        epochSeq = session.totalSeq
        send {type:"snapshot", seq:String(epochSeq), data:snapshot}
        send {type:"replay_complete"}
        register client in session.clients (live broadcast continues)
        // client's lastSeq is now epochSeq; live continues from epochSeq+1
```

### 3.x `tmuxSnapshot` recipe (Recipe X from 03-tmux §10.1)

```js
function tmuxSnapshot(sessionId) {
  // 1. Detect alt-screen state
  const altOn = execFileSync("tmux", ["-L", TMUX_SOCKET,
    "display-message", "-t", sessionId, "-p", "#{alternate_on}"
  ], { encoding: "utf-8" }).trim() === "1";

  // 2. Capture pane (with -a if in alt-screen)
  const args = ["-L", TMUX_SOCKET, "capture-pane", "-t", sessionId,
                "-p", "-e", "-J", "-S", "-", "-E", "-"];
  if (altOn) args.push("-a");
  const raw = execFileSync("tmux", args, {
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,    // raised from 8 MiB (gotcha #3 in 04 §9)
  });

  // 3. CRLF-normalise (xterm.js doesn't set convertEol)
  const body = raw.replace(/(?<!\r)\n/g, "\r\n");

  // 4. Read cursor position
  const [cx, cy] = execFileSync("tmux", ["-L", TMUX_SOCKET,
    "display-message", "-t", sessionId, "-p", "#{cursor_x},#{cursor_y}"
  ], { encoding: "utf-8" }).trim().split(",").map(Number);

  // 5. Wrap with clear-home + cursor-position
  return "\x1b[2J\x1b[H" + body + `\x1b[${cy + 1};${cx + 1}H`;
}
```

### 3.y Reconnect state machine (server-side)

```
                            client opens WS
                                   │
                                   ▼
                            ┌──────────────┐
                            │ AWAIT_HELLO  │
                            └──────┬───────┘
                                   │ first message: {type:"hello", lastSeq, binary_capable}
                                   ▼
                            ┌──────────────┐
                            │ ROUTE_HELLO  │
                            └──────┬───────┘
                                   │
                  ┌────────────────┼────────────────┐
                  │                │                │
        lastSeq < session     lastSeq within       session unknown /
        .prunedSeq           rolling window        no tmux pane
                  │                │                │
                  ▼                ▼                ▼
            ┌──────────┐    ┌──────────┐    ┌──────────┐
            │ SLOW_PATH│    │ FAST_PATH│    │  ERROR   │
            └─────┬────┘    └─────┬────┘    └─────┬────┘
                  │               │               │
                  │               │               │ {type:"error",msg:"Session not found"}
                  │               │               │ ws.close()
                  │               │
                  │               │ {type:"resume", from: lastSeq+1}
                  │               │ binary [OPCODE_OUTPUT][seq][data] x N
                  │               │ {type:"replay_complete"}
                  │               │
                  │               ▼
                  │         ┌──────────┐
                  │         │  LIVE    │ ◄── joins session.clients
                  │         │ (broad-  │     drains its queue per
                  │         │  casting)│     onData event
                  │         └──────────┘
                  │
                  │ snapshot = tmuxSnapshot(sessionId)
                  │ epochSeq = session.totalSeq
                  │ {type:"snapshot", seq: epochSeq, data: snapshot}
                  │ {type:"replay_complete"}
                  │
                  └─► joins session.clients
                      client.lastSentSeq = epochSeq
```

### 3.z Per-client async drain (replaces synchronous broadcast)

```
                  PTY onData(rawData)
                         │
                         │ data = rawData.replace(ALT_SCREEN_RE, "")
                         ▼
                  session.totalSeq += data.length
                  session.chunks.push({seq, data})    ◄── no slice, ever
                         │
                         │ prune oldest CHUNKS while
                         │ totalBytes > 2 MiB
                         ▼
                  for client of session.clients:
                      client.queue.push({seq, data})
                      if !client.drainScheduled:
                          client.drainScheduled = true
                          setImmediate(() => drainClient(client))

                  drainClient(client):
                      client.drainScheduled = false
                      while client.queue.length:
                          {seq, data} = client.queue.shift()
                          if client.bufferedAmount > 8 MiB:
                              client.ws.close(4503, "lagging")
                              session.clients.delete(client)
                              return
                          if client.binaryCapable:
                              frame = encodeBinary(OPCODE_OUTPUT, seq, data)
                              client.ws.send(frame)
                          else:
                              client.ws.send(JSON.stringify({
                                  type:"output", seq:String(seq), data
                              }))
                          client.lastSentSeq = seq
```

This drain pattern guarantees:
- **No client blocks another:** each `setImmediate` runs in its own microtask; one slow client's `bufferedAmount` check only affects itself.
- **No memory blowup from fan-out:** the per-client queue is bounded by the eviction ceiling (8 MiB of `bufferedAmount`); the server-side `chunks` list is bounded by 2 MiB.
- **Order preservation:** within one client, queue is FIFO; across clients, only causal order matters (each client sees the same `seq` values in the same order they were generated).
- **Backpressure correctness:** `bufferedAmount` is a real-time read of the underlying socket's send queue; if it grows, the eviction kicks in before the kernel buffer overruns.

---

## 4. Success criteria

Concrete, measurable, testable. Each one maps to a P-ID closed.

| # | Criterion | Reproduction | P-IDs |
|---|---|---|---|
| **S1** | **Zero divergence over 1 h Claude Code session producing 200 KB/s sustained.** Run `yes "ABC$(date +%N)" \| head -c $(( 200 * 1024 * 60 * 60 ))` (~720 MB) inside a session; diff what xterm.js rendered (via `serializeAddon.serialize()` on close) against the tmux scrollback (`capture-pane -S -`). Difference must be 0 visible cells. | Local sandbox repro script. | P1, P2, P10 |
| **S2** | **Reconnect preserves last 100 KB of output without ANSI corruption.** Run a `printf '\033[38;2;%d;%d;%dm█%s' ...` color-block generator producing >200 KB. Disconnect (kill WS), reconnect 10 s later. The bottom 100 KB of the rendered output must be byte-equivalent to what the prior connection rendered (no escape fragments rendered as text, no missing rows). | DevTools "Offline" toggle + WS close. | P1, P8, P10 |
| **S3** | **Surviving blue→green flip without losing visible screen state.** Start a session running `vim` (alt-screen). Run `bash deploy.sh`. Within 10 s the browser must show the EXACT vim screen (cursor in same cell, same content, same colors) — measured by a screenshot diff (≤2% pixel diff). | Existing `deploy.sh` execution. | P6 |
| **S4** | **WS resume after 60 s offline restores cursor + scrollback within 500 ms.** With a session running `htop`, disconnect for 60 s (DevTools Offline). Reconnect. From the moment `ws.onopen` fires to the moment `replay_complete` handler runs `term.scrollToBottom()`, total ≤500 ms (measured via `performance.now()`). Cursor lands in correct cell, scrollback contains last N lines. | Manual repro + perf marks. | P2, P9 |
| **S5** | **Slow client cannot block fast client.** Two browser tabs on same session. Tab A throttled to 100 KB/s (DevTools throttling); Tab B unthrottled. Producer running `cat /var/log/big.log` at 5 MB/s. Tab B must keep displaying live output at full rate; Tab A receives `close(4503, "lagging")` within 5 s and reconnects with `lastSeq` resume. | DevTools throttle + multi-tab. | P3, P4 |
| **S6** | **Resize storm during mobile keyboard show/hide produces ≤2 `pty.resize` calls.** Open session on mobile (or DevTools mobile emulation). Trigger keyboard show/hide cycle. Server logs (count of `session.pty.resize` calls during the cycle) must show ≤2 per direction. Today: dozens. | DevTools mobile mode + keyboard toggle. | P5 |
| **S7** | **Half-open TCP detected within 90 s.** Mid-session, `iptables -A OUTPUT -p tcp --dport 443 -j DROP` on the server (simulating cellular handoff). Within 90 s the client's `ws.onclose` must fire and reconnect must be attempted. Today: never. | Server iptables drop test. | P9 |
| **S8** | **Window resize during heavy output produces no visible scramble.** With a session running `tail -f /var/log/big.log`, drag the browser window resize handle for 5 s. xterm.js renderer must NOT show out-of-place rows or partial escape fragments rendered as text. | Manual drag + visual inspection. | P5, P7 |
| **S9** | **Replay buffer head is always escape-aligned.** After 10 sessions of >5 MB each, dump `session.chunks[0].data.slice(0, 100)` for each. None must start with a CSI/OSC continuation (e.g. no `;5;...m` without preceding `\x1b[`). | Server-side assertion in dev mode. | P1 |
| **S10** | **Token re-fetch budget on reconnect storm: ≤3 fetches per minute per session.** During a 60 s deploy window, count `/api/auth/ws-token` requests per session. Must be ≤3 (allowing 25 s token cache + jittered backoff). Today: up to 10/minute. | nginx access log analysis. | (out-of-scope adjacent — flagged §7) |

S1, S2, S3, S5, S6, S7 are the user's "раз и навсегда" acceptance set. S4, S8, S9 are quality-of-implementation gates. S10 is adjacent quality.

---

## 5. Rejected alternatives

One line per rejected candidate from `04-tradeoffs-tmux.md`.

- **C2 (PAUSE/RESUME app-level backpressure).** Replaced by C17 (drop slow client) — pausing node-pty makes Claude CLI see stuck stdout, watermark tuning is ongoing operational debt, seq-resume on reconnect makes eviction graceful enough.
- **C3 (segmented `(cols, rows, data)[]` replay).** Geometry is fixed via `window-size manual` (C15), so per-segment geometry is irrelevant; chunk list (C1) plus seq numbers (C10) give better correctness with simpler semantics.
- **C4 (`-CC` control mode migration).** No multi-pane UI ambition, no per-client backpressure need beyond C12+C17, ~600-1000 LoC parser+send-keys+layout work for marginal gain over Robust-Lite — months of risk for no user-visible improvement.
- **C13 (cross-instance persistence).** Single-VPS PM2 blue/green has tmux as a stable cross-instance source of truth; capture-pane (C5) bootstraps the new instance cleanly; Redis/SQLite snapshot adds operational surface without proportional value.
- **C14 (xterm.js `SerializeAddon` round-trip).** Marked experimental upstream, edge cases on combining marks/CJK/SGR; cursor not preserved automatically; server snapshot via capture-pane is already <500 ms which makes the perceived-latency gain marginal — defer until measurement justifies.
- **C16 (server-side throttled batcher / `tinybuffer`).** With C12 (per-client cursor) the broadcast loop is already efficient; with C17 (eviction ceiling) frame count is bounded; defer batcher until measurement shows JSON.stringify or socket-write CPU is the bottleneck.
- **C18 (`pause-after` flow control over `-CC`).** Requires C4 which is rejected.
- **C19 (mosh SSP full state-model rewrite).** Complete server rewrite; alternative architecture; out of scope for "fix the existing system permanently."
- **C20 (`pipe-pane` redundant byte tap).** One pipe per pane conflicts with blue/green overlap; complicates ops with log rotation; provides no benefit beyond what capture-pane (C5) already gives.
- **C22 (side-band `-CC no-output` gateway).** Requires C4 which is rejected.

---

## 6. Work-package partition

Three disjoint partitions for Phase-7 implementer agents. Each agent owns its files exclusively (write access); read-only access to other partitions for cross-reference. Conflicts are minimised by file boundary.

### WP-A — Server transport (data structure + WS protocol + ping/pong + eviction)

**Owner: 1 implementer agent.**
**Goal:** Replace the broadcast loop with per-client cursor, install seq+ack, switch hot-path to binary frames, add ping/pong, install C17 eviction.

**Files OWNED (write access):**
- `/root/projects/claude-terminal/server.js`
- `/root/projects/claude-terminal/terminal-manager.js`
- `/root/projects/claude-terminal/CLAUDE.md` (only the "Replay buffer: 500KB circular" line — fix to actual cap and behaviour)

**Files READ-ONLY:**
- `/root/projects/claude-terminal/src/components/Terminal.tsx` (for protocol shape contract)
- `/root/projects/claude-terminal/src/components/EphemeralTerminal.tsx` (same)
- `/root/projects/claude-terminal/tmux.conf` (for sizing/config awareness)
- `/root/projects/claude-terminal/presence-manager.js` (do NOT touch — separate WSS instance)

**Concrete deliverables (Phase 6 will translate to a file-by-file plan):**
1. Replace `session.buffer` (string) with `session.chunks: Array<{seq: bigint, data: string}>`, plus `session.totalSeq: bigint`, `session.prunedSeq: bigint` (`terminal-manager.js:147, 151, 371`).
2. Replace `session.buffer += data` and `slice(-2_000_000)` (`terminal-manager.js:294-296`, `:746-748`) with chunk-push + chunk-granularity prune. Cap at 2 MiB total cumulative `data.length`.
3. Replace `session.connectedClients = new Set<WebSocket>` with `session.clients = new Map<WebSocket, ClientRecord>` where `ClientRecord = { lastSentSeq: bigint, queue: Chunk[], drainScheduled: boolean, binaryCapable: boolean }` (`terminal-manager.js:147, 474`).
4. Replace synchronous `for (client of session.connectedClients) { ... client.send(...) }` broadcast (`terminal-manager.js:298-302, 750-754`) with per-client async drain (`scheduleClientFlush(client)` posting to `setImmediate`).
5. Implement binary frame format `[0x01 OPCODE_OUTPUT (1 B)][seq big-endian (8 B)][utf8 payload]` for clients with `binaryCapable: true`; JSON fallback `{type:"output", seq:String(s), data}` otherwise. `OPCODE_SNAPSHOT = 0x02` for snapshot frames.
6. Implement `tmuxSnapshot(sessionId)` per §3.x recipe; replace existing `tmuxCapture(sessionId, -1)` calls at `terminal-manager.js:177, 247, 489` with `tmuxSnapshot(sessionId)`. Raise `maxBuffer` from 8 MiB to 16 MiB (`terminal-manager.js:42`).
7. Implement reconnect handshake: server reads `{type:"hello", protocol_version, binary_capable, lastSeq}` as first message after upgrade; if `lastSeq >= session.prunedSeq`, send `{type:"resume", from:lastSeq+1}` then chunks where `seq > lastSeq` then `{type:"replay_complete"}`. Else send `{type:"snapshot", seq:String(session.totalSeq), data:snapshot}` then `{type:"replay_complete"}`.
8. Implement `bufferedAmount` ceiling (C17): before each per-client send, if `client.bufferedAmount > 8 * 1024 * 1024`, call `client.close(4503, "lagging")` and remove from `session.clients`.
9. Implement ping/pong (C11): `setInterval(25_000, ...)` per WSS instance, calling `ws.ping()` on each client; `ws.on('pong', () => isAlive=true)`; if `!isAlive` after 60 s, `ws.terminate()`.
10. Server-side resize coalesce (C8 server half): in WS message handler (`terminal-manager.js:528, 790`), check `if (cols === session.cols && rows === session.rows) return;` before `pty.resize`.
11. Add `ws.on('error', () => {})` to every per-client WebSocket to prevent uncaught error crashes (WS scan §3.5).
12. Feature flag (see §7): wrap the new path behind `process.env.CT_RELIABLE_STREAMING === "1"`; old path runs when flag is absent.

**Estimated LoC:** ~700 (chunk list ~150, per-client cursor ~200, binary frame protocol ~150, hello/resume handler ~100, snapshot helper ~80, ping/pong ~50, eviction ~30).

---

### WP-B — tmux glue (config + snapshot helper + alt-screen detection)

**Owner: 1 implementer agent.**
**Goal:** Eliminate resize-storm physics at the tmux layer, harden config for streaming reliability.

**Files OWNED (write access):**
- `/root/projects/claude-terminal/tmux.conf`

**Files READ-ONLY:**
- `/root/projects/claude-terminal/terminal-manager.js` (for the snapshot helper integration contract)
- `/root/projects/claude-terminal/CLAUDE.md`
- `/etc/nginx/sites-available/claude-terminal` (informational; verify no proxy_buffering changes needed)

**Concrete deliverables:**
1. Apply tmux.conf delta:
   ```
   # Geometry — kill resize storms (load-bearing for P5)
   set -g window-size manual
   set -g default-size "200x50"
   setw -g aggressive-resize off

   # Terminal capability — enable atomic redraws
   set -g default-terminal "tmux-256color"
   set -ga terminal-overrides ",*256col*:Tc"
   set -ga terminal-features ",*256col*:RGB,clipboard,focus,sync"

   # Reliability hardening
   set -g focus-events on
   setw -g automatic-rename off
   setw -g monitor-bell off
   set -g set-clipboard off
   ```
2. Verify and document existing-but-keep settings: `escape-time 0`, `history-limit 50000`, `mouse off`, `status off`, `allow-rename off`, `remain-on-exit off`, `prefix C-]`.
3. Update CLAUDE.md (read-only here — coordinate with WP-A) to reflect new geometry semantics: "Server tmux runs at fixed 200×50; browser xterm.js letterboxes locally."
4. Document: existing tmux sessions need detach+reattach to pick up `focus-events` and `terminal-features` changes; first deploy is half-effective for those (acceptable, no special handling required).

**Estimated LoC:** ~15 (config-only, plus comments).

---

### WP-C — Browser client (xterm.js, FitAddon debounce, binary protocol, hello/resume)

**Owner: 1 implementer agent.**
**Goal:** Switch client to binary frames, add seq tracking, install hello/resume protocol, switch `clear` to `reset`, debounce FitAddon, chain snapshot write.

**Files OWNED (write access):**
- `/root/projects/claude-terminal/src/components/Terminal.tsx`
- `/root/projects/claude-terminal/src/components/EphemeralTerminal.tsx`
- `/root/projects/claude-terminal/src/lib/TerminalScrollContext.tsx` (only if needed for scroll-restore on `replay_complete` — verify)

**Files READ-ONLY:**
- `/root/projects/claude-terminal/server.js` (for protocol contract)
- `/root/projects/claude-terminal/terminal-manager.js` (same)
- `/root/projects/claude-terminal/src/components/presence/CursorOverlay.tsx` (informational — uses scroll context, must not regress)

**Concrete deliverables:**
1. Set `ws.binaryType = "arraybuffer"` after constructing the WebSocket (`Terminal.tsx:145-146`, `EphemeralTerminal.tsx`).
2. Add `lastSeqRef = useRef<bigint>(0n)` to `Terminal.tsx`; persist to `sessionStorage` keyed by `sessionId` (so same-tab reconnect across page reload works).
3. In `ws.onopen` (`Terminal.tsx:148-167`), send `{type:"hello", protocol_version: 2, binary_capable: true, lastSeq: lastSeqRef.current.toString()}` BEFORE the existing `{type:"resize"}` send.
4. Replace `term.clear()` with `term.reset()` in the `if (isReconnectRef.current)` branch (`Terminal.tsx:155`) — but only if the server replies with `{type:"snapshot"}` (delete previous-tab state when starting fresh) OR if `isReconnectRef.current` AND `lastSeqRef.current === 0n` (never seen seq before).
5. In `ws.onmessage` (`Terminal.tsx:169-195`):
   - Branch on `event.data instanceof ArrayBuffer`:
     - Read opcode (byte 0), seq (big-endian uint64 bytes 1-8), payload (bytes 9+).
     - For OPCODE_OUTPUT (0x01): `lastSeqRef.current = seq`; `term.write(new Uint8Array(event.data, 9))`.
     - For OPCODE_SNAPSHOT (0x02): same as JSON `snapshot` handler below.
   - Else `JSON.parse(event.data)` and switch on `msg.type`:
     - `output` (text fallback): update lastSeq from `BigInt(msg.seq)`; `term.write(msg.data)`.
     - `snapshot`: `term.reset()` then `term.write(msg.data, callback)` — callback updates `lastSeqRef.current = BigInt(msg.seq)`.
     - `resume`: no-op (informational only).
     - `replay_complete`: `fitAddon.fit()`; `term.scrollToBottom()`; `setReconnecting(false)`.
     - `exit`/`stopped`/`error`: existing handlers preserved.
6. `EphemeralTerminal.tsx`: same binary-frame parsing path (no reconnect needed; ephemeral never reconnects per current design).
7. Replace the `ResizeObserver` callback (`Terminal.tsx:362-380`, `EphemeralTerminal.tsx:69-71`) with debounced version: clear+set `setTimeout(..., 80)` in a ref; the timed callback runs `fitAddon.fit()` + sends `{type:"resize"}` only if `term.cols/rows` actually changed since the last sent value.
8. Remove the JSON-parse-fallback path (`Terminal.tsx:191-194`, `EphemeralTerminal.tsx:55-58`) that writes raw `event.data` to `term.write` — replace with a console.warn (P11 closure).
9. Keep `dataDisposableRef` rebind pattern on reconnect (`Terminal.tsx:212-221`) — verify it survives the new protocol.
10. Handle `ws.binaryType` correctly in the reconnect cleanup (`Terminal.tsx:108-117`): the old socket's `onmessage = null` pattern must still work; verify no leak.

**Estimated LoC:** ~250 (binary frame parser ~80, hello/resume protocol ~50, debounce ~30, reset/replay_complete ~40, EphemeralTerminal mirror ~40, removal of raw-write fallback ~10).

---

### Conflict-free guarantee

| File | WP-A | WP-B | WP-C |
|---|---|---|---|
| `server.js` | OWN | — | RO |
| `terminal-manager.js` | OWN | RO | RO |
| `tmux.conf` | — | OWN | — |
| `Terminal.tsx` | RO | — | OWN |
| `EphemeralTerminal.tsx` | RO | — | OWN |
| `TerminalScrollContext.tsx` | — | — | OWN |
| `CLAUDE.md` | OWN (one line) | — | — |
| `presence-manager.js` | DO NOT TOUCH | — | — |
| `chat-manager.js` | DO NOT TOUCH | — | — |
| `symphony-orchestrator.js` | DO NOT TOUCH | — | — |
| `deploy.sh`, `ecosystem.config.js`, `package.json` | DO NOT TOUCH | DO NOT TOUCH | DO NOT TOUCH |

No two partitions write the same file. CLAUDE.md is touched only by WP-A (single line about replay buffer behaviour).

---

## 7. Feature-flag gating

**Server-side env var: `CT_RELIABLE_STREAMING`.**

| Value | Behaviour |
|---|---|
| unset / `0` | Old code path: `session.buffer` string accumulator, `slice(-2_000_000)` trim, JSON-only output frames, synchronous broadcast loop, no ping/pong, no hello/resume, no eviction. (Current behaviour.) |
| `1` | New code path: chunk list, per-client cursor, binary frames for clients that advertise `binary_capable`, hello/resume, ping/pong, eviction at 8 MiB. (Bundle Robust-Lite.) |

Set via `ecosystem.config.js` per-color env (blue and green can carry different values during canary). Hot rollback by editing `ecosystem.config.js` and `pm2 reload`.

**Per-session escape hatch (DEV only):** the server reads the `?reliable=0` query param on the WS upgrade for the terminal endpoint; if present AND `process.env.NODE_ENV !== "production"`, that session uses the old code path regardless of the env var. This is for emergency reproduction of the OLD bug class against a new build. Never exposed in production UI.

**Client-side:** the client always sends `{type:"hello", binary_capable: true, lastSeq: ...}`. The server interprets the `hello` only if `CT_RELIABLE_STREAMING === "1"`; else it's silently ignored and the client falls back to the existing JSON-only path (because old client code paths would receive whatever the server sends). To make this safe: the new client treats absence of `{type:"resume"}` and `{type:"replay_complete"}` as "server is on old protocol" and falls back to its old `term.clear()` + accept-everything-as-output behaviour. **The new client MUST be backward-compatible with the old server.**

**Roll-out plan (recommended):**
1. Deploy WP-A + WP-B + WP-C together with `CT_RELIABLE_STREAMING=0` everywhere. Verify nothing regresses (old code path still runs).
2. Enable on green only (`CT_RELIABLE_STREAMING=1` for green in `ecosystem.config.js`). Run `bash deploy.sh` to flip nginx. Observe for 24 h.
3. Enable on blue too. Now both colors run new code; deploys swap between two reliable-mode instances.
4. After 1 week of stability, remove the flag and the old code path entirely (Phase 7+ housekeeping ticket).

**Per-stage observability gates.** Each rollout stage has an explicit go/no-go criterion:

| Stage | Gate metric | Pass threshold | Source |
|---|---|---|---|
| 1 → 2 | All existing acceptance tests (manual repro of `tail -f`, `vim`, multi-tab) | No regressions vs. baseline | Manual |
| 2 → 3 | Reconnect time p99 (`onclose` to `replay_complete`) | ≤ 500 ms over 100 reconnects | Browser perf marks |
| 2 → 3 | Snapshot/resume balance | ≥ 80% reconnects use FAST_PATH (within rolling window) | Server log counter |
| 2 → 3 | Eviction rate | < 0.5% of clients evicted per hour | Server log counter |
| 2 → 3 | Ping/pong stability | < 1% false-positive `ws.terminate()` per 24 h | Server log counter |
| 3 → 4 | S1-S9 acceptance criteria all pass on production traffic | All green | Per §4 |

If any gate fails, set the env var back to `0` for that color, `pm2 reload`, investigate, redeploy when fixed. The gate definitions are also Phase-7 implementer guidance: instrument the named counters as part of WP-A.

**Mid-deploy version mismatch handling.** During the brief window where blue is on `=1` and green is still on `=0` (or vice-versa), some sessions may have clients that connected to the new server, then reconnect to the old server (because nginx flipped upstream). Behaviour:
- New client sends `{type:"hello", lastSeq:N}` to old server.
- Old server's WS upgrade handler does NOT recognise `hello` (it expects only `input/resize/image`); silently dropped by the existing try/catch (`terminal-manager.js:516`).
- Old server proceeds to send the legacy single-frame `{type:"output", data: session.buffer}` replay (`:507`).
- New client's `onmessage` receives `{type:"output", data, NO seq field}`. Since `msg.seq` is undefined, the new client just calls `term.write(msg.data)` without updating `lastSeqRef`.
- Net effect: client sees old-protocol replay (potentially the broken slice), but no crash, no protocol error. Acceptable degradation during the deploy window.

The reverse direction (old client → new server) is also safe:
- Old client connects and sends `{type:"resize", ...}` as its first message.
- New server's `AWAIT_HELLO` state expects `hello`; if the first message is not `hello`, fall back to legacy behaviour (existing `attachToSession` flow, send full `session.buffer` as one frame, register old broadcast loop). Effectively, treat absence of `hello` as `binary_capable:false, lastSeq:0`.
- Net effect: old clients keep working unchanged; the WP-A implementer must explicitly handle this fallback.

---

## 8. Open risks (accepted as residual after fix)

These are known fragilities we accept post-fix, justified by cost/benefit.

1. **Single-pane assumption.** Robust-Lite assumes one tmux pane per session. If/when the project adopts multi-pane UI in the browser, the snapshot path needs per-pane iteration and the chunk list needs a paneId dimension. Mitigation: documented in this file; reopened as new ticket if multi-pane becomes a goal.
2. **Octal-escape NOT supported.** Because we stay on raw attach (rejected C4), `%output` parsing semantics are not available; structured pane events (`%layout-change`, `%window-renamed`) are not surfaced. Acceptable: no current consumer.
3. **Non-UTF-8 application output is lossy.** `node-pty` is in UTF-8 string mode by default; an app that emits raw bytes outside UTF-8 will be transformed by `StringDecoder` (replacement chars). Acceptable for Claude CLI, codex, etc.; documented for future binary apps.
4. **Cross-instance seq epochs.** When blue/green flip happens and a client's `lastSeq` is from the old instance, the new instance has a different seq epoch (it bootstraps from `tmux capture-pane` with `session.totalSeq = 0`). The server detects this (its `session.prunedSeq = 0` and `lastSeq > 0`) and falls back to snapshot — correct, but the client's stored `lastSeq` is invalidated. Acceptable: the snapshot path closes the visual gap; only "byte-level continuity" is lost across the deploy boundary.
5. **`SerializeAddon` not adopted.** Same-tab reconnect still waits for server snapshot (~50-200 ms RTT + ~10-50 ms capture-pane). Perceived latency on cellular reconnect is therefore network-bound, not zero. Mitigation: defer C14 until measurement justifies; can be added behind a flag without changing protocol.
6. **`pause-after` not adopted.** Slow clients can still cause server-side queue buildup up to `bufferedAmount > 8 MiB` ceiling before eviction kicks in; a single chunky chunk near 8 MiB followed by another chunky chunk could push the queue past the limit briefly. Acceptable: 8 MiB is generous; eviction is graceful via seq-resume.
7. **`replay_complete` frame is best-effort barrier, not idempotent ack.** If the client receives `replay_complete` but its local `fitAddon.fit()` throws, the server doesn't know. Acceptable: client-side error here only affects layout, not data integrity (data is still going through the seq-tracked path).
8. **First `pty.resize` after a `window-size manual` config still triggers tmux redraw burst.** Even with the new config, if a client connects with a different size than `default-size 200x50`, tmux still re-renders the pane once. Acceptable: this is a one-shot at attach time, not a storm.
9. **xterm.js DOM renderer (no WebGL/Canvas addon) remains the default.** Under sustained 5 MB/s output, the client's `WriteBuffer` may grow large and rendering may lag the WS. Acceptable: out of scope for streaming reliability; addressable independently by adding `@xterm/addon-webgl`.
10. **`ALT_SCREEN_RE` per-chunk regex hazard remains.** A chunk ending in `\x1b[?104` followed by a chunk starting with `9h` will not be stripped (the regex doesn't span chunks). Acceptable: rare (tmux emits the sequence atomically); documented but not fixed in this work-package.

---

## 9. Out of scope (explicitly deferred)

We considered and deliberately deferred these. None block S1-S9 acceptance.

1. **`-CC` control mode migration (C4).** Multi-pane UI ambitions, octal-escape parser, send-keys input layer, layout sync — months of work, no current user-facing benefit beyond what Robust-Lite delivers.
2. **Cross-instance state persistence (C13, Redis/SQLite snapshot).** tmux survives blue/green; capture-pane is the cross-instance source of truth; persistence adds operational surface without proportional benefit on a single-VPS deployment.
3. **`SerializeAddon` client-side cache (C14).** Experimental, edge-case rough; perceived-latency win is small once snapshot path is sub-500 ms; defer until measurement justifies.
4. **Server-side throttled batcher (C16).** Defer until measurement shows JSON.stringify or socket-write CPU is a bottleneck; with binary frames (C9), much of the JSON cost goes away.
5. **PAUSE/RESUME app-level backpressure (C2).** Eviction (C17) plus seq-resume (C10) gives a cleaner story; PAUSE/RESUME would re-introduce stuck-stdout risk for non-interactive scripts.
6. **`pipe-pane` redundant byte tap (C20).** Conflicts with blue/green overlap; provides no benefit beyond capture-pane.
7. **`-CC` side-band gateway (C22) and `pause-after` (C18).** Both require C4.
8. **Mosh SSP full state-model rewrite (C19).** Alternative architecture; not "fix the existing system."
9. **xterm.js renderer upgrade (`@xterm/addon-webgl` or `@xterm/addon-canvas`).** Real client-side performance win on heavy output, but orthogonal to streaming reliability; separate ticket.
10. **Token caching to suppress `/api/auth/ws-token` storms (criterion S10).** The 30 s expiry plus client retries cause auth-endpoint spam during reconnect storms (WS scan §0.2). Easy to add (cache the token for 25 s in client memory) but adjacent to streaming reliability.
11. **`4401`/`4404` close codes referenced but never emitted.** `Terminal.tsx:201` checks for these but the server never sends them; auth failures retry forever silently (WS scan §10.3). Out of scope for streaming reliability; flag for separate auth ticket.
12. **Symphony WS path mismatch.** `SymphonyContext.tsx:256` connects to `/api/symphony-ws` but server only handles `/api/symphony-events` (WS scan H7). Out of scope.
13. **Documentation drift in `CLAUDE.md:28`.** Says "500 KB circular" but actual cap is 2 MB. WP-A fixes this single line as housekeeping.
14. **EphemeralTerminal lacks reconnect logic.** `EphemeralTerminal.tsx` has no `onclose` reconnect; ephemeral sessions are short-lived (5 min auto-destroy at `terminal-manager.js:732-734`) so this is acceptable — but every fix in WP-C explicitly inherits to ephemeral where feasible (binary frame parsing, debounce). Out of scope: adding full reconnect to ephemeral.
15. **Per-client xterm.js renderer choice.** Mobile may want Canvas, desktop may want WebGL — out of scope.
16. **`perMessageDeflate` WS compression.** The 2 MB snapshot is the one place compression would save bandwidth (~70%); but binary frames already save ~30%, and compression adds CPU on every frame. Defer until measurement justifies.
17. **`visualViewport` listener for mobile keyboard.** ResizeObserver + debounce handles most cases; fine-tuning for mobile keyboard quirks is part of the upcoming mobile-first workstream, not this ticket.
18. **Interactive cursor visibility / mouse mode preservation across reconnect snapshot.** `capture-pane` doesn't emit cursor visibility / mouse mode sequences (03-tmux §4.4); for full-screen apps the user may see brief artifacts until the app re-emits. Acceptable for Claude CLI (always re-emits on prompt cycle).

---

## 10. Final notes for Phase 6 / Phase 7

- Phase 6 should produce a file-by-file plan that takes WP-A, WP-B, WP-C as the partition and expands each `Concrete deliverable` numbered item into specific code edits (line ranges, function signatures, test cases). The partition guarantees no two implementers conflict at the file level.
- The feature flag (`CT_RELIABLE_STREAMING`) is a hard requirement of the implementation — Phase 7 implementers must NOT deliver code that runs the new path unconditionally. Both code paths must coexist in the same binary for one rollout cycle.
- Acceptance criteria S1-S9 are the gate; S10 is "nice to have" for the same PR but is out-of-scope adjacent (auth/token caching).
- If during implementation a partition needs to read into another's owned file beyond the read-only contract documented above, the implementer must surface that as a coordination request — DO NOT silently expand the partition.
- The "Open risks" section is the contract about residual fragility post-merge — anything not in this list and not in "Out of scope" is a regression and must be fixed before merge.

### 10.1 Wire protocol summary (single source of truth for Phase 6)

#### Server → Client frames

**Binary frames (when `binary_capable:true`):**

```
┌────────────┬─────────────────────────┬──────────────────────────────────────┐
│ opcode (1) │ seq (8 bytes big-endian)│ payload (UTF-8 bytes, variable)      │
└────────────┴─────────────────────────┴──────────────────────────────────────┘
  0x01 = OPCODE_OUTPUT     — live PTY chunk
  0x02 = OPCODE_SNAPSHOT   — initial snapshot (slow-path replay)
  0x03..0x0F reserved      — reject if received (Phase 6 implementer: log warn)
```

**Text frames (always JSON):**

| Type | Payload shape | Direction | When |
|---|---|---|---|
| `hello` | `{type, protocol_version:2, binary_capable:bool, lastSeq:string}` | C→S | First message after `ws.onopen`. |
| `resume` | `{type, from:string}` | S→C | Server replying that fast-path resume is starting at `seq=from`. Informational; client validates against its own `lastSeq+1`. |
| `snapshot` | `{type, seq:string, data:string}` (text fallback only — binary uses opcode 0x02) | S→C | Slow-path replay for clients beyond the rolling window or fresh tabs. |
| `replay_complete` | `{type}` | S→C | Always sent after the last replay/snapshot byte; client uses to fit/scroll/hide reconnecting indicator. |
| `output` | `{type, seq:string, data:string}` (text fallback only — binary uses opcode 0x01) | S→C | Live chunk for clients that did NOT advertise `binary_capable`. |
| `exit` | `{type, exitCode:number, signal:number}` | S→C | (existing — preserved as-is) |
| `stopped` | `{type}` | S→C | (existing — preserved as-is) |
| `error` | `{type, message:string}` | S→C | (existing — preserved as-is) |
| `input` | `{type, data:string}` | C→S | (existing — preserved as-is) |
| `resize` | `{type, cols:number, rows:number}` | C→S | (existing — preserved with server-side equality coalesce) |
| `image` | `{type, data:string (base64)}` | C→S | (existing — preserved as-is) |

#### Close codes (server-initiated)

| Code | Meaning | When |
|---|---|---|
| `1000` (Normal) | Existing — used in `client.close()` after error broadcasts |
| `4503` (NEW) | "Lagging" — `bufferedAmount` exceeded ceiling | Client should reconnect with current `lastSeq` |

The 4401/4404 codes referenced in `Terminal.tsx:201` are NOT emitted today and are NOT introduced by this work; `1006` (abnormal closure) remains the actual code for auth failures (out-of-scope adjacent).

### 10.2 Memory budget post-fix

Per session, in steady state:

| Component | Bound |
|---|---|
| `session.chunks` | ≤ 2 MiB total `data.length` (chunk granularity prune) |
| `session.clients` Map | O(N) for N attached clients × ~200 B per record |
| Per-client queue | ≤ 8 MiB `bufferedAmount` (eviction ceiling) |
| Per-client `lastSentSeq` (BigInt) | ~16 B |
| tmux scrollback (in tmux process, not node) | history-limit × cols × ~16 B |

Total per session: **2 MiB + 8 MiB × N_clients** in node memory.

For typical use (1-3 clients per session, 5-10 active sessions), that is ~50-100 MiB worst case under sustained load. Well within VPS budget.

### 10.3 What Phase 7 implementers should NOT do

- **DO NOT** introduce a third broadcast pattern. WP-A's per-client async drain is the canonical fan-out; do not add ad-hoc `for (client of session.clients) client.send(...)` loops elsewhere (e.g. for `stopped`, `exit` notices). All server→client emission must go through the same drain so `bufferedAmount` and `binaryCapable` are honoured uniformly.
- **DO NOT** persist `session.totalSeq` to disk. The blue/green flip uses snapshot-on-reconnect; per-instance seq epochs are intentional.
- **DO NOT** add tmux commands that would only work on `-CC` (`refresh-client -C`, `send-keys -l`). We are explicitly on raw attach.
- **DO NOT** convert ephemeral terminal to use the new chunk-list path unless it ALSO gets reconnect logic. Today ephemeral has no reconnect (`EphemeralTerminal.tsx:47-79`); the chunk-list adds memory cost without benefit. Keep ephemeral on the existing string buffer path; it dies after 5 min anyway (`terminal-manager.js:732-734`).
- **DO NOT** silently drop unknown WS message types. The current try/catch swallows everything (`terminal-manager.js:516`); add explicit `default:` branches with `console.warn` so future protocol additions are visible in logs.
- **DO NOT** change the existing token endpoint or auth flow. S10 is adjacent; out of scope.
- **DO NOT** touch `chat-manager.js`, `presence-manager.js`, `symphony-orchestrator.js`. These run on separate WSS instances and have their own broadcast patterns; cross-contamination would expand the blast radius beyond the terminal channel.

### 10.4 Test strategy

Each work-package has a corresponding test layer. Phase 6 detail; Phase 7 implementation.

- **WP-A unit tests:** mock `node-pty.onData`, push 10 MB of synthetic chunks; verify `session.chunks` total ≤ 2 MiB, `prunedSeq` advances correctly, eviction at chunk granularity (no chunk ever sliced). Mock client with controllable `bufferedAmount`; verify eviction at 8 MiB. Mock reconnect with various `lastSeq` values (0, mid-buffer, beyond-buffer); verify FAST_PATH vs SLOW_PATH routing.
- **WP-B integration tests:** run `tmux capture-pane` against a sandbox session with both normal and alt-screen content; verify CRLF normalisation and cursor-position appended correctly. Run resize-storm script; verify tmux pane never resizes.
- **WP-C component tests:** mock a WS server that sends binary frames + JSON control; verify client's `onmessage` correctly dispatches by `event.data instanceof ArrayBuffer`. Mock `term.reset()` then `term.write(snapshot, callback)`; verify `replay_complete` handler runs after parser drain.
- **End-to-end (manual):** S1-S9 acceptance criteria, executed against a live deployed instance per stage gate.

### 10.5 Rollback runbook (for ops)

If the new path causes regressions in production:

1. **Immediate rollback (< 30 s):** edit `ecosystem.config.js`, set `CT_RELIABLE_STREAMING=0` for both colors, `pm2 reload claude-terminal-blue claude-terminal-green`. New WS connections immediately use legacy path; existing connections finish out on the new path until they close naturally.
2. **Investigation:** check server logs for `eviction` counters, ping/pong false-positives, snapshot fork failures. Check browser console for `WARN: unknown message type` (indicates protocol drift) or `WARN: lastSeq mismatch` (indicates seq-epoch miscoordination).
3. **Code-level rollback (if env-var rollback insufficient):** `git revert` the WP-A / WP-C commits independently (they are separable). WP-B (tmux.conf) requires existing tmux sessions to detach+reattach to pick up the revert; document in the runbook to expect a one-deploy lag for some users.

End of `05-decision-tmux.md`.
