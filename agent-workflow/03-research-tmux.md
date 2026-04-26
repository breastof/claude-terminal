# 03 — Research: tmux Attach Modes for claude-terminal Streaming Reliability

> Phase 3 deliverable for `researcher-tmux-modes`. RESEARCH ONLY — no winner picked, no code change.
> Goal: characterise raw `attach-session`, `tmux -CC` (control mode), `pipe-pane`, `capture-pane`, hybrid combinations, and `tmux.conf` knobs against the divergence/replay-corruption symptoms documented in `/root/projects/claude-terminal/agent-workflow/02-scan-pty.md`.
> Local tmux version: **3.4** (`/usr/bin/tmux`, `tmux -V`). All man-page citations refer to `man tmux` on this binary unless otherwise noted; section names are uppercase, page anchors are `tmux(1)` line numbers in the locally-rendered man page (`man tmux | col -bx`, 3959 lines).

---

## 0. TL;DR (5 bullets, skip if you read the body)

- **Raw `attach-session`** is what claude-terminal does today. It hands you a fully-rendered xterm-256color byte stream over a PTY. There are zero structured boundaries, so any byte position in `session.buffer` may be inside an ANSI escape sequence — exactly the §6.2 risk in `02-scan-pty.md`. Multiple attached clients are merged through tmux's per-client renderer; tmux re-syncs each client's screen on attach via `redraw_screen`, so it solves visual coherence per-client but does NOT give the host any way to know "byte X is start of redraw, byte Y is application output". (`tmux(1)` CLIENTS AND SESSIONS, `attach-session`, lines 576-630.)
- **Control mode (`-CC`)** transforms the same stream into a line-oriented text protocol where every output chunk is wrapped as `%output %<paneId> <octal-escaped-bytes>\n` (or `%extended-output` when `pause-after` flow control is on). Each notification is a single line terminated by `\n`. This makes mid-escape-cut **impossible** at the `%output` framing level (tmux guarantees the line is delivered atomically to the protocol parser). It does NOT magically eliminate ANSI parsing — the value inside `%output` is the same xterm-256color byte stream — but it gives you a structured boundary to checkpoint, persist with seq numbers, and replay safely. (`tmux(1)` CONTROL MODE, lines 3727-3845.)
- **`pipe-pane -O`** taps the bytes flowing **into** the pane (i.e. the application stdout going into tmux's pane state machine). It is the rawest, lowest-overhead, ordering-correct firehose — but it gives you ONLY application output, not what tmux emits to a client. So it loses tmux's redraws, status-line repaints, and (critically) the resize-driven re-rendering that an attached client triggers. It's a complement to attach, not a replacement. (`tmux(1)` WINDOWS AND PANES, `pipe-pane`, lines 1467-1487.)
- **`capture-pane -p -e -J -S -`** prints a synthesised ANSI snapshot of the current pane buffer (visible + scrollback) on demand. It is suitable as a **resume baseline**: render the snapshot in a fresh xterm.js to recreate "what the screen looks like right now", then start streaming live deltas from a known checkpoint. The output is well-formed ANSI per cell (no half-escapes), the `-J` flag removes wrap ambiguity, and its cost is O(rows × cols × scrollback) — for the project's 50,000-line history-limit at 200 cols this is ~10 MB worst case but typically <1 MB. (`tmux(1)` WINDOWS AND PANES, `capture-pane`, lines 1158-1180.)
- **Hybrid X (raw attach + capture-pane snapshot on reconnect)** is the smallest change that fixes the documented divergence symptoms. It eliminates the §6.2 mid-escape-cut for the snapshot path because `capture-pane -p -e` emits well-formed sequences; combined with a boundary-aware live buffer (or just an O(scrollback)-cap reset on attach), it sidesteps the slice hazard entirely without touching the live data flow. **Hybrid Y (full `-CC` migration)** is a much larger change — needing a parser, per-pane fan-out, layout-change handling, and a different keystroke channel (commands instead of byte writes) — but it eliminates whole classes of bugs (multi-client divergence, framing ambiguity, seq numbering fits naturally on `%output` lines) and is the path that iTerm2 itself took. **Hybrid Z (raw attach + xterm.js Serializer addon as snapshot source)** moves the snapshot logic to the browser and lets the *server* be a dumb byte pipe — interesting but introduces a second snapshot mechanism (server `capture-pane` for new clients, client Serializer for re-paint), and the server still needs a way to obtain an authoritative replay for a fresh attach.

---

## 1. tmux raw attach — what it actually guarantees

### 1.1 What `tmux attach-session` does

From `tmux(1)` lines 576-619:

> If run from outside tmux, create a new client in the current terminal and attach it to target-session.

Internally a tmux client opens its TTY, sends a UNIX-domain message to the tmux server with its terminal type (`TERM`), `LC_CTYPE`, terminal size (rows × cols, derived from the controlling TTY via `TIOCGWINSZ`), and any `-f` flags. The server allocates a `client` struct, links it to the requested session, and starts emitting the rendered grid for the session's current window into the client's TTY. From the application's point of view (i.e. the bash/CLI inside the pane), nothing about the attach is visible — pane state is the source of truth, the client is just one of N viewers.

The byte stream a client sees is **the rendered output of tmux's internal screen state machine** for one pane (the active one) at a time. It is NOT the raw bytes the application wrote. tmux parses application output into its own grid (every cell holds a Unicode code point + SGR attributes), then re-emits that grid in the client's terminal-features dialect. This is why setting `default-terminal "xterm-256color"` (or `tmux-256color`) and a matching `terminal-overrides` is critical — the client side of the attach must speak whatever tmux is told to emit.

### 1.2 Ordering guarantees

Per `tmux(1)` CLIENTS AND SESSIONS lines 564-572 and the implementation in `tmux/server-client.c::server_client_check_redraw` (this file is not on this host but the behaviour is covered in the man page):

- Within one client, output is strictly ordered FIFO — tmux writes to the client TTY with `write(2)` in the order the screen-state changes are processed.
- Across clients (multi-attach), each client gets its own write loop and there is no causal ordering guarantee between clients. Two attached clients can see the same application-driven repaint at slightly different times if one of them is scheduled later by the kernel.
- The server processes one event at a time (single-threaded reactor — see `tmux(1)` MISCELLANEOUS), so application output → grid update is sequential, but client emission can be reordered by `write` returning short.

### 1.3 Redraw on resize

`tmux(1)` CLIENTS AND SESSIONS, `attach-session` (lines 576-630) and WINDOWS AND PANES, `aggressive-resize`/`window-size` (lines 2291-2299, 2483-2490).

The model is:
1. Client attaches, declares its size (cols × rows).
2. tmux computes the window's size based on `window-size` option:
   - `largest`: max of all attached client sizes
   - `smallest`: min of all attached client sizes (the historical default before tmux 3.0)
   - `latest`: size of the most recently active client
   - `manual`: only `resize-window`/`default-size` controls it
3. Each pane within the window gets sized to fit. If a pane's size changed, tmux sends the application a `SIGWINCH` and immediately re-renders the pane to the new size from its grid + scrollback.
4. Each attached client whose size differs from the window sees either letterboxing (a "padding" region on the side, filled with `fill-character`) or, if `aggressive-resize on` is set on the window, **the window itself resizes whenever the active client for that window changes** — so a smaller second client attaching to a window currently displayed by a larger first client will shrink the window for both, then the larger client redraws to fit.

The redraw on resize is a **full pane repaint**: tmux sends a clear-screen, cursor-home, then walks the grid emitting every cell. That repaint is itself a burst of bytes that propagates to every attached client. It is also one of the chief sources of "why is the WS suddenly producing 100 KB" mentioned in §6.3 of `02-scan-pty.md`.

### 1.4 Multi-client behaviour

- Any number of clients may attach to one session; each client renders independently from the same per-pane grid.
- A new attach forces tmux to send a full repaint to that one client (the "attach repaint", driven by `redraw_screen` in the server). It does NOT cause other clients to repaint unless the geometry changes (see 1.3).
- Detach is symmetric — when a client detaches, the window's size is recomputed (if `window-size latest` or aggressive sizing) and remaining clients may receive a repaint.
- All clients in the same session see the same pane content. `active-pane` flag (lines 587-588) lets a client have its own active-pane cursor independent of other clients, useful for read-only mirrors.

### 1.5 Hazards inherited by raw attach (specific to claude-terminal)

| Hazard | Why it happens | Fix path |
|---|---|---|
| Mid-escape cut in replay | Server stores all bytes seen as one string and trims tail. Tail boundary is unaligned to ANSI escape framing. | Switch snapshot source to `capture-pane` OR escape-aware tail trimmer OR full `-CC` (per-line framing). |
| Divergence between clients | tmux sends each client an independent stream. The server only tees its single PTY into N WS — but the PTY only sees one client's view. So clients that joined late are watching client-zero's view. | Either: keep one PTY per client (N attaches, each with its own fanout), or move to `-CC` where `%output` is per-pane and there's no client-specific rendering. |
| Resize storms cascading | Per-frame `ResizeObserver` → `pty.resize` → tmux redraws → byte burst. | Debounce client-side, decouple browser geometry from tmux geometry (server can run tmux at a fixed "host" size and let xterm.js letterbox locally). |
| Blue-green double-attach | During deploy overlap two PTYs may attach to one tmux session, both repaint, both fan out. | Coordinate via socket lock (only the active instance attaches), or move to `-CC` (the second instance can attach as a `no-output` flagged read-only client to get notifications only). |

---

## 2. tmux control mode (`-C` and `-CC`) — full protocol primer

This section is canonical. Sources: `tmux(1)` CONTROL MODE (lines 3727-3845) and the upstream `tmux/tmux` GitHub wiki page "Control Mode" (last verified 2026-04-26 via `curl -sL https://raw.githubusercontent.com/wiki/tmux/tmux/Control-Mode.md`).

### 2.1 Entering control mode

Two flags: `-C` (canonical mode preserved, echo on, useful for hand-typing while debugging) and `-CC` (canonical mode disabled, plus the client emits a DSC `\033P1000p` sequence on entry and `%exit` + `ST` (`\033\\`) on exit so a wrapping terminal can detect entry/exit). For a programmatic gateway (Node + node-pty), use `-CC`. Either way, the command is:

```
tmux -L claude-terminal -f tmux.conf -CC attach-session -t <sessionId>
# or
tmux -L claude-terminal -f tmux.conf -CC new-session -A -s <sessionId> ...
```

A control-mode client behaves like a normal tmux client in nearly every other respect (it can be detached, can switch sessions, can be killed, counts toward `window-size` calculations *only if* it has a size set via `refresh-client -C`).

Detach by writing an empty line (just `\n`) to the client's stdin. The client responds with `%exit` and closes.

### 2.2 The wire format

The control protocol is line-oriented. Every line terminated with `\n`. There are exactly two kinds of lines:

1. **Reply lines** wrapping a command's output, between guard markers `%begin` and `%end`/`%error`.
2. **Notification lines** prefixed with `%`, sent asynchronously outside any reply block.

Tmux guarantees notifications NEVER appear inside a `%begin/%end` block (`tmux(1)` line 3746-3747). Notifications between blocks are coalesced in their natural emission order.

### 2.3 Reply guards

Every command sent on stdin produces exactly one block:

```
%begin <unix-time> <command-number> <flags>
<...output lines, possibly zero...>
%end <unix-time> <command-number> <flags>      ← if command succeeded
%error <unix-time> <command-number> <flags>    ← if command failed
```

- `unix-time` is seconds since epoch (server-side clock).
- `command-number` is a strictly monotonic per-server integer, the same on `%begin` and the matching `%end`/`%error`.
- `flags` is currently always `1`.

`%begin` of command N is guaranteed to precede `%begin` of command N+1; output for different commands is never interleaved (`tmux(1)` line 3733-3737, wiki "Commands").

### 2.4 Full notification vocabulary (tmux 3.4)

From `tmux(1)` lines 3749-3845 plus the wiki "Notifications" table:

| Notification | Args | Meaning |
|---|---|---|
| `%begin t cmd flags` | time, cmd-id, flags | Start of a command-reply block. |
| `%end t cmd flags` | same | Successful end of a reply block. |
| `%error t cmd flags` | same | Failed end of a reply block (output before this is the error message). |
| `%output %p value` | pane-id, value (octal-escaped) | Pane `%p` produced output. |
| `%extended-output %p age ... : value` | pane-id, age-ms, future args, value | Same as `%output` but used when `pause-after` flag is on; `age` is ms the chunk was buffered before send. The `:` is a hard separator. |
| `%pause %p` | pane-id | Pane has been paused (because `pause-after` threshold hit, or manually). |
| `%continue %p` | pane-id | Paused pane has resumed. |
| `%session-changed $s name` | session-id, session-name | The attached session was changed (e.g. via `switch-client`). |
| `%client-session-changed client $s name` | client-name, session-id, session-name | *Another* client switched session. |
| `%session-renamed name` | new-name | Current session was renamed. |
| `%session-window-changed $s @w` | session-id, window-id | A session changed its current window. |
| `%sessions-changed` | (none) | Some session was created/destroyed. |
| `%window-add @w` | window-id | New window was linked to the attached session. |
| `%window-close @w` | window-id | Window in the attached session was closed. |
| `%window-renamed @w name` | window-id, name | Window in attached session renamed. |
| `%window-pane-changed @w %p` | window-id, pane-id | Active pane in window `@w` changed to `%p`. |
| `%pane-mode-changed %p` | pane-id | Pane mode (e.g. copy mode) changed. |
| `%layout-change @w layout visible-layout window-flags` | window-id, full layout string, visible-layout string, flags | Layout of window `@w` changed. The layout string is the same wire format `list-windows` emits (e.g. `bb62,159x48,0,0{79x48,0,0,79x48,80,0}`). |
| `%unlinked-window-add @w` | window-id | Window created in another session (not yours). |
| `%unlinked-window-close @w` | window-id | Window in another session closed. |
| `%unlinked-window-renamed @w name` | window-id, name | Window in another session renamed. |
| `%client-detached client` | client-name | Some client detached (could be another client). |
| `%paste-buffer-changed name` | buffer-name | Paste buffer `name` was changed. |
| `%paste-buffer-deleted name` | buffer-name | Paste buffer `name` was deleted. |
| `%subscription-changed name $s @w win-idx %p ... : value` | subscription-name, session-id, window-id, window-index, pane-id, future args, value | A subscribed format value changed. The `:` is a hard separator. |
| `%message message` | free-form text | A message sent with `display-message`. |
| `%config-error error` | free-form text | tmux config file produced an error. |
| `%exit [reason]` | optional reason | The client is exiting; if `reason` is present, it explains why. |

IDs always have a sigil prefix: sessions are `$1, $2, ...`, windows are `@1, @2, ...`, panes are `%1, %2, ...`. These are stable IDs (not indexes); they never change for the lifetime of the object. Use them in preference to names/indexes (wiki "General notes").

### 2.5 `%output` value escaping — exact rules

From `tmux(1)` lines 3785-3787 and the wiki "Pane output" section (verified on this host):

> The output has any characters less than ASCII 32 and the `\` character replaced with their octal equivalent, so `\` becomes `\134`.

So the unescape rule a parser must apply:
- A literal backslash followed by exactly three octal digits (`\000` through `\377`) decodes to the corresponding byte.
- All other bytes pass through unchanged. They will be in the range `0x20`–`0x7E` plus high bits (`0x80`–`0xFF`) — tmux does NOT touch high-bit bytes, so multi-byte UTF-8 lead/trail bytes ride through as-is.

Examples (from the wiki):
```
%output %1 nicholas@yelena:~$
%output %1 ls /\015\015\012
%output %1 altroot/     bsd.booted   dev/         obsd*        sys@\015\012bin/...
```

So `\015` is `\r`, `\012` is `\n`, `\033` is `ESC`. A `\134` decodes to `\` itself. The value field is everything after the second space (the first separator after the pane-id) up to the terminating `\n`.

The bytes inside `%output` are exactly what the application running in the pane wrote. They are NOT re-encoded for the client's terminal. So they are in the dialect tmux expects (`TERM=screen` or `tmux-256color`, depending on `default-terminal`). For an xterm.js consumer this is fine — xterm.js handles `tmux-256color`-style sequences just like `xterm-256color`.

### 2.6 Sizing a control-mode client

By default a `-CC` client does NOT have a size — it neither contributes to the `window-size` calculation nor causes any redraw on attach. If you want the pane to be the size your browser xterm.js is rendering at, you must say so explicitly:

```
refresh-client -C 80x24
# or per-window:
refresh-client -C @0:80x24
```

(`tmux(1)` lines 3743-3744 and lines 752-756.) Without this, the pane will keep whatever size it had from any other attached client (or `default-size` if no one else is attached). Multiple `-C` calls update the size and cause a real resize event. This is also where you'd debounce — call `refresh-client -C` from the server only when the geometry has actually changed.

### 2.7 Flow control — `pause-after`, `%pause`, `%continue`

`tmux(1)` lines 596-598, 3761-3774, 3798-3799, 3770-3774, plus the wiki "Flow control" section.

By default, tmux will buffer pane output indefinitely waiting for the control-mode client to drain. With `refresh-client -f pause-after=N`, tmux will pause a pane that has been buffering more than N seconds, send `%pause %p`, and stop reading from the pane until the client says `refresh-client -A '%p:continue'`. The unpause notification is `%continue %p`.

When `pause-after` is set, `%output` is replaced by `%extended-output %p <age-ms> ... : value`. The `age-ms` is the time the chunk waited in tmux's buffer before being emitted — useful for telemetry but not required for parsing.

This is the cleanest answer to the "no backpressure on WS" problem in `02-scan-ws.md` (referenced from §6 of the planner). With pause-after, a slow client doesn't OOM the server; instead the client is paused, and on `continue` it must `capture-pane` to catch up.

`refresh-client -A` accepts:
- `%p:on` — re-enable output for pane `%p` (default state).
- `%p:off` — stop sending output for pane `%p` to this client; if all clients say off, tmux will stop reading from the pane (useful for "this tab is in the background, don't waste cycles on it").
- `%p:pause` — manually pause the pane.
- `%p:continue` — manually resume the pane.

### 2.8 Format subscriptions — `refresh-client -B`

`tmux(1)` lines 765-775 and wiki "Format subscriptions". Lets you subscribe to any format expression and receive `%subscription-changed` notifications when its value changes (rate-limited to once per second per subscription). Use cases:

- Subscribe to `#{pane_current_path}` per-pane to know where the cwd is.
- Subscribe to `#{client_session}` to know which session is current.
- Subscribe to `#{window_layout}` to know layout changes (though `%layout-change` covers that).
- Subscribe to a pane-specific custom user option (`@my-state`) to push application-state changes from inside the pane to the gateway.

Syntax: `refresh-client -B 'name:type:format'` where type is empty (attached session), `%n` (pane), `%*` (all panes in attached session), `@n` (window), `@*` (all windows in attached session). Empty type+format removes a subscription named `name`.

### 2.9 Other control-mode-specific knobs

From `tmux(1)` lines 585-606 (the `-f` flags accepted by `attach-session` and settable later via `refresh-client -f`):

- `no-output` — suppress all `%output` for this client. Use for "side-band gateway" clients that only want notifications (e.g. layout, session events).
- `pause-after=N` — flow control threshold in seconds.
- `read-only` — only `detach-client` and `switch-client` keys work. (Useful for spectator clients.)
- `wait-exit` — wait for an empty stdin line before actually exiting after `%exit`. Lets the gateway flush.
- `ignore-size` — this client does not affect the size of other clients (pair with no-output to make a passive monitoring client that doesn't shrink the window).
- `active-pane` — independent active-pane tracking.

Each can be turned off later by prefixing with `!` (e.g. `refresh-client -f '!no-output'`).

### 2.10 What `-CC` does NOT do

- It does NOT do per-cell delta encoding. The bytes in `%output` are still the application's raw byte stream including any redraw bursts the application itself produces. tmux wraps each chunk in a notification but does not parse or canonicalise the contents.
- It does NOT eliminate ANSI parsing on the consumer. Inside `%output` you still need a terminal emulator (xterm.js) to make pixels.
- It does NOT replace `capture-pane`. To recover historical scrollback after a reconnect, you still call `capture-pane` (just over the control protocol).
- It does NOT solve the "browser is faster/slower than wire" problem on its own — that's `pause-after` plus your own seq-numbering on top of `%output` lines.

### 2.11 A parser sketch (TypeScript)

```ts
type CMNotification =
  | { kind: "output"; paneId: string; bytes: Uint8Array }
  | { kind: "extended-output"; paneId: string; ageMs: number; bytes: Uint8Array }
  | { kind: "pause" | "continue"; paneId: string }
  | { kind: "session-changed"; sessionId: string; name: string }
  | { kind: "client-session-changed"; client: string; sessionId: string; name: string }
  | { kind: "session-renamed"; name: string }
  | { kind: "session-window-changed"; sessionId: string; windowId: string }
  | { kind: "sessions-changed" }
  | { kind: "window-add" | "window-close"; windowId: string }
  | { kind: "window-renamed"; windowId: string; name: string }
  | { kind: "window-pane-changed"; windowId: string; paneId: string }
  | { kind: "pane-mode-changed"; paneId: string }
  | { kind: "layout-change"; windowId: string; layout: string; visibleLayout: string; flags: string }
  | { kind: "unlinked-window-add" | "unlinked-window-close"; windowId: string }
  | { kind: "unlinked-window-renamed"; windowId: string; name: string }
  | { kind: "client-detached"; client: string }
  | { kind: "paste-buffer-changed" | "paste-buffer-deleted"; bufferName: string }
  | { kind: "subscription-changed"; name: string; sessionId: string; windowId: string; windowIndex: string; paneId: string; value: string }
  | { kind: "message" | "config-error" | "exit"; text: string };

type CMReply =
  | { kind: "begin"; time: number; cmd: number; flags: number }
  | { kind: "end"; time: number; cmd: number; flags: number }
  | { kind: "error"; time: number; cmd: number; flags: number };

class ControlModeParser {
  private buf = "";
  private inReply: { time: number; cmd: number; flags: number; lines: string[] } | null = null;

  /** Feed UTF-8 string chunks from the tmux stdout. */
  feed(chunk: string, onNotification: (n: CMNotification) => void, onReply: (cmd: number, ok: boolean, lines: string[]) => void): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      this.handleLine(line, onNotification, onReply);
    }
  }

  private handleLine(line: string, onNotification: (n: CMNotification) => void, onReply: (cmd: number, ok: boolean, lines: string[]) => void): void {
    if (this.inReply) {
      if (line.startsWith("%end ") || line.startsWith("%error ")) {
        const ok = line.startsWith("%end");
        onReply(this.inReply.cmd, ok, this.inReply.lines);
        this.inReply = null;
      } else {
        this.inReply.lines.push(line);
      }
      return;
    }
    if (!line.startsWith("%")) return; // shouldn't happen outside of reply blocks
    const space = line.indexOf(" ");
    const tag = space < 0 ? line : line.slice(0, space);
    const rest = space < 0 ? "" : line.slice(space + 1);
    switch (tag) {
      case "%begin": {
        const [t, c, f] = rest.split(" ");
        this.inReply = { time: +t, cmd: +c, flags: +f, lines: [] };
        return;
      }
      case "%output": {
        // Format: %output <paneId> <octal-escaped bytes...>
        const sp = rest.indexOf(" ");
        const paneId = rest.slice(0, sp);
        const bytes = unescapeOctal(rest.slice(sp + 1));
        onNotification({ kind: "output", paneId, bytes });
        return;
      }
      case "%extended-output": {
        // Format: %extended-output <paneId> <ageMs> ... : <bytes>
        const colon = rest.indexOf(" : ");
        const head = rest.slice(0, colon).split(" ");
        const paneId = head[0];
        const ageMs = +head[1];
        const bytes = unescapeOctal(rest.slice(colon + 3));
        onNotification({ kind: "extended-output", paneId, ageMs, bytes });
        return;
      }
      case "%pause":
        onNotification({ kind: "pause", paneId: rest }); return;
      case "%continue":
        onNotification({ kind: "continue", paneId: rest }); return;
      case "%session-changed": {
        const [sid, ...nameParts] = rest.split(" ");
        onNotification({ kind: "session-changed", sessionId: sid, name: nameParts.join(" ") });
        return;
      }
      // ...one case per notification...
      case "%exit":
        onNotification({ kind: "exit", text: rest });
        return;
      default:
        // Future notifications: log and ignore. Forwards-compat per wiki.
        return;
    }
  }
}

function unescapeOctal(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; ) {
    if (s[i] === "\\" && i + 3 < s.length + 1
        && s[i + 1] >= "0" && s[i + 1] <= "7"
        && s[i + 2] >= "0" && s[i + 2] <= "7"
        && s[i + 3] >= "0" && s[i + 3] <= "7") {
      out.push(parseInt(s.slice(i + 1, i + 4), 8));
      i += 4;
    } else {
      out.push(s.charCodeAt(i));   // already 0x20-0x7E or high-bit UTF-8 bytes
      i += 1;
    }
  }
  return new Uint8Array(out);
}
```

Notes about this sketch:
- The parser is line-oriented and stateful only across a `%begin/%end` reply block. Notifications outside reply blocks are dispatched immediately.
- Octal escape decoding handles only `\NNN` (three digits). The wiki guarantees `\` itself is always escaped as `\134` so a lone `\` followed by non-octal cannot appear — but defensive code (`else { out.push(s.charCodeAt(i)) }`) handles an unexpected `\` by passing it through.
- The output is `Uint8Array` because `%output` may legitimately carry non-UTF-8 bytes (the wiki: "It may not be valid UTF-8"). Convert to `string` for xterm.js consumption only after you've done any seq-number bookkeeping; xterm.js can accept Uint8Array via `term.write(uint8)`.
- Critically: the parser reads input as a JS string but `feed()` MUST be called with strings produced by Node's `StringDecoder('utf8')` so that the line-split on `\n` is well-defined. node-pty's default already does this.

### 2.12 Latency overhead

Each `%output` line adds:
- Two leading bytes: `%o`-prefix to `%output` = 8 bytes
- One space + pane id (`%1 ` etc.) = 4–6 bytes
- Trailing newline = 1 byte
- Octal-escape expansion of control chars: every C0 byte becomes 4 bytes (`\NNN`). For typical CLI output (mostly printable ASCII), expansion ratio is ~1.0×; for ANSI-heavy redraws the worst case is ~4× because every `ESC`, `\r`, `\n`, etc. is escaped.

A pane producing 10 KB/s of ANSI-heavy output costs ~40 KB/s on the wire after octal escape, vs ~10 KB/s in raw attach. For claude-terminal at typical CLI output rates (sub-KB/s), this overhead is invisible. For a tight `cat /dev/urandom` it is significant (and pathological in any setup, control mode or not).

Latency-wise: tmux flushes the control-mode client write buffer eagerly (no batching delay). Round-trip from app `write()` → tmux gridding → `%output` line on the client's stdin is dominated by the kernel scheduler, typically <1 ms locally. There is no extra latency vs. raw attach in steady state.

---

## 3. `pipe-pane` — semantics, ordering, what it loses

### 3.1 What it is

`tmux(1)` lines 1467-1487:

> Pipe output sent by the program in target-pane to a shell command or vice versa. A pane may only be connected to one command at a time.

`pipe-pane -O` (the default direction): the **bytes the application writes** are forked into a child process whose stdin gets a copy of every byte the pane processes. So:

```
pipe-pane -t %0 -O 'cat >> /tmp/pane-%0.log'
```

writes a literal copy of the pane's input stream (i.e. application stdout/stderr) into `/tmp/pane-%0.log`.

`pipe-pane -I` reverses the direction: the child's stdout is written back into the pane (as if typed). Both flags can be combined (`-IO`). `-o` means "only open if not already open" — useful for toggling.

### 3.2 What you get

- **Raw application bytes.** No tmux re-encoding, no SGR translation, no terminal-features filtering. Whatever the application sent is what the pipe child sees, byte-for-byte, in order.
- **Ordering**: strictly FIFO with the pane's internal state-machine input. tmux processes the application's bytes in one pass — they are written to the pane state and to the pipe in the same loop iteration. So the pipe is a perfect causal copy of what the application produced.
- **Latency**: minimal. tmux writes to the pipe with the same `write(2)` discipline as the rest of its output handling.

### 3.3 What you LOSE (this is the trap)

- **No tmux-generated content**: pane border repaints, status-line updates (if status were on), copy-mode UI, choose-tree menus, `display-message` overlays — none of these reach the pipe. They are tmux's own emissions to the *client*, not the pane's input.
- **No resize-driven repaint**: when an attached client resizes and tmux re-emits the grid, that repaint is sent to the *client*, NOT to the pipe. The pipe sees only the application's response to `SIGWINCH` (if it chooses to redraw).
- **No initial state**: pipe-pane only captures from the moment it's attached forward. To know what's already on screen, you need a `capture-pane`.
- **No alt-screen separation**: the pipe sees the application's full byte stream including alt-screen toggles. If you also strip alt-screen toggles upstream (as claude-terminal does with `ALT_SCREEN_RE`), you'll be stripping them in the pipe too — which means full-screen apps' output (like vim) will be appended to the normal buffer, not handled as alt-screen. This is identical to today's behaviour, just sourced from pipe-pane.
- **One pipe per pane**: tmux refuses to attach a second pipe; the existing one is closed. So if two server instances try to pipe the same pane (blue/green overlap), one wins and the other silently loses its tap. There is no way to tee at the tmux level — you need an external `tee` in the pipe command.

### 3.4 Use cases

- **Asynchronous logging** with no client overhead: `pipe-pane 'cat >> log'` to grow a session log without affecting any attached interactive client.
- **Passive byte tap** as a backup/redundancy stream alongside an interactive attach: gives you a pristine "this is what the app sent" record to compare against `capture-pane` for debugging.
- **Bridging to a downstream consumer that wants the raw stream** without tmux's terminal state machine in the middle. (E.g. piping into a CI log collector.)

### 3.5 What it does NOT replace

- It does NOT replace attach. A `pipe-pane` consumer cannot send keystrokes back unless using the rarely-used `-I` direction, and even then you're racing the pane's controlling terminal (you can't `pipe-pane -I` AND have an attached client typing without conflict).
- It does NOT replace control mode. Control mode gives structured framing per-pane plus session-level events; pipe-pane gives raw bytes for one pane only and zero events.

---

## 4. `capture-pane` — flags, output format, snapshot recipe

`tmux(1)` lines 1158-1180. The key flags:

| Flag | Purpose |
|---|---|
| `-p` | Print the captured contents to stdout (instead of a paste buffer). Required for our use case. |
| `-e` | Include ANSI escape sequences for text and background attributes. Required to preserve color/SGR in the snapshot. |
| `-J` | Preserve trailing spaces AND join wrapped lines. Without `-J`, lines are emitted as wrapped (one tmux row = one output line, even if visually one logical line wraps). With `-J`, wrapped lines are joined into one output line. **For an xterm.js consumer, `-J` is what you want** — xterm.js will re-wrap to its own width, and joined lines avoid double-wrap artefacts. |
| `-N` | Preserve trailing spaces at each line's end. Implied by `-J`. |
| `-T` | Trim trailing positions that don't contain a character. Mutually nice with `-J` for clean output. |
| `-C` | Also escape non-printable chars as `\NNN` octal (control-mode style escaping). NOT what you want for an xterm.js snapshot — you want the raw escapes to render. |
| `-S start` | Starting line. `-` means "start of history". Negative numbers count back from the visible top. `0` is the first visible row. |
| `-E end` | Ending line. `-` means "end of visible". Default is `-E 0` (just the visible screen). |
| `-a` | Capture from the alternate screen (if any). Errors out if no alt-screen exists (unless `-q` is given). |
| `-P` | Capture only any output that is the beginning of an as-yet incomplete escape sequence (a diagnostic). |
| `-q` | Quiet — don't error out on edge cases. |
| `-b name` | Store in named paste buffer (we don't want this; use `-p` instead). |

### 4.1 The exact recipe for a "render-on-reconnect" snapshot

```
tmux -L claude-terminal capture-pane -t <paneId> -p -e -J -S - -E -
```

- `-t <paneId>` selects the pane. With multiple panes, run once per pane.
- `-p` to stdout.
- `-e` to include ANSI for color.
- `-J` to join wrapped lines into one output line each (xterm.js will rewrap).
- `-S -` = full scrollback start.
- `-E -` = end of visible (all the way to the bottom).

Output format:
- One line per logical (joined) row.
- Each line begins with whatever SGR was active at the start of the row, then cell contents with embedded SGR sequences as the attributes change.
- Each line is terminated by `\n` (LF), NOT `\r\n`.
- The cursor is NOT positioned (capture-pane does not emit cursor-motion sequences). After writing the snapshot to xterm.js, you should issue an explicit cursor-position sequence to put the cursor where tmux says it is.

To get the cursor position separately:

```
tmux -L claude-terminal display-message -t <paneId> -p '#{cursor_x},#{cursor_y}'
```

So a complete reconnect-snapshot recipe is:

```js
// 1. Snapshot the pane:
const snapshot = execFileSync("tmux", [
  "-L", TMUX_SOCKET,
  "capture-pane", "-t", paneId,
  "-p", "-e", "-J", "-S", "-", "-E", "-",
], { encoding: null, maxBuffer: 16 * 1024 * 1024 });

// 2. Snapshot the cursor:
const [cx, cy] = execFileSync("tmux", [
  "-L", TMUX_SOCKET,
  "display-message", "-t", paneId, "-p",
  "#{cursor_x},#{cursor_y}",
], { encoding: "utf-8" }).trim().split(",").map(Number);

// 3. Snapshot pane size for the client:
const [cols, rows] = execFileSync("tmux", [
  "-L", TMUX_SOCKET,
  "display-message", "-t", paneId, "-p",
  "#{pane_width},#{pane_height}",
], { encoding: "utf-8" }).trim().split(",").map(Number);

// 4. Send to xterm.js as one frame, then live stream from current pty position:
//    a) clear screen + home
//    b) snapshot bytes
//    c) cursor-position to (cx, cy)
//    d) optionally, restore SGR if you parse the trailing state
const frame =
  "\x1b[2J\x1b[H" +
  snapshot.toString("binary") +    // raw bytes (already includes SGR)
  `\x1b[${cy + 1};${cx + 1}H`;     // 1-based row;col
ws.send(JSON.stringify({ type: "snapshot", data: frame, cols, rows }));
```

### 4.2 Output post-processing

- **Convert bare `\n` to `\r\n` if writing to a raw terminal** that requires CRLF. xterm.js handles bare `\n` as cursor-down-only (no carriage return) by default — so you MUST translate `\n` → `\r\n` OR send a `\r` after each `\n` OR set xterm.js's `convertEol: true` option (which does this rewrite for you). Today's claude-terminal does not set `convertEol`, so the snapshot would render as a staircase. This is a real implementation gotcha.
- **No alt-screen interleaving**: capture-pane on the normal buffer never emits alt-screen toggles. You can ship the snapshot without any `\x1b[?1049[hl]` filtering.
- **Stripping**: with `-J`, lines are joined; with `-T`, trailing blank cells are trimmed. The combination produces compact output suitable for xterm.js to re-wrap at its own column count.
- **Line length**: at width N, each output line is at most N visible columns plus ANSI overhead. For 200 cols × 50000 history, ~12 MB worst case for a fully-coloured terminal; typical Claude CLI session is <1 MB.

### 4.3 Cost on every reconnect

- One `capture-pane` invocation forks a tmux client process, asks the server to dump grid+history for one pane, and writes to stdout. Typical wall-time: 5–50 ms for ≤1 MB output, scaling roughly linearly with output size.
- Memory: the snapshot buffers in tmux's client process, then in node's `execFileSync` buffer. Cap with `maxBuffer`.
- CPU: O(scrollback × cols) on the tmux server side; the renderer is `screen-write.c::screen_write_collect` and is well-optimised. For a 50,000-line history at 200 cols this is ~10M cell formats — milliseconds on modern hardware.
- **Run on every reconnect, not on every onData**. The cost is bounded per reconnect, not per byte.

### 4.4 Can it produce a clean snapshot xterm.js can render?

**Yes, with the caveats above.** The combination `-p -e -J -S -` produces a sequence of lines that, when written to xterm.js (with `\n` → `\r\n` rewrite OR `convertEol: true`), recreates the visible state plus scrollback as one coherent frame. The cursor must be positioned separately (xterm.js does this fine via `\x1b[Y;XH`). SGR state is line-resetting (each line begins with `\x1b[0m...` if attributes are set), so there is no leakage of attributes between rows — the snapshot is self-contained.

The two known gotchas:
1. CRLF vs LF (above).
2. `capture-pane` does NOT emit some screen-mode sequences (cursor visible/invisible, mouse mode, application-keypad mode). Those are PRESERVED in the application's stream, so they'll be missing from the snapshot until the application emits them again. For a Claude CLI session this is usually fine (the CLI re-emits its UI state on every prompt cycle). For something like vim, you would lose the alt-screen affordance until the user types something.

---

## 5. Multi-client semantics

`tmux(1)` CLIENTS AND SESSIONS, lines 564-572 plus the server-internals notes.

### 5.1 Which client gets which bytes

Every attached client (raw or `-CC`) has its own write buffer in the tmux server (`tty_write`). The server's per-frame loop:

1. Process all incoming application output → update grid for each affected pane.
2. For each attached client, mark which screen regions changed and queue redraw operations for that client's TTY.
3. Drain client TTY buffers as space allows.

A new write from an application is propagated to all attached clients. Each client's view is rendered from the same grid; the bytes they receive may differ in SGR encoding (different terminal-features), in line-wrap (different geometries), and in timing.

Control-mode clients receive `%output` notifications instead of rendered bytes — but the trigger is the same grid update. So a `-CC` client and a raw-attach client attached to the same session see identical *content*, just packaged differently.

### 5.2 Per-client view sync

Three knobs control whose view "wins":

- `window-size`: `largest`, `smallest`, `manual`, or `latest` (tmux 3.4 default is `latest` per `tmux(1)` lines 2483-2490).
- `aggressive-resize` (window option): if on, the window resizes whenever the *active* client for that window changes. (lines 2291-2299.)
- `ignore-size` flag on a client: that client does not contribute to window-size calculations.

Today's claude-terminal sets `window-size latest` and `aggressive-resize on` (`tmux.conf:33-34`). This means: the most recently-active client's geometry is the window geometry, and a switch of active client triggers a window resize and full repaint. With multiple browser clients connected via separate PTYs (today's model is one PTY per client too — each WS attach gets its own `pty.spawn` — see `02-scan-pty.md` §4), this means every reconnect causes a window-size churn and a repaint storm to all attached clients.

### 5.3 Side-band gateway pattern

A pattern useful for claude-terminal: have ONE server-side `-CC` client per session that uses `refresh-client -f no-output,ignore-size,read-only` to be a passive observer, plus N raw-attach (or N more `-CC`) clients per browser. The side-band client receives only `%window-add`, `%window-renamed`, `%layout-change`, etc., never `%output`. It's a "control plane only" client. This is what would let the server know layout/title changes in a structured way without doubling the byte traffic.

### 5.4 What multi-client does NOT solve

- **Per-client cursor**: even with `active-pane` flag, tmux only tracks one cursor per pane at the application level. Two clients hovering different cells with their pointers is a UI thing only.
- **Per-client scroll position**: tmux's scrollback (history) is shared. A client entering copy-mode scrolls only its own view, but the application keeps writing to the visible pane and other clients see those writes. This is fine for our use case (we don't enter copy mode from the WS side).

---

## 6. `alternate-screen` and `aggressive-resize` interactions

### 6.1 `alternate-screen` (pane option)

`tmux(1)` lines 2508-2515:

> This option configures whether programs running inside the pane may use the terminal alternate screen feature, which allows the smcup and rmcup terminfo capabilities. The alternate screen feature preserves the contents of the window when an interactive application starts and restores it on exit.

When `alternate-screen on` (default) and an app like vim emits `\x1b[?1049h` (CSI ? 1049 h, "save state and switch to alt screen"), tmux:
1. Saves the current "normal screen" grid + cursor + SGR state.
2. Switches the pane to a fresh blank "alt screen" grid.
3. Forwards the alt-screen toggle to all attached clients.

On `\x1b[?1049l`, tmux restores the saved state and forwards the toggle.

claude-terminal's current code strips `\x1b[?(1049|1047|47)[hl]` from the byte stream before it reaches the WS (`terminal-manager.js:34, 282`). The reason given in the comment: keep xterm.js in the normal buffer so its scrollback works. Effect:
- xterm.js never enters its own alt screen.
- Full-screen apps (vim, htop) write into xterm.js's normal buffer and pollute the scrollback.
- After the app exits, the polluted scrollback remains.
- The replay buffer captures both pre-app and during-app output as one continuous normal-buffer stream.

This IS the simplest way to make xterm.js scrollback work with a tmux backend (otherwise xterm.js's own scrollback empties on every alt-screen toggle). But it interacts badly with `capture-pane` for snapshotting:
- If the user is currently in vim (alt screen), `capture-pane` (no `-a`) captures the *normal* screen (i.e. what was there before vim) — NOT vim's view.
- `capture-pane -a` captures the alt screen but errors if no alt screen exists.

So a robust snapshot recipe must check whether the pane is in alt-screen mode and choose `-a` accordingly:

```
tmux display-message -t <paneId> -p '#{alternate_on}'
# returns "1" if in alt screen, else "0"
```

Then dispatch `capture-pane` with or without `-a`.

### 6.2 `aggressive-resize` (window option)

`tmux(1)` lines 2291-2299. Already discussed in §5.2. Notes specific to streaming reliability:

- With `aggressive-resize on`, attaching a smaller client to a window currently at 200×50 will resize the window to the smaller client's size, sending `SIGWINCH` to the application. Apps that handle WINCH will redraw, which is a byte burst.
- The default value is `off`. claude-terminal explicitly sets it `on`, presumably to ensure each browser sees its own geometry. Combined with `window-size latest`, this means: as soon as the *most recently-active* client changes geometry (or attaches), the whole pane re-flows.
- For interactive shells this is mostly harmless. For mid-prompt edits (zsh's syntax highlighting redrawing on every keystroke under different widths) this can be ugly.

Trade-off: turning `aggressive-resize off` and using `window-size manual` with a fixed `default-size` would freeze the pane to a constant geometry regardless of client. Browser xterm.js would letterbox (or fit to the host geometry), but no resize storms. Loss: users with very large displays don't get more cols.

### 6.3 Interaction matters for snapshot

- If `alternate-screen on` and the user is in vim, snapshot must use `-a`.
- If `aggressive-resize on` and `window-size latest`, the snapshot's rows/cols depend on whoever attached last — use `display-message -p '#{pane_width},#{pane_height}'` to read the actual current geometry, NOT the browser's xterm.js geometry.

---

## 7. `tmux.conf` knobs that affect streaming reliability

A consolidated reference of every option that could affect what bytes reach the WS, with rationale.

| Option | Default | Recommendation for claude-terminal | Rationale |
|---|---|---|---|
| `default-terminal` | `screen` (sometimes `tmux`) | `tmux-256color` (currently `xterm-256color`) | `tmux-256color` is the canonical TERM for content emitted by tmux to clients. xterm.js handles both, but `tmux-256color` more accurately describes what tmux emits. (`tmux(1)` 1853-1857.) |
| `terminal-overrides` | (none) | `,*256col*:Tc` (currently `,xterm-256color:Tc`) | `Tc` is the truecolor capability flag — critical for 24-bit color. Pattern over all 256col TERMs is more permissive. (`tmux(1)` 1994-2006, 3710-3717.) |
| `terminal-features` | (subset detected) | `,*256col*:RGB,clipboard,focus,sync` | Tells tmux the client supports RGB, clipboard, focus, and synchronized updates — last is the DEC sync sequence which lets apps batch redraws into atomic frames, reducing tearing. (`tmux(1)` 1926-1992.) |
| `history-limit` | 2000 | 50000 (currently set) | Larger scrollback = more useful `capture-pane -S -`. Memory cost is O(history × cols) per pane. Currently set to 50000 — fine, do not change. (`tmux(1)` 2101-2105.) |
| `escape-time` | 500 | 0 (currently set) | Zero means tmux passes ESC keypresses through immediately rather than waiting 500ms to see if it's a meta sequence. Critical for responsive editors. Currently set to 0 — keep. (`tmux(1)` 1863-1866.) |
| `set-clipboard` | `external` | `off` for this project | Setting `on` causes tmux to emit OSC 52 sequences to set the host clipboard. With xterm.js, this would push clipboard data through the WS — privacy/security implications. Currently NOT set, so falls back to `external` which only forwards programs' OSC 52 outwards. Setting `off` blocks that pathway. Worth considering for hardening. (`tmux(1)` 1905-1916.) |
| `mouse` | off | off (currently set) | Enabling mouse means tmux intercepts mouse events to do its own selection. xterm.js handles selection. Currently off — keep. (`tmux(1)` 2148-2151.) |
| `focus-events` | off | on | When on, tmux requests focus events from the client (e.g. xterm `\x1b[I` / `\x1b[O`) and forwards them to apps in the pane. Useful for editors to pause autosave on blur. Browser focus → `term.focus()` → focus event → tmux forwards to app. Note caveat: requires detach + re-attach to take effect after toggling. (`tmux(1)` 1887-1891.) |
| `extended-keys` | off | off (default) | Enables CSI u extended-key encoding (Ctrl+Tab, etc.). xterm.js doesn't fully support these — leaving off avoids confusion. (`tmux(1)` 1879-1885.) |
| `allow-passthrough` | off | off | When on, applications can emit `\x1bPtmux;...\x1b\\` to bypass tmux and write straight to the client. Useful for SIXEL/iTerm2 image protocol. claude-terminal doesn't need this; leaving off avoids surprise byte sequences in the WS. (`tmux(1)` 2498-2502.) |
| `allow-rename` | off | off (currently set) | When on, programs can rename windows via `\x1bk...\x1b\\`. Off is safer for our gateway use. Currently off — keep. (`tmux(1)` 2504-2506.) |
| `alternate-screen` | on | on (default) | Allow apps to use alt screen. Snapshot logic must handle this (see §6.3). Don't disable — vim et al. need it. (`tmux(1)` 2508-2515.) |
| `window-size` | latest (3.4 default) | `manual` with `default-size 200x50` for predictability, OR keep `latest` and accept the resize churn | `manual` freezes geometry; `latest` follows the most recent client. claude-terminal sets `latest` explicitly. With server-side debouncing of resize this is fine. (`tmux(1)` 2483-2490.) |
| `aggressive-resize` | off (default) | `off` for shells, `on` for full-screen apps. Currently `on` — consider toggling to `off` to avoid resize-driven repaint bursts. | The man page itself says: "good for full-screen programs which support SIGWINCH and poor for interactive programs such as shells". Claude CLI is more shell-like than full-screen; turning OFF would reduce the resize-storm pressure. (`tmux(1)` 2291-2299.) |
| `remain-on-exit` | off | off (currently set) | When off, pane closes when its app exits. claude-terminal wants this. Keep. (`tmux(1)` 2530-2534.) |
| `automatic-rename` | on | off | If on, tmux auto-renames windows from the foreground command. claude-terminal doesn't show window names anywhere; turning off avoids surprise `%window-renamed` notifications under control mode. (`tmux(1)` 2301-2310.) |
| `monitor-activity` | off | off | If on, generates activity alerts. Irrelevant for our use case. Keep off. (`tmux(1)` 2352-2354.) |
| `monitor-bell` | on | off | Disable so terminal bell doesn't trigger tmux's alert overlay. (`tmux(1)` 2356-2358.) |
| `status` | on | off (currently set) | No status line, hides our ops UI from the user. Keep. (`tmux(1)` 2189-2191.) |
| `prefix` | C-b | C-] (currently set) | Lower collision risk with Claude CLI. Keep. (`tmux(1)` 2153-2156.) |

### 7.1 Recommended `tmux.conf` diff (one-shot reference, NOT a recommendation to apply)

Provided here for Phase 5 to weigh against. NOT applying any of this in Phase 3.

```
# Existing settings (keep)
set -g prefix C-]
unbind C-b
set -g escape-time 0
set -g history-limit 50000
set -g status off
set -g mouse off
set -g allow-rename off
set -g remain-on-exit off

# Terminal capabilities — broaden the patterns
set -g default-terminal "tmux-256color"
set -ga terminal-overrides ",*256col*:Tc"
set -ga terminal-features ",*256col*:RGB,clipboard,focus,sync"

# Geometry — switch to manual to kill resize storms
set -g window-size manual
set -g default-size "200x50"
setw -g aggressive-resize off

# Other reliability
set -g focus-events on
setw -g automatic-rename off
setw -g monitor-bell off
set -g set-clipboard off
```

Rationale for each delta vs. current `tmux.conf`:
- `default-terminal "tmux-256color"`: more accurate for what tmux emits.
- Broader `terminal-overrides` pattern: matches both `xterm-256color` and `tmux-256color`.
- `terminal-features ... :sync`: enables synchronized updates so apps that use them get atomic redraws.
- `window-size manual` + `default-size 200x50` + `aggressive-resize off`: freezes geometry. Browser xterm.js can fit-to-container locally; the server tmux runs at a fixed 200×50 grid. Resize messages from the browser are now *advisory* — the server can either ignore them entirely (xterm.js letterboxes/scrolls) or forward them on a debounce. Eliminates the §6.3 resize storm class.
- `focus-events on`: enables proper editor blur/focus handling.
- `automatic-rename off`: under control mode, eliminates spurious `%window-renamed` events.
- `monitor-bell off`: avoids `%message` notifications on bells.
- `set-clipboard off`: blocks accidental OSC 52 leaks.

---

## 8. Existing wrappers — what they do and what we can learn

### 8.1 iTerm2 (the reference implementation)

iTerm2 is the original consumer of `-CC` mode; the protocol was designed by George Nachman to enable iTerm2's tmux integration (`tmux(1)` line 3728-3729: "control mode... allows applications to communicate with tmux using a simple text-only protocol"; iTerm2 docs at https://iterm2.com/documentation-tmux-integration.html).

Key design choices iTerm2 made:
- **One iTerm2 window per tmux session, one iTerm2 tab per tmux window, one iTerm2 split per tmux pane.** The mapping is symmetric. UI actions (split, close, resize) are translated to tmux commands sent over the control channel.
- **Window-size negotiation**: iTerm2 sets the tmux window size to match the iTerm2 window via `refresh-client -C`. tmux is configured with `window-size smallest` so multiple iTerm2 attaches converge to the smallest window. (Documented: "Windows are never larger than the smallest attached client.")
- **Layout sync via `%layout-change`**: iTerm2 parses the layout string (`bb62,159x48,0,0{79x48,0,0,79x48,80,0}` etc.) into its own split-pane representation.
- **Logging mode**: iTerm2's tmux mode has a "press L to toggle logging" feature that dumps every protocol exchange to the screen — useful for debugging during the design phase. Worth replicating in Phase 5/6 of claude-terminal as a debug WS endpoint.
- **Survives reconnect**: iTerm2 supports detach + reattach; on reattach it re-discovers state via `list-windows`, `list-panes`, `display-message`, and a `capture-pane` per pane to repaint. This is the canonical "restore on reconnect" recipe.
- **Limitations iTerm2 acknowledges**: a tab with split panes may have empty (letterboxed) areas because tmux requires every visible window to be the same size. claude-terminal's single-pane sessions don't hit this.

### 8.2 ttyd

https://github.com/tsl0922/ttyd. C+libuv backend, xterm.js frontend over WebSocket. **Does NOT integrate with tmux**. ttyd just spawns a PTY for an arbitrary command and pipes bytes through WS. To get tmux integration, the user runs `ttyd tmux attach -t mysession` — at which point ttyd is just claude-terminal's current model: raw attach over PTY, raw bytes over WS. No state sync, no reconnect snapshot, no seq numbers. Same divergence class as claude-terminal.

### 8.3 GoTTY / sorenisanerd's fork

https://github.com/sorenisanerd/gotty. Similar model to ttyd — Go-based, xterm.js frontend. Spawns a PTY, fans bytes to WS clients. Multi-client support via `--permit-write` and `--max-connection`. Like ttyd, there is no tmux awareness; treating tmux as just another command. So GoTTY-with-tmux has the same divergence problem.

### 8.4 sshx

https://github.com/ekzhang/sshx. **Most architecturally relevant to claude-terminal.** Rust backend, Svelte+xterm.js frontend, end-to-end encryption.

What sshx does that claude-terminal doesn't:
- **Per-shell sequence numbers**: each terminal "shell" has a `seqnum` (monotonic byte count). The proto (`crates/sshx-core/proto/sshx.proto`):
  ```proto
  message TerminalData {
    uint32 id = 1;   // shell id
    bytes data = 2;  // bytes
    uint64 seq = 3;  // sequence number of FIRST byte
  }
  message SequenceNumbers {
    map<uint32, uint64> map = 1;   // periodic sync
  }
  ```
  Server periodically sends `SequenceNumbers` to clients; clients echo their last-received seq on reconnect; server replays from there.
- **Chunked rolling buffer**: the server stores recent output as a `Vec<Bytes>` per shell with a 2 MiB cap. Old chunks are pruned, with `chunk_offset` and `byte_offset` tracking how much was discarded so seq numbers stay absolute. (`crates/sshx-server/src/session.rs`, see `State { seqnum, data, chunk_offset, byte_offset, ... }`.)
- **Idempotent broadcast**: comment in `session.rs` says "every update inside this channel must be of idempotent form, since messages may arrive before or after any snapshot of the current session state. Duplicated events should remain consistent."
- **Mosh-style predictive echo**: the client predicts what the local effect of typed characters will be and renders them immediately, then reconciles when the authoritative server response arrives. This is decoupled from tmux entirely; it's a UX layer in the browser.

Lessons applicable to claude-terminal:
- Add seq numbers to `{type:"output"}` frames. Lets the client say "I have up to seq N, send me from N+1" on reconnect.
- Switch the replay buffer from one big string to chunked `Vec<Bytes>` with absolute byte offsets.
- Make every server message idempotent so replay-then-live overlap is harmless.

sshx does NOT use tmux at all — it spawns plain shells and renders them directly. So sshx solves the divergence problem by having its server own the byte stream end-to-end with explicit seq/ack. claude-terminal's tmux layer adds an intermediate state machine that needs its own snapshot mechanism — `capture-pane`.

### 8.5 tmate

https://tmate.io. A fork of tmux that runs a daemon on `tmate.io` to allow shared SSH sessions. Built on tmux's own protocol (extended), not on `-CC`. Web UI is via SSH-over-WS, not via control mode parsing. Not directly useful for our model.

### 8.6 Mosh

https://mosh.org. State-synchronization-based remote shell. Uses SSP (State Synchronization Protocol) over UDP. The client and server each maintain a model of the terminal state and send diffs. Mosh is the canonical "predictive echo + replay-tolerant" remote terminal. Architecturally too far from tmux integration to be a drop-in pattern, but the ideas are: (a) the *state* is the source of truth, not the *byte history*, and (b) the protocol is diff-oriented, not stream-oriented.

For claude-terminal: think of `capture-pane -p -e -J -S -` as a Mosh-style state snapshot, and the live `%output` (or PTY bytes) as the diff stream. The combination gives Mosh-like properties: a fresh client gets a state snapshot, then incremental updates.

### 8.7 zellij / abduco / dvtm

`zellij` is a tmux-alternative multiplexer in Rust with a similar model but its own protocol (no `-CC` equivalent yet). `abduco` / `dvtm` are minimal multiplexers without web wrappers. Not relevant for "wraps tmux for web" research.

### 8.8 xterm.js Serializer addon

https://github.com/xtermjs/xterm.js/tree/master/addons/addon-serialize. Marked "experimental — under construction" in the README as of master HEAD verified 2026-04-26.

Behaviour:
- Walks the xterm.js buffer cell-by-cell, emitting SGR sequences as attributes change between cells.
- Output is a string of ANSI escape sequences that, when written to a fresh xterm.js, recreates the visible state.
- Supports both a raw-string mode and an HTML mode (`SerializeAddon.serializeAsHTML()`).
- API: `serializeAddon.serialize()` returns the string. There is also `serialize({ scrollback: N })` to include N lines of scrollback.

Limitations from the source (`SerializeAddon.ts`):
- Marked experimental. May not handle every edge case (combining marks, certain SGR combinations).
- Walks the whole buffer linearly — O(rows × cols × lookback) per call.
- Does NOT serialise alt-screen state (you'd need to call it from inside the alt-screen context).
- Does NOT preserve cursor position automatically; you can extract `term.buffer.active.cursorX/Y` and append a manual cursor-position sequence.

Use case for claude-terminal: have each browser xterm.js instance serialize its own state on disconnect (or every N seconds), POST it back to the server as a "client checkpoint", and the server uses it as the snapshot for the *same* client's reconnect. **But this only works if the same browser tab reconnects** — a fresh browser still needs an authoritative snapshot from the server (capture-pane).

So Serializer is a per-client "remember-where-I-was" cache, not a server-side authoritative snapshot.

---

## 9. Comparison matrix

The columns: **Ordering** = strict FIFO from app to consumer? **Mid-escape risk** = can a frame end inside an ANSI escape? **Resize handling** = does the mode automatically deal with resize-driven repaints? **Multi-client** = does the mode natively support N consumers without divergence? **Parsing complexity** = how much code do you need to write on the consumer? **Latency overhead** = wire bytes vs. raw application bytes.

| Mode | Ordering | Mid-escape-cut risk | Resize handling | Multi-client | Parsing complexity | Latency / overhead |
|---|---|---|---|---|---|---|
| **Raw `attach-session`** (today's claude-terminal) | Strict FIFO per client; multi-client ordering not synchronised. | HIGH at any user-imposed buffer trim boundary (the §6.2 hazard). The byte stream itself is intact from tmux; corruption only occurs when the gateway slices it. | Auto: tmux re-emits the rendered grid on resize. App receives `SIGWINCH`. Risk: a resize burst is a byte burst on the wire. | Partial: tmux supports N attached clients, but each renders independently. To fan one PTY's bytes to N WS clients (current model) loses per-client geometry. | Zero — bytes are already xterm-256color; xterm.js renders directly. | 1.0× (raw bytes). |
| **Control mode `-CC`** | Strict FIFO of `%output` lines per pane. Cross-pane order also strict (single tmux server thread). | NONE at the protocol framing level — every `%output` is a complete line terminated with `\n`. Mid-escape can still occur within the pane *application's* byte stream (e.g. a CLI writing in two `write` calls), but the framing tells you where one chunk ends. | Manual: gateway sets size with `refresh-client -C`. tmux re-emits `%output` containing the redraw bytes. Same byte-burst issue as raw, just framed. | Native: each gateway is one client; tmux sends `%output` independently per client. Multi-pane fan-out is via parsing pane IDs. Per-pane multi-client requires N gateways, one per consumer (or one gateway per browser, mediated by your app). | High — you write a parser (see §2.11). Plus a command sender. Plus layout-change handling if you support multi-pane. | 1.0–4.0× depending on control-char density. Octal-escape adds ~3 bytes per C0 byte. |
| **`pipe-pane` + raw attach** | Pipe is strict FIFO of application bytes (what the app wrote). Attach is independent FIFO of rendered bytes. They will NOT match (pipe lacks tmux's redraws). | Pipe has zero mid-escape risk (raw byte forwarding, no transformation). Attach inherits raw-attach risk. | Pipe is OBLIVIOUS to resize (sees only the app's response to WINCH). Attach handles resize as in raw. | Pipe is one-consumer (tmux refuses a second pipe-pane). Attach is N-client native. | Pipe: zero. Attach: zero. Combination: minimal — match pipe to "log" stream and attach to "live" stream; reconcile in the app. | Pipe is 1.0× over local socket; attach 1.0× over PTY. |
| **`capture-pane` polling** (e.g. every 100 ms) | NOT a stream — discrete snapshots. Order between snapshots is gateway-ordered. | Each snapshot is well-formed (no half-escapes within a snapshot). No risk inside a single snapshot. | Snapshots reflect current geometry at capture time. No real-time resize handling. | Each snapshot is fan-outable to N clients. But polling means 100 ms of input lag — bad UX. | Zero parsing — just write the snapshot to xterm.js. | Variable: full-screen redraw every poll, ~10–500 KB per poll. Heavy. |
| **Hybrid X: raw attach + capture-pane on reconnect** | Live stream is raw FIFO (per client). Snapshot is well-formed. | LIVE stream has the same risk as raw attach (bytes can split across chunks if the source did so). SNAPSHOT has no mid-escape risk. The §6.2 hazard at the user-trim boundary is eliminated IF the live buffer is bounded by a chunk-list with seq numbers OR if the gateway never trims and uses capture-pane as the only source for new clients. | Resize is handled natively by tmux. Burst risk same as raw. | N-client via fan-out, same as today. New clients get a clean snapshot. Existing clients get continued live stream. | Low — change is server-side only; xterm.js consumer code unchanged. | Live: 1.0×. Snapshot: O(scrollback) per reconnect, bounded. |
| **Hybrid Y: full `-CC` migration** | Strict per-pane FIFO. Cross-client ordering native (each gateway is one client). | None at framing layer. Per-pane snapshot via `capture-pane` over the same control channel (`capture-pane -p -e -J -S -` issued as a command, output comes back in the next `%begin/%end` block). | Same as raw — manual size declaration via `refresh-client -C`. | Native multi-pane and multi-client. Each browser gets one `-CC` connection (or one per pane). The server can also have a side-band `no-output` `-CC` client just for `%layout-change` etc. | High — parser, command sender, layout parser, possibly per-pane fan-out. Plus reconnect orchestration. | 1.0–4.0× from octal-escape. |
| **Hybrid Z: raw attach + xterm.js Serializer for client-side checkpoint** | Live stream raw FIFO. Per-client snapshot is the client's own xterm.js state. | Live stream same as raw. Server snapshot path can use `capture-pane` (same as X). Client-side snapshot is per-client and only useful for the same browser tab reconnect. | As raw. | Server snapshot fan-out; client snapshots are per-tab. | Medium — depends on whether you also implement seq numbering. | Live: 1.0×. Client snapshots: O(rows × cols × scrollback) per disconnect, browser-local cost. |

---

## 10. Hybrid recipes (concrete)

### 10.1 Recipe X — keep raw attach, add `capture-pane` snapshot on reconnect

**Change scope**: server-side only, ~50–100 LoC in `terminal-manager.js`.

**Steps**:

1. Replace `tmuxCapture(sessionId, -1)` calls (terminal-manager.js:177, 247, 489) with a function that returns a *well-formed* snapshot:
   ```js
   function tmuxSnapshot(sessionId) {
     const altOn = execFileSync("tmux", ["-L", TMUX_SOCKET,
       "display-message", "-t", sessionId, "-p", "#{alternate_on}"
     ], { encoding: "utf-8" }).trim() === "1";
     const captureArgs = ["-L", TMUX_SOCKET,
       "capture-pane", "-t", sessionId,
       "-p", "-e", "-J",
       "-S", "-", "-E", "-"
     ];
     if (altOn) captureArgs.push("-a");
     const snapshot = execFileSync("tmux", captureArgs, {
       encoding: "utf-8", maxBuffer: 16 * 1024 * 1024
     });
     // CRLF-normalise:
     return snapshot.replace(/(?<!\r)\n/g, "\r\n");
   }
   ```
2. Get cursor position separately so the snapshot can position the cursor:
   ```js
   const [cx, cy] = execFileSync("tmux", ["-L", TMUX_SOCKET,
     "display-message", "-t", sessionId, "-p", "#{cursor_x},#{cursor_y}"
   ], { encoding: "utf-8" }).trim().split(",").map(Number);
   ```
3. On `attachToSession` (terminal-manager.js:466-583), build the welcome frame as:
   ```js
   const frame = "\x1b[2J\x1b[H" + tmuxSnapshot(sessionId) + `\x1b[${cy + 1};${cx + 1}H`;
   ws.send(JSON.stringify({ type: "snapshot", data: frame }));
   ```
4. **Stop using `session.buffer` for new-attach replay.** It can still exist for in-flight late-deliveries (old WS that briefly disconnected, browser-side reconnect on same tab) — but the canonical snapshot for any new attach is from `capture-pane`.
5. The live `+=` accumulator can stay, but with a critical change: do NOT trim with `slice(-2_000_000)`. Either:
   - Replace with a chunk list (`session.buffer = []; session.buffer.push(data)`) and prune by total size with `chunk_offset` tracking like sshx.
   - Or just remove the trim entirely and let memory grow up to a hard ceiling (e.g. 10 MB), then on overflow drop `session.buffer = ""` and rely on the next reconnect to use `capture-pane`. This is simpler and safer.

**What this fixes**:
- §6.2 mid-escape cut in replay: GONE because `capture-pane -p -e` is well-formed.
- §5.5 surrogate-pair split at trim boundary: GONE for the snapshot, mitigated by chunk-list for live.
- §6.6 blue-green replay drift: improved — the new server's snapshot is from tmux's authoritative pane state, not from an in-memory `session.buffer` that may differ between blue and green.
- §6.9 reconnect race (snapshot/live duplication): improved — the snapshot is taken at a well-defined `capture-pane` moment; subsequent live bytes via `pty.onData` are appended after. There is still a window where a chunk could be in both, but with seq numbers (point 5 above) the client can dedupe.

**What it does NOT fix**:
- §6.3 resize storms: still on raw attach, still resize → tmux repaint → byte burst.
- §6.7 multi-client divergence: still one PTY per WS client, still no per-client cursor.

**Cost**:
- Per reconnect: one `capture-pane` + two `display-message` calls. ~10–50 ms wall.
- Per byte: zero overhead on live path.
- Memory: same or lower than today (no infinite-grow `String += chunk`).

### 10.2 Recipe Y — switch to `-CC` control mode

**Change scope**: server-side major (parser, command sender, fan-out logic) and modest client-side (snapshot+seq protocol). ~500–1000 LoC.

**Steps**:

1. Replace the `pty.spawn("tmux", ["...", "attach-session", "-t", sessionId])` invocation (terminal-manager.js:93-103) with `["...", "-CC", "attach-session", "-t", sessionId]`.
2. Wrap the resulting node-pty stream in a `ControlModeParser` (sketch in §2.11).
3. On any `%output %p value`, fan out to all WS clients listening on pane `%p`. The `value` is the bytes; you can either:
   - Send the raw bytes via the same `{type:"output", data: utf8DecodedBytes}` envelope as today.
   - Or send framed: `{type:"output", paneId, seq, bytes}` with explicit seq numbers per pane.
4. On `%layout-change @w layout ...`, parse the layout string and (optionally) reflect to the client UI.
5. On `%session-changed`, update server state for which session this control client is now attached to.
6. On WS `{type:"input"}`, write the bytes to the pane: `send-keys -t %p -- "<bytes>"`. Be careful with shell quoting; use `send-keys -H` for non-printable bytes (hex form).
7. On WS `{type:"resize"}`, send `refresh-client -C <cols>x<rows>` over the control channel.
8. On reconnect, issue `list-windows -t <session> -F '#{window_id} #{window_layout}'` and `capture-pane -t <pane> -p -e -J -S -` per pane to rebuild state.

**What this fixes**:
- §6.2 mid-escape-cut in replay: GONE at the framing level — every `%output` is a complete line.
- §6.4 (raw attach has no event boundary): GONE — `%output` is the boundary.
- §6.7 multi-client divergence: improved via `refresh-client -C` per-client and one control client per consumer.
- §6.6 blue-green: improved — the new server can attach as a fresh `-CC` client and start receiving `%output` from the next chunk; combined with seq numbers and snapshots it's clean.
- §6.9 reconnect race: a snapshot+seq protocol on top of `-CC` is the standard pattern (sshx-style).

**What it does NOT fix**:
- §6.3 resize storms: still resize → tmux repaint → bytes. Same physics.
- Multi-pane UI work: if you stay single-pane, no UI change needed; if you support multi-pane, need to render layout in the browser.

**Risk**:
- **Largest behavioural change** in the project. Every keystroke now goes through `send-keys` (a tmux command) rather than `pty.write`. There are subtle differences:
  - `send-keys` parses its arguments as key names (e.g. `Enter`, `C-c`) by default. To send literal bytes use `send-keys -l` or `send-keys -H` for hex.
  - Throughput: each input keystroke is now a tmux command round-trip. For typical typing (10 keys/sec) this is fine; for large pastes (`pty.write(largeChunk)`), wrapping each byte as a `send-keys` is slow. iTerm2 batches.
  - Bracketed paste: tmux supports it natively; ensure your `send-keys` accounts for it.
- **More moving parts**: parser bugs, command-sender bugs, layout-parser bugs all introduce regressions. iTerm2's control-mode integration has shipped for 10+ years and still occasionally has edge-case bugs.
- **Octal escape decoding**: must be exactly correct. `unescapeOctal` in the sketch (§2.11) handles `\NNN` only — but tmux only ever emits `\NNN`, never single or double-digit octal. So that's fine, just be sure not to over-engineer.
- **`%output` value MAY contain bytes that are not valid UTF-8**, per the wiki. So the parser must work on bytes, not chars. JS strings are UTF-16; using `String.charCodeAt(i)` for high-bit bytes works ONLY if Node's `setEncoding('utf8')` is OFF on the node-pty stream — which contradicts current setup. Either: switch node-pty to `Buffer` mode (set `encoding: null`) for the control-mode PTY, OR accept that non-UTF-8 application output will be lossy through the gateway. iTerm2 accepts the loss for non-UTF-8 apps (tmux is best-effort UTF-8 anyway).

### 10.3 Recipe Z — keep raw attach, add boundary-aware byte buffer + xterm.js Serializer

**Change scope**: server-side moderate (chunk-list buffer + seq numbers), client-side moderate (Serializer + reconnect protocol). ~200–400 LoC.

**Steps**:

1. Server: replace `session.buffer` (one big string) with `session.chunks: { seq: bigint; data: string }[]`. Track `session.totalSeq: bigint` (cumulative bytes seen).
2. Each `pty.onData(data)` → push `{ seq: session.totalSeq, data }`, increment `session.totalSeq += data.length`. Prune chunks from the head when total stored bytes > 2 MB; record `session.prunedSeq` (highest seq pruned).
3. WS protocol: every `{type:"output"}` frame includes `seq: <bigint string>`. Browser stores last received seq.
4. On reconnect, browser sends `{type:"hello", lastSeq: <bigint>}`. Server:
   - If `lastSeq >= session.prunedSeq`: replay all chunks where `seq > lastSeq`. Cheap; no escape risk because chunks are intact.
   - If `lastSeq < session.prunedSeq`: send a `capture-pane` snapshot, then resume from `session.totalSeq`.
5. (Optional client-side) Use `SerializeAddon` to capture the browser's xterm.js state on disconnect, store in `localStorage`/`IndexedDB`. On `onopen`, if seq replay would be too expensive (or unavailable), restore from the local snapshot first as an immediate visual, then accept server snapshot/replay.

**What this fixes**:
- §6.2 mid-escape cut: GONE — chunks are stored intact, never sliced.
- §5.5 surrogate split: GONE — same reason.
- §6.6 blue-green: requires `session.totalSeq` and `session.chunks` to be either persisted or reconstructible. New server bootstraps from `capture-pane` and assigns a fresh seq epoch.
- §6.7 multi-client: independent `lastSeq` per client lets each have their own cursor.
- §6.9 reconnect race: seq numbers are the deduplication primitive.

**What it does NOT fix**:
- §6.3 resize storms.
- The fundamental "raw attach has no per-pane structure" — but that's only a problem if you want multi-pane.

**Risk**:
- BigInt seq across blue-green: requires a way to make seq absolute across server restarts. Easiest: persist `session.totalSeq` to the same SQLite DB the project already uses. Ugly: rely on monotonic time and fudge.
- xterm.js Serializer is experimental — corner cases may render incorrectly. Use it as a *supplemental* immediate-render, not as the authoritative state.

---

## 11. Decisions to flag for Phase 4/5

The user wants explicit yes/no flags on these binary questions. I'm not picking — I'm framing the decision.

### 11.1 Switch from raw attach to `-CC`?

**Pro**: Eliminates whole classes of bugs (mid-escape framing, multi-pane structure, layout sync). Future-proof for multi-pane UIs.

**Con**: Largest single change. Octal-escape overhead 1.0–4.0×. Requires parser + command sender + careful keystroke handling. Non-UTF-8 in `%output` requires Buffer-mode node-pty.

**Open question**: does the project anticipate multi-pane support? If yes, `-CC` is the natural fit and you should pay the migration cost once. If no, Recipe X is much smaller for the same divergence-fix.

### 11.2 Add `capture-pane` snapshot on reconnect?

**Pro**: Fixes the §6.2 mid-escape hazard for the largest visible symptom (garbage at top of replay). Zero overhead on live path. Small change.

**Con**: Does not address resize storms or multi-client divergence. Adds one tmux fork per reconnect.

**Open question**: is the existing `tmuxCapture` already snapshot-based? Yes (terminal-manager.js:177, 247, 489 already call `tmux capture-pane -p -e`). The change is to make it the **only** snapshot source for new attaches and to stop slicing the live buffer destructively. So the change is mostly "delete the slice, route all new-attach replays through capture-pane".

### 11.3 Tighten `tmux.conf` knobs?

Recommended changes (with rationale per §7):
- `default-terminal "tmux-256color"` (more accurate)
- `terminal-features ... :sync` (atomic redraws)
- `window-size manual` + `default-size 200x50` + `aggressive-resize off` (kills resize storms — this is the §6.3 fix)
- `focus-events on` (better editor blur/focus)
- `automatic-rename off` (eliminates spurious notifications under `-CC`)
- `monitor-bell off` (no bell-driven notifications)
- `set-clipboard off` (security)

The biggest of these is `window-size manual` + `aggressive-resize off`. That single change addresses the resize-storm class without any code change. Worth doing in isolation as a Phase 4 experiment.

### 11.4 Hybrid X vs Hybrid Y vs full `-CC` migration?

A decision tree:

```
Is mid-escape-cut + multi-client-divergence the only pain?
├─ Yes  → Recipe X (small change, fixes §6.2 + §6.6 + §6.9)
└─ No, and you also need:
   ├─ Multi-pane UI in browser?     → Recipe Y (full -CC)
   ├─ Per-client cursor / scrollback? → Recipe Y
   ├─ Better backpressure (slow clients)? → Recipe Y (pause-after) OR Recipe Z (seq numbers)
   └─ Lower-risk byte-correctness fix only? → Recipe Z (seq numbers + Serializer)
```

Recipe X is the **minimum viable fix**. Recipe Z is a **medium-risk middle ground**. Recipe Y is the **end-state architecture** that iTerm2 has been running on for over a decade.

A staged path would be: Phase 4 = Recipe X plus the `tmux.conf` knobs (especially `window-size manual` to kill resize storms). Phase 5 = Recipe Z (seq numbers) on top. Phase 6 = consider Recipe Y if multi-pane UI becomes a goal.

---

## 12. Citations index

Local man page (`man tmux | col -bx`, 3959 lines, tmux 3.4 on `/usr/bin/tmux`):

- DESCRIPTION: lines 10-126
- DEFAULT KEY BINDINGS: lines 128-203
- CLIENTS AND SESSIONS: lines 564-868 (especially `attach-session` 576-630, `refresh-client` 735-788, `new-session` 683-733)
- WINDOWS AND PANES: lines 869-1643
  - `capture-pane`: 1158-1180
  - `pipe-pane`: 1467-1487
  - `resize-pane`: 1503-1519
  - `resize-window`: 1521-1529
- OPTIONS: lines 1731-2556
  - `default-terminal`: 1853-1857
  - `escape-time`: 1863-1866
  - `focus-events`: 1887-1891
  - `set-clipboard`: 1905-1916
  - `terminal-features`: 1926-1992
  - `terminal-overrides`: 1994-2006
  - `history-limit`: 2101-2105
  - `mouse`: 2148-2151
  - `aggressive-resize`: 2291-2299
  - `window-size`: 2483-2490
  - `allow-passthrough`: 2498-2502
  - `allow-rename`: 2504-2506
  - `alternate-screen`: 2508-2515
  - `remain-on-exit`: 2530-2534
- TERMINFO EXTENSIONS: lines 3637-3725
- CONTROL MODE: lines 3727-3845

External sources (verified 2026-04-26 via curl):
- tmux Control Mode wiki page, raw markdown: `https://raw.githubusercontent.com/wiki/tmux/tmux/Control-Mode.md`
- iTerm2 tmux Integration docs: `https://iterm2.com/documentation-tmux-integration.html`
- xterm.js addon-serialize README: `https://raw.githubusercontent.com/xtermjs/xterm.js/master/addons/addon-serialize/README.md`
- xterm.js addon-serialize source: `https://raw.githubusercontent.com/xtermjs/xterm.js/master/addons/addon-serialize/src/SerializeAddon.ts`
- sshx proto: `https://raw.githubusercontent.com/ekzhang/sshx/main/crates/sshx-core/proto/sshx.proto`
- sshx server session impl: `https://raw.githubusercontent.com/ekzhang/sshx/main/crates/sshx-server/src/session.rs`

Internal references:
- `/root/projects/claude-terminal/agent-workflow/02-scan-pty.md` — Phase 2 PTY pipeline scan, the source of every "current behaviour" claim in this file
- `/root/projects/claude-terminal/terminal-manager.js` — current PTY/tmux glue
- `/root/projects/claude-terminal/tmux.conf` — current tmux config

---

## 13. Outstanding questions for Phase 4/5

1. **Are we OK with Buffer-mode node-pty for the control-mode case?** If yes, parser can handle non-UTF-8 `%output` correctly. If no, we lose fidelity for apps that emit binary.
2. **Is the project's blue-green deploy model going to persist?** If the server is going to become stateful (sqlite-persisted seq numbers), some of the deploy machinery may need to change.
3. **Does the user care about multi-pane UI in the browser?** If yes, Recipe Y is on the critical path; if no, Recipe X + Recipe Z is sufficient.
4. **What is the latency budget for keystrokes?** If <50 ms input echo is required, `send-keys` over `-CC` may be too slow for large pastes — would need a separate input pipe. iTerm2 batches paste to `send-keys -l <chunk>`. Worth measuring before Phase 5 commits to Recipe Y.
5. **Are we OK ignoring `tmux.conf` changes that require detach-and-reattach to take effect (`focus-events`)?** During a deploy, every client would have to reconnect for the change to apply. Same as today's behaviour, just worth noting.

End of `03-research-tmux.md`.
