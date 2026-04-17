"use client";

import { useState, useEffect, useCallback } from "react";
import { ChevronLeft, AlertTriangle } from "@/components/Icons";
import { useSymphony } from "@/lib/SymphonyContext";

interface GlobalStats {
  orchestrator: {
    total_tokens_in: number;
    total_tokens_out: number;
    total_cost_usd: number;
    tick_count: number;
    active_agents: number;
    max_concurrent_agents: number;
  };
  tasksByStatus: { status: string; count: number }[];
  sessionsByStatus: { status: string; count: number }[];
  costByRole: {
    role_slug: string;
    total_cost: number;
    total_tokens_in: number;
    total_tokens_out: number;
    sessions: number;
  }[];
  costByProject: {
    slug: string;
    name: string;
    total_cost: number;
    sessions: number;
    total_tokens_in: number;
    total_tokens_out: number;
  }[];
  dailyCost: {
    day: string;
    cost: number;
    sessions: number;
  }[];
  recentSessions: {
    id: number;
    task_id: number;
    role_slug: string;
    status: string;
    tokens_in: number;
    tokens_out: number;
    cost_usd: number;
    started_at: string;
    finished_at: string | null;
    task_title: string;
    role_name: string;
  }[];
}

export default function CostDashboard({ onBack }: { onBack: () => void }) {
  const [stats, setStats] = useState<GlobalStats | null>(null);
  const { budgetAlerts, projects } = useSymphony();

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch("/api/symphony/v2/stats/global");
      if (res.ok) setStats(await res.json());
    } catch {}
  }, []);

  useEffect(() => { fetchStats(); }, [fetchStats]);

  if (!stats) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin h-6 w-6 border-2 border-accent border-t-transparent rounded-full" />
      </div>
    );
  }

  const { orchestrator, tasksByStatus, costByRole, costByProject, dailyCost, recentSessions } = stats;
  const maxDailyCost = Math.max(0.01, ...dailyCost.map(d => d.cost));
  const activeAlerts = Array.from(budgetAlerts.values());

  return (
    <div className="flex flex-col h-full">
      <div className="h-12 px-4 flex items-center gap-2 border-b border-border bg-surface">
        <button onClick={onBack} className="text-muted-fg hover:text-foreground cursor-pointer">
          <ChevronLeft className="w-4 h-4" />
        </button>
        <span className="text-sm font-medium text-foreground">Расходы и статистика</span>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Budget exceeded banner */}
        {activeAlerts.length > 0 && (
          <div className="p-3 bg-danger/10 border border-danger/30 rounded-lg">
            <div className="text-xs font-medium text-danger mb-1 flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5" />
              Превышен бюджет
            </div>
            {activeAlerts.map(a => {
              const projectName = projects.find(p => p.id === a.project_id)?.name ?? `#${a.project_id}`;
              return (
                <div key={`${a.role}:${a.project_id}`} className="text-xs text-danger/80 flex gap-2 ml-5">
                  <span className="font-medium">{projectName} / {a.role}</span>
                  <span>потрачено ${a.spent.toFixed(4)} / лимит ${a.limit.toFixed(2)}</span>
                </div>
              );
            })}
          </div>
        )}

        {/* Summary cards */}
        <div className="grid grid-cols-4 gap-3">
          <div className="p-3 bg-surface rounded-lg border border-border">
            <div className="text-[10px] text-muted-fg mb-1">Общий расход</div>
            <div className="text-lg font-medium text-foreground">${orchestrator.total_cost_usd.toFixed(2)}</div>
          </div>
          <div className="p-3 bg-surface rounded-lg border border-border">
            <div className="text-[10px] text-muted-fg mb-1">Токены IN</div>
            <div className="text-lg font-medium text-foreground">{(orchestrator.total_tokens_in / 1000).toFixed(1)}K</div>
          </div>
          <div className="p-3 bg-surface rounded-lg border border-border">
            <div className="text-[10px] text-muted-fg mb-1">Токены OUT</div>
            <div className="text-lg font-medium text-foreground">{(orchestrator.total_tokens_out / 1000).toFixed(1)}K</div>
          </div>
          <div className="p-3 bg-surface rounded-lg border border-border">
            <div className="text-[10px] text-muted-fg mb-1">Тиков</div>
            <div className="text-lg font-medium text-foreground">{orchestrator.tick_count}</div>
          </div>
        </div>

        {/* Daily cost trend */}
        {dailyCost.length > 0 && (
          <div className="p-3 bg-surface rounded-lg border border-border">
            <div className="text-xs font-medium text-foreground mb-2">Расход по дням (14 дней)</div>
            <div className="flex items-end gap-1 h-24">
              {dailyCost.map(d => (
                <div key={d.day} className="flex-1 flex flex-col items-center gap-0.5" title={`${d.day}: $${d.cost.toFixed(2)} (${d.sessions} сессий)`}>
                  <div
                    className="w-full bg-accent/80 rounded-t min-h-[2px] transition-all"
                    style={{ height: `${Math.max(2, (d.cost / maxDailyCost) * 80)}px` }}
                  />
                  <span className="text-[7px] text-muted">{d.day.slice(5)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Tasks by status */}
        <div className="p-3 bg-surface rounded-lg border border-border">
          <div className="text-xs font-medium text-foreground mb-2">Задачи по статусу</div>
          <div className="flex flex-wrap gap-2">
            {tasksByStatus.map(s => (
              <div key={s.status} className="px-2 py-1 bg-surface-alt rounded text-xs">
                <span className="text-muted-fg">{s.status}: </span>
                <span className="text-foreground font-medium">{s.count}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          {/* Cost by role */}
          <div className="p-3 bg-surface rounded-lg border border-border">
            <div className="text-xs font-medium text-foreground mb-2">Расходы по ролям</div>
            <div className="space-y-1.5">
              {costByRole.map(r => (
                <div key={r.role_slug} className="flex items-center gap-2 text-xs">
                  <span className="w-24 text-foreground truncate">{r.role_slug}</span>
                  <div className="flex-1 bg-surface-alt rounded-full h-2 overflow-hidden">
                    <div
                      className="h-full bg-accent rounded-full"
                      style={{ width: `${Math.min(100, (r.total_cost / Math.max(1, orchestrator.total_cost_usd)) * 100)}%` }}
                    />
                  </div>
                  <span className="w-14 text-right text-muted-fg">${(r.total_cost || 0).toFixed(2)}</span>
                  <span className="w-12 text-right text-muted-fg">{r.sessions}</span>
                </div>
              ))}
              {costByRole.map(r => {
                const isOverBudget = activeAlerts.some(a => a.role === r.role_slug);
                return (
                  <div key={r.role_slug} className="flex items-center gap-2 text-xs">
                    <span className={`w-24 truncate flex items-center gap-1 ${isOverBudget ? "text-danger font-medium" : "text-foreground"}`}>
                      {isOverBudget && <AlertTriangle className="w-3 h-3 flex-shrink-0" />}
                      {r.role_slug}
                    </span>
                    <div className="flex-1 bg-surface-alt rounded-full h-2 overflow-hidden">
                      <div
                        className={`h-full rounded-full ${isOverBudget ? "bg-danger" : "bg-accent"}`}
                        style={{ width: `${Math.min(100, (r.total_cost / Math.max(1, orchestrator.total_cost_usd)) * 100)}%` }}
                      />
                    </div>
                    <span className={`w-14 text-right ${isOverBudget ? "text-danger" : "text-muted-fg"}`}>${(r.total_cost || 0).toFixed(2)}</span>
                    <span className="w-12 text-right text-muted-fg">{r.sessions}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Cost by project */}
          {costByProject && costByProject.length > 0 && (
            <div className="p-3 bg-surface rounded-lg border border-border">
              <div className="text-xs font-medium text-foreground mb-2">Расходы по проектам</div>
              <div className="space-y-1.5">
                {costByProject.map(p => (
                  <div key={p.slug} className="flex items-center gap-2 text-xs">
                    <span className="w-24 text-foreground truncate">{p.name}</span>
                    <div className="flex-1 bg-surface-alt rounded-full h-2 overflow-hidden">
                      <div
                        className="h-full bg-success rounded-full"
                        style={{ width: `${Math.min(100, (p.total_cost / Math.max(1, orchestrator.total_cost_usd)) * 100)}%` }}
                      />
                    </div>
                    <span className="w-14 text-right text-muted-fg">${(p.total_cost || 0).toFixed(2)}</span>
                    <span className="w-12 text-right text-muted-fg">{p.sessions}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Recent sessions */}
        <div className="p-3 bg-surface rounded-lg border border-border">
          <div className="text-xs font-medium text-foreground mb-2">Последние сессии</div>
          <div className="space-y-1">
            {recentSessions.map(s => (
              <div key={s.id} className="flex items-center gap-2 text-[10px] py-1 border-b border-border/30 last:border-0">
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                  s.status === "completed" ? "bg-success" :
                  s.status === "failed" ? "bg-danger" :
                  s.status === "running" ? "bg-accent animate-pulse" : "bg-muted"
                }`} />
                <span className="w-20 text-foreground truncate">{s.role_name || s.role_slug}</span>
                <span className="flex-1 text-muted-fg truncate">{s.task_title}</span>
                {s.cost_usd > 0 && <span className="text-muted-fg">${s.cost_usd.toFixed(3)}</span>}
                <span className="text-muted-fg">
                  {new Date(s.started_at + "Z").toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}
                </span>
                <span className={`w-16 text-right ${
                  s.status === "completed" ? "text-success" :
                  s.status === "failed" ? "text-danger" :
                  s.status === "running" ? "text-accent-fg" : "text-muted-fg"
                }`}>{s.status}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
