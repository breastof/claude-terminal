"use client";

import { useState, useEffect } from "react";
import { Monitor, RefreshCw, GitBranch } from "@/components/Icons";

interface SystemStatus {
  hub: { dirty: boolean; lastCommit: string; lastPush?: string };
  dotfiles: { dirty: boolean; lastCommit: string; lastPush?: string };
  orphans: { count: number; entries: { key: string; size: string }[] };
  cron: { name: string; lastRun: string; ok: boolean }[];
}

export default function SystemPanel() {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncingHub, setSyncingHub] = useState(false);
  const [syncingDotfiles, setSyncingDotfiles] = useState(false);

  const fetchStatus = async () => {
    try {
      const res = await fetch("/api/system/status");
      if (res.ok) {
        const data = await res.json();
        setStatus(data);
      }
    } catch {} finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 60000);
    return () => clearInterval(interval);
  }, []);

  const handleSyncHub = async () => {
    setSyncingHub(true);
    try {
      await fetch("/api/system/git/hub/sync", { method: "POST" });
      fetchStatus();
    } catch {} finally {
      setSyncingHub(false);
    }
  };

  const handleSyncDotfiles = async () => {
    setSyncingDotfiles(true);
    try {
      await fetch("/api/system/git/dotfiles/sync", { method: "POST" });
      fetchStatus();
    } catch {} finally {
      setSyncingDotfiles(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="h-14 px-3 flex items-center justify-between border-b border-border">
        <div className="flex items-center gap-2">
          <Monitor className="w-4 h-4 text-accent-fg" />
          <span className="text-sm font-medium">Система</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin h-5 w-5 border-2 border-accent border-t-transparent rounded-full" />
          </div>
        ) : status ? (
          <>
            {/* Hub git */}
            <div className="p-3 bg-surface-alt rounded-lg border border-border">
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-1.5">
                  <GitBranch className="w-3.5 h-3.5 text-muted-fg" />
                  <span className="text-xs font-medium">Hub</span>
                </div>
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                  status.hub.dirty ? "bg-warning/20 text-warning" : "bg-success/20 text-success"
                }`}>
                  {status.hub.dirty ? "изменён" : "чисто"}
                </span>
              </div>
              <div className="text-[10px] text-muted mb-2">{status.hub.lastCommit || "—"}</div>
              <button
                onClick={handleSyncHub}
                disabled={syncingHub}
                className="w-full text-xs py-1 bg-surface border border-border rounded text-muted-fg hover:text-foreground transition-colors cursor-pointer disabled:opacity-50"
              >
                {syncingHub ? "Синхр..." : "Синхр. Hub"}
              </button>
            </div>

            {/* Dotfiles git */}
            <div className="p-3 bg-surface-alt rounded-lg border border-border">
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-1.5">
                  <GitBranch className="w-3.5 h-3.5 text-muted-fg" />
                  <span className="text-xs font-medium">Dotfiles</span>
                </div>
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                  status.dotfiles.dirty ? "bg-warning/20 text-warning" : "bg-success/20 text-success"
                }`}>
                  {status.dotfiles.dirty ? "изменён" : "чисто"}
                </span>
              </div>
              <div className="text-[10px] text-muted mb-2">{status.dotfiles.lastCommit || "—"}</div>
              <button
                onClick={handleSyncDotfiles}
                disabled={syncingDotfiles}
                className="w-full text-xs py-1 bg-surface border border-border rounded text-muted-fg hover:text-foreground transition-colors cursor-pointer disabled:opacity-50"
              >
                {syncingDotfiles ? "Синхр..." : "Синхр. Dotfiles"}
              </button>
            </div>

            {/* Orphans */}
            {status.orphans.count > 0 && (
              <div className="p-3 bg-danger/5 rounded-lg border border-danger/20">
                <div className="text-xs font-medium text-danger">{status.orphans.count} потерянных директорий</div>
                <div className="text-[10px] text-muted mt-1">Очистка в панели системы</div>
              </div>
            )}

            {/* Cron */}
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-muted-fg px-1">Крон-задачи</div>
              {status.cron.map((job) => (
                <div key={job.name} className="flex items-center justify-between px-2 py-1.5 bg-surface-alt rounded text-[10px]">
                  <span className="text-foreground">{job.name}</span>
                  <div className="flex items-center gap-1.5">
                    <span className="text-muted">{job.lastRun || "никогда"}</span>
                    <span className={`w-1.5 h-1.5 rounded-full ${job.ok ? "bg-success" : "bg-danger"}`} />
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <p className="text-muted text-sm text-center py-8">Не удалось загрузить статус</p>
        )}
      </div>
    </div>
  );
}
