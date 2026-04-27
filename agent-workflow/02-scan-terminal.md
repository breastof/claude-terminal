# 02 — Terminal Internals Scan (mobile-input perspective)

> Scope: xterm.js wrappers, keystroke ingress, WS message contract, resize plumbing, mobile-readiness gaps, and recommended splice-points for a `MobileTerminalInput.tsx`.
> SCAN ONLY — no edits, no proposed solutions beyond pointing out where to splice.
> Sister artifact (tmux-stream scanner) covers streaming reliability; this one covers mobile-input readiness.

---

## 0. File inventory

Code paths involved in this scan:

| File | Lines | Role |
|------|-------|------|
| `/root/projects/claude-terminal/src/components/Terminal.tsx` | 443 | Primary xterm.js wrapper, mounted in dashboard via `next/dynamic`. |
| `/root/projects/claude-terminal/src/components/EphemeralTerminal.tsx` | 116 | Smaller embedded xterm for the provider-wizard auth flow (`/login`, OAuth bridge). |
| `/root/projects/claude-terminal/src/app/dashboard/page.tsx` | 532 | Mounts `<Terminal>` as `dynamic(..., { ssr: false })`. Holds `fullscreen` state. |
| `/root/projects/claude-terminal/src/app/layout.tsx` | 47 | Root HTML — **no `<meta name="viewport">` is declared here** (relies on Next defaults). |
| `/root/projects/claude-terminal/src/app/globals.css` | 374 | Has `.xterm` padding rule and viewport scrollbar rules; **no `touch-action`, no safe-area inset, no `dvh`/`svh`**. |
| `/root/projects/claude-terminal/server.js` | 312 | WS upgrade router; routes `/api/terminal` upgrades to `terminalManager.attachToSession(...)` or `attachToEphemeralSession(...)`. |
| `/root/projects/claude-terminal/terminal-manager.js` | 945 | Server-side WS message dispatcher (input/resize/image). |
| `/root/projects/claude-terminal/src/components/presence/CursorOverlay.tsx` | (presence) | Imports nothing from xterm but checks `target.closest(".xterm")` at line 91 — only direct DOM dependency on xterm CSS class outside the wrapper. |

Grep confirms only **two** files import from `@xterm/*` (`Terminal.tsx`, `EphemeralTerminal.tsx`). All other references are CSS class hits or string mentions.

```
src/components/Terminal.tsx:4    import { Terminal as XTerm } from "@xterm/xterm";
src/components/Terminal.tsx:5    import { FitAddon } from "@xterm/addon-fit";
src/components/Terminal.tsx:6    import { WebLinksAddon } from "@xterm/addon-web-links";
src/components/Terminal.tsx:7    import "@xterm/xterm/css/xterm.css";
src/components/EphemeralTerminal.tsx:4 import { Terminal as XTerm } from "@xterm/xterm";
src/components/EphemeralTerminal.tsx:5 import { FitAddon } from "@xterm/addon-fit";
src/components/EphemeralTerminal.tsx:6 import "@xterm/xterm/css/xterm.css";
```

---

## 1. Package versions (mobile-relevant)

From `/root/projects/claude-terminal/package.json:43-45` and `node_modules/@xterm/*/package.json`:

| Package | package.json range | Installed |
|---------|--------------------|-----------|
| `@xterm/xterm` | `^6.0.0` | **6.0.0** |
| `@xterm/addon-fit` | `^0.11.0` | **0.11.0** |
| `@xterm/addon-web-links` | `^0.12.0` | **0.12.0** |

xterm.js 6 implications:
- Default renderer = **DOM renderer** (no `addon-canvas`/`addon-webgl` are loaded). Confirmed by absence of any other `@xterm/addon-*` in `package.json`.
- `xterm/css/xterm.css` is mandatory (loaded line 7 of `Terminal.tsx`, line 6 of `EphemeralTerminal.tsx`). It styles the helper textarea positioned off-screen.
- `term.textarea: HTMLTextAreaElement | undefined` is a public, supported field in v6 — see `node_modules/@xterm/xterm/typings/xterm.d.ts:822`.
- `term.input(data, wasUserInput?)` is a public method that pushes data into the input chain and triggers `onData` — see `xterm.d.ts:1015-1025`.
- `term.paste(data)` exists for bracketed-paste-aware writes — see `xterm.d.ts:1270-1275`.
- No mention in `package.json` of `@xterm/addon-unicode11`, `addon-image`, `addon-search`, `addon-ligatures`, `addon-serialize` — the surface is minimal.

---

## 2. xterm config (full options + addons + key handlers)

### 2.1 `Terminal.tsx` (primary)

`new XTerm({...})` — `Terminal.tsx:236-243`:

```tsx
const term = new XTerm({
  cursorBlink: true,
  fontSize: 14,
  fontFamily:
    "'Geist Mono', 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
  theme: themeConfigs[themeRef.current].terminal,
  scrollback: 5000,
});
```

Five options total. **Not set** (= xterm defaults apply):
- `rows`, `cols` — left to FitAddon. Initial render before first `fit()` is at xterm defaults (80×24).
- `convertEol`, `cursorStyle`, `cursorWidth`, `disableStdin`.
- `fastScrollSensitivity`, `fastScrollModifier`.
- `screenReaderMode` — **left at default `false`**, which means the helper textarea is sized 1×1px and visually-off-screen via `xterm.css`. (Mobile soft keyboards can still target it on focus, but the user has zero affordance to focus it — see §5.)
- `allowProposedApi` — false. (Means proposed APIs like `addon-image` would fail; non-issue for current code.)
- `macOptionIsMeta`, `macOptionClickForcesSelection`.
- `windowOptions`, `windowsMode`, `wordSeparator`.
- `allowTransparency`, `drawBoldTextInBrightColors`.
- `letterSpacing`, `lineHeight`.
- `tabStopWidth`.
- `minimumContrastRatio`.
- `customGlyphs`, `customWglGlyphs`, `documentOverride`.

Theme runtime mutation — `Terminal.tsx:50-54`:

```tsx
useEffect(() => {
  if (xtermRef.current) {
    xtermRef.current.options.theme = themeConfigs[theme].terminal;
  }
}, [theme]);
```

#### Addons loaded — `Terminal.tsx:245-249`

```tsx
const fitAddon = new FitAddon();
const webLinksAddon = new WebLinksAddon();

term.loadAddon(fitAddon);
term.loadAddon(webLinksAddon);
term.open(terminalRef.current);
```

Two addons:
- **FitAddon** — recomputes `cols`/`rows` to fit the container. Held in `fitAddonRef`. See §4.
- **WebLinksAddon** — turns `http(s)://` strings in the buffer into clickable spans. Default options (no `handler` override). On mobile it fires on **tap** (synthesized click); no special touch wiring.

No other addons. In particular **no** `WebglAddon`, `CanvasAddon`, `Unicode11Addon`, `LigaturesAddon`, `SearchAddon`, `SerializeAddon`, `ImageAddon`, `ClipboardAddon`.

#### `attachCustomKeyEventHandler` — `Terminal.tsx:299-333`

```tsx
term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
  if (e.type !== "keydown") return true;

  // Block xterm's default "Ctrl+V/Cmd+V/Ctrl+Shift+V" so the
  // browser native paste pipeline runs (handled below).
  if (
    ((e.ctrlKey || e.metaKey) && e.code === "KeyV") ||
    (e.ctrlKey && e.shiftKey && e.code === "KeyV")
  ) {
    return false;
  }

  if (!isMac) {
    // Linux/Win: Ctrl+Shift+C copies selection (and stops xterm
    // from sending Ctrl+C SIGINT in that case).
    if (e.ctrlKey && e.shiftKey && e.code === "KeyC") {
      const sel = term.getSelection();
      if (sel) {
        e.preventDefault();
        copyText(sel);
        term.clearSelection();
      }
      return false;
    }

    // Linux/Win: bare Ctrl+C copies if there's a selection,
    // otherwise falls through to xterm so it sends ^C to PTY.
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === "KeyC") {
      const sel = term.getSelection();
      if (sel) {
        e.preventDefault();
        copyText(sel);
        term.clearSelection();
        return false;
      }
      return true;
    }
  }

  return true;
});
```

Notes for mobile:
- Handler explicitly only runs on `keydown`. Soft-keyboard input on Android Chrome frequently arrives as `compositionstart`/`compositionupdate`/`compositionend` and `input` events on the textarea — those bypass this handler entirely.
- `e.code === "KeyC"` / `KeyV` use the physical-key code, which mobile keyboards do **not** reliably populate (most soft keyboards leave `e.code === ""` and `e.key === "Process"` or `"Unidentified"`).
- Returning `true` allows xterm's default keymap to translate the event into bytes; returning `false` prevents that. There is **no branch for touch, no branch for IME composition**.

#### `copyText` helper — `Terminal.tsx:284-297`

Async `navigator.clipboard.writeText` first, with a hidden `<textarea>` + `document.execCommand("copy")` fallback. The fallback textarea is created and removed inside the same event tick — no exposure to mobile.

### 2.2 `EphemeralTerminal.tsx` (provider-wizard embed)

`new XTerm({...})` — `EphemeralTerminal.tsx:28-35`:

```tsx
const term = new XTerm({
  cursorBlink: true,
  fontSize: 13,
  fontFamily: "'Geist Mono', 'JetBrains Mono', 'Fira Code', monospace",
  theme: themeConfigs[themeRef.current].terminal,
  scrollback: 1000,
  rows: 10,
});
```

Six options. Differences from primary:
- `fontSize: 13` (vs 14).
- `scrollback: 1000` (vs 5000).
- `rows: 10` is hard-coded — FitAddon is loaded but the container is fixed-height (`200px`, set via inline style on the wrapper `<div>` at line 112).

Addons — `EphemeralTerminal.tsx:37-39`:

```tsx
const fitAddon = new FitAddon();
term.loadAddon(fitAddon);
term.open(containerRef.current);
```

Only **FitAddon**. No WebLinksAddon. No `attachCustomKeyEventHandler` whatsoever — clipboard, copy/paste, all default xterm keymap.

This is meaningful: if the mobile-input proxy is built generically against the `Terminal as XTerm` ref, `EphemeralTerminal` benefits for free. If it's built into `Terminal.tsx` as bespoke React state, ephemeral stays mobile-broken.

---

## 3. Keystroke ingress — every byte path into the PTY

### 3.1 `term.onData` — primary keystroke pipe

`Terminal.tsx:212-221`:

```tsx
// Dispose old onData listener and register new one
dataDisposableRef.current?.dispose();
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

Properties:
- Re-registered every `connectWs` (so the closure binds to the *current* `ws`). Old listener is disposed via `dataDisposableRef.current?.dispose()`.
- Data string is the byte sequence xterm produced from a key event (e.g. `"a"`, `"\x03"` for Ctrl-C, `"\x1bOA"` for Up arrow under DECCKM, `"\r"` for Enter, etc.). It is **already PTY-ready**; the wrapper does not transform it.
- The DA/CPR regex filter (`/^\x1b\[[\?>=]/` and `/^\x1b\[\d+;\d+R$/`) is a workaround for xterm's auto-reply to tmux capability probes — those replies arrive on `onData` indistinguishably from real keystrokes. Anything spliced *upstream* of this filter (i.e. anything calling `term.input(...)`) will pass through it unscathed; anything spliced *downstream* (i.e. directly `ws.send` from a mobile input bypassing xterm) **must not** add escape sequences that match the filter or they'll be swallowed.
- `EphemeralTerminal.tsx:61-65` has the equivalent simpler version without the filter:

```tsx
term.onData((data) => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "input", data }));
  }
});
```

### 3.2 `term.onBinary` — **NOT used**

Grep confirms zero hits in `src/`. xterm fires `onBinary` only for non-UTF-8 mouse-tracking reports (SGR-pixels), which the PTY would receive as raw binary. The current wrapper drops these on the floor. Practical impact: mouse tracking inside `vim`/`tmux` over PTY does not get the legacy reports. Not a mobile concern, but flag for completeness.

### 3.3 `term.onKey` — **NOT used**

`onKey` would expose `{ key: string, domEvent: KeyboardEvent }` for every key xterm processed. The wrapper does not subscribe.

### 3.4 `attachCustomKeyEventHandler` — see §2.1

Returns boolean; **does not produce bytes** by itself. Side effects only: copy-on-Ctrl+Shift+C, clipboard writes via `copyText`. No bytes ever flow through this path; it's a gate that decides whether xterm's default keymap runs.

### 3.5 Raw DOM listeners on the container

Only **one** listener is attached at the wrapper level — `Terminal.tsx:336-359`:

```tsx
// Intercept paste event — uses wsRef so it works after reconnect
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

This is **the only DOM event listener** added to the terminal container directly. It runs in capture phase. Text paste is **not** intercepted — it falls through to xterm which handles it via its own `paste` listener on `term.textarea` (and emits the pasted bytes through `onData`, optionally wrapped in `\x1b[200~ ... \x1b[201~` if the application enabled bracketed paste mode).

There is no `keydown`/`keyup`/`keypress`/`input`/`compositionstart` listener attached at the wrapper level. xterm's own helper textarea owns those events.

### 3.6 Image upload (out of band)

For images pasted via clipboard, the wrapper sends `{ type: "image", data: <base64> }` over WS — `Terminal.tsx:351-352`. Server-side at `terminal-manager.js:531-573` this base64 → `xclip -selection clipboard -t image/png` → then writes `\x16` (Ctrl-V) to the PTY. This is not a keystroke pipe but it is a *byte producer for the PTY* and worth listing:

| Source | Path | PTY bytes | WS message |
|--------|------|-----------|------------|
| User typing into xterm textarea | `term.onData` (`Terminal.tsx:213`) | xterm-encoded keystroke string | `{type:"input", data:<string>}` |
| Image paste | `handlePaste` (`Terminal.tsx:336`) | server emits `\x16` (Ctrl-V) after `xclip` ownership | `{type:"image", data:<base64>}` |
| Resize | `handleResize` / fullscreen effect | none (PTY-internal `winsize`, not bytes) | `{type:"resize", cols, rows}` |

That's the complete inventory. There is no third byte-producer.

---

## 4. WebSocket keystroke message format (client + server)

### 4.1 Client → Server (only three message types)

| `type` | Payload shape | Sent from | When |
|--------|---------------|-----------|------|
| `"input"` | `{ type: "input", data: string }` | `Terminal.tsx:219`, `EphemeralTerminal.tsx:63` | Every `term.onData` emission (after DA/CPR filter). |
| `"resize"` | `{ type: "resize", cols: number, rows: number }` | `Terminal.tsx:67-74` (fullscreen effect), `Terminal.tsx:160-166` (on open), `Terminal.tsx:362-373` (`handleResize`); `EphemeralTerminal.tsx:67-72` | On WS open, on container ResizeObserver fire, on fullscreen toggle. |
| `"image"` | `{ type: "image", data: string }` (`data` is base64 of the raw image bytes, no data URL prefix) | `Terminal.tsx:351` | On `paste` event when first clipboard item is `image/*`. |

All three are stringified JSON sent via `ws.send(JSON.stringify(...))`. There is no binary frame, no length-prefix, no protocol-version field, no client→server message ID.

### 4.2 Server-side dispatcher

Persistent sessions — `terminal-manager.js:514-578`:

```js
ws.on("message", (rawMessage) => {
  try {
    const message = JSON.parse(rawMessage.toString());
    switch (message.type) {
      case "input":
        if (!session.exited && session.pty) {
          session.echoUntil = Date.now() + 600;
          session.waiting = false;
          session.lastActivityAt = new Date();
          session.pty.write(message.data);
        }
        break;
      case "resize":
        if (!session.exited && session.pty && message.cols && message.rows) {
          session.pty.resize(message.cols, message.rows);
        }
        break;
      case "image": {
        // ... base64 → xclip -t image/png → write '\x16' to PTY (Ctrl-V) ...
      }
    }
  } catch {
    // Ignore malformed messages
  }
});
```

Ephemeral sessions — `terminal-manager.js:781-793`:

```js
ws.on("message", (rawMessage) => {
  try {
    const message = JSON.parse(rawMessage.toString());
    if (message.type === "input" && !session.exited) {
      session.echoUntil = Date.now() + 600;
      session.waiting = false;
      session.lastActivityAt = new Date();
      session.pty.write(message.data);
    } else if (message.type === "resize" && !session.exited && message.cols && message.rows) {
      session.pty.resize(message.cols, message.rows);
    }
  } catch {}
});
```

Both branches feed `message.data` straight into `session.pty.write(...)` (`node-pty`). **`data` is interpreted as a JS string written to the PTY's stdin — node-pty UTF-8-encodes it on the way down.**

So the canonical keystroke contract is:

```json
{ "type": "input", "data": "<bytes-as-utf8-string>" }
```

where `<bytes-as-utf8-string>` is exactly what xterm would have produced for a real keystroke:

| Logical keystroke | `data` payload (literal, with `\x` escapes) |
|---|---|
| Lowercase `a` | `"a"` |
| Uppercase `A` | `"A"` |
| Enter (CR) | `"\r"` |
| Backspace | `"\x7f"` (DEL — what xterm sends by default; not `\b`) |
| Tab | `"\t"` |
| Esc | `"\x1b"` |
| Ctrl+C | `"\x03"` |
| Ctrl+D | `"\x04"` |
| Ctrl+L | `"\x0c"` |
| Ctrl+V | `"\x16"` |
| Up (cursor mode normal) | `"\x1b[A"` |
| Up (cursor mode application, DECCKM) | `"\x1bOA"` |
| Down | `"\x1b[B"` / `"\x1bOB"` |
| Right | `"\x1b[C"` / `"\x1bOC"` |
| Left | `"\x1b[D"` / `"\x1bOD"` |
| Shift+Tab | `"\x1b[Z"` |
| Alt+letter | `"\x1b<letter>"` (e.g. `"\x1bb"` for Alt+B) |
| Pasted text (bracketed-paste mode on) | `"\x1b[200~<text>\x1b[201~"` |

The server does **not** translate; it forwards verbatim. So a mobile input proxy must produce these exact byte strings (or call `term.input(...)` and let xterm produce them).

### 4.3 Server → Client (for completeness)

| `type` | Payload | Origin |
|---|---|---|
| `"output"` | `{type:"output", data:<string>}` | `terminal-manager.js:300, 507, 752, 778` — PTY → WS broadcast and initial buffer replay. |
| `"exit"` | `{type:"exit", exitCode, signal}` | `terminal-manager.js:318, 620, 660, 760, 813` — PTY exited. |
| `"stopped"` | `{type:"stopped"}` | `terminal-manager.js:511` — session in stopped state at attach time. |
| `"error"` | `{type:"error", message:<string>}` | `terminal-manager.js:469, 770` and `server.js:175` — session not found / no sessionId. |

Client switch — `Terminal.tsx:172-194`. `output.data` is fed straight into `term.write(...)`. Unrecognized JSON falls through to `term.write(event.data)` at line 193 (defensive).

### 4.4 Token / connection contract

WS URL formats — `Terminal.tsx:144` and `EphemeralTerminal.tsx:46`:

```
${ws|wss}://${host}/api/terminal?sessionId=<id>&token=<jwt>
${ws|wss}://${host}/api/terminal?sessionId=<eph-id>&token=<jwt>&ephemeral=true
```

Token is fetched from `/api/auth/ws-token` (`Terminal.tsx:119`, `EphemeralTerminal.tsx:24`). Server validates with `verifyJWT(token)` before `wss.handleUpgrade` (`server.js:163-187`). On 401-equivalent close codes (`4401`, `4404`) the client does *not* reconnect (`Terminal.tsx:204`). After 10 consecutive token-fetch failures the client gives up and shows "Сессия истекла" (`Terminal.tsx:122-129`, `MAX_AUTH_FAILURES = 10` at line 13).

---

## 5. Resize flow — FitAddon, ResizeObserver, fullscreen

### 5.1 Where `fit()` is called

Five call sites in `Terminal.tsx`:

| Line | Trigger | Code |
|---|---|---|
| 254 | Initial mount, double-rAF after `term.open()` | `requestAnimationFrame(() => { requestAnimationFrame(() => { fitAddon.fit(); }); });` |
| 64 | Fullscreen toggle effect (double-rAF) | `fitAddon.fit();` then `ws.send({type:"resize", ...})` |
| 363 | `ResizeObserver(handleResize)` fires | `fitAddon.fit();` then conditional `ws.send({type:"resize", ...})` |

And one in `EphemeralTerminal.tsx`:

| Line | Trigger | Code |
|---|---|---|
| 42 | Initial mount, double-rAF | `requestAnimationFrame(() => { requestAnimationFrame(() => fitAddon.fit()); });` |
| 68 | `ResizeObserver` fires | `fitAddon.fit();` then `ws.send({type:"resize", ...})` |

### 5.2 ResizeObserver registration

`Terminal.tsx:377-380`:

```tsx
const resizeObserver = new ResizeObserver(handleResize);
if (terminalRef.current) {
  resizeObserver.observe(terminalRef.current);
}
```

Observes the wrapper `<div ref={terminalRef}>` (the container that hosts xterm). Disconnect on cleanup (`Terminal.tsx:396`).

`EphemeralTerminal.tsx:67-73`:

```tsx
const resizeObserver = new ResizeObserver(() => {
  fitAddon.fit();
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
  }
});
if (containerRef.current) resizeObserver.observe(containerRef.current);
```

Same pattern.

### 5.3 What does **not** trigger fit

Critical for mobile:

- **`window.visualViewport.resize` is not listened to.** Grep:
  ```
  grep -rn "visualViewport" /root/projects/claude-terminal/src/  →  (no hits)
  ```
- **`window.resize` is not listened to.** No `window.addEventListener("resize", …)` anywhere in `Terminal.tsx` or `EphemeralTerminal.tsx`.
- **`orientationchange` is not listened to.**
- **`focusin`/`focusout` on the textarea is not listened to** (would fire on soft-keyboard open on iOS Safari for the helper textarea).

ResizeObserver does fire when the *container* changes size, so:
- If the soft keyboard pushes the layout up (Android Chrome default behavior) and the container's content-box height changes → fit fires.
- If the soft keyboard overlays the page without resizing the layout viewport (iOS Safari default) → the container's bounding rect is unchanged → **`fit()` is NOT called** → bottom of terminal is hidden under the keyboard with stale `cols/rows`.

This is the single biggest mobile-resize gap.

### 5.4 Resize message timing

After `fit()` runs, `term.cols` and `term.rows` are read and sent to the server. The server calls `session.pty.resize(cols, rows)` which issues `TIOCSWINSZ`. tmux notices the geometry change and re-renders. Round-trip is essentially one network RTT. There is no debouncing; `ResizeObserver` already coalesces rapid changes via the next animation frame internally, but rapid keyboard show/hide will burst-send.

---

## 6. Mobile gaps inventory

### 6.1 Attribute audit

Grep across `src/`:

```
grep -rn "visualViewport\|inputmode\|enterkeyhint\|autocapitalize\|autocorrect\|spellcheck\|touch-action\|onTouchStart\|onTouchEnd\|pointerdown\|onPointer" /root/projects/claude-terminal/src/
   →  (no hits anywhere, in any file)
```

**Zero** mobile-related attributes set in the entire `src/` tree. Specifically:

| Attribute | Set anywhere? | Notes |
|---|---|---|
| `inputmode="..."` | No | xterm's helper textarea has no `inputmode` set — defaults to `text`, which on iOS triggers shift-on-first-letter. |
| `enterkeyhint="..."` | No | Soft keyboard's Enter button shows generic "Return" / "↵". |
| `autocapitalize="off"` | No | iOS will capitalize first letter of every input "sentence". |
| `autocorrect="off"` | No | iOS autocorrects typed words → bytes diverge from intended keystrokes. |
| `spellcheck="false"` | No | Spellcheck underlines redact in the helper textarea (invisible) but consume CPU. |
| `touch-action: ...` | No | Default `auto` — tap on the terminal area starts text selection, double-tap zooms. |
| `visualViewport` listeners | No | See §5.3. |
| `PointerEvent` handlers | No | All event handling delegated to xterm + native scroll. |
| `onTouchStart`/`onTouchEnd` | No | None. |
| Safe-area `env(safe-area-inset-*)` | No (not in `globals.css`) | iOS notch overlap risk on full-screen mode. |
| `100dvh` / `100svh` | No | Layout uses fixed `100vh` constructions in some places (out of scope, see scanner-layout-topology). |
| `<meta name="viewport">` | **Not declared in `layout.tsx`** | Falls back to Next.js implicit default. No `viewport-fit=cover`, no `interactive-widget=resizes-content`. |

### 6.2 Helper textarea — exposed but unstyled for mobile

xterm.js v6 always creates a positioned-off-screen `<textarea class="xterm-helper-textarea">` inside `.xterm`. It is publicly accessible via `xtermRef.current.textarea` (`xterm.d.ts:822`).

Default styling from `xterm.css` (paraphrased — measure on installed file if exact):
- Position: absolute, top/left tiny offset, opacity 0, z-index -5, width/height small.
- This is what receives `keydown`/`input`/`compositionstart`/`compositionend` and emits to xterm's input chain.

For a mobile flow, three choices land here:
1. **Style the helper textarea visible** (override its size + opacity) — invasive and undocumented; xterm v6 may reset on every reflow.
2. **Programmatically `term.textarea?.focus()`** when the user taps a "show keyboard" button — keyboard opens, but the textarea is invisible so caret/IME hint render as ghosts off-screen.
3. **Build a separate React-controlled `<input>`** that does not touch the helper textarea and forwards bytes via `term.input(...)` (preferred — see §7).

There is no current code that touches `xtermRef.current.textarea` at all.

### 6.3 Mobile context inside the wider component tree

- The wrapper `<div>` (`Terminal.tsx:425-428`) is `className="w-full h-full min-h-0"`. No `touch-action`. No `tabIndex`. No `aria-label`. No `role`.
- Dashboard mounts it inside two nested divs at `dashboard/page.tsx:414-417`, both `w-full h-full rounded-...`. Outer container has `presence-active` class which (per `globals.css:215-218`) sets `cursor: none !important` on every child to support the multi-user remote cursor — this **also kills the native text-cursor on the textarea**. Not a mobile-input blocker per se, but worth noting if the splice-point puts a real `<input>` inside `.presence-active`.
- The outer `<div className="absolute inset-0 ${fullscreen ? "m-0" : "m-1 md:m-2"} presence-active">` (`dashboard/page.tsx:405`) is the only place where Tailwind responsive utilities touch the terminal area, and they're cosmetic margin only — no mobile-specific behavior.

### 6.4 Other mobile-relevant absences

- No `onCompositionStart` / `onCompositionUpdate` / `onCompositionEnd` handlers in either wrapper — IME (Chinese / Japanese / Korean / Russian transliteration) is whatever xterm's textarea handles internally; we do not orchestrate it.
- No virtual-keyboard API (`navigator.virtualKeyboard.overlaysContent`) usage. Chromium-only API but increasingly relevant for PWA installs.
- No `beforeinput` listener anywhere — even though xterm v6 listens internally, nothing in the wrapper observes it.
- No PWA install manifest manipulation (`scope`, `start_url`) — out of scope for this scan but called out because mobile deployment context matters.

### 6.5 What touch DOES today

By default, with no handlers wired:
- A single tap on the terminal area focuses xterm's helper textarea (because xterm wires that internally on `mousedown`/`pointerdown` of `.xterm-screen`). Soft keyboard opens.
- That keyboard then types into the invisible 1×1px textarea. Each character that arrives via the textarea's `input` event is forwarded by xterm to `onData`, hence to the WS, hence to the PTY. **So basic typing already works on mobile** — the breakage is in the *experience* (autocorrect rewrites, no visible cursor on the focused element, modifier keys absent, layout doesn't track keyboard).
- Long-press selects text the same way as on desktop (xterm handles this in its renderer).
- Double-tap zooms the page (no `touch-action: manipulation`).
- Pinch zooms.
- Pull-down at top of terminal triggers the browser's pull-to-refresh on Android.

---

## 7. Splice-points for `MobileTerminalInput.tsx`

### 7.1 Recommended splice surface

The cleanest splice is a **shared imperative ref** exposed by `Terminal.tsx` that lets a sibling component push bytes through the same WS:

- The byte-producer used today (`onData → ws.send({type:"input", data})`) is exactly two lines (`Terminal.tsx:218-220`). Anything that needs to pretend-to-be-a-keystroke can either:
  - **(A)** Call `xtermRef.current?.input(data, false)` — this fires `onData`, the existing closure forwards it to WS, and the DA/CPR filter still applies. No duplication of the `ws.send` logic. Bracketed-paste handling is preserved if/when the client-side enables it.
  - **(B)** Reach into `wsRef.current` (currently *not exported* anywhere) and `ws.send(JSON.stringify({type:"input", data}))` directly — bypasses xterm entirely. Pro: no risk of xterm intercepting modifier-key composition. Con: duplicates the protocol literal; you must keep it in sync if the WS contract changes.

Option (A) is preferred because the contract stays single-source-of-truth at `Terminal.tsx:218-220` and behavior across desktop / mobile / future test harness stays identical.

### 7.2 Concrete splice locations

For an `impl-terminal-input-proxy` agent to wire `MobileTerminalInput.tsx`:

1. **Expose a forward-bytes API.** The natural attach point is to (a) lift `xtermRef` to a shared context or `forwardRef`, *or* (b) add a callback prop `onBeforeInput?: (data: string) => boolean` that the mobile input invokes to test+forward. The minimal change is to expose an imperative handle wrapping `term.input(data, false)`.
   - Insertion site: between `Terminal.tsx:258` (`xtermRef.current = term;`) and `Terminal.tsx:261` (`// Scroll tracking`). At that point `term`, `fitAddon`, and `wsRef` are all initialized; `xtermRef` is set.

2. **WS readiness check.** The mobile input must not produce bytes while WS is reconnecting. `wsRef.current?.readyState === WebSocket.OPEN` is the gate — same gate `Terminal.tsx:218` uses. Either bubble `wsRef` up via context, or expose a `ready` boolean state already present in the component (it is not — the `reconnecting` state at `Terminal.tsx:34` is the inverse signal).

3. **Focus handoff.** When the mobile input is mounted, programmatic focus must transfer to the mobile `<input>` (not xterm's textarea), and tapping the terminal area must focus the mobile input rather than xterm's textarea. The shortest path is to attach a `pointerdown` listener on `terminalRef.current` (the wrapper div, currently bare) that calls `mobileInputRef.current?.focus()` on mobile breakpoints. This listener has nowhere to live today; the natural insertion is alongside the `paste` listener (`Terminal.tsx:359`).

4. **Re-fit on `visualViewport.resize`.** A mobile-specific `useEffect` would attach `window.visualViewport?.addEventListener("resize", handleResize)` (and `"scroll"` for iOS overlay-keyboard offset). `handleResize` already exists at `Terminal.tsx:362-375` and is currently scoped inside `initTerminal`. To listen on `visualViewport` it needs lifting to a stable function (or repeated locally inside the new effect). Pure additive — no existing logic moves.

5. **Modifier-key bar.** A `ModifierKeyBar.tsx` would dispatch chord bytes. Same forward-bytes API as (1). Examples:
   - Esc → `term.input("\x1b", false)` → `onData` → WS.
   - Ctrl+C with no preceding letter → `term.input("\x03", false)`.
   - Ctrl+letter as a chord (Ctrl held, then `c` typed) → bar sets a "next-key-is-Ctrl" flag in React state, the next char from the mobile input is rewritten to its Ctrl-coded form before forwarding (`String.fromCharCode(charCodeAt - 96)` for `a–z`).
   - Arrows → must respect DECCKM. xterm tracks application keypad mode via `term.modes.applicationKeypadMode` (`xterm.d.ts:1915`). If true, send `"\x1bOA"`; else `"\x1b[A"`. `term.input(...)` is not arrow-aware on its own — for arrows it is *safer* to call `ws.send` directly with a guard against `term.modes`, OR rely on a synthetic KeyboardEvent.

6. **Bypass DA/CPR filter.** The filter at `Terminal.tsx:217` would discard a payload like `"\x1b[?1;2c"`. Modifier-bar bytes never start that way, so no collision; but if the bar ever sends an explicit "send DA1 to PTY" key (unlikely), it must round-trip via raw `ws.send`, not `term.input`.

### 7.3 Anti-patterns to avoid

- **Do not** add a second `term.onData` subscription in a parallel component — both will fire, double-sending bytes.
- **Do not** style xterm's helper textarea (`term.textarea`) to be visible. xterm v6 reflows it on resize and will fight you. Build a separate React-owned input.
- **Do not** call `term.paste(data)` for keystrokes — `paste()` wraps in `\x1b[200~ ... \x1b[201~` if bracketed-paste is on, which makes the PTY think a clipboard paste happened (vim leaves insert mode, etc.).
- **Do not** assume `e.code` on mobile keyboard events — use `e.key` plus the modifier-bar's React state.

### 7.4 Where a fan-out hook would slot

If lifting `xtermRef` and `wsRef` to a context is the chosen pattern, the new context can sit next to `TerminalScrollContext` (already used, `Terminal.tsx:10`). Provider mount point is `dashboard/page.tsx:404` (`<TerminalScrollProvider>`). Adding a `<TerminalIOProvider>` next to it is a one-line edit and gives both `MobileTerminalInput.tsx` and `ModifierKeyBar.tsx` a stable handle without prop-drilling through the workspace tree.

---

## 8. Decisions closed (per planner brief)

### Q1. What exact bytes/JSON does the WS expect for keystrokes?

**A.** A JSON-stringified text-frame:

```json
{ "type": "input", "data": "<bytes-as-utf8-string>" }
```

`data` is xterm's keystroke encoding (e.g. `"a"`, `"\r"` for Enter, `"\x7f"` for Backspace, `"\x03"` for Ctrl+C, `"\x1b[A"` or `"\x1bOA"` for Up depending on DECCKM). Server forwards verbatim to `pty.write(data)`. See §4.2 / `terminal-manager.js:518-525` (persistent), `terminal-manager.js:784-788` (ephemeral).

### Q2. Is there a clean `term.onData`/`onData` boundary we can splice into?

**A.** Yes, two clean options:
- **(A)** `xtermRef.current?.input(data, false)` — pushes bytes into xterm's input chain so the existing `term.onData` listener (`Terminal.tsx:213`) forwards them to WS unchanged. Single source of truth for the protocol literal. `wasUserInput=false` skips xterm's auto-focus / selection-clear side effects. Documented at `xterm.d.ts:1015-1025`.
- **(B)** Direct `wsRef.current?.send(JSON.stringify({type:"input", data}))` — bypasses xterm entirely. Required for arrow keys when you want to mirror DECCKM-aware encoding without relying on xterm's keymap, and for any byte sequence that would be eaten by the DA/CPR filter at `Terminal.tsx:217`.

Both require lifting `xtermRef` (and ideally `wsRef`) out of `Terminal.tsx`'s local scope — currently both are component-private refs.

### Q3. Does FitAddon recompute on `visualViewport.resize`?

**A.** No. `FitAddon.fit()` is invoked only by:
- Initial double-rAF after `term.open()` (`Terminal.tsx:254`, `EphemeralTerminal.tsx:42`).
- Fullscreen-toggle effect (`Terminal.tsx:64`).
- `ResizeObserver` on the container `<div>` (`Terminal.tsx:363`, `EphemeralTerminal.tsx:68`).

On iOS Safari (default behavior of the soft keyboard overlaying without resizing the layout viewport), the container dimensions do not change → ResizeObserver does not fire → no `fit()` → no resize WS message → PTY winsize stays stale → the bottom rows of the terminal hide under the keyboard with no scroll-to-cursor adjustment. There is **zero** `visualViewport` listener anywhere in `src/`.

### Q4. Is xterm's helper textarea exposed and styleable, or is the easier path a separate input?

**A.** It is exposed (`term.textarea: HTMLTextAreaElement | undefined`, `xterm.d.ts:822`) but the easier path is a **separate React-controlled `<input>` / `<textarea>`** that calls `term.input(data, false)` (or `ws.send` directly).

Reasons:
- `xterm.css` ships with positioning/sizing rules for `.xterm-helper-textarea` that xterm's renderer relies on for mouse coordinate calculations and IME caret placement. Overriding them risks breaking selection and IME composition handling that *does* work today.
- The helper textarea has no semantic / UX affordances (no placeholder, no border, no caret position the user can see). Styling it visible would require duplicating those, at which point a fresh `<input>` is simpler.
- A separate input lets you apply mobile-only attributes (`inputmode="search"`, `enterkeyhint="send"`, `autocapitalize="off"`, `autocorrect="off"`, `spellcheck={false}`) without affecting desktop xterm behavior.
- A separate input lets you place the `ModifierKeyBar.tsx` directly above it as a sticky sibling above the soft keyboard (driven by `visualViewport.height`).
- The `forward-bytes` contract via `term.input(data, false)` keeps a single ingress for bytes, so all server-side recording / replay / multi-client broadcast continues to see one consistent input stream regardless of client form-factor.

---

## 9. Cross-references

- Sister scan covering streaming reliability: `agent-workflow/02-scan-tmux-stream.md` (out of scope here).
- Mobile-input proxy implementer brief: `agent-workflow/01-planner-mobile.md` Phase 7 §`impl-terminal-input-proxy` (lines 141-146).
- xterm.js typings (installed locally): `/root/projects/claude-terminal/node_modules/@xterm/xterm/typings/xterm.d.ts`.

---

## 10. TL;DR for the implementer

1. Lift `xtermRef` and `wsRef` out of `Terminal.tsx` into a `TerminalIOContext` next to `TerminalScrollProvider` (`dashboard/page.tsx:404`).
2. New mobile component calls `xtermRef.current.input(bytes, false)` for plain typing — re-uses the existing `term.onData → ws.send({type:"input"})` pipe at `Terminal.tsx:213-221`.
3. New `useEffect` listens on `window.visualViewport?.addEventListener("resize", …)` and replays the existing `handleResize` body (`Terminal.tsx:362-375`).
4. Modifier-bar produces chords by either (a) re-encoding the next typed char (`Ctrl-as-mod` flag in React state) or (b) `wsRef.current.send(JSON.stringify({type:"input", data: "\x03"}))` for one-shot chords.
5. On mobile breakpoints, set `tabIndex={-1}` on the terminal wrapper `<div>` (currently bare, `Terminal.tsx:425-428`) and route taps to the new mobile input via a `pointerdown` listener so xterm's helper textarea no longer steals focus.
6. None of the above touches the server. WS contract stays exactly as documented in §4.
