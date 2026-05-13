"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Pencil, Trash, Play, Pause, FolderIcon, Volume2, VolumeX, ChevronRight } from "@/components/Icons";
import { relativeTime } from "@/lib/utils";
import SessionDeleteModal from "@/components/SessionDeleteModal";
import PresenceAvatars from "@/components/presence/PresenceAvatars";
import ComboButton from "@/components/ComboButton";
import ProviderWizardModal from "@/components/ProviderWizardModal";
import ProviderConfigModal from "@/components/ProviderConfigModal";
import ProjectPickerModal from "@/components/pos/ProjectPickerModal";
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
  onNewSession: (providerSlug: string, projectDir?: string) => void;
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
  const [pickerOpen, setPickerOpen] = useState(false);

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
  // Cmd+K command-search state was lifted to a dashboard-page-level
  // component per `06-integration-plan-mobile.md §2.14`. The Ctrl+1..9
  // session-switch shortcut moved with it.

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

  // Global hotkeys (Cmd+K command search, Cmd/Ctrl+1..9 session switch)
  // moved to a dashboard-page-level component per
  // `06-integration-plan-mobile.md §2.14`. The new listener also scope-guards
  // `e.target` so the shortcut no longer steals from inputs/textareas/
  // contenteditable elements.

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

  // Группировка по проекту: ключ "sandbox" для песочниц в ~/projects/Claude/,
  // иначе — последний сегмент пути (basename projectDir).
  const groups = useMemo(() => {
    const SANDBOX_MARKER = "/projects/Claude/";
    const map = new Map<string, { key: string; label: string; sessions: Session[]; lastActivity: number; isSandbox: boolean }>();
    for (const s of sessions) {
      const isSandbox = s.projectDir.includes(SANDBOX_MARKER);
      const key = isSandbox ? "__sandbox__" : (s.projectDir.split("/").filter(Boolean).pop() || s.projectDir);
      const label = isSandbox ? "Сандбокс" : key;
      const existing = map.get(key);
      const ts = new Date(s.lastActivityAt || s.createdAt).getTime();
      if (existing) {
        existing.sessions.push(s);
        if (ts > existing.lastActivity) existing.lastActivity = ts;
      } else {
        map.set(key, { key, label, sessions: [s], lastActivity: ts, isSandbox });
      }
    }
    const arr = Array.from(map.values());
    // Сортировка групп: проекты по lastActivity desc, "Сандбокс" всегда внизу.
    arr.sort((a, b) => {
      if (a.isSandbox !== b.isSandbox) return a.isSandbox ? 1 : -1;
      return b.lastActivity - a.lastActivity;
    });
    // Внутри каждой группы: активные сверху, остановленные ниже, обе — по lastActivity desc.
    for (const g of arr) {
      g.sessions.sort((a, b) => {
        if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
        return byMostRecent(a, b);
      });
    }
    return arr;
  }, [sessions]);

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    if (typeof window === "undefined") return { __sandbox__: true };
    try {
      const raw = localStorage.getItem("sessionGroupCollapsed");
      if (raw) return JSON.parse(raw);
    } catch {}
    return { __sandbox__: true };
  });

  const toggleGroup = (key: string) => {
    setCollapsed((c) => {
      const next = { ...c, [key]: !c[key] };
      try { localStorage.setItem("sessionGroupCollapsed", JSON.stringify(next)); } catch {}
      return next;
    });
  };

  return (
    <div className="flex flex-col h-full">
      {/* New session button */}
      <div className="h-14 px-3 flex items-center gap-2 border-b border-border">
        <div className="flex-1 min-w-0">
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
        <button
          onClick={() => setPickerOpen(true)}
          disabled={creatingSession}
          title="Открыть сессию в существующей папке"
          className="p-2 rounded text-muted-fg hover:text-foreground hover:bg-surface-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
        >
          <FolderIcon className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-3">
        {sessions.length === 0 && (
          <p className="text-muted text-sm text-center py-8">Нет сессий</p>
        )}

        {groups.map((group, idx) => {
          const isCollapsed = !!collapsed[group.key];
          const activeCount = group.sessions.filter((s) => s.isActive).length;
          return (
            <div key={group.key}>
              <div className="px-2 py-1.5 text-xs font-medium text-muted-fg uppercase tracking-wider flex items-center justify-between">
                <button
                  onClick={() => toggleGroup(group.key)}
                  className="flex items-center gap-1.5 hover:text-foreground transition-colors cursor-pointer min-w-0"
                  title={group.isSandbox ? "Песочницы в ~/projects/Claude/" : `Сессии в проекте ${group.label}`}
                >
                  <ChevronRight
                    className={`w-3 h-3 flex-shrink-0 transition-transform ${isCollapsed ? "" : "rotate-90"}`}
                  />
                  <FolderIcon className="w-3 h-3 flex-shrink-0" />
                  <span className="truncate">{group.label}</span>
                  <span className="text-muted normal-case font-normal flex-shrink-0">
                    {activeCount > 0 ? `${activeCount}/${group.sessions.length}` : group.sessions.length}
                  </span>
                </button>
                {idx === 0 && (
                  <button
                    onClick={toggleMute}
                    className="p-1 text-muted-fg hover:text-foreground transition-colors cursor-pointer flex-shrink-0"
                    title={muted ? "Включить звук завершения" : "Отключить звук завершения"}
                    aria-label={muted ? "Unmute" : "Mute"}
                  >
                    {muted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
                  </button>
                )}
              </div>
              {!isCollapsed && group.sessions.map((session) => (
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
          );
        })}
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
      <ProjectPickerModal
        open={pickerOpen}
        providerSlug={selectedSlug}
        creating={!!creatingSession}
        onClose={() => setPickerOpen(false)}
        onCreate={(dir) => { setPickerOpen(false); onNewSession(selectedSlug, dir); }}
      />
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
