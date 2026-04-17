"use client";

import { useState, useEffect, useCallback } from "react";
import { Pencil, Trash, Play, Pause, FolderIcon } from "@/components/Icons";
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
  isActive: boolean;
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

  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch("/api/sessions");
      if (res.ok) {
        const data = await res.json();
        setSessions(data.sessions);
      }
    } catch {}
  }, []);

  useEffect(() => {
    fetchSessions();
    const interval = setInterval(fetchSessions, 5000);
    return () => clearInterval(interval);
  }, [fetchSessions]);

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

  const byNewest = (a: Session, b: Session) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  const activeSessions = sessions.filter((s) => s.isActive).sort(byNewest);
  const stoppedSessions = sessions.filter((s) => !s.isActive).sort(byNewest);

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
            <div className="px-2 py-1.5 text-xs font-medium text-muted-fg uppercase tracking-wider">Активные</div>
            {activeSessions.map((session) => (
              <SessionItem
                key={session.sessionId}
                session={session}
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
    </div>
  );
}

function SessionItem({
  session, isSelected, isResuming, editingId, editName,
  onSelect, onStop, onResume, onDelete, onRenameStart,
  onEditNameChange, onRenameSubmit, onRenameKeyDown, onOpenFiles,
}: {
  session: Session;
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
            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
              session.isActive ? "bg-emerald-400 shadow-sm shadow-emerald-400/50" : "bg-muted"
            }`} />
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
            <span className="text-sm text-foreground truncate">
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
        <span>{relativeTime(session.createdAt)}</span>
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
  isActive: boolean;
  connectedClients: number;
  hasFiles: boolean;
  providerSlug: string;
}
