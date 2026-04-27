# Phase 5 — Mobile Overhaul Arbiter Decisions

> Agent: `arbiter-tech-lead-mobile`
> Date: 2026-04-26
> Branch: `feat/tmux-streaming-and-mobile`
> Mode: DECISION-ONLY. No source modified. Phase 6 translates these into a file-by-file plan.
> Inputs digested in full: `01-planner-mobile.md`, `02-scan-layout.md`, `02-scan-navigation.md`, `02-scan-terminal.md`, `02-scan-styles.md`, `03-research-terminal-ux.md`, `03-research-xterm-proxy.md`, `03-research-nav-patterns.md`, `04-tradeoffs-mobile.md`.
> Citation conventions: scan files → `02-scan-{name}.md §X.Y` or `file.tsx:LINE`; research/tradeoff → `03-…` / `04-…` plus section anchors.

---

## 1. Decision Summary (one paragraph)

We ship the **"Polished" bundle** from `04-tradeoffs-mobile.md §6.2`, not Minimal and not Native-feeling. The philosophy is **"terminal-first canvas, single mobile nav surface, real input field that feeds bytes through the existing `term.onData` → WS pipe"** — meaning we keep `MobileBottomBar` as the only persistent mobile chrome, repurpose its tabs around the user's actual workflow (Terminal / Sessions / Chat / More), wrap secondary surfaces (Sessions list, Chat, Files, Admin) in `vaul` bottom-sheets / drawers with drag-to-close + focus-trap, mount a real `<textarea>`-backed `MobileTerminalInput.tsx` driven by IME-aware composition events that calls `term.input(data, true)` so the existing WS contract at `Terminal.tsx:213-221` and the DA/CPR filter at `Terminal.tsx:217` continue to be the single source of truth, and pin the modifier bar (frozen 14-key list) sticky against the top of the soft keyboard via a `visualViewport`-bound CSS variable. We pay +34 KB gzip for `vaul + Radix Dialog`, get drag-to-close on every overlay, kill every hot bug enumerated in the scans (chat ↔ admin double-overlay, Cmd+K stealing from ChatInput, iOS zoom on ChatInput focus, `100vh` keyboard trap, missing safe-area on home indicator, scattered z-index literals), and unblock all 11 Mobile UX Targets listed in `01-planner-mobile.md`.

---

## 2. Binary / Multi-Choice Decisions

Each decision: explicit pick, two-sentence rationale, citation.

### 2.1 Input proxy recipe — **`IP-B + IP-D` blend (default candidate)**

- **Pick.** Build a single React-controlled `<textarea rows={1}>` that calls `term.input(data, true)` on every non-composition `input` event AND on `compositionend.data`, plus `term.paste(text)` on the `paste` event so bracketed-paste mode is preserved.
- **Rationale.** This is the only recipe that honors all four inviolable facts simultaneously: (a) preserves the existing `term.onData → ws.send({type:"input", data})` contract at `Terminal.tsx:213-221` so the DA/CPR filter at `Terminal.tsx:217` and any future server-side recording / replay continues to see one consistent ingress (`02-scan-terminal.md §3.1, §7.1`); (b) routes IME / voice / Samsung-Keyboard / CJK input correctly via the documented `compositionstart/compositionend` lifecycle (`03-research-xterm-proxy.md §3 Recipe D pros`, §10); (c) lets us style a real visible input field with `inputmode="text" enterkeyhint="send" autocapitalize="off" autocorrect="off" spellcheck={false} autoComplete="off"` and `text-base` (16 px) to defeat iOS zoom-on-focus (`02-scan-styles.md §6`); (d) keeps `term.paste(text)` reachable for bracketed-paste mode (`03-research-xterm-proxy.md §1.3`, hard-conflict #1 in `04-tradeoffs-mobile.md §5`). `IP-A` is rejected because pulling xterm's helper textarea on-screen is brittle to xterm version bumps (`03-research-xterm-proxy.md §1.6`); `IP-C` is rejected by hard-conflict #1 and #2; `IP-E` is rejected because contenteditable diverges across engines (`03-research-xterm-proxy.md §3 Recipe E cons`).

### 2.2 Modifier-bar approach — **Custom React row (`MB-R`) with the 14-key list frozen below; reserve Termux JSON schema (`MB-T`) for Phase-8 polish**

- **Pick.** Single-row sticky toolbar above the keyboard, 14 buttons, hand-coded React component (`ModifierKeyBar.tsx`). No JSON schema for v1; Termux-style `[[ROW1],[ROW2]]` config and per-app profiles are explicitly Phase-8+ scope.
- **Rationale.** `MB-R` is the smallest patch that meets Mobile UX Target #4 with provable layout fit at the 360 px viewport (one row of 14 buttons at 24 px width + 4 px gap = 388 px scroll width inside an `overflow-x-auto` container — exceeds viewport by design, scrolls horizontally, see `04-tradeoffs-mobile.md §4.2 MB-R cons`); `MB-T`'s schema parser + JSON edit UI is itself a sub-feature (`04-tradeoffs-mobile.md §4.2 MB-T cons`) and would slip the Phase-7 schedule. We therefore commit to `MB-R` for v1 and frame the schema as additive (the bar accepts a static array now; the schema replaces the array in a later phase without changing any consumers).

### 2.3 Modifier-key behavior — **Blink semantics (tap = one-shot, long-press ≥300 ms = lock, hold = auto-repeat)**

- **Pick.** `Ctrl` and `Alt` are sticky toggles: tap arms for the next character then auto-releases (`Ctrl + tapping a` → emits `\x01`); long-press (≥300 ms) locks until tapped again; non-modifier keys (`Esc`, `Tab`, `↑↓←→`, `Home/End/PgUp/PgDn`, `^C/^D/^L/^R`) auto-repeat at 0.5 s initial delay then 100 ms interval while held.
- **Rationale.** Blink Shell's gesture model is the most user-tested mobile-terminal accessory bar in the wild (`03-research-terminal-ux.md §1.2`) and matches the planner brief's tap=one-shot / long-press=lock / hold=auto-repeat default candidate. Termux-style sticky-only toggles (no auto-repeat) would mean `↑↑↑↑↑` to scroll back through history requires five taps; that's fundamentally worse for the Claude Code workflow where users scroll prior prompts.

### 2.4 Nav consolidation combo — **`NV-A` (4-tab MobileBottomBar + hamburger overflow), with tab semantics retargeted to (Terminal / Sessions / Chat / More)**

- **Pick.** Keep `MobileBottomBar.tsx:56` as the single persistent mobile nav surface but **repurpose its 4 tabs from the current (sessions/hub/symphony/system) to (Terminal / Sessions / Chat / More)**. The hamburger trigger in `Navbar.tsx:67-74` continues to open the existing left drawer (`pos/DashboardLayout.tsx:72-114`) which now also reachable via the "More" overflow popover and houses Hub / Symphony / System / Config / Skills / Memory / Hotkeys / Admin / Logout.
- **Rationale.** This is the leading default in the prompt and it dovetails with the inheritance facts (`MobileBottomBar` already exists, hamburger trigger already wired, slide-overs already AnimatePresence) — total delta is one rename of `MAIN_TABS` constants in `MobileBottomBar.tsx:7-12` plus new tab handlers wired to existing toggles. `NV-B` (top-app-bar + bottom sheet) loses the persistent thumb-zone surface that distinguishes a productivity app from a content app; `NV-D` (no chrome) re-architects `dashboard/page.tsx`'s `workspaceView` discriminated union and orphans HotkeysModal/AdminPanel (`04-tradeoffs-mobile.md §4.3 NV-D cons`); `NV-C` (3-tab + drawer) introduces a "More" tab as the third primary destination, which is a code smell.

### 2.5 Sheet/drawer library — **`vaul` (= `SH-V`)**

- **Pick.** Adopt `vaul@^0.9` (which depends on `@radix-ui/react-dialog`); use it for the Sessions bottom-sheet, the Chat bottom-sheet, the Files bottom-sheet, the Admin bottom-sheet, and the More overflow drawer. Reuse the existing `framer-motion` for non-sheet animations (icon-rail rail, modifier-key tap feedback) — vaul does not replace it.
- **Rationale.** vaul gives us drag-to-close with a velocity threshold, snap points (`[0.4, 0.9]` for chat / files), scaled-background, and native iOS-style physics — none of which we get from Radix Dialog alone (`03-research-nav-patterns.md §3.1, §3.2`); it inherits Radix Dialog's focus-trap, `aria-modal`, `Esc`-to-close, and scroll-lock so we get the missing a11y plumbing (`02-scan-navigation.md §1.3, §1.4`) for free. We pay +34 KB gzip; we accept that cost because the alternative (`SH-C` custom on existing framer-motion) requires hand-rolling focus-trap, scroll-lock, edge-swipe-cancel, and snap-point physics — easy to get subtly wrong and a permanent tax on every future sheet (`04-tradeoffs-mobile.md §4.4 SH-C cons`).

### 2.6 Viewport meta — **exact frozen string**

- **Pick.**
  ```html
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
  ```
  Emitted via Next.js 16 `viewport` Metadata export in `src/app/layout.tsx`:
  ```ts
  export const viewport: Viewport = {
    width: "device-width",
    initialScale: 1,
    viewportFit: "cover",
    interactiveWidget: "resizes-content",
    themeColor: "#000000",
  };
  ```
- **Rationale.** `viewport-fit=cover` is the only switch that activates `env(safe-area-inset-*)` for the notch / Dynamic Island / home-indicator (`03-research-xterm-proxy.md §2.2`); `interactive-widget=resizes-content` makes Chrome 108+ shrink the layout viewport when the keyboard opens (so `100dvh` re-layouts automatically); both are required by the prompt and missing today (`02-scan-styles.md §1, §8`). `themeColor: "#000000"` prevents the black iOS Safari status-bar tint mismatch on the dark-only theme; `user-scalable` is intentionally NOT pinned because we want users to be able to pinch-zoom on terminal output for accessibility.

### 2.7 dvh strategy — **Both: replace every `100vh`/`h-screen` with `100dvh`/`h-dvh` AND use `--vvh` from `useVisualViewport()` for the dashboard root**

- **Pick.** Two layers, applied together: (1) global migration of every `h-screen`, `min-h-screen`, `h-[100vh]`, `max-h-[80vh]`, `max-h-[85vh]` to `h-dvh`, `min-h-dvh`, `h-[100dvh]`, `max-h-[80dvh]`, `max-h-[85dvh]` respectively across the 7 sites listed in `02-scan-layout.md §4` and `02-scan-styles.md §4`; (2) the dashboard root container at `pos/DashboardLayout.tsx:49,53` switches to `style={{ height: "var(--vvh, 100dvh)" }}` where `--vvh` is updated by a new `useVisualViewport()` hook on every `visualViewport.resize` and `visualViewport.scroll` event.
- **Rationale.** `100dvh` alone solves URL-bar collapse on Android Chrome 108+ (which honors `interactive-widget=resizes-content`) but iOS Safari ignores `interactive-widget` and continues to overlay the keyboard on top of the layout viewport without resizing it (`03-research-xterm-proxy.md §2.2`); the JS fallback via `visualViewport` is the documented cross-browser source of truth and is the only path that pushes the modifier bar flush against the top of the keyboard on iOS (`03-research-terminal-ux.md §5.2`, `03-research-xterm-proxy.md §5`). Both layers are cheap and cooperate cleanly because `var(--vvh, 100dvh)` falls back to the static `100dvh` when JS hasn't run yet (SSR + first paint).

### 2.8 Safe-area scaffolding — **`SA-G` (CSS utilities authored in `globals.css`) — NOT a Tailwind plugin, NOT per-component inline**

- **Pick.** Add a small `@utility` block (Tailwind v4 syntax, see `02-scan-styles.md §2.2`) plus raw CSS classes to `globals.css`:
  ```css
  @utility pt-safe { padding-top: env(safe-area-inset-top); }
  @utility pb-safe { padding-bottom: env(safe-area-inset-bottom); }
  @utility pl-safe { padding-left: env(safe-area-inset-left); }
  @utility pr-safe { padding-right: env(safe-area-inset-right); }
  @utility h-safe-bottom { height: env(safe-area-inset-bottom); }
  @utility min-h-safe-bottom { min-height: env(safe-area-inset-bottom); }
  ```
- **Rationale.** Tailwind v4's `@utility` directive lets us author safe-area helpers without adding a Tailwind plugin package (the project has zero Tailwind plugins today per `02-scan-styles.md §2.2`); centralised in `globals.css`, they are drift-resistant (which is exactly what scattered z-index literals teach us NOT to do — `04-tradeoffs-mobile.md §4.6 SA-P cons`). Per-component inline styles (`SA-P`) would re-create the z-index literal mess on a different axis.

### 2.9 Z-index tokenisation — **`ZI-T` (Tailwind theme extend via `@theme inline`)**

- **Pick.** Declare z-index tokens in `globals.css`'s `@theme inline` block alongside existing color/font tokens:
  ```css
  @theme inline {
    --z-base: 0;
    --z-content: 10;
    --z-sticky: 20;
    --z-sidebar: 30;
    --z-panel: 40;
    --z-floating: 50;
    --z-modal: 60;
    --z-popup: 100;
    --z-palette: 9000;   /* renamed from 9998 — see §4 */
    --z-toast: 9500;
  }
  ```
  Generates first-class Tailwind classes `z-base`, `z-content`, `z-sticky`, `z-sidebar`, `z-panel`, `z-floating`, `z-modal`, `z-popup`, `z-palette`, `z-toast` (Tailwind v4 reads `--z-*` keys per the v4 docs). Existing `src/lib/z-index.ts:20-39` keeps its TS exports for inline-style call sites (`style={{ zIndex: Z.MODAL }}`) and is updated to import from the same numeric values.
- **Rationale.** The codebase is overwhelmingly Tailwind-class-based (`02-scan-styles.md §5` — 113 responsive-prefix hits) — first-class tokens give us `z-modal` instead of `z-[60]` literals at every call site, which is the only way to drift-protect 8+ overlay layers (`02-scan-layout.md §6`). Dual-publish via `globals.css` AND `lib/z-index.ts` means both Tailwind class-string consumers AND inline-style consumers (e.g. `motion.div style={{ zIndex: Z.MODAL }}`) read from one source. CSS variables (`ZI-C`) without Tailwind utility extension would still leave `z-[var(--z-modal)]` ugliness at every site.

### 2.10 Overlay coordination — **`OC-S` (mutex Zustand store), with focus-trap delegated to vaul/Radix**

- **Pick.** Introduce a tiny Zustand store (`src/stores/overlayStore.ts`, ~40 LOC) that tracks an enum-typed exclusive overlay slot: `"none" | "sessionsSheet" | "chatSheet" | "filesSheet" | "adminSheet" | "moreDrawer" | "hotkeysModal" | "commandPalette" | "providerWizard" | "providerConfig" | "imageLightbox"`. Opening any overlay calls `setActiveOverlay(slot)`; opening another auto-closes the previous via `useEffect` watching the store. Focus-trap and Esc-to-close come from vaul/Radix (no separate `focus-trap-react` dep needed).
- **Rationale.** The chat ↔ admin double-overlay bug at `dashboard/page.tsx:494-521` is documented (`02-scan-navigation.md §5.1`) and the prompt explicitly lists "Cmd+K no longer steals from ChatInput" alongside it as a success criterion — both are state-collision symptoms of the same missing coordinator. Zustand is preferred over a React context because it doesn't force every tree under a provider, doesn't re-render the whole tree on overlay change, and stays out of the way for the few non-overlay components (Terminal canvas, FitAddon scheduler) that should not subscribe. Adding `focus-trap-react` separately is rejected because vaul + Radix Dialog already ship the WAI-ARIA-compliant trap (`03-research-nav-patterns.md §3.1, §3.2`).

### 2.11 Cmd+K chord clash fix — **`CK-B` (both: scope guard now AND move CommandPalette to dedicated context)**

- **Pick.** Two-part fix, both applied in Phase 7. Part 1 (`CK-S`): patch `SessionPanel.tsx:228-235` keydown listener to bail when `e.target` is `INPUT`/`TEXTAREA`/`isContentEditable`. Part 2 (`CK-D`): lift CommandPalette out of `SessionPanel.tsx:78-80, 459-468, 484-540` into a new `src/components/CommandPalette.tsx` mounted as a sibling of `TerminalScrollProvider` at `dashboard/page.tsx:404` with state owned by the new `overlayStore`. Both go in WP-D (overlays).
- **Rationale.** `CK-S` alone closes the hot bug (Cmd+K stealing keystrokes from ChatInput) but leaves the structural debt that the palette is unavailable on non-`sessions` sections (`02-scan-navigation.md §6.6`); `CK-D` alone is a refactor without a hot-bug fix at the listener level. Doing both in the same WP-D pass is the same surface-area touch (we already have to read `SessionPanel.tsx` to relocate the palette) and produces a clean palette that survives section switches.

### 2.12 Tablet behavior — **Desktop layout at ≥768 px (the planner brief is binding here)**

- **Pick.** Tablet (768–1023 px) uses the current desktop layout unchanged: IconRail visible at `w-12`, SidePanel toggleable at `w-[280px]`, slide-overs at `md:w-96 md:z-20`, no MobileBottomBar (already `md:hidden`). No bespoke "tablet" middle-ground layout.
- **Rationale.** The prompt and the planner brief explicitly say "tablet ≥768 keeps desktop layout" (`01-planner-mobile.md §"Mobile UX Targets" #1`) — re-litigating this would expand scope and conflict with `useIsMobile.ts:4-13`'s 768 px constant which is already used in `FileManager.tsx:102`. Building a third layout would also blow Phase 7's parallel partition since WP-A, WP-B, WP-D all touch breakpoint-aware code; a third breakpoint multiplies that surface.

### 2.13 Chat input font-size — **Yes, bump to 16 px (`text-base`) on mobile (effectively all viewports — chat input is currently `text-sm` everywhere)**

- **Pick.** `ChatInput.tsx:203` changes `text-sm` to `text-base` unconditionally (16 px desktop and mobile). The same sweep applies to any other text-input that defeats iOS zoom-on-focus: Cmd-K palette input (`SessionPanel.tsx:519`), file-manager search input (any `<input>` with `text-sm`).
- **Rationale.** `text-sm` (14 px) is the documented trigger for iOS Safari zoom-on-focus (`02-scan-styles.md §6`); the desktop visual delta is +2 px which is acceptable for a chat input (the surrounding UI is already 14 px so chat gains visual prominence — desirable). Conditional `text-sm md:text-base` would be the fancier choice but produces a layout shift on resize and adds complexity for negligible visual benefit.

### 2.14 xterm `convertEol` — **Leave unset (xterm default = `false`)**

- **Pick.** Do not set `convertEol`. The PTY already does cooked-mode `\n` → `\r\n` translation via `onlcr` termios flag (this is `node-pty` default behavior), so output already arrives with proper `\r\n`. The current `Terminal.tsx:236-243` config is correct as-is.
- **Rationale.** Setting `convertEol: true` would make xterm convert `\n` to `\r\n` on input — but our input path goes through `term.input(data, true)` and onward via WS to the PTY which expects raw bytes; doubling the translation would produce `\r\r\n` on Enter (`02-scan-terminal.md §4`). The scan flagged this as left-default and we keep that intentionally.

### 2.15 Modifier bar position — **Sticky `position: fixed; bottom: 0` with `transform: translateY(-var(--kbd-height))` driven by `visualViewport`**

- **Pick.** The bar is a `position: fixed` element at `bottom: 0` whose `transform: translateY(calc(-1 * var(--kbd-height)))` is updated by the `useVisualViewport()` hook every time `visualViewport.resize` or `visualViewport.scroll` fires. `--kbd-height` is computed as `Math.max(0, window.innerHeight - visualViewport.height - visualViewport.offsetTop)`. When the keyboard is closed the transform is `0` (so the bar sits flush against the bottom safe-area inset via `padding-bottom: env(safe-area-inset-bottom)`); when open it slides up by exactly the keyboard's height.
- **Rationale.** `position: fixed; bottom: 0` is the only position that survives DOM scroll without compounded layout cost (`03-research-xterm-proxy.md §2.4`); driving the visible offset with `transform` (compositor-only) keeps animation buttery (no layout/paint thrash). Using `visualViewport.offsetTop` in the calculation matters because pinch-zoom shifts the visual viewport relative to the layout viewport, and ignoring `offsetTop` causes the bar to drift off-screen during zoom. Anchoring with `top: visualViewport.offsetTop + visualViewport.height - bar.height` (the alternative) would re-introduce paint cost on every event.

---

## 3. Frozen Breakpoint Map

| Tier | CSS pixel range | Tailwind prefix | Behavior |
|---|---|---|---|
| **mobile** | `0 – 767px` | (no prefix; default) | MobileBottomBar visible, hamburger drawer, all overlays as `vaul` sheets, MobileTerminalInput rendered, ModifierKeyBar rendered |
| **tablet** | `768 – 1023px` | `md:` | Desktop layout (IconRail + SidePanel + main column), MobileBottomBar hidden via `md:hidden`, slide-overs anchored at `md:absolute right-0 w-96 md:z-20`, no MobileTerminalInput, no ModifierKeyBar |
| **desktop** | `≥1024px` | `lg:` (rare) / `md:` | Same as tablet plus `lg:` opt-in for wider gutters and dual-pane FileExplorer (existing `pos/FileExplorer.tsx:224` `md:w-[250px]`) |

These match the existing `useIsMobile.ts:4-13` constant (768 px) and Tailwind v4 defaults in `02-scan-styles.md §2.2`. **No custom Tailwind `screens` extension is added** — the defaults are sufficient. The `useIsMobile()` hook is the canonical JS-side check; CSS uses `md:` prefix.

The prompt asked for explicit pixel ranges and three tiers — answered above. We deliberately skip a 4th "small mobile" tier (e.g. `<360px`) because the smallest target viewport per `01-planner-mobile.md §"Mobile UX Targets" #1` is 360×640.

---

## 4. Frozen Modifier-Key List

The bar exposes exactly **14 keys** in a single horizontally-scrollable row, partitioned into 3 groups separated by 1px vertical dividers. Every byte mapping is verified against `03-research-xterm-proxy.md §6.1` and `02-scan-terminal.md §4.2` and is what the PTY at `terminal-manager.js:518-525` expects. Arrows are DECCKM-aware via `term.modes.applicationCursorKeysMode`.

### Group A: Primary modifiers and navigation (8 keys)

| # | Label (visible) | Logical key | Bytes (hex) | Bytes (literal) | Type |
|---|---|---|---|---|---|
| 1 | `Esc` | Escape | `1B` | `\x1b` | one-shot |
| 2 | `Tab` | Tab | `09` | `\t` | one-shot |
| 3 | `Ctrl` | Control modifier | (none — modifier toggle) | (modifier flag) | sticky toggle (tap = one-shot, long-press = lock) |
| 4 | `Alt` | Alt modifier | (none — modifier toggle) | (modifier flag) | sticky toggle (tap = one-shot, long-press = lock) |
| 5 | `↑` | Arrow Up | normal: `1B 5B 41` / DECCKM: `1B 4F 41` | `\x1b[A` / `\x1bOA` | one-shot, auto-repeat |
| 6 | `↓` | Arrow Down | normal: `1B 5B 42` / DECCKM: `1B 4F 42` | `\x1b[B` / `\x1bOB` | one-shot, auto-repeat |
| 7 | `←` | Arrow Left | normal: `1B 5B 44` / DECCKM: `1B 4F 44` | `\x1b[D` / `\x1bOD` | one-shot, auto-repeat |
| 8 | `→` | Arrow Right | normal: `1B 5B 43` / DECCKM: `1B 4F 43` | `\x1b[C` / `\x1bOC` | one-shot, auto-repeat |

### Group B: Common chords (5 keys, prefixed `^` for "Ctrl")

| # | Label | Logical key | Bytes (hex) | Bytes (literal) | Type |
|---|---|---|---|---|---|
| 9 | `^C` | Ctrl+C (SIGINT) | `03` | `\x03` | one-shot |
| 10 | `^D` | Ctrl+D (EOF) | `04` | `\x04` | one-shot |
| 11 | `^L` | Ctrl+L (clear) | `0C` | `\x0c` | one-shot |
| 12 | `^R` | Ctrl+R (history search; Claude resume) | `12` | `\x12` | one-shot |
| 13 | `⇧Tab` | Shift+Tab (back-tab; Claude tool selector) | `1B 5B 5A` | `\x1b[Z` | one-shot |

### Group C: Cursor block (4 keys, accessible via long-press `↑` / `↓` to swap the arrow group to PgUp/PgDn/Home/End — Blink-style page swap)

| # | Label | Logical key | Bytes (hex) | Bytes (literal) | Type |
|---|---|---|---|---|---|
| 14 | `Home` | Home | `1B 5B 48` | `\x1b[H` | one-shot |
| (—) | `End` | End | `1B 5B 46` | `\x1b[F` | one-shot |
| (—) | `PgUp` | Page Up | `1B 5B 35 7E` | `\x1b[5~` | one-shot, auto-repeat |
| (—) | `PgDn` | Page Down | `1B 5B 36 7E` | `\x1b[6~` | one-shot, auto-repeat |

> **Note**: keys 14, End, PgUp, PgDn are *not* visible by default; the visible bar is keys 1–13 (13 buttons). The 14th visible button is a `⋯` overflow that swaps the arrows group (5–8) with `Home/End/PgUp/PgDn` in-place — Blink's "alternate cursor page" pattern from `03-research-terminal-ux.md §1.2`. This keeps the bar at one row at 360 px width.

### Modifier composition (Ctrl+letter, Alt+letter)

When `Ctrl` is armed (sticky or locked) and the user types a letter `[a-zA-Z]` in `MobileTerminalInput`, the input handler intercepts and forwards `String.fromCharCode(letter.toUpperCase().charCodeAt(0) - 64)` instead of the letter, then auto-disarms (unless locked). Examples: `Ctrl + a` → `\x01`, `Ctrl + z` → `\x1A`. Out-of-range letters (`Ctrl + 1`) emit the literal letter (no chord exists).

When `Alt` is armed and the user types any printable character, the handler prepends `\x1b` and forwards `\x1b<char>` (Esc-prefix per `xterm metaSendsEscape=true`, `03-research-xterm-proxy.md §6.1`). Examples: `Alt + b` → `\x1bb`, `Alt + .` → `\x1b.`.

`Ctrl` and `Alt` can both be armed simultaneously. `Ctrl + Alt + a` → `\x1b\x01`.

### Frozen list, locked

These 14 visible keys + 4 hidden cursor-page keys are the v1 modifier surface. Phase 8 polish may add a Termux-style JSON schema to make this user-editable; v1 ships hard-coded.

---

## 5. Architecture Sketch (ASCII)

### 5.1 Mobile (`<768px`), keyboard CLOSED

```
┌──────────────────────────────────────────────┐  ← screen top, status bar above
│  [pt-safe pad for notch]                     │
├──────────────────────────────────────────────┤
│  ≡  session-7    🔌 │ 💬¹ ⚙               │  ← Navbar h-14 (kept)
├──────────────────────────────────────────────┤  ← Navbar / stage divider
│                                              │
│                                              │
│              xterm canvas                    │
│              (DOM renderer)                  │
│                                              │
│              [presence cursors                │
│               render here at z-content]      │
│                                              │
│                                              │
│   <Terminal> mounted via dynamic(ssr:false)  │
│    inside <TerminalIOProvider> at page.tsx   │
│                                              │
├──────────────────────────────────────────────┤
│  [empty — MobileTerminalInput is hidden      │
│   because keyboard is closed; tapping        │
│   anywhere on canvas focuses it and opens kbd│
├──────────────────────────────────────────────┤
│  💻 Term  📂 Sess  💬 Chat  ⋯ More       │  ← MobileBottomBar h-14 (repurposed
│  (active tab indicator: 💻 underline)        │     tabs: terminal/sessions/chat/more)
├──────────────────────────────────────────────┤
│  [pb-safe pad for home indicator]            │
└──────────────────────────────────────────────┘  ← screen bottom
```

### 5.2 Mobile (`<768px`), keyboard OPEN

```
┌──────────────────────────────────────────────┐
│  [pt-safe pad]                                │
├──────────────────────────────────────────────┤
│  ≡  session-7    🔌 │ 💬¹ ⚙               │  ← Navbar (unchanged)
├──────────────────────────────────────────────┤
│              xterm canvas                    │
│              (resized via FitAddon when      │
│               visualViewport.resize fires)   │
│              [scrolled to cursor on          │
│               keyboard open]                 │
├──────────────────────────────────────────────┤
│  ▒▒▒  MobileTerminalInput (textarea)  ▒▒▒  │  ← real <textarea rows=1>, 16px,
│  inputmode=text enterkeyhint=send            │     bg-surface-alt, h-11 (44px)
├──────────────────────────────────────────────┤
│  Esc Tab Ctrl Alt ↑ ↓ ← → ^C ^D ^L ^R ⇧Tab ⋯│  ← ModifierKeyBar h-11, scrollable-x
├──────────────────────────────────────────────┤  ← top of soft keyboard (per
│                                              │     visualViewport.height,
│        [iOS / Android soft keyboard]         │     transform: translateY(-kbd))
│                                              │
│   QWERTYUIOP                                 │
│   ASDFGHJKL                                  │
│   ⇧ZXCVBNM ⌫                                 │
│   123  space  send                           │
└──────────────────────────────────────────────┘
```

Note: when the keyboard is open the **MobileBottomBar is hidden** (`bottom-0` becomes occluded by the keyboard anyway, and we additionally apply `display: none` when `useVisualViewport().isKeyboardOpen` is true to prevent it from peeking above the modifier bar in any browser that doesn't push the body up).

### 5.3 Mobile, Sessions sheet OPEN (vaul, swipes up from bottom)

```
┌──────────────────────────────────────────────┐
│  [pt-safe pad]                               │
├──────────────────────────────────────────────┤
│  ≡  session-7    🔌 │ 💬¹ ⚙   [dimmed bg]  │  ← scaled-down background (vaul)
├──────────────────────────────────────────────┤
│              xterm canvas (dimmed)           │
│              [scaled 0.95 by vaul]           │
├──────────────────────────────────────────────┤
│              ▔▔▔                             │  ← vaul drag handle
│   Сессии                              + новая│
│   ────────────────────────────────────       │
│   • session-7  ●  current                    │
│   • session-3                                │
│   • session-1                                │
│   • session-bench                            │
│                                              │
│   [snap point 0.4 — 40% screen height]       │
│   [drag up to expand to 0.9]                 │
└──────────────────────────────────────────────┘
```

`vaul` Drawer mounted at `dashboard/page.tsx`; tabs in MobileBottomBar trigger `setActiveOverlay("sessionsSheet")`. Same pattern for Chat (right swap), Files (full-height), Admin (full-height), More (drawer from left edge).

### 5.4 Tablet / Desktop (`≥768px`) — UNCHANGED

```
┌─────────┬─────────┬──────────────────────────────────┬──────────┐
│ IconRail│SidePanel│              Main column         │ ChatPanel│
│  w-12   │ w-[280px]│  ┌───────────────────────────┐  │ slide-   │
│         │         │  │ Navbar h-14                │  │ over     │
│  📁     │ Sessions│  ├───────────────────────────┤  │ md:w-96  │
│  📂     │ • s-7   │  │                           │  │ md:z-20  │
│  💬     │ • s-3   │  │      xterm canvas          │  │  (no     │
│  ⚙     │ • s-1   │  │      OR FileManager        │  │   change)│
│  📊     │   ＋    │  │      OR SkillDetail …      │  │          │
│  ⌨     │         │  │                           │  │          │
│         │         │  └───────────────────────────┘  │          │
└─────────┴─────────┴──────────────────────────────────┴──────────┘
   ← MobileBottomBar hidden (md:hidden)
   ← MobileTerminalInput not rendered (gated by useIsMobile())
   ← ModifierKeyBar not rendered (gated by useIsMobile())
   ← Hamburger button hidden (md:hidden in Navbar.tsx:70)
```

The desktop tree is exactly today's code (`02-scan-layout.md §1`) with two additions: (a) `vaul`'s `Drawer` is used to render AdminPanel as a side-anchored sheet on mobile only (`<md`); on `≥md` the existing `motion.div` slide-over remains as-is; (b) z-index literals are migrated to `z-modal`/`z-floating`/etc. tokens but the visual outcome is identical.

### 5.5 Component-mount table (where each new piece lives)

| New component | File path | Mounted at | Gated by |
|---|---|---|---|
| `useVisualViewport()` hook | `src/lib/useVisualViewport.ts` | (hook) | always-on, no-op fallback if `visualViewport` undefined |
| `useKeyboardHeight()` derived | (inside useVisualViewport) | (hook) | derived from `vv.height` + `vv.offsetTop` + `window.innerHeight` |
| `TerminalIOContext` provider | `src/contexts/TerminalIOContext.tsx` | `dashboard/page.tsx:404` (sibling of `TerminalScrollProvider`) | always |
| `MobileTerminalInput.tsx` | `src/components/terminal/MobileTerminalInput.tsx` | `dashboard/page.tsx` inside terminal stage (page.tsx:404-418) as a fixed-position element | `useIsMobile() === true` AND `useVisualViewport().isKeyboardOpen === true` |
| `ModifierKeyBar.tsx` | `src/components/terminal/ModifierKeyBar.tsx` | same as above; sibling of MobileTerminalInput | same gate |
| `useModifierState()` hook | `src/lib/useModifierState.ts` | (hook) | consumed by both MobileTerminalInput and ModifierKeyBar |
| `overlayStore` (Zustand) | `src/stores/overlayStore.ts` | (module) | consumed by every overlay opener (MobileBottomBar, Navbar buttons, IconRail buttons, sheet wrappers) |
| `SessionSheet.tsx` (vaul) | `src/components/mobile/SessionSheet.tsx` | `dashboard/page.tsx`, sibling of existing slide-overs | `useIsMobile()` |
| `ChatSheet.tsx` (vaul) | `src/components/mobile/ChatSheet.tsx` | same | `useIsMobile()` |
| `FilesSheet.tsx` (vaul) | `src/components/mobile/FilesSheet.tsx` | same | `useIsMobile()` |
| `AdminSheet.tsx` (vaul) | `src/components/mobile/AdminSheet.tsx` | same | `useIsMobile()` |
| `MoreDrawer.tsx` (vaul left) | `src/components/mobile/MoreDrawer.tsx` | same | `useIsMobile()` |
| `CommandPalette.tsx` (lifted) | `src/components/CommandPalette.tsx` | `dashboard/page.tsx:404` (sibling of `TerminalScrollProvider`) | always (visible only when `overlayStore.activeOverlay === "commandPalette"`) |

The desktop AdminPanel / ChatPanel slide-overs at `dashboard/page.tsx:494-521` keep their existing `motion.div` implementation but are wrapped in `if (!isMobile)` gates; on mobile, the `vaul` Sheet variants render instead. This avoids any mid-resize flicker.

---

## 6. Success Criteria

Each criterion is **measurable**, **testable in Phase 8**, and gated as PASS/FAIL — partial passes are FAIL.

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

## 7. Rejected Alternatives (one-line reasons)

- **`IP-A` (style xterm.textarea on mobile)** — Brittle to xterm version bumps; helper textarea reflows on every fit (`03-research-xterm-proxy.md §1.6`).
- **`IP-C` (raw WS bypass)** — Breaks bracketed-paste, breaks DA/CPR filter, forks WS contract; hard-conflicts #1 and #2 in `04-tradeoffs-mobile.md §5`.
- **`IP-E` (contenteditable overlay)** — `contenteditable` diverges across engines, React doesn't track it cleanly, IME consistency is worse than `<textarea>` (`03-research-xterm-proxy.md §3 Recipe E cons`).
- **`MB-S` (swipeable two-row bar)** — Swipe gesture conflicts with xterm two-finger scroll inside terminal (`04-tradeoffs-mobile.md §5 #7`); we get the same effect via a single ⋯ button that swaps arrows ↔ cursor block in-place.
- **`MB-T` (Termux JSON schema) for v1** — Schema parser + edit UI is a sub-feature; deferred to Phase 8 polish (we adopt the schema *contract* by making `ModifierKeyBar` accept a static array — same shape as the future schema).
- **`MB-N` (no modifier bar)** — Fails Mobile UX Target #4 outright; VS Code Web ships this and openly admits it's broken (`03-research-terminal-ux.md §1.9, §2.5`).
- **`NV-B` (top app-bar + bottom-sheet sessions)** — Loses the persistent thumb-zone surface; diverges most from the existing `MobileBottomBar` baseline and orphans the hamburger trigger.
- **`NV-C` (3-tab + drawer)** — "More" overflow tab is a code smell; sessions-in-drawer pattern is harder to discover than sessions-as-tab.
- **`NV-D` (no chrome, push-stack)** — Re-architects `dashboard/page.tsx`'s `workspaceView` discriminated union and orphans HotkeysModal/AdminPanel mounts (`04-tradeoffs-mobile.md §4.3 NV-D cons`).
- **`SH-R` only (Radix Dialog without vaul)** — No drag-to-close; chat looks "modal" not "sheet" on mobile.
- **`SH-A` (Aceternity Sheet)** — +80 KB+ deps via framer-motion opinions; mixed a11y audit; opinionated styling fights Geist palette (`04-tradeoffs-mobile.md §4.4 SH-A cons`).
- **`SH-C` (custom on existing framer-motion)** — Saves +34 KB but re-implements focus-trap, scroll-lock, edge-swipe-cancel, snap-point physics — easy to get subtly wrong; a permanent tax on every future sheet.
- **`VP-W` only (meta hint, no JS listener)** — iOS Safari ignores `interactive-widget`; modifier bar would not pin to keyboard on iOS without `useVisualViewport()`.
- **`VP-V` only (JS listener, no meta hint)** — Loses Chrome 108+'s automatic `100dvh` re-layout, costs us extra repaints; `viewport-fit=cover` not enabled means `env(safe-area-inset-*)` returns 0.
- **`VP-N` (status quo)** — Fails Mobile UX Targets #1, #5, #10 outright (`02-scan-styles.md §4` "critical trap").
- **`SA-T` Tailwind plugin (separate npm package)** — Adds a dep when the project has zero Tailwind plugins today; v4's `@utility` directive in `globals.css` covers the same surface.
- **`SA-P` per-component inline** — Re-creates the z-index literal mess on a different axis.
- **`ZI-N` status quo z-index literals** — 8 distinct literal layers (10/20/30/40/50/60/100/9998 + 5000) with no semantic anchor; `04-tradeoffs-mobile.md §5 #10` documents the active collision.
- **`ZI-S` only (TS const enum)** — Doesn't help Tailwind class strings (`z-[60]` literals stay); Tailwind theme extend is needed alongside.
- **`OC-N` no overlay coordination** — Live chat ↔ admin double-overlay bug stays; doesn't satisfy the "no chrome conflicts" implicit requirement.
- **`OC-F` only focus-trap** — Solves a11y but not state collision (chat ↔ admin can still both be "open" in state).
- **`CK-S` only scope guard** — Closes the hot bug but leaves the structural debt; CommandPalette unavailable on non-`sessions` sections (`02-scan-navigation.md §6.6`).
- **`CK-D` only context refactor** — Doesn't add the e.target-tagName scope guard that prevents typing-in-input from triggering palette.
- **Tablet (768–1023 px) middle-ground layout** — Conflicts with the planner brief and would multiply WP-A/WP-B/WP-D file ownership.

---

## 8. Work-Package Partition

Four disjoint partitions for the four Phase-7 implementer agents. Files appear in **owned** for exactly one partition; **read-only** lists are non-owners that will read but not modify.

### WP-A — Shell, viewport, breakpoints, tokens (`impl-layout-shell`)

**Files owned (write):**
- `src/app/layout.tsx` — add `viewport` Metadata export per §2.6.
- `src/app/globals.css` — add safe-area `@utility` block per §2.8; add z-index tokens to `@theme inline` per §2.9; add `--vvh` CSS variable consumer; add `touch-action: manipulation` and `overscroll-behavior: contain` to `.terminal-host` and `body`; remove `cursor: none !important` if it breaks mobile-input caret (verify in WP-C).
- `src/components/pos/DashboardLayout.tsx` — replace `flex h-screen` (lines 49, 53) with `flex` + `style={{ height: "var(--vvh, 100dvh)" }}`; ensure top-level container also has `overflow: hidden` to prevent leak.
- `src/lib/z-index.ts` — extend `Z` const to mirror new tokens (`PALETTE`, `TOAST`); update existing values to match `globals.css`.
- `src/lib/useIsMobile.ts` — keep as is, but verify 768 px constant matches Tailwind `md:` (it does).
- `src/lib/useVisualViewport.ts` — **NEW** — hook per §2.7 + §2.15; pushes `--vvh`, `--kbd-height`, `--vv-offset-top` CSS vars to `document.documentElement` on every event.
- `src/components/ui/aurora-background.tsx`, `src/components/ui/lamp.tsx` — replace `100vh` / `min-h-screen` with `100dvh` / `min-h-dvh` (these are unused on dashboard but reachable from auth/welcome routes).
- `src/app/global-error.tsx` — `height: "100vh"` → `height: "100dvh"`.
- `src/components/HotkeysModal.tsx`, `src/components/ProviderWizardModal.tsx`, `src/components/symphony/CreateTaskModal.tsx`, `src/components/chat/ImageLightbox.tsx` — replace `max-h-[80vh]` / `max-h-[85vh]` / `max-h-[90vh]` with `max-h-[80dvh]` / `max-h-[85dvh]` / `max-h-[90dvh]`.

**Files read-only:**
- `package.json` — verify Tailwind v4 supports `@theme inline { --z-* }` (it does per `02-scan-styles.md §2.2`).
- `next.config.ts` — verify no conflicting head/meta config.

**Outputs:** code edits + `agent-workflow/07a-impl-shell.md` changelog.

---

### WP-B — Navigation: MobileBottomBar repurpose, hamburger, sheet wrappers (`impl-mobile-navigation`)

**Files owned (write):**
- `src/components/Navbar.tsx` — bump every `p-2` icon button (lines 130, 144, 151, 164, 171) to `p-2.5` to hit 44 px tap targets; add `aria-label` to chat/admin/hamburger buttons (currently `title` only); switch z-index literals (none currently in this file but `top-1` etc. should use tokens).
- `src/components/pos/DashboardLayout.tsx` — split mobile drawer logic: keep desktop tree (`hidden md:flex`) as-is; replace mobile `AnimatePresence` block (lines 72-114) with a `vaul` `Drawer.Root` for the More/IconRail panel that subscribes to `overlayStore` slot `"moreDrawer"`. (Note: this file is also touched by WP-A for the `h-screen` migration — split the responsibilities by line range; WP-A owns lines 49 & 53, WP-B owns lines 55-114; coordinate via the integration plan.)
- `src/components/pos/MobileBottomBar.tsx` — repurpose `MAIN_TABS` (lines 7-12) from (sessions/hub/symphony/system) to (terminal/sessions/chat/more); each tab handler invokes `overlayStore.setActiveOverlay()` for sheets or `setWorkspaceView()` for terminal; add `pb-safe` and `display: hidden` when `useVisualViewport().isKeyboardOpen`.
- `src/components/pos/SidePanel.tsx` — no behavior change; verify the switch over `activeSection` still works when invoked from inside a vaul Drawer.
- `src/components/pos/SessionPanel.tsx` — no behavior change; will be wrapped by `SessionSheet.tsx` (owned by WP-D actually — see below).
- `src/components/pos/IconRail.tsx` — adjust `hotkeysOpen` ownership: move the modal mount from IconRail to `dashboard/page.tsx` and consume `overlayStore.activeOverlay === "hotkeysModal"` instead. (Note: this overlaps with WP-D's CommandPalette lift; we keep the HotkeysModal mount migration in WP-B because IconRail is owned here.)
- `src/components/pos/MobileBottomBar.tsx` overflow popover — replace the local `bottom-14 right-2 z-50` popover with a vaul drawer for "More" content, slot `"moreDrawer"`.

**Files read-only:**
- `src/lib/NavigationContext.tsx` — read to understand `activeSection` / `panelOpen` / `workspaceView` semantics.
- `src/stores/overlayStore.ts` (created by WP-D) — read API.

**Outputs:** code edits + `agent-workflow/07b-impl-nav.md`.

**Note**: `MobileNav.tsx` is NOT created — the prompt asked "if any" and we rely on the existing `MobileBottomBar` + a thin `MoreDrawer.tsx` (which is owned by WP-D). No new top-level mobile-nav component.

---

### WP-C — Terminal input proxy, modifier bar, IO context, visualViewport listener (`impl-terminal-input-proxy`)

**Files owned (write):**
- `src/components/Terminal.tsx` — at line ~258 (after `xtermRef.current = term;`), expose `xtermRef` and `wsRef` via `TerminalIOContext` (add `useContext` consumer pattern); leave the `onData → ws.send` listener at lines 213-221 unchanged (this is the inviolable contract); add a `pointerdown` listener on `terminalRef.current` (the wrapper at line 425-428) that, when `useIsMobile()` is true, focuses `MobileTerminalInput`'s ref (via context); add a `useEffect` that listens on `window.visualViewport.resize` AND `visualViewport.scroll` to trigger `handleResize()` (which already exists at lines 362-375) — fixes the documented bottom-of-terminal-hidden-by-keyboard bug from `02-scan-terminal.md §5.3`; debounce the WS resize message at 150 ms.
- `src/components/EphemeralTerminal.tsx` — same `visualViewport` resize listener (mirrors `Terminal.tsx`); no `MobileTerminalInput` since this is the auth wizard embed (low value), but keyboard-resize bug should be fixed.
- `src/components/terminal/MobileTerminalInput.tsx` — **NEW** — Recipe `IP-B + IP-D` blend per §2.1; consumes `TerminalIOContext` for `xtermRef`; renders only when `useIsMobile() && useVisualViewport().isKeyboardOpen` (so it doesn't take vertical space when keyboard is closed); `text-base` (16px) per §2.13.
- `src/components/terminal/ModifierKeyBar.tsx` — **NEW** — 14-key bar per §4; consumes `xtermRef.current.modes.applicationCursorKeysMode` for arrow encoding; consumes `useModifierState()` hook for Ctrl/Alt sticky logic; calls `xtermRef.current?.input(bytes, true)` for byte injection (so existing `onData` filter applies); `position: fixed; bottom: 0; transform: translateY(calc(-1 * var(--kbd-height)))` per §2.15.
- `src/contexts/TerminalIOContext.tsx` — **NEW** — exposes `{xtermRef, wsRef, terminalElementRef, mobileInputRef}` so MobileTerminalInput, ModifierKeyBar, and any future tester can reach into them without prop-drilling.
- `src/lib/useModifierState.ts` — **NEW** — hook returning `{ctrl, alt, ctrlLocked, altLocked, armCtrl, armAlt, lockCtrl, lockAlt, consumeModifiers}` per §2.3 + §4.

**Files read-only:**
- `src/lib/useVisualViewport.ts` (created by WP-A) — read for keyboard height.
- `src/lib/mobile-input.ts` — created here actually (the KEYS map per `03-research-xterm-proxy.md §3 prelude`).
- `src/lib/z-index.ts` — read for `Z.STICKY` etc.
- `src/lib/useIsMobile.ts` — read.

**Outputs:** code + `agent-workflow/07c-impl-terminal.md`.

---

### WP-D — Overlays: chat, files, admin, hotkeys, command palette, mutex store (`impl-overlays-chat-files`)

**Files owned (write):**
- `src/components/chat/ChatPanel.tsx` — no behavior change; add `pb-safe` on the input row and ensure `flex flex-col h-full` works when wrapped in a vaul sheet (vaul handles its own sizing).
- `src/components/chat/ChatInput.tsx` — line 203: `text-sm` → `text-base` per §2.13; remove `disabled:opacity-30` collision with vaul's own opacity transitions if any.
- `src/components/FileManager.tsx` — verify `useIsMobile()` swap to `MOBILE_COLUMNS` works inside a sheet; add `pb-safe` on the bottom toolbar.
- `src/components/AdminPanel.tsx` — no behavior change; will be wrapped by `AdminSheet.tsx`.
- `src/components/HotkeysModal.tsx` — replace bespoke backdrop + centered card with a vaul `Drawer` (bottom on mobile, centered Radix Dialog on desktop); subscribe to `overlayStore` slot `"hotkeysModal"`; remove `max-h-[80vh]` (vaul sizes itself).
- `src/components/CommandPalette.tsx` — **NEW** — extracted from `SessionPanel.tsx:78-80, 459-468, 484-540`; mounted at `dashboard/page.tsx:404` as a sibling of `TerminalScrollProvider`; subscribes to `overlayStore` slot `"commandPalette"`; the keydown listener (currently at `SessionPanel.tsx:228-235`) is moved here AND gets the `e.target.tagName !== "INPUT" && e.target.tagName !== "TEXTAREA" && !e.target.isContentEditable` guard per §2.11.
- `src/components/pos/SessionPanel.tsx` — remove the CommandPalette markup (lines 484-540) and the `paletteOpen` / `paletteQuery` / `paletteIndex` state (lines 78-80) and the keydown listener (lines 228-235) that moved into `CommandPalette.tsx`.
- `src/components/mobile/SessionSheet.tsx` — **NEW** — vaul `Drawer.Root direction="bottom" snapPoints={[0.4, 0.9]}` that wraps the existing `SessionPanel` content (without the IconRail wrapper); subscribes to `overlayStore` slot `"sessionsSheet"`.
- `src/components/mobile/ChatSheet.tsx` — **NEW** — same pattern, slot `"chatSheet"`, snap points `[0.5, 0.95]`.
- `src/components/mobile/FilesSheet.tsx` — **NEW** — same, slot `"filesSheet"`, full-height (snap=`[1]`).
- `src/components/mobile/AdminSheet.tsx` — **NEW** — same, slot `"adminSheet"`, full-height.
- `src/components/mobile/MoreDrawer.tsx` — **NEW** — vaul `Drawer.Root direction="left"` with the existing IconRail content + secondary nav (Hub, Config, Skills, Memory, Symphony, System, Hotkeys, Admin, Logout); subscribes to `overlayStore` slot `"moreDrawer"`.
- `src/stores/overlayStore.ts` — **NEW** — Zustand store per §2.10; types: `OverlaySlot` enum, `setActiveOverlay(slot: OverlaySlot)`, `closeAll()`, `useOverlay(slot): boolean`.
- `src/app/dashboard/page.tsx` — biggest single touch outside the new files: wrap `<TerminalScrollProvider>` in `<TerminalIOProvider>` (which in turn wraps `<CommandPalette>` and the new mobile sheets); replace lines 494-521 (existing AdminPanel/ChatPanel slide-overs) with conditional rendering: desktop uses existing motion.div, mobile uses the new `*Sheet` components; wire MobileBottomBar tab handlers to `overlayStore.setActiveOverlay`. (Note: this file is the integration nexus; `dashboard/page.tsx` ownership is split: WP-D owns the overlay mount section, WP-B does NOT touch this file — WP-B's nav changes are in MobileBottomBar/IconRail/SidePanel.)

**Files read-only:**
- `src/contexts/TerminalIOContext.tsx` (created by WP-C).
- `src/lib/useIsMobile.ts`.
- `src/lib/z-index.ts` (extended by WP-A).

**Outputs:** code + `agent-workflow/07d-impl-overlays.md`.

---

### Disjointness check

| File | Owner |
|---|---|
| `src/app/layout.tsx` | WP-A |
| `src/app/globals.css` | WP-A |
| `src/app/dashboard/page.tsx` | WP-D (overlay mount + provider wiring) |
| `src/app/global-error.tsx` | WP-A |
| `src/components/Navbar.tsx` | WP-B |
| `src/components/Terminal.tsx` | WP-C |
| `src/components/EphemeralTerminal.tsx` | WP-C |
| `src/components/HotkeysModal.tsx` | WP-D |
| `src/components/CommandPalette.tsx` (new) | WP-D |
| `src/components/AdminPanel.tsx` | WP-D |
| `src/components/FileManager.tsx` | WP-D |
| `src/components/chat/ChatPanel.tsx` | WP-D |
| `src/components/chat/ChatInput.tsx` | WP-D |
| `src/components/pos/DashboardLayout.tsx` | **shared** — WP-A owns lines 49 & 53 (h-screen migration); WP-B owns lines 55-114 (drawer refactor) |
| `src/components/pos/IconRail.tsx` | WP-B |
| `src/components/pos/MobileBottomBar.tsx` | WP-B |
| `src/components/pos/SessionPanel.tsx` | WP-D (CommandPalette extraction) |
| `src/components/pos/SidePanel.tsx` | WP-B |
| `src/components/terminal/MobileTerminalInput.tsx` (new) | WP-C |
| `src/components/terminal/ModifierKeyBar.tsx` (new) | WP-C |
| `src/components/mobile/SessionSheet.tsx` (new) | WP-D |
| `src/components/mobile/ChatSheet.tsx` (new) | WP-D |
| `src/components/mobile/FilesSheet.tsx` (new) | WP-D |
| `src/components/mobile/AdminSheet.tsx` (new) | WP-D |
| `src/components/mobile/MoreDrawer.tsx` (new) | WP-D |
| `src/contexts/TerminalIOContext.tsx` (new) | WP-C |
| `src/stores/overlayStore.ts` (new) | WP-D |
| `src/lib/useVisualViewport.ts` (new) | WP-A |
| `src/lib/useModifierState.ts` (new) | WP-C |
| `src/lib/mobile-input.ts` (new) | WP-C |
| `src/lib/z-index.ts` (existing) | WP-A |
| `src/lib/useIsMobile.ts` (existing, no edits expected) | (none) |
| `src/components/ui/aurora-background.tsx`, `src/components/ui/lamp.tsx` | WP-A |

The single shared file is `pos/DashboardLayout.tsx` — WP-A and WP-B operate on **disjoint line ranges** (WP-A: lines 48-53; WP-B: lines 55-114). They merge cleanly via standard git three-way merge as long as both agents respect the line boundary. The integration plan (Phase 6) must enumerate this explicitly.

---

## 9. Feature Flag

**Flag name**: `NEXT_PUBLIC_MOBILE_OVERHAUL_ENABLED` (read at build time via `process.env`).

**Gating logic**:
```ts
// src/lib/featureFlags.ts (new)
export const MOBILE_OVERHAUL_ENABLED =
  process.env.NEXT_PUBLIC_MOBILE_OVERHAUL_ENABLED === "true";
```

**What it gates**:
- The new `viewport` Metadata export (falls back to Next.js default if disabled).
- The vaul `Drawer` mounts in `dashboard/page.tsx` (falls back to existing motion.div slide-overs).
- The MobileTerminalInput / ModifierKeyBar render gates (always `false` if flag off).
- The CommandPalette extraction (CommandPalette renders only if flag on AND `overlayStore.activeOverlay === "commandPalette"`; otherwise the existing in-SessionPanel palette renders — this requires WP-D to keep the old palette in `SessionPanel.tsx` as a deprecated fallback for the rollout window).
- The MobileBottomBar tab semantics (falls back to existing tabs/handlers if flag off).
- The `h-screen → h-dvh` migration: gated via Tailwind `safelist` if needed, or via class-name swap at runtime (but probably this is best applied unconditionally because the visual delta on desktop is zero — `dvh === vh` on desktop).

**Default**: `false` until Phase 9 audit passes; flipped to `true` at deploy after `09-audit.md` reaches all-PASS.

**Rollback path**: revert `NEXT_PUBLIC_MOBILE_OVERHAUL_ENABLED=false` in `.env`, redeploy via `bash /root/projects/claude-terminal/deploy.sh` blue-green; the desktop layout is unaffected so this is a one-button revert.

This flag does NOT need to be user-visible per session — it's a global rollout gate, not an A/B test (claude-terminal is a single-tenant tool). If per-user rollout is later desired, the flag can be re-keyed against `currentUser.id`.

---

## 10. Open Risks

These are explicitly flagged for the user to be aware of post-rollout:

1. **iOS Safari `visualViewport.resize` post-animation jank (~300 ms)**. The keyboard animation completes before `visualViewport.resize` fires; for ~300 ms the modifier bar is at its old position. Mitigation: also listen to `focusin`/`focusout` on the document to start the slide animation pre-emptively (`03-research-xterm-proxy.md §5 cross-browser notes`); residual risk is a 50 ms perceptible delay on first keyboard open per session.
2. **Samsung Keyboard skips `keydown` for letters** — Recipe `IP-B+D` relies on `input` events, which Samsung does fire. Verified plan; residual risk is that exotic Android keyboards (Microsoft SwiftKey landscape mode) may have unique quirks not covered by the Phase-8 emulation tests.
3. **vaul drag handle vs xterm two-finger scroll on the terminal canvas**. The chat sheet snap point `[0.5, 0.95]` means at 50% the sheet covers half the screen, including the terminal canvas — dragging the drag handle works, but dragging anywhere else might be ambiguous. Mitigation: `vaul` exposes `dismissible` and only the drag handle / scrim is draggable; verify in Phase 8c.
4. **`attachCustomKeyEventHandler(() => false)` is permanent** — xterm has no API to *remove* a custom handler (`03-research-xterm-proxy.md §1.4`). On viewport-flip from mobile to desktop (e.g. user rotates a tablet from portrait 600px to landscape 900px), we replace the handler with `() => true` to restore default behavior; verify no off-by-one on the `useIsMobile()` boundary.
5. **CommandPalette extraction risk**: `SessionPanel.tsx` is 684 lines and the palette is intertwined (state + keydown listener + render); the extraction is mechanical but easy to drop a state initialization. Mitigation: WP-D agent runs an explicit smoke test ("Cmd+K opens palette, Esc closes, arrow keys navigate, Enter selects session") in `07d-impl-overlays.md`.
6. **Fullscreen toggle behavior**. Today, `dashboard/page.tsx:78` `fullscreen` state hides the Navbar (`showNavbar = !fullscreen`, line 315) and short-circuits DashboardLayout — but on mobile this also hides the MobileBottomBar (because the fullscreen short-circuit bypasses the bar's mount). In v1 we accept this: fullscreen on mobile means truly full-screen terminal, no chrome. Documented as a "feature" in the success criteria — re-toggling fullscreen via the floating button (`page.tsx:407-413`) restores chrome.
7. **Safe-area on Android Chrome**. `env(safe-area-inset-*)` returns 0 on most Android browsers because Android doesn't have a notch/Dynamic Island concept the same way iOS does; our `pb-safe` etc. utilities will pad by 0 there. This is correct behavior — we just shouldn't expect visible padding on Android.
8. **Bracketed-paste mode on `term.paste(text)` requires the shell to enable `\x1b[?2004h`**. zsh, bash, fish, and most modern shells do enable it by default; if a custom shell (e.g. `dash`, embedded REPL) doesn't, `term.paste(text)` falls back to inserting raw bytes — same as if the user typed them. No regression vs today.
9. **Auto-repeat timer leakage**. `ModifierKeyBar`'s hold-to-auto-repeat is implemented as `setInterval` cleared on `pointerup`/`pointercancel`/`pointerleave`. If a `pointerleave` fires before `pointerup` (e.g. user drags off the button), the timer must clear; this is the most common bug class for hold-to-repeat UIs. WP-C agent owns explicit test for this.
10. **Mutex mid-transition flicker**. Closing one sheet and opening another happens in the same render tick via `overlayStore.setActiveOverlay(newSlot)` which sets the new slot but the previous slot's `useEffect` cleanup may dismiss the old sheet on the next tick — visible flicker possible. Mitigation: implement `setActiveOverlay` to first call the previous slot's close-handler synchronously, then schedule the new slot; verify in Phase 8c.

---

## 11. Out of Scope (explicitly NOT in this overhaul)

- **Termux JSON schema for user-customisable bars** — deferred to Phase 8+ polish.
- **Per-app modifier-bar profiles** (auto-swap when `vim`/`htop` runs in the foreground) — deferred (terminal-ux §5.5).
- **Voice input affordance** ("press-and-hold to dictate") — deferred.
- **Predictive command bar / AI-suggested chips** — deferred.
- **Haptic feedback** (`navigator.vibrate(20)` on key tap) — deferred (Native-feeling bundle only).
- **Animated keyboard tracker** (RAF-smoothed `visualViewport` interpolation) — deferred (Native-feeling bundle only); Phase 7 ships event-driven (which is correct, just unfiltered).
- **PWA install manifest tuning** (`scope`, `start_url`, `display: standalone`) — separate work.
- **Webgl/Canvas xterm renderer on mobile** — keep DOM renderer (default); benchmark in Phase 8 and revisit if FPS misses target.
- **Mouse-tracking via `term.onBinary`** — currently unused; unchanged.
- **`dashboard/page.tsx`'s heavy presence overlay (`CursorOverlay.tsx`)** — left as-is on mobile (renders, but presence cursors from desktop users are still relevant for collaboration; if perf is an issue in Phase 8b, gate by `useIsMobile()` and disable on mobile).
- **Symphony / System / Hub / Config / Skills / Memory mobile redesign** — out of scope; these views work today and are accessed via the More drawer on mobile.
- **The right-side AdminPanel / ChatPanel slide-over on desktop (`md:absolute right-0 w-96`)** — kept as-is; we only rewrap them with `vaul` on mobile via the conditional gate.
- **`server.js` / `terminal-manager.js` changes** — zero. The WS contract is preserved.
- **Anything tmux-streaming related** — separate workstream tracked in `04-tradeoffs-tmux.md`.
- **Tablet-specific layout variant** — reuses desktop per §2.12.

---

## 12. Implementation Notes for Phase 6 / Phase 7

### 12.1 Why `IP-B + IP-D` is one component, not two

The prompt asks for "a stated blend (default candidate from tradeoffs: B+D)". To be unambiguous: `MobileTerminalInput.tsx` is a **single** React component. It uses a `<textarea rows={1}>` (the `IP-D` substrate, not the `IP-B` `<input>`) but follows the `IP-B` outbox philosophy *outside* of composition windows. Pseudocode flow:

```ts
// inside MobileTerminalInput.tsx
const composingRef = useRef(false);

const handleInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
  if (composingRef.current) {
    setDraft((e.target as HTMLTextAreaElement).value); // visible draft only
    return;                                             // don't ship yet
  }
  const v = (e.target as HTMLTextAreaElement).value;
  if (!v) return;
  xtermRef.current?.input(applyArmedModifiers(v), true); // ship via term.input
  setDraft("");
  (e.target as HTMLTextAreaElement).value = "";
};

const handleCompositionStart = () => { composingRef.current = true; };
const handleCompositionEnd = (e: React.CompositionEvent<HTMLTextAreaElement>) => {
  composingRef.current = false;
  const final = e.data ?? taRef.current?.value ?? "";
  if (final) xtermRef.current?.input(final, true);       // ship full composition
  setDraft("");
  if (taRef.current) taRef.current.value = "";
};
```

`applyArmedModifiers(v)` is the single character pre-processor that converts `v` into bytes when `Ctrl` or `Alt` is armed (per §4 modifier composition rules) and clears the arm flag (unless locked). For multi-character inputs (paste, voice dictation final phrase), modifiers do not apply per-character — they apply to the first character only and then auto-disarm. This matches Blink's behavior.

### 12.2 The `term.attachCustomKeyEventHandler(() => false)` cleanup gotcha

Per `03-research-xterm-proxy.md §1.4` and `04-tradeoffs-mobile.md §4.1 IP-B cons`, xterm has no API to *remove* a custom key event handler — only to *replace* it. WP-C's `MobileTerminalInput.tsx` mounts a `() => false` handler on mount and a `() => true` handler on unmount. Two follow-on consequences:

(a) The existing handler in `Terminal.tsx:299-333` (which handles desktop Ctrl+Shift+C / Ctrl+V) gets clobbered when MobileTerminalInput mounts on mobile. Since MobileTerminalInput is gated by `useIsMobile() === true`, the desktop user never enters this state. But on a **tablet rotated from portrait** (where `useIsMobile()` flipped from true → false during the rotation), the handler reverts to `() => true` which is **less** than what `Terminal.tsx:299` originally installed (the Ctrl+Shift+C copy logic is gone). Mitigation: WP-C must export an explicit re-installer for the desktop handler and call it on cleanup; the integration plan (Phase 6) will spec this.

(b) The `attachCustomKeyEventHandler(() => false)` returns `false` for **every** keydown including `keyup` events; per the docs that's correct, but be aware no `keyup`-driven logic in xterm runs while mobile is active. Currently xterm doesn't have any such logic; flag for future xterm version bumps.

### 12.3 The `dashboard/page.tsx` provider stack at line 404

After WP-D's edit, the provider stack at `dashboard/page.tsx:404` becomes:

```tsx
<TerminalIOProvider>           {/* WP-C */}
  <TerminalScrollProvider>     {/* existing */}
    <CommandPalette />         {/* WP-D, lifted from SessionPanel */}
    {/* terminal stage */}
    {isMobile && (
      <>
        <SessionSheet />        {/* WP-D */}
        <ChatSheet />           {/* WP-D */}
        <FilesSheet />          {/* WP-D */}
        <AdminSheet />          {/* WP-D */}
        <MoreDrawer />          {/* WP-D */}
      </>
    )}
    {!isMobile && (
      <>
        {/* existing motion.div slide-overs at lines 494-521 */}
      </>
    )}
  </TerminalScrollProvider>
</TerminalIOProvider>
```

The `overlayStore` is a Zustand store, not a context — no provider wrapping needed. Each `*Sheet` component reads its slot from the store via `useOverlay("sessionsSheet")` and re-renders accordingly.

### 12.4 Why we extract CommandPalette but NOT HotkeysModal in WP-D

CommandPalette is extracted because it's intertwined with `SessionPanel.tsx`'s state machine (paletteOpen / paletteQuery / paletteIndex), the keydown listener clashes with ChatInput, and lifting it makes Cmd+K work on every section (not just `sessions`). HotkeysModal is **not** extracted in v1 — its mount migrates from `IconRail.tsx:97` to `dashboard/page.tsx` (so MoreDrawer can summon it on mobile) but the component itself stays put. Reason: HotkeysModal is purely presentational (`HotkeysModal.tsx:199-202` props are just `open` + `onClose`), no internal state to lift, no keydown listener to repair.

### 12.5 Why ModifierKeyBar uses `position: fixed; bottom: 0; transform: translateY(...)` instead of flexbox

Two alternative positions were considered:

- **Flexbox above the input row** (modifier bar as a sibling of `MobileTerminalInput` in a flex column at the bottom of the layout). Pros: no `position: fixed` complexity; bar moves with the input naturally. Cons: when keyboard opens on iOS Safari, the layout viewport doesn't shrink (per `02-scan-styles.md §4`), so the entire flex column gets pushed off-screen — the bar is hidden. This fails Mobile UX Target #5.
- **`position: fixed; bottom: var(--kbd-height)`** (anchor the bar at the keyboard top via a CSS var). Pros: no transform. Cons: changing `bottom` triggers layout/paint on every event; mobile browsers' compositor optimizations don't apply to `bottom` changes the same way they do to `transform` changes (which are GPU-composited). Performance margin: ~1-3 FPS during keyboard animation on mid-range Android.

The chosen `position: fixed; bottom: 0; transform: translateY(calc(-1 * var(--kbd-height)))` keeps the layout invariant (no reflow) and uses transform-only updates (compositor only). This is the same pattern Blink Shell's iOS `inputAccessoryView` ends up implementing under the hood.

### 12.6 Why `MobileBottomBar` hides during keyboard-open

When the soft keyboard opens, the bar has nowhere useful to live: it was at `bottom: 0` of the viewport, and the keyboard now occupies that space. Two options were considered: (a) push the bar above the modifier bar (at `bottom: kbd-height + bar-height`), which competes for vertical space with the terminal canvas and adds clutter; (b) hide the bar via `display: none` while keyboard-open and rely on the modifier bar for any in-input chrome. We chose (b) because the bar's only function in keyboard-open mode would be tab-switching, and tab-switching during typing is rare; the user tap on the canvas to open the keyboard implies they want to type, not navigate.

### 12.7 Sticky-but-scrollable modifier bar

The 14-button bar overflows the 360 px viewport (~388 px scroll width minimum). Implementation: the bar's outer wrapper is `position: fixed; left: 0; right: 0; bottom: 0; transform: ...`; the inner row is `overflow-x-auto scrollbar-none flex gap-1`; tap targets are 44×44 px so the visible 7-8 buttons fit and the rest scroll into view. We do not split into a 2nd row because that doubles the vertical footprint (88 px instead of 44 px), and the prompt explicitly framed swipeable two-row as a candidate but our chosen `MB-R` is single-row.

### 12.8 The `--vvh` / `--kbd-height` CSS variable contract

`useVisualViewport()` writes to `document.documentElement.style`:

| Variable | Computed as | Used by |
|---|---|---|
| `--vvh` | `window.visualViewport.height` (px) | `pos/DashboardLayout.tsx` root height |
| `--kbd-height` | `Math.max(0, window.innerHeight - vv.height - vv.offsetTop)` | `ModifierKeyBar.tsx` translateY |
| `--vv-offset-top` | `window.visualViewport.offsetTop` | sheet positioning during pinch-zoom |

The hook updates synchronously on every event (no rAF batching) because the cost of `style.setProperty` is sub-microsecond. If profiling later shows event coalescing helps, switch to a microtask.

### 12.9 Why we don't use the `inputAccessoryView` web equivalent (`autocomplete="off"` virtual keyboard API)

Chrome 108+ exposes `navigator.virtualKeyboard.overlaysContent = true` which makes the keyboard not push the layout up — equivalent to iOS's default behavior. Combined with `interactive-widget=resizes-content` (which we already set), this gives Chrome users automatic keyboard-aware layout. We could opt into this for the cleanest behavior, BUT it's Chromium-only and would diverge from iOS Safari's behavior (which doesn't have this API). For consistency we use the cross-browser `visualViewport` listener path; we may revisit `virtualKeyboard.overlaysContent` in Phase 8+ as an additive enhancement on Chrome.

### 12.10 Server-side: zero changes

The PTY bridge in `terminal-manager.js:514-578` (persistent) and `:781-793` (ephemeral) accepts `{type:"input", data}` and writes `data` to `pty.write(data)` verbatim. Every byte from the modifier bar, the mobile input, and the desktop xterm passes through the same `term.onData` listener at `Terminal.tsx:213-221` and arrives at the server unchanged. The server cannot tell (and shouldn't) whether `\x03` came from a hardware keyboard's Ctrl+C, a bar tap on `^C`, or a paired Bluetooth keyboard's chord — all are equivalent.

### 12.11 What the user types in the textarea — round-trip loop

The MobileTerminalInput textarea is an "outbox" — its visible text is empty most of the time. The user's letter goes:

```
keystroke → <textarea>.value = 'a' → onInput fires
         → if not composing: term.input('a', true)
         → existing onData listener at Terminal.tsx:213
         → ws.send({type:"input", data:"a"})
         → server PTY.write("a")
         → shell echoes "a" back
         → ws message {type:"output", data:"a"}
         → term.write("a") at Terminal.tsx:177
         → renders inside xterm canvas
         → setDraft(""), <textarea>.value = ""
```

The user sees the letter appear in the xterm canvas (the round-trip echo); the textarea remains empty. For interactive shells without local echo (e.g. password prompts), the letter still goes through the loop but the shell suppresses echo — same behavior as desktop.

### 12.12 Why we picked Russian as label-language for the bar (or didn't)

The 14 buttons use **universal symbols / English ASCII** (`Esc`, `Tab`, `Ctrl`, `Alt`, `↑`, `^C`, `⇧Tab`, etc.) rather than Russian translations. Reasons: (a) terminal command syntax is English globally, mixing Russian labels with bytes that decode to English shell commands creates cognitive dissonance; (b) the labels are already short — Russian "Ввод" for Tab takes 4 chars vs `Tab`'s 3 and breaks the row width; (c) every mobile terminal in the wild uses English/symbol labels (Termux, Blink, JuiceSSH per `03-research-terminal-ux.md`). Russian remains the UI language for everything else (sheet titles, error messages, settings).

### 12.13 First-paint flash mitigation

Without the new `viewport` Metadata, today's mobile users see a moment of un-zoomed layout before Next.js's default viewport meta applies. Adding the explicit Metadata export at `app/layout.tsx` ensures the meta is in the SSR HTML response — first paint is correct. Combined with `100dvh` (which works at first paint without JS) and the `var(--vvh, 100dvh)` fallback (which uses `100dvh` until the JS hook runs and sets `--vvh`), the SSR HTML produces a usable layout before client-side hydration.

---

## 13. Phase 6 Hand-off Checklist

The Phase-6 `planner-integration` agent should produce `06-integration-plan.md` containing:

- [ ] Per-WP file diff list with line-range hints (every file in §8 above with the specific lines being added/changed/deleted).
- [ ] Order of operations (e.g. WP-A must land before WP-D so `--vvh` and z-index tokens exist before WP-D's overlays consume them).
- [ ] Coordination plan for the shared `pos/DashboardLayout.tsx` file (line ownership boundary documented; integration test post-merge).
- [ ] Test harness for the `pointerdown` → `inputRef.focus()` synchronous-gesture chain (must run inside a Playwright real-touch event, not a synthetic event).
- [ ] Rollback plan: revert the feature flag to `false` and redeploy; measure rollback duration.
- [ ] Phase-7 partition assignments (each implementer reads exactly one of `07a/07b/07c/07d-impl-*.md`).
- [ ] Phase-8 validator config: viewport sizes (360, 390, 414, 430, 768, 1280), browsers (iOS Safari 16+, Android Chrome 110+, desktop Chrome / Firefox / Safari).
- [ ] Phase-9 audit checklist (mapping each Mobile UX Target to a specific test/screenshot).

---

End of decisions. Phase 6 (`planner-integration`) translates these into a file-by-file change plan with explicit diff intents.
