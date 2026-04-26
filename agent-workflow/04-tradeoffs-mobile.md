# Phase 4 — Mobile Overhaul Tradeoffs Matrix

> Agent: `analyst-tradeoffs-mobile`
> Date: 2026-04-26
> Mode: SCORE-ONLY. No winners picked, no edits to project source. The arbiter (Phase 5) closes every binary.
> Inputs digested in full: `01-planner-mobile.md`, `02-scan-layout.md`, `02-scan-navigation.md`, `02-scan-terminal.md`, `02-scan-styles.md`, `03-research-terminal-ux.md`, `03-research-xterm-proxy.md`, `03-research-nav-patterns.md`.
> Citation conventions: scan files → `02-scan-{name}.md §X.Y` or `file.tsx:LINE`; research files → `03-research-{name}.md §X.Y`.

---

## Executive overview

- 25 candidates scored across 9 sub-problems.
- 3 coherent bundles proposed (Minimal / Polished / Native-feeling).
- 16 explicit decisions punted to the arbiter.
- Single biggest risk flagged: **Recipe C (WS bypass)** — it permanently forks the byte-producer contract and silently breaks bracketed-paste, the DA/CPR auto-reply filter, and any future server-side replay/recording. If any candidate must be excluded outright at Phase 5, this is it.

---

## 1. Inherited constraint ledger (must-not-break facts)

The arbiter cannot freely choose against any of these — they are facts on the ground from the scans:

1. **`SessionList.tsx` does not exist.** Real components: `pos/SessionPanel.tsx`, `pos/SidePanel.tsx`, `pos/DashboardLayout.tsx`. Planner brief is stale on this point (`02-scan-navigation.md §0`, §7-1).
2. **A partial mobile mode already ships.** Hamburger trigger in `Navbar.tsx:67-74`, slide-in drawer in `pos/DashboardLayout.tsx:72-114`, persistent `pos/MobileBottomBar.tsx:56` (4 tabs + Ещё), right slide-overs for ChatPanel/AdminPanel at `dashboard/page.tsx:497-521` (`02-scan-navigation.md §4`).
3. **WS keystroke contract is fixed**: `{"type":"input","data":"<bytes-as-utf8-string>"}` (`02-scan-terminal.md §4.2`, `terminal-manager.js:518-525`). Server forwards verbatim into `pty.write(data)`. **No protocol change is required for any candidate** except Recipe C, which ships bytes via a different code path on the same channel.
4. **Splice point identified**: lift `xtermRef`/`wsRef` from `Terminal.tsx:213-221` into a new `TerminalIOContext` adjacent to the existing `TerminalScrollProvider` mount (`dashboard/page.tsx:404`). All input-proxy candidates (A/B/D/E) use this seam (`02-scan-terminal.md §7.4`).
5. **Z-index literals are scattered**: 10 / 20 / 30 / 40 / 50 / 60 / 100 / 9998 (`02-scan-layout.md §6`, `02-scan-navigation.md §5.7`). A `src/lib/z-index.ts` token file exists at `:20-39` but only some sites import it; literals dominate. Comments like `/* Z.MODAL */` next to `z-[60]` literals indicate a planned but-not-realised migration.
6. **No safe-area, no `dvh`, no `viewport-fit=cover`, no `interactive-widget=resizes-content`** anywhere in `src/` (`02-scan-styles.md §1, §3, §4, §8`). `app/layout.tsx:21-24` has no `viewport` export — Next.js 16 default is shipped.
7. **`flex h-screen` at `pos/DashboardLayout.tsx:49,53`** is the critical iOS keyboard trap (`02-scan-layout.md §4`, `02-scan-styles.md §4`). Soft keyboard pushes content out of the layout viewport with no recovery; xterm `FitAddon` does not refit because container ResizeObserver does not fire on `visualViewport.resize` (`02-scan-terminal.md §5.3`).
8. **`Cmd/Ctrl+K` chord clash**: `SessionPanel.tsx:228-235` keydown listener does not check `e.target` — typing the chord in `ChatInput.tsx:194-204` opens the CommandPalette and steals the keystroke (`02-scan-navigation.md §5.5`, §7-7).
9. **`ChatInput.tsx:203` uses `text-sm` (14 px)** → iOS Safari zoom-on-focus (`02-scan-styles.md §6`).
10. **Mutual exclusion is missing** between AdminPanel ↔ ChatPanel ↔ MobileBottomBar overflow ↔ mobile sidebar drawer ↔ CommandPalette (`02-scan-navigation.md §5.1, §7-4`). All can in principle be open simultaneously, producing layered overlays unreachable through clear close paths on mobile.
11. **`xterm.js v6` ships the helper textarea with `autocorrect/autocapitalize/spellcheck="off"` already** (`03-research-xterm-proxy.md §1.6`); `term.input(data, wasUserInput?)` and `term.paste(data)` are the documented byte-injection APIs (`02-scan-terminal.md §1`); `attachCustomKeyEventHandler` cannot be removed, only replaced (`03-research-xterm-proxy.md §1.4`).
12. **Tap targets on the existing `Navbar` are below 44 px**: hamburger `p-2` ≈ 36 px hit area; view-mode pill ≈ 24 px (`02-scan-navigation.md §10.1`).

These 12 facts gate every choice below.

---

## 2. Candidate roster (by sub-problem)

For brevity each candidate is given a code (e.g. `IP-A`, `MB-2`, `NV-A`). Per-candidate detail follows in §4.

### 2.1 Input proxy

| Code | Candidate | One-liner | Reference |
|------|-----------|-----------|-----------|
| `IP-A` | Recipe A — expose & style xterm helper textarea on mobile | Pull `term.textarea` (`xterm.d.ts:822`, scan §6.2) on-screen; xterm's pipeline does the rest | `03-research-xterm-proxy.md §3 Recipe A` |
| `IP-B` | Recipe B — React `<input>` calling `term.input(data, true)` per keystroke | Outbox-style; existing `onData` listener forwards to WS unchanged | `03-research-xterm-proxy.md §3 Recipe B` |
| `IP-C` | Recipe C — React `<input>` bypassing xterm; raw `ws.send` | `term.options.disableStdin = true`; mobile owns the WS channel | `03-research-xterm-proxy.md §3 Recipe C` |
| `IP-D` | Recipe D — `<textarea>` with composition events + `term.input` | Holds bytes during IME; ships on `compositionend` | `03-research-xterm-proxy.md §3 Recipe D` |
| `IP-E` | Recipe E — `contenteditable` overlay + `beforeinput` | Rich-input model; `term.paste` for clipboard | `03-research-xterm-proxy.md §3 Recipe E` |

### 2.2 Modifier bar

| Code | Candidate | One-liner | Reference |
|------|-----------|-----------|-----------|
| `MB-T` | Termux JSON schema (rows × keys + popup variants) | Adopt the `[[ROW1],[ROW2]]` syntax that's the de-facto standard | `03-research-terminal-ux.md §1.1` |
| `MB-B` | Blink-style gestures (tap=one-shot, long-press=lock, hold=auto-repeat) | Sticky modifier toggles + page-toggle for symbols/F-keys | `03-research-terminal-ux.md §1.2` |
| `MB-R` | Custom React row, fixed key list (Esc/Tab/Ctrl/Alt/arrows + ^C/^D/^L/⇧Tab) | Single-row toolbar matching planner Tier 1+2 | `03-research-terminal-ux.md §4.2` |
| `MB-S` | Swipeable two-row (Termux ViewPager analog) | Page 0 = primary keys; Page 1 = symbols / F-keys | `03-research-terminal-ux.md §4.3 row 1` |
| `MB-N` | None | Rely on hardware keyboard / Hacker's Keyboard on Android | `03-research-terminal-ux.md §1.4 (Hyper)` |

### 2.3 Nav consolidation

| Code | Candidate | One-liner | Reference |
|------|-----------|-----------|-----------|
| `NV-A` | Combo A — bottom-tab (4) + hamburger overflow | Sessions/Chat/Files/Sessions tabs + drawer for AdminPanel/Hotkeys | `03-research-nav-patterns.md §4 Combo A` |
| `NV-B` | Combo B — top app-bar + bottom-sheet sessions + slide-over chat | Maps/Uber pattern; max canvas | `03-research-nav-patterns.md §4 Combo B` |
| `NV-C` | Combo C — bottom-tab (3) + side drawer | Sessions live in drawer; "More" tab for Files/Admin | `03-research-nav-patterns.md §4 Combo C` |
| `NV-D` | Combo D — tab-stack collapse, no chrome | Linear/Slack web mobile pattern; back-stack navigation | `03-research-nav-patterns.md §4 Combo D` |

Existing `MobileBottomBar` (`pos/MobileBottomBar.tsx:56`, 4 tabs sessions/hub/symphony/system + Ещё for config/skills/memory) is the strong baseline. All candidates are scored against the **delta** from the current baseline.

### 2.4 Sheet / drawer library

| Code | Candidate | One-liner | Reference |
|------|-----------|-----------|-----------|
| `SH-V` | `vaul` | Drag-to-close, snap points, scaled-bg, ~34 KB gzip (with Radix Dialog dep) | `03-research-nav-patterns.md §3.1` |
| `SH-R` | `@radix-ui/react-dialog` | Headless full-screen modal, ~22 KB, no drag | `03-research-nav-patterns.md §3.2` |
| `SH-A` | Aceternity Sheet | Framer-motion-heavy, ~80+ KB, marketing-grade animations | `03-research-nav-patterns.md §3.4` |
| `SH-C` | Custom (bare CSS + framer-motion that's already a dep) | ~40 lines for a sheet shell, no focus-trap unless you add it | `03-research-nav-patterns.md §3.5` |

`framer-motion` is already in the bundle (`pos/DashboardLayout.tsx:84` uses `motion.div`), so SH-C does not add a runtime cost.

### 2.5 Viewport handling

| Code | Candidate | One-liner | Reference |
|------|-----------|-----------|-----------|
| `VP-W` | `interactive-widget=resizes-content` viewport meta + `100dvh` | Chrome-only widget hint + dynamic vh unit | `03-research-xterm-proxy.md §2.2`, `02-scan-styles.md §1` |
| `VP-V` | `visualViewport` listener feeding a `--vvh` CSS variable | Cross-browser, fires after kbd animation completes | `03-research-xterm-proxy.md §2.1, §5` |
| `VP-B` | Both (meta hint + listener) | Belt-and-braces: meta gives Android Chrome 108+ for free; listener catches iOS Safari | recommended cross-app convergence per `03-research-terminal-ux.md §5.2` |
| `VP-N` | Neither | Status quo: `flex h-screen`, no kbd awareness — only viable if mobile is permanently low-priority | n/a |

### 2.6 Safe-area scaffolding

| Code | Candidate | One-liner | Reference |
|------|-----------|-----------|-----------|
| `SA-G` | `env()` utilities authored in `globals.css` (e.g. `.pb-safe`, `.pt-safe`) | Centralised, low-magic | `03-research-terminal-ux.md §5.2` |
| `SA-T` | Tailwind plugin (`tailwindcss-safe-area` or hand-rolled `@utility`) | Inline `pb-safe-bottom` etc. classes; Tailwind v4 `@utility` directive | `02-scan-styles.md §2 (Plugins: zero today)` |
| `SA-P` | Per-component inline styles (`style={{ paddingBottom: "env(...)" }}`) | No central abstraction | n/a |

### 2.7 Z-index tokenisation

| Code | Candidate | One-liner | Reference |
|------|-----------|-----------|-----------|
| `ZI-C` | CSS variables in `globals.css` (`--z-modal: 60` etc.) | Theme-friendly; works in arbitrary `z-[var(--z-modal)]` | `02-scan-layout.md §6` |
| `ZI-T` | Tailwind theme extend (Tailwind v4 `@theme inline { --z-modal: 60 }` + `z-modal` utility) | First-class Tailwind class | `02-scan-styles.md §2.2` |
| `ZI-S` | TS const enum (already exists at `src/lib/z-index.ts:20-39`) | Adopt for inline styles + ad-hoc cases | `02-scan-layout.md §6` |
| `ZI-N` | Status quo (literals scattered) | No work | n/a |

### 2.8 Overlay coordination

| Code | Candidate | One-liner | Reference |
|------|-----------|-----------|-----------|
| `OC-S` | Explicit mutual-exclusion store (Zustand or React context) | Each overlay registers; opening one closes peers | gap noted in `02-scan-navigation.md §5.1, §7-4` |
| `OC-F` | Focus-trap-only (e.g. `focus-trap-react` per overlay) | Solves a11y but not state collision | `02-scan-navigation.md §1.3, §1.4` (no focus traps today) |
| `OC-B` | Both (store + focus-trap) | Belt-and-braces | n/a |
| `OC-N` | Neither (status quo) | Bug-prone but zero work | n/a |

### 2.9 `Cmd+K` chord clash fix

| Code | Candidate | One-liner | Reference |
|------|-----------|-----------|-----------|
| `CK-S` | Scope `Cmd+K` to non-input targets (check `e.target.tagName`) | Tiny patch to `SessionPanel.tsx:228-235` | `02-scan-navigation.md §5.5, §7-7` |
| `CK-D` | Move palette to a dedicated context, mount globally | Decouples from SessionPanel; works on all sections | `02-scan-navigation.md §6.6` |
| `CK-B` | Both | Scope guard now, context refactor later | n/a |

---

## 3. Scoring matrix

Legend per cell: ✓ = passes target / good · ~ = workable with caveats · ✗ = fails / breaks.
Columns 1–11 are the Mobile UX Targets from `01-planner-mobile.md §"Mobile UX Targets"`. Extra columns: **IC** = impl cost (S/M/L), **R** = risk (low/med/high), **A** = a11y, **RU** = RU-text fit, **B** = bundle delta, **CO** = coupling.

### 3.1 Input proxy

| Cand. | T1 vp | T2 nav | T3 input | T4 mod | T5 vv | T6 SA | T7 touch | T8 chat | T9 fm | T10 layout | T11 perf | IC | R | A | RU | B | CO |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `IP-A` style helper TA | n/a | n/a | ~ iOS quirks; xterm IME native (scan §6.2) | ~ uses `term.input` (research §3 A pros) | n/a | n/a | ~ no caret feedback | n/a | n/a | n/a | ~ helper TA reflows on every fit | S | high — xterm version churn (research §1.6) | ~ inherits xterm a11y | ✓ no labels | 0 KB | low |
| `IP-B` `<input>`+`term.input` | n/a | n/a | ✓ for Latin, ✗ for IME (research §3 B cons) | ✓ same WS pipe (terminal.tsx:213-221) | n/a | n/a | ✓ tap → `inputRef.focus` | n/a | n/a | n/a | ✓ no extra reflow | M | low | ✓ real `<input>`; aria-label trivial | ✓ | +0 KB | medium (lifts `xtermRef`) |
| `IP-C` `<input>`+raw WS | n/a | n/a | ✗ bracketed-paste gone, DA/CPR filter bypassed (terminal.tsx:217) | ✓ owns WS | n/a | n/a | ✓ | n/a | n/a | n/a | ✓ | M | **HIGH** — forks contract, breaks `term.paste`, breaks DA filter (scan §3.1 + §6.4) | ✓ | ✓ | +0 KB | **high** — duplicates `wsRef`, requires re-implementing filter in two places |
| `IP-D` `<textarea>`+composition | n/a | n/a | ✓ CJK/voice/Samsung kbd (research §3 D pros) | ✓ same pipe | n/a | n/a | ✓ | n/a | n/a | n/a | ✓ debounce on compositionend | M | low — most production-tested pattern (Sshwifty/VS Code lineage) | ✓ | ✓ | +0 KB | medium |
| `IP-E` `contenteditable`+`beforeinput` | n/a | n/a | ✓ modern event model | ✓ via `term.input`; chord rendering inline possible | n/a | n/a | ~ CE selection vs xterm selection (scan §6.5) | n/a | n/a | n/a | ✓ | M-L | medium — CE diverges across engines (research §3 E cons) | ~ React doesn't track CE; ARIA must be manual | ✓ | +0 KB | medium |

### 3.2 Modifier bar

| Cand. | T1 | T2 | T3 | T4 mod | T5 | T6 | T7 touch | T8 | T9 | T10 | T11 | IC | R | A | RU | B | CO |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `MB-T` Termux JSON | n/a | n/a | n/a | ✓ user-customisable (research §1.1) | n/a | n/a | ✓ long-press popups | n/a | n/a | n/a | ~ JSON parse cost | L | low | ✓ each key as `<button>` with `aria-label` | ✓ ASCII + Unicode glyphs | +1-2 KB schema validator | low (pure data) |
| `MB-B` Blink gestures | n/a | n/a | n/a | ✓ sticky toggles, hold=repeat (research §1.2) | n/a | n/a | ✓ tap=one-shot, long-press=lock, hold=auto-repeat | n/a | n/a | n/a | ✓ | M | low | ✓ standard button states | ✓ | +0 KB | low |
| `MB-R` Custom React row | n/a | n/a | n/a | ✓ planner Tier 1+2 keys (planner §"Mobile UX Targets" #4) | n/a | n/a | ✓ 44 px buttons | n/a | n/a | n/a | ✓ | S | low | ✓ trivial | ✓ short labels (^C, ⇧Tab) fit | +0 KB | low |
| `MB-S` Swipeable 2-row | n/a | n/a | n/a | ✓ + symbols/F-keys page (research §4.3) | n/a | n/a | ~ swipe gesture conflicts with xterm two-finger scroll (terminal-ux §1.2) | n/a | n/a | n/a | ✓ | M | medium — gesture coordination | ✓ ARIA `tablist` per page | ✓ | +0 KB | medium |
| `MB-N` None | n/a | n/a | n/a | ✗ no Esc/Tab/Ctrl reachable from soft kbd (research §0) | n/a | n/a | n/a | n/a | n/a | n/a | n/a | S | very high — fails T4 outright | ✗ | n/a | 0 KB | n/a |

### 3.3 Nav consolidation

| Cand. | T1 vp | T2 nav | T3 | T4 | T5 | T6 SA | T7 touch | T8 chat | T9 fm | T10 layout | T11 | IC | R | A | RU | B | CO |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `NV-A` 4-tab + hamburger | ✓ tab bar at `pb-safe` | ✓ single mobile nav surface (planner #2) | n/a | n/a | n/a | ~ adds bar height to be subtracted | ✓ persistent thumb-zone tabs | ~ chat as tab eats real-estate when hidden | ~ files as tab same | ✓ | ✓ | M | low — extends existing `MobileBottomBar` (scan §1.7) | ✓ tablist on bar | ~ "Терминал/Чат/Файлы/Сесcии" 4 RU labels fit at 360 px (cf. `Navbar.tsx:99,112` already hides labels at <sm) | +0 KB (custom CSS) | medium — shifts session-list role |
| `NV-B` top-bar + sheet + slide-over | ✓ max canvas | ✓ | n/a | n/a | n/a | ~ top-bar `pt-safe` | ~ session dropdown is single tap | ✓ slide-over keeps terminal in peripheral view | ✓ slide-over | ✓ | ✓ | L | medium — two gesture surfaces (sheet vs slide-over) | ✓ if `vaul`+Radix Dialog | ✓ | +34 KB if `vaul` adopted | medium |
| `NV-C` 3-tab + drawer | ✓ | ✓ | n/a | n/a | n/a | ~ tab bar bottom safe-area | ✓ | ✓ chat as tab | ~ Files as More→Modal (2 taps) | ✓ | ✓ | M | low | ✓ | ✓ | +0 KB | medium |
| `NV-D` tab-stack no chrome | ✓ | ~ no persistent indicator of active session | n/a | n/a | n/a | ~ stage `pt-safe`/`pb-safe` only | ✓ pure swipe-back gestures | ~ slide-over only | ~ push view | ✓ | ✓ | M | medium — no always-visible session indicator unless added to app-bar (research §4 Combo D) | ✓ | ✓ | +0 KB | high — re-architects `dashboard/page.tsx` workspaceView state machine |

### 3.4 Sheet / drawer library

| Cand. | T1 | T2 | T3 | T4 | T5 | T6 | T7 touch | T8 chat | T9 fm | T10 | T11 | IC | R | A | RU | B | CO |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `SH-V` `vaul` | n/a | n/a | n/a | n/a | n/a | n/a | ✓ drag-to-close with velocity threshold (research §3.1) | ✓ snap points `[0.4, 0.9]` for chat | ✓ | n/a | ✓ pointer events, no jank on iOS | M | low | ✓ inherits Radix Dialog focus trap, `aria-modal`, Esc handling | ✓ | **+34 KB gzip** (vaul + Radix Dialog) | low |
| `SH-R` Radix Dialog | n/a | n/a | n/a | n/a | n/a | n/a | ~ no drag — tap scrim or X only | ~ chat looks "modal" not "sheet" | ✓ admin/hotkeys natural fit | n/a | ✓ | S | low | ✓ industry-standard a11y (research §3.2) | ✓ | +22 KB gzip | low |
| `SH-A` Aceternity | n/a | n/a | n/a | n/a | n/a | n/a | ~ animation-heavy, possibly janky on low-end Android | ~ | ~ | n/a | ~ heavy framer-motion paint | M | medium — opinionated styling, mixed a11y (research §3.4) | ~ "mixed" per research | ✓ | **+80+ KB** with framer-motion deps | medium |
| `SH-C` Custom (uses existing framer-motion) | n/a | n/a | n/a | n/a | n/a | n/a | ~ drag implementable but non-trivial | ~ snap points need handcrafting | ~ | n/a | ✓ | L | medium — easy to get focus-trap subtly wrong | ✗ no built-in focus trap (`02-scan-navigation.md §1.3, §7-6`) | ✓ | +0 KB (motion already in bundle per `pos/DashboardLayout.tsx:84`) | low |

### 3.5 Viewport handling

| Cand. | T1 vp | T2 | T3 | T4 | T5 vv | T6 | T7 | T8 | T9 | T10 layout | T11 perf | IC | R | A | RU | B | CO |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `VP-W` meta + `100dvh` | ✓ Chrome 108+ shrinks layout vp (research §2.2) | n/a | n/a | n/a | ~ iOS Safari ignores `interactive-widget` (research §2.2) | n/a | n/a | n/a | n/a | ✓ no `100vh` traps if `100dvh` adopted (scan §4) | ✓ no JS listener cost | S | low | n/a | n/a | 0 KB | low (one meta line + class swaps) |
| `VP-V` `visualViewport` listener | ✓ cross-browser (research §5) | n/a | n/a | n/a | ✓ source of truth for kbd open (research §5.2) | n/a | n/a | n/a | n/a | ✓ feeds `--vvh` CSS var | ~ JS listener cost (negligible) | M | low | n/a | n/a | +0.2 KB (hook) | low |
| `VP-B` Both | ✓ best-of-both | n/a | n/a | n/a | ✓ | n/a | n/a | n/a | n/a | ✓ | ✓ | M | low | n/a | n/a | +0.2 KB | low |
| `VP-N` Neither | ✗ status quo (scan §6.4) | n/a | n/a | n/a | ✗ | n/a | n/a | n/a | n/a | ✗ | n/a | S | very high — fails T1, T5, T10 | n/a | n/a | 0 KB | n/a |

### 3.6 Safe-area scaffolding

| Cand. | T1 | T2 | T3 | T4 | T5 | T6 SA | T7 | T8 | T9 | T10 | T11 | IC | R | A | RU | B | CO |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `SA-G` globals.css utilities | n/a | n/a | n/a | n/a | n/a | ✓ centralised (`02-scan-styles.md §3`) | n/a | n/a | n/a | n/a | n/a | S | low | n/a | n/a | +0.1 KB | low |
| `SA-T` Tailwind v4 `@utility` | n/a | n/a | n/a | n/a | n/a | ✓ inline class authoring | n/a | n/a | n/a | n/a | n/a | S-M | low | n/a | n/a | +0 KB | low |
| `SA-P` per-component inline | n/a | n/a | n/a | n/a | n/a | ~ scattered, drift-prone | n/a | n/a | n/a | n/a | n/a | S | medium — drift like z-index today | n/a | n/a | +0 KB | medium |

### 3.7 Z-index tokenisation

| Cand. | T1 | T2 | T3 | T4 | T5 | T6 | T7 | T8 | T9 | T10 layout | T11 | IC | R | A | RU | B | CO |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `ZI-C` CSS variables | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | ✓ enforces stacking (`scan-layout §6`) | n/a | S | low | n/a | n/a | +0.2 KB | low |
| `ZI-T` Tailwind theme extend | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | ✓ first-class utility | n/a | S | low — Tailwind v4 supports `@theme inline { --z-modal:60 }` (`02-scan-styles.md §2.2`) | n/a | n/a | +0 KB | low |
| `ZI-S` TS const enum (lib/z-index.ts) | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | ~ exists but partly adopted (scan-layout §6) | n/a | S | low | n/a | n/a | +0 KB | low |
| `ZI-N` Status quo | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | ✗ confusing (`9998` collides w/ `5000`) | n/a | S | high | n/a | n/a | 0 KB | high |

### 3.8 Overlay coordination

| Cand. | T1 | T2 | T3 | T4 | T5 | T6 | T7 | T8 chat | T9 fm | T10 | T11 | IC | R | A | RU | B | CO |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `OC-S` mutex store | n/a | ✓ closes peers on open | n/a | n/a | n/a | n/a | ~ explicit close needed | ✓ chat ↔ admin no double-overlay (`02-scan-navigation.md §5.1`) | ✓ | n/a | n/a | M | low | ~ doesn't fix focus trap | n/a | +0.5 KB (Zustand) or +0 KB (React context) | medium — touches every overlay open/close |
| `OC-F` focus-trap-only | n/a | ~ a11y fix only | n/a | n/a | n/a | n/a | n/a | ✓ tab cycling | ✓ | n/a | n/a | S | low | ✓ closes a11y gap (`02-scan-navigation.md §7-6`) | n/a | +1.2 KB `focus-trap-react` | low |
| `OC-B` Both | n/a | ✓ | n/a | n/a | n/a | n/a | n/a | ✓ | ✓ | n/a | n/a | M | low | ✓ | n/a | +1.7 KB | medium |
| `OC-N` Neither | n/a | ✗ | n/a | n/a | n/a | n/a | n/a | ✗ chat+admin can collide | ✗ | n/a | n/a | S | medium | ✗ | n/a | 0 KB | n/a |

### 3.9 `Cmd+K` chord fix

| Cand. | T1 | T2 | T3 input | T4 | T5 | T6 | T7 | T8 chat | T9 | T10 | T11 | IC | R | A | RU | B | CO |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `CK-S` scope to non-input | n/a | n/a | ✓ kbd shortcut no longer steals from `ChatInput` (scan-nav §5.5, §7-7) | n/a | n/a | n/a | n/a | ✓ | n/a | n/a | n/a | S — 5-line patch to `SessionPanel.tsx:228-235` | low | n/a | n/a | +0 KB | low |
| `CK-D` move palette to dedicated context | n/a | ~ palette becomes available on all sections (scan-nav §6.6) | ✓ | n/a | n/a | n/a | n/a | ✓ | n/a | n/a | n/a | M | low | n/a | n/a | +0 KB | medium — refactor SessionPanel surface |
| `CK-B` Both | n/a | ~ | ✓ | n/a | n/a | n/a | n/a | ✓ | n/a | n/a | n/a | M | low | n/a | n/a | +0 KB | medium |

---

## 4. Per-candidate pros / cons (evidence-backed)

### 4.1 Input proxy

#### `IP-A` — Style xterm helper textarea on mobile

Pros:
- Zero changes to WS pipeline (`Terminal.tsx:213-221` untouched). `term.textarea` is a public field (`xterm.d.ts:822`, `02-scan-terminal.md §1`).
- Inherits xterm's `CompositionHelper` IME handling, paste handling, copy handling, and a11y for free (`03-research-xterm-proxy.md §1.6, §3 Recipe A`).
- ~30 LOC patch (research §3 Recipe A).
- xterm core already sets `autocorrect/autocapitalize/spellcheck="off"` on the helper textarea (research §1.6) — meets `03-research-terminal-ux.md §5.1` for free.

Cons:
- Helper textarea is empty after every keystroke (xterm clears it) → iOS autocorrect bar shows nonsense suggestions (research §3 Recipe A cons).
- Restyling internal xterm DOM is brittle to xterm version bumps (research §1.6, §3 Recipe A cons): xterm v6 reflows the textarea on resize and IME positioning.
- Cannot show typed-but-not-sent buffer (no echo-lag indicator) — irrelevant for `claude-tui` per planner Phase 7 brief.
- Modifier bar must inject via `term.input(byte, true)` only (no own input UI to host arrow buttons cleanly) — couples MB to xterm runtime.

#### `IP-B` — `<input>` + `term.input(data, true)`

Pros:
- WS pipeline untouched (`Terminal.tsx:213-221`); existing DA/CPR filter (`Terminal.tsx:217`) still applies (`02-scan-terminal.md §3.1, §7.1`).
- Full visual control of input bar — placeholder / send-state indicator / modifier bar render adjacent.
- `inputRef.current?.focus({preventScroll:true})` on `pointerdown` reliably opens iOS keyboard (research §3 Recipe B + research §2.6).
- `inputmode="text" enterkeyhint="send" autocapitalize="off" autocorrect="off" spellcheck={false}` covers all attribute targets in one place (research §2.3).
- Layered with composition handlers from `IP-D`, this is the hybrid the research §10 explicitly recommends as "B with D's composition handlers".

Cons:
- Outbox-style "ship every char immediately" breaks IME composition outright (research §3 Recipe B cons) — only viable when `IP-D` composition handlers are layered on top.
- ~10 special keys (Enter/Backspace/Tab/Esc/Arrows/Ctrl combos) need manual `onKeyDown` handling.
- `attachCustomKeyEventHandler(() => false)` cannot be removed — must replace with `() => true` on cleanup (research §1.4, §7).
- Lifts `xtermRef` to context → cascades to `Terminal.tsx`, `dashboard/page.tsx`, and the new MobileTerminalInput component.
- Samsung Keyboard skips `keydown` for letters (research §2.6), `<input>` `onChange` catches it but only on `IP-D`-style buffer.

#### `IP-C` — `<input>` bypassing xterm; raw `ws.send`

Pros:
- Pure render xterm — no `onData` re-entry, no double-send risk.
- Easiest to debug (single arrow: input → WS).

Cons (HARD CONFLICTS — see §5):
- **Bracketed-paste mode broken** (research §3 Recipe C cons). When shell enables `\x1b[?2004h`, xterm normally wraps clipboard pastes via `term.paste()`; raw `send(text)` does not — vim leaves insert mode, etc.
- **DA/CPR filter at `Terminal.tsx:217` is bypassed** for input; if any future code emits an inadvertent `\x1b[?...` sequence from the bar, server PTY echoes garbage (`02-scan-terminal.md §3.1`).
- **Local-echo modes break** — when shell tells xterm to render typed chars before round-trip, xterm has no chance.
- xterm's `disableStdin = true` does NOT block `term.input()` (research §1.5 footgun) — must combine with `attachCustomKeyEventHandler(() => false)` AND keep mouse reports on `onBinary` separately. Two-channel merge required.
- Forks the WS protocol literal between client and server — anything that needs to evolve the contract (e.g. a future `version` field) must be edited in two places.

#### `IP-D` — `<textarea>` + composition events + `term.input`

Pros:
- Correct CJK/emoji input; voice input (Gboard "voice typing", iOS dictation) ships full phrases at once via `compositionend` (research §3 Recipe D).
- Paste goes through `term.paste(text)` so bracketed-paste mode is honored (research §3 Recipe D + §6.4 Q4).
- Modifier bar still pipes into `term.input()`, single byte channel preserved.
- `<textarea>` allows multi-line composition (handy for "paste a JSON blob then submit").
- `e.data` fallback to `taRef.current?.value` covers Samsung kbd's empty `compositionend.data` edge case (research §3 Recipe D cons).

Cons:
- During long compositions the user sees a draft that hasn't reached the PTY → fish/zsh-syntax-highlighting feedback delayed until composition completes (research §3 Decision 5).
- ~110 LOC vs ~80 for `IP-B` (research §3 Recipe D).
- `<textarea>` needs `rows={1}` and `resize-none` (research §3 Recipe D code) to look like a single-line input.
- Same `attachCustomKeyEventHandler` cleanup limitation as `IP-B`.

#### `IP-E` — `contenteditable` overlay + `beforeinput`

Pros:
- Modern web-input event model — `beforeinput` is standardized and reliable on iOS Safari 16+ and Chrome 110+ (research §3 Recipe E).
- Native long-press → select → copy/paste menu works out of the box (terminal-ux §5.3 variant 1).
- Can host inline rich-text affordances (chip-rendering modifier-key tags like "⌃ + R") — research §3 Recipe E pros.
- Some Android keyboards emit `input` on CE more reliably than on `<input>` (research §3 Recipe E pros).

Cons:
- React doesn't track `contenteditable` — must use `suppressContentEditableWarning` and manage children only via refs (research §3 Recipe E cons).
- `inputmode`/`enterkeyhint`/`autocorrect` work on CE but with less consistency than on `<input>`/`<textarea>` (research §3 Recipe E cons).
- CE selection competes with xterm's own selection handler (`02-scan-terminal.md §6.5`) — needs explicit `pointer-events` partitioning.
- Voice input via Gboard mic still inserts entire phrases requiring diff-to-keypresses (terminal-ux §3 Pattern C cons).

### 4.2 Modifier bar

#### `MB-T` — Termux JSON schema

Pros:
- Industry-standard syntax (`[[ROW1],[ROW2]]` plus `{key, popup, display, macro}`, terminal-ux §1.1) — adopted by Termux:GUI, Acode, Flutter clones.
- User-customisable from day one — meets terminal-ux §4.4 "claude-terminal users include people running long Claude sessions".
- Macro support (`{macro: "CTRL f BKSP"}`) directly enables Claude Code chord launcher (planner #4).

Cons:
- Schema parsing + validation is +1-2 KB.
- UI for editing JSON is itself a sub-feature (likely Phase 8+ polish).
- Layout decisions (rows, popup density) still open even with schema in place.

#### `MB-B` — Blink-style gestures

Pros:
- Tap=one-shot, long-press=lock, hold=auto-repeat are user-tested on the most polished mobile-terminal accessory bar in the wild (terminal-ux §1.2).
- Sticky modifier toggles match planner Tier 1 list (planner #4).
- Page-toggle for symbols ↔ F-keys preserves single-row footprint (terminal-ux §1.2 layout table).

Cons:
- `UILongPressGestureRecognizer` semantics map awkwardly to web pointer events; need careful `pointerdown` + `setTimeout` for hold detection, with cancellation on `pointermove` past threshold.
- Auto-repeat (every 0.5 s, then 0.1 s — terminal-ux §1.2) requires its own RAF loop.
- Gesture recognizer collision with xterm `onPaste` (`Terminal.tsx:336-359`).

#### `MB-R` — Custom React row, fixed key list

Pros:
- Smallest patch — direct mapping from planner #4 Tier 1+2 (Esc/Tab/Ctrl/Alt/arrows/^C/^D/^L/⇧Tab).
- 44 px tap targets trivially achievable.
- ARIA `role="toolbar"` + `aria-label="Modifier keys"` covers a11y.
- Russian/English label-agnostic — uses universal symbols (`⌃`, `⌥`, `↑`, `^C`).

Cons:
- 8 Tier-1 keys exceed one row at 360 px with 44 px buttons + 4 px gap (terminal-ux §4.3) — must drop one or move to row 2.
- Not user-customisable without `MB-T` schema layered on top.
- No popup variants (Termux's `{key:'-', popup:'|'}` semantics) — symbols accessible only via OS keyboard.

#### `MB-S` — Swipeable two-row

Pros:
- Solves the 360 px row-1 overflow by promoting symbols/F-keys to row 2 (terminal-ux §4.3).
- ARIA `role="tablist"` per page is a clean a11y story.

Cons:
- Swipe gesture conflicts with xterm two-finger scroll inside the terminal (terminal-ux §1.2) — must be horizontally swipeable but only when pointer is inside the bar.
- Vertical space cost = 2 rows × 44 px = 88 px (vs 44 px for `MB-R`) — eats into terminal canvas.
- Bad for screen readers (research §4.3 final bullet).

#### `MB-N` — None

Pros:
- Zero work.

Cons:
- **Fails T4 outright.** No `Esc`/`Tab`/`Ctrl`/arrows reachable from soft keyboard alone (terminal-ux §0).
- VS Code Web shipped this and openly admits it's broken (terminal-ux §1.9, §2.5) — explicit negative reference.

### 4.3 Nav consolidation

#### `NV-A` — Bottom-tab (4) + hamburger overflow

Pros:
- Extends existing `MobileBottomBar.tsx:56` baseline minimally.
- One-tap top-level switching for the 4 most-used surfaces.
- Discoverable — labels visible (predictable thumb zone).
- Hamburger handles long tail without taking precious bottom real estate.

Cons:
- Tab bar costs ~80 px persistent vertical (modifier bar 44 + tab bar 56 + keyboard 280 ≈ 380 px gone before terminal renders) on 360×640 device — a 41% cut to terminal canvas height (research §4 Combo A cons).
- "Sessions as tab" is unusual (sessions are usually nav, not destinations) — risk of confusion vs current `pos/SessionPanel.tsx` mental model.
- 4 RU labels at 360 px need `text-[10px]` (matches existing `MobileBottomBar.tsx:67`) — readable but tight.
- Conflict with current `MobileBottomBar`'s 4 sections (sessions/hub/symphony/system + Ещё): need to choose between **renaming current tabs** (sessions/chat/files/sessions=workspace) or **stacking two bars** (impossible).

#### `NV-B` — Top app-bar + bottom-sheet sessions + slide-over chat

Pros:
- Maximum vertical real estate for the terminal (no bottom tab bar) — best for T11.
- Modern app feel matching Maps / Uber / Linear web (research §4 Combo B).
- Session switching is single tap on visible session name in app-bar.
- ChatPanel slide-over keeps terminal in peripheral vision while scrolling chat.

Cons:
- Two distinct gesture surfaces to learn (sheet from bottom, slide-over from right) — discoverability hit.
- Adds `vaul` (~34 KB) if drag-to-close is wanted (research §3.1).
- FileManager and Chat compete for the right-side slide-over slot.
- Diverges most from existing `MobileBottomBar` — biggest delete-and-rebuild.

#### `NV-C` — Bottom-tab (3) + side drawer

Pros:
- Smaller, simpler tab bar (3 items: Terminal / Chat / More).
- Sessions live in drawer where they belong (workspace-level nav).
- Very discoverable hamburger + clear destinations.

Cons:
- Two-step access for FileManager (More → Files) — extra tap.
- "More" tab is overflow, a code smell.
- Hamburger + bottom-tab is unusual on iOS (Material does it; iOS HIG discourages — research §4 Combo C cons).

#### `NV-D` — Tab-stack collapse, no chrome

Pros:
- Maximum simplicity. Zero persistent chrome on terminal screen.
- Mirrors Slack web mobile and Linear web mobile (research §2.1, §2.9).
- Back-button / swipe-back is the navigation gesture — known to iOS/Android users.

Cons:
- **AdminPanel needs a different mount.** Today it's a slide-over from `dashboard/page.tsx:494-506` — in NV-D there's no chrome to host the toggle. Either becomes a push-view from root, or an FAB on the terminal screen, or a hamburger overflow → contradicts "no chrome".
- Two-tap to switch sessions (back, tap new session). No always-visible session indicator unless added to app-bar (research §4 Combo D cons).
- Re-architects `dashboard/page.tsx`'s `workspaceView` discriminated union (`02-scan-navigation.md §2`) — highest impl cost.

### 4.4 Sheet / drawer library

#### `SH-V` — `vaul`

Pros:
- Best-in-class drag gesture with velocity threshold (research §3.1).
- Inherits Radix Dialog focus trap, `aria-modal`, Esc handling.
- shadcn's `Drawer` is a thin wrapper on vaul — community-tested patterns.

Cons:
- +34 KB gzip (vaul + Radix Dialog dep, research §3.1).
- Occasional SSR warnings with Next.js (resolved in vaul 0.9+ but worth pinning).
- Not a Material/iOS clone — neutral styling requires Tailwind work.

#### `SH-R` — `@radix-ui/react-dialog`

Pros:
- ~22 KB, headless, industry-leading a11y (research §3.2).
- Already in shadcn Sheet wrapper.
- Composable parts → easy to fit existing `ModalTitleBar.tsx` pattern (`02-scan-navigation.md §1.4`).

Cons:
- No drag-to-close — chat looks "modal" not "sheet" on mobile.
- Slide-out animations are user's responsibility (use `data-state` attrs).

#### `SH-A` — Aceternity Sheet

Pros:
- Eye-candy animations (matches existing `aurora-background.tsx`, `lamp.tsx` decoration aesthetic).

Cons:
- +80 KB+ deps including framer-motion (research §3.4).
- Mixed a11y audit per researcher (research §3.4).
- Opinionated styling fights with claude-terminal's Geist palette.

#### `SH-C` — Custom (existing framer-motion)

Pros:
- +0 KB — `motion/react` already bundled (`pos/DashboardLayout.tsx:84` uses `motion.div`).
- Full control over animation curves to match Geist aesthetic.
- Existing slide-overs (`dashboard/page.tsx:494-521`) already use `motion.div` pattern — coherent extension.

Cons:
- No focus trap unless added (current slide-overs lack focus traps per `02-scan-navigation.md §1.3, §7-6`).
- Drag-to-close needs handcrafting; snap points need physics tuning.
- Risk of subtly wrong scroll-lock / Esc handling.

### 4.5 Viewport handling

#### `VP-W` — Meta hint + `100dvh`

Pros:
- Chrome 108+ shrinks layout viewport when keyboard opens — `100dvh` re-layout is automatic (research §2.2).
- Single `<meta>` line in `app/layout.tsx` Metadata `viewport` export.
- `viewport-fit=cover` enables `env(safe-area-inset-*)` (research §2.2) — synergises with `SA-G/T`.

Cons:
- iOS Safari ignores `interactive-widget` (research §2.2) — only half-fixes the keyboard problem.
- Need to migrate every `h-screen` (`pos/DashboardLayout.tsx:49,53`) and arbitrary `[100vh]` (`globals.css`-noted `aurora-background.tsx`, `app/global-error.tsx`) to `dvh` — small but pervasive change.

#### `VP-V` — `visualViewport` listener

Pros:
- Cross-browser (research §5).
- Source-of-truth for keyboard open/close (research §5.2).
- Drives `--vvh`/`--kbd-height` CSS vars used by modifier-bar positioning (research §6.4 Q3 + §5.2 recipe).

Cons:
- iOS Safari `visualViewport.resize` fires after keyboard animation completes (~300 ms, research §5 cross-browser notes) — momentary jank during keyboard-open.
- Tiny JS listener cost (negligible).

#### `VP-B` — Both

Pros:
- Best-of-both: meta hint covers Chrome path automatically; listener catches iOS.
- Recommended as the cross-app convergent recipe (terminal-ux §5.2).

Cons:
- Two systems to keep in sync.

#### `VP-N` — Neither

Pros: zero work.
Cons: **Fails T1, T5, T10 outright** — current state from `02-scan-styles.md §1, §4, §8`.

### 4.6 Safe-area scaffolding

#### `SA-G` — globals.css utilities

Pros:
- Centralised — drift-resistant (`02-scan-styles.md §3` notes 0 hits today).
- Pairs naturally with existing `globals.css` theme tokens.
- One-line edit to fix every fixed-position mobile element (`pos/MobileBottomBar.tsx:56`, `pos/DashboardLayout.tsx:88`, etc. listed in `02-scan-styles.md §7`).

Cons:
- Requires authors to know / use the helpers (vs inline).

#### `SA-T` — Tailwind `@utility`

Pros:
- Inline class authoring — matches Tailwind-first convention.
- Tailwind v4 supports `@utility` directive (`02-scan-styles.md §2.2`).

Cons:
- Slightly more setup (declare in `globals.css`'s `@theme` block).

#### `SA-P` — Per-component

Pros: localised.
Cons: drift like z-index today (`02-scan-layout.md §6`).

### 4.7 Z-index tokenisation

#### `ZI-C` — CSS variables

Pros:
- Theme-friendly, works with `z-[var(--z-modal)]`.
- Single source of truth in `globals.css`.

Cons:
- Verbose at call site.

#### `ZI-T` — Tailwind theme extend

Pros:
- First-class utility (`z-modal`, `z-popup`).
- Tailwind v4 `@theme inline { --z-modal: 60 }` syntax (`02-scan-styles.md §2.2`).

Cons:
- Tailwind theme keys for z-index need explicit declaration.

#### `ZI-S` — TS const enum (existing)

Pros:
- File already exists at `src/lib/z-index.ts:20-39` (`02-scan-layout.md §6`).
- Works in inline `style={{ zIndex: Z.MODAL }}`.

Cons:
- Doesn't help Tailwind class strings — those still need `z-[60]` or migration to `ZI-T`.
- Currently only partly adopted — comments `/* Z.MODAL */` next to literals (`02-scan-navigation.md §3.4`).

#### `ZI-N` — Status quo

Pros: zero work.
Cons: 8 distinct literal layers (10/20/30/40/50/60/100/9998) with no semantic anchor.

### 4.8 Overlay coordination

#### `OC-S` — Mutex store

Pros:
- Closes the documented chat ↔ admin double-overlay bug (`02-scan-navigation.md §5.1`).
- Each overlay registers an open-id + close-handler.
- Composable with existing `NavigationContext` pattern (`02-scan-navigation.md §2`).

Cons:
- Touches every overlay open/close site (5+ in `dashboard/page.tsx`, plus `IconRail.tsx`'s HotkeysModal).
- Doesn't fix focus-trap a11y (separate concern).

#### `OC-F` — focus-trap-only

Pros:
- Closes a11y gap (`02-scan-navigation.md §1.3, §1.4, §7-6`).
- Library `focus-trap-react` is +1.2 KB.

Cons:
- Doesn't prevent overlapping overlays (state collision unchanged).

#### `OC-B` — Both

Pros: complete.
Cons: +1.7 KB and medium impl effort.

#### `OC-N` — Neither

Pros: zero work.
Cons: latent bug per `02-scan-navigation.md §5.1` (chat over admin), no a11y improvements.

### 4.9 `Cmd+K` chord clash fix

#### `CK-S` — Scope to non-input

Pros:
- 5-line patch to `SessionPanel.tsx:228-235`: check `e.target.tagName !== "INPUT" && e.target.tagName !== "TEXTAREA"` and `!e.target.isContentEditable`.
- Closes the documented bug (`02-scan-navigation.md §5.5, §7-7`).

Cons:
- Doesn't address: palette is unavailable on non-`sessions` sections (`02-scan-navigation.md §6.6`).

#### `CK-D` — Move to dedicated context

Pros:
- Palette becomes available on all sections (`02-scan-navigation.md §6.6`).
- Decouples from SessionPanel mount lifecycle.

Cons:
- Refactor surface — touches `SessionPanel.tsx:78-80, 228-235, 459-468, 484-540` plus dashboard mount.
- Still needs `CK-S`'s scope guard inside the new context.

#### `CK-B` — Both

Pros: complete fix.
Cons: medium impl effort.

---

## 5. Hard conflicts

These are candidate combinations where one excludes another. The arbiter must not pick conflicting candidates.

1. **`IP-C` ⊥ `term.paste`-dependent flows.** Recipe C bypasses xterm so `term.paste()` is unreachable for clipboard. If clipboard paste must honor bracketed-paste mode (`\x1b[?2004h` / `\x1b[200~ ... \x1b[201~`), `IP-C` cannot be picked alongside any clipboard-paste requirement. The existing image-paste handler at `Terminal.tsx:336-359` would also need to grow to handle text-paste. Conflicts with the existing `term.write` round-trip via `onData` (scan-terminal §3.1).

2. **`IP-C` ⊥ DA/CPR filter at `Terminal.tsx:217`.** Filter only protects bytes flowing through `term.onData`; raw `ws.send` from `IP-C` skips it. If any bar key emits `\x1b[?...` (e.g. user adds a custom macro), server PTY gets it and tmux's auto-replies cycle. Cannot pick `IP-C` without duplicating the filter in the WS-bypass path.

3. **`NV-D` ⊥ existing AdminPanel mount.** Combo D (no chrome) leaves no Navbar to host the AdminPanel toggle (`Navbar.tsx:144-160` consumed by `dashboard/page.tsx:377`). Three exits: (a) become a push-view from root list, (b) become an FAB on terminal screen, (c) hamburger overflow — but (c) contradicts "no chrome". Picking `NV-D` forces re-architecting `02-scan-navigation.md §6.5` (HotkeysModal lives in IconRail, IconRail goes away in NV-D).

4. **`MB-N` ⊥ T4.** Without a modifier bar, `Esc/Tab/Ctrl/Alt/arrows` are unreachable from the soft keyboard alone (terminal-ux §0). Picking `MB-N` automatically fails Mobile UX Target #4.

5. **`VP-N` ⊥ T1, T5, T10.** Status quo `flex h-screen` (`pos/DashboardLayout.tsx:49,53`) pushes content out of viewport on iOS keyboard open (`02-scan-styles.md §4` "critical trap"). No path exists to satisfy these targets without `VP-W`, `VP-V`, or `VP-B`.

6. **`SH-A` ⊥ bundle-size budget.** +80 KB+ for Aceternity (research §3.4) is incompatible with planner Phase 11 implicit perf targets and clashes with the project's lean 113-utility responsive surface (`02-scan-styles.md §5`).

7. **`MB-S` ⊥ xterm two-finger scroll.** Swipeable bar inside terminal capture zone collides with xterm's built-in two-finger scrollback gesture (terminal-ux §1.2 Blink, §1.1 Termux). Need pointer-routing partition: bar swipe vs terminal scroll.

8. **`OC-N` ⊥ NV-A/NV-C admin+chat tabs.** Without mutex (`OC-S`/`OC-B`), chat and admin can both be "open" — in NV-A/NV-C they'd be two simultaneous active tabs. Bottom-tab UI cannot represent that.

9. **`IP-A` ⊥ visible cursor / IME composition feedback below the kbd line.** Helper textarea is empty after every keystroke (research §3 Recipe A cons) — no native iOS suggestion bar surface for autocorrect.

10. **`ZI-N` ⊥ adding `MobileBottomBar` overflow popover at `z-50` next to chat slide-over at `z-50`.** Status quo's two `z-50` siblings (`MobileBottomBar.tsx:38` vs `dashboard/page.tsx:498,513`) already collide; adding new sheets without tokens widens the pile.

11. **`CK-B` ⊥ time-budget for "Minimal" bundle.** `CK-D` (move palette to dedicated context) is medium-effort refactor; for Minimal bundle only `CK-S` (scope guard) is justifiable.

---

## 6. Recommended bundles

Each bundle is a coherent, conflict-free combination. Per-target verdicts (PASS = meets target, PARTIAL = workable but with caveat, FAIL = does not meet) sum to the bundle's overall fitness.

### 6.1 Bundle "Minimal"

> Smallest change that reaches PASS on all 11 UX Targets.

Picks: `IP-B + IP-D` (combined: textarea calling `term.input` with composition handlers) · `MB-R` (custom React row) · `NV-baseline` (keep `MobileBottomBar` as-is, extend with new entries for chat/admin shortcuts) · `SH-C` (custom — uses existing framer-motion) · `VP-B` (meta + listener) · `SA-G` (globals utilities) · `ZI-T` (Tailwind theme extend) · `OC-N` (defer — known bug accepted) · `CK-S` (scope guard only).

Per-target verdict:

| Target | Verdict | Rationale |
|---|---|---|
| T1 viewport coverage | PASS | `VP-B` + `dvh` fix in `pos/DashboardLayout.tsx:49,53` covers iOS+Android |
| T2 single mobile nav | PARTIAL | Existing `MobileBottomBar` + Navbar hamburger remains; no new nav surface added — already meets "single mobile nav surface" if we accept current dual-mode (hamburger+bar) as the consolidated surface |
| T3 terminal input proxy | PASS | `IP-B+D` covers Latin, IME, voice, paste |
| T4 modifier bar | PASS | `MB-R` Tier 1+2 keys above keyboard via `visualViewport`-bottom anchor |
| T5 visualViewport-aware | PASS | `VP-V` + listener |
| T6 safe-area insets | PASS | `SA-G` utilities applied to MobileBottomBar, slide-overs, modifier bar |
| T7 touch ergonomics | PASS | `MB-R` 44 px buttons; `Navbar.tsx` icon-button bumps already at `p-2` (36 px today; needs uplift in `impl-mobile-navigation` to hit 44) |
| T8 chat mobile mode | PARTIAL | Current chat slide-over already exists; needs `text-base` (16 px) on `ChatInput.tsx:203` to fix iOS zoom + safe-area pad |
| T9 file manager mobile | PASS | Existing `useIsMobile` swap to `MOBILE_COLUMNS` already adequate (scan-nav §1.6) |
| T10 no layout breakage | PASS | `dvh` migration kills `100vh` traps |
| T11 performance | PASS | Existing `FitAddon` + `ResizeObserver`; add debounce on `visualViewport.resize` |

Total impl cost: ~250-350 LOC.

Files touched (new):
- `src/lib/useVisualViewport.ts` (new — research §5 hook).
- `src/lib/mobile-input.ts` (new — KEYS map per research §3 prelude).
- `src/components/MobileTerminalInput.tsx` (new — IP-B+D).
- `src/components/ModifierKeyBar.tsx` (new — MB-R).
- `src/contexts/TerminalIOContext.tsx` (new — lifts `xtermRef`/`wsRef` per scan-terminal §7.4).

Files touched (edits):
- `src/app/layout.tsx` — add `viewport` Metadata export (VP-W).
- `src/app/globals.css` — add safe-area utilities (SA-G), z-index Tailwind theme entries (ZI-T), `--vvh` CSS var consumer.
- `src/components/Terminal.tsx:213-221, 254, 425-428` — wire `TerminalIOProvider`, attach `pointerdown` to focus mobile input.
- `src/components/pos/DashboardLayout.tsx:49,53` — `h-screen` → `h-dvh` or `var(--vvh)`.
- `src/app/dashboard/page.tsx:404` — wrap in `TerminalIOProvider`.
- `src/components/pos/SessionPanel.tsx:228-235` — `CK-S` scope guard (5 lines).
- `src/components/chat/ChatInput.tsx:203` — `text-sm` → `text-base`.
- `src/components/Navbar.tsx:130, 144, 151, 164, 171` — bump to 44 px tap targets.

New deps: **none**.
Bundle delta: **+0 KB** (everything either uses existing motion or is custom code).

Risk surface:
- Mutex coordination not added (`OC-N` accepted) → chat ↔ admin can still double-open. Live bug, not a regression.
- iOS Safari `visualViewport.resize` post-animation jank (~300 ms) is observable.

### 6.2 Bundle "Polished"

> Minimal + drag-sheets, z-index tokens, overlay coordination.

Picks: Minimal **plus** `SH-V` (vaul drawer for Sessions) · `SH-V` (bottom-sheet for ChatPanel — same lib) · `ZI-T` already in Minimal · `OC-S` (mutex store) · `CK-S` already in Minimal.

Per-target verdict:

| Target | Verdict | Δ from Minimal |
|---|---|---|
| T1 | PASS | unchanged |
| T2 | PASS | drag-to-open Sessions sheet upgrades nav from "two surfaces" to one obvious gesture |
| T3 | PASS | unchanged |
| T4 | PASS | unchanged |
| T5 | PASS | unchanged |
| T6 | PASS | sheet bottoms get `pb-safe` automatically via vaul + SA-G |
| T7 | PASS | drag-to-close adds gesture-richness |
| T8 | PASS | chat as proper bottom-sheet with snap points `[0.4, 0.9]` |
| T9 | PASS | unchanged |
| T10 | PASS | unchanged |
| T11 | PASS | vaul uses pointer events natively, no jank on iOS |

Total impl cost: ~500-700 LOC.

Files touched (new, additional to Minimal):
- `src/contexts/OverlayCoordinationContext.tsx` (new — OC-S mutex).
- `src/components/mobile/SessionSheet.tsx` (new — vaul wrapper around existing `SessionPanel`).
- `src/components/mobile/ChatSheet.tsx` (new — vaul wrapper around existing `ChatPanel`).

Files touched (edits, additional):
- `src/app/dashboard/page.tsx:494-521` — replace mobile slide-over wrappers with vaul sheets, wire to mutex store.
- `src/lib/z-index.ts` — extend `Z` const to cover sheet z-layer.

New deps: **`vaul` + `@radix-ui/react-dialog`** (vaul depends on Radix).
Bundle delta: **+34 KB gzip**.

Risk surface:
- vaul SSR warnings if not pinned to ≥0.9.
- Mutex refactor touches every overlay open/close site — coordination with `impl-overlays-chat-files` agent required.

### 6.3 Bundle "Native-feeling"

> Polished + Termux schema + Blink gestures + haptic hints + animated kbd tracker.

Picks: Polished **plus** `MB-T` (Termux JSON schema for user-customisable bars) · `MB-B` (Blink-style gestures: tap/long-press/hold) · haptic via `navigator.vibrate(20)` on bell + key-press · animated keyboard tracker (transform-based smoothing of the visualViewport delta).

Per-target verdict:

| Target | Verdict | Δ from Polished |
|---|---|---|
| T1 | PASS | unchanged |
| T2 | PASS | unchanged |
| T3 | PASS | unchanged |
| T4 | PASS | upgraded — Tier 3 keys (F-keys, symbols, macros) accessible via long-press / page swipe |
| T5 | PASS | smoothed via animation frame interpolation |
| T6 | PASS | unchanged |
| T7 | PASS | upgraded — gesture vocabulary matches Blink |
| T8 | PASS | unchanged |
| T9 | PASS | unchanged |
| T10 | PASS | unchanged |
| T11 | PARTIAL | RAF interpolation + auto-repeat timers add a small CPU baseline; benchmark on mid-range Android required to confirm ≥50 FPS during scroll |

Total impl cost: ~1100-1500 LOC.

Files touched (new, additional to Polished):
- `src/lib/extra-keys-schema.ts` (new — Termux JSON parser per terminal-ux §1.1).
- `src/lib/use-haptics.ts` (new — wraps `navigator.vibrate`).
- `src/lib/use-keyboard-tracker.ts` (new — RAF-smoothed `visualViewport` deltas).
- `src/components/ModifierKeyEditor.tsx` (new — UI to edit the JSON bar config).

Files touched (edits, additional):
- `src/components/ModifierKeyBar.tsx` — schema-driven render, gesture handlers.
- `src/components/Terminal.tsx` — `term.onBell` listener for haptic.

New deps: **none additional** (Termux schema is hand-rolled JSON; haptics is `navigator.vibrate` native).
Bundle delta: **+34 KB gzip** (same as Polished — only authored code added).

Risk surface:
- Auto-repeat / long-press gesture state machine needs careful cancellation on pointer-up / pointer-cancel to avoid stuck modifiers.
- JSON-edit UI is a sub-feature → may slip to Phase 8+ polish wave.
- Per-app modifier-bar profiles (terminal-ux §5.5) NOT included — flagged for future polish.

---

## 7. Decisions punted to Phase 5 (the arbiter)

Each binary/multi-choice the arbiter must close in `05-decisions.md`:

1. **Input proxy recipe** — `IP-A` / `IP-B` / `IP-C` / `IP-D` / `IP-E`. Recommended: `IP-B+IP-D` blend (research §10). `IP-C` should be excluded by hard conflict.
2. **Modifier bar architecture** — `MB-R` only (Minimal) vs `MB-R + MB-T` (data-driven, Polished+) vs `MB-S` (swipe page) vs `MB-B` (gesture vocabulary). Recommended: pick `MB-R` for Phase 7, schedule `MB-T` for Phase 8 polish.
3. **Modifier bar key list (final lock)** — planner #4 lists Tier 1 (Esc/Tab/Ctrl/Alt/arrows) + Tier 2 (^C/^D/^L/⇧Tab + chord launcher). Arbiter must lock the exact 8-12 keys (Tier 1 already overflows one row at 360 px — drop one or move to Tier 2 row 2).
4. **Nav consolidation combo** — `NV-A` / `NV-B` / `NV-C` / `NV-D`. Status quo `MobileBottomBar` baseline maps closest to `NV-A` and `NV-C`; arbiter must declare whether the existing 4 tabs (sessions/hub/symphony/system) keep their meaning or shift to (terminal/chat/files/sessions) per Combo A.
5. **Sheet/drawer library** — `SH-V` / `SH-R` / `SH-C` (Aceternity excluded by bundle-size hard conflict). Recommended: `SH-V` for Polished+, `SH-C` for Minimal.
6. **Viewport handling** — `VP-W` / `VP-V` / `VP-B` (`VP-N` excluded by hard conflict). Recommended: `VP-B` (cheap belt-and-braces).
7. **Safe-area scaffolding** — `SA-G` / `SA-T` / `SA-P`. Recommended: `SA-G` (globals.css utilities) for least drift.
8. **Z-index tokenisation** — `ZI-C` / `ZI-T` / `ZI-S` / `ZI-N`. Recommended: `ZI-T` (Tailwind theme extend) — first-class `z-modal`/`z-popup` classes work everywhere.
9. **Overlay coordination** — `OC-S` / `OC-F` / `OC-B` / `OC-N`. Recommended: defer to Polished+ as `OC-S`; ship Minimal with `OC-N` accepting the known chat ↔ admin double-overlay bug.
10. **`Cmd+K` clash fix** — `CK-S` / `CK-D` / `CK-B`. Recommended: `CK-S` for Minimal (5-line patch); `CK-D` only if `CommandPalette` is also being lifted out of `SessionPanel.tsx` for other reasons.
11. **Tablet (≥768 px) behavior** — keep current desktop layout (planner brief says yes), or design a middle-ground tablet pattern? Research §5 flag (`03-research-nav-patterns.md §5 #4`).
12. **Persistent vs only-on-focus modifier bar** — terminal-ux §4.4 lists 4 variants. Arbiter must pick default + setting toggle.
13. **Bracketed-paste preservation** — explicit yes/no. If yes, `IP-C` is permanently out (already flagged §5 conflict 1).
14. **MobileBottomBar tab semantics** — keep current 4 (sessions/hub/symphony/system) or repurpose to (terminal/chat/files/workspace)? This is the crux of `NV-A` adoption.
15. **HotkeysModal mount migration** — currently lives in `IconRail.tsx:27, :97` (`02-scan-navigation.md §6.5`). If `NV-D` is picked, IconRail goes away; HotkeysModal needs a new owner.
16. **Touch tap-target uplift policy** — bump every `p-2` icon button (currently 36 px) to `p-2.5` or `p-3` (44 px)? This is a Tailwind-wide sweep across `Navbar.tsx:130-171`, `pos/SessionPanel.tsx:633-656`, etc. (12+ sites identified in `02-scan-navigation.md §1.1, §1.2`).

---

## 8. Cross-references

- Existing `src/lib/z-index.ts:20-39` token file — partial baseline for `ZI-S`/`ZI-T`.
- Existing `src/lib/useIsMobile.ts:4-13` (768 px threshold) — reuse rather than introducing new `useMediaQuery`.
- `src/components/pos/MobileBottomBar.tsx:7-18` — `MAIN_TABS` / `MORE_TABS` constants are the data hooks for any nav refactor.
- `src/lib/NavigationContext.tsx:5,48-60` — only existing nav-state context; safe channel for new section-level state.
- `dashboard/page.tsx:404` — `TerminalScrollProvider` mount; natural sibling for the new `TerminalIOProvider`.
- `terminal-manager.js:518-525` (persistent), `:784-788` (ephemeral) — server-side write-to-PTY contract; do NOT touch.
- Sister tmux-streaming scan: `agent-workflow/02-scan-tmux-stream.md` — out of scope here.

---

## 9. Sanity-check checklist for the arbiter

Before signing `05-decisions.md`, ensure:

- [ ] Picked input proxy is **not** `IP-C` (else explicitly justify breaking bracketed-paste, DA filter, and contract symmetry).
- [ ] Picked nav combo is compatible with `IconRail.tsx:97`'s ownership of HotkeysModal (else punt to Phase 7 to refactor).
- [ ] Modifier-bar key list is **explicitly enumerated** (not "Tier 1") and fits 360 px width given chosen 44 px tap target.
- [ ] If `OC-N` is kept, the known chat ↔ admin double-overlay bug is documented as accepted.
- [ ] `viewport` Metadata export string is **frozen verbatim** (per planner Phase 5 deliverables).
- [ ] Breakpoint map is **frozen** (planner suggests `mobile <768`, `tablet 768-1023`, `desktop ≥1024` — confirm).
- [ ] Bundle-size delta is acknowledged (Polished/Native-feeling = +34 KB; Minimal = +0 KB).
- [ ] Tap-target sweep policy (decision #16) is closed.

---

End of `04-tradeoffs-mobile.md`.
