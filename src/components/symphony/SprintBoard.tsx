"use client";

import { useState, useEffect, useCallback } from "react";
import { ChevronLeft, Plus } from "@/components/Icons";
import { useSymphony, type Task } from "@/lib/SymphonyContext";

interface Sprint {
  id: number;
  project_id: number;
  name: string;
  goal: string;
  status: string;
  start_date: string | null;
  end_date: string | null;
  task_count: number;
  done_count: number;
  total_points: number | null;
  done_points: number | null;
  created_at: string;
}

const SPRINT_STATUS_STYLES: Record<string, { label: string; class: string }> = {
  planning: { label: "Планирование", class: "bg-blue-500/10 text-blue-400" },
  active: { label: "Активный", class: "bg-success/10 text-success" },
  review: { label: "Ревью", class: "bg-orange-500/10 text-orange-400" },
  completed: { label: "Завершён", class: "bg-gray-500/10 text-gray-400" },
};

export default function SprintBoard({ slug }: { slug: string }) {
  const { setView } = useSymphony();
  const [sprints, setSprints] = useState<Sprint[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newGoal, setNewGoal] = useState("");
  const [newStart, setNewStart] = useState("");
  const [newEnd, setNewEnd] = useState("");
  const [expandedSprint, setExpandedSprint] = useState<number | null>(null);
  const [sprintTasks, setSprintTasks] = useState<Task[]>([]);

  const fetchSprints = useCallback(async () => {
    try {
      const res = await fetch(`/api/symphony/v2/projects/${slug}/sprints`);
      if (res.ok) {
        const data = await res.json();
        setSprints(data.sprints || []);
      }
    } catch {} finally { setLoading(false); }
  }, [slug]);

  useEffect(() => { fetchSprints(); }, [fetchSprints]);

  const fetchSprintTasks = async (sprintId: number) => {
    try {
      const res = await fetch(`/api/symphony/v2/projects/${slug}/sprints/${sprintId}`);
      if (res.ok) {
        const data = await res.json();
        setSprintTasks(data.tasks || []);
      }
    } catch {}
  };

  const handleCreate = async () => {
    if (!newName.trim()) return;
    await fetch(`/api/symphony/v2/projects/${slug}/sprints`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: newName.trim(),
        goal: newGoal.trim(),
        start_date: newStart || null,
        end_date: newEnd || null,
      }),
    });
    setNewName(""); setNewGoal(""); setNewStart(""); setNewEnd("");
    setCreating(false);
    fetchSprints();
  };

  const handleStatusChange = async (sprintId: number, status: string) => {
    // When completing, find the next planning sprint to move tasks to
    let nextSprintId: number | undefined;
    if (status === "completed") {
      const next = sprints.find(s => s.id !== sprintId && s.status === "planning");
      nextSprintId = next?.id;
    }

    await fetch(`/api/symphony/v2/projects/${slug}/sprints/${sprintId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, next_sprint_id: nextSprintId }),
    });
    fetchSprints();
  };

  const handleDeleteSprint = async (sprintId: number) => {
    if (!confirm("Удалить спринт? Задачи вернутся в бэклог.")) return;
    await fetch(`/api/symphony/v2/projects/${slug}/sprints/${sprintId}`, { method: "DELETE" });
    if (expandedSprint === sprintId) { setExpandedSprint(null); setSprintTasks([]); }
    fetchSprints();
  };

  const handleExpand = (sprintId: number) => {
    if (expandedSprint === sprintId) {
      setExpandedSprint(null);
      setSprintTasks([]);
    } else {
      setExpandedSprint(sprintId);
      fetchSprintTasks(sprintId);
    }
  };

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
          <span className="text-sm font-medium text-foreground">Спринты</span>
          <span className="text-[10px] text-muted bg-surface-alt px-1.5 rounded">{sprints.length}</span>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="flex items-center gap-1.5 px-3 py-1 text-xs bg-accent text-white rounded-md hover:bg-accent/90 cursor-pointer"
        >
          <Plus className="w-3.5 h-3.5" />
          Спринт
        </button>
      </div>

      {/* Create sprint form */}
      {creating && (
        <div className="px-4 py-3 border-b border-border bg-surface space-y-2">
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="Название спринта..."
              value={newName}
              onChange={e => setNewName(e.target.value)}
              className="flex-1 px-3 py-1.5 text-sm bg-surface-alt border border-border rounded-lg outline-none focus:border-accent text-foreground placeholder:text-muted"
              autoFocus
              onKeyDown={e => { if (e.key === "Enter") handleCreate(); if (e.key === "Escape") setCreating(false); }}
            />
          </div>
          <input
            type="text"
            placeholder="Цель спринта (опционально)..."
            value={newGoal}
            onChange={e => setNewGoal(e.target.value)}
            className="w-full px-3 py-1.5 text-xs bg-surface-alt border border-border rounded-lg outline-none focus:border-accent text-foreground placeholder:text-muted"
          />
          <div className="flex gap-2 items-center">
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-muted-fg">Начало:</span>
              <input type="date" value={newStart} onChange={e => setNewStart(e.target.value)}
                className="px-2 py-1 text-xs bg-surface-alt border border-border rounded text-foreground outline-none" />
            </div>
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-muted-fg">Конец:</span>
              <input type="date" value={newEnd} onChange={e => setNewEnd(e.target.value)}
                className="px-2 py-1 text-xs bg-surface-alt border border-border rounded text-foreground outline-none" />
            </div>
            <div className="flex-1" />
            <button onClick={handleCreate} className="px-3 py-1.5 text-xs bg-accent text-white rounded-lg hover:bg-accent/90 cursor-pointer">Создать</button>
            <button onClick={() => setCreating(false)} className="px-3 py-1.5 text-xs text-muted-fg hover:text-foreground cursor-pointer">Отмена</button>
          </div>
        </div>
      )}

      {/* Sprint list */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {sprints.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="text-2xl mb-2">🏃</div>
            <div className="text-sm text-foreground mb-1">Нет спринтов</div>
            <div className="text-xs text-muted-fg">Создайте первый спринт для организации задач</div>
          </div>
        ) : sprints.map(sprint => {
          const style = SPRINT_STATUS_STYLES[sprint.status] || SPRINT_STATUS_STYLES.planning;
          const progress = sprint.task_count > 0 ? Math.round((sprint.done_count / sprint.task_count) * 100) : 0;
          const isExpanded = expandedSprint === sprint.id;

          return (
            <div key={sprint.id} className="bg-surface rounded-lg border border-border">
              <div className="p-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <button onClick={() => handleExpand(sprint.id)} className="text-sm font-medium text-foreground hover:text-accent-fg cursor-pointer">
                      {sprint.name}
                    </button>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${style.class}`}>{style.label}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    {sprint.status === "planning" && (
                      <button onClick={() => handleStatusChange(sprint.id, "active")}
                        className="px-2 py-0.5 text-[10px] bg-success/10 text-success rounded hover:bg-success/20 cursor-pointer">
                        Запустить
                      </button>
                    )}
                    {sprint.status === "active" && (
                      <button onClick={() => handleStatusChange(sprint.id, "completed")}
                        className="px-2 py-0.5 text-[10px] bg-blue-500/10 text-blue-400 rounded hover:bg-blue-500/20 cursor-pointer">
                        Завершить
                      </button>
                    )}
                    <button onClick={() => handleDeleteSprint(sprint.id)}
                      className="px-2 py-0.5 text-[10px] text-danger/60 hover:text-danger cursor-pointer">
                      ✕
                    </button>
                  </div>
                </div>

                {sprint.goal && (
                  <div className="text-xs text-muted-fg mb-2">{sprint.goal}</div>
                )}

                {/* Progress bar */}
                <div className="flex items-center gap-2 mb-1">
                  <div className="flex-1 bg-surface-alt rounded-full h-2 overflow-hidden">
                    <div className="h-full bg-success rounded-full transition-all" style={{ width: `${progress}%` }} />
                  </div>
                  <span className="text-[10px] text-muted-fg w-8 text-right">{progress}%</span>
                </div>

                <div className="flex items-center gap-3 text-[10px] text-muted-fg">
                  <span>{sprint.done_count}/{sprint.task_count} задач</span>
                  {sprint.total_points != null && <span>{sprint.done_points || 0}/{sprint.total_points} SP</span>}
                  {sprint.start_date && <span>{sprint.start_date}</span>}
                  {sprint.end_date && <span>→ {sprint.end_date}</span>}
                </div>
              </div>

              {/* Expanded task list */}
              {isExpanded && (
                <div className="border-t border-border p-3 space-y-1">
                  {sprintTasks.length === 0 ? (
                    <div className="text-xs text-muted-fg text-center py-2">Нет задач в спринте</div>
                  ) : sprintTasks.map(task => (
                    <button
                      key={task.id}
                      onClick={() => setView({ type: "task", slug, taskId: task.id })}
                      className="w-full px-2.5 py-1.5 rounded bg-surface-alt/50 border border-border/50 hover:border-accent/30 text-left cursor-pointer flex items-center gap-2"
                    >
                      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                        task.status === "done" ? "bg-success" :
                        task.status === "development" || task.status === "code_review" ? "bg-blue-400" :
                        task.status === "qa" ? "bg-teal-400" :
                        "bg-gray-400"
                      }`} />
                      <span className="text-[9px] px-1 rounded bg-purple-500/10 text-purple-400">{task.type}</span>
                      <span className="text-xs text-foreground flex-1 truncate">{task.title}</span>
                      <span className="text-[9px] text-muted-fg">{task.status}</span>
                      {task.estimated_effort && <span className="text-[9px] text-muted">{task.estimated_effort.toUpperCase()}</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
