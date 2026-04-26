# Phase 6 — Mobile Overhaul Integration Plan

> Agent: `planner-integration-mobile`
> Date: 2026-04-26
> Branch: `feat/tmux-streaming-and-mobile`
> Bundle: **"Polished"** (per `05-decision-mobile.md §1`)
> Mode: PLANNING ONLY. No source modified. Phase 7 implementers (WP-A / WP-B / WP-C / WP-D) execute this plan in parallel.
> Citations: scan files → `02-scan-{name}.md §X.Y`; decision → `05-decision-mobile.md §X.Y`; tradeoffs → `04-tradeoffs-mobile.md §X.Y`; source → `path/to/file.tsx:LINE`.

---

## 1. Executive summary

We are converting the existing claude-terminal dashboard from a desktop-first React/Next.js app with a thin mobile veneer (hamburger drawer + 4-tab bottom bar) into a **terminal-first mobile experience** that meets all 11 Mobile UX Targets from `01-planner-mobile.md`. The work is purely additive at viewports `≥768px` (per `05-decision-mobile.md §2.12`); only the `<768px` tier gets new chrome, sheets, and a real software-keyboard input. We adopt the **Polished bundle** from `04-tradeoffs-mobile.md §6.2`: input proxy `IP-B + IP-D` blend (`05 §2.1`), Blink-style modifier-bar gestures (`05 §2.3`), `vaul`-based bottom sheets for Sessions/Chat/Files/Admin/More (`05 §2.5`), `visualViewport` + `100dvh` viewport handling (`05 §2.7`), `viewport-fit=cover` + `interactive-widget=resizes-content` viewport meta (`05 §2.6`), Tailwind v4 z-index tokens via `@theme inline` (`05 §2.9`), and Zustand-backed mutex overlay coordination (`05 §2.10`).

The user's perceptible delta on a 360-px iPhone SE running iOS 16 Safari: tap the terminal canvas → soft keyboard slides up → real on-screen `<textarea>`-backed input appears flush against the keyboard top, with a 14-button modifier bar (Esc/Tab/Ctrl/Alt/↑↓←→/^C/^D/^L/^R/⇧Tab/⋯) sticky just above it. The terminal canvas refits via `FitAddon` to stay above the keyboard so the cursor row never hides. Tapping `≡` opens a vaul drawer with the IconRail+Sessions list; tapping the chat tab opens a bottom sheet with snap points 50%/95%; admin and files use full-height sheets; `Cmd+K` opens the CommandPalette globally regardless of `activeSection` (lifted out of `SessionPanel.tsx`). Russian session names truncate with `...` at `max-w-[150px]` in the Navbar (`Navbar.tsx:79`) and stay readable. Tablet (`768–1023 px`) and desktop (`≥1024 px`) get only the additive viewport-meta and z-index-token changes — visually identical to today.

**Rollout**: gated behind `NEXT_PUBLIC_MOBILE_OVERHAUL_ENABLED` env flag (per `05-decision-mobile.md §9`), defaulting to `false` until Phase 9 audit reaches all-PASS, then flipped to `true` and deployed via `bash /root/projects/claude-terminal/deploy.sh` blue-green. Rollback is one env-var flip + redeploy. Per-component opt-out at runtime via `useMediaQuery`/`useIsMobile` short-circuit means the worst case is "the new viewport meta is in HTML head but no other code paths fire" — which is harmless.

---

## 2. New components (specs)

Each spec gives **path · props · state · mounting parent · dependencies · exact behavior**. Phase 7 implementers MUST follow the prop shapes literally; deviations cause cross-WP coupling drift.

### 2.1 `src/lib/useVisualViewport.ts`  — WP-A (NEW HOOK)

```ts
export interface VisualViewportState {
  height: number;          // window.visualViewport.height (px)
  offsetTop: number;       // window.visualViewport.offsetTop (px)
  isKeyboardOpen: boolean; // (innerHeight - height - offsetTop) > 150
  keyboardHeight: number;  // Math.max(0, innerHeight - height - offsetTop)
}

export function useVisualViewport(): VisualViewportState;
```

- **File path**: `/root/projects/claude-terminal/src/lib/useVisualViewport.ts` (new file).
- **Props/state**: hook (no props). Internal state: a single `VisualViewportState` object.
- **Mounting parent**: hook — consumed in `pos/DashboardLayout.tsx` (root height), `terminal/MobileTerminalInput.tsx` (gate), `terminal/ModifierKeyBar.tsx` (transform), and `pos/MobileBottomBar.tsx` (hide-when-open). Per the decision (`05-decision-mobile.md §5.5`), gated by `useIsMobile()` at consumer sites.
- **Dependencies**: none beyond React. SSR-safe via `typeof window === "undefined"` guard.
- **Exact behavior**:
  - On mount, reads `window.visualViewport?.height` (falls back to `window.innerHeight`) and `window.visualViewport?.offsetTop` (falls back to 0).
  - Subscribes to `window.visualViewport.addEventListener("resize", h)` AND `"scroll"` events, AND falls back to `window.addEventListener("resize", h)` if `visualViewport` is undefined.
  - On every event, recomputes state synchronously and calls `setState`.
  - Side effect: writes three CSS variables to `document.documentElement.style` per `05-decision-mobile.md §12.8`:
    - `--vvh`: `${height}px`
    - `--kbd-height`: `${keyboardHeight}px`
    - `--vv-offset-top`: `${offsetTop}px`
  - These are written every event with `style.setProperty` (sub-microsecond cost; no rAF batching per `05 §12.8`).
  - Returns the state object so consumers can also read it imperatively.
  - On unmount: removes listeners; does NOT clear the CSS variables (other consumers may still need them).
- **A11y**: none directly; consumers must not break a11y when the keyboard opens.
- **RTL/Russian**: irrelevant (no UI surface).

### 2.2 `src/contexts/TerminalIOContext.tsx`  — WP-C (NEW CONTEXT)

```tsx
export interface TerminalIOValue {
  xtermRef: React.MutableRefObject<XTerm | null>;
  wsRef: React.MutableRefObject<WebSocket | null>;
  terminalElementRef: React.MutableRefObject<HTMLDivElement | null>;
  mobileInputRef: React.MutableRefObject<HTMLTextAreaElement | null>;
  sendInput: (data: string) => void;
  requestResize: (cols: number, rows: number) => void;
  isReady: boolean;  // wsRef.current?.readyState === WebSocket.OPEN
}

export const TerminalIOContext = React.createContext<TerminalIOValue | null>(null);
export function TerminalIOProvider({ children }: { children: React.ReactNode }): JSX.Element;
export function useTerminalIO(): TerminalIOValue;
```

- **File path**: `/root/projects/claude-terminal/src/contexts/TerminalIOContext.tsx` (new).
- **Props/state**: provider holds four refs (`useRef<...>(null)`); `isReady` is React state recomputed on WS open/close.
- **Mounting parent**: `src/app/dashboard/page.tsx` line 404 — wraps `<TerminalScrollProvider>` per `05-decision-mobile.md §12.3`. Mount order: `<TerminalIOProvider>` outer → `<TerminalScrollProvider>` inner → CommandPalette → terminal stage → mobile sheets.
- **Dependencies**: React, `@xterm/xterm` types only (TypeScript-side).
- **Exact behavior**:
  - `sendInput(data: string)`:
    1. If `xtermRef.current` AND `wsRef.current?.readyState === WebSocket.OPEN`: call `xtermRef.current.input(data, true)` per `02-scan-terminal.md §7.1 option (A)`. This re-uses the existing `term.onData` listener at `Terminal.tsx:213-221` so the DA/CPR filter at line 217 still applies. Single source of truth for the WS contract.
    2. Else: silently no-op (keystrokes during reconnect are dropped by design — same as desktop).
  - `requestResize(cols, rows)`:
    1. If `wsRef.current?.readyState === WebSocket.OPEN`: `wsRef.current.send(JSON.stringify({type: "resize", cols, rows}))` per WS contract `02-scan-terminal.md §4.1`.
    2. No-op otherwise.
  - The provider does NOT instantiate xterm — `Terminal.tsx` does that, then sets `xtermRef.current = term` and `wsRef.current = ws` inside its `initTerminal` / `connectWs` flows. The provider's refs are filled by the Terminal component on mount.
  - `useTerminalIO()` throws if called outside the provider (defensive — Phase 7 will not encounter this in the planned mount order).
- **A11y**: irrelevant.

### 2.3 `src/stores/overlayStore.ts`  — WP-D (NEW ZUSTAND STORE)

```ts
export type OverlaySlot =
  | "none"
  | "sessionsSheet"
  | "chatSheet"
  | "filesSheet"
  | "adminSheet"
  | "moreDrawer"
  | "hotkeysModal"
  | "commandPalette"
  | "providerWizard"
  | "providerConfig"
  | "imageLightbox";

export interface OverlayStore {
  activeOverlay: OverlaySlot;
  setActiveOverlay: (slot: OverlaySlot) => void;
  closeAll: () => void;
}

export const useOverlayStore: UseBoundStore<StoreApi<OverlayStore>>;
export function useOverlay(slot: OverlaySlot): boolean;  // selector
```

- **File path**: `/root/projects/claude-terminal/src/stores/overlayStore.ts` (new).
- **Props/state**: Zustand store; single state field `activeOverlay`.
- **Mounting parent**: module-level (no JSX provider). Each consumer calls `useOverlay("sessionsSheet")` or `useOverlayStore((s) => s.setActiveOverlay)`.
- **Dependencies**: `zustand` (must add to `package.json` — see §5).
- **Exact behavior**:
  - `setActiveOverlay(slot)`: if `slot !== "none"`, sets state to `slot` (which auto-closes any other slot via the discriminated union). If `slot === "none"`, clears.
  - **Mid-transition flicker mitigation** per `05-decision-mobile.md §10 risk 10`: the setter is synchronous; consumer overlay components MUST treat `useOverlay(mySlot) === false` as "close immediately" without animation queueing — vaul's controlled `open` prop handles this correctly because it accepts `boolean` directly.
  - `closeAll()`: equivalent to `setActiveOverlay("none")`.
  - `useOverlay(slot)`: thin selector that returns `state.activeOverlay === slot` and is reference-stable across renders that don't change the answer.
- **A11y**: none directly. Each overlay component (vaul Drawer / Radix Dialog) supplies its own `aria-modal` + focus-trap.

### 2.4 `src/lib/zIndex.ts`  — WP-A (REPLACES EXISTING `src/lib/z-index.ts`)

```ts
export const Z = {
  BASE: 0,
  CONTENT: 10,
  STICKY: 20,
  SIDEBAR: 30,
  PANEL: 40,
  FLOATING: 50,
  MODAL: 60,
  POPUP: 100,
  PALETTE: 9000,    // renamed from Cmd+K's old 9998 per 05-decision-mobile.md §2.9
  TOAST: 9500,
  NAVBAR: 5000,     // kept for floating-navbar UI lib compat
} as const;

export type ZLayer = keyof typeof Z;
```

- **File path**: existing `/root/projects/claude-terminal/src/lib/z-index.ts` (kept name; spec calls it `zIndex.ts` but we keep the existing kebab-case to avoid import churn). Adds two new keys: `PALETTE` and `TOAST`.
- **Mirroring**: every key in `Z` MUST also exist as a CSS variable in `globals.css`'s `@theme inline { --z-* }` block per `05 §2.9` (so Tailwind generates `z-base`/`z-content`/`z-sticky`/`z-sidebar`/`z-panel`/`z-floating`/`z-modal`/`z-popup`/`z-palette`/`z-toast` utility classes). The dual publish guarantees both inline-style consumers (`style={{ zIndex: Z.MODAL }}`) and Tailwind-class consumers (`className="z-modal"`) pull from one source.
- **Behavior**: pure constants. No runtime effect.

### 2.5 `src/components/mobile/MobileTerminalInput.tsx`  — WP-C (NEW)

```tsx
interface MobileTerminalInputProps {
  // No props — reads everything from contexts/stores.
}
export default function MobileTerminalInput(props: MobileTerminalInputProps): JSX.Element | null;
```

- **File path**: `/root/projects/claude-terminal/src/components/mobile/MobileTerminalInput.tsx` (new). The decision (`05 §5.5`) places it under `src/components/terminal/`; per the prompt I am locating it under `src/components/mobile/` to keep all mobile-only widgets in one folder. WP-C is owner; one folder is fine as long as the import path is consistent. **Frozen path: `src/components/mobile/MobileTerminalInput.tsx`.**
- **Props**: none.
- **State**:
  - `composingRef: useRef<boolean>(false)` — IME composition flag.
  - `taRef: useRef<HTMLTextAreaElement>(null)` — also exposed via `TerminalIOContext.mobileInputRef` so other components (sheets, modifier bar) can focus/blur.
  - `[draft, setDraft] = useState("")` — visible composition draft only; cleared after `compositionend`.
- **Mounting parent**: `src/app/dashboard/page.tsx` inside the terminal stage (page.tsx:404 area, sibling of `<Terminal>`). Renders only when `useIsMobile() === true && useVisualViewport().isKeyboardOpen === true` per `05 §5.5`.
- **Dependencies**: `useTerminalIO()`, `useIsMobile()`, `useVisualViewport()`, `useModifierState()` (§2.7), `lib/mobile-input.ts` (§2.8).
- **Exact behavior** (per `05-decision-mobile.md §12.1` pseudocode):
  - Renders a single `<textarea rows={1}>` with these mandatory attributes per `05 §2.1` and `02-scan-styles.md §6`:
    ```tsx
    <textarea
      ref={taRef}
      value={draft}
      onInput={handleInput}
      onCompositionStart={handleCompositionStart}
      onCompositionEnd={handleCompositionEnd}
      onPaste={handlePaste}
      onKeyDown={handleKeyDown}
      inputMode="text"
      enterKeyHint="send"
      autoCapitalize="off"
      autoCorrect="off"
      spellCheck={false}
      autoComplete="off"
      rows={1}
      aria-label="Ввод в терминал"
      className="
        block w-full
        bg-surface-alt text-foreground placeholder-muted-fg
        text-base                    /* 16px — defeats iOS zoom-on-focus */
        leading-tight
        px-3 py-2.5 h-11             /* 44px tap target */
        outline-none border-0 resize-none
        font-mono
      "
      placeholder="Введите команду…"
    />
    ```
  - Outer wrapper:
    ```tsx
    <div
      role="region"
      aria-label="Мобильный ввод терминала"
      className="
        fixed left-0 right-0
        bottom-[var(--kbd-height,0px)]
        z-floating                   /* Z.FLOATING (50) */
        bg-surface
        border-t border-border
        pb-safe                      /* env(safe-area-inset-bottom) — only when kbd closed */
      "
      style={{ touchAction: "manipulation" }}
    >
      <textarea ... />
      <ModifierKeyBar />            {/* sibling, sticky above keyboard */}
    </div>
    ```
  - `handleInput(e)`:
    1. If `composingRef.current === true`: `setDraft(e.target.value)` and return (don't ship — wait for `compositionend`).
    2. Else: read `v = e.target.value`. If `v === ""` return.
    3. `bytes = applyArmedModifiers(v)` — `lib/mobile-input.ts` (§2.8) maps `Ctrl+a` → `\x01`, `Alt+x` → `\x1bx`, etc. Auto-disarms armed modifiers (unless locked).
    4. `terminalIO.sendInput(bytes)` — re-uses `xtermRef.current.input(bytes, true)` per `02-scan-terminal.md §7.1` option (A).
    5. `setDraft("")`; `e.target.value = ""` (clear immediately so the next keystroke doesn't re-emit the previous letter).
  - `handleCompositionStart()`: `composingRef.current = true`.
  - `handleCompositionEnd(e)`:
    1. `composingRef.current = false`.
    2. `final = e.data ?? taRef.current?.value ?? ""` per `05 §12.1` — Samsung-keyboard fallback.
    3. If `final !== ""`: `terminalIO.sendInput(final)` (composition finals go through unchanged — modifiers do NOT apply to multi-character compositions per `05 §12.1` "modifiers apply to first character only").
    4. `setDraft("")`; `taRef.current.value = ""`.
  - `handlePaste(e)`:
    1. If `e.clipboardData?.types.includes("Files")`: bail — let the existing `Terminal.tsx:336-359` image-paste handler manage it (the paste event bubbles to the terminal container's capture-phase listener).
    2. Else: `text = e.clipboardData.getData("text")`. If empty bail.
    3. `e.preventDefault()` — prevent the textarea from inserting locally.
    4. Call `xtermRef.current?.paste(text)` per `02-scan-terminal.md §7.1` and decision `05 §2.1` — this honors bracketed-paste mode `\x1b[?2004h` if the shell enabled it.
  - `handleKeyDown(e)`:
    1. Only handles Enter and Backspace explicitly; lets every other key fall through to the textarea's normal `input` flow.
    2. `Enter` (no Shift): `e.preventDefault()`. `terminalIO.sendInput("\r")`. (Don't send `\n` — PTY cooked mode handles `\n→\r\n` translation per `05 §2.14`.)
    3. `Shift+Enter`: allow default (multi-line composition continues in the textarea).
    4. `Backspace` when `draft === ""`: `e.preventDefault()`. `terminalIO.sendInput("\x7f")` (DEL byte per xterm convention; `02-scan-terminal.md §4.2`).
    5. Tab/Esc/arrows: do NOT intercept here — those come from `ModifierKeyBar` per `05 §4`.
  - On mount: `taRef.current?.focus({ preventScroll: true })` to trigger the soft keyboard.
  - On unmount: on the **mobile→desktop transition** (when `useIsMobile()` flips false), call `xtermRef.current?.attachCustomKeyEventHandler(() => true)` to restore the desktop default per `05 §10 risk 4 / §12.2`. Also call `xtermRef.current?.attachCustomKeyEventHandler(...)` to RE-INSTALL the original Ctrl+Shift+C copy handler from `Terminal.tsx:299-333` (WP-C must export a re-installer function from `Terminal.tsx` for this purpose).
- **A11y**: `aria-label="Ввод в терминал"`, `role="region"` on outer wrapper. Russian label. Native `<textarea>` is intrinsically focusable and screen-reader compatible.
- **RTL/Russian**: placeholder "Введите команду…" — fits at 360 px (≈ 130 px wide).

### 2.6 `src/components/mobile/ModifierKeyBar.tsx`  — WP-C (NEW)

```tsx
interface ModifierKeyBarProps {
  // No props.
}
export default function ModifierKeyBar(props: ModifierKeyBarProps): JSX.Element | null;
```

- **File path**: `/root/projects/claude-terminal/src/components/mobile/ModifierKeyBar.tsx` (new).
- **Props**: none.
- **State**:
  - `cursorPage: useState<"arrows" | "block">("arrows")` — for the `⋯` page-swap from `05 §4 Group C note`.
  - Auto-repeat timers: `repeatTimerRef: useRef<ReturnType<typeof setInterval> | null>(null)`, `repeatTimeoutRef: useRef<ReturnType<typeof setTimeout> | null>(null)`.
  - Modifier state: read from `useModifierState()` hook (§2.7).
- **Mounting parent**: rendered as a sibling of `MobileTerminalInput`'s textarea inside the same fixed wrapper. Same `useIsMobile() && isKeyboardOpen` gate.
- **Dependencies**: `useTerminalIO()`, `useModifierState()`, `lib/mobile-input.ts` (§2.8) for byte tables.
- **Exact behavior**:
  - 14-key visible row per `05 §4`. Layout:
    ```
    [Esc] [Tab] | [Ctrl] [Alt] | [↑] [↓] [←] [→] | [^C] [^D] [^L] [^R] [⇧Tab] [⋯]
    ```
    Vertical 1-px dividers separate the 4 logical groups.
  - Container CSS:
    ```tsx
    <div
      role="toolbar"
      aria-label="Модификаторы клавиатуры"
      className="
        flex items-stretch gap-1 px-1
        h-11                          /* 44px row */
        bg-surface
        border-t border-border
        overflow-x-auto scrollbar-none
        touch-action: pan-x           /* allow horizontal scroll */
      "
    >
      …buttons…
    </div>
    ```
  - Each button: `min-w-11 h-11 ...`, font-size 14, monospace for arrow glyphs.
  - **Arrow encoding per `05 §4`** must respect DECCKM mode:
    ```ts
    const isApplicationCursor =
      xtermRef.current?.modes.applicationCursorKeysMode === true;
    const upBytes = isApplicationCursor ? "\x1bOA" : "\x1b[A";
    // …same for ↓ ↓ ← →
    ```
    Read `xtermRef.current.modes.applicationCursorKeysMode` at click-time, not at render-time, since the mode changes when vim/tmux/Claude UI activates application cursor mode.
  - **Tap = one-shot** (one PointerEvent cycle):
    ```ts
    onPointerUp = () => {
      if (key.kind === "modifier") {
        modifierState.armCtrl();   // or armAlt; auto-disarms after next char in MobileTerminalInput
      } else {
        terminalIO.sendInput(key.bytes);  // for Esc/Tab/^C/etc.
      }
    };
    ```
  - **Long-press = lock** (≥300 ms hold):
    ```ts
    onPointerDown = () => {
      pressStartRef.current = Date.now();
      lockTimerRef.current = setTimeout(() => {
        if (key.kind === "modifier") modifierState.lockCtrl();  // or lockAlt
      }, 300);
    };
    onPointerUp = () => {
      clearTimeout(lockTimerRef.current);
      if (Date.now() - pressStartRef.current < 300) {
        // Tap path — see above
      }
      // Else lock has already fired during pointerdown
    };
    ```
  - **Hold = auto-repeat** (only for non-modifier keys: arrows, ^R, PgUp, PgDn): on pointerdown after 500 ms, fire the byte every 100 ms until pointerup/pointercancel/pointerleave per `05 §10 risk 9`:
    ```ts
    onPointerDown = () => {
      if (!key.autoRepeat) return;
      terminalIO.sendInput(getBytes(key));   // initial fire
      repeatTimeoutRef.current = setTimeout(() => {
        repeatTimerRef.current = setInterval(() => {
          terminalIO.sendInput(getBytes(key));
        }, 100);
      }, 500);
    };
    onPointerUp = onPointerCancel = onPointerLeave = () => {
      clearTimeout(repeatTimeoutRef.current);
      clearInterval(repeatTimerRef.current);
    };
    ```
    Critical: `pointerleave` must clear the timer (drag-off-button case from `05 §10 risk 9`).
  - **Page-swap** (`⋯` button): toggles `cursorPage` between `"arrows"` and `"block"`. When `"block"`, the four arrow buttons are replaced (in-place, same DOM positions) with `Home / End / PgUp / PgDn` per `05 §4 Group C note`. No animation; instant swap.
  - Active state: when `Ctrl` is armed: button gets `bg-accent-muted text-accent-fg` ring. When locked: same plus a small "lock" dot indicator.
- **A11y**:
  - `role="toolbar" aria-label="Модификаторы клавиатуры"` on outer.
  - Each button: `<button type="button" aria-label="Esc">Esc</button>` etc. — Russian-label-aware (use translate map: `Esc → "Escape"`, `Tab → "Табуляция"`, `Ctrl → "Контрол"`, `Alt → "Альт"`, `↑ → "Стрелка вверх"`, etc.). For brevity, all visible labels stay English/symbols per `05 §12.12` decision; only the screen-reader `aria-label` gets translated.
  - Modifier keys also expose `aria-pressed={armed}` boolean.
- **RTL/Russian**: visible labels are universal symbols / English ASCII per `05 §12.12`. Russian only in `aria-label`.

### 2.7 `src/lib/useModifierState.ts`  — WP-C (NEW HOOK)

```ts
export interface ModifierState {
  ctrl: boolean;          // armed (will apply to next char then auto-disarm)
  alt: boolean;
  ctrlLocked: boolean;    // sticky until manually un-locked
  altLocked: boolean;
  armCtrl: () => void;
  armAlt: () => void;
  lockCtrl: () => void;
  lockAlt: () => void;
  consumeModifiers: () => { ctrl: boolean; alt: boolean };
  // ^ called by MobileTerminalInput.applyArmedModifiers — returns current state
  //   AND auto-disarms ctrl/alt (but not their locked counterparts).
}

export function useModifierState(): ModifierState;
```

- **File path**: `/root/projects/claude-terminal/src/lib/useModifierState.ts` (new).
- **Implementation**: thin wrapper around a small Zustand store (or React context — Zustand preferred to avoid re-rendering the entire subtree on each modifier tap). Exact pattern up to WP-C; the API surface above is binding.
- **Behavior** per `05 §4 Modifier composition`:
  - `armCtrl()`: sets `ctrl: true`. Idempotent.
  - `lockCtrl()`: sets `ctrlLocked: true, ctrl: true`.
  - `consumeModifiers()`: snapshots `{ctrl, alt}`. If `!ctrlLocked`, sets `ctrl: false`. If `!altLocked`, sets `alt: false`. Returns the snapshot.
  - Same for Alt.
  - Tapping a locked modifier again calls `unlockCtrl()` (which sets `ctrlLocked: false, ctrl: false`).

### 2.8 `src/lib/mobile-input.ts`  — WP-C (NEW)

```ts
export function applyArmedModifiers(input: string, ctrl: boolean, alt: boolean): string;
export function ctrlOf(letter: string): string;  // 'a' → '\x01'; out-of-range → letter
export function altOf(char: string): string;     // any → '\x1b' + char

// Static byte tables
export const KEYS = {
  Esc: "\x1b",
  Tab: "\t",
  Enter: "\r",
  Backspace: "\x7f",
  ShiftTab: "\x1b[Z",
  Home: "\x1b[H",
  End: "\x1b[F",
  PgUp: "\x1b[5~",
  PgDn: "\x1b[6~",
  CtrlC: "\x03",
  CtrlD: "\x04",
  CtrlL: "\x0c",
  CtrlR: "\x12",
} as const;

export function arrowBytes(dir: "up" | "down" | "left" | "right", deccm: boolean): string;
```

- **File path**: `/root/projects/claude-terminal/src/lib/mobile-input.ts` (new).
- **Behavior**:
  - `applyArmedModifiers(input, ctrl, alt)` per `05 §4 Modifier composition`:
    - For multi-char `input`: apply modifiers to first character only, then rest unchanged.
    - For single char: if `ctrl && /^[a-zA-Z]$/.test(input)` → `ctrlOf(input)`. Else if `ctrl` → `input` (no chord exists for the given char).
    - Then if `alt`: prepend `\x1b` (Esc-prefix per `xterm metaSendsEscape=true`, `03-research-xterm-proxy.md §6.1`).
  - `ctrlOf("a")` → `String.fromCharCode("a".toUpperCase().charCodeAt(0) - 64)` → `\x01`. `ctrlOf("z")` → `\x1A`.
  - `arrowBytes("up", true)` → `\x1bOA`; `arrowBytes("up", false)` → `\x1b[A`.

### 2.9 `src/components/mobile/MobileSessionsSheet.tsx`  — WP-D (NEW)

```tsx
interface MobileSessionsSheetProps {
  // Reads sessionId etc. from page-level via prop drilling — see mounting.
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onSessionDeleted: (id: string) => void;
  onNewSession: (slug: string) => void;
  onOpenFiles?: (id: string) => void;
  onResumeSession?: (id: string) => void;
  resumingSessionId?: string | null;
  creatingSession?: boolean;
}
export default function MobileSessionsSheet(props: MobileSessionsSheetProps): JSX.Element;
```

- **File path**: `/root/projects/claude-terminal/src/components/mobile/MobileSessionsSheet.tsx` (new).
- **Props**: same callback shape as the existing `SessionPanel.tsx:28-37` so we can pass through from `dashboard/page.tsx` without remapping.
- **State**: none in the wrapper itself.
- **Mounting parent**: `dashboard/page.tsx`, sibling of `<Terminal>`, gated by `useIsMobile()` per `05 §5.5`.
- **Dependencies**: `vaul` (`Drawer.Root`, `Drawer.Trigger`, `Drawer.Portal`, `Drawer.Overlay`, `Drawer.Content`), `useOverlayStore`, the existing `SessionPanel`.
- **Exact behavior**:
  ```tsx
  const open = useOverlay("sessionsSheet");
  const setActiveOverlay = useOverlayStore(s => s.setActiveOverlay);
  return (
    <Drawer.Root
      open={open}
      onOpenChange={(o) => setActiveOverlay(o ? "sessionsSheet" : "none")}
      direction="bottom"
      snapPoints={[0.4, 0.9]}
      shouldScaleBackground
      dismissible
    >
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 bg-black/50 z-modal" />
        <Drawer.Content
          className="fixed inset-x-0 bottom-0 z-modal h-[90vh] bg-surface
                     rounded-t-2xl flex flex-col pb-safe"
          aria-label="Сессии"
        >
          <div className="mx-auto h-1.5 w-12 my-2 rounded-full bg-border" />
          <SessionPanel {...props} />
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
  ```
- **A11y**: vaul wraps Radix Dialog, inheriting `role="dialog"`, `aria-modal="true"`, focus-trap, scroll-lock, Esc-to-close. WP-D adds `aria-label="Сессии"` on the Content.
- **RTL/Russian**: drag handle visible; SessionPanel is already Russian-localized.

### 2.10 `src/components/mobile/MobileChatSheet.tsx`  — WP-D (NEW)

Same pattern as §2.9.

```tsx
interface MobileChatSheetProps {
  onImageClick?: (src: string) => void;
}
```

- **File path**: `/root/projects/claude-terminal/src/components/mobile/MobileChatSheet.tsx` (new).
- **Slot**: `"chatSheet"`.
- **Snap points**: `[0.5, 0.95]` per `05 §5.3`.
- **Wraps**: `<ChatPanel onImageClick={...} />`.
- **`aria-label`**: "Чат".

### 2.11 `src/components/mobile/MobileMoreSheet.tsx`  — WP-D (NEW)

Drawer for displaced Symphony/System tabs + Hub/Config/Skills/Memory + Hotkeys + Logout per `05 §2.4`.

```tsx
interface MobileMoreSheetProps {
  onLogout: () => void;
}
```

- **File path**: `/root/projects/claude-terminal/src/components/mobile/MobileMoreSheet.tsx` (new).
- **Slot**: `"moreDrawer"`.
- **Direction**: `"left"` per `05 §5.3` ("More drawer from left edge"). Actually, re-reading the decision (`05 §5.5`) shows MoreDrawer is `direction="left"`. Frozen: **left-edge drawer with the IconRail content + secondary nav**.
- **Content**: full IconRail (sections sessions/hub/config/skills/memory/symphony/system) + footer (theme toggle / hotkeys / logout). Reuses existing `IconRail.tsx` rendering inline (no nesting — copy the layout into the sheet to avoid the IconRail's own `HotkeysModal` mount which is being removed per WP-B).
- Tap on a section: `setActiveSection(...)`, `setActiveOverlay("none")` to close the drawer.
- Tap on "Горячие клавиши": `setActiveOverlay("hotkeysModal")`.
- Tap on "Выйти": calls `onLogout`.
- **`aria-label`**: "Главное меню".

### 2.12 `src/components/mobile/MobileFilesSheet.tsx`  — WP-D (NEW)

```tsx
interface MobileFilesSheetProps {
  sessionId: string;
  initialFile?: string | null;
}
```

- **File path**: `/root/projects/claude-terminal/src/components/mobile/MobileFilesSheet.tsx` (new).
- **Slot**: `"filesSheet"`.
- **Snap points**: `[1]` (full-height) per `05 §5.5`.
- **Wraps**: `<FileManager sessionId={...} initialFile={...} visible={true} />` — `visible` always true while sheet is mounted (vaul handles open/close).
- **`aria-label`**: "Файлы".
- Note: this wrapper is NEW but unused if `viewMode === "files"` already shows FileManager via the legacy stage path. The mobile pattern per `05 §5.5` is to render `<MobileFilesSheet/>` instead of the legacy `m-1 md:m-2`-wrapped `<FileManager>` when on mobile. WP-D coordinates this in `dashboard/page.tsx` (replacing lines 386-390 with a conditional: `isMobile ? <MobileFilesSheet/> : (legacy path)`).

### 2.13 `src/components/mobile/MobileAdminSheet.tsx`  — WP-D (NEW)

```tsx
interface MobileAdminSheetProps {
  onPendingCountChange?: (count: number) => void;
}
```

- **File path**: `/root/projects/claude-terminal/src/components/mobile/MobileAdminSheet.tsx` (new).
- **Slot**: `"adminSheet"`.
- **Snap points**: `[1]` (full-height).
- **Wraps**: `<AdminPanel onPendingCountChange={...} />`.
- **`aria-label`**: "Пользователи".

### 2.14 `src/components/CommandPalette.tsx`  — WP-D (NEW; LIFTED FROM `SessionPanel.tsx:484-540`)

```tsx
interface CommandPaletteProps {
  // No props — gets sessions, activeSessionId, onSelectSession from
  // contexts/zustand. Specifically:
  //   - sessions list: keep a per-page useState (already in dashboard/page.tsx)
  //   - selection callback: from page-level context (new: WorkspaceContext or
  //     direct prop drilling into a small CommandPaletteProvider)
}
export default function CommandPalette(): JSX.Element | null;
```

- **File path**: `/root/projects/claude-terminal/src/components/CommandPalette.tsx` (new).
- **Mounting parent**: `dashboard/page.tsx` line 404 (sibling of `<TerminalScrollProvider>`) per `05 §2.11` and `§5.5`.
- **State**:
  - `query: useState("")`, `index: useState(0)` (carry over from `SessionPanel.tsx:79-80`).
  - Reads `useOverlayStore.activeOverlay === "commandPalette"` for the open state.
- **Dependencies**: `useOverlayStore`, the page-level sessions array (passed via a thin context — see below), `lib/zIndex.ts` (`Z.PALETTE = 9000`).
- **Exact behavior** (carries over from `SessionPanel.tsx:484-555` verbatim except for two differences):
  1. **Open state lives in `overlayStore`**, not in `paletteOpen` local state.
  2. **Keydown listener gets the `e.target.tagName` guard per `05 §2.11`**:
     ```ts
     useEffect(() => {
       const onKey = (e: KeyboardEvent) => {
         const t = e.target as HTMLElement | null;
         const tag = t?.tagName;
         const isInputLike =
           tag === "INPUT" || tag === "TEXTAREA" || t?.isContentEditable;
         if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
           if (isInputLike) return;          // ← GUARD per 05 §2.11 / §5
           e.preventDefault();
           setActiveOverlay(activeOverlay === "commandPalette" ? "none" : "commandPalette");
           return;
         }
         if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && /^[1-9]$/.test(e.key)) {
           if (isInputLike) return;
           const active = sessions.filter(s => s.isActive);
           const idx = Number(e.key) - 1;
           if (active[idx]) { e.preventDefault(); onSelectSession(active[idx].sessionId); }
         }
         if (e.key === "Escape" && useOverlayStore.getState().activeOverlay === "commandPalette") {
           setActiveOverlay("none");
         }
       };
       window.addEventListener("keydown", onKey);
       return () => window.removeEventListener("keydown", onKey);
     }, [sessions, onSelectSession]);
     ```
  3. **Z-index** moves from inline `z-[9998]` (SessionPanel.tsx:514) to `z-palette` (Z.PALETTE = 9000) per `05 §4`. CommandPalette is still above modals (60) and toasts (9500 only above palette in the ordering — wait, 9500 > 9000, so toasts are above palette. Recheck: `05 §2.9` lists `--z-palette: 9000` and `--z-toast: 9500`. So toasts beat palette. This is intentional — toasts are transient and should always appear).
  4. **Sessions data source**: WP-D introduces a tiny `WorkspaceContext` (or just lifts the sessions array via prop drilling — see the rendered code below). To minimize churn, **prop drilling**: `dashboard/page.tsx` passes `sessions` and `onSelectSession` to `<CommandPalette sessions={sessions} onSelectSession={handleSelectSession} />`. Update prop signature accordingly.
  5. Final prop signature, frozen:
     ```ts
     interface CommandPaletteProps {
       sessions: Session[];
       onSelectSession: (sessionId: string) => void;
     }
     ```
- **Rendering**: identical to `SessionPanel.tsx:514-554` except `z-[9998]` → `z-palette`. Uses controlled state from `overlayStore`.
- **A11y**: `role="dialog" aria-modal="true" aria-label="Командная палитра"` added to the overlay div (was missing in the original per `02-scan-navigation.md §1.2`).
- **RTL/Russian**: existing placeholder "Поиск сессии…" preserved.

---

## 3. Per-file change plan

For each file: **path · WP owner · read-only or mutable for others · affected lines · diff intent · new imports · a11y/RTL**.

### 3.1 `src/app/layout.tsx` — WP-A

- **Owner**: WP-A (`impl-layout-shell`).
- **Read-only for**: WP-B, WP-C, WP-D.
- **Affected lines**: 1, 21-24.
- **Diff intent**: add `viewport` Metadata export per `05 §2.6` exact frozen string. Add `Viewport` import. Add `themeColor`. Do NOT touch the `dark` class on `<html>` (`layout.tsx:35`) or the `themeScript` (`layout.tsx:27, 37`). Do NOT add a manual `<meta name="viewport">` — Next.js 16 emits it from the export.
  - **Add at top imports**:
    ```tsx
    import type { Metadata, Viewport } from "next";
    ```
  - **Add after `metadata` export at line 24**:
    ```tsx
    export const viewport: Viewport = {
      width: "device-width",
      initialScale: 1,
      viewportFit: "cover",
      interactiveWidget: "resizes-content",
      themeColor: "#000000",
    };
    ```
- **New imports**: `type Viewport` from `"next"`.
- **A11y/RTL**: `themeColor: "#000000"` matches the `dark` theme background; in retro theme the status bar will mismatch slightly (acceptable per `05 §2.6`). RU UI remains lang="ru".

### 3.2 `src/app/globals.css` — WP-A

- **Owner**: WP-A.
- **Read-only for**: WP-B (consumes `pb-safe`), WP-C (consumes `--vvh`, `--kbd-height`), WP-D (consumes `z-modal`/`z-floating` etc.).
- **Affected lines**: insert blocks; do not modify existing `.xterm` or `.md-viewer` rules.
- **Diff intent**:
  1. Extend `@theme inline` block (lines 3-48) with z-index tokens **and `--vvh` fallback**:
     ```css
     @theme inline {
       /* …existing tokens (lines 4-47)… */

       /* Z-index tokens — mirror src/lib/z-index.ts per 05 §2.9 */
       --z-base: 0;
       --z-content: 10;
       --z-sticky: 20;
       --z-sidebar: 30;
       --z-panel: 40;
       --z-floating: 50;
       --z-modal: 60;
       --z-popup: 100;
       --z-palette: 9000;   /* renamed from old z-[9998] */
       --z-toast: 9500;
       --z-navbar: 5000;
     }
     ```
  2. Add safe-area `@utility` block (Tailwind v4 syntax per `05 §2.8`) right after `@theme inline`:
     ```css
     @utility pt-safe { padding-top: env(safe-area-inset-top); }
     @utility pb-safe { padding-bottom: env(safe-area-inset-bottom); }
     @utility pl-safe { padding-left: env(safe-area-inset-left); }
     @utility pr-safe { padding-right: env(safe-area-inset-right); }
     @utility h-safe-bottom { height: env(safe-area-inset-bottom); }
     @utility min-h-safe-bottom { min-height: env(safe-area-inset-bottom); }
     ```
  3. Augment `body` rule (lines 152-156):
     ```css
     body {
       background: var(--color-background);
       color: var(--color-foreground);
       font-family: var(--font-sans), system-ui, sans-serif;
       /* MOBILE additions per 05 §2.7, 02-scan-styles.md §6 */
       overscroll-behavior: contain;
       -webkit-tap-highlight-color: transparent;
     }
     ```
  4. Add a `.terminal-host` utility for the terminal stage container (consumed by `Terminal.tsx` wrapper or `dashboard/page.tsx:405`):
     ```css
     .terminal-host {
       touch-action: manipulation;
     }
     ```
  5. Add a global `input, textarea, select { font-size: 16px; }` rule **scoped to mobile** to defeat iOS zoom-on-focus per `05 §2.13`:
     ```css
     /* Mobile zoom-on-focus prevention — applies to all viewports
        (16px is acceptable on desktop too per 05 §2.13). */
     @media (max-width: 767px) {
       input:not([type="checkbox"]):not([type="radio"]),
       textarea,
       select {
         font-size: 16px !important;
       }
     }
     ```
  6. Add the `--vvh` fallback declaration on `:root` (so CSS works before JS hook fires):
     ```css
     :root {
       --vvh: 100dvh;
       --kbd-height: 0px;
       --vv-offset-top: 0px;
     }
     ```
  7. **Do NOT remove** `.presence-active { cursor: none !important; }` — `05 §10` and `02-scan-terminal.md §6.3` flag this as a potential mobile-input caret issue, but mobile devices have no cursor anyway. Verification by WP-C in Phase 8 will confirm; if a regression appears, gate the rule with `@media (hover: hover)`.
- **New imports**: none (pure CSS).
- **A11y/RTL**: irrelevant.

### 3.3 `src/app/dashboard/page.tsx` — WP-D (overlay/provider section); shares context with WP-C

- **Owner**: WP-D for the overlay-mount section (lines 494-521 and any new `<MobileXxxSheet>` mounts) AND the `<TerminalIOProvider>` wrap; WP-C **must read** the file to verify the context wrap.
- **Read-only for**: WP-A, WP-B.
- **Affected lines**: 22, 53-60, 382, 384-484, 494-521.
- **Diff intent**:
  1. **Imports** (line 22 and new):
     ```tsx
     import { TerminalIOProvider } from "@/contexts/TerminalIOContext";
     import { useOverlayStore } from "@/stores/overlayStore";
     import CommandPalette from "@/components/CommandPalette";
     import MobileSessionsSheet from "@/components/mobile/MobileSessionsSheet";
     import MobileChatSheet from "@/components/mobile/MobileChatSheet";
     import MobileFilesSheet from "@/components/mobile/MobileFilesSheet";
     import MobileAdminSheet from "@/components/mobile/MobileAdminSheet";
     import MobileMoreSheet from "@/components/mobile/MobileMoreSheet";
     import MobileTerminalInput from "@/components/mobile/MobileTerminalInput";
     import { useIsMobile } from "@/lib/useIsMobile";
     // useVisualViewport is consumed transitively via the components above.
     ```
  2. **`<TerminalIOProvider>` wrap** at line 404 area. The current code is:
     ```tsx
     <TerminalScrollProvider>
       <div ref={contentRef} className={...}>
         …
       </div>
     </TerminalScrollProvider>
     ```
     Becomes per `05 §12.3`:
     ```tsx
     <TerminalIOProvider>
       <TerminalScrollProvider>
         <div ref={contentRef} className={...}>
           …
           <Terminal key={...} sessionId={...} fullscreen={...} onConnectionChange={...} />
           {isMobile && <MobileTerminalInput />}    {/* new */}
         </div>
       </TerminalScrollProvider>
     </TerminalIOProvider>
     ```
  3. **Sheet mounts** — add to the `<div className="flex-1 relative">` content area (line 382):
     ```tsx
     {isMobile && (
       <>
         <MobileSessionsSheet
           activeSessionId={activeSessionId}
           onSelectSession={handleSelectSession}
           onSessionDeleted={handleSessionDeleted}
           onNewSession={handleNewSession}
           onOpenFiles={handleOpenFiles}
           onResumeSession={handleResumeSession}
           resumingSessionId={resumingSessionId}
           creatingSession={creatingSession}
         />
         <MobileChatSheet onImageClick={(src) => setLightboxSrc(src)} />
         <MobileMoreSheet onLogout={handleLogout} />
         {activeSessionId && <MobileFilesSheet sessionId={activeSessionId} initialFile={initialFile} />}
         {isAdmin && <MobileAdminSheet onPendingCountChange={setPendingCount} />}
       </>
     )}
     ```
  4. **CommandPalette mount** (sibling of `<TerminalScrollProvider>`):
     ```tsx
     <CommandPalette sessions={sessions} onSelectSession={handleSelectSession} />
     ```
  5. **Replace the existing `<AnimatePresence>` slide-overs** at lines 494-521 with a desktop-only conditional wrap:
     ```tsx
     {!isMobile && (
       <AnimatePresence>
         {adminOpen && isAdmin && (
           /* existing admin slide-over markup at lines 494-506 */
         )}
       </AnimatePresence>
     )}
     {!isMobile && (
       <AnimatePresence>
         {chatOpen && (
           /* existing chat slide-over markup at lines 509-521 */
         )}
       </AnimatePresence>
     )}
     ```
  6. **Wire the existing `chatOpen` / `adminOpen` toggles to `overlayStore` on mobile**: when `chatOpen` becomes `true` and `isMobile`, `setActiveOverlay("chatSheet")`. Use a small effect:
     ```tsx
     useEffect(() => {
       if (!isMobile) return;
       if (chatOpen) useOverlayStore.getState().setActiveOverlay("chatSheet");
       else if (useOverlayStore.getState().activeOverlay === "chatSheet")
         useOverlayStore.getState().setActiveOverlay("none");
     }, [chatOpen, isMobile]);
     // …same for adminOpen → "adminSheet"
     // …and the inverse: when overlayStore changes away from "chatSheet"/"adminSheet"
     //   on mobile, also set chatOpen/adminOpen to false (single source of truth).
     // To keep this small, WP-D may instead REPLACE the chatOpen state entirely on mobile
     // with a derived value: useOverlay("chatSheet"). But that requires Navbar to also
     // consume overlayStore, which is WP-B work. Recommended: keep the bidirectional
     // sync effect for v1; cleanup deferred.
     ```
  7. **Files-view mobile route**: replace lines 386-390 with:
     ```tsx
     {!isMobile && (
       <div className={`absolute inset-0 m-1 md:m-2 ${viewMode === "files" ? "" : "hidden"}`}>
         <div className="w-full h-full rounded-xl border border-accent/20 bg-surface-alt overflow-hidden">
           <FileManager sessionId={activeSessionId} initialFile={initialFile} visible={viewMode === "files"} />
         </div>
       </div>
     )}
     ```
     On mobile, `MobileFilesSheet` (mounted in step 3) handles files via `overlayStore`.
- **New imports**: see step 1.
- **A11y/RTL**: each sheet supplies its own `aria-label` per §2.9-§2.13.

### 3.4 `src/app/global-error.tsx` — WP-A

- **Owner**: WP-A.
- **Affected line**: 12.
- **Diff intent**: change inline `style={{ height: "100vh" }}` → `style={{ height: "100dvh" }}` per `05-decision-mobile.md §8 WP-A`.
- **A11y/RTL**: irrelevant.

### 3.5 `src/components/pos/DashboardLayout.tsx` — SHARED (WP-A on lines 49,53; WP-B on lines 55-114)

- **Shared file** per `05 §8 disjointness check`. WP-A and WP-B operate on **disjoint line ranges**.
- **WP-A — affected lines 48-53**:
  - Replace `flex h-screen bg-background` (line 49) with `flex bg-background` PLUS inline style `style={{ height: "var(--vvh, 100dvh)" }}`. Same edit at line 53. Final form:
    ```tsx
    if (fullscreen) {
      return (
        <div
          className="flex bg-background"
          style={{ height: "var(--vvh, 100dvh)" }}
        >{children}</div>
      );
    }
    return (
      <div
        className="flex bg-background"
        style={{ height: "var(--vvh, 100dvh)" }}
      >
        …
      </div>
    );
    ```
  - Add `useVisualViewport()` call at the top of the component **only to register the hook** (the CSS-var write is the side effect — no need to consume the returned state in this file):
    ```tsx
    import { useVisualViewport } from "@/lib/useVisualViewport";
    ...
    export default function DashboardLayout(...) {
      useVisualViewport();          // registers listeners + writes --vvh
      const { panelOpen } = useNavigation();
      ...
    }
    ```
- **WP-B — affected lines 55-114** (mobile drawer refactor):
  - Replace the entire `<AnimatePresence>` block at lines 72-114 with a vaul `<Drawer.Root direction="left">` controlled by `useOverlay("moreDrawer")`. The drawer content is the existing IconRail + 280-px SidePanel layout, kept verbatim — just rendered inside vaul's `<Drawer.Content>` instead of the bespoke `motion.div`.
  - Wire `mobileSidebarOpen` (passed from `dashboard/page.tsx:358`) to `overlayStore.activeOverlay === "moreDrawer"` via a local effect:
    ```tsx
    useEffect(() => {
      if (mobileSidebarOpen && useOverlayStore.getState().activeOverlay !== "moreDrawer")
        useOverlayStore.getState().setActiveOverlay("moreDrawer");
      else if (!mobileSidebarOpen && useOverlayStore.getState().activeOverlay === "moreDrawer")
        useOverlayStore.getState().setActiveOverlay("none");
    }, [mobileSidebarOpen]);
    ```
    And vice versa in vaul's `onOpenChange`. (Same bidirectional sync pattern as ChatSheet — `dashboard/page.tsx` continues to control `mobileSidebarOpen` for legacy code paths; overlayStore is the new source of truth.)
  - Final shape:
    ```tsx
    <Drawer.Root
      direction="left"
      open={useOverlay("moreDrawer")}
      onOpenChange={(o) => {
        useOverlayStore.getState().setActiveOverlay(o ? "moreDrawer" : "none");
        if (!o) onCloseMobileSidebar();
      }}
    >
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 bg-black/60 z-sidebar md:hidden" />
        <Drawer.Content
          className="fixed top-0 left-0 bottom-0 z-panel md:hidden flex
                     bg-surface border-r border-border pt-safe pb-safe"
          aria-label="Боковая панель"
        >
          <IconRail onLogout={onLogout} systemAlerts={systemAlerts} />
          <div className="w-[280px] bg-surface relative">
            <div className="absolute top-3 right-3 z-floating">
              <button onClick={() => useOverlayStore.getState().setActiveOverlay("none")} className="p-2 text-muted-fg hover:text-foreground transition-colors" aria-label="Закрыть"><X className="w-5 h-5" /></button>
            </div>
            <SidePanel
              activeSessionId={activeSessionId}
              onSelectSession={onSelectSession}
              onSessionDeleted={onSessionDeleted}
              onNewSession={onNewSession}
              onOpenFiles={onOpenFiles}
              onResumeSession={onResumeSession}
              resumingSessionId={resumingSessionId}
              creatingSession={creatingSession}
            />
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
    ```
- **MobileBottomBar mount** at line 122: keep as-is (WP-B owns MobileBottomBar.tsx itself, see §3.6).
- **A11y/RTL**: vaul + Radix supply `aria-modal`, focus-trap, Esc handler. New Russian `aria-label`s added.

### 3.6 `src/components/pos/MobileBottomBar.tsx` — WP-B

- **Owner**: WP-B.
- **Affected lines**: 7-12, 22-30, 32-80.
- **Diff intent** per `05 §2.4`:
  1. **Repurpose `MAIN_TABS`** (lines 7-12):
     ```tsx
     const MAIN_TABS = [
       { id: "terminal" as const, icon: TerminalIcon, label: "Терминал" },
       { id: "sessions" as const, icon: ListIcon,     label: "Сессии"   },
       { id: "chat"     as const, icon: MessageCircle, label: "Чат"     },
       { id: "more"     as const, icon: MoreHorizontal, label: "Ещё"    },
     ];
     ```
     (Replace the existing sessions/hub/symphony/system tabs.)
  2. **Tab handlers** (lines 26-30 area):
     ```tsx
     import { useOverlayStore } from "@/stores/overlayStore";
     ...
     const setActiveOverlay = useOverlayStore(s => s.setActiveOverlay);
     const handleTab = (tab: "terminal" | "sessions" | "chat" | "more") => {
       switch (tab) {
         case "terminal":
           setActiveSection("sessions");      // sessions section but no overlay
           setActiveOverlay("none");
           break;
         case "sessions":
           setActiveOverlay("sessionsSheet");
           break;
         case "chat":
           setActiveOverlay("chatSheet");
           break;
         case "more":
           setActiveOverlay("moreDrawer");
           break;
       }
     };
     ```
  3. **Hide bar when keyboard open** per `05 §5.1 note` and `§12.6`:
     ```tsx
     import { useVisualViewport } from "@/lib/useVisualViewport";
     ...
     const { isKeyboardOpen } = useVisualViewport();
     if (isKeyboardOpen) return null;          // unmount entirely
     ```
  4. **Safe-area** (line 56 wrapper): add `pb-safe`:
     ```tsx
     <div className="md:hidden h-14 border-t border-border bg-surface flex items-center justify-around px-2 pb-safe">
     ```
  5. **Remove the existing "Ещё" overflow popover** (lines 35-53). The `more` tab now opens `MobileMoreSheet` (full vaul drawer with all secondary nav).
  6. **Tap target sizing**: each button stays at `flex flex-col items-center gap-0.5 px-3 py-1` — already 44+ px on mobile.
  7. **Active-tab indicator**: bind to `useOverlay(...)` for sheet tabs, `activeSection === "sessions" && activeOverlay === "none"` for terminal tab.
- **New imports**: `useOverlayStore`, `useVisualViewport`, new icons (`ListIcon`, `MessageCircle` already exist; remove unused `BookOpen`, `Music`, `Monitor`, `Settings`, `Puzzle`, `Brain`).
- **A11y/RTL**: `<div role="tablist" aria-label="Главная навигация">` on outer; each button gets `role="tab" aria-selected={...}`. Russian labels fit at 360 px (≤ 7 chars each).

### 3.7 `src/components/Navbar.tsx` — WP-B

- **Owner**: WP-B.
- **Affected lines**: 49, 67-74, 142-173.
- **Diff intent**:
  1. **Tap-target bumps** per `05-decision-mobile.md §8 WP-B` and `04-tradeoffs-mobile.md §10.1`: change `p-2` → `p-2.5` on all icon buttons (lines 70, 144, 163) so the box is `p-2.5 + w-5 h-5 = 40 px` — still under 44 px, but combined with the inner icon padding gives a comfortable hit. **Frozen: bump to `p-2.5` and accept ~40 px hit area; if Phase 8c automated assert at 44 px fails, raise to `p-3`.**
  2. **`aria-label`** on every icon-only button:
     ```tsx
     <button onClick={onMenuClick} aria-label="Открыть меню" className="md:hidden p-2.5 -ml-1 …">
       <Menu className="w-5 h-5" />
     </button>
     ```
     Same for chat (`aria-label="Чат"`), admin (`aria-label="Пользователи"`), fullscreen toggle (already in `dashboard/page.tsx:407-413` — that's a separate file, leave as-is for WP-D / future).
  3. **Hamburger wiring**: keep `onMenuClick` prop. The page-level `onMenuClick` (`dashboard/page.tsx:369`) still calls `setMobileSidebarOpen(true)`; on mobile that triggers the bidirectional sync to `overlayStore.activeOverlay = "moreDrawer"` per §3.5 step 2. No Navbar change needed.
  4. **No z-index literals to fix in Navbar** (the file uses none).
- **New imports**: none.
- **A11y/RTL**: Russian `aria-label`s as specified.

### 3.8 `src/components/pos/IconRail.tsx` — WP-B

- **Owner**: WP-B.
- **Affected lines**: 7, 27, 31-38, 81-87, 97.
- **Diff intent** per `05-decision-mobile.md §8 WP-B`:
  1. **Move `HotkeysModal` mount out of IconRail** to `dashboard/page.tsx`. Per `05 §12.4`, HotkeysModal is not extracted; only its mount migrates. So in IconRail.tsx:
     - Remove `import HotkeysModal from "@/components/HotkeysModal"` (line 7).
     - Remove `const [hotkeysOpen, setHotkeysOpen] = useState(false)` (line 27).
     - Remove `<HotkeysModal open={hotkeysOpen} onClose={() => setHotkeysOpen(false)} />` (line 97).
     - Change the keyboard button (lines 81-87) to invoke `useOverlayStore.getState().setActiveOverlay("hotkeysModal")`.
  2. Add `useOverlayStore` import.
  3. **Tap targets**: section icons are already `w-10 h-10` (40 px); leave at `w-10 h-10`. The decision (`05 §6 #9`) requires ≥44; on the IconRail this is desktop-only (it's hidden on mobile via `hidden md:flex` parent). **No change needed for mobile compliance** because IconRail is desktop-only. On mobile, the same component is rendered inside `MobileMoreSheet.tsx` (§2.11) where the `w-10 h-10` is acceptable inside the larger sheet.
  4. **`section-click` handler** (lines 31-38): no change to logic, but add an effect to close the More drawer when a section is clicked from inside the More sheet — actually this is handled in `MobileMoreSheet.tsx` (§2.11 calls `setActiveOverlay("none")` after section change). IconRail itself stays unchanged here.
- **New imports**: `useOverlayStore`. Remove `HotkeysModal`.
- **Mount migration target**: WP-D's CommandPalette/HotkeysModal mount block in `dashboard/page.tsx`:
  ```tsx
  <HotkeysModal open={useOverlay("hotkeysModal")} onClose={() => setActiveOverlay("none")} />
  ```
  Add to `dashboard/page.tsx` near the lightbox mount (line 525).
- **A11y/RTL**: existing `aria-label={label}` (line 58) preserved.

### 3.9 `src/components/pos/SidePanel.tsx` — WP-B

- **Owner**: WP-B.
- **Affected lines**: 37 (verify).
- **Diff intent**: NO behavior change. WP-B reads the file to verify that the `activeSection` switch (lines 38-55) renders correctly when invoked from inside a vaul Drawer (it does — the dispatcher is pure). No edits expected.
- **A11y/RTL**: irrelevant.

### 3.10 `src/components/pos/SessionPanel.tsx` — WP-D (CommandPalette extraction)

- **Owner**: WP-D.
- **Affected lines**: 78-80, 226-250, 459-468, 484-555.
- **Diff intent** per `05 §2.11 / §10 risk 5 / §12.4`:
  1. **Remove CommandPalette state** (lines 78-80):
     ```tsx
     // DELETE these three lines:
     const [paletteOpen, setPaletteOpen] = useState(false);
     const [paletteQuery, setPaletteQuery] = useState("");
     const [paletteIndex, setPaletteIndex] = useState(0);
     ```
  2. **Remove the global keydown listener** (lines 226-250). It moves to `CommandPalette.tsx` per §2.14 (and gets the `e.target.tagName` guard).
  3. **Remove the CommandPalette JSX render** (lines 459-468) and the inline `function CommandPalette(...)` definition (lines 473-555). Delete both.
  4. **Keep**: SessionItem (lines 558-670), Session interface (lines 14-26 and 672-684), all session-management state and effects.
  5. After the diff, `SessionPanel.tsx` should be ~120 lines shorter and contain no CommandPalette references. Verify with `grep -n "palette\|Palette" src/components/pos/SessionPanel.tsx` → 0 hits expected.
- **New imports**: none added; `useState` references for palette are removed (others remain).
- **A11y/RTL**: irrelevant; existing aria stays.

### 3.11 `src/components/Terminal.tsx` — WP-C

- **Owner**: WP-C.
- **Affected lines**: 22-24, 213-221, 233-258, 299-333, 359-381.
- **Diff intent** per `05 §8 WP-C` and `02-scan-terminal.md §7`:
  1. **Lift refs into TerminalIOContext**:
     ```tsx
     import { useTerminalIO } from "@/contexts/TerminalIOContext";
     ...
     export default function Terminal({ sessionId, fullscreen, onConnectionChange }: TerminalProps) {
       const terminalIO = useTerminalIO();
       const terminalRef = terminalIO.terminalElementRef;   // replaces local useRef
       const xtermRef    = terminalIO.xtermRef;             // replaces local useRef
       const wsRef       = terminalIO.wsRef;                // replaces local useRef
       const fitAddonRef = useRef<FitAddon | null>(null);   // stays local
       ...
     }
     ```
     The `Terminal` component still owns the lifecycle (instantiate xterm, open WS, etc.) — but the refs now point into the context so siblings can call `terminalIO.sendInput(...)` and `terminalIO.requestResize(...)` without prop drilling.
  2. **Do NOT touch lines 213-221** (the `term.onData → ws.send({type:"input", data})` listener). This is the inviolable contract per `05 §6 #13`.
  3. **Pointerdown on terminal wrapper** (lines 425-428 area). Add a listener registered inside `initTerminal`:
     ```tsx
     // Inside initTerminal, after `terminalRef.current.addEventListener("paste", handlePaste, true);`
     const handlePointerDown = (e: PointerEvent) => {
       // Only on mobile — desktop xterm focuses its own helper textarea.
       if (window.matchMedia("(max-width: 767px)").matches) {
         e.preventDefault();
         terminalIO.mobileInputRef.current?.focus({ preventScroll: true });
       }
     };
     terminalRef.current.addEventListener("pointerdown", handlePointerDown, true);
     // …in cleanup:
     containerEl?.removeEventListener("pointerdown", handlePointerDown, true);
     ```
  4. **`visualViewport.resize` listener** per `02-scan-terminal.md §7.2 step 4` and `05 §8 WP-C`:
     ```tsx
     // New useEffect inside Terminal component (NOT inside initTerminal — it must
     // re-register if visualViewport handler ref churns). After init.
     useEffect(() => {
       if (typeof window === "undefined" || !window.visualViewport) return;
       let timeout: ReturnType<typeof setTimeout> | null = null;
       const onResize = () => {
         if (timeout) clearTimeout(timeout);
         timeout = setTimeout(() => {
           const fa = fitAddonRef.current;
           const term = xtermRef.current;
           const ws = wsRef.current;
           if (!fa || !term) return;
           fa.fit();
           if (ws && ws.readyState === WebSocket.OPEN) {
             ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
           }
         }, 150);   // debounce per 05 §8 WP-C
       };
       window.visualViewport.addEventListener("resize", onResize);
       window.visualViewport.addEventListener("scroll", onResize);
       return () => {
         window.visualViewport!.removeEventListener("resize", onResize);
         window.visualViewport!.removeEventListener("scroll", onResize);
         if (timeout) clearTimeout(timeout);
       };
     }, []);
     ```
     This fires `fit()` when the iOS keyboard opens (which doesn't trigger ResizeObserver on the container per `02-scan-terminal.md §5.3`).
  5. **`attachCustomKeyEventHandler` re-installer** per `05 §10 risk 4 / §12.2`. Export a function:
     ```tsx
     export function getDefaultKeyHandler(term: XTerm) {
       const isMac = getOS() === "mac";
       return (e: KeyboardEvent) => {
         /* original logic from lines 299-333 */
       };
     }
     ```
     `MobileTerminalInput.tsx` imports this and calls `xtermRef.current?.attachCustomKeyEventHandler(getDefaultKeyHandler(xtermRef.current))` on its unmount (mobile→desktop transition). The function lives at module scope so it's stateless across mounts.
  6. **`aria-label`** on the terminal wrapper div (line 424):
     ```tsx
     <div className="relative w-full h-full min-h-0 terminal-host" role="region" aria-label="Терминал">
     ```
- **New imports**: `useTerminalIO`, `useEffect` (already imported).
- **A11y/RTL**: `aria-label="Терминал"`, `role="region"`. Russian.

### 3.12 `src/components/EphemeralTerminal.tsx` — WP-C

- **Owner**: WP-C.
- **Affected lines**: 67-73.
- **Diff intent**: mirror the `visualViewport.resize` listener from `Terminal.tsx` (no MobileTerminalInput here per `05 §8 WP-C`). Pure additive listener:
  ```tsx
  useEffect(() => {
    if (typeof window === "undefined" || !window.visualViewport) return;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const onResize = () => {
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => {
        // re-fit using stored refs — note EphemeralTerminal doesn't expose
        // refs the same way; it inlines fit/ws within connect(). WP-C should
        // refactor connect() to store fitAddon and ws into refs that this
        // effect can read.
      }, 150);
    };
    window.visualViewport.addEventListener("resize", onResize);
    return () => {
      window.visualViewport!.removeEventListener("resize", onResize);
      if (timeout) clearTimeout(timeout);
    };
  }, []);
  ```
- **A11y/RTL**: irrelevant.

### 3.13 `src/components/chat/ChatPanel.tsx` — WP-D

- **Owner**: WP-D.
- **Affected lines**: 332-462 (verify); add `pb-safe` on input row.
- **Diff intent**: NO behavior change to channels/scrolling. Add `pb-safe` class on the bottom container so the ChatInput textarea isn't clipped by iOS home indicator when wrapped in `MobileChatSheet`:
  ```tsx
  // Outer wrapper at line 333:
  <div className="flex flex-col h-full pb-safe">
  ```
  vaul's snap point [0.5, 0.95] keeps the sheet within visualViewport, so the textarea is reachable; `pb-safe` ensures the safe-area inset is respected.
- **New imports**: none.
- **A11y/RTL**: existing `role="tablist" aria-label="Каналы чата"` (line 354) preserved.

### 3.14 `src/components/chat/ChatInput.tsx` — WP-D

- **Owner**: WP-D.
- **Affected line**: 203.
- **Diff intent** per `05 §2.13`: change `text-sm` → `text-base` (16 px) to defeat iOS zoom-on-focus. The mobile-scoped CSS in `globals.css` (§3.2 step 5) is a belt-and-suspenders backup; the explicit class here is more robust because it survives any future CSS specificity changes.
  ```tsx
  // Line 203, before:
  className="flex-1 bg-transparent text-sm text-foreground placeholder-muted outline-none resize-none max-h-24 min-h-[20px] disabled:opacity-30 disabled:cursor-not-allowed"
  // After:
  className="flex-1 bg-transparent text-base text-foreground placeholder-muted outline-none resize-none max-h-24 min-h-[20px] disabled:opacity-30 disabled:cursor-not-allowed"
  ```
- **A11y/RTL**: existing `placeholder` Russian.

### 3.15 `src/components/FileManager.tsx` — WP-D

- **Owner**: WP-D.
- **Affected lines**: 80, 102-103, 783, 691.
- **Diff intent**:
  1. **Confirm `useIsMobile()`** (line 102) returns `true` inside the vaul `MobileFilesSheet` — yes, since the hook is media-query-based and the sheet mounts on mobile only.
  2. **Add `pb-safe`** on the outer wrapper (line 691):
     ```tsx
     <div className="flex flex-col w-full h-full bg-background rounded-xl overflow-hidden relative pb-safe">
     ```
  3. **Drag overlay z-index** (line 783): change `z-40` → `z-panel` (Z.PANEL = 40, same value). No semantic change; just adopt the token per `05 §2.9`.
  4. **MOBILE_COLUMNS** (line 80): no change. Already correct.
- **New imports**: none.
- **A11y/RTL**: irrelevant.

### 3.16 `src/components/AdminPanel.tsx` — WP-D

- **Owner**: WP-D.
- **Affected lines**: 97-99.
- **Diff intent**: NO behavior change. Add `pb-safe` and a Russian `aria-label`:
  ```tsx
  <div className="flex flex-col h-full pb-safe" role="region" aria-label="Управление пользователями">
  ```
- **A11y/RTL**: `role="region"`, Russian aria-label added.

### 3.17 `src/components/HotkeysModal.tsx` — WP-D

- **Owner**: WP-D.
- **Affected lines**: 199-275 (modal shell).
- **Diff intent** per `05 §8 WP-D / §12.4`:
  - Convert from bespoke backdrop+card to a vaul Drawer on mobile, Radix Dialog on desktop. Subscribe to `overlayStore` slot `"hotkeysModal"`. Remove `max-h-[80vh]` (vaul handles sizing).
  - Skeleton:
    ```tsx
    import { Drawer } from "vaul";
    import * as Dialog from "@radix-ui/react-dialog";
    import { useOverlayStore, useOverlay } from "@/stores/overlayStore";
    import { useIsMobile } from "@/lib/useIsMobile";
    ...
    export default function HotkeysModal() {
      const isMobile = useIsMobile();
      const open = useOverlay("hotkeysModal");
      const setActive = useOverlayStore(s => s.setActiveOverlay);
      const onClose = () => setActive("none");
      const os = useOS();

      const body = (
        /* the same body content from lines 246-269 */
      );

      if (isMobile) {
        return (
          <Drawer.Root open={open} onOpenChange={(o) => setActive(o ? "hotkeysModal" : "none")} direction="bottom">
            <Drawer.Portal>
              <Drawer.Overlay className="fixed inset-0 bg-black/60 z-modal" />
              <Drawer.Content className="fixed inset-x-0 bottom-0 z-modal max-h-[90dvh] bg-surface rounded-t-2xl flex flex-col pb-safe" aria-label="Горячие клавиши">
                <div className="mx-auto h-1.5 w-12 my-2 rounded-full bg-border" />
                <ModalTitleBar title="Горячие клавиши" onClose={onClose} />
                {body}
              </Drawer.Content>
            </Drawer.Portal>
          </Drawer.Root>
        );
      }

      // Desktop: keep the existing motion-based modal
      return (
        <AnimatePresence>
          {open && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-black/60 z-modal flex items-center justify-center p-4" onClick={onClose}>
              <motion.div ... className="bg-surface border border-border-strong rounded-[var(--th-radius)] overflow-hidden max-w-md w-full max-h-[80dvh] flex flex-col">
                <ModalTitleBar title="Горячие клавиши" onClose={onClose} />
                {body}
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      );
    }
    ```
  - **Remove `open` and `onClose` props** — open/close are now driven by `overlayStore`. Update IconRail.tsx (already covered §3.8 — IconRail no longer mounts HotkeysModal).
  - **Mount move**: page-level (`dashboard/page.tsx`) renders `<HotkeysModal />` (no props) once, near the lightbox.
  - **Replace `max-h-[80vh]` → `max-h-[80dvh]`** (line 236 + new desktop branch).
- **New imports**: `vaul`, `@radix-ui/react-dialog` (the latter is a transitive dep of vaul; explicit import only if WP-D opts to use Dialog directly on desktop instead of motion — recommended for a11y consistency, but the motion approach also works).
- **A11y/RTL**: `aria-label="Горячие клавиши"`. vaul/Radix supplies focus-trap and Esc.

### 3.18 `src/components/ProviderWizardModal.tsx`, `src/components/symphony/CreateTaskModal.tsx`, `src/components/chat/ImageLightbox.tsx` — WP-A

- **Owner**: WP-A per `05 §8 WP-A`.
- **Affected lines**: ProviderWizardModal:260, CreateTaskModal:67, ImageLightbox:31.
- **Diff intent**: replace `max-h-[85vh]` / `max-h-[90vh]` with `max-h-[85dvh]` / `max-h-[90dvh]`. No structural change.

### 3.19 `src/components/ui/aurora-background.tsx`, `src/components/ui/lamp.tsx` — WP-A

- **Owner**: WP-A.
- **Affected lines**: aurora-background.tsx:25,41; lamp.tsx:22.
- **Diff intent**: `h-[100vh]` / `min-h-screen` → `h-[100dvh]` / `min-h-dvh` (Tailwind v4 supports `min-h-dvh`). No behavior change for desktop; mobile is the win.

---

## 4. Tailwind / styling additions

All authored in `globals.css` per WP-A; no separate config file.

- **`@theme inline` z-index tokens** (per §3.2 step 1):
  - `--z-base`, `--z-content`, `--z-sticky`, `--z-sidebar`, `--z-panel`, `--z-floating`, `--z-modal`, `--z-popup`, `--z-palette` (9000), `--z-toast` (9500), `--z-navbar` (5000).
  - Generates utility classes `z-base` … `z-navbar` automatically per Tailwind v4 (`02-scan-styles.md §2.2`).
- **`@utility` safe-area helpers** (per §3.2 step 2):
  - `pt-safe`, `pb-safe`, `pl-safe`, `pr-safe`.
  - `h-safe-bottom`, `min-h-safe-bottom` (for layout components needing the height alone).
- **Mobile input font-size override** (per §3.2 step 5):
  - `@media (max-width: 767px)` block forcing `font-size: 16px !important` on `input`, `textarea`, `select` (excluding checkbox/radio).
- **`touch-action: manipulation`** (per §3.2 step 4) on `.terminal-host` utility class — applied at the Terminal wrapper.
- **`overscroll-behavior: contain` and `-webkit-tap-highlight-color: transparent`** on `body` (per §3.2 step 3) — global.
- **`--vvh`/`--kbd-height`/`--vv-offset-top` :root fallbacks** (per §3.2 step 6) — guarantees CSS works at first paint before JS hook fires.

No Tailwind plugin packages are added. No `tailwind.config.*` file is created (project is CSS-first per `02-scan-styles.md §2`).

---

## 5. Deps to add

Confirmed via `package.json` read at `/root/projects/claude-terminal/package.json`:

| Dep | Version | Why | Verified missing? |
|---|---|---|---|
| `vaul` | `^0.9.9` | Bottom sheets / drawers per `05 §2.5`. Brings `@radix-ui/react-dialog` as transitive dep. | YES — not in dependencies (verified). |
| `zustand` | `^5.0.2` | Overlay mutex store (§2.3) and modifier state (§2.7). | YES — not in dependencies (verified). |
| `@radix-ui/react-dialog` | `^1.1.6` | Already a transitive dep of vaul; pin explicitly so it survives vaul upgrades. **Optional**: skip if WP-D is comfortable using vaul's transitive resolution. **Recommendation**: pin explicitly. | YES — not in dependencies. |

No other deps required. `framer-motion` is already in (`motion: ^12.34.2`), `next` is already 16, React is 19.

**Bundle delta budget** per `05 §6 criterion 11`: ≤ +38 KB gzip total. Validated by Phase 8a `next build` analyzer.

---

## 6. Migration order (frozen)

The four WPs are partitioned for parallel execution but have a strict dependency order on the ARTIFACTS each produces. The plan:

### Step 1 (must land first): WP-A — shell, viewport, breakpoints, tokens

Reasons WP-B/C/D depend on this:
- `--vvh` and `--kbd-height` CSS variables (consumed by `pos/DashboardLayout.tsx` height, `ModifierKeyBar.tsx` transform).
- `pb-safe`/`pt-safe` utilities (consumed by every overlay sheet, MobileBottomBar).
- Z-index tokens (`z-modal`, `z-panel`, `z-floating`, `z-palette`) (consumed by every WP-D sheet and the lifted CommandPalette).
- The `viewport` Metadata export (consumed implicitly by every mobile path).
- The `useVisualViewport()` hook (consumed by WP-C and indirectly by WP-B's MobileBottomBar).
- The renamed `lib/z-index.ts` with `PALETTE` and `TOAST` slots (consumed by WP-D's CommandPalette extraction).

WP-A also lands `useVisualViewport.ts` and the WP-A portion of `pos/DashboardLayout.tsx` (lines 49, 53).

### Step 2 (parallel after Step 1): WP-C and WP-B

**WP-C — terminal context + input proxy + modifier bar** can begin once `useVisualViewport` and the CSS vars exist. WP-C produces:
- `TerminalIOContext` (consumed by `dashboard/page.tsx` provider wrap — WP-D needs this to mount the provider).
- `MobileTerminalInput.tsx` and `ModifierKeyBar.tsx` (mounted by `dashboard/page.tsx` — WP-D coordinates the mount inside the provider).
- The `lib/useModifierState.ts` and `lib/mobile-input.ts` libraries.

**WP-B — navigation: MobileBottomBar repurpose, hamburger, IconRail HotkeysModal mount migration** can begin once `overlayStore` exists in stub form. **CRITICAL**: WP-D must publish `src/stores/overlayStore.ts` (or at least its type signature) before WP-B can wire MobileBottomBar's tab handlers. To unblock parallel work, **the type signature in §2.3 above is FROZEN** — WP-B can implement against the type while WP-D implements the runtime. If they merge in either order, the result is identical because the API surface is fixed in this plan.

WP-B produces:
- The repurposed `MobileBottomBar.tsx` (consumed by `pos/DashboardLayout.tsx:122`).
- Modified `pos/DashboardLayout.tsx` lines 55-114 (vaul-based MoreDrawer wrapping IconRail+SidePanel).
- Modified `Navbar.tsx` (tap-target bumps, aria-labels).
- Modified `IconRail.tsx` (HotkeysModal mount migration).

### Step 3 (after Steps 1+2 land): WP-D — overlays

WP-D — chat / files / admin / hotkeys / command palette / mutex store. Depends on:
- `overlayStore` is itself authored by WP-D. The store is the FIRST thing WP-D lands; once it exists, WP-B can pick up the import.
- `TerminalIOContext` from WP-C (only because the WP-D-owned `dashboard/page.tsx` wraps `<TerminalIOProvider>`).
- The CommandPalette extraction can proceed independently of the sheet wrappers; recommended sub-order within WP-D:
  1. `overlayStore.ts` (publishes the API).
  2. `CommandPalette.tsx` extraction (closes the hot bug from `05 §2.11`).
  3. `MobileXxxSheet.tsx` wrappers (one file at a time).
  4. `dashboard/page.tsx` integration (mounts everything).
  5. `HotkeysModal.tsx` conversion (last, because it touches the most a11y).

### Critical-path summary

```
WP-A (Step 1) ────────────► WP-C (Step 2a) ────────────►
            └────► WP-B (Step 2b) ─►                    │
            │                       │                   ▼
            └─►   WP-D-stub overlayStore ──► WP-B uses ──► WP-D (Step 3)
                                          ──► WP-D continues
```

**Coordination checkpoint** before merging WP-B and WP-D: both touch `pos/DashboardLayout.tsx`. WP-A owns lines 48-53 (h-screen migration). WP-B owns lines 55-114 (drawer refactor). Lines 117 (main column) and 122 (MobileBottomBar mount) are unchanged. Three-way merge is automatic.

---

## 7. Test plan

### 7.1 Build / typecheck / lint

- `cd /root/projects/claude-terminal && npm run build` — must complete without TypeScript errors.
- `npm run lint` — must pass `eslint`.
- `npx tsc --noEmit` — strict mode passes.
- Bundle analyzer: `next build` output + `du -sh .next/static/chunks/*` to confirm `dashboard/page.tsx` route is ≤ +38 KB gzip vs baseline (the baseline is captured in Phase 8a as a reference build of `feat/tmux-streaming-and-mobile~1`).

### 7.2 Headless viewport screenshots

Playwright runs (`@playwright/test ^1.58.2` already present in devDependencies) at viewports: 360×640, 390×844, 414×896, 430×932, 768×1024, 1280×800.

For each viewport:
- Login flow (existing test).
- Dashboard with no active session.
- Dashboard with active session, terminal view.
- Dashboard with active session, files view.
- Each overlay (`sessionsSheet`, `chatSheet`, `filesSheet`, `adminSheet`, `moreDrawer`, `hotkeysModal`, `commandPalette`).

Screenshot diffs are stored at `agent-workflow/08-shots/{viewport}/{state}.png`.

### 7.3 Touch + soft-keyboard simulation

Playwright touch emulation:
- Set `hasTouch: true, viewport: { width: 390, height: 844 }, isMobile: true`.
- Tap terminal canvas → assert `MobileTerminalInput` becomes visible (`document.querySelector('[aria-label="Ввод в терминал"]')` is in DOM).
- Type letter via `page.keyboard.type("a")` (which fires actual `input` event) → assert WS message `{type:"input", data:"a"}` was sent (intercept via WS proxy).
- Tap `Esc` button on modifier bar → assert WS got `{type:"input", data:"\x1b"}`.
- Tap `Ctrl` then `c` → assert WS got `{type:"input", data:"\x03"}`.
- Tap `↑` → assert WS got `{type:"input", data:"\x1b[A"}` (or `\x1bOA` if vim is in app-cursor mode).
- Simulate keyboard open via `window.visualViewport.height = 400` (mock) → assert `MobileTerminalInput` and `ModifierKeyBar` adjust their `transform: translateY` per `05 §2.15`.
- Tap a link in the terminal output → confirm WebLinksAddon still fires (no regression).

### 7.4 11 UX-target verification matrix

| # | UX target (paraphrased from `01-planner-mobile.md`) | How verified |
|---|---|---|
| 1 | Tablet ≥768 keeps desktop layout, mobile <768 gets new chrome | Phase 8b screenshot diff at 767 vs 768 viewport |
| 2 | Single mobile nav surface (`MobileBottomBar` + hamburger drawer) | Manual at 360×640: count visible nav surfaces == 1 (MobileBottomBar) when no overlay open |
| 3 | Real on-screen input field that forwards to PTY | Phase 7c smoke test: type "echo hi" via mobile input, assert PTY echoes "hi" within 100 ms |
| 4 | Modifier bar with Esc/Tab/Ctrl/Alt/arrows + Ctrl chords | Manual checklist: each of 14 keys produces correct WS message |
| 5 | `visualViewport` + `dvh` keep terminal canvas above keyboard | Visual: cursor visible after keyboard opens; assert `term.buffer.active.cursorY === term.rows - 1` |
| 6 | Safe-area insets respected (no home-indicator overlap) | Phase 8b screenshot diff: confirm 34 px bottom padding on iPhone 16 Pro frame |
| 7 | Tap targets ≥44×44 CSS px | Phase 8c automated assert via `getBoundingClientRect()` on every `<button>` in `<MobileBottomBar>`, `<ModifierKeyBar>`, sheets |
| 8 | Chat works inside `MobileChatSheet`; ChatInput defeats iOS zoom | Phase 8b: tap ChatInput, assert no zoom (computed font-size ≥ 16 px) |
| 9 | FileManager works inside `MobileFilesSheet` (4-column mobile) | Phase 8b: open files sheet, assert columns template == "32px 28px 1fr 80px" |
| 10 | All `100vh` traps replaced with `dvh`/`vvh` | Phase 8a build assert: `grep -rn "100vh\|h-screen\|max-h-\[80vh\]\|max-h-\[85vh\]" src/` returns 0 hits in dashboard tree |
| 11 | Mid-range Android scroll FPS ≥ 50 | Phase 10b manual on Pixel 6a (or Chrome DevTools throttled "Mid-tier mobile" profile) |

### 7.5 Russian text rendering

- At 360 px viewport, verify:
  - Navbar session name truncates with `…` after 150 px (existing behavior preserved).
  - "Сессии" / "Терминал" / "Чат" / "Ещё" tab labels in `MobileBottomBar` fit (≤ 7 chars; `text-[10px]`).
  - Sheet `aria-label`s "Сессии" / "Чат" / "Файлы" / "Пользователи" / "Главное меню" / "Горячие клавиши" / "Командная палитра" announce correctly via VoiceOver / TalkBack (manual Phase 10b).
  - `MobileTerminalInput` placeholder "Введите команду…" doesn't overflow (≈ 130 px wide at 16 px Geist Sans).

### 7.6 Existing desktop flow regression (≥768 px)

- Run the full existing Playwright suite at viewport 1280×800.
- Manual smoke at 1024×768 and 1920×1080: every existing flow (session create, terminal type, file open, chat send, admin role change, hotkeys modal, fullscreen toggle) works identically.
- Z-index visual check: with `chatOpen` and `adminOpen` both true on desktop (manual force via React DevTools), the overlay-coordination assert should now FORCIBLY close one when the other opens (via the `overlayStore` bidirectional sync from §3.3 step 6). This is the live fix for the latent bug from `02-scan-navigation.md §5.1`.

---

## 8. Rollback plan

Mobile changes are additive at `≥768 px` per `05 §2.12`; rollback only matters for `<768 px`.

### 8.1 One-button rollback (recommended)

1. Set `NEXT_PUBLIC_MOBILE_OVERHAUL_ENABLED=false` in `.env` (or in deployment env).
2. `bash /root/projects/claude-terminal/deploy.sh` blue-green deploys the disabled version.
3. Mobile users see the previous experience (hamburger drawer + 4-tab bar), with the additive viewport-meta still active (which is a no-op on `<768 px` if the rest is gated).

The flag gates per `05 §9`:
- `viewport` Metadata export (falls back to Next.js default).
- vaul `Drawer` mounts in `dashboard/page.tsx` (falls back to existing motion.div slide-overs).
- `MobileTerminalInput` / `ModifierKeyBar` render gates.
- `CommandPalette` extracted version (falls back to in-`SessionPanel.tsx` palette — which means the WP-D extraction must keep the old palette as a deprecated fallback during the rollout window OR the flag flip must coincide with a full deploy without the extraction. **Recommended**: defer the SessionPanel-side deletion (§3.10) until the flag has been ON in production for ≥7 days; then a follow-up PR deletes the dead code).
- `MobileBottomBar` tab semantics (falls back to existing tabs/handlers).
- `h-screen → h-dvh` migration: applied unconditionally because the visual delta on desktop is zero (`dvh === vh` on desktop browsers).

### 8.2 Per-component opt-out

For every new component that touches a render path, the `useIsMobile()` short-circuit short-circuits to a no-op on `≥768 px`. So even with the flag ON, the desktop tree is unaffected.

### 8.3 Worst-case revert

If the flag-flip approach fails (e.g. some new code is unconditionally executed and breaks desktop):
1. `git revert` the WP-A commit (the smallest, lowest-risk WP).
2. WP-B/C/D are no-ops without WP-A's CSS variables and viewport meta — they will render with broken layouts on mobile but **desktop is untouched** because WP-B/C/D mostly add new files that aren't referenced from the desktop render tree.
3. Re-deploy.

The estimated rollback duration is < 2 minutes (env var flip + blue-green) for the soft path, < 10 minutes for the hard path (git revert + npm install + build + deploy).

---

## 9. Work-package partitions (final, frozen)

Reproduced from `05-decision-mobile.md §8` with line-range disambiguations.

### 9.1 WP-A — Shell, viewport, breakpoints, tokens (`impl-layout-shell`)

**OWNED (write):**
- `src/app/layout.tsx` (add viewport export, themeColor)
- `src/app/globals.css` (z-index tokens, safe-area utilities, `--vvh` fallback, mobile font-size, `touch-action`, `overscroll-behavior`, `-webkit-tap-highlight-color`)
- `src/components/pos/DashboardLayout.tsx` (lines 49 & 53 ONLY — `h-screen` → `var(--vvh, 100dvh)` migration; the file is also written by WP-B for lines 55-114)
- `src/lib/z-index.ts` (rename to keep name; add PALETTE and TOAST)
- `src/lib/useVisualViewport.ts` (NEW)
- `src/components/ui/aurora-background.tsx` (lines 25, 41: `100vh` → `100dvh`)
- `src/components/ui/lamp.tsx` (line 22: `min-h-screen` → `min-h-dvh`)
- `src/app/global-error.tsx` (line 12: inline `100vh` → `100dvh`)
- `src/components/HotkeysModal.tsx` (line 236 only: `max-h-[80vh]` → `max-h-[80dvh]` — the rest is WP-D)
- `src/components/ProviderWizardModal.tsx` (line 260: `max-h-[85vh]` → `max-h-[85dvh]`)
- `src/components/symphony/CreateTaskModal.tsx` (line 67: `max-h-[85vh]` → `max-h-[85dvh]`)
- `src/components/chat/ImageLightbox.tsx` (line 31: `max-h-[90vh]` → `max-h-[90dvh]`)

**READ-ONLY-REFERENCE:**
- `package.json` (verify Tailwind v4 `@theme inline { --z-* }` works — it does per `02-scan-styles.md §2.2`).
- `next.config.ts` (verify no head/meta overrides).

**MUST-NOT-TOUCH:**
- Everything in WP-B/C/D ownership lists.
- `src/components/pos/DashboardLayout.tsx` lines 55-114 (WP-B).
- `src/lib/useIsMobile.ts` (no edits expected).

**Depends on**: nothing (Step 1).

### 9.2 WP-B — Navigation: MobileBottomBar, Navbar, IconRail, hamburger drawer (`impl-mobile-navigation`)

**OWNED (write):**
- `src/components/Navbar.tsx` (tap-target bumps, aria-labels)
- `src/components/pos/DashboardLayout.tsx` (lines 55-114 — vaul drawer for the More/IconRail/SidePanel mobile slide-in; coordinate with WP-A on lines 49,53)
- `src/components/pos/MobileBottomBar.tsx` (tab repurpose, vaul wiring, hide-when-keyboard-open, `pb-safe`)
- `src/components/pos/SidePanel.tsx` (verify behavior; no edits expected)
- `src/components/pos/IconRail.tsx` (remove HotkeysModal mount, route to overlayStore)

**READ-ONLY-REFERENCE:**
- `src/lib/NavigationContext.tsx` (read for `activeSection` / `panelOpen` / `workspaceView` semantics).
- `src/stores/overlayStore.ts` (created by WP-D; WP-B reads the API per the frozen signature in §2.3).
- `src/lib/useVisualViewport.ts` (created by WP-A; consumed by MobileBottomBar).

**MUST-NOT-TOUCH:**
- Everything in WP-A/C/D ownership lists.
- `src/components/pos/SessionPanel.tsx` (WP-D for CommandPalette extraction).
- `src/app/dashboard/page.tsx` (WP-D for overlay mounts).

**Depends on**: WP-A (Step 1) for `useVisualViewport` and CSS vars; WP-D (Step 3) for `overlayStore` runtime — but the type signature is frozen in §2.3 so WP-B can implement against the type in parallel with WP-D.

### 9.3 WP-C — Terminal IO context + input proxy + modifier bar (`impl-terminal-input-proxy`)

**OWNED (write):**
- `src/components/Terminal.tsx` (lift refs to context, add visualViewport listener, pointerdown handler, export getDefaultKeyHandler; do NOT touch lines 213-221 contract)
- `src/components/EphemeralTerminal.tsx` (mirror visualViewport listener)
- `src/components/mobile/MobileTerminalInput.tsx` (NEW per §2.5)
- `src/components/mobile/ModifierKeyBar.tsx` (NEW per §2.6)
- `src/contexts/TerminalIOContext.tsx` (NEW per §2.2)
- `src/lib/useModifierState.ts` (NEW per §2.7)
- `src/lib/mobile-input.ts` (NEW per §2.8)

**READ-ONLY-REFERENCE:**
- `src/lib/useVisualViewport.ts` (WP-A).
- `src/lib/z-index.ts` (WP-A).
- `src/lib/useIsMobile.ts`.
- xterm.js typings at `node_modules/@xterm/xterm/typings/xterm.d.ts:822` for `term.textarea`, `term.input`, `term.modes.applicationCursorKeysMode`.

**MUST-NOT-TOUCH:**
- Everything in WP-A/B/D ownership lists.
- `src/app/dashboard/page.tsx` (WP-D mounts the provider; WP-C just defines it).

**Depends on**: WP-A (Step 1) for CSS vars and useVisualViewport.

### 9.4 WP-D — Overlays: chat, files, admin, hotkeys, command palette, mutex store (`impl-overlays-chat-files`)

**OWNED (write):**
- `src/components/chat/ChatPanel.tsx` (add `pb-safe`)
- `src/components/chat/ChatInput.tsx` (line 203: `text-sm` → `text-base`)
- `src/components/FileManager.tsx` (add `pb-safe`, swap z-40 → z-panel token)
- `src/components/AdminPanel.tsx` (add `pb-safe`, aria-label)
- `src/components/HotkeysModal.tsx` (vaul on mobile, Radix on desktop; consume overlayStore; remove `open`/`onClose` props — line 236 `max-h-[80dvh]` is WP-A's edit)
- `src/components/CommandPalette.tsx` (NEW per §2.14; lifted from SessionPanel)
- `src/components/pos/SessionPanel.tsx` (delete CommandPalette state, listener, JSX, function)
- `src/components/mobile/MobileSessionsSheet.tsx` (NEW per §2.9)
- `src/components/mobile/MobileChatSheet.tsx` (NEW per §2.10)
- `src/components/mobile/MobileMoreSheet.tsx` (NEW per §2.11)
- `src/components/mobile/MobileFilesSheet.tsx` (NEW per §2.12)
- `src/components/mobile/MobileAdminSheet.tsx` (NEW per §2.13)
- `src/stores/overlayStore.ts` (NEW per §2.3)
- `src/app/dashboard/page.tsx` (provider wrap, sheet mounts, CommandPalette mount, conditional rendering of legacy slide-overs)

**READ-ONLY-REFERENCE:**
- `src/contexts/TerminalIOContext.tsx` (WP-C).
- `src/lib/useIsMobile.ts`.
- `src/lib/z-index.ts` (WP-A).

**MUST-NOT-TOUCH:**
- Everything in WP-A/B/C ownership lists.
- `src/components/Terminal.tsx` (WP-C; WP-D's page-level wrap goes around the Terminal).
- `src/components/pos/DashboardLayout.tsx` (WP-A and WP-B).

**Depends on**: WP-A (Step 1) for CSS vars/tokens; WP-B (Step 2) for repurposed MobileBottomBar that calls `setActiveOverlay`; WP-C (Step 2) for `TerminalIOProvider` (so the page-level wrap can mount it).

### 9.5 Single shared file disambiguation

`src/components/pos/DashboardLayout.tsx`:
- WP-A line range: 48-53 (the two `flex h-screen` short-circuits).
- WP-B line range: 55-114 (the desktop column + mobile drawer).
- Lines 117-122 (main column + MobileBottomBar mount) are unchanged.

After both land, a standard git three-way merge produces no conflicts because the line ranges are strictly disjoint. If a conflict surfaces (e.g. one WP touches a "neighboring" line for whitespace), the integration nexus is `dashboard/page.tsx` for WP-D — not DashboardLayout.

---

## 10. Acceptance criteria copy

Restated verbatim from `05-decision-mobile.md §6`. Phase 9 audit MUST verify each.

1. **Zero horizontal scroll** at viewport widths 360, 390, 414, 430 px on iOS Safari and Android Chrome with the dashboard mounted to an active session terminal view, and with each of (no overlay, sessions sheet open, chat sheet open, files sheet open, admin sheet open, more drawer open). Headless Playwright run in Phase 8b asserts `document.documentElement.scrollWidth <= document.documentElement.clientWidth` for every (viewport × overlay) cell.
2. **All 11 Mobile UX Targets** from `01-planner-mobile.md §"Mobile UX Targets"` reach **PASS** verdict in the Phase-9 audit (no PARTIAL, no FAIL).
3. **iOS Safari 16+ smoke test green** (manual, Phase 10b checklist): keyboard opens on canvas tap, modifier bar sits flush against keyboard top with zero gap, typing a Latin character appears in the PTY within 100 ms, `Ctrl + C` from bar interrupts a `sleep 30`, arrow keys navigate `vim` in normal mode, `Esc` exits insert mode, paste from iOS clipboard menu inserts text with bracketed-paste markers, voice dictation (long-press space) inserts the recognised phrase on completion.
4. **Android Chrome 110+ smoke test green** (same checklist plus Samsung Keyboard test): typing letters fires `input` event correctly (the Samsung-skips-keydown gotcha from `03-research-xterm-proxy.md §2.6`), CJK IME composition (Pinyin → Hanzi) completes correctly via `compositionend.data`.
5. **Cmd+K does not steal from ChatInput** when ChatInput is focused: pressing Cmd+K (or Ctrl+K on Linux/Win) inside the chat textarea types literal `k` instead of opening CommandPalette. The reverse — Cmd+K with no input focused — opens CommandPalette as today.
6. **Soft-keyboard layout invariants**: when keyboard opens (verified via `visualViewport.height < window.innerHeight - 150`), (a) MobileTerminalInput is visible (within the visualViewport), (b) terminal scrolls to the cursor row (verified via `term.buffer.active.cursorY === term.rows - 1` after a no-op `term.input("")`), (c) ModifierKeyBar's `getBoundingClientRect().bottom` equals `window.visualViewport.offsetTop + window.visualViewport.height` (the bar is flush against the keyboard top, ±2px tolerance for sub-pixel rounding).
7. **No `100vh` traps**: `grep -rn "100vh\|h-screen\|min-h-screen\|max-h-\[80vh\]\|max-h-\[85vh\]\|h-\[100vh\]" src/` returns zero hits in the dashboard tree (allowed in marketing UI like `aurora-background.tsx`, `lamp.tsx` because they're not on the dashboard route — verified by Phase 8a build assert).
8. **Safe-area insets respected**: each of MobileBottomBar, ModifierKeyBar, MobileTerminalInput, every vaul sheet bottom edge applies `pb-safe` (or vaul's built-in equivalent). Visually-confirmed in the Phase 8b screenshots: no element overlaps with the iOS home indicator or notch.
9. **Tap targets ≥44×44 CSS px**: every interactive element on mobile (`<button>`, `<a>`, `role="button"`) has a computed `width >= 44 && height >= 44` (or its hit-target via `padding` extends to 44+44). Verified via Phase 8c automated assert.
10. **No double-overlay states reachable**: opening any overlay (chat sheet, admin sheet, command palette, hotkeys modal, image lightbox, more drawer, sessions sheet, files sheet) closes any other open overlay. Verified by Phase 8c sequence: open chat → open admin → assert chat is closed.
11. **Bundle size**: production build of `dashboard/page.tsx` route increases by no more than **+38 KB gzip** total (vaul + Radix Dialog overhead = ~34 KB plus ~4 KB for new components). Verified via `next build` analyzer in Phase 8a.
12. **Mid-range Android scroll FPS ≥50**: scrolling 1000 lines of terminal output via two-finger swipe maintains ≥50 FPS in Chrome's Performance panel on a Pixel 6a or equivalent (per planner #11). Verified manually in Phase 10b.
13. **WS contract preserved**: every byte that reaches the PTY originates from `Terminal.tsx:213-221` (the existing `term.onData` listener). Verified via WS message audit log: every keystroke from MobileTerminalInput flows through `term.input → onData → ws.send` and not via any other path.

---

## 11. Phase 7 hand-off checklist

Each Phase-7 implementer reads this plan plus their assigned partition (§9.1 / §9.2 / §9.3 / §9.4). Outputs:

- **WP-A** → `agent-workflow/07a-impl-shell.md` (changelog of edits to layout.tsx / globals.css / DashboardLayout.tsx lines 49-53 / lib/z-index.ts / lib/useVisualViewport.ts / global-error.tsx / aurora / lamp / modal `vh→dvh` swaps).
- **WP-B** → `agent-workflow/07b-impl-nav.md` (changelog of edits to Navbar.tsx / pos/DashboardLayout.tsx lines 55-114 / pos/MobileBottomBar.tsx / pos/IconRail.tsx).
- **WP-C** → `agent-workflow/07c-impl-terminal.md` (changelog of edits to Terminal.tsx / EphemeralTerminal.tsx + new files: TerminalIOContext.tsx / MobileTerminalInput.tsx / ModifierKeyBar.tsx / useModifierState.ts / mobile-input.ts).
- **WP-D** → `agent-workflow/07d-impl-overlays.md` (changelog of edits to ChatPanel.tsx / ChatInput.tsx / FileManager.tsx / AdminPanel.tsx / HotkeysModal.tsx / pos/SessionPanel.tsx / app/dashboard/page.tsx + new files: CommandPalette.tsx / MobileSessionsSheet.tsx / MobileChatSheet.tsx / MobileMoreSheet.tsx / MobileFilesSheet.tsx / MobileAdminSheet.tsx / overlayStore.ts).

Each implementer agent MUST:
- Cite this plan's section number for every edit (e.g. "per `06-integration-plan-mobile.md §3.7 step 2`").
- Run `npm run build` and `npm run lint` before declaring done.
- Verify no edits to files outside their owned list (§9.1-§9.4).
- Coordinate the shared `pos/DashboardLayout.tsx` line ranges with the merge order: WP-A first, then WP-B.

---

## 12. Single ambiguity intentionally left for implementers

**Where to live: `src/components/mobile/` vs `src/components/terminal/`?**

Decision (`05 §5.5`) places `MobileTerminalInput` and `ModifierKeyBar` under `src/components/terminal/`, while sheets land under `src/components/mobile/`. This plan moves the two terminal-mobile components to `src/components/mobile/` for consistency with the rest of the mobile-only widgets. **WP-C may reverse this** (keep them under `src/components/terminal/`) without breaking any consumer because both folders are in the same import root. Implementer's choice; I recommend `src/components/mobile/` to keep all mobile-only files in one place and avoid future "where did this live?" hunts. This is the only path ambiguity in the plan; everything else is frozen.

---

End of `06-integration-plan-mobile.md`.

Phase-7 implementers: read your partition, follow the spec literally, raise issues on this thread.
