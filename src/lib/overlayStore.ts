"use client";

/**
 * overlayStore — exclusive (mutex) overlay coordinator.
 *
 * API surface frozen per `06-integration-plan-mobile.md §2.3` so that
 * WP-B / WP-C / WP-D can implement against the same contract in
 * parallel. Opening any non-"none" slot auto-closes whatever was open
 * before — fixing the chat ↔ admin double-overlay bug at
 * `dashboard/page.tsx:494-521` (`02-scan-navigation.md §5.1`).
 *
 * Mid-transition flicker mitigation per `05-decision-mobile.md §10
 * risk 10`: setter is synchronous; vaul/Radix consumers read the boolean
 * directly via the controlled `open` prop and animate naturally.
 *
 * Compatibility shim: also exports `openOverlay(name)` / `closeOverlay()`
 * and a short `OverlayName` (without `"none"`) so newer code can use the
 * shorter idiom without re-implementing mutex semantics.
 */
import { create } from "zustand";

/**
 * Long-form slots — frozen per `06-integration-plan-mobile.md §2.3`.
 * These are the canonical names the integration plan binds. WP-B/D
 * code (`MobileBottomBar`, `MobileMoreSheet`, `IconRail`, etc.) consumes
 * these names directly.
 */
type CanonicalSlot =
  | "none"
  | "sessionsSheet"
  | "chatSheet"
  | "filesSheet"
  | "historySheet"
  | "adminSheet"
  | "moreDrawer"
  | "hotkeysModal"
  | "commandPalette"
  | "providerWizard"
  | "providerConfig"
  | "imageLightbox";

/**
 * Short-form aliases — matches the prompt's WP-A spec
 * (`'sessions' | 'chat' | 'files' | 'admin' | 'hotkeys'`) plus the few
 * extras some early WP-D scaffolds picked up (`palette`, `more`,
 * `lightbox`). Kept as a compatibility surface so existing WP-D files
 * (`CommandPalette.tsx`, an older `MobileSessionsSheet.tsx`) typecheck
 * without forcing a same-PR refactor of code outside this WP's owned
 * list.
 */
type ShortSlot =
  | "sessions"
  | "chat"
  | "files"
  | "history"
  | "admin"
  | "hotkeys"
  | "more"
  | "palette"
  | "lightbox";

export type OverlaySlot = CanonicalSlot | ShortSlot;

/** Same as `OverlaySlot` minus `"none"` — convenience for `openOverlay`. */
export type OverlayName = Exclude<OverlaySlot, "none">;

export interface OverlayStore {
  /** Currently-visible slot, or `"none"` when nothing is open. */
  activeOverlay: OverlaySlot;
  /**
   * Set `slot`; if `slot !== "none"` it auto-closes any other slot
   * (mutex). Pass `"none"` to clear.
   */
  setActiveOverlay: (slot: OverlaySlot) => void;
  /** Equivalent to `setActiveOverlay("none")`. */
  closeAll: () => void;
  /** Alias for `setActiveOverlay(name)`. */
  openOverlay: (name: OverlayName) => void;
  /** Alias for `closeAll()`. */
  closeOverlay: () => void;
}

export const useOverlayStore = create<OverlayStore>((set, get) => ({
  activeOverlay: "none",
  setActiveOverlay: (slot) => set({ activeOverlay: slot }),
  closeAll: () => set({ activeOverlay: "none" }),
  openOverlay: (name) => get().setActiveOverlay(name),
  closeOverlay: () => get().closeAll(),
}));

/**
 * Selector helper — returns `true` iff `slot` is the active overlay.
 * Reference-stable across renders that don't change the answer (Zustand
 * selectors short-circuit on Object.is equality).
 */
export function useOverlay(slot: OverlaySlot): boolean {
  return useOverlayStore((s) => s.activeOverlay === slot);
}

/** Convenience wrapper for code that prefers an "open"-style verb. */
export function openOverlay(name: OverlayName): void {
  useOverlayStore.getState().setActiveOverlay(name);
}

/** Convenience wrapper — same as `useOverlayStore.getState().closeAll()`. */
export function closeOverlay(): void {
  useOverlayStore.getState().closeAll();
}
