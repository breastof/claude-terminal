# 08 — Behavioural Validation: claude-terminal Robust-Lite Streaming

> Phase 8 deliverable for `validator-behavioral-tmux`.
> Stress-test of the new tmux-streaming reliability path (`CT_RELIABLE_STREAMING=1`)
> via a Node-side harness — no full deploy, no browser.
> Inputs: 05/06/07 plans + actual `terminal-manager.js` source.

---

## TL;DR

- Harness file: `/root/projects/claude-terminal/tests/reliable-streaming.test.js`
- Run: `cd /root/projects/claude-terminal && node tests/reliable-streaming.test.js`
- Result: **20 RUN / 20 PASS / 0 FAIL / 0 SKIP**
- Source bugs filed: **0 hard bugs**, **2 spec deviations** (documented below)
- Verdict: implementation matches the spec on every behavioural axis covered by
  a Node harness. The data-structure contract that makes "пакеты теряются"
  structurally impossible is correctly implemented.

---

## Per-test results

| #     | Test                                                                                  | Status |
|-------|---------------------------------------------------------------------------------------|--------|
| 1a    | push 1000 chunks, `chunksSince(0)` returns all in order                              | PASS   |
| 1b    | eviction at chunk granularity (no mid-chunk slice)                                    | PASS   |
| 1c    | `chunksSince(arbitrary seq)` returns contiguous tail                                  | PASS   |
| 1d    | snapshot path triggered when `lastSeq < oldestRemainingSeq`                           | PASS   |
| 2a    | CSI/OSC/SGR sequences split across chunks → exact byte replay                        | PASS   |
| 2b    | chunk-granularity eviction preserves chunk integrity                                  | PASS   |
| 3a    | each client sees only its own missed chunks                                           | PASS   |
| 3b    | mutating one client's record does not affect another                                  | PASS   |
| 4a    | `_drainClient` queues rather than send-spamming when bufferedAmount low               | PASS   |
| 4b    | ceiling-eviction closes slow client with code 4503                                    | PASS   |
| 4c    | drain on dead ws drops client without close call                                      | PASS   |
| 5a    | `HELLO_TIMEOUT_MS` constant equals 2000                                              | PASS   |
| 5b    | `attachToSessionV2` schedules helloTimer with `HELLO_TIMEOUT_MS` and falls back     | PASS   |
| 5c    | `firstMessageHandler` routes hello vs non-hello and SLOW/FAST per plan §2.7         | PASS   |
| 6a    | `tmuxSnapshot` returns `{data, cursor:{x,y}, cols, rows, alternate}`                | PASS   |
| 6b    | `_sendSnapshotPath` wires snapshot.seq = `session.totalSeq` (epoch) + replay_complete | PASS   |
| 7a    | push 100 chunks → seqs strictly ascending, `totalSeq` matches sum of bytes           | PASS   |
| 8a    | module flag is false when env var unset, no heartbeat scheduled                       | PASS   |
| 8b    | `server.js` routes to `attachToSession` (not V2) when flag off                       | PASS   |
| 8c    | legacy `attachToSession` uses `session.buffer` + `connectedClients` (no chunk fan-out)| PASS   |

---

## Harness output (verbatim)

```
=== 1. Chunk-list buffer correctness ===
> tmux session alive: 26-04-2026-08-50-21 (PTY will attach on client connect)
  [PASS] 1a. push 1000 chunks, chunksSince(0) returns all in order
  [PASS] 1b. eviction at chunk granularity (no mid-chunk slice)
  [PASS] 1c. chunksSince(arbitrary seq) returns contiguous tail
  [PASS] 1d. snapshot path triggered when lastSeq < oldestRemainingSeq

=== 2. ANSI-escape integrity (replay equals concatenation) ===
  [PASS] 2a. CSI/OSC/SGR sequences split across chunks → exact byte replay
  [PASS] 2b. chunk-granularity eviction preserves chunk integrity

=== 3. Per-client cursor — three clients with different lastSeq ===
  [PASS] 3a. each client sees only its own missed chunks
  [PASS] 3b. mutating one client's record does not affect another

=== 4. Backpressure — bufferedAmount ceiling triggers close(4503) ===
  [PASS] 4a. _drainClient queues rather than send-spamming when bufferedAmount low
  [PASS] 4b. ceiling-eviction closes slow client with code 4503
  [PASS] 4c. drain on dead ws drops client without close call

=== 5. AWAIT_HELLO 2 s timer (static analysis) ===
  [PASS] 5a. HELLO_TIMEOUT_MS constant equals 2000
  [PASS] 5b. attachToSessionV2 schedules helloTimer with HELLO_TIMEOUT_MS and falls back
  [PASS] 5c. firstMessageHandler routes hello vs non-hello and SLOW/FAST per plan §2.7

=== 6. tmuxSnapshot helper ===
  [PASS] 6a. tmuxSnapshot returns {data, cursor:{x,y}, cols, rows, alternate}
> tmux session alive: 26-04-2026-08-50-21 (PTY will attach on client connect)
  [PASS] 6b. _sendSnapshotPath wires snapshot.seq = session.totalSeq (epoch) and emits replay_complete

=== 7. Seq monotonicity ===
  [PASS] 7a. push 100 chunks → seqs strictly ascending, totalSeq matches sum of bytes

=== 8. Legacy path with CT_RELIABLE_STREAMING undefined ===
> tmux session alive: 26-04-2026-08-50-21 (PTY will attach on client connect)
  [PASS] 8a. module flag is false when env var unset, no heartbeat scheduled
  [PASS] 8b. server.js routes to attachToSession (not V2) when flag off
  [PASS] 8c. legacy attachToSession uses session.buffer + connectedClients (no chunk fan-out)

==================================================
 SUMMARY: 20/20 PASS  (0 FAIL, 0 SKIP)
==================================================
 tmux on host: tmux 3.4
 flag-on:  reliableStreaming=true, HELLO_TIMEOUT_MS=2000, BUFFERED_CEILING=8388608, CHUNK_BYTES_CAP=2097152
```

---

## What each test actually proves

### 1. Chunk-list buffer correctness

- **1a** Pushed 1000 random-sized chunks (1..256 B); verified `_chunksSince(-1n)`
  returns all 1000 in insertion order with strictly ascending seq, exact data
  preservation. Also verified that `chunksSince(0n)` correctly drops the chunk
  at seq=0 (the contract is `seq > lastSeqBig`, strict inequality).
- **1b** Pushed 50 × 64 KiB chunks (3.125 MiB total) into a 2 MiB cap; verified
  exactly 32 chunks survive (32 × 64 KiB = 2 MiB), each chunk's `data.length`
  equals 64 KiB (no slice), starts with the marker byte we put in, and
  `prunedSeq === 18 × 65536` exactly. Also verified the invariant
  `chunks[0].seq == prunedSeq` holds (plan §6.1 #4).
- **1c** Pushed 100 × 1 KiB chunks; for `_chunksSince(chunks[40].seq)` got
  exactly chunks[41..99] in order. Edge case: `_chunksSince(totalSeq)` returns
  empty array.
- **1d** Replicated the exact FAST_PATH/SLOW_PATH router from
  `attachToSessionV2` lines 982-986 against post-eviction state. Confirmed:
  - `lastSeq=0` → SLOW (below prunedSeq)
  - `lastSeq=prunedSeq-1` → SLOW
  - `lastSeq=prunedSeq` → FAST
  - `lastSeq=totalSeq-1` → FAST
  - `lastSeq=totalSeq` → SLOW (no replay)
  - `lastSeq>totalSeq` → SLOW (epoch mismatch — important for blue/green flips)

### 2. ANSI integrity

- **2a** Built a 580-byte stream containing SGR/256-color, OSC window-title,
  cursor hide/move/clear-line/show, plus mixed text. Sliced at 10 arbitrary
  cut points (3, 9, 12, 28, 47, 80, 120, 200, 280, end) — many of which fall
  inside CSI sequences. After pushing all slices and reassembling via
  `_chunksSince(-1n).join("")`, the replayed stream is byte-for-byte identical
  to the original. **This is the load-bearing P1 closure**: chunks are stored
  verbatim, and concatenation is identity.
- **2b** Pushed 100 × ~32 KiB SGR-wrapped chunks to force eviction. Asserted
  every surviving chunk starts with `\x1b[38;5;` (full CSI opener) and ends
  with `\x1b[0m` (full CSI closer). No chunk was sliced mid-escape.

### 3. Per-client cursor

- **3a** Three synthetic clients with different `lastSeq` values — each sees
  only their missed tail. No cross-client mutation.
- **3b** Three real `_registerClientV2` records — confirmed they have distinct
  `queue` and `lastSentSeq` references; pushing into A's queue doesn't show up
  in B/C; mutating A's `lastSentSeq` doesn't change B/C; deleting A from
  `session.clients` leaves B/C intact.

### 4. Backpressure

- **4a** With `bufferedAmount=0`, `_drainClient` sends all 3 queued chunks in
  one cycle, leaves the queue empty, advances `lastSentSeq` to 3n, and never
  calls `ws.close()`.
- **4b** With `bufferedAmount = 8 MiB + 1`, `_drainClient` immediately calls
  `ws.close(4503, "lagging")` BEFORE sending any data, removes the client from
  `session.clients`, and increments `streamCounters.evictions`. Per plan §3.6
  exactly.
- **4c** With `readyState = 3` (CLOSED), `_drainClient` short-circuits without
  sending and removes the client from the Map. No `close()` call (the socket
  is already closed).

### 5. AWAIT_HELLO timer

Static-analysis asserts (no E2E because real WS would require live HTTP
upgrade flow):
- `HELLO_TIMEOUT_MS = 2000` confirmed.
- `setTimeout(..., HELLO_TIMEOUT_MS)` is the actual scheduling call (not a
  literal `2000`).
- `fallbackToLegacy()` is invoked from the timer body and from the
  parse-error / non-hello-first-message branches.
- `clearTimeout(helloTimer)` runs once `helloHandled` flips, preventing
  double-registration.
- The router conditions `lastSeqBig >= session.prunedSeq` and
  `lastSeqBig < session.totalSeq` exactly match plan §2.7.

### 6. Snapshot helper

- **6a** Created a real tmux session on a probe socket
  (`-L probe-validate-test`), invoked `tmuxSnapshot()` (re-loaded with the
  probe socket value), and asserted the return shape: `data` is a string
  starting with `\x1b[2J\x1b[H` (clear-home) and ending with `\x1b[Y;XH`
  (cursor-position). `cursor.{x,y}`, `cols`, `rows`, `alternate` all present
  with correct types. Probe socket is killed in `finally`.
- **6b** Loaded `terminal-manager.js` with `tmuxSnapshot` source-replaced by a
  deterministic stub returning `{data:"STUB-SNAPSHOT", cursor:{x:4,y:9},
  cols:80, rows:24, alternate:false}`. Pushed 5 × 100 B chunks (totalSeq=500n),
  invoked `_sendSnapshotPath`, and verified two frames sent in order:
  `{type:"snapshot", seq:"500", data:"STUB-SNAPSHOT", cols:80, rows:24,
  cursor:{x:4,y:9}}` then `{type:"replay_complete"}`. `clientRec.lastSentSeq`
  advanced to 500n. Per plan §2.3.3 exactly.

### 7. Seq monotonicity

- Pushed 100 chunks of varying sizes (50..149 B); confirmed seqs are strictly
  ascending and `last.seq + last.data.length === totalSeq` (plan §6.1 #3).

### 8. Legacy path

- **8a** Re-loaded the module with `CT_RELIABLE_STREAMING` undefined; confirmed
  `mgr.reliableStreaming === false` and `mgr.heartbeatInterval === null`. No
  `setInterval` ran.
- **8b** Static-analyzed `server.js`: `useReliable = RELIABLE_STREAMING && !devOptOut`,
  `attachToSessionV2` and `attachToSession` are both wired into the upgrade
  handler, the env-driven constant is initialised correctly.
- **8c** Sliced the source between `attachToSession` and `attachToSessionV2`
  method boundaries; confirmed the legacy slice contains
  `session.connectedClients.add(ws)` and `session.buffer`, and contains no
  `session.clients.set(...)` (which would indicate cross-contamination from V2
  into the legacy path).

---

## Source bugs / spec deviations found

### 0 hard bugs

The implementation is sound on every measurable axis. Every assertion the
harness exercises against the actual code passes.

### 2 spec deviations (already documented in `07-impl-tmux-WP-A.md`)

These are NOT bugs but worth re-flagging for the next-phase auditor:

1. **`_broadcastControlV2` bypasses per-client async drain** (file:
   `terminal-manager.js:550-557`). It does `ws.send(text)` directly inside a
   `for` loop instead of pushing into `clientRec.queue` and scheduling a
   drain. Consequence: a control envelope (exit/stopped/error) sent to a
   slow client whose `bufferedAmount` is already > 8 MiB will NOT trigger the
   eviction; the send just blocks at the socket level. Plan §10.3 explicitly
   says "DO NOT introduce a third broadcast pattern" — this is one. WP-A's
   own deviation #1 acknowledges a related case for initial replay. Severity:
   LOW (control envelopes are tiny and rare; the eviction would happen on the
   next live broadcast within milliseconds anyway). Suggested fix: route
   control envelopes through `_drainClient` like the spec asks (push to
   `queue` then `setImmediate(_drainClient)`).

2. **Initial replay (FAST_PATH/SLOW_PATH) bypasses the per-client async drain**
   (file: `terminal-manager.js:1042-1102`). Same root cause as above —
   `_sendResumePath` and `_sendSnapshotPath` call `ws.send(...)` directly
   inside their loops with no `bufferedAmount` check. WP-A flagged this as
   deviation #2 already. Severity: LOW (snapshots are <12 MiB, kernel buffer
   is typically already drained, and the next live broadcast picks up the
   eviction). Acceptable for ship; document that an oversize snapshot to a
   slow client could briefly exceed the ceiling before eviction kicks in.

### 1 cosmetic observation

- **FAST_PATH router has an extra `session.totalSeq > 0n` guard** (line 983)
  that the plan §2.4.1 does NOT require. It is, however, semantically correct
  — on a fresh session (`totalSeq=0n`) there's nothing to resume, so SLOW_PATH
  is the right answer. Test 1d explicitly verifies this is benign. NOT a bug;
  if anything, a defensive improvement.

---

## Assessment vs `05-decision-tmux.md` Success Criteria

| #  | Criterion                                                         | Coverage from harness                                             | Verdict          |
|----|-------------------------------------------------------------------|-------------------------------------------------------------------|------------------|
| S1 | Zero divergence over 1 h @ 200 KB/s                              | NOT MEASURED — needs real PTY + xterm. Harness verifies the data-structure invariant that makes divergence impossible. | INDIRECT (strong) |
| S2 | Reconnect preserves last 100 KB without ANSI corruption          | Tests 1b, 1c, 2a, 2b prove the chunk list never mid-cuts an escape. Test 6b proves snapshot path emits the canonical replay. | STRONG indirect  |
| S3 | Blue→green flip without losing visible screen state              | Test 6 proves snapshot path produces a self-contained replay with cursor/clear-home. Cross-instance epoch handling (test 1d row "lastSeq>totalSeq → SLOW") confirms the new instance falls through to snapshot. | STRONG indirect  |
| S4 | WS resume after 60 s offline ≤500 ms                             | NOT MEASURED — needs real WS. Test 5 confirms timer code paths exist. | INDIRECT         |
| S5 | Slow client cannot block fast client                              | Test 3b proves per-client records are independent. Test 4b proves ceiling-eviction. Test 4a proves drain doesn't spam when buffer low. | DIRECT (strong)  |
| S6 | Resize storm produces ≤2 `pty.resize`                            | Server-side equality coalesce code reviewed at `_handleSteadyStateMessage` line 1134. NOT exercised by harness. | INDIRECT         |
| S7 | Half-open TCP detected within 90 s                                | Heartbeat code reviewed (`_heartbeatTick` line 563-591); `setInterval(25_000)` confirmed. NOT exercised by harness. | INDIRECT         |
| S8 | Window resize during heavy output → no scramble                   | Same as S6.                                                        | INDIRECT         |
| S9 | Replay buffer head is always escape-aligned                       | **Test 2b directly exercises this** — every surviving chunk starts with full CSI opener. | DIRECT           |
| S10| Token re-fetch budget (auth, out-of-scope adjacent)              | Out of scope.                                                      | N/A              |

**"Раз и навсегда" assessment.** The user's complaint ("пакеты теряются /
экран ползёт") is rooted in three structural hazards: (a) `slice(-2_000_000)`
cuts mid-CSI, (b) synchronous broadcast lets a slow client block the producer,
(c) no seq/ack means reconnect-induced duplication is undetectable. The
harness PROVES that the new path closes (a) by construction (tests 1b, 2a, 2b),
provides isolation for (b) (tests 3b, 4a, 4b, 4c), and assigns absolute byte
addresses (tests 1c, 1d, 6b, 7a). This is the "fix the data structure" win
the decision document promised — not "less likely after a patch" but "the
data structure has no way to express the bug."

The path that is **not** verified by this harness layer:
- The actual round-trip of the protocol against a real WebSocket client
  (hello → resume vs snapshot routing on a live socket — only static-analyzed
  here).
- The behaviour of xterm.js when fed our snapshot+live frames in the right
  order (client-side flush-barrier correctness).
- The `setImmediate`-driven drain under real concurrent producer + consumer
  pressure (we tested the drain's logic, not its scheduling under load).

These are **inherently NOT covered by a Node-only harness** and require the
manual T1-T6 + S1-S9 tests from plan §6.

---

## Biggest unknown that only real-device testing can settle

**Whether `_sendResumePath` ordering survives a high-rate producer.** Initial
replay bypasses `_drainClient` (deviation #2 above). If a client is in the
middle of receiving a 12 MiB snapshot when the PTY produces a new chunk, the
new chunk goes into `clientRec.queue` and a `setImmediate(_drainClient)` is
scheduled. The drain races against the rest of the synchronous snapshot
sends. JavaScript single-threaded semantics guarantee `_sendResumePath`
completes before any `setImmediate` callback runs — so order IS preserved —
but if the snapshot's `ws.send` is async at the kernel level (it is) and the
live `_drainClient` call also does `ws.send`, both end up enqueued on the same
socket. RFC 6455 frame ordering is preserved at the socket level, so this is
fine in theory. Real-device testing should confirm under sustained 5 MB/s
that no observable reorder/loss happens during the snapshot→live transition.

A secondary unknown: the new `term.modes.applicationCursorKeysMode` read in
ModifierKeyBar (mobile WP-C) interacts with cursor-key SGR mode flips by
vim/tmux during reconnect. Not testable here.

---

## What the next-phase auditor should specifically look at

1. **`_broadcastControlV2` and initial-replay-bypass**: route them through
   `_drainClient` (or document explicitly that the eviction will fire on the
   next live chunk and is acceptable). Either is fine; right now the code is
   silent on the choice.
2. **Real-device S5 reproduction**: open two browser tabs, throttle one to
   100 KB/s with DevTools, verify the throttled one gets `close(4503,
   "lagging")` and reconnects with `lastSeq` resume. Eviction counter on the
   server should advance by 1.
3. **Real-device S2 reproduction**: disconnect for 10 s mid-tail, reconnect,
   verify `lastSeqRef` advances continuously. Confirm `replay_complete` arrives
   in <500 ms (S4).
4. **Snapshot epoch correctness across blue→green**: run `bash deploy.sh` mid
   `vim` session, confirm the new server's `tmuxSnapshot` produces a
   well-formed alt-screen replay (with `-a` flag for alt-screen). The harness
   tests the helper shape but cannot exercise the alt-screen branch
   end-to-end.
5. **Heartbeat false-positive rate**: confirm `pingTerminations` counter
   stays at 0 over a 24 h window with no real network failures.
6. **The WP-C client's `legacyFallbackTimerRef` (2 s)**: under packet loss
   the snapshot may parse slowly enough that the timer fires first and runs
   `term.clear()` over a partially-written snapshot. WP-C deviation #1 already
   flags this; auditor should reproduce on slow Android with a 12 MiB
   scrollback session.
7. **Memory pressure under N concurrent sessions**: 10 sessions × (2 MiB
   chunks + 8 MiB × 3 clients) = ~260 MiB worst case in node memory. Confirm
   actual residency vs estimate.

---

## Constraints honoured

- DID NOT modify `terminal-manager.js`, `server.js`, or any other source file.
- DID NOT run `npm run dev`, `pm2`, or `bash deploy.sh`.
- DID NOT touch the production tmux server (`tmux -L claude-terminal`); used
  a probe socket `-L probe-validate-test` for snapshot integration. Probe
  socket is killed in `finally` blocks; verified post-run with
  `tmux -L probe-validate-test list-sessions` returning "no server running".
- DID NOT add a CI runner entry for the harness — it's a one-shot script per
  the task instructions.

End of `08-validate-behavior-tmux.md`.
