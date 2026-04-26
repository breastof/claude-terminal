# 02 — Scan: xterm.js Client Render Path

> Agent: `scanner-xterm-client`
> Branch: `feat/tmux-streaming-and-mobile`
> Goal: audit browser-side xterm.js render path — write loop, FitAddon usage, IME handling, addons, callback chaining, replay-vs-live ordering.
> Mode: SCAN ONLY. No solutions. No edits.

---

## 0. Files in scope

- `/root/projects/claude-terminal/src/components/Terminal.tsx` — primary persistent terminal (442 lines).
- `/root/projects/claude-terminal/src/components/EphemeralTerminal.tsx` — short-lived terminal for ephemeral sessions (115 lines).
- `/root/projects/claude-terminal/src/lib/TerminalScrollContext.tsx` — scroll context provider (51 lines).
- `/root/projects/claude-terminal/src/components/presence/CursorOverlay.tsx` — consumer of scroll context (only client of `useTerminalScroll`, no `term.write` calls).
- `/root/projects/claude-terminal/package.json` — version pins.
- `/root/projects/claude-terminal/terminal-manager.js` — server-side reference for how the replay buffer arrives (cited only for ordering analysis).

Grep results confirm these are the only files touching `xterm`/`@xterm/*`:

```
/root/projects/claude-terminal/src/components/Terminal.tsx
/root/projects/claude-terminal/src/components/EphemeralTerminal.tsx
/root/projects/claude-terminal/src/components/presence/CursorOverlay.tsx   # uses xterm only via .xterm class selector for "/" hotkey filter
```

`CursorOverlay.tsx:91` has `target.closest(".xterm")` only — it never writes to or instantiates a terminal. Excluded from further audit.

---

## 1. xterm.js instantiation

### 1.1 Version pins (`package.json`)

| Package | Version pin (semver) | Resolved | File:line |
|---------|---------------------|----------|-----------|
| `@xterm/xterm` | `^6.0.0` | `6.0.0` | `package.json:45` |
| `@xterm/addon-fit` | `^0.11.0` | `0.11.0` | `package.json:43` |
| `@xterm/addon-web-links` | `^0.12.0` | `0.12.0` | `package.json:44` |

Resolved versions checked from `node_modules/@xterm/{xterm,addon-fit,addon-web-links}/package.json`. Caret allows minor/patch upgrades on next `npm install` — not pinned.

NOT installed (verified by `ls node_modules/@xterm/`):
- `@xterm/addon-serialize`
- `@xterm/addon-unicode11`
- `@xterm/addon-webgl`
- `@xterm/addon-canvas`
- `@xterm/addon-search`
- `@xterm/addon-attach`
- `@xterm/addon-ligatures`
- `@xterm/addon-image`

Only **two** addons exist on disk: `addon-fit` and `addon-web-links`.

### 1.2 Persistent terminal — `Terminal.tsx:236-243`

```ts
const term = new XTerm({
  cursorBlink: true,
  fontSize: 14,
  fontFamily:
    "'Geist Mono', 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
  theme: themeConfigs[themeRef.current].terminal,
  scrollback: 5000,
});
```

Options passed to constructor (5 keys):
1. `cursorBlink: true` — `Terminal.tsx:237`
2. `fontSize: 14` — `Terminal.tsx:238`
3. `fontFamily: "'Geist Mono', 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace"` — `Terminal.tsx:239-240`
4. `theme: themeConfigs[themeRef.current].terminal` — `Terminal.tsx:241`
5. `scrollback: 5000` — `Terminal.tsx:242`

Options NOT set (xterm.js defaults apply):
- `rows`, `cols` — left to `FitAddon` to compute on `open()`.
- `convertEol` — default `false`. PTY is expected to send `\r\n`; node-pty does so on Linux PTY.
- `cursorStyle` — default `block`.
- `disableStdin` — default `false`.
- `drawBoldTextInBrightColors` — default `true`.
- `fontWeight`, `fontWeightBold` — defaults.
- `letterSpacing`, `lineHeight` — defaults (1, 1.0).
- `logLevel` — default `info`.
- `macOptionIsMeta`, `macOptionClickForcesSelection` — defaults `false`.
- `minimumContrastRatio` — default `1`.
- `rightClickSelectsWord` — default `false` on linux/win, `true` on mac.
- `screenReaderMode` — default `false`.
- `tabStopWidth` — default `8`.
- `wordSeparator` — default `" ()[]{}',\""`.
- `allowProposedApi` — default `false`. Required for `Unicode11Addon`/`WebglAddon`/serialize. Since none are loaded, leaving it off is consistent.
- `allowTransparency` — default `false`.
- `customGlyphs` — default `true`.
- `overviewRulerWidth` — not set; ruler not used.
- `windowsMode` / `windowsPty` — not set; server is Linux.

Theme object comes from `@/lib/theme-config` indirectly; not in scope for this scan, but the **theme can be hot-swapped at runtime** without re-instantiation:

```ts
// Terminal.tsx:50-54
useEffect(() => {
  if (xtermRef.current) {
    xtermRef.current.options.theme = themeConfigs[theme].terminal;
  }
}, [theme]);
```

This mutates `term.options.theme` in place. Theme changes do NOT reset/clear the buffer — relevant for the "screen state" hypothesis.

### 1.3 Ephemeral terminal — `EphemeralTerminal.tsx:28-35`

```ts
const term = new XTerm({
  cursorBlink: true,
  fontSize: 13,
  fontFamily: "'Geist Mono', 'JetBrains Mono', 'Fira Code', monospace",
  theme: themeConfigs[themeRef.current].terminal,
  scrollback: 1000,
  rows: 10,
});
```

Options (6 keys, differs from main):
1. `cursorBlink: true` — `EphemeralTerminal.tsx:29`
2. `fontSize: 13` (vs 14 in main) — `EphemeralTerminal.tsx:30`
3. `fontFamily: "'Geist Mono', 'JetBrains Mono', 'Fira Code', monospace"` (no Cascadia Code) — `EphemeralTerminal.tsx:31`
4. `theme: themeConfigs[themeRef.current].terminal` — `EphemeralTerminal.tsx:32`
5. `scrollback: 1000` (vs 5000) — `EphemeralTerminal.tsx:33`
6. `rows: 10` — `EphemeralTerminal.tsx:34` — **explicit fixed rows**, FitAddon may still resize on first fit.

### 1.4 Addon load order

Persistent terminal — `Terminal.tsx:245-249`:
```ts
const fitAddon = new FitAddon();
const webLinksAddon = new WebLinksAddon();
term.loadAddon(fitAddon);
term.loadAddon(webLinksAddon);
term.open(terminalRef.current);
```

Order:
1. `loadAddon(fitAddon)` — `Terminal.tsx:248`
2. `loadAddon(webLinksAddon)` — `Terminal.tsx:249`
3. `term.open(terminalRef.current)` — `Terminal.tsx:250`

Both addons attached **before** `open()`. `WebLinksAddon` registers per-cell link matchers on the renderer; it does not intercept `write()` calls and does not buffer data.

Ephemeral — `EphemeralTerminal.tsx:37-39`:
```ts
const fitAddon = new FitAddon();
term.loadAddon(fitAddon);
term.open(containerRef.current);
```

Order:
1. `loadAddon(fitAddon)` — `EphemeralTerminal.tsx:38`
2. `term.open(containerRef.current)` — `EphemeralTerminal.tsx:39`

No `WebLinksAddon` here. No serializer. No webgl/canvas renderer addon — falls through to the **default DOM renderer** (xterm.js v6 still ships a DOM renderer; the WebGL/Canvas renderers are explicit opt-in via addons).

### 1.5 Renderer

No `WebglAddon` or `CanvasAddon` is loaded → xterm.js v6 uses its **DOM renderer by default**. This is significantly slower than the GL/Canvas paths and is known to drop frames under high write throughput. (Stated as fact, not a recommendation.)

---

## 2. Write-loop audit

Every `term.write(…)` call site, with chaining/queue analysis.

### 2.1 `Terminal.tsx`

#### Site A — live PTY output, persistent terminal
**File:line:** `Terminal.tsx:174`

```ts
case "output":
  term.write(message.data);
  break;
```

- **Chained?** No. The return value of `write()` is **discarded**. No callback. No `await`. No promise.
- **Queue?** No application-level queue. xterm.js has its own internal write buffer (`InputHandler` parses asynchronously), but the application does not enforce ordering between successive WS frames.
- **Triggered by:** `ws.onmessage` for messages where `JSON.parse(event.data).type === "output"`.

#### Site B — exit notification
**File:line:** `Terminal.tsx:177-179`

```ts
case "exit":
  term.write(
    "\r\n\x1b[90m--- Сессия остановлена ---\x1b[0m\r\n"
  );
  break;
```

- **Chained?** No. Static UI string written immediately after potentially in-flight `output` writes. No barrier ensures previous writes have flushed before this banner appears.
- **Queue?** No.

#### Site C — stopped notification
**File:line:** `Terminal.tsx:182-184`

```ts
case "stopped":
  term.write(
    "\x1b[90m--- Сессия остановлена. Нажмите \"Возобновить\" в боковой панели. ---\x1b[0m\r\n"
  );
  break;
```

- **Chained?** No. Same pattern as exit.

#### Site D — error notification
**File:line:** `Terminal.tsx:187-189`

```ts
case "error":
  term.write(
    `\r\n\x1b[31m${message.message}\x1b[0m\r\n`
  );
  break;
```

- **Chained?** No.

#### Site E — fallback raw write (unparseable JSON)
**File:line:** `Terminal.tsx:193`

```ts
} catch {
  term.write(event.data);
}
```

- **Chained?** No. Triggered when `JSON.parse(event.data)` throws. Writes raw `event.data` (a string) directly into xterm. This is a **silent fallback path** — any non-JSON frame dumps unmediated bytes into the terminal.

### 2.2 `EphemeralTerminal.tsx`

#### Site F — ephemeral output
**File:line:** `EphemeralTerminal.tsx:52`

```ts
if (msg.type === "output") term.write(msg.data);
```

- **Chained?** No.

#### Site G — ephemeral exit
**File:line:** `EphemeralTerminal.tsx:54`

```ts
term.write("\r\n\x1b[90m--- Сессия завершена ---\x1b[0m\r\n");
```

- **Chained?** No.

#### Site H — ephemeral fallback raw write
**File:line:** `EphemeralTerminal.tsx:57`

```ts
} catch {
  term.write(event.data);
}
```

- **Chained?** No. Same silent fallback as Site E.

### 2.3 Summary table

| Site | File:line | Trigger | `write()` chained via callback? | App-level queue? |
|------|-----------|---------|---------------------------------|------------------|
| A | `Terminal.tsx:174` | WS `output` | NO | NO |
| B | `Terminal.tsx:177-179` | WS `exit` | NO | NO |
| C | `Terminal.tsx:182-184` | WS `stopped` | NO | NO |
| D | `Terminal.tsx:187-189` | WS `error` | NO | NO |
| E | `Terminal.tsx:193` | WS message (unparseable JSON) | NO | NO |
| F | `EphemeralTerminal.tsx:52` | WS `output` | NO | NO |
| G | `EphemeralTerminal.tsx:54` | WS `exit` | NO | NO |
| H | `EphemeralTerminal.tsx:57` | WS message (unparseable JSON) | NO | NO |

**Conclusion: zero of 8 `write()` call sites use the callback signature `term.write(data, () => …)` or chain successive writes.** Every write is fire-and-forget. xterm.js's internal `WriteBuffer` does serialize writes in order under normal use, but the API contract for ordering relies on the caller never assuming "the previous write is fully parsed." The application code makes no use of that contract.

xterm.js v6's `Terminal.write(data, callback?)` queues bytes in its `WriteBuffer`. The buffer is drained in arrival order, so single-thread JS is unlikely to *reorder* sequential `write()` calls within one event loop turn. The risk is not reordering of the calls themselves but:
- The fallback path (Sites E, H) can race with parsed-output writes if the WS server ever emits both types in the same connection.
- There is no flow control or backpressure to xterm — under burst load the `WriteBuffer` grows unbounded and `onWriteParsed` (Site `Terminal.tsx:270`) fires asynchronously, potentially after re-renders triggered by `fit()`.

---

## 3. WebSocket receive handler

### 3.1 Persistent terminal — `Terminal.tsx:169-195`

```ts
ws.onmessage = (event) => {
  try {
    const message = JSON.parse(event.data);
    switch (message.type) {
      case "output":
        term.write(message.data);
        break;
      case "exit":
        term.write(
          "\r\n\x1b[90m--- Сессия остановлена ---\x1b[0m\r\n"
        );
        break;
      case "stopped":
        term.write(
          "\x1b[90m--- Сессия остановлена. Нажмите \"Возобновить\" в боковой панели. ---\x1b[0m\r\n"
        );
        break;
      case "error":
        term.write(
          `\r\n\x1b[31m${message.message}\x1b[0m\r\n`
        );
        break;
    }
  } catch {
    term.write(event.data);
  }
};
```

#### Shape contract

- Frame is expected to be a JSON-encoded string. The handler unconditionally calls `JSON.parse(event.data)`.
- `binaryType` is **never set** (grep confirms zero occurrences in client code). Default is `"blob"`. If the server ever sent a binary frame, `event.data` would be a `Blob`, `JSON.parse(Blob)` would throw, and the catch branch (Site E) would write the **`Blob`'s `toString()`** ("`[object Blob]`") into the terminal. That is broken-by-design but currently inert because the server only emits text frames (`ws.send(JSON.stringify(...))` per `terminal-manager.js:300, 318, 469, 507, 511, 553, 562, 570, 752, 760, 770, 778`).
- Recognized message types from server: `output`, `exit`, `stopped`, `error`. Confirmed at `terminal-manager.js:300, 318, 469, 507, 511`.
- Server also emits `welcome` (`server.js:215`) and `connected` (`server.js:257`) on **other** WS endpoints (presence, symphony) — not the terminal endpoint. Terminal client has no `welcome`/`connected` handling.

#### Non-`output` (control) message handling

- `exit`, `stopped`, `error` → treated as "render banner into the terminal." There is no separation between control messages and data — they are all coalesced into the same `term.write` stream.
- `image` is **send-only** (`Terminal.tsx:351`). The server-side `image` handler exists at `terminal-manager.js:531-573` and pipes the image to `xclip`; it does not echo back as `image`.
- `resize` is **send-only** from client; server has no `resize` echo. No client handling.

#### What NOT in `onmessage`

- No `seq` / `ack` fields are read.
- No `pong`/`ping` handling. The browser handles WS pings transparently.
- No "barrier" or "end-of-replay" sentinel. The first `output` after `onopen` is conventionally the replay buffer dump (`terminal-manager.js:507`) but the wire format does not distinguish replay from live.
- No `clear`/`reset` message type.

### 3.2 Ephemeral — `EphemeralTerminal.tsx:49-59`

```ts
ws.onmessage = (event) => {
  try {
    const msg = JSON.parse(event.data);
    if (msg.type === "output") term.write(msg.data);
    else if (msg.type === "exit") {
      term.write("\r\n\x1b[90m--- Сессия завершена ---\x1b[0m\r\n");
    }
  } catch {
    term.write(event.data);
  }
};
```

- Subset of the persistent handler. `stopped` and `error` are silently ignored (no `case`/`else if`).
- Same JSON-only contract, same fallback hazard.

### 3.3 Bytes flow into `write()`

For both terminals, the only path is:

```
WS frame (string)
  → JSON.parse(event.data)
  → message.data   (string, server-encoded UTF-8)
  → term.write(message.data)   // xterm WriteBuffer
```

`message.data` is whatever the server put in `data:` of the JSON envelope. Server-side at `terminal-manager.js:280-300`:

```js
// session.buffer += data; … client.send(JSON.stringify({ type: "output", data }));
```

`data` is the raw string yielded by `pty.onData` after the alt-screen scrubber (`terminal-manager.js:280`). It is **already a JS string by the time it reaches `JSON.stringify`** — node-pty in default mode emits strings, not Buffers, so UTF-8 decoding happens on the server. The JSON encoding then escapes control chars but preserves the string verbatim. Once the client `JSON.parse`s it, the same JS string lands at `term.write`. xterm.js then accepts a string and parses ANSI/UTF-8 as text.

There is **no binary path**. There is **no chunked-write protocol**. Each WS frame is one logical chunk.

### 3.4 Outbound message types

From `Terminal.tsx`:

| Type | File:line | Trigger |
|------|-----------|---------|
| `resize` | `Terminal.tsx:67-73` | `useEffect` on `fullscreen` change |
| `resize` | `Terminal.tsx:160-166` | `ws.onopen` initial size |
| `input` | `Terminal.tsx:219` | `term.onData` callback |
| `image` | `Terminal.tsx:351` | `paste` event with image MIME |
| `resize` | `Terminal.tsx:366-372` | `ResizeObserver` callback |

From `EphemeralTerminal.tsx`:

| Type | File:line | Trigger |
|------|-----------|---------|
| `input` | `EphemeralTerminal.tsx:63` | `term.onData` |
| `resize` | `EphemeralTerminal.tsx:70` | `ResizeObserver` |

---

## 4. Resize / FitAddon flow

### 4.1 Persistent terminal — every `fit()` call site

| # | File:line | Trigger | Inside `requestAnimationFrame`? | Debounced? |
|---|-----------|---------|--------------------------------|------------|
| 1 | `Terminal.tsx:64` | `useEffect([fullscreen])` after fullscreen toggles | Yes — double-rAF (`Terminal.tsx:62-63`) | NO |
| 2 | `Terminal.tsx:254` | Initial mount, after `term.open()` | Yes — double-rAF (`Terminal.tsx:252-253`) | NO |
| 3 | `Terminal.tsx:363` | `ResizeObserver` callback (`handleResize`) | NO | **NO** |

The `ResizeObserver`:

```ts
// Terminal.tsx:362-380
const handleResize = () => {
  fitAddon.fit();
  const ws = wsRef.current;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(
      JSON.stringify({
        type: "resize",
        cols: term.cols,
        rows: term.rows,
      })
    );
  }
  requestAnimationFrame(() => publishScroll());
};

const resizeObserver = new ResizeObserver(handleResize);
if (terminalRef.current) {
  resizeObserver.observe(terminalRef.current);
}
```

- `ResizeObserver` fires **per browser layout pass** that changes the observed element. It is the browser-throttled equivalent of "every layout settled," NOT debounced by the application.
- Each fire calls `fitAddon.fit()` synchronously and immediately sends a `resize` WS frame.
- During keyboard open/close on mobile (or window resize drag on desktop), `ResizeObserver` can fire **dozens** of times in rapid succession. Each call:
  1. Recomputes character cell metrics (DOM measurement → sync reflow).
  2. Calls `term.resize(cols, rows)` internally → triggers re-render of every visible cell.
  3. Sends a `resize` JSON frame to server → server calls `pty.resize(cols, rows)` → tmux re-renders the pane → emits a burst of redraw bytes back over the WS into `term.write` while the client may still be mid-resize.

There is no `setTimeout`/`clearTimeout`/`requestIdleCallback` debounce wrapping `handleResize` and no `lodash.debounce` or equivalent imported anywhere.

### 4.2 Ephemeral — fit calls

| # | File:line | Trigger | rAF? | Debounced? |
|---|-----------|---------|------|------------|
| 1 | `EphemeralTerminal.tsx:42` | Initial mount | Yes — double-rAF (`EphemeralTerminal.tsx:41-42`) | NO |
| 2 | `EphemeralTerminal.tsx:68` | `ResizeObserver` callback | NO | **NO** |

Same pattern as persistent.

### 4.3 No `visualViewport` listener

Grep for `visualViewport` returns zero hits in `src/`. `ResizeObserver` on the terminal container is the only mechanism for size changes. On mobile browsers, the soft keyboard typically resizes the layout viewport, which would re-fire `ResizeObserver` — but `visualViewport.resize` events (which fire on keyboard show/hide independently of layout viewport) are not subscribed.

### 4.4 No window-level resize listener for the terminal

`window.addEventListener("resize", …)` matches found:
- `SystemHealth.tsx:120` — for popover anchor positioning, unrelated.
- `CursorOverlay.tsx:30` — for mobile detection.

Neither touches the terminal. The terminal relies entirely on `ResizeObserver`.

### 4.5 Theme-change side-effect

`Terminal.tsx:50-54` mutates `term.options.theme` on theme change. xterm.js triggers a full rerender on theme mutation. This does **not** call `fit()`. The terminal preserves its current dimensions. No issue here for the streaming-reliability scope.

---

## 5. Reconnect ordering — replay vs. live

### 5.1 Reconnect state machine

#### Triggers
- WS `onclose` → `Terminal.tsx:197-209`:
  ```ts
  ws.onclose = (event) => {
    onConnectionChangeRef.current?.("disconnected");
    wsRef.current = null;
    if (unmountedRef.current) return;
    if (event.code === 4401 || event.code === 4404) return;
    isReconnectRef.current = true;          // <-- mark
    scheduleReconnect();
  };
  ```
- Token-fetch failure (HTTP) — `Terminal.tsx:122-133` → `scheduleReconnect()`.
- Try/catch network error in `connectWs` — `Terminal.tsx:222-226`:
  ```ts
  } catch {
    if (unmountedRef.current) return;
    isReconnectRef.current = true;
    scheduleReconnect();
  }
  ```

#### Backoff
- `Terminal.tsx:85-94`:
  ```ts
  const scheduleReconnect = useCallback(() => {
    if (unmountedRef.current) return;
    setReconnecting(true);
    const attempt = reconnectAttemptRef.current++;
    const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
    reconnectTimerRef.current = setTimeout(() => {
      connectWs();
    }, delay);
  }, []);
  ```
  Exponential, capped at 10 s. Counter resets in `ws.onopen` (`Terminal.tsx:149`).

#### Connection (persistent only)
- `Terminal.tsx:98-230`. The crucial section after the new socket opens — `Terminal.tsx:148-167`:
  ```ts
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
  ```

### 5.2 Ordering analysis

Sequence on reconnect (persistent terminal):

1. WS `onclose` fires → `isReconnectRef.current = true` → `scheduleReconnect`.
2. After backoff, `connectWs` runs:
   - Closes any leftover WS (`Terminal.tsx:108-117`).
   - Fetches token (`Terminal.tsx:119`).
   - Opens new WS (`Terminal.tsx:145-146`).
3. WS `onopen` fires:
   - `term.clear()` is called **synchronously** if `isReconnectRef.current` is true (`Terminal.tsx:155`).
   - `ws.send({type:"resize", …})` is called next (`Terminal.tsx:160-166`).
4. The server side (`terminal-manager.js:505-512`) sends the entire `session.buffer` as a single `output` frame **immediately upon attach**, before any new `input`/`resize` from the client is processed. From the wire's perspective, the very first frame the client receives back is:
   ```
   { type: "output", data: <full replay buffer string> }
   ```
   followed by live `output` frames as PTY produces new bytes.
5. `ws.onmessage` handler receives the replay frame → `term.write(replayString)`.
6. Subsequent live `output` frames arrive → `term.write(liveChunk)` for each.

#### Reset/clear status

- `term.clear()` is called on reconnect (`Terminal.tsx:155`). Per xterm.js docs, `clear()` clears the **viewport** but preserves the active cursor row content; it scrolls the prompt to the top. It does **not** reset parser state or alt-screen mode. `term.reset()` (which would do a full hard reset including cursor pos, parser state, modes, scrollback) is **not** called.
- `term.reset()` is **never** called anywhere in the codebase (grep shows zero occurrences).

#### Barrier between replay and live

- **None.** No protocol-level "end-of-replay" sentinel exists. The server emits the replay buffer in one `output` frame, and the next `output` frames are live. The client cannot distinguish them. There is no callback or promise awaited between the replay write and the live writes.
- Because everything goes through `ws.onmessage` → `term.write`, the **order on the wire** equals the **order of `term.write` calls**. xterm.js's `WriteBuffer` will then drain them in order. So *within a single connection*, replay is parsed before live, by construction.

#### Race condition: in-flight bytes from prior connection

The risk is across the close/reopen boundary:
- The old WS is closed at `Terminal.tsx:108-117` only inside the next `connectWs` call. If a stale `output` message had been queued by the browser's WS layer **before close**, it could in theory still fire through `oldWs.onmessage` — but the code defensively does `oldWs.onmessage = null;` (`Terminal.tsx:111`). So stale frames cannot reach `term.write` after the new `connectWs` starts.
- However: the original `ws.onclose` set `isReconnectRef = true` and called `scheduleReconnect` (`Terminal.tsx:206-208`). During the backoff window (1–10 s), if any code path called `connectWs` again, the old WS would still be in `wsRef.current` until the next `connectWs` execution clears it. There is `isConnectingRef` (`Terminal.tsx:103-104`) to prevent concurrent `connectWs` invocations. So serialization is OK.

#### Ephemeral terminal reconnect

- `EphemeralTerminal.tsx` has **no reconnect logic at all**. There is no `onclose` handler. Once the WS dies, the terminal is dead.

### 5.3 Replay arrives BEFORE live — confirmed

Order (per connection):

```
new WebSocket → onopen → term.clear() + send(resize)
              → onmessage(replay frame) → term.write(replay)
              → onmessage(live frame) → term.write(live)
              → onmessage(live frame) → term.write(live)
              ...
```

Replay writes happen before live writes. The client does not interleave them at the protocol level.

The ambiguity is at the **xterm.js parser level**: `term.clear()` runs first (synchronously), then `term.write(replayString)` is queued; if the replay string is large (server caps at 2 MB — `terminal-manager.js:296`), it can take many event-loop turns to parse. During those turns, live `output` frames may arrive and get queued behind it in the same `WriteBuffer`. They will still parse in order, but the user sees the screen "scroll through" the replay before live content shows up. There is no UI hint distinguishing the two.

---

## 6. IME / composition / paste

### 6.1 `compositionstart` / `compositionupdate` / `compositionend`

Grep result:
```
(no matches)
```

**No application-level composition handlers exist.** xterm.js v6 has built-in IME support via its `<textarea>` proxy and `helpers/InputHandler` composition logic. The application does not interfere with or augment that. This means:
- IME composition uses xterm.js's default behavior (commit on `compositionend` → emit through `onData`).
- Any composition-related ordering issues would be inside xterm.js itself, not the application.

### 6.2 Paste — persistent terminal

`Terminal.tsx:336-359`:

```ts
const handlePaste = (e: ClipboardEvent) => {
  if (!e.clipboardData) return;

  const items = e.clipboardData.items;
  for (let i = 0; i < items.length; i++) {
    if (items[i].type.startsWith("image/")) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const blob = items[i].getAsFile();
      if (!blob) return;
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(",")[1];
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "image", data: base64 }));
        }
      };
      reader.readAsDataURL(blob);
      return;
    }
  }
};
terminalRef.current.addEventListener("paste", handlePaste, true);
```

- Listener is in **capture phase** (`true` arg, `Terminal.tsx:359`). It runs before xterm.js's own paste handler.
- For image MIME items: prevent default, prevent xterm seeing it, send as `image` WS frame.
- For text/non-image: handler returns without action → falls through to xterm's default paste path (which goes to `onData`).
- `wsRef` is read at fire time (not captured at setup) so paste survives reconnect.

### 6.3 Paste — ephemeral terminal

No custom `paste` handler at all. xterm.js defaults apply.

### 6.4 `attachCustomKeyEventHandler` — persistent terminal

`Terminal.tsx:299-333`:

```ts
term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
  if (e.type !== "keydown") return true;

  if (
    ((e.ctrlKey || e.metaKey) && e.code === "KeyV") ||
    (e.ctrlKey && e.shiftKey && e.code === "KeyV")
  ) {
    return false;   // let browser handle paste
  }

  if (!isMac) {
    if (e.ctrlKey && e.shiftKey && e.code === "KeyC") {
      const sel = term.getSelection();
      if (sel) {
        e.preventDefault();
        copyText(sel);
        term.clearSelection();
      }
      return false;
    }

    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === "KeyC") {
      const sel = term.getSelection();
      if (sel) {
        e.preventDefault();
        copyText(sel);
        term.clearSelection();
        return false;
      }
      return true;     // no selection → pass through to PTY (Ctrl+C signal)
    }
  }

  return true;
});
```

- Returning `false` from this handler tells xterm to **not** process the key → caller (browser) handles it.
- Ctrl/Cmd+V → returns false so the browser fires `paste` event (caught by Site 6.2).
- Linux only: Ctrl+Shift+C → copy if selection exists.
- Linux only: Ctrl+C with selection → copy. Ctrl+C with no selection → pass through (so the PTY receives SIGINT).
- All other keys → return true → xterm processes them normally → `onData` fires.

### 6.5 `attachCustomKeyEventHandler` — ephemeral

Not called. Ephemeral has no key-event interception.

### 6.6 Custom escape filter on `onData` — persistent

`Terminal.tsx:213-221`:

```ts
dataDisposableRef.current = term.onData((data) => {
  // Filter terminal query responses (DA1, DA2, DA3, CPR) —
  // xterm.js auto-replies to tmux capability probes; echoing them
  // back into the PTY produces visible garbage like [?1;2c
  if (/^\x1b\[[\?>=]/.test(data) || /^\x1b\[\d+;\d+R$/.test(data)) return;
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "input", data }));
  }
});
```

- Filters Device-Attribute and Cursor-Position-Report responses that xterm auto-emits when tmux probes the terminal. Without this filter, those responses would be echoed back into tmux as `input`, surfacing as visible garbage.
- The `ws` variable is **closed-over from the connectWs closure** (`Terminal.tsx:145`). If `connectWs` runs again on reconnect, a **new** `dataDisposableRef.current` is registered (`Terminal.tsx:212-213`) bound to the new `ws`. The old listener is disposed first via `dataDisposableRef.current?.dispose()`.

### 6.7 `onData` — ephemeral

`EphemeralTerminal.tsx:61-65`:

```ts
term.onData((data) => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "input", data }));
  }
});
```

No DA/CPR filter. No dispose-and-reattach pattern (irrelevant since no reconnect).

---

## 7. Hypothesis checklist

### H1. xterm.js `write()` not awaited (high throughput → out-of-order)

**Verdict: PARTIALLY ACCEPTED.**

Evidence:
- All 8 `term.write` call sites pass no callback (Sites A–H, §2.3).
- Within a single tick, sequential `term.write` calls are queued in xterm's `WriteBuffer` and parsed in arrival order — JS's single-threaded event loop guarantees ordering of synchronous queue inserts.
- BUT: the application makes no use of the second-arg callback to know **when** parsing has completed. This matters for two adjacent operations the code does perform without waiting for parser completion:
  - `term.clear()` immediately followed by writing replay (`Terminal.tsx:155` then queued message at `Terminal.tsx:174`). `clear()` is synchronous on the buffer but rendering is async. No ordering bug from this directly.
  - `fitAddon.fit()` triggered while writes are queued (`Terminal.tsx:363`). xterm's resize during in-flight parsing is documented to cause re-layout of in-flight cells. The application does not wait for `WriteBuffer` to drain before calling `fit()`.

So: out-of-order between successive `write()` calls is **not** plausible (single-threaded queue). Out-of-order between `write()` parsing and `fit()`/clear/resize side effects **is** plausible because none of those wait on `write` callbacks.

### H2. Reconnect race: late replay flush interleaves with live stream

**Verdict: REJECTED at the wire/protocol level. ACCEPTED at the screen-state level.**

Evidence:
- The new WS opens after the old one is fully closed (`Terminal.tsx:108-117`) and `oldWs.onmessage = null` (`Terminal.tsx:111`) prevents stale frames.
- On the new connection, server sends replay in one `output` frame **before** any live `output` (`terminal-manager.js:505-512`). Order on the wire is replay → live.
- `term.clear()` runs synchronously **before** any new `onmessage` can fire on the new socket (it's inside `onopen`, single event-loop step).
- BUT: `term.clear()` does not reset the parser state or the alternate screen mode. If the old session had been in alt-screen (e.g., `vim`), the cursor position and cell attributes may carry over. The replay buffer relies on `terminal-manager.js:31-32` server-side scrubbing of alt-screen sequences ("Strip alternate screen sequences"), so in normal flow the replay should put the screen back into a sensible state. If the scrubber misses an edge case (CSI, OSC fragments), the live stream that follows lands on a corrupted parser state.

### H3. FitAddon called per-keystroke during resize → mid-stream re-renders

**Verdict: ACCEPTED.**

Evidence:
- `ResizeObserver` callback (`Terminal.tsx:362-375`) calls `fitAddon.fit()` synchronously with no debounce.
- During interactive resize (window drag, keyboard show/hide), the observer fires per layout pass — potentially many times per second.
- Each fit is followed immediately by a `resize` WS frame to the server, which causes server-side `pty.resize` (`terminal-manager.js:526-530`), which makes tmux redraw the pane (a burst of `output` bytes back to the client). Those bytes land in `term.write` while the client may still be settling its own resize.
- This is **not per-keystroke** in the typing sense — `term.onData` does not call `fit()`. But for any sequence of layout changes (mobile keyboard toggle, fullscreen toggle, drawer animations) the per-frame fit-storm matches the hypothesis.
- The `fullscreen` `useEffect` (`Terminal.tsx:57-82`) DOES use double-rAF before calling `fit()`, which is a one-shot defer. That path is not the offender — the `ResizeObserver` is.

### H4. Replay applied without `term.reset()` → corrupts current screen state

**Verdict: ACCEPTED.**

Evidence:
- `term.clear()` called on reconnect (`Terminal.tsx:155`), `term.reset()` is **never** called (`grep -rn "term\.\(reset\|clear\|refresh\|resize\)"` confirms zero `term.reset` matches).
- `clear()` only clears the viewport rows; it does not reset:
  - Parser state (CSI/OSC partial buffer)
  - SGR (color/style) attribute
  - Cursor mode (DECSC/DECRC)
  - Alt-screen flag
  - Application-cursor-keys mode (DECCKM)
  - Modes set by tmux on prior attach
- On reconnect the new server attach issues a fresh capture of the whole pane via `tmuxCapture(sessionId, -1)` (`terminal-manager.js:489`) which produces a complete redraw that should, in practice, normalize the screen — but the parser state hangover from an interrupted CSI on the previous connection is not erased by `clear()`. If the connection died mid-escape sequence (a real possibility on flaky networks), the next bytes through the parser will still be interpreted in the old partial state.

---

## 8. Decisions closed

### 8.1 Are `write()` calls chained via callback?

**No.** All 8 sites are fire-and-forget. xterm's WriteBuffer preserves arrival order intra-process, but the application takes no action contingent on parse completion. See §2.3.

### 8.2 Is FitAddon debounced?

**No.** `ResizeObserver`-driven `fit()` (`Terminal.tsx:363`, `EphemeralTerminal.tsx:68`) runs unthrottled on every observer tick. The two non-observer fits (initial mount `Terminal.tsx:254`, fullscreen toggle `Terminal.tsx:64`) use double-`requestAnimationFrame` deferral but that is a one-shot defer, not a debounce. See §4.

### 8.3 Is replay applied before or after live stream resumes?

**Before.** Server emits the entire replay buffer in one `output` JSON frame immediately on socket attach (`terminal-manager.js:505-512`), before any live PTY bytes can be sent. Client `term.clear()` runs first (`Terminal.tsx:155`), then replay write, then live writes — single-tick FIFO order. There is no end-of-replay sentinel and no application-level ack/barrier between replay and live. See §5.

### 8.4 What addons are loaded?

| Addon | Loaded? | File:line |
|-------|---------|-----------|
| `FitAddon` (`@xterm/addon-fit` 0.11.0) | Yes (both terminals) | `Terminal.tsx:248`, `EphemeralTerminal.tsx:38` |
| `WebLinksAddon` (`@xterm/addon-web-links` 0.12.0) | Yes (persistent only) | `Terminal.tsx:249` |
| `SerializeAddon` | NO (not installed) | — |
| `Unicode11Addon` | NO (not installed) | — |
| `WebglAddon` | NO (not installed) | — |
| `CanvasAddon` | NO (not installed) | — |
| `SearchAddon`, `AttachAddon`, `LigaturesAddon`, `ImageAddon` | NO (not installed) | — |

Only `FitAddon` and `WebLinksAddon` exist on disk under `node_modules/@xterm/`. Default DOM renderer is in use (no GL/Canvas opt-in).

---

## 9. Other findings (in scope but not directly listed)

### 9.1 React StrictMode double-init guard

`Terminal.tsx:407-421`:
```ts
useEffect(() => {
  if (initRef.current) return;
  initRef.current = true;
  unmountedRef.current = false;
  let cleanup: (() => void) | undefined;
  initTerminal().then((fn) => { cleanup = fn; });
  return () => {
    // Don't reset initRef — prevents double init in StrictMode
    cleanup?.();
  };
}, [initTerminal]);
```

`initRef` is never reset → in dev StrictMode the first cleanup fires, sets `unmountedRef = true` (`Terminal.tsx:387`), then the second mount runs `initTerminal` but bails out at `Terminal.tsx:234` because… actually wait, `unmountedRef` is set inside `cleanup` (Terminal.tsx:387) but reset at Terminal.tsx:410 to false again on next effect run. The guard `if (initRef.current) return` at line 408 prevents the second init entirely in StrictMode — but **also** means if the parent ever truly unmounts and remounts the component (e.g., session switch), the terminal would not re-initialize. This depends on whether the parent wraps `<Terminal>` in `key={sessionId}`. Out of scope to verify here, but flagged as fragile.

### 9.2 `dataDisposableRef` reattach on reconnect

`Terminal.tsx:212-221` disposes the old `onData` and reattaches a new one bound to the new `ws` on every successful `connectWs` run. This is correct — without it, keystrokes after reconnect would still go to a stale closure. The pattern works; just noting it's load-bearing.

### 9.3 `onWriteParsed` for scroll publishing

`Terminal.tsx:270-272`:
```ts
const writeDisposable = term.onWriteParsed(() => {
  requestAnimationFrame(() => publishScroll());
});
```

Fires after **every** write parse → schedules a rAF → publishes scroll. This is one rAF per parsed write batch. Under high write throughput this generates many `setState` calls into `TerminalScrollContext` (`TerminalScrollContext.tsx:34-36`), which causes React re-renders of `<CursorOverlay>` and any other context consumer. **Not** a bug for the streaming-reliability scope, but it is a cost paid per write.

### 9.4 Initial `resize` send timing

`Terminal.tsx:159-167` sends `resize` from inside `ws.onopen`. The ordering on a brand-new connection is:
1. Client `onopen` → `term.clear()` (if reconnect) → `send(resize)`.
2. Server-side handshake at `terminal-manager.js`: when the WS is accepted, the server immediately calls `attachToSession` (need to verify path but the resize message handling at `terminal-manager.js:526-530` is on the same `ws.on("message")` listener that is set up at `terminal-manager.js:514`).
3. The replay `ws.send(...buffer)` at `terminal-manager.js:507` runs BEFORE the `ws.on("message")` listener is attached at `terminal-manager.js:514`. So the server pushes the replay first, then begins listening for client messages, then receives the client's `resize` frame.

This means: **the client's initial `resize` does not affect the dimensions of the replay redraw.** The replay was pre-captured at whatever size the server last knew about. If the client's current viewport is larger than the server's last known size, the replay will fill only part of the viewport; if smaller, the replay will overflow. The subsequent `pty.resize` triggers tmux to redraw the pane to the new size, but those bytes arrive **after** the replay, producing the user-visible "flash of stale buffer → redraw" that is consistent with the streaming-reliability bug class.

### 9.5 No `await` on ws-token fetch race

`Terminal.tsx:119-140`. If `unmountedRef.current` becomes true between the `await` of `tokenRes` and the `await` of `tokenRes.json()`, the early return at `Terminal.tsx:141` catches it. But `wsRef.current = ws` is set **after** the async gap — if a parallel connectWs attempted to mutate `wsRef.current` (gated by `isConnectingRef`) it could not run concurrently. So this is safe, just noted for completeness.

### 9.6 Disposable leakage on error path

If `connectWs` throws between creating the new WebSocket and reaching `term.onData` registration (`Terminal.tsx:213`), the `dataDisposableRef` is not refreshed but the old WS is closed. The old `dataDisposableRef.current` is bound to the **prior** `ws` — its `onData` callback would `ws.send` to a closed socket, falling into `if (ws.readyState === WebSocket.OPEN)` false, silently dropping the keystroke. Not a correctness bug, but keystrokes during reconnect-failure windows will silently disappear without any visual indication.

### 9.7 No ping/pong heartbeat in client

`Terminal.tsx` and `EphemeralTerminal.tsx` rely entirely on the browser's WebSocket implementation for ping/pong. There is no application-level heartbeat. If a stateful proxy (nginx, ALB) drops the connection after idle, the client first learns about it via `onclose` — by which point any in-flight bytes are lost. Out of scope for the client-render audit but relevant to "biggest risk" framing.

---

## 10. Risk inventory (ranked, client-side only)

1. **Unthrottled `ResizeObserver` → fit-storm → resize-burst echo.** During mobile keyboard show/hide or window drag, dozens of `fit()` + `resize` WS sends fire in <1 s, each triggering a tmux pane redraw that interleaves with whatever live output was streaming. This is the most reproducible client-side amplifier of out-of-sync rendering. (`Terminal.tsx:362-380`, `EphemeralTerminal.tsx:67-72`.)
2. **No barrier between replay write and live writes.** `term.clear()` then `term.write(replay)` then live `term.write(...)` all queue in one buffer with no flush boundary. If replay is a 2 MB string, the parser spends many event-loop turns on it; live frames pile up behind. The user sees stale screen → fast-forward redraw → live, which can manifest as "duplication" if the prior screen state was not fully cleared first. (`Terminal.tsx:155, 174`.)
3. **`term.clear()` instead of `term.reset()` on reconnect.** Parser state, SGR, mode flags survive reconnect. If the prior connection died mid-escape, the next replay byte is interpreted with stale state. (`Terminal.tsx:155`.)
4. **JSON.parse failure silently writes raw frame.** Sites E and H pipe any non-JSON frame straight into `term.write` as a string. Today the server only sends JSON, so dormant — but a future change (or a binary frame from a misbehaving proxy) immediately corrupts the screen. (`Terminal.tsx:193`, `EphemeralTerminal.tsx:57`.)
5. **DOM renderer.** No `WebglAddon`/`CanvasAddon` → DOM-only render path. Drops frames under heavy output, can fall behind the WriteBuffer growth.
6. **Default `binaryType = "blob"`.** Not currently triggered, but implies any future binary protocol switch will break parsing immediately.
7. **`onData` filter regex** `/^\x1b\[[\?>=]/` (`Terminal.tsx:217`) catches DA1/DA2/DA3/CPR responses by structural prefix. False positives are possible if a user deliberately types `\x1b[?…` (rare but not impossible); false negatives if a CPR response has unusual whitespace. Low risk.

---

## 11. Cross-references for other agents

- For the wire protocol the client expects, see `terminal-manager.js:280-300` (`pty.onData` → `JSON.stringify({type:"output", data})`) and `terminal-manager.js:505-512` (replay flush on attach).
- For the server-side resize handler the client triggers, see `terminal-manager.js:526-530`.
- For the server-side image clipboard bridge, see `terminal-manager.js:531-573`.
- For the WS handshake routing on the server, see `server.js:155-220`.
- For the sole consumer of `TerminalScrollContext`, see `CursorOverlay.tsx:15`.

---

## 12. Out of scope (deliberately not investigated)

- Server-side WS framing, backpressure (`bufferedAmount`), broadcast fan-out — covered by `scanner-ws-transport`.
- Server-side tmux pipe-pane vs control-mode, replay slicing, UTF-8 boundary handling — covered by `scanner-pty-pipeline`.
- Mobile-specific keyboard/IME alternatives, `<input>` proxy — covered by `scanner-terminal-internals` for the mobile workstream.
- Theme contents (`theme-config.ts`) — irrelevant for streaming reliability.
