# 10 — Fixup: mount orphan mobile components & retire legacy drawer

Closes the structural integration gap reported in `09-audit-mobile.md`
(D1 + D3 FAIL). Surgical patch — three files, +43 LoC net.

## Goal

Make the four mobile components that were already implemented in
`src/components/mobile/` (`MobileTerminalInput`, `ModifierKeyBar`,
`MobileSessionsSheet`, `MobileMoreSheet`) actually appear in the JSX
tree, retire the conflicting legacy mobile slide-in drawer, and re-wire
the hamburger so it opens the new mobile sessions sheet on phones.

Per `09-audit-mobile.md §5.3 Option A` (the minimum-churn variant) plus
the prompt's directive that the hamburger should open
`overlayStore.openOverlay("sessions")` (not `"more"`). The semantic
match: the legacy drawer used to render `IconRail + SidePanel`, which is
the sessions list; the new mobile equivalent is `MobileSessionsSheet`.

## Files modified (3, +43 LoC net)

| File | Δ lines | Why |
|---|---:|---|
| `src/app/dashboard/page.tsx` | +19 | Import + mount the 4 orphan components |
| `src/components/Navbar.tsx` | +17 | Wire hamburger → `openOverlay("sessions")` on mobile |
| `src/components/pos/DashboardLayout.tsx` | +7 | Gate legacy `mobileSidebarOpen` AnimatePresence behind `!isMobile` |

## Changes in detail

### 1. `src/app/dashboard/page.tsx`

Added imports for the four orphans next to the existing
`MobileChatSheet` / `MobileFilesSheet` / `MobileAdminSheet` imports
(WP-D mounting pattern).

Mounted `<MobileTerminalInput/>` and `<ModifierKeyBar/>` as siblings of
`<Terminal>` inside the existing `<TerminalIOProvider><TerminalScrollProvider>`
tree (under the `isMobile` guard). This is the JSX tree where
`mobileInputRef` gets attached — the existing `Terminal.tsx:678-692`
pointerdown handler will now find a real DOM node and the soft keyboard
will pop on iOS.

Mounted `<MobileSessionsSheet/>` and `<MobileMoreSheet/>` in the existing
mobile-overlays block (next to `MobileChatSheet/Files/Admin`), passing
through the same handlers the desktop `SidePanel` already uses
(`onSelectSession`, `onSessionDeleted`, `onNewSession`, etc.).

`<MobileMoreSheet/>` receives `onLogout={handleLogout}`. Did NOT pass
`systemAlerts` because the dashboard does not currently track that state
(it's an optional prop and the audit confirms it's only used for the
red dot indicator).

### 2. `src/components/Navbar.tsx`

Added `useIsMobile` + `useOverlayStore` imports. Added a
`handleMenuClick` wrapper that:
- on mobile → calls `openOverlay("sessions")`
- on desktop → falls through to the legacy `onMenuClick` prop (preserves
  any tablet/edge breakpoint that hits `md:hidden`)

The hamburger button now always renders on mobile (we no longer require
the prop), so even if a future caller forgets to pass `onMenuClick`, the
mobile sessions sheet stays reachable.

### 3. `src/components/pos/DashboardLayout.tsx`

Added `useIsMobile` import. Wrapped the existing
`<AnimatePresence>{mobileSidebarOpen && ...}</AnimatePresence>` block
(legacy `IconRail + SidePanel` slide-in) in an outer `{!isMobile && ...}`
guard. Mobile no longer renders the duplicate nav surface — the
`MobileBottomBar` plus the new `MobileSessionsSheet` / `MobileMoreSheet`
own that responsibility now. Desktop tablet/edge breakpoints (which can
still hit `md:hidden` if width < 768) keep the legacy behavior, but in
practice that branch is dead since `useIsMobile()` triggers at the same
breakpoint.

The `mobileSidebarOpen` state stays in `dashboard/page.tsx` (not removed)
because various session handlers still call `setMobileSidebarOpen(false)`
to clean up after session select / new-session — those are no-ops on
mobile now, but harmless. Removing them would have widened the diff
without behavioral benefit.

## Verification

| Check | Result |
|---|---|
| `npx tsc --noEmit` | EXIT=0 |
| `npm run build` | EXIT=0 |
| Static grep — orphans now imported | All 4 components appear in real JSX |

Static grep result (consumers outside each component's own file):

```
src/app/dashboard/page.tsx:42:import MobileSessionsSheet from "@/components/mobile/MobileSessionsSheet";
src/app/dashboard/page.tsx:43:import MobileMoreSheet from "@/components/mobile/MobileMoreSheet";
src/app/dashboard/page.tsx:44:import MobileTerminalInput from "@/components/mobile/MobileTerminalInput";
src/app/dashboard/page.tsx:45:import ModifierKeyBar from "@/components/mobile/ModifierKeyBar";
src/app/dashboard/page.tsx:502:                      {isMobile && <MobileTerminalInput />}
src/app/dashboard/page.tsx:503:                      {isMobile && <ModifierKeyBar />}
src/app/dashboard/page.tsx:618:            <MobileSessionsSheet
src/app/dashboard/page.tsx:628:            <MobileMoreSheet onLogout={handleLogout} />
```

## Expected behavioral change after deploy

- iOS Safari tap on terminal canvas → `MobileTerminalInput` textarea
  receives synchronous focus from the existing `Terminal.tsx:678-692`
  pointerdown handler → soft keyboard opens. (D3 closes.)
- `ModifierKeyBar` renders pinned to `bottom: var(--kbd-height, 0)` — the
  14-key modifier toolbar above the keyboard.
- Hamburger in top Navbar → opens `MobileSessionsSheet` (vaul drawer
  with the existing `SessionPanel` body).
- Bottom-bar "Сессии" tab → also opens `MobileSessionsSheet` (same slot,
  mutex-coordinated with chat / more / files / admin).
- Bottom-bar "Ещё" tab → opens `MobileMoreSheet` (vaul left-edge drawer
  with hub / config / skills / memory / symphony / system + theme +
  hotkeys + logout).
- Legacy `IconRail + SidePanel` slide-in no longer appears on mobile.
  (D1 closes.)

## What this fixup did NOT touch

- `agent-workflow/*` (read-only audit deliverables).
- `server.js`, `terminal-manager.js`, `tmux.conf`, all shell files.
- `app/layout.tsx`, `app/globals.css`.
- Any component in `src/components/mobile/*` — they were correct as
  shipped, just unmounted.
- All `lib/*` (overlayStore, useVisualViewport, zIndex, TerminalIOContext,
  mobile-input, useModifierState, useIsMobile).
- `Terminal.tsx` — its `mobileInputRef` consumption was already wired in
  Wave-2; the ref is now genuinely populated because
  `MobileTerminalInput` mounts and writes to
  `terminalIO.mobileInputRef.current` via its callback ref.

## Residual risk

`MobileSessionsSheet` and the bottom-bar "Сессии" tab both target the
same `"sessions"` overlay slot — they cooperate cleanly (mutex), and the
hamburger now does the same thing as the bottom-bar tab. If a future UX
review wants the hamburger to do something different from the bottom-bar
tab (e.g. open `MoreSheet` per the audit's §5.3 Option A suggestion), the
single-line change is in `Navbar.handleMenuClick`. Per the prompt's
explicit instruction the hamburger goes to `"sessions"`.

## Phase-8 retest expectation

D1 (consolidated mobile nav) and D3 (terminal input on mobile) should
flip from FAIL to PASS at the next real-device sweep. D2 was already
PASS. Open caveats from `09-audit-mobile.md §3` remain unchanged
(real-device verification of soft-keyboard timing on iPhone vs Android
is still needed).
