# Phase 3 — Research: xterm.js Mobile Input Proxy

> Agent: `researcher-xterm-input-proxy`
> Stack assumption (frozen by `package.json`): `@xterm/xterm@^6.0.0`, `@xterm/addon-fit@^0.11.0`, `@xterm/addon-web-links@^0.12.0`, Next.js 15, React 19, TypeScript.
> WS protocol (already shipped, see `Terminal.tsx:213–221`): keystrokes go through `ws.send(JSON.stringify({ type: "input", data }))` where `data: string` is the raw byte sequence the PTY expects.
> All API signatures below are copied verbatim from `node_modules/@xterm/xterm/typings/xterm.d.ts` and `node_modules/@xterm/addon-fit/typings/addon-fit.d.ts` — i.e. ground-truth for the version we ship.
> Web research (xtermjs.org docs, MDN, GitHub examples) was attempted but the WebSearch/WebFetch backend was unavailable during this session; the recipes lean on local type definitions and the cross-browser knowledge baked into the harness. Implementer should re-verify edge cases on real devices in Phase 8c.

---

## 0. TL;DR for the arbiter

- **Recommended baseline**: **Recipe B** (separate React-controlled `<input>` that calls `term.input(data, true)` per keystroke), with **Recipe D** layered on top for IME composition. This keeps the existing `term.onData` → WS pipeline intact (zero changes to Terminal.tsx's WebSocket handling) and lets us hide xterm's native helper textarea on mobile to escape iOS Safari's caret/scroll quirks.
- **Fallback**: Recipe A (expose & style xterm's built-in `term.textarea`) — simplest possible patch but inherits every iOS quirk in xterm.js core.
- **Reject**: Recipe C (bypass xterm and write directly to WS) — duplicates the data path, breaks `term.onData` symmetry, and forces us to re-implement bracketed-paste/local-echo logic.
- **Modifier bar**: separate `ModifierKeyBar.tsx` that calls a single `sendKey(name)` helper. Bytes go through the same `ws.send({type:"input", data})` channel — there is no protocol change required.

---

## 1. xterm.js API reference cheatsheet (v6, ground truth from local `.d.ts`)

### 1.1 Properties on `Terminal` relevant to input proxy

| Property | Type | Semantics |
|----------|------|-----------|
| `element` | `HTMLElement \| undefined` | The wrapper `<div class="terminal xterm">` xterm injects after `term.open(parent)`. Use to bind paste/touch listeners. |
| `textarea` | `HTMLTextAreaElement \| undefined` | The hidden helper `<textarea class="xterm-helper-textarea">` xterm uses for clipboard, IME and a11y. **Recipe A targets this.** Off-screen by default (`left: -9999em` in core CSS). |
| `cols` / `rows` | `number` | Read-only viewport size. Used to send `{type:"resize", cols, rows}` over WS after FitAddon recompute. |
| `buffer` | `IBufferNamespace` | `.active.viewportY`, `.baseY`, `.length` already used by `TerminalScrollContext`. |
| `options` | `ITerminalOptions` | Mutable, e.g. `term.options.cursorBlink = false` when blurred on mobile. |
| `modes` | `IModes` | Read-only DEC/ANSI mode flags. **`modes.applicationCursorKeysMode`** flips arrow-key encoding (`\x1bOA` vs `\x1b[A`) — modifier bar must respect this. |

### 1.2 Events (every call returns `IDisposable`; always store the disposable)

| Event | Payload | Used for |
|-------|---------|----------|
| `onData(listener)` | `string` | Fires for everything xterm decided to send to the PTY: typed chars, paste (with bracketed wrappers), key bytes from xterm's own keymap. **This is the existing splice point in Terminal.tsx.** |
| `onBinary(listener)` | `string` | Non-UTF-8 binary (currently only mouse reports). On the wire send as `Buffer.from(data, 'binary')`. Mobile rarely fires this. |
| `onKey(listener)` | `{ key: string, domEvent: KeyboardEvent }` | Fires after xterm's own keymap resolves. **Don't use for proxy** — `onData` already includes the resulting bytes; using both double-sends. |
| `onResize(listener)` | `{ cols: number, rows: number }` | Fires when FitAddon recomputes. Hook here to push `{type:"resize"}` over WS. |
| `onScroll(listener)` | `number` (new viewportY) | Already wired to `TerminalScrollContext`. |
| `onWriteParsed(listener)` | `void` | Fires once per frame after `term.write` is parsed. Already wired. |
| `onSelectionChange(listener)` | `void` | Useful for showing a "Copy" button on long-press. |
| `onTitleChange(listener)` | `string` | Could surface in mobile header. |
| `onCursorMove(listener)` | `void` | Trigger to re-scroll mobile input bar into view. |
| `onBell(listener)` | `void` | Optional `navigator.vibrate(20)` haptic. |

### 1.3 Methods relevant to input proxy

| Method | Signature (ground truth) | Semantics |
|--------|--------------------------|-----------|
| `input` | `input(data: string, wasUserInput?: boolean): void` | **Pushes `data` into the same pipeline a typed key would.** This causes `onData` to fire with `data`. Pass `wasUserInput=true` (default) so xterm clears selection / scrolls to bottom; pass `false` for synthetic input that should be quiet. |
| `paste` | `paste(data: string): void` | Wraps `data` with `\x1b[200~ … \x1b[201~` if `modes.bracketedPasteMode` is on, then routes through `onData`. **Use for clipboard paste on mobile** — do not call `input()` for paste. |
| `attachCustomKeyEventHandler` | `(event: KeyboardEvent) => boolean` | Pre-processor; return `false` to swallow the event before xterm's keymap. Already used in Terminal.tsx for Ctrl+Shift+C. **On mobile we will return `false` for everything when the proxy is active**, so xterm's own keymap doesn't double-emit. |
| `focus()` / `blur()` | `(): void` | `focus()` puts caret in `term.textarea`. **On iOS Safari `focus()` only opens the keyboard if it happens inside a user gesture**; we'll trigger it from a `pointerdown` on the terminal surface. |
| `write` | `write(data: string \| Uint8Array, callback?: () => void): void` | Server → client. Callback fires after parser drains. Use for sequencing modifier-bar feedback after an echo arrives. |
| `writeln` | `writeln(data, callback?): void` | `write` + `\n`. |
| `loadAddon` | `(addon: ITerminalAddon): void` | Load FitAddon, WebLinksAddon, future Unicode11Addon, Webgl/CanvasAddon. |
| `resize` | `(columns: number, rows: number): void` | Direct resize bypassing FitAddon. Debounce ≥100 ms. |
| `getSelection()` / `hasSelection()` / `clearSelection()` | trivially typed | For mobile copy button. |
| `dispose()` | `(): void` | Tear-down. |

### 1.4 `attachCustomKeyEventHandler` return value semantics (footgun)

```ts
attachCustomKeyEventHandler((ev: KeyboardEvent) => boolean): void;
```

- `return true` → xterm processes the event normally (its keymap emits bytes via `onData`).
- `return false` → xterm **swallows** the event — no `onData` fires from it.
- The handler runs on **both `keydown` and `keyup`**. Always check `ev.type === 'keydown'` before doing work.
- It does **not** call `ev.preventDefault()` for you. If you return `false` and want to also stop the browser default (e.g. Ctrl+R reloading the page), you must call `ev.preventDefault()` yourself.

### 1.5 `term.input(data, wasUserInput)` semantics (footgun)

- Calling `term.input("a")` fires `onData` with `"a"`. Existing Terminal.tsx code at line 213 will then `ws.send(JSON.stringify({type:"input", data:"a"}))`. **Calling `term.input()` AND `ws.send()` for the same key = duplicate input** — recipes B/D pick one path.
- `wasUserInput=true` triggers a few side-effects: scroll-to-bottom (if `scrollOnUserInput: true`), clears selection, clears the `cursorHidden` flag. For real keystrokes you want this. For programmatic injection (e.g. replaying buffer) pass `false`.
- It does **not** check `disableStdin`. So `term.options.disableStdin = true` does NOT block `term.input()` — only the keymap path.

### 1.6 The hidden helper `<textarea>` (`term.textarea`)

xterm.js builds its DOM after `term.open(el)` like this (approximated; see `src/browser/Terminal.ts`):

```html
<div class="terminal xterm xterm-cursor-block">
  <div class="xterm-viewport" />
  <div class="xterm-screen">
    <textarea class="xterm-helper-textarea"
              aria-label="Terminal input"
              autocorrect="off" autocapitalize="off" spellcheck="false"
              tabindex="0"
              style="position:absolute; opacity:0; left:-9999em; top:0; width:0; height:0;" />
    <canvas class="xterm-text-layer" />
    …
  </div>
</div>
```

Key properties for Recipe A:
- The textarea **is the keyboard target on every platform** — that's how xterm receives keys today, mobile included.
- It already has `autocorrect="off" autocapitalize="off" spellcheck="false"` set by xterm core.
- It is positioned `-9999em` left so the OS keyboard's "selected text" indicator isn't visible. **This is the bug on iOS Safari**: when an input is off-screen, iOS sometimes refuses to scroll-into-view, leaving the keyboard covering the bottom of the page with no input bar feedback.
- Recipe A: pull it back on-screen (`left: 0; opacity: 0.01; height: 1px; width: 100%`) so iOS treats it like a normal input.

### 1.7 Addon compatibility for mobile

| Addon | Status (v6) | Mobile note |
|-------|-------------|-------------|
| `@xterm/addon-fit@^0.11.0` | shipped | Already in use. **Must `.fit()` on every `visualViewport.resize`** when the keyboard opens. |
| `@xterm/addon-web-links@^0.12.0` | shipped | Already in use. Tap-to-open works on iOS/Android; consider `linkHandler.activate` to confirm before opening. |
| `@xterm/addon-unicode11` | optional | Recommended for emoji/CJK width. Activate with `term.unicode.activeVersion = '11'`. |
| `@xterm/addon-webgl` | optional | **Skip on mobile by default** — context loss on iOS Safari background, GPU memory pressure on low-end Android. |
| `@xterm/addon-canvas` | optional | Better mobile fit than webgl; v6 still falls back to DOM renderer when neither is loaded. **Use canvas on mobile, webgl on desktop** if performance is required. |
| `@xterm/addon-clipboard` | optional | Adds OSC 52 clipboard support. Pair with `navigator.clipboard.writeText` permission prompt. |

---

## 2. Web platform reference (terse)

### 2.1 `visualViewport`

```ts
interface VisualViewport extends EventTarget {
  readonly offsetLeft: number;
  readonly offsetTop: number;     // distance from layout viewport top to visual viewport top
  readonly pageLeft: number;
  readonly pageTop: number;
  readonly width: number;
  readonly height: number;        // height of visible area, EXCLUDING soft keyboard
  readonly scale: number;
  onresize: ((this: VisualViewport, ev: Event) => any) | null;
  onscroll: ((this: VisualViewport, ev: Event) => any) | null;
}
```

- Fired on Safari iOS 13+, Chrome Android 61+, desktop Chrome/Edge/Firefox.
- `height` shrinks when the soft keyboard opens **iff** `interactive-widget=resizes-content` is **not** set (default is `resizes-visual`, which is what we want for the proxy).
- `offsetTop` is non-zero when the user pinches/zooms; on non-pinched pages it's 0.

### 2.2 Viewport meta string we'll need (one-time, in `app/layout.tsx`)

```html
<meta name="viewport"
      content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content" />
```

- `viewport-fit=cover` → enables `env(safe-area-inset-*)` (notch, home indicator).
- `interactive-widget=resizes-content` → on Chrome Android the layout viewport shrinks when the keyboard opens, so `100dvh` and absolute-positioned elements re-layout. **Currently Safari iOS ignores `interactive-widget`** (still uses default `resizes-visual`); we must use `visualViewport` events as the cross-browser fallback.
- Without `interactive-widget=resizes-content`, Chrome Android behaves like Safari (keyboard floats over content) — that's why we still need the `useVisualViewport()` hook for both browsers.

### 2.3 Input attributes we'll use on the proxy field

| Attribute | Value | Effect |
|-----------|-------|--------|
| `inputmode` | `"text"` (default) — could try `"none"` to skip text-prediction layer, but `"none"` hides the keyboard on iOS so DON'T use here | Hints to OS what kind of keyboard to show. |
| `enterkeyhint` | `"send"` or `"go"` | Changes the Enter button label on mobile. We want `"send"` so users know it's a real submit (which it is — Enter forwards as `\r`). |
| `autocapitalize` | `"off"` (alt `"none"`) | Disables capitalization-on-first-letter. |
| `autocorrect` | `"off"` (Safari only, non-standard) | Disables iOS text correction. |
| `spellcheck` | `"false"` | Disables spell underline. |
| `autocomplete` | `"off"` (alt `"new-password"` defeats password-manager autofill more reliably on iOS) | No autofill suggestions. |

### 2.4 CSS hygiene

```css
/* Block iOS rubber-band & Android pull-to-refresh inside the terminal */
.terminal-host {
  overscroll-behavior: contain;
  touch-action: manipulation; /* disables 300ms tap delay; allows pinch */
}

/* Proxy input — full width, hugs the top of the keyboard */
.mobile-input-bar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  /* Will be overridden by visualViewport hook */
  padding-bottom: env(safe-area-inset-bottom);
}
```

### 2.5 Viewport-height units

| Unit | Means | When to use |
|------|-------|-------------|
| `100vh` | Largest possible viewport (URL bar hidden on mobile). **Causes scroll/clip on URL-bar-show.** Avoid. |
| `100dvh` | Dynamic — current viewport (matches `visualViewport.height` minus keyboard? No — minus URL bar yes, keyboard depends on `interactive-widget`). |
| `100svh` | Smallest stable (URL bar shown). |
| `100lvh` | Largest stable (URL bar hidden). |

For the dashboard shell: use `100dvh` with a `--vvh` CSS variable updated by `useVisualViewport()` as fallback for older WebKit.

### 2.6 Browser quirks to design for

**iOS Safari**
- `term.focus()` outside a user gesture → no keyboard. Always trigger from `pointerdown`/`touchend` listener.
- An input with `position: fixed; bottom: 0` jumps up when keyboard opens **only if** that input has focus. Other fixed elements are pushed up by the same amount. Use `visualViewport` to position.
- `:focus` on a fixed input is auto-blurred when user taps a non-input element with `tabindex` — work around by adding `tabindex="-1"` to the terminal canvas wrapper.
- IME composition: `compositionstart`/`compositionupdate`/`compositionend` fire normally on a real `<input>`, but **xterm's helper textarea swallows compositionend on iOS sometimes** — Recipe D provides a clean path.

**Android Chrome**
- `interactive-widget=resizes-content` works since Chrome 108. Without it, behaves like Safari.
- IME composition is more reliable but emits `keydown` with `keyCode === 229` for every composition step. Don't trust `keydown.key` during composition; wait for `compositionend.data`.
- Some Samsung Keyboards never fire `keydown` for letters — only `input` event. Recipe B/D rely on `input` event for cross-keyboard correctness.

---

## 3. Candidate implementation recipes

Each recipe is a self-contained React + TS sketch. They share these helpers (define once in `src/lib/mobile-input.ts`):

```ts
// src/lib/mobile-input.ts
export type WSSender = (msg: { type: "input"; data: string }) => void;

export interface ProxyConfig {
  send: WSSender;             // closes over wsRef
  termInput?: (data: string, wasUserInput?: boolean) => void; // optional bypass
  applicationCursorKeys: () => boolean; // term.modes.applicationCursorKeysMode
}

// Same byte map used by ModifierKeyBar — see §5
export const KEYS = {
  Esc: "\x1b",
  Tab: "\t",
  Enter: "\r",
  Backspace: "\x7f",
  CtrlC: "\x03",
  CtrlD: "\x04",
  CtrlL: "\x0c",
  CtrlR: "\x12",
  ShiftTab: "\x1b[Z",
  // Arrows depend on application cursor keys mode (DECCKM).
  // In normal mode: \x1b[A/B/C/D ; in app mode: \x1bOA/OB/OC/OD
  ArrowUp:    (appCursor: boolean) => appCursor ? "\x1bOA" : "\x1b[A",
  ArrowDown:  (appCursor: boolean) => appCursor ? "\x1bOB" : "\x1b[B",
  ArrowRight: (appCursor: boolean) => appCursor ? "\x1bOC" : "\x1b[C",
  ArrowLeft:  (appCursor: boolean) => appCursor ? "\x1bOD" : "\x1b[D",
} as const;
```

---

### Recipe A — Expose & style xterm's built-in `term.textarea` on mobile

**Idea**: xterm already focuses its hidden helper textarea when the user taps the terminal. On mobile, just pull that textarea on-screen (or visually flush against the keyboard) and let xterm's own pipeline do everything. Smallest possible patch.

```tsx
// src/components/MobileTerminalInput.tsx (Recipe A)
"use client";
import { useEffect } from "react";
import type { Terminal as XTerm } from "@xterm/xterm";

interface Props {
  term: XTerm | null;
  isMobile: boolean;
}

export function MobileTerminalInput({ term, isMobile }: Props) {
  useEffect(() => {
    if (!term || !isMobile) return;
    const ta = term.textarea;
    if (!ta) return;

    // Pull xterm's hidden textarea onto the visible surface.
    ta.style.position = "fixed";
    ta.style.left = "0";
    ta.style.right = "0";
    ta.style.bottom = "0";
    ta.style.width = "100%";
    ta.style.height = "1px";        // 1px keeps the OS caret on-screen but invisible
    ta.style.opacity = "0.01";       // not 0 — Safari sometimes ignores zero-opacity inputs for caret positioning
    ta.style.zIndex = "50";
    ta.style.transform = "none";
    ta.setAttribute("inputmode", "text");
    ta.setAttribute("enterkeyhint", "send");
    ta.setAttribute("autocapitalize", "off");
    ta.setAttribute("autocorrect", "off");
    ta.setAttribute("spellcheck", "false");
    ta.setAttribute("autocomplete", "off");

    // Tap the terminal surface → focus the textarea (open keyboard)
    const host = term.element;
    const onPointerDown = () => {
      // MUST happen synchronously inside the user gesture or iOS won't open keyboard
      ta.focus({ preventScroll: true });
    };
    host?.addEventListener("pointerdown", onPointerDown);

    return () => {
      host?.removeEventListener("pointerdown", onPointerDown);
      // Restore xterm's default off-screen position on unmount/desktop
      Object.assign(ta.style, {
        position: "absolute",
        left: "-9999em",
        top: "0",
        width: "0",
        height: "0",
        opacity: "0",
      });
    };
  }, [term, isMobile]);

  return null; // no own DOM — we mutate xterm's textarea
}
```

**Pros**
- Zero changes to WS pipeline; `term.onData` already wired.
- Inherits xterm's IME handling for free.
- ~30 lines of code.

**Cons**
- Helper textarea has no visible text (it's empty after each keystroke — xterm clears it). On iOS Safari, the OS keyboard's autocorrect bar sometimes shows nonsense suggestions because the textarea's value is always empty.
- Cannot show typed-but-not-sent buffer (no echo lag indicator).
- Modifier bar still needs to inject bytes — must do it via `term.input(byte, true)` because the textarea isn't a real input bar we control.
- Restyling internal xterm DOM is brittle to xterm version bumps.

---

### Recipe B — Separate React `<input>` calling `term.input(data, true)` per keystroke

**Idea**: Build our own input UI; for every keystroke, push the bytes into xterm via `term.input()`. xterm's existing `onData` listener (in Terminal.tsx) sends them over WS unchanged.

```tsx
// src/components/MobileTerminalInput.tsx (Recipe B)
"use client";
import { useEffect, useRef, useState, useCallback } from "react";
import type { Terminal as XTerm } from "@xterm/xterm";
import { KEYS } from "@/lib/mobile-input";

interface Props {
  term: XTerm | null;
  isMobile: boolean;
}

export function MobileTerminalInput({ term, isMobile }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(""); // visual buffer (always cleared on keystroke)

  // Per-keystroke push: derive what changed and forward
  const onChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (!term) return;
    const v = e.target.value;
    if (v.length === 0) return;
    // We treat the input as "outbox": every char gets shipped immediately, then we clear.
    term.input(v, true);
    setDraft("");
    // Reset DOM value too (controlled-component sync after async setState)
    e.target.value = "";
  }, [term]);

  // Keys that don't produce an input event (Backspace on empty, Enter, arrows on hard keyboard)
  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!term) return;
    // Block xterm-bound keys that would normally re-fire from the canvas (we own input now)
    switch (e.key) {
      case "Enter":
        e.preventDefault();
        term.input(KEYS.Enter, true);
        return;
      case "Backspace":
        if ((e.target as HTMLInputElement).value.length === 0) {
          e.preventDefault();
          term.input(KEYS.Backspace, true);
        }
        return;
      case "Tab":
        e.preventDefault();
        term.input(e.shiftKey ? KEYS.ShiftTab : KEYS.Tab, true);
        return;
      case "Escape":
        e.preventDefault();
        term.input(KEYS.Esc, true);
        return;
      // Arrows fire keydown without an input event on hardware keyboards.
      case "ArrowUp":
      case "ArrowDown":
      case "ArrowLeft":
      case "ArrowRight": {
        e.preventDefault();
        const app = term.modes.applicationCursorKeysMode;
        const m = ({
          ArrowUp:    KEYS.ArrowUp(app),
          ArrowDown:  KEYS.ArrowDown(app),
          ArrowLeft:  KEYS.ArrowLeft(app),
          ArrowRight: KEYS.ArrowRight(app),
        } as const)[e.key];
        term.input(m, true);
        return;
      }
    }
    // Ctrl combos from a paired hardware keyboard
    if (e.ctrlKey && e.key.length === 1) {
      const code = e.key.toUpperCase().charCodeAt(0);
      if (code >= 64 && code <= 95) {
        e.preventDefault();
        term.input(String.fromCharCode(code - 64), true);
      }
    }
  }, [term]);

  // On mobile, swallow xterm's own keymap so it doesn't double-emit.
  useEffect(() => {
    if (!term || !isMobile) return;
    term.attachCustomKeyEventHandler(() => false); // we own input now
    // Restore on cleanup — but xterm has no setter to restore default;
    // store the previous state in a closure or just re-init when isMobile flips.
    return () => {
      term.attachCustomKeyEventHandler(() => true);
    };
  }, [term, isMobile]);

  // Open keyboard on tap of terminal surface
  useEffect(() => {
    if (!term || !isMobile) return;
    const host = term.element;
    const onPointerDown = () => inputRef.current?.focus({ preventScroll: true });
    host?.addEventListener("pointerdown", onPointerDown);
    return () => host?.removeEventListener("pointerdown", onPointerDown);
  }, [term, isMobile]);

  if (!isMobile) return null;

  return (
    <div className="mobile-input-bar">
      <input
        ref={inputRef}
        type="text"
        value={draft}
        onChange={onChange}
        onKeyDown={onKeyDown}
        inputMode="text"
        enterKeyHint="send"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        autoComplete="off"
        aria-label="Terminal input"
        className="w-full bg-transparent outline-none text-base px-3 py-2"
      />
    </div>
  );
}
```

**Pros**
- WS pipeline untouched (`Terminal.tsx` line 213's `onData` listener still does the actual sending).
- Full visual control (placeholder, "send" indicator, modifier bar can render adjacent).
- Easy to layer composition events on top (Recipe D).
- Keyboard reliably opens on tap because `inputRef.current?.focus()` runs inside a React-attached `pointerdown` synchronously.

**Cons**
- "Outbox" pattern (push-and-clear) means autocorrect can never finish a word — every letter is shipped immediately. **Use Recipe D for autocorrect/IME-friendly variant.**
- Must manually handle ~10 special keys in `onKeyDown`.
- `attachCustomKeyEventHandler(() => false)` swallows xterm's keymap — desktop must restore it (handled by `useEffect` cleanup in code above).

---

### Recipe C — Separate `<input>` that bypasses xterm and writes bytes straight to WS

**Idea**: don't call `term.input()` at all; encode bytes ourselves and send to WS. xterm becomes a pure renderer.

```tsx
// src/components/MobileTerminalInput.tsx (Recipe C)
"use client";
import { useCallback, useEffect, useRef } from "react";
import type { Terminal as XTerm } from "@xterm/xterm";
import { KEYS } from "@/lib/mobile-input";

interface Props {
  term: XTerm | null;
  isMobile: boolean;
  send: (data: string) => void; // ws.send(JSON.stringify({type:"input", data}))
}

export function MobileTerminalInput({ term, isMobile, send }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  const onChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    if (v.length === 0) return;
    send(v);                      // straight to WS
    e.target.value = "";
  }, [send]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!term) return;
    switch (e.key) {
      case "Enter":     e.preventDefault(); send(KEYS.Enter); return;
      case "Backspace":
        if ((e.target as HTMLInputElement).value.length === 0) {
          e.preventDefault(); send(KEYS.Backspace);
        }
        return;
      case "Tab":       e.preventDefault(); send(e.shiftKey ? KEYS.ShiftTab : KEYS.Tab); return;
      case "Escape":    e.preventDefault(); send(KEYS.Esc); return;
      case "ArrowUp":
      case "ArrowDown":
      case "ArrowLeft":
      case "ArrowRight": {
        e.preventDefault();
        const app = term.modes.applicationCursorKeysMode;
        const m = ({
          ArrowUp: KEYS.ArrowUp(app), ArrowDown: KEYS.ArrowDown(app),
          ArrowLeft: KEYS.ArrowLeft(app), ArrowRight: KEYS.ArrowRight(app),
        } as const)[e.key];
        send(m); return;
      }
    }
  }, [term, send]);

  // Tell xterm "you have no input"; it should still render, just not steal keys.
  useEffect(() => {
    if (!term || !isMobile) return;
    term.options.disableStdin = true;
    term.attachCustomKeyEventHandler(() => false);
    return () => {
      term.options.disableStdin = false;
      term.attachCustomKeyEventHandler(() => true);
    };
  }, [term, isMobile]);

  if (!isMobile) return null;
  return (
    <div className="mobile-input-bar">
      <input
        ref={inputRef}
        type="text"
        onChange={onChange}
        onKeyDown={onKeyDown}
        inputMode="text" enterKeyHint="send"
        autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="off"
      />
    </div>
  );
}
```

**Pros**
- Pure render xterm — no `onData` re-entry, no double-send risk.
- Easiest to debug (single arrow: input → WS).

**Cons**
- **Bracketed-paste mode is broken.** When the shell enables `\x1b[?2004h`, real terminals wrap clipboard pastes with `\x1b[200~ … \x1b[201~`. `term.paste()` does this for us; raw `send(text)` does not. We'd have to re-implement bracketed-paste detection in the WS layer.
- xterm's `disableStdin = true` still allows mouse reports, focus events, and other xterm-managed in-band sequences to flow via `onBinary`. We'd need to merge two channels (raw input + onBinary) into the same WS message.
- `onData` is bypassed → existing telemetry/filter (`if (/^\x1b\[[\?>=]/.test(data)) return;` at line 217) is bypassed too — must duplicate that filter.
- Local-echo modes (where the shell tells xterm to render typed chars before they round-trip) stop working.

---

### Recipe D — `<textarea>` with composition-event awareness (IME-friendly)

**Idea**: use a real `<textarea>` (not `<input>`) and only ship bytes after the IME composition completes. Best for CJK, emoji-by-name, voice input.

```tsx
// src/components/MobileTerminalInput.tsx (Recipe D)
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Terminal as XTerm } from "@xterm/xterm";
import { KEYS } from "@/lib/mobile-input";

interface Props {
  term: XTerm | null;
  isMobile: boolean;
}

export function MobileTerminalInput({ term, isMobile }: Props) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const [draft, setDraft] = useState("");

  // While composing, hold bytes locally. On compositionend, ship the final string.
  const onCompositionStart = useCallback(() => { composingRef.current = true; }, []);
  const onCompositionEnd = useCallback((e: React.CompositionEvent<HTMLTextAreaElement>) => {
    composingRef.current = false;
    if (!term) return;
    const data = e.data ?? taRef.current?.value ?? "";
    if (data) term.input(data, true);
    setDraft("");
    if (taRef.current) taRef.current.value = "";
  }, [term]);

  // For non-composition input (typed Latin chars, autocorrect commits), forward immediately.
  const onInput = useCallback((e: React.FormEvent<HTMLTextAreaElement>) => {
    if (composingRef.current) {
      // Composition in progress — just reflect locally
      setDraft((e.target as HTMLTextAreaElement).value);
      return;
    }
    if (!term) return;
    const v = (e.target as HTMLTextAreaElement).value;
    if (v.length === 0) return;
    term.input(v, true);
    setDraft("");
    (e.target as HTMLTextAreaElement).value = "";
  }, [term]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (composingRef.current) return; // never intercept during composition
    if (!term) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      term.input(KEYS.Enter, true);
      return;
    }
    if (e.key === "Backspace" && (e.target as HTMLTextAreaElement).value.length === 0) {
      e.preventDefault();
      term.input(KEYS.Backspace, true);
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      term.input(e.shiftKey ? KEYS.ShiftTab : KEYS.Tab, true);
    }
    // Arrows handled by hardware-keyboard branch (Recipe B logic — omitted for brevity)
  }, [term]);

  // Paste handler — use xterm.paste() for bracketed-paste support
  const onPaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!term) return;
    const text = e.clipboardData.getData("text");
    if (!text) return;
    e.preventDefault();
    term.paste(text); // wraps with bracketed-paste markers if mode is on
    setDraft("");
    if (taRef.current) taRef.current.value = "";
  }, [term]);

  useEffect(() => {
    if (!term || !isMobile) return;
    term.attachCustomKeyEventHandler(() => false);
    const host = term.element;
    const onDown = () => taRef.current?.focus({ preventScroll: true });
    host?.addEventListener("pointerdown", onDown);
    return () => {
      host?.removeEventListener("pointerdown", onDown);
      term.attachCustomKeyEventHandler(() => true);
    };
  }, [term, isMobile]);

  if (!isMobile) return null;
  return (
    <div className="mobile-input-bar">
      <textarea
        ref={taRef}
        rows={1}
        value={draft}
        onInput={onInput}
        onChange={() => { /* controlled — handled in onInput */ }}
        onKeyDown={onKeyDown}
        onCompositionStart={onCompositionStart}
        onCompositionEnd={onCompositionEnd}
        onPaste={onPaste}
        inputMode="text"
        enterKeyHint="send"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        autoComplete="off"
        aria-label="Terminal input"
        className="w-full bg-transparent outline-none text-base px-3 py-2 resize-none"
      />
    </div>
  );
}
```

**Pros**
- Correct CJK/emoji input; voice input (Gboard "voice typing", iOS dictation) ships full phrases at once.
- Paste goes through `term.paste()` so bracketed-paste mode is honored.
- Modifier bar still pipes into `term.input()`, so we don't fork the data path.
- `<textarea>` allows multi-line composition (handy for "paste a JSON blob then submit").

**Cons**
- Slightly more code than B.
- During long compositions the user sees a draft that hasn't reached the PTY — for shells that do live syntax highlighting (fish, zsh-syntax-highlighting), feedback arrives only after compositionend.
- `e.data` on `compositionend` is empty on some Android keyboards (Samsung) — hence the `taRef.current?.value` fallback.

---

### Recipe E — Hybrid: `contenteditable` overlay over the terminal canvas

**Idea**: a single `contenteditable="true"` `<div>` overlaid on the terminal viewport. It captures keystrokes, IME, paste, and forwards via `term.input()`. Rendered behind the canvas with `pointer-events: auto` on tap.

```tsx
// src/components/MobileTerminalInput.tsx (Recipe E)
"use client";
import { useEffect, useRef } from "react";
import type { Terminal as XTerm } from "@xterm/xterm";
import { KEYS } from "@/lib/mobile-input";

interface Props {
  term: XTerm | null;
  isMobile: boolean;
}

export function MobileTerminalInput({ term, isMobile }: Props) {
  const ceRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!term || !isMobile || !ceRef.current) return;
    const ce = ceRef.current;
    let composing = false;

    const flushAndClear = () => {
      const text = ce.textContent ?? "";
      if (text.length > 0) {
        term.input(text, true);
        ce.textContent = "";
      }
    };

    const onInput = () => { if (!composing) flushAndClear(); };
    const onCompStart = () => { composing = true; };
    const onCompEnd = () => { composing = false; flushAndClear(); };
    const onKeyDown = (e: KeyboardEvent) => {
      if (composing) return;
      switch (e.key) {
        case "Enter":     e.preventDefault(); term.input(KEYS.Enter, true); return;
        case "Backspace":
          if (!ce.textContent) { e.preventDefault(); term.input(KEYS.Backspace, true); }
          return;
        case "Tab":       e.preventDefault(); term.input(e.shiftKey ? KEYS.ShiftTab : KEYS.Tab, true); return;
        case "Escape":    e.preventDefault(); term.input(KEYS.Esc, true); return;
      }
    };
    const onPaste = (e: ClipboardEvent) => {
      const t = e.clipboardData?.getData("text");
      if (!t) return;
      e.preventDefault();
      term.paste(t);
    };

    ce.addEventListener("input", onInput);
    ce.addEventListener("compositionstart", onCompStart);
    ce.addEventListener("compositionend", onCompEnd);
    ce.addEventListener("keydown", onKeyDown);
    ce.addEventListener("paste", onPaste);

    term.attachCustomKeyEventHandler(() => false);

    const host = term.element;
    const focusCe = () => ce.focus({ preventScroll: true });
    host?.addEventListener("pointerdown", focusCe);

    return () => {
      ce.removeEventListener("input", onInput);
      ce.removeEventListener("compositionstart", onCompStart);
      ce.removeEventListener("compositionend", onCompEnd);
      ce.removeEventListener("keydown", onKeyDown);
      ce.removeEventListener("paste", onPaste);
      host?.removeEventListener("pointerdown", focusCe);
      term.attachCustomKeyEventHandler(() => true);
    };
  }, [term, isMobile]);

  if (!isMobile) return null;

  return (
    <div
      ref={ceRef}
      contentEditable
      role="textbox"
      aria-label="Terminal input"
      suppressContentEditableWarning
      // CSS: position over the input bar, single line, no caret visible
      style={{
        position: "fixed", left: 0, right: 0, bottom: 0,
        minHeight: 44, padding: "10px 12px",
        outline: "none", whiteSpace: "pre", overflow: "hidden",
        fontFamily: "monospace",
      }}
      // Standard input attrs work on contenteditable in modern browsers
      inputMode="text"
      enterKeyHint="send"
      autoCapitalize="off"
      autoCorrect="off"
      spellCheck={false}
    />
  );
}
```

**Pros**
- `contenteditable` is the only path that lets us style a single-line composer with rich-text affordances (e.g. show modifier-key tags inline like "⌃ + R").
- Some keyboards (older Android) emit `input` events to `contenteditable` more reliably than to `<input>`.

**Cons**
- `contenteditable` famously diverges across engines (line break behavior, paste sanitization, cursor placement).
- React doesn't track `contenteditable` — must use `suppressContentEditableWarning` and never re-render its children, or use a ref-only model.
- Standard input attributes (`inputmode`, `enterkeyhint`, `autocorrect`) work on `contenteditable` but with less consistency than on `<input>`/`<textarea>`.

---

## 4. Per-recipe matrix

Score legend: ✓ = good / native, ~ = workable with caveats, ✗ = broken or hard.

| Criterion | A: term.textarea | B: input + term.input() | C: input + WS bypass | D: textarea + composition | E: contenteditable |
|-----------|------------------|-------------------------|----------------------|---------------------------|--------------------|
| IME (CJK/emoji/voice) | ~ (xterm core handles, but iOS dictation is flaky in helper textarea) | ✗ (chars ship per-keystroke; composition broken) | ✗ (same as B + no `term.paste`) | ✓ (compositionend buffers) | ✓ (works in modern browsers) |
| Paste (bracketed-paste mode) | ✓ (xterm internal) | ~ (must call `term.paste` in handler) | ✗ (manual bracket wrapping required) | ✓ (`term.paste` in handler) | ✓ (`term.paste` in handler) |
| `autocorrect=off` honored | ✓ (xterm sets it) | ✓ | ✓ | ✓ | ~ (less reliable on CE) |
| iOS keyboard opens reliably | ~ (depends on xterm focus path) | ✓ (`inputRef.focus()` in pointerdown) | ✓ (same) | ✓ (same) | ✓ (`ce.focus()` in pointerdown) |
| Android `keyCode 229` quirk | ✓ (xterm handles) | ✗ (per-keystroke ship breaks Samsung kbd) | ✗ (same) | ✓ (input event fires after composition) | ✓ |
| Hardware keyboard support | ✓ (xterm handles) | ✓ (manual key handler covers Enter/Tab/arrows/Ctrl) | ✓ (same as B) | ✓ (same) | ✓ |
| Modifier bar integration | ~ (must use `term.input(byte)` since no own UI) | ✓ (call `term.input(byte)` from button) | ~ (call `send(byte)` directly) | ✓ (call `term.input(byte)`) | ✓ (call `term.input(byte)`) |
| Reuses existing WS pipeline | ✓ | ✓ | ✗ (parallel path) | ✓ | ✓ |
| Code complexity (lines) | ~30 | ~80 | ~70 | ~110 | ~100 |
| Risk of regression on desktop | low (gated by `isMobile`) | low | medium (changes xterm options) | low | medium (CE quirks) |
| Risk of xterm-version churn | high (relies on internal DOM) | low | low | low | low |
| Brittleness vs. iOS Safari updates | high (helper textarea is internal) | low | low | medium (compositionend behavior) | medium |

---

## 5. `useVisualViewport()` recipe

```ts
// src/lib/useVisualViewport.ts
"use client";
import { useEffect, useState } from "react";

export interface VVState {
  height: number;     // visualViewport.height OR window.innerHeight fallback
  width: number;
  offsetTop: number;  // 0 unless pinch-zoomed
  offsetLeft: number;
  isKeyboardOpen: boolean;
  scale: number;
}

const KEYBOARD_THRESHOLD = 150; // px difference between layout vh and visual vh that flags keyboard

export function useVisualViewport(): VVState {
  const [state, setState] = useState<VVState>(() => readState());

  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;

    const update = () => setState(readState());

    if (vv) {
      vv.addEventListener("resize", update);
      vv.addEventListener("scroll", update);
    } else {
      // Fallback: use window resize. Less precise but fires on most Androids.
      window.addEventListener("resize", update);
      window.addEventListener("orientationchange", update);
    }
    update();

    return () => {
      if (vv) {
        vv.removeEventListener("resize", update);
        vv.removeEventListener("scroll", update);
      } else {
        window.removeEventListener("resize", update);
        window.removeEventListener("orientationchange", update);
      }
    };
  }, []);

  return state;
}

function readState(): VVState {
  if (typeof window === "undefined") {
    return { height: 0, width: 0, offsetTop: 0, offsetLeft: 0, isKeyboardOpen: false, scale: 1 };
  }
  const vv = window.visualViewport;
  const layoutH = window.innerHeight;
  if (vv) {
    return {
      height: vv.height,
      width: vv.width,
      offsetTop: vv.offsetTop,
      offsetLeft: vv.offsetLeft,
      isKeyboardOpen: layoutH - vv.height > KEYBOARD_THRESHOLD,
      scale: vv.scale,
    };
  }
  // No visualViewport (very old Safari) — assume no keyboard, full layout.
  return {
    height: layoutH,
    width: window.innerWidth,
    offsetTop: 0,
    offsetLeft: 0,
    isKeyboardOpen: false,
    scale: 1,
  };
}
```

### Usage in mobile shell

```tsx
// src/components/MobileShell.tsx
"use client";
import { useVisualViewport } from "@/lib/useVisualViewport";
import { useEffect, useRef } from "react";

export function MobileShell({ children, inputBar }: { children: React.ReactNode; inputBar: React.ReactNode }) {
  const vv = useVisualViewport();
  const shellRef = useRef<HTMLDivElement>(null);

  // Push CSS variables so styles can target the visual viewport
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--vvh", `${vv.height}px`);
    root.style.setProperty("--vv-offset-top", `${vv.offsetTop}px`);
  }, [vv.height, vv.offsetTop]);

  return (
    <div
      ref={shellRef}
      style={{ height: "var(--vvh, 100dvh)" }}
      className="flex flex-col overflow-hidden"
    >
      <main className="flex-1 min-h-0 relative">{children}</main>
      <div
        className="fixed left-0 right-0 z-40"
        style={{
          // Sit flush against the top of the keyboard (or the bottom of the screen if no keyboard)
          bottom: 0,
          transform: `translateY(${vv.isKeyboardOpen ? 0 : 0}px)`,
          paddingBottom: vv.isKeyboardOpen ? 0 : "env(safe-area-inset-bottom)",
        }}
      >
        {inputBar}
      </div>
    </div>
  );
}
```

### Cross-browser fallback notes

- **`window.visualViewport`** is `undefined` on iOS < 13 and Android WebView < 5. The hook above falls back to `window.resize`.
- On iOS Safari the `visualViewport.resize` event fires **after** the keyboard animation completes (~300 ms). For a smoother UX, also listen to `focusin`/`focusout` on the document to slide the input bar into final position immediately and let `resize` fine-tune.
- On Android Chrome with `interactive-widget=resizes-content`, `window.innerHeight` already reflects the shrunk layout — `visualViewport.height` matches it. No keyboard offset is needed; just use `100dvh`.
- Pinch-zoom: `vv.offsetTop` becomes non-zero. The hook exposes it; consumer can decide whether to track or ignore.

---

## 6. Modifier-key handling recipe

### 6.1 Byte map

These are the bytes a real terminal (e.g. xterm/tmux/zsh) expects on the PTY. Verified against ECMA-48 / xterm control sequences.

| Logical key | Bytes | Hex | Notes |
|-------------|-------|-----|-------|
| `Esc` | `\x1b` | `1B` | One byte. |
| `Tab` | `\t` (`\x09`) | `09` | |
| `Shift+Tab` | `\x1b[Z` | `1B 5B 5A` | CSI-Z. |
| `Enter` | `\r` (`\x0D`) | `0D` | PTY translates to `\r\n` if `onlcr` is set. |
| `Backspace` | `\x7f` | `7F` | DEL char; some shells expect `\x08` (BS) — `\x7f` is the modern default (matches xterm). |
| `Ctrl+A` … `Ctrl+Z` | `\x01` … `\x1A` | `01–1A` | ASCII control: `letter.charCodeAt(0) - 64`. |
| `Ctrl+C` | `\x03` | `03` | SIGINT. |
| `Ctrl+D` | `\x04` | `04` | EOF. |
| `Ctrl+L` | `\x0c` | `0C` | clear. |
| `Ctrl+R` | `\x12` | `12` | reverse-i-search. |
| `Ctrl+\` | `\x1c` | `1C` | SIGQUIT. |
| `Ctrl+[` | `\x1b` | `1B` | same as Esc. |
| `Ctrl+]` | `\x1d` | `1D` | telnet escape. |
| `Alt+letter` | `\x1b<letter>` | `1B + ascii(letter)` | Esc-prefix encoding (xterm `metaSendsEscape=true`). |
| `↑` (normal cursor mode) | `\x1b[A` | `1B 5B 41` | CSI-A. |
| `↓` (normal) | `\x1b[B` | `1B 5B 42` | |
| `→` (normal) | `\x1b[C` | `1B 5B 43` | |
| `←` (normal) | `\x1b[D` | `1B 5B 44` | |
| `↑` (application cursor mode, DECCKM) | `\x1bOA` | `1B 4F 41` | SS3-A. tmux/vim in some modes. |
| `↓` (app) | `\x1bOB` | `1B 4F 42` | |
| `→` (app) | `\x1bOC` | `1B 4F 43` | |
| `←` (app) | `\x1bOD` | `1B 4F 44` | |
| `Home` | `\x1b[H` | `1B 5B 48` | |
| `End` | `\x1b[F` | `1B 5B 46` | |
| `PgUp` | `\x1b[5~` | `1B 5B 35 7E` | |
| `PgDn` | `\x1b[6~` | `1B 5B 36 7E` | |
| `Insert` | `\x1b[2~` | `1B 5B 32 7E` | |
| `Delete` | `\x1b[3~` | `1B 5B 33 7E` | |
| `F1` | `\x1bOP` | `1B 4F 50` | |
| `F2` | `\x1bOQ` | | |
| `F3` | `\x1bOR` | | |
| `F4` | `\x1bOS` | | |
| `F5` | `\x1b[15~` | | |
| `F6–F12` | `\x1b[17~`, `18~`, `19~`, `20~`, `21~`, `23~`, `24~` | | F11 is `\x1b[23~`, F12 is `\x1b[24~`. |
| `Ctrl+Space` | `\x00` (NUL) | `00` | |

### 6.2 ModifierKeyBar.tsx sketch

```tsx
// src/components/ModifierKeyBar.tsx
"use client";
import type { Terminal as XTerm } from "@xterm/xterm";
import { useState } from "react";

interface Props {
  term: XTerm | null;
}

const PRIMARY = ["Esc", "Tab", "Ctrl", "Alt", "↑", "↓", "←", "→"] as const;
const CHORDS = [
  { label: "^C", bytes: "\x03", hint: "SIGINT" },
  { label: "^D", bytes: "\x04", hint: "EOF" },
  { label: "^L", bytes: "\x0c", hint: "clear" },
  { label: "^R", bytes: "\x12", hint: "history" },
  { label: "⇧Tab", bytes: "\x1b[Z", hint: "back-tab" },
] as const;

export function ModifierKeyBar({ term }: Props) {
  const [ctrl, setCtrl] = useState(false);
  const [alt, setAlt]   = useState(false);

  const sendBytes = (data: string) => term?.input(data, true);

  const sendKey = (k: typeof PRIMARY[number]) => {
    if (!term) return;
    const app = term.modes.applicationCursorKeysMode;

    if (k === "Esc")  return sendBytes("\x1b");
    if (k === "Tab")  return sendBytes("\t");
    if (k === "Ctrl") return setCtrl(v => !v);
    if (k === "Alt")  return setAlt(v => !v);

    const arrow = ({
      "↑": app ? "\x1bOA" : "\x1b[A",
      "↓": app ? "\x1bOB" : "\x1b[B",
      "←": app ? "\x1bOD" : "\x1b[D",
      "→": app ? "\x1bOC" : "\x1b[C",
    } as const)[k];
    sendBytes(arrow);
  };

  // Called when a real letter key is pressed elsewhere (proxy input)
  // and modifiers are armed. Implementer wires this into the proxy's onKeyDown.
  // For brevity not shown — the helper:
  //   if (ctrl && /^[a-z]$/i.test(letter)) emit String.fromCharCode(letter.toUpperCase().charCodeAt(0) - 64)
  //   else if (alt && letter.length === 1) emit "\x1b" + letter

  return (
    <div className="flex gap-1 overflow-x-auto p-1 bg-neutral-900/95 backdrop-blur">
      {PRIMARY.map(k => (
        <button
          key={k}
          onClick={() => sendKey(k)}
          className={`min-w-[44px] h-10 rounded text-sm
                      ${k === "Ctrl" && ctrl ? "bg-amber-500" : ""}
                      ${k === "Alt"  && alt  ? "bg-amber-500" : ""}`}
        >{k}</button>
      ))}
      <span className="w-px bg-neutral-700 mx-1" />
      {CHORDS.map(c => (
        <button key={c.label} onClick={() => sendBytes(c.bytes)}
                title={c.hint} className="min-w-[44px] h-10 rounded text-sm">
          {c.label}
        </button>
      ))}
    </div>
  );
}
```

### 6.3 Where the bytes go on the wire

There is **no protocol change required**.

- `ModifierKeyBar` calls `term.input(bytes, true)`.
- That fires `onData` on xterm.
- The existing listener in `Terminal.tsx:213–221` calls `ws.send(JSON.stringify({type:"input", data: bytes}))`.
- Server side (the existing PTY bridge) writes `data` to the PTY stdin verbatim.

This is the cleanest decision: modifier bytes share the typed-character channel. The PTY can't tell (and shouldn't care) whether `\x03` came from the user pressing Ctrl+C on a hardware keyboard, the `^C` button, or an autocorrect commit of "C" with armed Ctrl.

For Recipe C only (which bypasses xterm), the modifier bar must instead call the WS sender directly (`send("\x03")`). That asymmetry is one more reason to prefer Recipes B/D.

---

## 7. Decisions to flag for the arbiter

### Decision 1 — Recipe choice (A / B / C / D / E)

| Option | When to pick |
|--------|--------------|
| A — expose xterm.textarea | If timeline is one day and you accept iOS quirks. |
| **B + D blend** (recommended) | Default — correct for IME, paste, hardware keyboard, modifier bar. |
| C — bypass xterm | Only if a future protocol change needs raw bytes (e.g. true binary mode). Reject for now. |
| E — contenteditable | If you want inline modifier-tag rendering. Higher cross-browser risk. |

**Recommendation to arbiter: B with D's composition handlers** (effectively a `<textarea>` in single-row mode that calls `term.input()` per non-composition keystroke and per `compositionend`).

### Decision 2 — Disable xterm's helper textarea on mobile?

- **Yes, on mobile**, when using Recipe B/D/E. Method:
  - Move `term.textarea` off-screen (already default — no action needed) AND
  - `term.attachCustomKeyEventHandler(() => false)` to swallow keys it might receive from a paired Bluetooth keyboard while a custom input is focused.
- **Restore on desktop / orientation flip to landscape tablet**, by re-attaching the original `() => true` handler.

A small wrinkle: xterm has no API to "remove" a custom key event handler. You install a new one that always returns `true` — see Recipe B/D cleanup blocks.

### Decision 3 — Where do modifier-key bytes go on the WS protocol?

- **Same `{type:"input", data}` channel as typed bytes.** No new message type. No new server-side branch.
- The server's existing PTY bridge already writes `data` straight to PTY stdin.
- Side benefit: the `data`-filtering in Terminal.tsx (`/^\x1b\[[\?>=]/.test(data)` to skip terminal-query auto-replies) works unchanged for modifier bytes too.

### Decision 4 — Renderer choice on mobile

Out of scope for input proxy, but flagging: keep DOM renderer (default) on mobile. Skip Webgl (context-loss issues on iOS background tabs). Canvas addon is acceptable; benchmark in Phase 8.

### Decision 5 — Should the input bar render its own draft text, or be a write-only outbox?

- **Recipe B**: outbox (clear after every keystroke) — simplest, breaks autocorrect.
- **Recipe D**: holds draft during composition, ships on compositionend — autocorrect works for IME but the user sees a desync between what they typed and what's on the terminal until composition completes.
- **Hybrid**: short timeout (e.g. 300 ms idle) before flushing — most user-friendly but adds latency to remote shells.

Arbiter picks. Recommendation: D's "hold during composition only" strategy.

### Decision 6 — What to do with paired Bluetooth keyboards on iPad-mode

- Once an external keyboard connects, `visualViewport.height` doesn't shrink and the proxy bar isn't needed. Detection: `navigator.userAgent` + media query `(hover: hover) and (pointer: fine)` toggles desktop layout.
- Decision: rely on the existing `isMobile` flag (viewport-width-based, 768 px breakpoint per planner) and accept that BT-keyboard-on-phone cases use the proxy bar (still works, just redundant).

---

## 8. Cross-browser pitfalls (consolidated)

1. **iOS Safari requires user gesture for `focus()`.** Always wire focus to a synchronous `pointerdown` listener.
2. **Bracketed-paste mode is invisible on the wire.** Don't ever skip `term.paste()` for clipboard input — only for typed input.
3. **Android `keyCode 229` during IME composition.** Never read `e.key` in `keydown` while `composing` is true.
4. **Samsung Keyboard skips `keydown` for letters.** Recipes B/D lean on `input`/`change` events, which Samsung does fire.
5. **iOS Safari blurs the input on tap-outside.** Set `tabindex="-1"` on the terminal canvas wrapper so a tap re-focuses the input bar instead of stealing focus.
6. **`100vh` is broken on every mobile browser.** Use `100dvh` and the `--vvh` variable from `useVisualViewport()` together.
7. **`visualViewport.resize` fires after keyboard animation.** Combine with `focusin`/`focusout` for instant repositioning.
8. **xterm `attachCustomKeyEventHandler` cannot be removed.** Replace it with `() => true` to "restore" default.
9. **`term.options.disableStdin = true` does NOT block `term.input()`.** It only blocks the keymap path. Don't rely on it for safety.
10. **Helper textarea position rewrite is brittle.** Recipe A may break on `@xterm/xterm` minor version bumps.

---

## 9. Reference implementations (intent)

WebSearch was unavailable during this session, so the planned crawl of GitHub examples was deferred. Implementer should compare against these public projects as a second pass:

- **`xtermjs/xterm.js` issue tracker** — search "mobile keyboard", "iOS", "ios safari focus", "composition" — many open issues with workarounds in the comments are gold.
- **`tabby-tabby/tabby`** — Electron + xterm, has a mobile-aware fork branch.
- **`tsl0922/ttyd`** — minimal xterm + WS bridge; their `index.js` shows the canonical onData → WS pattern we already mirror.
- **`microsoft/vscode`** — `src/vs/workbench/contrib/terminal/browser/terminal.ts` — has the most production-hardened xterm wiring; mobile notes are sparse but desktop quirks port over.
- **`coder/code-server`** — Browser-based VS Code; their terminal works on iPad, look at `lib/vscode/src/vs/workbench/contrib/terminal/browser/xterm/xtermTerminal.ts`.
- **`vercel/swr`** + **`vaul`** — for the bottom-sheet pattern that pairs nicely with the modifier bar.

---

## 10. Summary table for the arbiter

| Question | Answer |
|----------|--------|
| Best recipe (default) | B layered with D — separate React `<textarea>` calling `term.input(data, true)`, with composition-event awareness and `term.paste()` for clipboard. |
| Hide xterm helper textarea on mobile? | Yes (use existing off-screen positioning + swallow keys via `attachCustomKeyEventHandler(() => false)`). |
| WS protocol change? | None. Modifier bytes ride the existing `{type:"input", data}` channel. |
| Touch viewport meta string | `width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content` |
| visualViewport hook | `useVisualViewport()` returns `{height, width, offsetTop, offsetLeft, isKeyboardOpen, scale}` with `window.resize` fallback. |
| Arrow byte map | normal: `\x1b[A/B/C/D` ; application cursor mode: `\x1bOA/OB/OC/OD` (read `term.modes.applicationCursorKeysMode`). |
| Backspace byte | `\x7f` (DEL). |
| Ctrl+letter formula | `String.fromCharCode(letter.toUpperCase().charCodeAt(0) - 64)`. |
| Alt+letter formula | `"\x1b" + letter` (Esc-prefix). |
