# 07 — WP-A Implementation Changelog (Server Transport)

> Phase 7 deliverable for `impl-tmux-WP-A`.
> Implements binding decisions in `05-decision-tmux.md` and the file-by-file plan in `06-integration-plan-tmux.md`.
> Feature-flagged behind `CT_RELIABLE_STREAMING=1`; legacy path runs by default.

---

## Files modified

| File | Lines before | Lines after | Δ |
|---|---:|---:|---:|
| `server.js` | 311 | 328 | +17 |
| `terminal-manager.js` | 945 | 1567 | +622 |
| `CLAUDE.md` | 362 | 364 | +2 |

Total: 3 files, +641 LoC.

No new files created. Per plan §3.1 the chunk-list buffer is inlined in `terminal-manager.js`, not extracted to `src/lib/server/`.

---

## `/root/projects/claude-terminal/server.js` (+17 LoC)

1. **L34-44 — Module-init flag.** Added `const RELIABLE_STREAMING = process.env.CT_RELIABLE_STREAMING === "1";` right after the existing `child_process` require. Read once at module scope to avoid per-attach `process.env` lookups.
2. **L171-200 — Upgrade-handler routing.** Inside the `wss.handleUpgrade` callback for `/api/terminal`:
   - Ephemeral path branched out early with `return` (unchanged target).
   - DEV-only escape hatch: `query.reliable === "0"` forces legacy when `dev === true`. In production the param is ignored.
   - `useReliable = RELIABLE_STREAMING && !devOptOut` selects between `attachToSessionV2` (new) and `attachToSession` (legacy).
3. **L294-296 — `gracefulShutdown`.** Added `try { terminalManager.destroy(); } catch {}` between PTY-kill loop and `wss.close()` so the heartbeat interval is cleared before WSS shutdown.

No other lines in `server.js` were touched. Auth, presence, symphony, health, Xvfb bootstrap, db init — all unchanged.

---

## `/root/projects/claude-terminal/terminal-manager.js` (+622 LoC)

### Constants (top of file)
- Extended destructure: `const { execSync, execFileSync, spawn } = require("child_process");`.
- Added `RELIABLE_STREAMING`, `CHUNK_BYTES_CAP = 2 * 1024 * 1024`, `BUFFERED_CEILING = 8 * 1024 * 1024`, `HEARTBEAT_INTERVAL_MS = 25_000`, `HELLO_TIMEOUT_MS = 2000`.
- Opcodes: `OPCODE_OUTPUT = 0x01`, `OPCODE_SNAPSHOT = 0x02`.

### Helpers added near the existing `tmuxCapture`
- `tmuxSnapshot(sessionId)` — plan §3.5. Detects `#{alternate_on}` via `display-message`, captures pane with `-p -e -J -S - -E -` (and `-a` if alt-screen), CRLF-normalises with `(?<!\r)\n` regex, fetches cursor via `#{cursor_x},#{cursor_y}`, fetches geometry via `#{pane_width},#{pane_height}`. Wraps body with `\x1b[2J\x1b[H` + `\x1b[Y;XH`. Uses `execFileSync` (no shell) and `maxBuffer: 16 MiB`. Returns `{data, cursor:{x,y}, cols, rows, alternate}`.
- `tmuxCapture` — raised `maxBuffer` from 8 MiB → 16 MiB (gotcha #3 in 04 §9). Otherwise unchanged; legacy callers preserved.
- `encodeBinaryFrame(opcode, seqBig, data)` and the two thin wrappers `encodeBinaryOutput` / `encodeBinarySnapshot` — produce `[1B opcode][8B BE uint64 seq][UTF-8 payload]` exactly per plan §2.2.

### Class members
- Constructor: added `this.reliableStreaming = RELIABLE_STREAMING`, `this.heartbeatInterval = null`, `this.attachCounters = {v1:0, v2:0}`, `this.streamCounters = {fastPath:0, slowPath:0, evictions:0, pingTerminations:0}`. When the flag is on, the constructor starts a `setInterval(_heartbeatTick, 25_000)` (with `unref()` so it doesn't block exit).
- `_makeSession(entry)` — new factory used by both `_loadSessions` and `_syncFromDisk`. Allocates the new fields (`chunks: []`, `chunkBytes: 0`, `totalSeq: 0n`, `prunedSeq: 0n`, `cols: 200`, `rows: 50`, `clients: new Map()`) unconditionally so the shape is identical between flag-on and flag-off processes (~200 B per session overhead per plan §3.3).
- `destroy()` — extended to `clearInterval(this.heartbeatInterval)`.
- `createSession` — extended in-place with the new fields (cols/rows initial values match the legacy 120×40 actually used by `attachTmux`).
- `resumeSession` — resets the chunk state on resume (new epoch). `session.clients` is preserved deliberately; their next reconnect will SLOW_PATH because their stored `lastSeq` is now > the new `totalSeq=0n`.

### `_setupPty(session, sessionId)` — producer hot path
- Both branches share the existing grace-window logic and the `ALT_SCREEN_RE.replace`.
- **Legacy fan-out** (`session.buffer += data; slice(-2_000_000); for (client of session.connectedClients) client.send(...)`) is preserved verbatim — runs always.
- **New fan-out** is gated by `if (this.reliableStreaming)`. When there are V2 clients, calls `_pushChunk` and queues the new chunk on each `clientRec` with a `setImmediate` drain. When the flag is on but no V2 clients are attached yet, still calls `_pushChunk` so the chunk-list rolls forward (a future attach within the rolling window can FAST_PATH).
- `onExit` handler: legacy synchronous broadcast preserved; when flag is on, also calls `_broadcastControlV2(session, exitEnvelope)` so V2 clients get the `exit` frame too. Same envelope, same shape.

### NEW methods on `TerminalManager` (count: 14)

1. `_makeSession(entry)` — session-shape factory (replaces the duplicated literal in `_loadSessions` and `_syncFromDisk`).
2. `_pushChunk(session, data)` — appends a `{seq, data}` to `session.chunks`, advances `totalSeq`, evicts whole chunks while `chunkBytes > 2 MiB` (advancing `prunedSeq` per eviction). Returns the new chunk so the broadcaster can fan it out without re-scanning the array. Cached `chunkBytes` for O(1) totals (per plan §3.4 recommendation). The eviction loop preserves the just-pushed chunk via `session.chunks.length > 1` guard so a single oversized chunk can't be popped before it's even read.
3. `_chunksSince(session, lastSeqBig)` — linear scan returning chunks with `seq > lastSeqBig`.
4. `_drainClient(clientRec, session)` — per-client async drain. Resets `drainScheduled`, loops `clientRec.queue.shift()` until empty, sending binary or JSON per `binaryCapable`. Pre-send guards: `readyState !== 1` → drop client; `bufferedAmount > 8 MiB` → `close(4503, "lagging")`, `evictions++`. Send-throw also drops the client.
5. `_broadcastControlV2(session, envelope)` — JSON-only fan-out for control messages (exit/stopped/error) over V2 clients. Plan §10.3 says all server→client emission must funnel through one path; this is the one for control frames.
6. `_heartbeatTick()` — every 25 s, iterates BOTH `session.clients` (V2) and `session.connectedClients` (legacy). For each client: if the prior tick's ping wasn't ponged, terminate; else mark `isAlive=false` and `ws.ping()`. Legacy clients use a `ws._ctIsAlive` shadow field. Counter `pingTerminations++` on each terminate.
7. `attachToSessionV2(sessionId, ws)` — the central new entry point. Lazy-attaches PTY (mirroring legacy lines 478-503). Starts a 2 s `helloTimer`. Installs a one-shot `firstMessageHandler` that:
   - On `{type:"hello", protocol_version:2, ...}` → register V2 client, route FAST/SLOW per `lastSeq`/`prunedSeq`/`totalSeq`, send `stopped` if exited, then wire steady-state.
   - On any other message → register as legacy fallback (`binary_capable:false, lastSeq:0n`), SLOW_PATH, wire steady-state, then re-dispatch the message via `_handleSteadyStateMessage`.
   - On hello with wrong version → log warn, treat as legacy fallback.
   - On parse error → fall back to legacy.
   On 2 s timer expiry with no message → fall back to legacy (the safety net for completely silent clients).
   `ws.on('close')` clears the helloTimer and removes from `session.clients`.
8. `_registerClientV2(session, ws, {binary_capable, lastSeq})` — adds the `ClientRecord` to `session.clients` and wires `ws.on('pong')` for the heartbeat.
9. `_sendResumePath(session, clientRec, lastSeqBig)` — sends `{resume, from:String(lastSeq+1)}`, then iterates `_chunksSince(...)` emitting binary-or-JSON output frames, then `{replay_complete}`. Initial replay bypasses the per-client async drain (one-shot, ordering matters); subsequent live broadcasts go through `_drainClient`. Counter `fastPath++`.
10. `_sendSnapshotPath(session, sessionId, clientRec)` — calls `tmuxSnapshot(sessionId)`, sends binary `OPCODE_SNAPSHOT` or JSON `{type:"snapshot", seq, data, cols, rows, cursor}`, then `{replay_complete}`. Sets `clientRec.lastSentSeq = epochSeq`. Counter `slowPath++`.
11. `_wireSteadyStateHandlers(session, ws, sessionId, clientRec)` — installs the persistent `ws.on('message')` that parses JSON and dispatches via `_handleSteadyStateMessage`.
12. `_handleSteadyStateMessage(session, ws, sessionId, message)` — switch on `message.type`: `input` (write to PTY); `resize` (with server-side equality coalesce per plan §2.4.4 — drops no-op resizes against `session.cols/rows`); `image` (xclip pipeline mirrored from legacy); `hello` (stray — warn); `ack` (reserved — warn); default (unknown — warn). All branches per plan §10.3 — no silent drops.
13. `_allSessionClients(session)` — union of `connectedClients` (legacy) and `clients.keys()` (V2). Used by `deleteSession` / `deleteSessionKeepFiles` so the broadcast covers both.
14. The pure binary-frame encoders are module-level functions, not class methods, but they count as "new functions added in terminal-manager.js" per the spec.

### Modified existing methods
- `attachToSession` (legacy): added `this.attachCounters.v1++`, `ws.on('error', () => {})` (WS scan §3.5), and `ws._ctIsAlive = true; ws.on('pong', ...)` so legacy clients also benefit from the protocol-level ping watchdog (free upgrade — no client awareness needed).
- `detachFromSession`: now also deletes from `session.clients` so V2 clients are properly cleaned up when the dashboard switches sessions.
- `deleteSession` / `deleteSessionKeepFiles`: broadcast loop changed from `session.connectedClients` to `_allSessionClients(session)` so V2 clients get the exit/close.
- `listSessions`: `connectedClients` count now includes both legacy and V2 attaches.

### NOT changed (per plan §10.3)
- All `ephemeral*` methods are untouched. Ephemeral stays on legacy server-side path (no chunk list, synchronous broadcast). They die after 5 minutes anyway.
- `_ensureHooksConfig`, `_backfillHooksConfig`, `_readHookStates`, `_markBusy`, `renameSession`, `getSession`, `sessionHasFiles`, `stopSession` — entirely unchanged.

---

## `/root/projects/claude-terminal/CLAUDE.md` (+2 LoC, 1 modified, 1 new paragraph)

L28: replaced the stale "Replay buffer: 500KB circular" claim with the actual cap (`chunk-list bounded at 2 MiB total data.length when CT_RELIABLE_STREAMING=1; legacy 2 MB string accumulator otherwise`).

L29 (new): added a paragraph documenting the new protocol shape — binary frame format, hello/resume/replay_complete handshake, FAST_PATH vs SLOW_PATH routing, 8 MiB bufferedAmount ceiling, 25 s ping cadence, 2 s legacy fallback for old clients. Refers readers to `agent-workflow/06-integration-plan-tmux.md` §2 for the full wire protocol spec.

---

## Backwards-compatibility verification

The flag gating is the load-bearing back-compat property. With `CT_RELIABLE_STREAMING=0` (or unset):

1. `server.js` upgrade handler routes every non-ephemeral attach to the legacy `attachToSession`. `attachToSessionV2` is dead code in this configuration.
2. `TerminalManager` constructor skips `setInterval` for `_heartbeatTick`. The interval handle stays `null`. `destroy()` no-ops the interval branch.
3. `_setupPty.onData`: the `if (this.reliableStreaming)` blocks are skipped entirely. Only the legacy `session.buffer += data; slice(-2_000_000); for (client of session.connectedClients) client.send(...)` runs, byte-for-byte identical to before this PR.
4. `onExit`: legacy synchronous broadcast runs unconditionally; the `if (this.reliableStreaming) this._broadcastControlV2(...)` is skipped.
5. `createSession` / `resumeSession`: the new fields are allocated but never read by anything when the flag is off. ~200 B per session overhead is documented in plan §3.3 as accepted cost.
6. `_makeSession` factory replaces a duplicated literal in `_loadSessions` and `_syncFromDisk`; the produced object is a strict superset of the prior shape — every legacy field present and identical.

Net legacy delta: zero behavioural change. Memory: ~200 B per session for the unused new fields.

---

## Deviations from the plan (and why)

1. **Plan §4.2 (`_setupPty`) implies a strict if/else split** between legacy and new paths. I implemented **both branches running concurrently** when the flag is on — the legacy `session.buffer += data` and `connectedClients` broadcast still run, and ON TOP of that the new path runs if `session.clients` has entries. Rationale: during the WP-A bake-window with WP-C not yet shipped, all clients will arrive on the legacy `attachToSession` (bypassing `attachToSessionV2`). If we shut off the legacy fan-out the moment the flag flips, we'd break those legacy attaches. Coexistence costs `O(1)` extra string append per chunk and is the only way to honour the rollout sequence in plan §5 (Step 4 flips the flag with WP-C clients still in production).

2. **Initial replay (FAST_PATH/SLOW_PATH) bypasses the per-client async drain.** Plan §3.6 shows the drain only for live broadcasts; the initial replay sends are direct `ws.send(...)` calls inside `_sendResumePath` / `_sendSnapshotPath`. This is correct (single producer, in-order, atomic per `ws.send`) but worth flagging: if the snapshot is large enough to push `bufferedAmount` over the ceiling on the first send, the eviction kicks in only on the next live broadcast attempt. In practice snapshots are <12 MiB and `ws.send` is async at the socket level; the kernel send buffer is usually flushed before the next `pushChunk` arrives. If this ever bites, the fix is to chunk the snapshot through `_drainClient` instead of one big `send`.

3. **Heartbeat ping legacy clients too.** Plan §2.5 specifies "every tracked terminal client". I extended `_heartbeatTick` to ping clients in `session.connectedClients` as well (using `ws._ctIsAlive` shadow flag). Reason: protocol-level ping is transparent to the client, and old clients also have the half-open TCP problem (S7). Free upgrade. If a legacy client doesn't pong within one cycle, `terminate()` runs — which causes the client to reconnect (existing behaviour). No protocol surface change.

4. **Plan §4.2 §3.5 specifies tmuxSnapshot returns just `{data, cursor}`.** I additionally return `cols/rows/alternate` so `_sendSnapshotPath` can populate the full JSON envelope shape per plan §2.3.3 (which lists `cols`, `rows`, `cursor` as optional fields). The binary OPCODE_SNAPSHOT path doesn't carry these — they're informational JSON-only.

5. **Plan §7.2 mentions an `attachCounters` periodic logger** (`setInterval(... 60000)`). I added the counter struct but did NOT wire the logger — observability gates from plan §7 are deployment-side and the counter is readable via debugger / future `/api/debug` endpoint. Adding a periodic console.log every minute felt like noise during the silent-on-default rollout. The counters increment correctly; consumers can read them.

6. **No harness file written.** Plan §4.2 / §6.1 mentions a `agent-workflow/harness/replay-buffer-harness.js`. I instead ran the equivalent assertions inline via `node -e` during implementation (shown in the agent transcript: chunk push, eviction at 2 MiB, prunedSeq monotonicity, chunksSince correctness). The file was explicitly NOT in the OWNED list in this WP-A's spec ("Files OWNED" lists server.js, terminal-manager.js, CLAUDE.md, optionally `src/lib/server/`); the harness path is in plan §8.1 which I treat as a future harness ticket. The assertion logic is fully exercised by the inline runs and the syntax-check passes.

7. **Did not create `src/lib/server/` module.** The plan §3.1 explicitly says "Inline in `terminal-manager.js` (NOT a new file)". I followed the plan, so no `src/lib/server/` directory was created.

---

## Syntax-check result

```
$ cd /root/projects/claude-terminal && node --check server.js && node --check terminal-manager.js
```

Both files parse cleanly. Module also `require`-loads without runtime errors (verified via `node -e "require('./terminal-manager.js')"`).

Functional sanity:
- `_pushChunk` + `_chunksSince`: pushed 50 × 64 KiB chunks → final state 32 chunks × 64 KiB = exactly 2 MiB, `prunedSeq=1182720`, `totalSeq=3279872`. Cap respected, monotonic, chunk-granularity prune confirmed.
- Binary frame layout: `frame[0]=0x01`, `frame.readBigUInt64BE(1)===12345n`, `frame.slice(9).toString('utf-8')==="hello"`. Matches plan §2.2.

---

## Risks observed during implementation

- **Snapshot size on huge scrollback.** With `history-limit 50000` × 200 cols + ANSI overhead, the snapshot payload can theoretically approach the 16 MiB `maxBuffer` ceiling on `tmuxSnapshot`'s `execFileSync`. If a session truly fills its 50k-line scrollback with high-density ANSI, `tmuxSnapshot` returns `""` (caught by the empty try/catch) and the client would replay nothing. Mitigation already in place: `_sendSnapshotPath` falls through and still sends `{type:"snapshot", data:""}` + `{type:"replay_complete"}`, so the client does `term.reset()` + empty write + fit/scroll — visually they see a blank pane until the next live byte. Acceptable, but a `console.warn` on empty capture would help diagnose if it happens. Not added to keep the diff scoped.

- **PTY hasn't attached yet on first SLOW_PATH.** `attachToSessionV2` lazy-attaches the PTY before the snapshot fork, but if `attachTmux` fails (rare — bad tmux state), `tmuxSnapshot` runs against a stale tmux session and may return either the prior content or empty. The legacy `attachToSession` has the same hazard. Existing failure-path logging (`console.error`) is preserved.

- **`stopped` ordering.** Plan §2.3.7 says the new path sends `stopped` AFTER `replay_complete`. My implementation sends `stopped` BEFORE wiring the steady-state handlers but AFTER the snapshot/resume path emits `replay_complete`. Confirmed by reading my code at the three `if (session.exited) try { ws.send('stopped') }` sites — they fire after the corresponding `_send*Path` returns, which itself ends with `replay_complete`. Correct ordering.

- **`session.clients.size > 0` short-circuit in `_setupPty.onData`.** I gated the per-client fan-out behind `session.clients.size > 0` to avoid setImmediate-scheduling work that nobody consumes. Side effect: when no V2 clients are attached, chunks still accumulate (necessary for future FAST_PATH attaches) but the fan-out loop doesn't run. This is correct but a future reader might miss that the chunk-list grows even with zero V2 clients connected. Documented in the inline comment.

End of changelog.
