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
  const vvHeight = vv?.height ?? innerHeight;
  const offsetTop = vv?.offsetTop ?? 0;
  const keyboardHeight = Math.max(0, innerHeight - vvHeight - offsetTop);
  const isKeyboardOpen = keyboardHeight > 150;
  // ALWAYS use visualViewport.height as the source of truth for body sizing.
  // On iOS Safari (bottom URL bar mode) `innerHeight` keeps reporting the
  // FULL layout viewport even with the keyboard open, so body sized to
  // innerHeight extends behind keyboard/URL bar — and the user can pan the
  // visual viewport over it ("вся страница скроллится"). Pinning body to
  // vv.height + vv.offsetTop guarantees body == visible area, with nothing
  // for iOS to pan into.
  const height = vvHeight;
  return {
    height,
    offsetTop,
    keyboardHeight,
    isKeyboardOpen,
  };
}

function writeCssVars(state: VisualViewportState): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement.style;
  root.setProperty("--vvh", `${state.height}px`);
  root.setProperty("--kbd-height", `${state.keyboardHeight}px`);
  root.setProperty("--vv-offset-top", `${state.offsetTop}px`);
  // Also write body inline styles directly. Belt-and-braces: the CSS var path
  // sometimes lags on iOS Safari (var update fires AFTER paint), and an inline
  // height on body forces the layout to settle inside vv.area without waiting
  // for var resolution. This is the difference between body.height = vv.height
  // exactly vs body sometimes overflowing into the area behind the keyboard.
  if (document.body) {
    document.body.style.height = `${state.height}px`;
    document.body.style.top = `${state.offsetTop}px`;
  }
}

export function useVisualViewport(): VisualViewportState {
  // Initialize eagerly from the live viewport so --vvh is correct on the
  // very first render (no 0→realHeight flash on hydration). Also write CSS
  // vars immediately so containers using var(--vvh) don't flash to 100dvh
  // fallback then jump to the real value.
  const [state, setState] = useState<VisualViewportState>(() => {
    if (typeof window === "undefined") return DEFAULT_STATE;
    const initial = readState();
    writeCssVars(initial);
    return initial;
  });

  useEffect(() => {
    if (typeof window === "undefined") return;

    const update = () => {
      const next = readState();
      writeCssVars(next);
      setState(next);
      // Defeat iOS Safari auto-scroll-on-focus: when keyboard opens, Safari
      // sometimes pans the visual viewport over the (still-tall) layout
      // viewport, which the user perceives as "вся страница скроллится".
      // Body is already pinned by the writeCssVars above; reset any scroll
      // the browser may have queued before we finish painting.
      try {
        if (window.scrollY !== 0 || window.scrollX !== 0) {
          window.scrollTo(0, 0);
        }
        if (document.documentElement.scrollTop !== 0) {
          document.documentElement.scrollTop = 0;
        }
        if (document.body && document.body.scrollTop !== 0) {
          document.body.scrollTop = 0;
        }
      } catch { /* defensive */ }
    };

    // Seed once on mount (covers SSR hydration).
    update();

    const vv = window.visualViewport;
    // Also listen to plain `window.resize`. visualViewport doesn't fire on
    // every browser-window resize (notably DevTools mobile→desktop swap),
    // and we MUST update `--vvh` then or layouts pinned to `var(--vvh)`
    // keep an old shrunken value from the mobile viewport.
    window.addEventListener("resize", update);

    if (vv) {
      vv.addEventListener("resize", update);
      vv.addEventListener("scroll", update);
      return () => {
        vv.removeEventListener("resize", update);
        vv.removeEventListener("scroll", update);
        window.removeEventListener("resize", update);
        // Intentionally do NOT clear CSS vars on unmount — other consumers
        // may still rely on them, and the values are valid until the next
        // hook mount overwrites them.
      };
    }

    return () => {
      window.removeEventListener("resize", update);
    };
  }, []);

  return state;
}
