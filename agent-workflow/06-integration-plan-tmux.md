# 06 — Integration Plan: claude-terminal Robust-Lite Streaming Overhaul

> Phase 6 deliverable for `planner-integration-tmux`.
> Mode: BINDING file-by-file plan. Phase-7 implementer agents execute this verbatim.
> Inputs synthesised: `05-decision-tmux.md` (binding decisions), `02-scan-pty.md`, `02-scan-ws.md`, `02-scan-client.md`, `04-tradeoffs-tmux.md`.
> No source files were modified during planning.

---

## 1. Executive summary

We are converting the claude-terminal streaming pipeline from a fragile string-accumulator + synchronous-broadcast architecture into a chunk-list + per-client-cursor + seq-addressed transport. The user-visible "пакеты теряются / экран ползёт" symptom is currently caused by `terminal-manager.js:294-296` (mid-escape `slice(-2_000_000)`), `terminal-manager.js:298-302` (synchronous broadcast that lets a slow client block the producer), `Terminal.tsx:155` (`term.clear()` that preserves stale parser state), `tmux.conf:33-34` (`window-size latest` + `aggressive-resize on` triggering redraw cascades on every viewport change), and the absence of any seq/ack handshake which makes reconnect-driven duplication structurally impossible to dedupe. The Robust-Lite bundle replaces all five hazards in a single coordinated drop while keeping raw `tmux attach-session` mode (no `-CC` migration), keeping in-memory state only (no Redis/SQLite persistence), and keeping the existing JSON envelope as a fallback for control messages (binary frames are reserved for high-volume `output` and `snapshot` payloads only).

The work is split across three independent partitions: WP-A (server transport — `server.js` + `terminal-manager.js` + `CLAUDE.md` doc fix), WP-B (tmux config — `tmux.conf` only), WP-C (browser client — `Terminal.tsx` + `EphemeralTerminal.tsx`). The partitions are file-disjoint by design — each implementer can land their work on a separate PR without merge conflicts. The order is: WP-B first (config-only, no protocol coupling, can ship immediately as a no-op for any client/server combination), then WP-A behind `CT_RELIABLE_STREAMING=1` env flag (defaults OFF, both code paths coexist in the same binary), then WP-C (auto-detects new server via `hello`/`replay_complete` frames; falls back to legacy behaviour if those frames never arrive). When all three are merged and baked, the env flag is flipped to `1` on green first, then on blue, with explicit go/no-go observability gates between stages (per `05-decision-tmux.md` §7).

The feature flag (`CT_RELIABLE_STREAMING=1`) gates the entire new code path on the server. When unset or `0`, `attachToSession` runs the existing legacy code (string buffer, synchronous broadcast, no hello/resume handshake, no ping/pong, no eviction) — byte-for-byte identical to today's behaviour. When set to `1`, `attachToSession` instead routes to `attachToSessionV2` which uses chunk-list, per-client cursor, binary frames (when client advertises `binary_capable`), seq+ack with `lastSeq` resume, `bufferedAmount` ceiling at 8 MiB, and protocol-level ping/pong every 25 s. The new client (WP-C) ALWAYS sends `{type:"hello", protocol_version:2, binary_capable:true, lastSeq:N}` as its first message — the server interprets it only when the flag is on, so old servers safely ignore it (silently dropped by their existing try/catch at `terminal-manager.js:516`). The new client treats absence of `{type:"replay_complete"}` within 2 s of `ws.onopen` as "server is on legacy path" and falls back to its old `term.clear()` + raw-output behaviour. This contract makes the rollout strictly additive: every interim combination (old-client/old-server, old-client/new-server, new-client/old-server, new-client/new-server) is correct.

---

## 2. New WS protocol spec (frozen)

This section is the binding wire format for Phase 7. Every field, every type, every direction is fixed here. WP-A and WP-C MUST honour this exactly.

### 2.1 Encoding overview

- **Text frames** carry JSON. Always UTF-8. Used for ALL control messages (`hello`, `resume`, `replay_complete`, `snapshot` text-fallback, `output` text-fallback, `exit`, `stopped`, `error`, `input`, `resize`, `image`).
- **Binary frames** carry a 1-byte opcode + 8-byte big-endian seq + UTF-8 payload bytes. Used ONLY for high-volume `output` and `snapshot` payloads. JSON fallback is mandatory for clients that did NOT advertise `binary_capable:true` in their `hello`.
- **Heartbeat** uses the WS protocol-level ping/pong (RFC 6455 §5.5.2/§5.5.3, exposed in npm `ws` as `WebSocket#ping` / `'pong'` event). NOT JSON.

### 2.2 Binary frame format (server → client)

```
┌────────────────┬──────────────────────────────┬───────────────────────────────────┐
│ opcode (1 B)   │ seq (8 B big-endian uint64)  │ payload (UTF-8 bytes, variable)   │
└────────────────┴──────────────────────────────┴───────────────────────────────────┘
```

| Opcode | Name              | Payload semantics                                       |
|--------|-------------------|---------------------------------------------------------|
| `0x01` | `OPCODE_OUTPUT`   | Live PTY chunk. `seq` is the absolute byte address of the FIRST byte of `payload`. `payload.length` bytes are appended to the canonical byte stream. |
| `0x02` | `OPCODE_SNAPSHOT` | Slow-path replay (capture-pane). `seq` is the new epoch — i.e. all subsequent `OPCODE_OUTPUT` frames have `seq > snapshot.seq`. |
| `0x03..0x0F` | reserved   | Phase 7 implementer MUST log `console.warn` and discard. Do NOT throw. |

**seq encoding.** `BigUint64` big-endian. Server-side `Buffer#writeBigUInt64BE`. Client-side `DataView#getBigUint64(1, false)`.

**payload encoding.** UTF-8 bytes (raw). Client-side: `term.write(new Uint8Array(event.data, 9))` — xterm.js v6 accepts `Uint8Array` directly.

**Frame size cap.** No enforced cap below the WS library default (`maxPayload: 100 MiB`). Snapshot is the largest single frame (~2-12 MiB depending on tmux scrollback density). Live `output` chunks are typically <8 KiB.

### 2.3 Text frames (server → client)

Each frame is `JSON.stringify(envelope)`. All fields are mandatory unless marked optional.

#### 2.3.1 `hello` reply (NONE)

The server does NOT send a `hello` back to the client. It immediately responds with EITHER `resume`+chunks+`replay_complete` (FAST_PATH) OR `snapshot`+`replay_complete` (SLOW_PATH). The presence of one of those frames within the post-hello round-trip IS the implicit acknowledgement that the server understood the hello.

#### 2.3.2 `resume` (S→C, informational)

Sent by the server when fast-path resume is starting. The client validates the `from` value matches its own `lastSeq + 1` and then expects a sequence of `OPCODE_OUTPUT` frames where `seq > lastSeq`, terminated by `replay_complete`.

```json
{
  "type": "resume",
  "from": "12345"
}
```

| Field | Type | Notes |
|---|---|---|
| `type` | `"resume"` | Constant. |
| `from` | `string` (decimal-encoded BigInt) | First seq the server will replay. SHOULD equal `lastSeq + 1`. Decimal-encoded because JSON cannot round-trip BigInt. |

**Receiver action.** Client logs (debug) the value; takes no rendering action. Used for divergence detection during development; in production the client just verifies `BigInt(from) === lastSeqRef.current + 1n` and warns on mismatch.

#### 2.3.3 `snapshot` text fallback (S→C)

Sent by the server when slow-path replay is required (client `lastSeq` is below `session.prunedSeq`, or fresh tab) AND the client did NOT advertise `binary_capable:true`. Binary clients receive `OPCODE_SNAPSHOT` instead.

```json
{
  "type": "snapshot",
  "seq": "67890",
  "data": "[2J[H...[10;5H",
  "cols": 200,
  "rows": 50,
  "cursor": { "x": 4, "y": 9 }
}
```

| Field | Type | Notes |
|---|---|---|
| `type` | `"snapshot"` | Constant. |
| `seq` | `string` (decimal-encoded BigInt) | Snapshot epoch. After applying, `lastSeqRef.current = BigInt(seq)`. |
| `data` | `string` | Pre-baked replay: `\x1b[2J\x1b[H` + capture-pane body (CRLF-normalised) + `\x1b[Y;XH` cursor-position. The data string is itself self-contained. |
| `cols` | `number` (uint, optional) | Tmux pane width at capture time. Informational; client SHOULD NOT call `term.resize` based on it (xterm.js letterboxes locally). |
| `rows` | `number` (uint, optional) | Tmux pane height at capture time. Same. |
| `cursor` | `{x:number, y:number}` (optional) | 0-indexed cursor position in pane coordinates. The `data` already encodes `\x1b[Y;XH` so this is for divergence detection only. |

**Receiver action.**
1. Call `term.reset()` (NOT `clear()`) — hard-reset parser state, SGR, alt-screen flag, mode flags.
2. Call `term.write(data, () => { lastSeqRef.current = BigInt(seq); })` — chain via callback so `lastSeqRef` updates only after parser has drained.
3. Wait for `replay_complete` to fire `fitAddon.fit()` and `term.scrollToBottom()`.

#### 2.3.4 `output` text fallback (S→C)

Used ONLY when the client did NOT advertise `binary_capable:true`. Otherwise the server emits `OPCODE_OUTPUT` binary frames.

```json
{
  "type": "output",
  "seq": "12346",
  "data": "Hello [31mworld[0m\r\n"
}
```

| Field | Type | Notes |
|---|---|---|
| `type` | `"output"` | Constant. |
| `seq` | `string` (decimal-encoded BigInt) | Absolute byte address of the FIRST byte of `data`. |
| `data` | `string` | Raw decoded chunk from `pty.onData` after `ALT_SCREEN_RE` strip. UTF-8. |

**Receiver action.** Update `lastSeqRef.current = BigInt(seq)`. Call `term.write(data)` (no callback chain — fire-and-forget per §5 of `05-decision-tmux.md` D-Q7).

#### 2.3.5 `replay_complete` (S→C, mandatory barrier)

Sent EXACTLY ONCE per WS lifetime, immediately after the last replay/snapshot frame. Must be sent for both FAST_PATH and SLOW_PATH. Marks the boundary between "replay" and "live" — the client uses it to fire `fitAddon.fit()`, `term.scrollToBottom()`, and to hide the reconnecting indicator.

```json
{ "type": "replay_complete" }
```

| Field | Type | Notes |
|---|---|---|
| `type` | `"replay_complete"` | Constant. No payload. |

**Receiver action.** Call `fitAddon.fit()` on next rAF, then `term.scrollToBottom()`, then `setReconnecting(false)`. Mark `replayCompleteSeenRef = true` so the legacy-fallback timer (§2.7) is cancelled.

#### 2.3.6 `exit` (S→C, unchanged from legacy)

```json
{ "type": "exit", "exitCode": 0, "signal": 0 }
```

Sent when tmux pane dies and PTY exits. Existing behaviour preserved exactly (`terminal-manager.js:317-321`). Client renders the banner and stops reconnecting.

#### 2.3.7 `stopped` (S→C, unchanged from legacy)

```json
{ "type": "stopped" }
```

Sent if the session was already exited at attach time. Existing behaviour preserved (`terminal-manager.js:511`). Now sent AFTER the `replay_complete` frame in the new path; AFTER the buffer dump in the legacy path.

#### 2.3.8 `error` (S→C, unchanged from legacy)

```json
{ "type": "error", "message": "Session not found" }
```

Existing behaviour preserved (`server.js:175`, `terminal-manager.js:469`).

### 2.4 Text frames (client → server)

#### 2.4.1 `hello` (C→S, NEW, MANDATORY first message)

Sent by the new client as the FIRST message after `ws.onopen` fires, BEFORE the existing `resize` frame. The server MUST process exactly one `hello` per WS upgrade; subsequent `hello` frames on the same socket are ignored with a `console.warn`.

```json
{
  "type": "hello",
  "protocol_version": 2,
  "binary_capable": true,
  "lastSeq": "12345"
}
```

| Field | Type | Notes |
|---|---|---|
| `type` | `"hello"` | Constant. |
| `protocol_version` | `number` (uint) | Constant `2` for this rollout. Reserved `1` for legacy. Future-proofing only — the server only knows about `2` today. |
| `binary_capable` | `boolean` | `true` from this WP-C client (it sets `ws.binaryType = "arraybuffer"` and parses binary frames). Old clients omit this field; server treats absence as `false`. |
| `lastSeq` | `string` (decimal-encoded BigInt) | Last seq the client successfully wrote to xterm. `"0"` for fresh tabs. Persisted in `sessionStorage` keyed by `sessionId` so same-tab reload preserves it. |

**Server action (only when `CT_RELIABLE_STREAMING=1`).**
1. Compute `lastSeqBig = BigInt(msg.lastSeq)`.
2. If `lastSeqBig >= session.prunedSeq` AND `lastSeqBig < session.totalSeq` → FAST_PATH (§2.7).
3. If `lastSeqBig === 0n` AND `session.totalSeq === 0n` → SLOW_PATH but snapshot may be empty (fresh session).
4. Else → SLOW_PATH: compute `tmuxSnapshot(sessionId)`, send `snapshot`+`replay_complete`, set `client.lastSentSeq = session.totalSeq`.

**Server action (when flag OFF or hello is malformed).** Silently ignore the message. Continue on the legacy code path. (Today's `terminal-manager.js:516` try/catch already swallows unknown messages — this is the load-bearing back-compat property.)

#### 2.4.2 `ack` (C→S, OPTIONAL, FUTURE)

Reserved opcode for Phase-8+ flow-control. Spec is frozen here so future implementers don't squat on the same fieldnames.

```json
{ "type": "ack", "seq": "12345" }
```

**Status for this rollout.** Phase 7 implementers MUST NOT emit `ack` from the client and MUST silently drop it on the server with a `console.warn`. The actual flow-control mechanism in this rollout is `bufferedAmount` ceiling (§3.4 — server-only).

The reason `ack` is reserved here rather than later: any future PAUSE/RESUME, watermark, or sshx-style "Subscribe(start, k)" reuse needs the same `seq` field shape, and adding it later without breaking version-2 clients would force a `protocol_version: 3` bump.

#### 2.4.3 `input` (C→S, unchanged from legacy)

```json
{ "type": "input", "data": "ls -la\r" }
```

Existing behaviour preserved (`terminal-manager.js:518-524`). Server still calls `session.pty.write(message.data)`. Client-side filter at `Terminal.tsx:217` (DA1/DA2/DA3/CPR drop) is preserved.

#### 2.4.4 `resize` (C→S, unchanged shape, NEW server-side coalesce)

```json
{ "type": "resize", "cols": 200, "rows": 50 }
```

Existing wire shape preserved. Server-side change (WP-A): before `pty.resize`, check `if (cols === session.cols && rows === session.rows) return;` to drop no-op resizes (`terminal-manager.js:526-530`). Client-side change (WP-C): `ResizeObserver` callback is wrapped in 80 ms trailing-edge debounce.

#### 2.4.5 `image` (C→S, unchanged from legacy)

```json
{ "type": "image", "data": "<base64 PNG>" }
```

Existing behaviour preserved (`terminal-manager.js:531-573`). xclip pipeline unchanged.

### 2.5 Heartbeat (protocol-level ping/pong)

NOT a JSON frame. Uses the WS protocol-level frames defined in RFC 6455.

**Server side (NEW, WP-A).**
- `setInterval(25_000, heartbeatTick)` per WSS instance.
- For each tracked terminal client: if `client.isAlive === false`, call `client.ws.terminate()` and remove from `session.clients`. Else set `client.isAlive = false` and call `client.ws.ping()` (no payload).
- On `ws.on('pong')`, set `client.isAlive = true`.
- Newly-attached clients start with `isAlive = true`.

**Client side.** No application-level handling. Browsers respond to protocol-level pings automatically (RFC 6455). The client does NOT need to send pings of its own; the server-driven 25 s cadence is sufficient.

**Effective detection latency.** First missed ping is detected at `~25 s` (no pong); termination happens on the NEXT tick at `~50 s`. Acceptance criterion S7 requires ≤90 s; we are well under.

### 2.6 Close codes

| Code | Meaning | Direction | When |
|---|---|---|---|
| `1000` (Normal) | Existing — used in `client.close()` after error / delete-session broadcasts | S→C | Existing behaviour preserved (`terminal-manager.js:622, 662, 816`). |
| `4503` (NEW) | "Lagging" — `bufferedAmount` exceeded ceiling | S→C | When per-client send queue grows beyond 8 MiB. Client SHOULD reconnect with current `lastSeq`. |
| `1006` (Abnormal) | Browser default for sudden close (TCP RST, half-open detected) | passive | Existing — not changed. |
| `4401`/`4404` | Referenced in `Terminal.tsx:201` but NOT emitted by server today | — | Status quo. NOT introduced by this work; auth failures stay on `1006`. |

The new `4503` code is in the application range (4000-4999, RFC 6455 §7.4.2). Phase 7 implementer (WP-C) MUST add `case 4503` to `Terminal.tsx:204`'s reconnect branch logic — `4503` should NOT block reconnect (unlike `4401`/`4404` which are "permanent stop"); it's an explicit "you fell behind, come back with your lastSeq."

### 2.7 Reconnect state machine (server-side, NEW path only)

```
                            client opens WS (auth passed)
                                       │
                                       ▼
                                ┌──────────────┐
                                │ AWAIT_HELLO  │   timer: 2 s
                                └──────┬───────┘
                                       │ first message
                       ┌───────────────┼───────────────┐
                       │               │               │
                  is "hello"      is "input" /    timer expires
                  with v=2        "resize" /     (2 s no message)
                       │           "image"            │
                       ▼               │               ▼
                ┌────────────┐         │         ┌──────────┐
                │ ROUTE_HELLO│         │         │ LEGACY   │
                └─────┬──────┘         ▼         │ (treat as│
                      │           ┌──────────┐   │ binary=  │
                      │           │ LEGACY   │   │ false,   │
                      │           │ (treat as│   │ lastSeq=0│
                      │           │ binary=  │   │ → SLOW)  │
                      │           │ false,   │   └─────┬────┘
                      │           │ lastSeq=0│         │
                      │           │ → SLOW)  │         │
                      │           └─────┬────┘         │
                      │                 │              │
                      ▼                 │              │
        ┌─────────────┴──────────┐      │              │
        │                        │      │              │
  lastSeq < prunedSeq      lastSeq within             │
  OR no tmux pane          rolling window             │
        │                        │                    │
        ▼                        ▼                    │
  ┌──────────┐            ┌──────────┐                │
  │ SLOW_PATH│            │ FAST_PATH│                │
  └─────┬────┘            └─────┬────┘                │
        │                       │                     │
        │                       │ {type:"resume",     │
        │                       │  from:lastSeq+1}    │
        │                       │                     │
        │                       │ for chunk in        │
        │                       │ session.chunks      │
        │                       │ where seq>lastSeq:  │
        │                       │   binary OPCODE_    │
        │                       │   OUTPUT [seq][data]│
        │                       │                     │
        │                       │ {type:"replay_      │
        │                       │  complete"}         │
        │                       │                     │
        │                       ▼                     │
        │                 ┌──────────┐                │
        │                 │  LIVE    │                │
        │                 └──────────┘                │
        │                                             │
        │ snap = tmuxSnapshot(sessionId)              │
        │ epochSeq = session.totalSeq                 │
        │                                             │
        │ if binary_capable:                          │
        │   binary OPCODE_SNAPSHOT [epochSeq][snap]   │
        │ else:                                       │
        │   {type:"snapshot",seq:epochSeq,data:snap}  │
        │                                             │
        │ {type:"replay_complete"}                    │
        │                                             │
        └──────► joins session.clients                │
                 client.lastSentSeq = epochSeq        │
                                                      │
                                                      └─► joins session.clients (legacy path)
                                                          send full session.buffer, no replay_complete
```

The 2 s `AWAIT_HELLO` timer is the load-bearing back-compat: it ensures an old-client reconnect to a new server (which sends `input`/`resize` first, never `hello`) gets the legacy buffer dump within 2 s and never hangs. Phase 7 implementer (WP-A) MUST implement this with a per-WS `setTimeout` cleared on first message.

### 2.8 Backwards compatibility matrix

| Client | Server | First message C→S | Server response | Result |
|---|---|---|---|---|
| Old (legacy) | Old (flag off) | `{type:"resize",...}` | Full `session.buffer` dump as one `output` frame | Today's behaviour exactly. |
| Old (legacy) | New (flag on) | `{type:"resize",...}` | After 2 s `AWAIT_HELLO` timeout → LEGACY branch → full `session.buffer` dump as one `output` frame, no `replay_complete` | Old client works, no protocol error. |
| New (WP-C) | Old (flag off) | `{type:"hello",lastSeq:"N"}` then `{type:"resize",...}` | Old server's try/catch swallows `hello`, processes `resize`, then sends full `session.buffer` as one `output` (no `seq`). New client's onmessage: `BigInt(undefined)` would throw → catch branch → `term.write(msg.data)` without updating `lastSeqRef`. After 2 s legacy-fallback timer fires: `replayCompleteSeenRef === false` → client falls back to legacy mode (treats subsequent `output` frames as fire-and-forget without seq tracking) | New client works against old server, byte-for-byte identical to old behaviour. |
| New (WP-C) | New (flag on) | `{type:"hello",lastSeq:"N",binary_capable:true}` | FAST_PATH or SLOW_PATH per §2.7; binary frames for output/snapshot; ping/pong every 25 s | Full Robust-Lite path. |

The "no-confusion-possible" property: every cell in this matrix produces correct rendering. Mid-deploy version-mismatch windows are safe.

---

## 3. New chunk-list buffer module

### 3.1 File location decision

**Inline in `terminal-manager.js`** (NOT a new file). Rationale:
- The buffer's only consumer is `TerminalManager`. Extracting to `src/lib/server/replay-buffer.js` would create a one-callsite module that imports nothing and is imported once.
- The chunk list is tightly coupled to `_setupPty.onData` (the only producer) and `attachToSessionV2` (the only consumer). Locality > abstraction here.
- The legacy path (string buffer) and new path (chunk list) need to coexist in the same `Session` record during the rollout. Inlining keeps both visible side-by-side for the implementer.

If the project grows multi-pane support later, extracting then is a 30-minute refactor. Today, inline.

### 3.2 Public API (methods on the per-session record, NOT a class)

The following methods are added as plain functions on the `session` object. They mutate `session.chunks`, `session.totalSeq`, `session.prunedSeq` in place.

```js
// Conceptual signatures — Phase 7 implementer chooses the exact code shape.
session.pushChunk(data)              // append chunk, advance totalSeq, prune to bytes cap
session.chunksSince(lastSeqBig)      // returns Array<{seq:BigInt, data:string}> where seq > lastSeqBig
session.snapshot()                   // synchronous: returns {seq:BigInt, data:string} from tmuxSnapshot
session.evictForPrune(targetBytes)   // shifts chunks until totalBytes(chunks) <= targetBytes
```

| Method | Returns | Notes |
|---|---|---|
| `pushChunk(data: string)` | `{seq: BigInt, data: string}` | Pushes a `{seq, data}` to `session.chunks`, sets `seq = session.totalSeq`, advances `session.totalSeq += BigInt(data.length)`. Calls `evictForPrune(2 * 1024 * 1024)` if total bytes exceeded. Returns the newly-added chunk so the broadcast loop can fan it out without re-reading the array. |
| `chunksSince(lastSeqBig: BigInt)` | `Array<{seq, data}>` | Returns chunks where `chunk.seq > lastSeqBig`. Uses linear scan (chunks list is bounded at ~256 entries for 2 MiB cap with avg 8 KiB chunks). Premature optimisation: a binary search could be added later if profiling shows the scan is hot. |
| `snapshot()` | `{seq: BigInt, data: string}` | Calls `tmuxSnapshot(sessionId)` (§3.5). Returns `{seq: session.totalSeq, data: snap}`. Does NOT mutate session state. |
| `evictForPrune(targetBytes: number)` | `void` | Shifts `chunks[0]` while `totalBytes > targetBytes`. For each evicted chunk, sets `session.prunedSeq = chunk.seq + BigInt(chunk.data.length)` (the seq of the FIRST byte that is no longer reachable from the chunk list — i.e. the smallest seq the client must ask for to be served from chunks). |

### 3.3 Internal state (added to the per-session record)

Added to the existing session object created at `terminal-manager.js:143-153, 232-242, 365-375`:

```js
{
  // ── existing fields, preserved verbatim ──
  pty: null,
  projectDir: ...,
  connectedClients: new Set(),     // OLD path uses this; NEW path uses session.clients (Map)
  createdAt: ...,
  lastActivityAt: ...,
  buffer: "",                       // OLD path: string accumulator. NEW path leaves "" untouched.
  exited: ...,
  displayName: ...,
  providerSlug: ...,

  // ── NEW fields (only populated when CT_RELIABLE_STREAMING=1) ──
  chunks: [],                       // Array<{seq:BigInt, data:string}>, bounded by 2 MiB total data.length
  totalSeq: 0n,                     // BigInt: cumulative bytes ever received from PTY since session start
  prunedSeq: 0n,                    // BigInt: seq of the first byte still reachable in chunks (== chunks[0].seq if chunks non-empty)
  cols: 200,                        // last-known cols (for resize coalesce)
  rows: 50,                         // last-known rows
  clients: new Map(),               // Map<WebSocket, ClientRecord>; replaces synchronous broadcast
}
```

Per-client record (entries in `session.clients`):

```js
{
  ws: WebSocket,
  lastSentSeq: BigInt,              // last seq we successfully scheduled a send for
  queue: Array<{seq:BigInt, data:string}>,   // pending chunks waiting to flush
  drainScheduled: boolean,          // setImmediate guard
  binaryCapable: boolean,           // from hello.binary_capable
  isAlive: boolean,                 // ping/pong watchdog
}
```

### 3.4 Eviction policy

**Trigger.** After every `pushChunk` that pushes total bytes over `2 * 1024 * 1024` (== 2 MiB).

**Action.** `while (totalBytes(session.chunks) > 2 * 1024 * 1024) { evicted = session.chunks.shift(); session.prunedSeq = evicted.seq + BigInt(evicted.data.length); }`.

**Granularity.** Always at chunk boundary. NEVER inside a chunk. This is the structural property that closes P1 (mid-CSI cut) and P10 (UTF-16 surrogate split) by construction — `node-pty.onData` already gave us a string aligned on UTF-8 codepoints (via `StringDecoder` in `node-pty/lib/unixTerminal.js:95`), and we never re-slice that string.

**Memory accounting.** `totalBytes` is computed as `chunks.reduce((s, c) => s + c.data.length, 0)`. A naive sum on every push is O(N). Phase 7 implementer SHOULD cache `session.chunkBytes: number` and update incrementally on push/shift to keep the hot path O(1). This is a small optimisation; if Phase 7 ships the naive version and profiling later shows the reduce is hot, add the cache then.

**Why 2 MiB and not something else.** Today's `slice(-2_000_000)` cap (terminal-manager.js:295) is 2 MB; we keep parity. Larger means more memory per session (10 sessions × 2 MiB = 20 MiB worst case), smaller means more snapshot fallbacks on reconnect. 2 MiB is a defensible status-quo carry-over.

**Per-client backpressure ceiling.** Separate from the chunk-list cap. The per-client `bufferedAmount` ceiling is `8 * 1024 * 1024` (8 MiB); when exceeded, the client is closed with code `4503`. See §3.7.

### 3.5 `tmuxSnapshot` helper

Inline in `terminal-manager.js`, replaces `tmuxCapture(sessionId, -1)` calls at three sites:

```js
function tmuxSnapshot(sessionId) {
  // 1. Detect alt-screen state (vim, htop, tmux uses alt-screen internally)
  let altOn = false;
  try {
    const out = execFileSync("tmux", [
      "-L", TMUX_SOCKET,
      "display-message", "-t", sessionId, "-p", "#{alternate_on}",
    ], { encoding: "utf-8" }).trim();
    altOn = out === "1";
  } catch { /* default false */ }

  // 2. Capture pane (with -a if in alt-screen)
  const args = ["-L", TMUX_SOCKET, "capture-pane", "-t", sessionId,
                "-p", "-e", "-J", "-S", "-", "-E", "-"];
  if (altOn) args.push("-a");
  let raw;
  try {
    raw = execFileSync("tmux", args, {
      encoding: "utf-8",
      maxBuffer: 16 * 1024 * 1024,    // raised from 8 MiB (gotcha #3 in 04 §9)
    });
  } catch {
    raw = "";
  }

  // 3. CRLF-normalise (xterm.js doesn't set convertEol)
  const body = raw.replace(/(?<!\r)\n/g, "\r\n");

  // 4. Read cursor position (best-effort)
  let cx = 0, cy = 0;
  try {
    const cur = execFileSync("tmux", [
      "-L", TMUX_SOCKET,
      "display-message", "-t", sessionId, "-p", "#{cursor_x},#{cursor_y}",
    ], { encoding: "utf-8" }).trim().split(",").map(Number);
    if (Number.isFinite(cur[0]) && Number.isFinite(cur[1])) {
      cx = cur[0]; cy = cur[1];
    }
  } catch { /* default 0,0 */ }

  // 5. Wrap with clear-home + cursor-position
  return {
    data: "\x1b[2J\x1b[H" + body + `\x1b[${cy + 1};${cx + 1}H`,
    cursor: { x: cx, y: cy },
  };
}
```

**Why `execFileSync` not `execSync`.** Avoids shell injection on `sessionId` (today's code at `terminal-manager.js:36-46` uses string interpolation in `execSync` — acceptable because `sessionId` is server-generated, but `execFileSync` is strictly safer and the new helper has no reason to use a shell).

**Why three forks instead of one tmux command.** tmux doesn't have a single command that returns both the capture AND the cursor position. Two `display-message` + one `capture-pane` is the canonical pattern (03-tmux §10.1, 04 §9 gotcha #4). Total cost: ~5-50 ms per reconnect. Acceptable per S4 (≤500 ms reconnect budget).

### 3.6 Per-client cursor management

The synchronous broadcast loop at `terminal-manager.js:298-302`:

```js
for (const client of session.connectedClients) {
  if (client.readyState === 1) {
    client.send(JSON.stringify({ type: "output", data }));
  }
}
```

Is replaced (in the new path) with a per-client schedule:

```js
const newChunk = session.pushChunk(data);     // returns {seq, data}
for (const [, clientRec] of session.clients) {
  clientRec.queue.push(newChunk);
  if (!clientRec.drainScheduled) {
    clientRec.drainScheduled = true;
    setImmediate(() => drainClient(clientRec, session));
  }
}
```

The `drainClient` function:

```js
function drainClient(clientRec, session) {
  clientRec.drainScheduled = false;
  while (clientRec.queue.length > 0) {
    if (clientRec.ws.readyState !== 1) {
      clientRec.queue = [];
      session.clients.delete(clientRec.ws);
      return;
    }
    if (clientRec.ws.bufferedAmount > 8 * 1024 * 1024) {
      try { clientRec.ws.close(4503, "lagging"); } catch {}
      session.clients.delete(clientRec.ws);
      return;
    }
    const chunk = clientRec.queue.shift();
    if (clientRec.binaryCapable) {
      const frame = encodeBinaryOutput(chunk.seq, chunk.data);
      clientRec.ws.send(frame);
    } else {
      clientRec.ws.send(JSON.stringify({
        type: "output",
        seq: String(chunk.seq),
        data: chunk.data,
      }));
    }
    clientRec.lastSentSeq = chunk.seq;
  }
}
```

**Concurrency invariants.**
- `setImmediate` runs in its own microtask; one slow client's `bufferedAmount` check only affects itself (FIFO within client, no cross-client coupling).
- The `drainScheduled` flag prevents two `drainClient` calls from racing for the same client (they'd both shift from the same queue otherwise).
- Eviction (`close + delete`) is idempotent: subsequent pushes find the client gone from the Map.
- The `queue` is unbounded in code, but bounded in practice by the `bufferedAmount` check (which fires before queue can grow large because `ws.send` immediately accumulates into `bufferedAmount`).

### 3.7 Memory cap target

| Component | Bound | Notes |
|---|---|---|
| `session.chunks` | ≤ 2 MiB total `data.length` | Chunk-granularity prune; never mid-chunk slice. |
| `session.clients` Map | O(N_clients × ~200 B record) | Negligible. |
| Per-client `queue` | Practically ≤ 8 MiB (because `bufferedAmount` triggers eviction) | The queue itself is unbounded in code, but `ws.send` immediately moves bytes into `bufferedAmount`, so queue depth in JS is small. |
| Per-client `bufferedAmount` | Hard ceiling 8 MiB; eviction past that | RFC-defined `WebSocket.bufferedAmount`; `ws@8` reads it from underlying `net.Socket.bufferSize` plus internal buffer. |
| tmux scrollback (in tmux process, not node) | `history-limit × cols × ~16 B` | Out of node memory; tmux process owns it. With 50000 lines × 200 cols × 16 B ≈ 160 MiB worst case but typically much smaller. |

**Total per session in node memory (worst case under sustained load):** `2 MiB + 8 MiB × N_clients`. For typical use (1-3 clients × 5-10 sessions), ~50-100 MiB worst case. Well within VPS budget.

---

## 4. Per-file change plan

### 4.1 `/root/projects/claude-terminal/server.js` (WP-A)

| Property | Value |
|---|---|
| **Owning WP** | WP-A |
| **Read/Write status for other WPs** | Read-only for WP-B and WP-C |
| **Estimated LoC change** | ~30 lines added, ~5 modified |
| **New imports** | None |
| **New dependencies** | None |

**Sections affected.**

#### `server.js:158-189` — terminal upgrade handler

Currently routes the WS upgrade to `terminalManager.attachToSession(sessionId, ws)` or `terminalManager.attachToEphemeralSession(sessionId, ws)` based on `query.ephemeral`. Diff intent:

1. Read `process.env.CT_RELIABLE_STREAMING` once at module init (after env load at line 7-22). Store in module-scope `const RELIABLE_STREAMING = process.env.CT_RELIABLE_STREAMING === "1"`.
2. Inside `wss.handleUpgrade` callback (line 171), pass `RELIABLE_STREAMING` to `attachToSession` as a second arg (or set it as a property on the ws), so the manager can branch on it WITHOUT re-reading `process.env` per attach.
3. Add per-session escape hatch (DEV-only): if `query.reliable === "0"` AND `process.env.NODE_ENV !== "production"`, override `RELIABLE_STREAMING` to `false` for this session. Useful for ops to repro the legacy bug class against a new build.
4. (No change to `/api/presence` or `/api/symphony-events` upgrades — they are explicitly out of scope per `05-decision-tmux.md` §10.3.)

#### `server.js:272-307` — `gracefulShutdown`

Currently:
- Awaits `symphonyOrchestrator.gracefulShutdown()`.
- Iterates `terminalManager.sessions` and `pty.kill()` each.
- Calls `wss.close()`, `wssPresence.close()`, `wssSymphony.close()`.
- Calls `server.close()` then `db.close()`.
- 40 s force-exit timer.

Diff intent: Add ONE step before WSS close: if `RELIABLE_STREAMING`, also call the heartbeat interval cleanup. Specifically, if WP-A registered a `setInterval` for ping/pong in TerminalManager, ensure it's cleared in `gracefulShutdown` so the process can exit cleanly. The simplest way: have TerminalManager expose a `destroy()` method (one already exists at `terminal-manager.js:218-224` for the file watcher) and extend it to clear the heartbeat interval. Then `gracefulShutdown` calls `terminalManager.destroy()` at the start.

**Tests to add.** Manual harness (no test infra exists for server.js): start with `CT_RELIABLE_STREAMING=0`, verify legacy session works; restart with `=1`, verify new session works; restart back to `=0`, verify legacy still works. Done as part of WP-A's S1-S9 manual repro.

---

### 4.2 `/root/projects/claude-terminal/terminal-manager.js` (WP-A)

| Property | Value |
|---|---|
| **Owning WP** | WP-A |
| **Read/Write status for other WPs** | Read-only for WP-B and WP-C |
| **Estimated LoC change** | ~700 lines added, ~50 modified, ~30 deleted |
| **New imports** | `execFileSync` from `child_process` (already imported as `execSync` and `spawn` at line 4 — extend the destructure) |
| **New dependencies** | None |

**Sections affected.** Listed top-to-bottom.

#### Lines 1-4 — imports

Diff intent: Extend the destructure on line 4 from `const { execSync, spawn } = require("child_process");` to `const { execSync, execFileSync, spawn } = require("child_process");`. `execFileSync` is for the new `tmuxSnapshot` (avoids shell injection on `sessionId`).

#### Lines 36-47 — `tmuxCapture` helper

Diff intent:
- Raise the `maxBuffer` from `8 * 1024 * 1024` to `16 * 1024 * 1024` (gotcha #3 in 04 §9 — at 200 cols × 50000 lines + ANSI overhead, 8 MiB can truncate).
- Add the new `tmuxSnapshot(sessionId)` function immediately after `tmuxCapture` per §3.5 of this plan. `tmuxCapture` is preserved for the legacy code path (call sites at 177, 247, 489 that run when `RELIABLE_STREAMING` is off remain unchanged).
- The new code path's snapshot helper (`tmuxSnapshot`) is ONLY called from the new `attachToSessionV2` (introduced below); existing `tmuxCapture` callers stay on the existing helper.

#### Lines 105-115 — `TerminalManager` constructor

Diff intent:
- Add new field `this.heartbeatInterval = null` initialised in the constructor.
- After `_watchSessionsFile()`, if `process.env.CT_RELIABLE_STREAMING === "1"`, start the heartbeat interval: `this.heartbeatInterval = setInterval(() => this._heartbeatTick(), 25_000)`. This is the ping/pong watchdog (per §2.5 of this plan).

#### Lines 136-159 — `_loadSessions`

Diff intent: Add the new fields to the session object created on line 143-153. Specifically:

```js
this.sessions.set(entry.sessionId, {
  // ... existing fields ...
  buffer: "",                  // legacy field — stays as today
  // NEW (only used when CT_RELIABLE_STREAMING=1; safe to allocate even if flag off):
  chunks: [],
  chunkBytes: 0,               // optional cache for O(1) totalBytes
  totalSeq: 0n,
  prunedSeq: 0n,
  cols: 200,                   // matches new tmux default-size from WP-B
  rows: 50,
  clients: new Map(),
});
```

Allocating these fields unconditionally costs ~200 B per session and keeps the session shape uniform across rollout phases.

#### Lines 218-224 — `destroy`

Diff intent: Extend to also clear the heartbeat interval if it was set:

```js
destroy() {
  if (this._watchCallback) {
    fs.unwatchFile(SESSIONS_FILE, this._watchCallback);
    this._watchCallback = null;
  }
  if (this.heartbeatInterval) {           // NEW
    clearInterval(this.heartbeatInterval);
    this.heartbeatInterval = null;
  }
}
```

`server.js`'s `gracefulShutdown` MUST call this (per §4.1).

#### Lines 226-255 — `_syncFromDisk`

Diff intent: Same as `_loadSessions` — extend the new-session shape to include the new fields. Single reuse: extract the session-shape factory into a helper `_makeSession(entry)` to avoid drift between `_loadSessions` and `_syncFromDisk`.

#### Lines 271-323 — `_setupPty`

Diff intent: This is the producer hot path. Branch on `process.env.CT_RELIABLE_STREAMING === "1"` (cached at constructor time as `this.reliableStreaming`). 

**Legacy branch (flag off).** Unchanged. The existing `session.buffer += data; if (length > 2_000_000) slice(-2_000_000); for (client of session.connectedClients) client.send(...)` pattern stays exactly as today.

**New branch (flag on).** Replace lines 294-302 with:

```js
const newChunk = this._pushChunk(session, data);
for (const [, clientRec] of session.clients) {
  clientRec.queue.push(newChunk);
  if (!clientRec.drainScheduled) {
    clientRec.drainScheduled = true;
    setImmediate(() => this._drainClient(clientRec, session));
  }
}
```

Where `_pushChunk` and `_drainClient` are new private methods (added near `_setupPty`) implementing §3.2 and §3.6 of this plan.

**Both branches share** the `ALT_SCREEN_RE.replace`, the grace-window extension (lines 285-292), and the `lastActivityAt` semantics. Only the storage and broadcast differ.

#### Lines 305-322 — `onExit` handler

Diff intent: Update the broadcast at line 316-321 to use the new fan-out when flag is on. Specifically, the `client.send(JSON.stringify({type:"exit", ...}))` MUST go through the same per-client async drain so `bufferedAmount` and `binaryCapable` are honoured (per `05-decision-tmux.md` §10.3 — "DO NOT introduce a third broadcast pattern").

Practical implementation:

```js
ptyProcess.onExit(() => {
  session.pty = null;
  if (tmuxHasSession(sessionId)) {
    console.log(`> PTY detached from tmux ${sessionId} (tmux still alive)`);
  } else {
    session.exited = true;
    if (this.reliableStreaming) {
      this._broadcastControlV2(session, { type: "exit", exitCode: 0, signal: 0 });
    } else {
      for (const client of session.connectedClients) {
        if (client.readyState === 1) {
          client.send(JSON.stringify({ type: "exit", exitCode: 0, signal: 0 }));
        }
      }
    }
  }
});
```

Where `_broadcastControlV2` iterates `session.clients` and pushes a JSON envelope through the same drain (control messages are ALWAYS JSON, never binary, per §2.1 of this plan).

#### Lines 325-381 — `createSession`

Diff intent: Extend the session shape on lines 365-375 to include the new fields. Single change: copy the new fields from the `_makeSession` helper.

#### Lines 383-441 — `resumeSession`

Diff intent: At line 433, `session.buffer = ""` is the legacy reset. Add (immediately after) a reset of the new fields when flag is on:

```js
session.buffer = "";
if (this.reliableStreaming) {
  session.chunks = [];
  session.chunkBytes = 0;
  session.totalSeq = 0n;
  session.prunedSeq = 0n;
  // session.clients is preserved (existing connections survive resume); their queues drain naturally.
}
```

The clients Map IS preserved — their `lastSentSeq` becomes irrelevant for the new session epoch but the next snapshot/resume will re-anchor them.

#### Lines 466-583 — `attachToSession` (THE CENTRAL CHANGE)

Diff intent: This is the most complex change. Phase 7 implementer (WP-A) MUST split this into two paths.

**Phase 7 implementation strategy (recommended):**
- Keep the existing `attachToSession(sessionId, ws)` method INTACT for the legacy path.
- Add a new method `attachToSessionV2(sessionId, ws)` that implements the new path.
- The `server.js` upgrade handler chooses between them based on `RELIABLE_STREAMING`.

**`attachToSessionV2` semantic outline.** Phase 7 implements the following state machine (per §2.7 of this plan):

1. **Setup.** Reject if `!session`. Attach `ws.on("error", () => {})` (WS scan §3.5). Start `helloTimer = setTimeout(2000)`.
2. **First-message handler.** On message, parse JSON. Branch:
   - `msg.type === "hello"` AND `protocol_version === 2`: extract `lastSeqBig = BigInt(msg.lastSeq || "0")` and `binaryCapable = msg.binary_capable === true`. Register client. Lazy-attach PTY (mirror existing lines 478-503). Then route: if `lastSeqBig >= session.prunedSeq && lastSeqBig < session.totalSeq` → FAST_PATH (`_sendResumePath`); else SLOW_PATH (`_sendSnapshotPath`). If `session.exited`, send `{type:"stopped"}` AFTER `replay_complete`. Wire steady-state handlers.
   - `msg.type === "hello"` with other version: log warn, register as `{binary_capable:false, lastSeq:0n}`, SLOW_PATH, wire steady-state.
   - Any other message: register as legacy fallback `{binary_capable:false, lastSeq:0n}`, SLOW_PATH, wire steady-state, then re-dispatch the message via `_handleSteadyStateMessage`.
3. **Hello-timer expiry.** If 2 s pass with no message, treat as legacy: register `{binary_capable:false, lastSeq:0n}`, SLOW_PATH, wire steady-state. (Old clients send `resize` first — they hit the "any other message" branch above; this timer is the safety net for clients that send NOTHING.)
4. **Close handler.** `session.clients.delete(ws)`, `clearTimeout(helloTimer)`.

The `helloHandled` flag is a guard so the timer-fallback and the message-handler don't both register the same client. `ws.off("message", firstMessageHandler)` removes the once-only handler before wiring the steady-state one.

Helper sizes:
- `_registerClientV2(session, ws, {binary_capable, lastSeq})` (~10 LoC): adds `ClientRecord` to `session.clients`.
- `_sendResumePath(session, ws, lastSeqBig, binaryCapable)` (~30 LoC): emits `{type:"resume", from:String(lastSeqBig+1n)}`, iterates `session.chunksSince(lastSeqBig)` emitting binary or JSON output frames, ends with `{type:"replay_complete"}`. All sends route through the per-client queue so `bufferedAmount` is honoured.
- `_sendSnapshotPath(session, ws, {binary_capable})` (~25 LoC): calls `tmuxSnapshot(sessionId)`, computes `epochSeq = session.totalSeq`, emits binary `OPCODE_SNAPSHOT` (Buffer.allocUnsafe(9+len)) or JSON `snapshot` envelope, then `{type:"replay_complete"}`. Sets `clientRec.lastSentSeq = epochSeq`.
- `_wireSteadyStateHandlers(session, ws, sessionId)` (~50 LoC): mirrors today's lines 514-578 (input/resize/image), with the new resize coalesce: `if (cols === session.cols && rows === session.rows) return;` then `pty.resize(...)` then update `session.cols/rows`.
- `_handleSteadyStateMessage(session, ws, sessionId, rawMessage)` (~5 LoC): one-line dispatch helper for the "first message wasn't hello" re-process case.

#### Lines 514-578 — message handler

Diff intent: Lifted into `_wireSteadyStateHandlers` for the new path; preserved verbatim for the legacy path. The ONLY behavioural change in steady-state is the resize coalesce (`if (cols === session.cols && rows === session.rows) return;` before `pty.resize`). Image handling is identical. Input handling is identical.

#### Lines 580-583 — close handler

Diff intent: Legacy path stays as-is. New path's close handler is set up inside `attachToSessionV2` and removes from `session.clients` Map (not `session.connectedClients` Set).

#### Lines 592-669 — `deleteSession` and `deleteSessionKeepFiles`

Diff intent: Both currently iterate `session.connectedClients` to broadcast `exit` then `client.close()`. Update to iterate the appropriate collection based on which path is active. Cleanest approach: union both collections via a helper:

```js
_allClients(session) {
  const result = new Set(session.connectedClients);   // legacy clients
  for (const ws of session.clients.keys()) result.add(ws);  // new clients
  return result;
}
```

Then the `for (const client of this._allClients(session))` loop works for both paths.

#### Lines 705-820 — ephemeral session methods

Diff intent: **NO CHANGES.** Per `05-decision-tmux.md` §10.3 ("DO NOT convert ephemeral terminal to use the new chunk-list path unless it ALSO gets reconnect logic"), ephemeral stays on the legacy string buffer + synchronous broadcast. They die after 5 min anyway (line 732-734).

#### NEW METHODS TO ADD

In addition to the helpers cited above, Phase 7 (WP-A) adds:

- `_pushChunk(session, data)` — per §3.2. ~15 LoC.
- `_drainClient(clientRec, session)` — per §3.6. ~25 LoC.
- `_broadcastControlV2(session, envelope)` — per §4.2 above. ~10 LoC.
- `_heartbeatTick()` — iterates ALL sessions and ALL their `clients` Map. For each: if `!isAlive`, terminate; else set `isAlive=false` and `ws.ping()`. Also iterates legacy `session.connectedClients` so legacy path also gets ping/pong (free upgrade — protocol-level, no client awareness needed). ~25 LoC.
- `_makeSession(entry)` factory — per §4.2 above (line 226-255 section). ~25 LoC.
- `tmuxSnapshot(sessionId)` — per §3.5. ~25 LoC.
- `encodeBinaryOutput(seq, data)` and `encodeBinarySnapshot(seq, data)` — pure functions. ~10 LoC each:

```js
function encodeBinaryOutput(seqBig, data) {
  const payload = Buffer.from(data, "utf-8");
  const frame = Buffer.allocUnsafe(9 + payload.length);
  frame.writeUInt8(0x01, 0);
  frame.writeBigUInt64BE(seqBig, 1);
  payload.copy(frame, 9);
  return frame;
}

function encodeBinarySnapshot(seqBig, data) {
  const payload = Buffer.from(data, "utf-8");
  const frame = Buffer.allocUnsafe(9 + payload.length);
  frame.writeUInt8(0x02, 0);
  frame.writeBigUInt64BE(seqBig, 1);
  payload.copy(frame, 9);
  return frame;
}
```

**Tests to add.** No test infra exists for `terminal-manager.js`. Phase 7 implementer (WP-A) MUST add a manual harness — a small standalone Node script (in `agent-workflow/harness/` so it doesn't ship to production) that:
1. Mocks `node-pty.onData` by pushing 10 MB of synthetic chunks (mix of small <1 KiB and large 64 KiB).
2. Asserts `session.chunks` total bytes ≤ 2 MiB after each push.
3. Asserts `prunedSeq` advances monotonically.
4. Asserts no chunk is ever sliced mid-bytes (head of `chunks[0].data` always equals what was passed to `pushChunk`).
5. Mocks a "client" with controllable `bufferedAmount` (sets it to 9 MiB) and asserts eviction at 8 MiB triggers `close(4503, "lagging")`.
6. Mocks reconnect with `lastSeq` values: `0n` → SLOW_PATH; mid-buffer (e.g. 5000n if totalSeq=10000n and prunedSeq=2000n) → FAST_PATH; pre-prune (e.g. 1000n if prunedSeq=2000n) → SLOW_PATH.

Harness file: `/root/projects/claude-terminal/agent-workflow/harness/replay-buffer-harness.js`. Run via `node agent-workflow/harness/replay-buffer-harness.js`. Output: PASS/FAIL summary, no test framework dependency.

---

### 4.3 `/root/projects/claude-terminal/tmux.conf` (WP-B)

| Property | Value |
|---|---|
| **Owning WP** | WP-B |
| **Read/Write status for other WPs** | Read-only for WP-A and WP-C |
| **Estimated LoC change** | +13 lines added, 2 modified |
| **New imports** | N/A |
| **New dependencies** | None (tmux ≥ 3.2 required for `terminal-features` syntax — verified on host via `tmux -V`) |

**Sections affected.** Entire file is small (35 lines today). Below is the BEFORE → AFTER diff intent line-by-line.

**Lines 1-11 (preamble + prefix + escape-time):** unchanged.

```
# Claude Terminal — tmux configuration                       # unchanged
# Used with: tmux -L claude-terminal -f tmux.conf            # unchanged

# Prefix: C-] (rarely used, won't conflict with Claude CLI)  # unchanged
set -g prefix C-]                                            # unchanged
unbind C-b                                                   # unchanged

# Instant escape key passthrough (no delay)                  # unchanged
set -g escape-time 0                                         # unchanged

# Large scrollback buffer for terminal history persistence   # unchanged
set -g history-limit 50000                                   # unchanged
```

Verify on the running tmux server (no actionable change needed): `escape-time 0` already set; `history-limit 50000` already set.

**Lines 14-16 (terminal capabilities):** EXTENDED.

BEFORE:
```
set -g default-terminal "xterm-256color"
set -ga terminal-overrides ",xterm-256color:Tc"
```

AFTER:
```
# Terminal capability — enable atomic redraws, focus events, RGB
set -g default-terminal "tmux-256color"
set -ga terminal-overrides ",*256col*:Tc"
set -ga terminal-features ",*256col*:RGB,clipboard,focus,sync"
```

**Why `tmux-256color` not `xterm-256color`.** `tmux-256color` is the recommended terminfo entry inside tmux (advertises sync, clipboard, focus). `xterm-256color` works but is a less-precise capability description. The PTY env (`PTY_ENV.TERM` at `terminal-manager.js:64`) stays as `xterm-256color` — that's the OUTER terminal's TERM, which xterm.js consumes; tmux internally uses `tmux-256color`.

**Why `*256col*` glob.** Matches both `xterm-256color` and `tmux-256color` so the override applies regardless.

**Lines 19-30 (status, mouse, rename, remain-on-exit):** EXTENDED.

BEFORE:
```
# No status bar (invisible to xterm.js)
set -g status off

# Mouse OFF — xterm.js handles selection/scroll natively.
# tmux mouse intercepts events and creates its own yellow selection
# that conflicts with browser copy (Cmd+C / Ctrl+C).
set -g mouse off

# Don't rename windows
set -g allow-rename off

# Destroy session when the command inside exits
set -g remain-on-exit off
```

AFTER (additions only — existing settings preserved):
```
# (existing settings preserved verbatim)
set -g status off
set -g mouse off
set -g allow-rename off
set -g remain-on-exit off

# Reliability hardening
set -g focus-events on
setw -g automatic-rename off
setw -g monitor-bell off
set -g set-clipboard off
```

**Lines 33-34 (window-size + aggressive-resize):** REPLACED — load-bearing.

BEFORE:
```
# Resize to match the latest attached client
set -g window-size latest
set -g aggressive-resize on
```

AFTER:
```
# Geometry — kill resize storms (load-bearing for P5)
# Server tmux runs at fixed 200x50. Browser xterm.js letterboxes locally.
# Client resize messages are coalesced server-side (terminal-manager.js)
# and dropped if (cols,rows) didn't actually change.
set -g window-size manual
set -g default-size "200x50"
setw -g aggressive-resize off
```

**Why this is THE load-bearing change.** With `window-size latest` + `aggressive-resize on`, every browser viewport change → `pty.resize` → tmux re-renders pane to new geometry → byte burst back through pipe → client renders → repeat. This cascade is the physics behind P5 (resize storms). Setting `window-size manual` + `default-size 200x50` + `aggressive-resize off` makes tmux IGNORE client geometry changes; the pane stays at 200×50; xterm.js letterboxes locally (renders the 200-col grid inside a wider/narrower viewport).

**Acceptance.** Per S6 of `05-decision-tmux.md` §4: mobile keyboard show/hide must produce ≤2 `pty.resize` calls per direction. With `window-size manual`, even those 2 calls become no-ops at the tmux layer (tmux ignores them). The server-side equality coalesce in WP-A is defensive against the client misbehaving.

**Operational note.** Existing tmux sessions need detach+reattach to pick up `focus-events`, `terminal-features`, `window-size manual`. The first deploy after this change is "half-effective" for sessions that were already running. Acceptable per `05-decision-tmux.md` §8 risk #8 (one-shot at attach time, not a storm).

**Diff verification.** Phase 7 (WP-B) MUST verify the new config parses cleanly: `tmux -L claude-terminal-test -f tmux.conf new-session -d -s test 'sleep 60' && tmux -L claude-terminal-test kill-server`. If this returns a non-zero exit code, the config has a syntax error.

**Tests to add.** None automated. Manual: after deploy, run `tmux -L claude-terminal show-options -g | grep -E '(window-size|aggressive-resize|focus-events|terminal-features|set-clipboard|monitor-bell|automatic-rename)'` and verify all values match expected. WP-B implementer adds this command to the deploy README or runs it in the deploy report.

---

### 4.4 `/root/projects/claude-terminal/src/components/Terminal.tsx` (WP-C)

| Property | Value |
|---|---|
| **Owning WP** | WP-C |
| **Read/Write status for other WPs** | Read-only for WP-A and WP-B |
| **Estimated LoC change** | ~150 lines added, ~30 modified, ~5 deleted |
| **New imports** | None (no new deps) |
| **New dependencies** | None |

**Sections affected.**

#### Lines 21-47 — refs and props

Diff intent: Add three new refs:

```ts
const lastSeqRef = useRef<bigint>(0n);                      // tracked seq of last applied byte
const replayCompleteSeenRef = useRef(false);                // becomes true after server emits replay_complete; also true once legacy fallback timer expires
const legacyFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
const resizeDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
```

`lastSeqRef` is persisted to `sessionStorage` keyed by `sessionId` to survive page reload (same-tab refresh). Phase 7 (WP-C) MUST add a `useEffect` that:
- On mount, reads `sessionStorage.getItem("ct.lastSeq." + sessionId)` and sets `lastSeqRef.current = BigInt(stored || "0")`.
- On every update of `lastSeqRef.current`, debounces a write back to sessionStorage (every ~250 ms is fine).
- On unmount or session switch, removes the key.

`replayCompleteSeenRef` exists to handle the new-client/old-server case: if 2 s after `ws.onopen` we have NOT seen `replay_complete`, fall back to legacy mode (assume server is on old protocol).

#### Lines 84-94 — `scheduleReconnect`

Diff intent: NO CHANGES to the backoff function itself. Phase 7 (WP-C) adds ONE thing in the close handler at line 197-209: include `4503` in the "do reconnect" branch (it already reconnects on `1006`; just ensure `4503` is not accidentally caught by the `4401`/`4404` permanent-stop branch).

Concretely, line 204 today reads:
```ts
if (event.code === 4401 || event.code === 4404) return;
```

After change (the existing line is FINE — `4503` falls through naturally to the reconnect path). No edit needed beyond a code comment to document `4503` semantics.

#### Lines 98-230 — `connectWs`

Diff intent: This is the central client change. Multiple sub-edits:

**Line 145-146 — set binaryType.**

BEFORE:
```ts
const ws = new WebSocket(wsUrl);
wsRef.current = ws;
```

AFTER:
```ts
const ws = new WebSocket(wsUrl);
ws.binaryType = "arraybuffer";       // NEW: enable binary frame parsing
wsRef.current = ws;
```

**Lines 148-167 — `ws.onopen`.**

BEFORE:
```ts
ws.onopen = () => {
  reconnectAttemptRef.current = 0;
  setReconnecting(false);
  onConnectionChangeRef.current?.("connected");

  if (isReconnectRef.current) {
    term.clear();
    isReconnectRef.current = false;
  }

  ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
};
```

AFTER:
```ts
ws.onopen = () => {
  reconnectAttemptRef.current = 0;
  setReconnecting(false);
  onConnectionChangeRef.current?.("connected");
  replayCompleteSeenRef.current = false;

  // NEW: send hello first; defer term.reset until snapshot arrives
  ws.send(JSON.stringify({
    type: "hello",
    protocol_version: 2,
    binary_capable: true,
    lastSeq: lastSeqRef.current.toString(),
  }));

  // Then send resize (existing behaviour preserved)
  ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));

  // Legacy fallback: if no replay_complete within 2 s, assume old server and apply legacy term.clear
  legacyFallbackTimerRef.current = setTimeout(() => {
    if (!replayCompleteSeenRef.current && isReconnectRef.current) {
      term.clear();
      isReconnectRef.current = false;
    }
  }, 2000);
};
```

**Note on `term.reset` vs `term.clear`.** Per `05-decision-tmux.md` D-Q8, the new path uses `term.reset()` inside the `snapshot` handler (because we KNOW the server is going to send us a self-contained snapshot that does its own clear-home). `term.clear()` is preserved only in the legacy-fallback timer for backwards compat. Phase 7 implementer MUST be careful: do NOT call `term.reset()` on every reconnect — only inside the snapshot handler.

**Lines 169-195 — `ws.onmessage` (full replacement).** The new handler dispatches by frame type, then by opcode (binary) or `msg.type` (JSON):

**Binary branch** (`event.data instanceof ArrayBuffer`):
- If `byteLength < 9`, `console.warn` and return.
- Read `opcode = view.getUint8(0)`, `seq = view.getBigUint64(1, false)`, `payload = new Uint8Array(event.data, 9)`.
- `0x01 OPCODE_OUTPUT`: `lastSeqRef.current = seq; term.write(payload)`.
- `0x02 OPCODE_SNAPSHOT`: `term.reset()`; decode UTF-8 via `TextDecoder` (callback chaining requires string); `term.write(text, () => { lastSeqRef.current = seq; })`.
- default: `console.warn("[terminal] unknown binary opcode:", opcode)`.

**Text branch** (JSON parse, drop on parse error with `console.warn` — REMOVE the legacy `} catch { term.write(event.data); }` raw-write branch; this closes P11):
- `output`: if `typeof msg.seq === "string"` then `lastSeqRef.current = BigInt(msg.seq)` (try/catch); `term.write(msg.data)`. Old-server fallback case: missing `seq` field is tolerated (just don't update lastSeq).
- `snapshot`: `term.reset()` then `term.write(msg.data, () => { lastSeqRef.current = BigInt(msg.seq); })`.
- `resume`: informational; no rendering action. Optional dev debug: validate `BigInt(msg.from) === lastSeqRef.current + 1n`, warn on mismatch.
- `replay_complete`: set `replayCompleteSeenRef.current = true`; clear `legacyFallbackTimerRef`; on next rAF call `fitAddonRef.current?.fit()`, `term.scrollToBottom()`, `setReconnecting(false)`; set `isReconnectRef.current = false`.
- `exit` / `stopped` / `error`: identical banners as today (preserve verbatim text).
- default: `console.warn("[terminal] unknown message type:", msg.type)`.

**Removal of legacy fallback to raw write.** The OLD `} catch { term.write(event.data); }` branch (line 192-194) is REMOVED. P11 (JSON-parse fallback) is closed by NOT writing arbitrary frame data into xterm. Replaced with `console.warn` and silent drop.

#### Lines 197-209 — `ws.onclose`

Diff intent: Add cleanup of the new timer:

```ts
ws.onclose = (event) => {
  onConnectionChangeRef.current?.("disconnected");
  wsRef.current = null;

  if (legacyFallbackTimerRef.current) {        // NEW: cleanup
    clearTimeout(legacyFallbackTimerRef.current);
    legacyFallbackTimerRef.current = null;
  }

  if (unmountedRef.current) return;
  if (event.code === 4401 || event.code === 4404) return;

  // Note: 4503 ("lagging") falls through to reconnect — preserves lastSeq for resume.

  isReconnectRef.current = true;
  scheduleReconnect();
};
```

#### Lines 211-221 — `term.onData` data filter

Diff intent: NO CHANGES. The DA1/DA2/DA3/CPR filter is preserved verbatim.

#### Lines 233-405 — `initTerminal`

Diff intent: ONE behavioural change — replace `ResizeObserver` callback with debounced version.

**Lines 362-380.** BEFORE:
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

AFTER:
```ts
let lastSentCols = term.cols;
let lastSentRows = term.rows;

const doResize = () => {
  fitAddon.fit();
  const ws = wsRef.current;
  if (ws && ws.readyState === WebSocket.OPEN) {
    if (term.cols !== lastSentCols || term.rows !== lastSentRows) {
      lastSentCols = term.cols;
      lastSentRows = term.rows;
      ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    }
  }
  requestAnimationFrame(() => publishScroll());
};

const handleResize = () => {
  if (resizeDebounceTimerRef.current) {
    clearTimeout(resizeDebounceTimerRef.current);
  }
  resizeDebounceTimerRef.current = setTimeout(doResize, 80);
};

const resizeObserver = new ResizeObserver(handleResize);
```

The debounce is 80 ms trailing-edge. The local equality check `lastSentCols/lastSentRows` is defensive: even if `fit()` produces the same dimensions, we don't spam the server. This complements WP-A's server-side equality coalesce.

#### Lines 386-404 — cleanup function

Diff intent: Add cleanup for the new timers:

```ts
return () => {
  unmountedRef.current = true;
  if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
  if (legacyFallbackTimerRef.current) clearTimeout(legacyFallbackTimerRef.current);   // NEW
  if (resizeDebounceTimerRef.current) clearTimeout(resizeDebounceTimerRef.current);   // NEW
  containerEl?.removeEventListener("paste", handlePaste, true);
  scrollDisposable.dispose();
  writeDisposable.dispose();
  dataDisposableRef.current?.dispose();
  registerScrollFnRef.current(null);
  resizeObserver.disconnect();
  if (wsRef.current) {
    wsRef.current.onclose = null;
    wsRef.current.close();
    wsRef.current = null;
  }
  term.dispose();
};
```

**Tests to add.** No test infra exists for React components in this project. Manual verification per S1-S9 acceptance criteria. Phase 7 (WP-C) MUST also verify in dev console:
- `event.data instanceof ArrayBuffer` returns `true` for binary frames after `binaryType="arraybuffer"`.
- `console.warn` for unknown opcodes is observable.
- `lastSeqRef.current` advances monotonically (log it on each `output`).

---

### 4.5 `/root/projects/claude-terminal/src/components/EphemeralTerminal.tsx` (WP-C)

| Property | Value |
|---|---|
| **Owning WP** | WP-C |
| **Read/Write status for other WPs** | Read-only for WP-A and WP-B |
| **Estimated LoC change** | ~50 lines added, ~10 modified |
| **New imports** | None |
| **New dependencies** | None |

**Sections affected.** Per `05-decision-tmux.md` §10.3, ephemeral does NOT inherit the chunk-list path on the SERVER side. But it DOES inherit the client-side improvements (binary frame parsing, debounce, removal of raw-write fallback) for forward-compatibility.

#### Line 47 — set `binaryType`

After `const ws = new WebSocket(wsUrl)`, add `ws.binaryType = "arraybuffer";`. No-op today (server doesn't emit binary to ephemeral) but forward-compatible.

#### Lines 49-59 — `ws.onmessage`

Replace with a structurally equivalent but slimmer version of Terminal.tsx's onmessage:
- If `event.data instanceof ArrayBuffer`: read opcode (byte 0); for `0x01`/`0x02` call `term.write(new Uint8Array(event.data, 9))`; else `console.warn`.
- Else parse JSON. Branch on `msg.type`: `output` → `term.write(msg.data)`; `exit` → write the existing banner; `snapshot` → `term.reset()` then `term.write(msg.data)` (forward-compat no-op today); `replay_complete` → no-op (forward-compat); default → `console.warn`.
- REMOVE the legacy `} catch { term.write(event.data); }` raw-write branch — replace with `console.warn` and silent drop (P11 closure).

Ephemeral does NOT send `hello` because it has no reconnect logic and no `lastSeq` to preserve — intentional per §10.3.

#### Lines 67-72 — `ResizeObserver`

Wrap the existing `fitAddon.fit() + ws.send(resize)` body in an 80 ms trailing-edge debounce identical to Terminal.tsx (`doResize` + `resizeTimer` ref + `clearTimeout` on each observer tick), with the same `lastSentCols/lastSentRows` equality check before sending. Add `if (resizeTimer) clearTimeout(resizeTimer);` to the cleanup function.

**Tests to add.** Manual: verify ephemeral session (provider-wizard auth terminal) still works. Visual check that no warnings are spammed in console.

---

### 4.6 `/root/projects/claude-terminal/src/lib/TerminalScrollContext.tsx` (WP-C, READ-ONLY by design)

| Property | Value |
|---|---|
| **Owning WP** | WP-C (declared in `05-decision-tmux.md` §6 WP-C) |
| **Status for this rollout** | NO CHANGES |
| **Estimated LoC change** | 0 |

**Diff intent.** None. The scroll context is unaffected by the protocol changes. The `replay_complete` handler in WP-C calls `fitAddon.fit()` and `term.scrollToBottom()` directly on xterm; the scroll context will pick up the resulting `term.onScroll` event naturally via the existing wiring at `Terminal.tsx:269-271`. WP-C implementer should verify the scroll context still behaves correctly during the replay → live transition (no need to write code).

---

### 4.7 `/root/projects/claude-terminal/CLAUDE.md` (WP-A, doc fix)

| Property | Value |
|---|---|
| **Owning WP** | WP-A |
| **Read/Write status for other WPs** | None |
| **Estimated LoC change** | 1 line modified, ~6 lines added |
| **New imports** | N/A |
| **New dependencies** | N/A |

**Sections affected.** Line 28 contains the stale "Replay buffer: 500KB circular" claim. Phase 7 (WP-A) replaces it and adds a paragraph documenting the new protocol contract.

BEFORE (line 28):
```
**terminal-manager.js** — Manages PTY sessions via tmux. CLI runs inside `tmux -L claude-terminal` sessions that survive server restarts/deploys. node-pty attaches lazily (on first client connect). Tracks WebSocket clients, handles session lifecycle (create/stop/resume/delete/rename). Persists metadata to `~/.sessions.json`. Watches file for cross-instance sync during blue-green deploy. Replay buffer: 500KB circular.
```

AFTER:
```
**terminal-manager.js** — Manages PTY sessions via tmux. CLI runs inside `tmux -L claude-terminal` sessions that survive server restarts/deploys. node-pty attaches lazily (on first client connect). Tracks WebSocket clients, handles session lifecycle (create/stop/resume/delete/rename). Persists metadata to `~/.sessions.json`. Watches file for cross-instance sync during blue-green deploy. Replay buffer: chunk-list (≤2 MiB total) when `CT_RELIABLE_STREAMING=1`; legacy 2 MB string accumulator otherwise. New path uses seq+ack protocol (binary frames for live output, JSON for control), per-client async drain, 8 MiB `bufferedAmount` ceiling, ping/pong every 25 s. Snapshot on reconnect via `tmux capture-pane` (slow path) or chunk replay from `lastSeq` (fast path). See `agent-workflow/05-decision-tmux.md` for full protocol spec.
```

**Optional addition (after line 109, in the "Key files" table).** Add a row:
```
| `agent-workflow/06-integration-plan-tmux.md` | Phase 6 file-by-file plan for Robust-Lite streaming overhaul |
```

This is housekeeping only; WP-A may skip it if the doc table is considered out-of-scope for the streaming PR.

**Tests to add.** None — documentation change.

---

## 5. Migration order

The order is constrained by interface contracts: WP-B is purely physical (changes how tmux behaves, no protocol implications), WP-A introduces a new protocol behind a flag (so the new code path is dormant until explicitly enabled), WP-C is forward-compatible (works with old AND new servers).

### Step 1 — WP-B lands first (immediate)

- **PR scope.** `tmux.conf` only.
- **Pre-deploy verification.** Phase 7 (WP-B) runs the syntax check (`tmux -L claude-terminal-test -f tmux.conf new-session -d -s test 'sleep 1' && tmux -L claude-terminal-test kill-server`). If green, ship.
- **Deploy.** Standard `bash deploy.sh`. Existing tmux sessions stay on old config until next detach+reattach. New sessions immediately use the new config.
- **Validation.** Run `tmux -L claude-terminal show-options -g | grep -E '(window-size|aggressive-resize|focus-events|terminal-features|set-clipboard)'` and verify all values match expected.
- **Rollback.** `git revert tmux.conf`, `bash deploy.sh`. tmux config reload picks up the old values.
- **Bake time.** 24 h baseline observation: any user complaints about geometry, fullscreen redraws, fonts? If none, proceed to Step 2.

### Step 2 — WP-A lands behind flag, default OFF

- **PR scope.** `server.js` + `terminal-manager.js` + `CLAUDE.md` doc fix.
- **Pre-deploy verification.** Phase 7 (WP-A) runs the harness from §4.2. All asserts must pass.
- **Deploy.** Standard `bash deploy.sh` with `CT_RELIABLE_STREAMING=0` (or unset) in `ecosystem.config.js`. Behaviour identical to today (legacy code path).
- **Validation.** Smoke test: open session, run `tail -f`, run `vim`, deploy again — same UX as before.
- **Rollback.** `git revert` the WP-A commits (env flag is meaningless without the code).
- **Bake time.** 1 week of "new code in tree but not active" — verifies no accidental coupling between legacy path and new fields.

### Step 3 — WP-C lands

- **PR scope.** `Terminal.tsx` + `EphemeralTerminal.tsx`.
- **Pre-deploy verification.** Manual smoke test in dev: with WP-A flag OFF (legacy server), the new client must render correctly. Specifically:
  1. Open session, verify replay arrives as one `output` frame with no `seq`.
  2. Verify the 2 s legacy fallback timer fires (because no `replay_complete` ever arrives) → `term.clear()` runs → screen renders correctly.
  3. Reconnect, repeat.
- **Deploy.** Standard `bash deploy.sh`.
- **Validation.** Same UX as before. Console may show "[terminal] unknown message type" warnings if the server emits anything novel (it shouldn't), or "[terminal] non-JSON text frame received" warnings (also shouldn't happen). Either is a benign protocol drift signal.
- **Rollback.** `git revert` the WP-C commits.
- **Bake time.** 24-48 h. Both code paths (old client + new client) talking to old server (flag OFF). Verify no regressions.

### Step 4 — Flip flag to `1` on green

- **No code change.** Edit `ecosystem.config.js`: set `CT_RELIABLE_STREAMING=1` for the green PM2 entry only. `pm2 reload claude-terminal-green`. nginx upstream still pointing to blue (legacy).
- **Validation.** Use `?reliable=1` query param OR direct port (3001) to test green specifically. New WS connections to green run the new path; existing ones stay on whatever they were doing.
- **Bake time.** 24 h. Watch the per-stage gate metrics from `05-decision-tmux.md` §7:
  - Reconnect time p99 ≤ 500 ms (browser perf marks).
  - ≥ 80% reconnects use FAST_PATH (server log counter `[ct] fast_path_count vs slow_path_count`).
  - < 0.5% clients evicted per hour (server log counter `[ct] evictions`).
  - < 1% false-positive ws.terminate per 24 h (server log counter `[ct] ping_terminations`).

### Step 5 — Flip nginx to green

- **No code change.** Run `bash deploy.sh` — this naturally flips nginx to green and starts blue (which is still on flag=0 from Step 2). Now production traffic is on the new path.
- **Validation.** S1-S9 acceptance criteria from `05-decision-tmux.md` §4.
- **Bake time.** 24-48 h.

### Step 6 — Flip flag to `1` on blue too

- **No code change.** Edit `ecosystem.config.js`: set `CT_RELIABLE_STREAMING=1` for blue too. Now BOTH colors are on the new path. Subsequent deploys swap between two reliable-mode instances.
- **Bake time.** 1 week.

### Step 7 (Phase 7+ housekeeping ticket) — Remove legacy code

- After 1 week of full-flag stability, remove the legacy `attachToSession` path and the `CT_RELIABLE_STREAMING` flag. Out of scope for this rollout; tracked as separate ticket.

### Handshake / version-bump details

The "version-bump" is implicit:
- The new client always sends `{type:"hello", protocol_version:2, binary_capable:true, lastSeq:N}`.
- The new server responds with `{type:"resume",...}` or `{type:"snapshot",...}` followed by `{type:"replay_complete"}`.
- The OLD server silently ignores `hello` (its try/catch swallows unknown types) and responds with the legacy single-frame buffer dump → no `replay_complete`.
- The NEW client's 2 s timer fires → falls back to legacy mode → calls `term.clear()` → continues processing future `output` frames (with no `seq` field) by treating them as fire-and-forget.

There is NO formal version-negotiation handshake. The presence of `replay_complete` (or its absence after 2 s) IS the version detection. This keeps the protocol additive and avoids a "version not supported" failure mode.

---

## 6. Test plan

### 6.1 Unit / harness tests for the chunk-list buffer (WP-A)

- **File location.** `/root/projects/claude-terminal/agent-workflow/harness/replay-buffer-harness.js`.
- **Format.** Plain Node script with `process.exit(1)` on assertion failure. No test framework dependency.
- **Asserts.**
  1. **Push/eviction parity.** Push 10 MB of synthetic chunks (mix of 1 KiB / 8 KiB / 64 KiB sizes). After each push, assert `totalBytes(session.chunks) ≤ 2 * 1024 * 1024`.
  2. **Chunk integrity.** After eviction, `chunks[0].data` must equal the exact string passed to `pushChunk` for that chunk (no mid-byte slice). Use a recognizable per-chunk marker like `\x1b[38;5;${i % 256}m█` so any mid-CSI cut would produce a recognizable corruption pattern.
  3. **Seq monotonicity.** `chunks[i].seq < chunks[i+1].seq` for all `i`. `chunks[chunks.length - 1].seq + BigInt(chunks[chunks.length - 1].data.length) === session.totalSeq`.
  4. **PrunedSeq invariant.** `session.prunedSeq === chunks[0].seq` (when chunks non-empty).
  5. **Eviction at chunk granularity.** Force a single chunk push of 3 MiB (over cap). After push, `chunks` has exactly 1 entry of 3 MiB (or chunks size 0 + the new chunk if eviction is "shift then push" — Phase 7 implementer chooses the order; this assertion just ensures no slice).
  6. **chunksSince correctness.** With `totalSeq=1000`, `prunedSeq=200`: `chunksSince(500n)` returns chunks where seq > 500. `chunksSince(0n)` returns all chunks. `chunksSince(1000n)` returns empty array.
  7. **bufferedAmount eviction.** Mock a client with `bufferedAmount` set to 9 * 1024 * 1024 (above 8 MiB ceiling). On next `_drainClient`, assert `client.close(4503, "lagging")` was called and the client is removed from `session.clients`.

### 6.2 Integration tests (WP-A + WP-B + WP-C; manual repro)

Each test is an explicit reproduction script with a pass/fail criterion. Phase 7 implementers (or the deploy operator) execute these post-merge.

#### T1 — Rapid resize during heavy output

- **Setup.** Open session, run `seq 1 1000000 | nl`.
- **Action.** Drag browser window resize handle for 5 seconds.
- **Pass.** xterm.js renderer shows no out-of-place rows or escape fragments rendered as text. Server log shows ≤ 5 `pty.resize` calls during the drag (vs. dozens today).
- **Closes.** S6, S8.

#### T2 — 5 MB cat through pipeline

- **Setup.** `dd if=/dev/urandom bs=1 count=5000000 | base64 > /tmp/big.txt` on host. Open session.
- **Action.** Run `cat /tmp/big.txt`.
- **Pass.** All 5 MB renders without scramble. Server log shows no eviction (single-client; bufferedAmount stays under 8 MiB because client drains in real-time).
- **Closes.** S1.

#### T3 — Vim full-screen redraw

- **Setup.** Open session, run `vim /tmp/test.txt`.
- **Action.** Type `:set number`, then `i` to enter insert mode, then `Esc :q!`.
- **Pass.** Vim screen renders correctly. Cursor in correct cell. No leftover "~" markers from vim's tildes.
- **Closes.** S3 (alt-screen handling).

#### T4 — Reconnect mid-stream

- **Setup.** Open session, run `tail -f /var/log/syslog`.
- **Action.** Open DevTools → Network → toggle Offline → wait 10 s → toggle back online.
- **Pass.** Within 500 ms of reconnect, screen shows the EXACT continuation of `tail -f`. No duplicated lines, no missing lines. `lastSeqRef.current` (logged in dev) advances continuously across the gap.
- **Closes.** S2, S4.

#### T5 — Blue/green flip during vim

- **Setup.** Open session, run `vim /etc/hosts`.
- **Action.** Run `bash deploy.sh` from a separate shell.
- **Pass.** Within 10 s the browser shows the EXACT vim screen (cursor in same cell, same content, same colors). Screenshot diff ≤ 2% pixel diff.
- **Closes.** S3.

#### T6 — Slow client cannot block fast client

- **Setup.** Open session in two browser tabs (Tab A and Tab B).
- **Action.** In Tab A: DevTools → Network → throttle to "Slow 3G" (100 KB/s). In session: `cat /tmp/big.txt` (the 5 MB file from T2).
- **Pass.** Tab B keeps displaying live output at full rate. Tab A receives `close(4503, "lagging")` within 5 s and reconnects with `lastSeq` resume.
- **Closes.** S5.

#### T7 — Half-open TCP detected

- **Setup.** Open session.
- **Action.** On host: `iptables -A OUTPUT -p tcp --dport 443 -j DROP` (or equivalent on 3000/3001). Wait 90 s.
- **Cleanup.** `iptables -D OUTPUT -p tcp --dport 443 -j DROP`.
- **Pass.** Within 60 s, client `ws.onclose` fires (because server's ping timeout terminates the socket). Reconnect attempted.
- **Closes.** S7.

#### T8 — Multi-tab divergence detection

- **Setup.** Open same session in two tabs.
- **Action.** Run a deterministic output: `for i in $(seq 1 1000); do printf '\033[38;5;%dm%04d\033[0m\n' $((i % 256)) $i; done`.
- **Pass.** Both tabs show identical output. Use the divergence detection tool from §6.3 to confirm `serializeAddon.serialize()` outputs match.

#### T9 — `replay_complete` barrier integrity

- **Setup.** Instrument `Terminal.tsx`'s `replay_complete` handler with `console.time/console.timeEnd` markers.
- **Action.** Reconnect 10 times consecutively (kill WS, wait 1 s, reconnect).
- **Pass.** Each reconnect's "onopen → replay_complete" duration is measured. p99 ≤ 500 ms.
- **Closes.** S4.

### 6.3 Divergence detection method

To prove that what xterm.js renders matches what tmux holds:

1. Add a temporary debug command to the dev console (Phase 7 WP-C, gated behind `process.env.NODE_ENV === "development"`):

```ts
window.__ctDiff = async () => {
  // Get xterm rendered state via SerializeAddon (only works if installed)
  // Since SerializeAddon is NOT installed in the project (per 05-decision §5 C14 rejected),
  // we use the simpler approach: dump term.buffer.active line-by-line.
  const term = (window as any).__ctTerm;  // Phase 7 exposes this in dev mode
  const lines = [];
  for (let i = 0; i < term.buffer.active.length; i++) {
    lines.push(term.buffer.active.getLine(i)?.translateToString(true) || "");
  }
  return lines.join("\r\n");
};
```

2. On the server, expose a debug endpoint (Phase 7 WP-A, gated behind `process.env.NODE_ENV === "development"`):

```js
// In server.js or a new debug route
if (req.url === "/api/debug/snapshot" && process.env.NODE_ENV !== "production") {
  const sessionId = url.parse(req.url, true).query.sessionId;
  const snap = execFileSync("tmux", ["-L", "claude-terminal", "capture-pane", "-p", "-t", sessionId, "-S", "-"], { encoding: "utf-8" });
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(snap);
  return;
}
```

3. Diff with allowed delta = whitespace-only. The Phase 7 implementer chooses the diff tool (`diff -w`, JS diff library, etc.). The acceptance is "no visible cell differs"; trailing whitespace per row is permissible because xterm.js trims trailing spaces in `translateToString`.

This is a development-mode diagnostic, not a production health check. It exists to validate S1 and S9 manually post-deploy.

---

## 7. Rollback plan

### 7.1 Per-session escape hatch (DEV only)

Already specified in `05-decision-tmux.md` §7: client passes `?reliable=0` query param on the WS upgrade. Server checks `if (process.env.NODE_ENV !== "production" && query.reliable === "0")` and uses the legacy path for that session only. NOT exposed in production UI.

WP-A implementer wires this in the upgrade handler at `server.js:158-189`:

```js
const useReliable = RELIABLE_STREAMING && !(query.reliable === "0" && process.env.NODE_ENV !== "production");
if (useReliable) {
  terminalManager.attachToSessionV2(sessionId, ws);
} else {
  terminalManager.attachToSession(sessionId, ws);
}
```

### 7.2 Global env-var rollback

```bash
# Edit ecosystem.config.js: set CT_RELIABLE_STREAMING=0 for both colors
pm2 reload claude-terminal-blue claude-terminal-green
```

New WS connections immediately use legacy path. Existing connections finish out on whatever path they started on (closing them via `pm2 reload` would be disruptive; let them drain naturally — they will reconnect and pick up the new flag value).

**Observability during rollback.** Server logs should show the count of legacy-path-attaches vs new-path-attaches. WP-A implementer adds a counter:

```js
// In TerminalManager constructor:
this.attachCounters = { v1: 0, v2: 0 };
// In attachToSession: this.attachCounters.v1++;
// In attachToSessionV2: this.attachCounters.v2++;
// Periodically log: setInterval(() => console.log(`[ct] attaches v1=${this.attachCounters.v1} v2=${this.attachCounters.v2}`), 60000);
```

### 7.3 Code-level rollback (env-var rollback insufficient)

`git revert` the WP-A and WP-C commits independently. They are file-disjoint (per §1) so the reverts cannot conflict. WP-B (`tmux.conf`) requires existing tmux sessions to detach+reattach to pick up the revert; document in the runbook to expect a one-deploy lag for some users.

### 7.4 Data safety

Nothing is persisted across deploys (per `05-decision-tmux.md` §2 D-Q12 — in-memory only, tmux is the cross-instance source of truth). Rollback is stateless. The chunk list is wiped on process restart; the next attach bootstraps from `tmux capture-pane`.

---

## 8. Work-package partitions (final, frozen)

This section is the binding partition. Phase 7 implementer agents must respect file ownership: any cross-WP write requires a coordination request (per `05-decision-tmux.md` §10).

### 8.1 WP-A — Server transport

| Property | Files |
|---|---|
| **OWNED (write access)** | `/root/projects/claude-terminal/server.js` (lines 158-189, 272-307) |
| | `/root/projects/claude-terminal/terminal-manager.js` (entire file) |
| | `/root/projects/claude-terminal/CLAUDE.md` (line 28 only — replay-buffer doc fix) |
| | `/root/projects/claude-terminal/agent-workflow/harness/replay-buffer-harness.js` (NEW; self-contained test script) |
| **READ-ONLY REFERENCE** | `/root/projects/claude-terminal/src/components/Terminal.tsx` (for protocol shape contract — §2 of this plan) |
| | `/root/projects/claude-terminal/src/components/EphemeralTerminal.tsx` (same) |
| | `/root/projects/claude-terminal/tmux.conf` (for sizing/config awareness — `default-size 200x50`) |
| | `/root/projects/claude-terminal/agent-workflow/05-decision-tmux.md` (binding decisions) |
| | `/root/projects/claude-terminal/agent-workflow/06-integration-plan-tmux.md` (this plan) |
| **MUST NOT TOUCH** | `/root/projects/claude-terminal/presence-manager.js` (separate WSS instance, out of scope) |
| | `/root/projects/claude-terminal/chat-manager.js` (separate WSS instance, out of scope) |
| | `/root/projects/claude-terminal/symphony-orchestrator.js` (separate WSS instance, out of scope) |
| | `/root/projects/claude-terminal/deploy.sh`, `ecosystem.config.js`, `package.json` |
| **Dependencies on other WPs** | None at code level. WP-A's protocol spec (§2 of this plan) is the contract WP-C reads. WP-A may proceed independently; WP-C must read this plan, not WP-A's source. |

### 8.2 WP-B — tmux glue

| Property | Files |
|---|---|
| **OWNED (write access)** | `/root/projects/claude-terminal/tmux.conf` (entire file) |
| **READ-ONLY REFERENCE** | `/root/projects/claude-terminal/terminal-manager.js` (for the snapshot helper integration contract — §3.5 of this plan) |
| | `/root/projects/claude-terminal/agent-workflow/05-decision-tmux.md` |
| | `/root/projects/claude-terminal/agent-workflow/06-integration-plan-tmux.md` (this plan, §4.3) |
| | `/etc/nginx/sites-available/claude-terminal` (informational; verify no `proxy_buffering` changes needed — none are) |
| **MUST NOT TOUCH** | All other files. WP-B is config-only. |
| **Dependencies on other WPs** | None. WP-B can ship first (Step 1 in §5). |

### 8.3 WP-C — Browser client

| Property | Files |
|---|---|
| **OWNED (write access)** | `/root/projects/claude-terminal/src/components/Terminal.tsx` (entire file) |
| | `/root/projects/claude-terminal/src/components/EphemeralTerminal.tsx` (entire file) |
| | `/root/projects/claude-terminal/src/lib/TerminalScrollContext.tsx` (NO CHANGES expected per §4.6, but listed for completeness) |
| **READ-ONLY REFERENCE** | `/root/projects/claude-terminal/server.js` (for protocol contract — §2 of this plan) |
| | `/root/projects/claude-terminal/terminal-manager.js` (same) |
| | `/root/projects/claude-terminal/src/components/presence/CursorOverlay.tsx` (informational — uses scroll context, must not regress) |
| | `/root/projects/claude-terminal/agent-workflow/05-decision-tmux.md` |
| | `/root/projects/claude-terminal/agent-workflow/06-integration-plan-tmux.md` (this plan, §4.4 and §4.5) |
| **MUST NOT TOUCH** | `/root/projects/claude-terminal/server.js`, `terminal-manager.js`, `tmux.conf`. |
| | All other `src/components/**` and `src/lib/**` files. |
| | `package.json` (no new deps). |
| **Dependencies on other WPs** | The protocol spec (§2 of this plan) is the contract. WP-C consumes it; WP-A produces it. WP-C should land AFTER WP-A's PR is in tree (so the new client can be sanity-tested against the new server in dev), but is not strictly blocked by it (WP-C is forward-AND-backward compatible per §2.8 matrix). |

### 8.4 Conflict-free guarantee (final)

| File | WP-A | WP-B | WP-C |
|---|---|---|---|
| `server.js` | OWN | — | RO |
| `terminal-manager.js` | OWN | RO | RO |
| `tmux.conf` | RO | OWN | — |
| `Terminal.tsx` | RO | — | OWN |
| `EphemeralTerminal.tsx` | RO | — | OWN |
| `TerminalScrollContext.tsx` | — | — | OWN (no edit expected) |
| `CLAUDE.md` | OWN (line 28) | — | — |
| `presence-manager.js` | DO NOT TOUCH | — | — |
| `chat-manager.js` | DO NOT TOUCH | — | — |
| `symphony-orchestrator.js` | DO NOT TOUCH | — | — |
| `deploy.sh`, `ecosystem.config.js`, `package.json` | DO NOT TOUCH | DO NOT TOUCH | DO NOT TOUCH |
| `agent-workflow/harness/replay-buffer-harness.js` | OWN (NEW) | — | — |

No two partitions write the same file. The integration plan (this document) is read-only for all three WPs.

---

## 9. Acceptance criteria (verbatim from `05-decision-tmux.md` §4)

The following are restated as the implementation target. Each one maps to a P-ID closed.

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

S1, S2, S3, S5, S6, S7 are the user's "раз и навсегда" acceptance set. S4, S8, S9 are quality-of-implementation gates.

---

## 10. Implementation sequencing notes (final)

### 10.1 What Phase 7 implementers SHOULD do

- Read `05-decision-tmux.md` and this plan in full BEFORE writing any code.
- For WP-A: write the harness from §4.2 FIRST, then implement to pass it. This is test-driven for the chunk-list semantics.
- For WP-B: verify the tmux config syntax with the throwaway-socket sanity check BEFORE shipping.
- For WP-C: dev-test against the OLD server (flag OFF) FIRST to verify the legacy fallback path works. Then test against the NEW server.
- All three: keep diffs tightly scoped to the per-file plan in §4. Resist the urge to "improve" adjacent code.

### 10.2 What Phase 7 implementers MUST NOT do

(Restated and extended from `05-decision-tmux.md` §10.3.)

- **DO NOT** introduce a third broadcast pattern. The per-client async drain in WP-A is the canonical fan-out for the new path; legacy path keeps its synchronous loop. Do not invent a hybrid.
- **DO NOT** persist `session.totalSeq` to disk. Cross-instance flips use snapshot-on-reconnect; per-instance seq epochs are intentional.
- **DO NOT** add tmux commands that would only work on `-CC` (`refresh-client -C`, `send-keys -l`). We are explicitly on raw attach.
- **DO NOT** convert ephemeral terminal to use the new chunk-list path. Ephemeral stays on legacy server-side; client-side gets only the binary parsing + debounce + warn-instead-of-write.
- **DO NOT** silently drop unknown WS message types. Add explicit `default:` branches with `console.warn`.
- **DO NOT** change the existing token endpoint, auth flow, or 4401/4404 close codes.
- **DO NOT** touch `chat-manager.js`, `presence-manager.js`, `symphony-orchestrator.js`. Cross-contamination expands the blast radius beyond the terminal channel.
- **DO NOT** add new npm dependencies. The whole bundle ships with zero new deps.
- **DO NOT** install `@xterm/addon-serialize` or `@xterm/addon-webgl`. Both are deferred per `05-decision-tmux.md` §9.
- **DO NOT** call `term.reset()` on every reconnect. Reset is reserved for the snapshot-apply path; resume-path does not reset. Calling reset on FAST_PATH would wipe the screen and force a full snapshot fork — defeating the seq-resume optimization.
- **DO NOT** switch `node-pty` from string mode to Buffer mode. Per `05-decision-tmux.md` §8 risk #3, non-UTF-8 app output is accepted as lossy. Buffer mode would require switching the entire pipeline; out of scope.

### 10.3 Where this plan intentionally leaves ambiguity

The Phase 7 implementer must choose:

1. **Whether to cache `session.chunkBytes` for O(1) totalBytes.** §3.4 documents both approaches; the harness assertions are independent of which is chosen. Recommendation: ship the cached version because it's a 10-LoC delta and avoids a hot-path O(N) reduce. But the naive version will pass all asserts.

This is the ONE place where the plan does not prescribe the exact code shape. Every other decision point is closed.

---

End of `06-integration-plan-tmux.md`.
