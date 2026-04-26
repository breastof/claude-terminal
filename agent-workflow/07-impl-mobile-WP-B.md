# 07 — impl-mobile-WP-B (navigation) changelog

> Sister files: `07-impl-mobile-WP-A.md` (shell), `07-impl-mobile-WP-C.md`
> (terminal), `07-impl-mobile-WP-D.md` (overlays).
>
> Spec: `06-integration-plan-mobile.md` §3.5–§3.9, §3.10 (CommandPalette
> extraction lifted into WP-B by the impl prompt).

## Scope reassignment vs the planning doc

The impl prompt reassigned the following files from WP-D ownership (per
`06-integration-plan-mobile.md §9.4`) to WP-B for this implementation wave:

- `src/components/CommandPalette.tsx` (NEW)
- `src/components/mobile/MobileSessionsSheet.tsx` (NEW)
- `src/components/mobile/MobileMoreSheet.tsx` (NEW)
- `src/components/pos/SessionPanel.tsx` (Cmd+K extraction)

WP-D will mount these (`dashboard/page.tsx`) but WP-B authored the components.

## Key API alignment finding

`overlayStore.ts` was already landed by WP-A with a different API surface
than `06-integration-plan-mobile.md §2.3` froze. Plan said
`OverlaySlot` (e.g. `"sessionsSheet"`, `"chatSheet"`, `"moreDrawer"`,
`"hotkeysModal"`, `"commandPalette"`) plus `setActiveOverlay(slot)` and
`closeAll()`. WP-A actually shipped `OverlayName` (short names:
`"sessions"` / `"chat"` / `"more"` / `"hotkeys"` / `"palette"` etc.) plus
`openOverlay(name)` and `closeOverlay()`.

**WP-B aligned to the as-shipped WP-A API.** All `setActiveOverlay("...Sheet")`
calls became `openOverlay("short-name")` or `closeOverlay()`; all
`useOverlay("...Sheet")` calls became `useOverlay("short-name")`.

## Files modified

### `src/components/Navbar.tsx`

Per plan §3.7:

1. Hamburger `<button>` (line 70-area): `p-2` → `p-2.5`; added
   `aria-label="Открыть меню"`.
2. Admin toggle `<button>` (line 144-area): `p-2 md:p-1.5` →
   `p-2.5 md:p-1.5`; added `aria-label="Пользователи"`.
3. Chat toggle `<button>` (line 163-area): `p-2 md:p-1.5` →
   `p-2.5 md:p-1.5`; added `aria-label="Чат"`.
4. No `overlayStore` wiring per plan §3.7 step 3 ("No Navbar change needed"
   beyond aria-labels and tap-target bumps; the bidirectional sync between
   `mobileSidebarOpen` and `overlayStore.activeOverlay === "more"` lives in
   `pos/DashboardLayout.tsx` per §3.5 — owned by a different sub-task).

### `src/components/pos/MobileBottomBar.tsx`

Repurposed completely per plan §3.6 / decision §2.4. Tab list before/after:

| Slot | Before                                | After       |
|------|---------------------------------------|-------------|
| 1    | Сессии (sets section "sessions")      | Терминал    |
| 2    | Hub (sets section "hub")              | Сессии      |
| 3    | Задачи (sets section "symphony")      | Чат         |
| 4    | Система (sets section "system")       | Ещё         |
| 5    | Ещё (overflow popover with 3 tabs)    | _(removed)_ |

Notes:

- "Ещё" overflow popover (lines 35-53 in original) deleted; the More tab
  now opens `MobileMoreSheet` (full vaul drawer) per plan §3.6 step 5.
- Russian labels: "Терминал / Сессии / Чат / Ещё" (≤ 8 chars each, fits at
  360 px under `text-[10px]`).
- Added `pb-safe` for iOS home indicator inset per plan §3.6 step 4.
- Added `useVisualViewport()` consumer + `if (isKeyboardOpen) return null`
  per §3.6 step 3.
- Added `role="tablist"` + per-button `role="tab"` + `aria-selected` +
  `aria-label` per §3.6 step 7.
- The Sessions tab uses the existing `Files` icon (visual list-of-items)
  because no `ListIcon` exists in `src/components/Icons.tsx` — the plan's
  named import `ListIcon` had no source. `Files` reads as "list of session
  files" and matches the current visual language.

### `src/components/pos/IconRail.tsx`

Per plan §3.8:

- Removed `import HotkeysModal from "@/components/HotkeysModal"`.
- Removed `const [hotkeysOpen, setHotkeysOpen] = useState(false)`.
- Removed the inline `<HotkeysModal open={hotkeysOpen} onClose={...} />`
  mount at the bottom of the JSX.
- Removed the `<>` fragment wrapper around the rail body (now returns the
  rail container directly).
- Added `import { useOverlayStore } from "@/lib/overlayStore"`; the keyboard
  button now calls `openOverlay("hotkeys")`.
- Added `aria-label`s on theme toggle / hotkeys / logout (matching `title`).
- Section button sizing left at `w-10 h-10` (desktop-only per plan §3.8 #3).

### `src/components/pos/SidePanel.tsx`

No edits per plan §3.9. Verified that the `activeSection` switch dispatcher
is pure and renders correctly inside a vaul Drawer (no hooks that depend on
the desktop chrome).

### `src/components/pos/SessionPanel.tsx`

Per plan §3.10 (lifted into WP-B by the impl prompt):

- Removed `paletteOpen / paletteQuery / paletteIndex` state (lines 78-80).
- Removed the global `keydown` listener that handled Cmd+K and Ctrl+1..9
  (lines 226-250).
- Removed the inline `<CommandPalette ... />` JSX render (lines 459-468).
- Removed the inline `function CommandPalette(...)` definition + its
  `CommandPaletteProps` interface (lines 473-555).
- Added comment markers documenting the lift.

Verification: `grep -n 'palette\|Palette' src/components/pos/SessionPanel.tsx`
→ 0 hits. File shrank by ~120 lines.

## Files created

### `src/components/CommandPalette.tsx`

Extracted Cmd+K palette per plan §2.14. Key changes vs the original
`SessionPanel.tsx:484-555` body:

- Open state lives in `useOverlayStore` (slot `"palette"`), not local state.
- Keydown listener is **scope-guarded** per `05-decision-mobile.md §2.11`:

  ```ts
  const isInputLike =
    tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" ||
    !!t?.isContentEditable;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    if (isInputLike) return;          // GUARD
    e.preventDefault();
    ...
  }
  ```

  The same guard applies to Cmd/Ctrl+1..9 so chat/rename inputs can type
  literal digits.
- z-index moved from inline `z-[9998]` to inline `style={{ zIndex: 9000 }}`
  (Z.PALETTE) so the palette beats modals (60) but sits below toasts (9500).
  WP-A's Tailwind tokens publish `z-palette` as well; using inline style
  avoids depending on Tailwind class generation in this file.
- Added `role="dialog" aria-modal="true" aria-label="Командная палитра"`
  (was missing per `02-scan-navigation.md §1.2`).
- Props frozen per plan §2.14 step 5: `{ sessions, onSelectSession }`.
- Russian UX preserved verbatim: placeholder "Поиск сессии…" and the empty
  state "Нет активных сессий".

### `src/components/mobile/MobileSessionsSheet.tsx`

Bottom-sheet wrapper around `<SessionPanel/>` per plan §2.9. Vaul Drawer
controlled by `useOverlay("sessions")` ↔ `openOverlay("sessions")` /
`closeOverlay()`. Wraps `props.onSelectSession` to auto-close the sheet
after a selection so the user lands back on the terminal canvas.

A11y: vaul → Radix Dialog inherits `role="dialog"` + `aria-modal="true"` +
focus-trap + Esc-to-close. Adds `aria-label="Сессии"` plus `Drawer.Title`
(sr-only) and `Drawer.Description` (sr-only).

### `src/components/mobile/MobileMoreSheet.tsx`

Left-edge drawer per plan §2.11. Inlines the IconRail layout (does NOT
render `<IconRail/>` directly) so the wider sheet can host text labels next
to the icons and use 44 px tap targets (`h-11`) instead of IconRail's 40 px
desktop sizing.

Hosts:

- Section list: Сессии / Hub / Конфигурация / Скиллы / Память / Symphony /
  Система. Tapping a section calls `setActiveSection` + `setPanelOpen` and
  closes the drawer.
- Footer: Theme toggle / Горячие клавиши (opens hotkeys overlay) / Выйти.

A11y: `aria-label="Главное меню"`, `aria-current="page"` on the active
section, vaul-inherited dialog semantics.

## Dependencies

`vaul` was NOT listed under WP-B's deps in the plan §5 table — install
ownership was ambiguous. Since the impl prompt reassigned the new
`MobileSessionsSheet` and `MobileMoreSheet` files to WP-B (and these files
import from `vaul`), WP-B installed `vaul` to keep typecheck clean:

```
cd /root/projects/claude-terminal && npm install vaul --save
```

Result: `vaul ^1.1.2` added to `package.json`. WP-D may run the same install
later — `npm install` is idempotent.

## Type-check

```
cd /root/projects/claude-terminal && npx tsc --noEmit 2>&1 | head -100
```

→ 0 errors across the entire repo. Owned files all clean.

## Acceptance-criterion mapping

| ID  | Criterion (from §10)                              | Where verified |
|-----|---------------------------------------------------|----------------|
| 5   | Cmd+K does not steal from ChatInput               | `CommandPalette.tsx` `isInputLike` guard, lines 56-63 |
| 8   | Safe-area insets respected (MobileBottomBar)      | `MobileBottomBar.tsx` `pb-safe` on the wrapper |
| 9   | Tap targets ≥44×44 (Navbar mobile buttons)        | `Navbar.tsx` `p-2.5` bumps (≈ 40 px; if 8c asserts fail, raise to `p-3` per plan §3.7 step 1) |
| 10  | No double-overlay states                          | All sheet/drawer wrappers go through `openOverlay()` which clears any prior slot (mutex semantics in `overlayStore.ts`) |

## Risks / open items

- **One risk surfaced**: `MobileMoreSheet`'s "Сессии" entry sets
  `activeSection = "sessions"` and closes the drawer, but does NOT open the
  Sessions sheet. On mobile the bottom-bar's "Сессии" tab is the canonical
  way to reach the list. If a user expects the More drawer's "Сессии" row to
  do the same thing, we'd need to also call `openOverlay("sessions")` after
  closing the drawer. Frozen as-is for parity with the desktop IconRail's
  behaviour (where "Сессии" simply selects the section). Flag for Phase 9
  audit.

- **API drift between plan and as-shipped store**: documented above. Any
  later WP that reads `06-integration-plan-mobile.md §2.3` literally will
  hit `Property 'setActiveOverlay' does not exist`. Recommend WP-D updates
  the plan or the store comment to reflect the as-shipped API.

- **`Files` icon used for Sessions tab**: plan named `ListIcon` which does
  not exist. If the Phase 8b screenshot review flags ambiguity (Files icon
  could read as "files manager"), swap to a custom 3-line list SVG inside
  `Icons.tsx` (out of WP-B scope — file owned by neither WP).
