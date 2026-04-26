# Phase 7 — WP-A Implementation Changelog

> Agent: `impl-mobile-WP-A` (shell + scaffolding)
> Date: 2026-04-26
> Branch: `feat/tmux-streaming-and-mobile`
> Spec: `06-integration-plan-mobile.md` §3.1, §3.2, §3.3 (provider wrap only),
> §3.4, §3.5 (lines 49 & 53 only), §3.18, §3.19, §9.1.
> Decision: `05-decision-mobile.md` §2.6 (viewport meta), §2.7 (dvh strategy),
> §2.8 (safe-area), §2.9 (z-index tokens), §2.13 (mobile font-size).

---

## Summary

Lands the shell + scaffolding tier of the mobile overhaul: viewport metadata,
global CSS additions (z-index tokens, safe-area utilities, visualViewport
fallbacks, mobile font-size override), the `useVisualViewport()` hook, the
`TerminalIOContext` scaffold (refs only — Terminal.tsx wiring deferred to
combined Wave-2), the `overlayStore` Zustand mutex, and `vh→dvh` swaps
across modals + UI library + global-error.

Deps added: `zustand@^5.0.12` (plan §5 lists `^5.0.2`; npm resolved to a
compatible later patch). `vaul` is **NOT** added in this WP — the
integration plan §5 lists vaul as a dep, but `MobileBottomBar`/sheets are
WP-B/WP-D territory; I confirmed no WP-A-owned file imports vaul, so the
install is correctly deferred to those WPs.

---

## Files modified (10)

### `src/app/layout.tsx`

- Added `import type { Viewport } from "next"` to the existing type-only
  import.
- Added `export const viewport: Viewport = { ... }` after the existing
  `metadata` export — frozen string per `05 §2.6`. Emits the exact meta:
  `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">`
  plus `themeColor: "#000000"` for the iOS Safari status-bar tint.
- `user-scalable` intentionally NOT pinned per `05 §2.6` so users can
  pinch-zoom terminal output.
- No changes to `<html lang="ru" className="dark">` or the FOUC theme
  script — both preserved.

### `src/app/globals.css`

- Extended the existing `@theme inline { ... }` block with z-index CSS
  vars: `--z-base: 0`, `--z-content: 10`, `--z-sticky: 20`, `--z-sidebar: 30`,
  `--z-panel: 40`, `--z-floating: 50`, `--z-modal: 60`, `--z-popup: 100`,
  `--z-palette: 9000`, `--z-toast: 9500`, `--z-navbar: 5000`. Tailwind v4
  reads these and auto-generates `z-base` … `z-navbar` utility classes.
- Added Tailwind v4 `@utility` block right after `@theme inline`:
  `pt-safe`, `pb-safe`, `pl-safe`, `pr-safe`, `h-safe-bottom`,
  `min-h-safe-bottom` mapping to `env(safe-area-inset-*)` per `05 §2.8`.
- Augmented the `body` rule with `overscroll-behavior: contain` and
  `-webkit-tap-highlight-color: transparent` per `05 §2.7`.
- Added a second `:root { ... }` block (lines 196-200) with the
  `--vvh: 100dvh`, `--kbd-height: 0px`, `--vv-offset-top: 0px`
  fallbacks per `06 §3.2 step 6`. The browser merges these with the
  existing theme `:root` block; properties don't conflict.
- Added a `.terminal-host` utility class with `touch-action: manipulation`
  per `06 §3.2 step 4`.
- Added a `@media (max-width: 767px)` block forcing
  `font-size: 16px !important` on `<input>` (excluding checkbox/radio),
  `<textarea>`, `<select>` per `05 §2.13`.

### `src/app/dashboard/page.tsx`

- Added `import { TerminalIOProvider } from "@/lib/TerminalIOContext"`.
- Wrapped the existing `<TerminalScrollProvider>` with
  `<TerminalIOProvider>` at the terminal stage (around the original
  line 404 area) per `06 §3.3 step 2`. This is shell-only — overlay
  mounts (`MobileSessionsSheet`, `MobileChatSheet`, etc.) and the
  `<MobileTerminalInput>` mount itself remain WP-D's responsibility.

### `src/app/global-error.tsx`

- Inline `style={{ height: "100vh" }}` → `style={{ height: "100dvh" }}`
  per `06 §3.4`.

### `src/components/pos/DashboardLayout.tsx`

- Added `import { useVisualViewport } from "@/lib/useVisualViewport"`.
- Called `useVisualViewport()` inside `DashboardLayout` for the side
  effect of writing the `--vvh` / `--kbd-height` / `--vv-offset-top`
  CSS vars on every visualViewport event. Per `06 §3.5 WP-A` — return
  value not consumed in this file.
- Replaced the line-49 `<div className="flex h-screen bg-background">`
  with `<div className="flex bg-background" style={{ height: "var(--vvh, 100dvh)" }}>`
  inside the `fullscreen` short-circuit branch.
- Same replacement at the original line 53 (the non-fullscreen return).
- **Did NOT touch** the WP-B-owned mobile drawer block at lines 55-114.
  Three-way merge with WP-B is automatic per `06 §9.5`.

### `src/components/ProviderWizardModal.tsx`

- `max-h-[85vh]` → `max-h-[85dvh]` (the only modal-shell line) per
  `06 §3.18`.

### `src/components/symphony/CreateTaskModal.tsx`

- `max-h-[85vh]` → `max-h-[85dvh]` on the outer modal box per `06 §3.18`.

### `src/components/chat/ImageLightbox.tsx`

- `max-h-[90vh]` → `max-h-[90dvh]` on the `<img>` element per `06 §3.18`.
  Note: the `max-w-[90vw]` was kept as `vw` because viewport WIDTH does
  not have the iOS-keyboard collapse problem that `vh` does.

### `src/components/ui/aurora-background.tsx`

- Two `h-[100vh]` → `h-[100dvh]` swaps (retro branch line 25, default
  branch line 41) per `06 §3.19`.

### `src/components/ui/lamp.tsx`

- `min-h-screen` → `min-h-dvh` per `06 §3.19` (Tailwind v4 supports
  `min-h-dvh`).

### `src/lib/z-index.ts`

- Added two new keys per `05 §2.9`: `PALETTE: 9000` and `TOAST: 9500`.
- Updated the JSDoc layer order to mention the new keys and the new
  Tailwind utility classes generated from `globals.css`'s `@theme inline`
  block.
- Kept the file at its existing kebab-case name to avoid import churn
  per `06 §2.4` ("spec calls it `zIndex.ts` but we keep the existing
  kebab-case"). The new `src/lib/zIndex.ts` (below) is a re-export shim
  to satisfy the prompt's OWNED list literally.

---

## Files created (5)

### `src/lib/useVisualViewport.ts` — NEW

Per `06 §2.1` and the prompt. Exports
`useVisualViewport(): VisualViewportState` where `VisualViewportState`
is `{ height, offsetTop, isKeyboardOpen, keyboardHeight }`. SSR-safe via
`typeof window === "undefined"` guard. Side effect: writes
`--vvh`, `--kbd-height`, `--vv-offset-top` to `document.documentElement.style`
on every `visualViewport.resize` and `visualViewport.scroll` event (and a
fallback `window.resize` listener for very old Safari without
visualViewport). On unmount: removes listeners but **does not** clear the
CSS vars per `06 §2.1` ("other consumers may still need them").

### `src/lib/TerminalIOContext.tsx` — NEW (scaffold)

Per `06 §2.2`. Exports `TerminalIOContext`, `TerminalIOProvider`, and
`useTerminalIO()`. The provider holds four refs (xtermRef, wsRef,
terminalElementRef, mobileInputRef), an `isReady: boolean` state,
`setReady`, `sendInput(data)`, `requestResize(cols, rows)`. Lifecycle
ownership stays in `Terminal.tsx` — this file contains a `TODO: wire
from Terminal.tsx` comment block listing the four splice-points
(xterm init, WS open, WS close/err, container ref) for the Phase-2
implementer (combined Terminal overhaul).

`sendInput` routes via `xterm.input(data, true)` per
`02-scan-terminal.md §7.1 option (A)` so the existing `term.onData`
listener at `Terminal.tsx:213-221` (with its DA/CPR filter at line 217)
remains the sole WS ingress.

### `src/lib/overlayStore.ts` — NEW (Zustand)

Per `06 §2.3`. Frozen API per the integration plan: `setActiveOverlay(slot)`
+ `closeAll()` + `activeOverlay` (default `"none"`). Slot enum is the
canonical 11-member union from the plan (`"none"` | `"sessionsSheet"` |
`"chatSheet"` | `"filesSheet"` | `"adminSheet"` | `"moreDrawer"` |
`"hotkeysModal"` | `"commandPalette"` | `"providerWizard"` |
`"providerConfig"` | `"imageLightbox"`).

Plus a compatibility surface for the prompt's short-form names
(`"sessions"` | `"chat"` | `"files"` | `"admin"` | `"hotkeys"` | `"more"` |
`"palette"` | `"lightbox"`) and a pair of convenience verbs
(`openOverlay(name)` / `closeOverlay()`) — kept so existing
WP-D-authored files (`CommandPalette.tsx`, an early
`MobileSessionsSheet.tsx`) typecheck without forcing a same-PR refactor
of code outside this WP's owned list. Mutex semantics are preserved on
both API surfaces — opening any non-`"none"` slot auto-closes whatever
was previously open.

`useOverlay(slot)` selector returns `boolean` (reference-stable per
Zustand's Object.is short-circuit).

### `src/lib/zIndex.ts` — NEW (re-export shim)

Per the prompt's OWNED list which named `zIndex.ts`. The integration
plan §2.4 is explicit that the canonical file stays at the existing
kebab-case `z-index.ts` to avoid import churn — this file is a thin
`export { Z, type ZLayer } from "./z-index"` so new code can import
from `@/lib/zIndex` while older code keeps working.

---

## Deps added

| Dep | Version | Purpose |
|---|---|---|
| `zustand` | `^5.0.12` | Mutex overlay store (`overlayStore.ts`); per plan §5 |

`vaul` was NOT added — no WP-A-owned file imports it; WP-B / WP-D will
install it when they need bottom sheets.

---

## TypeScript validation

Ran with `NODE_ENV=development ./node_modules/.bin/tsc --noEmit` (after
explicitly installing devDependencies because the workspace had
`NODE_ENV=production` set in the shell). Errors after WP-A landed: 1, in
`src/components/pos/IconRail.tsx` (WP-B territory — a forgotten
`setActiveOverlay` reference in their early scaffold). **Zero errors in
any WP-A-owned file.**

---

## Deviations from spec

1. **`src/lib/zIndex.ts` vs existing `src/lib/z-index.ts`**: prompt
   listed `zIndex.ts` as a NEW OWNED file; plan §2.4 says keep the
   existing kebab-case. Resolved by doing both: updated the canonical
   `z-index.ts` (added `PALETTE`, `TOAST`) AND created `zIndex.ts` as a
   re-export shim. Either import path works and both pull from the same
   numeric values. **This is the one judgment call I had to make.**

2. **`overlayStore.ts` API drift across WPs**: when I first checked the
   workspace the WP-D-authored `CommandPalette.tsx` and an early
   `MobileSessionsSheet.tsx` consumed short slot names (`"palette"`,
   `"sessions"`) and `openOverlay/closeOverlay`, while
   `MobileBottomBar.tsx` / `MobileMoreSheet.tsx` / `IconRail.tsx` used
   the integration plan §2.3 long names (`"commandPalette"`,
   `"sessionsSheet"`, `setActiveOverlay`). Rather than break either
   group, I exposed both APIs from the same store with shared mutex
   state. Mutex semantics are unchanged. WP-D will collapse this back
   to a single API surface in their pass.

3. **`TerminalIOContext` location**: prompt's OWNED list places it at
   `src/lib/TerminalIOContext.tsx`; plan §2.2 puts it at
   `src/contexts/TerminalIOContext.tsx`. Followed prompt path (no
   `src/contexts/` directory exists yet). Same rationale for
   `overlayStore.ts` (prompt: `src/lib/`; plan §2.3: `src/stores/`).

4. **Provider wrap mount point**: plan §3.3 step 2 puts the
   `<TerminalIOProvider>` wrap at `dashboard/page.tsx` line 404 area —
   I located it inside the `viewMode !== "files"` branch wrapping
   `<TerminalScrollProvider>`. This matches the plan's frozen "outer →
   inner" mount order (`<TerminalIOProvider>` outer →
   `<TerminalScrollProvider>` inner) and keeps the provider out of the
   FileManager / Welcome / Skill / Memory / Symphony / System branches
   where there's no terminal to register against.

---

## Out-of-scope items deferred (verified)

- All `<MobileXxxSheet>` mounts in `dashboard/page.tsx` — WP-D.
- The `<MobileTerminalInput>` and `<ModifierKeyBar>` mounts and the
  Terminal.tsx ref-lifting code — combined Terminal Wave-2.
- The `<AnimatePresence>` slide-overs at lines 494-521 (chat/admin) —
  WP-D coordinates the bidirectional sync to `overlayStore`.
- Files-view mobile route (replacing lines 386-390) — WP-D.
- All `vh→dvh` swaps inside ChatPanel / FileManager / AdminPanel /
  HotkeysModal — WP-D.
- All Navbar / SessionPanel / IconRail / SidePanel / MobileBottomBar
  edits — WP-B.
- `vaul` install — WP-B / WP-D.

---

## Acceptance check (relative to WP-A's slice)

- Viewport meta exact string emitted via Next.js `viewport` Metadata
  export (verified by reading the file post-edit).
- All seven `vh→dvh` swaps completed (global-error, two aurora, lamp,
  ProviderWizard, CreateTask, ImageLightbox).
- DashboardLayout root height now sourced from `var(--vvh, 100dvh)`
  with the JS hook live in the same component.
- All eleven z-index tokens authored in `globals.css` `@theme inline`
  AND mirrored in `lib/z-index.ts`.
- Six safe-area `@utility` classes authored.
- Mobile-only `font-size: 16px !important` rule scoped to
  `(max-width: 767px)`.
- Body-level `overscroll-behavior: contain` and
  `-webkit-tap-highlight-color: transparent` applied globally.
- `:root` fallbacks for `--vvh`, `--kbd-height`, `--vv-offset-top`
  declared once.
- `useVisualViewport` hook exports the documented `VisualViewportState`
  shape and writes the three CSS vars on every event.
- `TerminalIOContext` scaffolds the `xtermRef`/`wsRef`/`sendInput`/
  `requestResize` API; Phase-2 wiring TODO documented in-file.
- `overlayStore` exposes the canonical plan §2.3 API plus a
  compatibility surface; mutex preserved on both.
- `zustand@^5.0.12` added to `package.json` dependencies.
- TypeScript: `tsc --noEmit` — zero errors in WP-A-owned files.
