"use client";

/**
 * composerStore — tracks whether MobileComposer textarea has focus.
 *
 * Used by MobileBottomBar to hide itself when the composer is focused,
 * giving the composer maximum vertical space (Telegram/WhatsApp pattern).
 * Separate from overlayStore to avoid touching the mutex (composer focus
 * is not an exclusive overlay — it coexists with the terminal being visible).
 */
import { create } from "zustand";

interface ComposerStore {
  focused: boolean;
  setFocused: (v: boolean) => void;
}

export const useComposerStore = create<ComposerStore>((set) => ({
  focused: false,
  setFocused: (v) => set({ focused: v }),
}));
