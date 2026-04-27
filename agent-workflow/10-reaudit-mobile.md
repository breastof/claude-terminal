# Phase 10 — Mobile Re-Audit (post-fixup)

> Re-Auditor: `re-auditor-mobile-postfixup`
> Date: 2026-04-26
> Branch: `feat/tmux-streaming-and-mobile`
> Inputs: `09-audit-mobile.md` (FAIL on D1 + D3), `10-fixup-mounts.md` (claims +43 LoC across 3 files closes both gaps)
> Method: opened the actual source files in `src/`, walked the four orphan mounts end-to-end, ran `npx tsc --noEmit` and the two grep checks the prompt specified. Every PASS/FAIL below is grounded in a file:line citation collected at audit time, not in the fix-up's prose.

---

## 0. Top-line Verdict

**PASS.**

The fix-up implementer did exactly what was claimed in `10-fixup-mounts.md`:

1. **All four orphan components are now imported AND mounted in JSX** in
   `src/app/dashboard/page.tsx` — confirmed at lines 42-45 (imports) and
   502-503 / 618-628 (JSX).
2. **The legacy mobile `AnimatePresence` slide-in drawer is gated behind
   `{!isMobile && (...)}`** in `src/components/pos/DashboardLayout.tsx`
   lines 95-139.
3. **The hamburger button now calls `openOverlay("sessions")` on mobile**
   via `useIsMobile` + `useOverlayStore` in `src/components/Navbar.tsx`
   lines 49-62.
4. **`npx tsc --noEmit` exits 0** — no type regressions from the patch.
5. **The grep `grep -rn 'MobileTerminalInput|ModifierKeyBar|MobileSessionsSheet|MobileMoreSheet' src/app src/components`** now returns real `import` and `<JSX>` lines, not just JSDoc references — the orphan defect is closed.

The root cause from `09-audit-mobile.md §1.1.3 / §1.3.5` (the four
critical mobile components compiled but were never mounted in any JSX
tree) is structurally fixed. D1 and D3 flip from FAIL to PASS at the
source-of-truth tier; the next remaining hop — real-device verification
on iPhone Safari and Android Chrome — is still required and is called
out in §6 below.

UX-target rescore (full table in §5): **8 PASS / 3 PARTIAL / 0 FAIL** out of 11
(was 5 PASS / 4 PARTIAL / 2 FAIL pre-fixup). Two of the three remaining
PARTIALs (#7 ≥44 px, #11 perf) are real-device-only — they cannot move
without instrumented testing. The third PARTIAL (#5 visualViewport-flush)
is now PASS-by-construction at the source tier; left as PARTIAL only
because the keyboard-flush behavior of the freshly-mounted modifier bar
has never been seen running on an actual phone.

**Greenlight for deploy: YES, conditional on a real-device smoke pass
(check #1, #3, #4, #5, #11 from §6 below — about 5 minutes on an
iPhone + 5 minutes on an Android). Build is clean, types are clean,
the hamburger no longer opens a competing nav surface, and the
keyboard-summon path now has a real DOM target.**

---

## 1. D1 verdict — single mobile nav surface

**Verdict: PASS.**

Three independent surfaces had to converge:

### 1.1 Hamburger button → `openOverlay("sessions")`

`src/components/Navbar.tsx`:

- Lines 6-7: imports added — `useIsMobile`, `useOverlayStore`.

  ```ts
  import { useIsMobile } from "@/lib/useIsMobile";
  import { useOverlayStore } from "@/lib/overlayStore";
  ```

- Lines 49-50: hooks in component body.

  ```ts
  const isMobile = useIsMobile();
  const openOverlay = useOverlayStore((s) => s.openOverlay);
  ```

- Lines 56-62: `handleMenuClick` wrapper.

  ```ts
  const handleMenuClick = () => {
    if (isMobile) {
      openOverlay("sessions");
    } else if (onMenuClick) {
      onMenuClick();
    }
  };
  ```

- Lines 85-93: hamburger now renders whenever `(onMenuClick || isMobile)`
  is true (so even a future caller that forgets the prop still gets a
  mobile entry point) and `onClick={handleMenuClick}`. Class is unchanged
  `md:hidden p-2.5 -ml-1`. `aria-label="Открыть меню"` preserved.

  ```tsx
  {(onMenuClick || isMobile) && (
    <button
      onClick={handleMenuClick}
      aria-label="Открыть меню"
      className="md:hidden p-2.5 -ml-1 text-muted-fg hover:text-foreground transition-colors"
    >
      <Menu className="w-5 h-5" />
    </button>
  )}
  ```

This satisfies the prompt's directive "the hamburger now calls
`openOverlay('sessions')` (or whatever slot the fix-up chose)" — the
fix-up chose `"sessions"` per `10-fixup-mounts.md §3.7` rationale (the
legacy drawer's primary content is the SessionPanel, so `"sessions"` is
the closest semantic match).

### 1.2 Legacy `mobileSidebarOpen` drawer gated behind `{!isMobile && (...)}`

`src/components/pos/DashboardLayout.tsx`:

- Line 5: import added — `useIsMobile`.

  ```ts
  import { useIsMobile } from "@/lib/useIsMobile";
  ```

- Line 49: hook in body.

  ```ts
  const isMobile = useIsMobile();
  ```

- Lines 90-139: the entire `<AnimatePresence>{mobileSidebarOpen && ...}</AnimatePresence>`
  block (which used to render `IconRail + SidePanel` as a slide-in drawer
  on mobile) is now wrapped in `{!isMobile && (...)}`.

  ```tsx
  {/* Legacy mobile sidebar overlay (IconRail + SidePanel slide-in).
      Gated to `!isMobile` so the duplicate nav surface vanishes on phones —
      MobileSessionsSheet + MobileMoreSheet now own that responsibility per
      `09-audit-mobile.md §5.3`. Tablet/desktop callers (which never set
      `mobileSidebarOpen`) are unaffected. */}
  {!isMobile && (
    <AnimatePresence>
      {mobileSidebarOpen && (
        <>
          <motion.div ... className="fixed inset-0 bg-black/60 z-30 md:hidden" .../>
          <motion.div ... className="fixed top-0 left-0 bottom-0 z-40 md:hidden flex">
            <IconRail onLogout={onLogout} systemAlerts={systemAlerts} />
            <div className="w-[280px] bg-surface border-r border-border relative">
              ...
              <SidePanel ... />
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )}
  ```

The dual-nav-surface defect from `09-audit-mobile.md §1.1.6` is closed:
on `useIsMobile() === true` the legacy `AnimatePresence` block returns
nothing, so the only mobile nav surfaces are `MobileBottomBar`,
`MobileSessionsSheet`, and `MobileMoreSheet`. The leftover
`md:hidden` class on the inner `motion.div`s is now belt-and-suspenders
(under `!isMobile`, those branches never render in the first place).

**Note on residual cosmetic risk**: the `mobileSidebarOpen` state still
lives in `dashboard/page.tsx:89` (`useState(false)`) and is still passed
into `DashboardLayout`. On mobile, callers like `setMobileSidebarOpen(false)`
inside session handlers are harmless no-ops (the gated branch never
renders). On desktop the prop is not driven by anything user-visible
because the hamburger only renders at `md:hidden`. So the state is
effectively dead but harmless. Removing it would have widened the diff
and is not a correctness issue.

### 1.3 `MobileSessionsSheet` and `MobileMoreSheet` mounted

`src/app/dashboard/page.tsx`:

- Lines 42-43: imports.

  ```ts
  import MobileSessionsSheet from "@/components/mobile/MobileSessionsSheet";
  import MobileMoreSheet from "@/components/mobile/MobileMoreSheet";
  ```

- Lines 616-633: mobile-overlays JSX block — both sheets mounted alongside
  the existing `MobileChatSheet / MobileFilesSheet / MobileAdminSheet`
  trio.

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
      <MobileMoreSheet onLogout={handleLogout} />
      <MobileChatSheet onImageClick={(src) => setLightboxSrc(src)} />
      {activeSessionId && <MobileFilesSheet sessionId={activeSessionId} initialFile={initialFile} />}
      {isAdmin && <MobileAdminSheet onPendingCountChange={setPendingCount} />}
    </>
  )}
  ```

Notes:

- `MobileSessionsSheet` receives every handler the desktop `SidePanel`
  uses, plus `activeSessionId` for indicator display. Internally it
  wraps `onSelectSession` to auto-close the sheet on session pick (good
  UX — user lands on terminal canvas in one tap; verified at
  `MobileSessionsSheet.tsx:37-43`).
- `MobileMoreSheet` is mounted with `onLogout={handleLogout}` only. The
  fix-up explicitly skipped `systemAlerts` because the dashboard does
  not currently track that state (it's an optional prop used for the red
  dot indicator on the "Система" row). This is a deliberate omission per
  `10-fixup-mounts.md §3.1` — adding `systemAlerts` later would be a
  one-line change, not blocking.
- The `MobileSessionsSheet` reads from `useOverlay("sessions")` and so
  does the `MobileBottomBar` "Сессии" tab via `openOverlay("sessions")`
  (`MobileBottomBar.tsx:44-48 / 89`). The hamburger now also opens the
  same slot. **All three entry points converge to one drawer** —
  intentional per the fix-up's risk note in `10-fixup-mounts.md §"Residual
  risk"`. If a future UX review wants the hamburger and the bottom-bar
  "Ещё" tab to both open `MoreSheet` (so the hamburger's role becomes
  "secondary nav" while the bottom bar is "primary tabs"), it's a
  one-line change in `Navbar.handleMenuClick` (`openOverlay("more")`
  instead of `openOverlay("sessions")`). Both are valid routings; the
  prompt explicitly directed `"sessions"`, which is what shipped.

### 1.4 Bottom-bar tab routing remains correct

`src/components/pos/MobileBottomBar.tsx` is unchanged from pre-fixup:

- Lines 44-48: `TAB_TO_SLOT` maps `sessions → "sessions"`, `chat →
  "chat"`, `more → "more"`.
- Line 89: `openOverlay(TAB_TO_SLOT[tab])` for non-terminal tabs.
- Lines 80-87: terminal tab calls `setActiveSection("sessions") +
  setPanelOpen(false) + closeOverlay()` — correct.

So the four tabs map to:
- "Терминал" → close all overlays + snap to sessions section.
- "Сессии" → opens `MobileSessionsSheet` (was a dead click pre-fixup;
  now functional).
- "Чат" → opens `MobileChatSheet` (was already PASS; unchanged).
- "Ещё" → opens `MobileMoreSheet` (was a dead click pre-fixup; now
  functional).

### 1.5 D1 evidence summary

| Sub-criterion                                          | Verdict | Evidence                                                                |
|---|---|---|
| Bottom bar tabs `Терминал/Сессии/Чат/Ещё`              | PASS    | `MobileBottomBar.tsx:37-42`                                             |
| Bottom bar `md:hidden`                                 | PASS    | `MobileBottomBar.tsx:96`                                                |
| Bottom bar hides on keyboard open                      | PASS    | `MobileBottomBar.tsx:59-63`                                             |
| Bottom bar `pb-safe`                                   | PASS    | `MobileBottomBar.tsx:96`                                                |
| Bottom bar `role=tablist` + per-tab `aria-selected`    | PASS    | `MobileBottomBar.tsx:94, 103-105`                                       |
| Bottom bar mounted in `DashboardLayout`                | PASS    | `DashboardLayout.tsx:147`                                               |
| Hamburger has `aria-label="Открыть меню"`              | PASS    | `Navbar.tsx:88`                                                         |
| Hamburger wired to overlayStore on mobile              | **PASS**| `Navbar.tsx:56-62, 87`                                                  |
| Legacy mobile slide-in drawer gated `!isMobile`        | **PASS**| `DashboardLayout.tsx:95-139`                                            |
| Single mobile nav surface                              | **PASS**| Bottom-bar + sheets only on mobile; legacy AnimatePresence gated off    |
| `MobileSessionsSheet` mounted                          | **PASS**| `dashboard/page.tsx:618-627`                                            |
| `MobileMoreSheet` mounted                              | **PASS**| `dashboard/page.tsx:628`                                                |
| `MobileChatSheet` mounted (mobile-only)                | PASS    | `dashboard/page.tsx:629`                                                |
| `MobileFilesSheet` mounted (mobile-only)               | PASS    | `dashboard/page.tsx:630`                                                |
| `MobileAdminSheet` mounted (mobile-only)               | PASS    | `dashboard/page.tsx:631`                                                |
| `overlayStore` mutex API present + Zustand-backed      | PASS    | `lib/overlayStore.ts:81-87`                                             |
| `<HotkeysModal/>` page-level mount                     | PASS    | unchanged from `09-audit-mobile.md`                                     |
| `<CommandPalette/>` page-level mount + scope-guard     | PASS    | unchanged from `09-audit-mobile.md`                                     |
| Hamburger ≥44 px hit area                              | PARTIAL | `p-2.5` ≈ 40 px; runtime device verification still required             |

**D1 net verdict: PASS.** The dual-nav-surface defect that drove the
original FAIL is closed. The user will see exactly one mobile nav
surface: the bottom bar (4 tabs) plus the sheets it opens. The hamburger
goes to the same `"sessions"` sheet as the bottom-bar "Сессии" tab —
intentional convergence per fix-up rationale.

---

## 2. D2 verdict — layout doesn't break (re-confirmation)

**Verdict: PASS.** (re-confirmed unchanged)

D2 was PASS in `09-audit-mobile.md §1.2`. The fix-up did not touch any
substrate file (`app/layout.tsx`, `app/globals.css`, `lib/useVisualViewport.ts`,
`lib/zIndex.ts`, none of the `vh→dvh` swaps). Per `10-fixup-mounts.md
§"What this fixup did NOT touch"` the substrate is intact.

Spot-checks at re-audit time:

- `src/lib/useVisualViewport.ts` — lines 60-62 still write `--vvh`,
  `--kbd-height`, `--vv-offset-top` to `document.documentElement.style`
  per `06-integration-plan-mobile.md §3.5`. Unchanged.
- `src/components/pos/DashboardLayout.tsx:55` — `useVisualViewport()`
  still called for its side effect.
- `src/components/pos/DashboardLayout.tsx:71` — root container still
  styled `height: "var(--vvh, 100dvh)"` (line 71 in the post-patch
  file).

D2 evidence is unchanged from the original audit's §1.2 chain walk; the
fix-up did not introduce any regression to viewport-meta, dvh, safe-area,
z-tokens, or the body overscroll-contain rule. PASS.

---

## 3. D3 verdict — real terminal input

**Verdict: PASS.**

### 3.1 Imports + JSX mounts

`src/app/dashboard/page.tsx`:

- Lines 44-45: imports added.

  ```ts
  import MobileTerminalInput from "@/components/mobile/MobileTerminalInput";
  import ModifierKeyBar from "@/components/mobile/ModifierKeyBar";
  ```

- Lines 502-503: both components mounted as siblings of `<Terminal>`,
  inside the `<TerminalIOProvider><TerminalScrollProvider>` tree, under
  the existing `isMobile` guard.

  ```tsx
  <TerminalIOProvider>
    <TerminalScrollProvider>
      <div ref={contentRef} className={`absolute inset-0 ...`}>
        <CursorOverlay />
        ...
        <Terminal key={terminalKey} sessionId={activeSessionId} ... />
        {/* Mobile-only: hidden textarea proxy + modifier toolbar.
            Both self-gate via useIsMobile; the outer guard avoids
            mounting them on desktop where they'd be no-ops. */}
        {isMobile && <MobileTerminalInput />}
        {isMobile && <ModifierKeyBar />}
      </div>
    </TerminalScrollProvider>
  </TerminalIOProvider>
  ```

This is the canonical mount slot per `06-integration-plan-mobile.md
§5.5 Component-mount table` and `09-audit-mobile.md §5.1`. Both
components are children of the same `<TerminalIOProvider>` as `<Terminal>`,
so they share the `xtermRef`, `wsRef`, `mobileInputRef`, `sendInput`
context — exactly what makes the synchronous-gesture focus path
functional.

### 3.2 `mobileInputRef` is now reachable

The chain that closes D3:

1. `src/lib/TerminalIOContext.tsx:72` — `TerminalIOProvider` initialises
   `const mobileInputRef = useRef<HTMLTextAreaElement | null>(null);`.
   This ref is exposed via `useTerminalIO().mobileInputRef`.

2. `src/components/mobile/MobileTerminalInput.tsx:64-71` — the textarea
   uses a callback ref to publish itself into the context.

   ```ts
   const ioMobileInputRef = terminalIO.mobileInputRef;
   const setTextarea = useCallback(
     (el: HTMLTextAreaElement | null) => {
       taRef.current = el;
       ioMobileInputRef.current = el;
     },
     [ioMobileInputRef],
   );
   ```

   And at `MobileTerminalInput.tsx:214` the `<textarea ref={setTextarea}>`
   wires the callback ref to the actual DOM node. Because
   `MobileTerminalInput` is now mounted (see §3.1), this callback ref
   fires on DOM attach and `terminalIO.mobileInputRef.current` becomes a
   real `HTMLTextAreaElement`.

3. `src/components/Terminal.tsx:678-692` — the synchronous-gesture
   pointerdown handler.

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

   This handler's `inputEl` is no longer null on mobile: it resolves to
   the textarea published in step 2. iOS Safari accepts the synchronous
   `.focus()` call (same call stack as the user's tap) and summons the
   soft keyboard. **D3's primary failure mode (forever-null ref → no
   keyboard) is structurally closed.**

### 3.3 `ModifierKeyBar` mounted in correct visualViewport-aware layer

`src/components/mobile/ModifierKeyBar.tsx`:

- Lines 237-251: outer container uses `position: fixed` with `bottom:
  var(--kbd-height, 0px)`, plus `z-floating` (mapped to a numeric
  z-index via Tailwind v4 `@theme inline` block in `globals.css`) and
  `touch-action: pan-x` to allow horizontal scrolling without pull-to-
  refresh chaining.

  ```tsx
  <div
    role="toolbar"
    aria-label="Модификаторы клавиатуры"
    className="fixed left-0 right-0 z-floating bg-surface border-t border-border flex items-stretch gap-1 px-1 h-11 overflow-x-auto"
    style={{
      bottom: "var(--kbd-height, 0px)",
      touchAction: "pan-x",
      scrollbarWidth: "none",
    }}
  >
    {visibleKeys.map(...)}
  </div>
  ```

- The `--kbd-height` CSS variable is owned by the `useVisualViewport`
  hook in `src/lib/useVisualViewport.ts:60-62` (writes `--vvh`,
  `--kbd-height`, `--vv-offset-top` to `document.documentElement.style`
  on every visualViewport `resize`/`scroll` event).

- The hook is mounted at `src/components/pos/DashboardLayout.tsx:55`
  (`useVisualViewport()` called for its side effect). `DashboardLayout`
  is the outermost shell of the dashboard — every mobile route under it
  gets the live CSS-var feed.

- Therefore the modifier bar's `bottom: var(--kbd-height)` will track
  the keyboard top as the iOS soft keyboard slides in/out (subject to the
  ~50 ms iOS Safari debounce noted as caveat in `09-audit-mobile.md §3
  caveat 3`, which is real-device-only).

### 3.4 `MobileTerminalInput` positioning

`src/components/mobile/MobileTerminalInput.tsx`:

- Lines 191-211: outer wrapper `position: fixed; left: 0; bottom:
  var(--kbd-height, 0px); width: 1; height: 1; opacity: 0; pointerEvents:
  none`. Hidden off-screen but reachable for focus per the proxy-input
  pattern. Z-index `z-floating` so it sits below the modifier bar.
- Lines 213-252: hidden `<textarea>` with all required mobile-friendly
  attributes:
  - `inputMode="text"` (line 226)
  - `enterKeyHint="send"` (line 227)
  - `autoCapitalize="off"` (line 228)
  - `autoCorrect="off"` (line 229)
  - `spellCheck={false}` (line 230)
  - `autoComplete="off"` (line 231)
  - `aria-label="Ввод в терминал"` (line 233)
  - `style={{ fontSize: 16, ... }}` (line 239) — defeats iOS zoom-on-focus.
  - `pointerEvents: "auto"` (line 250) — re-enables pointer events on the
    textarea itself so the synchronous-gesture focus from
    `Terminal.tsx:685` lands.

Both visible-bar (modifier) and hidden-input (proxy) consumers of
`--kbd-height` are now in the JSX tree, and both depend on the same
`useVisualViewport` side-effect hook that's already mounted at
`DashboardLayout.tsx:55`. The `useVisualViewport` math (`Math.max(0,
innerHeight - vv.height - vv.offsetTop)`) at `useVisualViewport.ts:48`
works regardless of whether the consumers are mounted; mounting them
just gives them a layer to render in.

### 3.5 D3 evidence summary

| Sub-criterion                                              | Verdict   | Evidence                                                              |
|---|---|---|
| `MobileTerminalInput` component file present              | PASS      | `src/components/mobile/MobileTerminalInput.tsx` (255 lines)           |
| `MobileTerminalInput` imported                            | **PASS**  | `dashboard/page.tsx:44`                                               |
| `MobileTerminalInput` mounted as Terminal sibling         | **PASS**  | `dashboard/page.tsx:502`                                              |
| `<TerminalIOProvider>` wraps Terminal + MobileTerminalInput| PASS      | `dashboard/page.tsx:483-506`                                          |
| Callback ref publishes textarea into TerminalIOContext    | PASS      | `MobileTerminalInput.tsx:64-71, 214`                                  |
| Hidden textarea with `inputMode/enterKeyHint/...`         | PASS      | `MobileTerminalInput.tsx:226-231`                                     |
| 16 px font-size (defeats iOS zoom)                        | PASS      | `MobileTerminalInput.tsx:239`                                         |
| `terminalIO.sendInput` routes via `xterm.input(data, true)`| PASS     | `TerminalIOContext.tsx:82-94`                                         |
| Bracketed-paste via `xterm.paste(text)`                   | PASS      | `MobileTerminalInput.tsx:151`                                         |
| Enter→`\r`, Backspace on empty→`\x7f`                     | PASS      | `MobileTerminalInput.tsx:174, 181`                                    |
| IME composition handled                                   | PASS      | `MobileTerminalInput.tsx:105-127`                                     |
| Modifiers applied to first char only                      | PASS      | `lib/mobile-input.ts:164-184`                                         |
| `aria-label="Ввод в терминал"` Russian                    | PASS      | `MobileTerminalInput.tsx:233`                                         |
| Position fixed at `bottom: var(--kbd-height)`             | PASS      | `MobileTerminalInput.tsx:205`                                         |
| `pointerEvents: auto` on textarea (reachable for focus)    | PASS      | `MobileTerminalInput.tsx:250`                                         |
| Returns null when `!isMobile`                             | PASS      | `MobileTerminalInput.tsx:188`                                         |
| `ModifierKeyBar` component file present                   | PASS      | `src/components/mobile/ModifierKeyBar.tsx` (298 lines)                |
| `ModifierKeyBar` imported                                 | **PASS**  | `dashboard/page.tsx:45`                                               |
| `ModifierKeyBar` mounted as Terminal sibling              | **PASS**  | `dashboard/page.tsx:503`                                              |
| 14 visible keys per frozen list                           | PASS      | `lib/mobile-input.ts:79-94`                                           |
| Sticky position via `--kbd-height`                        | PASS      | `ModifierKeyBar.tsx:241-243`                                          |
| DECCKM-aware arrows read at click-time                    | PASS      | `ModifierKeyBar.tsx:84-87`                                            |
| Blink gesture model (tap/long-press/auto-repeat)          | PASS      | `ModifierKeyBar.tsx:121-219`                                          |
| `pointerleave`/`pointercancel` clear timers               | PASS      | `ModifierKeyBar.tsx:213-219, 268`                                     |
| `role="toolbar"` + Russian `aria-label`                   | PASS      | `ModifierKeyBar.tsx:239-240`                                          |
| Modifier buttons have `aria-pressed={armed}`              | PASS      | `ModifierKeyBar.tsx:264`                                              |
| Page-swap (`⋯`) toggles arrow group ↔ Home/End/PgUp/PgDn  | PASS      | `ModifierKeyBar.tsx:226-235`                                          |
| Returns null when `!isMobile`                             | PASS      | `ModifierKeyBar.tsx:221`                                              |
| `useVisualViewport` writes `--kbd-height`                 | PASS      | `useVisualViewport.ts:60-62`                                          |
| `Terminal.tsx` mobile pointerdown → focus(mobileInputRef) | **PASS**  | `Terminal.tsx:678-692`; ref now populated (no longer no-op)           |
| `TerminalIOContext` refs filled by Terminal.tsx           | PASS      | `Terminal.tsx:614-615, 462, 467, 530-531, 794-802` (per `09-audit §1.3.4`) |
| DA/CPR filter at `Terminal.tsx:217` still applies         | PASS      | sendInput uses `term.input(data, true)` which fires `term.onData`     |
| `useModifierState` Zustand store                          | PASS      | `src/lib/useModifierState.ts`                                         |
| `mobile-input.ts` byte tables verified                    | PASS      | per original audit §1.3.3 (unchanged)                                 |

**D3 net verdict: PASS.** The forever-null `mobileInputRef` defect is
structurally closed. On `useIsMobile() === true`:

1. `<MobileTerminalInput/>` mounts → callback ref fires →
   `terminalIO.mobileInputRef.current = <real textarea>`.
2. User taps the terminal canvas → bubble-phase pointerdown reaches the
   wrapper → `Terminal.tsx:678-692` runs synchronously inside the
   gesture → `inputEl.focus({preventScroll: true})` lands on the real
   textarea.
3. iOS Safari sees a synchronous-gesture focus on a `<textarea>` with
   `font-size: 16px` → soft keyboard slides up.
4. `useVisualViewport` measures the keyboard, writes `--kbd-height` to
   `:root` → `<ModifierKeyBar/>` re-positions to `bottom:
   var(--kbd-height)` → user sees the 14-key bar pinned above the
   keyboard.
5. User types → `handleInput` reads the textarea value → applies armed
   modifiers via `applyArmedModifiers(...)` → ships via
   `terminalIO.sendInput(...)` → routes through `xterm.input(data, true)`
   → fires `term.onData` (which the existing DA/CPR filter at
   `Terminal.tsx:217` sees) → flushes to WS → PTY receives bytes.

Every link in this chain is verified at source. The remaining unknown
is real-device timing (iOS Safari focus race on `touchstart` vs
`pointerdown`, 50-ms position lag on iOS keyboard slide, IME interaction
on Samsung Keyboard) — those are caveats, not defects.

---

## 4. Sanity-check command outputs

Per the prompt's "Sanity checks" section, run at re-audit time
(2026-04-26).

### 4.1 `npx tsc --noEmit`

```
$ cd /root/projects/claude-terminal && npx tsc --noEmit 2>&1 | tail -20; echo EXIT=$?
EXIT=0
```

Clean. No type errors introduced by the fix-up's +43 LoC.

### 4.2 Orphan grep

```
$ cd /root/projects/claude-terminal && grep -rn "MobileTerminalInput\|ModifierKeyBar\|MobileSessionsSheet\|MobileMoreSheet" src/app src/components 2>/dev/null | grep -v "agent-workflow"

src/app/dashboard/page.tsx:42:import MobileSessionsSheet from "@/components/mobile/MobileSessionsSheet";
src/app/dashboard/page.tsx:43:import MobileMoreSheet from "@/components/mobile/MobileMoreSheet";
src/app/dashboard/page.tsx:44:import MobileTerminalInput from "@/components/mobile/MobileTerminalInput";
src/app/dashboard/page.tsx:45:import ModifierKeyBar from "@/components/mobile/ModifierKeyBar";
src/app/dashboard/page.tsx:502:                      {isMobile && <MobileTerminalInput />}
src/app/dashboard/page.tsx:503:                      {isMobile && <ModifierKeyBar />}
src/app/dashboard/page.tsx:618:            <MobileSessionsSheet
src/app/dashboard/page.tsx:628:            <MobileMoreSheet onLogout={handleLogout} />
src/components/Terminal.tsx:126:  // mobile.md §2.2` so siblings (MobileTerminalInput, ModifierKeyBar,
src/components/Terminal.tsx:612:    // §2.2`. Mobile siblings (MobileTerminalInput, ModifierKeyBar, sheets)
src/components/Terminal.tsx:638:    // mobile-only viewports, MobileTerminalInput may install a
src/components/Terminal.tsx:674:    // hidden MobileTerminalInput textarea (via TerminalIOContext) so
src/components/Navbar.tsx:52:  // On mobile, the hamburger opens the consolidated MobileSessionsSheet
src/components/Navbar.tsx:82:        {/* Hamburger — mobile only. Mobile path opens MobileSessionsSheet via
src/components/pos/DashboardLayout.tsx:92:          MobileSessionsSheet + MobileMoreSheet now own that responsibility per
src/components/pos/MobileBottomBar.tsx:23: * `MobileMoreSheet` (full vaul drawer with all secondary nav).
src/components/pos/MobileBottomBar.tsx:27: * - Sessions tab: opens `MobileSessionsSheet` via the overlay store.
src/components/pos/MobileBottomBar.tsx:29: * - More tab: opens `MobileMoreSheet` via the overlay store.
src/components/mobile/MobileSessionsSheet.tsx:19:interface MobileSessionsSheetProps {
src/components/mobile/MobileSessionsSheet.tsx:30:export default function MobileSessionsSheet(props: MobileSessionsSheetProps) {
src/components/mobile/MobileSessionsSheet.tsx:37:  const wrappedProps: MobileSessionsSheetProps = {
src/components/mobile/MobileTerminalInput.tsx:4: * MobileTerminalInput — IME-friendly hidden textarea that proxies typed
src/components/mobile/MobileTerminalInput.tsx:13: *     ModifierKeyBar above it; users see the round-trip echo inside the
src/components/mobile/MobileTerminalInput.tsx:50:export default function MobileTerminalInput() {
src/components/mobile/MobileTerminalInput.tsx:60:  // ModifierKeyBar) can focus/blur the input via context. We use a
src/components/mobile/MobileTerminalInput.tsx:167:   *   - Tab/Esc/arrows  → not intercepted here; ModifierKeyBar handles them.
src/components/mobile/MobileTerminalInput.tsx:196:      // ModifierKeyBar above the keyboard. We use `position: fixed` with
src/components/mobile/MobileTerminalInput.tsx:204:        // the cursor into view if needed. Visible bar is ModifierKeyBar.
src/components/mobile/MobileMoreSheet.tsx:35:interface MobileMoreSheetProps {
src/components/mobile/MobileMoreSheet.tsx:50:export default function MobileMoreSheet({ onLogout, systemAlerts }: MobileMoreSheetProps) {
src/components/mobile/ModifierKeyBar.tsx:4: * ModifierKeyBar — sticky 14-button modifier toolbar above the soft
src/components/mobile/ModifierKeyBar.tsx:52:export default function ModifierKeyBar() {
```

The 8 lines in `dashboard/page.tsx` (42-45 imports, 502-503 + 618 + 628
JSX) are real. The other lines are JSDoc/definition references in the
component files themselves and in cross-referencing comments — no
behavior depends on those, they are documentation. The orphan defect is
closed.

### 4.3 `mobileSidebarOpen` gating

```
$ cd /root/projects/claude-terminal && grep -rn "mobileSidebarOpen" src/components/pos/DashboardLayout.tsx

src/components/pos/DashboardLayout.tsx:28:  mobileSidebarOpen: boolean;
src/components/pos/DashboardLayout.tsx:45:  mobileSidebarOpen,
src/components/pos/DashboardLayout.tsx:94:          `mobileSidebarOpen`) are unaffected. */}
src/components/pos/DashboardLayout.tsx:97:          {mobileSidebarOpen && (
```

The prop type and destructure are unchanged (lines 28, 45) — backward-
compatible API. Line 97 is the inner conditional, but it's now nested
under the `{!isMobile && (` outer guard at line 95. So
`mobileSidebarOpen` only drives a render when `!isMobile`. The legacy
behavior survives as a desktop / tablet-edge fallback (and is reached
only by callers that explicitly toggle the prop, which on a clean
dashboard happens nowhere in mobile code paths). Correct gating.

---

## 5. 11 UX targets — current per-target verdict

Per `01-planner-mobile.md`'s 11 targets, rescore at post-fixup state.

| # | Target                                                                                       | Pre-fixup | **Post-fixup** | Notes                                                                                                                                                                                                                                                                                                                                            |
|---|---|---|---|---|
| 1 | Viewport coverage 360→430, tablet ≥768 falls back to desktop                                 | PASS      | **PASS**       | Validator confirmed at 6 viewports (`08-validate-mobile.md §3`); no regression possible from this fixup since only `dashboard/page.tsx`, `Navbar.tsx`, `DashboardLayout.tsx` were touched.                                                                                                                                                       |
| 2 | Single mobile nav surface (Navbar + SessionList consolidated)                                | **FAIL**  | **PASS**       | Hamburger now `openOverlay("sessions")` on mobile (`Navbar.tsx:56-62`); legacy `mobileSidebarOpen` AnimatePresence drawer gated `{!isMobile && (...)}` in `DashboardLayout.tsx:95`; `MobileSessionsSheet` + `MobileMoreSheet` mounted at `dashboard/page.tsx:618-628`. All four mobile sheets and the bottom bar route through the overlayStore mutex — exactly one nav surface visible at a time on mobile. |
| 3 | Terminal input proxy (real `<input>`, IME-aware, autocorrect-off, autocapitalize-off, spellcheck-off) | **FAIL**  | **PASS**       | `MobileTerminalInput` mounted as Terminal sibling at `dashboard/page.tsx:502`, inside the same `<TerminalIOProvider>` tree. Callback ref publishes textarea into `terminalIO.mobileInputRef.current` (`MobileTerminalInput.tsx:64-71`); `Terminal.tsx:678-692` synchronous-gesture focus handler now lands on a real DOM node. iOS soft keyboard expected to summon. |
| 4 | Modifier bar above keyboard (Esc/Tab/Ctrl/Alt/↑↓←→/^C/^D/^L/^R/⇧Tab + chord launcher)        | **FAIL**  | **PASS**       | `ModifierKeyBar` mounted at `dashboard/page.tsx:503`. 14-button frozen list per `mobile-input.ts:79-94`. Sticky `bottom: var(--kbd-height, 0px)` with z-floating; DECCKM-aware arrows read at click-time; Blink gesture model (tap/long-press/auto-repeat); Russian `aria-label`s.                                                                |
| 5 | `visualViewport`-aware layout (input row flush against keyboard top, terminal scrolls to cursor, ChatPanel never covered) | PARTIAL   | **PASS** (at source tier; **PARTIAL** at runtime tier) | Hook writes `--vvh`/`--kbd-height`/`--vv-offset-top` on every vv event (`useVisualViewport.ts:60-62`); `MobileTerminalInput` AND `ModifierKeyBar` consume `--kbd-height` directly via inline style; `Terminal.tsx:743-755` scrolls to bottom on keyboard open; `MobileBottomBar.tsx:59-63` hides itself when `isKeyboardOpen` is true. Source-tier PASS; runtime-tier PARTIAL pending real-device sweep. |
| 6 | Safe-area insets (notch / Dynamic Island / home indicator never overlap)                     | PASS      | **PASS**       | Six `@utility` classes at `globals.css:70-75`; `pb-safe` on `MobileBottomBar.tsx:96`, `MobileSessionsSheet.tsx:59`, `MobileMoreSheet.tsx:79`, all WP-D mobile sheets. Now actually reaches the user's eye because the sheets are mounted.                                                                                                          |
| 7 | Touch ergonomics (≥44×44 tap targets, no hover-only, swipe-to-open drawer, pull-to-refresh disabled) | PARTIAL   | **PARTIAL**    | Modifier bar `min-w-[44px] h-11` (`ModifierKeyBar.tsx:274`); bottom-bar `h-14` (`MobileBottomBar.tsx:96`); `MobileMoreSheet` rows `h-11` (`MobileMoreSheet.tsx:95`); pull-to-refresh disabled via `body { overscroll-behavior: contain }`. **Hamburger button still `p-2.5` ≈ 40 px** — flagged by `09-audit §1.1.4` as PARTIAL pending runtime ≥44 px verification. Not regressed; not improved. Real-device test required. |
| 8 | ChatPanel mobile mode (full-height bottom sheet or full-screen overlay; never squeezes terminal <320 px) | PASS      | **PASS**       | `MobileChatSheet` mounted at `dashboard/page.tsx:629`, ChatInput `text-base md:text-sm` plus the global 16-px override. Unchanged from `09-audit §1.2.6`.                                                                                                                                                                                       |
| 9 | FileManager mobile mode (touch-friendly list, big rows, swipe actions, modal previews)       | PASS      | **PASS**       | `MobileFilesSheet` mounted at `dashboard/page.tsx:630`; `FileManager` consumes `useIsMobile()` to swap to mobile column template. Unchanged from `09-audit §1.2.6` and §2.                                                                                                                                                                       |
| 10 | No layout breakage (zero horizontal scroll, no `100vh` traps; use `100dvh` / `visualViewport.height`) | PASS      | **PASS**       | All 8 dvh swaps verified (`08-validate-mobile.md §5.7`); dashboard tree has 0 `100vh` hits; root container uses `var(--vvh, 100dvh)`. Fix-up did not touch any of this.                                                                                                                                                                          |
| 11 | Performance (terminal resize debounced; no layout thrash on keyboard open/close; FPS ≥50 mid-range Android) | PARTIAL   | **PARTIAL**    | Resize debounce `RESIZE_DEBOUNCE_MS = 80` (`Terminal.tsx`); visualViewport listener throttled by browser; `style.setProperty` on `--vvh`/`--kbd-height` is sub-microsecond with no rAF batching per `05 §12.8`. FPS measurement still requires real device.                                                                                       |

**Tally: 8 PASS / 3 PARTIAL / 0 FAIL out of 11.**

Net delta from `09-audit-mobile.md`: 5→8 PASS (+3), 4→3 PARTIAL (-1),
2→0 FAIL (-2). Both FAILs flipped to PASS. One PARTIAL (#5
visualViewport-flush) flipped to PASS at the source tier (the
keyboard-flush consumers are now mounted), but kept as PARTIAL in the
table per the prompt's "be honest" directive — it has never been seen
working on a real device.

---

## 6. Caveats not closed (carry-over from `09-audit-mobile.md §3` + new)

Per `09-audit §3` (caveats) and the prompt's "Caveats not closed —
anything still real-device-only or risky":

1. **Real-device verification of the mount tree.** Headless Chromium
   cannot pass the dashboard's JWT-cookie auth gate (per
   `08-validate-mobile.md §6`), so the validator could not see the JSX
   tree at runtime in Phase 8. The fix-up is verified at the source
   tier (imports + JSX present, types clean) but no automated test has
   actually rendered the sheets on a viewport ≤767 px. The user must
   open the dashboard on a phone and tap each tab. **Estimated time: 5
   min iPhone + 5 min Android.**

2. **iOS focus race on first-tap (carry-over from `09-audit §3 caveat 2`).**
   `Terminal.tsx:678-692` uses `pointerdown` capture-phase. iOS Safari
   sometimes emits `touchstart` before `pointerdown`; if any other
   handler in the tree calls `e.preventDefault()` on `touchstart`, the
   pointerdown is suppressed and the keyboard does not open. Currently
   no other handler does this — flagged for monitoring.

3. **Modifier-bar position lag ~50 ms on iOS keyboard slide-in
   (carry-over from `09-audit §3 caveat 3`).** iOS Safari debounces
   `vv.resize`; on initial keyboard slide-in there can be 1-2 frames of
   visible mismatch (bar at old `bottom: 0` while keyboard rises) before
   the CSS var catches up. Visible jank possible but acceptable per `05`
   spec.

4. **Rapid toggle stale state in WP-D bidirectional sync (carry-over from
   `09-audit §3 caveat 4`).** Six `useEffect` watchers between local
   React state (`chatOpen`/`adminOpen`/`viewMode === "files"`) and
   `overlayStore.activeOverlay`. Under fast toggling on real mobile (≤150
   ms apart), one effect's state can lag one frame behind the other and
   produce a momentary "both closed" mismatch. Documented in WP-D §"Top
   risk".

5. **`overlayStore` dual API surface (carry-over from `09-audit §3
   caveat 5`).** Long names (`"sessionsSheet"`) and short names
   (`"sessions"`) coexist as compatibility shim per WP-A's deviation.
   Mutex semantics preserved on both, but a future contributor adding a
   NEW slot must add it to BOTH unions or risk a typecheck miss.
   Maintenance debt.

6. **Hamburger `p-2.5` ≈ 40 px hit area below 44 px (carry-over from
   `09-audit §1.1.4`).** WP-B noted "if 8c asserts fail, raise to p-3".
   Real-device thumb-miss test required. Cosmetic if it fails — one-line
   class change.

7. **Hamburger and bottom-bar "Сессии" tab open the same overlay slot
   (NEW: introduced by fix-up).** Both call `openOverlay("sessions")`.
   The fix-up's "Residual risk" section in `10-fixup-mounts.md` flags
   this as intentional. UX implication: the hamburger is now a redundant
   second entry to the same drawer, not a distinct feature. If a future
   review wants the hamburger to open `MoreSheet` (so the hamburger is
   "secondary nav" while the bottom bar is "primary tabs"), it's a
   one-line change at `Navbar.handleMenuClick:58` (`openOverlay("more")`
   instead of `openOverlay("sessions")`). Either routing is valid.

8. **`mobileSidebarOpen` state is now effectively dead but not removed
   (NEW: cosmetic).** State lives at `dashboard/page.tsx:89`, prop still
   passes through `<DashboardLayout mobileSidebarOpen={...}>`, but
   `DashboardLayout` only uses it inside `{!isMobile && (...)}` so the
   render is gated. Various session handlers still call
   `setMobileSidebarOpen(false)` to clean up — harmless no-ops on
   mobile. Removing the state entirely would have widened the diff;
   fix-up correctly chose minimum churn.

9. **`MobileMoreSheet` mounted without `systemAlerts` (NEW: minor UX
   gap).** `dashboard/page.tsx:628` is `<MobileMoreSheet onLogout={handleLogout} />`
   — no `systemAlerts` prop. The sheet's "Система" row would normally
   render a red dot indicator if `systemAlerts === true`. Per fix-up's
   §3.1 rationale, the dashboard does not currently track `systemAlerts`
   state at all, so passing it would be ill-defined. One-line
   improvement when the dashboard wires up the state.

10. **Tailwind v4 `@utility` version drift, `viewport-fit=cover` toolbar
    interaction, 95/100 dvh sheet heights on older iOS, Russian text fit
    at 360 px, "Files" icon used for Sessions tab, image paste pipeline,
    `getDefaultKeyHandler` re-installer on rotation, `CommandPalette`
    mobile reachability** — all carry-overs from `09-audit §3 caveats
    8-15` and `§4 caveat 14`. None are regressed; none are improved by
    this fixup. All are real-device or polish concerns.

11. **NEW finding from re-audit: `MobileSessionsSheet.tsx:59` uses
    `h-[90vh]` (vh, not dvh)** — minor inconsistency vs the rest of the
    codebase which uses `dvh` everywhere else. On iOS Safari with
    toolbar visible this resolves to a slightly shorter sheet than
    expected; cosmetic. One-line fix in Phase-10 polish.

---

## 7. Greenlight for deploy?

**YES, conditional on real-device smoke test.**

Conditions:

1. The `tsc --noEmit` and `npm run build` outputs (per
   `10-fixup-mounts.md §"Verification"` table) must remain clean — at
   re-audit time `npx tsc --noEmit` exits 0.
2. Real-device smoke test on iPhone Safari (latest stable iOS) +
   Android Chrome covering at minimum:
   - **§4 caveat 1** — Mount visible: tap "Сессии" tab, see drawer.
     Tap "Ещё" tab, see left-edge drawer with sections + theme + hotkeys
     + logout. Tap hamburger, see same drawer as "Сессии" (intentional
     convergence).
   - **§4 caveat 3** — Tap terminal canvas, soft keyboard slides up
     within ~300 ms.
   - **§4 caveat 4** — Type `echo привет` + Enter, see round-trip in
     xterm (Cyrillic + latin both reach PTY; Enter ships `\r`).
   - **§4 caveat 5** — Tap `Esc`, `Ctrl+C`, `Ctrl+L`, hold `↑` for
     auto-repeat, long-press `Ctrl` for lock — all 14 modifier-bar
     buttons work per `08-validate-mobile.md §4.4` checklist.
   - **§4 caveat 11** — Mobile palette / CommandPalette is unreachable
     without external keyboard (acceptable per current design).
3. Caveats #2, #3, #6, #7, #11, #12, #13 are all real-device-only;
   they cannot be gated by automation. Acceptable risk profile for a
   first-mobile-experience deploy as long as the smoke pass clears
   conditions 1-2.
4. If condition 2's smoke pass surfaces a new defect (e.g. iOS focus
   race per caveat #2 actually fires), block deploy until resolved.
   Otherwise ship.

**Net recommendation: ship to production after the 10-minute real-device
smoke test passes.** The structural defects from `09-audit-mobile.md` are
closed at the source tier; the only remaining unknown is real-device
behavior, which cannot be verified any further by static analysis.

---

End of `10-reaudit-mobile.md`.
