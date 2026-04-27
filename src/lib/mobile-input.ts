/**
 * mobile-input — pure helpers for the mobile-input proxy and modifier bar.
 *
 * Per `06-integration-plan-mobile.md §2.8` and `05-decision-mobile.md §4`.
 *
 * These helpers are pure (no React, no DOM). They translate logical key
 * presses + armed-modifier state into the exact byte sequences the PTY
 * expects, matching xterm's own keymap (verified against
 * `02-scan-terminal.md §4.2` and `03-research-xterm-proxy.md §6.1`).
 *
 * No `"use client"` — pure module, importable from server or client.
 */

/**
 * Static byte tables — one-shot keys produced by the modifier bar.
 *
 * Frozen per `05-decision-mobile.md §4 Group A/B/C`. Every value MUST
 * round-trip through `terminalIO.sendInput` (= `term.input(data, true)`)
 * unchanged. The DA/CPR filter at `Terminal.tsx:217` does NOT match any
 * of these (it filters `\x1b[?...` and `\x1b[N;NR`), so all are safe.
 */
export const KEYS = {
  Esc: "\x1b",
  Tab: "\t",
  Enter: "\r",
  Backspace: "\x7f",
  ShiftTab: "\x1b[Z",
  Home: "\x1b[H",
  End: "\x1b[F",
  PgUp: "\x1b[5~",
  PgDn: "\x1b[6~",
  CtrlC: "\x03",
  CtrlD: "\x04",
  CtrlL: "\x0c",
  CtrlR: "\x12",
} as const;

export type KeyName = keyof typeof KEYS;

/** Cardinal arrow direction. */
export type ArrowDirection = "up" | "down" | "left" | "right";

/**
 * Frozen visible modifier-key list per `05-decision-mobile.md §4`.
 *
 * Order matters — this is the on-screen left-to-right order. The 14th
 * visible button (`More`) swaps the arrows group (5..8) for Home/End/
 * PgUp/PgDn in-place per the Blink "alternate cursor page" pattern.
 *
 * `kind`:
 *   - `"key"`         — emits `bytes` (or `bytesGetter` for DECCKM-aware) on tap
 *   - `"modifier"`    — toggles armed/locked state via useModifierState
 *   - `"page"`        — internal UI toggle (More button)
 */
export interface ModifierKeyDescriptor {
  id: string;
  label: string;
  /** Russian aria-label per `06-integration-plan-mobile.md §2.6 a11y`. */
  ariaLabel: string;
  kind: "key" | "modifier" | "page";
  /** Static byte sequence for one-shot keys. */
  bytes?: string;
  /** Modifier name (only when `kind === "modifier"`). */
  modifier?: "ctrl" | "alt";
  /** Hold-to-auto-repeat (per `05 §4 Type` column). */
  autoRepeat?: boolean;
  /** Arrow direction (resolved at click-time via DECCKM). */
  arrow?: ArrowDirection;
}

/**
 * The 14 visible buttons in the order they appear on screen.
 *
 * Groups separated by 1 px vertical dividers per `05 §4`:
 *   A: Esc Tab | Ctrl Alt | ↑ ↓ ← →
 *   B: ^C ^D ^L ^R ⇧Tab
 *   (page-swap): More
 */
export const MODIFIER_KEY_LIST: readonly ModifierKeyDescriptor[] = [
  { id: "esc", label: "Esc", ariaLabel: "Escape", kind: "key", bytes: KEYS.Esc },
  { id: "tab", label: "Tab", ariaLabel: "Табуляция", kind: "key", bytes: KEYS.Tab },
  { id: "ctrl", label: "Ctrl", ariaLabel: "Контрол", kind: "modifier", modifier: "ctrl" },
  { id: "alt", label: "Alt", ariaLabel: "Альт", kind: "modifier", modifier: "alt" },
  { id: "up", label: "↑", ariaLabel: "Стрелка вверх", kind: "key", arrow: "up", autoRepeat: true },
  { id: "down", label: "↓", ariaLabel: "Стрелка вниз", kind: "key", arrow: "down", autoRepeat: true },
  { id: "left", label: "←", ariaLabel: "Стрелка влево", kind: "key", arrow: "left", autoRepeat: true },
  { id: "right", label: "→", ariaLabel: "Стрелка вправо", kind: "key", arrow: "right", autoRepeat: true },
  { id: "ctrlC", label: "^C", ariaLabel: "Ctrl C", kind: "key", bytes: KEYS.CtrlC },
  { id: "ctrlD", label: "^D", ariaLabel: "Ctrl D", kind: "key", bytes: KEYS.CtrlD },
  { id: "ctrlL", label: "^L", ariaLabel: "Ctrl L", kind: "key", bytes: KEYS.CtrlL },
  { id: "ctrlR", label: "^R", ariaLabel: "Ctrl R", kind: "key", bytes: KEYS.CtrlR, autoRepeat: true },
  { id: "shiftTab", label: "⇧Tab", ariaLabel: "Shift Tab", kind: "key", bytes: KEYS.ShiftTab },
  { id: "more", label: "⋯", ariaLabel: "Альтернативная страница курсора", kind: "page" },
] as const;

/**
 * Alternate "cursor block" page — swaps in for arrows when user taps More.
 * Per `05 §4 Group C note`. Same DOM positions as up/down/left/right.
 */
export const CURSOR_BLOCK_LIST: readonly ModifierKeyDescriptor[] = [
  { id: "home", label: "Home", ariaLabel: "Home", kind: "key", bytes: KEYS.Home },
  { id: "end", label: "End", ariaLabel: "End", kind: "key", bytes: KEYS.End },
  { id: "pgUp", label: "PgUp", ariaLabel: "Page Up", kind: "key", bytes: KEYS.PgUp, autoRepeat: true },
  { id: "pgDn", label: "PgDn", ariaLabel: "Page Down", kind: "key", bytes: KEYS.PgDn, autoRepeat: true },
] as const;

/**
 * DECCKM-aware arrow byte map.
 *
 * Per `05-decision-mobile.md §4 Group A` and `02-scan-terminal.md §4.2`:
 *   - Normal mode (DECCKM off):     `\x1b[A` `\x1b[B` `\x1b[D` `\x1b[C`
 *   - Application cursor (DECCKM):  `\x1bOA` `\x1bOB` `\x1bOD` `\x1bOC`
 *
 * vim, claude code, tmux all flip DECCKM via `\x1b[?1h` / `\x1b[?1l`.
 * xterm tracks this via `term.modes.applicationCursorKeysMode`
 * (`xterm.d.ts:1911`); read at click-time, never cached at render-time
 * because the mode changes when the active TUI activates app cursor mode.
 */
export function arrowBytes(dir: ArrowDirection, deccm: boolean): string {
  const intro = deccm ? "\x1bO" : "\x1b[";
  const tail = dir === "up" ? "A" : dir === "down" ? "B" : dir === "left" ? "D" : "C";
  return intro + tail;
}

/**
 * Map an ASCII letter `a..z` / `A..Z` to its Ctrl-coded byte.
 * Per `05 §4 Modifier composition` and POSIX caret notation.
 *
 * `ctrlOf("a")` → `\x01`. `ctrlOf("z")` → `\x1A`. Out-of-range input is
 * returned unchanged (no chord exists).
 */
export function ctrlOf(letter: string): string {
  if (letter.length !== 1) return letter;
  const c = letter.charCodeAt(0);
  // a..z → 0x61..0x7A; A..Z → 0x41..0x5A. Map to 0x01..0x1A.
  if (c >= 0x61 && c <= 0x7a) return String.fromCharCode(c - 0x60);
  if (c >= 0x41 && c <= 0x5a) return String.fromCharCode(c - 0x40);
  return letter;
}

/**
 * Esc-prefix any printable character per xterm's `metaSendsEscape=true`
 * convention (`03-research-xterm-proxy.md §6.1`).
 *
 * `altOf("b")` → `\x1bb`. `altOf(".")` → `\x1b.`.
 */
export function altOf(char: string): string {
  return "\x1b" + char;
}

/**
 * Apply armed Ctrl/Alt modifiers to the user's typed input.
 *
 * Per `05-decision-mobile.md §4 Modifier composition`:
 *   - For multi-character input (paste, IME composition, voice dictation):
 *     modifiers apply ONLY to the first character; the rest is appended
 *     unchanged. This matches Blink's behavior and avoids garbled output
 *     when the user dictates a phrase while Ctrl is locked.
 *   - For single-character input: Ctrl-letter chords are computed via
 *     `ctrlOf`; Alt prepends `\x1b`. Out-of-range Ctrl combos drop the
 *     modifier silently (no chord exists for `Ctrl + 1`).
 *   - Ctrl + Alt + a → `\x1b\x01` (Alt wraps the result of Ctrl).
 */
export function applyArmedModifiers(input: string, ctrl: boolean, alt: boolean): string {
  if (!input) return input;
  if (!ctrl && !alt) return input;

  const first = input[0];
  const rest = input.slice(1);

  let head = first;
  if (ctrl) {
    if (/^[a-zA-Z]$/.test(first)) {
      head = ctrlOf(first);
    }
    // Else: leave the character unchanged — no Ctrl-chord exists for
    // digits/punctuation in the standard PTY contract.
  }
  if (alt) {
    head = altOf(head);
  }

  return head + rest;
}
