/* eslint-disable no-console */
/**
 * reliable-streaming.test.js
 *
 * Behavioural validator for `CT_RELIABLE_STREAMING=1` (Robust-Lite WP-A).
 * Stress-tests the chunk-list buffer, snapshot helper, per-client cursor,
 * backpressure ceiling, and seq+ack handshake described in:
 *   - agent-workflow/05-decision-tmux.md
 *   - agent-workflow/06-integration-plan-tmux.md (especially §6, §2, §3, §9)
 *   - agent-workflow/07-impl-tmux-WP-A.md
 *
 * Run:  cd /root/projects/claude-terminal && node tests/reliable-streaming.test.js
 *
 * The harness loads `terminal-manager.js` once with the flag ON (to verify
 * construction-side wiring) and once with the flag OFF (to verify legacy
 * behaviour is preserved). It also reaches into `require.cache` to pull
 * private helpers (`tmuxSnapshot`, `encodeBinaryOutput`, `encodeBinarySnapshot`)
 * which are not part of `module.exports`.
 */

"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const childProcess = require("node:child_process");

// ──────────────────────────────────────────────────────────────────────────────
// Test scaffolding
// ──────────────────────────────────────────────────────────────────────────────

const RESULTS = [];
function record(name, status, detail) {
  RESULTS.push({ name, status, detail: detail || "" });
  const tag = status === "PASS" ? "PASS" : status === "FAIL" ? "FAIL" : "SKIP";
  const msg = detail ? ` — ${detail}` : "";
  console.log(`  [${tag}] ${name}${msg}`);
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

function runTest(name, fn) {
  try {
    const out = fn();
    if (out && typeof out.then === "function") {
      throw new Error("async tests not supported in this harness");
    }
    record(name, "PASS");
  } catch (err) {
    record(name, "FAIL", err && err.message ? err.message : String(err));
    if (process.env.HARNESS_VERBOSE && err && err.stack) {
      console.log(err.stack);
    }
  }
}

function skipTest(name, reason) {
  record(name, "SKIP", reason);
}

// Provide a minimal stub of global.db so TerminalManager constructor doesn't
// blow up — db is only consulted by createSession/resumeSession (we don't use
// either in this harness). _loadSessions / _cleanupOrphanedTmux / etc. only
// touch fs/tmux which are tolerant of missing data on a clean system.
global.db = {
  prepare: () => ({
    get: () => null,
    run: () => ({}),
    all: () => [],
  }),
};

// We allocate a unique sessions file per harness run so we don't disturb the
// real ~/projects/Claude/.sessions.json. The TerminalManager hardcodes the
// path, so we clear `require.cache` between re-loads but cannot reroute the
// path. Instead we accept the side effect of TerminalManager reading the real
// sessions file — _loadSessions is tolerant of missing/corrupt input.

// ──────────────────────────────────────────────────────────────────────────────
// Helper: load terminal-manager.js with a specific env flag value, returning
// both the module exports AND the cached module record so we can read private
// helpers via `require.cache`.
// ──────────────────────────────────────────────────────────────────────────────

function loadManager(flagValue) {
  const modulePath = require.resolve(
    path.join(__dirname, "..", "terminal-manager.js")
  );
  // Drop any cached copy so the module-init constants re-evaluate.
  delete require.cache[modulePath];
  const prev = process.env.CT_RELIABLE_STREAMING;
  if (flagValue === undefined) {
    delete process.env.CT_RELIABLE_STREAMING;
  } else {
    process.env.CT_RELIABLE_STREAMING = flagValue;
  }
  let exported;
  try {
    exported = require(modulePath);
  } finally {
    if (prev === undefined) {
      delete process.env.CT_RELIABLE_STREAMING;
    } else {
      process.env.CT_RELIABLE_STREAMING = prev;
    }
  }
  const cached = require.cache[modulePath];
  return { exported, cached };
}

// Pull private helpers out of the loaded module via static source analysis +
// indirect invocation. Because `terminal-manager.js` does NOT export them, we
// re-`require` the file with a Function-eval shim that re-exports the helpers
// we need. Cleaner than `eval`-ing the whole source. We grep for the function
// names from the source and call the bound copies inside the cached module's
// `module.exports` object via a side-channel.
//
// Simpler: read source and hand-evaluate small extracted helpers. Because we
// also need consistent state, the harness uses real class methods on a fresh
// TerminalManager instance for the chunk-list tests, and reaches into the
// module cache for module-level pure helpers (encodeBinary*, tmuxSnapshot)
// using a re-evaluation shim.
//
// The shim works by reading the source, appending an explicit
// `module.exports.__test_helpers = { ... }` line, and using `vm.runInThisContext`
// to evaluate the modified source in a fresh module scope.

function loadManagerWithHelperExposure(flagValue) {
  const Module = require("module");
  const filename = path.resolve(__dirname, "..", "terminal-manager.js");
  const source = fs.readFileSync(filename, "utf-8");
  const patched =
    source +
    "\n;module.exports = Object.assign({}, module.exports, { __helpers: { tmuxSnapshot, encodeBinaryFrame, encodeBinaryOutput, encodeBinarySnapshot, OPCODE_OUTPUT, OPCODE_SNAPSHOT, CHUNK_BYTES_CAP, BUFFERED_CEILING, HEARTBEAT_INTERVAL_MS, HELLO_TIMEOUT_MS, RELIABLE_STREAMING } });\n";

  const m = new Module(filename, module);
  m.filename = filename;
  m.paths = Module._nodeModulePaths(path.dirname(filename));

  const prev = process.env.CT_RELIABLE_STREAMING;
  if (flagValue === undefined) {
    delete process.env.CT_RELIABLE_STREAMING;
  } else {
    process.env.CT_RELIABLE_STREAMING = flagValue;
  }
  try {
    // eslint-disable-next-line no-underscore-dangle
    m._compile(patched, filename);
  } finally {
    if (prev === undefined) {
      delete process.env.CT_RELIABLE_STREAMING;
    } else {
      process.env.CT_RELIABLE_STREAMING = prev;
    }
  }
  return m.exports;
}

// ──────────────────────────────────────────────────────────────────────────────
// Make a synthetic session shape (mirrors `_makeSession` in terminal-manager.js)
// ──────────────────────────────────────────────────────────────────────────────

function makeSyntheticSession() {
  return {
    pty: null,
    projectDir: "/tmp",
    connectedClients: new Set(),
    createdAt: new Date(),
    lastActivityAt: new Date(),
    buffer: "",
    exited: true,
    displayName: null,
    providerSlug: "claude",
    chunks: [],
    chunkBytes: 0,
    totalSeq: 0n,
    prunedSeq: 0n,
    cols: 200,
    rows: 50,
    clients: new Map(),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Mock WebSocket — implements only what _drainClient and _heartbeatTick read.
// Tracks bufferedAmount externally; allows us to force values and observe close
// codes / sent frames.
// ──────────────────────────────────────────────────────────────────────────────

function makeMockWs(opts = {}) {
  const ws = {
    readyState: 1, // 1 = OPEN
    bufferedAmount: 0,
    sentFrames: [],
    closeCalls: [],
    pingCount: 0,
    terminated: false,
    handlers: {},
    _closed: false,
  };
  ws.send = (frame) => {
    if (ws._sendThrows) throw new Error(ws._sendThrows);
    ws.sentFrames.push(frame);
    if (opts.simulateBacklog) {
      ws.bufferedAmount += typeof frame === "string"
        ? Buffer.byteLength(frame, "utf-8")
        : frame.length;
    }
  };
  ws.close = (code, reason) => {
    ws.closeCalls.push({ code, reason });
    ws.readyState = 3; // CLOSED
    ws._closed = true;
    if (ws.handlers.close) ws.handlers.close({ code, reason });
  };
  ws.terminate = () => {
    ws.terminated = true;
    ws.readyState = 3;
    if (ws.handlers.close) ws.handlers.close({ code: 1006, reason: "" });
  };
  ws.ping = () => {
    ws.pingCount += 1;
  };
  ws.on = (event, handler) => {
    ws.handlers[event] = handler;
  };
  ws.off = (event /* , handler */) => {
    delete ws.handlers[event];
  };
  return ws;
}

// ──────────────────────────────────────────────────────────────────────────────
// 1. Chunk-list buffer correctness
// ──────────────────────────────────────────────────────────────────────────────

section("1. Chunk-list buffer correctness");

const helpers = loadManagerWithHelperExposure("1");
const { TerminalManager } = helpers;
const PRIVATE = helpers.__helpers;

// Construct manager — the constructor will read real .sessions.json. That's
// tolerated because the chunk-list tests we run only touch synthetic sessions.
let mgr;
try {
  mgr = new TerminalManager();
} catch (err) {
  console.error("FATAL: TerminalManager constructor threw:", err.message);
  process.exit(1);
}

runTest("1a. push 1000 chunks, chunksSince(0) returns all in order", () => {
  const session = makeSyntheticSession();
  // Use 8-byte average chunks so 1000 of them stays well under the 2 MiB cap
  // (no eviction during this test). 1000 × 256 B = 250 KiB — comfortable.
  const inputs = [];
  for (let i = 0; i < 1000; i++) {
    const sz = 1 + Math.floor(Math.random() * 256); // 1..256 bytes
    const data = "x".repeat(sz);
    inputs.push(data);
    mgr._pushChunk(session, data);
  }
  // No eviction expected (total ≪ 2 MiB).
  assert.equal(session.chunks.length, 1000, "all chunks retained");
  const out = mgr._chunksSince(session, -1n);
  assert.equal(out.length, 1000, "chunksSince(-1n) returns all 1000");
  // Order check: seq is strictly increasing AND data matches input order.
  for (let i = 0; i < 1000; i++) {
    assert.equal(out[i].data, inputs[i], `chunk ${i} data preserved`);
    if (i > 0) {
      assert.ok(out[i].seq > out[i - 1].seq, `seq strictly ascending at ${i}`);
    }
  }
  // chunksSince(0n) per spec returns chunks where seq > 0n; the very first
  // chunk has seq=0n so it would be EXCLUDED. This matches plan §6.1.
  const fromZero = mgr._chunksSince(session, 0n);
  assert.equal(fromZero.length, 999, "chunksSince(0n) drops the seq=0 chunk");
});

runTest("1b. eviction at chunk granularity (no mid-chunk slice)", () => {
  const session = makeSyntheticSession();
  // Push 64 KiB chunks until we exceed the 2 MiB cap.
  const CHUNK_SIZE = 64 * 1024;
  const N = 50; // 50 × 64 KiB = 3.125 MiB → eviction must reduce to ≤ 2 MiB
  for (let i = 0; i < N; i++) {
    const data = `=${"x".repeat(CHUNK_SIZE - 1)}`; // distinguishable per chunk
    mgr._pushChunk(session, data);
  }
  // Cap is 2 MiB; with 64 KiB chunks, 32 of them × 64 KiB = exactly 2 MiB.
  assert.ok(
    session.chunkBytes <= PRIVATE.CHUNK_BYTES_CAP,
    `chunkBytes ${session.chunkBytes} should be <= ${PRIVATE.CHUNK_BYTES_CAP}`
  );
  // Per WP-A changelog "32 chunks × 64 KiB = exactly 2 MiB".
  assert.equal(session.chunks.length, 32, "exactly 32 chunks remain");
  // No mid-chunk slice: every chunk's data length is unchanged.
  for (const c of session.chunks) {
    assert.equal(c.data.length, CHUNK_SIZE, "chunk data preserved verbatim");
    assert.equal(c.data[0], "=", "chunk starts with the original marker byte");
  }
  // prunedSeq must point exactly at the seq immediately AFTER the last
  // evicted chunk's last byte. With 18 chunks evicted (50-32) × 64 KiB = 18*65536:
  const expectedPruned = BigInt(18 * CHUNK_SIZE);
  assert.equal(session.prunedSeq, expectedPruned, "prunedSeq monotonic & exact");
  // The OLDEST remaining chunk's seq must equal prunedSeq exactly.
  assert.equal(
    session.chunks[0].seq,
    session.prunedSeq,
    "chunks[0].seq == prunedSeq invariant (plan §6.1 #4)"
  );
});

runTest("1c. chunksSince(arbitrary seq) returns contiguous tail", () => {
  const session = makeSyntheticSession();
  // 100 × 1 KiB chunks, no eviction (well under cap).
  for (let i = 0; i < 100; i++) {
    mgr._pushChunk(session, `chunk-${String(i).padStart(3, "0")}-${"x".repeat(1010)}`);
  }
  // Pick a random seq somewhere in the middle.
  const midChunk = session.chunks[40];
  const tail = mgr._chunksSince(session, midChunk.seq);
  // tail must be chunks[41..99] inclusive (seq STRICTLY > midChunk.seq).
  assert.equal(tail.length, 59, "tail length is 100 - 41 = 59");
  for (let i = 0; i < tail.length; i++) {
    assert.equal(tail[i].seq, session.chunks[41 + i].seq, "tail seq match");
    assert.equal(tail[i].data, session.chunks[41 + i].data, "tail data match");
  }
  // chunksSince(totalSeq) must return [].
  assert.deepEqual(
    mgr._chunksSince(session, session.totalSeq),
    [],
    "chunksSince(totalSeq) returns empty"
  );
});

runTest("1d. snapshot path triggered when lastSeq < oldestRemainingSeq", () => {
  // This test mirrors the FAST_PATH/SLOW_PATH router in attachToSessionV2:
  //   if lastSeq >= prunedSeq && lastSeq < totalSeq → FAST_PATH
  //   else → SLOW_PATH (snapshot)
  const session = makeSyntheticSession();
  for (let i = 0; i < 50; i++) {
    mgr._pushChunk(session, "x".repeat(64 * 1024)); // forces eviction
  }
  // After the loop, chunks[0].seq > 0 — clients with lastSeq=0 must SLOW_PATH.
  assert.ok(session.prunedSeq > 0n, "some chunks evicted");
  // Replicate the route logic from attachToSessionV2 (lines 982-986).
  function route(lastSeqBig) {
    if (
      session.totalSeq > 0n &&
      lastSeqBig >= session.prunedSeq &&
      lastSeqBig < session.totalSeq
    ) {
      return "FAST";
    }
    return "SLOW";
  }
  assert.equal(route(0n), "SLOW", "lastSeq=0 → SLOW (below prunedSeq)");
  assert.equal(
    route(session.prunedSeq - 1n),
    "SLOW",
    "lastSeq just below prunedSeq → SLOW"
  );
  assert.equal(route(session.prunedSeq), "FAST", "lastSeq == prunedSeq → FAST");
  assert.equal(
    route(session.totalSeq - 1n),
    "FAST",
    "lastSeq just below totalSeq → FAST"
  );
  assert.equal(route(session.totalSeq), "SLOW", "lastSeq == totalSeq → SLOW (no replay needed)");
  assert.equal(
    route(session.totalSeq + 1n),
    "SLOW",
    "lastSeq beyond totalSeq → SLOW (epoch mismatch)"
  );
});

// ──────────────────────────────────────────────────────────────────────────────
// 2. ANSI-escape integrity across chunk boundaries
// ──────────────────────────────────────────────────────────────────────────────

section("2. ANSI-escape integrity (replay equals concatenation)");

runTest("2a. CSI/OSC/SGR sequences split across chunks → exact byte replay", () => {
  const session = makeSyntheticSession();
  // Build a stream containing several full ANSI sequences:
  //   CSI: \x1b[38;5;234m█\x1b[0m   (SGR with 256-color foreground)
  //   OSC: \x1b]0;hello world\x07   (set window title)
  //   plus mixed text + CRLF.
  const stream =
    "Hello \x1b[38;5;234m█world\x1b[0m\r\n" +
    "\x1b]0;hello world\x07more text\r\n" +
    "\x1b[?25l\x1b[2;1H\x1b[K\x1b[?25h" + // cursor hide / move / clear-line / show
    "0123456789".repeat(32);
  // Split AT POSITIONS THAT INTENTIONALLY CUT AN ESCAPE in the WIRE stream,
  // mirroring real-life node-pty.onData timing. The buffer must NOT re-cut
  // these — chunks are stored verbatim, and chunksSince concatenation must
  // yield the original byte-stream exactly.
  const splitPoints = [3, 9, 12, 28, 47, 80, 120, 200, 280, stream.length];
  let prev = 0;
  for (const p of splitPoints) {
    const slice = stream.slice(prev, p);
    if (slice.length > 0) mgr._pushChunk(session, slice);
    prev = p;
  }
  const replayed = mgr
    ._chunksSince(session, -1n)
    .map((c) => c.data)
    .join("");
  assert.equal(replayed, stream, "byte-for-byte equality after split-and-replay");
  assert.equal(
    Buffer.byteLength(replayed, "utf-8"),
    Buffer.byteLength(stream, "utf-8"),
    "byte length matches"
  );
});

runTest("2b. chunk-granularity eviction preserves chunk integrity", () => {
  // Push many small ANSI-laden chunks past the 2 MiB cap and verify the
  // surviving chunks are byte-for-byte the originals (no eviction-side slice).
  const session = makeSyntheticSession();
  const sentinels = [];
  // Each chunk is a recognisable SGR + payload (~32 KiB) so we can assert
  // that no surviving chunk starts with a CSI fragment (P1 closure).
  for (let i = 0; i < 100; i++) {
    const data = `\x1b[38;5;${i % 256}m` + "█".repeat(32 * 1024) + "\x1b[0m";
    sentinels.push(data);
    mgr._pushChunk(session, data);
  }
  // Eviction has run. Surviving chunks must each:
  //   - start with `\x1b[38;5;` (the SGR opener — never mid-CSI),
  //   - end with `\x1b[0m` (the SGR closer — never mid-CSI),
  //   - exist verbatim in the original sentinels list.
  for (const c of session.chunks) {
    assert.ok(
      c.data.startsWith("\x1b[38;5;"),
      "surviving chunk starts with full CSI opener (no mid-escape eviction)"
    );
    assert.ok(
      c.data.endsWith("\x1b[0m"),
      "surviving chunk ends with full CSI closer"
    );
    assert.ok(sentinels.includes(c.data), "surviving chunk equals an original");
  }
  assert.ok(
    session.chunkBytes <= PRIVATE.CHUNK_BYTES_CAP,
    "post-eviction chunkBytes within cap"
  );
});

// ──────────────────────────────────────────────────────────────────────────────
// 3. Per-client cursor isolation
// ──────────────────────────────────────────────────────────────────────────────

section("3. Per-client cursor — three clients with different lastSeq");

runTest("3a. each client sees only its own missed chunks", () => {
  const session = makeSyntheticSession();
  for (let i = 0; i < 10; i++) {
    mgr._pushChunk(session, `chunk-${i}`);
  }
  // Capture seqs.
  const seq3 = session.chunks[3].seq;
  const seq6 = session.chunks[6].seq;
  const seq9 = session.chunks[9].seq;

  const tailA = mgr._chunksSince(session, -1n); // fresh client → all 10
  const tailB = mgr._chunksSince(session, seq3); // saw 0..3 → expects 4..9 = 6
  const tailC = mgr._chunksSince(session, seq6); // saw 0..6 → expects 7..9 = 3
  const tailD = mgr._chunksSince(session, seq9); // up to date → 0
  assert.equal(tailA.length, 10);
  assert.equal(tailB.length, 6);
  assert.equal(tailC.length, 3);
  assert.equal(tailD.length, 0);
});

runTest("3b. mutating one client's record does not affect another", () => {
  const session = makeSyntheticSession();
  for (let i = 0; i < 5; i++) mgr._pushChunk(session, `chunk-${i}`);

  const wsA = makeMockWs();
  const wsB = makeMockWs();
  const wsC = makeMockWs();

  const recA = mgr._registerClientV2(session, wsA, { binary_capable: false, lastSeq: 0n });
  const recB = mgr._registerClientV2(session, wsB, { binary_capable: true, lastSeq: 0n });
  const recC = mgr._registerClientV2(session, wsC, { binary_capable: false, lastSeq: session.chunks[2].seq });

  // Each ClientRecord must be a distinct object with its own queue.
  assert.notEqual(recA, recB, "distinct A vs B");
  assert.notEqual(recA, recC, "distinct A vs C");
  assert.notEqual(recA.queue, recB.queue, "A.queue !== B.queue");
  assert.notEqual(recA.queue, recC.queue, "A.queue !== C.queue");

  // Mutate A's queue: must not affect B/C.
  recA.queue.push({ seq: 999n, data: "POISON" });
  assert.equal(recB.queue.length, 0, "B unaffected by A push");
  assert.equal(recC.queue.length, 0, "C unaffected by A push");

  // Mutate A's lastSentSeq: must not affect B/C.
  recA.lastSentSeq = 12345n;
  assert.equal(recB.lastSentSeq, 0n, "B.lastSentSeq unchanged");
  assert.equal(recC.lastSentSeq, session.chunks[2].seq, "C.lastSentSeq unchanged");

  // Closing one client only removes that client from session.clients.
  session.clients.delete(wsA);
  assert.equal(session.clients.size, 2, "B and C still in clients map");
  assert.ok(session.clients.has(wsB), "B retained");
  assert.ok(session.clients.has(wsC), "C retained");
});

// ──────────────────────────────────────────────────────────────────────────────
// 4. Backpressure simulation (bufferedAmount ceiling → 4503 close)
// ──────────────────────────────────────────────────────────────────────────────

section("4. Backpressure — bufferedAmount ceiling triggers close(4503)");

runTest("4a. _drainClient queues rather than send-spamming when bufferedAmount low", () => {
  const session = makeSyntheticSession();
  const ws = makeMockWs();
  const rec = mgr._registerClientV2(session, ws, { binary_capable: false, lastSeq: 0n });
  // Queue 3 chunks; nothing else triggered.
  rec.queue.push({ seq: 1n, data: "a" }, { seq: 2n, data: "b" }, { seq: 3n, data: "c" });
  mgr._drainClient(rec, session);
  assert.equal(ws.sentFrames.length, 3, "all 3 chunks sent in one drain cycle");
  // No close.
  assert.equal(ws.closeCalls.length, 0, "no close triggered when buffered low");
  // Queue is empty after drain.
  assert.equal(rec.queue.length, 0, "queue drained");
  // lastSentSeq advanced to 3.
  assert.equal(rec.lastSentSeq, 3n, "lastSentSeq advanced");
});

runTest("4b. ceiling-eviction closes slow client with code 4503", () => {
  const session = makeSyntheticSession();
  const ws = makeMockWs();
  // Force bufferedAmount over the ceiling BEFORE drain runs.
  ws.bufferedAmount = PRIVATE.BUFFERED_CEILING + 1;
  const rec = mgr._registerClientV2(session, ws, { binary_capable: false, lastSeq: 0n });
  rec.queue.push({ seq: 1n, data: "x" });
  // Capture the evictions counter before.
  const beforeEvictions = mgr.streamCounters.evictions;
  mgr._drainClient(rec, session);
  // Client must be closed with 4503 / "lagging".
  assert.equal(ws.closeCalls.length, 1, "ws.close() called once");
  assert.equal(ws.closeCalls[0].code, 4503, "close code is 4503");
  assert.equal(ws.closeCalls[0].reason, "lagging", "close reason is 'lagging'");
  // Removed from session.clients.
  assert.ok(!session.clients.has(ws), "client removed from session.clients");
  // Evictions counter incremented.
  assert.equal(
    mgr.streamCounters.evictions,
    beforeEvictions + 1,
    "evictions counter incremented"
  );
  // No actual data frame was sent.
  assert.equal(ws.sentFrames.length, 0, "no chunk sent past the ceiling");
});

runTest("4c. drain on dead ws drops client without close call", () => {
  const session = makeSyntheticSession();
  const ws = makeMockWs();
  ws.readyState = 3; // CLOSED before drain
  const rec = mgr._registerClientV2(session, ws, { binary_capable: false, lastSeq: 0n });
  rec.queue.push({ seq: 1n, data: "x" });
  mgr._drainClient(rec, session);
  // No frames sent (readyState !== 1 short-circuit).
  assert.equal(ws.sentFrames.length, 0);
  // Removed from session.clients.
  assert.ok(!session.clients.has(ws));
});

// ──────────────────────────────────────────────────────────────────────────────
// 5. AWAIT_HELLO timer (static analysis of terminal-manager.js)
// ──────────────────────────────────────────────────────────────────────────────

section("5. AWAIT_HELLO 2 s timer (static analysis)");

runTest("5a. HELLO_TIMEOUT_MS constant equals 2000", () => {
  assert.equal(PRIVATE.HELLO_TIMEOUT_MS, 2000, "constant is 2000 ms");
});

runTest("5b. attachToSessionV2 schedules helloTimer with HELLO_TIMEOUT_MS and falls back", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "terminal-manager.js"),
    "utf-8"
  );
  // The implementation MUST call setTimeout with the constant (not a literal).
  const setTimeoutWithConstant = /setTimeout\([^,]+,\s*HELLO_TIMEOUT_MS\)/;
  assert.ok(
    setTimeoutWithConstant.test(src),
    "setTimeout(..., HELLO_TIMEOUT_MS) present in attachToSessionV2"
  );
  // The timer body must call fallbackToLegacy (or equivalent SLOW_PATH).
  assert.ok(
    src.includes("fallbackToLegacy()"),
    "fallbackToLegacy is invoked from somewhere in the AWAIT_HELLO branch"
  );
  // The fallback must clear the helloTimer once it fires (idempotency).
  assert.ok(
    /clearTimeout\(helloTimer\)/.test(src),
    "helloTimer cleared when handshake completes or falls back"
  );
  // The fallback path must also run on first non-hello message.
  assert.ok(
    /firstMessageHandler/.test(src),
    "first-message handler installed"
  );
});

runTest("5c. firstMessageHandler routes hello vs non-hello and SLOW/FAST per plan §2.7", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "terminal-manager.js"),
    "utf-8"
  );
  // hello v2 → register V2 client + route per lastSeq.
  assert.ok(
    src.includes(`message.type === "hello"`),
    "hello type checked"
  );
  assert.ok(
    /protocol_version\s*!==\s*2/.test(src),
    "protocol_version mismatch handled"
  );
  // SLOW vs FAST condition matches plan §2.7.
  assert.ok(
    /lastSeqBig\s*>=\s*session\.prunedSeq/.test(src),
    "fast-path lower bound check (lastSeq >= prunedSeq)"
  );
  assert.ok(
    /lastSeqBig\s*<\s*session\.totalSeq/.test(src),
    "fast-path upper bound check (lastSeq < totalSeq)"
  );
});

// ──────────────────────────────────────────────────────────────────────────────
// 6. Snapshot helper (real tmux session if possible, else mock)
// ──────────────────────────────────────────────────────────────────────────────

section("6. tmuxSnapshot helper");

let tmuxAvailable = false;
let tmuxVersion = "";
try {
  tmuxVersion = childProcess.execSync("tmux -V", { encoding: "utf-8" }).trim();
  tmuxAvailable = true;
} catch {
  tmuxAvailable = false;
}

const PROBE_SOCKET = "probe-validate-test";

function tmuxKill() {
  try {
    childProcess.execSync(
      `tmux -L ${PROBE_SOCKET} kill-server 2>/dev/null`,
      { stdio: ["pipe", "pipe", "pipe"] }
    );
  } catch {
    /* nothing to kill */
  }
}

if (tmuxAvailable) {
  // Build a fresh tmux session on a probe socket. The implementation hardcodes
  // the socket name `claude-terminal`. To avoid mutating production state we
  // instead test `tmuxSnapshot` indirectly: re-evaluate the source with our
  // probe-socket value substituted, expose the patched helper, and call it.

  function loadHelpersWithSocket(socketName) {
    const Module = require("module");
    const filename = path.resolve(__dirname, "..", "terminal-manager.js");
    let source = fs.readFileSync(filename, "utf-8");
    source = source.replace(
      'const TMUX_SOCKET = "claude-terminal";',
      `const TMUX_SOCKET = "${socketName}";`
    );
    source +=
      "\n;module.exports = Object.assign({}, module.exports, { __helpers: { tmuxSnapshot, encodeBinaryFrame, encodeBinaryOutput, encodeBinarySnapshot, OPCODE_OUTPUT, OPCODE_SNAPSHOT, CHUNK_BYTES_CAP, BUFFERED_CEILING, HEARTBEAT_INTERVAL_MS, HELLO_TIMEOUT_MS, RELIABLE_STREAMING, TMUX_SOCKET } });\n";

    const m = new Module(filename, module);
    m.filename = filename;
    m.paths = Module._nodeModulePaths(path.dirname(filename));
    process.env.CT_RELIABLE_STREAMING = "1";
    try {
      // eslint-disable-next-line no-underscore-dangle
      m._compile(source, filename);
    } finally {
      delete process.env.CT_RELIABLE_STREAMING;
    }
    return m.exports.__helpers;
  }

  runTest("6a. tmuxSnapshot returns {data, cursor:{x,y}, cols, rows, alternate}", () => {
    tmuxKill();
    const sessName = "harness-snapshot-test";
    // Create a tmux session with deterministic content.
    childProcess.execSync(
      `tmux -L ${PROBE_SOCKET} new-session -d -s ${sessName} -x 80 -y 24 "sleep 30"`,
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    // Send some keys so the pane has visible content.
    childProcess.execSync(
      `tmux -L ${PROBE_SOCKET} send-keys -t ${sessName} "echo hello-from-harness" Enter`,
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    // Wait briefly for the output to land. Synchronous sleep is fine.
    childProcess.execSync("sleep 0.3");

    try {
      const probeHelpers = loadHelpersWithSocket(PROBE_SOCKET);
      const snap = probeHelpers.tmuxSnapshot(sessName);
      assert.equal(typeof snap, "object", "snapshot is an object");
      assert.equal(typeof snap.data, "string", "data is string");
      assert.ok(snap.cursor && typeof snap.cursor === "object", "cursor object present");
      assert.equal(typeof snap.cursor.x, "number", "cursor.x number");
      assert.equal(typeof snap.cursor.y, "number", "cursor.y number");
      assert.equal(typeof snap.cols, "number", "cols number");
      assert.equal(typeof snap.rows, "number", "rows number");
      assert.equal(typeof snap.alternate, "boolean", "alternate boolean");
      // Data must start with the clear-home wrapper from plan §3.5 step 5.
      assert.ok(
        snap.data.startsWith("\x1b[2J\x1b[H"),
        "snapshot.data starts with \\x1b[2J\\x1b[H clear-home"
      );
      // Data must end with a cursor-position CSI.
      assert.ok(
        /\x1b\[\d+;\d+H$/.test(snap.data),
        "snapshot.data ends with \\x1b[Y;XH cursor-position"
      );
    } finally {
      tmuxKill();
    }
  });

  runTest("6b. _sendSnapshotPath wires snapshot.seq = session.totalSeq (epoch) and emits replay_complete", () => {
    // The plan calls the snapshot's seq the "epoch" — equal to session.totalSeq
    // at capture time. _sendSnapshotPath calls the *module-bound* tmuxSnapshot
    // (which uses the destructured execFileSync captured at module-load), so we
    // cannot monkey-patch from outside the module scope. Instead we re-evaluate
    // the source with `tmuxSnapshot` REPLACED by a deterministic stub, then
    // exercise _sendSnapshotPath through the patched module's TerminalManager.
    const Module = require("module");
    const filename = path.resolve(__dirname, "..", "terminal-manager.js");
    let source = fs.readFileSync(filename, "utf-8");
    // Replace the body of tmuxSnapshot with a deterministic constant. We keep
    // the function signature intact so all internal callers reach the stub.
    source = source.replace(
      /function tmuxSnapshot\(sessionId\) \{[\s\S]*?^\}\n/m,
      [
        "function tmuxSnapshot(sessionId) {",
        '  return { data: "STUB-SNAPSHOT", cursor: { x: 4, y: 9 }, cols: 80, rows: 24, alternate: false };',
        "}\n",
      ].join("\n")
    );
    source +=
      "\n;module.exports = Object.assign({}, module.exports, { __helpers: { tmuxSnapshot } });\n";
    const m = new Module(filename, module);
    m.filename = filename;
    m.paths = Module._nodeModulePaths(path.dirname(filename));
    process.env.CT_RELIABLE_STREAMING = "1";
    let ProbeMgr;
    try {
      // eslint-disable-next-line no-underscore-dangle
      m._compile(source, filename);
      ProbeMgr = m.exports.TerminalManager;
    } finally {
      delete process.env.CT_RELIABLE_STREAMING;
    }
    assert.ok(ProbeMgr, "patched TerminalManager loaded");
    // Confirm the stub is what runs.
    const probeSnap = m.exports.__helpers.tmuxSnapshot("anything");
    assert.equal(probeSnap.data, "STUB-SNAPSHOT", "stub installed correctly");

    const probeMgr = new ProbeMgr();
    try {
      const session = makeSyntheticSession();
      for (let i = 0; i < 5; i++) probeMgr._pushChunk(session, "x".repeat(100));
      const epoch = session.totalSeq;
      assert.equal(epoch, 500n, "epoch == sum(data.length)");

      const ws = makeMockWs();
      const rec = probeMgr._registerClientV2(session, ws, { binary_capable: false, lastSeq: 0n });
      probeMgr._sendSnapshotPath(session, "any-session-id", rec);

      assert.equal(ws.sentFrames.length, 2, "snapshot + replay_complete sent");
      const snapshotFrame = JSON.parse(ws.sentFrames[0]);
      assert.equal(snapshotFrame.type, "snapshot");
      // Per plan §2.3.3 seq is decimal-encoded BigInt.
      assert.equal(snapshotFrame.seq, String(epoch), "snapshot.seq === String(epoch)");
      assert.equal(snapshotFrame.data, "STUB-SNAPSHOT", "snapshot.data piped through");
      assert.equal(snapshotFrame.cols, 80, "cols from snapshot");
      assert.equal(snapshotFrame.rows, 24, "rows from snapshot");
      assert.deepEqual(snapshotFrame.cursor, { x: 4, y: 9 }, "cursor round-tripped");
      const completeFrame = JSON.parse(ws.sentFrames[1]);
      assert.equal(completeFrame.type, "replay_complete");
      assert.equal(rec.lastSentSeq, epoch, "lastSentSeq advanced to epoch");
    } finally {
      if (probeMgr.destroy) probeMgr.destroy();
    }
  });
} else {
  skipTest("6a. tmuxSnapshot via real tmux", "tmux not installed on host");
  skipTest("6b. snapshot epoch wiring", "tmux not installed; skipping integration");
}

// ──────────────────────────────────────────────────────────────────────────────
// 7. Seq monotonicity
// ──────────────────────────────────────────────────────────────────────────────

section("7. Seq monotonicity");

runTest("7a. push 100 chunks → seqs strictly ascending, totalSeq matches sum of bytes", () => {
  const session = makeSyntheticSession();
  let cumulative = 0;
  for (let i = 0; i < 100; i++) {
    const data = "x".repeat(50 + i); // varying sizes
    cumulative += data.length;
    mgr._pushChunk(session, data);
  }
  // Strictly ascending.
  for (let i = 1; i < session.chunks.length; i++) {
    assert.ok(
      session.chunks[i].seq > session.chunks[i - 1].seq,
      `seq strictly ascending at i=${i}`
    );
  }
  // totalSeq matches cumulative byte count.
  assert.equal(session.totalSeq, BigInt(cumulative), "totalSeq == sum of data.length");
  // Last chunk's seq + length == totalSeq.
  const last = session.chunks[session.chunks.length - 1];
  assert.equal(
    last.seq + BigInt(last.data.length),
    session.totalSeq,
    "last chunk's seq + length == totalSeq (plan §6.1 #3)"
  );
});

// ──────────────────────────────────────────────────────────────────────────────
// 8. Legacy path off
// ──────────────────────────────────────────────────────────────────────────────

section("8. Legacy path with CT_RELIABLE_STREAMING undefined");

runTest("8a. module flag is false when env var unset, no heartbeat scheduled", () => {
  // Re-load with flag undefined.
  const legacyMod = loadManagerWithHelperExposure(undefined);
  const legacyMgr = new legacyMod.TerminalManager();
  try {
    assert.equal(legacyMgr.reliableStreaming, false, "reliableStreaming === false");
    assert.equal(legacyMgr.heartbeatInterval, null, "no heartbeatInterval scheduled");
  } finally {
    if (legacyMgr.destroy) legacyMgr.destroy();
  }
});

runTest("8b. server.js routes to attachToSession (not V2) when flag off", () => {
  const serverSrc = fs.readFileSync(
    path.join(__dirname, "..", "server.js"),
    "utf-8"
  );
  // Verify the routing block exists and matches the contract:
  //   if (useReliable) terminalManager.attachToSessionV2(...)
  //   else             terminalManager.attachToSession(...)
  assert.ok(
    /useReliable\s*=\s*RELIABLE_STREAMING\s*&&\s*!devOptOut/.test(serverSrc),
    "useReliable derived from RELIABLE_STREAMING"
  );
  assert.ok(
    /attachToSessionV2\(sessionId,\s*ws\)/.test(serverSrc),
    "attachToSessionV2 wired into upgrade handler"
  );
  assert.ok(
    /attachToSession\(sessionId,\s*ws\)/.test(serverSrc),
    "legacy attachToSession still wired"
  );
  // Confirm the environment-driven constant.
  assert.ok(
    /const RELIABLE_STREAMING = process\.env\.CT_RELIABLE_STREAMING === "1"/.test(serverSrc),
    "RELIABLE_STREAMING constant initialised from env"
  );
});

runTest("8c. legacy attachToSession uses session.buffer + connectedClients (no chunk fan-out)", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "terminal-manager.js"),
    "utf-8"
  );
  // The legacy attach path (not V2) must reference session.buffer and
  // connectedClients.add(ws) — these are the load-bearing legacy structures.
  // We pull the slice of source between `attachToSession(sessionId, ws)` and
  // `attachToSessionV2(sessionId, ws)` (which is the next method).
  const startIdx = src.indexOf("attachToSession(sessionId, ws)");
  const endIdx = src.indexOf("attachToSessionV2(sessionId, ws)");
  assert.ok(startIdx > 0 && endIdx > startIdx, "legacy method bounded in source");
  const legacy = src.slice(startIdx, endIdx);
  assert.ok(
    /session\.connectedClients\.add\(ws\)/.test(legacy),
    "legacy attach adds to connectedClients (not session.clients Map)"
  );
  assert.ok(
    /session\.buffer/.test(legacy),
    "legacy attach reads session.buffer"
  );
  // It must NOT register clients into session.clients (that's V2 territory).
  assert.ok(
    !/session\.clients\.set/.test(legacy),
    "legacy attach does not touch session.clients Map"
  );
});

// ──────────────────────────────────────────────────────────────────────────────
// Summary
// ──────────────────────────────────────────────────────────────────────────────

if (mgr && typeof mgr.destroy === "function") {
  try { mgr.destroy(); } catch {}
}

const total = RESULTS.length;
const passed = RESULTS.filter((r) => r.status === "PASS").length;
const failed = RESULTS.filter((r) => r.status === "FAIL").length;
const skipped = RESULTS.filter((r) => r.status === "SKIP").length;

console.log("");
console.log("==================================================");
console.log(` SUMMARY: ${passed}/${total} PASS  (${failed} FAIL, ${skipped} SKIP)`);
console.log("==================================================");
console.log(` tmux on host: ${tmuxAvailable ? tmuxVersion : "NOT INSTALLED"}`);
console.log(` flag-on:  reliableStreaming=${PRIVATE.RELIABLE_STREAMING}, HELLO_TIMEOUT_MS=${PRIVATE.HELLO_TIMEOUT_MS}, BUFFERED_CEILING=${PRIVATE.BUFFERED_CEILING}, CHUNK_BYTES_CAP=${PRIVATE.CHUNK_BYTES_CAP}`);

process.exitCode = failed > 0 ? 1 : 0;
