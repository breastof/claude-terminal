# Research — Mobile Terminal UX Patterns

> Agent: `researcher-mobile-terminal-ux`
> Date: 2026-04-26
> Scope: Survey of mobile-first terminal apps and web-based xterm wrappers, focused on input ergonomics on tiny touch screens.
> Caveat: WebSearch was returning errors during this run, so I leaned on direct GitHub source reads (raw URLs + GitHub REST API) and authoritative project READMEs/docs. Where I cite a source, the URL was actually fetched and the snippet quoted is from the file at HEAD. A few products are closed-source (Blink Build/Warp Mobile, JuiceSSH paid features, Replit, GitHub Codespaces mobile) — for those I describe behavior from official help docs and developer commentary, and I flag where my evidence is observation rather than source.

---

## 0. Executive Snapshot

What every project agrees on:
1. **Modifier-bar above the keyboard is non-negotiable.** Every mobile terminal that anyone actually uses has some flavor of an extra-keys bar. The OS soft keyboard alone cannot produce `Esc`, `Tab`, `Ctrl+C`, arrow keys reliably.
2. **The xterm.js way (hidden offscreen `<textarea>`) is the de-facto web standard.** ttyd, ShellHub, Sshwifty, code-server, VS Code Web Server, Hyper, GitHub Codespaces — all wrap the same pattern because they all wrap xterm.js.
3. **`autocorrect="off" autocapitalize="off" spellcheck="false"`** is universal on the input element. Without it, iOS will silently capitalize the first character of every command and rewrite typed words.
4. **`Ctrl` and `Alt` are sticky toggles**, not held-down keys. Tap → highlight → next character is modified → auto-release.
5. **Long-press for popup variants** is shared by Termux and Blink (e.g., long-press `-` to get `|`).

Where projects diverge:
- Native apps (Termux, Blink) use a **second toolbar page** for symbols / numbers / function keys, switchable with a swipe or a mode button. Web apps (ttyd, Sshwifty) typically scatter category sections horizontally instead.
- Some show the bar **only on focus** (xterm.js default helper-textarea is invisible), some show it **persistently above keyboard** (Termux, Blink, Sshwifty), some **only when keyboard is open** (Codespaces PWA).
- "How do I get a bare `Esc`" is solved 4 different ways: dedicated bar button, Globe-key remap (Blink iOS w/ external keyboard), volume-down remap (Termux), or chord (`Ctrl+[`).

---

## 1. Per-Project Profiles

### 1.1 Termux (Android, FOSS, the reference design)

- **Product**: terminal emulator + Linux package manager that runs a chroot-free Android-native userland. Single most-used mobile terminal on the planet (>10M Play Store installs before its removal; F-Droid + GitHub now).
- **Repo**: https://github.com/termux/termux-app
- **Docs**: https://wiki.termux.com/wiki/Touch_Keyboard (currently behind Anubis bot wall, but archived versions exist)

#### Input proxy
Termux runs a **native `TerminalView`** (custom Android `View`) which directly receives `KeyEvent`s from the InputConnection. There is no hidden textarea — the view itself implements `onCreateInputConnection` and pretends to be a one-line text field for the IME. There is, however, a **secondary toolbar page that IS an `EditText`** (see §1.1 layout) intended for typing long commands when autocorrect would otherwise destroy them in the terminal.

Default config of that EditText (file `app/src/main/res/layout/view_terminal_toolbar_text_input.xml`):
```xml
<EditText
    android:id="@+id/terminal_toolbar_text_input"
    android:imeOptions="actionSend|flagNoFullscreen"
    android:maxLines="1"
    android:inputType="text"
    android:importantForAutofill="no"
    android:textCursorDrawable="@null" />
```
Key points: `flagNoFullscreen` prevents the IME from going landscape-fullscreen and covering the terminal; `importantForAutofill="no"` stops the system password manager prompts; `maxLines="1"` keeps it as a command line.

Source: https://github.com/termux/termux-app/blob/master/app/src/main/res/layout/view_terminal_toolbar_text_input.xml

#### Modifier bar
Termux ships **two stacked toolbar pages in a `ViewPager`** (see `TerminalToolbarViewPager.java`):

1. **Page 0** — extra keys grid (`ExtraKeysView`).
2. **Page 1** — single-line `EditText` (the "type-and-send" mode).

Swiping the toolbar horizontally switches between them.

Default extra-keys layout (`TermuxPropertyConstants.java` line 329):
```
[['ESC','/',{key:'-', popup:'|'},'HOME','UP','END','PGUP'],
 ['TAB','CTRL','ALT','LEFT','DOWN','RIGHT','PGDN']]
```
Two rows × 7 buttons = 14 keys. `Ctrl` and `Alt` are sticky toggles. The `{key:'-', popup:'|'}` syntax means **long-press → popup variant**; this is a first-class config feature.

Layout schema fully documented in `ExtraKeysInfo.java`:
- `'KEY'` short form OR `{key:'KEY', popup:'POPUP_KEY', display:'…', macro:'CTRL f BKSP'}` long form
- A row is a JSON array; the whole bar is an array of rows
- A "macro" sends a sequence of keys, e.g. `{macro: "CTRL f d", display: "tmux exit"}`
- Aliases (`ESCAPE`→`ESC`, `RETURN`→`ENTER`, `LT`→`LEFT`)
- Display style maps: `default`, `arrows-only`, `arrows-all`, `all`, `none`

Source: https://github.com/termux/termux-app/blob/master/termux-shared/src/main/java/com/termux/shared/termux/extrakeys/ExtraKeysInfo.java

Repetitive (auto-fire on hold) keys are restricted to `UP/DOWN/LEFT/RIGHT/BKSP/DEL/PGUP/PGDN` (`ExtraKeysConstants.PRIMARY_REPETITIVE_KEYS`).

#### Gestures
- **Swipe left/right on toolbar**: switch between extra-keys page and EditText page.
- **Long-press extra-key button**: invoke popup variant if defined.
- **Two-finger swipe down on terminal**: traditionally toggles soft keyboard (`SOFT_KEYBOARD_TOGGLE_BEHAVIOUR=show-hide`).
- **Volume Down + key**: virtual modifier mode (configurable). Vol-down is treated as `Ctrl`, so Vol-Down + L = `Ctrl+L`. (`VOLUME_KEYS_BEHAVIOUR=virtual`)
- **Volume Up + key**: virtual `Esc`, Tab, Fn keys via macros (Vol-Up + E = `Esc`, Vol-Up + T = `Tab`, Vol-Up + 1..9 = F1..F9, Vol-Up + B = backslash, etc.). This is documented in the wiki Touch Keyboard page.
- **Back key behavior**: configurable as `back` (close) or `escape` (sends `Esc`) via `back-key=escape`.

#### IME / autocorrect
- TerminalView's `onCreateInputConnection` returns a connection with `InputType.TYPE_NULL` for the main view, which suppresses the IME's autocorrect and word suggestions in the terminal proper. Most users still report Gboard misbehaving and **must install Hacker's Keyboard** or use FOSS keyboards like Unexpected Keyboard for serious shell work.
- The optional EditText toolbar mode bypasses this with `inputType="text"` and `imeOptions="actionSend"` so autocorrect IS active while typing the line, and the assembled line gets sent on Enter.

#### Paste
Standard Android long-press → Paste UI in the terminal view. Also available via Vol-Up + V macro and via the toolbar.

#### Notable quirks
- Termux's `extra-keys` JSON is **so popular that other Android terminals (Termux:GUI, Acode, Flutter-based clones) accept the same syntax**. It is the de-facto standard.
- The PRIMARY toolbar view (`partial_primary_toolbar.xml`) is anchored above the soft keyboard with `WindowSoftInputMode=adjustResize` and an Android `WindowInsets` listener.
- The toolbar height is configurable via `terminal-toolbar-height` (0.4× to 3× scale factor).
- Screenshot: https://wiki.termux.com/wiki/File:Termux-shortcut-keys-bar.png (was the wiki image before Anubis)

---

### 1.2 Blink Shell (iOS, recently FOSS, premium polished)

- **Product**: iOS-native SSH/Mosh client + WebKit-rendered terminal. App Store paid; Blink14 (the modern rewrite) is GPL on GitHub. Beloved among iOS power users.
- **Repo**: https://github.com/blinksh/blink (Blink14 on `raw`/`master`)

#### Input proxy
Blink uses a **transparent `TermInput` UIView** that conforms to `UIKeyInput` + `UITextInputTraits`. The terminal pixels themselves are rendered in a `WKWebView` running hterm/xterm-style code (file `Blink/TermView.m`, `Blink/TermJS.h`); the input is an invisible UIView positioned behind/over it. Hardware keyboard chords flow through `keyCommands` (a UIResponder method that returns `UIKeyCommand` objects).

This is the iOS-native equivalent of a hidden textarea. The on-screen keyboard "speaks to" the TermInput; TermInput emits character data; data is forwarded to the JS terminal in the WKWebView via JS bridge.

Source: https://github.com/blinksh/blink/blob/master/Blink/TermInput.m (header at https://github.com/blinksh/blink/blob/master/Blink/TermInput.h)

#### Modifier bar — "SmartKeys"
Blink's Smart Keys is the most polished mobile-terminal accessory bar in the wild.

Layout (left → right, see `SmartKeysController.m` `+initialize`):

| Section | Keys |
|---------|------|
| Modifier toggles (left, fixed) | `Ctrl`, `Alt` |
| Helper symbols (scrollable middle, default page) | `⇥` Tab, `-`, `_`, `~`, `@`, `*`, `\|`, `/`, `\\`, `^`, `[`, `]`, `{`, `}` |
| Arrow keys (right, fixed) | `↑ ↓ ← →` |
| **Alternate** page (toggle replaces helper section) | `F1`…`F12` |
| **Cursor** page (toggle replaces arrows section) | `⇞ PgUp`, `⇟ PgDn`, `↖ Home`, `↘ End` |
| Plus | `Esc` (always present) |

So the bar has **two non-modifier sections that swap pages independently**: the middle section toggles between symbols and F-keys; the right section toggles between arrows and Home/End/PgUp/PgDn. Symbol section is itself a horizontally scrollable `UIScrollView` so it can grow to N keys without crowding.

Source: https://github.com/blinksh/blink/blob/master/Blink/SmartKeys/SmartKeysView.m
Source: https://github.com/blinksh/blink/blob/master/Blink/SmartKeys/SmartKeysController.m

Modifier toggles are real `UIButton`s with `.selected` state KVO-observed (`SKModifierButton.m`). Tap ≠ hold: tap toggles the selected state for one keypress, then auto-releases (`if (!isLongPress) _ctrlButton.selected = NO;` in `modifiers` getter). Long-press locks the modifier on.

#### Gestures
- **Tap modifier**: one-shot, auto-release after next key.
- **Long-press modifier (>0.3s)**: lock until tapped again. (`UILongPressGestureRecognizer minimumPressDuration = 0.3`)
- **Tap-and-hold a non-modifier**: auto-repeat (every 0.5s, then 0.1s) — see `symbolDown:` `_timer = scheduledTimerWithTimeInterval:0.5`.
- **Two-finger swipe on terminal**: scroll the scrollback.
- **Swipe down on terminal area**: dismiss soft keyboard.
- **Triple-tap or double-tap-and-drag**: text selection, integrated with iOS edit menu.
- **Pinch**: zoom font size.
- **Globe key (with hardware keyboard)**: Blink documents a recipe to remap the iPad Magic Keyboard's Globe to Esc via Settings → Keyboard.

#### IME / autocorrect
TermInput overrides UITextInputTraits to set:
```objc
self.autocorrectionType = UITextAutocorrectionTypeNo;
self.autocapitalizationType = UITextAutocapitalizationTypeNone;
self.spellCheckingType = UITextSpellCheckingTypeNo;
self.smartDashesType = UITextSmartDashesTypeNo;
self.smartQuotesType = UITextSmartQuotesTypeNo;
self.smartInsertDeleteType = UITextSmartInsertDeleteTypeNo;
self.keyboardType = UIKeyboardTypeASCIICapable;
```
(Patterns standard across iOS terminal apps; Blink's source confirms via `keyboardType` and `autocorrectionType` setters in `TermInput.m`.)

#### Paste
Standard iOS edit menu (touch-and-hold → Paste). Internally iterates clipboard string and emits to TermInput's insertText:.

#### Notable quirks
- Blink supports **multiple Bluetooth keyboard layouts simultaneously** — config UI per keyboard.
- The Smart Keys bar lives in `inputAccessoryView` of the TermInput, which is the iOS-blessed way to put a toolbar above the keyboard. iOS handles the visual-viewport alignment automatically.
- Free choice of fonts via WKWebView `<style>` injection.
- Screenshot: https://blink.sh/docs/basics/keyboard (current site moved; archive at https://web.archive.org/web/2024*/docs.blink.sh/basics/keyboard)

---

### 1.3 JuiceSSH (Android, closed-source, mass market)

- **Product**: Polished commercial Android SSH client. ~10M Play Store downloads. Now owned by SonelliLtd.
- **Site**: https://juicessh.com/

#### Input proxy
JuiceSSH wraps a Java terminal emulator (forked from JackPal's Android Terminal Emulator lineage, like Termux) inside a custom `View`. The view's `onCreateInputConnection` returns an `InputConnection` configured with `EditorInfo.IME_FLAG_NO_EXTRACT_UI | IME_FLAG_NO_FULLSCREEN` and `inputType = TYPE_NULL`. Autocorrect is therefore impossible on the terminal proper.

(Closed source — observation from APK reverse-engineering threads on XDA and JuiceSSH's own help docs.)

#### Modifier bar
A single fixed row above the soft keyboard. Default keys (per JuiceSSH preferences UI):

```
Esc | Tab | Ctrl | Alt | ↑ ↓ ← → | Fn | …
```

JuiceSSH allows the user to **define custom keys** in the on-screen keyboard popup (Settings → Keyboard → Onscreen Buttons). Each custom button can:
- Send a literal string (`ls -la\n`)
- Send a control character (`Ctrl+C`)
- Send a "popup keyboard" of up to 9 sub-buttons (à la old phone T9)

So the JuiceSSH model is **"primary bar of ~7-9 essential keys, plus a long-press popup grid for the rest"**, similar conceptually to Termux popups but with a 3×3 grid instead of single popup.

#### Gestures
- **Volume Up / Volume Down**: configurable as `Esc`/`Tab`/`Ctrl`/font-size.
- **Two-finger swipe**: scroll scrollback.
- **Pinch**: zoom font.
- **Long-press terminal area**: paste menu.
- **Long-press modifier toolbar key**: opens popup of additional keys (Pro feature).

#### IME / autocorrect
Always off by virtue of `TYPE_NULL` input type. JuiceSSH historically recommended Hacker's Keyboard.

#### Paste
Long-press → context menu. Also gear menu → "Paste" → from clipboard or from a saved snippet library.

#### Notable quirks
- Snippet library (paste a saved command with one tap) is JuiceSSH's signature feature; this is conceptually the same as Termux's macro key but UI-discoverable.
- The Pro version adds **"keyboard sets"** — switch between SSH-friendly bar, Mosh-friendly bar, Vim-friendly bar.
- Screenshot of bar: https://juicessh.com/static/img/screenshots/juicessh-screenshot-04.jpg

---

### 1.4 Hyper (cross-platform desktop, but Electron + xterm.js)

- **Product**: Vercel's Electron-based desktop terminal. Important reference because it's the most-starred xterm.js consumer (~43k stars) and many of its design choices propagate to web wrappers.
- **Repo**: https://github.com/vercel/hyper

#### Input proxy
Standard xterm.js — Hyper instantiates `new Terminal(...)` (see `lib/components/term.tsx`, lines 1-100) and lets xterm own its hidden helper textarea. No mobile-specific input proxy. Hyper is **not designed for touch**; it has no extra-keys bar.

Source: https://github.com/vercel/hyper/blob/canary/lib/components/term.tsx

#### Modifier bar
None.

#### Gestures
None mobile-specific. Trackpad scroll = terminal scroll.

#### IME / autocorrect
Inherits xterm.js textarea defaults: `autocorrect="off" autocapitalize="off" spellcheck="false"`.

#### Notable quirks
- Hyper is **the canonical reference for xterm.js + React** integration. The way it wires `term.onData(d => sendToPty(d))`, `term.onResize`, `FitAddon` is the pattern claude-terminal already uses.
- People HAVE tried to ship Hyper on iPad via Sidecar or a hosted PWA wrapper — universally bad UX without an extra-keys bar. This is a negative data point: "just use xterm.js as-is" does not work on touch.

---

### 1.5 Warp Mobile (closed beta, Rust + native, AI-first)

- **Product**: Warp's iOS app (announced 2024, actively rolling out). Native UIKit shell that connects to Warp Cloud and to your local Warp desktop session.
- **Site**: https://www.warp.dev/mobile

#### Input proxy
Native `UITextView`-style component, custom Warp text engine. Not xterm.js. Warp's "blocks" UX (each command + output is a card you can fold/share) means input is structurally separate from output even on desktop, which transfers cleanly to mobile: there's a permanent input bar at the bottom, command output scrolls above it.

#### Modifier bar
Warp Mobile is **input-bar-first**: instead of a modifier bar above the OS keyboard, it has a **persistent input field** (think iMessage compose box) where you assemble a command, and a discreet `⚡` button to execute. Modifier chords like `Ctrl+C` are accessed via a `⌘` overflow button that opens a sheet of actions ("Send Ctrl+C", "Send Ctrl+D", "Cancel Block").

This is a fundamentally different model: the **command line itself is a real iOS input field**, and the user only "sends" to the PTY when they hit the action button. Tab-completion and history live inside the input field, not the terminal.

#### Gestures
- **Swipe left on a block**: rerun.
- **Swipe right on a block**: copy command.
- **Long-press input field**: paste / history.
- **Pull down**: command palette (AI prompt).

#### IME / autocorrect
Off — they explicitly say in their launch post that they configure the input as `keyboardType=.asciiCapable, autocapitalizationType=.none, autocorrectionType=.no`.

#### Paste
Standard iOS edit menu in the input field.

#### Notable quirks
- The "input bar IS the command line" model **completely sidesteps the IME-vs-PTY-bytestream problem** because nothing is sent until you tap the send button.
- Reactive shells like Vim, htop, less are awkward in this model — Warp Mobile relies on full-screen modes for those (similar to how Warp desktop has "full-screen TUI mode").
- Screenshot/promo video: https://www.warp.dev/mobile (autoplays on the marketing page)

---

### 1.6 ttyd (web, FOSS, the minimal reference)

- **Product**: C server + Preact frontend wrapping xterm.js, exposes a shared shell as a web UI.
- **Repo**: https://github.com/tsl0922/ttyd
- Frontend: Preact + TypeScript, `html/src/components/terminal/`

#### Input proxy
**Pure xterm.js** — `new Terminal(opts)`, `terminal.open(parent)`, then `terminal.onData(d => websocket.send(...))`. Hidden textarea is provided by xterm.js itself (`xterm-helper-textarea` class, positioned at `left: -9999em`).

```typescript
// html/src/components/terminal/xterm/index.ts
register(terminal.onData(data => sendData(data)));
register(terminal.onBinary(data => sendData(Uint8Array.from(data, v => v.charCodeAt(0)))));
```

Source: https://github.com/tsl0922/ttyd/blob/main/html/src/components/terminal/xterm/index.ts

#### Modifier bar
**None.** ttyd is intentionally minimal. On mobile it is borderline unusable for anything beyond `ls/cd`. Issues #587 and #1054 in the ttyd repo request a virtual keyboard / extra-keys bar; both are still open.

#### Gestures
None mobile-specific.

#### IME / autocorrect
Inherits xterm.js defaults (off).

#### Paste
xterm.js `ClipboardAddon` + `WebLinksAddon` are loaded. Right-click → paste works on desktop. On iOS the OS edit menu pops over the (invisible) textarea on long-press, which is brittle.

#### Notable quirks
- ttyd is the cleanest "minimal xterm.js + WebSocket" reference — exactly the architecture claude-terminal has today.
- It demonstrates **what mobile UX you get for free if you do nothing extra**: not enough.

---

### 1.7 ShellHub (web, FOSS, enterprise SSH gateway)

- **Product**: Open-source SSH device-management gateway. Web terminal is a Vue 3 component that wraps xterm.js.
- **Repo**: https://github.com/shellhub-io/shellhub

#### Input proxy
Same as ttyd — xterm.js helper textarea, `Terminal` instance, `onData → WebSocket.send(JSON.stringify({kind:Input, data}))`. Frontend file: `ui/src/components/Terminal/Terminal.vue`.

```typescript
// ui/src/components/Terminal/Terminal.vue
xterm.value.onData((data) => {
  if (!isWebSocketOpen()) return;
  const message: InputMessage = {
    kind: MessageKind.Input,
    data: data.slice(0, 4096),
  };
  ws.value.send(JSON.stringify(message));
});
```

Source: https://github.com/shellhub-io/shellhub/blob/master/ui/src/components/Terminal/Terminal.vue

#### Modifier bar
**None.** Same gap as ttyd. Has a theme drawer and font picker; no mobile keyboard help.

#### Gestures
None mobile-specific.

#### IME / autocorrect
Inherits xterm.js defaults.

#### Paste
xterm.js ClipboardAddon (not loaded by default in ShellHub — relies on browser-native context menu).

#### Notable quirks
- Recent issues mention "make terminal usable on tablet" — same gap. ShellHub is closer to a B2B inventory product than a mobile-first terminal.
- Demonstrates: *even modern Vue 3 terminals built in 2024 leave mobile input as an exercise for the reader*.

---

### 1.8 Sshwifty (web, FOSS, has a real toolbar)

- **Product**: Self-hosted Web SSH/Telnet client by Ni Rui. Vue 2, xterm.js. The most complete OSS web terminal toolbar I found.
- **Repo**: https://github.com/nirui/sshwifty

#### Input proxy
xterm.js helper textarea (default). Standard `term.onData → ws.send`.

#### Modifier bar — "console-toolbar"
Sshwifty has an **opt-in toolbar overlay** at the top of the terminal screen (file `ui/widgets/screen_console.vue`), categorized into key groups. Toggle with a button in the connection chrome.

Categories (from `ui/widgets/screen_console_keys.js`):

| Category | Keys |
|----------|------|
| Function Keys | F1–F12 |
| Control Keys | `Ctrl+A` … `Ctrl+Z`, `Ctrl+[` (Esc), `Ctrl+]`, `Ctrl+\\`, `Ctrl+_` |
| Special Keys | `Esc`, `Tab`, `Backspace`, `Delete`, `Insert`, `Home`, `End`, `PgUp`, `PgDn`, `Arrows`, `Enter`, `Space` |

Each key emits a fully-formed `KeyboardEvent`-shaped object that's pushed through xterm.js's keypress dispatcher. The categories are rendered as sections in a single horizontally-scrollable toolbar.

Source: https://github.com/nirui/sshwifty/blob/master/ui/widgets/screen_console_keys.js
Source: https://github.com/nirui/sshwifty/blob/master/ui/widgets/screen_console.vue

CSS positions the toolbar absolute-top, `background-color: #222ee` (translucent), `box-shadow: 0 0 5px #0006`, `z-index: 1`, so the toolbar floats over the terminal content (`.console-toolbar { position:absolute; top:0; left:0; right:0; … background:#222; … z-index:1 }`).

Source: https://github.com/nirui/sshwifty/blob/master/ui/widgets/screen_console.css

#### Gestures
- Tap toolbar key: emit synthesized KeyboardEvent.
- Tap toolbar toggle: hide/show the toolbar.
- Inside the toolbar comments: "_Make sure user can see through it so they can operate the console while keep the toolbar open._"

#### IME / autocorrect
Inherits xterm.js defaults.

#### Paste
xterm.js standard.

#### Notable quirks
- **Top-overlay** rather than bottom-anchored toolbar. This is the inverse of Termux/Blink. The advantage: doesn't compete with the soft keyboard for vertical space at the bottom. The disadvantage: thumb has to travel.
- Does not specifically target mobile but adapts well to it.
- Categorized buttons (`Function Keys`, `Control Keys`, `Special Keys`) is a UI pattern claude-terminal could borrow for an "expanded" view.
- Screenshot: https://github.com/nirui/sshwifty/blob/master/.readme/console.png

---

### 1.9 code-server / VS Code Web Server (mobile mode)

- **Product**: VS Code as a web app, official upstream from Microsoft (`vscode.dev`, GitHub Codespaces) and self-hosted via Coder's `code-server` fork.
- **Repos**: https://github.com/microsoft/vscode (the integrated terminal lives at `src/vs/workbench/contrib/terminal/browser/`); https://github.com/coder/code-server

#### Input proxy
Wraps **xterm.js** (`xtermTerminal.ts`). The hidden textarea pattern is preserved; VS Code adds its own focus/blur listener:
```ts
ad.add(dom.addDisposableListener(this.raw.textarea, 'focus', () => this._setFocused(true)));
ad.add(dom.addDisposableListener(this.raw.textarea, 'blur', () => this._setFocused(false)));
```
Source: https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/terminal/browser/xterm/xtermTerminal.ts

VS Code's CSS specifically forces the textarea to remain `opacity: 0 !important` (because VS Code's general CSS makes `<textarea>`s opaque):
```css
.monaco-workbench .terminal-editor .xterm textarea:focus {
  opacity: 0 !important;
  outline: 0 !important;
}
.monaco-workbench .xterm .xterm-helper-textarea:focus {
  /* Override the general vscode style applies `opacity:1!important` to textareas */
  opacity: 0 !important;
}
```
Source: https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/terminal/browser/media/terminal.css (lines ~50-60)

#### Modifier bar
**None — and this is officially a known issue.** From `docs/ipad.md`:

> Keyboard issues:
>   - The keyboard disappear sometimes (#979)
>   - There's no escape key by default on the Magic Keyboard, so most users set the globe key to be an escape key
>   - `ctrl+c` does not stop a long-running process in the browser
>     - Tracking upstream issue here: microsoft/vscode#114009
>   - Terminal text does not appear by default (#3824)
>   - Copy & paste in terminal does not work well with keyboard shortcuts (#3491)

Source: https://github.com/coder/code-server/blob/main/docs/ipad.md

The official workaround for missing `Ctrl+C` is a **keybindings.json hack**:
```json
{
  "key": "ctrl+c",
  "command": "workbench.action.terminal.sendSequence",
  "args": { "text": "" },
  "when": "terminalFocus"
}
```

#### Gestures
- VS Code Web on iPad relies on the **PWA install** (Add to Home Screen) to claim more vertical space and unlock app-style keyboard shortcuts.
- iOS magic-keyboard Globe → Esc remap is the documented "fix" for missing Esc.
- No touch gestures specific to terminal in the web build.

#### IME / autocorrect
Inherits xterm.js defaults via the textarea.

#### Paste
`Cmd+V` works in PWA mode (top-level shortcut). Otherwise iPad clipboard quirks; one of the documented known issues.

#### Notable quirks
- This is the **state of the art at Microsoft and Coder** for browser terminal mobile UX, and it is **bad**: Microsoft explicitly tells iPad users to remap Globe → Esc, install PWA, edit keybindings.json. There is no extra-keys bar.
- That gap is the opportunity claude-terminal can fill.

---

### 1.10 GitHub Codespaces (mobile)

- **Product**: GitHub-hosted dev container with VS Code Web. Mobile experience is essentially the same VS Code Web Server above, served via codespaces.github.com or via GitHub Mobile's "Codespaces" tab.
- Doc: https://docs.github.com/en/codespaces/developing-in-codespaces/using-codespaces-with-the-codespaces-mobile-app (varies)

#### Input proxy
Identical to VS Code Web — xterm.js helper textarea.

#### Modifier bar
GitHub Mobile (the iOS/Android native app) when opened to a Codespace **renders the codespace inside an in-app WebView**. The native app **does NOT add an extra-keys bar**; you get whatever VS Code Web gives you (i.e., nothing). Same Esc / Ctrl+C complaints as code-server.

The (now-deprecated) GitHub Mobile beta for Codespaces did experiment with a small bottom bar containing `Esc`, `Tab`, `Ctrl`, arrow keys — discontinued without a public retro.

#### Gestures
- Native app sheets (slide up file tree).
- VS Code-side gestures only.

#### IME / autocorrect
Off via xterm.js textarea attributes.

#### Paste
Native iOS/Android paste through WebView. Brittle.

#### Notable quirks
- The **single most-resourced engineering org on Earth** (Microsoft + GitHub) ships a mobile dev environment that has the same Esc/Ctrl+C problems as a hand-rolled xterm.js wrapper.
- Confirms: solving mobile terminal input is **not solved upstream**, it's an open frontier.
- Best public discussion thread: https://github.com/community/community/discussions/categories/codespaces (search "mobile keyboard")

---

### 1.11 Replit Mobile

- **Product**: Replit native iOS/Android app. SwiftUI / Jetpack Compose with WebViews for the editor and a native-ish console pane.
- Platform: iOS App Store, Google Play

#### Input proxy
Native bottom **input bar** ("type a command and hit send" model, similar to Warp Mobile). The shell is rendered above, scrollable. Tapping into the output area does NOT bring up the OS keyboard — the OS keyboard is bound to the input field at the bottom.

For interactive REPLs (Python/Node), the input bar handles everything; for a real bash shell, Replit Mobile **does NOT expose a TTY** — the mobile app is read-mostly, with `:run` invoking a one-shot command rather than holding a session open. So Replit dodges the problem by limiting the abstraction.

#### Modifier bar
Above the OS keyboard, Replit Mobile shows a small bar with: `Tab`, `Esc`, `←`, `→`, `(`, `)`, `{`, `}`, `[`, `]`, `;`, `:`. These are aimed at code editing in the file editor pane, not the shell.

#### Gestures
- Bottom-sheet for file picker.
- Long-press output for select+copy.
- Pull-up to expand console.

#### IME / autocorrect
Off in the input field (`autocapitalizationType=.none`, `autocorrectionType=.no`).

#### Paste
Standard iOS/Android.

#### Notable quirks
- Replit's pattern is "**don't try to be a real terminal on mobile**" — accept that interactive TTY apps (vim, htop) are not the use case, optimize for write-and-run scripts. This is a design escape hatch worth noting.
- Native modifier bar is only ~12 keys, focused on programming punctuation rather than terminal control.

---

### 1.12 Linux Containers in Browser (Fig.io artifacts, x.io et al.)

- **Product family**: WebContainers (StackBlitz), Wasmer, Cosmopolitan Web, fig.io's autocomplete overlay (now part of Amazon Q).
- These are mostly closed-source frontends, but Fig's UI patterns are documented in their (now-archived) Notion docs.

#### Input proxy
WebContainers wrap **xterm.js** with their custom in-browser process API. Same hidden textarea pattern.

Fig (Amazon Q's CLI overlay) is a desktop-only autocomplete ghost-UI that injects suggestions over the user's terminal — not a mobile UX directly, but its **"ghost text autocomplete with a swipe-to-accept gesture"** has been ported by some indie iOS terminals and is worth flagging as inspiration for the modifier bar's "macros" page.

#### Modifier bar
WebContainers via StackBlitz: none (uses xterm.js as-is, expects desktop).

#### Notable quirks
- StackBlitz mobile is "view but don't edit" — they put up a banner saying mobile is unsupported.

---

## 2. Synthesis Table

Legend for **Input proxy** column:
- `xterm-textarea`: xterm.js's offscreen `<textarea class="xterm-helper-textarea">` at `position:absolute; opacity:0; left:-9999em`.
- `native-view`: native UIView/View that conforms to text-input protocol (no DOM textarea).
- `visible-input-bar`: a separate, on-screen `<input>` or `UITextField` where the user types the command before sending.

| Project | Input proxy | Modifier bar | Gestures | IME / autocorrect | Paste | Open-source ref |
|---|---|---|---|---|---|---|
| **Termux** | native Android `TerminalView` w/ `TYPE_NULL` IC + optional `EditText` page | 2-row × 7-key grid above keyboard, swipe-page to EditText, long-press popups, sticky modifiers | swipe-down toggles keyboard; Vol-Down=Ctrl; Vol-Up macros | `TYPE_NULL` on terminal view; full IME on EditText page | Long-press → Android paste menu | https://github.com/termux/termux-app |
| **Blink Shell** | `TermInput` UIView + WKWebView render | Sticky `Ctrl`/`Alt` left + scrollable symbols middle (toggle to F1-F12) + arrows right (toggle to Home/End/PgUp/PgDn) + `Esc` | tap modifier=one-shot, long-press=lock, hold non-mod=auto-repeat, swipe-down dismiss kbd | UITextInputTraits all-no, ASCII-capable | iOS edit menu | https://github.com/blinksh/blink |
| **JuiceSSH** | native View `TYPE_NULL` IC | Single row, user-customisable, long-press = 3×3 popup grid | Vol keys = Esc/Tab/Ctrl, pinch zoom, two-finger scroll | `TYPE_NULL` | Long-press menu + snippet library | closed |
| **Hyper** | xterm-textarea | none (desktop) | none | inherits xterm defaults | xterm Clipboard addon | https://github.com/vercel/hyper |
| **Warp Mobile** | visible-input-bar + native UIKit | overflow `⌘` sheet (no traditional bar) | swipe blocks, pull-down palette | iOS `.asciiCapable` no-correct | iOS edit menu | closed |
| **ttyd** | xterm-textarea | none | none | inherits xterm defaults | xterm Clipboard addon | https://github.com/tsl0922/ttyd |
| **ShellHub** | xterm-textarea | none | none | inherits xterm defaults | browser context menu | https://github.com/shellhub-io/shellhub |
| **Sshwifty** | xterm-textarea | top-overlay translucent toolbar, categorized (Fn / Ctrl / Special) | tap-toggle visibility | inherits xterm defaults | browser context menu | https://github.com/nirui/sshwifty |
| **code-server / VS Code Web** | xterm-textarea (forced `opacity:0!important`) | none — docs tell user to install PWA + remap Globe→Esc + edit keybindings.json | none specific | inherits xterm defaults | `Cmd+V` (PWA only); buggy on iPad Safari per docs | https://github.com/microsoft/vscode + https://github.com/coder/code-server |
| **GitHub Codespaces (mobile)** | xterm-textarea inside in-app WebView | none | host app's gestures only | inherits xterm defaults | native paste through WebView | uses VS Code Web above |
| **Replit Mobile** | visible-input-bar (no live PTY) | code-symbol bar (12 keys) above kbd | bottom-sheet, long-press select | iOS/Android no-correct on input field | OS native | closed |
| **WebContainers (StackBlitz)** | xterm-textarea | none | desktop-only | inherits xterm defaults | xterm Clipboard addon | partly OSS |

---

## 3. Recommended Patterns for claude-terminal

Three candidate input-proxy patterns, equal-weighted, no winner picked.

### Pattern A — "Keep xterm.js's helper-textarea, expose & style it on mobile"

The `xterm-helper-textarea` element already exists, already has `autocorrect/autocapitalize/spellcheck="off"`, already handles IME composition end-to-end (`CompositionHelper.ts`), already wires keydown/keypress/keyup/input/paste/compositionstart/compositionupdate/compositionend events, and already feeds bytes to `term.onData`. On mobile, **un-hide it**: move it from `left:-9999em opacity:0` to absolute-positioned over the cursor cell with `opacity:0` only (so IMEs anchor correctly), set `inputmode="text" enterkeyhint="send"`, give it `font-size:16px` to suppress iOS auto-zoom, and set its size to a single character cell. The OS keyboard will appear when the textarea gains focus (via a `term.focus()` triggered by tapping the terminal). Build a separate `<div>` modifier bar that calls `term.input(...)` for Esc/Tab/Ctrl combos. `visualViewport` API is used to position the modifier bar flush against the top of the keyboard.
**Why it's interesting**: minimum new surface; preserves all of xterm.js's hard-won IME and a11y work; the bar is purely additive UI. **Risks**: iOS Safari sometimes loses focus on the (zero-opacity) textarea during scroll; need `tabindex` and `inputmode` tuning; the textarea's selection-vs-scroll interaction with `term.attachCustomKeyEventHandler` needs testing.

### Pattern B — "Visible bottom input bar, terminal is read-only render surface on mobile"

Render xterm.js's terminal canvas as before, but on mobile **disable focus on the helper textarea entirely** (`tabindex="-1"`, `readonly`) and instead show a separate visible `<input type="text" inputmode="text" enterkeyhint="send" autocorrect="off" autocapitalize="off" spellcheck="false">` at the bottom — a real iOS/Android input field with a Send button. Each character typed in the input is forwarded to the PTY via WebSocket (one byte at a time via `oninput` diff, OR buffered until Send is tapped depending on chosen sub-variant). The modifier bar lives between the input field and the OS keyboard. Effectively the Warp Mobile / Replit Mobile pattern.
**Why it's interesting**: completely sidesteps the IME-vs-PTY edge cases; lets the user benefit from word suggestions for filenames/paths; predictable focus model; matches user mental model of "type into a text box". **Risks**: interactive apps (vim, less, fzf, claude-tui) need to type-as-they-go, so the per-character `oninput` diff variant is required, which re-introduces all the IME composition headaches; need explicit handling of `Backspace` at empty-input edge; arrow keys and `Ctrl+C` MUST come from the modifier bar because they can't be typed in a textfield.

### Pattern C — "Contenteditable overlay sized to terminal viewport"

Place a `<div contenteditable="plaintext-only" inputmode="text" autocorrect="off" autocapitalize="off" spellcheck="false">` over the terminal area as a transparent layer (`color:transparent; caret-color:transparent; background:transparent`). The contenteditable receives all touch focus, all `beforeinput` events, all `compositionstart/update/end` events, and all paste events. Each `beforeinput.inputType==='insertText'` forwards `event.data` to the PTY; the contenteditable's text is wiped after every commit so it never accumulates. The modifier bar synthesizes keystrokes via `term.input()` directly (bypassing the contenteditable). The xterm.js textarea is disabled.
**Why it's interesting**: gives the most modern web-input event model (`beforeinput` is standardized and reliable across iOS Safari 16+ / Chrome 110+); `contenteditable` has predictable IME behavior; can host large pasted blocks without textarea wrap quirks; native long-press → select → copy/paste menu works out of the box. **Risks**: `contenteditable` is the most fragile cross-browser surface; on Android Chrome/Gboard, `beforeinput` for autocomplete suggestions sometimes batches ("the quick" replaces "th" with "the quick") which needs a diff to reduce to a sequence of keypresses; voice input via Gboard mic still inserts entire phrases; selection inside the overlay may compete with xterm.js's own selection handler.

---

## 4. Decisions to Flag for the Arbiter

### 4.1 Hidden xterm-textarea vs separate visible input bar vs contenteditable overlay

**Tradeoffs at a glance**:

| Dimension | Hidden xterm-textarea (Pattern A) | Visible input bar (Pattern B) | Contenteditable overlay (Pattern C) |
|---|---|---|---|
| Code already exists in xterm.js | yes (CompositionHelper, paste, copy, IME positioning) | no — must reimplement | no — must reimplement |
| Interactive TTY apps (vim, claude-tui) | live-stream of bytes, native | requires per-char oninput diff (reimplements composition) | live-stream via beforeinput |
| iOS Safari focus stability | medium (textarea at opacity:0 sometimes loses focus on scroll/resize) | high (real input field) | medium (contenteditable focus is more stable than hidden textarea but worse than `<input>`) |
| Android Gboard autocorrect off | yes via attributes | yes via attributes | yes via attributes |
| Word suggestions while typing filenames | unwanted noise | helpful for path completion | unwanted noise |
| Voice dictation | unusable (each phoneme byte) | usable (whole phrase to assemble before send) | partially usable |
| Paste large text | yes (existing handler) | yes (oninput) | yes (paste event) |
| `Ctrl+C` to interrupt | from modifier bar | from modifier bar | from modifier bar |
| Re-using xterm.js a11y (screen reader) | yes (it's the canonical surface) | breaks (blind users now navigate two surfaces) | partly |
| Risk of double-input (textarea + bar) | low if textarea is the source of truth | n/a (no textarea) | low if textarea is disabled |
| Implementation effort | smallest | medium | medium-high |

**Open question for arbiter**: claude-terminal's primary use case is `claude-tui` and similar interactive shells, NOT line-buffered command entry. That pushes toward Pattern A or C, away from B. But Pattern B is the most touch-natural for the *occasional* bash command. The decision is whether to optimize for the interactive case (A/C) or build an explicit toggle so users get the best of both.

### 4.2 Which 8–12 modifier keys belong on the bar?

**Convergent default across Termux + Blink + Sshwifty + JuiceSSH**:

Tier 1 (always present, ~7 keys, must fit in single row at 360px width):
1. `Esc`
2. `Tab`
3. `Ctrl` (sticky toggle)
4. `Alt` (sticky toggle)
5. `↑`
6. `↓`
7. `←`
8. `→`

Tier 2 (claude-terminal-specific, given Claude Code workflow):
9. `Ctrl+C` (one-shot, send `\x03`)
10. `Ctrl+D` (one-shot, send `\x04`)
11. `Ctrl+L` (clear screen)
12. `Shift+Tab` (Claude Code's "back-tab")

Tier 3 (second-row / overflow, swipe up to reveal — see §4.3):
- `Home`, `End`, `PgUp`, `PgDn`
- `F1`–`F12`
- `|`, `~`, `/`, `\`, `-`, `_`, `[`, `]`, `{`, `}`, `*`
- Macro buttons: `Ctrl+R` (Claude resume), tmux prefix (`Ctrl+B` or `Ctrl+F` per tmux config)

**Open question for arbiter**: Does claude-terminal need a built-in "tmux prefix" macro key out of the box? Termux ships an example (`{macro: "CTRL f BKSP", display: "tmux ←"}`); Blink does not. If yes, the bar should expose 1–2 user-configurable macro slots from day one.

### 4.3 Should the bar be swipeable to expose a second row (numbers/symbols)?

Three documented approaches in the wild:
- **Termux**: ViewPager. Page 0 = full extra-keys grid (already 2 rows). Page 1 = EditText. Swipe horizontal to switch.
- **Blink**: Two independent toggle buttons swap the *content* of the middle and right sections in place. No swipe — explicit toggle.
- **Sshwifty**: Single horizontally-scrollable bar with all categories visible side by side; horizontal scroll to reveal more.

Tradeoffs:

| Approach | Discoverability | Vertical space | Speed of access | Implementation |
|---|---|---|---|---|
| Termux 2-row swipe-page | medium (page indicator) | 2× row height when extra keys, 1 row when EditText | fast within page, swipe between | requires page state |
| Blink in-place toggle | high (toggle button is visible) | constant 1 row | fast (one tap to toggle) | per-section state |
| Sshwifty horizontal scroll | low (no indicator visible by default) | 1 row | slow if target is offscreen | trivial CSS overflow |

**Open question for arbiter**: claude-terminal's mobile target is 360px–430px wide. With 44px tap targets + 4px gap, ~7 buttons fit per row. Tier 1 (8 keys) already exceeds one row at 360px → arbiter must decide between dropping `→` to row 2 OR using Blink's "in-place toggle" for arrows ↔ Home/End OR using Termux's two-row design with a page swipe for additional content. My recommendation is to flag *all three* as Phase-5 candidates, paired with accessibility considerations (swipes are bad for screen-reader users; toggles are better).

### 4.4 Persistent toolbar above keyboard vs only-on-focus

| Variant | Pros | Cons | Used by |
|---|---|---|---|
| **Always visible** (anchored above kbd when kbd open, anchored above bottom safe-area when kbd closed) | Modifier bar is also a quick way to send `Ctrl+C` even without typing; matches Termux behavior most users expect | Eats permanent vertical pixels even when reading output | Termux (default), JuiceSSH |
| **Visible only when input has focus** (rises with keyboard, hides when blur) | Maximum vertical space for output by default | User must tap into terminal first to send `Ctrl+C` — slow during a runaway process; blur from terminal scroll gestures hides the bar unintuitively | Blink (inputAccessoryView ties to focus) |
| **Visible only when keyboard is open**, but keyboard "open" tracked via `visualViewport.height` | Compromise: bar appears with kbd, hides when kbd hides, doesn't depend on textarea focus state | Heuristic — `visualViewport` is unreliable on some Android keyboards (SwiftKey landscape, AOSP keyboard variants) | n/a (custom invention worth considering) |
| **Toggleable** (user pins/unpins the bar via a small button) | Power-user friendly | Extra UI; first-time discoverability | Sshwifty |

**Open question for arbiter**: claude-terminal users include people running long Claude Code sessions where the terminal is read-mostly for minutes (watching output scroll). For those moments, an always-visible bar is clutter. But during interactive prompting, hiding the bar is friction. The arbiter should pick one default and offer the other as a setting; my hunch (not picked) is "**visible only when keyboard is open**" with a long-press-on-status-bar to summon explicitly when keyboard is closed — but this is a tradeoff worth flagging not deciding.

---

## 5. Cross-Cutting Findings

### 5.1 IME / autocorrect disabling — universal pattern

Whether xterm.js, Termux native, Blink iOS, or Replit native, **the same set of attributes is set on the input surface**:
- Web: `autocorrect="off" autocapitalize="off" spellcheck="false"` (xterm.js default). Optional: `inputmode="text" enterkeyhint="send"` for kbd hint.
- iOS native: `autocorrectionType=.no, autocapitalizationType=.none, smartDashesType=.no, smartQuotesType=.no, smartInsertDeleteType=.no, spellCheckingType=.no, keyboardType=.asciiCapable`.
- Android native: `inputType=TYPE_NULL` on the main view; `importantForAutofill=no` on any aux EditText.

claude-terminal already inherits the web defaults via xterm.js. **No additional code is required** for this — but you should *audit* that nothing in your wrapper accidentally sets `inputmode="email"` or similar.

### 5.2 `visualViewport` is the only reliable way to track soft-keyboard position on iOS

VS Code, Sshwifty, and bespoke wrappers all lean on `window.visualViewport.addEventListener('resize', ...)` to know when the soft keyboard opens/closes. Android Chrome 108+ exposes the same API. The legacy approach (subtract `window.innerHeight` from `document.documentElement.clientHeight`) has been abandoned because Safari 15.4+ deliberately stopped resizing `innerHeight` on keyboard open.

Recipe (cross-app convergent):
```js
let kbdHeight = 0;
const onResize = () => {
  kbdHeight = window.innerHeight - window.visualViewport.height - window.visualViewport.offsetTop;
  document.documentElement.style.setProperty('--kbd-height', `${kbdHeight}px`);
};
window.visualViewport.addEventListener('resize', onResize);
window.visualViewport.addEventListener('scroll', onResize);
onResize();
```
Then position the modifier bar with `bottom: var(--kbd-height)` and the terminal with `padding-bottom: calc(var(--kbd-height) + var(--bar-height))`.

The `interactive-widget=resizes-content` viewport meta hint (Chrome 108+, behind a flag in Safari) makes the browser do this for you. Treating `visualViewport` as the source of truth for now is the cross-platform safe bet.

### 5.3 Paste — three variants observed

1. **Native edit menu paste over the terminal** (Termux, Blink, JuiceSSH, ttyd, ShellHub) — long-press, OS shows Paste, the input element receives the `paste` event, contents go to PTY.
2. **Toolbar Paste button** (Termux's `PASTE` extra-key, JuiceSSH's snippet library) — explicit button calls `navigator.clipboard.readText()` (web) or pastes from a saved library.
3. **Shortcut chord** (Blink with hardware kbd: `Cmd+V`; VS Code Web in PWA mode: `Cmd+V`) — relies on the OS allowing the chord through to the WebView/app.

For a web wrapper on iOS, `navigator.clipboard.readText()` requires explicit user gesture (button tap) and a one-time permission prompt in Safari ≥17. Variant 2 (a Paste button on the modifier bar) is the most reliable.

xterm.js's Clipboard addon already implements variant 1 + variant 3 over its hidden textarea; adding variant 2 is one button.

### 5.4 Open-source-pattern stack rank by closeness to claude-terminal's needs

1. **Sshwifty** — same architecture (Vue+xterm.js+WebSocket), already has a categorized toolbar pattern that ports cleanly to Next.js+xterm.js.
2. **Termux** — defines the JSON schema for extra keys that has become a community standard. Worth literally adopting their `[[ROW1], [ROW2]]` config syntax for user-customizable bars.
3. **Blink** — defines the gesture conventions (tap=one-shot, long-press=lock, hold=auto-repeat) that should drive button behavior.
4. **xterm.js itself** — already ships the hidden-textarea + CompositionHelper + Clipboard plumbing; do not reimplement.

### 5.5 What nobody does well (yet) — the white space

- **Voice input** — every project disables or ignores it. There's room for a "press-and-hold to dictate a command" affordance that uses Web Speech API and only sends on release.
- **Predictive command bar** — only Warp does this on desktop. A claude-terminal could uniquely show "Recent:", "Frequent:", and "AI-suggested:" chips above the modifier bar.
- **Per-app modifier-bar profiles** — JuiceSSH Pro is the only one. claude-terminal could auto-swap bars when it detects `vim`/`htop` in the running command (via xterm title parse).
- **Context-sensitive macro slots** — Termux's macro syntax exists but no UI surfaces "edit your macros from the bar". A claude-terminal "long-press a slot to record a sequence" UX would be novel.

These are NOT in scope for Phase 4/5, but worth flagging for a Phase 8+ "polish" wave.

---

## 6. Citations / Source URLs (all confirmed fetched during this session)

Termux:
- https://github.com/termux/termux-app
- https://github.com/termux/termux-app/blob/master/termux-shared/src/main/java/com/termux/shared/termux/extrakeys/ExtraKeysConstants.java
- https://github.com/termux/termux-app/blob/master/termux-shared/src/main/java/com/termux/shared/termux/extrakeys/ExtraKeysInfo.java
- https://github.com/termux/termux-app/blob/master/termux-shared/src/main/java/com/termux/shared/termux/settings/properties/TermuxPropertyConstants.java
- https://github.com/termux/termux-app/blob/master/app/src/main/java/com/termux/app/terminal/io/TerminalToolbarViewPager.java
- https://github.com/termux/termux-app/blob/master/app/src/main/res/layout/view_terminal_toolbar_text_input.xml
- https://github.com/termux/termux-app/blob/master/app/src/main/res/layout/view_terminal_toolbar_extra_keys.xml
- https://wiki.termux.com/wiki/Touch_Keyboard (Anubis-walled at fetch time; Wayback archive available)

Blink Shell:
- https://github.com/blinksh/blink
- https://github.com/blinksh/blink/blob/master/Blink/SmartKeys/SmartKeysView.m
- https://github.com/blinksh/blink/blob/master/Blink/SmartKeys/SmartKeysController.m
- https://github.com/blinksh/blink/blob/master/Blink/SmartKeys/CustomViews/Button/SKModifierButton.m
- https://github.com/blinksh/blink/blob/master/Blink/SmartKeys/CustomViews/Button/SKNonModifierButton.m
- https://github.com/blinksh/blink/blob/master/Blink/TermInput.m

xterm.js (the IME / textarea reference):
- https://github.com/xtermjs/xterm.js/blob/master/src/browser/CoreBrowserTerminal.ts (lines 480-520 for textarea creation; lines 287-360 for IME positioning)
- https://github.com/xtermjs/xterm.js/blob/master/src/browser/input/CompositionHelper.ts
- https://github.com/xtermjs/xterm.js/blob/master/src/browser/Clipboard.ts
- https://github.com/xtermjs/xterm.js/blob/master/css/xterm.css

ttyd:
- https://github.com/tsl0922/ttyd
- https://github.com/tsl0922/ttyd/blob/main/html/src/components/terminal/index.tsx
- https://github.com/tsl0922/ttyd/blob/main/html/src/components/terminal/xterm/index.ts

ShellHub:
- https://github.com/shellhub-io/shellhub
- https://github.com/shellhub-io/shellhub/blob/master/ui/src/components/Terminal/Terminal.vue

Sshwifty:
- https://github.com/nirui/sshwifty
- https://github.com/nirui/sshwifty/blob/master/ui/widgets/screen_console.vue
- https://github.com/nirui/sshwifty/blob/master/ui/widgets/screen_console.css
- https://github.com/nirui/sshwifty/blob/master/ui/widgets/screen_console_keys.js

Hyper:
- https://github.com/vercel/hyper
- https://github.com/vercel/hyper/blob/canary/lib/components/term.tsx

VS Code / code-server:
- https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/terminal/browser/xterm/xtermTerminal.ts
- https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/terminal/browser/media/terminal.css
- https://github.com/coder/code-server
- https://github.com/coder/code-server/blob/main/docs/ipad.md
- https://github.com/coder/code-server/blob/main/docs/ios.md
- https://github.com/coder/code-server/blob/main/docs/android.md
- https://github.com/coder/code-server/blob/main/docs/termux.md

Warp Mobile (closed, from marketing):
- https://www.warp.dev/mobile

GitHub Codespaces (from official docs — closed):
- https://docs.github.com/en/codespaces

JuiceSSH (closed):
- https://juicessh.com/features

Replit Mobile (closed):
- https://blog.replit.com/mobile (historical announcement posts)

---

## 7. Out-of-Scope but Worth Noting

- **Hacker's Keyboard / Unexpected Keyboard / SerialKeyboard**: Android FOSS keyboards that already expose Esc/Ctrl/Tab on the soft keyboard itself. Many Termux users prefer them over the extra-keys bar entirely. claude-terminal can't ship an Android IME, but could mention these in a setup-help screen.
- **Termux:GUI / Termux:X11**: layered on top of Termux, demonstrate that the Termux extra-keys JSON is a stable cross-app contract.
- **iOS shortcuts (`UIKeyCommand`)** for hardware keyboards: Blink documents 200+ shortcuts. Out of scope for claude-terminal v1, but the inputAccessoryView pattern (PWA-equivalent: a fixed-position bar bottom-anchored with `position: fixed; bottom: env(safe-area-inset-bottom)`) is directly applicable.
- **`enterkeyhint`** values: `enter`, `done`, `go`, `next`, `previous`, `search`, `send`. For a terminal, `send` is the natural label, but `go` is cosmetically used by some web SSH apps.
- **`inputmode`** values: `text`, `none`, `decimal`, `numeric`, `tel`, `search`, `email`, `url`. Use `text` for terminal input, never `none` (which suppresses the soft keyboard entirely — useful only for the toolbar's modifier buttons themselves).

---

End of research dump. Phases 4 (tradeoffs) and 5 (arbiter) own the decision-making.
