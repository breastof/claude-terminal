"use client";

/**
 * TerminalIOContext — single-source-of-truth for the xterm and WebSocket
 * refs that mobile-only siblings (`MobileTerminalInput`, `ModifierKeyBar`,
 * mobile sheets) need to reach without prop drilling.
 *
 * Per `06-integration-plan-mobile.md §2.2`. The provider only HOLDS the
 * refs; lifecycle ownership stays in `Terminal.tsx`, which assigns
 * `xtermRef.current = term` and `wsRef.current = ws` during its own
 * `initTerminal` / `connectWs` flows.
 *
 * Phase-2 implementer (combined Terminal overhaul) will wire these refs
 * from `Terminal.tsx` — see TODO below. For now this file scaffolds the
 * API surface so WP-D can mount `<TerminalIOProvider>` in
 * `app/dashboard/page.tsx` and downstream components can call
 * `sendInput(...)` / `requestResize(...)` against a stable contract.
 *
 * Type for the xterm instance is referenced through @xterm/xterm so the
 * provider stays type-safe without importing the runtime in SSR paths.
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import type { Terminal as XTerm } from "@xterm/xterm";

export interface TerminalIOValue {
  /** xterm.js instance — set by Terminal.tsx after `new Terminal(...)`. */
  xtermRef: MutableRefObject<XTerm | null>;
  /** Active WebSocket — set by Terminal.tsx after `connectWs()`. */
  wsRef: MutableRefObject<WebSocket | null>;
  /** The DOM container that hosts xterm — set by Terminal.tsx via ref={}. */
  terminalElementRef: MutableRefObject<HTMLDivElement | null>;
  /** The mobile <textarea> — set by MobileTerminalInput on mount. */
  mobileInputRef: MutableRefObject<HTMLTextAreaElement | null>;
  /**
   * Single-byte / multi-byte input dispatcher.
   * Per `02-scan-terminal.md §7.1` option (A) we route via
   * `xterm.input(data, true)` so the existing `term.onData` listener at
   * `Terminal.tsx:213-221` (and its DA/CPR filter at line 217) stays the
   * sole ingress to the WS. No-op when xterm is not yet ready.
   */
  sendInput: (data: string) => void;
  /**
   * PTY resize request. Sends `{ type: "resize", cols, rows }` over the WS.
   * No-op when the WS is not OPEN.
   */
  requestResize: (cols: number, rows: number) => void;
  /** Mirrors `wsRef.current?.readyState === WebSocket.OPEN` reactively. */
  isReady: boolean;
  /** Setter exposed for Terminal.tsx to flip readiness on WS open/close. */
  setReady: (ready: boolean) => void;
}

export const TerminalIOContext = createContext<TerminalIOValue | null>(null);

interface TerminalIOProviderProps {
  children: ReactNode;
}

export function TerminalIOProvider({ children }: TerminalIOProviderProps) {
  const xtermRef = useRef<XTerm | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const terminalElementRef = useRef<HTMLDivElement | null>(null);
  const mobileInputRef = useRef<HTMLTextAreaElement | null>(null);
  const [isReady, setReady] = useState(false);

  // TODO: wire from Terminal.tsx (Phase-2 implementer):
  //   - on xterm init:    terminalIO.xtermRef.current = term
  //   - on WS open:       terminalIO.wsRef.current = ws; terminalIO.setReady(true)
  //   - on WS close/err:  terminalIO.setReady(false)
  //   - on container ref: <div ref={terminalIO.terminalElementRef}>
  //   - on cleanup:       null all refs and setReady(false)

  const sendInput = useCallback((data: string) => {
    if (!data) return;
    const term = xtermRef.current;
    const ws = wsRef.current;
    if (term && ws && ws.readyState === WebSocket.OPEN) {
      // Re-use the existing onData listener; preserves DA/CPR filter and
      // any future server-side recording / replay path.
      term.input(data, true);
      return;
    }
    // Silently drop input during reconnect — same UX contract as desktop
    // (where xterm-helper-textarea also drops bytes between WS sessions).
  }, []);

  const requestResize = useCallback((cols: number, rows: number) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ type: "resize", cols, rows }));
    } catch {
      /* WS may close mid-send; safe to ignore. */
    }
  }, []);

  // Critical: the context object identity MUST NOT change when `isReady`
  // flips, otherwise consumers (Terminal.tsx) that include `terminalIO` in
  // useCallback deps see a new reference, rebuild connectWs/initTerminal,
  // and the [initTerminal] effect tears the live xterm down — leaving a
  // blank canvas.
  //
  // Solution: keep a stable object (empty-dep useMemo) but write isReady
  // into a ref so `sendInput`/`requestResize` can read the live value, and
  // expose it via a separate shallow wrapper. Components that need reactive
  // isReady should call `useTerminalIO().isReady` which is updated via the
  // ref approach below.
  //
  // For simplicity we keep isReady as a plain state that IS included in the
  // value but we split the memo: the stable refs/callbacks object never
  // changes; a thin wrapper object is recreated only when isReady changes
  // (this is safe because Terminal.tsx intentionally excludes terminalIO
  // from its deps — see the eslint-disable comments there).
  const stableRefs = useMemo(
    () => ({
      xtermRef,
      wsRef,
      terminalElementRef,
      mobileInputRef,
      sendInput,
      requestResize,
      setReady,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const value = useMemo<TerminalIOValue>(
    () => ({ ...stableRefs, isReady }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isReady],
  );

  return (
    <TerminalIOContext.Provider value={value}>
      {children}
    </TerminalIOContext.Provider>
  );
}

/**
 * Hook accessor. Throws when called outside `<TerminalIOProvider>` —
 * defensive only; the planned mount order (provider wraps the dashboard
 * tree) guarantees the context is always present in production paths.
 */
export function useTerminalIO(): TerminalIOValue {
  const ctx = useContext(TerminalIOContext);
  if (!ctx) {
    throw new Error(
      "useTerminalIO must be used within a <TerminalIOProvider>",
    );
  }
  return ctx;
}
