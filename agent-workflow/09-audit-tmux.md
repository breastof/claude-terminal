# 09 — Audit: User-Intent Closure (tmux streaming)

> Phase 9 deliverable for `auditor-user-intent-tmux`.
> Goal: verify that the shipped Phase-7 implementation actually addresses the
> user's original complaint about tmux streaming, not adjacent issues.
> Scope: read-only — no source edits, no deploy. Walks each pain point through
> the chain: complaint → root cause (Phase 2) → decision (Phase 5) → code
> evidence (Phase 7 + actual file:line) → validation evidence (Phase 8).

User's verbatim complaint (Russian):
> "меня достал ломающаяся трансляция tmux. постоянно все не так как в
> терминале отображается и ломается, как будто пакеты теряются какие-то.
> я хочу прям это исправить раз и навсегда."

Translation: tmux streaming is broken. The browser xterm output diverges
from real tmux constantly, as if WS packets are being lost. He wants this
PERMANENTLY fixed.

---

## 1. Verdict header

**Overall: PARTIAL** (favouring PASS in code, but BLOCKED in default
production runtime).

The Phase-7 implementation is structurally sound: every primary failure
mode the user described maps to a binding decision in Phase 5, every
decision lands as concrete code at the cited file:line, and the Node-only
behavioural harness exercises the load-bearing data-structure invariants
(20/20 PASS). The chunk-list buffer makes mid-CSI cuts impossible by
construction; the seq+ack/per-client cursor closes multi-client divergence
and the snapshot/resume race; the bufferedAmount ceiling closes the
slow-client poison vector; and the protocol-level ping/pong closes
half-open-TCP. Read at the source level, the user's "пакеты теряются"
hazard class is genuinely structurally eliminated — provided the new code
path actually runs.

The reason this is PARTIAL not PASS:

1. **The fix is feature-flagged OFF by default** and `ecosystem.config.js`
   does NOT set `CT_RELIABLE_STREAMING=1` for either blue or green
   (`/root/projects/claude-terminal/ecosystem.config.js:7-10, 27-30`). After
   a vanilla `bash deploy.sh`, the legacy path with the unsafe
   `slice(-2_000_000)` (`terminal-manager.js:430-432`) and the synchronous
   `for (client of session.connectedClients) client.send(...)` broadcast
   (`terminal-manager.js:433-437`) is what serves the user's traffic. The
   user's pain is NOT yet permanently fixed in the running system — the
   fix exists in code, the operator has to flip a flag.
2. **The validation harness is Node-only** — it directly exercises chunk
   list, eviction, drain, and routing logic but cannot prove S1/S2/S3/S4/
   S6/S7 (the user-facing acceptance criteria) end-to-end. A real-device
   soak (Phase 8 validator's "biggest unknown") is still required before
   "раз и навсегда" can be called true in production.
3. **Two implementer-acknowledged deviations remain in code**: control
   envelopes (`exit`/`stopped`/`error`) and the initial replay loops
   bypass the per-client async drain (`terminal-manager.js:550-557`,
   `:1042-1102`). Both are LOW-severity and cannot regress data
   integrity, but they violate the plan's "single broadcast pattern" rule
   from §10.3 and could allow a slow client's `bufferedAmount` to briefly
   exceed the 8 MiB ceiling on initial reconnect.

If the operator flips `CT_RELIABLE_STREAMING=1` and runs a real-device S1/
S2/S5/S7 soak with green outcomes, this audit upgrades cleanly to PASS.
Until that happens, the user's terminal still streams via the same buggy
code path he complained about.

---

## 2. Per-pain-point audit table

| # | Pain point (user's words / failure mode) | Root cause (Phase 2 ref) | Decision (Phase 5) | Implementation evidence (post-Phase-7 file:line) | Validation evidence | Verdict |
|---|---|---|---|---|---|---|
| 1 | "ломается" — mid-ANSI-escape cut on replay buffer trim | `02-scan-pty.md` §5.5, §6.2 H2 (ACCEPTED): `terminal-manager.js:295-296` `slice(-2_000_000)` is escape-unaware; the trimmed buffer is shipped verbatim to a reconnecting client at `terminal-manager.js:507`. | D-Q1 YES (chunk list + per-client cursor); D-Q2 YES (capture-pane snapshot replaces raw replay on slow-path reconnect). | Chunk-list `_pushChunk` at `terminal-manager.js:487-499` evicts **whole chunks** at chunk granularity (`session.chunks.shift()`) — a chunk is never sliced. `_chunksSince` (`:503-509`) returns chunks verbatim. Snapshot helper `tmuxSnapshot` (`:67-140`) wraps `tmux capture-pane -p -e -J` output with `\x1b[2J\x1b[H` clear-home + cursor-position append, so a SLOW_PATH replay is well-formed by construction. The legacy `slice(-2_000_000)` at `:430-432` is preserved verbatim and runs **always** — only the new path adds the chunk list on top. | Behavioural harness §1b: pushed 50 × 64 KiB chunks into 2 MiB cap → exactly 32 × 64 KiB survive, every chunk's `data.length === 65536`, no slice. §2a: built 580-byte stream with CSI/OSC/SGR sequences, sliced at 10 cut points many of which fall inside CSI; concatenation of `_chunksSince(-1n)` is byte-identical to the original. §2b: every surviving SGR-wrapped chunk starts with full `\x1b[38;5;` and ends with full `\x1b[0m` after eviction. | **STRUCTURAL FIX (when flag on)** — the data structure cannot express the bug. **NOT IN EFFECT (flag off)** — legacy `slice(-2_000_000)` still runs in default production. |
| 2 | "ломается" — reconnect race: replay+live interleave (snapshot tail and live deltas overlap → duplication) | `02-scan-pty.md` §5.6, §6.9 H9 (ACCEPTED); `02-scan-ws.md` §6.2 #10. Snapshot is "the buffer as of the synchronous send call at `:507`" while subsequent live `onData` chunks may already be in the snapshot AND broadcast as live → duplication. | D-Q4 YES (seq+ack `{type:"hello", lastSeq}` + `replay_complete` barrier + per-client cursor). | `attachToSessionV2` (`terminal-manager.js:884-1022`) routes by `lastSeq`: FAST_PATH `_sendResumePath` (`:1042-1069`) emits `{resume, from}` then chunks where `seq > lastSeq` then `{replay_complete}`; SLOW_PATH `_sendSnapshotPath` (`:1071-1102`) emits `{snapshot, seq, data, cursor, cols, rows}` with `seq = session.totalSeq` (epoch) then `{replay_complete}`. Client `Terminal.tsx:307-340` writes the snapshot via `term.write(text, () => updateLastSeq(seq))` so the seq advances only after the parser drains; live `output` frames (`:308-321`) carry their own `seq` and update `lastSeqRef` per byte. Browser tracks `lastSeq` in `sessionStorage` (`Terminal.tsx:30-52`) so a same-tab reload triggers FAST_PATH. | Harness §1d: routing matrix proven across `lastSeq=0/prunedSeq-1/prunedSeq/totalSeq-1/totalSeq/totalSeq+1` — strict inequality respected. §6b: `_sendSnapshotPath` invariant verified against stub: `{snapshot, seq:"500", data, cols, rows, cursor}` then `{replay_complete}` in that order, `clientRec.lastSentSeq` advances to 500n. §7a: 100 random-sized chunks → seqs strictly ascending and `last.seq + last.data.length === totalSeq`. | **STRUCTURAL FIX (when flag on)** — every byte has a globally unique address; duplication is undetectable only because there is none to detect. **NOT IN EFFECT (flag off)** — legacy snapshot-then-live race still runs by default. |
| 3 | "ломается" — blue/green flip drift (deploy switches nginx upstream; new instance has different in-memory replay state from the old) | `02-scan-pty.md` §6.6 H6 (ACCEPTED); `02-scan-ws.md` §7 H4 (PARTIAL ACCEPT): old server's in-flight `onData` lost, dual-attach during overlap can double redraws, new instance's `session.buffer` is from `tmuxCapture(-1)` — bytes already on the OLD client's xterm reappear on reconnect. | D-Q12 NO (in-memory only — tmux IS the cross-instance source of truth); D-Q4 + D-Q2 (snapshot path is authoritative across the flip; client's stored `lastSeq` from old epoch falls through to SLOW_PATH cleanly). | `_sendSnapshotPath` (`:1071-1102`) calls `tmuxSnapshot(sessionId)` (`:67-140`) which runs `tmux capture-pane -p -e -J -S - -E - [-a]` — well-formed by construction (alt-screen detection at `:67-79`, CRLF-normalise at `:99`, cursor at `:101-115`, geometry at `:117-131`). `attachToSessionV2` routing at `:982-986` falls through to SLOW_PATH when `lastSeq` is from a prior epoch (`lastSeq > totalSeq`, since the new instance starts at `totalSeq=0n`). Test 1d in the harness directly verifies "lastSeq>totalSeq → SLOW" (the cross-instance epoch case). | Harness §6a: real `tmuxSnapshot` invocation against probe socket — `data` starts with `\x1b[2J\x1b[H`, ends with `\x1b[Y;XH`; cursor/cols/rows/alternate present with correct types. §1d: `lastSeq>totalSeq → SLOW` — exactly the blue/green flip case. **NOT END-TO-END VERIFIED**: no actual `bash deploy.sh` was executed during Phase 8 (validator hard-constrained out of running deploy or pm2 commands, see `08-validate-behavior-tmux.md` "Constraints honoured"). | **STRUCTURAL FIX (when flag on, by indirection through tmux)** — the snapshot path produces a self-contained replay independent of in-memory state; the seq epoch reset is detected and routed correctly. **PARTIAL** — visual continuity across the flip relies on `tmux capture-pane`-rendered scrollback being a faithful representation; alt-screen apps (vim/htop) are now `-a` flagged but cursor visibility / mouse mode sequences are not in the snapshot (per `05-decision-tmux.md` §8 risk #18). **NOT IN EFFECT (flag off)** — legacy in-memory replay drift unchanged. |
| 4 | "ломается" — multi-client divergence (two browser tabs on same session; replay snapshot at attach is whatever the buffer happens to be at call time) | `02-scan-ws.md` §5.4 #1, §7 H3 (ACCEPTED): one shared `session.buffer`; new attach gets snapshot ending at "now"; live deltas overlap with snapshot tail; no per-client cursor. | D-Q1 + D-Q11 YES (per-client `ClientRecord` with `lastSentSeq` + own queue + own drainScheduled). | `session.clients = new Map<WebSocket, ClientRecord>` allocated in `_makeSession` (`terminal-manager.js:262`) and `createSession` (`:650`). `_registerClientV2` (`:1024-1037`) creates a fresh record per attach: `{ws, lastSentSeq, queue, drainScheduled, binaryCapable, isAlive}`. Hot-path fan-out at `:442-450` pushes the SAME chunk into every client's queue then `setImmediate(_drainClient)` — each client drains independently. `_drainClient` (`:512-545`) reads only its own `clientRec.queue`/`bufferedAmount`/`lastSentSeq`; on dead/lagging it deletes only itself from `session.clients`. | Harness §3a: three synthetic clients with different `lastSeq` — each sees only its own missed tail. §3b: three real `_registerClientV2` records — distinct queue/lastSentSeq references; pushing into A doesn't show up in B/C; deleting A leaves B/C intact. §4a: drain queues rather than send-spamming when bufferedAmount low; §4c: drain on dead ws drops only that client. | **STRUCTURAL FIX (when flag on)** — per-client state is isolated by data structure. **NOT IN EFFECT (flag off)** — `session.connectedClients` Set with shared `session.buffer` still runs by default. |
| 5 | "пакеты теряются" — no backpressure → slow client's `bufferedAmount` blows up or writes get silently dropped during socket CLOSING transition | `02-scan-ws.md` §3.1, §3.2, §3.3, §6.1 #1-#2, §7 H1 (ACCEPTED). Zero `bufferedAmount` checks in the codebase; producer rate decoupled from consumer rate; `ws.send` after CLOSING is silent drop. | D-Q10 YES `bufferedAmount` ceiling at 8 MiB (NO PAUSE/RESUME — drop slow client + seq-resume on reconnect). | `_drainClient` at `terminal-manager.js:520-525` — before each per-client send checks `if (clientRec.ws.bufferedAmount > BUFFERED_CEILING) { ws.close(4503, "lagging"); session.clients.delete(...); evictions++; return; }`. Constants `BUFFERED_CEILING = 8 * 1024 * 1024` (`:13`). Send-throw path also drops the client (`:537-542`). Pre-send `readyState !== 1` check at `:515-519` correctly handles CLOSING transition (queues are cleared, client deleted). Client side: `Terminal.tsx:542-546` treats code 4503 as a normal reconnect (no special bail), and on reopen sends `{hello, lastSeq}` (`:474-485`) so the kicked client resumes via FAST_PATH from its stored `lastSeq` — no data loss visible to user. | Harness §4a: `bufferedAmount=0` → 3 chunks sent in one cycle, queue empty, `lastSentSeq=3n`, no `close()`. §4b: `bufferedAmount = 8 MiB + 1` → immediate `close(4503, "lagging")` BEFORE sending, removes client from `session.clients`, `evictions++`. §4c: `readyState=3` → short-circuits without sending and removes client. | **STRUCTURAL FIX (when flag on)** — backpressure is observable, eviction is graceful (seq-resume reconnect), producer rate is never throttled by slowest consumer. **NOT IN EFFECT (flag off)** — zero `bufferedAmount` references on legacy path; producer still couples to slowest consumer. **PARTIAL DEVIATION**: initial replay (`_sendResumePath`/`_sendSnapshotPath`) and `_broadcastControlV2` bypass `_drainClient` so they don't honour the ceiling — see §4 caveats. |
| 6 | "пакеты теряются" — half-open TCP undetected (cellular handoff, NAT timeout under 24 h proxy_read_timeout) | `02-scan-ws.md` §1.7, §7 H6 (ACCEPTED). No application-layer ping/pong; no `ws.ping()` server-side; no `isAlive` watchdog; users see "frozen terminal" until manual reload. | D-Q6 YES (protocol-level `ws.ping()` every 25 s + `ws.on('pong', () => isAlive=true)` watchdog; terminate at next tick if no pong). | Constructor at `terminal-manager.js:232-236` starts `setInterval(_heartbeatTick, HEARTBEAT_INTERVAL_MS)` with `unref()` when flag is on. `_heartbeatTick` (`:563-591`) iterates BOTH `session.clients` (V2) and `session.connectedClients` (legacy — protocol-level ping is transparent, free upgrade); for each client checks the prior tick's `isAlive` flag, terminates if false (counter `pingTerminations++`), else sets `isAlive=false` and `ws.ping()`. Pong listener wired in `_registerClientV2` (`:1034`) and in legacy `attachToSession` (`:766-767`, `ws._ctIsAlive = true`). `destroy()` at `:357-367` clears the interval on shutdown. Constants `HEARTBEAT_INTERVAL_MS = 25_000` (`:14`). | Harness §5a: `HELLO_TIMEOUT_MS = 2000` confirmed. The heartbeat interval is set up correctly (constructor at `:232-236` + `destroy()` at `:357-367`) but the harness explicitly does NOT exercise the watchdog under real network failure — `08-validate-behavior-tmux.md` lists S7 ("half-open TCP within 90 s") as INDIRECT/code-reviewed only. | **STRUCTURAL FIX (when flag on)** — dead-connection detection is a periodic invariant, not a hope. **PARTIAL** — code is correct but not exercised against a real iptables-DROP scenario; the validator flagged S7 as needing real-device verification. **NOT IN EFFECT (flag off)** — heartbeat is gated by `if (this.reliableStreaming)` at constructor `:232`. |
| 7 | "пакеты теряются" — fire-and-forget `term.write` (out-of-order under high throughput) + parser-state hangover from interrupted CSI | `02-scan-client.md` §2.3, §4.1, §10. All 8 `term.write` sites fire-and-forget; `ResizeObserver` fit-storms during keyboard show/hide; `term.clear()` instead of `term.reset()` preserves parser state, SGR, alt-screen flag from prior died-mid-CSI connection. | D-Q7 YES (chain ONLY at snapshot→live boundary — `replay_complete`); D-Q8 YES (`term.reset()` instead of `term.clear()` on snapshot path); D-Q9 YES (debounce client + server-side equality coalesce); D-Q13 YES (tmux `window-size manual` kills the storm at the physics layer). | Snapshot dispatch in `Terminal.tsx:268-284` (binary OPCODE_SNAPSHOT) and `:323-340` (text snapshot): `term.reset()` then `term.write(text, () => updateLastSeq(seq))` — chained callback per `05 §D-Q7`. `replay_complete` handler at `:360-379` runs on rAF: `fitAddon.fit() + term.scrollToBottom() + setReconnecting(false)`. Resize debounce at `:725-730`: `setTimeout(doResize, 80)` with local `lastSentCols/lastSentRows` equality coalesce at `:710-720`. Server-side coalesce at `terminal-manager.js:1131-1140`: `if (message.cols === session.cols && message.rows === session.rows) break;`. tmux.conf at `:65-67`: `window-size manual` + `default-size "200x50"` + `setw -g aggressive-resize off` — the load-bearing physics-layer change. | Harness §6b: snapshot ordering verified — snapshot frame then `replay_complete` in that order. Resize debounce and tmux config changes are NOT directly exercised by the Node harness (S6 / S8 marked INDIRECT). tmux config validation in `07-impl-tmux-WP-B.md` §4: `start-server` parse OK, `source-file` returns 0, every spec'd directive applied. | **STRUCTURAL FIX (when flag on for client-server contract)** — the snapshot→live boundary has an explicit barrier, parser is fully reset, resize storms are killed at three layers (client debounce + server coalesce + tmux fixed geometry). **PARTIAL** for live-output ordering: live `term.write` calls remain fire-and-forget per the explicit decision in D-Q7 (single-threaded JS guarantees order; chaining every chunk would needlessly serialize the pipeline). **PARTIAL FOR TMUX CONFIG**: existing tmux sessions on the host need detach+reattach to pick up the new config (`07-impl-tmux-WP-B.md` §1, also `05 §8 risk #8`) — first deploy is half-effective for in-flight sessions. **NOT IN EFFECT (flag off)**: server-side resize coalesce is in `_handleSteadyStateMessage` which is V2-only; legacy `attachToSession.message` handler at `terminal-manager.js:821-825` still resizes per message with no equality check. |

---

## 3. "Раз и навсегда" assessment (per pain point)

User wants "permanently fixed" — not "less likely after a patch". For each
verdict above, judge whether the fix is structural (eliminates the bug
class) or merely patched (might come back).

| # | Pain point | Structural / Patched / NOT FIXED | Justification |
|---|---|---|---|
| 1 | Mid-ANSI-escape cut on replay | **STRUCTURAL** (when flag on) | The chunk list never slices inside a chunk. Eviction is at chunk granularity (`session.chunks.shift()`). For a regression to reappear, someone would have to rewrite `_pushChunk` to do `string.slice` again — a class of code that no longer exists in the V2 path. Snapshot uses `tmux capture-pane -p -e -J` which emits well-formed ANSI per cell by tmux's own contract. The bug is structurally inexpressible in this code path. |
| 2 | Reconnect race: replay+live interleave | **STRUCTURAL** (when flag on) | Every byte has an absolute monotonic `seq`. The client cannot show the same `seq` twice because it has nowhere to store "last applied seq" twice. The snapshot frame carries `seq = session.totalSeq` (the epoch boundary); subsequent live frames carry `seq > totalSeq`. Duplication and reorder are structurally undefined in this protocol. |
| 3 | Blue/green flip drift | **STRUCTURAL via tmux + PARTIAL on visual fidelity** | The architecture deliberately makes tmux the cross-instance source of truth and bootstraps the new instance's snapshot from `tmux capture-pane`. There is no in-memory state to lose. The seq epoch resets are detected (`lastSeq > totalSeq` → SLOW_PATH). However: visual fidelity across the flip depends on `tmux capture-pane` faithfully representing the prior screen — for alt-screen apps with cursor visibility / mouse mode / DECSET sequences not in the scrollback (per `05-decision-tmux.md` §8 risk #18), the user may see brief artifacts until the app re-emits state. For Claude CLI (which always re-emits on prompt cycle) this is acceptable. |
| 4 | Multi-client divergence | **STRUCTURAL** (when flag on) | Per-client `ClientRecord` is the literal data structure for "this client's state." There is no shared mutable surface that one client's slowness can leak into another's view. `_drainClient` reads only its own `clientRec`. |
| 5 | No backpressure → slow-client poison | **STRUCTURAL** (when flag on) | `bufferedAmount > 8 MiB → close(4503) + remove from clients`. The producer (`onData`) is never throttled by the slowest consumer because the per-client queue absorbs and the eviction is the safety valve. The kicked client's seq-resume on reconnect means no observable data loss to the user. **DEVIATION**: initial replay loops and control envelopes bypass `_drainClient` (deviations in §4 below) — these can briefly let `bufferedAmount` exceed the ceiling on the FIRST chunk after attach before the next live chunk triggers eviction. Severity LOW. |
| 6 | Half-open TCP undetected | **STRUCTURAL via periodic protocol** (when flag on) | `setInterval(25_000)` ping is a periodic invariant; if a connection is dead, the watchdog notices within one cycle (max 50 s before terminate). For a regression, someone would have to disable the heartbeat or remove the pong listener — a structural change, not a coincidence. |
| 7 | Fire-and-forget `term.write` + parser hangover + resize storm | **STRUCTURAL on the boundaries; PATCHED on live writes; STRUCTURAL on resize physics** | Snapshot→live boundary uses chained callbacks → barrier is exact. `term.reset()` (vs `term.clear()`) is a one-line correctness fix that wipes parser state. Live `term.write` remains fire-and-forget per explicit D-Q7 decision (deliberate, JS single-thread guarantees order). Resize storm: tmux `window-size manual` is the LOAD-BEARING physics-layer fix — tmux can't repaint the pane on every client geometry change because there is no "client geometry change" propagating to tmux any more. Plus client debounce + server coalesce as defense-in-depth. The resize storm class is structurally killed at the tmux layer. |

**Bottom line on "раз и навсегда".** When the flag is enabled, every named
pain point is structurally closed by the data structure or the protocol —
not patched. The user's complaint operates at the symptom layer; this
implementation operates at the invariant layer. Provided the flag flips,
the bugs cannot reappear without someone deliberately rewriting
`_pushChunk` to slice strings again, deleting the seq numbers from the
protocol, or removing the heartbeat — all of which would be visible code
changes, not silent regressions.

The "fragile" parts are:

- **Phase 5 explicitly defers** `-CC` control mode (`C4`), cross-instance
  persistence (`C13`), and the Serializer (`C14`). These would buy
  marginal additional robustness but were rejected as poor cost/benefit
  for a single-VPS single-pane deployment. Documented in `05-decision-
  tmux.md` §9 — these are acceptable residual fragilities, not regressions.
- **`session.chunks` grows even with zero V2 clients connected** (`07-impl-
  tmux-WP-A.md` §"Risks observed", #4). This is by-design (so a future
  attach within the rolling window can FAST_PATH) but a future reader
  might miss it. Documented but not a defect.

---

## 4. Open caveats

Every place the implementation can still produce divergence post-fix.

### Caveat 1 — Flag is OFF by default; legacy code path serves production
- **Severity**: HIGH (operational; not a code defect).
- **Trigger**: After `bash deploy.sh`, neither blue nor green has
  `CT_RELIABLE_STREAMING=1` in `ecosystem.config.js` (`/root/projects/
  claude-terminal/ecosystem.config.js:7-10, 27-30`). The legacy
  `attachToSession` runs at `terminal-manager.js:754-878` with the
  unchanged unsafe `slice(-2_000_000)` (`:430-432`) and the synchronous
  `for (client of session.connectedClients) client.send(...)` broadcast
  (`:433-437`).
- **Recommended next-step**: Set `CT_RELIABLE_STREAMING: "1"` in the
  `env` block of both apps in `ecosystem.config.js`, OR follow the
  staged rollout plan in `05-decision-tmux.md` §7 (canary green first,
  then blue). Without this, the user's pain is NOT addressed in
  production despite the code being merged.

### Caveat 2 — Initial replay (`_sendResumePath`/`_sendSnapshotPath`) bypasses `_drainClient`
- **Severity**: LOW (acknowledged in `07-impl-tmux-WP-A.md` deviation #2;
  re-flagged in `08-validate-behavior-tmux.md` §"Source bugs / spec
  deviations").
- **Trigger**: A reconnecting client whose `bufferedAmount` is already
  near the 8 MiB ceiling receives a snapshot >12 MiB (theoretically up
  to `tmuxSnapshot`'s 16 MiB cap). The snapshot is one synchronous
  `ws.send` at `terminal-manager.js:1085` or `:1087` — no
  `bufferedAmount` check. Eviction triggers only on the NEXT live chunk
  via `_drainClient`. Plan §10.3 explicitly says "DO NOT introduce a
  third broadcast pattern" — this is a violation.
- **Recommended next-step**: Route initial replay through
  `_drainClient` by pushing chunks into `clientRec.queue` and scheduling
  the drain. Tracked already by the implementer; accepted as ship-able
  with eviction-on-next-chunk as the safety valve.

### Caveat 3 — `_broadcastControlV2` bypasses `_drainClient`
- **Severity**: LOW (also acknowledged in `08-validate-behavior-tmux.md`
  §"Source bugs / spec deviations" #1).
- **Trigger**: Same as Caveat 2 — a slow client whose `bufferedAmount` is
  already > 8 MiB gets a control envelope (`exit`/`stopped`/`error`) via
  `terminal-manager.js:550-557` direct `ws.send(text)` — eviction won't
  fire until the next live broadcast. The function comment claims it
  honours bufferedAmount/binaryCapable rules but the implementation does
  not — a silent contract violation.
- **Recommended next-step**: Same as Caveat 2 — push control envelopes
  through `_drainClient`. Severity LOW because envelopes are tiny and
  rare; the eviction kicks in within milliseconds.

### Caveat 4 — Resize coalesce is V2-only on the server
- **Severity**: MED (legacy clients still suffer the storm).
- **Trigger**: If WP-C client is rolled out but WP-A flag is OFF, all
  clients hit `attachToSession`'s message handler at `terminal-manager.
  js:821-825` which calls `session.pty.resize(message.cols, message.rows)`
  with no equality check. The client-side debounce at `Terminal.tsx:
  725-730` prevents storm from the OBSERVER, but the server still resizes
  on every received message → tmux re-renders pane → byte burst back. Even
  with `window-size manual` this can produce one redraw per received
  resize message; the storm magnitude is reduced by the client debounce
  but not eliminated.
- **Recommended next-step**: Consider hoisting the equality check into
  the legacy `attachToSession` message handler too — it's a 2-line change
  and provides defense-in-depth. Out of scope for current tickets but
  trivial to add.

### Caveat 5 — `ALT_SCREEN_RE` per-chunk regex hazard remains
- **Severity**: LOW (accepted in `05-decision-tmux.md` §8 risk #10).
- **Trigger**: A chunk ending in `\x1b[?104` followed by a chunk starting
  with `9h` will not be stripped by `terminal-manager.js:415` regex
  (chunk-spanning sequence). xterm.js would briefly switch to alt-screen
  before something redraws it back. tmux generally emits the sequence
  atomically so this is rare in practice.
- **Recommended next-step**: Accept as documented residual; revisit only
  if measurement shows real symptoms.

### Caveat 6 — Existing tmux sessions need detach+reattach to pick up new config
- **Severity**: MED (one-deploy lag; per `07-impl-tmux-WP-B.md` §1 and
  `05 §8 risk #8`).
- **Trigger**: After deploy, in-flight tmux sessions still run with the
  OLD `window-size latest` + `aggressive-resize on` until the user
  detaches and reattaches (or the session naturally ends). For those
  in-flight sessions, the resize storm physics fix is NOT in effect.
- **Recommended next-step**: Document in deploy runbook. Consider a
  one-time `tmux -L claude-terminal detach -a` after deploy completes —
  but that disconnects users mid-session, so probably not worth the
  cure.

### Caveat 7 — Snapshot can return empty string on huge scrollback
- **Severity**: LOW (acknowledged in `07-impl-tmux-WP-A.md` §"Risks
  observed", #1).
- **Trigger**: With `history-limit 50000` × 200 cols × ANSI overhead, a
  worst-case snapshot can hit the 16 MiB `maxBuffer` ceiling on
  `tmuxSnapshot`'s `execFileSync` (`terminal-manager.js:90-96`). Catch
  block returns empty string, client does `term.reset()` + empty write +
  fit/scroll — visually a blank pane until next live byte.
- **Recommended next-step**: Add `console.warn` on empty capture (the
  implementer flagged this but didn't add it to keep diff scoped).

### Caveat 8 — Cross-instance seq epoch invalidates client's stored lastSeq
- **Severity**: LOW (accepted in `05-decision-tmux.md` §8 risk #4).
- **Trigger**: Blue/green flip → new instance starts at `totalSeq=0n` →
  client's stored `lastSeq` (from old instance) is invalidated → server
  detects (`lastSeq > totalSeq`) and routes SLOW_PATH (snapshot). Visual
  continuity is preserved via the snapshot, but byte-level continuity is
  lost. The user does NOT observe this directly.
- **Recommended next-step**: Acceptable per decision document. Cross-
  instance persistence (C13) was deliberately rejected as poor cost/
  benefit.

### Caveat 9 — Client legacy-fallback timer can race a slow snapshot parse
- **Severity**: LOW (acknowledged in `07-impl-terminal-combined.md`
  §"Risks observed", #1).
- **Trigger**: On a session with a 12 MiB scrollback snapshot, parsing
  through `term.write` may take longer than the 2 s `LEGACY_FALLBACK_MS`
  budget on a slow Android. If timer fires first AND it's a reconnect,
  `term.clear()` runs and wipes the partial snapshot paint.
  Implementation guard at `Terminal.tsx:507-520` checks
  `replayCompleteSeenRef.current` AND `isReconnectRef.current` — so
  fresh-connect doesn't trigger; only reconnect with slow parse triggers.
- **Recommended next-step**: Raise `LEGACY_FALLBACK_MS` to 5000 if real-
  device profiling shows slow Android with huge scrollbacks regressing.
  Currently 2 s is the documented value.

### Caveat 10 — Ephemeral path is intentionally on legacy server-side
- **Severity**: LOW (accepted in `05-decision-tmux.md` §10.3 + §9 #14).
- **Trigger**: Ephemeral sessions (provider-wizard auth) still run via
  legacy `attachToEphemeralSession` (`terminal-manager.js` ephemeral
  block). Has the SAME `slice(-2_000_000)` and synchronous broadcast
  hazards as the legacy persistent path. But ephemeral sessions die
  after 5 min; impact bounded.
- **Recommended next-step**: Acceptable. Ephemeral has no reconnect logic
  by design; chunk list adds memory cost without benefit.

### Caveat 11 — DOM renderer remains the default on the client
- **Severity**: LOW (accepted in `05-decision-tmux.md` §8 risk #9).
- **Trigger**: Under sustained 5 MB/s output the DOM renderer can fall
  behind xterm's internal `WriteBuffer`. Not a frame-loss bug per se but
  a smoothness bug that compounds the user's "ломается" perception under
  heavy output.
- **Recommended next-step**: Add `@xterm/addon-webgl` in a separate
  ticket. Out of scope for streaming reliability per the decision.

---

## 5. Real-device verification needed

These are symptoms that ONLY a real Claude Code soak (or DevTools throttle
+ multi-tab) can confirm. Per `08-validate-behavior-tmux.md` §"Biggest
unknown that only real-device testing can settle":

1. **S1 — Zero divergence over 1 h @ 200 KB/s.** The harness verifies the
   data-structure invariant but cannot prove rendered xterm matches tmux
   scrollback over a real long-running session. Run the `yes "ABC$(date
   +%N)" | head -c $(( 200 * 1024 * 60 * 60 ))` script per `05-decision-
   tmux.md` §4 S1 and diff `serializeAddon.serialize()` vs `tmux capture-
   pane -S -`.

2. **S2 — Reconnect preserves last 100 KB without ANSI corruption.**
   Disconnect mid-color-block stream, reconnect 10 s later. Confirm the
   replay byte-equivalent to prior render. `terminal-manager.js` chunk
   list invariants are proven; the open question is whether xterm's
   parser handles the snapshot frame correctly at the boundary.

3. **S3 — Blue→green flip preserves vim screen state.** Run `vim` in
   alt-screen, execute `bash deploy.sh`, expect the EXACT vim screen
   within 10 s. The `tmuxSnapshot` helper has the `-a` flag for alt-
   screen and the harness §6a verified shape, but no end-to-end vim+
   deploy test ran (validator was constrained against running deploy).

4. **S4 — WS resume after 60 s offline ≤ 500 ms.** Heartbeat code
   reviewed but not exercised under network failure. Need DevTools
   "Offline" toggle + perf marks from `ws.onopen` to
   `replay_complete` handler.

5. **S5 — Slow client cannot block fast client.** Two browser tabs, throttle
   one to 100 KB/s with DevTools. Producer at 5 MB/s. Verify the
   throttled tab gets `close(4503, "lagging")` within 5 s and reconnects
   via seq-resume; verify the fast tab keeps full rate. Server should
   show `evictions++` counter.

6. **S6 — Resize storm during mobile keyboard show/hide ≤ 2 `pty.resize`.**
   `tmux.conf` is the structural fix but the actual count needs counting
   `session.pty.resize` calls during a keyboard cycle on a real device.

7. **S7 — Half-open TCP detected within 90 s.** Server iptables-DROP
   test. Heartbeat `setInterval(25_000)` + watchdog → max 50 s before
   `terminate()` if no pong; need to confirm with actual packet drop.

8. **The "biggest unknown" per Phase 8 validator**: whether
   `_sendResumePath` ordering survives a high-rate producer when initial
   replay bypasses `_drainClient`. JS single-thread guarantees ordering
   in theory, but only a sustained 5 MB/s soak can confirm no observable
   reorder/loss happens during the snapshot→live transition under real
   socket-level back-pressure.

9. **Memory pressure under N concurrent sessions.** Estimate is 10
   sessions × (2 MiB chunks + 8 MiB × 3 clients) = ~260 MiB worst case in
   node memory. Confirm vs estimate against real PM2 RSS.

Until these run with green outcomes, the audit verdict cannot be upgraded
from PARTIAL to PASS. The code is structurally correct; the system is not
yet known to behave per spec.

---

## 6. Recommendation to user (Russian)

Кратко по-русски, что делать дальше.

Что сделано: переписана структура хранения PTY-данных (chunk list вместо
строки с `slice` посередине байтов ANSI-эскейпа), на каждом WS-сообщении
теперь есть абсолютный seq-номер байта, у каждого клиента — свой курсор
и своя очередь, добавлен пинг каждые 25 с (раньше «зависший» терминал
после потери сети чинился только перезагрузкой страницы), на reconnect
клиент шлёт свой `lastSeq` и сервер либо доигрывает только новые байты
(FAST_PATH), либо шлёт чистый снапшот через `tmux capture-pane`
(SLOW_PATH). Старая «сломанная» механика — синхронный broadcast и
2-мегабайтный `slice` — формально живёт в коде как legacy-путь, но это
для безопасности отката.

Где остаточный риск. Главное: сейчас фича-флаг
`CT_RELIABLE_STREAMING=1` ВЫКЛЮЧЕН по умолчанию в
`ecosystem.config.js`. То есть после `bash deploy.sh` твой терминал
по-прежнему работает по старому коду — пока флаг не включишь, эта
правка тебе никак не помогает. Также три деривации от плана: контрольные
сообщения и initial replay не идут через per-client drain (риск низкий),
и тмукс-сессии, которые сейчас уже запущены, подхватят новый
`tmux.conf` только после detach+reattach.

Что делать. (1) Открой `ecosystem.config.js`, добавь `CT_RELIABLE_
STREAMING: "1"` в `env`-блок ОБЕИХ apps (blue и green), запусти `bash
deploy.sh`. (2) Сделай реальный 1-часовой прогон: запусти Claude Code,
работай как обычно, разверни вкладку на телефоне, дёрни WiFi на 30 с —
если экран не «ползёт» и после переподключения сразу синхронизируется
без артефактов в 1-2 строки сверху, значит фикс работает. (3) Если
что-то поломалось — откат мгновенный: убери флаг и сделай `pm2 reload
claude-terminal-blue claude-terminal-green`. Старый код на месте,
рисков от отката ноль.

Что отслеживать. На сервере прирастают счётчики
`terminalManager.streamCounters.{evictions, pingTerminations, fastPath,
slowPath}` — если `evictions` или `pingTerminations` >0 за сутки без
явных проблем у юзеров, это ложные срабатывания и порог в 8 МиБ /
интервал в 25 с надо подкрутить. Если `fastPath` всегда 0 и всё идёт
через `slowPath` — значит chunk-list rolling window слишком короткий
для реального трафика, можно поднять `CHUNK_BYTES_CAP` в
`terminal-manager.js:12`.

---

## 7. Detailed file:line verification trail

This section walks every cited line of code I opened to verify the
implementer's changelog claims. Read-only. The goal is to demonstrate the
audit didn't take the implementer's word — every key claim was checked at
the source.

### 7.1 Server transport (WP-A)

| Claim from `07-impl-tmux-WP-A.md` | Source verified | Notes |
|---|---|---|
| "L34-44 Module-init flag" | `server.js:41-44` — `const RELIABLE_STREAMING = process.env.CT_RELIABLE_STREAMING === "1";` | Confirmed verbatim. Read once at module scope (no per-attach lookup). |
| "L171-200 Upgrade-handler routing" | `server.js:166-202` — branch on `query.ephemeral`, then `devOptOut = !dev ? false : query.reliable === "0"`, then `useReliable = RELIABLE_STREAMING && !devOptOut`, then `attachToSessionV2` vs `attachToSession`. | Confirmed. Production correctly ignores the `?reliable=0` escape hatch; dev mode honours it. |
| "L294-296 gracefulShutdown" | `server.js:303-304` — `try { terminalManager.destroy(); } catch {}` between PTY-kill loop and `wss.close()`. | Confirmed. Heartbeat interval is cleared before WSS shutdown. |
| "Chunk-list constants" | `terminal-manager.js:12-15` — `CHUNK_BYTES_CAP = 2 * 1024 * 1024`, `BUFFERED_CEILING = 8 * 1024 * 1024`, `HEARTBEAT_INTERVAL_MS = 25_000`, `HELLO_TIMEOUT_MS = 2000`. | Confirmed. Matches plan §3.4, §3.7. |
| "Binary frame opcodes" | `terminal-manager.js:18-19` — `OPCODE_OUTPUT = 0x01`, `OPCODE_SNAPSHOT = 0x02`. | Confirmed. Matches plan §2.2. |
| "tmuxSnapshot helper" | `terminal-manager.js:67-140` — alt-screen detection (`#{alternate_on}`), `capture-pane -p -e -J -S - -E - [-a]`, CRLF-normalise via `(?<!\r)\n`, cursor via `#{cursor_x},#{cursor_y}`, geometry via `#{pane_width},#{pane_height}`, wrap with `\x1b[2J\x1b[H` + `\x1b[Y;XH`. | Confirmed verbatim. Uses `execFileSync` (no shell). `maxBuffer: 16 * 1024 * 1024` per gotcha #3. |
| "Binary frame encoders" | `terminal-manager.js:143-158` — `encodeBinaryFrame(opcode, seqBig, data)` writes `[1B opcode][8B BE uint64 seq][UTF-8 payload]`. | Confirmed. `Buffer.allocUnsafe(9 + payload.length)`, `writeUInt8`, `writeBigUInt64BE`, `payload.copy`. |
| "Constructor heartbeat" | `terminal-manager.js:232-236` — `if (this.reliableStreaming) { this.heartbeatInterval = setInterval(() => this._heartbeatTick(), HEARTBEAT_INTERVAL_MS); if (this.heartbeatInterval.unref) this.heartbeatInterval.unref(); }` | Confirmed. Heartbeat is gated by the flag. `unref()` so test processes don't hang. |
| "_makeSession factory" | `terminal-manager.js:242-264` — allocates `chunks: []`, `chunkBytes: 0`, `totalSeq: 0n`, `prunedSeq: 0n`, `cols: 200`, `rows: 50`, `clients: new Map()` UNCONDITIONALLY. | Confirmed. ~200 B per session overhead even when flag off (acceptable per plan §3.3). |
| "destroy()" | `terminal-manager.js:357-367` — clears file watcher AND heartbeat interval. | Confirmed. |
| "createSession" | `terminal-manager.js:633-651` — initialises both legacy fields and reliable-streaming fields. `cols: 120, rows: 40` (matches the actual `attachTmux` call at `:631`, NOT `200, 50` as plan §3 diagram suggests — minor inconsistency, not a defect). | Confirmed. The `default-size 200x50` from `tmux.conf` is overridden by the explicit `-x 120 -y 40` on `new-session`. |
| "resumeSession resets chunk state" | `terminal-manager.js:715-724` — when `session.chunks` exists, resets all reliable-streaming fields to fresh epoch. `session.clients` deliberately preserved. | Confirmed. Per plan: existing connections will SLOW_PATH on next reconnect because their `lastSeq > totalSeq=0n`. |
| "_setupPty.onData hot path" | `terminal-manager.js:412-456` — legacy fan-out runs ALWAYS (line 429-437); new path runs gated by `if (this.reliableStreaming && session.clients && session.clients.size > 0)` (line 442-450); when flag on with no V2 clients, still calls `_pushChunk` (line 451-454) so a future attach within window can FAST_PATH. | Confirmed. Coexistence is correct per implementer deviation #1. |
| "_pushChunk" | `terminal-manager.js:487-499` — appends `{seq, data}`, advances `totalSeq`, evicts whole chunks from the head while `chunkBytes > CHUNK_BYTES_CAP && chunks.length > 1`, advances `prunedSeq` per eviction. | Confirmed. The `> 1` guard prevents popping a single oversized chunk before it's been read. |
| "_chunksSince" | `terminal-manager.js:503-509` — linear scan returning chunks where `chunk.seq > lastSeqBig` (strict inequality). | Confirmed. |
| "_drainClient" | `terminal-manager.js:512-545` — pre-send `readyState !== 1` check (line 515-519), `bufferedAmount > BUFFERED_CEILING` check + `close(4503, "lagging")` + `evictions++` (line 520-525), per-chunk send with binary or JSON per `binaryCapable` (line 527-536), send-throw drops client (line 537-542), advances `lastSentSeq` (line 543). | Confirmed. The drain is correct. |
| "_broadcastControlV2" | `terminal-manager.js:550-557` — direct `clientRec.ws.send(text)` inside `for` loop, NO `bufferedAmount` check, NO drain. **DEVIATION**: comment claims "honours bufferedAmount/binaryCapable rules" but implementation doesn't. | Confirmed deviation. See §4 caveat #3. |
| "_heartbeatTick" | `terminal-manager.js:563-591` — iterates BOTH `session.clients` AND `session.connectedClients`. Legacy clients use `ws._ctIsAlive` shadow flag. Counter `pingTerminations++` on each terminate. | Confirmed. Free upgrade for legacy clients. |
| "attachToSessionV2" | `terminal-manager.js:884-1022` — lazy PTY attach (lines 898-921), AWAIT_HELLO state (lines 926-944), `firstMessageHandler` (lines 947-1014). On `hello.protocol_version === 2`: parses `lastSeq`, registers via `_registerClientV2`, routes per condition `session.totalSeq > 0n && lastSeqBig >= session.prunedSeq && lastSeqBig < session.totalSeq` (line 982-986). On parse error or non-hello first message: `fallbackToLegacy()` (line 929-939) which SLOW_PATHs and re-dispatches. On 2 s timer: `fallbackToLegacy()`. | Confirmed. The router has an extra `session.totalSeq > 0n` guard not in plan §2.7 — defensively correct (fresh session has nothing to resume from), validator §"cosmetic observation" agrees. |
| "_registerClientV2" | `terminal-manager.js:1024-1037` — creates `{ws, lastSentSeq, queue, drainScheduled, binaryCapable, isAlive}`. Wires `ws.on('pong', () => clientRec.isAlive = true)`. | Confirmed. Idempotent registration. |
| "_sendResumePath" | `terminal-manager.js:1042-1069` — `{resume, from: String(lastSeq+1n)}`, then loop emit chunks where `seq > lastSeq` (binary or JSON per binaryCapable), then `{replay_complete}`. **DEVIATION**: bypasses `_drainClient` per implementer #2 / validator #2. | Confirmed deviation. See §4 caveat #2. |
| "_sendSnapshotPath" | `terminal-manager.js:1071-1102` — `tmuxSnapshot(sessionId)` (catch returns empty struct), `epochSeq = session.totalSeq`, send binary OPCODE_SNAPSHOT or JSON `{snapshot, seq, data, cols, rows, cursor}`, then `{replay_complete}`. `clientRec.lastSentSeq = epochSeq`. | Confirmed. Empty-snapshot fall-through is graceful (`term.reset()` + empty write + fit). |
| "_wireSteadyStateHandlers" | `terminal-manager.js:1105-1115` — installs `ws.on('message')` that JSON-parses and dispatches via `_handleSteadyStateMessage`. Validator's `_clientRec → no param` fix applied (per `08-validate-build.md` §2). | Confirmed. |
| "_handleSteadyStateMessage" | `terminal-manager.js:1120-1193` — switch on type: `input` writes to PTY; `resize` server-side equality coalesce (line 1134) — drops no-op resizes against `session.cols/rows` per plan §2.4.4; `image` xclip pipeline; `hello` stray (warn); `ack` reserved (warn); default unknown (warn). | Confirmed. No silent drops on unknown types per plan §10.3. |
| "Legacy attachToSession adds error handler + heartbeat liveness" | `terminal-manager.js:762-767` — `attachCounters.v1++`, `ws.on('error', () => {})`, `ws._ctIsAlive = true; ws.on('pong', () => { ws._ctIsAlive = true; })`. | Confirmed. Legacy clients get the heartbeat upgrade for free. |
| "deleteSession + deleteSessionKeepFiles use _allSessionClients" | `terminal-manager.js:1239`, `:1279` — `for (const client of this._allSessionClients(session))` (defined at `:1205-1211` as union of `connectedClients` and `clients.keys()`). | Confirmed. V2 clients get exit/close on session delete. |
| "CLAUDE.md L28-30 updated" | `CLAUDE.md:28` — replaced "500KB circular" with chunk-list-based description. `CLAUDE.md:30` — new paragraph documenting the protocol. | Confirmed. |

### 7.2 tmux.conf (WP-B)

| Claim from `07-impl-tmux-WP-B.md` | Source verified | Notes |
|---|---|---|
| "default-terminal: tmux-256color" | `tmux.conf:31` — `set -g default-terminal "tmux-256color"` | Confirmed. |
| "terminal-overrides glob" | `tmux.conf:32` — `set -ga terminal-overrides ",*256col*:Tc"` | Confirmed. |
| "terminal-features: RGB,clipboard,focus,sync" | `tmux.conf:33` — `set -ga terminal-features ",*256col*:RGB,clipboard,focus,sync"` | Confirmed. Requires tmux ≥ 3.2; host has tmux 3.4. |
| "focus-events on" | `tmux.conf:53` — `set -g focus-events on` | Confirmed. |
| "automatic-rename off" | `tmux.conf:54` — `setw -g automatic-rename off` | Confirmed. |
| "monitor-bell off" | `tmux.conf:55` — `setw -g monitor-bell off` | Confirmed. |
| "set-clipboard off" | `tmux.conf:56` — `set -g set-clipboard off` | Confirmed. |
| "window-size manual" | `tmux.conf:65` — `set -g window-size manual` (load-bearing for P5) | Confirmed. WAS comments at lines 63-64 retain old values for grep-discoverability. |
| "default-size 200x50" | `tmux.conf:66` — `set -g default-size "200x50"` | Confirmed. |
| "aggressive-resize off" | `tmux.conf:67` — `setw -g aggressive-resize off` | Confirmed. |
| "Preserved verbatim: prefix C-], unbind C-b, escape-time 0, history-limit 50000, status off, mouse off, allow-rename off, remain-on-exit off" | `tmux.conf:16, 17, 20, 23, 38, 43, 46, 49` | Confirmed. |

### 7.3 Browser client (combined WP-C)

| Claim from `07-impl-terminal-combined.md` | Source verified | Notes |
|---|---|---|
| "Module constants LEGACY_FALLBACK_MS, RESIZE_DEBOUNCE_MS, OPCODE_OUTPUT, OPCODE_SNAPSHOT" | `Terminal.tsx:21-25` | Confirmed. Same constants in `EphemeralTerminal.tsx:19-22`. |
| "lastSeqStorageKey + readStoredLastSeq + writeStoredLastSeq" | `Terminal.tsx:30-52` | Confirmed. Wrapped in try/catch for private-mode safety. |
| "ws.binaryType = 'arraybuffer'" | `Terminal.tsx:459`, `EphemeralTerminal.tsx:61` | Confirmed. Set immediately after `new WebSocket(...)`. |
| "Send hello FIRST in onopen" | `Terminal.tsx:474-485` — `ws.send(JSON.stringify({type:"hello", protocol_version: 2, binary_capable: true, lastSeq: lastSeqRef.current.toString()}))`, then `resize` at `:488-498`. | Confirmed. Hello before resize. |
| "2 s legacy fallback timer" | `Terminal.tsx:504-520` — `setTimeout(..., LEGACY_FALLBACK_MS)`. On expiry, IF `!replayCompleteSeenRef.current` AND `isReconnectRef.current`: `term.clear()` (mimicking original behaviour). Always: `setReconnecting(false)`. | Confirmed. Guard correctly handles fresh-connect vs reconnect distinction. |
| "Binary branch in handleMessage" | `Terminal.tsx:252-285` — checks `event.data instanceof ArrayBuffer`, parses opcode (byte 0), seq (DataView.getBigUint64(1, false)), payload (Uint8Array(buf, 9)). OPCODE_OUTPUT: `updateLastSeq(seq); term.write(payload)`. OPCODE_SNAPSHOT: `term.reset(); term.write(text, () => updateLastSeq(seq))` — chained per `05 §D-Q7`. | Confirmed. |
| "Text branch JSON dispatch" | `Terminal.tsx:287-401` — `output` (tolerates absent seq), `snapshot` (text fallback with `term.reset()` + chain), `resume` (informational), `replay_complete` (rAF fit + scrollToBottom + setReconnecting(false), clears legacy timer), `exit`/`stopped`/`error` (Russian banners), default (`console.warn`). | Confirmed. Removed legacy `} catch { term.write(event.data) }` raw-write fallback per plan §4.4 line 1084 → P11 closed. |
| "ws.onclose handles 4503 as normal reconnect" | `Terminal.tsx:527-551` — `if (event.code === 4401 || event.code === 4404) return;` — code 4503 falls through to `isReconnectRef.current = true; scheduleReconnect()`. | Confirmed. Per plan §2.6, 4503 is "lagging" → reconnect with stored `lastSeq` for FAST_PATH resume. |
| "Debounced ResizeObserver" | `Terminal.tsx:725-735` — `setTimeout(doResize, RESIZE_DEBOUNCE_MS)`; `doResize` at `:702-723` does `fitAddon.fit()` then sends `resize` only if `term.cols !== lastSentCols || term.rows !== lastSentRows`. | Confirmed. Local equality coalesce complements server-side coalesce. |
| "visualViewport listener for mobile keyboard" | `Terminal.tsx:743-761` — `handleVvResize` calls `handleResize` plus `term.scrollToBottom()` if keyboard open. | Confirmed. |
| "DA1/DA2/DA3/CPR filter on onData preserved verbatim" | `Terminal.tsx:564-572` — `if (/^\x1b\[[\?>=]/.test(data) || /^\x1b\[\d+;\d+R$/.test(data)) return;` | Confirmed. Same regex as original `Terminal.tsx:217`. |
| "Mobile pointerdown handler for focus on tap" | `Terminal.tsx:678-692` — checks `window.matchMedia("(max-width: 767px)").matches`, focuses `terminalIO.mobileInputRef.current` synchronously. | Confirmed. Capture-phase listener. |
| "EphemeralTerminal.tsx mirrors binary parsing + JSON dispatch + debounce" | `EphemeralTerminal.tsx:63-112` — binary branch + text branch with same removed raw-write fallback; debounce at `:122-146`; visualViewport listener at `:155-159`. | Confirmed. Does NOT send `hello` (ephemeral stays on legacy server-side per plan §10.3). |

### 7.4 Validation harness (Phase 8)

| Claim from `08-validate-behavior-tmux.md` | Source verified | Notes |
|---|---|---|
| "Harness file at `tests/reliable-streaming.test.js`, 20/20 PASS" | `/root/projects/claude-terminal/tests/reliable-streaming.test.js` exists, 934 lines. | Confirmed exists. The harness output is reported in `08-validate-behavior-tmux.md` §"Harness output (verbatim)" with all 20 tests PASS. I did not re-run it — trusting the validator's run since the file exists and the source code at the cited line:source shows the harness's assertions are sound. |
| "0 hard bugs, 2 spec deviations" | Cross-referenced with implementer changelog `07-impl-tmux-WP-A.md` deviations #1 #2. Both are LOW severity, acknowledged. | Confirmed. The deviations are exactly the two I flagged in §4 caveats #2 and #3. |

---

## 8. Cross-reference: every Phase-2 hypothesis vs Phase-7 fix

For completeness — every ACCEPTED or PARTIALLY ACCEPTED hypothesis from
the Phase-2 scans, mapped to its post-fix status.

### 8.1 From `02-scan-pty.md` §6

| H# | Hypothesis | Phase-2 verdict | Post-fix status |
|---|---|---|---|
| H1 | UTF-8 cut on WS frame boundary | REJECTED on producer; PARTIAL at trim | **Eliminated** by chunk list (no slice on UTF-16 surrogate possible — chunks are stored as the StringDecoder-aligned strings node-pty emitted). |
| H2 | Replay buffer truncation mid-escape | ACCEPTED | **Structurally eliminated** (chunk granularity prune; Pain Point 1). |
| H3 | PTY resize storms | ACCEPTED | **Structurally eliminated** at three layers: tmux `window-size manual` + client debounce + server equality coalesce (Pain Point 7). |
| H4 | tmux pipe-pane vs control-mode mismatch | REJECTED (no pipe-pane in code) | N/A |
| H5 | Server-side throttling/coalescing splits escapes | REJECTED | N/A |
| H6 | nginx blue/green flip → empty replay | ACCEPTED | **Structurally eliminated** via tmux as cross-instance source of truth + snapshot path (Pain Point 3). |
| H7 | Two clients on one session → no per-client cursor | ACCEPTED | **Structurally eliminated** by per-client `ClientRecord` (Pain Point 4). |
| H8 | xterm.js write() not awaited | DEFERRED to client scanner | **Partial** — chained at snapshot→live boundary only; live writes remain fire-and-forget per explicit decision (Pain Point 7). |
| H9 | Reconnect race: late buffer flush vs live | ACCEPTED | **Structurally eliminated** by seq+ack and `replay_complete` barrier (Pain Point 2). |

### 8.2 From `02-scan-ws.md` §7

| H# | Hypothesis | Phase-2 verdict | Post-fix status |
|---|---|---|---|
| H1 | No backpressure → blowup or drops on CLOSING | ACCEPT | **Structurally eliminated** by `bufferedAmount` ceiling + per-client async drain + seq-resume on reconnect (Pain Point 5). |
| H2 | Reconnect race | ACCEPT (partial) | **Structurally eliminated** by seq+ack (Pain Point 2). |
| H3 | Multi-client without per-client cursor | ACCEPT | **Structurally eliminated** by per-client `ClientRecord` (Pain Point 4). |
| H4 | Blue/green flip → empty replay | PARTIAL ACCEPT | **Structurally eliminated** via tmux + snapshot (Pain Point 3). |
| H5 | xterm.js write() not chained | ACCEPT | **Partially patched** — chained only at boundary per D-Q7 decision. |
| H6 (bonus) | No ping/pong → undetected dead | (observed) | **Structurally eliminated** by `setInterval(25_000)` heartbeat (Pain Point 6). |
| H7 (bonus) | Symphony WS path mismatch | (observed) | **OUT OF SCOPE** per `05-decision-tmux.md` §9 #12. Not addressed in this work. |

### 8.3 From `02-scan-client.md` §7

| H# | Hypothesis | Phase-2 verdict | Post-fix status |
|---|---|---|---|
| H1 | xterm.js write() not awaited | PARTIALLY ACCEPTED | **Same as Pain Point 7 / D-Q7**. |
| H2 | Reconnect race at screen-state level | REJECTED at wire / ACCEPTED at screen | **Structurally eliminated** by `term.reset()` + chained snapshot write + seq tracking (Pain Point 7). |
| H3 | FitAddon called per-keystroke during resize | ACCEPTED | **Structurally eliminated** by client debounce (`Terminal.tsx:725-730`) + tmux `window-size manual`. |
| H4 | Replay applied without `term.reset()` → corrupts state | ACCEPTED | **Structurally eliminated** by replacing `term.clear()` with `term.reset()` in snapshot dispatch (`Terminal.tsx:273, 327`). |

**Tally**: 13 ACCEPTED hypotheses across the three scans. Of these, **11
are structurally eliminated** (when flag on) by the implementation, **2
are partially patched** (live `term.write` ordering accepted as
fire-and-forget per single-thread JS guarantee; resize coalesce on
legacy server path not added). The H7 Symphony path mismatch is
explicitly out of scope.

This is the strongest possible "fix per pain class" coverage given the
Phase 5 decision boundaries.

---

## 9. What this audit deliberately did NOT verify

To set expectations honestly:

1. **End-to-end network round-trip**. The new client is now sending
   `{type:"hello", lastSeq, binary_capable: true}` against any server,
   but I did not open a real WSS connection or watch the wire. The
   harness static-analyses the routing logic; it doesn't deliver bytes.
2. **xterm.js parser behaviour against the new snapshot frame**. The
   harness verifies the server SEND order; it does not exercise xterm's
   `WriteBuffer` under a real 12 MiB snapshot followed by live deltas.
   The "biggest unknown" per Phase 8 is whether the snapshot bypass of
   `_drainClient` produces visible artifacts under sustained 5 MB/s
   producer.
3. **Mobile UX under a real phone**. This audit covers the streaming
   reliability work, not the mobile WP. The `useIsMobile` checks and
   visualViewport listener are present but I did not test them on real
   iOS Safari 18 / Android Chrome 132.
4. **Heartbeat false-positive rate over 24 h**. The code is correct; the
   real-world rate of `pingTerminations` from intermittently-flaky
   clients (vs genuinely dead) is not measurable from a static audit.
5. **Memory pressure under N concurrent sessions**. Estimate is 260 MiB
   worst case for 10 sessions × 3 clients; not measured against real PM2
   RSS.
6. **`bash deploy.sh` execution end-to-end**. The deploy script was
   intentionally NOT run during this audit (would mutate production
   state). The verdict on Pain Point 3 (blue/green flip) relies on the
   `tmuxSnapshot` shape verification + the routing matrix from harness
   §1d ("lastSeq>totalSeq → SLOW") being correct in isolation; whether
   the actual flip preserves screen state requires a real deploy soak.

---

## 10. Final remarks

Two observations the next-phase auditor or the user might find useful.

### 10.1 The fix is the data structure

What makes this implementation worthy of "раз и навсегда" status is that
the fix lives at the data-structure layer, not the symptom layer. A
chunk list cannot mid-cut an escape sequence because it has no operation
that slices inside a chunk. A per-client `ClientRecord` cannot leak
across clients because there is no shared mutable surface between them.
A seq number cannot allow duplication because each byte has exactly one
address. These are not "less likely after a patch" — they are
structurally undefined.

For the bug class to come back, someone would have to reintroduce
`String.slice(-2_000_000)` to `_pushChunk`, delete the seq numbers from
the protocol, or remove the per-client Map. All three would be visible
code changes, not silent regressions. That's the strongest possible
notion of "permanent fix" for this kind of issue.

### 10.2 The protocol is forward-and-backward-compatible

The plan and implementation explicitly preserve a graceful fallback
matrix:

- Old client → old server: unchanged behaviour.
- Old client → new server: the `AWAIT_HELLO` 2 s timer + first-message-
  not-hello branch in `attachToSessionV2:947-1014` falls back to legacy
  treatment without protocol error.
- New client → old server: the client always sends `hello`, but the old
  server's existing try/catch at `attachToSession:870-872` silently
  drops it; the client's 2 s `legacyFallbackTimerRef:507-520` then
  enters legacy mode without breaking.
- New client → new server: full new path with `hello`/`resume`/`snapshot`/
  `replay_complete`.

This means the rollout has no "break the world" cliff — both sides can
upgrade independently, and any version-mismatch combination keeps
working. Operator can canary green first per `05-decision-tmux.md` §7
roll-out plan with full safety.

### 10.3 What would make me upgrade this verdict to PASS

Three things, in order of importance:

1. **Flip the flag.** Add `CT_RELIABLE_STREAMING: "1"` to both apps'
   `env` blocks in `ecosystem.config.js`. Until this happens, the user's
   actual production traffic is on the legacy code path and the audit's
   structural-fix verdicts are theoretical.
2. **Run S1, S2, S5, S7 against a real device.** These are the user-
   facing acceptance criteria from `05-decision-tmux.md` §4 that the
   Node harness cannot exercise. S5 (multi-tab throttle) is the most
   diagnostic of the bunch — it directly verifies that a slow client can
   no longer poison a fast one.
3. **Resolve the two LOW-severity deviations** (caveats #2 and #3 in
   §4): route initial replay and control envelopes through
   `_drainClient`. These are small, mechanical, and would close the
   single remaining "third broadcast pattern" violation flagged by both
   the implementer and the validator.

When those three are done, the streaming reliability work is genuinely
shippable as "раз и навсегда" with no asterisks.

End of `09-audit-tmux.md`.
