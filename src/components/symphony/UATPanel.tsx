"use client";

import { useState, useEffect, useCallback } from "react";
import type { Task } from "@/lib/SymphonyContext";
import { useSymphony } from "@/lib/SymphonyContext";

export default function UATPanel({ slug }: { slug: string }) {
  const { setView } = useSymphony();
  const [tasks, setTasks] = useState<Task[]>([]);

  const fetchUAT = useCallback(async () => {
    try {
      const res = await fetch(`/api/symphony/v2/projects/${slug}/tasks?status=uat`);
      if (res.ok) {
        const data = await res.json();
        setTasks(data.tasks || []);
      }
    } catch {}
  }, [slug]);

  useEffect(() => { fetchUAT(); }, [fetchUAT]);

  const handleDecision = async (taskId: number, version: number, decision: "done" | "development", comment?: string) => {
    await fetch(`/api/symphony/v2/projects/${slug}/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: decision, version }),
    });
    if (comment) {
      await fetch(`/api/symphony/v2/projects/${slug}/tasks/${taskId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: comment, type: decision === "done" ? "approval" : "rejection" }),
      });
    }
    fetchUAT();
  };

  if (tasks.length === 0) {
    return <div className="p-4 text-xs text-muted-fg text-center">Нет задач для проверки</div>;
  }

  return (
    <div className="space-y-3 p-3">
      <div className="text-xs font-medium text-foreground">Ожидают проверки ({tasks.length})</div>
      {tasks.map(task => (
        <div key={task.id} className="p-3 bg-surface rounded-lg border border-border">
          <button
            onClick={() => setView({ type: "task", slug, taskId: task.id })}
            className="text-sm text-foreground hover:text-accent-fg cursor-pointer mb-2 block text-left"
          >
            #{task.id} {task.title}
          </button>
          <div className="text-xs text-muted-fg mb-2 line-clamp-2">{task.description}</div>
          <div className="flex gap-2">
            <button
              onClick={() => handleDecision(task.id, task.version, "done", "UAT approved")}
              className="flex-1 py-1.5 text-xs bg-success/10 text-success rounded hover:bg-success/20 cursor-pointer"
            >
              Одобрить
            </button>
            <button
              onClick={() => {
                const reason = prompt("Причина отклонения:");
                if (reason) handleDecision(task.id, task.version, "development", reason);
              }}
              className="flex-1 py-1.5 text-xs bg-danger/10 text-danger rounded hover:bg-danger/20 cursor-pointer"
            >
              Отклонить
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
