# 03 — Research: PTY/Terminal-to-Browser Streaming Stacks

> Agent: `researcher-pty-streaming`
> Phase 3 deliverable: survey proven streaming stacks; produce a comparison the arbiter can pick from to fix divergence in claude-terminal.
> Mode: RESEARCH ONLY. No solutions chosen. Decisions left open.

All cited URLs were fetched live via curl while writing this report (WebFetch and WebSearch were both broken by an upstream `effort` parameter incompatibility — every WebFetch/WebSearch call returned `400 invalid_request_error`). Each project section ends with the raw GitHub paths actually read.

---

## 0. Executive summary (skim only)

Eight projects fully covered: **ttyd**, **gotty**, **wetty**, **sshx**, **upterm**, **VS Code Remote Server / code-server**, **mosh** (SSP), and **xterm.js' own addons** (`addon-attach`, `addon-serialize`, `addon-fit`).

Three patterns dominate the landscape:

1. **`tmux capture-pane` / "rendered snapshot" replay** — the parent container (tmux) takes a snapshot of the *visible state* at attach time and ships it as a single ANSI dump; live PTY bytes are then streamed unaltered. Used by current claude-terminal (broken), and partly by upterm. Cheap, but corrupts on any boundary cut and has no per-client cursor.
2. **Server-buffered byte log + per-client offset/seq + snapshot+delta** — the server retains a rolling byte log of N MiB per shell, every chunk is associated with a sequence number, and on reconnect the client says "I'm at byte X, give me from there." Used by **sshx** (with snapshot+delta persistence), **VS Code remote terminal** (replay event with cols/rows segmentation), and the inspiration is mosh's SSP.
3. **PAUSE/RESUME flow control with watermark counters** — server pauses the upstream `pty.read()` when `bufferedAmount` (or an account counter) crosses high-water; resumes when an `ack`/`commit` from the client lowers it past low-water. Used by **ttyd** (binary `2`/`3` opcodes), **wetty** (socket.io `commit` events), and underpins both projects' graceful behavior on slow links.

Biggest single insight: **NONE** of the proven stacks let the *server's* in-RAM byte buffer be the canonical source of replay across a server restart. They either (a) restore from a *separate* snapshot store (sshx zstd+protobuf), (b) re-derive from a still-alive process container (tmux capture-pane), or (c) treat replay-on-reconnect as best-effort with explicit "out-of-sync" recovery (mosh's "this snapshot is the new base, throw away your old state"). claude-terminal currently does (a) without the snapshot store, then (b) with no per-client cursor — which is exactly the worst hybrid.

Biggest risk if we wholesale-copy any single project: **sshx requires a structurally different server runtime** (gRPC channel from a long-lived host process to a stateless web server, with snapshot-to-Redis); **ttyd requires a binary opcode protocol bump**; **mosh requires UDP**; **VS Code requires the PTY-host process model**. There is no project we can cargo-cult without a full server rewrite.

---

## 1. Per-project deep dives

### 1.1 ttyd — C, libwebsockets, binary opcode protocol

**Files read:**
- `https://raw.githubusercontent.com/tsl0922/ttyd/main/src/protocol.c`
- `https://raw.githubusercontent.com/tsl0922/ttyd/main/src/server.h`
- `https://raw.githubusercontent.com/tsl0922/ttyd/main/html/src/components/terminal/xterm/index.ts`
- `https://raw.githubusercontent.com/tsl0922/ttyd/main/html/src/components/terminal/index.tsx`

**Protocol shape.** Pure binary WebSocket frames. Every frame starts with a single ASCII byte that identifies the message kind, followed by payload. Frame layout `[CMD][...]`. Five command bytes are defined (`server.h`):

```c
// client -> server
#define INPUT '0'             // 0x30
#define RESIZE_TERMINAL '1'   // 0x31
#define PAUSE '2'             // 0x32
#define RESUME '3'            // 0x33
#define JSON_DATA '{'         // 0x7b — first frame only, contains AuthToken+initial size

// server -> client
#define OUTPUT '0'            // 0x30 — verbatim PTY bytes after the prefix byte
#define SET_WINDOW_TITLE '1'  // 0x31
#define SET_PREFERENCES '2'   // 0x32
```

Every WebSocket frame is sent with `LWS_WRITE_BINARY` (`protocol.c:171`). The first message from the client is the only text-oriented one (`JSON_DATA` = `{`-prefixed JSON for auth + initial window size); from then on the entire channel is binary opcodes. The browser sets `socket.binaryType = 'arraybuffer'` (`xterm/index.ts:223`) and reads `event.data` as `ArrayBuffer`, slices the first byte to switch on command, and feeds the remainder to xterm via `terminal.write(typeof data === 'string' ? data : new Uint8Array(data))`.

**UTF-8 / ANSI cuts on frame boundaries.** ttyd emits raw PTY bytes verbatim — it does **not** decode UTF-8 server-side. Each `pty.read()` produces a `pty_buf_t` and gets shipped as one OUTPUT frame (`protocol.c:wsi_output`, lines 162-179). xterm.js's `Uint8Array` write path uses xterm's internal UTF-8 stream parser, which buffers partial UTF-8 codepoints and partial CSI sequences across calls. Cuts at frame boundaries are therefore harmless because the parser is stateful and accepts byte-level fragments. **No special boundary-aware logic anywhere.**

**Backpressure / flow control.** Application-level PAUSE/RESUME, driven from the *client* with a high/low-water-mark book-keeping pair on top of xterm's `term.write(data, callback)`:

```ts
// xterm/index.ts:189-209  (FlowControl: { limit, highWater, lowWater })
public writeData(data) {
  this.written += data.length;
  if (this.written > limit) {
    terminal.write(data, () => {
      this.pending = Math.max(this.pending - 1, 0);
      if (this.pending < lowWater) socket.send(textEncoder.encode(Command.RESUME));
    });
    this.pending++;
    this.written = 0;
    if (this.pending > highWater) socket.send(textEncoder.encode(Command.PAUSE));
  } else {
    terminal.write(data);
  }
}
```

Server side honours those: `case PAUSE: pty_pause(pss->process)` and `case RESUME: pty_resume(pss->process)` (`protocol.c:316-325`). Pausing the libuv read on the master fd lets the kernel TCP window fill the OS pipe buffer, which then back-propagates to whatever process is writing — **real end-to-end backpressure**, not just a producer-side throttle.

ttyd also uses libwebsockets' built-in writeable callback model: each PTY read creates a `pty_buf_t` and sets `pss->pty_buf`, then calls `lws_callback_on_writable(pss->wsi)`. The actual `lws_write` only runs from `LWS_CALLBACK_SERVER_WRITEABLE`, which fires only when the socket is drainable (`protocol.c:243-263`). Between the read callback and the writeable callback the libuv loop pauses the PTY (`pty_pause`) and resumes (`pty_resume`) only after the buffer is flushed.

**Replay/scrollback.** **None.** ttyd has no concept of session replay. When a client connects, the server spawns a fresh process for that client (or re-attaches if `--max-clients` is in use). For multi-client sharing, ttyd documents using `tmux` externally — i.e. ttyd intentionally pushes the replay problem down to tmux. The browser does `terminal.reset()` on every `socket.onopen` after the first (`xterm/index.ts:onSocketOpen`).

**Reconnect / resume.** No seq numbers, no resume offset. Reconnect is "open a new socket, send `JSON_DATA` again with auth+size, server re-spawns the process" — i.e. **session is destroyed**. The browser shows a "Reconnecting…" or "Press ⏎ to Reconnect" overlay (via `OverlayAddon`). Ping interval `--ping-interval=5s` for half-open detection (real WebSocket ping/pong).

**Multi-client.** `--max-clients`, `--once`, `--exit-no-conn` flags. No native fan-out; multi-client = multi-process. Sharing one shell across clients = use tmux (documented in README "Sharing with Multiple Clients").

**License.** MIT.

**One-line applicability to claude-terminal.** *Strong fit for the binary-frames+opcode pattern and especially for the PAUSE/RESUME flow-control scheme*; weak fit because ttyd cedes replay to tmux entirely and we already have tmux.

---

### 1.2 gotty — Go, gorilla/websocket, base64-text protocol

**Files read:**
- `https://raw.githubusercontent.com/yudai/gotty/master/server/handlers.go`
- `https://raw.githubusercontent.com/yudai/gotty/master/webtty/webtty.go`
- `https://raw.githubusercontent.com/yudai/gotty/master/webtty/message_types.go`

**Protocol shape.** Text WebSocket frames with an opcode in the first ASCII byte (same pattern as ttyd, but text-typed and **base64-encoded payload** for PTY bytes):

```go
// webtty/message_types.go
// client -> server
const ( UnknownInput='0'; Input='1'; Ping='2'; ResizeTerminal='3' )
// server -> client
const ( UnknownOutput='0'; Output='1'; Pong='2'; SetWindowTitle='3'; SetPreferences='4'; SetReconnect='5' )
```

The PTY-output path encodes binary bytes to base64 *server-side* before shipping (`webtty.go:handleSlaveReadEvent`):

```go
func (wt *WebTTY) handleSlaveReadEvent(data []byte) error {
  safeMessage := base64.StdEncoding.EncodeToString(data)
  return wt.masterWrite(append([]byte{Output}, []byte(safeMessage)...))
}
```

Resize is JSON `{"columns":N,"rows":M}` after the opcode byte. Browser receives a TEXT frame, splits off the first char, base64-decodes the rest, and writes to xterm/hterm.

**UTF-8 / ANSI cuts.** Base64-encoding side-steps all UTF-8 boundary risk on the wire (base64 is 7-bit ASCII) — the server reads raw bytes from the PTY and base64s them; the browser base64-decodes back to bytes and feeds them into the terminal emulator's stream parser, which itself is byte-stateful. Like ttyd, no special handling for ANSI escapes is needed because the parser is stream-stateful. Cost: ~33% bandwidth overhead from base64.

**Backpressure.** **Effectively none on the data path.** `webtty.go` runs two goroutines (slave→master, master→slave) with a fixed `bufferSize: 1024` byte read buffer (`webtty.go:39`). Writes are guarded only by a `sync.Mutex` on `masterWrite` to serialize fragments — no `bufferedAmount` check, no socket buffer awareness. Slow clients block the writer goroutine, which blocks PTY reads via the OS write call back-pressure.

There **is** a Ping/Pong roundtrip (`'2'` opcode both directions) for liveness, but it's not used for flow control.

**Replay/scrollback.** **None at the gotty layer.** When a new client connects, gotty spawns a fresh process per client unless `--reconnect` is set. With `--reconnect=true` the server sends a `SetReconnect` opcode (`'5'`) so the *client* knows it should auto-reconnect — but gotty itself does not retain bytes for replay across the disconnect. Sharing = tmux.

**Reconnect / resume.** Client-side auto-reconnect with a fixed `--reconnect-time=10s` interval. No sequence numbers, no resume offset. The browser does a `terminal.reset()` on reconnect.

**Multi-client.** None natively (per-connection process). Same recommendation as ttyd: use tmux.

**License.** MIT.

**One-line applicability.** Demonstrates that **base64-over-text** is a perfectly viable way to ship raw PTY bytes if we don't want to switch to binary frames — at a 4/3 bandwidth cost and zero UTF-8 worry. Otherwise structurally similar to ttyd; same opcode-byte-prefix idiom but text-typed.

---

### 1.3 wetty — Node, socket.io, JSON events with explicit ack flow control

**Files read:**
- `https://raw.githubusercontent.com/butlerx/wetty/main/src/server/spawn.ts`
- `https://raw.githubusercontent.com/butlerx/wetty/main/src/server/flowcontrol.ts`
- `https://raw.githubusercontent.com/butlerx/wetty/main/src/server/socketServer/socket.ts`
- `https://raw.githubusercontent.com/butlerx/wetty/main/src/client/wetty.ts`
- `https://raw.githubusercontent.com/butlerx/wetty/main/src/client/wetty/flowcontrol.ts`
- `https://raw.githubusercontent.com/butlerx/wetty/main/src/client/wetty/term.ts`

**Protocol shape.** socket.io named events. socket.io itself frames each `emit` as a JSON envelope (default text, with binary attachments only when an event payload contains a Buffer). Defined event names:

| Direction | Event | Payload | Source |
|-----------|-------|---------|--------|
| s→c | `data` | string (raw PTY chunk, accumulated by `tinybuffer`) | `spawn.ts:40` (`socket.emit('data', s.join(''))`) |
| s→c | `login` / `logout` / `disconnect` / `error` | none / string | `spawn.ts:23-27`, `wetty.ts` |
| c→s | `input` | string (keystroke) | `wetty.ts:43` |
| c→s | `resize` | `{cols, rows}` | `wetty.ts:46` |
| c→s | `commit` | number (acked byte count) | `wetty.ts:53,60` (the *flow-control ack*) |

socket.io transparently handles ping/pong (`pingInterval: 3000, pingTimeout: 7000` — `socketServer/socket.ts:38-39`). Long-poll fallback if WS unavailable (default socket.io behaviour).

**UTF-8 / ANSI cuts.** node-pty in default mode hands strings to socket.io; socket.io serializes them as JSON strings; xterm parses strings (state-stateful). Same picture as ttyd/gotty — boundary safety is delegated to the xterm parser.

**Server-side coalescing — `tinybuffer`.** Wetty actually *batches* PTY chunks before emitting:

```ts
// server/flowcontrol.ts:6-29
export function tinybuffer(socket, timeout, maxSize) {
  const s: string[] = [];
  let length = 0;
  let sender: NodeJS.Timeout | null = null;
  return (data) => {
    s.push(data);
    length += data.length;
    if (length > maxSize) {            // immediate flush at maxSize (e.g. 524288)
      socket.emit('data', s.join(''));
      ...
    } else if (!sender) {              // schedule a flush in `timeout` (microseconds in name; ms in practice — 2 in spawn.ts:34)
      sender = setTimeout(() => { socket.emit('data', s.join('')); ... }, timeout);
    }
  };
}
```

Used as `const send = tinybuffer(socket, 2, 524288)` (`spawn.ts:34`). So PTY chunks accumulate into one socket.io emit per ~2 ms or per 512 KiB, whichever comes first. **This is per-frame batching, not server-side replay**: it just reduces emit count for high-throughput periods.

Note carefully: tinybuffer concatenates JS strings; if a chunk ends mid-CSI, the next chunk's prefix completes it inside the same flushed string — **not** split across socket.io frames. But if a *single* PTY write is bigger than 512 KiB (rare), the immediate flush at line 17 happens with whatever is currently in `s`, which **will** cut at an arbitrary string boundary. That tail boundary risk is the same xterm-parser-saves-us situation as ttyd/gotty.

**Backpressure — explicit `commit`/`account` watermark with client→server ack.** Two-sided design:

```ts
// server/flowcontrol.ts:55-80  (FlowControlServer — high=2_097_152, low=524_288)
public account(length: number): boolean {  // returns true if PTY should be paused
  const old = this.counter;
  this.counter += length;
  return old < this.high && this.counter > this.high;  // crossing the high-water mark
}
public commit(length: number): boolean {   // returns true if PTY should be resumed
  const old = this.counter;
  this.counter -= length;
  return old > this.low && this.counter < this.low;
}
```

```ts
// client/wetty/flowcontrol.ts  (FlowControlClient — ackBytes=262144 default)
public needsCommit(length: number): boolean {
  this.counter += length;
  if (this.counter >= this.ackBytes) {
    this.counter -= this.ackBytes;
    return true;     // emit a 'commit' to the server with `ackBytes`
  }
  return false;
}
```

Client uses xterm's `term.write(data, callback)` to send the `commit` *only after xterm has parsed* the chunk:

```ts
// client/wetty.ts:51-66
.on('data', (data) => {
  ...
  if (downloadLength && fcClient.needsCommit(downloadLength)) {
    socket.emit('commit', fcClient.ackBytes);
  }
  if (remainingData) {
    if (fcClient.needsCommit(remainingData.length)) {
      term.write(remainingData, () =>            // <-- callback: xterm has flushed
        socket.emit('commit', fcClient.ackBytes),
      );
    } else { term.write(remainingData); }
  }
})
```

Server side:

```ts
// server/spawn.ts:35-49
const fcServer = new FlowControlServer();
term.onData((data: string) => {
  send(data);
  if (fcServer.account(data.length)) term.pause();
});
socket.on('commit', size => {
  if (fcServer.commit(size)) term.resume();
});
```

This is **the most rigorous backpressure I found** in any of the surveyed projects: it gates on the consumer's xterm-parser drain, not on the WebSocket's `bufferedAmount`. Because xterm.js' write buffer is the actual bottleneck on slow rendering (DOM renderer especially), pausing the producer when xterm hasn't finished parsing prevents memory blow-up better than just trusting `bufferedAmount`.

**Replay/scrollback.** **None at the wetty layer.** When the client reconnects, socket.io creates a new session and the server `spawn.ts` triggers a brand new SSH/login process. There is no buffer kept on either side. For "shared sessions" you again use tmux underneath. The README points to `wetty --command "tmux a"` as the canonical pattern.

**Reconnect.** socket.io's built-in reconnect (default exponential backoff with jitter, capped, retries indefinitely). On disconnect the server `term.kill()`s the PTY (`spawn.ts:42-44`) — i.e. session is destroyed. No resume.

**Multi-client.** None natively; rely on tmux.

**License.** MIT.

**One-line applicability.** *The flow-control + ack pattern is the cleanest example we'll find of "wait for the consumer parser to drain before letting the producer continue."* The replay model is "don't have one" — only useful as a counterexample (i.e. wetty intentionally has no replay because it expects tmux to provide persistence).

---

### 1.4 sshx — Rust, axum WebSocket + tonic gRPC, CBOR-encoded binary, snapshot+delta on resume

**Files read:**
- `https://raw.githubusercontent.com/ekzhang/sshx/main/crates/sshx-server/src/web/protocol.rs`
- `https://raw.githubusercontent.com/ekzhang/sshx/main/crates/sshx-server/src/web/socket.rs`
- `https://raw.githubusercontent.com/ekzhang/sshx/main/crates/sshx-server/src/session.rs`
- `https://raw.githubusercontent.com/ekzhang/sshx/main/crates/sshx-server/src/session/snapshot.rs`
- `https://raw.githubusercontent.com/ekzhang/sshx/main/crates/sshx-core/proto/sshx.proto`
- `https://raw.githubusercontent.com/ekzhang/sshx/main/crates/sshx-core/src/lib.rs`
- `https://raw.githubusercontent.com/ekzhang/sshx/main/src/lib/protocol.ts` (TS mirror of `WsServer`/`WsClient`)

**Protocol shape — two layers.**

1. **Backend↔server: gRPC streaming over HTTP/2 (tonic).** The host's `sshx` binary opens a long-lived bidirectional `Channel(stream ClientUpdate) -> stream ServerUpdate` RPC to the central server (`proto/sshx.proto`):

   ```protobuf
   service SshxService {
     rpc Open(OpenRequest) returns (OpenResponse);
     rpc Channel(stream ClientUpdate) returns (stream ServerUpdate);
     rpc Close(CloseRequest) returns (CloseResponse);
   }
   message TerminalData { uint32 id=1; bytes data=2; uint64 seq=3; }
   message TerminalInput { uint32 id=1; bytes data=2; uint64 offset=3; }
   message SequenceNumbers { map<uint32,uint64> map=1; }
   ```
   Client→server stream is `TerminalData{id,bytes,seq}` plus `created_shell` / `closed_shell` acks. Server→client stream is `TerminalInput{id,bytes,offset}` + `SequenceNumbers sync` + `TerminalSize resize` + `ping/pong` + `error`. **Both directions carry sequence numbers from the start.**

2. **Browser↔server: binary WebSocket frames carrying CBOR-encoded `WsServer`/`WsClient` enums.**

   ```rust
   // web/socket.rs:62-77
   async fn send(socket: &mut WebSocket, msg: WsServer) -> Result<()> {
     let mut buf = Vec::new();
     ciborium::ser::into_writer(&msg, &mut buf)?;
     socket.send(Message::Binary(Bytes::from(buf))).await?;
     Ok(())
   }
   async fn recv(socket: &mut WebSocket) -> Result<Option<WsClient>> {
     match socket.recv().await.transpose()? {
       Some(Message::Text(_)) => warn!("ignoring text message over WebSocket"),
       Some(Message::Binary(msg)) => break Some(ciborium::de::from_reader(&*msg)?),
       ...
     }
   }
   ```
   Text frames are *explicitly rejected* (`ignoring text message`). The CBOR wire schema is the Rust enum tagged via serde:

   ```rust
   // web/protocol.rs
   pub enum WsServer {
     Hello(Uid, String),
     InvalidAuth(),
     Users(Vec<(Uid, WsUser)>),
     UserDiff(Uid, Option<WsUser>),
     Shells(Vec<(Sid, WsWinsize)>),
     Chunks(Sid, u64, Vec<Bytes>),    // <-- replay slice: shellId, seqnum, chunks
     Hear(Uid, String, String),       // chat
     ShellLatency(u64),
     Pong(u64),
     Error(String),
   }
   pub enum WsClient {
     Authenticate(Bytes, Option<Bytes>),
     SetName(String), SetCursor(Option<(i32,i32)>), SetFocus(Option<Sid>),
     Create(i32, i32), Close(Sid), Move(Sid, Option<WsWinsize>),
     Data(Sid, Bytes, u64),           // user input with explicit offset
     Subscribe(Sid, u64),             // <-- "subscribe shell SID, starting at chunk N"
     Chat(String), Ping(u64),
   }
   ```

**UTF-8 / ANSI cuts.** sshx never decodes the byte stream as text. `Bytes` (the bytes crate's `Bytes`) flows from the host's PTY → encrypted with AES → gRPC `TerminalData` → server in-memory `Vec<Bytes>` → CBOR-framed → WebSocket → browser → decrypted → fed into xterm. xterm.js parser handles fragments. No string conversion anywhere on the data path. Encryption at the host means the server can't even introspect bytes for boundary alignment.

**Backpressure / flow control.** Three layers:

1. **Per-shell rolling byte log capped at 2 MiB** (`session.rs:25` `SHELL_STORED_BYTES: u64 = 1 << 21`). When the cap is exceeded, oldest `Bytes` chunks are *evicted* from the front (not sliced — the chunks are the unit of pruning), and `chunk_offset` / `byte_offset` counters increment to reflect what's been pruned (`session.rs:add_data`, lines 244-269):

   ```rust
   if seq <= shell.seqnum && seq + data.len() as u64 > shell.seqnum {
     let start = shell.seqnum - seq;
     let segment = data.slice(start as usize..);
     shell.seqnum += segment.len() as u64;
     shell.data.push(segment);
     // Prune old chunks if we've exceeded the maximum stored bytes.
     let mut stored_bytes = shell.seqnum - shell.byte_offset;
     if stored_bytes > SHELL_STORED_BYTES {
       let mut offset = 0;
       while offset < shell.data.len() && stored_bytes > SHELL_STORED_BYTES {
         let bytes = shell.data[offset].len() as u64;
         stored_bytes -= bytes;
         shell.chunk_offset += 1;
         shell.byte_offset += bytes;
         offset += 1;
       }
       shell.data.drain(..offset);
     }
     shell.notify.notify_waiters();
   }
   ```
   Crucially, eviction is at **chunk granularity, not byte granularity** — a `Bytes` chunk is the atomic unit, and chunks are sized however the host's encrypter packaged them. So no per-byte slice can land mid-escape.

2. **`tokio::sync::broadcast::channel(64)` for cross-stream events** (`session.rs:101`). When a slow consumer falls behind, the broadcast channel emits `BroadcastStreamRecvError::Lagged(n)` — the WebSocket handler treats that as a connection-killing error (`socket.rs:154`):

   ```rust
   Some(result) = broadcast_stream.next() => {
     let msg = result.context("client fell behind on broadcast stream")?;
     ...
   }
   ```
   So **slow clients are dropped**, not waited for. Producer is never throttled.

3. **gRPC backpressure** between host and server is handled by tonic's stream flow control (HTTP/2 windowing).

**Replay / scrollback model — server-buffered byte log + per-client subscribe(offset).** The killer feature. On any WebSocket connect:

```rust
// socket.rs handle_socket: loop body, line 178
WsClient::Subscribe(id, chunknum) => {
  if subscribed.contains(&id) { continue; }
  subscribed.insert(id);
  let session = Arc::clone(&session);
  let chunks_tx = chunks_tx.clone();
  tokio::spawn(async move {
    let stream = session.subscribe_chunks(id, chunknum);   // <-- starts at chunk N
    tokio::pin!(stream);
    while let Some((seqnum, chunks)) = stream.next().await {
      if chunks_tx.send((id, seqnum, chunks)).await.is_err() { break; }
    }
  });
}
```

Server sends back `WsServer::Chunks(sid, seqnum, Vec<Bytes>)` — a *batch* of chunks with the *byte sequence number of the first chunk*. The client tracks `chunknum` per shell; on reconnect it knows exactly which chunk to ask for next, and the server either:
- starts streaming from that chunk if it's still in the rolling buffer, **or**
- starts from the oldest chunk it has + an implicit "you're behind by `chunk_offset - your_chunknum` chunks, here's the oldest".

**This is the canonical "snapshot + delta" pattern, but the snapshot is just a slice of the rolling byte log starting at the requested offset.** No separate "screen state" snapshot — the byte log itself, replayed into the xterm parser, reconstructs the screen. The 2 MiB cap is the worst-case "how far back can a reconnecting client be."

**Cross-server snapshot+restore for persistence.** `session/snapshot.rs` adds a *secondary* persistence path: every session can be serialized to a zstd-compressed protobuf (`SerializedSession{shells: map<sid, SerializedShell>}` — see `proto/sshx.proto:97-117`). Per-shell snapshot pruning keeps **only the last 32 KiB** (`SHELL_SNAPSHOT_BYTES: u64 = 1 << 15`) — a tiny amount, intended only to "draw the screen the user just saw" on a server failover. This snapshot lives in Redis (per `lib.rs` and the deployment docs). When a server picks up a session from another server, `Session::restore(data: &[u8])` rebuilds the `State` (`snapshot.rs:79-115`), preserving `seqnum`, `data`, `chunk_offset`, `byte_offset`. **Sequence numbers survive cross-server moves**, which means clients can still `Subscribe(sid, last_chunknum)` and get a consistent answer.

**Reconnect semantics.** Client logic (in `Session.svelte`, not quoted in full but consistent with the protocol): track `last_chunknum[sid]` per shell, on reconnect re-`Authenticate` then `Subscribe(sid, last_chunknum[sid])` for each open shell. Server replays missing chunks first, then live. The `WsServer::Chunks(sid, seqnum, chunks)` carries the seqnum so the client can sanity-check it picked up where it expected. Plus periodic `Ping(timestamp)`/`Pong(timestamp)` for latency measurement and keepalive, separate from the (also-present) underlying WebSocket protocol-level ping.

**Multi-client.** First-class. Each session has multiple `WsUser`s with `name`, `cursor`, `focus`, `can_write`. A user's cursor and focus changes broadcast via `WsServer::UserDiff` and `WsServer::Users`. The shared canvas model means N clients see N cursors moving in real time. Critically, **per-client subscribe offset means no two clients need to be at the same byte position** — late joiners catch up at their own pace while the live stream flows on.

**License.** MIT (Eric Zhang, sshx.io). Server is open-source but explicitly "Self-hosted deployments are not supported at the moment" per README.

**One-line applicability.** *The most modern and architecturally sound model in this survey* — but lifting it wholesale requires (a) introducing a snapshot-store backend, (b) protocol versioning to add seq+ack+subscribe-offset, (c) abandoning the "JSON over text frame" wire in favour of binary CBOR/MessagePack/protobuf, and (d) a different process model (host process feeding bytes to a stateless server). For claude-terminal we can adopt the *idea* (per-client offset, chunk-granularity buffer, broadcast channel with lagged-client eviction) without copying the implementation.

---

### 1.5 upterm — Go, SSH protocol over TCP/WebSocket, tmux underneath

**Files read:**
- `https://raw.githubusercontent.com/owenthereal/upterm/master/README.md`
- `https://raw.githubusercontent.com/owenthereal/upterm/master/host/host.go`
- (plus Go module structure listings)

**Protocol shape.** Native SSH protocol. The "host" runs `upterm host` which establishes an outbound SSH connection to a relay server (`uptermd.upterm.dev` or self-hosted); clients connect via `ssh <token>@uptermd.upterm.dev`. WebSocket support is via the `--server wss://...` flag, which tunnels SSH-over-WebSocket as the transport.

**UTF-8 / ANSI cuts.** N/A at this layer — SSH is a stream protocol; the bytes flow through ssh.Channel reads/writes, with the SSH library handling MAC/encryption and packet boundaries. xterm-side cuts are handled by whatever client is on the other side (usually OpenSSH's `ssh`).

**Backpressure.** SSH channels have built-in flow-control windows (per RFC 4254 §5.2). Each side advertises a window size, and the peer must not exceed it. This is **window-based flow control at the protocol layer**, similar to TCP, but at the SSH-channel granularity. Comparable to HTTP/2's flow control.

**Replay/scrollback.** Delegated to **tmux** — the documented pattern is `upterm host --force-command 'tmux attach -t pair-programming' -- tmux new -t pair-programming`. The README's "Force command" section makes this explicit. Without tmux, upterm has no replay; with tmux, you get tmux's full scrollback (history-limit) plus its native multi-client attach semantics.

**Reconnect / resume.** SSH-level reconnect (i.e. the user manually re-runs `ssh ...`); ssh.Channel does not survive disconnect. tmux session survives independently. Client reconnect = new ssh = new tmux attach = full pane redraw. No seq numbers, no per-client cursors at upterm layer (tmux gives those).

**Multi-client.** Multiple `ssh` clients can connect to the same session. Upterm's session shows `{{.ClientCount}}` (per README template variables). All clients share the same single tmux pane.

**License.** Apache 2.0.

**One-line applicability.** *Same architectural idea as our claude-terminal* (raw tmux attach, no replay buffer, rely on tmux for persistence) — but using SSH protocol instead of a custom WS protocol. Confirms our model is at least *not unprecedented*; informs us that "the right answer is to make tmux the source of truth" is a defensible position.

---

### 1.6 VS Code Remote Server / code-server — IPC channel + replay-event protocol + per-buffer throttle

**Files read:**
- `https://raw.githubusercontent.com/microsoft/vscode/main/src/vs/workbench/contrib/terminal/common/basePty.ts`
- `https://raw.githubusercontent.com/microsoft/vscode/main/src/vs/platform/terminal/common/terminalRecorder.ts`
- `https://raw.githubusercontent.com/microsoft/vscode/main/src/vs/platform/terminal/common/terminalDataBuffering.ts`
- `https://raw.githubusercontent.com/microsoft/vscode/main/src/vs/platform/terminal/common/terminalProcess.ts`
- `https://raw.githubusercontent.com/microsoft/vscode/main/src/vs/workbench/contrib/terminal/common/remote/remoteTerminalChannel.ts`

**Protocol shape.** VS Code uses its own IPC channel framework (`base/parts/ipc/common/ipc.ts`, the `IChannel` interface) that runs over either Electron IPC (local), Node IPC (extension host), or **WebSocket between VS Code workbench and a remote code-server**. The IPC framing is a binary length-prefixed messagepack-like format with explicit request/notification/event types. Each named "channel" multiplexes onto the underlying socket.

For terminals specifically, the channel name is `"remoteterminal"` (`REMOTE_TERMINAL_CHANNEL_NAME`), and the message vocabulary is enumerated as `RemoteTerminalChannelEvent` and `RemoteTerminalChannelRequest` — concrete events include:

- `OnProcessDataEvent` — `{id, event: IProcessDataEvent | string}` — live PTY bytes
- `OnProcessReplayEvent` — `{id, event: IPtyHostProcessReplayEvent}` — *the replay payload sent on attach*
- `OnProcessExitEvent`, `OnProcessReadyEvent`, `OnDidChangeProperty`
- `CreateProcess`, `AttachToProcess`, `Input`, `Resize`, `Acknowledge`, `Shutdown` requests

**Replay event shape — the most interesting part.** Per `terminalRecorder.ts` and `terminalProcess.ts:ReplayEntry`:

```ts
export interface ReplayEntry {
  cols: number;
  rows: number;
  data: string;
}
export interface IPtyHostProcessReplayEvent {
  events: ReplayEntry[];
  commands: ISerializedCommandDetectionCapability;
}
```

The **replay is not one big string**; it's a sequence of `(cols, rows, data)` entries, segmented at every resize. This means xterm on the receiving side can apply each segment with the *correct geometry of the time the bytes were emitted*. The recorder maintains the segments live:

```ts
// terminalRecorder.ts:39-60
handleResize(cols, rows): void {
  if (lastEntry.data.length === 0) this._entries.pop();          // drop empty segment
  if (lastEntry.cols === cols && lastEntry.rows === rows) return; // no-op
  if (lastEntry.cols === 0 && lastEntry.rows === 0) {
    lastEntry.cols = cols; lastEntry.rows = rows; return;        // first valid size
  }
  this._entries.push({ cols, rows, data: [] });                  // start new segment
}
handleData(data): void {
  const lastEntry = this._entries[this._entries.length - 1];
  lastEntry.data.push(data);
  this._totalDataLength += data.length;
  while (this._totalDataLength > Constants.MaxRecorderDataSize) {  // 10 MiB cap
    const firstEntry = this._entries[0];
    const remainingToDelete = this._totalDataLength - Constants.MaxRecorderDataSize;
    if (remainingToDelete >= firstEntry.data[0].length) {
      this._totalDataLength -= firstEntry.data[0].length;
      firstEntry.data.shift();
      if (firstEntry.data.length === 0) this._entries.shift();
    } else {
      firstEntry.data[0] = firstEntry.data[0].substr(remainingToDelete);
      this._totalDataLength -= remainingToDelete;
    }
  }
}
```

**Cap = 10 MiB total**, eviction at *string granularity* from the head, but importantly **the segment boundaries (resize events) are preserved** — it's a list of strings keyed by geometry, not a single concatenated string. Trim at arbitrary char index can still happen, but only inside one segment, and the parser-state-stateful xterm handles it.

The replay client side (`basePty.ts:handleReplay`) iterates events, fires `OverrideDimensions` for each, then awaits each chunk's `writePromise` (xterm's `term.write(data, callback)`-style backpressure):

```ts
async handleReplay(e: IPtyHostProcessReplayEvent) {
  try {
    this._inReplay = true;
    for (const innerEvent of e.events) {
      if (innerEvent.cols !== 0 || innerEvent.rows !== 0) {
        this._onDidChangeProperty.fire({ type: ProcessPropertyType.OverrideDimensions,
                                          value: { cols, rows, forceExactSize: true } });
      }
      const e: IProcessDataEvent = { data: innerEvent.data, trackCommit: true };
      this._onProcessData.fire(e);
      await e.writePromise;     // <-- this is the per-chunk barrier
    }
  } finally {
    this._inReplay = false;
  }
  ...
  this._onDidChangeProperty.fire({ type: ProcessPropertyType.OverrideDimensions, value: undefined });
  this._onProcessReplayComplete.fire();
}
```

This is a real **flush barrier between replay chunks**: the `await e.writePromise` doesn't proceed until xterm has parsed the previous chunk. That guarantees the size-override for chunk N+1 is applied only after chunk N has been fully rendered. After replay, an `OverrideDimensions: undefined` re-allows live resizes, and `onProcessReplayComplete` fires — explicit "replay is done" event.

**Live data buffering — `TerminalDataBufferer`.** A separate per-id batcher with a `setTimeout(throttleBy=5ms)` flush:

```ts
// terminalDataBuffering.ts:23-46
startBuffering(id, event, throttleBy=5): IDisposable {
  const disposable = event(e => {
    const data = isString(e) ? e : e.data;
    let buffer = this._terminalBufferMap.get(id);
    if (buffer) { buffer.data.push(data); return; }
    const timeoutId = setTimeout(() => this.flushBuffer(id), throttleBy);
    buffer = { data: [data], timeoutId, dispose: ... };
    this._terminalBufferMap.set(id, buffer);
  });
  return disposable;
}
flushBuffer(id): void {
  const buffer = this._terminalBufferMap.get(id);
  if (buffer) {
    this._terminalBufferMap.delete(id);
    this._callback(id, buffer.data.join(''));   // <-- one event per 5ms
  }
}
```

So at most one IPC event per 5 ms per terminal. Reduces IPC overhead by orders of magnitude during high-throughput output.

**UTF-8 / ANSI cuts.** Strings throughout (node-pty default). Trim at `MaxRecorderDataSize` boundary uses `substr` on a JS string — same UTF-16-code-unit issue as our current implementation, but the per-segment isolation means a corrupted prefix in segment 0 just makes segment 0's first bytes parse weirdly; the resize barrier then applies clean geometry for segment 1. In practice, a 10 MiB cap rarely hits trim.

**Backpressure.** The `await e.writePromise` chain in `handleReplay` is the explicit barrier. Live-stream writes are not backpressured at the IPC layer (the buffer is flushed every 5 ms regardless), but the IChannel framing on top of WebSocket has built-in pause semantics (the `IPC` framework will buffer messages if the underlying socket is slow). No `bufferedAmount` checks visible at the terminal-channel level.

**Reconnect.** The `OnProcessReplayEvent` is the entire "resume" mechanism — on reconnect to a `shouldPersist: true` PTY, the server fires the recorded replay event, the client applies all `(cols,rows,data)` segments via `await writePromise`, then live data flows. No seq numbers, no offset — the client is expected to do `term.reset()` first (managed by VS Code's terminal layer, not visible in this code) and accept the full replay.

**Multi-client.** VS Code's terminal model is "one workbench, one terminal instance" — there is no concept of two clients on one PTY natively. The "remote" model is single-tenant per workbench; if you open a second VS Code window connected to the same remote, each gets its own PTY (or reattaches to a persistent one with full replay). No per-client cursor.

**License.** MIT (vscode). code-server (Coder) reuses these channels.

**One-line applicability.** *The segmented-by-resize replay model is directly transferable to claude-terminal* — even keeping our 2 MB cap, splitting the buffer into `[(cols,rows,string), …]` segments would prevent geometry-mismatch garbage on reconnect after a resize. The `await writePromise` flush-barrier between segments is a small client-side change that gives a real correctness guarantee. The 5 ms throttle is also a quick win for our resize-storm problem.

---

### 1.7 mosh (mobile shell) — UDP, SSP (State Synchronization Protocol), full snapshot+delta

**Files read:**
- `https://raw.githubusercontent.com/mobile-shell/mosh/master/src/network/network.h`
- `https://raw.githubusercontent.com/mobile-shell/mosh/master/src/network/networktransport.h`
- `https://raw.githubusercontent.com/mobile-shell/mosh/master/src/network/networktransport-impl.h`
- `https://raw.githubusercontent.com/mobile-shell/mosh/master/src/statesync/completeterminal.h`

**Protocol shape.** Datagram-based (UDP). Each packet is encrypted (AES-OCB) and contains a `Packet{seq, direction, timestamp, timestamp_reply, payload}` (`network.h:78-90`). The `payload` is a fragment of an `Instruction` (the mosh state-synchronization unit). Instructions are reassembled from fragments by `FragmentAssembly`.

**SSP — the State Synchronization Protocol.** This is the core insight that everyone copies in spirit. The semantics:

- Each side maintains a **state object** of type `T` that fully describes "what the user should see" (`Terminal::Complete` server-side, comprising `UTF8Parser + Emulator + Display`).
- The state object implements `diff_from(other) -> string`, `init_diff() -> string`, `apply_string(diff)`, and `==` (`completeterminal.h:74-79`).
- The sender keeps a list of `TimestampedState<T>` it has emitted; the receiver keeps a list it has acknowledged.
- A packet conceptually says: *"old_num = N, new_num = M, here is the diff to go from state N to state M, ack_num = K (the highest receiver state I've seen)"* — see `Instruction` framing (referenced via `transportfragment.h`) and `networktransport-impl.h:recv()`.
- On receive, the listener finds the `reference_state` matching `old_num`, applies the diff, stores `new_state` indexed by `new_num`, and emits an ack.
- **Idempotency**: if a packet's `new_num` is already in `received_states`, drop it. If `old_num` isn't found, drop it (sender will retransmit from a base we have).

```cpp
// networktransport-impl.h:recv (excerpt)
for (auto i = received_states.begin(); i != received_states.end(); i++) {
  if (inst.new_num() == i->num) return;  // already have this state
}
bool found = false;
for (auto reference_state = received_states.begin(); reference_state != received_states.end(); ++reference_state) {
  if (inst.old_num() == reference_state->num) { found = true; break; }
}
if (!found) return;  // we don't have the base — drop, sender will retry from older
TimestampedState<RemoteState> new_state = *reference_state;
new_state.timestamp = timestamp();
new_state.num = inst.new_num();
if (!inst.diff().empty()) new_state.state.apply_string(inst.diff());
// insert in sorted position by num
received_states.push_back(new_state);
sender.set_ack_num(received_states.back().num);
```

**Sequence numbers — but at the *state* level, not the *byte* level.** Each `Packet.seq` is uniquely random (`Crypto::unique()`); each `Instruction.new_num` is monotonic state-number. The two are independent layers — packet seq is for the encryption replay-protection window, state num is for SSP idempotency.

**UTF-8 / ANSI cuts.** Mosh's server runs a *full UTF-8-aware ANSI parser* (`Parser::UTF8Parser` feeding `Terminal::Emulator`) on the bytes from the PTY, building a complete framebuffer (`Terminal::Framebuffer`). The state shipped to the client is the **rendered framebuffer**, not raw bytes. This means:
- Cuts in the byte stream are absorbed by the parser; the framebuffer state is always self-consistent.
- The diff between two framebuffers can be expressed as a small set of cell-update operations.
- The client also runs a parser+framebuffer; `apply_string(diff)` mutates the local framebuffer.

**Backpressure / flow control.** Mosh's sender uses adaptive throttling based on RTT and inflight state count. Specifically:
- `set_send_delay(int new_delay)` adjusts inter-packet spacing.
- `process_throwaway_until(throwaway_num)` lets the *receiver* tell the sender "states older than N can be discarded from your retransmit log" — this prevents the sender's state log from growing unboundedly during long disconnects.
- `receiver_quench_timer = now + 15000` if the queue gets too large (>1024 states), forcing a 15s back-off (`networktransport-impl.h:120-130`).
- No traditional "PAUSE/RESUME" — mosh just *coalesces*: when the user types fast, multiple keystrokes are merged into one state diff.

**Replay/scrollback.** Mosh does not have scrollback at the protocol level — the framebuffer is exactly the visible screen. Scrollback is delegated to the *terminal emulator* the user runs locally (e.g. `tmux` or the terminal app itself); mosh shows only the current screen.

**Reconnect.** Mosh's signature feature: a roaming client can change IP entirely (cellular handoff) and the server will continue to accept the next packet because authentication is per-packet via the OCB tag. Mosh-server doesn't even know the client's IP. The state synchronization protocol naturally resumes from wherever both sides last agreed.

**Multi-client.** Not designed for it — one user, one session, but heavily resilient to a flaky connection.

**License.** GPL v3.

**One-line applicability.** *Conceptually critical: the "diff from acknowledged state to current state" model is the only way to truly survive long disconnects without bandwidth blow-up.* Practically not adoptable — running a full ANSI parser server-side and shipping framebuffer diffs is a complete rewrite. But the **idea** of "state number + ack — never resend bytes the client has acknowledged" is what informs sshx's chunk-level subscribe-offset.

---

### 1.8 xterm.js official addons — `addon-attach`, `addon-serialize`, `addon-fit`

**Files read:**
- `https://raw.githubusercontent.com/xtermjs/xterm.js/master/addons/addon-attach/src/AttachAddon.ts`
- `https://raw.githubusercontent.com/xtermjs/xterm.js/master/addons/addon-serialize/src/SerializeAddon.ts`
- (FitAddon source not re-read; well-known)

**`addon-attach` — the canonical "WS ↔ xterm" wiring.** The whole module is ~80 lines:

```ts
constructor(socket: WebSocket, options?: IAttachOptions) {
  this._socket = socket;
  this._socket.binaryType = 'arraybuffer';      // <-- NB: enforced
  this._bidirectional = !(options && options.bidirectional === false);
}
public activate(terminal: Terminal): void {
  this._disposables.push(
    addSocketListener(this._socket, 'message', ev => {
      const data: ArrayBuffer | string = ev.data;
      terminal.write(typeof data === 'string' ? data : new Uint8Array(data));
    })
  );
  if (this._bidirectional) {
    this._disposables.push(terminal.onData(data => this._sendData(data)));
    this._disposables.push(terminal.onBinary(data => this._sendBinary(data)));
  }
  ...
}
private _sendData(data: string): void { ...; this._socket.send(data); }
private _sendBinary(data: string): void {
  const buffer = new Uint8Array(data.length);
  for (let i = 0; i < data.length; ++i) buffer[i] = data.charCodeAt(i) & 255;
  this._socket.send(buffer);
}
```

Key points the maintainers wrote in:
- **`binaryType='arraybuffer'` is set unconditionally.** "always set binary type to arraybuffer, we do not handle blobs" — comment in the file. Strong statement that Blobs are wrong for terminal data.
- **`terminal.write` accepts both `string` and `Uint8Array`** in xterm v6 — the parser handles either, with byte-level state preservation across calls.
- **No frame protocol** — `addon-attach` assumes the *raw* WS frame contents are PTY bytes. Application-level framing (opcode bytes, JSON envelopes) is the application's job.
- `addon-attach` does not implement reconnect, replay, or backpressure. It's deliberately the minimal viable wiring; any real product wraps it (or replaces it).

**`addon-serialize` — the "round-trip the screen state" pattern.** The serialize addon walks the xterm.js buffer cell-by-cell and emits a string of ANSI escape sequences that, when fed back into `term.write()`, reconstructs the same screen. Key behaviour:
- Iterates every cell in the visible buffer (or scrollback range), emitting SGR-attribute changes as they differ from the previous cell.
- Handles wrap continuation between rows by examining whether `nextLine.isWrapped` and emitting either `\r\n` (hard line break) or empty (continuation).
- Special-cases CJK (double-width) chars and BCE (background color erase).
- Returns a single ANSI-string suitable for `term.write()`.

This is the **xterm-side equivalent of mosh's framebuffer-diff** — instead of shipping a diff, you ship the rendered ANSI to recreate the screen. Use cases noted by the xterm maintainers: snapshotting for tab restoration, debugging, and (with the HTML serializer) clipboard/HTML export.

**Why this matters for replay.** If the *client* serializes its own screen on disconnect (`const snapshot = serializeAddon.serialize()`), the client has a guaranteed-clean ANSI string representing exactly what it last showed. On reconnect, if the server can confirm "your snapshot was up to byte X, here's bytes X.. now", the client doesn't need a full server-side replay — it already has its own. This is the most sophisticated possible reconnect model and avoids server-side replay entirely.

**`addon-fit`.** Computes terminal dimensions from container size and calls `terminal.resize(cols, rows)`. Has no built-in debounce — that's the application's responsibility (see notes in our scan: claude-terminal calls `fit()` inside an unthrottled `ResizeObserver`).

**License.** All MIT.

**One-line applicability.** `addon-attach` is too thin to use directly given our protocol; `addon-serialize` is the sleeper hit — it gives us a way to do *client-side* state preservation that completely sidesteps server-side replay corruption. Adding it costs one npm package (~30 KB).

---

## 2. Synthesis matrix

| Project | Framing | UTF-8 / ANSI safety | Backpressure | Replay model | Reconnect model | Multi-client | License | Lang |
|---|---|---|---|---|---|---|---|---|
| **claude-terminal (current)** | JSON in TEXT WS frame, `JSON.stringify({type:"output",data})` | No special handling, string `slice(-2_000_000)` cuts mid-CSI | **None** (no `bufferedAmount`, no PAUSE/RESUME) | Single 2 MB string per session, capture-pane reseed on lazy attach | Full replay dump, no seq/offset | Shared `session.buffer`, no per-client cursor | (proprietary) | Node + React |
| **ttyd** | Binary WS frame, opcode byte + payload | Raw bytes; xterm parser handles | App-level PAUSE/RESUME with high/low watermarks driven by `term.write` callback | None (delegate to tmux) | New process per connection | None native (use tmux) | MIT | C / libwebsockets |
| **gotty** | Text WS frame, opcode byte + base64 payload | Base64 sidesteps UTF-8 entirely | None (just goroutine block) | None | New process per connection (or `--reconnect=true` server-side flag triggers client retry) | None native | MIT | Go / gorilla |
| **wetty** | socket.io named events, JSON | Strings; tinybuffer batches but no boundary logic | **High/low watermark with explicit `commit`-after-`term.write`-callback ack** | None (delegate to ssh+tmux) | socket.io reconnect; PTY killed on disconnect | None native | MIT | Node + socket.io |
| **sshx** | Binary WS frame, CBOR-encoded enum | Bytes throughout (encrypted at host); xterm parser | broadcast-channel "fall behind → drop client"; per-shell 2 MiB rolling chunk log with chunk-granularity eviction | **Per-shell rolling byte log + per-client subscribe-offset; secondary 32 KiB snapshot+restore via Redis** | `WsClient::Subscribe(sid, chunknum)`; server resumes from offset | First-class: per-user cursor/focus; broadcast diffs | MIT | Rust / axum + tonic |
| **upterm** | SSH protocol (over TCP or WS) | SSH packet boundaries | SSH channel windowing | None (delegate to tmux via `--force-command`) | New ssh per reconnect; tmux survives | tmux client count | Apache 2.0 | Go |
| **VS Code remote** | IPC channel over WS, length-prefixed binary IPC framing | Strings; recorder cap 10 MB with substr eviction inside segment | `await writePromise` per replay chunk; 5 ms `setTimeout` batcher per terminal | **Segmented `(cols,rows,string)[]` recorder, replayed with per-segment `OverrideDimensions` + `await writePromise`** | Full replay event with explicit `OnProcessReplayComplete` boundary | One client per workbench (multi-window = multi-PTY) | MIT | TypeScript |
| **mosh** | Encrypted UDP datagram, fragmented `Instruction{old_num, new_num, ack_num, diff}` | Server runs full ANSI parser; ships framebuffer diffs | Adaptive send-delay; `throwaway_num` lets receiver discard old states; `receiver_quench_timer` | **Full screen state model + diff-from-acknowledged-state**; no scrollback at protocol layer | Per-packet auth; client IP can change; SSP resumes naturally | Single user | GPL v3 | C++ |
| **xterm.js `addon-attach`** | Whatever the WS sends (string or arraybuffer); enforces `binaryType=arraybuffer` | xterm parser is byte-level state-stateful | None | None | None | None | MIT | TypeScript |
| **xterm.js `addon-serialize`** | N/A (in-process) | Walks cells → emits ANSI string that round-trips through `term.write()` | N/A | **Client-side snapshot of own buffer state** | Could be combined with anything: client serializes, ships to server on disconnect, retrieves on reconnect | N/A | MIT | TypeScript |

---

## 3. Pattern catalogue (mix-and-match)

Named patterns the arbiter can compose. Every pattern carries which projects exemplify it and what its trade-offs are.

### P1. "Binary WS frames with single-byte opcode prefix" (ttyd-style)
Each frame: `[CMD:1 byte][payload:N bytes]`. CMD ∈ {OUTPUT, INPUT, RESIZE, PAUSE, RESUME, …}. Browser sets `binaryType='arraybuffer'`, slices first byte, switches.
- **Pros:** zero parsing overhead; binary-safe for raw PTY bytes; trivially extensible (new opcodes); avoids JSON quoting/escape gotchas.
- **Cons:** less self-describing than JSON; need a versioning story for future opcode additions.
- **Examples:** ttyd (binary), gotty (text-typed but same opcode pattern), VS Code IPC channel (more elaborate header but same idea).

### P2. "JSON-typed envelope over text frames" (current claude-terminal, gotty, wetty)
Each frame: `JSON.stringify({type:"output", data:string})`. Browser does `JSON.parse(event.data)`.
- **Pros:** trivial to debug (Wireshark-readable); easy to add fields; works with any string-based framework.
- **Cons:** every byte of data is JSON-quoted (control chars become `\uXXXX`, ~2x worst case); UTF-16 surrogate hazards on string slicing; no binary frame benefit.
- **Examples:** claude-terminal, wetty (via socket.io), gotty (with base64 payload).

### P3. "Base64-encoded raw PTY bytes inside a text envelope" (gotty)
Server reads bytes, `base64.encode`s them, ships as text.
- **Pros:** completely sidesteps UTF-8 boundary, surrogate, and JSON-escape concerns; works in any text-only transport.
- **Cons:** ~33% bandwidth overhead; CPU cost on both ends.
- **Examples:** gotty.

### P4. "PAUSE/RESUME with high/low-water marks driven by client ack" (ttyd, wetty)
Client tracks bytes received since last ack; when count crosses high-water, client emits PAUSE; server pauses upstream PTY read; when client crosses low-water, emits RESUME; server resumes. Optionally gate on `term.write(data, callback)` so ack is emitted only after xterm has parsed.
- **Pros:** **real end-to-end backpressure**; xterm's parser becomes the throttle, not the network buffer; survives very slow consumers without OOM.
- **Cons:** requires watermark tuning; adds round-trip latency; needs an ack vocabulary.
- **Examples:** ttyd (binary opcodes 2/3), wetty (`commit` socket.io event).

### P5. "Per-client offset / subscribe(seq)" (sshx)
Each chunk on the server's rolling buffer has a sequence number. Each client tracks the highest seq it has received. On reconnect (or new subscribe), client sends `Subscribe(sid, lastSeq)`; server resumes streaming from `lastSeq` if still in buffer, or from the oldest available chunk if behind. Each batch sent down includes its starting seq so the client can audit.
- **Pros:** correct behaviour for late-joining and reconnecting clients; no duplicate bytes; can reason about exactly-once delivery within the rolling buffer window; multi-client with independent positions.
- **Cons:** requires sequence numbers in the protocol; requires per-client state on the server (or stateless if seq is in WS subscribe message); "what if client is behind by more than buffer?" requires a degraded-mode answer (e.g. snapshot+delta, or "you missed N bytes, here's what's left").
- **Examples:** sshx.

### P6. "Server-buffered replay capped at N bytes, full dump on reconnect" (current claude-terminal — known broken at boundaries)
On reconnect, server sends the entire current buffer as one frame. No seq, no offset. Trim is character-index `slice(-N)`.
- **Pros:** trivially simple; works for one-client case if buffer stays small.
- **Cons:** trim is escape-unaware → garbage at top of replay; race with live `onData` between snapshot and resume → duplicates; no per-client cursor → late joiners share the same starting point.
- **Examples:** claude-terminal (broken).

### P7. "Full screen capture (`tmux capture-pane`) on resume + live stream after" (capture-pane approach)
On reconnect, server runs `tmux capture-pane -p -e -S -<lines>` to get a clean ANSI redraw of the visible pane (and optionally the scrollback), ships that as the "snapshot," then attaches a fresh PTY for live data.
- **Pros:** snapshot is *guaranteed* well-formed by tmux; scrollback comes for free; survives server restart because tmux is a separate process.
- **Cons:** snapshot is screen-state, not byte-stream — cannot resume "in the middle of a CSI"; if live data arrives between `capture-pane` and the next live byte, those bytes might be in the snapshot AND in the live stream; subtly different geometry from what xterm currently has.
- **Examples:** claude-terminal (its lazy-attach path uses this), upterm (recommends it via tmux force-command), ttyd (recommends it externally).

### P8. "Segmented replay: list of `(cols, rows, data)` entries with per-segment apply" (VS Code)
Replay is `Array<{cols, rows, data}>`, where a new segment starts on every resize. Client iterates: applies `OverrideDimensions(cols,rows)`, then writes data with `await writePromise`, then loops. After the loop, fires `OverrideDimensions: undefined` and `onProcessReplayComplete`.
- **Pros:** geometry-correct replay across resize history; explicit completion event ("now the live stream starts"); per-segment flush barrier prevents the parser from interleaving stale and live geometry.
- **Cons:** slightly more bookkeeping; doesn't address byte-level corruption inside a single segment.
- **Examples:** VS Code remote terminal (`TerminalRecorder` + `BasePty.handleReplay`).

### P9. "Snapshot + delta with idempotent state numbers" (mosh SSP)
Server keeps the *full screen state* as an addressable object with monotonic state numbers. Each packet says "from state N, here's the diff to state M." Receiver discards already-seen states, requests retransmit if base unknown. Throwaway_num lets receiver tell sender "you can discard state log up to here."
- **Pros:** survives arbitrarily long disconnects with bounded bandwidth (only diff from last ack); idempotent (re-applying the same instruction is a no-op).
- **Cons:** requires a parser+framebuffer model server-side; full state object, not byte stream — can't be a thin proxy to PTY bytes; complete redesign for an existing project.
- **Examples:** mosh.

### P10. "Client-side `serialize` + reattach with my-snapshot" (xterm-serialize-addon)
Client uses `addon-serialize` to capture its current screen as ANSI on disconnect. On reconnect, client either (a) ships the snapshot to the server so server can dedupe, or (b) just `term.reset()` and accepts a server-side replay knowing it could already display its own snapshot meanwhile.
- **Pros:** no server-side replay corruption affects the display; snapshot is always self-consistent (xterm produced it from its own state); zero protocol changes if snapshot is purely client-local.
- **Cons:** not a full reconnect solution alone — still need SOMETHING for the bytes-after-snapshot; serialize cost is non-zero on large scrollbacks.
- **Examples:** xterm.js `addon-serialize`. Used in production by tab-restoration features in various projects.

### P11. "Throttled batcher: coalesce N ms of PTY chunks into one frame" (wetty `tinybuffer`, VS Code `TerminalDataBufferer`)
On the server, accumulate PTY chunks into an array; flush either on `setTimeout(2-5 ms)` OR when accumulated size crosses a threshold (e.g. 512 KiB).
- **Pros:** dramatically reduces frame count during high-throughput; each flush is one big frame the WS layer can ship efficiently; **doesn't split** an escape sequence because adjacent chunks are concatenated, not framed separately.
- **Cons:** adds 2-5 ms of latency to every chunk (imperceptible for output, irrelevant for input which is small); if a single chunk > threshold, you still flush at an arbitrary boundary (rare).
- **Examples:** wetty `tinybuffer(socket, 2, 524288)`, VS Code `TerminalDataBufferer(throttleBy=5)`.

### P12. "Drop slow clients: broadcast channel with `Lagged` error" (sshx)
Server uses a bounded broadcast channel (Tokio `broadcast::channel(64)`); slow consumers fall behind; the broadcast stream emits `BroadcastStreamRecvError::Lagged(n)`; server treats lag as a connection-killing error and closes the WS.
- **Pros:** producer is never throttled by slowest consumer; bounded memory; explicit kill is better than silent OOM.
- **Cons:** slow client must reconnect (and replay) to recover; not friendly for users on bad connections.
- **Examples:** sshx (`broadcast_stream.next()` with `client fell behind on broadcast stream`).

### P13. "Per-client buffered amount check before send" (canonical)
Before `client.send(data)`, check `client.bufferedAmount > THRESHOLD`; if so, either drop the frame, or evict the client.
- **Pros:** prevents OOM from slow client; standard WebSocket idiom.
- **Cons:** dropping breaks delivery; evicting forces reconnect.
- **Examples:** none of the surveyed projects do this directly (they use higher-level mechanisms — sshx's lagged broadcast achieves the same eviction effect more cleanly), but it's recommended in MDN/WHATWG spec docs.

### P14. "Cross-server snapshot store" (sshx)
Periodically serialize the session state to a compressed blob (zstd+protobuf in sshx) and store in a shared key-value store (Redis). On server failover, restore from the latest snapshot. Sequence numbers are part of the snapshot, so clients can still subscribe-with-offset post-failover.
- **Pros:** clean separation between live state and persistence; horizontal scaling; survives any single server crash.
- **Cons:** requires external KV store; snapshot frequency vs. data-loss tradeoff.
- **Examples:** sshx (Redis Cloud).

### P15. "Resize debounce / coalesce" (canonical, missing in claude-terminal)
On the client, debounce `ResizeObserver` callbacks (e.g. `requestAnimationFrame` or a 50-100 ms timer); on the server, coalesce multiple `RESIZE` messages by checking if the new size matches the current size before calling `pty.resize`. VS Code's `TerminalRecorder.handleResize` removes empty back-to-back resize entries.
- **Pros:** stops resize-storms during window drag, mobile keyboard show/hide.
- **Cons:** adds tiny resize latency.
- **Examples:** ttyd does it implicitly via libwebsockets coalescing; VS Code does it in TerminalRecorder; wetty does not (same problem we have); xterm.js maintainers recommend it.

### P16. "Application-level ping/pong with timestamp echo for latency" (sshx, ttyd)
Client periodically sends `Ping(ts)`; server echoes `Pong(ts)`. Client computes RTT.
- **Pros:** detects half-open TCP that nginx's 24h idle won't catch; gives users a latency display.
- **Cons:** adds traffic.
- **Examples:** sshx (`WsClient::Ping(u64)` → `WsServer::Pong(u64)`), ttyd (libwebsockets-level ping with `--ping-interval=5`), gotty (Ping/Pong opcodes 2/2). **Currently absent in claude-terminal.**

### P17. "Per-segment flush barrier on replay" (VS Code `await writePromise`)
On the client, between successive replay writes, `await` xterm's write callback. Prevents geometry-override-after for segment N+1 from racing with parser-still-busy-with-segment-N.
- **Pros:** clean correctness guarantee on replay; no spurious resize redraws during replay.
- **Cons:** slightly slower replay for very long buffers.
- **Examples:** VS Code's `BasePty.handleReplay`.

### P18. "Authoritative replay end marker" (VS Code `onProcessReplayComplete`)
Server fires an explicit "replay is over, live data starts now" event AFTER all replay chunks. Client can use this to switch to live-mode UI, run a fit() once, etc.
- **Pros:** removes ambiguity about "did I get all the replay yet"; lets client perform one-shot post-replay actions (resize, focus, scroll-to-bottom) at the right moment.
- **Cons:** trivial protocol addition.
- **Examples:** VS Code (`OnProcessReplayComplete`).

### P19. "Reset-not-clear on reconnect" (xterm canonical)
Use `term.reset()` (full hard reset: parser state, modes, SGR, alt-screen flag, scrollback) instead of `term.clear()` (viewport-only) before applying replay.
- **Pros:** parser state hangover from interrupted CSI on previous connection is erased; replay starts from a known-good baseline.
- **Cons:** loses local scrollback (often desired anyway during replay).
- **Examples:** ttyd does `terminal.reset()` on reconnect (`xterm/index.ts:onSocketOpen`); claude-terminal does `term.clear()` (broken per Phase 2 scan client §5).

### P20. "Per-client cursor on a shared session"
Each connected WS gets its own subscription/iterator over the session's rolling chunk log. New chunks are not "fan-out broadcasts" but "yield to each subscriber individually." Slow client doesn't block fast client; each progresses independently.
- **Pros:** truly independent multi-client; backpressure can be per-client.
- **Cons:** more bookkeeping; needs a per-client task or async-stream.
- **Examples:** sshx (`tokio::spawn` per `Subscribe`); the inverse approach (current claude-terminal) iterates `connectedClients` synchronously inside the producer callback.

---

## 4. Specific recipes for fixing claude-terminal's pain

For each Phase-2-confirmed problem, list 2-3 concrete approaches drawn from the patterns above. **No opinions yet** — just the solution-space.

### Problem A. "Replay buffer cuts mid-ANSI-escape" (PTY scan §5.5, §6.2; client scan §10.2)
- **Recipe A1 (sshx pattern P5+P12):** replace the `String += data` accumulator with a `Vec<Bytes>`-style chunk list. Cap at chunk granularity, not byte granularity. On evict, drop oldest *whole chunks* and bump `chunk_offset`/`byte_offset` counters. Because chunks are exactly what `node-pty.onData` produced, no chunk ever spans a CSI boundary that node-pty could have torn (and StringDecoder guarantees full UTF-8 codepoints).
- **Recipe A2 (capture-pane pattern P7, refined):** on every reconnect, ALWAYS replace the in-memory buffer with a fresh `tmux capture-pane -p -e -S -` rather than ever shipping the live `+=` buffer. Tmux always emits well-formed ANSI; the snapshot is never a fragment. The risk is double-bytes between snapshot and the next live `onData` — mitigate with a sequence number on the live stream (P5).
- **Recipe A3 (VS Code pattern P8):** segment the buffer into `(cols, rows, string)[]`. The trim removes oldest *segments* (or oldest entries within the head segment with substr) but never crosses a resize boundary. On replay, send the segment list, not a flat string. Client applies `OverrideDimensions` per segment (no behaviour change if no resizes happened, so backward-compatible to single-segment replay).

### Problem B. "Reconnect race: snapshot vs live stream" (PTY scan §6.9; client scan §5)
- **Recipe B1 (P5 + P18):** assign a sequence number to every chunk written to the rolling buffer. On reconnect, the client tells the server the highest seq it has rendered (it knows because every WS frame carries the seq); server sends only `seq > client_seq`. No overlap possible.
- **Recipe B2 (P18 alone — minimal change):** before sending the snapshot, server sets a "replay-mode" flag. While true, NEW `onData` chunks are queued (NOT sent live). After the snapshot send completes, server flushes the queue, then sets a `replayComplete` marker frame, then resumes live broadcast. Single-client correctness guaranteed; multi-client not really helped.
- **Recipe B3 (P10 — client-side serialize):** on disconnect, client calls `serializeAddon.serialize()` and stores in `sessionStorage`. On reconnect, client *retains its own buffer* (no `term.clear()`), discards any incoming bytes that match what it already has (heuristic: snapshot length matches), and resumes from there. Pure client-side fix; no protocol change.

### Problem C. "No backpressure across `ws.send` sites" (WS scan §3)
- **Recipe C1 (ttyd P4):** add PAUSE/RESUME opcodes. Client sets high/low watermarks (e.g. high=2 MiB, low=512 KiB written). When client crosses high, `socket.send({type:"pause"})` (or binary opcode); server `pty.pause()`. When client drains below low, `socket.send({type:"resume"})`; server `pty.resume()`. node-pty supports `pause()` / `resume()` natively.
- **Recipe C2 (wetty P4 + xterm callback):** identical pattern but with the explicit `term.write(data, () => socket.send({type:"commit", bytes}))` flush ack. More precise (gates on actual xterm parser drain) but needs more bookkeeping.
- **Recipe C3 (sshx P12):** before each `client.send`, check `client.bufferedAmount`; if > 8 MiB, `client.close(4503, "lagging")` and let the client reconnect. Brutal but correct; no slow-client OOM.

### Problem D. "No ping/pong; 24h nginx idle" (WS scan §1.7)
- **Recipe D1 (P16):** add app-level `Ping(timestamp)`/`Pong(timestamp)` round-trip every 15-30 s. Client tracks last-pong time; if > 60 s, force-close and reconnect. Detects half-open TCP within a minute regardless of nginx config.
- **Recipe D2 (ws-library protocol ping):** call `ws.ping()` server-side every 30 s; install `ws.on('pong')`; track `isAlive`. Standard `ws@8` pattern documented in their docs (`https://github.com/websockets/ws#how-to-detect-and-close-broken-connections`).
- **Recipe D3 (nginx-side):** lower `proxy_read_timeout` to e.g. 60 s and let normal disconnect-reconnect handle dead connections. Cheapest fix but kicks healthy idle users.

### Problem E. "One shared `session.buffer` for all clients; no per-client cursor" (WS scan §5)
- **Recipe E1 (sshx P5+P20):** replace the broadcast `for (client of connectedClients) client.send(...)` loop with a per-client async subscription model. Each client has its own offset; each client gets its own backpressure decision; each client can be at a different point in the rolling buffer.
- **Recipe E2 (cheap intermediate):** keep the broadcast but have each new client's `attachToSession` send the *current* tail of the buffer with an explicit "you're at seq N" frame, then live broadcasts include their seq. Old clients see no change; new clients can detect duplication if they reconnect.
- **Recipe E3 (no change to wire):** accept the divergence; keep one shared buffer; just ensure the snapshot is well-formed (recipe A2). Multi-client divergence becomes a UX issue not a correctness issue.

### Problem F. "FitAddon NOT debounced; resize storms" (client scan §4, §10.1)
- **Recipe F1 (P15):** wrap the `ResizeObserver` callback in `requestAnimationFrame` or a 50 ms `setTimeout` debounce. Trivial change; no protocol impact.
- **Recipe F2 (P15 server-side):** server checks if incoming `RESIZE` cols/rows match the current pty size; if so, drop. This prevents tmux redraw storms even if the client misbehaves.
- **Recipe F3 (combined):** debounce client-side AND coalesce server-side AND merge resize events in the recorder (VS Code's empty-segment cleanup).

### Problem G. "All `term.write` calls fire-and-forget; no flush barrier" (client scan §2.3, §10.2)
- **Recipe G1 (VS Code P17 + P18):** on the snapshot frame, use `term.write(snapshot, () => { live writes start here })` — chain the next operation in the callback. For the streaming case, since snapshot is a single big string, just `await` the callback once before processing further messages.
- **Recipe G2 (P19 + P17):** on reconnect, do `term.reset()` (not `term.clear()`); then `term.write(snapshot, callback)`; then in the callback, install the live `onmessage` handler. Guarantees clean parser state + ordered application.

### Problem H. "Blue/green replay drift" (PTY scan §6.6)
- **Recipe H1 (P14):** introduce a snapshot store (Redis or even on-disk JSON beside the existing session state). On graceful shutdown, write each session's `seqnum` + last K bytes. New process restores from store + seqnum continuity. Clients with their own seq can subscribe-with-offset and get clean replay.
- **Recipe H2 (P7-only, simpler):** rely entirely on `tmux capture-pane` as the cross-process source-of-truth. Old process dies; new process queries tmux fresh on each new attach. The cost is no per-client byte-accurate continuity — but the *visible* state is always correct.
- **Recipe H3 (longer drain):** increase the drain window in `deploy.sh` from 5 s to e.g. 30 s, and have the old process explicitly broadcast `{type:"reconnect_soon"}` to its clients so they reconnect to the new process *during* the drain window. Requires cooperation but no protocol surgery.

---

## 5. Decisions to flag for Phase 4/5

These are the binary (or n-ary) choices the arbiter must make. Each lists "what the choice gates" and which patterns above bind to which option.

### D1. Binary frames vs UTF-8 strings?
- **Binary frames:** opcode byte + raw payload. Enables P1, makes P3 unnecessary, simplifies UTF-8 handling, ~30% bandwidth savings vs base64. Cost: requires a JS opcode-dispatcher on the client; needs `binaryType='arraybuffer'`; current claude-terminal client/server entirely text-based.
- **UTF-8 strings (status quo):** keeps JSON envelopes, easy to debug. Cost: keeps surrogate cut hazard, keeps string-trim hazard, no path to base64-free binary.
- **Hybrid:** keep JSON envelopes for control messages (resize, exit, error), switch ONLY the high-volume `output` messages to binary frames carrying raw bytes after a 1-byte opcode. Complexity middle-ground.
- **Bound to:** replay framing, backpressure mechanism, all future protocol additions.

### D2. Add seq+ack vs blind reconnect?
- **Seq+ack (P5):** every server→client output frame carries a sequence number; client tracks highest-received per session; on reconnect, client sends its last seq; server resumes from there. Requires protocol versioning.
- **Blind reconnect (status quo):** client throws away local state and accepts whatever replay the server sends. Keep the existing protocol; live with the duplication / corruption.
- **Bound to:** Problems A, B, E, H. With seq+ack, all four become solvable cleanly. Without, they become best-effort.

### D3. Snapshot+delta vs raw replay?
- **Snapshot+delta (mosh P9):** server maintains a parsed framebuffer; ships diffs from the last acked state. Highest correctness, lowest bandwidth on long disconnects. Cost: complete redesign; need a full ANSI parser server-side.
- **Raw replay (status quo, sshx P5):** ship the bytes as-is, capped at N MiB. Simple. Cost: cap is a hard limit on replay-able history; no idempotency guarantee for retries.
- **Hybrid (sshx + Redis snapshot):** raw replay in normal operation; snapshot+restore via persistence layer for cross-server moves.
- **Bound to:** the rolling-buffer eviction policy, the "what if client is behind by more than buffer" answer.

### D4. Per-client cursors on the broadcast?
- **Per-client cursors (sshx P20):** each WS gets its own iterator/subscription over the rolling buffer. Independent positions, independent backpressure decisions. Multi-client correctness: trivial.
- **Shared buffer broadcast (status quo):** one `for (client of connectedClients) send(...)` loop. Simple. Multi-client correctness: late joiners get a mid-stream snapshot; slow clients block the loop.
- **Bound to:** Problems C, E. Per-client cursors are a prerequisite for per-client backpressure (C2/C3 most natural with cursors).

### D5. Backpressure mechanism: drop oldest, slow producer, evict slow client?
- **Drop oldest (status quo, implicit):** replay buffer trims oldest bytes. No flow control to producer.
- **Slow producer with PAUSE/RESUME (ttyd P4, wetty P4):** server pauses node-pty when consumer can't keep up. Lossless. Cost: producer (Claude CLI) sees a stuck-stdout, which may break some interactive programs (Claude itself is fine; less obvious for arbitrary commands).
- **Evict slow client (sshx P12):** server kills the WS when it falls behind a threshold. Producer never throttled. Cost: bad-network users get repeatedly kicked.
- **Combinations:** PAUSE/RESUME for steady state + evict-slow-client as a hard ceiling. Most production-grade.
- **Bound to:** Problem C. Also has implications for tmux's `aggressive-resize on` — pausing the PTY pauses tmux's redraw bursts too.

### D6. Replay barrier protocol marker?
- **Yes (P18):** add a `{type:"replay_complete"}` frame after the snapshot. Client knows when to fit, focus, scroll-to-bottom, switch to "live" UI.
- **No (status quo):** client can't distinguish snapshot from live; replay-end-vs-live-start is implicit.
- **Bound to:** Problems B, G. Cheap to add, useful regardless of other choices.

### D7. Resize debounce: client, server, both?
- **Client only (P15a):** RAF/setTimeout debounce in `ResizeObserver`. Stops most storms.
- **Server-side coalesce (P15b):** drop incoming RESIZE if same as current. Catches storms even from a misbehaving client.
- **Both:** belt-and-braces.
- **Bound to:** Problem F. Decoupled from other decisions.

### D8. Reset vs clear on reconnect, with or without serialize?
- **`term.reset()` (xterm-canonical P19):** wipe parser state too. Always-correct baseline. Loses local scrollback during replay.
- **`term.clear()` (status quo):** keeps parser state. Faster but corrupt-on-mid-CSI.
- **`addon-serialize` round-trip (P10):** keep parser state, serialize old buffer to ANSI, write into a fresh parser, then accept replay. Most preservation, more code.
- **Bound to:** Problems A, B, G. Complementary to D2 (seq+ack), D3 (snapshot+delta). Standalone improvement regardless of bigger changes.

### D9. Persistence story: in-memory only, snapshot to disk/Redis, or rely on tmux?
- **In-memory only (current):** state lost on process death; rely on tmux survival for cross-restart continuity.
- **Snapshot to disk/Redis (P14):** sshx-style. Survives any single-instance failure.
- **Rely on tmux (P7):** trust tmux to be the source of truth; in-memory state is a cache.
- **Hybrid (current intent, broken):** tmux as fallback + in-memory cache + capture-pane reseed on attach. Currently has the §6.6 race.
- **Bound to:** Problem H, but also the longer-term operational story.

### D10. Throttled batcher (P11) on the live output path?
- **Yes (wetty 2 ms, VS Code 5 ms):** coalesce PTY chunks into one frame per N ms. Reduces frame count by 1-2 orders of magnitude during heavy output.
- **No (status quo):** every onData chunk is a separate frame.
- **Bound to:** indirectly to Problem C. Reduces backpressure pressure but doesn't solve it; complementary.

---

## 6. Misc observations worth flagging

- **xterm.js v6 accepts both `string` and `Uint8Array` in `term.write()`.** Confirmed in `addon-attach`. The byte-stream parser is state-stateful; cuts at any boundary are absorbed. This means switching to binary frames is **lower-risk than it sounds** — we don't need to reshape the parser, we just feed bytes.
- **node-pty supports `pty.pause()` / `pty.resume()` natively.** Required for ttyd-style PAUSE/RESUME. Documented at https://github.com/microsoft/node-pty.
- **ttyd uses `--ping-interval=5` (5 seconds) by default.** Their authors clearly think 5 s is the right cadence for terminal apps. Our 24 h nginx timeout vs zero-pings is at the other extreme.
- **sshx cap is also 2 MiB per shell.** Coincidentally exactly the same number as our (broken) cap. The difference is sshx evicts at chunk granularity and counts from `byte_offset`, so the "what does the new head look like" question doesn't arise.
- **wetty's 2-ms batcher with 512 KiB threshold** is a reasonable starting point if we adopt P11. VS Code's 5-ms batcher with no size threshold suggests the time interval matters more than the size for IPC-like overhead; for WS (with frame headers), size threshold matters more.
- **VS Code's `commands` field in the replay** (shell-integration command detection) is VS-Code-specific (PowerShell command-detection capabilities). We don't need it, but the *concept* of attaching auxiliary state to the replay event is broadly useful (could carry per-client cursor, scroll position, focus state).
- **All surveyed projects rely on the application-level WS message vocabulary, not WebSocket sub-protocols.** No one negotiates `Sec-WebSocket-Protocol`. ttyd is the exception — it specifies `subprotocols: ['tty']` in the `new WebSocket(url, ['tty'])` call (`xterm/index.ts:223`) but the value is informational only.
- **None of the surveyed projects use `perMessageDeflate`** (WS compression). All judged the CPU cost not worth it for terminal traffic, which is mostly small chunks or already-encoded ANSI. Our 2 MB replay snapshot is the one outlier where compression could save real bandwidth (~70% on ANSI-heavy text), but no project does it for live data.
- **No project surveyed uses `binaryType='blob'`.** Either `'arraybuffer'` (ttyd, sshx, addon-attach) or text frames only (gotty, wetty). The Blob default is broken for terminal data.

---

## 7. Citations — full URL list of fetched sources

All fetched live via `curl -sL` while writing this report.

### ttyd
- https://raw.githubusercontent.com/tsl0922/ttyd/main/README.md
- https://raw.githubusercontent.com/tsl0922/ttyd/main/src/protocol.c
- https://raw.githubusercontent.com/tsl0922/ttyd/main/src/server.h
- https://raw.githubusercontent.com/tsl0922/ttyd/main/html/src/components/terminal/index.tsx
- https://raw.githubusercontent.com/tsl0922/ttyd/main/html/src/components/terminal/xterm/index.ts
- (directory listing) https://api.github.com/repos/tsl0922/ttyd/contents/src
- (directory listing) https://api.github.com/repos/tsl0922/ttyd/contents/html/src/components/terminal/xterm

### gotty
- https://raw.githubusercontent.com/yudai/gotty/master/README.md
- https://raw.githubusercontent.com/yudai/gotty/master/server/handlers.go
- https://raw.githubusercontent.com/yudai/gotty/master/webtty/webtty.go
- https://raw.githubusercontent.com/yudai/gotty/master/webtty/message_types.go
- (directory listing) https://api.github.com/repos/yudai/gotty/contents/webtty

### wetty
- https://raw.githubusercontent.com/butlerx/wetty/main/README.md
- https://raw.githubusercontent.com/butlerx/wetty/main/src/server/spawn.ts
- https://raw.githubusercontent.com/butlerx/wetty/main/src/server/flowcontrol.ts
- https://raw.githubusercontent.com/butlerx/wetty/main/src/server/socketServer.ts
- https://raw.githubusercontent.com/butlerx/wetty/main/src/server/socketServer/socket.ts
- https://raw.githubusercontent.com/butlerx/wetty/main/src/buffer.ts
- https://raw.githubusercontent.com/butlerx/wetty/main/src/client/wetty.ts
- https://raw.githubusercontent.com/butlerx/wetty/main/src/client/wetty/flowcontrol.ts
- https://raw.githubusercontent.com/butlerx/wetty/main/src/client/wetty/term.ts
- (directory listings) https://api.github.com/repos/butlerx/wetty/contents/src and ./contents/src/server, ./contents/src/server/socketServer, ./contents/src/client, ./contents/src/client/wetty

### sshx
- https://raw.githubusercontent.com/ekzhang/sshx/main/README.md
- https://raw.githubusercontent.com/ekzhang/sshx/main/crates/sshx-server/src/web/protocol.rs
- https://raw.githubusercontent.com/ekzhang/sshx/main/crates/sshx-server/src/web/socket.rs
- https://raw.githubusercontent.com/ekzhang/sshx/main/crates/sshx-server/src/session.rs
- https://raw.githubusercontent.com/ekzhang/sshx/main/crates/sshx-server/src/session/snapshot.rs
- https://raw.githubusercontent.com/ekzhang/sshx/main/crates/sshx-core/src/lib.rs
- https://raw.githubusercontent.com/ekzhang/sshx/main/crates/sshx-core/proto/sshx.proto
- https://api.github.com/repos/ekzhang/sshx/contents/src/lib/protocol.ts (base64-decoded WsServer/WsClient TS mirror)
- (directory listings) https://api.github.com/repos/ekzhang/sshx/contents/crates and subfolders

### upterm
- https://raw.githubusercontent.com/owenthereal/upterm/master/README.md
- https://raw.githubusercontent.com/owenthereal/upterm/master/host/host.go
- (directory listing) https://api.github.com/repos/owenthereal/upterm/contents

### VS Code Remote Server / code-server
- https://raw.githubusercontent.com/microsoft/vscode/main/src/vs/workbench/contrib/terminal/common/basePty.ts
- https://raw.githubusercontent.com/microsoft/vscode/main/src/vs/platform/terminal/common/terminalRecorder.ts
- https://raw.githubusercontent.com/microsoft/vscode/main/src/vs/platform/terminal/common/terminalDataBuffering.ts
- https://raw.githubusercontent.com/microsoft/vscode/main/src/vs/platform/terminal/common/terminalProcess.ts
- https://raw.githubusercontent.com/microsoft/vscode/main/src/vs/workbench/contrib/terminal/common/remote/remoteTerminalChannel.ts
- (directory listings) https://api.github.com/repos/microsoft/vscode/contents/src/vs/{workbench/contrib,platform}/terminal/common and ./remote

### mosh
- https://raw.githubusercontent.com/mobile-shell/mosh/master/src/network/network.h
- https://raw.githubusercontent.com/mobile-shell/mosh/master/src/network/networktransport.h
- https://raw.githubusercontent.com/mobile-shell/mosh/master/src/network/networktransport-impl.h
- https://raw.githubusercontent.com/mobile-shell/mosh/master/src/statesync/completeterminal.h
- (directory listing) https://api.github.com/repos/mobile-shell/mosh/contents/src/network

### xterm.js addons
- https://raw.githubusercontent.com/xtermjs/xterm.js/master/addons/addon-attach/src/AttachAddon.ts
- https://raw.githubusercontent.com/xtermjs/xterm.js/master/addons/addon-serialize/src/SerializeAddon.ts

### Tooling note
- WebFetch and WebSearch in the harness are currently broken (`API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"This model does not support the effort parameter."}}` for every call). All sources above were obtained via `curl -sL <raw github URL>` and `curl -sL <github API contents URL>` (the GitHub REST API for directory listings).
