"use client";

import { useState, useEffect, useCallback } from "react";
import { DndContext, DragOverlay, closestCorners, type DragEndEvent, type DragStartEvent, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { Plus, ChevronLeft } from "@/components/Icons";
import { useSymphony } from "@/lib/SymphonyContext";
import type { Task } from "@/lib/SymphonyContext";
import BoardColumn from "./BoardColumn";
import CreateTaskModal from "./CreateTaskModal";
import ProjectChat from "./ProjectChat";

const STATUSES = ["backlog", "analysis", "design", "development", "code_review", "qa", "uat", "done", "pending_cancel", "failed"];

interface ProjectBoardProps {
  slug: string;
}

export default function ProjectBoard({ slug }: ProjectBoardProps) {
  const { setView, roles } = useSymphony();
  const [columns, setColumns] = useState<Record<string, Task[]>>({});
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [activeTask, setActiveTask] = useState<Task | null>(null);

  // Filters
  const [search, setSearch] = useState("");
  const [filterRole, setFilterRole] = useState("");
  const [filterType, setFilterType] = useState("");
  const [showFilters, setShowFilters] = useState(false);

  // Bulk operations
  const [bulkMode, setBulkMode] = useState(false);
  const [selectedTasks, setSelectedTasks] = useState<Set<number>>(new Set());

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

  const fetchBoard = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (filterRole) params.set("role", filterRole);
      if (filterType) params.set("type", filterType);
      const qs = params.toString();
      const res = await fetch(`/api/symphony/v2/projects/${slug}/board${qs ? "?" + qs : ""}`);
      if (res.ok) {
        const data = await res.json();
        setColumns(data.columns || {});
      }
    } catch {} finally {
      setLoading(false);
    }
  }, [slug, search, filterRole, filterType]);

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
    fetchBoard();
    fetchProject();
  }, [fetchBoard, fetchProject]);

  // Listen for WS updates
  useEffect(() => {
    const handler = () => fetchBoard();
    window.addEventListener("symphony:task-update", handler);
    window.addEventListener("symphony:agent-update", handler);
    return () => {
      window.removeEventListener("symphony:task-update", handler);
      window.removeEventListener("symphony:agent-update", handler);
    };
  }, [fetchBoard]);

  // DnD handlers
  const handleDragStart = (event: DragStartEvent) => {
    const id = event.active.id as number;
    const allTasks = Object.values(columns).flat();
    const task = allTasks.find(t => t.id === id);
    if (task) setActiveTask(task);
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    setActiveTask(null);
    const { active, over } = event;
    if (!over) return;

    const taskId = active.id as number;
    const newStatus = over.id as string;

    // Find the task
    const allTasks = Object.values(columns).flat();
    const task = allTasks.find(t => t.id === taskId);
    if (!task || task.status === newStatus) return;

    // Check if status is valid (it's a column)
    if (!STATUSES.includes(newStatus)) return;

    // Optimistic update
    setColumns(prev => {
      const updated = { ...prev };
      for (const s of STATUSES) {
        updated[s] = (updated[s] || []).filter(t => t.id !== taskId);
      }
      updated[newStatus] = [...(updated[newStatus] || []), { ...task, status: newStatus }];
      return updated;
    });

    // API call
    await fetch(`/api/symphony/v2/projects/${slug}/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: newStatus, version: task.version }),
    });

    fetchBoard();
  };

  const handleToggleSelect = useCallback((id: number) => {
    setSelectedTasks(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Bulk actions
  const handleBulkAction = async (action: string, value?: string) => {
    if (selectedTasks.size === 0) return;
    const ids = Array.from(selectedTasks);

    for (const id of ids) {
      const allTasks = Object.values(columns).flat();
      const task = allTasks.find(t => t.id === id);
      if (!task) continue;

      const body: Record<string, unknown> = { version: task.version };
      if (action === "status" && value) body.status = value;
      if (action === "role" && value) body.assigned_role = value;
      if (action === "delete") {
        await fetch(`/api/symphony/v2/projects/${slug}/tasks/${id}`, { method: "DELETE" });
        continue;
      }

      await fetch(`/api/symphony/v2/projects/${slug}/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    setSelectedTasks(new Set());
    setBulkMode(false);
    fetchBoard();
  };

  const totalTasks = Object.values(columns).reduce((sum, col) => sum + col.length, 0);

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
        <div className="flex items-center gap-2">
          <button onClick={() => setView({ type: "dashboard" })} className="text-muted-fg hover:text-foreground cursor-pointer">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="text-sm font-medium text-foreground">{projectName}</span>
          <span className="text-[10px] text-muted bg-surface-alt px-1.5 rounded">{totalTasks} задач</span>
        </div>
        <div className="flex items-center gap-2">
          {/* Search */}
          <input
            type="text"
            placeholder="Поиск..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-40 px-2 py-1 text-xs bg-surface-alt border border-border rounded-md outline-none focus:border-accent text-foreground placeholder:text-muted"
          />
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`px-2 py-1 text-xs border rounded-md cursor-pointer transition-colors ${
              showFilters || filterRole || filterType
                ? "border-accent text-accent-fg bg-accent/5"
                : "border-border text-muted-fg hover:text-foreground"
            }`}
          >
            Фильтры
          </button>
          <button
            onClick={() => { setBulkMode(!bulkMode); setSelectedTasks(new Set()); }}
            className={`px-2 py-1 text-xs border rounded-md cursor-pointer transition-colors ${
              bulkMode ? "border-accent text-accent-fg bg-accent/5" : "border-border text-muted-fg hover:text-foreground"
            }`}
          >
            {bulkMode ? "Отмена" : "Выбрать"}
          </button>
          <button
            onClick={() => setView({ type: "overview", slug })}
            className="px-2 py-1 text-xs border border-border rounded-md text-muted-fg hover:text-foreground transition-colors cursor-pointer"
          >
            Обзор
          </button>
          <button
            onClick={() => setView({ type: "sprints", slug })}
            className="px-2 py-1 text-xs border border-border rounded-md text-muted-fg hover:text-foreground transition-colors cursor-pointer"
          >
            Спринты
          </button>
          <button
            onClick={() => setView({ type: "backlog", slug })}
            className="px-2 py-1 text-xs border border-border rounded-md text-muted-fg hover:text-foreground transition-colors cursor-pointer"
          >
            Бэклог
          </button>
          <button
            onClick={() => setShowChat(!showChat)}
            className="px-2 py-1 text-xs border border-border rounded-md text-muted-fg hover:text-foreground transition-colors cursor-pointer"
          >
            Чат
          </button>
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-1.5 px-3 py-1 text-xs bg-accent text-white rounded-md hover:bg-accent/90 transition-colors cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            Задача
          </button>
        </div>
      </div>

      {/* Filters bar */}
      {showFilters && (
        <div className="px-4 py-2 border-b border-border bg-surface-alt/30 flex items-center gap-3 text-xs">
          <div className="flex items-center gap-1.5">
            <span className="text-muted-fg">Роль:</span>
            <select
              value={filterRole}
              onChange={e => setFilterRole(e.target.value)}
              className="px-1.5 py-0.5 bg-surface border border-border rounded text-foreground outline-none text-xs"
            >
              <option value="">Все</option>
              {roles.map(r => <option key={r.slug} value={r.slug}>{r.name}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-muted-fg">Тип:</span>
            <select
              value={filterType}
              onChange={e => setFilterType(e.target.value)}
              className="px-1.5 py-0.5 bg-surface border border-border rounded text-foreground outline-none text-xs"
            >
              <option value="">Все</option>
              <option value="epic">Epic</option>
              <option value="story">Story</option>
              <option value="task">Task</option>
              <option value="subtask">Subtask</option>
            </select>
          </div>
          {(filterRole || filterType) && (
            <button
              onClick={() => { setFilterRole(""); setFilterType(""); }}
              className="text-accent-fg hover:underline cursor-pointer"
            >
              Сбросить
            </button>
          )}
        </div>
      )}

      {/* Bulk action bar */}
      {bulkMode && selectedTasks.size > 0 && (
        <div className="px-4 py-2 border-b border-border bg-accent/5 flex items-center gap-3 text-xs">
          <span className="text-foreground font-medium">Выбрано: {selectedTasks.size}</span>
          <select
            onChange={e => { if (e.target.value) handleBulkAction("status", e.target.value); e.target.value = ""; }}
            className="px-1.5 py-0.5 bg-surface border border-border rounded text-foreground outline-none text-xs"
          >
            <option value="">Статус...</option>
            {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <select
            onChange={e => { if (e.target.value) handleBulkAction("role", e.target.value); e.target.value = ""; }}
            className="px-1.5 py-0.5 bg-surface border border-border rounded text-foreground outline-none text-xs"
          >
            <option value="">Роль...</option>
            {roles.map(r => <option key={r.slug} value={r.slug}>{r.name}</option>)}
          </select>
          <button
            onClick={() => { if (confirm(`Удалить ${selectedTasks.size} задач?`)) handleBulkAction("delete"); }}
            className="px-2 py-0.5 bg-danger/10 text-danger rounded hover:bg-danger/20 cursor-pointer"
          >
            Удалить
          </button>
        </div>
      )}

      {/* Board */}
      <div className="flex-1 flex overflow-hidden">
        <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
          <div className="flex-1 overflow-x-auto p-3">
            <div className="flex gap-3 h-full min-w-[1600px]">
              {STATUSES.map((status) => (
                <BoardColumn
                  key={status}
                  status={status}
                  tasks={columns[status] || []}
                  projectSlug={slug}
                  selectedTasks={selectedTasks}
                  onToggleSelect={handleToggleSelect}
                  bulkMode={bulkMode}
                />
              ))}
            </div>
          </div>
          <DragOverlay>
            {activeTask && (
              <div className="w-52 p-2.5 bg-surface rounded-lg border border-accent shadow-lg text-xs text-foreground opacity-80">
                {activeTask.title}
              </div>
            )}
          </DragOverlay>
        </DndContext>

        {/* Chat sidebar */}
        {showChat && (
          <div className="w-72 border-l border-border flex-shrink-0">
            <ProjectChat slug={slug} />
          </div>
        )}
      </div>

      {/* Create modal */}
      {showCreate && (
        <CreateTaskModal
          projectSlug={slug}
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            fetchBoard();
          }}
        />
      )}
    </div>
  );
}
