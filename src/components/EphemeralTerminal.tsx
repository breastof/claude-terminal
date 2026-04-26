"use client";

import { useEffect, useRef, useCallback } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useTheme } from "@/lib/ThemeContext";
import { themeConfigs } from "@/lib/theme-config";

interface EphemeralTerminalProps {
  ephemeralId: string;
}

const RESIZE_DEBOUNCE_MS = 80;

export default function EphemeralTerminal({ ephemeralId }: EphemeralTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const initRef = useRef(false);
  const { theme } = useTheme();
  const themeRef = useRef(theme);
  themeRef.current = theme;

  const connect = useCallback(async () => {
    if (!containerRef.current || !ephemeralId) return;

    const tokenRes = await fetch("/api/auth/ws-token");
    if (!tokenRes.ok) return;
    const { token } = await tokenRes.json();

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'Geist Mono', 'JetBrains Mono', 'Fira Code', monospace",
      theme: themeConfigs[themeRef.current].terminal,
      scrollback: 1000,
      rows: 10,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => fitAddon.fit());
    });

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/api/terminal?sessionId=${encodeURIComponent(ephemeralId)}&token=${encodeURIComponent(token)}&ephemeral=true`;
    const ws = new WebSocket(wsUrl);

    ws.onmessage = (event) => {
      let msg: { type?: string; data?: string; message?: string };
      try {
        msg = JSON.parse(event.data as string);
      } catch {
        console.warn("[ephemeral] non-JSON text frame received");
        return;
      }
      switch (msg.type) {
        case "output":
          if (typeof msg.data === "string") term.write(msg.data);
          return;
        case "exit":
          term.write("\r\n\x1b[90m--- Сессия завершена ---\x1b[0m\r\n");
          return;
        case "error":
          if (typeof msg.message === "string") {
            term.write(`\r\n\x1b[31m${msg.message}\x1b[0m\r\n`);
          }
          return;
        default:
          console.warn("[ephemeral] unknown message type:", msg.type);
      }
    };

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", data }));
      }
    });

    // Debounced resize per `06-integration-plan-tmux.md §4.5` — 80 ms
    // trailing-edge with local equality coalesce, mirroring Terminal.tsx.
    let lastSentCols = term.cols;
    let lastSentRows = term.rows;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;

    const doResize = () => {
      try {
        fitAddon.fit();
      } catch {
        /* container may have zero size mid-transition; ignore */
      }
      if (ws.readyState === WebSocket.OPEN) {
        if (term.cols !== lastSentCols || term.rows !== lastSentRows) {
          lastSentCols = term.cols;
          lastSentRows = term.rows;
          ws.send(
            JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }),
          );
        }
      }
    };

    const onResizeTrigger = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(doResize, RESIZE_DEBOUNCE_MS);
    };

    const resizeObserver = new ResizeObserver(onResizeTrigger);
    if (containerRef.current) resizeObserver.observe(containerRef.current);

    // Per `06-integration-plan-mobile.md §3.12`: also listen on
    // visualViewport so iOS keyboard show/hide refits the ephemeral
    // canvas (auth-wizard embed; rare but consistent).
    let vvAttached = false;
    if (typeof window !== "undefined" && window.visualViewport) {
      window.visualViewport.addEventListener("resize", onResizeTrigger);
      window.visualViewport.addEventListener("scroll", onResizeTrigger);
      vvAttached = true;
    }

    return () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      if (vvAttached && window.visualViewport) {
        window.visualViewport.removeEventListener("resize", onResizeTrigger);
        window.visualViewport.removeEventListener("scroll", onResizeTrigger);
      }
      resizeObserver.disconnect();
      ws.close();
      term.dispose();
    };
  }, [ephemeralId]);

  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    let cleanup: (() => void) | undefined;
    connect().then((fn) => { cleanup = fn; });

    return () => {
      initRef.current = false;
      cleanup?.();
    };
  }, [connect]);

  // Cleanup ephemeral session on unmount
  useEffect(() => {
    return () => {
      if (ephemeralId) {
        fetch("/api/ephemeral", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: ephemeralId }),
        }).catch(() => {});
      }
    };
  }, [ephemeralId]);

  return (
    <div
      ref={containerRef}
      className="w-full rounded-lg overflow-hidden border border-border"
      style={{ height: 200, backgroundColor: themeConfigs[theme].terminal.background }}
    />
  );
}
