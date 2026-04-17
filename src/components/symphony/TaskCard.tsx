"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Task } from "@/lib/SymphonyContext";
import { useSymphony } from "@/lib/SymphonyContext";

const TYPE_BADGES: Record<string, { label: string; class: string }> = {
  epic: { label: "Epic", class: "bg-purple-500/10 text-purple-400" },
  story: { label: "Story", class: "bg-cyan-500/10 text-cyan-400" },
  task: { label: "Task", class: "bg-blue-500/10 text-blue-400" },
  subtask: { label: "Sub", class: "bg-gray-500/10 text-gray-400" },
};

const EFFORT_LABELS: Record<string, string> = {
  xs: "XS", s: "S", m: "M", l: "L", xl: "XL",
};

const ROLE_COLORS: Record<string, string> = {
  cto: "#dc2626",
  pm: "#8b5cf6",
  "scrum-master": "#06b6d4",
  analyst: "#f59e0b",
  researcher: "#a78bfa",
  designer: "#ec4899",
  "frontend-dev": "#3b82f6",
  "backend-dev": "#10b981",
  reviewer: "#f97316",
  qa: "#14b8a6",
};

interface TaskCardProps {
  task: Task;
  selected?: boolean;
  onToggleSelect?: (id: number) => void;
  bulkMode?: boolean;
}

export default function TaskCard({ task, selected, onToggleSelect, bulkMode }: TaskCardProps) {
  const { setView } = useSymphony();
  const typeBadge = TYPE_BADGES[task.type] || TYPE_BADGES.task;
  const tags: string[] = (() => { try { return JSON.parse(task.tags); } catch { return []; } })();
  const roleColor = task.assigned_role ? ROLE_COLORS[task.assigned_role] || "#71717a" : undefined;
  const isRunning = (task.has_active_agent ?? 0) > 0;
  const hasChildren = (task.children_count ?? 0) > 0;
  const hasBlockers = (task.unresolved_blockers ?? 0) > 0;

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  // Find project slug from URL context (passed via parent)
  const projectSlug = (task as unknown as Record<string, unknown>)._projectSlug as string | undefined;

  const handleClick = (e: React.MouseEvent) => {
    if (bulkMode && onToggleSelect) {
      e.preventDefault();
      onToggleSelect(task.id);
      return;
    }
    if (projectSlug) setView({ type: "task", slug: projectSlug, taskId: task.id });
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={handleClick}
      className={`w-full p-2.5 bg-surface rounded-lg border transition-colors text-left cursor-pointer group ${
        selected ? "border-accent ring-1 ring-accent/30" :
        hasBlockers ? "border-danger/30" :
        "border-border hover:border-accent/30"
      }`}
    >
      {/* Header: checkbox + type + priority */}
      <div className="flex items-center gap-1.5 mb-1">
        {bulkMode && (
          <input
            type="checkbox"
            checked={selected || false}
            onChange={() => onToggleSelect?.(task.id)}
            onClick={e => e.stopPropagation()}
            className="w-3 h-3 rounded"
          />
        )}
        <span className={`text-[9px] px-1 py-px rounded font-medium ${typeBadge.class}`}>{typeBadge.label}</span>
        {task.priority > 70 && <span className="text-[9px] text-danger">●</span>}
        {task.priority > 50 && task.priority <= 70 && <span className="text-[9px] text-warning">●</span>}
        {hasBlockers && <span className="text-[9px] text-danger" title="Заблокировано">⛔</span>}
        {isRunning && (
          <span className="text-[9px] text-success animate-pulse ml-auto">● Работает</span>
        )}
        <span className="text-[9px] text-muted ml-auto">#{task.id}</span>
      </div>

      {/* Title */}
      <div className="text-xs text-foreground leading-snug mb-1.5 line-clamp-2">{task.title}</div>

      {/* Footer */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {task.assigned_role && (
          <span
            className="text-[9px] px-1 py-px rounded"
            style={{ backgroundColor: roleColor + "15", color: roleColor }}
          >
            {task.assigned_role}
          </span>
        )}
        {task.estimated_effort && (
          <span className="text-[9px] text-muted-fg bg-surface-alt px-1 rounded">
            {EFFORT_LABELS[task.estimated_effort] || task.estimated_effort}
          </span>
        )}
        {hasChildren && (
          <span className="text-[9px] text-muted-fg">{task.children_count}</span>
        )}
        {tags.slice(0, 2).map((tag) => (
          <span key={tag} className="text-[9px] text-muted bg-surface-hover px-1 rounded">{tag}</span>
        ))}
        {task.needs_human_review === 1 && (
          <span className="text-[9px] text-warning">UAT</span>
        )}
        {task.attempt > 0 && (
          <span className="text-[9px] text-danger">x{task.attempt}</span>
        )}
        {task.due_date && (
          <span className="text-[9px] text-muted-fg ml-auto">{task.due_date}</span>
        )}
      </div>
    </div>
  );
}
