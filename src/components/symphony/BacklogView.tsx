"use client";

import { useState, useEffect, useCallback } from "react";
import { ChevronLeft } from "@/components/Icons";
import { useSymphony, type Task } from "@/lib/SymphonyContext";

interface Sprint {
  id: number;
  name: string;
  status: string;
}

const EFFORT_POINTS: Record<string, number> = { xs: 1, s: 2, m: 5, l: 8, xl: 13 };

export default function BacklogView({ slug }: { slug: string }) {
  const { setView, roles } = useSymphony();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [sprints, setSprints] = useState<Sprint[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTasks, setSelectedTasks] = useState<Set<number>>(new Set());
  const [sortBy, setSortBy] = useState<"priority" | "created" | "effort">("priority");

  const fetchBacklog = useCallback(async () => {
    try {
      const res = await fetch(`/api/symphony/v2/projects/${slug}/tasks?status=backlog`);
      if (res.ok) {
        const data = await res.json();
        setTasks(data.tasks || []);
      }
    } catch {} finally { setLoading(false); }
  }, [slug]);

  const fetchSprints = useCallback(async () => {
    try {
      const res = await fetch(`/api/symphony/v2/projects/${slug}/sprints`);
      if (res.ok) {
        const data = await res.json();
        setSprints((data.sprints || []).filter((s: Sprint) => s.status !== "completed"));
      }
    } catch {}
  }, [slug]);

  useEffect(() => { fetchBacklog(); fetchSprints(); }, [fetchBacklog, fetchSprints]);

  const sorted = [...tasks].sort((a, b) => {
    if (sortBy === "priority") return b.priority - a.priority;
    if (sortBy === "effort") return (EFFORT_POINTS[b.estimated_effort || ""] || 0) - (EFFORT_POINTS[a.estimated_effort || ""] || 0);
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  const toggleSelect = (id: number) => {
    setSelectedTasks(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleMoveToSprint = async (sprintId: number) => {
    for (const id of selectedTasks) {
      const task = tasks.find(t => t.id === id);
      if (!task) continue;
      await fetch(`/api/symphony/v2/projects/${slug}/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sprint_id: sprintId, version: task.version }),
      });
    }
    setSelectedTasks(new Set());
    fetchBacklog();
  };

  const totalPoints = sorted.reduce((sum, t) => sum + (EFFORT_POINTS[t.estimated_effort || ""] || 0), 0);
  const selectedPoints = [...selectedTasks].reduce((sum, id) => {
    const t = tasks.find(t => t.id === id);
    return sum + (EFFORT_POINTS[t?.estimated_effort || ""] || 0);
  }, 0);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin h-6 w-6 border-2 border-accent border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="h-12 px-4 flex items-center justify-between border-b border-border bg-surface">
        <div className="flex items-center gap-2">
          <button onClick={() => setView({ type: "project", slug })} className="text-muted-fg hover:text-foreground cursor-pointer">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="text-sm font-medium text-foreground">Бэклог</span>
          <span className="text-[10px] text-muted bg-surface-alt px-1.5 rounded">{tasks.length} задач</span>
          <span className="text-[10px] text-muted bg-surface-alt px-1.5 rounded">{totalPoints} SP</span>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={sortBy}
            onChange={e => setSortBy(e.target.value as typeof sortBy)}
            className="px-2 py-1 text-xs bg-surface-alt border border-border rounded text-foreground outline-none"
          >
            <option value="priority">По приоритету</option>
            <option value="effort">По объёму</option>
            <option value="created">По дате</option>
          </select>
        </div>
      </div>

      {/* Bulk move bar */}
      {selectedTasks.size > 0 && (
        <div className="px-4 py-2 border-b border-border bg-accent/5 flex items-center gap-3 text-xs">
          <span className="text-foreground font-medium">Выбрано: {selectedTasks.size} ({selectedPoints} SP)</span>
          <select
            onChange={e => { if (e.target.value) handleMoveToSprint(Number(e.target.value)); e.target.value = ""; }}
            className="px-2 py-0.5 bg-surface border border-border rounded text-foreground outline-none text-xs"
          >
            <option value="">В спринт...</option>
            {sprints.map(s => <option key={s.id} value={s.id}>{s.name} ({s.status})</option>)}
          </select>
          <button
            onClick={() => setSelectedTasks(new Set())}
            className="text-muted-fg hover:text-foreground cursor-pointer"
          >
            Отменить
          </button>
        </div>
      )}

      {/* Task table */}
      <div className="flex-1 overflow-y-auto">
        {sorted.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="text-2xl mb-2">📋</div>
            <div className="text-sm text-foreground">Бэклог пуст</div>
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-surface border-b border-border">
              <tr className="text-left text-[10px] text-muted-fg">
                <th className="px-3 py-2 w-8">
                  <input
                    type="checkbox"
                    checked={selectedTasks.size === sorted.length && sorted.length > 0}
                    onChange={() => {
                      if (selectedTasks.size === sorted.length) setSelectedTasks(new Set());
                      else setSelectedTasks(new Set(sorted.map(t => t.id)));
                    }}
                    className="rounded"
                  />
                </th>
                <th className="px-2 py-2 w-12">#</th>
                <th className="px-2 py-2 w-16">Тип</th>
                <th className="px-2 py-2">Название</th>
                <th className="px-2 py-2 w-16">Приор.</th>
                <th className="px-2 py-2 w-16">Объём</th>
                <th className="px-2 py-2 w-24">Роль</th>
                <th className="px-2 py-2 w-20">Дата</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(task => {
                const tags: string[] = (() => { try { return JSON.parse(task.tags); } catch { return []; } })();
                return (
                  <tr
                    key={task.id}
                    className={`border-b border-border/30 hover:bg-surface-alt/30 transition-colors ${
                      selectedTasks.has(task.id) ? "bg-accent/5" : ""
                    }`}
                  >
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={selectedTasks.has(task.id)}
                        onChange={() => toggleSelect(task.id)}
                        className="rounded"
                      />
                    </td>
                    <td className="px-2 py-2 text-muted-fg">{task.id}</td>
                    <td className="px-2 py-2">
                      <span className="text-[9px] px-1 rounded bg-purple-500/10 text-purple-400">{task.type}</span>
                    </td>
                    <td className="px-2 py-2">
                      <button
                        onClick={() => setView({ type: "task", slug, taskId: task.id })}
                        className="text-foreground hover:text-accent-fg cursor-pointer text-left"
                      >
                        {task.title}
                      </button>
                      {tags.length > 0 && (
                        <div className="flex gap-1 mt-0.5">
                          {tags.slice(0, 3).map(t => (
                            <span key={t} className="text-[8px] px-1 bg-surface-alt rounded text-muted-fg">{t}</span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="px-2 py-2">
                      <div className="flex items-center gap-1">
                        <div className={`w-2 h-2 rounded-full ${
                          task.priority >= 80 ? "bg-danger" : task.priority >= 50 ? "bg-warning" : "bg-muted"
                        }`} />
                        <span className="text-muted-fg">{task.priority}</span>
                      </div>
                    </td>
                    <td className="px-2 py-2 text-muted-fg">{task.estimated_effort?.toUpperCase() || "—"}</td>
                    <td className="px-2 py-2 text-muted-fg truncate">{task.assigned_role || "—"}</td>
                    <td className="px-2 py-2 text-muted">
                      {new Date(task.created_at + "Z").toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
