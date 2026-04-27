# 02 — Scan: Layout Topology of the Dashboard

> Agent: `scanner-layout-topology`
> Branch: `feat/tmux-streaming-and-mobile`
> Date: 2026-04-26
> Mode: read-only scan, no edits, no solutions

This report maps the entire layout tree of the dashboard route, the flex/grid topology at every level, every fixed-px / fixed-vh assumption baked into the source, every overlay z-index in use, and every breakpoint actually referenced. It is a forensic scan; mitigations are explicitly out of scope.

---

## 1. Component tree (dashboard route, ASCII)

The dashboard is a single Next.js client component (`/dashboard`) wrapped in seven nested context providers, then a layout shell (`DashboardLayout`), then a content "stage" that toggles through six mutually-exclusive views plus two slide-over panels.

```
RootLayout                                           src/app/layout.tsx:29
└─ <html lang="ru" class="dark">                     src/app/layout.tsx:35
   └─ <body class="font-* antialiased">              src/app/layout.tsx:39
      └─ Dashboard (default export)                  src/app/dashboard/page.tsx:44
         └─ <Suspense>                               src/app/dashboard/page.tsx:46
            └─ ThemeProvider                         src/app/dashboard/page.tsx:47
               └─ UserProvider                       src/app/dashboard/page.tsx:48
                  └─ PresenceProvider                src/app/dashboard/page.tsx:49
                     └─ ProviderProvider             src/app/dashboard/page.tsx:50
                        └─ EditorProvider            src/app/dashboard/page.tsx:51
                           └─ NavigationProvider     src/app/dashboard/page.tsx:52
                              └─ DashboardInner      src/app/dashboard/page.tsx:64
                                 └─ DashboardLayout  src/app/dashboard/page.tsx:347
                                    │   ├ flex h-screen bg-background       components/pos/DashboardLayout.tsx:53
                                    │
                                    ├─ [Desktop ≥md] hidden md:flex h-full  components/pos/DashboardLayout.tsx:55
                                    │   ├─ IconRail   (w-12 fixed)          components/pos/IconRail.tsx:42
                                    │   └─ {panelOpen && <SidePanel/>}      components/pos/DashboardLayout.tsx:57
                                    │       └─ SidePanel  (w-[280px] fixed) components/pos/SidePanel.tsx:37
                                    │           ├─ SessionPanel             components/pos/SessionPanel.tsx:357
                                    │           ├─ HubPanel
                                    │           ├─ ConfigPanel
                                    │           ├─ SkillsPanel
                                    │           ├─ MemoryPanel
                                    │           ├─ SymphonyPanel
                                    │           └─ SystemPanel
                                    │
                                    ├─ [Mobile <md] AnimatePresence overlay  components/pos/DashboardLayout.tsx:72
                                    │   {mobileSidebarOpen && (
                                    │     ├─ <motion.div backdrop>          components/pos/DashboardLayout.tsx:80   (z-30)
                                    │     └─ <motion.div drawer (slide-in)> components/pos/DashboardLayout.tsx:88   (z-40)
                                    │         ├─ IconRail                   (re-mounted)
                                    │         └─ <div w-[280px]>            components/pos/DashboardLayout.tsx:91
                                    │             └─ SidePanel               components/pos/DashboardLayout.tsx:100
                                    │   )}
                                    │
                                    ├─ MAIN STAGE  flex-1 flex flex-col min-w-0   components/pos/DashboardLayout.tsx:117
                                    │   └─ {children}                              ← page.tsx supplies all of this
                                    │       ├─ Navbar (h-14, hidden in fullscreen) src/app/dashboard/page.tsx:362
                                    │       │
                                    │       └─ STAGE WRAPPER  flex-1 relative      src/app/dashboard/page.tsx:382
                                    │           │  (this is the absolute-position
                                    │           │   container; *every* page view
                                    │           │   below is `absolute inset-0`)
                                    │           │
                                    │           ├─ [Session view, files mode]                                   page.tsx:386
                                    │           │   absolute inset-0 m-1 md:m-2  ←  hidden when not active
                                    │           │   └─ rounded-xl border bg-surface-alt overflow-hidden          page.tsx:387
                                    │           │      └─ FileManager                                            page.tsx:388
                                    │           │         └─ flex flex-col w-full h-full
                                    │           │            ├─ TabBar  (min-h-[36px])
                                    │           │            ├─ Toolbar (Breadcrumbs + FileToolbar)
                                    │           │            ├─ FileList (flex-1 overflow-y-auto)
                                    │           │            └─ Drag overlay (fixed inset-0 z-40)                FileManager.tsx:783
                                    │           │
                                    │           ├─ [Session view, terminal stopped]                              page.tsx:394
                                    │           │   absolute inset-0 m-1 md:m-2
                                    │           │   └─ rounded-xl border bg-surface-alt
                                    │           │      └─ StoppedSessionOverlay
                                    │           │         ├─ absolute inset-0 fake terminal text                 StoppedSessionOverlay.tsx:89
                                    │           │         ├─ absolute inset-0 gradient layer ×2                  StoppedSessionOverlay.tsx:106-107
                                    │           │         ├─ absolute inset-0 backdrop-blur-[2px]                StoppedSessionOverlay.tsx:110
                                    │           │         └─ absolute inset-0 centered button                    StoppedSessionOverlay.tsx:113
                                    │           │
                                    │           ├─ [Session view, terminal active]                               page.tsx:404
                                    │           │   TerminalScrollProvider
                                    │           │   └─ <div ref=contentRef> absolute inset-0 (m-1 md:m-2 / m-0)  page.tsx:405
                                    │           │      ├─ CursorOverlay (absolute pointer-events-none z-10)      presence/CursorOverlay.tsx:162
                                    │           │      ├─ Fullscreen toggle btn (absolute top-2 right-2 z-10)    page.tsx:407-413
                                    │           │      └─ rounded-xl border bg-surface-alt overflow-hidden p-1   page.tsx:414
                                    │           │         └─ rounded-lg overflow-hidden  themed bg                page.tsx:415
                                    │           │            └─ <Terminal>                                       Terminal.tsx:21
                                    │           │               └─ <div relative w-full h-full min-h-0>          Terminal.tsx:424
                                    │           │                  ├─ <div ref=terminalRef> w-full h-full min-h-0
                                    │           │                  └─ floating reconnect badge (absolute z-20)   Terminal.tsx:430
                                    │           │
                                    │           ├─ [Explorer view] hub or config  absolute inset-0 m-1 md:m-2    page.tsx:428
                                    │           │   └─ FileExplorer (noTree)
                                    │           │
                                    │           ├─ [Skill detail]  absolute inset-0 m-1 md:m-2                   page.tsx:437
                                    │           │   └─ SkillDetailView
                                    │           │
                                    │           ├─ [Memory detail] absolute inset-0 m-1 md:m-2                   page.tsx:446
                                    │           │   └─ MemoryDetailView
                                    │           │
                                    │           ├─ [Symphony view] absolute inset-0 m-1 md:m-2                   page.tsx:455
                                    │           │   └─ SymphonyProvider → SymphonyDashboard
                                    │           │
                                    │           ├─ [System dashboard] absolute inset-0 m-1 md:m-2                page.tsx:466
                                    │           │   └─ SystemDashboard
                                    │           │
                                    │           ├─ [WelcomeScreen]  fills via flex h-full                        page.tsx:474
                                    │           │   └─ WelcomeScreen (flex items-center justify-center)
                                    │           │
                                    │           ├─ AdminPanel slide-over                                         page.tsx:494-506
                                    │           │   ├─ backdrop:  fixed inset-0 z-40 md:hidden
                                    │           │   └─ panel:     fixed md:absolute top-0 right-0 bottom-0
                                    │           │                  w-full sm:w-80 md:w-96 z-50 md:z-20
                                    │           │       └─ AdminPanel
                                    │           │
                                    │           └─ ChatPanel slide-over                                          page.tsx:509-521
                                    │               ├─ backdrop:  fixed inset-0 z-40 md:hidden
                                    │               └─ panel:     fixed md:absolute top-0 right-0 bottom-0
                                    │                              w-full sm:w-80 md:w-96 z-50 md:z-20
                                    │                   └─ ChatPanel
                                    │                       (flex flex-col h-full, internal flex-1 overflow-y-auto)
                                    │
                                    └─ MobileBottomBar  (md:hidden, h-14, border-t)                              components/pos/MobileBottomBar.tsx:56
                                        └─ overflow popover when "Ещё" tapped (fixed bottom-14 z-50)             MobileBottomBar.tsx:38

Top-layer (siblings of DashboardLayout):
   ImageLightbox         fixed inset-0 z-[100]                                                                   chat/ImageLightbox.tsx:25
   ProviderWizardModal   fixed inset-0 z-[60]                                                                    ProviderWizardModal.tsx:251
   ProviderConfigModal   fixed inset-0 z-[60]                                                                    ProviderConfigModal.tsx:94
```

Notes on the tree:
- Seven providers wrap the page (`Suspense → Theme → User → Presence → Provider → Editor → Navigation`) before any DOM is rendered (`page.tsx:46-60`).
- `DashboardLayout` short-circuits to `<div className="flex h-screen bg-background">{children}</div>` when `fullscreen` is true (`DashboardLayout.tsx:48-50`), bypassing IconRail / SidePanel / MobileBottomBar entirely.
- The mobile sidebar drawer renders a *second* `IconRail` instance instead of moving the desktop one (`DashboardLayout.tsx:90`).
- Every "page view" inside the stage is positioned `absolute inset-0` — there is no in-flow layout; the stage is a layered stack (page.tsx:386, 394, 405, 428, 437, 446, 455, 466).

---

## 2. Flex / grid topology at each level

The dashboard is a **pure flexbox tree, not CSS Grid**. Below is the topology level-by-level.

| Level | Element | File:line | display | direction | sizing |
| --- | --- | --- | --- | --- | --- |
| 0 | `<html class="dark">` | layout.tsx:35 | block | — | — |
| 0 | `<body>` | layout.tsx:39 | block | — | full document |
| 1 | `DashboardLayout` root | DashboardLayout.tsx:48 / 53 | `flex` | row (default) | `h-screen bg-background` |
| 2a | Desktop wrapper | DashboardLayout.tsx:55 | `hidden md:flex` | row | `h-full` |
| 3a | `IconRail` | IconRail.tsx:42 | `flex` | column | `w-12 flex-shrink-0` |
| 3a | `SidePanel` | SidePanel.tsx:37 | block | — | `w-[280px] flex-shrink-0` |
| 2b | Mobile drawer wrapper | DashboardLayout.tsx:88 | `flex` (motion.div) | row | `fixed top-0 left-0 bottom-0 z-40` |
| 3b | drawer `IconRail` | DashboardLayout.tsx:90 | `flex` | column | `w-12` |
| 3b | drawer panel | DashboardLayout.tsx:91 | block | — | `w-[280px]` |
| 2c | Main stage | DashboardLayout.tsx:117 | `flex` | column | `flex-1 min-w-0` |
| 3c | `Navbar` | Navbar.tsx:49 | `flex` | row, `justify-between` | `h-14` |
| 3c | Stage wrapper (children area) | page.tsx:382 | block, `relative` | — | `flex-1` |
| 4c | All views | page.tsx:386,394,405,428,437,446,455,466 | block | — | `absolute inset-0` (+ `m-1 md:m-2`) |
| 5c | View card | (each view) | block | — | `w-full h-full rounded-xl border overflow-hidden` |
| 4c | AdminPanel slide-over | page.tsx:498 | block | — | `fixed md:absolute top-0 right-0 bottom-0 w-full sm:w-80 md:w-96` |
| 4c | ChatPanel slide-over | page.tsx:513 | block | — | `fixed md:absolute top-0 right-0 bottom-0 w-full sm:w-80 md:w-96` |
| 1 | `MobileBottomBar` (sibling of stage) | MobileBottomBar.tsx:56 | `flex` (md:hidden) | row, `justify-around` | `h-14 border-t` |

Internal panel topologies (inside stage cards):

| Card | File:line | Layout |
| --- | --- | --- |
| Terminal card | page.tsx:414-418 | nested flex; inner `<div w-full h-full min-h-0>` (Terminal.tsx:424) — xterm canvas |
| FileManager | FileManager.tsx:691 | `flex flex-col w-full h-full` → TabBar (min-h-[36px]) → toolbar → `flex-1 overflow-y-auto` list |
| FileExplorer (noTree) | FileExplorer.tsx:221 | `flex h-full` → tab bar → `flex-1 flex overflow-hidden` editor split |
| EditorWorkspace split | EditorWorkspace.tsx:583, 595, 632 | `flex-1 min-h-0 flex` row, panels share via inline `flexBasis: %` (drag-resizable) |
| ChatPanel | chat/ChatPanel.tsx:333 | `flex flex-col h-full` → header (h-10) + tabs → `flex-1 overflow-y-auto overflow-x-hidden` |
| AdminPanel | AdminPanel.tsx:97 | `flex flex-col h-full` → header (h-12) → `flex-1 overflow-y-auto` |

**Verdict on the dashboard's primary layout pattern:**
- Outer chrome: **flexbox row** (rail | side panel | main column).
- Main column: **flexbox column** (Navbar | stage).
- Stage interior: **absolute-positioned overlapping panels** stacked on top of each other — only one is visible at a time via React conditional rendering; switching is instant DOM swap (page.tsx:382-484).
- No `display: grid` exists in the dashboard tree (`grep -r "grid-cols\|display: grid"` returns only `SystemDashboard.tsx:91` and `BacklogView.tsx:153` table — neither part of the layout shell).

---

## 3. Fixed-px / fixed-vh inventory

Every load-bearing hard-coded width / height in the dashboard tree, with file:line.

### 3.1 Layout shell (load-bearing)

| What | Value | File:line |
| --- | --- | --- |
| IconRail width | `w-12` (48 px) | components/pos/IconRail.tsx:42 |
| IconRail button | `w-10 h-10` (40 px) | components/pos/IconRail.tsx:52, 76, 83, 90 |
| Icon size inside IconRail buttons | `w-[18px] h-[18px]` | components/pos/IconRail.tsx:63, 79, 86, 93 |
| SidePanel width (desktop + mobile drawer) | `w-[280px]` | components/pos/SidePanel.tsx:37, components/pos/DashboardLayout.tsx:91 |
| SidePanel section header rows | `h-14` (56 px) | SessionPanel.tsx:360, ConfigPanel.tsx:55, SkillsPanel.tsx:34, MemoryPanel.tsx:37, HubPanel.tsx:119, SymphonyPanel.tsx:53, SystemPanel.tsx:59 |
| Section toolbar headers (inside views) | `h-12` (48 px) | SkillDetailView.tsx:52, MemoryDetailView.tsx:44, SymphonyBoard.tsx:88, SystemDashboard.tsx:80, ProjectOverview.tsx:80, ProjectBoard.tsx:180, BacklogView.tsx:89, TaskDetail.tsx:185, ProjectSettings.tsx:48, SymphonyDashboard.tsx:70, SprintBoard.tsx:123 |
| Navbar height | `h-14` (56 px) | components/Navbar.tsx:49 |
| MobileBottomBar height | `h-14` (56 px) | components/pos/MobileBottomBar.tsx:56 |
| MobileBottomBar overflow popover position | `bottom-14 right-2` | components/pos/MobileBottomBar.tsx:38 |
| MobileBottomBar popover min-width | `min-w-[140px]` | components/pos/MobileBottomBar.tsx:38 |
| AdminPanel/ChatPanel slide-over widths | `w-full sm:w-80 md:w-96` | src/app/dashboard/page.tsx:498, 513 |
| FileExplorer left tree width | `w-full md:w-[250px] md:min-w-[200px] md:max-w-[300px]` | components/pos/FileExplorer.tsx:224 |
| FileExplorer right tab bar height | `h-9` (36 px) | components/pos/FileExplorer.tsx:300 |
| FileExplorer editor toolbar height | `h-8` (32 px) | components/pos/FileExplorer.tsx:335 |
| TabBar (file-manager) min height | `min-h-[36px]` | components/file-manager/TabBar.tsx:44 |
| TabBar tab max width | `max-w-[180px]` | components/file-manager/TabBar.tsx:76 |
| FileExplorer tab name truncate | `max-w-[120px]` | components/pos/FileExplorer.tsx:318 |

### 3.2 Hard-coded grid columns (FileManager)

```ts
// components/FileManager.tsx:80
const MOBILE_COLUMNS  = "32px 28px 1fr 80px";
// components/FileManager.tsx:101 (initial state)
const [columnWidths, setColumnWidths] = useState("32px 28px 1fr 100px 140px 80px");
// components/FileManager.tsx:103
const effectiveColumns = isMobile ? MOBILE_COLUMNS : columnWidths;
```

These are passed into `FileList` as a CSS-grid template. Mobile → 4 fixed-px columns adding to ~140 px chrome, leaving `1fr` for the name. Desktop → 6 fixed-px columns adding to ~380 px chrome.

### 3.3 Modals and floating widgets

| What | Value | File:line |
| --- | --- | --- |
| HotkeysModal kbd | `min-w-[28px] h-[26px]` | components/HotkeysModal.tsx:161 |
| HotkeysModal max | `max-w-md max-h-[80vh]` | components/HotkeysModal.tsx:236 |
| ProviderWizardModal max | `max-w-lg max-h-[85vh]` | components/ProviderWizardModal.tsx:260 |
| ProviderWizardModal preview | `w-full h-[200px]` | components/ProviderWizardModal.tsx:15 |
| ProviderConfigModal max | `max-w-md` | components/ProviderConfigModal.tsx:103 |
| SessionDeleteModal | `max-w-sm` | components/SessionDeleteModal.tsx:44 |
| DeleteConfirmModal (file mgr) | `max-w-sm` | components/file-manager/DeleteConfirmModal.tsx:33 |
| UnsavedChangesModal | `max-w-sm` | components/file-manager/UnsavedChangesModal.tsx:37 |
| NewFileModal | `max-w-sm` | components/file-manager/NewFileModal.tsx:96 |
| SessionPanel CommandPalette dialog | `w-[min(560px,92vw)]` | components/pos/SessionPanel.tsx:515 |
| SessionPanel CommandPalette overlay | `pt-[15vh]` | components/pos/SessionPanel.tsx:514 |
| SessionPanel CommandPalette list | `max-h-80` | components/pos/SessionPanel.tsx:524 |
| TabContextMenu | `min-w-[160px]` | components/file-manager/TabContextMenu.tsx:52 |
| Symphony PipelineAlertBanner | `w-[480px] max-w-[calc(100vw-2rem)]` | components/symphony/PipelineAlertBanner.tsx:78 |
| Symphony PipelineAlerts dock | `max-w-[360px] sm:w-[360px]` | components/symphony/PipelineAlerts.tsx:68 |
| Symphony NotificationCenter | `w-80 max-h-96` | components/symphony/NotificationCenter.tsx:16 |
| Symphony CreateTaskModal | `w-[520px] max-h-[85vh]` | components/symphony/CreateTaskModal.tsx:67 |
| Symphony BoardColumn min-h | `min-h-[60px]` | components/symphony/BoardColumn.tsx:56 |
| Symphony ProjectBoard inner | `min-w-[1600px]` | components/symphony/ProjectBoard.tsx:319 |
| Symphony SymphonyBoard inner | `min-w-[800px]` | components/pos/SymphonyBoard.tsx:141 |
| Symphony ErrorRateTrends svg | `min-w-[300px]` | components/symphony/pipeline/ErrorRateTrends.tsx:59 |
| Symphony ActivityTimeline svg | `min-w-[400px]` | components/symphony/pipeline/ActivityTimeline.tsx:54 |

### 3.4 Chat / image / cursor labels

| What | Value | File:line |
| --- | --- | --- |
| Chat reply min-width 0 | `min-w-0` | chat/ChatPanel.tsx:435 |
| Chat image preview | `max-w-[240px] max-h-[180px]` | chat/ChatMessage.tsx:206 |
| Chat file chip | `max-w-[280px]` | chat/ChatMessage.tsx:222 |
| Chat input textarea | `max-h-24 min-h-[20px]` | chat/ChatInput.tsx:203 |
| Cursor name pill | `max-w-[150px]` | presence/Cursor.tsx:269 |
| EdgeIndicator name | `max-w-[80px]` | presence/EdgeIndicator.tsx:41 |
| ImageLightbox | `max-w-[90vw] max-h-[90vh]` | chat/ImageLightbox.tsx:31 |

### 3.5 Navbar truncation (relevant for mobile widths)

```tsx
// components/Navbar.tsx:79
<span className="text-sm text-muted-fg font-mono truncate max-w-[150px] md:max-w-none">
```

The session-name pill is capped at **150 px on mobile**; without `md:max-w-none` it would also chain into pending-count badges (`min-w-[16px]`, Navbar.tsx:153), which is fine but adds a fixed-width assumption.

### 3.6 Decorative components (UI library, off the load-bearing path but still rendered if used)

- `aurora-background.tsx:25, 41` — `h-[100vh]`
- `lamp.tsx:22` — `min-h-screen`
- `lamp.tsx:37, 52` — `w-[30rem]`, `h-56` etc.
- `spotlight.tsx:15` — `h-[169%] w-[138%]`
- `floating-navbar.tsx:56` — `top-10 z-[5000]`
- `placeholders-and-vanish-input.tsx:267` — `w-[calc(100%-2rem)]`
- `moving-border.tsx:40, 66` — `h-16 w-40`
- `typewriter-effect.tsx:93, 180` — fixed cursor heights `h-4 sm:h-6 lg:h-10 xl:h-12`

`<Spotlight>` is rendered inside `WelcomeScreen.tsx:35-38` (positioned `-top-40 left-0 md:left-60 md:-top-20`) — its `h-[169%] w-[138%]` may push horizontal overflow on tiny screens (see §5).

---

## 4. `100vh` / `100vw` / `100dvh` / `100svh` usage table

| Unit | File:line | Context |
| --- | --- | --- |
| `100vh` | components/ui/aurora-background.tsx:25 | `"relative flex h-[100vh] flex-col items-center justify-center"` — wrapper variant of Aurora background |
| `100vh` | components/ui/aurora-background.tsx:41 | `"transition-bg relative flex h-[100vh] flex-col items-center justify-center bg-zinc-50 ..."` — outer Aurora wrapper |
| `100vh` | app/global-error.tsx:12 | inline style `height: "100vh"` — full-screen error fallback |
| `100vh` | app/api/auth/approve/route.ts:17 | `min-height:100vh` in HTML server-rendered approval page |
| `100dvh` | — | **none** found (`grep -rn "100dvh\|dvh\|svh\|lvh"` returns 0 hits) |
| `100svh` | — | none |
| `100lvh` | — | none |
| `100vw` | components/symphony/PipelineAlertBanner.tsx:78 | `max-w-[calc(100vw-2rem)]` — banner clamp |
| `92vw`  | components/pos/SessionPanel.tsx:515 | `w-[min(560px,92vw)]` — Cmd-K palette |
| `90vw / 90vh` | components/chat/ImageLightbox.tsx:31 | `max-w-[90vw] max-h-[90vh]` — image viewer |
| `85vh` | components/HotkeysModal.tsx:236 | `max-h-[80vh]` (sic 80, not 85; HotkeysModal uses 80vh) |
| `80vh` | components/HotkeysModal.tsx:236 | `max-h-[80vh]` — modal content cap |
| `85vh` | components/ProviderWizardModal.tsx:260 | `max-h-[85vh]` |
| `85vh` | components/symphony/CreateTaskModal.tsx:67 | `max-h-[85vh]` |
| `15vh` | components/pos/SessionPanel.tsx:514 | `pt-[15vh]` — palette top offset |

Indirect viewport dependence (Tailwind `h-screen` / `min-h-screen` — these compile to `100vh`):

| File:line | Class | Effect |
| --- | --- | --- |
| components/pos/DashboardLayout.tsx:49 | `flex h-screen` (fullscreen branch) | full viewport |
| components/pos/DashboardLayout.tsx:53 | `flex h-screen` (normal branch) | full viewport — **this is the dashboard's root height** |
| components/ui/lamp.tsx:22 | `min-h-screen` | unused on dashboard |
| app/symphony/page.tsx:25 | `min-h-screen` | the standalone /symphony route |

**Total `100vh` traps in the live dashboard tree:** 1 critical (`DashboardLayout.tsx:49 + :53` — both branches use `h-screen`), plus 4 modal `max-h-XXvh` clamps (acceptable on desktop but cooperate badly with the iOS keyboard). Aurora/lamp `100vh` lines are unused on `/dashboard`.

---

## 5. Horizontal-scroll sources at <768 px (suspect list)

The `<body>` and root containers do **not** set `overflow-x: hidden`. Every container below is therefore a candidate for triggering window-level horizontal scroll if its content overflows.

| # | Suspect | File:line | Why it can overflow |
| --- | --- | --- | --- |
| 1 | `min-w-[1600px]` Symphony project board | components/symphony/ProjectBoard.tsx:319 | If routed through dashboard symphony view, forces 1600 px column. Wrapper `overflow-x-auto` at 318 — internal scroll, but the `min-w` cascades to the parent if the wrapper isn't `min-w-0`. |
| 2 | `min-w-[800px]` SymphonyBoard | components/pos/SymphonyBoard.tsx:141 | Same pattern, smaller floor. |
| 3 | `min-w-[400px]` ActivityTimeline svg | components/symphony/pipeline/ActivityTimeline.tsx:54 | Inside `overflow-x-auto` (line 50) — OK if parent has `min-w-0`. |
| 4 | `min-w-[300px]` ErrorRateTrends svg | components/symphony/pipeline/ErrorRateTrends.tsx:59 | Same. |
| 5 | `min-w-[200px]` FileExplorer tree | components/pos/FileExplorer.tsx:224 | Only applies at `md:` — safe on mobile. |
| 6 | TabBar in FileManager | components/file-manager/TabBar.tsx:48 | `overflow-x-auto scrollbar-none` — produces internal scroll, can also leak via `min-w-[180px]` per tab if parent missing `min-w-0`. |
| 7 | Breadcrumbs row | components/file-manager/Breadcrumbs.tsx:14 | `overflow-x-auto` — fine, but long paths with no min-w-0 parent overflow chain. |
| 8 | FileExplorer tab strip | components/pos/FileExplorer.tsx:300 | `h-9 ... overflow-x-auto` — internal scroll. |
| 9 | `<pre>` blocks in markdown viewer | app/globals.css:281 | `overflow-x: auto` — local scroll OK. |
| 10 | ChatInput emoji/preview row | components/chat/ChatInput.tsx:140 | `overflow-x-auto` — local scroll. |
| 11 | TaskDetail pre | components/symphony/TaskDetail.tsx:355 | `overflow-x-auto` — local scroll. |
| 12 | **Spotlight inside WelcomeScreen** | components/ui/spotlight.tsx:15 + WelcomeScreen.tsx:35 | `h-[169%] w-[138%]` positioned `-top-40 left-0` → **on a 360 px viewport, occupies up to ~497 px wide**. Outer `WelcomeScreen` has `overflow-hidden` (WelcomeScreen.tsx:34) so it should be clipped, but the Spotlight is positioned outside the centered `max-w-md` block via absolute positioning — needs to be verified visually. |
| 13 | **`md:left-60` Spotlight position** | components/WelcomeScreen.tsx:36 | At `<md` it sits at `left-0` — combined with 138% width, can cause layout shifts in some Safari versions when `transform` is animating (`animate-spotlight`). |
| 14 | **AdminPanel/ChatPanel slide-overs** when open on mobile | src/app/dashboard/page.tsx:498, 513 | `w-full sm:w-80 md:w-96` — `w-full` is correct on mobile. But the panel is `position: fixed`, so the parent stage's content remains its previous width. If the underlying terminal content has any `min-w-*` it may already cause horizontal scroll independent of the panel. |
| 15 | **Navbar gap chain** | components/Navbar.tsx:49 | `flex items-center justify-between px-3 md:px-5` + multiple icon buttons (chat, admin, system health, connection status, session counter, view-mode tab strip). On a 360 px viewport with `activeSessionName` shown (`max-w-[150px]`), buttons may push the tab strip and chat button off the right edge if no `min-w-0` on the inner flex containers. |
| 16 | **View-mode toggle in Navbar** | components/Navbar.tsx:87-114 | `flex items-center gap-0.5 ml-2 ...` — no truncation/wrap; on tiny screens with all buttons present, may push width. The `<span class="hidden sm:inline">Терминал/Файлы</span>` already hides labels at `<sm`, so buttons are 28-32 px each — likely safe. |
| 17 | **MobileBottomBar overlap** | MobileBottomBar.tsx:56 | `h-14` is added at the *bottom* of the column, but `DashboardLayout.tsx:53` sets `h-screen` on the root. The stage's `flex-1` shrinks correctly, but the *Navbar (h-14)* + *MobileBottomBar (h-14)* + *iOS URL bar* together cost up to 250 px of viewport height on mobile Safari with the keyboard collapsed. With keyboard open the available stage height drops by another ~280 px. |
| 18 | `min-w-[140px]` MobileBottomBar overflow popover | MobileBottomBar.tsx:38 | Fine — fixed and small. |
| 19 | `min-w-[480px]` PipelineAlertBanner | components/symphony/PipelineAlertBanner.tsx:78 | Already clamped via `max-w-[calc(100vw-2rem)]` — safe. |
| 20 | Cursor name pill | components/presence/Cursor.tsx:269 | `max-w-[150px] truncate` — safe. |

**Strongest candidates for actually scrolling the window** at <768 px:
- (a) Symphony views routed via dashboard with `min-w-[1600px]` if `overflow-x-auto` parent is misaligned (#1).
- (b) Spotlight (#12) — visual artifact rather than scroll, but worth verifying.
- (c) Navbar contents on iPhone SE width when both `chatOpen` and `adminOpen` icons are present plus session name (#15).
- (d) Any FileManager search query producing very long file names without `min-w-0` parents.

The dashboard root container (`flex h-screen`) does **not** set `overflow-x` anywhere; the `body` does not have `overflow-x: hidden`; `globals.css` does not set it. So any inner overflow leaks straight to the window scroll.

---

## 6. Z-index / stacking inventory

The project defines a Z scale at `src/lib/z-index.ts:20-39`:

```
BASE = 0, CONTENT = 10, STICKY = 20, SIDEBAR = 30, PANEL = 40,
FLOATING = 50, MODAL = 60, POPUP = 100, NAVBAR = 5000
```

Actual usages found in the dashboard tree:

| Layer (in code) | z value | Element | File:line | Trigger |
| --- | --- | --- | --- | --- |
| local | `z-0` | Lamp container (decorative) | components/ui/lamp.tsx:22, 27 | static |
| CONTENT | `z-10` | WelcomeScreen content wrapper | components/WelcomeScreen.tsx:40 | always when welcome view active |
| CONTENT | `z-10` | Login page content | app/page.tsx:33 | login route |
| CONTENT | `z-10` | Fullscreen toggle button (terminal) | src/app/dashboard/page.tsx:409 | terminal view |
| CONTENT | `z-10` | Mobile close-X (admin/chat slide-over) | src/app/dashboard/page.tsx:499, 514 | when slide-over open |
| CONTENT | `z-10` | CursorOverlay container | components/presence/CursorOverlay.tsx:162 | terminal view |
| CONTENT | `z-10` | CodeEditor loading overlay | components/file-manager/CodeEditor.tsx:277 | editor loading |
| CONTENT | `z-10` | hover-border-gradient inner | components/ui/hover-border-gradient.tsx:73, 97 | UI lib |
| STICKY | `z-20` | Reconnect / auth-expired badge (Terminal) | components/Terminal.tsx:430, 436 | reconnect or expired |
| STICKY | `z-20` | Slide-over panels on desktop (`md:z-20`) | src/app/dashboard/page.tsx:498, 513 | desktop only |
| STICKY | `z-20` | Lamp masks | components/ui/lamp.tsx:39, 40, 54, 55 | UI lib |
| SIDEBAR | `z-30` | Mobile sidebar backdrop | components/pos/DashboardLayout.tsx:80 | `mobileSidebarOpen` |
| SIDEBAR | `z-30` | Lamp blur | components/ui/lamp.tsx:67 | UI lib |
| PANEL | `z-40` | Mobile sidebar drawer (`fixed`) | components/pos/DashboardLayout.tsx:88 | `mobileSidebarOpen` |
| PANEL | `z-40` | AdminPanel & ChatPanel mobile backdrop | src/app/dashboard/page.tsx:497, 512 | when open AND `<md` |
| PANEL | `z-40` | FileManager drag overlay | components/FileManager.tsx:783 | drag-and-drop active |
| PANEL | `z-40` | MobileBottomBar overflow scrim | components/pos/MobileBottomBar.tsx:37 | "Ещё" tapped |
| PANEL | `z-40` | Lamp mask outer | components/ui/lamp.tsx:81 | UI lib |
| FLOATING | `z-50` | Mobile sidebar close-X | components/pos/DashboardLayout.tsx:92 | drawer open |
| FLOATING | `z-50` | AdminPanel & ChatPanel mobile drawer (`fixed`) | src/app/dashboard/page.tsx:498, 513 | when open AND `<md` |
| FLOATING | `z-50` | MobileBottomBar overflow popover | components/pos/MobileBottomBar.tsx:38 | "Ещё" tapped |
| FLOATING | `z-50` | Symphony PipelineAlertBanner | components/symphony/PipelineAlertBanner.tsx:78 | symphony alerts |
| FLOATING | `z-50` | CreateTaskModal | components/symphony/CreateTaskModal.tsx:66 | modal |
| FLOATING | `z-50` | ComboButton dropdown | components/ComboButton.tsx:129 | dropdown opened |
| FLOATING | `z-50` | SymphonyDashboard popover | components/symphony/SymphonyDashboard.tsx:95 | menu |
| FLOATING | `z-50` | Various Lamp/UI lib | components/ui/lamp.tsx:60, 76, 85, presence vanish-input.tsx:204, 212 | UI lib |
| MODAL | `z-[60]` | Modal backdrops (ProviderWizard, ProviderConfig, SessionDelete, Hotkeys, NewFile, DeleteConfirm, UnsavedChanges) | search "z-[60]" | modal open |
| MODAL | `z-[60]` | Symphony PipelineAlerts dock | components/symphony/PipelineAlerts.tsx:68 | symphony |
| POPUP | `z-[100]` | ImageLightbox | components/chat/ImageLightbox.tsx:25 | image clicked |
| POPUP | `z-[100]` | TabContextMenu | components/file-manager/TabContextMenu.tsx:52 | right-click on tab |
| OUT-OF-SCALE | `z-[5000]` | UI lib FloatingNavbar | components/ui/floating-navbar.tsx:56 | UI lib (not used in dashboard) |
| OUT-OF-SCALE | `z-[9998]` | **CommandPalette (Ctrl+K)** | components/pos/SessionPanel.tsx:514 | palette opened |

Conflict notes:
- The Cmd-K palette uses `z-[9998]` — well above modals (60). This is intentional since Ctrl+K should overlay anything, but it bypasses the centralized scale (z-index.ts only goes up to NAVBAR=5000).
- Both AdminPanel and ChatPanel slide-over panels share the *same* z-50 / md:z-20. If both are toggled on mobile they would stack at the same z; in practice only one can be open via state, but there is no enforced mutual-exclusion in `DashboardInner` (`chatOpen` and `adminOpen` are independent state, page.tsx:84-85). Bug latent.
- The Navbar reconnect badge (`z-20`) sits above CursorOverlay (`z-10`) inside the same Terminal stage card — correct.
- Mobile sidebar drawer (`z-40`) is below modal backdrops (`z-60`) — correct, modal can open over the sidebar.

---

## 7. Breakpoints actually in use

Tailwind's default breakpoints are the only ones referenced (`tailwind.config.*` is not present in `/root/projects/claude-terminal` — config defaults are inherited from `@import "tailwindcss";` in `src/app/globals.css:1`, Tailwind 4 modeled). Default thresholds: `sm:640`, `md:768`, `lg:1024`, `xl:1280`, `2xl:1536`.

### Frequency of each prefix in `src/**/*.tsx`

| Prefix | Distinct utilities | Top utilities (count) |
| --- | --- | --- |
| `sm:` | 9 | `sm:inline ×6`, `sm:text-base ×3`, `sm:w-80 ×2`, `sm:hidden ×1`, `sm:block ×1`, `sm:h-6 ×1`, `sm:left-8 ×1`, `sm:pl-12 ×1`, `sm:pl-10 ×1`, `sm:text-xl ×1`, `sm:w-[360px] ×1` |
| `md:` | 50+ | `md:w-3.5 ×12`, `md:h-3.5 ×12`, `md:p-1 ×9`, `md:hidden ×9`, `md:m-2 ×8`, `md:flex ×6`, `md:py-1.5 ×5`, `md:px-2.5 ×5`, `md:w-4 ×4`, `md:h-4 ×4`, `md:block ×4`, `md:text-xl ×3`, `md:p-1.5 ×3`, `md:z-20 ×2`, `md:w-96 ×2`, `md:px-4 ×2`, `md:opacity-0 ×2`, `md:max-w-[300px] ×2`, `md:h-7 ×2`, `md:group-hover:opacity-100 ×2`, `md:grid-cols-2 ×2`, `md:gap-0.5 ×2`, `md:absolute ×2`, `md:w-[250px] ×1`, `md:w-16 ×1`, `md:-top-20 ×1`, `md:text-9xl ×1`, `md:text-6xl ×1`, `md:text-3xl ×1`, `md:text-2xl ×1`, `md:py-3 ×1`, `md:py-2.5 ×1`, `md:py-2 ×1`, `md:px-7 ×1`, `md:left-60 ×1`, `md:m-0 ×1`, `md:mb-8 ×1`, `md:mb-6 ×1`, `md:max-w-none`, `md:min-w-[200px]`, etc. |
| `lg:` | 5 | `lg:grid-cols-3`, `lg:h-10`, `lg:text-3xl`, `lg:text-5xl`, `lg:w-[84%]` (spotlight) |
| `xl:` | 2 | `xl:h-12`, `xl:text-5xl` |
| `2xl:` | 0 | none |

### Total occurrences

`grep -rE '(\bsm:|\bmd:|\blg:|\bxl:)' src/` → **111 lines** matched (single line can carry several utilities).

### Raw `@media` queries

`grep -rn "@media"` in `src/` → **0 hits**. All breakpointing goes through Tailwind utilities.

### `useIsMobile` runtime breakpoint

`src/lib/useIsMobile.ts:4` — JS-side breakpoint hard-coded to `768 px` (matches `md:`). Used in:
- `components/FileManager.tsx:102` to swap grid template (`MOBILE_COLUMNS`).
- `components/file-manager/EditorWorkspace.tsx:64` to gate split-view mode and preview toggle.
- `components/presence/CursorOverlay.tsx:19` (own state, also keyed on `768 px`).

### Effective dashboard breakpoints

The whole responsive contract for the dashboard happens at exactly two breakpoints:
1. `md:` (768 px) — desktop chrome (IconRail+SidePanel) appears, MobileBottomBar disappears, slide-over panels drop from `fixed` to `md:absolute` and shrink from `w-full` to `sm:w-80 md:w-96`.
2. `sm:` (640 px) — view-mode label text appears (`sm:inline`), session counter visible, `sm:w-80` for slide-overs partially activates.

There is **no `lg:` or `xl:` adjustment for the dashboard layout itself** — `lg:` is only used by `SystemDashboard.tsx` grid and the Spotlight UI library.

---

## 8. Decisions closed

### 8.1 Is the dashboard a CSS Grid, flex row, or absolute-positioned panels?

**Mixed: flex row outer + absolute-stacked panels in the stage.**

- The outer chrome (rail + side panel + main column + mobile bottom bar) is a **flex row** at `DashboardLayout.tsx:53`.
- The main column is a **flex column** (Navbar + stage) at `DashboardLayout.tsx:117`.
- The stage interior is **`absolute inset-0` on every page-view**: `page.tsx:386, 394, 405, 428, 437, 446, 455, 466`. All views overlap each other in z and are toggled by React conditional rendering — only one is visible at a time.
- AdminPanel and ChatPanel slide-overs are `fixed md:absolute` overlays on top of the stage (`page.tsx:498, 513`).
- **No `display: grid`** is used in the dashboard layout shell. Grid is used only inside `SystemDashboard` content (1 occurrence) and inside the FileManager file-list rows (CSS grid template via inline string).

### 8.2 Where does horizontal scroll come from at <768 px today?

The body/root never set `overflow-x: hidden`. Concrete suspects (in priority order):

1. **Symphony content with `min-w-[1600px]` / `min-w-[800px]`** (ProjectBoard.tsx:319, SymphonyBoard.tsx:141). These ARE inside `overflow-x-auto` parents, but when those parents lack `min-w-0` themselves the floor cascades to the dashboard root.
2. **Navbar** (`components/Navbar.tsx:49`) — `justify-between` with up to 7 controls (hamburger, session pill `max-w-[150px]`, view-mode toggle, session counter, connection status, system health, admin toggle, chat toggle) on a 360 px viewport. Inner flex containers do not set `min-w-0`. With long session names truncated at 150 px and 5+ icons, total can exceed 360 px.
3. **Spotlight in WelcomeScreen** (`components/ui/spotlight.tsx:15` rendered at `WelcomeScreen.tsx:35`). 138% width × 169% height anchored to `-top-40 left-0` on mobile. The parent has `overflow-hidden` (`WelcomeScreen.tsx:34`), so this *should* be clipped — needs visual confirmation since `animate-spotlight` keyframes reposition during the first ~2 s.
4. **Slide-over backdrops at z-40 vs panel at z-50** — both use `fixed inset-0`. The backdrop fully covers the viewport, so it cannot itself trigger scroll; but the underlying stage may still scroll horizontally if any of the above leaks.
5. **TabBar in FileManager / FileExplorer** has `overflow-x-auto` but inner tabs can have `max-w-[180px]` × N, which overflows the strip — internal scroll, not window-level.
6. **`min-w-[160px]` TabContextMenu, `min-w-[140px]` MobileBottomBar popover, `min-w-[28px]` HotkeysModal kbd** — all small, contained, low risk.

### 8.3 Are there `100vh` traps?

**Yes — one critical, plus four `max-h-XXvh` modal caps that misbehave with the iOS keyboard.**

- **Critical:** `components/pos/DashboardLayout.tsx:49` and `components/pos/DashboardLayout.tsx:53` both wrap the entire dashboard with `flex h-screen` (Tailwind `h-screen` → `height: 100vh`). On mobile Safari this height is set to the **layout viewport** which excludes the dynamic URL bar but does *not* shrink when the soft keyboard appears. Result: when the keyboard opens, the bottom 250-280 px of the dashboard (including MobileBottomBar `h-14` and any input row inside Navbar / ChatPanel) gets pushed off-screen and is unreachable without scrolling — and the document doesn't scroll because the root is `h-screen`.
- **Modal caps:** `max-h-[80vh]` (HotkeysModal), `max-h-[85vh]` ×3 (ProviderWizard, CreateTaskModal, SessionPanel CommandPalette `pt-[15vh]`). On mobile Safari with the keyboard open, the modal stays at 85% of *layout* viewport — but the visible viewport is now ~50%, so the modal scrolls into the keyboard.
- **Aurora wrapper `h-[100vh]`** (`components/ui/aurora-background.tsx:25, 41`) — not currently used by dashboard; latent if later wired.
- **No `100dvh` / `100svh` / `100lvh` anywhere in the codebase.**

### 8.4 Is `viewport-fit=cover` set?

**No.** `src/app/layout.tsx:21-25` exports only the `title` and `description` Metadata. There is **no `viewport` export** (`grep -rn "export const viewport\|viewport:"` in `src/` returned 0 hits). Next.js will inject its default `<meta name="viewport" content="width=device-width, initial-scale=1">`, which:
- Lacks `viewport-fit=cover` — `env(safe-area-inset-*)` will all be 0 on iOS notch / Dynamic Island devices.
- Lacks `interactive-widget=resizes-content` — Chrome on Android will not shrink the layout viewport when the soft keyboard opens (default is `resizes-visual`).
- Lacks `user-scalable=no` and `maximum-scale=1` — pinch-zoom is allowed, which on a terminal interface is questionable but currently unconstrained.

The only other place `viewport` appears in source is the inline approval-page HTML at `src/app/api/auth/approve/route.ts:16` — irrelevant to dashboard.

`grep -rn "safe-area-inset"` in `src/` → **0 hits.** No `env(safe-area-inset-*)` usage anywhere. The dashboard does not respect notch / home-indicator safe areas.

---

## Appendix Z — Per-component layout audit

### Z.1 `src/app/dashboard/page.tsx` (the orchestrator)

The dashboard page is a single client component. Layout responsibilities:
- Wraps everything in 7 nested context providers (`page.tsx:46-60`).
- Owns view-mode state: `mobileSidebarOpen`, `fullscreen`, `viewMode`, `chatOpen`, `adminOpen` — none of which use URL params (page.tsx:77-87).
- Renders `<DashboardLayout>` with all session-related callbacks.
- Inside the slot, renders Navbar (`page.tsx:362-379`) + a single `flex-1 relative` stage container (`page.tsx:382`) + slide-overs.
- Stage container has **no padding, no overflow rule, no min-height of its own** — it relies entirely on its parent (`flex-1 flex flex-col min-w-0` from DashboardLayout) for sizing, and on each absolute-positioned child to fill it.

Critical layout fragments inside `page.tsx`:

```tsx
// Line 382 — the stage
<div className="flex-1 relative">
  …
</div>

// Lines 386, 394, 405, 428, 437, 446, 455, 466 — every page-view starts with:
<div className="absolute inset-0 m-1 md:m-2 …">
  <div className="w-full h-full rounded-xl border border-accent/20 bg-surface-alt overflow-hidden">
    …
  </div>
</div>
```

The `m-1 md:m-2` margin is the only "gap" between the chrome (Navbar, IconRail, SidePanel) and the content card. On mobile (`m-1` = 4 px), this means the content card extends to within 4 px of every edge of the stage — acceptable. On desktop (`md:m-2` = 8 px), 8 px of breathing room.

The fullscreen branch removes the margin (`fullscreen ? "m-0" : "m-1 md:m-2"`, line 405) for the terminal only — everything else still gets `m-1 md:m-2` because there is no `fullscreen` switch on lines 386, 394, 428, 437, 446, 455, 466.

The slide-over panels (`page.tsx:498, 513`) use a clever responsive pattern:
```tsx
className="fixed md:absolute top-0 right-0 bottom-0 w-full sm:w-80 md:w-96 z-50 md:z-20 bg-surface border-l border-border"
```
- On mobile: `fixed` (covers viewport), `w-full` (full width), `z-50` (above mobile sidebar `z-40`).
- On `sm` (≥640): `w-80` (320 px).
- On `md` (≥768): `absolute` (inside stage, not over the entire viewport), `w-96` (384 px), `z-20` (above terminal but below modals).

This is the only place in the codebase that flips `position` between `fixed` and `absolute` via responsive utilities.

### Z.2 `src/components/pos/DashboardLayout.tsx` (chrome shell)

- Two render branches gated on `fullscreen`:
  - Fullscreen: `<div className="flex h-screen bg-background">{children}</div>` (line 49). **No IconRail, no SidePanel, no MobileBottomBar.** Just a flex container holding the children directly. This means terminal fullscreen mode loses the sidebar but **keeps `h-screen` (= 100vh)** — same trap.
  - Normal: `<div className="flex h-screen bg-background">` (line 53), plus the desktop chrome (line 55), the mobile drawer (line 72), the main column (line 117), and the `MobileBottomBar` (line 122).
- The main column at line 117: `<div className="flex-1 flex flex-col min-w-0">{children}</div>`. `min-w-0` is critical to prevent flex children from forcing the row to grow beyond viewport — present here, good.
- The mobile drawer animates from `x: -100%` to `x: 0` via `motion/react` (line 84). Drawer width = IconRail (48 px) + panel (280 px) = **328 px**. On a 360 px viewport this leaves only 32 px of backdrop visible — small tap target to close the drawer.
- The mobile drawer renders an entire IconRail + SidePanel inside `position: fixed`. When the desktop layout already has these mounted on the left (visible at `md:flex`), there are technically two parallel React trees for the same components on tablet-to-desktop transition windows. In practice `md:hidden` on the mobile drawer prevents this, but the components are still re-mounted on each open/close cycle.

### Z.3 `src/components/pos/IconRail.tsx`

- `w-12 flex-shrink-0 flex flex-col bg-surface border-r border-border h-full` (line 42).
- 7 section icons (sessions, hub, config, skills, memory, symphony, system) rendered as `w-10 h-10 ... rounded-lg` buttons inside an icon column (line 44, 52).
- Footer with theme toggle, hotkeys, logout — same `w-10 h-10` button shape.
- Icons themselves are `w-[18px] h-[18px]`.
- Width of the rail = `48 px` exact. Cannot be collapsed; cannot be expanded.

### Z.4 `src/components/pos/SidePanel.tsx`

- `w-[280px] flex-shrink-0 border-r border-border bg-surface h-full overflow-hidden` (line 37).
- Switches between SessionPanel / HubPanel / ConfigPanel / SkillsPanel / MemoryPanel / SymphonyPanel / SystemPanel based on `activeSection` from `NavigationContext`.
- Each panel internally is `flex flex-col h-full` with a `h-14` header and `flex-1 overflow-y-auto` body.
- Width is **fixed at 280 px** — there is no resize handle, no collapse, no responsive shrink. On `<md:` the panel only shows inside the mobile drawer (where it's the same 280 px on top of a 48 px rail).

### Z.5 `src/components/pos/SessionPanel.tsx`

- `flex flex-col h-full` (line 358).
- `h-14` header with `ComboButton` to start a new session.
- `flex-1 overflow-y-auto p-2 space-y-4` body listing active and stopped sessions.
- Each `SessionItem` (line 558+) has its own internal flex with hover-revealed action icons (`opacity-0 md:group-hover:opacity-100`, line 633) — meaning **action buttons are always visible on mobile, hidden on desktop until hover**.
- `CommandPalette` (line 484) overlays via `fixed inset-0 z-[9998]` with a 92vw / 560 px max width centered with `pt-[15vh]` — uses raw vh.

### Z.6 `src/components/pos/MobileBottomBar.tsx`

- `md:hidden h-14 border-t border-border bg-surface flex items-center justify-around px-2` (line 56).
- 4 main tabs (sessions, hub, symphony, system) + 1 "Ещё" overflow.
- Tabs are vertical flex with icon + 10 px label (`text-[10px]`, line 67).
- Overflow popover positioned `fixed bottom-14 right-2 z-50 ... min-w-[140px]` — sits above the bar on tap.
- Only renders when viewport is `<md`. Adds 56 px of fixed-height chrome at the bottom.

### Z.7 `src/components/Navbar.tsx`

- `h-14 border-b border-border flex items-center justify-between px-3 md:px-5 bg-surface backdrop-blur-xl` (line 49).
- Left cluster (line 50):
  - Sidebar toggle (`hidden md:flex`) — desktop only, currently unused (no callback wired in `dashboard/page.tsx`).
  - Hamburger (`md:hidden p-2 -ml-1`) — mobile only.
  - Provider icon + session-name pill (`max-w-[150px] md:max-w-none`).
  - View-mode tab strip (Терминал/Файлы) — labels hidden `<sm`.
- Right cluster (line 118):
  - Session counter (`hidden sm:inline`).
  - Connection status (Wifi/WifiOff icon).
  - System health (admin only).
  - Admin toggle (admin only) with badge.
  - Chat toggle.
- Heights of inner icons: `w-5 h-5 md:w-4 md:h-4` (line 130, 151, 171) — **larger on mobile** for tap-target compliance.

The `backdrop-blur-xl` is disabled by the retro theme override at `globals.css:163-168`.

### Z.8 `src/components/Terminal.tsx`

- Outer `<div className="relative w-full h-full min-h-0">` (line 424).
- Inner xterm host: `<div ref={terminalRef} className="w-full h-full min-h-0" />` (line 425-428).
- Reconnect badge: `absolute top-3 left-1/2 -translate-x-1/2 z-20 ...` (line 430).
- Auth-expired badge: `absolute top-3 left-1/2 -translate-x-1/2 z-20 ...` (line 436).
- The xterm `FitAddon` calls `fit()` on mount and on `ResizeObserver` events (line 377-380). Fits to the parent's measured width/height in CSS pixels.
- xterm CSS scrollbar removed at `globals.css:189-193` (xterm v6 uses its own SmoothScroll).

The terminal does **not** use `100dvh` or `visualViewport` — it relies on `ResizeObserver` of the parent. When the iOS keyboard opens, the parent's height does *not* change (because `h-screen` doesn't shrink), so xterm never re-fits and the bottom rows stay covered by the keyboard.

### Z.9 `src/components/chat/ChatPanel.tsx`

- `flex flex-col h-full` (line 333).
- Header: `flex-shrink-0 border-b border-border` containing a `h-10` title bar and a tab strip.
- Messages area: `flex-1 overflow-y-auto overflow-x-hidden` (line 391) — **the only place in the entire dashboard with explicit `overflow-x-hidden`**.
- Reply banner (line 433): inline above the input.
- ChatInput (line 456): conditionally rendered for project channel only.

The panel's host (`page.tsx:513`) is `fixed/md:absolute top-0 right-0 bottom-0`. Its height is determined by `top-0 ... bottom-0` (a stretch via inset). On mobile this stretches to the visual viewport because of `fixed` — but again, mobile Safari's keyboard moves the visual viewport, not the layout viewport, so the panel keeps its full 100vh height while the keyboard covers 30-50% of it.

### Z.10 `src/components/FileManager.tsx`

- Outer `flex flex-col w-full h-full bg-background rounded-xl overflow-hidden relative` (line 691).
- TabBar (`min-h-[36px]`) — see Z.11.
- Toolbar: Breadcrumbs + FileToolbar inside a `border-b px-4 py-3 space-y-3` block (line 711).
- File list: `flex-1 overflow-y-auto` (line 727) wrapping `<FileList>`.
- Upload status bar: conditional `border-t px-4 py-2 bg-surface-alt` (line 758).
- Drag overlay: `fixed inset-0 z-40` (line 783) — **uses `fixed`, so it covers the entire viewport, not just the FileManager card**.

When in editor mode (`editorMode === true`, line 660), it renders `<EditorWorkspace>` instead.

`MOBILE_COLUMNS = "32px 28px 1fr 80px"` (line 80) and the desktop initial `"32px 28px 1fr 100px 140px 80px"` (line 101) define the file-list grid template at compile time. The runtime swap at line 103 happens via `useIsMobile()` (768 px breakpoint).

### Z.11 `src/components/file-manager/TabBar.tsx`

- `flex items-center border-b border-border bg-surface min-h-[36px]` (line 44).
- Tabs scroll horizontally: `flex-1 flex items-center overflow-x-auto scrollbar-none` (line 48).
- "Файлы" permanent tab (line 52) + dynamic file tabs (`max-w-[180px]` per tab).
- Add button on the right (`p-1.5 mx-1`).

The `min-h-[36px]` ensures the bar never collapses even with no tabs. With only a few tabs the strip looks fine; with 10+ tabs at 180 px each, horizontal scroll is contained inside this row.

### Z.12 `src/components/AdminPanel.tsx`

- `flex flex-col h-full` (line 97).
- Header: `h-12 flex items-center px-4 border-b border-border flex-shrink-0` (line 99).
- Content: `flex-1 overflow-y-auto` (line 105).
- User rows: `px-4 py-2.5 hover:bg-surface-hover` (line 216) with avatar (`w-8 h-8`), info (`flex-1 min-w-0`), and actions (`flex-shrink-0`).

The host slide-over (`page.tsx:498`) is identical to ChatPanel's — same width and z-index pattern.

### Z.13 `src/components/HotkeysModal.tsx`

- Backdrop: `fixed inset-0 bg-black/60 z-[60] flex items-center justify-center p-4` (line 227).
- Modal box: `bg-surface border border-border-strong rounded-[var(--th-radius)] overflow-hidden max-w-md w-full max-h-[80vh] flex flex-col` (line 236).
- Body: `flex-1 overflow-y-auto py-2` (line 246).
- Footer: `border-t border-border px-4 py-2.5 text-center shrink-0` (line 265).
- Kbd elements inside use `min-w-[28px] h-[26px]` (line 161).

The `max-h-[80vh]` is one of the keyboard traps — see §4.

### Z.14 `src/components/StoppedSessionOverlay.tsx`

- `relative w-full h-full overflow-hidden rounded-xl bg-background` (line 87).
- 5 stacked `absolute inset-0` layers: fake terminal text (line 89), gradient top-fade (line 106), gradient bottom-fade (line 107), `backdrop-blur-[2px]` (line 110), centered content (line 113).
- Centered content: `flex items-center justify-center` with `max-w-sm` (line 113-118).
- Resume button has `whileHover={{ scale: 1.02 }}` motion — works fine on touch.
- Inner card: `w-14 h-14 md:w-16 md:h-16 rounded-2xl` (line 125).

The 5-layer absolute-stack pattern works only because the parent is `relative` with explicit dimensions. If the parent has `0` height, all 5 layers collapse.

### Z.15 `src/components/WelcomeScreen.tsx`

- `flex items-center justify-center h-full relative overflow-hidden px-4` (line 34).
- `<Spotlight>` positioned `-top-40 left-0 md:left-60 md:-top-20` — see §5 for the overflow concern.
- Centered content: `text-center max-w-md relative z-10` (line 40).
- Renders `TypewriterEffect`, `FlipWords`, `TextGenerateEffect`, `ComboButton`.

### Z.16 `src/components/EditorWorkspace.tsx`

- `flex flex-col w-full h-full bg-background rounded-xl overflow-hidden` (line 465).
- TabBar.
- Header row with file path + preview-mode buttons + Save button (line 480).
- Conflict banner (conditional, line 561).
- Content area: `flex-1 min-h-0 flex` (line 583) — split between editor and preview.
- Editor pane: `min-h-0 overflow-hidden` (line 595) with inline `flexBasis` for split widths.
- Drag handle: `w-1.5 cursor-col-resize` (line 622) — for split resize on desktop.
- Preview pane: `min-h-0 overflow-hidden` (line 631) with conditional `flex-1` on mobile/fullscreen.

`isMobile` (768 px breakpoint via `useIsMobile`) gates the split mode entirely (line 435: `isSplit = showPreview && canPreview && !isMobile && !previewFullscreen`). On mobile, only single-pane (code XOR preview) is allowed.

---

## Appendix Y — Overflow chain analysis

This is a per-route trace of how a horizontal overflow could surface at the window scrollbar.

### Y.1 Path: Terminal view at <768 px

```
window
  body                  (no overflow rule)
    DashboardLayout     flex h-screen          (no overflow-x rule, h-screen)
      MobileBottomBar   md:hidden h-14         (sibling, no width contribution)
      MainColumn        flex-1 flex flex-col min-w-0   ← min-w-0 prevents column overflow
        Navbar          h-14 flex justify-between px-3   ← row, NO min-w-0 on inner clusters
        Stage           flex-1 relative
          TerminalCard  absolute inset-0 m-1     (4 px from each edge)
            Wrapper     w-full h-full rounded-xl border bg-surface-alt overflow-hidden
              ThemeBg   w-full h-full rounded-lg overflow-hidden
                Terminal  div relative w-full h-full min-h-0
                  XTerm   ResizeObserver-fitted to parent
```

For terminal view, the only overflow risk is the **Navbar inner clusters** (no `min-w-0`). The xterm canvas itself never overflows because FitAddon snaps to the parent's clientWidth.

### Y.2 Path: Symphony view at <768 px

```
window
  body
    DashboardLayout  flex h-screen
      MainColumn     flex-1 flex flex-col min-w-0
        Navbar       h-14
        Stage        flex-1 relative
          SymphonyCard absolute inset-0 m-1
            Wrapper  w-full h-full rounded-xl border bg-surface-alt overflow-hidden
              SymphonyProvider
                SymphonyDashboard
                  ProjectBoard
                    overflow-x-auto    ← scroll container
                      flex gap-3 h-full min-w-[1600px]   ← FORCED 1600 px
```

Here the `min-w-[1600px]` (`ProjectBoard.tsx:319`) is inside an `overflow-x-auto` container at line 318. The wrapper at the level above is `overflow-hidden` (the `m-1 md:m-2` card wrapper). Provided the chain is correct, the 1600 px wide row only causes scroll inside the project board. **Risk:** if a future refactor moves `min-w-[1600px]` outside the `overflow-x-auto` parent, the scroll leaks straight up to the window.

### Y.3 Path: WelcomeScreen at <768 px

```
window
  body
    DashboardLayout flex h-screen
      MainColumn    flex-1 flex flex-col min-w-0
        Navbar      h-14
        Stage       flex-1 relative
          WelcomeScreen flex items-center justify-center h-full overflow-hidden px-4
            Spotlight  pointer-events-none absolute z-[1] h-[169%] w-[138%] (animate-spotlight)
            CenteredContent text-center max-w-md relative z-10
```

Spotlight is `absolute` inside a `relative overflow-hidden` parent — clipped. **Safe.** The animation moves `transform: translate(-72%, -62%) scale(0.5)` → `translate(-50%, -40%) scale(1)` (`globals.css:31-37`). Even at scale 1, the parent clipping holds.

### Y.4 Path: AdminPanel slide-over open at <768 px

```
window
  body
    DashboardLayout flex h-screen
      MainColumn    flex-1 flex flex-col min-w-0
        ...
        Stage       flex-1 relative
          (current view, e.g. Terminal)
          Backdrop  fixed inset-0 bg-black/60 z-40 md:hidden
          Drawer    fixed top-0 right-0 bottom-0 w-full sm:w-80 md:w-96 z-50
            AdminPanel flex flex-col h-full
              Header h-12
              Body   flex-1 overflow-y-auto
```

The drawer is `position: fixed`, so it doesn't affect the layout flow. It covers the entire viewport on mobile (`w-full`). The underlying stage is hidden behind the backdrop. **Safe** for horizontal scroll; vertical: the panel uses `flex-1 overflow-y-auto`, so the body scrolls internally.

---

## Appendix X — Breakpoint-by-breakpoint behavior matrix

What changes when you cross each Tailwind breakpoint (in the dashboard tree):

### X.1 At sm: (≥640 px)

| Element | Change | File:line |
| --- | --- | --- |
| Navbar session counter | becomes visible (`hidden sm:inline`) | Navbar.tsx:120 |
| Navbar view-mode labels (Терминал/Файлы) | become visible (`hidden sm:inline`) | Navbar.tsx:99, 112 |
| Slide-over panels | shrink from `w-full` to `w-80` (320 px) | dashboard/page.tsx:498, 513 |
| Symphony PipelineAlerts dock | width = `sm:w-[360px]` | symphony/PipelineAlerts.tsx:68 |

### X.2 At md: (≥768 px)

| Element | Change | File:line |
| --- | --- | --- |
| `DashboardLayout` desktop chrome | becomes visible (`hidden md:flex`) | DashboardLayout.tsx:55 |
| `DashboardLayout` mobile drawer backdrop | hidden (`md:hidden`) | DashboardLayout.tsx:80 |
| `DashboardLayout` mobile drawer | hidden (`md:hidden`) | DashboardLayout.tsx:88 |
| `MobileBottomBar` | hidden (`md:hidden`) | MobileBottomBar.tsx:56 |
| `Navbar` hamburger | hidden (`md:hidden`) | Navbar.tsx:67-74 |
| `Navbar` desktop sidebar toggle | shown (`hidden md:flex`) | Navbar.tsx:53-64 |
| `Navbar` icon sizes | shrink from `w-5 h-5` to `md:w-4 md:h-4` | Navbar.tsx:130, 151, 171 |
| `Navbar` button paddings | shrink from `p-2` to `md:p-1.5` | Navbar.tsx:144, 163 |
| Slide-over `position` | flips from `fixed` to `md:absolute` (scoped to stage) | dashboard/page.tsx:498, 513 |
| Slide-over width | grows from `w-80` to `md:w-96` (384 px) | dashboard/page.tsx:498, 513 |
| Slide-over z-index | drops from `z-50` to `md:z-20` | dashboard/page.tsx:498, 513 |
| Slide-over close-X | hidden on desktop (`md:hidden` on the close button container) | dashboard/page.tsx:499, 514 |
| Slide-over backdrop | hidden on desktop (`md:hidden`) | dashboard/page.tsx:497, 512 |
| Stage card margins | `m-1` → `md:m-2` (8 px) | dashboard/page.tsx:386, 394, 405, 428, 437, 446, 455, 466 |
| FileManager row hover actions | switch from always-on (`opacity-100`) to hover-only (`md:opacity-0 md:group-hover:opacity-100`) | SessionPanel.tsx:633 |
| FileExplorer left tree | hidden vs flex based on `mobileShowEditor` (`hidden md:flex`) | FileExplorer.tsx:224 |
| FileExplorer right pane | hidden vs flex inverse (`hidden md:flex`) | FileExplorer.tsx:297 |
| FileManager grid columns | swap from `MOBILE_COLUMNS` (4 cols) to desktop (6 cols) via `useIsMobile()` 768 px JS hook | FileManager.tsx:103 |
| Editor split mode | enabled (`!isMobile` gate) | EditorWorkspace.tsx:435 |
| Editor preview-mode tri-button | shown (`!isMobile`) | EditorWorkspace.tsx:493 |
| Editor preview-mode toggle (mobile) | hidden (`isMobile`) | EditorWorkspace.tsx:528 |
| WelcomeScreen Spotlight position | `-top-40 left-0 md:left-60 md:-top-20` | WelcomeScreen.tsx:36 |
| StoppedSessionOverlay sizing | `w-14 h-14 md:w-16 md:h-16`, font sizes `text-[10px] md:text-xs`, etc. | StoppedSessionOverlay.tsx:90, 125, 128, 131, 132, 138, 144, 153 |
| EditorWorkspace save label | `hidden sm:inline` (already at sm:) | EditorWorkspace.tsx:555 |

### X.3 At lg: (≥1024 px)

Only used by:
- `SystemDashboard.tsx:91` — `lg:grid-cols-3` (currently shows md:grid-cols-2, lg:grid-cols-3 grid).
- UI library: `lamp.tsx`, `typewriter-effect.tsx`, `spotlight.tsx`, `floating-navbar.tsx`.

**No dashboard chrome adjustments at `lg:`.**

### X.4 At xl: (≥1280 px)

Only used by `typewriter-effect.tsx` for cursor heights. **No dashboard chrome adjustments at `xl:`.**

### X.5 At 2xl: (≥1536 px)

**Zero usages anywhere.**

---

## Appendix W — Unique findings worth flagging

1. **Two `h-screen` traps in the same file**: `DashboardLayout.tsx:49` (fullscreen branch) and `:53` (normal branch). The fullscreen branch is reached from terminal-only fullscreen toggle (`page.tsx:78`, `setFullscreen(true)`), and is meant to make the terminal occupy the full window. But it still uses `h-screen` rather than letting the document flow.
2. **No `viewport` export**: `src/app/layout.tsx` exports `metadata` but no `viewport`. Next.js 14+ accepts `export const viewport: Viewport = {…}` to control the meta tag — currently absent. The default lacks `viewport-fit=cover`, `interactive-widget`, and any `themeColor`.
3. **Two parallel `IconRail` instances in mobile drawer**: `DashboardLayout.tsx:90` re-mounts `IconRail` inside the mobile drawer on top of the desktop one (which is `hidden md:flex` — so only mobile mounts it, but the component re-mounts on every drawer open).
4. **Slide-over double-trigger risk**: `chatOpen` and `adminOpen` (`page.tsx:84-85`) are independent state. On mobile both can theoretically be open simultaneously — both render `fixed inset-0` backdrops at z-40 and `fixed top-0 right-0 bottom-0 w-full` panels at z-50. Last-rendered wins visually (ChatPanel renders after AdminPanel — chat would be on top), but both backdrops stack and both close handlers fire on the same click. Latent bug.
5. **`backdrop-blur-xl` on Navbar** (`Navbar.tsx:49`) — in dark theme this gives a frosted-glass effect; in retro theme overridden to `none` (`globals.css:163-168`). On mobile, `backdrop-blur` is GPU-expensive and on iOS Safari has known issues with elements behind the blur becoming non-interactive in some compositing edge cases.
6. **Cmd-K palette uses `z-[9998]`** (`SessionPanel.tsx:514`) — bypasses the centralized Z scale (max NAVBAR=5000 in `lib/z-index.ts`). Intentional but inconsistent.
7. **`presence-active` cursor: none** (`globals.css:215-218`) — when the terminal is active, the cursor is hidden via `cursor: none !important`. On touch devices this has no effect (no cursor), but the rule still applies.
8. **No `safe-area-inset` anywhere** in the source (`grep -rn "safe-area-inset" src/` → 0). On notched iPhones, the bottom MobileBottomBar will sit underneath the home indicator strip.
9. **`useIsMobile` is JS-side, not CSS-side** — relies on `matchMedia` and a React state update. There's a one-render delay between viewport resize and the `MOBILE_COLUMNS` swap. On the first paint at SSR hydration, `isMobile` always starts as `false` (`useIsMobile.ts:5`), so mobile users briefly see the desktop column layout before it switches.
10. **`min-h-0` is used in 4 critical places** but missing in many others (`grep -rn "min-h-0"` returned only 6 matches). Standard flexbox bug: a flex child with overflow content needs `min-h-0` (or `min-w-0`) to actually allow shrinking. Missing in: every `flex-1` child of the stage that wraps a long-content card.
11. **`cache-control: no-cache, must-revalidate`** is set globally for HTML/API in `next.config.ts:10-21`. Static assets exempted. This means every page load re-fetches the dashboard; not a layout concern but worth noting for mobile UX (cellular).
12. **`flex-1` count: 195 occurrences**, **`h-full / w-full` count: 195 occurrences**, **rounded utilities: 293 occurrences** — the codebase relies heavily on flex+full-size to fill cards, which is exactly the pattern that breaks under mobile-keyboard viewport shrinkage when the root is `h-screen`.

---

## Appendix V — Summary of scan numbers

| Metric | Count |
| --- | --- |
| Component files inspected for layout | 16 |
| Lines in `dashboard/page.tsx` | 533 |
| Lines in `globals.css` | 375 |
| Distinct view-types in stage | 7 (terminal, files, explorer, skill, memory, symphony, system, welcome — plus stopped overlay) |
| Slide-over panels (Admin, Chat) | 2 |
| Modal dialogs in dashboard tree | 7 (HotkeysModal, ProviderWizardModal, ProviderConfigModal, SessionDeleteModal, NewFileModal, DeleteConfirmModal, UnsavedChangesModal, plus CreateTaskModal in symphony) |
| Distinct z-index values in use | 11 (`z-0`, `z-10`, `z-20`, `z-30`, `z-40`, `z-50`, `z-[60]`, `z-[100]`, `z-[1]`, `z-[5000]`, `z-[9998]`) |
| Tailwind responsive prefixes referenced | 4 (`sm:`, `md:`, `lg:`, `xl:`) |
| Unique `md:` utilities found | 50+ |
| `h-screen` / `min-h-screen` usages | 4 (2 dashboard, 1 lamp UI lib, 1 symphony page) |
| `100vh` raw usages | 4 (2 aurora, 1 global-error, 1 approval HTML) |
| `100dvh` / `100svh` / `100lvh` usages | 0 |
| `safe-area-inset` usages | 0 |
| `viewport-fit` / `interactive-widget` declarations | 0 |
| Raw `@media` queries | 0 (all via Tailwind) |
| `overflow-x-auto` (intentional internal scroll) | 9 |
| `overflow-x-hidden` | 1 (`chat/ChatPanel.tsx:391`) |
| `position: fixed` instances (incl. Tailwind `fixed`) | 16 |
| `position: absolute` instances (incl. Tailwind `absolute`) | 39 |
| `min-w-0` instances | ≈12 |
| `flex-1` instances | 195 |
| `h-full` / `w-full` instances | 195 |

---

## Appendix A — files inspected

Required by the brief, all read in full or relevant portion:
- `/root/projects/claude-terminal/src/app/dashboard/page.tsx` (533 lines, full)
- `/root/projects/claude-terminal/src/app/layout.tsx` (47 lines, full)
- `/root/projects/claude-terminal/src/app/globals.css` (375 lines, full)
- `/root/projects/claude-terminal/src/components/Navbar.tsx` (178 lines, full)
- `/root/projects/claude-terminal/src/components/Terminal.tsx` (443 lines, full)
- `/root/projects/claude-terminal/src/components/chat/ChatPanel.tsx` (465 lines, full)
- `/root/projects/claude-terminal/src/components/FileManager.tsx` (821 lines, full)
- `/root/projects/claude-terminal/src/components/AdminPanel.tsx` (330 lines, full)

The brief also requested `SessionList.tsx` — that file does not exist in this codebase; the equivalent component is `/root/projects/claude-terminal/src/components/pos/SessionPanel.tsx` (685 lines, read in full). Other panels read for context: `DashboardLayout.tsx`, `IconRail.tsx`, `SidePanel.tsx`, `MobileBottomBar.tsx`, `StoppedSessionOverlay.tsx`, `WelcomeScreen.tsx`, `FileExplorer.tsx`, `EditorWorkspace.tsx`, `TabBar.tsx`, `useIsMobile.ts`, `z-index.ts`.

## Appendix B — grep summary

| Query | Hits |
| --- | --- |
| `100vh` in `src/` | 4 (2 in aurora-background, 1 in global-error inline style, 1 in approval HTML) |
| `100vw` in `src/` | 1 (PipelineAlertBanner clamp) |
| `100dvh` / `100svh` / `100lvh` | 0 |
| `h-screen` / `min-h-screen` | 4 (DashboardLayout ×2, lamp.tsx, app/symphony/page.tsx) |
| `vh` total | 11 |
| `vw` total | 3 |
| `min-w-[…]` brackets | 14 |
| `max-w-[…]` brackets | 14 |
| `w-[…]` arbitrary brackets | 27 |
| `h-[…]` arbitrary brackets | 18 |
| `@media` (raw CSS) | 0 |
| Tailwind `sm:` / `md:` / `lg:` / `xl:` lines | 111 |
| `position: fixed` (incl. Tailwind `fixed inset-0`) | 16 |
| `position: absolute` (incl. `absolute inset-0`) | 39 (incl. 8 in dashboard page.tsx alone) |
| `z-` utilities (numeric or arbitrary) | 60+ |
| `overflow-x-auto` | 9 |
| `overflow-x-hidden` | 1 (chat/ChatPanel.tsx:391) |
| `safe-area-inset` | 0 |
| `viewport-fit` / `interactive-widget` | 0 |
