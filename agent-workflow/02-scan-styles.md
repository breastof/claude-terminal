# 02 — Styling & Meta Scan (claude-terminal)

> Agent: `scanner-styling-and-meta`
> Scope: viewport meta, root layout `<head>`, Tailwind config, global CSS, mobile primitives.
> Mode: SCAN ONLY — no proposed solutions, no edits.
> Files cited with absolute path and line number.

---

## TL;DR (4 sentences)

1. The root layout (`/root/projects/claude-terminal/src/app/layout.tsx`) **does NOT export a `viewport` Metadata object and does NOT render a `<meta name="viewport">` tag** — Next.js 16 falls back to its default `width=device-width, initial-scale=1`.
2. `dvh`/`svh`/`lvh` are **never used anywhere in `src/`**; the codebase relies on `h-screen` (`100vh`), `min-h-screen`, and arbitrary `h-[100vh]`/`max-h-[85vh]`/`max-h-[90vh]`/`100vw` units which are known to misbehave with iOS dynamic toolbars.
3. **Zero usage of `env(safe-area-inset-*)`, `viewport-fit=cover`, `interactive-widget`, `touch-action`, `overscroll-behavior`, `-webkit-tap-highlight-color`, `inputmode`, `enterkeyhint`, or `themeColor`** anywhere in the source tree.
4. Tailwind v4 (`^4`) is configured CSS-first via `@theme inline` in `globals.css`; **`screens` are NOT customized** — defaults `sm/md/lg/xl/2xl` (640/768/1024/1280/1536px) are in effect, and the codebase routes all responsiveness through `md:` (768px) as the desktop/mobile pivot, with secondary `sm:` (640px) usage for inline label hiding.

---

## 1. Viewport meta string

**File**: `/root/projects/claude-terminal/src/app/layout.tsx`

```tsx
// Lines 21–24
export const metadata: Metadata = {
  title: "Claude Terminal",
  description: "Web interface for Claude CLI",
};
```

- **No `export const viewport: Viewport`** in `layout.tsx`.
- **No raw `<meta name="viewport">`** in the `<head>` (only a theme bootstrap script at line 37–38).
- **No `themeColor` / `colorScheme` / `viewportFit`** declared.

### Implicit default

Next.js 16, when a route exports `metadata` but no `viewport`, emits the framework default:

```html
<meta name="viewport" content="width=device-width, initial-scale=1">
```

This is the **only** viewport meta the dashboard ships with.

### Other viewport meta found in the project

The auth approval HTML page renders its own static `<meta name="viewport">` (still no `viewport-fit`):

`/root/projects/claude-terminal/src/app/api/auth/approve/route.ts:16`
```html
<meta name="viewport" content="width=device-width, initial-scale=1.0">
```

### Decision flags closed

| Question | Answer | Evidence |
|---|---|---|
| `viewport-fit=cover` present? | **NO** | layout.tsx has no viewport export |
| `interactive-widget=resizes-content` present? | **NO** | layout.tsx has no viewport export |
| `user-scalable` overridden? | **NO** | grep returned zero matches in `src/` |
| `maximum-scale` / `minimum-scale`? | **NO** | grep returned zero matches in `src/` |
| `themeColor` set? | **NO** | grep returned zero matches in `src/` |

---

## 2. Tailwind config snapshot

### Version

`/root/projects/claude-terminal/package.json`
- Line 81: `"tailwindcss": "^4"` (devDependency)
- Line 66: `"@tailwindcss/postcss": "^4"` (devDependency)

### Config style

**Tailwind v4, CSS-first.** No `tailwind.config.{js,ts,mjs,cjs}` exists anywhere in the repo (verified with `find -maxdepth 3`). All theme configuration lives in CSS via `@theme inline { … }`.

### PostCSS pipeline

`/root/projects/claude-terminal/postcss.config.mjs` (entire file):
```js
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};
export default config;
```

No additional PostCSS plugins (no autoprefixer, nesting, etc. — handled internally by Tailwind v4).

### CSS theme block

`/root/projects/claude-terminal/src/app/globals.css:1`
```css
@import "tailwindcss";

@theme inline {
  /* Semantic color tokens — resolved via CSS vars per theme */
  --color-background: var(--th-bg);
  --color-foreground: var(--th-fg);
  --color-surface: var(--th-surface);
  --color-surface-alt: var(--th-surface-alt);
  --color-surface-hover: var(--th-surface-hover);
  --color-surface-active: var(--th-surface-active);
  --color-border: var(--th-border);
  --color-border-strong: var(--th-border-strong);
  --color-muted: var(--th-muted);
  --color-muted-fg: var(--th-muted-fg);
  --color-accent: var(--th-accent);
  --color-accent-fg: var(--th-accent-fg);
  --color-accent-muted: var(--th-accent-muted);
  --color-accent-hover: var(--th-accent-hover);
  --color-danger: var(--th-danger);
  --color-success: var(--th-success);
  --color-warning: var(--th-warning);

  --font-sans: var(--th-font-sans);
  --font-mono: var(--th-font-mono);

  --animate-aurora: aurora 60s linear infinite;
  --animate-spotlight: spotlight 2s ease 0.75s 1 forwards;

  /* @keyframes for spotlight + aurora — lines 29–47 */
}
```

Items declared inside `@theme inline`:
- 17 semantic colors (lines 5–21)
- 2 font tokens (sans/mono — lines 23–24)
- 2 animation tokens (lines 26–27)
- 2 keyframes (spotlight, aurora — lines 29–47)

### Custom screens

**NOT defined.** No `--breakpoint-*` or `screens` overrides anywhere in `globals.css` or in any tailwind config file. Tailwind v4 default breakpoints are in effect:

| prefix | min-width |
|---|---|
| `sm:` | 640px |
| `md:` | 768px |
| `lg:` | 1024px |
| `xl:` | 1280px |
| `2xl:` | 1536px |

### Plugins

**Zero Tailwind plugins.** No `@plugin "..."` directive in `globals.css`, no `tailwindcss-*` plugin packages in `package.json`. (The only Tailwind packages are core + the PostCSS adapter.)

### Dark mode strategy

Configured implicitly via class on `<html>` and a `data-theme` attribute toggled by inline FOUC script.

`/root/projects/claude-terminal/src/app/layout.tsx:35`
```tsx
<html lang="ru" className="dark" suppressHydrationWarning>
```

`/root/projects/claude-terminal/src/app/layout.tsx:27`
```js
const themeScript = `(function(){try{if(localStorage.getItem("theme")==="retro")document.documentElement.setAttribute("data-theme","retro")}catch(e){}})()`;
```

- The `dark` class is applied unconditionally to `<html>` — there is **no class-toggle scheme** for light/dark; instead the alternative theme is keyed via `[data-theme="retro"]` selector blocks (`globals.css:105`).
- Tailwind v4 default `dark:` variant resolves against `prefers-color-scheme` — but because `dark` is hard-coded as a class on `<html>` and the `dark` variant is not redefined, Tailwind's `dark:` prefix used in code (e.g. `placeholders-and-vanish-input.tsx`, `aurora-background.tsx`) follows v4 default behavior (matches OS preference). No custom `@variant dark` directive was found.

### Custom variants / utilities / sources

Grep `src/` for `@variant|@apply|@custom-variant|@plugin|@source|@utility` — only one hit: `@theme` itself at `globals.css:3`. **No custom variants, no `@apply`, no `@source`, no `@utility` extensions.**

---

## 3. Safe-area inventory

```
grep -rn "safe-area\|env(safe-area" /root/projects/claude-terminal/src/
```

**Zero results.** No file in `src/` references `safe-area`, `env(safe-area-inset-*)`, `padding-{top,bottom,left,right}: env(...)`, or any iOS notch/Dynamic-Island/home-indicator handling.

This means every fixed-position UI surface (see §6 below) sits flush against device edges — overlapping the iOS status bar, notch, and home-indicator zone.

---

## 4. dvh / svh / lvh usage

```
grep -rEn "\bdvh\b|\bsvh\b|\blvh\b" /root/projects/claude-terminal/src/
```

**Zero results.** No occurrence of `100dvh`, `100svh`, `100lvh`, `min-h-dvh`, `h-dvh`, `dvh`, or arbitrary `h-[100dvh]`.

### What IS used instead (viewport-height units)

`grep -rEn "\bh-screen\b|\bmin-h-screen\b|\bmax-h-screen\b|100vh|100dvh|100svh|100lvh"`:

| File | Line | Snippet |
|---|---|---|
| `/root/projects/claude-terminal/src/app/symphony/page.tsx` | 25 | `<div className="min-h-screen bg-background">` |
| `/root/projects/claude-terminal/src/components/pos/DashboardLayout.tsx` | 49 | `<div className="flex h-screen bg-background">{children}</div>` |
| `/root/projects/claude-terminal/src/components/pos/DashboardLayout.tsx` | 53 | `<div className="flex h-screen bg-background">` |
| `/root/projects/claude-terminal/src/components/ui/lamp.tsx` | 22 | `relative flex min-h-screen flex-col …` |
| `/root/projects/claude-terminal/src/components/ui/aurora-background.tsx` | 25 | `relative flex h-[100vh] flex-col …` |
| `/root/projects/claude-terminal/src/components/ui/aurora-background.tsx` | 41 | `transition-bg relative flex h-[100vh] flex-col …` |
| `/root/projects/claude-terminal/src/app/global-error.tsx` | 12 | `style={{ … height: "100vh", … }}` |
| `/root/projects/claude-terminal/src/app/api/auth/approve/route.ts` | 17 | `style="margin:0;min-height:100vh;…"` |

### Arbitrary `vh`/`vw` values

| File | Line | Snippet |
|---|---|---|
| `HotkeysModal.tsx` | 236 | `max-h-[80vh]` |
| `ProviderWizardModal.tsx` | 260 | `max-h-[85vh]` |
| `symphony/CreateTaskModal.tsx` | 67 | `w-[520px] max-h-[85vh]` |
| `symphony/PipelineAlertBanner.tsx` | 78 | `w-[480px] max-w-[calc(100vw-2rem)]` |
| `chat/ImageLightbox.tsx` | 31 | `max-w-[90vw] max-h-[90vh]` |
| `pos/SessionPanel.tsx` | 514 | `pt-[15vh]` (modal positioning) |
| `pos/SessionPanel.tsx` | 515 | `w-[min(560px,92vw)]` |

### Decision flag closed

> **Is `100dvh` used anywhere?**
> **NO.** The dashboard shell uses `h-screen` (`100vh`) which on iOS Safari and Android Chrome corresponds to `lvh` (largest viewport height) — meaning content is sized to the toolbar-collapsed viewport and gets cropped when the toolbars are visible.

---

## 5. Media-query inventory

### Raw `@media` queries

```
grep -rn "@media" /root/projects/claude-terminal/src/
```

**Zero results.** No raw `@media` rules in any source file (including `globals.css`). All responsiveness is delegated to Tailwind responsive prefixes.

### Tailwind responsive-prefix usage

Total lines containing `sm:|md:|lg:|xl:|2xl:` in `src/`: **113**.

#### `sm:` (640px) — 11 hits, mostly inline-label show/hide

| File | Line | Snippet |
|---|---|---|
| `components/Navbar.tsx` | 99 | `<span className="hidden sm:inline">Терминал</span>` |
| `components/Navbar.tsx` | 112 | `<span className="hidden sm:inline">Файлы</span>` |
| `components/Navbar.tsx` | 120 | `<span className="text-xs text-muted hidden sm:inline">` |
| `components/ui/floating-navbar.tsx` | 71–72 | `block sm:hidden` / `hidden sm:block` icon vs name |
| `components/ui/placeholders-and-vanish-input.tsx` | 187, 204, 267 | `sm:left-8`, `sm:pl-10 sm:text-base`, `sm:pl-12 sm:text-base` |
| `components/file-manager/FileToolbar.tsx` | 58, 83 | `<span className="hidden sm:inline">Создать/Загрузить</span>` |
| `components/file-manager/EditorWorkspace.tsx` | 555 | `<span className="hidden sm:inline">…Сохранить</span>` |
| `components/symphony/PipelineAlerts.tsx` | 68 | `w-full max-w-[360px] sm:w-[360px]` |
| `components/ui/typewriter-effect.tsx` | 75, 93, 159, 180 | `sm:text-xl`, `sm:h-6`, `sm:text-base`, `sm:h-6` |
| `app/dashboard/page.tsx` | 498, 513 | `w-full sm:w-80 md:w-96` (admin/chat side panels) |

#### `md:` (768px) — primary mobile/desktop pivot

This is the single breakpoint that drives nearly all responsive layout. Selected representative hits:

| File | Line | Pattern |
|---|---|---|
| `components/pos/DashboardLayout.tsx` | 55 | `<div className="hidden md:flex h-full">` (desktop sidebar) |
| `components/pos/DashboardLayout.tsx` | 80 | `fixed inset-0 bg-black/60 z-30 md:hidden` (mobile scrim) |
| `components/pos/DashboardLayout.tsx` | 88 | `fixed top-0 left-0 bottom-0 z-40 md:hidden flex` (mobile drawer) |
| `components/pos/MobileBottomBar.tsx` | 56 | `md:hidden h-14 border-t …` (mobile bottom tab-bar) |
| `components/Navbar.tsx` | 49 | `h-14 … px-3 md:px-5 …` |
| `components/Navbar.tsx` | 55 | `hidden md:flex …` (collapse-panel button desktop only) |
| `components/Navbar.tsx` | 70 | `md:hidden p-2 -ml-1 …` (hamburger mobile only) |
| `components/Navbar.tsx` | 79 | `truncate max-w-[150px] md:max-w-none` |
| `components/Navbar.tsx` | 130/132/144/151/164/171 | icon size & padding swap `w-5 h-5 md:w-4 md:h-4`, `p-2 md:p-1.5` |
| `components/Navbar.tsx` | 144, 164 | `relative p-2 md:p-1.5` (touch-target swap on icons) |
| `components/StoppedSessionOverlay.tsx` | 90, 125, 128, 131–132, 138, 144, 150, 153, 163 | size/padding scaling, `<br className="hidden md:block">` |
| `components/SystemHealth.tsx` | 225 | `w-4 h-4 md:w-3.5 md:h-3.5` |
| `components/WelcomeScreen.tsx` | 36, 47, 52 | `md:left-60 md:-top-20`, `text-xl md:text-2xl`, `text-sm md:text-base` |
| `components/pos/FileExplorer.tsx` | 224 | `… ${mobileShowEditor && activeTab ? "hidden md:flex" : "flex"} flex-col w-full md:w-[250px] md:min-w-[200px] md:max-w-[300px]` |
| `components/pos/FileExplorer.tsx` | 297 | `flex flex-col flex-1 min-w-0` (mobile editor swap) |
| `components/pos/FileExplorer.tsx` | 304 | `md:hidden p-1.5 …` (mobile back button) |
| `components/pos/SessionPanel.tsx` | 585 | `px-3 py-3 md:py-2.5 …` |
| `components/pos/SessionPanel.tsx` | 633 | `gap-1 md:gap-0.5 opacity-100 md:opacity-0 md:group-hover:opacity-100` (always-visible action icons on mobile) |
| `components/pos/SessionPanel.tsx` | 635, 639, 643, 648, 652, 655 | `p-2 md:p-1` touch-target swap on row action icons |
| `components/pos/SessionPanel.tsx` | 636, 640, 644, 649, 653, 656 | `w-4 h-4 md:w-3.5 md:h-3.5` icon swap |
| `components/file-manager/FileTableHeader.tsx` | 105, 134, 143, 164 | `px-2 md:px-4`, `hidden md:block`/`hidden md:flex` columns |
| `components/file-manager/FileItem.tsx` | 96, 152, 157, 162, 166, 169, 174, 177, 181, 184 | dense row spacing/icon size scaling, `hidden md:block` columns |
| `components/file-manager/MarkdownPreview.tsx` | 172 | `px-4 md:px-6 py-4` |
| `components/file-manager/FileToolbar.tsx` | 39, 54, 79, 92, 104, 116 | `min-w-[100px] max-w-none md:max-w-[250px]`, `px-3 py-2 md:px-2.5 md:py-1.5` |
| `components/pos/SystemDashboard.tsx` | 91, 190 | `grid grid-cols-1 md:grid-cols-2`, `md:col-span-2` |
| `components/symphony/SymphonyDashboard.tsx` | 162 | `grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3` |
| `app/dashboard/page.tsx` | 386, 394, 405, 409, 412, 428, 437, 446, 455, 466 | `m-1 md:m-2`, `p-2 md:p-1.5`, icon size swaps |
| `app/dashboard/page.tsx` | 497–514 | mobile scrim + slide-over for AdminPanel & ChatPanel: `md:hidden` scrim + `fixed md:absolute … w-full sm:w-80 md:w-96 z-50 md:z-20` |
| `app/page.tsx` | 41 | `text-5xl md:text-6xl` |
| `app/not-found.tsx` | 32, 35 | `text-8xl md:text-9xl`, `text-lg md:text-xl` |

#### `lg:` (1024px) — only 4 hits

| File | Line | Snippet |
|---|---|---|
| `components/ui/spotlight.tsx` | 15 | `lg:w-[84%]` |
| `components/ui/typewriter-effect.tsx` | 75 | `lg:text-5xl` |
| `components/ui/typewriter-effect.tsx` | 93 | `lg:h-10` |
| `components/ui/typewriter-effect.tsx` | 159 | `lg:text-3xl` |
| `components/symphony/SymphonyDashboard.tsx` | 162 | `lg:grid-cols-3` |

#### `xl:` (1280px) — only typewriter demo

| File | Line | Snippet |
|---|---|---|
| `components/ui/typewriter-effect.tsx` | 159 | `xl:text-5xl` |
| `components/ui/typewriter-effect.tsx` | 180 | `xl:h-12` |

#### `2xl:` (1536px)

**Zero hits as a Tailwind prefix.** (Substring `2xl` appears only inside class names like `rounded-2xl`, never as a `2xl:` responsive prefix.)

### Conclusion on breakpoint usage

The codebase essentially has a **two-state responsive design**: `<768px` (mobile) vs `≥768px` (desktop), driven entirely by `md:`. `sm:` (640px) is used to recover icon-vs-label transitions in tight nav buttons. `lg:` and `xl:` are used only in the marketing/landing UI primitives (`typewriter-effect`, `spotlight`) and the Symphony dashboard grid. There is **no breakpoint between 0–767px** — meaning the entire range from a 320px iPhone SE to a 767px small tablet shares one layout token.

---

## 6. Touch-related CSS

### Searched

```
grep -rn "touch-action"        → 0 results
grep -rn "overscroll-behavior" → 0 results
grep -rn "tap-highlight"       → 0 results
grep -rn "user-select"         → 0 results (CSS property)
```

### `select-*` Tailwind utilities (text selection)

| File | Line | Class |
|---|---|---|
| `components/StoppedSessionOverlay.tsx` | 89 | `select-none pointer-events-none` |
| `components/ModalTitleBar.tsx` | 12, 42 | `select-none shrink-0` |
| `components/symphony/pipeline/DwellHeatmap.tsx` | 61 | `select-none` |
| `components/file-manager/DataPreview.tsx` | 98, 132 | `select-none py-px` |
| `components/file-manager/EditorWorkspace.tsx` | 583 | `select-none` (during drag) |
| `components/file-manager/TabBar.tsx` | 62, 87 | `select-none` |
| `components/file-manager/FileTableHeader.tsx` | 105 | `select-none` |
| `components/file-manager/MarkdownPreview.tsx` | 115 | `select-none` (lang label) |

These translate to `user-select: none`. They are correct for chrome-elements but irrelevant to mobile-touch behavior (no `touch-action: manipulation` anywhere → 300ms click delay potentially lurking on older WebViews).

### Pointer-event utilities (Tailwind)

11 hits — all related to overlays passing through clicks. No `touch-action` equivalents.

| File | Line | Class |
|---|---|---|
| `components/StoppedSessionOverlay.tsx` | 89 | `pointer-events-none` |
| `components/presence/Cursor.tsx` | 82, 240 | `pointer-events-auto` |
| `components/presence/CursorOverlay.tsx` | 162 | `pointer-events-none z-10` |
| `components/presence/EdgeIndicator.tsx` | 26 | `pointer-events-auto cursor-pointer` |
| `components/ui/spotlight.tsx` | 15 | `pointer-events-none …` |
| `components/ui/placeholders-and-vanish-input.tsx` | 187, 246 | `pointer-events-none` |
| `components/ui/aurora-background.tsx` | 70 | `pointer-events-none …` |
| `components/symphony/PipelineAlerts.tsx` | 68, 75 | `pointer-events-none`, `pointer-events-auto` |

### iOS-specific input attributes

```
grep -rEn "inputmode|enterkeyhint|autocorrect|autocapitalize|autocomplete=\"off\""
```
**Zero matches** in `src/`. No `<input>`/`<textarea>` declares `inputmode="numeric"`, `enterkeyhint="send"`, `autocorrect="off"`, or `autocapitalize="off"`.

The terminal-relevant `<textarea>` (`/root/projects/claude-terminal/src/components/chat/ChatInput.tsx:194–204`) ships only with:
```tsx
className="flex-1 bg-transparent text-sm text-foreground placeholder-muted outline-none resize-none max-h-24 min-h-[20px] disabled:opacity-30 disabled:cursor-not-allowed"
```
— `text-sm` (14px) ⇒ **iOS Safari will zoom on focus** (the well-known < 16px input rule).

### Conclusion

Zero CSS-level touch optimization. No `touch-action`, no `overscroll-behavior` (rubber-band passes through to the body during terminal scroll), no tap-highlight removal (default semi-transparent box on every tap), no input-mode hints.

---

## 7. Base font sizes / readability at 360px

### Root `html` styling

`/root/projects/claude-terminal/src/app/globals.css` — **no `html { … }` rule**. Default `font-size: 16px` from user-agent stylesheet is in effect (Tailwind v4 does not inject a Preflight `html` font-size override; rem stays 16px).

### `body` styling

`/root/projects/claude-terminal/src/app/globals.css:152–156`:
```css
body {
  background: var(--color-background);
  color: var(--color-foreground);
  font-family: var(--font-sans), system-ui, sans-serif;
}
```
- No `font-size` — inherits 16px.
- No `line-height` — inherits browser default (~1.2).
- No `text-rendering`, no `-webkit-font-smoothing`, no `font-feature-settings`.
- No `min-width`, no `overflow-x: hidden`.
- No `position: fixed; inset: 0` mobile-shell trick.

The `<body>` does receive the Geist-Sans/Mono/Space-Grotesk variable classes plus `antialiased` from layout.tsx:40 (Tailwind's `antialiased` ⇒ `-webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;`).

### Markdown viewer base (`.md-viewer`)

`/root/projects/claude-terminal/src/app/globals.css:258–328`:
- h1 `font-size: 1.75rem`, h2 `1.4rem`, h3 `1.15rem`, h4–h6 `1rem`
- p `line-height: 1.7`
- li `line-height: 1.6`
- pre `font-size: 0.875rem; line-height: 1.5`
- code `font-size: 0.875em`
- table `font-size: 0.875rem`

These are fine on mobile.

### xterm padding

`/root/projects/claude-terminal/src/app/globals.css:185–187`:
```css
.xterm { padding: 8px; }
```
Static 8px gutter — at 360px viewport this leaves 344px terminal width.

### Components with potential 360px breakage

| File | Line | Issue |
|---|---|---|
| `components/symphony/SymphonyBoard.tsx` | 141 | `min-w-[800px]` — horizontal scroll on mobile (likely intended) |
| `components/symphony/ProjectBoard.tsx` | 319 | `min-w-[1600px]` — horizontal scroll on mobile (intended) |
| `components/pos/SidePanel.tsx` | 37 | `w-[280px]` — fixed-width drawer (fits 360px with 80px room) |
| `components/pos/DashboardLayout.tsx` | 91 | `w-[280px]` — mobile-drawer body next to IconRail |
| `components/symphony/CreateTaskModal.tsx` | 67 | `w-[520px] max-h-[85vh]` — overflows 360px viewport (no `max-w-[calc(100vw-2rem)]`) |
| `components/symphony/PipelineAlertBanner.tsx` | 78 | `w-[480px] max-w-[calc(100vw-2rem)]` — properly clamped |
| `components/symphony/pipeline/ActivityTimeline.tsx` | 54 | `min-w-[400px]` — overflows at 360px |
| `components/symphony/pipeline/ErrorRateTrends.tsx` | 59 | `min-w-[300px]` — fits |
| `components/chat/ChatInput.tsx` | 203 | `text-sm` (14px) on textarea — **iOS zoom-on-focus** |
| `components/symphony/PipelineAlerts.tsx` | 68 | `top-16 right-3 w-full max-w-[360px]` — clipped under any iOS notch (no safe-area) |
| `components/pos/MobileBottomBar.tsx` | 56 | `md:hidden h-14 …` — sits flush against home-indicator (no `pb-[env(safe-area-inset-bottom)]`) |

### Fixed-position elements at risk for safe-area collisions

| File | Line | Position |
|---|---|---|
| `components/pos/DashboardLayout.tsx` | 88 | `fixed top-0 left-0 bottom-0` (mobile drawer) — no `top: env(safe-area-inset-top)` |
| `components/symphony/PipelineAlerts.tsx` | 68 | `fixed top-16 right-3` |
| `components/pos/MobileBottomBar.tsx` | 38 | `fixed bottom-14 right-2` (More popover) |
| `components/presence/Cursor.tsx` | 82 | `fixed bottom-4 left-4 right-4` |
| `components/symphony/PipelineAlertBanner.tsx` | 78 | `fixed top-4 right-4` |
| `app/dashboard/page.tsx` | 497, 498, 512, 513 | scrim + slide-over panels (`fixed inset-0`, `fixed md:absolute top-0 right-0 bottom-0`) |

None of these compensate for the iOS notch/Dynamic Island (top inset) or home-indicator (bottom inset) zones.

---

## 8. Decisions closed

| Decision | Answer | Source |
|---|---|---|
| Does the viewport meta include `viewport-fit=cover`? | **NO.** No `viewport` export in `layout.tsx`; Next.js default has no `viewport-fit`. | `src/app/layout.tsx:21–24` |
| Does the viewport meta include `interactive-widget=resizes-content`? | **NO.** Not set anywhere. | `src/app/layout.tsx:21–24` |
| Is `100dvh` used anywhere? | **NO.** Project uses `h-screen`/`100vh`/`min-h-screen` exclusively. | grep: 0 results for `dvh\|svh\|lvh` |
| Is Tailwind's `screens` config customized? | **NO.** Tailwind v4 CSS-first config in `globals.css` has no `--breakpoint-*` overrides; defaults `sm/md/lg/xl/2xl` apply. | `src/app/globals.css:3–48` |
| Are `env(safe-area-inset-*)` insets used anywhere? | **NO.** Zero matches in `src/`. | grep: 0 results |
| Is `themeColor` (status-bar tint) configured? | **NO.** No `themeColor` in `metadata` or `viewport`. | `src/app/layout.tsx:21–24` |
| Is `touch-action` declared anywhere? | **NO.** Zero matches. Default browser handling (incl. 300ms tap delay on older WebViews, double-tap zoom). | grep: 0 results |
| Is `overscroll-behavior` declared anywhere? | **NO.** Rubber-band/pull-to-refresh passes through. | grep: 0 results |
| Is `-webkit-tap-highlight-color` overridden? | **NO.** Default semi-transparent gray box on every tap. | grep: 0 results |
| Is `inputmode` / `enterkeyhint` / `autocorrect` ever set on inputs? | **NO.** All `<input>`/`<textarea>` use defaults — including the chat textarea at `text-sm` (14px), which triggers iOS auto-zoom on focus. | grep: 0 results |
| Is there a custom `dark:` variant binding? | **NO.** Default v4 behavior (matches `prefers-color-scheme`) plus an unconditional `className="dark"` on `<html>`. | `src/app/layout.tsx:35` |
| Are there any raw `@media` rules? | **NO.** All responsiveness via Tailwind prefixes. | grep: 0 raw `@media` in `src/` |
| Does the dashboard shell use any mobile-aware viewport units? | **NO.** `DashboardLayout.tsx:53` uses `flex h-screen` (= `100vh`) which is `lvh` on iOS Safari → bottom of UI hidden behind dynamic toolbar. | `src/components/pos/DashboardLayout.tsx:49,53` |

---

## Files inventoried (absolute paths)

- `/root/projects/claude-terminal/src/app/layout.tsx` (47 lines)
- `/root/projects/claude-terminal/src/app/globals.css` (375 lines)
- `/root/projects/claude-terminal/src/app/dashboard/page.tsx` (read header + main content area)
- `/root/projects/claude-terminal/src/app/symphony/page.tsx` (line 25 cited)
- `/root/projects/claude-terminal/src/app/global-error.tsx` (line 12 cited)
- `/root/projects/claude-terminal/src/app/api/auth/approve/route.ts` (lines 16–17 cited)
- `/root/projects/claude-terminal/postcss.config.mjs` (8 lines)
- `/root/projects/claude-terminal/next.config.ts` (25 lines)
- `/root/projects/claude-terminal/package.json` (85 lines)
- `/root/projects/claude-terminal/src/components/pos/DashboardLayout.tsx` (126 lines)
- `/root/projects/claude-terminal/src/components/pos/MobileBottomBar.tsx` (82 lines)
- `/root/projects/claude-terminal/src/components/pos/SidePanel.tsx` (line 37 cited)
- `/root/projects/claude-terminal/src/components/pos/IconRail.tsx` (lines 63, 79, 86, 93 cited)
- `/root/projects/claude-terminal/src/components/pos/FileExplorer.tsx` (lines 224, 297, 304, 318 cited)
- `/root/projects/claude-terminal/src/components/pos/SessionPanel.tsx` (multiple lines cited)
- `/root/projects/claude-terminal/src/components/pos/SystemDashboard.tsx` (lines 91, 190 cited)
- `/root/projects/claude-terminal/src/components/Navbar.tsx` (multiple lines cited)
- `/root/projects/claude-terminal/src/components/SystemHealth.tsx` (line 225 cited)
- `/root/projects/claude-terminal/src/components/StoppedSessionOverlay.tsx` (multiple lines cited)
- `/root/projects/claude-terminal/src/components/WelcomeScreen.tsx` (lines 36, 47, 52 cited)
- `/root/projects/claude-terminal/src/components/HotkeysModal.tsx` (lines 161, 236 cited)
- `/root/projects/claude-terminal/src/components/ProviderWizardModal.tsx` (line 260 cited)
- `/root/projects/claude-terminal/src/components/ModalTitleBar.tsx` (lines 12, 42, 16, 30, 31, 47, 52, 66 cited)
- `/root/projects/claude-terminal/src/components/ComboButton.tsx` (line 130 cited)
- `/root/projects/claude-terminal/src/components/chat/ChatInput.tsx` (lines 181–217 read)
- `/root/projects/claude-terminal/src/components/chat/ImageLightbox.tsx` (line 31 cited)
- `/root/projects/claude-terminal/src/components/chat/ChatMessage.tsx` (lines 206, 222 cited)
- `/root/projects/claude-terminal/src/components/symphony/SymphonyBoard.tsx` (line 141 cited — `min-w-[800px]`)
- `/root/projects/claude-terminal/src/components/symphony/ProjectBoard.tsx` (line 319 cited — `min-w-[1600px]`)
- `/root/projects/claude-terminal/src/components/symphony/PipelineAlerts.tsx` (lines 68, 75 cited)
- `/root/projects/claude-terminal/src/components/symphony/PipelineAlertBanner.tsx` (line 78 cited)
- `/root/projects/claude-terminal/src/components/symphony/CreateTaskModal.tsx` (line 67 cited)
- `/root/projects/claude-terminal/src/components/symphony/SymphonyDashboard.tsx` (line 162 cited)
- `/root/projects/claude-terminal/src/components/symphony/pipeline/ActivityTimeline.tsx` (line 54 cited)
- `/root/projects/claude-terminal/src/components/symphony/pipeline/ErrorRateTrends.tsx` (line 59 cited)
- `/root/projects/claude-terminal/src/components/symphony/pipeline/DwellHeatmap.tsx` (line 61 cited)
- `/root/projects/claude-terminal/src/components/file-manager/FileTableHeader.tsx` (lines 105, 134, 143, 164 cited)
- `/root/projects/claude-terminal/src/components/file-manager/FileItem.tsx` (multiple lines cited)
- `/root/projects/claude-terminal/src/components/file-manager/MarkdownPreview.tsx` (lines 115, 172 cited)
- `/root/projects/claude-terminal/src/components/file-manager/FileToolbar.tsx` (multiple lines cited)
- `/root/projects/claude-terminal/src/components/file-manager/EditorWorkspace.tsx` (lines 555, 583 cited)
- `/root/projects/claude-terminal/src/components/file-manager/TabBar.tsx` (lines 62, 76, 87 cited)
- `/root/projects/claude-terminal/src/components/file-manager/TabContextMenu.tsx` (line 52 cited)
- `/root/projects/claude-terminal/src/components/file-manager/DataPreview.tsx` (lines 98, 132 cited)
- `/root/projects/claude-terminal/src/components/file-manager/MediaPreview.tsx` (lines 27, 29, 40, 44 cited)
- `/root/projects/claude-terminal/src/components/presence/Cursor.tsx` (lines 82, 93, 228, 240, 269 cited)
- `/root/projects/claude-terminal/src/components/presence/CursorOverlay.tsx` (line 162 cited)
- `/root/projects/claude-terminal/src/components/presence/EdgeIndicator.tsx` (lines 26, 41 cited)
- `/root/projects/claude-terminal/src/components/ui/aurora-background.tsx` (lines 25, 41, 70 cited)
- `/root/projects/claude-terminal/src/components/ui/lamp.tsx` (lines 22, 40, 54 cited)
- `/root/projects/claude-terminal/src/components/ui/spotlight.tsx` (line 15 cited)
- `/root/projects/claude-terminal/src/components/ui/typewriter-effect.tsx` (lines 75, 93, 159, 180 cited)
- `/root/projects/claude-terminal/src/components/ui/placeholders-and-vanish-input.tsx` (lines 187, 204, 246, 267 cited)
- `/root/projects/claude-terminal/src/components/ui/floating-navbar.tsx` (lines 71–72 cited)
- `/root/projects/claude-terminal/src/components/ui/moving-border.tsx` (lines 50, 90, 143 cited)

---

## Files searched but containing no relevant matches

- `tailwind.config.{js,ts,mjs,cjs}` — **does not exist** in repo (verified `find -maxdepth 3 -name 'tailwind.config*'` returns nothing).
- No `app/head.tsx` (Next.js 16 prefers `metadata`/`viewport` exports).
- No `manifest.json` / `manifest.webmanifest` referenced from layout.

---

## Search commands run (for reproducibility)

```
find /root/projects/claude-terminal -maxdepth 3 -name 'tailwind.config*'
find /root/projects/claude-terminal/src -name '*.css'
grep -rn "viewport"            /root/projects/claude-terminal/src/app/
grep -rn "safe-area\|env(safe-area" /root/projects/claude-terminal/src/
grep -rEn "\bdvh\b|\bsvh\b|\blvh\b" /root/projects/claude-terminal/src/
grep -rn "interactive-widget\|viewport-fit" /root/projects/claude-terminal/src/
grep -rn "touch-action"        /root/projects/claude-terminal/src/
grep -rn "@media"              /root/projects/claude-terminal/src/
grep -rn "pointer-events"      /root/projects/claude-terminal/src/
grep -rn "user-select"         /root/projects/claude-terminal/src/
grep -rn "overscroll-behavior\|tap-highlight" /root/projects/claude-terminal/src/
grep -rEn "\bh-screen\b|\bmin-h-screen\b|\bmax-h-screen\b|100vh|100dvh|100svh|100lvh" /root/projects/claude-terminal/src/
grep -rEn "user-scalable|maximum-scale|minimum-scale|initial-scale" /root/projects/claude-terminal/src/
grep -rEn "themeColor|theme-color|export const viewport|Viewport " /root/projects/claude-terminal/src/
grep -rEn "@theme|@layer|@variant|@apply|@custom-variant|@plugin|@source|@utility" /root/projects/claude-terminal/src/
grep -rEn "\b(sm|md|lg|xl|2xl):" /root/projects/claude-terminal/src/   # 113 hits
grep -rEn "min-w-\[|w-\[[0-9]+px\]" /root/projects/claude-terminal/src/
grep -rEn "vh|vw" /root/projects/claude-terminal/src/   # filtered
grep -rEn "<input|<textarea" /root/projects/claude-terminal/src/
grep -rEn "inputmode|enterkeyhint|autocorrect|autocapitalize" /root/projects/claude-terminal/src/   # 0 hits
grep -rEn "fixed bottom|fixed top" /root/projects/claude-terminal/src/
```
