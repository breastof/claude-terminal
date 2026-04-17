"use client";

import { useState, useEffect, useCallback } from "react";
import { ChevronLeft } from "@/components/Icons";
import { useSymphony } from "@/lib/SymphonyContext";

interface ProjectStats {
  total_tasks: number;
  by_status: { status: string; count: number }[];
  by_type: { type: string; count: number }[];
  by_role: { assigned_role: string; count: number }[];
  done_count: number;
  avg_cycle_hours: number | null;
  recent_activity: {
    id: number;
    task_id: number;
    action: string;
    old_value: string | null;
    new_value: string | null;
    actor_type: string;
    actor_id: string | null;
    created_at: string;
  }[];
}

const STATUS_COLORS: Record<string, string> = {
  backlog: "#71717a", analysis: "#f59e0b", design: "#ec4899",
  development: "#3b82f6", code_review: "#f97316", qa: "#14b8a6",
  uat: "#a855f7", done: "#22c55e", pending_cancel: "#f43f5e",
  cancelled: "#ef4444",
};

export default function ProjectOverview({ slug }: { slug: string }) {
  const { setView, orchestratorStatus } = useSymphony();
  const [stats, setStats] = useState<ProjectStats | null>(null);
  const [projectName, setProjectName] = useState(slug);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch(`/api/symphony/v2/projects/${slug}/stats`);
      if (res.ok) {
        const data = await res.json();
        setStats(data);
      }
    } catch {}
  }, [slug]);

  const fetchProject = useCallback(async () => {
    try {
      const res = await fetch(`/api/symphony/v2/projects/${slug}`);
      if (res.ok) {
        const data = await res.json();
        setProjectName(data.project?.name || slug);
      }
    } catch {}
  }, [slug]);

  useEffect(() => {
    fetchStats();
    fetchProject();
  }, [fetchStats, fetchProject]);

  if (!stats) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin h-6 w-6 border-2 border-accent border-t-transparent rounded-full" />
      </div>
    );
  }

  const completionRate = stats.total_tasks > 0
    ? Math.round((stats.done_count / stats.total_tasks) * 100)
    : 0;

  const maxStatusCount = Math.max(1, ...stats.by_status.map(s => s.count));

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="h-12 px-4 flex items-center gap-2 border-b border-border bg-surface">
        <button onClick={() => setView({ type: "project", slug })} className="text-muted-fg hover:text-foreground cursor-pointer">
          <ChevronLeft className="w-4 h-4" />
        </button>
        <span className="text-sm font-medium text-foreground">{projectName} — Обзор</span>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Metric cards */}
        <div className="grid grid-cols-4 gap-3">
          <div className="p-3 bg-surface rounded-lg border border-border">
            <div className="text-[10px] text-muted-fg mb-1">Всего задач</div>
            <div className="text-xl font-medium text-foreground">{stats.total_tasks}</div>
          </div>
          <div className="p-3 bg-surface rounded-lg border border-border">
            <div className="text-[10px] text-muted-fg mb-1">Завершено</div>
            <div className="text-xl font-medium text-success">{completionRate}%</div>
            <div className="w-full bg-surface-alt rounded-full h-1.5 mt-1">
              <div className="h-full bg-success rounded-full transition-all" style={{ width: `${completionRate}%` }} />
            </div>
          </div>
          <div className="p-3 bg-surface rounded-lg border border-border">
            <div className="text-[10px] text-muted-fg mb-1">Активных агентов</div>
            <div className="text-xl font-medium text-foreground">
              {orchestratorStatus?.active_agents || 0}/{orchestratorStatus?.max_concurrent_agents || 5}
            </div>
          </div>
          <div className="p-3 bg-surface rounded-lg border border-border">
            <div className="text-[10px] text-muted-fg mb-1">Ср. цикл</div>
            <div className="text-xl font-medium text-foreground">
              {stats.avg_cycle_hours ? `${stats.avg_cycle_hours.toFixed(1)}ч` : "—"}
            </div>
          </div>
        </div>

        {/* Status distribution */}
        <div className="p-3 bg-surface rounded-lg border border-border">
          <div className="text-xs font-medium text-foreground mb-3">Распределение по статусу</div>
          <div className="space-y-2">
            {stats.by_status.map(s => (
              <div key={s.status} className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full" style={{ backgroundColor: STATUS_COLORS[s.status] || "#71717a" }} />
                <span className="w-24 text-xs text-foreground">{s.status}</span>
                <div className="flex-1 bg-surface-alt rounded-full h-3 overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{
                      width: `${(s.count / maxStatusCount) * 100}%`,
                      backgroundColor: STATUS_COLORS[s.status] || "#71717a",
                    }}
                  />
                </div>
                <span className="w-8 text-right text-xs font-medium text-foreground">{s.count}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          {/* By type */}
          <div className="p-3 bg-surface rounded-lg border border-border">
            <div className="text-xs font-medium text-foreground mb-2">По типу</div>
            <div className="space-y-1">
              {stats.by_type.map(t => (
                <div key={t.type} className="flex items-center justify-between text-xs">
                  <span className="text-foreground">{t.type}</span>
                  <span className="text-muted-fg font-medium">{t.count}</span>
                </div>
              ))}
            </div>
          </div>

          {/* By role */}
          <div className="p-3 bg-surface rounded-lg border border-border">
            <div className="text-xs font-medium text-foreground mb-2">По роли</div>
            <div className="space-y-1">
              {stats.by_role.map(r => (
                <div key={r.assigned_role || "none"} className="flex items-center justify-between text-xs">
                  <span className="text-foreground">{r.assigned_role || "не назначено"}</span>
                  <span className="text-muted-fg font-medium">{r.count}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Recent activity */}
        <div className="p-3 bg-surface rounded-lg border border-border">
          <div className="text-xs font-medium text-foreground mb-2">Последняя активность</div>
          <div className="space-y-1">
            {stats.recent_activity?.length === 0 && (
              <div className="text-xs text-muted-fg text-center py-2">Нет активности</div>
            )}
            {stats.recent_activity?.map(a => (
              <div key={a.id} className="flex items-center gap-2 py-1 border-b border-border/30 last:border-0 text-[10px]">
                <span className="text-foreground">{a.action}</span>
                {a.old_value && <span className="text-muted-fg">{a.old_value}</span>}
                {a.old_value && a.new_value && <span className="text-muted">→</span>}
                {a.new_value && <span className="text-foreground">{a.new_value}</span>}
                <span className="text-muted ml-auto">{a.actor_type}:{a.actor_id}</span>
                <span className="text-muted">
                  {new Date(a.created_at + "Z").toLocaleString("ru-RU", { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" })}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
