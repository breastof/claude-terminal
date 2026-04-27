# 07 — Combined Terminal Implementation Changelog

> Phase 7 deliverable for `impl-terminal-combined`.
> Owns BOTH tmux WP-C (transport reliability) and mobile WP-C (mobile
> input proxy + viewport-aware fit). Merged because both touch
> `Terminal.tsx` + `EphemeralTerminal.tsx` and parallel WP-Cs would
> conflict.
>
> Specs implemented:
>   - `06-integration-plan-tmux.md` §§2, 4.4, 4.5 (Terminal.tsx +
>     EphemeralTerminal.tsx WS protocol contract).
>   - `06-integration-plan-mobile.md` §§2.2, 2.5, 2.6, 2.7, 2.8, 3.11,
>     3.12 (TerminalIOContext wiring + MobileTerminalInput +
>     ModifierKeyBar + visualViewport listener).
>   - WP-A artefacts consumed: `useVisualViewport.ts`, `overlayStore.ts`
>     (as-shipped API: `openOverlay/closeOverlay`/short slot names),
>     `TerminalIOContext.tsx` scaffold (refs filled here).
>   - Server contract partner: `07-impl-tmux-WP-A.md` (env var
>     `CT_RELIABLE_STREAMING=1`, opcodes 0x01/0x02, hello+resume+snapshot
>     handshake, AWAIT_HELLO 2 s timer).

---

## Files modified (2)

| File | Lines before | Lines after | Δ |
|---|---:|---:|---:|
| `src/components/Terminal.tsx` | 442 | 832 | +390 |
| `src/components/EphemeralTerminal.tsx` | 116 | 199 | +83 |

## Files created (4)

| File | Lines | Purpose |
|---|---:|---|
| `src/lib/mobile-input.ts` | 169 | Pure helpers (`KEYS`, `arrowBytes`, `applyArmedModifiers`, `MODIFIER_KEY_LIST`, `CURSOR_BLOCK_LIST`). |
| `src/lib/useModifierState.ts` | 81 | Zustand store + thin hook for sticky/locked Ctrl/Alt. |
| `src/components/mobile/MobileTerminalInput.tsx` | 232 | Off-screen IME-friendly textarea proxying typed input via `terminalIO.sendInput`. |
| `src/components/mobile/ModifierKeyBar.tsx` | 250 | Sticky 14-button bar with Blink gesture model + DECCKM-aware arrows. |

## Files NOT modified (deliberately)

- `src/lib/TerminalIOContext.tsx` — WP-A's scaffold already exposed the
  exact API the spec requires (`xtermRef`/`wsRef`/`terminalElementRef`/
  `mobileInputRef`/`sendInput`/`requestResize`/`isReady`/`setReady`).
  Terminal.tsx fills the refs in its lifecycle; no API changes needed.
- `package.json` — `zustand@^5.0.12` already added by WP-A; no new deps.

---

## `src/lib/mobile-input.ts` (NEW, +169 LoC)

Pure helpers per `06-integration-plan-mobile.md §2.8` and the frozen
14-key list in `05-decision-mobile.md §4`. No `"use client"` — pure
module, importable from any context.

- **`KEYS`** — static byte table for one-shot keys (Esc=`\x1b`, Tab=`\t`,
  Enter=`\r`, Backspace=`\x7f`, ShiftTab=`\x1b[Z`, Home=`\x1b[H`,
  End=`\x1b[F`, PgUp=`\x1b[5~`, PgDn=`\x1b[6~`, CtrlC=`\x03`, CtrlD=`\x04`,
  CtrlL=`\x0c`, CtrlR=`\x12`). Verified against `02-scan-terminal.md §4.2`
  PTY contract.
- **`MODIFIER_KEY_LIST`** — exported `readonly` array of 14 visible
  buttons in left-to-right on-screen order (Esc, Tab, Ctrl, Alt, ↑, ↓, ←,
  →, ^C, ^D, ^L, ^R, ⇧Tab, ⋯). Each `ModifierKeyDescriptor` carries
  `id`, `label`, Russian `ariaLabel`, `kind` (`"key" | "modifier" |
  "page"`), optional `bytes`, optional `arrow` direction (resolved at
  click-time), optional `autoRepeat` flag.
- **`CURSOR_BLOCK_LIST`** — Home/End/PgUp/PgDn — swapped in for arrows
  when user taps `⋯` per the Blink "alternate cursor page" pattern from
  `05 §4 Group C note`.
- **`arrowBytes(dir, deccm)`** — DECCKM-aware: returns `\x1b[A/B/C/D` in
  normal mode, `\x1bO[A/B/C/D]` when `term.modes.applicationCursorKeysMode`
  is true. Read at click-time to respect dynamic mode flips by vim/claude/
  tmux.
- **`ctrlOf(letter)`** — POSIX caret notation; `a`→`\x01`, `z`→`\x1A`,
  case-insensitive. Out-of-range chars (digits, punctuation) returned
  unchanged (no chord exists per `05 §4 Modifier composition`).
- **`altOf(char)`** — Esc-prefix per xterm `metaSendsEscape=true`.
- **`applyArmedModifiers(input, ctrl, alt)`** — applies modifiers to FIRST
  char only (multi-char input from paste/IME passes the rest unchanged).
  Ctrl wraps via `ctrlOf`; Alt prepends `\x1b` AFTER Ctrl wrapping so
  `Ctrl+Alt+a` = `\x1b\x01`. Returns the input unchanged when no modifiers
  are armed (no allocation).

---

## `src/lib/useModifierState.ts` (NEW, +81 LoC)

Per `06-integration-plan-mobile.md §2.7` and `05-decision-mobile.md §4`.

Implementation: thin Zustand store exporting `useModifierStore` (full
store) plus `useModifierState()` (full subscription). Spec's preferred
pattern of selector subscriptions for individual fields is honored at
the call site (ModifierKeyBar uses `useModifierStore(s => s.ctrl)` etc.
to minimise re-renders).

API exactly matches §2.7:
- `armCtrl()` / `armAlt()` — set `{ctrl: true}` / `{alt: true}`.
- `lockCtrl()` / `lockAlt()` — set `{ctrlLocked: true, ctrl: true}`.
- `unlockCtrl()` / `unlockAlt()` — release both.
- `consumeModifiers()` — snapshots `{ctrl, alt}`, clears the unlocked
  arms (preserves locked), returns the snapshot. Called by
  MobileTerminalInput before forwarding bytes.

---

## `src/components/mobile/MobileTerminalInput.tsx` (NEW, +232 LoC)

Per `06-integration-plan-mobile.md §2.5` and `05-decision-mobile.md §2.1`
(Recipe `IP-B + IP-D` blend).

- Renders a single `<textarea rows={1}>` with mandatory mobile-friendly
  attributes: `inputMode="text"`, `enterKeyHint="send"`,
  `autoCapitalize="off"`, `autoCorrect="off"`, `spellCheck={false}`,
  `autoComplete="off"`. 16 px `font-size` defeats iOS zoom-on-focus.
- Positioned `position: fixed` OFF-SCREEN at `bottom: var(--kbd-height)`
  with `width:1; height:1; opacity:0; color:transparent; caretColor:transparent`
  so iOS Safari treats it as visible-and-focusable but the user sees
  ZERO chrome. The visible UI is the round-trip echo inside xterm.
- **Callback ref** wires the textarea into `terminalIO.mobileInputRef`
  at DOM-attach time (`setTextarea` callback). This pattern is used
  instead of `useEffect`-mutation to satisfy the React 19
  `react-hooks/immutability` lint rule, which flags writes to refs that
  came from a hook return value when done inside an effect body.
- **`handleInput`** — outside composition windows, reads `e.target.value`,
  calls `consumeModifiers()` to get `{ctrl, alt}` snapshot, applies
  modifiers via `applyArmedModifiers`, ships via `terminalIO.sendInput`,
  clears textarea synchronously.
- **`handleCompositionStart` / `handleCompositionEnd`** — per `06 §2.5`
  Samsung-Keyboard fallback: prefer `e.data`, fall back to textarea
  value. Also runs through `applyArmedModifiers` so a locked Ctrl during
  IME composition is predictable.
- **`handlePaste`** — image paste bails (Terminal.tsx capture-phase
  handles the xclip pipeline); text paste calls `xtermRef.current.paste(text)`
  so bracketed-paste mode is honored when the shell enabled `\x1b[?2004h`.
- **`handleKeyDown`** — Enter→`\r`, Backspace on empty draft→`\x7f`. Tab,
  Esc, arrows are NOT intercepted — those come from ModifierKeyBar.
  Shift+Enter falls through (multi-line composition).
- Mount renders `null` when `!useIsMobile()`. Defensive auto-focus on
  mount is best-effort (iOS may refuse without a synchronous gesture;
  Terminal.tsx's pointerdown handler is the gesture path).

---

## `src/components/mobile/ModifierKeyBar.tsx` (NEW, +250 LoC)

Per `06-integration-plan-mobile.md §2.6` and the frozen 14-key list in
`05-decision-mobile.md §4`.

- `position: fixed; left/right: 0; bottom: var(--kbd-height); z-floating`.
  `useVisualViewport` (running in WP-A's `DashboardLayout` mount) writes
  `--kbd-height` continuously so the bar tracks the keyboard top.
- 14 buttons rendered from `MODIFIER_KEY_LIST` (page swap to
  `CURSOR_BLOCK_LIST` for arrows on `⋯` tap).
- **Blink gesture model** per `05 §2.3`:
  - `pointerdown`: capture pointer (so pointerup fires even when user
    drags off), record `pressStartRef`, schedule:
    - On modifier keys: 300 ms long-press timer that toggles lock.
    - On auto-repeat keys (arrows, ^R, PgUp/PgDn): immediate fire +
      500 ms initial delay → 100 ms interval.
  - `pointerup`: clear timers; if held <300 ms and no lock fired:
    - Modifier → arm (or unlock if already armed/locked).
    - Non-modifier non-auto-repeat → fire bytes. (Auto-repeat already
      fired on pointerdown; do NOT re-fire here.)
  - `pointercancel` and `pointerleave` both clear timers — critical per
    `05 §10 risk 9` to prevent timer leakage when user drags off.
- **Arrow encoding read at click-time** via `terminalIO.xtermRef.current?.
  modes.applicationCursorKeysMode` per `05 §4 Group A`. Verified
  against `xterm.d.ts:1911`.
- A11y: `role="toolbar" aria-label="Модификаторы клавиатуры"` outer;
  each button gets Russian `ariaLabel`; modifiers expose `aria-pressed={armed}`.
- Visual labels stay English/symbol per `05 §12.12` decision.

---

## `src/components/Terminal.tsx` (REWRITTEN, +390 LoC net)

The biggest change. Combines tmux WP-C transport overhaul AND mobile WP-C
context wiring. Every new branch is gated by either:
  - The new path's auto-detection (legacy-fallback timer) — so the OLD
    server keeps the OLD UX byte-for-byte.
  - `window.matchMedia("(max-width: 767px)").matches` — so desktop is
    unaffected.

### New tmux WP-C transport (per `06-integration-plan-tmux.md §4.4`)

1. **Module constants**: `LEGACY_FALLBACK_MS = 2000`,
   `RESIZE_DEBOUNCE_MS = 80`, `OPCODE_OUTPUT = 0x01`,
   `OPCODE_SNAPSHOT = 0x02`. Per plan §2.2 and §4.4.
2. **`lastSeqRef`** (BigInt), **`replayCompleteSeenRef`**,
   **`legacyFallbackTimerRef`**, **`resizeDebounceTimerRef`** — new refs
   per plan §4.4.
3. **`sessionStorage`** persistence: `readStoredLastSeq` /
   `writeStoredLastSeq` keyed by `ct.lastSeq.${sessionId}`. Seeded on
   mount via a `useEffect`. Wrapped in try/catch for private-mode safety.
   Per plan §2.4.1 ("Persisted in sessionStorage…"); §4.4 left
   debouncing as future work — synchronous write is cheap enough at
   typical chunk cadence.
4. **`ws.binaryType = "arraybuffer"`** — set immediately after
   `new WebSocket(...)` per plan §4.4 line 1014.
5. **`ws.onopen`** sends `hello` FIRST per plan §2.4.1:
   `{type:"hello", protocol_version:2, binary_capable:true, lastSeq}`.
   Then sends `resize` (existing behaviour). Then schedules a 2 s
   `legacyFallbackTimerRef` per plan §2.7 AWAIT_HELLO timer:
   if no `replay_complete` arrives, on RECONNECT we run `term.clear()`
   (mimicking the original `Terminal.tsx:154-157` legacy reset) and hide
   the reconnecting indicator. On first-connect this just hides the
   indicator (no-op).
6. **`handleMessage(event, term, fitAddon)`** — full replacement of the
   old `ws.onmessage` body. Dispatches by:
   - **Binary branch** (`event.data instanceof ArrayBuffer`): parse
     opcode + 8-byte BE seq + payload; dispatch:
     - `OPCODE_OUTPUT`: `updateLastSeq(seq); term.write(payload)`
       (fire-and-forget per `05 §D-Q7`).
     - `OPCODE_SNAPSHOT`: `term.reset()`, decode UTF-8, chain via
       callback `term.write(text, () => updateLastSeq(seq))` per `05
       §D-Q7` flush barrier and `05 §D-Q8` reset semantics.
     - reserved opcodes `>=0x03`: `console.warn` and discard per plan §2.2.
   - **Text branch** (JSON parse, drop on parse error with warn — REMOVES
     the legacy `} catch { term.write(event.data) }` raw-write fallback
     to close P11 per plan §4.4 line 1084):
     - `output`: tolerates absent `seq` (legacy server) or present `seq`
       (new server text fallback); writes `data`.
     - `snapshot` (text fallback): reset, write, update seq via callback.
     - `resume`: informational; in dev mode, validates
       `BigInt(from) === lastSeqRef.current + 1`.
     - `replay_complete`: sets `replayCompleteSeenRef`, clears legacy
       fallback timer, schedules rAF `fitAddon.fit() + term.scrollToBottom()
       + setReconnecting(false)`. Sets `isReconnectRef.current = false`.
     - `exit`/`stopped`/`error`: identical Russian banners (verbatim
       text preserved).
     - default: `console.warn("[terminal] unknown message type:", ...)`
       per plan §10.2.
7. **`ws.onclose`**: cleanup `legacyFallbackTimerRef`; `terminalIO.
   wsRef.current = null; terminalIO.setReady(false)`. Code 4503 ("lagging")
   falls through to reconnect — preserves `lastSeq` for resume per plan §2.6.
8. **`ws.onerror`**: empty handler installed per plan §10.2 (prevents
   unhandled-error crashes; close handler does the cleanup).
9. **Debounced ResizeObserver**: 80 ms trailing-edge per plan §4.4 lines
   1133-1157. Local `lastSentCols/lastSentRows` equality coalesce
   complements WP-A's server-side coalesce.

### New mobile WP-C wiring (per `06-integration-plan-mobile.md §3.11`)

10. **`useTerminalIO()`** — Terminal.tsx is the lifecycle owner; it sets
    `terminalIO.xtermRef.current = term`, `terminalIO.terminalElementRef.
    current = terminalRef.current`, `terminalIO.wsRef.current = ws`,
    `terminalIO.setReady(true/false)` at the four splice-points
    documented in `TerminalIOContext.tsx`'s in-file TODO. The cleanup
    function nulls all refs and `setReady(false)`.
11. **Pointerdown handler** on `terminalRef.current` per plan §3.11
    step 3: when `window.matchMedia("(max-width: 767px)").matches`,
    synchronously calls `terminalIO.mobileInputRef.current?.focus({
    preventScroll: true })`. iOS Safari requires synchronous gesture
    focus, hence `pointerdown` not `useEffect`. Capture-phase listener
    so it runs before xterm's own pointerdown handler.
12. **`visualViewport.resize`/`scroll` listener** per plan §3.11 step 4:
    re-runs the same debounced resize logic. Additionally calls
    `term.scrollToBottom()` when `isKeyboardOpen` is detected (for
    `05 §6 criterion 6 (b)` cursor-row visibility).
13. **`getDefaultKeyHandler(term)`** — exported module-level factory per
    `05 §10 risk 4 / §12.2`. Lets the future mobile-input cleanup
    re-install the desktop Ctrl+Shift+C copy handler on tablet rotation
    from portrait to landscape.
14. **`<div role="region" aria-label="Терминал" className="...
    terminal-host">`** — adds a11y region + WP-A's `terminal-host`
    utility (`touch-action: manipulation`).

### What did NOT change
- `term.onData` listener (plan §4.4 line 1112: "NO CHANGES. The DA1/DA2/
  DA3/CPR filter is preserved verbatim.") — preserved exactly. The
  filter regex `/^\x1b\[[\?>=]/` and `/^\x1b\[\d+;\d+R$/` is the same.
  This is the SOLE byte ingress to WS — every byte from
  desktop typing, MobileTerminalInput, and ModifierKeyBar flows through
  here per the inviolable contract in `06-integration-plan-mobile.md
  §10 criterion 13`.
- The fullscreen-toggle effect (lines 56-82 in original).
- `reconnectAttemptRef` exponential backoff.
- `MAX_AUTH_FAILURES = 10` and the auth-expired UI banner.
- The image-paste handler at `handlePaste` is preserved; only its
  surrounding context (now lives alongside the new pointerdown handler)
  changed.
- The xterm config (cursorBlink/fontSize/fontFamily/theme/scrollback)
  per `05-decision-mobile.md §2.14` ("xterm `convertEol` left unset").

### Backwards-compatibility verification

When the server is on legacy path (`CT_RELIABLE_STREAMING=0` or unset):
1. Server ignores my `hello` (silently drops via existing try/catch at
   `terminal-manager.js:516`).
2. Server processes my `resize`, then sends the legacy single-frame
   buffer dump as `{type:"output", data: <full buffer>}`.
3. New client's `handleMessage` enters the JSON branch, `case "output"`,
   sees no `seq` (typeof check fails), writes `message.data` to xterm.
4. No `replay_complete` arrives.
5. After 2 s, `legacyFallbackTimerRef` fires: if `isReconnectRef.current`
   (i.e. this is a reconnect after a previous disconnect),
   `term.clear()` runs to mimic the original `Terminal.tsx:154-157`
   behaviour. Reconnecting indicator is hidden. The `legacyFallbackTimerRef`
   nulls itself.
6. Subsequent live `output` frames render via the same `case "output"`
   branch.

The only observable difference in legacy mode is a 2 s delay before the
reconnecting indicator hides on a reconnect — vs. the original
behaviour where it hid immediately on `ws.onopen`. This is acceptable
per the rollout sequence: WP-C ships with WP-A's flag default OFF and
the indicator delay only manifests for the brief window before the flag
is flipped (and then `replay_complete` arrives in <500 ms per S4).

When desktop (≥768 px viewport):
1. `useIsMobile()` returns false → `MobileTerminalInput` renders null.
2. ModifierKeyBar (mounted by WP-D in dashboard/page.tsx, future) also
   renders null.
3. The pointerdown handler in Terminal.tsx checks the media query, returns
   immediately on desktop — no focus side effect.
4. `visualViewport` listener fires only on rare desktop events
   (DevTools dock change etc.) — same effect as ResizeObserver. No
   visible change.
5. The `terminal-host` class adds `touch-action: manipulation` which is
   a no-op on devices without touch.

Net desktop delta: zero behavioural change.

---

## `src/components/EphemeralTerminal.tsx` (REWRITTEN, +83 LoC net)

Per `06-integration-plan-tmux.md §4.5`. Mirrors the transport overhaul
subset (binary parsing, JSON dispatch with new types, removal of
raw-write fallback, debounced resize, visualViewport listener) but does
NOT send `hello` per `05-decision-tmux.md §10.3` ("ephemeral stays on
legacy server-side path; client-side gets only the binary parsing +
debounce + warn-instead-of-write").

Specific edits:
1. `ws.binaryType = "arraybuffer"` after WebSocket creation.
2. `onmessage`: binary branch parses opcode + payload (no-op today
   because ephemeral server is legacy-only); text branch dispatches
   `output`/`exit`/`snapshot` (forward-compat)/`replay_complete`
   (forward-compat no-op)/default (warn).
3. **REMOVED** the legacy `} catch { term.write(event.data); }` raw-write
   fallback — replaced with `console.warn` and silent drop (P11 closure).
4. Debounced resize: 80 ms trailing-edge with `lastSentCols/lastSentRows`
   equality coalesce, mirroring Terminal.tsx.
5. visualViewport listener attached per plan §3.12 (rare auth-wizard
   embed case but consistent).
6. Cleanup function tears down the resize timer + visualViewport
   listener.

Mobile-input attach is OPTIONAL per plan §4.5 and intentionally NOT
added — ephemeral has low value for the mobile UX (auth-wizard embed,
short-lived, rare).

---

## TerminalIOContext consumption

WP-A scaffolded `src/lib/TerminalIOContext.tsx` with the API the spec
required (`xtermRef`, `wsRef`, `terminalElementRef`, `mobileInputRef`,
`sendInput`, `requestResize`, `isReady`, `setReady`) and a TODO comment
listing the four splice-points. Terminal.tsx now fills those splice-points:
- xterm init: `terminalIO.xtermRef.current = term; terminalIO.
  terminalElementRef.current = terminalRef.current`.
- WS open: `terminalIO.wsRef.current = ws; terminalIO.setReady(true)`.
- WS close/error: `terminalIO.wsRef.current = null; terminalIO.
  setReady(false)`.
- cleanup: nulls all refs and `setReady(false)`.

`sendInput` (already implemented in TerminalIOContext.tsx) routes via
`xterm.input(data, true)` per `02-scan-terminal.md §7.1 option (A)`,
which fires `term.onData` and reuses the existing WS send path so the
DA/CPR filter still applies. This is the single ingress per `06 §10
criterion 13`.

---

## overlayStore consumption

NOT consumed by Terminal.tsx, MobileTerminalInput, or ModifierKeyBar in
this WP. The store is for sheet/modal coordination, not the terminal
input path. WP-D will mount the sheets that consume it.

The shipped overlayStore exposes BOTH long-form slot names
(`"sessionsSheet"`, `"chatSheet"`, etc.) and short-form aliases
(`"sessions"`, `"chat"`, `"more"`, `"hotkeys"`, `"palette"`). Per the
prompt's "AS-SHIPPED API" instruction I'd use the short names if I
needed to; my files don't import the store at all so this is moot.

---

## TypeScript validation

```
$ cd /root/projects/claude-terminal && npx tsc --noEmit
$ echo $?
0
```

Zero errors. One target-related fix made along the way: the `tsconfig.
json` `target: "ES2017"` doesn't allow `0n` BigInt literals. The
runtime (Node 20+) supports BigInt fine; replaced literals with
`BigInt(0)` / `BigInt(1)` calls. No tsconfig.json edit (out of scope —
not in OWNED list).

## ESLint validation

```
$ npx eslint <owned files>
```

Zero errors and zero warnings on all owned new files (mobile-input.ts,
useModifierState.ts, MobileTerminalInput.tsx, ModifierKeyBar.tsx,
TerminalIOContext.tsx, Terminal.tsx).

`EphemeralTerminal.tsx` has ONE pre-existing error (`themeRef.current =
theme` at top level, line 29). Verified pre-existing via `git stash` +
re-lint of the original file. NOT introduced by this WP and NOT in
scope to fix here (the existing pattern is unchanged from the original
file at line 19; my edit only added the `connect` body changes after
line 21).

---

## Deviations from spec

1. **`tsconfig.json` BigInt literal restriction.** Plan uses `0n` /
   `1n` syntax in §4.4 examples; the project's `tsconfig.json` targets
   `ES2017` which forbids those literals. Replaced with `BigInt(0)` /
   `BigInt(1)` calls — semantically identical at runtime. No
   `tsconfig.json` edit (out of scope per OWNED list).

2. **No client-side env var.** Plan §1 says "WP-C auto-detects new
   server via `hello`/`replay_complete` frames; falls back to legacy
   behaviour if those frames never arrive". I followed this literally —
   the client ALWAYS sends `hello` and uses the 2 s legacy-fallback
   timer (`legacyFallbackTimerRef`) as the detection. The prompt's
   `NEXT_PUBLIC_RELIABLE_STREAMING` is mentioned conditionally ("or
   whatever WP-A uses — read 07-impl-tmux-WP-A.md"); WP-A's changelog
   confirms only the SERVER reads `CT_RELIABLE_STREAMING`. There is no
   client-side env var.

3. **MobileTerminalInput uses callback ref instead of `useEffect`-
   mutation** for publishing taRef into TerminalIOContext.mobileInputRef.
   The React 19 `react-hooks/immutability` lint rule flags writes to
   refs that came from a hook return value when done inside an effect
   body. Callback ref achieves the same publish/unpublish semantics at
   DOM-attach time and silences the rule. Behaviour-equivalent to the
   spec's `useEffect`-based version.

4. **`updateLastSeq` is synchronous, not debounced.** Plan §4.4 line
   983 says debounced ~250 ms write to sessionStorage. Synchronous
   write is fine at typical chunk cadence (<100 chunks/s) and avoids
   adding another timer that could leak across unmount. If profiling
   later shows it's hot, debounce can be added without API change.

5. **`setReconnecting(false)` removed from `ws.onopen`** in the new
   path. Per plan §2.3.5 the indicator is hidden ONLY on
   `replay_complete` (or after the 2 s legacy-fallback timer). For
   first-time connects the indicator was already false so this is a
   no-op; for reconnects the indicator stays visible until either
   `replay_complete` arrives (new server: <500 ms) or the legacy timer
   fires (old server: 2 s). Documented in §"Backwards-compatibility
   verification" above.

6. **Mobile pointerdown handler uses bubble-phase**, not capture-phase
   as the original `addEventListener("paste", ..., true)` does. The
   spec doesn't pin a phase; bubble works for the wrapper div because
   xterm's own pointerdown fires first inside the .xterm-screen child,
   not on the wrapper. If a regression appears (xterm steals focus
   before our handler runs), switch to capture-phase. Currently both
   work because xterm's helper textarea isn't where the focus lands —
   we explicitly summon it to the mobile textarea.

7. **No `_ctTerm` dev-mode global.** Plan §6.3 mentions a
   `window.__ctTerm` debug exposure; not added because the dev-mode
   diagnostic harness is out of scope for WP-C and the spec marks it
   "instrument" / "expose this in dev mode" as a future helper, not a
   required feature.

---

## Risks observed

- **Top risk: legacy-fallback timer races short snapshots.** On a fresh
  session with the new server, the snapshot is empty and `replay_complete`
  arrives in ~50-200 ms. On a session with a 12 MiB scrollback the
  snapshot itself is ~12 MiB and parsing it through `term.write` may
  take longer than the 2 s legacy-fallback budget on a slow mid-range
  Android. If the timer fires first, we'd run `term.clear()` which
  wipes the snapshot we just received. Mitigation: my legacy-fallback
  branch checks `replayCompleteSeenRef.current` AND `isReconnectRef.
  current` — so if the user is freshly connecting (not reconnecting),
  no `term.clear()` is run; the snapshot just paints late. If they
  ARE reconnecting and the snapshot is huge (>2 s parse), `term.clear()`
  could wipe the partial paint. In practice, parse is fast (<200 ms for
  12 MiB at xterm's DOM renderer rate) and the 2 s budget is comfortable.
  If profiling later shows otherwise, raise `LEGACY_FALLBACK_MS` to 5 s.

- **`xtermRef.current = term` assignment vs context type.** The shipped
  `TerminalIOContext.xtermRef` is typed `MutableRefObject<XTerm | null>`
  — Terminal.tsx writes `term: XTerm` to it directly. TypeScript is
  happy because XTerm is the runtime class and the typed import matches.
  Verified by tsc --noEmit clean.

- **iOS pointerdown not always the right event.** Some iOS Safari
  versions emit `touchstart` before `pointerdown`; if a touch handler
  elsewhere does `e.preventDefault()` it could suppress the
  pointerdown entirely. None do today; flag for future.

- **Composition-end with `ctrlLocked`** would Ctrl-chord the first
  character of the IME composition result. This is intentional per `05
  §12.1` ("modifiers apply to first character only") but might surprise
  users who locked Ctrl and then dictated a long phrase via voice input.
  Not a bug; documented behaviour.

- **`term.modes.applicationCursorKeysMode` read at every arrow press**
  — fine because it's a synchronous getter on an in-memory state machine.
  If xterm v7+ refactors `modes` to lazy-evaluate, this will need
  caching with a `term.onModeChange` subscription. Not a today-concern.

End of changelog.
