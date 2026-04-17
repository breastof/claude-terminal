"use client";

import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { Task } from "@/lib/SymphonyContext";
import TaskCard from "./TaskCard";

const STATUS_META: Record<string, { label: string; color: string }> = {
  backlog: { label: "Бэклог", color: "#71717a" },
  analysis: { label: "Анализ", color: "#f59e0b" },
  design: { label: "Дизайн", color: "#ec4899" },
  development: { label: "Разработка", color: "#3b82f6" },
  code_review: { label: "Code Review", color: "#f97316" },
  qa: { label: "QA", color: "#14b8a6" },
  uat: { label: "UAT", color: "#a855f7" },
  done: { label: "Готово", color: "#22c55e" },
  pending_cancel: { label: "Ожидает отмены", color: "#f43f5e" },
};

interface BoardColumnProps {
  status: string;
  tasks: Task[];
  projectSlug: string;
  wipLimit?: number;
  selectedTasks?: Set<number>;
  onToggleSelect?: (id: number) => void;
  bulkMode?: boolean;
}

export default function BoardColumn({ status, tasks, projectSlug, wipLimit, selectedTasks, onToggleSelect, bulkMode }: BoardColumnProps) {
  const meta = STATUS_META[status] || { label: status, color: "#71717a" };
  const { isOver, setNodeRef } = useDroppable({ id: status });
  const overWip = wipLimit ? tasks.length >= wipLimit : false;

  // Inject projectSlug into tasks for TaskCard navigation
  const enrichedTasks = tasks.map(t => ({ ...t, _projectSlug: projectSlug }));

  return (
    <div
      ref={setNodeRef}
      className={`flex-shrink-0 w-52 flex flex-col rounded-lg transition-colors ${
        isOver ? "bg-accent/5 ring-1 ring-accent/30" : "bg-surface-alt/30"
      } ${overWip ? "ring-1 ring-danger/30" : ""}`}
    >
      {/* Header */}
      <div className="px-2.5 py-2 flex items-center gap-2 border-b border-border/50">
        <div className="w-2 h-2 rounded-full" style={{ backgroundColor: meta.color }} />
        <span className="text-[11px] font-medium text-foreground">{meta.label}</span>
        <span className={`text-[10px] px-1.5 rounded ml-auto ${overWip ? "bg-danger/10 text-danger" : "bg-surface text-muted"}`}>
          {tasks.length}{wipLimit ? `/${wipLimit}` : ""}
        </span>
      </div>

      {/* Cards */}
      <SortableContext items={enrichedTasks.map(t => t.id)} strategy={verticalListSortingStrategy}>
        <div className="flex-1 overflow-y-auto p-1.5 space-y-1.5 min-h-[60px]">
          {enrichedTasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task as Task}
              selected={selectedTasks?.has(task.id)}
              onToggleSelect={onToggleSelect}
              bulkMode={bulkMode}
            />
          ))}
        </div>
      </SortableContext>
    </div>
  );
}
