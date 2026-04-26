# Mobile Adaptive Overhaul — Agent Roster

> Planner output. Phases 2–10 will spawn the agents below in waves.
> Branch: `feat/tmux-streaming-and-mobile`. Output dir for all artifacts: `agent-workflow/`.

---

## Mobile UX Targets (acceptance criteria the team must hit)

1. **Viewport coverage**: works flawlessly on iOS Safari 16+ and Android Chrome 110+ at 360×640 up to 430×932; tablet (≥768px) falls back to current desktop layout.
2. **Single mobile nav surface**: Navbar + SessionList consolidated. Decision space: bottom-tab-bar + slide-over drawer, OR top-AppBar + bottom-sheet sessions. Phase 5 picks one.
3. **Terminal input proxy**: a real `<input>` (or `contenteditable`) bound to the OS keyboard, keystrokes piped to PTY in real-time via the existing WebSocket. Backspace, Enter, IME composition, autocorrect-off, autocapitalize-off, spellcheck-off all behave correctly. The xterm.js canvas remains a render surface only on mobile.
4. **Modifier bar above keyboard**: sticky toolbar exposing at minimum `Esc`, `Tab`, `Ctrl`, `Alt`, `↑↓←→`, `Ctrl+C`, `Ctrl+D`, `Ctrl+L`, and a chord launcher for Claude Code commands (`Ctrl+R`, `Shift+Tab`). Final key list locked in Phase 5.
5. **`visualViewport`-aware layout**: when the soft keyboard opens, the input row sits flush against the top of the keyboard, terminal scrolls to the cursor, ChatPanel/Drawer never get covered.
6. **Safe-area insets**: `env(safe-area-inset-*)` respected for notch, Dynamic Island, and home-indicator; status-bar zone never overlaps content.
7. **Touch ergonomics**: tap targets ≥44×44 CSS px, no hover-only affordances, swipe-to-open drawer with edge-gesture, pull-to-refresh disabled inside terminal.
8. **ChatPanel mobile mode**: opens as full-height bottom sheet or full-screen overlay, never squeezes the terminal column to <320px.
9. **FileManager mobile mode**: usable on touch (list view, big rows, swipe actions, modal previews).
10. **No layout breakage**: zero horizontal scroll at any viewport, no `100vh` traps (use `100dvh` / `visualViewport.height`).
11. **Performance**: terminal resize debounced; no layout thrash on keyboard open/close; FPS ≥ 50 during scroll on mid-range Android.

---

## Phase 2 — Architecture Scan (4 agents, parallel)

### `scanner-layout-topology`
- **Role**: Map current dashboard layout tree, grid/flex topology, and where width/height assumptions are baked in.
- **Inputs**: source files listed in planner brief.
- **Outputs**: `agent-workflow/02-scan-layout.md` — markdown with ASCII layout tree, list of every fixed-px width, every `100vh`/`100vw`, breakpoints actually in use.
- **Tools**: Read, Grep, Bash (for `wc -l`, `find`).
- **Decisions to close**: Is the dashboard a CSS Grid, flex row, or absolute-positioned panels? Where does horizontal scroll come from at <768px today?
- **Dependencies**: none.

### `scanner-navigation-components`
- **Role**: Catalogue Navbar.tsx, SessionList.tsx, AdminPanel.tsx, HotkeysModal.tsx — props, state owners, open/close handlers, z-index stacking.
- **Inputs**: same as above.
- **Outputs**: `agent-workflow/02-scan-navigation.md` — per-component table (props, callbacks, current breakpoint behavior, accessibility attributes).
- **Tools**: Read, Grep.
- **Decisions to close**: Which component owns "active session" state? Is SessionList already collapsible? Does Navbar have a hamburger trigger today?
- **Dependencies**: none.

### `scanner-terminal-internals`
- **Role**: Document Terminal.tsx + EphemeralTerminal.tsx — xterm instantiation, FitAddon usage, WebSocket I/O contract, current keyboard handlers, resize observer logic.
- **Inputs**: source files.
- **Outputs**: `agent-workflow/02-scan-terminal.md` — message format spec for PTY WS, list of every event listener, current touch/mobile code paths (likely none).
- **Tools**: Read, Grep.
- **Decisions to close**: What exact bytes does the WS expect for keystrokes? Is there an existing `term.write`/`term.onData` boundary we can splice into? Does FitAddon recompute on `visualViewport.resize`?
- **Dependencies**: none.

### `scanner-styling-and-meta`
- **Role**: Audit `globals.css`, `layout.tsx` `<head>`, Tailwind config — viewport meta, safe-area usage, dvh/svh usage, `touch-action`, current `@media` breakpoints.
- **Inputs**: globals.css, layout.tsx, tailwind.config.*, app/head.tsx if any.
- **Outputs**: `agent-workflow/02-scan-styles.md` — viewport meta string, safe-area inventory, breakpoint map, font-size base.
- **Tools**: Read, Grep.
- **Decisions to close**: Does viewport meta include `viewport-fit=cover` and `interactive-widget=resizes-content`? Is `100dvh` used anywhere? Is Tailwind's `screens` config customized?
- **Dependencies**: none.

---

## Phase 3 — Best-Practice Research (3 agents, parallel)

### `researcher-mobile-terminal-ux`
- **Role**: Survey how Termux, Blink Shell, JuiceSSH, Hyper, Warp Mobile, ttyd, ShellHub, and web-based xterm wrappers solve mobile input.
- **Inputs**: none from prior phases (independent research).
- **Outputs**: `agent-workflow/03-research-terminal-ux.md` — comparison table of input-proxy patterns, modifier-bar layouts, gesture conventions, screenshots/quotes where useful.
- **Tools**: WebSearch, WebFetch, Read.
- **Decisions to close**: Which input-proxy pattern (hidden textarea, visible input bar, contenteditable overlay) gives best IME + autocorrect-off + paste behavior on iOS and Android?
- **Dependencies**: none.

### `researcher-xterm-input-proxy`
- **Role**: Deep-dive xterm.js APIs (`onData`, `attachCustomKeyEventHandler`, `textarea` helper element, `term.paste`), plus `visualViewport` + `interactive-widget` meta, plus `inputmode`/`enterkeyhint` attributes.
- **Inputs**: none.
- **Outputs**: `agent-workflow/03-research-xterm-proxy.md` — concrete code recipes (3–5 candidate implementations), each with browser-support matrix.
- **Tools**: WebSearch, WebFetch, Read.
- **Decisions to close**: Use xterm's built-in helper `<textarea>` and just expose+style it on mobile, OR build a separate React-controlled input that calls `term.input()` / WS send directly?
- **Dependencies**: none.

### `researcher-mobile-nav-patterns`
- **Role**: Survey bottom-sheet vs side-drawer vs bottom-tab-bar patterns in modern PWAs (Linear mobile, GitHub mobile, Vercel dashboard, Replit mobile, Codespaces mobile). Cover Aceternity/shadcn primitives available.
- **Inputs**: none.
- **Outputs**: `agent-workflow/03-research-nav-patterns.md` — pattern catalogue, library recommendations (`vaul`, `@radix-ui/react-dialog`, custom), gesture cost analysis.
- **Tools**: WebSearch, WebFetch, Read.
- **Decisions to close**: Bottom-tab-bar (persistent) vs single hamburger drawer (collapsed)? Does ChatPanel become a tab, a sheet, or a docked overlay?
- **Dependencies**: none.

---

## Phase 4 — Pros/Cons Analysis (1 agent)

### `analyst-tradeoffs`
- **Role**: Take every candidate pattern from Phase 3 and score it against the Mobile UX Targets, current codebase constraints (from Phase 2), and implementation cost.
- **Inputs**: all `02-*.md` and `03-*.md`.
- **Outputs**: `agent-workflow/04-tradeoffs.md` — matrix: rows = candidates, columns = (target #1…#11, impl-cost, risk, a11y, a11y-RU). Cells: pro/con bullets.
- **Tools**: Read, Write.
- **Decisions to close**: none — produces ranked options only.
- **Dependencies**: blocked by all Phase 2 + Phase 3 agents.

---

## Phase 5 — Arbiter (1 agent)

### `arbiter-tech-lead`
- **Role**: Pick the final solution stack. One concrete choice per open decision.
- **Inputs**: `04-tradeoffs.md` + all prior scans.
- **Outputs**: `agent-workflow/05-decisions.md` — numbered decisions with rationale, explicit list of rejected alternatives, frozen modifier-key list, frozen breakpoint map (e.g. `mobile <768px`, `tablet 768–1023`, `desktop ≥1024`).
- **Tools**: Read, Write.
- **Decisions to close**: nav pattern, input-proxy pattern, modifier keys, sheet library, gesture set, viewport meta string, dvh strategy.
- **Dependencies**: blocked by Phase 4.

---

## Phase 6 — Integration Plan (1 agent)

### `planner-integration`
- **Role**: Translate `05-decisions.md` into a file-by-file change plan — every file to touch, every new file to create, exact diff intent (not the diff itself).
- **Inputs**: `05-decisions.md`, all Phase 2 scans.
- **Outputs**: `agent-workflow/06-integration-plan.md` — sections: (a) new files, (b) edits per existing file with line-range hints, (c) Tailwind/globals changes, (d) viewport meta change, (e) test plan, (f) rollback plan, (g) **non-overlap partition** assigning each file to exactly one Phase-7 implementer.
- **Tools**: Read, Write.
- **Decisions to close**: how to split work between implementers so file ownership is disjoint.
- **Dependencies**: blocked by Phase 5.

---

## Phase 7 — Implementation (4 agents, parallel; disjoint file sets)

### `impl-layout-shell`
- **Role**: Owns `dashboard/page.tsx`, `app/layout.tsx`, `globals.css`, viewport meta, dvh/safe-area scaffolding, breakpoint plumbing.
- **Inputs**: `06-integration-plan.md` partition A.
- **Outputs**: code edits + `agent-workflow/07a-impl-shell.md` (changelog).
- **Tools**: Read, Edit, Write, Bash.
- **Decisions to close**: none — execute the plan.
- **Dependencies**: Phase 6.

### `impl-mobile-navigation`
- **Role**: Owns Navbar.tsx, SessionList.tsx, plus any new `MobileNav.tsx` / `MobileDrawer.tsx` / `BottomTabBar.tsx`.
- **Inputs**: `06-integration-plan.md` partition B.
- **Outputs**: code edits + `agent-workflow/07b-impl-nav.md`.
- **Tools**: Read, Edit, Write, Bash.
- **Dependencies**: Phase 6. Coordinates with shell agent only via shared CSS variables defined in plan.

### `impl-terminal-input-proxy`
- **Role**: Owns Terminal.tsx, EphemeralTerminal.tsx, plus new `MobileTerminalInput.tsx` and `ModifierKeyBar.tsx`. Wires WS keystroke forwarding, `visualViewport` listener, FitAddon recompute on keyboard open.
- **Inputs**: `06-integration-plan.md` partition C, `02-scan-terminal.md`, `03-research-xterm-proxy.md`.
- **Outputs**: code + `agent-workflow/07c-impl-terminal.md`.
- **Tools**: Read, Edit, Write, Bash.
- **Dependencies**: Phase 6.

### `impl-overlays-chat-files`
- **Role**: Owns ChatPanel.tsx, ChatInput.tsx, FileManager.tsx, AdminPanel.tsx, HotkeysModal.tsx — converts to mobile-aware sheet/full-screen overlays.
- **Inputs**: `06-integration-plan.md` partition D.
- **Outputs**: code + `agent-workflow/07d-impl-overlays.md`.
- **Tools**: Read, Edit, Write, Bash.
- **Dependencies**: Phase 6.

---

## Phase 8 — Validation (3 agents, parallel)

### `validator-build-types-lint`
- **Role**: Run `npm run build`, `tsc --noEmit`, `npm run lint`. Report failures with file:line.
- **Inputs**: working tree post-Phase-7.
- **Outputs**: `agent-workflow/08a-validate-build.md`.
- **Tools**: Bash, Read.
- **Dependencies**: Phase 7 (all four).

### `validator-viewport-headless`
- **Role**: Headless Chromium (Puppeteer/Playwright) at 360×640, 390×844, 414×896, 430×932, 768×1024, 1280×800. Capture screenshots, assert no horizontal scroll, assert nav opens/closes, assert input field visible.
- **Inputs**: build artifact.
- **Outputs**: `agent-workflow/08b-validate-viewport.md` + screenshots in `agent-workflow/screenshots/`.
- **Tools**: Bash (puppeteer/playwright), Read, Write.
- **Dependencies**: Phase 7 + 8a green.

### `validator-touch-keyboard-sim`
- **Role**: Simulate touch events + soft-keyboard open via `visualViewport` mocking; verify modifier-bar position, input-proxy keystroke forwarding (mock WS).
- **Inputs**: build artifact.
- **Outputs**: `agent-workflow/08c-validate-touch.md`.
- **Tools**: Bash, Read, Write.
- **Dependencies**: Phase 7 + 8a green.

---

## Phase 9 — User-Demand Audit (1 agent)

### `auditor-user-demands`
- **Role**: Walk through the user's three verbatim demands and check each against the implementation + validation evidence.
- **Inputs**: all Phase 7 + 8 outputs.
- **Outputs**: `agent-workflow/09-audit.md` — per-demand verdict (PASS/PARTIAL/FAIL) with evidence links and remediation notes.
- **Tools**: Read, Write.
- **Decisions to close**: are all 3 demands satisfied? If not, what minimum patch closes the gap?
- **Dependencies**: Phase 8.

---

## Phase 10 — Final Test + Polish (2 agents, sequential)

### `polisher-final`
- **Role**: Apply any tweaks from Phase 9 audit, micro-polish (animation easing, haptic hints via `navigator.vibrate`, focus rings, RU label review).
- **Inputs**: `09-audit.md`.
- **Outputs**: code edits + `agent-workflow/10a-polish.md`.
- **Tools**: Read, Edit, Bash.
- **Dependencies**: Phase 9.

### `tester-real-device`
- **Role**: Deploy to staging via `bash /root/projects/claude-terminal/deploy.sh`, generate a real-device test checklist for the user (iOS Safari + Android Chrome scenarios), wait for user sign-off.
- **Inputs**: deployed URL.
- **Outputs**: `agent-workflow/10b-test-checklist.md` — numbered scenarios, expected vs observed columns left blank for user to fill.
- **Tools**: Bash, Write.
- **Dependencies**: Phase 10a.
