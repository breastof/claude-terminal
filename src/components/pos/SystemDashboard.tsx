"use client";

import { useState, useEffect } from "react";
import { RefreshCw, GitBranch, Trash, Monitor } from "@/components/Icons";

interface SystemHealth {
  hub: { dirty: boolean; lastCommit: string; dirtyFiles: number };
  dotfiles: { dirty: boolean; lastCommit: string; dirtyFiles: number };
  orphans: { count: number; entries: { key: string; size: string }[] };
  cron: { name: string; schedule: string; lastRun: string; ok: boolean }[];
  disk: { hub: string; claude: string; sessions: string };
  contentMap: {
    projects: { name: string; path: string; hasClaude: boolean }[];
    sessions: { total: number; active: number; orphanMemory: number };
  };
}

export default function SystemDashboard() {
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncingHub, setSyncingHub] = useState(false);
  const [syncingDotfiles, setSyncingDotfiles] = useState(false);
  const [cleaningOrphans, setCleaningOrphans] = useState(false);
  const [selectedOrphans, setSelectedOrphans] = useState<Set<string>>(new Set());

  const fetchHealth = async () => {
    try {
      const res = await fetch("/api/system/status");
      if (res.ok) {
        const data = await res.json();
        setHealth(data);
      }
    } catch {} finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchHealth(); }, []);

  const handleSyncHub = async () => {
    setSyncingHub(true);
    try { await fetch("/api/system/git/hub/sync", { method: "POST" }); fetchHealth(); } catch {} finally { setSyncingHub(false); }
  };

  const handleSyncDotfiles = async () => {
    setSyncingDotfiles(true);
    try { await fetch("/api/system/git/dotfiles/sync", { method: "POST" }); fetchHealth(); } catch {} finally { setSyncingDotfiles(false); }
  };

  const handleCleanOrphans = async () => {
    if (selectedOrphans.size === 0) return;
    setCleaningOrphans(true);
    try {
      await fetch("/api/system/orphans/cleanup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keys: [...selectedOrphans] }),
      });
      setSelectedOrphans(new Set());
      fetchHealth();
    } catch {} finally {
      setCleaningOrphans(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin h-6 w-6 border-2 border-accent border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!health) {
    return <div className="flex items-center justify-center h-full text-muted-fg text-sm">Не удалось загрузить статус</div>;
  }

  return (
    <div className="flex flex-col h-full">
      <div className="h-12 px-4 flex items-center justify-between border-b border-border bg-surface">
        <div className="flex items-center gap-2">
          <Monitor className="w-4 h-4 text-accent-fg" />
          <span className="text-sm font-medium text-foreground">Панель системы</span>
        </div>
        <button onClick={fetchHealth} className="p-1.5 text-muted-fg hover:text-foreground transition-colors cursor-pointer" title="Обновить">
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 flex justify-center">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-5xl w-full">
          {/* Git Sync */}
          <div className="p-4 bg-surface rounded-xl border border-border">
            <div className="text-xs font-medium text-muted-fg uppercase tracking-wider mb-3">Синхронизация Git</div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <GitBranch className="w-4 h-4 text-muted-fg" />
                  <span className="text-sm text-foreground">Hub</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${health.hub.dirty ? "bg-warning/20 text-warning" : "bg-success/20 text-success"}`}>
                    {health.hub.dirty ? `${health.hub.dirtyFiles} изм.` : "чисто"}
                  </span>
                  <button onClick={handleSyncHub} disabled={syncingHub} className="text-xs text-accent-fg hover:underline cursor-pointer disabled:opacity-50">
                    {syncingHub ? "Синхр..." : "Синхр."}
                  </button>
                </div>
              </div>
              <div className="text-[10px] text-muted pl-6">{health.hub.lastCommit}</div>

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <GitBranch className="w-4 h-4 text-muted-fg" />
                  <span className="text-sm text-foreground">Dotfiles</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${health.dotfiles.dirty ? "bg-warning/20 text-warning" : "bg-success/20 text-success"}`}>
                    {health.dotfiles.dirty ? `${health.dotfiles.dirtyFiles} изм.` : "чисто"}
                  </span>
                  <button onClick={handleSyncDotfiles} disabled={syncingDotfiles} className="text-xs text-accent-fg hover:underline cursor-pointer disabled:opacity-50">
                    {syncingDotfiles ? "Синхр..." : "Синхр."}
                  </button>
                </div>
              </div>
              <div className="text-[10px] text-muted pl-6">{health.dotfiles.lastCommit}</div>
            </div>
          </div>

          {/* Disk Usage */}
          <div className="p-4 bg-surface rounded-xl border border-border">
            <div className="text-xs font-medium text-muted-fg uppercase tracking-wider mb-3">Диск</div>
            <div className="space-y-2">
              {[
                { label: "Hub", value: health.disk.hub },
                { label: ".claude", value: health.disk.claude },
                { label: "Сессии", value: health.disk.sessions },
              ].map(({ label, value }) => (
                <div key={label} className="flex items-center justify-between">
                  <span className="text-sm text-foreground">{label}</span>
                  <span className="text-sm font-mono text-muted-fg">{value}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Cron Monitor */}
          <div className="p-4 bg-surface rounded-xl border border-border">
            <div className="text-xs font-medium text-muted-fg uppercase tracking-wider mb-3">Крон-задачи</div>
            <div className="space-y-2">
              {health.cron.map((job) => (
                <div key={job.name} className="flex items-center justify-between">
                  <div>
                    <div className="text-sm text-foreground">{job.name}</div>
                    <div className="text-[10px] text-muted">{job.schedule}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-muted">{job.lastRun || "никогда"}</span>
                    <span className={`w-2 h-2 rounded-full ${job.ok ? "bg-success" : "bg-danger"}`} />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Content Map */}
          <div className="p-4 bg-surface rounded-xl border border-border">
            <div className="text-xs font-medium text-muted-fg uppercase tracking-wider mb-3">Карта контента</div>
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-foreground">Проекты</span>
                <span className="text-muted-fg">{health.contentMap.projects.length}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-foreground">Сессии</span>
                <span className="text-muted-fg">{health.contentMap.sessions.total} ({health.contentMap.sessions.active} акт.)</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-foreground">Потерянная память</span>
                <span className={health.contentMap.sessions.orphanMemory > 0 ? "text-danger" : "text-muted-fg"}>
                  {health.contentMap.sessions.orphanMemory}
                </span>
              </div>
            </div>
          </div>

          {/* Orphan Cleanup */}
          {health.orphans.count > 0 && (
            <div className="md:col-span-2 p-4 bg-surface rounded-xl border border-danger/20">
              <div className="flex items-center justify-between mb-3">
                <div className="text-xs font-medium text-danger uppercase tracking-wider">Потерянная память ({health.orphans.count})</div>
                <button
                  onClick={handleCleanOrphans}
                  disabled={selectedOrphans.size === 0 || cleaningOrphans}
                  className="flex items-center gap-1.5 px-3 py-1 text-xs bg-danger text-white rounded-md hover:bg-danger/90 transition-colors cursor-pointer disabled:opacity-50"
                >
                  <Trash className="w-3 h-3" />
                  {cleaningOrphans ? "Очистка..." : `Удалить ${selectedOrphans.size}`}
                </button>
              </div>
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {health.orphans.entries.map((entry) => (
                  <label key={entry.key} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-surface-hover cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedOrphans.has(entry.key)}
                      onChange={(e) => {
                        const next = new Set(selectedOrphans);
                        e.target.checked ? next.add(entry.key) : next.delete(entry.key);
                        setSelectedOrphans(next);
                      }}
                      className="accent-accent"
                    />
                    <span className="text-xs font-mono text-foreground truncate flex-1">{entry.key}</span>
                    <span className="text-[10px] text-muted flex-shrink-0">{entry.size}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
