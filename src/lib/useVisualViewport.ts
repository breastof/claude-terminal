"use client";

/**
 * useVisualViewport — single source of truth for soft-keyboard-aware
 * viewport metrics on mobile. Per `06-integration-plan-mobile.md §2.1`.
 *
 * Side effect: writes three CSS variables to `document.documentElement.style`
 * on every `visualViewport.resize` and `visualViewport.scroll` event:
 *   - `--vvh`           — visualViewport.height in px
 *   - `--kbd-height`    — Math.max(0, innerHeight - vv.height - vv.offsetTop)
 *   - `--vv-offset-top` — visualViewport.offsetTop in px
 *
 * Returns the same state synchronously so consumers can also read it
 * imperatively (e.g. `MobileBottomBar` hides itself when keyboard opens).
 *
 * SSR-safe: returns deterministic defaults when window is undefined.
 *
 * Per `05-decision-mobile.md §12.8` we deliberately skip rAF batching —
 * `style.setProperty` is sub-microsecond and visualViewport events are
 * already throttled by the browser.
 */
import { useEffect, useState } from "react";

export interface VisualViewportState {
  /** window.visualViewport.height (px); falls back to window.innerHeight */
  height: number;
  /** window.visualViewport.offsetTop (px); falls back to 0 */
  offsetTop: number;
  /** Heuristic: keyboard occupies > 150 px of the layout viewport */
  isKeyboardOpen: boolean;
  /** Math.max(0, innerHeight - height - offsetTop) */
  keyboardHeight: number;
}

const DEFAULT_STATE: VisualViewportState = {
  height: 0,
  offsetTop: 0,
  isKeyboardOpen: false,
  keyboardHeight: 0,
};

function readState(): VisualViewportState {
  if (typeof window === "undefined") return DEFAULT_STATE;
  const vv = window.visualViewport;
  const innerHeight = window.innerHeight || 0;
  const height = vv?.height ?? innerHeight;
  const offsetTop = vv?.offsetTop ?? 0;
  const keyboardHeight = Math.max(0, innerHeight - height - offsetTop);
  return {
    height,
    offsetTop,
    keyboardHeight,
    isKeyboardOpen: keyboardHeight > 150,
  };
}

function writeCssVars(state: VisualViewportState): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement.style;
  root.setProperty("--vvh", `${state.height}px`);
  root.setProperty("--kbd-height", `${state.keyboardHeight}px`);
  root.setProperty("--vv-offset-top", `${state.offsetTop}px`);
}

export function useVisualViewport(): VisualViewportState {
  const [state, setState] = useState<VisualViewportState>(DEFAULT_STATE);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const update = () => {
      const next = readState();
      writeCssVars(next);
      setState(next);
    };

    // Seed once on mount (covers SSR hydration).
    update();

    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener("resize", update);
      vv.addEventListener("scroll", update);
      return () => {
        vv.removeEventListener("resize", update);
        vv.removeEventListener("scroll", update);
        // Intentionally do NOT clear CSS vars on unmount — other consumers
        // may still rely on them, and the values are valid until the next
        // hook mount overwrites them.
      };
    }

    // Fallback for browsers without visualViewport (very old Safari).
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
    };
  }, []);

  return state;
}
