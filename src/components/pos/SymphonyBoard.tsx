"use client";

import { useState, useEffect, useCallback } from "react";
import { Plus, Search } from "@/components/Icons";

interface Task {
  id: number;
  title: string;
  description: string;
  status: string;
  priority: string;
  session_id: string | null;
  created_at: string;
  updated_at: string;
}

const COLUMNS = [
  { status: "pending", label: "Ожидает", color: "border-muted" },
  { status: "active", label: "Активна", color: "border-accent" },
  { status: "proof", label: "Проверка", color: "border-warning" },
  { status: "done", label: "Готово", color: "border-success" },
];

const PRIORITY_LABELS: Record<string, { label: string; class: string }> = {
  low: { label: "Низкий", class: "text-muted bg-surface-hover" },
  medium: { label: "Средн.", class: "text-foreground bg-surface-hover" },
  high: { label: "Высок.", class: "text-warning bg-warning/10" },
  critical: { label: "Крит.", class: "text-danger bg-danger/10" },
};

export default function SymphonyBoard() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newPriority, setNewPriority] = useState("medium");

  const fetchTasks = useCallback(async () => {
    try {
      const res = await fetch("/api/symphony/tasks");
      if (res.ok) {
        const data = await res.json();
        setTasks(data.tasks || []);
      }
    } catch {} finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchTasks(); }, [fetchTasks]);

  const handleCreate = async () => {
    if (!newTitle.trim()) return;
    try {
      await fetch("/api/symphony/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: newTitle.trim(), priority: newPriority }),
      });
      setNewTitle("");
      setCreating(false);
      fetchTasks();
    } catch {}
  };

  const handleStatusChange = async (taskId: number, newStatus: string) => {
    try {
      await fetch(`/api/symphony/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      fetchTasks();
    } catch {}
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
      {/* Header */}
      <div className="h-12 px-4 flex items-center justify-between border-b border-border bg-surface">
        <div className="text-sm font-medium text-foreground">Доска задач Symphony</div>
        <button
          onClick={() => setCreating(true)}
          className="flex items-center gap-1.5 px-3 py-1 text-xs bg-accent text-white rounded-md hover:bg-accent/90 transition-colors cursor-pointer"
        >
          <Plus className="w-3.5 h-3.5" />
          Новая задача
        </button>
      </div>

      {/* Quick create */}
      {creating && (
        <div className="px-4 py-3 border-b border-border bg-surface flex gap-2">
          <input
            type="text"
            placeholder="Название задачи..."
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); if (e.key === "Escape") setCreating(false); }}
            className="flex-1 px-3 py-1.5 text-sm bg-surface-alt border border-border rounded-lg outline-none focus:border-accent text-foreground placeholder:text-muted"
            autoFocus
          />
          <select
            value={newPriority}
            onChange={(e) => setNewPriority(e.target.value)}
            className="px-2 py-1.5 text-xs bg-surface-alt border border-border rounded-lg text-foreground outline-none"
          >
            <option value="low">Низкий</option>
            <option value="medium">Средний</option>
            <option value="high">Высокий</option>
            <option value="critical">Критический</option>
          </select>
          <button onClick={handleCreate} className="px-3 py-1.5 text-xs bg-accent text-white rounded-lg hover:bg-accent/90 cursor-pointer">Создать</button>
        </div>
      )}

      {/* Kanban columns */}
      <div className="flex-1 overflow-x-auto p-4">
        {tasks.length === 0 && !creating ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="text-muted-fg text-sm mb-2">Нет задач</div>
            <button
              onClick={() => setCreating(true)}
              className="text-xs text-accent-fg hover:underline cursor-pointer mb-4"
            >
              Создайте первую задачу
            </button>
            <div className="text-[10px] text-muted space-y-0.5">
              <div>Ожидает → Активна → Проверка → Готово</div>
            </div>
          </div>
        ) : (
        <div className="flex gap-4 h-full min-w-[800px]">
          {COLUMNS.map((col) => {
            const colTasks = tasks.filter(t => t.status === col.status);
            return (
              <div key={col.status} className={`flex-1 flex flex-col rounded-lg border-t-2 ${col.color} bg-surface-alt/50`}>
                <div className="px-3 py-2 flex items-center justify-between">
                  <span className="text-xs font-medium text-foreground">{col.label}</span>
                  <span className="text-[10px] text-muted bg-surface px-1.5 rounded">{colTasks.length}</span>
                </div>
                <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-2">
                  {colTasks.map((task) => {
                    const badge = PRIORITY_LABELS[task.priority] || PRIORITY_LABELS.low;
                    return (
                      <div
                        key={task.id}
                        className="p-3 bg-surface rounded-lg border border-border hover:border-accent/30 transition-colors cursor-pointer"
                      >
                        <div className="text-sm text-foreground mb-1">{task.title}</div>
                        <div className="flex items-center gap-2 text-[10px]">
                          <span className={`px-1 rounded ${badge.class}`}>{badge.label}</span>
                          {task.session_id && <span className="text-accent-fg">привязана</span>}
                        </div>
                        {/* Status change buttons */}
                        <div className="flex gap-1 mt-2">
                          {COLUMNS.filter(c => c.status !== col.status).map(c => (
                            <button
                              key={c.status}
                              onClick={() => handleStatusChange(task.id, c.status)}
                              className="text-[10px] px-1.5 py-0.5 rounded bg-surface-hover text-muted-fg hover:text-foreground transition-colors cursor-pointer"
                            >
                              → {c.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
        )}
      </div>
    </div>
  );
}
