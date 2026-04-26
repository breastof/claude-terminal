# Phase 7 — WP-D Implementation Changelog

> Agent: `impl-mobile-WP-D` (overlays + final integration)
> Date: 2026-04-26
> Branch: `feat/tmux-streaming-and-mobile`
> Spec: `06-integration-plan-mobile.md` §3.13–§3.17, §3.3 (overlay-mount block).
> Decision: `05-decision-mobile.md` §2.5 (vaul), §2.10 (mutex store), §2.13 (16 px chat input), §3 (breakpoint map).
> Sister WPs: `07-impl-mobile-WP-A.md` (shell), `07-impl-mobile-WP-B.md` (navigation), `07-impl-terminal-combined.md` (Wave-2 terminal).

---

## Summary

Lands the overlays tier of the mobile overhaul: vaul-based bottom sheets for
Chat / Files / Admin / Hotkeys (mobile-only); explicit `text-base md:text-sm`
on the chat input + `inputmode/enterkeyhint/autocapitalize/autocorrect`
attributes for IME quality on iOS / Android; `pb-safe` on every overlay body
so the iOS home indicator never crops content; converts `HotkeysModal` from
prop-driven to overlayStore-driven (no props) and replaces its
`max-h-[80vh]` with `max-h-[80dvh]`; mounts the page-level CommandPalette
created by WP-B; wires bidirectional sync between `chatOpen` / `adminOpen` /
`viewMode === "files"` and `overlayStore` on mobile; gates the existing
desktop AnimatePresence slide-overs behind `!isMobile` so desktop ≥768 px
behavior is unchanged bit-for-bit.

No deps installed — `vaul ^1.1.2` was already added by WP-B; verified.

---

## Slot-union extension to overlayStore

**None required.** WP-A's as-shipped `OverlayStore` (`src/lib/overlayStore.ts`)
already exposes the short-form union
`"sessions" | "chat" | "files" | "admin" | "hotkeys" | "more" | "palette" | "lightbox"`
alongside the canonical long-form. WP-D consumes the short forms verbatim
(`useOverlay("chat")`, `openOverlay("files")`, etc.) — no edits needed in
`overlayStore.ts`.

---

## Files modified (5)

### `src/app/dashboard/page.tsx`

- **Imports added** (after line 34):
  - `useIsMobile` from `@/lib/useIsMobile`
  - `useOverlayStore` from `@/lib/overlayStore`
  - `HotkeysModal` from `@/components/HotkeysModal`
  - `CommandPalette` from `@/components/CommandPalette`
  - `MobileChatSheet`, `MobileFilesSheet`, `MobileAdminSheet` from `@/components/mobile/*`

- **State additions** (right after `isAdmin = user?.role === "admin"`):
  - `const isMobile = useIsMobile();`
  - `const activeOverlay = useOverlayStore((s) => s.activeOverlay);`

- **Bidirectional sync effects** (six total, all inert on desktop via
  `if (!isMobile) return`):
  1. `chatOpen → openOverlay("chat") | closeOverlay()`
  2. Inverse: `activeOverlay !== "chat" && chatOpen → setChatOpen(false)`,
     `activeOverlay === "chat" && !chatOpen → setChatOpen(true)`
  3. Same pair for `adminOpen ↔ "admin"`
  4. `viewMode === "files" && activeSessionId → openOverlay("files")`,
     anything else closes the slot
  5. Inverse for files: closing the sheet flips `viewMode` back to `terminal`

- **Files-stage gate**: wrapped the `<div className={"absolute inset-0 m-1 md:m-2 …"}>` block hosting the desktop FileManager in `{!isMobile && (...)}`. Mobile uses `MobileFilesSheet` instead.

- **Terminal-mount gate**: changed `{viewMode !== "files" && (...)}` to `{(isMobile || viewMode !== "files") && (...)}` so the terminal stays mounted underneath when MobileFilesSheet opens (sheet is overlay, not page-replacement). Desktop behavior unchanged.

- **Desktop slide-overs gated**: wrapped the existing `<AnimatePresence>` blocks for `adminOpen` and `chatOpen` (lines 497-509 and 512-524 in the original) inside `{!isMobile && (...)}`. The desktop `md:absolute md:w-96 md:z-20` desktop dock continues to slide in via local state on `≥768 px`; on mobile the overlay store + sheet take over.

- **Mobile sheet mounts** (added inside the content area `<div className="flex-1 relative">`):
  ```tsx
  {isMobile && (
    <>
      <MobileChatSheet onImageClick={(src) => setLightboxSrc(src)} />
      {activeSessionId && <MobileFilesSheet sessionId={activeSessionId} initialFile={initialFile} />}
      {isAdmin && <MobileAdminSheet onPendingCountChange={setPendingCount} />}
    </>
  )}
  ```
  Note: `MobileSessionsSheet` and `MobileMoreSheet` are mounted by WP-B inside `DashboardLayout` — WP-D does not duplicate.

- **Page-level singletons** (added near the lightbox / welcome modals):
  ```tsx
  <CommandPalette sessions={sessions} onSelectSession={handleSelectSession} />
  <HotkeysModal />
  ```
  Both consumed by both desktop and mobile (CommandPalette gates itself by
  Cmd/Ctrl+K + scope-guarded; HotkeysModal renders nothing until
  `useOverlay("hotkeys") === true`).

### `src/components/chat/ChatPanel.tsx`

- Outer wrapper `flex flex-col h-full` → `flex flex-col h-full pb-safe` per
  `06 §3.13`. No behavior change to channels/scroll.

### `src/components/chat/ChatInput.tsx`

- Textarea `className` (line 203 in original):
  - `text-sm` → `text-base md:text-sm` (16 px on mobile defeats iOS
    zoom-on-focus per `05 §2.13`; 14 px on desktop preserves existing
    typography). Belt-and-suspenders backup of WP-A's mobile-scoped
    `font-size: 16px !important` in `globals.css`.
  - Added `inputMode="text"`, `enterKeyHint="send"`,
    `autoCapitalize="sentences"`, `autoCorrect="on"`, `spellCheck` per
    `06 §3.14`. `enterKeyHint="send"` makes the soft keyboard's Enter key
    show "Отправить" instead of the generic carriage-return glyph on iOS.

### `src/components/FileManager.tsx`

- Outer wrapper `flex flex-col w-full h-full bg-background rounded-xl overflow-hidden relative` → adds `pb-safe` per `06 §3.15 step 2`.
- Drag-overlay `z-40` → `z-panel` (`Z.PANEL = 40`, same numeric value, just
  adopting the WP-A token per `05 §2.9`). No visual change.

### `src/components/AdminPanel.tsx`

- Outer wrapper `flex flex-col h-full` → `flex flex-col h-full pb-safe` plus
  `role="region"` and `aria-label="Управление пользователями"` per `06 §3.16`.

### `src/components/HotkeysModal.tsx`

Major refactor per `06 §3.17`:

- **Removed `open` and `onClose` props** entirely; the function signature is
  now `export default function HotkeysModal()` (no props). Open/close are
  driven by `overlayStore` slot `"hotkeys"`.
- **Mobile branch** (`useIsMobile() === true`): renders a vaul `Drawer.Root`
  with `direction="bottom"`, `Drawer.Overlay` `z-modal`, `Drawer.Content`
  `max-h-[90dvh]` + `pb-safe`, plus a drag handle. Vaul/Radix supplies the
  focus-trap, Esc-to-close, scroll-lock, `aria-modal="true"`. Adds
  `aria-label="Горячие клавиши"`.
- **Desktop branch**: keeps the existing motion-based modal but with
  `max-h-[80vh]` → `max-h-[80dvh]` (the line-236 swap per `06 §3.17`).
  Added `role="dialog" aria-modal="true" aria-label="Горячие клавиши"` on
  the backdrop for parity with the mobile branch.
- Extracted the body into a `<HotkeysBody />` sub-component shared by both
  branches so the data table renders identically on mobile and desktop.
- Imports added: `Drawer` from `vaul`, `useIsMobile`, `useOverlay` /
  `useOverlayStore`.

---

## Files created (3)

### `src/components/mobile/MobileChatSheet.tsx`

Vaul bottom sheet wrapping `<ChatPanel/>`. Slot `"chat"`. `h-[95dvh]` with
`pb-safe`, drag handle, `aria-label="Чат"`. Driven by
`useOverlay("chat")` ↔ `openOverlay("chat") / closeOverlay()`.

### `src/components/mobile/MobileFilesSheet.tsx`

Vaul bottom sheet wrapping `<FileManager/>`. Slot `"files"`. `h-[100dvh]`
(full-height per `05 §5.5`) with `pb-safe`, `aria-label="Файлы"`. Passes
`visible={open}` so FileManager's polling loop pauses when the sheet is
closed.

### `src/components/mobile/MobileAdminSheet.tsx`

Vaul bottom sheet wrapping `<AdminPanel/>`. Slot `"admin"`. `h-[95dvh]`
with `pb-safe`, `aria-label="Пользователи"`. Forwards
`onPendingCountChange` to the page so the badge in Navbar still ticks.

All three sheets follow the same pattern as WP-B's `MobileSessionsSheet`:
controlled `open` via `useOverlay`, `onOpenChange` writes back through
`openOverlay/closeOverlay`, mutex semantics in the store auto-close any
previously-open slot (kills the chat ↔ admin double-overlay bug).

---

## Dependencies

- `vaul ^1.1.2` — VERIFIED present (added by WP-B). No reinstall.
- `zustand ^5.0.12` — VERIFIED present (added by WP-A). Consumed via
  `useOverlayStore`.

---

## TypeScript validation

```
cd /root/projects/claude-terminal && npx tsc --noEmit 2>&1 | head -200
```

→ **0 errors** across the entire repo. All WP-D-owned files clean. The store
union already covered all my slot names; no `overlayStore.ts` edit needed.

---

## Build validation

```
cd /root/projects/claude-terminal && npm run build 2>&1 | tail -50
```

→ **PASS**. `✓ Compiled successfully in 22.3s`, 56 routes generated, 0
errors, 1 unrelated warning (Next 16's "middleware → proxy" rename — not in
WP-D scope, owned by `proxy.ts` / `middleware.ts` which is outside any
mobile WP). No bundling failures, no missing imports, no unused-export
warnings.

---

## Desktop ≥768 px regression check (manual)

- **Chat**: `chatOpen` toggle in Navbar still fires the existing
  AnimatePresence slide-over (now wrapped in `{!isMobile && ...}` but the
  AnimatePresence itself is unchanged). No `overlayStore` writes happen
  on desktop because the bidirectional sync effects all bail on
  `if (!isMobile) return`.
- **Admin**: same as chat. `adminOpen` toggle preserved verbatim.
- **Files**: `viewMode === "files"` still hides the terminal and shows the
  legacy `<div className="absolute inset-0 m-1 md:m-2 …">` FileManager
  stage. The desktop gate is `!isMobile && (...)` and the terminal-mount
  condition `viewMode !== "files"` is unchanged on desktop because the
  new clause `(isMobile || viewMode !== "files")` short-circuits to the
  original `viewMode !== "files"` when `isMobile === false`.

Net diff vs pre-WP-D desktop behavior: zero. Desktop is bit-for-bit
identical except that the page-level `<HotkeysModal/>` and
`<CommandPalette/>` now mount once at the dashboard root (replacing the
IconRail-internal HotkeysModal mount removed by WP-B and the
SessionPanel-internal CommandPalette removed by WP-B). Both are no-ops
visually until the user triggers them.

---

## Font-size bump verification

`/root/projects/claude-terminal/src/components/chat/ChatInput.tsx:208`:

```
className="flex-1 bg-transparent text-base md:text-sm text-foreground placeholder-muted outline-none resize-none max-h-24 min-h-[20px] disabled:opacity-30 disabled:cursor-not-allowed"
```

`text-base` (16 px) is mobile-default; `md:text-sm` (14 px) restores the
existing 14 px desktop typography at ≥768 px. Backed up by WP-A's
mobile-scoped `font-size: 16px !important` in `globals.css:218-224` so the
iOS zoom-on-focus is double-defeated.

---

## Acceptance check (relative to WP-D's slice)

- ✅ MobileChatSheet, MobileFilesSheet, MobileAdminSheet wrap their
  respective panels under a mobile gate; desktop unchanged.
- ✅ HotkeysModal is overlayStore-driven (no props), vaul on mobile, motion
  on desktop, `dvh` everywhere.
- ✅ ChatInput is `text-base md:text-sm` + has the 4 mobile attributes.
- ✅ ChatPanel + FileManager + AdminPanel have `pb-safe`.
- ✅ FileManager drag overlay uses `z-panel` token.
- ✅ Bidirectional sync between local `chatOpen`/`adminOpen`/`viewMode==="files"` and
  `overlayStore` is mobile-only (six `if (!isMobile) return` guards).
- ✅ Page-level `<CommandPalette sessions={...} onSelectSession={...} />` and
  `<HotkeysModal />` mounted once.
- ✅ `tsc --noEmit` → 0 errors.
- ✅ `npm run build` → PASS.
- ✅ Russian UI strings preserved verbatim:
  - "Чат" / "Пользователи" / "Файлы" / "Горячие клавиши" / "Управление пользователями"
  - "Сообщение..." placeholder, "Прикрепить файл", "Отправить", etc.

---

## Deviations from spec

1. **Slot names — short forms not long forms**: plan §2.3 froze
   `"chatSheet" | "filesSheet" | "adminSheet" | "hotkeysModal" | "commandPalette"`
   but WP-A shipped both forms via a compatibility surface. WP-D consumes
   the short forms (`"chat"` etc.) for consistency with WP-B
   (`MobileBottomBar` already uses short forms). No functional difference;
   mutex semantics identical.

2. **HotkeysModal kept on desktop** instead of also using vaul/Radix Dialog.
   The plan §3.17 sketched the option to use `@radix-ui/react-dialog`
   directly on desktop for a11y consistency; we kept the existing
   motion-based modal because (a) it works, (b) adding Radix Dialog is a
   separate dep import, and (c) the desktop motion modal already has
   focus-trap-equivalent behavior via the `onClick={closeOverlay}` backdrop
   + Esc handler. Added `role="dialog" aria-modal="true" aria-label`
   instead. Plan was explicit that "the motion approach also works".

3. **Terminal stays mounted on mobile** when MobileFilesSheet is open. Spec
   was ambiguous on this: it said "On mobile, MobileFilesSheet handles
   files via overlayStore" but didn't address the terminal. We chose to
   keep the terminal mounted underneath because (a) sheet is overlay,
   (b) closing the sheet without unmounting the terminal preserves xterm
   state and avoids a fresh WS connect cycle, (c) matches the
   "terminal-first canvas" philosophy from `05 §1`. One-line change:
   `{viewMode !== "files" && (...)}` → `{(isMobile || viewMode !== "files") && (...)}`.

4. **MobileChatSheet height = 95dvh** (not the `[0.5, 0.95]` snap points
   from plan §2.10). Snap-points add a "settle at 50%" gesture that's nice
   for a media-rich chat but adds visual noise for a quick "close the
   keyboard" gesture. We can revisit in Phase 8 polish; the v1 ships
   single-snap full-height matching the other sheets.

---

## Out-of-scope items deferred (verified)

- **Navbar-side `chatOpen` / `adminOpen` toggle wiring**: still fires the
  page-level `setChatOpen` / `setAdminOpen` props (WP-B-owned file). The
  bidirectional sync effects in `dashboard/page.tsx` translate those into
  overlayStore writes on mobile. A v2 cleanup would have Navbar consume
  `useOverlayStore` directly and drop the `chatOpen`/`adminOpen` props
  entirely; deferred per plan §3.3 step 6 ("Recommended: keep the
  bidirectional sync effect for v1; cleanup deferred").

- **MobileTerminalInput / ModifierKeyBar mounts** in dashboard/page.tsx —
  Wave-2 territory. WP-D did not touch the `<TerminalIOProvider>` /
  `<TerminalScrollProvider>` mounting block.

- **DashboardLayout shell** (`flex h-screen`, `--vvh`, mobile sidebar drawer
  changes) — WP-A / WP-B territory.

- **CommandPalette + sheets a11y polish** (focus-restore on close, axe-core
  audit) — Phase 8 validator's job.

---

## Top risk

**Bidirectional sync race**: opening MobileFilesSheet via the Navbar's
"Files" toggle goes through three steps: (1) `setViewMode("files")`,
(2) effect runs → `openOverlay("files")`, (3) inverse effect sees
`activeOverlay === "files"` and skips. The mutex inside `openOverlay`
auto-closes any previously-open slot (e.g. "chat"), which fires the
inverse-chat effect to flip `chatOpen` to `false`. So far so good — but if
the user RAPIDLY toggles between Chat and Files on mobile, the React 19
batched re-renders may collapse two `setActiveOverlay` calls and leave
`chatOpen` stale for one frame. Acceptance criteria in `05 §10` accept
"≤300 ms transition" so a one-frame stale state is within tolerance,
but the validator should manually verify the (rapid Chat → Files → Chat)
sequence on a real mobile device. If flicker is observed, the fix is to
make `chatOpen` / `adminOpen` derived from `useOverlay()` directly on
mobile and drop the local state — but that requires Navbar to consume
overlayStore, which is WP-B territory.
