"use client";

import { useState, useEffect } from "react";
import { useOverlay, useOverlayStore } from "@/lib/overlayStore";

/**
 * Command palette (Cmd+K / Ctrl+K) — extracted from `pos/SessionPanel.tsx`
 * per `06-integration-plan-mobile.md §2.14`.
 *
 * Lives at the page level so it works regardless of the active section
 * (closes the hot bug from `02-scan-navigation.md §1.2`: previously the
 * Cmd+K listener only ran while the SessionPanel was mounted).
 *
 * Scope-guard per `05-decision-mobile.md §2.11 / §5`: ignores keystrokes
 * whose `e.target` is an INPUT, TEXTAREA, SELECT, or `[contenteditable]`,
 * so chat / rename / search inputs can type literal `k`.
 */

interface PaletteSession {
  sessionId: string;
  displayName: string | null;
  isActive: boolean;
  busy?: boolean;
  waiting?: boolean;
}

interface CommandPaletteProps {
  sessions: PaletteSession[];
  onSelectSession: (sessionId: string) => void;
}

export default function CommandPalette({ sessions, onSelectSession }: CommandPaletteProps) {
  const open = useOverlay("palette");
  const openOverlay = useOverlayStore((s) => s.openOverlay);
  const closeOverlay = useOverlayStore((s) => s.closeOverlay);

  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);

  // Reset query/index whenever the palette is closed.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setIndex(0);
    }
  }, [open]);

  // Global hotkeys: Cmd/Ctrl+K toggles palette, Cmd/Ctrl+1..9 switches sessions.
  // Scope-guarded against typing inside form fields (`05 §2.11`).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      const isInputLike =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        !!t?.isContentEditable;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        if (isInputLike) return; // GUARD: do not steal Cmd+K from inputs
        e.preventDefault();
        const current = useOverlayStore.getState().activeOverlay;
        if (current === "palette") closeOverlay();
        else openOverlay("palette");
        return;
      }

      if (
        (e.ctrlKey || e.metaKey) &&
        !e.altKey &&
        !e.shiftKey &&
        /^[1-9]$/.test(e.key)
      ) {
        if (isInputLike) return;
        const active = sessions.filter((s) => s.isActive);
        const idx = Number(e.key) - 1;
        if (active[idx]) {
          e.preventDefault();
          onSelectSession(active[idx].sessionId);
        }
        return;
      }

      if (
        e.key === "Escape" &&
        useOverlayStore.getState().activeOverlay === "palette"
      ) {
        closeOverlay();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sessions, onSelectSession, openOverlay, closeOverlay]);

  const filtered = sessions
    .filter((s) => s.isActive)
    .filter((s) => {
      if (!query.trim()) return true;
      const q = query.toLowerCase();
      return (
        (s.displayName || "").toLowerCase().includes(q) ||
        s.sessionId.toLowerCase().includes(q)
      );
    });

  if (!open) return null;

  const handleSelect = (id: string) => {
    onSelectSession(id);
    closeOverlay();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex(Math.min(index + 1, Math.max(0, filtered.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex(Math.max(0, index - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filtered[index]) handleSelect(filtered[index].sessionId);
    } else if (e.key === "Escape") {
      closeOverlay();
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Командная палитра"
      className="fixed inset-0 flex items-start justify-center pt-[15vh] bg-black/50"
      style={{ zIndex: 9000 }}
      onClick={() => closeOverlay()}
    >
      <div
        className="w-[min(560px,92vw)] bg-surface-alt border border-border-strong rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={onKey}
          placeholder="Поиск сессии… (↑↓ навигация, Enter — открыть, Esc — закрыть)"
          className="w-full px-4 py-3 bg-transparent text-foreground outline-none border-b border-border text-sm"
        />
        <div className="max-h-80 overflow-y-auto">
          {filtered.length === 0 && (
            <div className="px-4 py-6 text-center text-muted-fg text-sm">
              Нет активных сессий
            </div>
          )}
          {filtered.map((s, i) => (
            <button
              key={s.sessionId}
              onClick={() => handleSelect(s.sessionId)}
              onMouseEnter={() => setIndex(i)}
              className={`w-full text-left px-4 py-2.5 flex items-center gap-3 cursor-pointer transition-colors ${
                i === index ? "bg-accent-hover" : "hover:bg-surface-hover"
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                  s.busy
                    ? "bg-emerald-300 ring-2 ring-emerald-400"
                    : s.waiting
                    ? "bg-amber-300 ring-2 ring-amber-400"
                    : "bg-emerald-400"
                }`}
              />
              <span className="text-sm text-foreground truncate flex-1">
                {s.displayName || s.sessionId}
              </span>
              {i < 9 && (
                <span className="text-[10px] text-muted-fg border border-border rounded px-1.5 py-0.5">
                  Ctrl+{i + 1}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
