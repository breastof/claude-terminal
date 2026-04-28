"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import { useTheme } from "@/lib/ThemeContext";
import { themeConfigs } from "@/lib/theme-config";
import { Search, X } from "@/components/Icons";

interface HistoryViewerProps {
  sessionId: string;
  onClose?: () => void;
}

const PAGE_SIZE = 5 * 1024 * 1024; // 5 MB per fetch
const SCROLL_TOP_THRESHOLD = 200;

interface LoadedRange {
  start: number;
  end: number;
}

export default function HistoryViewer({ sessionId, onClose }: HistoryViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  // Accumulated bytes across paged fetches (oldest → newest).
  const accRef = useRef<Uint8Array>(new Uint8Array(0));
  const initRef = useRef(false);
  const loadingRef = useRef(false);

  const { theme } = useTheme();

  const [totalSize, setTotalSize] = useState<number>(0);
  const [loadedRange, setLoadedRange] = useState<LoadedRange>({ start: 0, end: 0 });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const writeAccToTerm = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    term.reset();
    term.write(accRef.current, () => {
      try { term.scrollToBottom(); } catch { /* best effort */ }
    });
  }, []);

  const fetchInitial = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/history?tail=${PAGE_SIZE}`,
      );
      if (res.status === 404) {
        const j = await res.json().catch(() => ({}));
        if (j?.error === "history_not_recorded") {
          setError("История не записана для этой сессии (создана до включения функции). Доступно только то, что в живом скроллбэке.");
        } else {
          setError("Сессия не найдена.");
        }
        setLoading(false);
        return;
      }
      if (!res.ok) {
        setError(`Ошибка загрузки: ${res.status}`);
        setLoading(false);
        return;
      }
      const total = parseInt(res.headers.get("X-Total-Size") || "0", 10);
      const rs = parseInt(res.headers.get("X-Range-Start") || "0", 10);
      const re = parseInt(res.headers.get("X-Range-End") || "0", 10);
      const buf = new Uint8Array(await res.arrayBuffer());
      accRef.current = buf;
      setTotalSize(total);
      setLoadedRange({ start: rs, end: re });
      writeAccToTerm();
    } catch (e) {
      setError(`Сеть: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [sessionId, writeAccToTerm]);

  const loadOlder = useCallback(async () => {
    if (loadingRef.current) return;
    if (loadedRange.start <= 0) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/history?before=${loadedRange.start}&size=${PAGE_SIZE}`,
      );
      if (!res.ok) {
        setError(`Ошибка пагинации: ${res.status}`);
        return;
      }
      const total = parseInt(res.headers.get("X-Total-Size") || "0", 10);
      const rs = parseInt(res.headers.get("X-Range-Start") || "0", 10);
      const re = parseInt(res.headers.get("X-Range-End") || "0", 10);
      const buf = new Uint8Array(await res.arrayBuffer());
      const merged = new Uint8Array(buf.length + accRef.current.length);
      merged.set(buf, 0);
      merged.set(accRef.current, buf.length);
      accRef.current = merged;
      setTotalSize(total);
      setLoadedRange({ start: rs, end: loadedRange.end });

      const term = termRef.current;
      if (!term) return;
      // Re-render entire accumulator. Approximate scroll restoration —
      // user keeps roughly current line position by re-scrolling to a
      // similar bottom-distance after reset.
      const prevViewport = term.buffer.active.viewportY;
      const prevTotal = term.buffer.active.length;
      term.reset();
      term.write(accRef.current, () => {
        const newTotal = term.buffer.active.length;
        const newViewport = Math.min(
          newTotal - term.rows,
          (newTotal - prevTotal) + prevViewport,
        );
        try { term.scrollToLine(Math.max(0, newViewport)); } catch { /* best effort */ }
      });
    } catch (e) {
      setError(`Пагинация: ${(e as Error).message}`);
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [sessionId, loadedRange]);

  // Mount xterm + initial fetch
  useEffect(() => {
    if (initRef.current || !containerRef.current) return;
    initRef.current = true;

    const term = new XTerm({
      cursorBlink: false,
      disableStdin: true,
      fontSize: 13,
      fontFamily: "'Geist Mono', 'JetBrains Mono', 'Fira Code', monospace",
      theme: themeConfigs[theme].terminal,
      scrollback: 50000,
      convertEol: false,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.open(containerRef.current);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        try { fit.fit(); } catch { /* best effort */ }
      });
    });

    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;

    // Scroll listener — load older when near top.
    const onScroll = () => {
      const t = termRef.current;
      if (!t) return;
      if (loadingRef.current) return;
      if (t.buffer.active.viewportY < SCROLL_TOP_THRESHOLD && loadedRange.start > 0) {
        loadOlder();
      }
    };
    term.onScroll(onScroll);

    // Cmd+F / Ctrl+F → toggle search bar
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearchOpen(true);
        return false;
      }
      if (e.type === "keydown" && e.key === "Escape") {
        setSearchOpen(false);
        if (onClose) onClose();
        return false;
      }
      return true;
    });

    fetchInitial();

    const ro = new ResizeObserver(() => {
      try { fit.fit(); } catch { /* best effort */ }
    });
    if (containerRef.current) ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      try { search.dispose(); } catch { /* best effort */ }
      try { fit.dispose(); } catch { /* best effort */ }
      try { term.dispose(); } catch { /* best effort */ }
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-apply theme when it changes
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = themeConfigs[theme].terminal;
    }
  }, [theme]);

  const doSearch = (dir: "next" | "prev") => {
    if (!searchRef.current || !searchQuery) return;
    if (dir === "next") {
      searchRef.current.findNext(searchQuery, { caseSensitive: false });
    } else {
      searchRef.current.findPrevious(searchQuery, { caseSensitive: false });
    }
  };

  const fmtBytes = (n: number) => {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  };

  return (
    <div className="w-full h-full flex flex-col bg-surface-alt">
      {/* Top toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-surface flex-shrink-0">
        <span className="text-xs text-muted-fg">
          {error
            ? "—"
            : `Загружено ${fmtBytes(loadedRange.end - loadedRange.start)} из ${fmtBytes(totalSize)}`}
        </span>
        {loading && (
          <span className="text-xs text-accent-fg ml-2">загрузка…</span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => setSearchOpen((v) => !v)}
            className="p-1.5 text-muted-fg hover:text-foreground hover:bg-surface-hover rounded transition-colors cursor-pointer"
            title="Поиск (⌘F)"
          >
            <Search className="w-4 h-4" />
          </button>
          {onClose && (
            <button
              onClick={onClose}
              className="p-1.5 text-muted-fg hover:text-foreground hover:bg-surface-hover rounded transition-colors cursor-pointer"
              title="Закрыть (Esc)"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Search bar */}
      {searchOpen && (
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-surface-alt flex-shrink-0">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") doSearch(e.shiftKey ? "prev" : "next");
              if (e.key === "Escape") setSearchOpen(false);
            }}
            placeholder="Найти в истории…"
            autoFocus
            className="flex-1 px-2 py-1 text-sm bg-surface border border-border rounded outline-none focus:border-accent"
          />
          <button
            onClick={() => doSearch("prev")}
            className="px-2 py-1 text-xs text-muted-fg hover:text-foreground hover:bg-surface-hover rounded"
            title="Предыдущее (Shift+Enter)"
          >
            ↑
          </button>
          <button
            onClick={() => doSearch("next")}
            className="px-2 py-1 text-xs text-muted-fg hover:text-foreground hover:bg-surface-hover rounded"
            title="Следующее (Enter)"
          >
            ↓
          </button>
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div className="px-3 py-2 text-xs text-warning bg-surface-hover border-b border-border flex-shrink-0">
          {error}
        </div>
      )}

      {/* xterm container */}
      <div
        ref={containerRef}
        className="flex-1 min-h-0 overflow-hidden"
        style={{ backgroundColor: themeConfigs[theme].terminal.background }}
      />
    </div>
  );
}
