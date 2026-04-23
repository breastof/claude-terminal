"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Pencil, Trash, Play, Pause, FolderIcon, Volume2, VolumeX } from "@/components/Icons";
import { relativeTime } from "@/lib/utils";
import SessionDeleteModal from "@/components/SessionDeleteModal";
import PresenceAvatars from "@/components/presence/PresenceAvatars";
import ComboButton from "@/components/ComboButton";
import ProviderWizardModal from "@/components/ProviderWizardModal";
import ProviderConfigModal from "@/components/ProviderConfigModal";
import { useProviders, type Provider } from "@/lib/ProviderContext";
import { getProviderIcon } from "@/lib/provider-icons";

interface Session {
  sessionId: string;
  displayName: string | null;
  projectDir: string;
  createdAt: string;
  lastActivityAt?: string;
  isActive: boolean;
  busy?: boolean;
  waiting?: boolean;
  connectedClients: number;
  hasFiles: boolean;
  providerSlug: string;
}

interface SessionPanelProps {
  activeSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onSessionDeleted: (sessionId: string) => void;
  onNewSession: (providerSlug: string) => void;
  onOpenFiles?: (sessionId: string) => void;
  onResumeSession?: (sessionId: string) => void;
  resumingSessionId?: string | null;
  creatingSession?: boolean;
}

export default function SessionPanel({
  activeSessionId,
  onSelectSession,
  onSessionDeleted,
  onNewSession,
  onOpenFiles,
  onResumeSession,
  resumingSessionId,
  creatingSession,
}: SessionPanelProps) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Session | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [configProvider, setConfigProvider] = useState<Provider | null>(null);

  const { providers, refetch: refetchProviders } = useProviders();

  const [selectedSlug, setSelectedSlug] = useState<string>(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("selectedProvider") || "claude";
    }
    return "claude";
  });

  const prevBusyRef = useRef<Set<string>>(new Set());
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const seenOnceRef = useRef(false);
  const [muted, setMuted] = useState<boolean>(() => {
    if (typeof window !== "undefined") return localStorage.getItem("soundMuted") === "1";
    return false;
  });
  const lastBadgeRef = useRef<string>("");
  const originalFaviconRef = useRef<HTMLImageElement | null>(null);
  const [seenMap, setSeenMap] = useState<Record<string, number>>(() => {
    if (typeof window === "undefined") return {};
    try { return JSON.parse(localStorage.getItem("sessionSeenMap") || "{}"); } catch { return {}; }
  });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteIndex, setPaletteIndex] = useState(0);

  useEffect(() => {
    if (typeof window !== "undefined" && !audioRef.current) {
      const a = new Audio("/sounds/done.mp3");
      a.preload = "auto";
      a.volume = 0.35;
      audioRef.current = a;
    }
  }, []);

  const toggleMute = () => {
    setMuted((m) => {
      const next = !m;
      localStorage.setItem("soundMuted", next ? "1" : "0");
      return next;
    });
  };

  const anyBusy = sessions.some((s) => s.busy);

  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch("/api/sessions");
      if (!res.ok) return;
      const data = await res.json();
      const next: Session[] = data.sessions;
      const curBusy = new Set(next.filter((s) => s.busy).map((s) => s.sessionId));
      if (seenOnceRef.current) {
        const anyFinished = [...prevBusyRef.current].some((id) => !curBusy.has(id));
        if (anyFinished && !muted && audioRef.current) {
          const a = audioRef.current;
          a.currentTime = 0;
          a.play().catch(() => {});
        }
      }
      prevBusyRef.current = curBusy;
      seenOnceRef.current = true;
      setSessions(next);
    } catch {}
  }, [muted]);

  useEffect(() => {
    fetchSessions();
    const interval = setInterval(fetchSessions, anyBusy ? 1500 : 5000);
    return () => clearInterval(interval);
  }, [fetchSessions, anyBusy]);

  // Favicon: оригинальная иконка + угловая точка по состоянию любой сессии
  useEffect(() => {
    if (typeof document === "undefined") return;

    const anyBusy = sessions.some((s) => s.isActive && s.busy);
    const anyUnread = sessions.some((s) => isUnread(s));
    const anyWaiting = sessions.some((s) => s.isActive && s.waiting);
    const badgeColor = anyBusy ? "#10b981" : (anyWaiting || anyUnread) ? "#f59e0b" : null;

    const stateKey = badgeColor || "none";
    if (stateKey === lastBadgeRef.current) return;
    lastBadgeRef.current = stateKey;

    const paint = (img: HTMLImageElement) => {
      const canvas = document.createElement("canvas");
      canvas.width = 64; canvas.height = 64;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, 64, 64);
      ctx.drawImage(img, 0, 0, 64, 64);
      if (badgeColor) {
        // Точка в правом нижнем углу, радиус 11 → занимает 45-63 → не лезет на логотип
        ctx.fillStyle = badgeColor;
        ctx.beginPath(); ctx.arc(54, 54, 11, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = "#0a0a0a"; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(54, 54, 11, 0, Math.PI * 2); ctx.stroke();
      }
      const dataUrl = canvas.toDataURL("image/png");
      document.querySelectorAll("link[rel*='icon']").forEach((el) => el.remove());
      const link = document.createElement("link");
      link.rel = "icon";
      link.type = "image/png";
      link.href = dataUrl;
      document.head.appendChild(link);
    };

    if (originalFaviconRef.current) {
      paint(originalFaviconRef.current);
    } else {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => { originalFaviconRef.current = img; paint(img); };
      img.onerror = () => {
        // Если не удалось загрузить оригинал — просто ставим текущий бандл-фавикон
        // и рисуем точку на пустом холсте в углу (её всё равно будет видно поверх)
        const canvas = document.createElement("canvas");
        canvas.width = 64; canvas.height = 64;
        const ctx = canvas.getContext("2d");
        if (ctx && badgeColor) {
          ctx.fillStyle = badgeColor;
          ctx.beginPath(); ctx.arc(54, 54, 11, 0, Math.PI * 2); ctx.fill();
          document.querySelectorAll("link[rel*='icon']").forEach((el) => el.remove());
          const link = document.createElement("link");
          link.rel = "icon"; link.type = "image/png";
          link.href = canvas.toDataURL("image/png");
          document.head.appendChild(link);
        }
      };
      img.src = "/favicon.ico";
    }
  }, [sessions, seenMap]);


  // Unread tracking: обновляем seenMap для активно просматриваемой сессии,
  // пока вкладка видима. Сохраняем в localStorage.
  useEffect(() => {
    if (!activeSessionId) return;
    const mark = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      setSeenMap((m) => {
        const now = Date.now();
        if (m[activeSessionId] && now - m[activeSessionId] < 1500) return m;
        const next = { ...m, [activeSessionId]: now };
        try { localStorage.setItem("sessionSeenMap", JSON.stringify(next)); } catch {}
        return next;
      });
    };
    mark();
    const id = setInterval(mark, 2000);
    const onFocus = () => mark();
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener("focus", onFocus);
    };
  }, [activeSessionId]);

  const isUnread = (s: Session) => {
    if (!s.isActive) return false;
    // Currently-viewed session with visible tab is always "read".
    if (s.sessionId === activeSessionId && typeof document !== "undefined" && !document.hidden) return false;
    const last = s.lastActivityAt ? new Date(s.lastActivityAt).getTime() : new Date(s.createdAt).getTime();
    const seen = seenMap[s.sessionId] || 0;
    return last > seen + 1000;
  };

  // Global hotkeys: Ctrl+K palette, Ctrl+1..9 session switch
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        setPaletteQuery("");
        setPaletteIndex(0);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && /^[1-9]$/.test(e.key)) {
        const active = sessions.filter((s) => s.isActive);
        const idx = Number(e.key) - 1;
        if (active[idx]) {
          e.preventDefault();
          onSelectSession(active[idx].sessionId);
        }
      }
      if (e.key === "Escape" && paletteOpen) {
        setPaletteOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sessions, onSelectSession, paletteOpen]);

  const handleStop = async (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await fetch(`/api/sessions/${sessionId}?action=stop`, { method: "DELETE" });
    fetchSessions();
  };

  const handleResume = (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    onResumeSession?.(sessionId);
  };

  const handleDeleteClick = (session: Session, e: React.MouseEvent) => {
    e.stopPropagation();
    setDeleteTarget(session);
  };

  const handleDeleteConfirm = async (deleteFiles: boolean) => {
    if (!deleteTarget) return;
    const keepFiles = !deleteFiles;
    const res = await fetch(
      `/api/sessions/${deleteTarget.sessionId}${keepFiles ? "?keepFiles=true" : ""}`,
      { method: "DELETE" }
    );
    if (res.ok) {
      onSessionDeleted(deleteTarget.sessionId);
      fetchSessions();
    }
    setDeleteTarget(null);
  };

  const handleRenameStart = (session: Session, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(session.sessionId);
    setEditName(session.displayName || session.sessionId);
  };

  const handleRenameSubmit = async (sessionId: string) => {
    if (editName.trim()) {
      await fetch(`/api/sessions/${sessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: editName.trim() }),
      });
      fetchSessions();
    }
    setEditingId(null);
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent, sessionId: string) => {
    if (e.key === "Enter") handleRenameSubmit(sessionId);
    else if (e.key === "Escape") setEditingId(null);
  };

  const handleSaveProvider = useCallback(async (data: {
    name: string; slug: string; command: string; resumeCommand: string; icon: string; color: string;
  }) => {
    const res = await fetch("/api/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: data.name, slug: data.slug, command: data.command,
        resumeCommand: data.resumeCommand || null, icon: data.icon, color: data.color,
      }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "Ошибка");
    }
    await refetchProviders();
    setSelectedSlug(data.slug);
    try { localStorage.setItem("selectedProvider", data.slug); } catch {}
  }, [refetchProviders]);

  const handleUpdateProvider = useCallback(async (slug: string, data: { name?: string; command?: string; resumeCommand?: string }) => {
    const res = await fetch(`/api/providers/${slug}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "Ошибка");
    }
    await refetchProviders();
  }, [refetchProviders]);

  const handleDeleteProvider = useCallback(async (slug: string) => {
    const res = await fetch(`/api/providers/${slug}`, { method: "DELETE" });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "Ошибка");
    }
    await refetchProviders();
    if (selectedSlug === slug) {
      setSelectedSlug("claude");
      try { localStorage.setItem("selectedProvider", "claude"); } catch {}
    }
  }, [refetchProviders, selectedSlug]);

  const byMostRecent = (a: Session, b: Session) =>
    new Date(b.lastActivityAt || b.createdAt).getTime() -
    new Date(a.lastActivityAt || a.createdAt).getTime();
  const activeSessions = sessions.filter((s) => s.isActive).sort(byMostRecent);
  const stoppedSessions = sessions.filter((s) => !s.isActive).sort(byMostRecent);

  return (
    <div className="flex flex-col h-full">
      {/* New session button */}
      <div className="h-14 px-3 flex items-center border-b border-border">
        <ComboButton
          providers={providers}
          selectedSlug={selectedSlug}
          onSelect={setSelectedSlug}
          onCreate={(slug) => onNewSession(slug)}
          onAddProvider={() => setWizardOpen(true)}
          onConfigureProvider={(p) => setConfigProvider(p)}
          creating={creatingSession}
          variant="sidebar"
        />
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-4">
        {sessions.length === 0 && (
          <p className="text-muted text-sm text-center py-8">Нет сессий</p>
        )}

        {activeSessions.length > 0 && (
          <div>
            <div className="px-2 py-1.5 text-xs font-medium text-muted-fg uppercase tracking-wider flex items-center justify-between">
              <span>Активные</span>
              <button
                onClick={toggleMute}
                className="p-1 text-muted-fg hover:text-foreground transition-colors cursor-pointer"
                title={muted ? "Включить звук завершения" : "Отключить звук завершения"}
                aria-label={muted ? "Unmute" : "Mute"}
              >
                {muted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
              </button>
            </div>
            {activeSessions.map((session) => (
              <SessionItem
                key={session.sessionId}
                session={session}
                unread={isUnread(session)}
                isSelected={activeSessionId === session.sessionId}
                isResuming={resumingSessionId === session.sessionId}
                editingId={editingId}
                editName={editName}
                onSelect={() => onSelectSession(session.sessionId)}
                onStop={(e) => handleStop(session.sessionId, e)}
                onResume={(e) => handleResume(session.sessionId, e)}
                onDelete={(e) => handleDeleteClick(session, e)}
                onRenameStart={(e) => handleRenameStart(session, e)}
                onEditNameChange={setEditName}
                onRenameSubmit={() => handleRenameSubmit(session.sessionId)}
                onRenameKeyDown={(e) => handleRenameKeyDown(e, session.sessionId)}
                onOpenFiles={onOpenFiles ? (e) => { e.stopPropagation(); onOpenFiles(session.sessionId); } : undefined}
              />
            ))}
          </div>
        )}

        {stoppedSessions.length > 0 && (
          <div>
            <div className="px-2 py-1.5 text-xs font-medium text-muted-fg uppercase tracking-wider">Остановленные</div>
            {stoppedSessions.map((session) => (
              <SessionItem
                key={session.sessionId}
                session={session}
                unread={isUnread(session)}
                isSelected={activeSessionId === session.sessionId}
                isResuming={resumingSessionId === session.sessionId}
                editingId={editingId}
                editName={editName}
                onSelect={() => onSelectSession(session.sessionId)}
                onStop={(e) => handleStop(session.sessionId, e)}
                onResume={(e) => handleResume(session.sessionId, e)}
                onDelete={(e) => handleDeleteClick(session, e)}
                onRenameStart={(e) => handleRenameStart(session, e)}
                onEditNameChange={setEditName}
                onRenameSubmit={() => handleRenameSubmit(session.sessionId)}
                onRenameKeyDown={(e) => handleRenameKeyDown(e, session.sessionId)}
                onOpenFiles={onOpenFiles ? (e) => { e.stopPropagation(); onOpenFiles(session.sessionId); } : undefined}
              />
            ))}
          </div>
        )}
      </div>

      <SessionDeleteModal
        session={deleteTarget}
        hasFiles={deleteTarget?.hasFiles ?? false}
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeleteTarget(null)}
      />
      <ProviderWizardModal
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onSave={handleSaveProvider}
      />
      <ProviderConfigModal
        open={!!configProvider}
        provider={configProvider}
        onClose={() => setConfigProvider(null)}
        onSave={handleUpdateProvider}
        onDelete={handleDeleteProvider}
      />
      <CommandPalette
        open={paletteOpen}
        sessions={sessions}
        query={paletteQuery}
        index={paletteIndex}
        onQueryChange={(q) => { setPaletteQuery(q); setPaletteIndex(0); }}
        onIndexChange={setPaletteIndex}
        onSelect={(id) => { onSelectSession(id); setPaletteOpen(false); }}
        onClose={() => setPaletteOpen(false)}
      />
    </div>
  );
}

interface CommandPaletteProps {
  open: boolean;
  sessions: Session[];
  query: string;
  index: number;
  onQueryChange: (q: string) => void;
  onIndexChange: (i: number) => void;
  onSelect: (id: string) => void;
  onClose: () => void;
}

function CommandPalette({ open, sessions, query, index, onQueryChange, onIndexChange, onSelect, onClose }: CommandPaletteProps) {
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

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      onIndexChange(Math.min(index + 1, Math.max(0, filtered.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      onIndexChange(Math.max(0, index - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filtered[index]) onSelect(filtered[index].sessionId);
    } else if (e.key === "Escape") {
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-[9998] flex items-start justify-center pt-[15vh] bg-black/50" onClick={onClose}>
      <div className="w-[min(560px,92vw)] bg-surface-alt border border-border-strong rounded-xl shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={onKey}
          placeholder="Поиск сессии… (↑↓ навигация, Enter — открыть, Esc — закрыть)"
          className="w-full px-4 py-3 bg-transparent text-foreground outline-none border-b border-border text-sm"
        />
        <div className="max-h-80 overflow-y-auto">
          {filtered.length === 0 && (
            <div className="px-4 py-6 text-center text-muted-fg text-sm">Нет активных сессий</div>
          )}
          {filtered.map((s, i) => (
            <button
              key={s.sessionId}
              onClick={() => onSelect(s.sessionId)}
              onMouseEnter={() => onIndexChange(i)}
              className={`w-full text-left px-4 py-2.5 flex items-center gap-3 cursor-pointer transition-colors ${
                i === index ? "bg-accent-hover" : "hover:bg-surface-hover"
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                s.busy ? "bg-emerald-300 ring-2 ring-emerald-400" :
                s.waiting ? "bg-amber-300 ring-2 ring-amber-400" :
                "bg-emerald-400"
              }`} />
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

function SessionItem({
  session, unread, isSelected, isResuming, editingId, editName,
  onSelect, onStop, onResume, onDelete, onRenameStart,
  onEditNameChange, onRenameSubmit, onRenameKeyDown, onOpenFiles,
}: {
  session: Session;
  unread?: boolean;
  isSelected: boolean;
  isResuming: boolean;
  editingId: string | null;
  editName: string;
  onSelect: () => void;
  onStop: (e: React.MouseEvent) => void;
  onResume: (e: React.MouseEvent) => void;
  onDelete: (e: React.MouseEvent) => void;
  onRenameStart: (e: React.MouseEvent) => void;
  onEditNameChange: (v: string) => void;
  onRenameSubmit: () => void;
  onRenameKeyDown: (e: React.KeyboardEvent) => void;
  onOpenFiles?: (e: React.MouseEvent) => void;
}) {
  const isEditing = editingId === session.sessionId;
  const ProviderIcon = getProviderIcon(session.providerSlug === "terminal" ? "terminal" : session.providerSlug === "claude" ? "claude" : session.providerSlug || "default");

  return (
    <div
      onClick={onSelect}
      className={`px-3 py-3 md:py-2.5 rounded-lg transition-all duration-150 group cursor-pointer ${
        isSelected
          ? "bg-accent-hover border border-accent-muted"
          : "hover:bg-surface-hover border border-transparent"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {isResuming ? (
            <span className="w-1.5 h-1.5 rounded-full flex-shrink-0 bg-emerald-400 animate-pulse" />
          ) : (
            <span className="relative w-1.5 h-1.5 flex-shrink-0 inline-flex items-center justify-center">
              {session.busy && session.isActive && (
                <>
                  <span className="absolute -inset-2 rounded-full bg-emerald-400/40 animate-ping" />
                  <span className="absolute -inset-1 rounded-full bg-emerald-400/30" />
                </>
              )}
              <span className={`relative w-1.5 h-1.5 rounded-full ${
                !session.isActive
                  ? "bg-muted"
                  : session.busy
                    ? "bg-emerald-300 ring-2 ring-emerald-400"
                    : unread
                      ? "bg-amber-400 shadow-sm shadow-amber-400/50"
                      : "bg-emerald-400 shadow-sm shadow-emerald-400/50"
              }`} />
            </span>
          )}
          <ProviderIcon className="w-3.5 h-3.5 text-muted-fg flex-shrink-0" />
          {isEditing ? (
            <input
              type="text"
              value={editName}
              onChange={(e) => onEditNameChange(e.target.value)}
              onBlur={onRenameSubmit}
              onKeyDown={onRenameKeyDown}
              onClick={(e) => e.stopPropagation()}
              className="text-sm text-foreground bg-surface-alt border border-border rounded px-2 py-0.5 w-full outline-none focus:border-accent"
              autoFocus
            />
          ) : (
            <span className="text-sm text-foreground truncate" title={session.displayName || session.sessionId}>
              {session.displayName || session.sessionId}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1 md:gap-0.5 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity flex-shrink-0">
          {isResuming ? (
            <div className="p-2 md:p-1">
              <div className="w-4 h-4 md:w-3.5 md:h-3.5 border-2 border-emerald-500/30 border-t-emerald-400 rounded-full animate-spin" />
            </div>
          ) : session.isActive ? (
            <button onClick={onStop} className="p-2 md:p-1 text-muted-fg hover:text-amber-400 transition-colors cursor-pointer" title="Остановить">
              <Pause className="w-4 h-4 md:w-3.5 md:h-3.5" />
            </button>
          ) : (
            <button onClick={onResume} className="p-2 md:p-1 text-muted-fg hover:text-emerald-400 transition-colors cursor-pointer" title="Возобновить">
              <Play className="w-4 h-4 md:w-3.5 md:h-3.5" />
            </button>
          )}
          {onOpenFiles && (
            <button onClick={onOpenFiles} className="p-2 md:p-1 text-muted-fg hover:text-accent-fg transition-colors cursor-pointer" title="Файлы">
              <FolderIcon className="w-4 h-4 md:w-3.5 md:h-3.5" />
            </button>
          )}
          <button onClick={onRenameStart} className="p-2 md:p-1 text-muted-fg hover:text-foreground transition-colors cursor-pointer" title="Переименовать">
            <Pencil className="w-4 h-4 md:w-3.5 md:h-3.5" />
          </button>
          <button onClick={onDelete} className="p-2 md:p-1 text-muted-fg hover:text-danger transition-colors cursor-pointer" title="Удалить">
            <Trash className="w-4 h-4 md:w-3.5 md:h-3.5" />
          </button>
        </div>
      </div>

      <div className="text-xs text-muted mt-1 pl-4 flex items-center gap-2">
        <span title={`Создана ${relativeTime(session.createdAt)}`}>{relativeTime(session.lastActivityAt || session.createdAt)}</span>
        {session.displayName && <span className="text-muted">{session.sessionId}</span>}
        <div className="ml-auto">
          <PresenceAvatars sessionId={session.sessionId} maxVisible={3} />
        </div>
      </div>
    </div>
  );
}

interface Session {
  sessionId: string;
  displayName: string | null;
  projectDir: string;
  createdAt: string;
  lastActivityAt?: string;
  isActive: boolean;
  busy?: boolean;
  waiting?: boolean;
  connectedClients: number;
  hasFiles: boolean;
  providerSlug: string;
}
