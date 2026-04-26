"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { useTheme } from "@/lib/ThemeContext";
import { themeConfigs } from "@/lib/theme-config";
import { useTerminalScroll } from "@/lib/TerminalScrollContext";
import { useTerminalIO } from "@/lib/TerminalIOContext";
import { getOS } from "@/lib/useOS";

const MAX_AUTH_FAILURES = 10;

const RESIZE_DEBOUNCE_MS = 80;

interface TerminalProps {
  sessionId: string;
  fullscreen?: boolean;
  onConnectionChange?: (status: "connected" | "disconnected") => void;
}

/**
 * Default key event handler factory — exported so the mobile-input
 * code path can re-install the desktop handler when a tablet rotates
 * from portrait to landscape (per `05-decision-mobile.md §10 risk 4 /
 * §12.2`). xterm has no API to *remove* a custom handler, only to
 * *replace* it; this lets us swap back to the desktop logic without
 * losing the original.
 */
export function getDefaultKeyHandler(term: XTerm) {
  const isMac = getOS() === "mac";

  const copyText = (text: string) => {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(() => {});
    } else {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
  };

  return (e: KeyboardEvent): boolean => {
    if (e.type !== "keydown") return true;

    if (
      ((e.ctrlKey || e.metaKey) && e.code === "KeyV") ||
      (e.ctrlKey && e.shiftKey && e.code === "KeyV")
    ) {
      return false;
    }

    if (!isMac) {
      if (e.ctrlKey && e.shiftKey && e.code === "KeyC") {
        const sel = term.getSelection();
        if (sel) {
          e.preventDefault();
          copyText(sel);
          term.clearSelection();
        }
        return false;
      }

      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === "KeyC") {
        const sel = term.getSelection();
        if (sel) {
          e.preventDefault();
          copyText(sel);
          term.clearSelection();
          return false;
        }
        return true;
      }
    }

    return true;
  };
}

export default function Terminal({ sessionId, fullscreen, onConnectionChange }: TerminalProps) {
  // Local refs for lifecycle ownership. We ALSO mirror xtermRef/wsRef/
  // terminalElementRef into TerminalIOContext per `06-integration-plan-
  // mobile.md §2.2` so siblings (MobileTerminalInput, ModifierKeyBar,
  // mobile sheets) can reach them without prop drilling.
  const terminalIO = useTerminalIO();
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const initRef = useRef(false);
  const unmountedRef = useRef(false);
  const isConnectingRef = useRef(false);
  const isReconnectRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const authFailureCountRef = useRef(0);
  const dataDisposableRef = useRef<{ dispose: () => void } | null>(null);

  // 80 ms trailing-edge debounce on ResizeObserver → ws.send({type:"resize"}).
  const resizeDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [reconnecting, setReconnecting] = useState(false);
  const [authExpired, setAuthExpired] = useState(false);
  const { theme } = useTheme();
  const themeRef = useRef(theme);
  themeRef.current = theme;

  const { updateScroll, registerScrollFn } = useTerminalScroll();
  const updateScrollRef = useRef(updateScroll);
  updateScrollRef.current = updateScroll;
  const registerScrollFnRef = useRef(registerScrollFn);
  registerScrollFnRef.current = registerScrollFn;

  const onConnectionChangeRef = useRef(onConnectionChange);
  onConnectionChangeRef.current = onConnectionChange;

  // Update terminal theme when theme changes
  useEffect(() => {
    if (xtermRef.current) {
      xtermRef.current.options.theme = themeConfigs[theme].terminal;
    }
  }, [theme]);

  // Refit xterm when fullscreen changes
  useEffect(() => {
    if (!fitAddonRef.current || !xtermRef.current) return;
    const fitAddon = fitAddonRef.current;
    const term = xtermRef.current;

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        fitAddon.fit();
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "resize",
              cols: term.cols,
              rows: term.rows,
            })
          );
        }
        updateScrollRef.current({
          viewportY: term.buffer.active.viewportY,
          rows: term.rows,
          totalLines: term.buffer.active.length,
        });
      });
    });
  }, [fullscreen]);

  // Schedule reconnect with exponential backoff
  const scheduleReconnect = useCallback(() => {
    if (unmountedRef.current) return;
    setReconnecting(true);
    const attempt = reconnectAttemptRef.current++;
    const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
    reconnectTimerRef.current = setTimeout(() => {
      connectWs();
    }, delay);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Handle a server→client message. The server uses simple JSON envelopes:
   *   { type: "output", data: "..." }
   *   { type: "exit", exitCode, signal }
   *   { type: "stopped" }
   *   { type: "error", message }
   * The first "output" frame after attach is a tmuxSnapshot from
   * terminal-manager.js (full scrollback, prefixed with \x1b[2J\x1b[H,
   * suffixed with cursor restore). Subsequent "output" frames are live
   * deltas. We just write them to xterm in order.
   */
  const handleMessage = useCallback(
    (event: MessageEvent, term: XTerm, fitAddon: FitAddon) => {

      // Text branch — JSON envelopes per `06 §2.3`.
      let message: {
        type?: string;
        data?: string;
        seq?: string;
        from?: string;
        message?: string;
        cols?: number;
        rows?: number;
      };
      try {
        message = JSON.parse(event.data as string);
      } catch {
        // Per `06 §4.4` line "REMOVE the legacy raw-write fallback":
        // P11 (JSON-parse fallback writing arbitrary frames) is closed
        // by NOT writing arbitrary data into xterm. Warn and drop.
        console.warn("[terminal] non-JSON text frame received");
        return;
      }

      switch (message.type) {
        case "output":
          if (typeof message.data === "string") {
            term.write(message.data);
          }
          return;

        case "exit":
          term.write("\r\n\x1b[90m--- Сессия остановлена ---\x1b[0m\r\n");
          isReconnectRef.current = false;
          setReconnecting(false);
          return;

        case "stopped":
          term.write(
            "\x1b[90m--- Сессия остановлена. Нажмите \"Возобновить\" в боковой панели. ---\x1b[0m\r\n",
          );
          isReconnectRef.current = false;
          setReconnecting(false);
          return;

        case "error":
          if (typeof message.message === "string") {
            term.write(`\r\n\x1b[31m${message.message}\x1b[0m\r\n`);
          }
          return;

        default:
          console.warn("[terminal] unknown message type:", message.type);
      }
    },
    [],
  );

  // Connect/reconnect WebSocket (separate from terminal init)
  const connectWs = useCallback(async () => {
    const term = xtermRef.current;
    const fitAddon = fitAddonRef.current;
    if (!term || !fitAddon || !sessionId || unmountedRef.current) return;

    // Guard: prevent concurrent connectWs calls
    if (isConnectingRef.current) return;
    isConnectingRef.current = true;

    try {
      // Close any existing WebSocket before creating a new one
      if (wsRef.current) {
        const oldWs = wsRef.current;
        oldWs.onclose = null; // Prevent old onclose from triggering reconnect
        oldWs.onmessage = null;
        oldWs.onerror = null;
        if (oldWs.readyState === WebSocket.OPEN || oldWs.readyState === WebSocket.CONNECTING) {
          oldWs.close();
        }
        wsRef.current = null;
      }

      const tokenRes = await fetch("/api/auth/ws-token");
      if (!tokenRes.ok) {
        // Token fetch failed (likely auth expired)
        authFailureCountRef.current++;
        onConnectionChangeRef.current?.("disconnected");
        terminalIO.setReady(false);

        if (authFailureCountRef.current >= MAX_AUTH_FAILURES) {
          setAuthExpired(true);
          setReconnecting(false);
          return;
        }

        // Keep retrying — cookie might refresh from another tab
        scheduleReconnect();
        return;
      }

      // Auth succeeded, reset failure counter
      authFailureCountRef.current = 0;
      setAuthExpired(false);

      const { token } = await tokenRes.json();
      if (unmountedRef.current) return;

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${window.location.host}/api/terminal?sessionId=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(token)}`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      // Mirror into TerminalIOContext for mobile siblings.
      terminalIO.wsRef.current = ws;

      ws.onopen = () => {
        reconnectAttemptRef.current = 0;
        onConnectionChangeRef.current?.("connected");
        terminalIO.setReady(true);
        isReconnectRef.current = false;
        setReconnecting(false);

        // Send current terminal size so tmux pane matches client geometry.
        try {
          ws.send(
            JSON.stringify({
              type: "resize",
              cols: term.cols,
              rows: term.rows,
            }),
          );
        } catch {
          /* ignore */
        }
      };

      ws.onmessage = (event) => {
        handleMessage(event, term, fitAddon);
      };

      ws.onclose = (event) => {
        onConnectionChangeRef.current?.("disconnected");
        wsRef.current = null;
        terminalIO.wsRef.current = null;
        terminalIO.setReady(false);

        if (unmountedRef.current) return;
        if (event.code === 4401 || event.code === 4404) return;

        isReconnectRef.current = true;
        scheduleReconnect();
      };

      ws.onerror = () => {
        // Errors trigger close; cleanup happens in onclose.
      };

      // Dispose old onData listener and register new one. The DA/CPR
      // filter remains the SOLE rule on this listener per the
      // mobile-side §6 #13 contract — every byte (desktop typing,
      // mobile-input, modifier-bar) flows through here.
      dataDisposableRef.current?.dispose();
      dataDisposableRef.current = term.onData((data) => {
        // Filter terminal query responses (DA1, DA2, DA3, CPR) —
        // xterm.js auto-replies to tmux capability probes; echoing them
        // back into the PTY produces visible garbage like [?1;2c
        if (/^\x1b\[[\?>=]/.test(data) || /^\x1b\[\d+;\d+R$/.test(data)) return;
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "input", data }));
        }
      });
    } catch {
      // Network error fetching token — retry
      if (unmountedRef.current) return;
      isReconnectRef.current = true;
      scheduleReconnect();
    } finally {
      isConnectingRef.current = false;
    }
    // terminalIO intentionally excluded: only refs and stable setters used.
    // Including it would rebuild this callback on every setReady() flip and
    // tear down the live xterm via the [initTerminal] effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, scheduleReconnect, handleMessage]);

  // Initialize terminal ONCE, then connect WebSocket
  const initTerminal = useCallback(async () => {
    if (!terminalRef.current || !sessionId) return;

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 14,
      fontFamily:
        "'Geist Mono', 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      theme: themeConfigs[themeRef.current].terminal,
      scrollback: 5000,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(terminalRef.current);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        fitAddon.fit();
      });
    });

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;
    // Mirror refs into TerminalIOContext per `06-integration-plan-mobile.md
    // §2.2`. Mobile siblings (MobileTerminalInput, ModifierKeyBar, sheets)
    // read these refs to dispatch input and check DECCKM mode.
    terminalIO.xtermRef.current = term;
    terminalIO.terminalElementRef.current = terminalRef.current;

    // Scroll tracking via xterm API
    const publishScroll = () => {
      updateScrollRef.current({
        viewportY: term.buffer.active.viewportY,
        rows: term.rows,
        totalLines: term.buffer.active.length,
      });
    };
    const scrollDisposable = term.onScroll(() => publishScroll());
    const writeDisposable = term.onWriteParsed(() => {
      requestAnimationFrame(() => publishScroll());
    });
    requestAnimationFrame(() => {
      requestAnimationFrame(() => publishScroll());
    });
    registerScrollFnRef.current((line: number) => {
      const maxLine = term.buffer.active.baseY;
      term.scrollToLine(Math.min(maxLine, Math.max(0, Math.round(line - term.rows / 2))));
    });

    // Install the desktop key handler (Ctrl+Shift+C copy etc.). On
    // mobile-only viewports, MobileTerminalInput may install a
    // `() => false` blanket-block handler; the re-installer in
    // `getDefaultKeyHandler` lets us swap back on tablet rotation
    // (`05-decision-mobile.md §10 risk 4`).
    term.attachCustomKeyEventHandler(getDefaultKeyHandler(term));

    // Intercept paste event — uses wsRef so it works after reconnect.
    // Image paste only; text paste falls through to xterm's own paste
    // handler (which honors bracketed-paste).
    const handlePaste = (e: ClipboardEvent) => {
      if (!e.clipboardData) return;

      const items = e.clipboardData.items;
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith("image/")) {
          e.preventDefault();
          e.stopImmediatePropagation();
          const blob = items[i].getAsFile();
          if (!blob) return;
          const reader = new FileReader();
          reader.onload = () => {
            const base64 = (reader.result as string).split(",")[1];
            const ws = wsRef.current;
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "image", data: base64 }));
            }
          };
          reader.readAsDataURL(blob);
          return;
        }
      }
    };
    terminalRef.current.addEventListener("paste", handlePaste, true);

    // Mobile pointerdown handler per `06-integration-plan-mobile.md §3.11
    // step 3`: tapping the terminal area on mobile must focus the
    // hidden MobileTerminalInput textarea (via TerminalIOContext) so
    // the soft keyboard opens. iOS Safari REQUIRES focus to come from
    // a synchronous user gesture, hence the `pointerdown` (capture-phase
    // not strictly needed here; bubble works for the wrapper div).
    const handlePointerDown = () => {
      if (!window.matchMedia("(max-width: 767px)").matches) return;
      const inputEl = terminalIO.mobileInputRef.current;
      if (!inputEl) return;
      // Focus must be synchronous within the gesture; do not wrap in
      // a microtask or rAF.
      try {
        inputEl.focus({ preventScroll: true });
      } catch {
        inputEl.focus();
      }
      // Note: do NOT preventDefault — xterm's own pointerdown handler
      // also runs and manages selection / scroll; we just summon focus.
    };
    terminalRef.current.addEventListener("pointerdown", handlePointerDown, true);

    // Resize handler — uses wsRef so it works after reconnect.
    // Per `06-integration-plan-tmux.md §4.4` lines 1133-1157 and
    // `06-integration-plan-mobile.md §3.11 step 4`: 80 ms trailing-edge
    // debounce + local equality coalesce so we don't spam the server
    // with no-op resizes during keyboard show/hide cascades.
    let lastSentCols = term.cols;
    let lastSentRows = term.rows;

    const doResize = () => {
      try {
        fitAddon.fit();
      } catch {
        /* container may have zero size mid-transition; ignore */
      }
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        if (term.cols !== lastSentCols || term.rows !== lastSentRows) {
          lastSentCols = term.cols;
          lastSentRows = term.rows;
          ws.send(
            JSON.stringify({
              type: "resize",
              cols: term.cols,
              rows: term.rows,
            }),
          );
        }
      }
      requestAnimationFrame(() => publishScroll());
    };

    const handleResize = () => {
      if (resizeDebounceTimerRef.current) {
        clearTimeout(resizeDebounceTimerRef.current);
      }
      resizeDebounceTimerRef.current = setTimeout(doResize, RESIZE_DEBOUNCE_MS);
    };

    const resizeObserver = new ResizeObserver(handleResize);
    if (terminalRef.current) {
      resizeObserver.observe(terminalRef.current);
    }

    // Mobile-specific: visualViewport.resize fires when iOS keyboard
    // opens/closes WITHOUT the container content-box changing — which
    // ResizeObserver misses (`02-scan-terminal.md §5.3`). Per `06-
    // integration-plan-mobile.md §3.11 step 4` we attach a separate
    // listener that re-runs the same debounced resize logic and also
    // scrolls the cursor into view if the keyboard is open.
    const handleVvResize = () => {
      handleResize();
      // Best-effort: scroll cursor into view on keyboard open per `05-
      // decision-mobile.md §6 criterion 6 (b)`.
      const vv = window.visualViewport;
      const innerH = window.innerHeight || 0;
      const isKbdOpen = vv ? Math.max(0, innerH - vv.height - vv.offsetTop) > 150 : false;
      if (isKbdOpen) {
        requestAnimationFrame(() => {
          term.scrollToBottom();
        });
      }
    };
    let vvAttached = false;
    if (typeof window !== "undefined" && window.visualViewport) {
      window.visualViewport.addEventListener("resize", handleVvResize);
      window.visualViewport.addEventListener("scroll", handleVvResize);
      vvAttached = true;
    }

    // Defensive: also listen to plain window resize. ResizeObserver covers
    // the container, but some layouts (e.g. when the surrounding panel
    // collapses without dimension change) won't trigger it on a window
    // resize. This duplicate path is debounced via the same handler so
    // there's no extra cost.
    const handleWindowResize = () => handleResize();
    window.addEventListener("resize", handleWindowResize);
    // Also re-fit when the page becomes visible again after tab switch /
    // device sleep — char metrics can drift if the document was hidden.
    const handleVisibility = () => {
      if (document.visibilityState === "visible") handleResize();
    };
    document.addEventListener("visibilitychange", handleVisibility);

    // Connect WebSocket
    await connectWs();

    const containerEl = terminalRef.current;
    return () => {
      unmountedRef.current = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      if (resizeDebounceTimerRef.current) {
        clearTimeout(resizeDebounceTimerRef.current);
        resizeDebounceTimerRef.current = null;
      }
      containerEl?.removeEventListener("paste", handlePaste, true);
      containerEl?.removeEventListener("pointerdown", handlePointerDown, true);
      if (vvAttached && window.visualViewport) {
        window.visualViewport.removeEventListener("resize", handleVvResize);
        window.visualViewport.removeEventListener("scroll", handleVvResize);
      }
      window.removeEventListener("resize", handleWindowResize);
      document.removeEventListener("visibilitychange", handleVisibility);
      scrollDisposable.dispose();
      writeDisposable.dispose();
      dataDisposableRef.current?.dispose();
      registerScrollFnRef.current(null);
      resizeObserver.disconnect();
      // Clear TerminalIOContext refs so siblings don't reach into a
      // disposed xterm.
      terminalIO.xtermRef.current = null;
      terminalIO.terminalElementRef.current = null;
      terminalIO.setReady(false);
      // Clean close of WebSocket
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
        wsRef.current = null;
        terminalIO.wsRef.current = null;
      }
      term.dispose();
    };
    // terminalIO intentionally excluded — see connectWs note above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, connectWs]);

  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    unmountedRef.current = false;

    let cleanup: (() => void) | undefined;
    initTerminal().then((fn) => {
      cleanup = fn;
    });

    return () => {
      // Don't reset initRef — prevents double init in StrictMode
      cleanup?.();
    };
  }, [initTerminal]);

  return (
    <div className="relative w-full h-full min-h-0">
      <div
        ref={terminalRef}
        role="region"
        aria-label="Терминал"
        className="w-full h-full min-h-0 terminal-host"
      />
      {reconnecting && !authExpired && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 bg-amber-500/90 text-white text-xs px-3 py-1.5 rounded-full flex items-center gap-2 animate-pulse shadow-lg">
          <div className="w-2.5 h-2.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
          Переподключение...
        </div>
      )}
      {authExpired && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 bg-red-500/90 text-white text-xs px-3 py-1.5 rounded-full shadow-lg">
          Сессия истекла — обновите страницу
        </div>
      )}
    </div>
  );
}
