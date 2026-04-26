# Phase 2 — Navigation / Overlay Components Scan

> Output of `scanner-navigation-components`.
> Mode: SCAN-only. No solutions, no edits — only documentation of current code with file:line citations.
> Scope (originally requested): `Navbar`, `SessionList`, `AdminPanel`, `HotkeysModal`, `ChatPanel`, `FileManager`, `dashboard/page.tsx`.
> Reality: there is **no `SessionList.tsx`** in the repo. The session list lives inside `pos/SessionPanel.tsx` and is composed via `pos/SidePanel.tsx` + `pos/DashboardLayout.tsx`. This scan therefore covers `SessionPanel` (the de-facto SessionList) plus the surrounding shell (`DashboardLayout`, `IconRail`, `MobileBottomBar`, `SidePanel`) because they are inseparable from the navigation surface that any mobile overhaul must touch.

---

## 0. File inventory and line counts

| Component | Path | Lines |
|---|---|---|
| Navbar | `src/components/Navbar.tsx` | 177 |
| SessionList (de-facto) | `src/components/pos/SessionPanel.tsx` | 684 (incl. internal `CommandPalette`, `SessionItem`) |
| AdminPanel | `src/components/AdminPanel.tsx` | 329 |
| HotkeysModal | `src/components/HotkeysModal.tsx` | 276 |
| ChatPanel | `src/components/chat/ChatPanel.tsx` | 464 |
| FileManager | `src/components/FileManager.tsx` | 820 |
| DashboardLayout (shell host) | `src/components/pos/DashboardLayout.tsx` | 125 |
| IconRail (left vertical icon strip) | `src/components/pos/IconRail.tsx` | 100 |
| MobileBottomBar (bottom tab bar) | `src/components/pos/MobileBottomBar.tsx` | 81 |
| SidePanel (section dispatcher) | `src/components/pos/SidePanel.tsx` | 58 |
| NavigationContext (section + panel state) | `src/lib/NavigationContext.tsx` | 88 |
| dashboard/page.tsx (state owner) | `src/app/dashboard/page.tsx` | 532 |
| globals.css | `src/app/globals.css` | 374 (no z-index tokens, no @media queries — see §3) |

> Note: `SessionList.tsx` does not exist anywhere under `src/` — verified via `find … -name "SessionList*"`. The brief's reference is stale; the planner's Phase 7 mention of `SessionList.tsx` should be re-targeted onto `SessionPanel.tsx` (and probably `IconRail`/`MobileBottomBar`/`DashboardLayout`).

---

## 1. Per-component table

Columns: **Props | State owners | Open/close trigger | Current breakpoint behavior | Z-index | A11y attrs**

### 1.1 Navbar

`src/components/Navbar.tsx`

| Field | Value |
|---|---|
| Props | `activeSessionId, activeSessionName, providerSlug, connectionStatus, sessionCount, sidebarOpen?, onToggleSidebar?, onMenuClick?, viewMode?, onSwitchView?, chatOpen?, onToggleChat?, isAdmin?, pendingCount?, adminOpen?, onToggleAdmin?` — `Navbar.tsx:9-26` |
| Internal state | None. Pure presentational shell. |
| State owners | All booleans/strings come from `dashboard/page.tsx` (see §2). Only computed value is `ProvIcon` from `getProviderIcon(providerSlug)` — `Navbar.tsx:46`. |
| Open/close triggers | Sidebar: `onToggleSidebar` (desktop, `Navbar.tsx:54`) — **not wired** by `dashboard/page.tsx` (it passes only `onMenuClick`, leaving the desktop `ChevronLeft/Right` button hidden). Hamburger: `onMenuClick` (mobile, `Navbar.tsx:69`) → `setMobileSidebarOpen(true)` in `dashboard/page.tsx:369`. Chat: `onToggleChat` → `setChatOpen(!chatOpen)` (`page.tsx:373`). Admin: `onToggleAdmin` → `setAdminOpen(!adminOpen)` (`page.tsx:377`). View-mode tabs: `onSwitchView` (`Navbar.tsx:91, 104`) → `handleSwitchView` (`page.tsx:250`). |
| Current breakpoint behavior | Hard-coded `md:` (Tailwind ≥768px) split throughout: <ul><li>`hidden md:flex` desktop sidebar button — `Navbar.tsx:55`</li><li>`md:hidden` hamburger — `Navbar.tsx:70`</li><li>Padding `px-3 md:px-5` — `Navbar.tsx:49`</li><li>Session label width `max-w-[150px] md:max-w-none` — `Navbar.tsx:79`</li><li>View-mode tab labels: `<span className="hidden sm:inline">Терминал</span>` (`Navbar.tsx:99`, `Navbar.tsx:112`) — labels collapse below `sm` (640px), only icons remain</li><li>Session counter `hidden sm:inline` — `Navbar.tsx:120`</li><li>Connection icon `w-4 h-4 md:w-3.5 md:h-3.5` — bigger on mobile — `Navbar.tsx:130, 132`</li><li>Admin/Chat buttons `p-2 md:p-1.5` and `w-5 h-5 md:w-4 md:h-4` — bigger touch targets on mobile — `Navbar.tsx:144, 151, 164, 171`</li></ul> Height fixed `h-14` (56 px) — `Navbar.tsx:49`. |
| Z-index | None on Navbar root (relies on parent stacking context — DashboardLayout right column at `flex-1`, `pos/DashboardLayout.tsx:117`). Internal absolutely-positioned pending badge: `absolute -top-1 -right-1` — `Navbar.tsx:153`. |
| A11y attrs | Only the view-mode toggle group is annotated: `role="tablist" aria-label="View mode"` — `Navbar.tsx:87`; `role="tab" aria-selected={…}` — `Navbar.tsx:90, 103`. Other icon-only buttons use `title` only; **no `aria-label`** on chat/admin/hamburger buttons (`Navbar.tsx:69, 142, 162`). |

---

### 1.2 SessionList → actually `pos/SessionPanel`

`src/components/pos/SessionPanel.tsx`

| Field | Value |
|---|---|
| Props | `activeSessionId, onSelectSession, onSessionDeleted, onNewSession, onOpenFiles?, onResumeSession?, resumingSessionId?, creatingSession?` — `SessionPanel.tsx:28-37`. |
| Internal state | Heavy. <ul><li>`sessions: Session[]` (re-fetched every 1.5–5 s) — `SessionPanel.tsx:49, 122-126`</li><li>Inline rename: `editingId, editName` — `:50-51`</li><li>`deleteTarget: Session\|null` — `:52`</li><li>`wizardOpen, configProvider` (provider modals) — `:53-54`</li><li>`selectedSlug` (current provider; mirrored to `localStorage` "selectedProvider") — `:58-63`</li><li>Mute toggle `muted` mirrored to `localStorage` "soundMuted" — `:68-71`</li><li>`seenMap` mirrored to `localStorage` "sessionSeenMap" (per-session unread tracking) — `:74-77`</li><li>`paletteOpen, paletteQuery, paletteIndex` (Cmd/Ctrl-K command palette) — `:78-80`</li><li>Refs: `prevBusyRef`, `audioRef`, `seenOnceRef`, `lastBadgeRef`, `originalFaviconRef` — `:65-73`</li></ul> |
| State owners | `activeSessionId` is **lifted to `dashboard/page.tsx:74`** (`useState<string\|null>`). Provider list comes from `useProviders()` context (`ProviderContext`). Everything else is local. |
| Open/close triggers | Container `SessionPanel` itself is **always rendered** when `activeSection === "sessions"` (`SidePanel.tsx:38`). Its visibility is gated by `panelOpen` (NavigationContext) on desktop (`DashboardLayout.tsx:57`) and by `mobileSidebarOpen` on mobile (`DashboardLayout.tsx:73`). Internal overlays: `wizardOpen`, `configProvider`, `deleteTarget`, `paletteOpen`. Palette opens via Ctrl/Cmd+K (`SessionPanel.tsx:228-235`). Closes on Esc / outside click. |
| Current breakpoint behavior | Limited responsive tweaks: <ul><li>Row vertical padding `py-3 md:py-2.5` — `SessionPanel.tsx:585`</li><li>Action buttons stay visible on mobile (`opacity-100 md:opacity-0 md:group-hover:opacity-100`) — `:633` — i.e. **hover-on-desktop, always-on-mobile**, good for touch.</li><li>Icon sizes `w-4 h-4 md:w-3.5 md:h-3.5` (Pause/Play/Folder/Pencil/Trash) — `:640, :644, :649, :653, :656`</li><li>Spinner `w-4 h-4 md:w-3.5 md:h-3.5` — `:636`</li><li>Tap targets `p-2 md:p-1` — `:639, :643, :648, :652, :655` (16-px hit area on mobile)</li><li>Header height `h-14` — `:360`</li></ul> No collapsed/condensed mode of its own — relies on the wrapper drawer. |
| Z-index | Command palette: `z-[9998]` (`SessionPanel.tsx:514`) — highest in the app, deliberately above modals. |
| A11y attrs | Almost none. Only `aria-label={muted ? "Unmute" : "Mute"}` on the volume toggle (`:386`). All other icon buttons rely on `title`. No landmarks, no `role` on the list. |

---

### 1.3 AdminPanel

`src/components/AdminPanel.tsx`

| Field | Value |
|---|---|
| Props | `onPendingCountChange?: (count: number) => void` — `AdminPanel.tsx:17-19`. Single callback, no `open`/`onClose`. |
| Internal state | `users, loading, actionLoading, deleteConfirm` — `:22-25`. |
| State owners | Whether it is shown is owned by `dashboard/page.tsx:85` (`adminOpen`). Pending count is bidirectionally synced: page passes `setPendingCount` (`page.tsx:502`), AdminPanel calls it after each fetch (`AdminPanel.tsx:34`). |
| Open/close triggers | The component itself has no open/close API — it is mounted/unmounted by `dashboard/page.tsx:495` based on `adminOpen && isAdmin`. Internally: `deleteConfirm` is per-user inline confirm; `actionLoading` is per-user spinner. Listens to `window` event `"admin:pending-user"` (`:48`) for live refresh. |
| Current breakpoint behavior | **None.** Zero `sm:`/`md:`/`lg:` classes inside the component. Only the wrapper in `dashboard/page.tsx:498` does responsive width: `w-full sm:w-80 md:w-96`. |
| Z-index | Wrapper (in page.tsx): backdrop `z-40 md:hidden` (`page.tsx:497`); panel itself `z-50 md:z-20` (`page.tsx:498`). On mobile it floats above everything; on desktop it sits under the navbar but inside the content area. |
| A11y attrs | None. No `role`, no `aria-label`. The `select` for role uses native semantics only (`:272-279`). |

---

### 1.4 HotkeysModal

`src/components/HotkeysModal.tsx`

| Field | Value |
|---|---|
| Props | `open: boolean, onClose: () => void` — `HotkeysModal.tsx:199-202`. |
| Internal state | None (data is a top-level `HOTKEY_GROUPS` constant). Reads OS via `useOS()` hook (`:205`). |
| State owners | `hotkeysOpen` is owned by `IconRail` (`pos/IconRail.tsx:27`) — **NOT** by `dashboard/page.tsx`. Triggered by Keyboard icon button at `IconRail.tsx:82`. |
| Open/close triggers | Open: `setHotkeysOpen(true)` from IconRail. Close: backdrop click (`HotkeysModal.tsx:228`), Esc key (`:207-218`), or `ModalTitleBar`'s close button (`:243`). |
| Current breakpoint behavior | None. Single layout: centered card `max-w-md w-full max-h-[80vh]` — `:236`. Padding `p-4` on backdrop — `:227`. The 80vh trap is a known mobile risk (uses static `vh` rather than `dvh`). |
| Z-index | `z-[60]` on backdrop — `:227` (commented `/* Z.MODAL */`). Same tier as ProviderConfigModal, ProviderWizardModal, NewFileModal, UnsavedChangesModal, DeleteConfirmModal, SessionDeleteModal, PipelineAlerts. |
| A11y attrs | None on the modal root (`role="dialog"` missing, no `aria-modal`, no `aria-labelledby`). Only `<kbd>` semantics on key caps (`:160-165`). ModalTitleBar provides `aria-label="Закрыть"` (`ModalTitleBar.tsx:17, 67`). Esc handler is wired manually (`:207-218`). No focus trap. |

---

### 1.5 ChatPanel

`src/components/chat/ChatPanel.tsx`

| Field | Value |
|---|---|
| Props | `onImageClick?: (src: string) => void` — `ChatPanel.tsx:54-56`. |
| Internal state | Two-component split. Outer `ChatPanel` keeps `showGallery` (`:59`) → swap-renders `MediaGallery` instead of messages. Inner `ChatPanelMessages` holds: <ul><li>`messages: ChatMessageData[]` + `messagesRef` mirror — `:92-93, 104-110`</li><li>`replyTarget` — `:94`</li><li>`agentRoles, roleMap` — `:95, 99`</li><li>`loading, loadingOlder, hasMore` — `:96-98`</li><li>`activeChannel: 'project' \| 'watercooler'` — `:132`</li><li>`watercoolerMessages, watercoolerLoading` — `:133-134`</li><li>Refs `scrollRef`, `isAtBottomRef`, `initialLoadDone` — `:100-102`</li></ul> Live messages from `usePresence().globalChatMessages` (`:91, 213-231`); watercooler messages from `window.addEventListener("symphony:watercooler-message")` (`:309-327`). |
| State owners | `chatOpen` is owned by `dashboard/page.tsx:84` (`useState(false)`). Toggled from Navbar via `onToggleChat`. Like AdminPanel, ChatPanel itself has no open API — it is conditionally mounted at `page.tsx:510`. |
| Open/close triggers | Mounted/unmounted via `chatOpen`. Internal navigation: `showGallery` swap (`ChatPanel.tsx:61-68`); tabs `Проект`/`Watercooler` (`:355-381`). Send: `handleSend` (`:234`); reply: `handleReply` (`:112-115`). |
| Current breakpoint behavior | None on `ChatPanel` itself. All breakpoint logic is in the wrapper at `dashboard/page.tsx:513` (`w-full sm:w-80 md:w-96`). The header is `h-10` (`:337`); messages area `flex-1 overflow-y-auto overflow-x-hidden` (`:391`); input row `ChatInput` has no responsive logic either. |
| Z-index | Wrapper backdrop `z-40 md:hidden` (`page.tsx:512`); panel `z-50 md:z-20` (`page.tsx:513`). Same tier as AdminPanel — they would collide if both ever open simultaneously (see §5). |
| A11y attrs | Best in the navigation set. `role="tablist" aria-label="Каналы чата"` (`:354`), each tab has `role="tab" aria-selected aria-controls` (`:356-380`). Messages container is `role="tabpanel" id="chat-panel-…" aria-label=…` (`:388-390`). No `role="dialog"` though, and no focus trap. |

---

### 1.6 FileManager

`src/components/FileManager.tsx`

| Field | Value |
|---|---|
| Props | `sessionId: string, initialFile?: string\|null, visible?: boolean` (default `true`) — `FileManager.tsx:82-86`. |
| Internal state | Very heavy (~25 useState/useRef). Highlights: <ul><li>`currentPath, entries, loading` — `:91-93`</li><li>`selectedPaths: Set<string>` — `:94`</li><li>`sortBy, sortDir, searchQuery` — `:95-97`</li><li>`renamingEntry, renameName, deleteConfirm` — `:98-100`</li><li>`columnWidths` (default `"32px 28px 1fr 100px 140px 80px"`) — `:101`</li><li>`isMobile = useIsMobile()` — `:102`; replaces columnWidths with `MOBILE_COLUMNS = "32px 28px 1fr 80px"` — `:80, :103`</li><li>`searchResults, searchLoading` — `:104-105`</li><li>`newFileModal` — `:107`</li><li>Upload: `uploading, uploadError, isDragging`, `dragCounterRef` — `:110-113`</li><li>Editor tabs via `useEditorTabs(sessionId)` — `:117-122`</li><li>External-close handshake: `pendingCloseRef`, `showExternalUnsavedModal` — `:626-627`</li></ul> Two render branches: editor mode (`if (editorMode)` → `EditorWorkspace`, `:660-687`) vs file-list mode (everything else). |
| State owners | Mounted at `dashboard/page.tsx:388` only when `activeSessionId && activeSection === "sessions" && viewMode === "files"`. Page owns `activeSessionId`, `viewMode`, `initialFile`. Editor unsaved-state is published via `EditorContext` (`:127-129`); page reads `hasUnsavedChanges` from there for `beforeunload` and view-switch guards (`page.tsx:71, 155, 188-191, 251-254`). |
| Open/close triggers | The whole component closes by `viewMode → "terminal"` (no `open` prop). Sub-modals: `DeleteConfirmModal` (`:800`), `NewFileModal` (`:807`), `UnsavedChangesModal` (`:679`). Drag-and-drop overlay shown via `isDragging` (`:776-797`). |
| Current breakpoint behavior | <ul><li>Single explicit consumer of `useIsMobile()` in the codebase — `:102`</li><li>Mobile-only column template `"32px 28px 1fr 80px"` (drops size + mtime cols) — `:80, :103`</li><li>Drag overlay uses `bg-accent/10 backdrop-blur-[2px]` and is full-screen `fixed inset-0` — fine for any width</li><li>Toolbar/breadcrumbs use `px-4 py-3 space-y-3` (no responsive variants) — `:711`</li><li>The wrapper at `dashboard/page.tsx:386` adds `m-1 md:m-2` outer margin, no other size logic.</li></ul> |
| Z-index | Drag overlay `z-40` (`:783`). Sub-modals (NewFile, DeleteConfirm, UnsavedChanges) all `z-[60]`. |
| A11y attrs | None at the FileManager root (no `role`, no `aria-label`). Sub-components have their own (e.g. `Breadcrumbs`, `FileToolbar` not audited here). |

---

### 1.7 Shell composition (DashboardLayout / IconRail / SidePanel / MobileBottomBar)

These are not in the original brief but are unavoidable for any nav refactor.

| Component | Key facts (file:line) |
|---|---|
| **DashboardLayout** (`pos/DashboardLayout.tsx`) | Splits into `hidden md:flex` desktop column (IconRail + optional SidePanel) — `:55-69`, plus an `AnimatePresence` mobile drawer that re-mounts both IconRail and SidePanel inside a slide-in `motion.div` — `:72-114`. Backdrop `z-30 md:hidden` (`:80`); drawer `z-40 md:hidden` (`:88`); inner close button `z-50` (`:92`). Children render in a flex column (`flex-1 flex flex-col min-w-0`, `:117-119`). `MobileBottomBar` is always rendered at the bottom (`:122`) — internally `md:hidden`. Fullscreen short-circuit at `:48-50`. |
| **IconRail** (`pos/IconRail.tsx`) | Width fixed `w-12` — `:42`. Renders 7 section icons (`SECTIONS`, `:14-22`) + theme/hotkeys/logout footer. State: `panelOpen, activeSection` from NavigationContext — `:25`; local `hotkeysOpen` — `:27`. Click handler at `:31-38`: same-section click toggles `panelOpen`; new-section click sets section + auto-collapses panel for `FULL_WIDTH_SECTIONS = ["symphony", "system"]` (`:29`). Owns `<HotkeysModal open={hotkeysOpen} … />` — `:97`. A11y: each button has `aria-label={label}` and `title={label}` — `:57-58`. |
| **SidePanel** (`pos/SidePanel.tsx`) | `w-[280px] flex-shrink-0` fixed — `:37`. Pure switch over `activeSection` — `:38-55` — to one of `SessionPanel / HubPanel / ConfigPanel / SkillsPanel / MemoryPanel / SymphonyPanel / SystemPanel`. Pass-through props for SessionPanel only. |
| **MobileBottomBar** (`pos/MobileBottomBar.tsx`) | Fixed bottom row `md:hidden h-14` — `:56`. Four primary tabs (`MAIN_TABS` `:7-12`: sessions/hub/symphony/system) + overflow `Ещё` button (`:69-77`) revealing config/skills/memory in a popup at `bottom-14 right-2` — `:38`. Local `moreOpen` — `:22`. Backdrop `fixed inset-0 z-40` — `:37`; popup `z-50` — `:38`. Sets `panelOpen=false` for full-width sections — `:28`. |

---

## 2. State-ownership graph

`dashboard/page.tsx` is the de-facto orchestration root. NavigationContext is the **only context** that touches navigation; it owns section + side-panel-open state and is read by IconRail, MobileBottomBar, SidePanel, DashboardLayout.

```
dashboard/page.tsx (DashboardInner, page.tsx:64)
├── activeSessionId        useState<string|null>           page.tsx:74
│       └── consumed by:   Navbar (prop)                   page.tsx:364
│                          DashboardLayout → SidePanel → SessionPanel  page.tsx:349, SidePanel.tsx:38
│                          FileManager (prop)              page.tsx:388
│                          Terminal (prop)                 page.tsx:416
│                          presenceJoin(activeSessionId)   page.tsx:163
│
├── activeProviderSlug     useState<string>                page.tsx:75
├── viewMode: "terminal"|"files"  useState<ViewMode>      page.tsx:81
│       └── consumed by:   Navbar (prop)                   page.tsx:370
│                          FileManager visible= viewMode==="files"  page.tsx:388
│                          conditional Terminal render     page.tsx:392
│       └── persisted to:  sessionStorage `session-viewmode-{sid}`  page.tsx:185, :194, :201, :257
│
├── connectionStatus       useState<"connected"|"disconnected"|"idle">  page.tsx:79
│       └── from:          Terminal onConnectionChange     page.tsx:239, :416
│       └── to:            Navbar (prop)                   page.tsx:367
│
├── chatOpen               useState<boolean>               page.tsx:84
│       └── trigger:       Navbar onToggleChat             page.tsx:373
│       └── consumed by:   AnimatePresence overlay         page.tsx:510
│
├── adminOpen              useState<boolean>               page.tsx:85
│       └── trigger:       Navbar onToggleAdmin            page.tsx:377
│       └── consumed by:   AnimatePresence overlay         page.tsx:495
│
├── pendingCount           useState<number>                page.tsx:86
│       └── source:        initial fetch                   page.tsx:100-112
│                          PresenceProvider onPendingUser  page.tsx:114-117
│                          AdminPanel.onPendingCountChange page.tsx:502 → AdminPanel.tsx:34
│       └── to:            Navbar (badge prop)             page.tsx:375
│
├── lightboxSrc            useState<string|null>           page.tsx:87
│       └── trigger:       ChatPanel.onImageClick          page.tsx:517
│
├── mobileSidebarOpen      useState<boolean>               page.tsx:77
│       └── trigger:       Navbar onMenuClick              page.tsx:369
│       └── consumed by:   DashboardLayout (prop)          page.tsx:358
│       └── auto-closed on: handleSelectSession  page.tsx:199
│                            handleNewSession    page.tsx:230
│                            handleOpenFiles     page.tsx:246
│                            handleResumeSession page.tsx:277
│
├── fullscreen             useState<boolean>               page.tsx:78
│       └── consumed by:   DashboardLayout fullscreen short-circuit (DashboardLayout.tsx:48)
│                          terminal margin                 page.tsx:405
│                          showNavbar = !fullscreen        page.tsx:315
│
├── welcomeSelectedSlug    useState<string>                page.tsx:92  (mirrors localStorage "selectedProvider")
├── welcomeWizardOpen      useState<boolean>               page.tsx:96
└── welcomeConfigProvider  useState<Provider|null>         page.tsx:97

Contexts wrapping DashboardInner (page.tsx:46-61):
  ThemeProvider → UserProvider → PresenceProvider → ProviderProvider → EditorProvider → NavigationProvider

NavigationContext (NavigationContext.tsx:48)
├── activeSection: Section                                 NavigationContext.tsx:5, :49
│       └── persisted: localStorage "pos_section"          NavigationContext.tsx:55
│       └── readers: IconRail, MobileBottomBar, SidePanel,
│                    dashboard/page.tsx (workspaceView sync useEffect, page.tsx:318-344)
├── panelOpen: boolean                                     NavigationContext.tsx:50
│       └── persisted: localStorage "pos_panel"            NavigationContext.tsx:60
│       └── readers: DashboardLayout (gates SidePanel render), IconRail (toggles), MobileBottomBar
└── workspaceView: WorkspaceView                           NavigationContext.tsx:51, :7-15
        discriminated union driving main content area in dashboard/page.tsx:382-491

EditorContext (used by FileManager + page)
  hasUnsavedChanges, requestClose(), setCloseHandler()
  FileManager registers async close handler                FileManager.tsx:629-638
  page consults requestClose() on view/session switch      page.tsx:188, :252

PresenceContext  (joinSession, onPendingUser, globalChatMessages)
  page.tsx:163  presenceJoin(activeSessionId)
  page.tsx:116  onPendingUser → setPendingCount

Local-but-important leaf state:
  IconRail.hotkeysOpen   IconRail.tsx:27  (HotkeysModal open lives here, not in page.tsx)
  MobileBottomBar.moreOpen MobileBottomBar.tsx:22
  SessionPanel: paletteOpen :78, wizardOpen :53, configProvider :54, deleteTarget :52,
                editingId :50, selectedSlug :58 (localStorage "selectedProvider"),
                muted :68 (localStorage "soundMuted"),
                seenMap :74 (localStorage "sessionSeenMap")
  ChatPanelMessages.activeChannel ChatPanel.tsx:132, replyTarget :94, showGallery (outer) :59
  FileManager: 25+ pieces of local state; editor tabs via useEditorTabs hook
```

**Pattern summary**: state is **lifted to `dashboard/page.tsx`** for everything that crosses the Navbar-↔-overlay boundary (chat/admin/mobile-sidebar/active session/view mode/fullscreen/pending count). Side-section navigation (which "section" is active, whether the side panel is open) is **in NavigationContext**. There is **no global store** — no Zustand/Jotai/Redux/Context-for-overlays. HotkeysModal is the lone exception: its open state lives in IconRail because no other component references it.

---

## 3. Existing responsive logic

### 3.1 Tailwind breakpoint usage (`md:` / `sm:` / `lg:`)

There is **no custom `tailwind.config` for `screens`** referenced in any of the audited files; Tailwind defaults are in effect (`sm` 640px, `md` 768px, `lg` 1024px, `xl` 1280px, `2xl` 1536px). All responsive logic is via plain Tailwind utility prefixes.

By component:

- **Navbar** (Navbar.tsx)
  - `px-3 md:px-5` :49
  - `hidden md:flex` desktop sidebar toggle :55
  - `md:hidden` hamburger :70
  - `max-w-[150px] md:max-w-none` session label :79
  - `hidden sm:inline` "Терминал" / "Файлы" labels :99, :112
  - `hidden sm:inline` session counter :120
  - `w-4 h-4 md:w-3.5 md:h-3.5` connection icon :130, :132
  - `p-2 md:p-1.5`, `w-5 h-5 md:w-4 md:h-4` admin / chat / fullscreen buttons :144, :151, :164, :171
- **dashboard/page.tsx**
  - `m-1 md:m-2` outer margin around content panes (FileManager/Terminal/Symphony/etc. — many lines, e.g. :386, :394, :405, :428, :437, :446, :455, :466)
  - `p-2 md:p-1.5`, `w-5 h-5 md:w-4 md:h-4` fullscreen toggle :409, :412
  - Right-side overlays (admin, chat) backdrop `z-40 md:hidden` :497, :512
  - Right-side overlay panel `fixed md:absolute … w-full sm:w-80 md:w-96 z-50 md:z-20 …` :498, :513
  - Mobile-only close X button on those overlays `md:hidden` :499, :514
- **DashboardLayout** (pos/DashboardLayout.tsx)
  - Desktop column `hidden md:flex` :55
  - Mobile drawer & backdrop `md:hidden` :80, :88
- **MobileBottomBar** (pos/MobileBottomBar.tsx)
  - Whole bar `md:hidden` :56
- **SessionPanel** (SessionPanel.tsx)
  - `py-3 md:py-2.5` row height :585
  - `opacity-100 md:opacity-0 md:group-hover:opacity-100` action buttons :633
  - `gap-1 md:gap-0.5` button spacing :633
  - `p-2 md:p-1`, `w-4 h-4 md:w-3.5 md:h-3.5` action buttons :636, :639–:656
- **AdminPanel** — none
- **HotkeysModal** — none
- **ChatPanel** — none (relies on parent overlay sizing)
- **FileManager** — none directly (uses `useIsMobile()` instead, see below); only `m-1 md:m-2` from page-level wrapper
- **IconRail** — none (always visible inside the parent's `md:flex` container)
- **SidePanel** — none

### 3.2 JS-side media-query

- `useIsMobile(breakpoint = 768)` — `src/lib/useIsMobile.ts:4-13`. Wraps `window.matchMedia("(max-width: 767px)")` with state. **Single consumer in this scan: `FileManager.tsx:102`**, used to swap to a four-column file list (`MOBILE_COLUMNS`, line 80). No other audited component uses it.
- No `useMediaQuery` hook exists; no other `matchMedia` calls found in `src/`.

### 3.3 Conditional renders by viewport

- `DashboardLayout.tsx:55, :72` — desktop tree vs mobile drawer split via Tailwind.
- `MobileBottomBar.tsx:56` — visible only `md:hidden`.
- `dashboard/page.tsx:497, :512` — backdrop only on mobile (`md:hidden`).
- `dashboard/page.tsx:498, :513` — overlay positioning swaps `fixed → md:absolute` and z-index `z-50 → md:z-20`.
- No JS branch renders different React subtrees by viewport (everything is one tree, hide/show via CSS), with the sole exception of `FileManager`'s column template swap.

### 3.4 globals.css

- 374 lines, contains theme variables and tokens.
- **Zero `@media` queries** (`grep "@media"` returns nothing).
- **No safe-area** (`env(safe-area-inset-…)`) usage.
- **No `dvh`/`svh`/`lvh`** usage.
- **No `--th-z-…` z-index design tokens** — the comments `/* Z.MODAL */` next to `z-[60]` literals (in HotkeysModal.tsx:227, ProviderConfigModal.tsx:94, etc.) appear to refer to a planned token system that has not been implemented.

### 3.5 Viewport meta / safe-area

Not in the scope of this scan (covered by sibling agent `scanner-styling-and-meta`), but worth noting that **none of the audited components reference safe-area or `100dvh`**. HotkeysModal uses `max-h-[80vh]` which is a known mobile issue when the URL/tab bar collapses.

---

## 4. Hamburger / drawer audit

Does any component already have a mobile collapse mode?

**Yes — but only at the shell level.** Detail:

- **Hamburger button in Navbar** — `Navbar.tsx:67-74`. Renders only when `onMenuClick` is provided (always provided by `dashboard/page.tsx:369`). The button is `md:hidden`, uses the `Menu` icon, and on click invokes `setMobileSidebarOpen(true)` in the dashboard. **This is the only hamburger trigger in the app.** There is no standalone `MobileNav.tsx`/`MobileDrawer.tsx`/`Hamburger.tsx` file — `find … -iname "Drawer*"` and `find … -iname "Sheet*"` both return empty.

- **Mobile drawer at the shell level** — `pos/DashboardLayout.tsx:72-114`. When `mobileSidebarOpen`, an `AnimatePresence` renders:
  - Backdrop `motion.div` (opacity 0→1, `z-30`) — `:74-82`.
  - Slide-in container animating `x: -100% → 0` with `spring damping=25 stiffness=300` — `:83-89`. Inside it, IconRail (full width 48 px) + a 280-px SidePanel — `:90-110`. Close button absolutely positioned top-right inside the drawer — `:92-99`.
  - The drawer dismisses on backdrop click (`:81`) or the close `X` (`:94-98`). **No edge-swipe-to-open gesture** is implemented anywhere.

- **MobileBottomBar** — `pos/MobileBottomBar.tsx`. Acts as a persistent mobile bottom-tab-bar, `md:hidden h-14`, with four primary section icons + an "Ещё" overflow popup that slides up from `bottom-14 right-2` (`:38`). Switching a tab calls `setActiveSection` and `setPanelOpen` (`:26-30`); for `symphony`/`system` it sets `panelOpen=false` so the heavy panels expand full-width. **This is a real mobile nav surface that already coexists with the hamburger drawer.**

- **No collapsed/condensed mode inside SessionPanel itself.** It is a fixed 280-px column that depends on the wrapper drawer/SidePanel for visibility.

- **AdminPanel & ChatPanel mobile drawer**: implemented at the page level (`page.tsx:497-505, :510-521`), not in the components themselves. Slides in from the right (`x: "100%" → 0`, spring damping=30 stiffness=300), full width on mobile (`w-full`), 320 px at `sm`, 384 px at `md`. Has its own backdrop (only on mobile, `md:hidden`).

- **HotkeysModal**: standard centered modal — **no mobile mode**. Will look fine but uses `max-h-[80vh]` which truncates poorly on iOS Safari with the URL bar showing.

- **FileManager**: no drawer; switches column count via `useIsMobile()`. The editor mode (`editorMode` branch) replaces the entire layout with `EditorWorkspace` — that subcomponent's mobile behavior is out of scope for this scan.

- **CommandPalette** (inside SessionPanel) — `:514` — fixed full-screen overlay at `z-[9998]`. Not a drawer; centered card `w-[min(560px,92vw)]` so it does scale to mobile width, but there is no mobile-specific behavior.

---

## 5. Overlap risks at 360 px viewport

Components that share or overlap the right edge / bottom edge, ranked by collision severity.

### 5.1 AdminPanel ↔ ChatPanel — same wrapper geometry

Both rendered in the same `<div className="flex-1 relative">` (`page.tsx:382`) with effectively identical wrappers:

- `page.tsx:498`: admin panel `fixed md:absolute top-0 right-0 bottom-0 w-full sm:w-80 md:w-96 z-50 md:z-20`
- `page.tsx:513`: chat panel **identical class string**.

If both `adminOpen` and `chatOpen` were true simultaneously on a 360-px viewport, they would stack on the same `z-50` layer (last one rendered wins; chat is rendered after admin in `page.tsx`, so chat would visually cover admin), but the two backdrops would also stack. **No state machine prevents simultaneous open.** Toggling chat while admin is open today produces a broken-looking double-overlay state. On desktop the same conflict applies but at `z-20` and 384 px width (panels would overlap the terminal pane only, not each other since both anchor right; but admin would be hidden under chat).

### 5.2 ChatPanel/AdminPanel ↔ MobileBottomBar (z-index + height)

- MobileBottomBar overlays its own popup at `z-50` (`MobileBottomBar.tsx:38`) and the bar itself sits at the bottom (`md:hidden h-14`, `:56`) inside the same `flex` parent (`DashboardLayout.tsx:53, :122`).
- AdminPanel/ChatPanel mobile overlay is `bottom-0` (`page.tsx:498, :513`) — they extend behind the bottom bar because they are `fixed inset` on mobile and the bottom bar is also fixed but lives in the layout flex (it's not `position:fixed`, just bottom-of-flex, which means the panels don't actually push it).
- Concretely: at 360 px mobile, an open ChatPanel covers the entire screen *including* the area where the bottom bar would be (because the bar is in the right column flex, but the chat overlay is `fixed inset` from page level). The bar gets visually overlapped by the chat panel's right edge area only (since chat is full-width on mobile, `w-full`) — i.e. **the user cannot reach the bottom-tab-bar while chat or admin is open** unless they close the overlay. The chat panel input row sits at the very bottom edge (no safe-area inset), which on iPhone with home indicator will be partly under the indicator.

### 5.3 Mobile sidebar drawer ↔ ChatPanel/AdminPanel

- Sidebar drawer slides from the **left** (`x: -100% → 0`, `DashboardLayout.tsx:84`) at `z-40`.
- Admin/Chat slide from the **right** (`x: 100% → 0`, `page.tsx:498, :513`) at `z-50`.
- If you opened the sidebar then somehow triggered chat (Navbar has the trigger but Navbar is hidden by sidebar drawer, so this only happens via fullscreen toggle path), chat would cover sidebar — **but the sidebar's auto-close on `onSelectSession` etc. (page.tsx:199, :230, :246, :277) avoids most cases**. Still no explicit mutual-exclusion logic.

### 5.4 HotkeysModal ↔ everything

`z-[60]` with no responsive width logic. On a 360-px viewport, `max-w-md w-full max-h-[80vh] p-4` produces a card the full width minus 32 px of backdrop padding. Fine geometrically. But because `z-[60]` < `z-[9998]` (CommandPalette) and < `z-[100]` (ImageLightbox, TabContextMenu), if the user opens HotkeysModal then triggers Cmd/Ctrl+K (which is global), the command palette renders **above** the hotkeys modal — ugly but probably acceptable since palette won.

### 5.5 CommandPalette ↔ all overlays

`z-[9998]` (`SessionPanel.tsx:514`) — beats every other overlay by orders of magnitude. The palette listens for Cmd/Ctrl+K globally (`SessionPanel.tsx:228-235`) and is mounted whenever SessionPanel is mounted (i.e. whenever `activeSection === "sessions"`). Triggering it while any other overlay is open will draw it on top — intended. **However** the keydown listener does not check whether focus is in another input (e.g. ChatInput's textarea), so typing Cmd+K in chat opens the palette and prevents the keystroke from reaching the textarea. Outside the scan brief but worth flagging.

### 5.6 Terminal fullscreen toggle ↔ overlays

`fullscreen` (`page.tsx:78`) hides the Navbar (`showNavbar = !fullscreen`, `:315`) and short-circuits DashboardLayout (`DashboardLayout.tsx:48-50`). When fullscreen is on:
- Navbar is gone → no chat/admin/hamburger triggers reachable.
- AnimatePresence overlays (admin/chat) **are still mounted** since they live in `dashboard/page.tsx`'s `<div className="flex-1 relative">` (page.tsx:382), which is rendered as part of `children` inside the short-circuited DashboardLayout. So if chat was open before going fullscreen it stays open — and now there is no way to close it except via its own X button on mobile (`page.tsx:515`) or backdrop click. On desktop, no X button is rendered (`md:hidden`) — escape requires re-toggling fullscreen first.

### 5.7 Z-index full inventory (audited files only)

| Layer | Value | File:line |
|---|---|---|
| Page-level CommandPalette | `z-[9998]` | SessionPanel.tsx:514 |
| ImageLightbox | `z-[100]` | chat/ImageLightbox.tsx:25 |
| TabContextMenu | `z-[100]` | file-manager/TabContextMenu.tsx:52 |
| Modals (HotkeysModal + 5 others) | `z-[60]` | HotkeysModal.tsx:227 + Provider*Modal, *DeleteModal, NewFileModal, UnsavedChangesModal |
| PipelineAlerts | `z-[60]` | symphony/PipelineAlerts.tsx:68 |
| Mobile right overlays (admin, chat) | `z-50` mobile / `z-20` desktop | page.tsx:498, :513 |
| Mobile drawer close X | `z-50` | DashboardLayout.tsx:92 |
| Mobile bottom bar overflow popup | `z-50` | MobileBottomBar.tsx:38 |
| Mobile drawer container | `z-40` | DashboardLayout.tsx:88 |
| Mobile right overlay backdrops | `z-40` | page.tsx:497, :512 |
| Mobile bottom bar overflow backdrop | `z-40` | MobileBottomBar.tsx:37 |
| FileManager drag overlay | `z-40` | FileManager.tsx:783 |
| Mobile drawer backdrop | `z-30` | DashboardLayout.tsx:80 |
| Fullscreen toggle button (in-content) | `z-10` | page.tsx:409 |
| Mobile-only X close inside overlays | `z-10` | page.tsx:499, :514 |

No design tokens. No `--th-z-*` CSS vars. No constants module.

---

## 6. Decisions closed

### 6.1 Which component owns "active session" state?

**`dashboard/page.tsx`.** Defined at `page.tsx:74` as `const [activeSessionId, setActiveSessionId] = useState<string | null>(null)`. Every consumer receives it via prop drilling: Navbar (`:364`), DashboardLayout → SidePanel → SessionPanel (`:349` → `SidePanel.tsx:38` → `SessionPanel.tsx:39`), FileManager (`:388`), Terminal (`:416`). PresenceProvider gets it via `presenceJoin(activeSessionId)` effect (`:163`).

NavigationContext does **not** own the active session — it owns `activeSection` (`"sessions"|"hub"|…`), `panelOpen`, and `workspaceView`. Active session and active section are orthogonal axes.

### 6.2 Is SessionList already collapsible?

**No, not directly.** `SessionPanel` is a fixed 280-px column with no internal collapsed/condensed state. It becomes "collapsible" only in two indirect ways:

1. **Desktop**: NavigationContext's `panelOpen` (`NavigationContext.tsx:50`) gates the entire `SidePanel` render in `DashboardLayout.tsx:57` (`{panelOpen && <SidePanel ... />}`). Toggled by clicking the active section icon again in IconRail (`IconRail.tsx:31-38`). Persisted to `localStorage "pos_panel"` (`NavigationContext.tsx:60`).
2. **Mobile**: hidden by default (the desktop column has `hidden md:flex`, `DashboardLayout.tsx:55`); shown only when `mobileSidebarOpen` triggers the slide-in drawer (`DashboardLayout.tsx:72-114`).

There is no condensed/icon-only mode for the list rows themselves.

### 6.3 Does Navbar have a hamburger trigger today?

**Yes.** `Navbar.tsx:67-74`:

```tsx
{onMenuClick && (
  <button onClick={onMenuClick} className="md:hidden p-2 -ml-1 text-muted-fg hover:text-foreground transition-colors">
    <Menu className="w-5 h-5" />
  </button>
)}
```

Visible only on mobile (`md:hidden`). Wired to `setMobileSidebarOpen(true)` from `dashboard/page.tsx:369`. There is no edge-swipe alternative; the button is the only entry point.

### 6.4 What is the current behavior of ChatPanel on mobile?

Defined in `dashboard/page.tsx:509-521` plus `chat/ChatPanel.tsx:332-462`.

- **Trigger**: tap chat icon in Navbar (`Navbar.tsx:162-173`) → toggles `chatOpen` in `dashboard/page.tsx:84, :373`.
- **Render**: `<AnimatePresence>` wraps a backdrop `motion.div` (`fixed inset-0 bg-black/60 z-40 md:hidden`, page.tsx:512) and a panel `motion.div` (`fixed md:absolute top-0 right-0 bottom-0 w-full sm:w-80 md:w-96 z-50 md:z-20 bg-surface border-l border-border`, page.tsx:513).
- **Animation**: slide from `x: "100%"` to `x: 0` with a `spring damping=30 stiffness=300` (page.tsx:513).
- **Sizing on mobile (<640 px)**: `w-full` — the panel covers the **entire viewport width** including the area normally used by the bottom-tab-bar.
- **Sizing on `sm` (640–767 px)**: 320 px wide on the right; backdrop still present.
- **Sizing on `md+` (≥768 px)**: 384 px wide; backdrop removed (`md:hidden`); panel becomes `md:absolute` so it overlays the content area only, not the entire viewport.
- **Close**: backdrop tap (page.tsx:512), explicit X button rendered `md:hidden` (page.tsx:514-516), or another tap of the chat icon.
- **No swipe-to-dismiss gesture.** No focus trap. No `role="dialog"`. The `ChatInput` textarea sits at the very bottom of the panel (`ChatInput.tsx:194-204`) with no `visualViewport` listener, so when the on-screen keyboard opens on iOS Safari the textarea is hidden behind the keyboard.
- **No mobile-specific layout inside ChatPanel itself** — same header (`h-10`, `:337`), same tabs row, same message list, same input. The only difference vs desktop is the wrapper width.

### 6.5 (Bonus) Where does HotkeysModal open state live?

Local to `IconRail` — `pos/IconRail.tsx:27`. Triggered by Keyboard icon at `:82`. Not lifted, not in NavigationContext, not in `dashboard/page.tsx`. Anyone who wants to open it from elsewhere (e.g. a future "?" hotkey) currently cannot without refactoring.

### 6.6 (Bonus) Where does the Cmd/Ctrl+K command-palette open state live?

Local to `SessionPanel` — `SessionPanel.tsx:78` — and the global `keydown` listener at `SessionPanel.tsx:228-235`. The listener is mounted only while SessionPanel is rendered (i.e. while `activeSection === "sessions"`). On other sections (hub/config/symphony/etc.) **Cmd/Ctrl+K does nothing** — undocumented behavior worth noting.

---

## 7. Open observations (no actions taken)

These are findings the SCAN surfaced but were not part of the explicit deliverable. Recorded here for the arbiter / integration planner.

1. **Brief mismatch.** The roster file `01-planner-mobile.md` references `SessionList.tsx` (lines 35, 134-138). That file does not exist. The planner should be updated to `SessionPanel.tsx` (and probably `IconRail`/`MobileBottomBar`/`DashboardLayout`/`SidePanel` should be added to the impl-mobile-navigation partition).
2. **Two parallel mobile nav surfaces already coexist**: the Navbar hamburger → left-slide drawer (full IconRail+SidePanel), and MobileBottomBar's persistent bottom tabs. They are not coordinated and offer **partly overlapping affordances** (both can switch sections). The arbiter must decide whether to keep both, merge them, or drop one.
3. **No design tokens for z-index**, but comments `/* Z.MODAL */` next to literals suggest a planned token layer that should land before the overhaul to avoid additional drift.
4. **Mutual-exclusion is missing** between AdminPanel, ChatPanel, MobileBottomBar overflow popup, mobile sidebar drawer, and CommandPalette. Most of these can in principle be open at once, producing layered overlays that are unreachable through clear close paths on mobile.
5. **`max-h-[80vh]`** in HotkeysModal (`:236`) is the clearest static-vh trap inside the audited set.
6. **No focus trap, no `role="dialog"`, no `aria-modal`** on any overlay (HotkeysModal, AdminPanel wrapper, ChatPanel wrapper, mobile sidebar drawer). Esc is hand-wired only in HotkeysModal. Mobile sidebar drawer can only be closed via tap (no Esc handler in `DashboardLayout.tsx`).
7. **Chat keystroke clash with Cmd/Ctrl+K**: the global palette listener (`SessionPanel.tsx:228`) does not check `e.target` — typing the chord while focused in `ChatInput`'s textarea opens the palette and prevents the keystroke from reaching the input.
8. **Auto-close coverage on `mobileSidebarOpen`**: closed on session select, new session, open files, resume — but **not** on tapping a non-session section (hub/symphony/etc.) inside the drawer. Consequence: if user opens hamburger and taps "Hub", the section changes but the drawer stays open (the user must tap the X or backdrop manually).

---

## 8. Detailed dashboard/page.tsx callback ledger

Every callback the page wires into navigation/overlay components, with the side-effect chain. This is the surface area any mobile rework must preserve or rewire deliberately.

### 8.1 Session lifecycle callbacks (passed to DashboardLayout → SidePanel → SessionPanel)

| Callback | Defined | Side effects |
|---|---|---|
| `onSelectSession` → `handleSelectSession(sessionId)` | page.tsx:187-206 | Awaits `requestClose()` if dirty editor (`:188-191`). Saves outgoing session's viewMode to sessionStorage (`:194`). Sets `activeSessionId` (`:196`), bumps `terminalKey` (`:197`, forces Terminal remount), resets connectionStatus (`:198`), closes mobile sidebar (`:199`), restores incoming viewMode from sessionStorage (`:201-203`), forces section to "sessions" (`:204`), updates workspaceView (`:205`). |
| `onSessionDeleted` → `handleSessionDeleted(sessionId)` | page.tsx:208-215 | Only acts if deleted == active; resets to welcome view, viewMode → terminal. |
| `onNewSession` → `handleNewSession(providerSlug = "claude")` | page.tsx:217-237 | POSTs `/api/sessions`, sets `activeSessionId`, bumps `terminalKey`, closes mobile sidebar, switches to terminal view. Manages `creatingSession` boolean. |
| `onOpenFiles` → `handleOpenFiles(sessionId)` | page.tsx:243-248 | Sets active session, viewMode="files", closes mobile sidebar, sets `workspaceView`. |
| `onResumeSession` → `handleResumeSession(sessionId?)` | page.tsx:267-283 | PUTs `/api/sessions/{id}`, optimistically marks active in local sessions array, then same flow as select. Manages `resumingSessionId`. |
| `onLogout` (passed to DashboardLayout, then IconRail) | page.tsx:180-183 | POST `/api/auth/logout` then `router.push("/")`. |

### 8.2 Navbar wiring

```
page.tsx:362-379:
  Navbar
    activeSessionId       = page.activeSessionId
    activeSessionName     = derived from page.sessions.find(...)
    providerSlug          = page.activeProviderSlug (synced via useEffect :167-169)
    connectionStatus      = page.connectionStatus
    sessionCount          = derived { total, active } at page.tsx:119-122
    onMenuClick           = () => setMobileSidebarOpen(true)        page.tsx:369
    viewMode              = isSessionView ? page.viewMode : undefined
    onSwitchView          = isSessionView ? handleSwitchView : undefined
    chatOpen              = page.chatOpen
    onToggleChat          = () => setChatOpen(!chatOpen)            page.tsx:373
    isAdmin               = page.isAdmin (from useUser())
    pendingCount          = page.pendingCount
    adminOpen             = page.adminOpen
    onToggleAdmin         = () => setAdminOpen(!adminOpen)          page.tsx:377
```

`onToggleSidebar` is **never passed** by the page — the desktop ChevronLeft/Right button (`Navbar.tsx:53-64`) is therefore inert in the live app. The desktop sidebar collapse is instead exposed via clicking the active section icon in IconRail (`IconRail.tsx:31-38`). This is a UX fork to flag for the arbiter: two ways exist in code (one dead, one live).

### 8.3 Section-sync effect

`page.tsx:318-344` reacts to `activeSection` changes and rewrites `workspaceView`:

| activeSection | Resulting workspaceView |
|---|---|
| `sessions` | If no active session: `{ type: "welcome" }`. Else: keep current view. |
| `hub` | `{ type: "explorer", root: "hub" }` |
| `config` | `{ type: "explorer", root: "config" }` |
| `skills` | If current type ≠ "skill": `{ type: "welcome" }` (placeholder) |
| `memory` | If current type ≠ "memory": `{ type: "welcome" }` |
| `symphony` | `{ type: "symphony" }` |
| `system` | `{ type: "system" }` |

This effect is the bridge between NavigationContext (which only knows section IDs) and the polymorphic `workspaceView` discriminated union.

### 8.4 Per-overlay close-path matrix

Audited 360-px viewport behavior. "Yes" means there is at least one user-reachable affordance to close it. "Esc" is checked against documented or grep-confirmed listeners.

| Overlay | Backdrop tap | Close button | Esc | Toggle button | Notes |
|---|---|---|---|---|---|
| HotkeysModal | Yes (`HotkeysModal.tsx:228`) | Yes (`ModalTitleBar` X, `:243`) | Yes (`:207-218`) | n/a | Self-contained; no focus trap. |
| AdminPanel overlay | Yes mobile (`page.tsx:497`) | Yes mobile X (`:500`) | No | Yes (Navbar admin button) | Desktop has neither backdrop nor X — only the toggle button. |
| ChatPanel overlay | Yes mobile (`page.tsx:512`) | Yes mobile X (`:515`) | No | Yes (Navbar chat button) | Same desktop gap as Admin. |
| Mobile sidebar drawer | Yes (`DashboardLayout.tsx:81`) | Yes (`:94`) | No | Hamburger reopens, but no toggle-to-close on Navbar | Auto-closed on session select/create/files/resume only. |
| MobileBottomBar overflow | Yes (`MobileBottomBar.tsx:37`) | Implicit (re-tap "Ещё") | No | "Ещё" button | Smallest popup, lowest blast radius. |
| CommandPalette | Yes (`SessionPanel.tsx:514`) | No X | Yes (`:244-246, :509-511`) | Cmd/Ctrl+K | Highest z-index (`9998`). |
| ImageLightbox | Yes (full-area click is the close trigger) | n/a | n/a | n/a | (Out of scope file but relevant for stacking.) |
| FileManager drag overlay | n/a (auto-dismisses on drop/leave) | n/a | n/a | n/a | Not user-dismissed. |
| Sub-modals (NewFile/Delete/Unsaved/Provider*) | Yes (`Z.MODAL` pattern) | Yes (`ModalTitleBar`) | Component-specific | n/a | All `z-[60]`. |

### 8.5 Auto-close trigger inventory for `mobileSidebarOpen`

Spread across 4 places; missing on at least 2 important paths:

| Trigger | Location | Auto-closes drawer? |
|---|---|---|
| User selects existing session | page.tsx:199 | Yes |
| User creates new session | page.tsx:230 | Yes |
| User opens session's files | page.tsx:246 | Yes |
| User resumes a stopped session | page.tsx:277 | Yes |
| User changes section (hub/symphony/etc.) inside drawer | IconRail.tsx:31-38 sets activeSection | **No** — drawer remains open. |
| User changes section via MobileBottomBar | MobileBottomBar.tsx:26-30 | **No** (but bar is invisible while drawer is open, so this path is unreachable). |
| User taps backdrop | DashboardLayout.tsx:81 → `onCloseMobileSidebar` → page.tsx:359 | Yes |
| User taps drawer X | DashboardLayout.tsx:94 | Yes |
| Esc key | nowhere | **No** |

---

## 9. Render-tree map at 360 px (mobile, sessions section, no overlays open)

```
<html>
└── <body>
    └── <Suspense>
        └── ThemeProvider → UserProvider → PresenceProvider →
            ProviderProvider → EditorProvider → NavigationProvider
            └── DashboardInner
                └── DashboardLayout
                    ├── (hidden md:flex) IconRail + SidePanel  ← display:none on mobile
                    ├── AnimatePresence (mobileSidebarOpen=false → empty)
                    ├── <div flex-1 flex flex-col min-w-0>
                    │   ├── Navbar (h-14)
                    │   │   ├── Hamburger (md:hidden) ← only mobile control here
                    │   │   ├── activeSession label / provider icon
                    │   │   ├── view-mode tabs (icons only at <sm)
                    │   │   ├── session counter (hidden sm:inline)
                    │   │   ├── connection wifi
                    │   │   ├── SystemHealth (admin only)
                    │   │   ├── Admin toggle (admin only)
                    │   │   └── Chat toggle
                    │   └── <div flex-1 relative>
                    │       ├── one of: Terminal | FileManager | StoppedSessionOverlay |
                    │       │           FileExplorer | SkillDetailView | MemoryDetailView |
                    │       │           SymphonyDashboard | SystemDashboard | WelcomeScreen
                    │       │           (each wrapped with absolute inset-0 m-1)
                    │       ├── AnimatePresence(adminOpen) → AdminPanel + backdrop
                    │       └── AnimatePresence(chatOpen)  → ChatPanel  + backdrop
                    └── MobileBottomBar (md:hidden h-14)
```

### 9.1 Render-tree map at 360 px (mobile, hamburger drawer open)

```
DashboardLayout
├── (hidden md:flex desktop column hidden)
├── AnimatePresence(mobileSidebarOpen=true)
│   ├── motion.div backdrop (z-30)
│   └── motion.div drawer (z-40)
│       ├── IconRail (w-12)
│       └── <div w-[280px]>
│           ├── X close button (z-50)
│           └── SidePanel (dispatches by activeSection)
│               └── SessionPanel
│                   ├── h-14 ComboButton (new session)
│                   ├── scroll list with active + stopped sessions
│                   └── (mounted but not visible) wizard/configprovider/deleteTarget/CommandPalette
├── <div flex-1> (Navbar + content + admin overlay + chat overlay)
└── MobileBottomBar (md:hidden, but visually overlapped by drawer at left edge)
```

### 9.2 Render-tree map at 360 px (mobile, ChatPanel open)

```
DashboardLayout
├── (desktop column hidden)
├── (mobile drawer hidden)
├── <div flex-1 flex flex-col min-w-0>
│   ├── Navbar (Z=auto, in flex flow)
│   ├── <div flex-1 relative>
│   │   ├── content pane (Terminal etc.)
│   │   ├── motion.div backdrop  z-40 (covers content)
│   │   └── motion.div panel     z-50, w-full, fixed top-0 right-0 bottom-0
│   │       ├── X close button (z-10)
│   │       └── ChatPanel
│   │           ├── header h-10
│   │           ├── tabs (project/watercooler)
│   │           ├── messages (scroll)
│   │           └── ChatInput (textarea at bottom edge — under iOS keyboard)
└── MobileBottomBar visually overlapped by panel because panel is full-width fixed
```

---

## 10. Per-component anatomy details (deep dive)

These notes capture mechanics that the table couldn't carry — needed by Phase-7 implementers.

### 10.1 Navbar — visual hierarchy and tap-target sizing

- Two flex rows separated by `justify-between`. Left group: `gap-2` (Navbar.tsx:50). Right group: `gap-3` (`:118`).
- Tap target sizes (mobile): hamburger `p-2` (`:70` → 16-px hit area + 20-px icon = 36-px), admin/chat `p-2` (`:144, :164` → 36-px box). All below the planner's 44-px target.
- View-mode pill: `bg-surface-alt rounded-lg p-0.5 border border-border` shell with two `rounded-md px-2.5 py-1 text-xs` buttons (`:87-114`). Total height ≈ 24 px — too small for touch on a 360-px viewport.
- Pending badge math: `min-w-[16px] h-4 ... text-[10px]` (`:153`), absolutely positioned `-top-1 -right-1` over the admin button.

### 10.2 SessionPanel — fetch cadence and event sources

- Polling: 1500 ms when any session is busy, 5000 ms otherwise — `:124`.
- Audio: `/sounds/done.mp3`, `volume = 0.35`, played when previously-busy session transitions to not-busy and `seenOnceRef.current` is true (`:108-117`).
- Favicon repaint: every render where `sessions` or `seenMap` changes triggers an `<img>` load and canvas paint of a 64×64 favicon with a colored badge (`:128-188`). The repaint diffs against `lastBadgeRef` to avoid redundant DOM mutations.
- Unread tracking: per-session `seenMap[sessionId] = Date.now()`; mark cadence is 2000 ms while active session is visible (`:194-215`). Persisted to `localStorage "sessionSeenMap"` (`:199-201`).
- Global hotkeys (mounted with SessionPanel only):
  - `Cmd/Ctrl+K` — toggle CommandPalette (`:228-235`)
  - `Cmd/Ctrl+1..9` — switch to nth active session (`:236-243`)
  - `Esc` — close palette (`:244-246`)
- CommandPalette is rendered inside `<SessionPanel>` (`:459-468`). Its `<div className="fixed inset-0 z-[9998]">` (`:514`) escapes the DOM container via z-index but is **still mounted only when SessionPanel is mounted**.

### 10.3 AdminPanel — refresh model

- Initial fetch on mount (`:43-45`).
- Refetch on `window` event `"admin:pending-user"` (`:47-51`) — emitted by PresenceProvider when a new pending user signs up, see also `dashboard/page.tsx:114-117` which uses the same PresenceProvider hook.
- All actions (`approve/reject/set_role/delete`) use optimistic spinner via `actionLoading: number|null` (`:24, :53-91`).
- Renders three sections with sub-headers (`Ожидают подтверждения / Активные / Отклонённые`, `:114-176`).
- Inline delete confirm via `deleteConfirm: number|null` (`:25, :294-322`) — the Да/Нет buttons sit inside the row; no modal.

### 10.4 HotkeysModal — content layout

- Six groups defined statically in `HOTKEY_GROUPS` (`:22-155`): Терминал (6 hotkeys), Навигация (4), Интерфейс (1), Редактор (7), Чат (3).
- `useOS()` returns `"mac" | "windows" | "linux"` (`:205`); each Hotkey has parallel `mac` and `win` arrays (`:11-15`).
- Layout: header (ModalTitleBar) + `flex-1 overflow-y-auto py-2` body + `border-t px-4 py-2.5 text-center shrink-0` footer announcing the detected OS (`:265-269`).
- KeyCap component renders `<kbd>` with min-w-28-px h-26-px boxes (`:159-165`).

### 10.5 ChatPanel — channel architecture

- Two channels: `'project'` (default, primary chat with users + agents) and `'watercooler'` (read-only agent banter).
- Project messages: `/api/chat/messages` (REST), realtime via `usePresence().globalChatMessages` (WebSocket).
- Watercooler messages: `/api/symphony/v2/chat?channel=watercooler` (REST), realtime via `window` event `"symphony:watercooler-message"` (`:309-327`).
- Agent role mapping: `/api/symphony/v2/roles` populates `agentRoles` and `roleMap` (color/icon per slug, `:117-130`).
- Infinite scroll up: `loadOlder()` triggered when `scrollTop < 100` (`:198-210`); paginates via `?before={oldestId}&limit=50` (`:174`); preserves scroll position (`:182-187`).
- Send: `handleSend(text, files)` (`:234-283`). Falls back to FormData if files present, else JSON. Supports reply via `replyTarget.id`.
- Gallery: outer `ChatPanel` swap-renders `<MediaGallery onBack={...}/>` when `showGallery=true` (`:61-68`).
- Input is hidden on Watercooler tab (`:455` — `activeChannel === 'project' && <ChatInput .../>`).

### 10.6 FileManager — visibility and editor lifecycle

- `visible` prop (default true) controls polling: when invisible, the 3-second interval is skipped (`:198`); when transitioning false→true, an immediate silent refetch fires (`:191-193`).
- `editorMode = showEditor` from `useEditorTabs(sessionId)` (`:117-124`); when true, the entire FileManager replaces itself with `<EditorWorkspace .../>` plus a `<UnsavedChangesModal>` for external close handshake (`:660-687`).
- External close handshake: page.tsx invokes `requestClose()` (from EditorContext) which forwards to FileManager's registered handler (`:629-638`). FileManager resolves the promise via three buttons in the `UnsavedChangesModal`: Save (treated as discard since save can only happen inside EditorWorkspace, `:640-645`), Discard (`:647-651`), Cancel (`:653-657`).
- Drag-and-drop overlay: full-screen `fixed inset-0 z-40` with backdrop blur (`:776-797`). Drag counter ref to handle nested dragenter/dragleave correctly (`:112, :596, :604`).
- Mobile column template: drops `100px` (size) and `140px` (mtime) columns (`:80, :103`).

### 10.7 IconRail — sticky vs full-width sections

- `FULL_WIDTH_SECTIONS = ["symphony", "system"]` (`:29`) — clicking these forces `panelOpen=false` (`:36`) so the side panel collapses and the workspace gets the full width.
- All other sections force `panelOpen=true` on first click (`:36`).
- Re-clicking the active section toggles `panelOpen` (`:33`) — this is the live desktop "collapse SessionList" mechanism.
- 7 sections rendered in a single map (`:45-69`); each gets a left-side accent bar when active (`:60-62`).
- Footer: theme toggle, hotkeys (opens `HotkeysModal`), logout (`:73-95`).
- Holds `HotkeysModal` open state (`:27, :97`) — only consumer in the app.

### 10.8 MobileBottomBar — section split

- Primary tabs (`MAIN_TABS`, `:7-12`): sessions, hub, symphony, system.
- Overflow tabs (`MORE_TABS`, `:14-18`): config, skills, memory.
- Tab handler: `setActiveSection` + `setPanelOpen(!FULL_WIDTH_SECTIONS.includes(section))` + close overflow popup (`:26-30`).
- Active state for "Ещё" button: highlighted if `activeSection ∈ MORE_TABS` (`:71-72`).
- Popup positioning: `fixed bottom-14 right-2 z-50` (`:38`) — anchored above the bar.
- No safe-area inset for home indicator. The bar height `h-14` (56 px) covers part of the iOS gesture area on iPhones with home bar.

### 10.9 SidePanel — section dispatcher

- Pure switch — no state. Width fixed `w-[280px] flex-shrink-0` (`:37`).
- Imports 7 panel components (`SessionPanel, HubPanel, ConfigPanel, SkillsPanel, MemoryPanel, SymphonyPanel, SystemPanel`).
- Only `SessionPanel` receives the session-lifecycle props; others are self-contained.

### 10.10 NavigationContext — surface

- 3 fields, 4 setters: `activeSection`, `panelOpen`, `workspaceView` + `togglePanel`.
- 2 localStorage keys: `"pos_section"`, `"pos_panel"`. `workspaceView` is intentionally **not persisted** (re-derived on each load via the `activeSection` sync effect at `page.tsx:318-344`).
- Initial values via lazy initializers (`:29-46`) so SSR returns `"sessions"` and `panelOpen=true` deterministically.

---

## 11. Cross-component prop/event matrix (sanity check)

| Prop name | Producer | Consumer | Path |
|---|---|---|---|
| `activeSessionId` | page state | Navbar, FileManager, Terminal, SessionPanel (via SidePanel) | useState page.tsx:74 |
| `activeSession` | derived | (page) | page.tsx:124 |
| `activeSessionName` | derived | Navbar | page.tsx:125, :365 |
| `activeProviderSlug` | page state, set from activeSession | Navbar | page.tsx:75, :167-169, :366 |
| `connectionStatus` | page state, set by Terminal | Navbar | page.tsx:79, :239, :367 |
| `sessionCount` | derived | Navbar | page.tsx:119-122, :368 |
| `mobileSidebarOpen` | page state | DashboardLayout | page.tsx:77, :358 |
| `chatOpen` | page state | Navbar, AnimatePresence | page.tsx:84, :372, :510 |
| `adminOpen` | page state | Navbar, AnimatePresence | page.tsx:85, :376, :495 |
| `pendingCount` | page state | Navbar; receives updates from AdminPanel & PresenceProvider | page.tsx:86, :100-117, :375 |
| `viewMode` | page state | Navbar (read), FileManager (visible decoder) | page.tsx:81, :370, :388 |
| `fullscreen` | page state | DashboardLayout (short-circuit) | page.tsx:78, :48-50 (DashboardLayout) |
| `lightboxSrc` | page state | ImageLightbox | page.tsx:87, :517, :525 |
| `terminalKey` | page state | Terminal `key=` (forces remount) | page.tsx:76, :416 |
| `resumingSessionId` | page state | DashboardLayout → SidePanel → SessionPanel | page.tsx:82, :355 |
| `creatingSession` | page state | DashboardLayout → SessionPanel (ComboButton) | page.tsx:83, :356 |
| `panelOpen` | NavigationContext | DashboardLayout (gates SidePanel), IconRail (toggles), MobileBottomBar | NavigationContext.tsx:50 |
| `activeSection` | NavigationContext | IconRail, MobileBottomBar, SidePanel, page (sync effect) | NavigationContext.tsx:5 |
| `workspaceView` | NavigationContext | page (drives main content branch) | NavigationContext.tsx:7-15 |
| `hasUnsavedChanges` | EditorContext | page (beforeunload, view/session switch) | page.tsx:71, :155 |
| `requestClose()` | EditorContext | page (await before destructive nav) | page.tsx:188, :252 |

This matrix is the canonical "wiring" the planner-integration agent must respect when partitioning files.

---

## 12. Quick-reference checklist for downstream agents

- Treat `dashboard/page.tsx` as the canonical state container. Any new mobile state (sheet open, modifier-bar visible, etc.) should plug in here unless promoted to context.
- `NavigationContext` is the only safe channel for new section-level navigation state.
- Right-edge slide-overs share `w-full sm:w-80 md:w-96` + `z-50 md:z-20`; if a third joins (e.g. settings), unify the geometry into a single token to avoid drift.
- `useIsMobile(768)` already exists; reuse it instead of adding `useMediaQuery`.
- `ModalTitleBar` provides OS-aware traffic-light or window-control titlebars; reuse for any new modal to keep the look consistent.
- Z-index layers in use: 10 → 20 → 30 → 40 → 50 → 60 → 100 → 9998. Any new overlay must pick a slot deliberately, not by copy-paste.
- The hamburger trigger lives in Navbar (`onMenuClick`), wired to `mobileSidebarOpen` in `dashboard/page.tsx`. The slide-in container is in `DashboardLayout.tsx`. Re-skinning the drawer means touching DashboardLayout, not Navbar.
- IconRail owns `HotkeysModal`'s open state; promote it to NavigationContext if a global `?` hotkey or settings entry needs it.
- CommandPalette is the only existing component with `z-[9998]`; it stays on top by design. Any new overlay must stay below this layer.
- The polling cadence in `SessionPanel` (1500/5000 ms) and `FileManager` (3000 ms when visible & not editor) plus the `setInterval(fetchSessions, 5000)` in `dashboard/page.tsx:140` are the three timer sources downstream agents will encounter while measuring layout thrash.
- The dead `onToggleSidebar` path in Navbar (`Navbar.tsx:53-64`) should be either revived (consistent with IconRail's collapse behavior) or removed during the overhaul.

---

End of `02-scan-navigation.md`.
