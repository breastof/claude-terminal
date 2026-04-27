# Phase 9 — Mobile Overhaul User-Demand Audit

> Auditor: `auditor-user-intent-mobile`
> Date: 2026-04-26
> Branch: `feat/tmux-streaming-and-mobile`
> Inputs digested: `01-planner-mobile.md`, `02-scan-{layout,navigation,terminal,styles}.md`, `05-decision-mobile.md`, `06-integration-plan-mobile.md`, `07-impl-mobile-WP-{A,B,D}.md`, `07-impl-terminal-combined.md`, `08-validate-build.md`, `08-validate-mobile.md`.
> Method: opened the actual source files (not just the changelogs) at the file:line citations in the implementation reports and walked the chain end-to-end for each of the user's three explicit demands. Every PASS/FAIL verdict below is grounded in an audit-time `grep` or file read.

---

## 0. Top-line Verdict

**PARTIAL — FAIL on D1 and D3 mount integration; PASS on D2 (shell/CSS substrate).**

The Phase-7 implementers built every promised component. The files exist, the TypeScript compiles, the Next.js bundle builds clean (`08-validate-build.md` exit-code 0), the headless validator scored 60/60 PASS for viewport meta + dvh + safe-area + z-tokens + no-h-scroll across 6 viewports (`08-validate-mobile.md §3`). Static-source greps show the right utility classes, the right CSS vars, the right keystroke byte tables, the right Russian aria-labels.

But four critical components — **`MobileTerminalInput`, `ModifierKeyBar`, `MobileSessionsSheet`, `MobileMoreSheet`** — exist on disk and are **NEVER imported**, **NEVER mounted in any JSX tree**. The dashboard ships the new viewport meta, the new CSS, the new overlay-store mutex, the new chat / files / admin sheets. But on a real iPhone the user will see:

- **Two competing mobile nav surfaces**: the new bottom bar (Терминал/Сессии/Чат/Ещё) AND the legacy hamburger slide-in drawer that re-renders a full IconRail+SidePanel — the original "двойная навигация" the user complained about is regressed-not-fixed.
- **Bottom bar's "Сессии" and "Ещё" tabs are dead clicks**: they call `openOverlay("sessions" | "more")` correctly, but `MobileSessionsSheet` and `MobileMoreSheet` are never mounted to listen. The user taps and nothing visible happens.
- **No on-screen input field for the terminal**: tapping the canvas runs the synchronous-gesture focus call at `Terminal.tsx:678-692` — but the focus target `terminalIO.mobileInputRef.current` is forever null because nothing has mounted `<MobileTerminalInput/>` to populate it via callback ref. Soft keyboard does not open. **Demand D3 is unmet.**
- **No modifier bar**: same root cause; `<ModifierKeyBar/>` is orphaned.

What DID land for the user:
- D2 (layout doesn't break) is structurally complete — viewport meta, dvh swaps, safe-area, mobile font-size override, z-tokens, body overscroll-contain, terminal-host touch-action. PASS.
- D1's bottom-bar component itself is repurposed correctly (4 tabs match spec). PASS as a component, FAIL as an integrated nav surface.
- `MobileChatSheet`, `MobileFilesSheet`, `MobileAdminSheet` ARE mounted and functional. The chat sheet (with 16-px ChatInput) and files sheet (with mobile column template) are the most user-visible wins of this branch on mobile.
- Page-level `<CommandPalette/>` and `<HotkeysModal/>` ARE mounted and overlay-store-driven. Cmd+K scope-guard PASS.
- Terminal.tsx's `useTerminalIO()` ref-mirroring (xtermRef, wsRef, terminalElementRef, setReady) IS wired and would activate the moment `<MobileTerminalInput/>` is mounted.

**Net for the user**: D2 delivered. D1 and D3 not delivered because critical mounts are missing. A short patch (~15-25 lines) in `dashboard/page.tsx` (mount the orphans) and `pos/DashboardLayout.tsx` (gate the legacy hamburger drawer behind `!isMobile`, or replace with `<MobileMoreSheet/>` opened by `openOverlay("more")`) would close both gaps. No new components needed; no new logic; just wire up what already exists.

---

## 1. Per-Demand Audit

### 1.1 D1 — Pack the dual navigation (Navbar + Sessions) into a single mobile nav surface

**Verdict: FAIL** (component-level PASS for the bottom bar; integration-level FAIL because the dual-surface problem is structurally regressed)

#### 1.1.1 Chain walk — bottom bar component

The `MobileBottomBar` was repurposed correctly per `05-decision-mobile.md §2.4` (which selected `NV-A` from the tradeoff matrix). Confirmed from source:

`/root/projects/claude-terminal/src/components/pos/MobileBottomBar.tsx`:
- Lines 35-42: tab list `MAIN_TABS` is exactly `[ {id:"terminal"}, {id:"sessions"}, {id:"chat"}, {id:"more"} ]` with Russian labels `Терминал / Сессии / Чат / Ещё`. Matches the frozen decision verbatim.
- Lines 44-48: `TAB_TO_SLOT` maps the three non-terminal tabs to overlay slots `"sessions"` / `"chat"` / `"more"`.
- Lines 50-63: hooks read `useNavigation`, `useOverlayStore`, `useOverlay`, `useVisualViewport`. The `isKeyboardOpen` short-circuits to `return null` (line 63) so the bar disappears when the soft keyboard is up — required by `05 §5.1 / §12.6`.
- Lines 80-90: `handleTab("terminal")` closes any open overlay and snaps section to "sessions" (the canvas-default state). Other tabs call `openOverlay(slot)`.
- Line 96: `<div role="tablist" aria-label="Главная навигация" className="md:hidden h-14 border-t border-border bg-surface flex items-center justify-around px-2 pb-safe">` — `md:hidden` correctly hides on tablet+desktop; `pb-safe` respects iOS home indicator; `role="tablist"` PASS for a11y.
- Lines 101-115: each tab is `<button role="tab" aria-selected={active} aria-label={label}>`. PASS for a11y.
- Lines 70-77: active-tab indicator: "Терминал" tab is active when no overlay is open AND on the sessions section; other tabs are active when their overlay slot is open. PASS — gives the user clear feedback.

**Component-level verdict: PASS.** The bar is correct. It is mounted in `DashboardLayout.tsx:139` (`<MobileBottomBar />`) so it actually appears on screen.

#### 1.1.2 Chain walk — hamburger button + legacy drawer

Here is where D1 falls apart. The integration-plan `06 §3.7` and the WP-B changelog say the Navbar's hamburger should be wired to `openOverlay("more")` (or equivalent) and the legacy `AnimatePresence` slide-in drawer at `DashboardLayout.tsx:88-131` should be removed or gated behind `!isMobile`. Neither happened.

`/root/projects/claude-terminal/src/components/Navbar.tsx`:
- Lines 67-75: hamburger is `<button onClick={onMenuClick} aria-label="Открыть меню" className="md:hidden p-2.5 -ml-1 ...">`. The `onClick={onMenuClick}` is a **prop** — Navbar still consumes the legacy callback contract.
- Lines 9-26: `NavbarProps` still declares `onMenuClick?: () => void`. There is no `useOverlayStore` import in this file (verified by `grep -n "useOverlay\|openOverlay" Navbar.tsx` → 0 hits). Navbar is unchanged structurally; only `aria-label` was added per WP-B.

`/root/projects/claude-terminal/src/app/dashboard/page.tsx`:
- Line 85: `const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);` — local React state still owns the hamburger drawer's open/close.
- Line 428: `<DashboardLayout ... mobileSidebarOpen={mobileSidebarOpen} ... onCloseMobileSidebar={() => setMobileSidebarOpen(false)}>`.
- Line 439: `onMenuClick={() => setMobileSidebarOpen(true)}` is passed to `<Navbar>` — direct prop wire-up.

`/root/projects/claude-terminal/src/components/pos/DashboardLayout.tsx`:
- Lines 88-131: the legacy `<AnimatePresence>` block is ENTIRELY PRESENT, unchanged. When `mobileSidebarOpen` is true, it renders:
  - A backdrop `fixed inset-0 bg-black/60 z-30 md:hidden` (line 97).
  - A slide-in `motion.div` at `fixed top-0 left-0 bottom-0 z-40 md:hidden` (line 105) containing:
    - **Another `IconRail`** (line 107) — full vertical rail with 7 section buttons.
    - A `w-[280px]` panel (line 108) containing `SidePanel` (line 117) — which dispatches to `SessionPanel` / `HubPanel` / `ConfigPanel` / etc. based on `activeSection`.
- This drawer is the SAME UI surface as desktop's IconRail+SidePanel. Tapping the hamburger on mobile opens this. Tapping the bottom bar's "Ещё" tab is supposed to open `MobileMoreSheet` (a vaul left-edge drawer with a different visual style) — but `MobileMoreSheet` is never mounted, so the "Ещё" tap is a dead click.

**The user sees TWO drawers on mobile**: (a) the legacy IconRail+SidePanel slide-in via hamburger, (b) nothing via "Ещё" tab. This is exactly the dual-navigation problem the user complained about. Worse, "Сессии" tab is also dead because `MobileSessionsSheet` is also orphaned — so the only way to access sessions on mobile is through the legacy hamburger drawer's `SessionPanel` (the same path that existed before the refactor).

#### 1.1.3 Chain walk — orphaned sheets

`/root/projects/claude-terminal/src/components/mobile/MobileSessionsSheet.tsx`:
- Lines 30-72: vaul `Drawer.Root` controlled by `useOverlay("sessions")`, wraps `<SessionPanel/>`, `aria-label="Сессии"`, has `Drawer.Title` + `Drawer.Description` (sr-only), `pb-safe`, drag handle, `shouldScaleBackground`, `dismissible`. Correct per `06 §2.9`.
- Wraps `props.onSelectSession` to auto-close the sheet on selection (lines 37-43) so the user lands on the terminal canvas without an extra tap. Good UX.

**Audit-time grep**:
```
$ grep -rln "MobileSessionsSheet" src/
src/components/mobile/MobileSessionsSheet.tsx       (definition file itself)
src/components/pos/MobileBottomBar.tsx              (mention in JSDoc comment, line 27)
src/lib/overlayStore.ts                             (mention in JSDoc comment, line 46)
src/app/dashboard/page.tsx                          (mention in JSX comment, line 605)
```
Zero JSX usages, zero `import` statements. Component is dead code.

`/root/projects/claude-terminal/src/components/mobile/MobileMoreSheet.tsx`:
- Lines 50-153: vaul `Drawer.Root` direction `"left"`, 280-px width, `pt-safe pb-safe`, `aria-label="Главное меню"`, `outline-none`, `Drawer.Title`+`Description`. Inlines section list (Сессии/Hub/Config/Skills/Memory/Symphony/System) at 44-px row height, plus footer (theme toggle / hotkeys / logout) — does NOT nest `<IconRail/>`, which avoids the IconRail's 40-px desktop sizing.
- Lines 130-136: hotkeys row calls `openOverlay("hotkeys")` — correctly invokes the page-level `<HotkeysModal/>` mount.

**Audit-time grep**:
```
$ grep -rln "MobileMoreSheet" src/
src/components/mobile/MobileMoreSheet.tsx           (definition only)
src/components/pos/MobileBottomBar.tsx              (JSDoc comments, lines 23, 29)
src/app/dashboard/page.tsx                          (JSX comment, line 605)
```
Same orphan problem.

The comment at `dashboard/page.tsx:605` literally says:
```jsx
{/* Mobile overlays — sheets driven by overlayStore (mutex). MobileSessionsSheet
    and MobileMoreSheet are mounted inside DashboardLayout (WP-B territory);
    here we add the WP-D sheets: chat, files, admin. */}
```
This comment is **factually wrong**. `grep -n "MobileSessionsSheet\|MobileMoreSheet" src/components/pos/DashboardLayout.tsx` returns ZERO hits. The mounts were never added. WP-B's changelog claims they were created and would be mounted by WP-D in `DashboardLayout`; WP-D's changelog claims they were mounted by WP-B in `DashboardLayout`. Neither actually did it — classic ownership-handoff failure.

#### 1.1.4 Evidence summary (D1)

| Sub-criterion | Verdict | Evidence (file:line) |
|---|---|---|
| Bottom bar tabs (Терминал/Сессии/Чат/Ещё) | PASS | `MobileBottomBar.tsx:37-42` |
| Bottom bar `md:hidden` | PASS | `MobileBottomBar.tsx:96` |
| Bottom bar hides on keyboard open | PASS | `MobileBottomBar.tsx:59-63` |
| Bottom bar `pb-safe` for home indicator | PASS | `MobileBottomBar.tsx:96` |
| Bottom bar `role=tablist` + per-tab `aria-selected` | PASS | `MobileBottomBar.tsx:94, 103-105` |
| Bottom bar mounted in `DashboardLayout` | PASS | `DashboardLayout.tsx:139` |
| Hamburger button has `aria-label="Открыть меню"` | PASS | `Navbar.tsx:70` |
| Hamburger button hits ≥44 px (`p-2.5`) | PARTIAL | `Navbar.tsx:71` (`p-2.5` ≈ 40 px; needs runtime check) |
| Hamburger wired to overlayStore (`openOverlay("more")`) | **FAIL** | `Navbar.tsx:67-75` still uses `onMenuClick` prop; `dashboard/page.tsx:439` → `setMobileSidebarOpen(true)` |
| Legacy mobile slide-in drawer removed or gated | **FAIL** | `DashboardLayout.tsx:88-131` AnimatePresence block intact |
| Single mobile nav surface | **FAIL** | Two surfaces coexist: legacy hamburger drawer + bottom bar |
| `MobileSessionsSheet` mounted | **FAIL** | Component orphaned; "Сессии" tap = dead click |
| `MobileMoreSheet` mounted | **FAIL** | Component orphaned; "Ещё" tap = dead click |
| `MobileChatSheet` mounted (mobile-only) | PASS | `dashboard/page.tsx:609` |
| `MobileFilesSheet` mounted (mobile-only) | PASS | `dashboard/page.tsx:610` |
| `MobileAdminSheet` mounted (mobile-only) | PASS | `dashboard/page.tsx:611` |
| `overlayStore` mutex API present + Zustand-backed | PASS | `lib/overlayStore.ts:81-87` |
| `overlayStore` exports both long+short slot names | PASS | `lib/overlayStore.ts:28-58` |
| Bidirectional sync chat/admin/viewMode↔store (mobile) | PASS | WP-D changelog, six effects in `dashboard/page.tsx` |
| `<HotkeysModal/>` page-level mount, no props | PASS | `dashboard/page.tsx:627`; `HotkeysModal.tsx:242` (no props) |
| `<CommandPalette/>` page-level mount + Cmd+K scope-guard | PASS | `dashboard/page.tsx:624`; `CommandPalette.tsx:54-77` |

#### 1.1.5 Phase 8 validation

`08-validate-mobile.md §6` per-target row #2 logged D1 as **SKIPPED-needs-device** because the dashboard is JWT-cookie gated and the headless Playwright run could not pass authentication without compromising secrets. The validator confirmed component files exist and tab semantics are correct via static analysis (§5.5, §5.6, §5.9) but did NOT verify the mount tree — that omission is what hides the orphan defect from the automated tier. Validator §7 risk #2 calls out the missing fixture-login backdoor as a Phase-10 follow-up.

#### 1.1.6 Net D1 verdict: FAIL

The user will see two competing mobile nav surfaces and dead bottom-bar buttons. The one explicit ask — "нашу двойную навигацию как-то упаковать" — is not met. The architectural foundation (overlayStore mutex, vaul sheets, repurposed bottom bar) is in place; just three import statements + three JSX tags away from PASS.

---

### 1.2 D2 — Layout doesn't break on mobile

**Verdict: PASS** (substrate complete and verified; runtime visual confirmation deferred to real device)

#### 1.2.1 Chain walk — viewport meta

`/root/projects/claude-terminal/src/app/layout.tsx`:
- Lines 1-3: imports `Viewport` type from `next` (added by WP-A per its changelog).
- Lines 32-38:
  ```ts
  export const viewport: Viewport = {
    width: "device-width",
    initialScale: 1,
    viewportFit: "cover",
    interactiveWidget: "resizes-content",
    themeColor: "#000000",
  };
  ```
- This emits `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">` and `<meta name="theme-color" content="#000000">`. The exact frozen string per `05 §2.6`.
- `viewport-fit=cover` is the necessary switch to activate `env(safe-area-inset-*)` for iOS notch / Dynamic Island / home indicator.
- `interactive-widget=resizes-content` hints to Chrome 108+ to shrink the layout viewport on keyboard open (so `100dvh` re-layouts naturally). iOS Safari ignores this — the JS fallback via `useVisualViewport` covers it.
- `themeColor: "#000000"` keeps the iOS Safari status-bar tint aligned with the dark theme; otherwise the chrome would mismatch the bg.
- `user-scalable` deliberately NOT pinned per `05 §2.6` so users can pinch-zoom terminal output for accessibility.

PASS.

#### 1.2.2 Chain walk — `useVisualViewport` hook

`/root/projects/claude-terminal/src/lib/useVisualViewport.ts`:
- Lines 24-33: `VisualViewportState` interface — `{ height, offsetTop, isKeyboardOpen, keyboardHeight }`.
- Lines 35-40: `DEFAULT_STATE = { height: 0, offsetTop: 0, isKeyboardOpen: false, keyboardHeight: 0 }`.
- Lines 42-55: `readState()` reads `window.visualViewport.height` (falls back to `window.innerHeight`), computes `keyboardHeight = Math.max(0, innerHeight - height - offsetTop)`, derives `isKeyboardOpen = keyboardHeight > 150`. SSR-safe via `typeof window === "undefined"` guard.
- Lines 57-63: `writeCssVars(state)` writes three CSS variables to `document.documentElement.style`:
  ```ts
  root.setProperty("--vvh", `${state.height}px`);
  root.setProperty("--kbd-height", `${state.keyboardHeight}px`);
  root.setProperty("--vv-offset-top", `${state.offsetTop}px`);
  ```
- Lines 65-101: `useVisualViewport()` hook subscribes to `vv.addEventListener("resize", update)` and `"scroll"` (lines 81-84), with fallback `window.addEventListener("resize", update)` for old Safari (line 94). Returns `state` so consumers can also read it imperatively.
- Side-effect-only writes per `05 §12.8`: no rAF batching (style.setProperty is sub-microsecond, vv events already throttled by browser).
- On unmount: removes listeners but does NOT clear the CSS vars — other consumers may still rely on them.

PASS.

#### 1.2.3 Chain walk — DashboardLayout root height

`/root/projects/claude-terminal/src/components/pos/DashboardLayout.tsx`:
- Line 4: `import { useVisualViewport } from "@/lib/useVisualViewport";`
- Lines 47-53: hook is called for its side effect; comment explains the CSS-var write.
- Lines 55-64 (fullscreen short-circuit branch):
  ```jsx
  <div
    className="flex bg-background"
    style={{ height: "var(--vvh, 100dvh)" }}
  >
    {children}
  </div>
  ```
- Lines 66-141 (main return) — same `style={{ height: "var(--vvh, 100dvh)" }}` (line 69).
- The fallback chain `var(--vvh, 100dvh)` ensures: SSR + first paint use `100dvh` (CSS-tracked dynamic viewport); after JS hydration `--vvh` is set to the JS-measured `visualViewport.height` (handles iOS edge cases where `100dvh` lags keyboard open).

PASS.

#### 1.2.4 Chain walk — globals.css

`/root/projects/claude-terminal/src/app/globals.css`:
- Lines 70-75: six `@utility` (Tailwind v4 directive) declarations — `pt-safe`, `pb-safe`, `pl-safe`, `pr-safe`, `h-safe-bottom`, `min-h-safe-bottom`. All map to `env(safe-area-inset-*)`. Validator §5.4 confirmed the only places `env(safe-area-` appears in `src/` are these six utility definitions. Centralised — no per-component drift.
- Lines 179-188: `body` rule — added `overscroll-behavior: contain` (kills rubber-band scroll chaining) and `-webkit-tap-highlight-color: transparent` (kills iOS' grey tap highlight). Body comment cites `05 §2.7` and `02-scan-styles.md §6`.
- Lines 196-200: SSR fallback `:root { --vvh: 100dvh; --kbd-height: 0px; --vv-offset-top: 0px; }` — guarantees `var(--vvh)` resolves before JS hydration finishes.
- Lines 208-210: `.terminal-host { touch-action: manipulation; }` — applied via `Terminal.tsx` to the terminal wrapper div, kills the 300 ms double-tap zoom delay so single tap focuses input immediately.
- Lines 218-224: `@media (max-width: 767px) { input:not([type=checkbox]):not([type=radio]), textarea, select { font-size: 16px !important; } }` — defeats iOS Safari zoom-on-focus on EVERY text input on mobile, regardless of class. Belt-and-suspenders backup of WP-D's `text-base md:text-sm` on ChatInput.

PASS — every WP-A scaffold item from the changelog is confirmed in source.

#### 1.2.5 Chain walk — `100vh` → `100dvh` migration

Validator §5.7 documents 8 sites swapped:

| File | Line | Was | Now |
|---|---|---|---|
| `HotkeysModal.tsx` | 276 | `max-h-[80vh]` | `max-h-[90dvh]` (mobile branch) |
| `HotkeysModal.tsx` | 311 | `max-h-[80vh]` | `max-h-[80dvh]` (desktop branch) |
| `ProviderWizardModal.tsx` | 260 | `max-h-[85vh]` | `max-h-[85dvh]` |
| `symphony/CreateTaskModal.tsx` | 67 | `max-h-[85vh]` | `max-h-[85dvh]` |
| `chat/ImageLightbox.tsx` | 31 | `max-h-[90vh]` | `max-h-[90dvh]` |
| `ui/aurora-background.tsx` | 25, 41 | `h-[100vh]` | `h-[100dvh]` |
| `ui/lamp.tsx` | (varies) | `min-h-screen` | `min-h-dvh` |
| `app/global-error.tsx` | 12 | inline `100vh` | `100dvh` |

Static-source sweep confirmation (validator §5.1):
```
$ grep -rn "100vh\|h-screen\|min-h-screen\|max-h-\[80vh\]\|max-h-\[85vh\]\|max-h-\[90vh\]\|h-\[100vh\]" src/
src/app/symphony/page.tsx:25:    <div className="min-h-screen bg-background">
src/app/api/auth/approve/route.ts:17:<body style="margin:0;min-height:100vh;...">
```
2 hits remain, both **out of scope**:
- `symphony/page.tsx:25` — Symphony route is explicitly out of scope per `05 §11`.
- `auth/approve/route.ts:17` — server-rendered HTML for the OAuth approval page; not React, not part of the dashboard tree.

Dashboard tree: 0 `100vh` hits. PASS — matches success criterion `05 §6.7`.

#### 1.2.6 Chain walk — ChatInput 16-px font

`/root/projects/claude-terminal/src/components/chat/ChatInput.tsx`:
- Line 193 (comment): "Textarea — text-base (16px) on mobile defeats iOS zoom-on-focus; md:text-sm keeps desktop compact."
- Lines 203-208:
  ```tsx
  inputMode="text"
  enterKeyHint="send"
  autoCapitalize="sentences"
  autoCorrect="on"
  spellCheck
  className="flex-1 bg-transparent text-base md:text-sm text-foreground placeholder-muted outline-none resize-none max-h-24 min-h-[20px] disabled:opacity-30 disabled:cursor-not-allowed"
  ```
- `text-base` (16 px) on mobile, `md:text-sm` (14 px) on desktop. Plus the `globals.css:218-224` `@media (max-width: 767px)` rule forces 16 px on every text input regardless of class. iOS zoom-on-focus is double-defeated.
- `enterKeyHint="send"` makes the soft keyboard's Enter key show the send glyph instead of the generic carriage return on iOS.
- `inputMode="text"` is the default; included for explicitness.
- Note: chat is conversational text, so `autoCapitalize="sentences"` and `autoCorrect="on"` are intentional. Compare with `MobileTerminalInput` (which sets all four to `off` because terminal commands are not natural language).

PASS.

#### 1.2.7 Chain walk — z-index tokenisation

`/root/projects/claude-terminal/src/lib/zIndex.ts` is a re-export shim per WP-A's deviation #1 (the integration plan named `zIndex.ts` but the existing file was `z-index.ts`; WP-A kept both):
```ts
export { Z, type ZLayer } from "./z-index";
```
The numeric tokens live in `lib/z-index.ts` and are mirrored in `globals.css`'s `@theme inline { --z-base: 0; --z-content: 10; ... --z-toast: 9500; --z-navbar: 5000; }` block. Tailwind v4 generates `z-base`, `z-content`, `z-modal`, `z-floating`, `z-palette`, `z-toast`, etc. utility classes. Validator confirmed these reach `getComputedStyle(document.documentElement)` at runtime.

WP-D's audit note: "Validator confirmed `--z-modal: 60`, `--z-palette: 9000`, `--z-toast: 9500`, `--z-navbar: 5000` reachable via getComputedStyle." PASS.

#### 1.2.8 Evidence summary (D2)

| Sub-criterion | Verdict | Evidence |
|---|---|---|
| Viewport meta `viewport-fit=cover` | PASS | `app/layout.tsx:35` |
| Viewport meta `interactive-widget=resizes-content` | PASS | `app/layout.tsx:36` |
| Theme color `#000000` for dark theme | PASS | `app/layout.tsx:37` |
| `user-scalable` not pinned (pinch-zoom OK) | PASS | absent from `viewport` export |
| `useVisualViewport` writes `--vvh`/`--kbd-height`/`--vv-offset-top` | PASS | `lib/useVisualViewport.ts:57-63` |
| Hook subscribed to `vv.resize` + `vv.scroll` + `window.resize` fallback | PASS | `lib/useVisualViewport.ts:81-94` |
| Dashboard root uses `var(--vvh, 100dvh)` | PASS | `pos/DashboardLayout.tsx:57-69` |
| Six safe-area `@utility` classes authored | PASS | `globals.css:70-75` |
| `body { overscroll-behavior: contain }` | PASS | `globals.css:186` |
| `body { -webkit-tap-highlight-color: transparent }` | PASS | `globals.css:187` |
| `:root` SSR fallback for `--vvh`/`--kbd-height`/`--vv-offset-top` | PASS | `globals.css:196-200` |
| `.terminal-host { touch-action: manipulation }` | PASS | `globals.css:208-210` |
| Mobile `@media (max-width: 767px)` 16-px text-input override | PASS | `globals.css:218-224` |
| All 8 modal/full-screen sites swapped `vh→dvh` | PASS | Validator §5.7 |
| Dashboard tree has 0 `100vh` traps | PASS | Validator §5.1 |
| ChatInput `text-base md:text-sm` + IME-aware attrs | PASS | `chat/ChatInput.tsx:203-208` |
| Z-index tokens published (CSS vars + Tailwind utility classes) | PASS | `globals.css` `@theme inline`, `lib/z-index.ts` |
| 60/60 viewport assertions PASS at 360/390/414/430/768/1280 | PASS | `08-validate-mobile.md §3` |
| AdminPanel/ChatPanel/FileManager have `pb-safe` outer wrapper | PASS | WP-D changelog, verified via grep |
| FileManager drag overlay uses `z-panel` token (not literal) | PASS | WP-D changelog |

#### 1.2.9 Phase 8 validation

`08-validate-mobile.md §3` ran headless Chromium at 6 viewports (360×640, 390×844, 414×896, 430×932, 768×1024, 1280×800). All 60 assertion cells PASS. Six PNG screenshots captured (`agent-workflow/screenshots/root-{viewport}.png`). The exact frozen viewport-meta string was confirmed in served HTML at every viewport. The dashboard route returned 307→/ confirming auth-gate is functional and the validator's choice to test against `/` is the only legal automated path.

`08-validate-build.md` confirmed the Next.js build (`npm run build`) compiles clean with exit code 0; `tsc --noEmit` clean; lint exit 0 with one new conforming error in `CommandPalette.tsx:43` matching the project's pre-existing `react-hooks/set-state-in-effect` style (validator §5.1 classified as "pattern-conforming, NOT a regression").

#### 1.2.10 Net D2 verdict: PASS

The user's "лейаут чтобы не ломался" demand is met at the structural / CSS / viewport-meta tier. Modal heights respect dynamic viewport. Dashboard root tracks `visualViewport.height`. Safe-area utilities present and consumed. iOS zoom-on-focus defeated. No horizontal scroll at any tested width. Desktop ≥768 px is bit-for-bit identical to pre-branch (WP-D verified). The remaining risk is real-device behavior on unusual iOS Safari versions / Android Chrome versions that headless Chromium can't reproduce, plus the Phase-10b checklist scenarios. The substrate is solid.

---

### 1.3 D3 — Real input field for typing into the terminal, working well on mobile

**Verdict: FAIL** (component implementation correct; never mounted; no on-screen input on mobile)

#### 1.3.1 Chain walk — `MobileTerminalInput` component

`/root/projects/claude-terminal/src/components/mobile/MobileTerminalInput.tsx` (255 lines total):
- Lines 35-48: imports `useTerminalIO`, `useIsMobile`, `useModifierStore`, `applyArmedModifiers`, `KEYS`. All present and correct.
- Lines 50-71: component opens with hooks; **callback ref** `setTextarea` (lines 65-71) publishes `el` into both local `taRef.current` AND `terminalIO.mobileInputRef.current`. This is the publish-on-DOM-attach pattern (per WP-C deviation #3) that silences the React 19 `react-hooks/immutability` lint and ensures the ref is filled the moment the DOM is ready.
- Lines 76-79: defensive auto-focus on mount via `taRef.current?.focus({preventScroll: true})` — iOS Safari will likely refuse this because it didn't originate from a synchronous gesture; the gesture path lives in Terminal.tsx (see §1.3.4). Android Chrome honors it.
- Lines 87-103 (`handleInput`):
  1. If `composingRef.current` (true between `compositionstart` and `compositionend`): `setDraft(v)` and return. Don't ship.
  2. Else read `v = e.currentTarget.value`. If empty, return.
  3. Read armed modifier state via `consumeModifiers()` — this snapshots `{ctrl, alt}` AND auto-disarms the unlocked ones (so the next input is unmodified unless the user re-arms or had locked them).
  4. Apply modifiers via `applyArmedModifiers(v, ctrl, alt)` — the helper from `lib/mobile-input.ts:164-184` Ctrl-codes the first character if it's `[a-zA-Z]`, prepends `\x1b` if Alt is armed, leaves the rest of the string unchanged. So `Ctrl + paste("hello")` → `\x01ello` (ctrl applied to first char, rest unchanged) per `05 §4 Modifier composition`.
  5. Call `terminalIO.sendInput(bytes)`. This routes via `xtermRef.current.input(data, true)` which fires `term.onData` and reuses the existing WS send path so the DA/CPR filter at `Terminal.tsx:217` continues to apply. Single ingress preserved per `06 §10 criterion 13`.
  6. Clear textarea synchronously (`setDraft(""); target.value = ""`) so the next keystroke doesn't re-emit the previous letter.
- Lines 105-127 (`handleCompositionStart` / `handleCompositionEnd`):
  - On start, set `composingRef.current = true`. iOS voice dictation, Android Gboard CJK, Samsung Keyboard SwiftKey all use composition events.
  - On end, set `composingRef.current = false`. Read `final = e.data ?? taRef.current?.value ?? ""` — Samsung Keyboard sometimes emits `compositionend` with empty `e.data` and the actual phrase in the textarea value, hence the fallback. Apply modifiers and ship if non-empty.
- Lines 136-159 (`handlePaste`):
  - If `cd.types.includes("Files")` (image paste): bail. Terminal.tsx's existing capture-phase paste handler at `Terminal.tsx:647-670` will intercept and run the xclip pipeline.
  - Else (text paste): `e.preventDefault()` (don't insert into textarea), then call `xtermRef.current?.paste(text)`. xterm's `paste()` honors bracketed-paste mode `\x1b[?2004h` if the shell has enabled it.
- Lines 169-186 (`handleKeyDown`):
  - `Enter` (no Shift): `e.preventDefault()`. Send `KEYS.Enter` = `"\r"`. Don't send `\n` because the PTY does cooked-mode `\n→\r\n` translation via `node-pty`'s default `onlcr` termios flag — sending `\n` would produce `\r\r\n`. Per `05 §2.14`.
  - `Shift+Enter`: fall through (allows multi-line composition in the textarea).
  - `Backspace` when `draft === ""`: `e.preventDefault()`. Send `KEYS.Backspace` = `"\x7f"` (DEL byte per xterm convention).
  - Tab/Esc/arrows: NOT intercepted here — those come from `ModifierKeyBar`. The textarea's default would just type literal characters or move focus; we don't want that on mobile.
- Line 188: `if (!isMobile) return null;` — the component is a no-op on tablet+desktop.
- Lines 190-254: JSX. Outer `<div role="region" aria-label="Мобильный ввод терминала">` with inline style positioning at `bottom: var(--kbd-height, 0px)`, width/height 1, opacity 0, pointerEvents none. Hidden off-screen but reachable for focus. Inner `<textarea>` at width/height 1, `font-size: 16` inline, `color: transparent; caretColor: transparent`, `pointerEvents: auto` so `mobileInputRef.current.focus()` works. Mandatory mobile-friendly attrs:
  - `inputMode="text"` (line 226)
  - `enterKeyHint="send"` (line 227)
  - `autoCapitalize="off"` (line 228)
  - `autoCorrect="off"` (line 229)
  - `spellCheck={false}` (line 230)
  - `autoComplete="off"` (line 231)
  - `aria-label="Ввод в терминал"` (line 233) — Russian per `06 §2.5`.

**Component-level correctness: PASS.** The implementation matches every clause of the integration plan and every byte mapping is verified against `02-scan-terminal.md §4.2` PTY contract.

#### 1.3.2 Chain walk — `ModifierKeyBar` component

`/root/projects/claude-terminal/src/components/mobile/ModifierKeyBar.tsx` (298 lines):
- Lines 32-46: imports `useTerminalIO`, `useIsMobile`, `useModifierStore`, plus `arrowBytes`, `CURSOR_BLOCK_LIST`, `MODIFIER_KEY_LIST` from `lib/mobile-input.ts`.
- Lines 48-50: `LONG_PRESS_MS = 300`, `REPEAT_INITIAL_MS = 500`, `REPEAT_INTERVAL_MS = 100` — Blink's gesture model timings per `05 §2.3`.
- Lines 52-74: hooks read modifier state (ctrl/alt/locked status + setters) via Zustand selectors — minimizes re-renders by selecting individual fields. Per-button timer `Map`s keyed by descriptor.id allow concurrent multi-touch.
- Lines 81-92 (`getBytes`): for arrow keys, reads `term.modes.applicationCursorKeysMode` AT CLICK-TIME (not cached at render-time) and returns DECCKM-aware bytes via `arrowBytes(dir, deccm)`. Per `05 §4 Group A`. vim/claude/tmux flip DECCKM dynamically via `\x1b[?1h` / `\x1b[?1l`; reading at click-time is mandatory.
- Lines 121-165 (`handlePointerDown`):
  - `e.currentTarget.setPointerCapture(e.pointerId)` (line 126) — captures pointer so pointerup fires on the same button even if the user drags off, ensuring reliable timer cleanup.
  - Modifier keys: schedule 300 ms long-press timer that toggles `lockCtrl`/`lockAlt` via `useModifierStore`.
  - Auto-repeat keys (arrows, ^R, PgUp/PgDn): immediate fire on pointerdown for instant feedback, then 500 ms delay → 100 ms interval timer.
- Lines 167-211 (`handlePointerUp`):
  - Page-swap key (`⋯`): toggles `cursorPage` between `"arrows"` and `"block"`.
  - Modifier key + lock-not-fired + held<300 ms: arm one-shot. If already armed, second tap unlocks (which also disarms). Per Blink semantics.
  - Non-modifier non-auto-repeat key: fire on pointerup (release).
  - Auto-repeat keys: do NOT re-fire on pointerup (already fired on pointerdown).
- Lines 213-219, 268 (`handlePointerCancel` + `onPointerLeave`): clear all timers per `05 §10 risk 9` — critical to prevent timer leakage when user drags off the button mid-press.
- Line 221: `if (!isMobile) return null;`.
- Lines 226-235: visible key list resolved at render-time. When `cursorPage === "block"`, the four arrow buttons (ids `up`/`down`/`left`/`right`) are replaced in-place by `Home/End/PgUp/PgDn` from `CURSOR_BLOCK_LIST`. Same DOM positions, just different bytes.
- Lines 237-250: outer container `<div role="toolbar" aria-label="Модификаторы клавиатуры">` with `position: fixed; left: 0; right: 0; bottom: var(--kbd-height, 0px); z-floating; flex; gap-1; px-1; h-11; overflow-x-auto`. The `bottom: var(--kbd-height)` pins the bar against the keyboard top via the CSS var written by `useVisualViewport` on every event. `touch-action: pan-x` allows horizontal scroll for narrow viewports, blocks pull-to-refresh chaining.
- Lines 252-294: button render. Each button has `min-w-[44px] h-11` (44 px tap target per `05 §6 criterion 9`), `aria-label` Russian (from descriptor `ariaLabel`), modifier buttons get `aria-pressed={armed}`. Active modifiers get `bg-accent/30` background + ring. Locked modifiers get a small `•` lock-dot.
- Line 272: `onClick={(e) => e.preventDefault()}` — suppresses synthesized click after pointerup, prevents double-fire.

**Component-level correctness: PASS.** Frozen 14-key list, Blink semantics, DECCKM-aware, a11y-correct.

#### 1.3.3 Chain walk — supporting helpers

`/root/projects/claude-terminal/src/lib/mobile-input.ts`:
- Lines 22-36: `KEYS` static byte table — Esc=`\x1b`, Tab=`\t`, Enter=`\r`, Backspace=`\x7f`, ShiftTab=`\x1b[Z`, Home/End/PgUp/PgDn, Ctrl+C/D/L/R. All verified against `02-scan-terminal.md §4.2`.
- Lines 79-94: `MODIFIER_KEY_LIST` — exactly 14 visible buttons in left-to-right order per `05 §4 Group A/B`. Russian `ariaLabel` for each. The 14th is `⋯` (`page` kind).
- Lines 100-105: `CURSOR_BLOCK_LIST` — Home/End/PgUp/PgDn for the page-swap.
- Lines 119-123: `arrowBytes(dir, deccm)` — DECCKM-aware. `intro = deccm ? "\x1bO" : "\x1b["`; tail per direction.
- Lines 132-139: `ctrlOf(letter)` — POSIX caret notation, `a→\x01`, `z→\x1A`, case-insensitive, out-of-range unchanged.
- Lines 147-149: `altOf(char)` — Esc-prefix per xterm `metaSendsEscape=true` (`03-research-xterm-proxy.md §6.1`).
- Lines 164-184: `applyArmedModifiers(input, ctrl, alt)` — applies modifiers to FIRST char only (multi-char input from paste/IME passes the rest unchanged), Ctrl wraps via `ctrlOf`, Alt prepends `\x1b` AFTER Ctrl wrapping so `Ctrl+Alt+a` = `\x1b\x01`.

`/root/projects/claude-terminal/src/lib/useModifierState.ts`:
- Per WP-C changelog, exposes `useModifierStore` (Zustand store) with `armCtrl/armAlt/lockCtrl/lockAlt/unlockCtrl/unlockAlt/consumeModifiers`. `consumeModifiers()` snapshots `{ctrl, alt}` and clears the unlocked arms (preserves locked).

`/root/projects/claude-terminal/src/lib/useVisualViewport.ts`: covered in §1.2.2. Writes `--kbd-height` continuously so `ModifierKeyBar`'s `bottom: var(--kbd-height)` tracks the keyboard top.

`/root/projects/claude-terminal/src/lib/TerminalIOContext.tsx`:
- Lines 34-60: `TerminalIOValue` interface — refs (`xtermRef`, `wsRef`, `terminalElementRef`, `mobileInputRef`), methods (`sendInput`, `requestResize`), state (`isReady`, `setReady`).
- Lines 68-125: `TerminalIOProvider` mounts the provider with refs initialized to null and `isReady` defaulting false.
- Lines 82-94: `sendInput(data)` routes via `xterm.input(data, true)` — preserves the DA/CPR filter and any future server-side recording / replay path. Single ingress per `06 §10 criterion 13`. Silently no-op when xterm/WS not ready (matches desktop drop-bytes-during-reconnect contract).
- Lines 132-140: `useTerminalIO()` throws if called outside the provider (defensive).

#### 1.3.4 Chain walk — `Terminal.tsx` mobile wiring

`/root/projects/claude-terminal/src/components/Terminal.tsx`:
- Line 128: `const terminalIO = useTerminalIO();` — Terminal is a child of `<TerminalIOProvider>` per `dashboard/page.tsx:479`.
- Lines 614-615: after xterm init: `terminalIO.xtermRef.current = term; terminalIO.terminalElementRef.current = terminalRef.current;`.
- Line 462: after WS open: `terminalIO.wsRef.current = ws;`.
- Line 467: `terminalIO.setReady(true);`.
- Lines 530-531: WS close/error: `terminalIO.wsRef.current = null; terminalIO.setReady(false);`.
- Lines 794-802: cleanup on unmount: nulls all refs and `setReady(false)`.
- Lines 678-692 — the **mobile pointerdown handler**:
  ```tsx
  const handlePointerDown = () => {
    if (!window.matchMedia("(max-width: 767px)").matches) return;
    const inputEl = terminalIO.mobileInputRef.current;
    if (!inputEl) return;
    try {
      inputEl.focus({ preventScroll: true });
    } catch {
      inputEl.focus();
    }
  };
  terminalRef.current.addEventListener("pointerdown", handlePointerDown, true);
  ```
  Capture-phase listener; runs synchronously inside the user's gesture. iOS Safari requires this for soft-keyboard summoning. **Correct in principle but functionally a no-op**: `terminalIO.mobileInputRef.current` is `null` because nothing has called `setTextarea` to populate it (because `<MobileTerminalInput/>` is never mounted to define the textarea ref).
- Lines 743-761: `visualViewport.resize/scroll` listener — re-runs the same debounced fit logic + `term.scrollToBottom()` when keyboard opens. Independent of MobileTerminalInput; works regardless. PASS.
- Line 642: `term.attachCustomKeyEventHandler(getDefaultKeyHandler(term));` — installs the desktop Ctrl+Shift+C copy handler. The factory `getDefaultKeyHandler(term)` is exported at module level (per WP-C deviation note) so future mobile-input cleanup can re-install on tablet rotation per `05 §10 risk 4 / §12.2`.

#### 1.3.5 Audit-time grep — orphan confirmation

```
$ grep -rln "MobileTerminalInput\|ModifierKeyBar" src/
src/components/Terminal.tsx                              (only in JSDoc/comments at lines 126, 612, 638, 674)
src/components/mobile/ModifierKeyBar.tsx                 (definition file only)
src/components/mobile/MobileTerminalInput.tsx            (definition file only)
src/lib/TerminalIOContext.tsx                            (only in JSDoc lines 5-16)
src/lib/useModifierState.ts                              (definition of supporting hook)
```

Zero JSX usages, zero `import` statements. `dashboard/page.tsx` does not import either. `DashboardLayout.tsx` does not import either. No `<MobileTerminalInput/>` or `<ModifierKeyBar/>` JSX exists anywhere in the application.

The integration plan `06 §5.5 Component-mount table` says these components should be mounted at `dashboard/page.tsx` inside the terminal stage (page.tsx:404 area, sibling of `<Terminal>`), gated by `useIsMobile() === true && useVisualViewport().isKeyboardOpen === true`. The expected mount slot exists (`dashboard/page.tsx:478-498` is the terminal-active branch wrapped in `<TerminalIOProvider>` → `<TerminalScrollProvider>`); WP-C changelog says "WP-D will mount the sheets that consume [overlayStore]" but WP-D's own changelog only mounts the chat/files/admin sheets, never the terminal-input proxy or modifier bar. Another ownership-handoff failure.

#### 1.3.6 Evidence summary (D3)

| Sub-criterion | Verdict | Evidence |
|---|---|---|
| `MobileTerminalInput` component file present | PASS | `mobile/MobileTerminalInput.tsx` (255 lines) |
| Hidden textarea with mobile-friendly attrs | PASS | Lines 226-231 |
| 16 px font-size (defeats iOS zoom) | PASS | Line 239 |
| Calls `terminalIO.sendInput` via `xterm.input(data, true)` | PASS | `MobileTerminalInput.tsx:98`, `TerminalIOContext.tsx:82-94` |
| Bracketed-paste via `xterm.paste(text)` | PASS | Line 151 |
| Enter→`\r`, Backspace on empty→`\x7f` | PASS | Lines 174, 181 |
| IME composition handled (compositionstart/end) | PASS | Lines 105-127 |
| Samsung-Keyboard `e.data` fallback | PASS | Line 117 |
| Modifiers applied to first char only | PASS | `applyArmedModifiers` at `mobile-input.ts:164-184` |
| `aria-label="Ввод в терминал"` Russian | PASS | Line 233 |
| `inputmode/enterkeyhint=send/autocapitalize=off/autocorrect=off/spellcheck=false/autocomplete=off` | PASS | Lines 226-231 |
| Position fixed at `bottom: var(--kbd-height)` | PASS | Line 205 |
| Returns null when `!isMobile` | PASS | Line 188 |
| **`MobileTerminalInput` ACTUALLY MOUNTED** | **FAIL** | Zero importers in `src/`; zero JSX usages |
| `ModifierKeyBar` component file present | PASS | `mobile/ModifierKeyBar.tsx` (298 lines) |
| 14 visible keys per frozen list | PASS | `MODIFIER_KEY_LIST` at `mobile-input.ts:79-94` |
| Sticky position via `--kbd-height` | PASS | Lines 241-243 |
| DECCKM-aware arrows read at click-time | PASS | Lines 84-87 |
| Blink gesture model (tap/long-press/auto-repeat) | PASS | Lines 121-219 |
| `pointerleave`/`pointercancel` clear timers | PASS | Lines 213-219, 268 |
| `role="toolbar"` + Russian `aria-label` | PASS | Lines 239-240 |
| Modifier buttons have `aria-pressed={armed}` | PASS | Line 264 |
| Page-swap (`⋯`) toggles arrow group ↔ Home/End/PgUp/PgDn | PASS | Lines 226-235 |
| Returns null when `!isMobile` | PASS | Line 221 |
| **`ModifierKeyBar` ACTUALLY MOUNTED** | **FAIL** | Zero importers in `src/`; zero JSX usages |
| `useVisualViewport` writes `--kbd-height` | PASS | `useVisualViewport.ts:57-63` |
| `Terminal.tsx` mobile pointerdown → focus(mobileInputRef) | PASS-but-no-op | `Terminal.tsx:678-692`; ref always null |
| `TerminalIOContext` refs filled by Terminal.tsx | PASS | `Terminal.tsx:614-615, 462, 467, 530-531, 794-802` |
| `terminalIO.sendInput` routes via `xterm.input(data, true)` | PASS | `TerminalIOContext.tsx:82-94` |
| DA/CPR filter at `Terminal.tsx:217` still applies to mobile bytes | PASS-by-design | sendInput uses `term.input` which fires `term.onData` |
| `useModifierState` Zustand store | PASS | `lib/useModifierState.ts` (per WP-C changelog) |
| `mobile-input.ts` byte tables verified | PASS | Lines 22-36, vs `02-scan-terminal.md §4.2` |

#### 1.3.7 Phase 8 validation

`08-validate-mobile.md §6` per-target rows #3 and #4 logged D3 sub-criteria as **PARTIAL** with note "MobileTerminalInput.tsx / ModifierKeyBar.tsx exist, integrate TerminalIOContext, calls xterm.input(data, true) per source — END-TO-END requires device". The validator confirmed source-level correctness but never confirmed runtime mount because (a) the dashboard route is JWT-gated and the headless validator cannot pass auth, and (b) without dashboard access there's no JSX tree to inspect for `<MobileTerminalInput/>` mounts. Same root cause as the D1 mount-omission going unnoticed.

#### 1.3.8 Net D3 verdict: FAIL

The user's "поле ввода в терминал нормально работало" demand is not met. On a real iPhone the user will tap the terminal canvas, the `Terminal.tsx:678-692` pointerdown handler will fire and try to call `terminalIO.mobileInputRef.current?.focus()` on a forever-null ref. Soft keyboard does not open. There is no on-screen input field, no modifier bar, no way to type into the terminal except the existing xterm helper textarea path which the user already complained about as "вообще неудобно".

The kicker: every supporting piece is ready. The TerminalIOContext wiring in Terminal.tsx works. The `useVisualViewport` hook writes `--kbd-height`. The `applyArmedModifiers` byte logic is correct. The `useModifierState` store is correct. `MobileTerminalInput.tsx` and `ModifierKeyBar.tsx` are correctly written. They just need to be mounted — two `import` statements + two JSX tags inside the terminal-active branch at `dashboard/page.tsx:478-498`, gated by `isMobile && isKeyboardOpen` (or by `isMobile` alone if the spec's `isKeyboardOpen` gate is too aggressive — the integration plan §5.5 lists both gates).

---

## 2. Per-UX-Target Table (all 11 targets from `01-planner-mobile.md`)

| # | Target | Verdict | Evidence / notes |
|---|---|---|---|
| 1 | Viewport coverage 360→430, tablet ≥768 falls back to desktop | PASS | Validator confirmed at 6 viewports (`08-validate-mobile.md §3`); viewport-meta exact-string match; no horizontal scroll at any width; tablet uses desktop layout because `MobileBottomBar` and other mobile-only mounts are `md:hidden` or `useIsMobile()`-gated |
| 2 | Single mobile nav surface (Navbar + SessionList consolidated) | **FAIL** | Bottom-bar component repurposed correctly to (Терминал/Сессии/Чат/Ещё) at `MobileBottomBar.tsx:37-42`; but: (a) hamburger still drives `mobileSidebarOpen` local state → legacy IconRail+SidePanel slide-in via `DashboardLayout.tsx:88-131`, (b) `MobileSessionsSheet` and `MobileMoreSheet` orphaned; bottom-bar's "Сессии" / "Ещё" tabs = dead clicks. Two competing mobile nav surfaces remain. |
| 3 | Terminal input proxy (real `<input>` bound to OS keyboard, IME-aware, autocorrect-off, autocapitalize-off, spellcheck-off) | **FAIL** | `MobileTerminalInput.tsx` correctly written with all required attrs and IME handling, never mounted. Tapping canvas runs the synchronous-gesture focus handler at `Terminal.tsx:678-692` → focus target `terminalIO.mobileInputRef.current` is forever null. Soft keyboard does not open. |
| 4 | Modifier bar above keyboard (Esc/Tab/Ctrl/Alt/↑↓←→/^C/^D/^L/^R/⇧Tab + chord launcher) | **FAIL** | `ModifierKeyBar.tsx` correctly written with frozen 14-key list, Blink gesture model, DECCKM-aware arrows; never mounted. User sees no bar. |
| 5 | `visualViewport`-aware layout (input row flush against keyboard top, terminal scrolls to cursor, ChatPanel/Drawer never covered) | PARTIAL | `useVisualViewport` hook writes `--vvh`/`--kbd-height`/`--vv-offset-top` correctly (`useVisualViewport.ts:57-63`); `Terminal.tsx:743-755` scrolls to bottom on keyboard open; ChatSheet (`MobileChatSheet`) IS mounted and would benefit if user opens chat with keyboard. But the consumers that need `--kbd-height` for the modifier bar / mobile input (`ModifierKeyBar`, `MobileTerminalInput`) are never mounted, so the keyboard-flush behavior for the terminal is unreachable. |
| 6 | Safe-area insets (notch / Dynamic Island / home indicator never overlap) | PASS | Six `@utility` classes authored at `globals.css:70-75`; `pb-safe` confirmed in `MobileBottomBar.tsx:96`, `MobileSessionsSheet.tsx:59`, `MobileMoreSheet.tsx:79`, `MobileChatSheet.tsx`, `MobileFilesSheet.tsx`, `MobileAdminSheet.tsx` (per WP-D), `HotkeysModal.tsx:276` (mobile branch), `ChatPanel.tsx`, `FileManager.tsx`, `AdminPanel.tsx` (per WP-D). For the orphan sheets the safe-area still attaches automatically when they are eventually mounted. |
| 7 | Touch ergonomics (≥44×44 tap targets, no hover-only, swipe-to-open drawer, pull-to-refresh disabled) | PARTIAL | `Navbar.tsx:71/146/167` bumped to `p-2.5`; `ModifierKeyBar.tsx:274` `min-w-[44px] h-11`; `MobileBottomBar.tsx:96` `h-14`; `MobileMoreSheet.tsx:95` rows `h-11`. Pull-to-refresh disabled via `body { overscroll-behavior: contain }` (`globals.css:186`). Hover-on-desktop / always-on-mobile pattern preserved in `SessionPanel`. Vaul provides drag-to-close on every sheet that IS mounted (chat/files/admin/hotkeys-mobile). WP-B noted `p-2.5` ≈ 40 px and "if 8c asserts fail, raise to p-3" — runtime ≥44 px not verified. |
| 8 | ChatPanel mobile mode (full-height bottom sheet or full-screen overlay; never squeezes terminal <320 px) | PASS | `MobileChatSheet.tsx` mounted at `dashboard/page.tsx:609`, controlled by `useOverlay("chat")`, vaul drawer at 95dvh, `pb-safe`, `aria-label="Чат"`. ChatInput is `text-base md:text-sm` (`ChatInput.tsx:208`) plus globals.css 16-px override → iOS won't zoom. Bidirectional sync between local `chatOpen` and `overlayStore` works on mobile. |
| 9 | FileManager mobile mode (touch-friendly list, big rows, swipe actions, modal previews) | PASS | `MobileFilesSheet.tsx` mounted at `dashboard/page.tsx:610`; `FileManager.tsx:102-103` consumes `useIsMobile()` to swap to `MOBILE_COLUMNS = "32px 28px 1fr 80px"` (4-column mobile grid template, drops size + mtime cols); `pb-safe` on outer wrapper (per WP-D). |
| 10 | No layout breakage (zero horizontal scroll, no `100vh` traps; use `100dvh` / `visualViewport.height`) | PASS | All 8 dvh swaps verified (validator §5.7); dashboard tree has 0 `100vh` hits (validator §5.1; only 2 surviving are out-of-scope: `symphony/page.tsx`, `auth/approve/route.ts`); root container uses `var(--vvh, 100dvh)` (`DashboardLayout.tsx:57-69`); 60/60 viewport assertions PASS (validator §3). |
| 11 | Performance (terminal resize debounced; no layout thrash on keyboard open/close; FPS ≥50 mid-range Android) | PARTIAL | Resize debounce `RESIZE_DEBOUNCE_MS = 80` (`Terminal.tsx`); visualViewport listener throttled by browser; `style.setProperty` on `--vvh`/`--kbd-height` is sub-microsecond with no rAF batching per `05 §12.8`. ResizeObserver + visualViewport.resize coalesced via debounce timer at `Terminal.tsx:725-735`. FPS measurement requires real device; validator deferred to Phase 10b. |

**Summary: 5 PASS / 4 PARTIAL / 2 FAIL out of 11 UX targets.**

The 2 FAIL targets (#2, #3) and 3 of the 4 PARTIALs (#4 modifier bar, #5 keyboard-flush, #7 ≥44 px runtime) all share the same root cause: orphaned components. Mounting `MobileTerminalInput`, `ModifierKeyBar`, `MobileSessionsSheet`, `MobileMoreSheet` (plus rewiring the hamburger to `openOverlay("more")` and gating the legacy AnimatePresence drawer behind `!isMobile`) would convert all five of those rows to PASS.

---

## 3. Open Caveats — what still might not be 100% on real device

1. **Mount omission is the critical defect.** Even after the orphans are mounted, the per-device behavior of the new code has never been exercised in the wild. Static checks confirm files exist and logic is correct; runtime is unverified. Phase-10b is mandatory.

2. **iOS focus race on first-tap.** `Terminal.tsx:678-692` uses `pointerdown` (capture-phase) for the synchronous-gesture focus call. iOS Safari sometimes emits `touchstart` before `pointerdown`; if any other handler in the tree calls `e.preventDefault()` on `touchstart`, the pointerdown is suppressed and the keyboard does not open. Currently no other handler does this — flagged for monitoring per `07-impl-terminal-combined.md` "Risks observed".

3. **Modifier-bar position lag (~50 ms).** The bar tracks `--kbd-height` via `useVisualViewport`'s event subscription. iOS Safari debounces `vv.resize`; on initial keyboard slide-in there can be 1–2 frames of visible mismatch (bar at old `bottom: 0` while keyboard rises) before the CSS var catches up. Visible jank possible but acceptable per `05` spec.

4. **Rapid toggle stale state (WP-D `MobileChatSheet` ↔ `MobileFilesSheet`).** WP-D's bidirectional sync uses six `useEffect` watchers between local React state (`chatOpen`/`adminOpen`/`viewMode === "files"`) and `overlayStore.activeOverlay`. Under fast toggling on real mobile (≤150 ms apart), one effect's state can lag one frame behind the other and produce a momentary "both closed" mismatch. Mutex semantics in the store prevent the worst case (two sheets visible at once) but the user can briefly see neither sheet during a quick swap. Documented in WP-D §"Top risk".

5. **`overlayStore` dual API surface.** Long names (`"sessionsSheet"`) and short names (`"sessions"`) coexist as compatibility shim per WP-A's deviation. Mutex semantics preserved on both, but a future contributor adding a NEW slot must add it to BOTH unions or risk a typecheck miss. Maintenance debt.

6. **`HotkeysModal` re-mounted at page level even on desktop.** WP-B removed the IconRail-internal mount; WP-D added the page-level `<HotkeysModal />`. Desktop now has a single source of truth, but the desktop hotkey-icon button at `IconRail.tsx:101` calls `openOverlay("hotkeys")` — fine. Risk: any third-party code still passing `open`/`onClose` props to `<HotkeysModal />` would silently no-op (none does today per audit grep).

7. **`CommandPalette.tsx:43` lint error left unfixed** — `react-hooks/set-state-in-effect`. Validator §5.1 classified as conforming-to-pre-existing-pattern; same lint exists in 14+ pre-existing files. Build is unaffected.

8. **Tailwind v4 `@utility` directive support.** The `pt-safe`/`pb-safe`/etc. classes work via Tailwind v4's `@utility` mechanism in `globals.css:70-75`. If Tailwind v4's PostCSS adapter version drifts to a release that changes `@utility` semantics (the spec is recent), the safe-area classes silently stop generating and the iOS notch/home-indicator overlap returns. Pin Tailwind version (`^4` in `package.json:81` is too loose).

9. **`viewport-fit=cover` activates `env(safe-area-inset-*)` only when in fullscreen-equivalent display mode.** On mobile Safari with the bottom toolbar visible, `safe-area-inset-bottom` may report 0 (no home-indicator zone visible because the toolbar fills it). When the user scrolls down and Safari hides the toolbar, the inset becomes non-zero — content reflows. Visible jank possible. Mitigated by `interactive-widget=resizes-content` only on Chrome 108+; iOS Safari ignores it.

10. **The 95 / 100 dvh sheet heights** (`MobileChatSheet h-[95dvh]`, `MobileFilesSheet h-[100dvh]`) on iOS Safari with toolbar visible may overflow under the toolbar. `dvh` is the dynamic-viewport-height which IS toolbar-aware on Safari 16.4+, but older iOS 15 fallback could clip the bottom edge.

11. **Russian text fit at 360 px** for tab labels "Терминал / Сессии / Чат / Ещё" at `text-[10px]` (`MobileBottomBar.tsx:112`) — fits per static analysis but font-rendering on actual devices (different Latin/Cyrillic glyph metrics) might wrap. Not visually verified.

12. **`MobileBottomBar` "Files" icon used for Sessions tab** because `Icons.tsx` has no `ListIcon`. WP-B flagged this in their changelog. Visually ambiguous — looks like "files manager" not "list of sessions". Cosmetic but worth fixing before user testing.

13. **`MobileBottomBar` Terminal-tab snap behavior** (lines 80-90): tapping "Терминал" calls `setActiveSection("sessions")` + `setPanelOpen(false)` + `closeOverlay()`. If the user is on the Symphony or System section when they tap Terminal, the section flip may briefly render the sessions UI before the terminal canvas settles. Minor.

14. **Image paste pipeline unchanged.** Image-from-clipboard still flows through `Terminal.tsx:647-670` capture-phase listener → server xclip → `\x16` (Ctrl-V) PTY byte. `MobileTerminalInput.handlePaste` correctly bails on `cd.types.includes("Files")` so this path is preserved when the orphans are mounted. No regression risk.

15. **`getDefaultKeyHandler(term)` re-installer.** The exported module-level factory at `Terminal.tsx` allows mobile-input cleanup to re-install the desktop Ctrl+Shift+C copy handler on tablet rotation portrait→landscape. `MobileTerminalInput`'s in-spec cleanup logic (per `06 §2.5` "On unmount: ... re-install the original Ctrl+Shift+C copy handler") was implemented. But because `MobileTerminalInput` is never mounted, this cleanup never runs — moot today, but if mounting is added later, verify the handler swap works on rotation.

---

## 4. Real-Device Gaps — what the user must verify on his iPhone + Android

(Concise checklist. Cannot be automated without a fixture-login backdoor; see validator §7 risk #2.)

1. **Mount the orphans first, then test.** Open the dashboard on iPhone Safari. Confirm the bottom bar's "Сессии" tab opens the vaul drawer with the session list (currently FAILS — dead click). Confirm "Ещё" opens the left-edge MoreSheet with secondary nav (currently FAILS).
2. **Hamburger button.** Confirm the hamburger now opens the SAME drawer as "Ещё" (currently FAILS — it opens the legacy IconRail+SidePanel slide-in via `mobileSidebarOpen`). After patch: hamburger calls `openOverlay("more")`; `DashboardLayout.tsx:88-131` AnimatePresence block is removed or gated `{!isMobile && ...}`.
3. **Tap terminal canvas → keyboard slides up?** Currently FAILS because `MobileTerminalInput` is not mounted. After patch: keyboard appears, modifier bar sits flush against keyboard top, off-screen textarea is focused.
4. **Type "echo привет" + Enter.** Currently no on-screen input. After patch: typing latin and Cyrillic both reach the PTY; Enter sends `\r`; shell prompt advances; round-trip echo visible in xterm canvas.
5. **Modifier bar tap tests.** `Esc`, `Tab`, `Ctrl+C`, `Ctrl+D`, `Ctrl+L`, `Alt+B`, arrows, `^R`, `⇧Tab`, hold `↑` for auto-repeat, long-press `Ctrl` for lock — all per `08-validate-mobile.md §4.4` checklist.
6. **iOS notch / Dynamic Island / home indicator.** Confirm Navbar content not under notch; bottom bar respects home indicator; modifier bar (when keyboard closed) doesn't hide behind home indicator.
7. **Pinch-zoom in xterm output.** Should work (`user-scalable` intentionally not pinned per `05 §2.6`). Modifier bar should track `visualViewport.offsetTop` correctly during pinch.
8. **iOS keyboard open while ChatSheet is open.** Tap ChatInput while sheet is open — sheet should not jump; ChatInput row should sit flush against keyboard top.
9. **CJK / Pinyin / voice dictation.** Type Chinese via Gboard or use long-press space for iOS dictation — composition should ship via `compositionend.data` only, no per-char duplicates.
10. **Fast tab switching (Chat → Files → Chat → Sessions).** Confirm overlay mutex works — at most one sheet visible at a time, no double-overlay.
11. **Tap targets feel.** Every button in modifier bar, MobileBottomBar, vaul sheets ≥44 px hit area (thumb miss-tap test).
12. **Russian labels render correctly at 360 px iPhone SE.** "Терминал / Сессии / Чат / Ещё" all visible without truncation; aria-labels announced correctly by VoiceOver/TalkBack.
13. **Cmd+K with external Bluetooth keyboard inside ChatInput.** Confirm the literal "k" character is typed (CommandPalette is suppressed inside INPUT/TEXTAREA per `CommandPalette.tsx:54-77` scope guard). Outside any input, Cmd+K opens the palette.
14. **Mobile palette access without external keyboard.** After orphans are mounted: `MobileMoreSheet.tsx:130-136` only opens hotkeys, not the palette — there's no UI affordance for opening CommandPalette on mobile. This may be intentional (Cmd+K is a keyboard shortcut by definition); or it may be a Phase-10 polish addition (palette icon in MoreSheet).

---

## 5. Minimum patch to close D1 + D3 (informational)

This is not part of the audit deliverable but is included so the user can immediately understand the size of the gap. Phase 10 polishers may use it as a starting point.

### 5.1 Mount `MobileTerminalInput` and `ModifierKeyBar`

Inside `src/app/dashboard/page.tsx` at the terminal-active branch (currently lines 478-498), inside the `<TerminalIOProvider><TerminalScrollProvider>...` tree, add as a sibling of `<Terminal>`:

```tsx
import MobileTerminalInput from "@/components/mobile/MobileTerminalInput";
import ModifierKeyBar from "@/components/mobile/ModifierKeyBar";
// ...
<TerminalIOProvider>
  <TerminalScrollProvider>
    <div ref={contentRef} ...>
      <CursorOverlay />
      ...
      <Terminal ... />
      {isMobile && <MobileTerminalInput />}
      {isMobile && <ModifierKeyBar />}
    </div>
  </TerminalScrollProvider>
</TerminalIOProvider>
```

Both components self-gate via `if (!isMobile) return null;` — the outer `{isMobile &&` wrapper is belt-and-suspenders.

### 5.2 Mount `MobileSessionsSheet` and `MobileMoreSheet`

Inside `src/app/dashboard/page.tsx` at the existing mobile-overlays block (lines 607-613), add the two missing imports + JSX:

```tsx
import MobileSessionsSheet from "@/components/mobile/MobileSessionsSheet";
import MobileMoreSheet from "@/components/mobile/MobileMoreSheet";
// ...
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
    <MobileMoreSheet onLogout={handleLogout} systemAlerts={systemAlerts} />
    <MobileChatSheet onImageClick={(src) => setLightboxSrc(src)} />
    {activeSessionId && <MobileFilesSheet sessionId={activeSessionId} initialFile={initialFile} />}
    {isAdmin && <MobileAdminSheet onPendingCountChange={setPendingCount} />}
  </>
)}
```

(Or alternatively mount them inside `DashboardLayout.tsx` per the original WP-B plan; either location works because `useOverlay` reads from a global Zustand store.)

### 5.3 Rewire hamburger to overlay store + gate legacy drawer

Two changes — `Navbar.tsx` (or its callsite) + `DashboardLayout.tsx`:

**Option A** (minimum churn — change just the callsite at `dashboard/page.tsx:439`):
```tsx
// Before:
onMenuClick={() => setMobileSidebarOpen(true)}
// After:
onMenuClick={() => isMobile ? openOverlay("more") : setMobileSidebarOpen(true)}
```
And in `DashboardLayout.tsx:89-131`, gate the AnimatePresence block:
```tsx
{!isMobile && (
  <AnimatePresence>
    {mobileSidebarOpen && ( ... )}
  </AnimatePresence>
)}
```
(The legacy block becomes desktop-only — though "mobileSidebarOpen" being a misnomer at that point is cosmetic.)

**Option B** (cleaner — remove `mobileSidebarOpen` state entirely, drive Navbar's hamburger from `useOverlay("more")` directly):
- `Navbar.tsx`: import `useOverlayStore`, replace `onMenuClick` prop wire-up with internal `onClick={() => openOverlay("more")}` on the hamburger.
- `DashboardLayout.tsx`: remove `mobileSidebarOpen` / `onCloseMobileSidebar` props, remove the AnimatePresence block at lines 89-131 entirely.
- `dashboard/page.tsx`: drop `mobileSidebarOpen` state, drop the `onMenuClick` and `mobileSidebarOpen`/`onCloseMobileSidebar` props from `<Navbar>` and `<DashboardLayout>`.

**Option B is the canonical fix** per the integration plan but touches 3 files; Option A is the 5-line patch.

### 5.4 Total patch size

| Patch | Lines added | Lines removed | Files touched |
|---|---:|---:|---:|
| 5.1 + 5.2 (mount orphans) | ~20 | 0 | 1 (`dashboard/page.tsx`) + optional `DashboardLayout.tsx` |
| 5.3 Option A (gate legacy) | ~3 | ~1 | 2 (`dashboard/page.tsx` + `DashboardLayout.tsx`) |
| 5.3 Option B (clean hamburger rewire) | ~5 | ~30 | 3 (`Navbar.tsx` + `DashboardLayout.tsx` + `dashboard/page.tsx`) |

Either option closes D1's structural gap and D3 entirely. After patch, all five FAIL+PARTIAL UX targets (#2, #3, #4, #5-keyboard-flush, #7-runtime) should flip to PASS at the next Phase-8 device test. PARTIAL #6, #11 stay PARTIAL pending real-device verification.

---

## 6. Recommendation to user (Russian, 4-6 sentences)

Сделали много правильного по подложке: подтянули viewport-meta с `viewport-fit=cover` и `interactive-widget=resizes-content`, заменили все `100vh` на `100dvh` плюс JS-хук на `visualViewport`, добавили safe-area-utilities, прокинули 16-px шрифт во все инпуты (чтобы iOS не зумил при фокусе), переписали `MobileBottomBar` на (Терминал/Сессии/Чат/Ещё) — лейаут больше ломаться не должен, и это можно проверить открыв любую страницу в мобильном Safari. Но критическая поломка интеграции: четыре новых компонента — `MobileTerminalInput`, `ModifierKeyBar`, `MobileSessionsSheet`, `MobileMoreSheet` — написаны корректно и лежат в `src/components/mobile/`, но **никем не вмонтированы в JSX** (audit-time `grep -rln` показывает ноль импортов в приложении), поэтому на телефоне вы не увидите ни поля ввода в терминале, ни модификаторов клавиатуры, ни Sessions/More-листов; кнопки "Сессии" и "Ещё" в нижней панели будут мёртвыми, а гамбургер всё ещё открывает старый дублирующий drawer (IconRail + SidePanel) вместо нового MobileMoreSheet. **Сначала откройте приложение на iPhone и тапните терминал — почти наверняка клавиатура не вылезет**; если так, нужен короткий доводочный патч (~15-25 строк): вмонтировать четыре орфана в `dashboard/page.tsx`, переключить гамбургер с `setMobileSidebarOpen` на `openOverlay("more")`, и удалить или загейтить `{!isMobile && ...}` `AnimatePresence`-блок в `DashboardLayout.tsx:88-131`. После этого имеет смысл прогнать чек-лист из §4 — D2 уже работает, а D1 + D3 закроются автоматически как только орфаны окажутся в дереве.

---

End of `09-audit-mobile.md`.
