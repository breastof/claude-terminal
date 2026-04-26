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

// Tmux WP-C constants per `06-integration-plan-tmux.md §2.7`.
// Server gates the new path behind `CT_RELIABLE_STREAMING=1`; the client
// is forward-AND-backward-compatible per §2.8 matrix — it ALWAYS sends
// `hello` and uses the absence of `replay_complete` within 2 s as the
// "old server" detection. There is intentionally NO client-side env var.
const LEGACY_FALLBACK_MS = 2000;
const RESIZE_DEBOUNCE_MS = 80;
// Binary frame opcodes per `06-integration-plan-tmux.md §2.2`.
const OPCODE_OUTPUT = 0x01;
const OPCODE_SNAPSHOT = 0x02;

// sessionStorage key for `lastSeq` resume per `06-integration-plan-tmux.md
// §2.4.1` ("Persisted in sessionStorage keyed by sessionId so same-tab
// reload preserves it").
function lastSeqStorageKey(sessionId: string): string {
  return `ct.lastSeq.${sessionId}`;
}

function readStoredLastSeq(sessionId: string): bigint {
  try {
    if (typeof sessionStorage === "undefined") return BigInt(0);
    const raw = sessionStorage.getItem(lastSeqStorageKey(sessionId));
    if (!raw) return BigInt(0);
    return BigInt(raw);
  } catch {
    return BigInt(0);
  }
}

function writeStoredLastSeq(sessionId: string, seq: bigint): void {
  try {
    if (typeof sessionStorage === "undefined") return;
    sessionStorage.setItem(lastSeqStorageKey(sessionId), seq.toString());
  } catch {
    /* sessionStorage may be disabled in private mode; safe to ignore. */
  }
}

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

  // Tmux WP-C transport state per `06-integration-plan-tmux.md §4.4`:
  //   - lastSeqRef   : tracked seq of last applied byte (BigInt as string in storage)
  //   - replayCompleteSeenRef : true after server emits `replay_complete`
  //                             OR after the legacy-fallback timer fires.
  //   - legacyFallbackTimerRef: 2 s timer that flips to legacy mode if the
  //                             server doesn't emit `replay_complete`.
  //   - resizeDebounceTimerRef: 80 ms trailing-edge debounce on
  //                             ResizeObserver → ws.send({type:"resize"}).
  const lastSeqRef = useRef<bigint>(BigInt(0));
  const replayCompleteSeenRef = useRef(false);
  const legacyFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  // Seed lastSeqRef from sessionStorage on mount per `06 §4.4`. Same-tab
  // reload preserves the seq so a fast-path resume is possible.
  useEffect(() => {
    lastSeqRef.current = readStoredLastSeq(sessionId);
    return () => {
      // Best-effort cleanup on session switch — keep the key around in
      // case the user navigates back to this session shortly. Per `06
      // §4.4` "On unmount or session switch, removes the key" is
      // optional; we leave it for now to maximise FAST_PATH hits.
    };
  }, [sessionId]);

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
   * Update lastSeqRef and persist it. Per `06-integration-plan-tmux.md
   * §4.4` the persistence is debounced (~250 ms) but a synchronous write
   * per-chunk is cheap enough for the typical chunk cadence (live output
   * is usually <100 chunks/s). Keep simple for now.
   */
  const updateLastSeq = useCallback((seq: bigint) => {
    lastSeqRef.current = seq;
    writeStoredLastSeq(sessionId, seq);
  }, [sessionId]);

  /**
   * Handle a server→client message — handles BOTH the new path's binary
   * frames + new JSON envelopes AND the legacy path's plain `output`/
   * `exit`/`stopped`/`error` envelopes. Per `06-integration-plan-tmux.md
   * §2.8 matrix`, every cell renders correctly because the new client
   * tolerates absent `seq` fields and falls back to legacy after 2 s
   * with no `replay_complete`.
   */
  const handleMessage = useCallback(
    (event: MessageEvent, term: XTerm, fitAddon: FitAddon) => {
      // Binary branch — only fires when server uses new path AND client
      // advertised binary_capable in its hello (we always do).
      if (event.data instanceof ArrayBuffer) {
        const buf = event.data;
        if (buf.byteLength < 9) {
          console.warn("[terminal] binary frame too short:", buf.byteLength);
          return;
        }
        const view = new DataView(buf);
        const opcode = view.getUint8(0);
        const seq = view.getBigUint64(1, false);
        const payload = new Uint8Array(buf, 9);
        switch (opcode) {
          case OPCODE_OUTPUT:
            // Live live output — fire-and-forget per `05 §D-Q7`.
            updateLastSeq(seq);
            term.write(payload);
            return;
          case OPCODE_SNAPSHOT: {
            // Slow-path replay. Reset parser state so the snapshot's own
            // `\x1b[2J\x1b[H` clear-home re-anchors a clean buffer
            // (`05 §D-Q8`). Update lastSeq AFTER parser drains via the
            // write callback per `05 §D-Q7` chain barrier.
            term.reset();
            const text = new TextDecoder("utf-8").decode(payload);
            term.write(text, () => {
              updateLastSeq(seq);
            });
            return;
          }
          default:
            // Per plan §2.2 reserved opcodes: log and discard.
            console.warn("[terminal] unknown binary opcode:", opcode);
            return;
        }
      }

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
          // New path emits `seq` (decimal-encoded BigInt string); legacy
          // omits it. Tolerate both per `06 §2.8`.
          if (typeof message.seq === "string") {
            try {
              updateLastSeq(BigInt(message.seq));
            } catch {
              /* malformed seq — keep last known */
            }
          }
          if (typeof message.data === "string") {
            term.write(message.data);
          }
          return;

        case "snapshot": {
          // Text-fallback snapshot per `06 §2.3.3`. Behavior identical
          // to OPCODE_SNAPSHOT — reset, write, update seq via callback.
          if (typeof message.data === "string") {
            term.reset();
            const seqStr = message.seq;
            term.write(message.data, () => {
              if (typeof seqStr === "string") {
                try {
                  updateLastSeq(BigInt(seqStr));
                } catch {
                  /* malformed; ignore */
                }
              }
            });
          }
          return;
        }

        case "resume":
          // Informational per `06 §2.3.2`. Optionally validate `from`
          // matches lastSeq + 1; warn on mismatch in dev.
          if (process.env.NODE_ENV !== "production" && typeof message.from === "string") {
            try {
              const expected = lastSeqRef.current + BigInt(1);
              const got = BigInt(message.from);
              if (got !== expected) {
                console.warn(
                  `[terminal] resume mismatch: from=${got} expected=${expected}`,
                );
              }
            } catch {
              /* ignore parse error */
            }
          }
          return;

        case "replay_complete":
          // Per `06 §2.3.5`: barrier between replay and live. Fire fit +
          // scrollToBottom on next rAF, hide reconnecting indicator,
          // cancel the legacy-fallback timer.
          replayCompleteSeenRef.current = true;
          if (legacyFallbackTimerRef.current) {
            clearTimeout(legacyFallbackTimerRef.current);
            legacyFallbackTimerRef.current = null;
          }
          isReconnectRef.current = false;
          requestAnimationFrame(() => {
            try {
              fitAddon.fit();
            } catch {
              /* fit may throw if container size is 0 mid-transition; ignore */
            }
            term.scrollToBottom();
            setReconnecting(false);
          });
          return;

        case "exit":
          term.write("\r\n\x1b[90m--- Сессия остановлена ---\x1b[0m\r\n");
          return;

        case "stopped":
          term.write(
            "\x1b[90m--- Сессия остановлена. Нажмите \"Возобновить\" в боковой панели. ---\x1b[0m\r\n",
          );
          return;

        case "error":
          if (typeof message.message === "string") {
            term.write(`\r\n\x1b[31m${message.message}\x1b[0m\r\n`);
          }
          return;

        default:
          // Per `06 §10.2` "DO NOT silently drop unknown WS message
          // types. Add explicit default branches with console.warn".
          console.warn("[terminal] unknown message type:", message.type);
      }
    },
    [updateLastSeq],
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
      // Per `06-integration-plan-tmux.md §4.4`: enable binary frame
      // parsing on the new path. No-op on legacy server (won't emit binary).
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;
      // Mirror into TerminalIOContext for mobile siblings.
      terminalIO.wsRef.current = ws;

      ws.onopen = () => {
        reconnectAttemptRef.current = 0;
        onConnectionChangeRef.current?.("connected");
        terminalIO.setReady(true);
        replayCompleteSeenRef.current = false;

        // Per `06 §2.4.1`: send `hello` FIRST so the new server can
        // route FAST/SLOW path. Old servers silently ignore the unknown
        // `hello` type via their existing try/catch (`terminal-manager.js
        // :516`) — this is the load-bearing back-compat property.
        try {
          ws.send(
            JSON.stringify({
              type: "hello",
              protocol_version: 2,
              binary_capable: true,
              lastSeq: lastSeqRef.current.toString(),
            }),
          );
        } catch {
          /* WS may be closing; safe to ignore */
        }

        // Existing behaviour: send current terminal size.
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

        // Mimic the old behaviour at `Terminal.tsx:154-157` — clear the
        // terminal IMMEDIATELY on reconnect open so the legacy server's
        // about-to-arrive `output` buffer paints on a clean canvas.
        // Doing this inside the 2 s legacy-fallback timer would wipe the
        // already-rendered buffer (the legacy server sends its
        // session.buffer dump within milliseconds of connect).
        if (isReconnectRef.current) {
          term.clear();
          isReconnectRef.current = false;
        }

        // Legacy fallback: per `06 §2.7` AWAIT_HELLO timer + §2.8 matrix.
        // If the server is on the OLD path, no `replay_complete` will
        // ever arrive. After 2 s, hide the reconnecting indicator only.
        if (legacyFallbackTimerRef.current) {
          clearTimeout(legacyFallbackTimerRef.current);
        }
        legacyFallbackTimerRef.current = setTimeout(() => {
          if (!replayCompleteSeenRef.current) {
            // Hide the reconnecting indicator (legacy path emits a single
            // `output` frame and never a `replay_complete`).
            setReconnecting(false);
          }
          legacyFallbackTimerRef.current = null;
        }, LEGACY_FALLBACK_MS);
      };

      ws.onmessage = (event) => {
        handleMessage(event, term, fitAddon);
      };

      ws.onclose = (event) => {
        onConnectionChangeRef.current?.("disconnected");
        wsRef.current = null;
        terminalIO.wsRef.current = null;
        terminalIO.setReady(false);

        // Cleanup the legacy fallback timer if still pending.
        if (legacyFallbackTimerRef.current) {
          clearTimeout(legacyFallbackTimerRef.current);
          legacyFallbackTimerRef.current = null;
        }

        // Don't reconnect if component unmounting
        if (unmountedRef.current) return;
        // Don't reconnect on explicit auth/session errors
        if (event.code === 4401 || event.code === 4404) return;
        // Per `06 §2.6`: code 4503 ("lagging") falls through to reconnect
        // — preserves lastSeq for resume. No special handling needed
        // here because it's NOT 4401/4404; the existing reconnect path
        // already handles it correctly.

        // Mark as reconnecting for buffer dedup on next connect
        isReconnectRef.current = true;
        scheduleReconnect();
      };

      ws.onerror = () => {
        // Errors trigger close; cleanup happens in onclose. Per `06
        // §10.2` we MUST install an `error` handler so unhandled errors
        // don't crash the WSS-side socket scan.
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

    // Connect WebSocket
    await connectWs();

    const containerEl = terminalRef.current;
    return () => {
      unmountedRef.current = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      // Cleanup WP-C transport timers.
      if (legacyFallbackTimerRef.current) {
        clearTimeout(legacyFallbackTimerRef.current);
        legacyFallbackTimerRef.current = null;
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
