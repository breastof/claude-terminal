"use client";

/**
 * ModifierKeyBar — inline 14-button modifier toolbar embedded inside
 * MobileComposer. Per `06-integration-plan-mobile.md §2.6` and the
 * frozen 14-key list in `05-decision-mobile.md §4`.
 *
 * Behavior (Blink semantics from `05 §2.3`):
 *   - Tap = one-shot. Modifier keys (Ctrl/Alt) arm the next-character
 *     chord; non-modifier keys ship their bytes immediately.
 *   - Long-press (≥300 ms) on a modifier = lock until next tap on it.
 *   - Hold (≥500 ms) on a non-modifier auto-repeat key (arrows, ^R,
 *     PgUp/PgDn) = initial fire then 100 ms interval until pointerup /
 *     pointercancel / pointerleave (the latter is critical per `05 §10
 *     risk 9` to prevent timer leakage when user drags off the button).
 *   - The "More" button toggles the arrow group (5..8) with Home/End/
 *     PgUp/PgDn in-place per the Blink "alternate cursor page" pattern.
 *
 * Arrow encoding respects DECCKM at click-time (NOT render-time) per
 * `05 §4 Group A` and `06 §2.6`: vim/claude/tmux flip
 * `term.modes.applicationCursorKeysMode` dynamically.
 *
 * Position: rendered in-flow inside MobileComposer — no fixed
 * positioning, no z-index overlap. Visible only when keyboard is open
 * (controlled by parent via `visible` prop).
 *
 * Accessibility:
 *   - `role="toolbar" aria-label="Модификаторы клавиатуры"` on outer.
 *   - Each button: `role="button"` (default) + Russian `aria-label`.
 *   - Modifier buttons additionally expose `aria-pressed={armed}`.
 */
import {
  useCallback,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTerminalIO } from "@/lib/TerminalIOContext";
import { useModifierStore } from "@/lib/useModifierState";
import {
  arrowBytes,
  CURSOR_BLOCK_LIST,
  MODIFIER_KEY_LIST,
  type ModifierKeyDescriptor,
} from "@/lib/mobile-input";

export interface ModifierKeyBarProps {
  /** When false the bar renders null (keyboard is closed). */
  visible: boolean;
}

const LONG_PRESS_MS = 300;
const REPEAT_INITIAL_MS = 500;
const REPEAT_INTERVAL_MS = 100;

export default function ModifierKeyBar({ visible }: ModifierKeyBarProps) {
  const terminalIO = useTerminalIO();
  const ctrl = useModifierStore((s) => s.ctrl);
  const alt = useModifierStore((s) => s.alt);
  const ctrlLocked = useModifierStore((s) => s.ctrlLocked);
  const altLocked = useModifierStore((s) => s.altLocked);
  const armCtrl = useModifierStore((s) => s.armCtrl);
  const armAlt = useModifierStore((s) => s.armAlt);
  const lockCtrl = useModifierStore((s) => s.lockCtrl);
  const lockAlt = useModifierStore((s) => s.lockAlt);
  const unlockCtrl = useModifierStore((s) => s.unlockCtrl);
  const unlockAlt = useModifierStore((s) => s.unlockAlt);

  const [cursorPage, setCursorPage] = useState<"arrows" | "block">("arrows");

  // Per-button timer refs. Keyed by descriptor.id so concurrent touches
  // (multi-finger) don't clobber each other.
  const longPressTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const repeatInitialTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const repeatIntervalTimers = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());
  const lockFiredRef = useRef<Map<string, boolean>>(new Map());
  const pressStartRef = useRef<Map<string, number>>(new Map());

  /**
   * Resolve the byte sequence for a key at click-time. Arrows read
   * DECCKM mode from xterm right now (NOT cached); other keys return
   * their static bytes from the descriptor.
   */
  const getBytes = useCallback(
    (key: ModifierKeyDescriptor): string | null => {
      if (key.kind !== "key") return null;
      if (key.arrow) {
        const term = terminalIO.xtermRef.current;
        const deccm = term?.modes.applicationCursorKeysMode === true;
        return arrowBytes(key.arrow, deccm);
      }
      return key.bytes ?? null;
    },
    [terminalIO],
  );

  const fireKey = useCallback(
    (key: ModifierKeyDescriptor) => {
      const bytes = getBytes(key);
      if (bytes === null) return;
      terminalIO.sendInput(bytes);
    },
    [getBytes, terminalIO],
  );

  const clearTimers = useCallback((id: string) => {
    const lp = longPressTimers.current.get(id);
    if (lp) {
      clearTimeout(lp);
      longPressTimers.current.delete(id);
    }
    const ri = repeatInitialTimers.current.get(id);
    if (ri) {
      clearTimeout(ri);
      repeatInitialTimers.current.delete(id);
    }
    const rp = repeatIntervalTimers.current.get(id);
    if (rp) {
      clearInterval(rp);
      repeatIntervalTimers.current.delete(id);
    }
  }, []);

  const handlePointerDown = useCallback(
    (key: ModifierKeyDescriptor, e: ReactPointerEvent<HTMLButtonElement>) => {
      // Capture the pointer so pointerup fires on this element even if
      // the user drags off — necessary for reliable timer cleanup.
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* some browsers throw on touch-action: none mismatches; ignore */
      }
      pressStartRef.current.set(key.id, Date.now());
      lockFiredRef.current.set(key.id, false);

      // Modifier long-press → lock
      if (key.kind === "modifier") {
        const lp = setTimeout(() => {
          if (key.modifier === "ctrl") {
            if (ctrlLocked) unlockCtrl();
            else lockCtrl();
          } else if (key.modifier === "alt") {
            if (altLocked) unlockAlt();
            else lockAlt();
          }
          lockFiredRef.current.set(key.id, true);
        }, LONG_PRESS_MS);
        longPressTimers.current.set(key.id, lp);
        return;
      }

      // Auto-repeat key → fire initial, schedule interval
      if (key.kind === "key" && key.autoRepeat) {
        // First fire happens on pointerdown immediately so the user gets
        // instant feedback; subsequent repeats start after REPEAT_INITIAL_MS.
        fireKey(key);
        const ri = setTimeout(() => {
          const rp = setInterval(() => {
            fireKey(key);
          }, REPEAT_INTERVAL_MS);
          repeatIntervalTimers.current.set(key.id, rp);
        }, REPEAT_INITIAL_MS);
        repeatInitialTimers.current.set(key.id, ri);
        return;
      }
    },
    [ctrlLocked, altLocked, fireKey, lockCtrl, lockAlt, unlockCtrl, unlockAlt],
  );

  const handlePointerUp = useCallback(
    (key: ModifierKeyDescriptor) => {
      const start = pressStartRef.current.get(key.id) ?? Date.now();
      const heldMs = Date.now() - start;
      const lockFired = lockFiredRef.current.get(key.id) ?? false;
      clearTimers(key.id);
      pressStartRef.current.delete(key.id);

      if (key.kind === "page") {
        setCursorPage((prev) => (prev === "arrows" ? "block" : "arrows"));
        return;
      }

      if (key.kind === "modifier") {
        // Tap (no lock fired) → arm one-shot. If already armed, tapping
        // again is a no-op (consumeModifiers handles disarm). Long-press
        // already fired the lock toggle in pointerdown.
        if (!lockFired && heldMs < LONG_PRESS_MS) {
          if (key.modifier === "ctrl") {
            if (ctrl) {
              // Already armed → second tap unlocks if locked, otherwise
              // disarms. Simplification: just unlock (which also disarms).
              unlockCtrl();
            } else {
              armCtrl();
            }
          } else if (key.modifier === "alt") {
            if (alt) {
              unlockAlt();
            } else {
              armAlt();
            }
          }
        }
        return;
      }

      // Non-modifier, non-auto-repeat → fire on pointerup (release).
      // Auto-repeat keys already fired on pointerdown; do NOT re-fire here.
      if (key.kind === "key" && !key.autoRepeat) {
        fireKey(key);
      }
    },
    [armCtrl, armAlt, ctrl, alt, clearTimers, fireKey, unlockCtrl, unlockAlt],
  );

  const handlePointerCancel = useCallback(
    (key: ModifierKeyDescriptor) => {
      clearTimers(key.id);
      pressStartRef.current.delete(key.id);
    },
    [clearTimers],
  );

  if (!visible) return null;

  // Resolve visible key list based on cursor-page toggle. The arrow
  // group (ids up/down/left/right) is replaced by CURSOR_BLOCK_LIST when
  // page === "block". Layout positions are preserved (same indices).
  const visibleKeys: ModifierKeyDescriptor[] =
    cursorPage === "arrows"
      ? [...MODIFIER_KEY_LIST]
      : MODIFIER_KEY_LIST.map((k) => {
          if (k.id === "up") return CURSOR_BLOCK_LIST[0];
          if (k.id === "down") return CURSOR_BLOCK_LIST[1];
          if (k.id === "left") return CURSOR_BLOCK_LIST[2];
          if (k.id === "right") return CURSOR_BLOCK_LIST[3];
          return k;
        });

  return (
    <div
      role="toolbar"
      aria-label="Модификаторы клавиатуры"
      className="bg-surface border-t border-border flex items-stretch gap-0.5 sm:gap-1 px-0.5 sm:px-1 h-9 overflow-x-auto flex-shrink-0"
      style={{
        // Allow horizontal scroll, prevent pull-to-refresh / vertical
        // gesture conflicts (`05 §2.7`).
        touchAction: "pan-x",
        // Hide scrollbar on iOS / Android per design — fallback uses
        // -webkit-scrollbar in globals.css if needed.
        scrollbarWidth: "none",
      }}
    >
      {visibleKeys.map((key) => {
        const isCtrlBtn = key.kind === "modifier" && key.modifier === "ctrl";
        const isAltBtn = key.kind === "modifier" && key.modifier === "alt";
        const armed =
          (isCtrlBtn && ctrl) || (isAltBtn && alt);
        const locked =
          (isCtrlBtn && ctrlLocked) || (isAltBtn && altLocked);
        return (
          <button
            key={key.id}
            type="button"
            aria-label={key.ariaLabel}
            aria-pressed={key.kind === "modifier" ? armed : undefined}
            onPointerDown={(e) => handlePointerDown(key, e)}
            onPointerUp={() => handlePointerUp(key)}
            onPointerCancel={() => handlePointerCancel(key)}
            onPointerLeave={() => handlePointerCancel(key)}
            // Suppress synthesized click → we already handled pointer
            // events; the click handler running again would double-fire
            // on browsers that emit click after pointerup.
            onClick={(e) => e.preventDefault()}
            className={
              "min-w-[32px] xs:min-w-[40px] h-9 px-1 xs:px-1.5 flex items-center justify-center font-mono text-xs select-none rounded transition-colors " +
              (armed || locked
                ? "bg-accent/30 text-foreground "
                : "bg-surface-alt text-foreground hover:bg-surface-alt/80 ") +
              (locked ? "ring-1 ring-accent" : "")
            }
            style={{
              // Prevent the OS from interpreting touches as scrolls/zoom.
              touchAction: "manipulation",
              WebkitUserSelect: "none",
              userSelect: "none",
            }}
          >
            {key.label}
            {locked && (
              <span className="ml-0.5 text-[8px] opacity-70" aria-hidden="true">
                •
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
