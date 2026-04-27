"use client";

/**
 * useModifierState — Zustand-backed sticky modifier state for the mobile
 * modifier bar. Per `06-integration-plan-mobile.md §2.7` and
 * `05-decision-mobile.md §4`.
 *
 * Behavior (Blink semantics from §2.3):
 *   - `armCtrl()`     : sets `ctrl: true`. Tap a letter → letter is
 *                       Ctrl-chorded then ctrl auto-disarms (unless locked).
 *   - `lockCtrl()`    : sets `ctrlLocked: true, ctrl: true`. Stays armed
 *                       across keystrokes until `unlockCtrl()`.
 *   - `unlockCtrl()`  : releases the lock + the arm.
 *   - Same for Alt.
 *   - `consumeModifiers()` : snapshots `{ctrl, alt}`, clears the unlocked
 *                       arms, returns the snapshot. Called by
 *                       MobileTerminalInput right before forwarding bytes.
 *
 * Why Zustand over React context: avoids re-rendering the entire subtree
 * on every modifier tap (per `06 §2.7` rationale).
 */
import { create } from "zustand";

interface ModifierStoreState {
  ctrl: boolean;
  alt: boolean;
  ctrlLocked: boolean;
  altLocked: boolean;
  armCtrl: () => void;
  armAlt: () => void;
  lockCtrl: () => void;
  lockAlt: () => void;
  unlockCtrl: () => void;
  unlockAlt: () => void;
  consumeModifiers: () => { ctrl: boolean; alt: boolean };
}

export const useModifierStore = create<ModifierStoreState>((set, get) => ({
  ctrl: false,
  alt: false,
  ctrlLocked: false,
  altLocked: false,
  armCtrl: () => set({ ctrl: true }),
  armAlt: () => set({ alt: true }),
  lockCtrl: () => set({ ctrlLocked: true, ctrl: true }),
  lockAlt: () => set({ altLocked: true, alt: true }),
  unlockCtrl: () => set({ ctrlLocked: false, ctrl: false }),
  unlockAlt: () => set({ altLocked: false, alt: false }),
  consumeModifiers: () => {
    const { ctrl, alt, ctrlLocked, altLocked } = get();
    const snapshot = { ctrl, alt };
    set({
      ctrl: ctrlLocked ? true : false,
      alt: altLocked ? true : false,
    });
    return snapshot;
  },
}));

export interface ModifierState {
  ctrl: boolean;
  alt: boolean;
  ctrlLocked: boolean;
  altLocked: boolean;
  armCtrl: () => void;
  armAlt: () => void;
  lockCtrl: () => void;
  lockAlt: () => void;
  unlockCtrl: () => void;
  unlockAlt: () => void;
  consumeModifiers: () => { ctrl: boolean; alt: boolean };
}

/**
 * Convenience hook that subscribes to the full modifier state. Consumers
 * that only need ONE field (e.g. just `ctrl`) should use the store
 * selectors directly via `useModifierStore(s => s.ctrl)` to minimise
 * re-renders.
 */
export function useModifierState(): ModifierState {
  return useModifierStore();
}
