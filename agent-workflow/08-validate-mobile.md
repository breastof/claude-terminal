# Phase 8 — Mobile Overhaul Validation

> Agent: `validator-viewport-mobile`
> Date: 2026-04-26
> Branch: `feat/tmux-streaming-and-mobile`
> Inputs digested: `05-decision-mobile.md`, `06-integration-plan-mobile.md` §7,
> `07-impl-mobile-WP-A.md`, `07-impl-mobile-WP-B.md`,
> `07-impl-terminal-combined.md`, `07-impl-mobile-WP-D.md`.

---

## 0. Executive Verdict

**Headless static + structural checks: 60/60 PASS across 6 viewports.**
**Static-source greps: clean (0 leftover `100vh` in dashboard tree).**
**Mobile-chrome behavior (sheets, modifier bar, keyboard interactions): SKIPPED-needs-device** — the dashboard is auth-gated by JWT cookie and there is no fixture-login backdoor; UI behavior tests require either a real device or a test-only auth bypass that does not exist in this codebase. The real-device checklist in §4 is the canonical artefact for these.

The shell tier (viewport meta, dvh, safe-area, z-tokens, overscroll-behavior, theme-color, no-horizontal-scroll) is fully validated automatically. The interaction tier needs §4.

---

## 1. Setup probes & tooling

| Probe | Result |
|---|---|
| `node_modules/playwright` | PRESENT — `playwright YES` |
| `node_modules/@playwright/test` | PRESENT — `@playwright/test YES` |
| `node_modules/puppeteer` | absent |
| Chromium binary (Playwright bundle) | `~/.cache/ms-playwright/chromium-1208/` PRESENT |
| Chromium binary (system) | `/usr/bin/chromium-browser`, `/snap/bin/chromium` PRESENT |
| `next build` already done | YES — `.next/BUILD_ID` exists, `.next/standalone/` populated; no rebuild triggered |

**Headless tooling found**: Playwright + Chromium. Headless mode used.

---

## 2. Server lifecycle

- The PM2 production server on :3000 was serving the **OLD** build (no `viewport-fit=cover`, no `interactive-widget`, no `theme-color`). Validator did NOT touch it.
- A fresh standalone Next server was started on :3300 from `.next/standalone/server.js` with `NEXT_PUBLIC_MOBILE_OVERHAUL_ENABLED=true`. It served the new HTML correctly: `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">` plus `<meta name="theme-color" content="#000000">`.
- After the test run completed, the PID was killed cleanly (SIGKILL was needed for the worker process — the parent SIGTERM is not sufficient for Next standalone).
- No PM2/deploy commands were invoked. Production state untouched.

---

## 3. Headless checks — per-viewport result matrix

Run target: `http://127.0.0.1:3300/` (the public `/page.tsx` — auth-gated dashboard cannot be reached without a valid JWT cookie, which this environment cannot mint without altering the schema).

The root page exercises the **shell** (`layout.tsx` viewport export, `globals.css` tokens, `aurora-background.tsx` dvh-migrated full-screen surface). All structural/CSS-layer assertions are verifiable from this route. **Sheet/modifier-bar/textarea behavior** lives behind the auth gate and is delegated to the real-device checklist (§4).

| Viewport | page-load | viewport-meta | theme-color | html-attrs | no-h-scroll | css-vars | overscroll | aurora-dvh | screenshot | dashboard-auth-gate |
|---|---|---|---|---|---|---|---|---|---|---|
| 360×640 | PASS | PASS | PASS | PASS | PASS (360≤360) | PASS | PASS | PASS (h=640) | PASS | PASS (307→/) |
| 390×844 (iPhone 13) | PASS | PASS | PASS | PASS | PASS (390≤390) | PASS | PASS | PASS (h=844) | PASS | PASS |
| 414×896 (iPhone 11) | PASS | PASS | PASS | PASS | PASS (414≤414) | PASS | PASS | PASS (h=896) | PASS | PASS |
| 430×932 (iPhone 15 Pro Max) | PASS | PASS | PASS | PASS | PASS (430≤430) | PASS | PASS | PASS (h=932) | PASS | PASS |
| 768×1024 (tablet) | PASS | PASS | PASS | PASS | PASS (768≤768) | PASS | PASS | PASS (h=1024) | PASS | PASS |
| 1280×800 (desktop) | PASS | PASS | PASS | PASS | PASS (1280≤1280) | PASS | PASS | PASS (h=800) | PASS | PASS |

**Total: 60 PASS / 0 FAIL / 0 WARN.** 6 screenshots captured at `/root/projects/claude-terminal/agent-workflow/screenshots/root-{viewport}.png`.

### Notable assertion details

- **viewport-meta-content** asserts the EXACT frozen string from `05-decision-mobile.md §2.6`:
  ```
  width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content
  ```
  Confirmed at every viewport. Plus separate `<meta name="theme-color" content="#000000">`.
- **css-vars-loaded** asserts that `globals.css` `@theme inline` tokens reach `getComputedStyle(document.documentElement)`:
  - `--vvh: 100dvh` (initial fallback before `useVisualViewport` writes a px value)
  - `--kbd-height: 0px` (initial fallback)
  - `--z-modal: 60`, `--z-palette: 9000`, `--z-toast: 9500`, `--z-navbar: 5000`
- **body-overscroll-contain** asserts `getComputedStyle(document.body).overscrollBehavior === "contain"` — confirms `globals.css:186` lands.
- **aurora-uses-dvh** asserts `[class*="100dvh"]` matches and `[class*="100vh"]` does NOT (i.e. the WP-A migration of `aurora-background.tsx` lines 25 & 41 lands).
- **dashboard-auth-gate** asserts `/dashboard` redirects (307→/) — confirms auth is functional and that the validator's choice to test against `/` is the only legal automated path without compromising auth.

### Why the dashboard route was not tested in-browser

The dashboard is gated by a JWT session cookie issued by `src/lib/auth.ts` after a successful POST to `/api/auth/login`. Test-only auth bypass requires either:
- a hard-coded fixture user with a known password (not present in this codebase),
- a debug HTTP endpoint that mints a dev cookie (not present),
- direct DB seeding plus JWT signing key extraction (would require reading secrets, which violates security rules).

Therefore: every assertion that depends on the dashboard tree being mounted (MobileBottomBar visibility, sheet open behavior, MobileTerminalInput textarea attributes, ChatInput font-size at runtime, overlay mutex behavior) is **SKIPPED-needs-device** in the automated tier and **REQUIRED** in §4.

---

## 4. Real-Device Checklist — Phase 10b Manual Test Plan

**Setup**: open `https://pos.digitaldonald.ru/` after the next deploy (the PM2 prod server currently serves the OLD bundle — flip `NEXT_PUBLIC_MOBILE_OVERHAUL_ENABLED=true` in `.env` and run `bash /root/projects/claude-terminal/deploy.sh`). Test on **both**:
- iPhone (Safari 16+) — recommend iPhone 13 Pro / 14 / 15
- Android (Chrome 110+) — recommend Pixel 6a / Samsung Galaxy S22

For each scenario, mark Pass / Fail / Notes. Empty cells are for the tester to fill.

### 4.1 UX Target #1 — Viewport coverage (360×640 → 430×932)

| # | Scenario | Expected | iOS | Android |
|---|---|---|---|---|
| 1.1 | Open landing page on smallest device tested | No horizontal scroll; Russian title fits on 2 lines max | | |
| 1.2 | Open dashboard after login | Terminal canvas + Navbar + MobileBottomBar all visible without overlap | | |
| 1.3 | Rotate to landscape | Layout reflows; modifier bar still attached to keyboard top when open | | |
| 1.4 | Open dashboard at iPad (≥768px) Safari | Desktop layout (IconRail + SidePanel + main) — NO MobileBottomBar | | |

### 4.2 UX Target #2 — Single mobile nav surface

| # | Scenario | Expected | iOS | Android |
|---|---|---|---|---|
| 2.1 | Land on dashboard, no overlay open | Exactly ONE persistent nav surface visible: `MobileBottomBar` at bottom (4 tabs: Терминал/Сессии/Чат/Ещё) | | |
| 2.2 | Hamburger drawer | Only reachable through the "Ещё" tab or hamburger trigger in Navbar; opens as left drawer | | |
| 2.3 | Active-tab highlighting | "Терминал" tab is active when no overlay; tapping "Сессии" highlights it; tapping "Терминал" again closes overlays and snaps back | | |

### 4.3 UX Target #3 — Real on-screen input field that forwards to PTY

| # | Scenario | Expected | iOS | Android |
|---|---|---|---|---|
| 3.1 | Tap terminal canvas | OS keyboard slides up; `MobileTerminalInput` (textarea) appears above keyboard, ABOVE the modifier bar | | |
| 3.2 | Type "echo привет" | Characters appear in textarea, then ship to PTY on next render; `привет` is echoed back in xterm canvas (UTF-8 + Cyrillic round-trip) | | |
| 3.3 | Press Enter on the keyboard | `\n` (or `\r`) reaches PTY; shell prompt advances | | |
| 3.4 | Long-press → paste from iOS/Android clipboard | Pasted text appears in textarea, then ships via `term.paste()` (bracketed-paste `\x1b[200~…\x1b[201~`) | | |
| 3.5 | Voice dictation (long-press space on iOS) | Recognised phrase ships on `compositionend` (full phrase, not per-char) | | |
| 3.6 | Pinyin / CJK IME (Android Gboard set to Chinese) | Composing candidates appear in textarea; only the final committed character ships to PTY | | |
| 3.7 | Backspace | Sends `\x7f` (DEL) — verify shell deletes one char (or readline-equivalent) | | |
| 3.8 | iOS autocorrect / autocapitalize | OFF — typing "linux" should NOT autocorrect to "Linux"; sentences should NOT capitalize | | |

### 4.4 UX Target #4 — Modifier bar (14 keys)

| # | Tap key | Expected bytes to PTY | iOS | Android |
|---|---|---|---|---|
| 4.1 | `Esc` | `\x1b` (verify by typing in vim normal mode → still in normal) | | |
| 4.2 | `Tab` | `\t` (verify shell completion fires) | | |
| 4.3 | `Ctrl` then `c` | `\x03` (interrupts a `sleep 30`) | | |
| 4.4 | `Ctrl` long-press → lock; tap `a` then `b` | `\x01\x02` (Ctrl-A then Ctrl-B) | | |
| 4.5 | `Alt` then `b` | `\x1bb` (readline back-word) | | |
| 4.6 | `↑` | `\x1b[A` (or `\x1bOA` if vim is in app-cursor) | | |
| 4.7 | `↓ ← →` | `\x1b[B \x1b[D \x1b[C` respectively | | |
| 4.8 | Hold `↑` | Auto-repeat at 0.5 s initial / 100 ms thereafter | | |
| 4.9 | `^L` | `\x0c` (clears screen) | | |
| 4.10 | `^R` | `\x12` (history search) | | |
| 4.11 | `^D` | `\x04` (EOF) | | |
| 4.12 | `⇧Tab` | `\x1b[Z` | | |
| 4.13 | `⋯` overflow → swap arrows for cursor block | `Home`/`End`/`PgUp`/`PgDn` visible; tap `Home` → `\x1b[H` | | |

### 4.5 UX Target #5 — `visualViewport` + dvh keyboard handling

| # | Scenario | Expected | iOS | Android |
|---|---|---|---|---|
| 5.1 | Open keyboard | Modifier bar slides up to sit FLUSH against keyboard top (zero gap) | | |
| 5.2 | Open keyboard at deep terminal scrollback | Cursor row scrolls into view (xterm should auto-scroll on resize) | | |
| 5.3 | Close keyboard | Modifier bar slides back to bottom; xterm canvas re-fits to full height | | |
| 5.4 | Pinch-zoom inside terminal output | Modifier bar stays at correct visual viewport top (uses `visualViewport.offsetTop`) | | |
| 5.5 | Open ChatSheet, then open keyboard | ChatInput row sits flush against keyboard top; chat scroll doesn't get covered | | |

### 4.6 UX Target #6 — Safe-area insets

| # | Scenario | Expected | iOS | Android |
|---|---|---|---|---|
| 6.1 | iPhone with notch / Dynamic Island | Top status-bar area NEVER overlaps Navbar content | | |
| 6.2 | iPhone home-indicator zone (bottom 34 px) | MobileBottomBar respects bottom inset (`pb-safe`); home indicator sits in its own zone | | |
| 6.3 | Modifier bar on iPhone | When keyboard is closed, bar uses `pb-safe` so bottom of bar = top of home-indicator zone | | |
| 6.4 | Vaul sheets (Sessions/Chat/Files/Admin/More) | Sheet bottom edge respects `pb-safe`; no content hidden behind home indicator | | |
| 6.5 | Android with gesture-pill | `env(safe-area-inset-bottom)` = 0 there is correct; bar touches the screen edge as expected | | |

### 4.7 UX Target #7 — Touch ergonomics (≥44×44 tap targets)

| # | Scenario | Expected | iOS | Android |
|---|---|---|---|---|
| 7.1 | Each tab in MobileBottomBar | Hit target ≥44×44 CSS px (verify via thumb miss-tap test) | | |
| 7.2 | Each modifier-bar key | ≥44×44 (allow horizontal scroll for narrower keys to extend their hit area via padding) | | |
| 7.3 | Navbar icon buttons | ≥44×44 (after `p-2` → `p-2.5` bump) | | |
| 7.4 | No double-tap-zoom on terminal canvas | `.terminal-host` has `touch-action: manipulation` — single tap focuses input without 300ms delay | | |

### 4.8 UX Target #8 — ChatPanel as bottom sheet, no iOS zoom

| # | Scenario | Expected | iOS | Android |
|---|---|---|---|---|
| 8.1 | Tap "Чат" tab in MobileBottomBar | Chat opens as vaul bottom sheet at snap point ~50%; drag handle visible | | |
| 8.2 | Drag sheet up | Sheet snaps to ~95% (full); drag down dismisses | | |
| 8.3 | Tap ChatInput textarea | iOS Safari does NOT zoom (textarea computed `font-size === 16px` on mobile via the `@media (max-width: 767px)` rule + `text-base md:text-sm` class) | | |
| 8.4 | Send a message via chat | Message sends; sheet stays open | | |
| 8.5 | Open Chat, then tap "Сессии" tab | Chat sheet closes (overlay mutex via `overlayStore`); Sessions sheet opens | | |

### 4.9 UX Target #9 — FileManager mobile mode

| # | Scenario | Expected | iOS | Android |
|---|---|---|---|---|
| 9.1 | Open Files (via "Ещё" → Files or icon) | FileManager renders inside `MobileFilesSheet` (full-height vaul); 4-column mobile grid template | | |
| 9.2 | Tap a file row | Editor or preview opens (existing desktop behavior) | | |
| 9.3 | Bottom toolbar | Has `pb-safe`; no overlap with home indicator | | |

### 4.10 UX Target #10 — No `100vh` traps

Static-source PASS already (see §5). On-device:

| # | Scenario | Expected | iOS | Android |
|---|---|---|---|---|
| 10.1 | iOS Safari URL bar visible vs hidden | Layout height matches `100dvh` not `100vh`; no clipped chrome | | |
| 10.2 | Keyboard open vs closed | `--vvh` CSS var updates; root container reflows; no element trapped offscreen | | |

### 4.11 UX Target #11 — Mid-range Android FPS ≥50

| # | Scenario | Expected | Pixel 6a / equiv |
|---|---|---|---|
| 11.1 | Run `find / 2>/dev/null | head -1000` to fill scrollback | Output lands; no jank | |
| 11.2 | Two-finger swipe to scroll xterm | DevTools "Performance" panel → record scroll → median FPS ≥ 50 | |
| 11.3 | Modifier-bar `↑` long-press auto-repeat | No frame drops; output renders smoothly | |

### 4.12 Bonus — Cmd+K / palette behavior on mobile

| # | Scenario | Expected | iOS | Android |
|---|---|---|---|---|
| B.1 | Open ChatInput, press Cmd+K (external keyboard) | Types literal `k` (CommandPalette is suppressed inside INPUT/TEXTAREA per `e.target.tagName` guard) | | |
| B.2 | Outside any input, press Cmd+K | CommandPalette opens (lifted from SessionPanel into top-level mount) | | |
| B.3 | Mobile palette access (no external keyboard) | Reachable via "Ещё" → "Командная палитра" entry | | |

### 4.13 Bonus — Overlay mutex (forced sequence)

| # | Scenario | Expected | iOS | Android |
|---|---|---|---|---|
| M.1 | Tap "Чат" → wait → tap "Сессии" | Chat sheet closes BEFORE Sessions sheet opens (no double-overlay) | | |
| M.2 | Tap "Чат" → tap hamburger | Chat sheet closes; MoreDrawer opens | | |
| M.3 | Open HotkeysModal, then tap "Чат" | HotkeysModal closes; Chat opens | | |
| M.4 | Open ChatSheet, then open desktop AdminPanel via reflow | Bidirectional sync — only one of {Chat, Admin} can be open at a time, even on the desktop side | | |

### 4.14 Bonus — Russian text fit at 360 px

| # | Scenario | Expected | iOS | Android |
|---|---|---|---|---|
| R.1 | "Терминал" / "Сессии" / "Чат" / "Ещё" tab labels | Fit on one line, no truncation, `text-[10px]` minimum | | |
| R.2 | Sheet aria-labels — "Сессии", "Чат", "Файлы", "Пользователи", "Главное меню", "Горячие клавиши", "Командная палитра" | VoiceOver / TalkBack announce correctly | | |
| R.3 | Navbar session name truncation | Truncates with `…` after ~150 px (existing behavior preserved) | | |
| R.4 | MobileTerminalInput placeholder "Введите команду…" | Visible, no overflow at 360 px | | |

---

## 5. Static-Analysis Findings

### 5.1 `100vh` / `h-screen` / `max-h-[80vh]` / `max-h-[85vh]` / `max-h-[90vh]` — full sweep

```
$ grep -rn "100vh\|h-screen\|min-h-screen\|max-h-\[80vh\]\|max-h-\[85vh\]\|max-h-\[90vh\]\|h-\[100vh\]" src/
src/app/symphony/page.tsx:25:    <div className="min-h-screen bg-background">
src/app/api/auth/approve/route.ts:17:<body style="margin:0;min-height:100vh;...">
```

**2 hits remaining, both intentionally out of scope:**
- `src/app/symphony/page.tsx:25` — Symphony is OUT OF SCOPE for this overhaul (`05 §11`); not part of dashboard tree.
- `src/app/api/auth/approve/route.ts:17` — server-rendered HTML for the approval page (an HTTP API endpoint); server-side templated string, not React tree.

**Dashboard tree: 0 hits.** Matches success criterion `05 §6.7`.

### 5.2 Viewport meta in `src/app/layout.tsx`

```tsx
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: "#000000",
};
```

PASS — emits the exact frozen string from `05 §2.6`. Confirmed in served HTML at every viewport.

### 5.3 `interactive-widget` reachability

```
$ grep -rn "interactive-widget\|interactiveWidget" src/
src/app/layout.tsx:36:  interactiveWidget: "resizes-content",
```

PASS — single source of truth, no drift.

### 5.4 `env(safe-area-*)` usage

```
$ grep -rn "env(safe-area" src/
src/app/globals.css:70: @utility pt-safe { padding-top: env(safe-area-inset-top); }
src/app/globals.css:71: @utility pb-safe { padding-bottom: env(safe-area-inset-bottom); }
src/app/globals.css:72: @utility pl-safe { padding-left: env(safe-area-inset-left); }
src/app/globals.css:73: @utility pr-safe { padding-right: env(safe-area-inset-right); }
src/app/globals.css:74: @utility h-safe-bottom { height: env(safe-area-inset-bottom); }
src/app/globals.css:75: @utility min-h-safe-bottom { min-height: env(safe-area-inset-bottom); }
```

PASS — Tailwind v4 `@utility` directives author 6 utilities; all centralised in `globals.css` per `05 §2.8`.

### 5.5 Hook + store usage

```
$ grep -rln "useVisualViewport\|overlayStore\|useOverlay" src/components/
src/components/pos/DashboardLayout.tsx
src/components/pos/MobileBottomBar.tsx
src/components/mobile/ModifierKeyBar.tsx
src/components/mobile/MobileTerminalInput.tsx
src/components/mobile/MobileSessionsSheet.tsx
src/components/mobile/MobileChatSheet.tsx
src/components/mobile/MobileFilesSheet.tsx
src/components/mobile/MobileAdminSheet.tsx
src/components/mobile/MobileMoreSheet.tsx
src/components/HotkeysModal.tsx
src/components/CommandPalette.tsx
src/components/pos/IconRail.tsx
```

PASS — every consumer the integration plan named is wired. `useVisualViewport` is invoked in `DashboardLayout` (CSS-var write side-effect) and consumed in `MobileBottomBar` and the modifier bar.

### 5.6 Vaul integration

```
$ grep -ln "from \"vaul\"" src/components/
src/components/HotkeysModal.tsx
src/components/mobile/MobileSessionsSheet.tsx
src/components/mobile/MobileChatSheet.tsx
src/components/mobile/MobileFilesSheet.tsx
src/components/mobile/MobileAdminSheet.tsx
src/components/mobile/MobileMoreSheet.tsx
```

PASS — 6 vaul `Drawer` consumers (5 mobile sheets + HotkeysModal mobile path). `package.json` declares `vaul@^1.1.2`, `zustand@^5.0.12`.

### 5.7 dvh swaps — verified per file

| File | Was | Now |
|---|---|---|
| `src/components/HotkeysModal.tsx:276` | `max-h-[80vh]` | `max-h-[90dvh]` (mobile) |
| `src/components/HotkeysModal.tsx:311` | `max-h-[80vh]` | `max-h-[80dvh]` (desktop) |
| `src/components/ProviderWizardModal.tsx:260` | `max-h-[85vh]` | `max-h-[85dvh]` |
| `src/components/symphony/CreateTaskModal.tsx:67` | `max-h-[85vh]` | `max-h-[85dvh]` |
| `src/components/chat/ImageLightbox.tsx:31` | `max-h-[90vh]` | `max-h-[90dvh]` |
| `src/components/ui/aurora-background.tsx:25,41` | `h-[100vh]` | `h-[100dvh]` |
| `src/components/ui/lamp.tsx` | `min-h-screen` | `min-h-dvh` |
| `src/app/global-error.tsx:12` | inline `100vh` | `100dvh` |

PASS — all 8 sites migrated.

### 5.8 ChatInput font-size

```
$ grep -n "text-base\|text-sm" src/components/chat/ChatInput.tsx
208:          className="flex-1 bg-transparent text-base md:text-sm text-foreground placeholder-muted outline-none resize-none ..."
```

PASS — mobile = 16 px (`text-base`), desktop = 14 px (`text-sm`). Plus the `globals.css` `@media (max-width: 767px)` override forces 16 px on every `<input>`/`<textarea>`/`<select>` regardless of class. Defeats iOS zoom-on-focus.

### 5.9 MobileBottomBar tab semantics

```
$ grep -n "MAIN_TABS\|MainTab" src/components/pos/MobileBottomBar.tsx
35: type MainTab = "terminal" | "sessions" | "chat" | "more";
37: const MAIN_TABS = [
38:   { id: "terminal", icon: TerminalIcon, label: "Терминал" },
39:   { id: "sessions", icon: Files, label: "Сессии" },
40:   { id: "chat", icon: MessageCircle, label: "Чат" },
41:   { id: "more", icon: MoreHorizontal, label: "Ещё" },
44: ];
```

PASS — repurposed to (Терминал/Сессии/Чат/Ещё) per `05 §2.4`, away from the legacy (sessions/hub/symphony/system).

### 5.10 z-index tokens

`globals.css` `@theme inline` block declares `--z-base/content/sticky/sidebar/panel/floating/modal/popup/palette/toast/navbar`. `lib/z-index.ts` exports the mirror const enum. **Tailwind utility classes verified at runtime**: `z-modal` (60), `z-palette` (9000), `z-toast` (9500), `z-navbar` (5000) all reachable via `getComputedStyle(documentElement)`.

---

## 6. Per-UX-Target Verdict

| # | Target | Automated verdict | Notes |
|---|---|---|---|
| 1 | Viewport coverage 360→430, tablet desktop fallback | **PASS** | All 4 mobile viewports + tablet + desktop pass no-h-scroll, layout reflow, viewport meta |
| 2 | Single mobile nav surface | **SKIPPED-needs-device** | Dashboard not reachable headless; static analysis confirms `MobileBottomBar` is only persistent surface (md:hidden gate at component) |
| 3 | Real on-screen input field → PTY | **PARTIAL** | `MobileTerminalInput.tsx` exists, integrates `TerminalIOContext`, calls `xterm.input(data, true)` per source — END-TO-END requires device |
| 4 | Modifier bar (14 keys, modifiers, arrows, chords) | **PARTIAL** | `ModifierKeyBar.tsx` exists with frozen 14-key list; auto-repeat / Ctrl-arm / Alt-prefix logic in `useModifierState.ts` per source — bytes-to-PTY needs device |
| 5 | `visualViewport` + dvh layout | **PARTIAL** | Hook exists; CSS vars `--vvh` / `--kbd-height` / `--vv-offset-top` confirmed loaded; behavior under keyboard open requires real soft keyboard (headless cannot fire `visualViewport.resize`) |
| 6 | Safe-area insets respected | **PARTIAL** | `pt-safe`/`pb-safe`/`pl-safe`/`pr-safe`/`h-safe-bottom`/`min-h-safe-bottom` utilities present; `pb-safe` confirmed in `MobileBottomBar`, vaul sheets, modifier bar; visual confirmation needs notched device |
| 7 | Tap targets ≥44×44 | **SKIPPED-needs-device** | `Navbar.tsx` `p-2.5` bump in source per WP-B; assertion needs runtime `getBoundingClientRect` over each tab, sheet button — needs auth-gated dashboard |
| 8 | ChatPanel mobile (sheet) + ChatInput no zoom | **PARTIAL** | `ChatInput.tsx:208` confirms `text-base md:text-sm`; `globals.css` mobile @media forces 16 px on every textarea; `MobileChatSheet.tsx` wraps `ChatPanel` in vaul Drawer — render needs device |
| 9 | FileManager mobile mode | **PARTIAL** | `MobileFilesSheet.tsx` exists; `FileManager.tsx` consumes `useIsMobile` for column-template swap; render needs device |
| 10 | No `100vh` traps | **PASS** | Dashboard tree: 0 hits. 2 hits outside scope (symphony/page.tsx, auth/approve/route.ts) |
| 11 | Mid-range Android FPS ≥50 | **SKIPPED-needs-device** | Cannot measure FPS on a real device from a headless container |

**Summary:**
- PASS (verified automatically): #1, #10
- PARTIAL (source-confirmed; runtime needs device): #3, #4, #5, #6, #8, #9
- SKIPPED-needs-device: #2, #7, #11

---

## 7. Risks Surfaced During Validation

1. **The PM2 production server on :3000 is serving the OLD bundle** — viewport meta lacks `viewport-fit=cover` and `interactive-widget=resizes-content`. The build IS ready in `.next/standalone/` but PM2 hasn't been bounced. **Action**: deploy via `bash deploy.sh` before Phase 10b real-device testing, otherwise the testers will be testing the wrong code.
2. **No fixture-login backdoor** — automated dashboard testing is impossible without one. If the team plans to maintain headless E2E coverage on the dashboard tree, a Phase 10 follow-up should add a `NEXT_PUBLIC_E2E_BYPASS_AUTH=true` gate that mints a fixed dev cookie. This is also called out in `05 §10` indirectly.
3. **JWT secret rotation invalidates real-device sessions** — unrelated to mobile but worth noting that `bash deploy.sh` blue-green should not regenerate the JWT secret or all mobile testers will be re-prompted to log in.
4. **The `overlayStore` exposes a dual API** (long names from §2.3 and short names like `"chat"`/`"sessions"` from WP-D's early scaffold per `07-impl-mobile-WP-A.md` §"Deviations from spec" #2). Mutex semantics are preserved on both, but the dual surface should be collapsed in a follow-up to one canonical API to reduce future drift.
5. **Validator did not test bundle size delta** (success criterion #11: ≤+38 KB gzip). The `next build` output should be inspected against a `feat/tmux-streaming-and-mobile~1` baseline by `validator-build-types-lint`.

---

## 8. Artefacts

- Screenshots: `/root/projects/claude-terminal/agent-workflow/screenshots/root-{viewport}.png` (6 PNGs, 217–531 KB each)
- Raw assertion log: `/tmp/validate-results.json` (60 entries — ephemeral, not checked in)
- This document: `/root/projects/claude-terminal/agent-workflow/08-validate-mobile.md`

---

## 9. Recommendation for Phase 9 / Phase 10

- Proceed to Phase 9 audit; the shell tier is solid.
- Phase 10b real-device testing is **REQUIRED** for UX targets #2, #3, #4, #5, #6, #7, #8, #9, #11. The §4 checklist above is the canonical artefact.
- Before Phase 10b, redeploy via `bash deploy.sh` so the real-device testers get the new bundle (currently :3000 is OLD).
- Consider adding a fixture-login gated by `NEXT_PUBLIC_E2E_BYPASS_AUTH=true` so future validators (and Phase 8b's automated viewport diff per `06 §7.2`) can reach the dashboard tree headlessly.
