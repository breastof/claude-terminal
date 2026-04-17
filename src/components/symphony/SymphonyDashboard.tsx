"use client";

import { useState } from "react";
import { Plus } from "@/components/Icons";
import { useSymphony } from "@/lib/SymphonyContext";
import ProjectBoard from "./ProjectBoard";
import TaskDetail from "./TaskDetail";
import ProjectOverview from "./ProjectOverview";
import SprintBoard from "./SprintBoard";
import BacklogView from "./BacklogView";
import OrchestratorControl from "./OrchestratorControl";
import CostDashboard from "./CostDashboard";
import NotificationCenter from "./NotificationCenter";

export default function SymphonyDashboard() {
  const { view, setView, projects, refreshProjects, orchestratorStatus, notifications } = useSymphony();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newSlug, setNewSlug] = useState("");
  const [showCost, setShowCost] = useState(false);
  const [showNotifs, setShowNotifs] = useState(false);

  const handleCreateProject = async () => {
    if (!newName.trim()) return;
    const slug = newSlug.trim() || newName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    try {
      const res = await fetch("/api/symphony/v2/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim(), slug }),
      });
      if (res.ok) {
        setNewName("");
        setNewSlug("");
        setCreating(false);
        refreshProjects();
      }
    } catch {}
  };

  // Route to sub-views
  if (view.type === "project") {
    return <ProjectBoard slug={view.slug} />;
  }
  if (view.type === "task") {
    return <TaskDetail slug={view.slug} taskId={view.taskId} />;
  }
  if (view.type === "overview") {
    return <ProjectOverview slug={view.slug} />;
  }
  if (view.type === "sprints") {
    return <SprintBoard slug={view.slug} />;
  }
  if (view.type === "backlog") {
    return <BacklogView slug={view.slug} />;
  }

  if (showCost) {
    return <CostDashboard onBack={() => setShowCost(false)} />;
  }

  const unreadCount = notifications.filter(n => !n.read).length;
  const totalTasks = orchestratorStatus
    ? `${orchestratorStatus.active_agents}/${orchestratorStatus.max_concurrent_agents} agents`
    : "";

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="h-12 px-4 flex items-center justify-between border-b border-border bg-surface">
        <div className="flex items-center gap-3">
          <div className="text-sm font-medium text-foreground">Symphony</div>
          {totalTasks && (
            <span className="text-[10px] text-muted bg-surface-alt px-1.5 rounded">{totalTasks}</span>
          )}
          {orchestratorStatus && orchestratorStatus.total_cost_usd > 0 && (
            <span className="text-[10px] text-muted bg-surface-alt px-1.5 rounded">${orchestratorStatus.total_cost_usd.toFixed(2)}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Notification bell */}
          <div className="relative">
            <button
              onClick={() => setShowNotifs(!showNotifs)}
              className="px-2 py-1 text-xs text-muted-fg hover:text-foreground border border-border rounded-md transition-colors cursor-pointer relative"
            >
              Уведомления
              {unreadCount > 0 && (
                <span className="absolute -top-1 -right-1 w-4 h-4 text-[9px] bg-danger text-white rounded-full flex items-center justify-center">
                  {unreadCount > 9 ? "9+" : unreadCount}
                </span>
              )}
            </button>
            {showNotifs && (
              <div className="absolute right-0 top-full mt-1 z-50">
                <NotificationCenter onClose={() => setShowNotifs(false)} />
              </div>
            )}
          </div>

          <button
            onClick={() => setShowCost(true)}
            className="px-3 py-1 text-xs text-muted-fg hover:text-foreground border border-border rounded-md transition-colors cursor-pointer"
          >
            Расходы
          </button>
          <button
            onClick={() => setCreating(true)}
            className="flex items-center gap-1.5 px-3 py-1 text-xs bg-accent text-white rounded-md hover:bg-accent/90 transition-colors cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            Новый проект
          </button>
        </div>
      </div>

      {/* Orchestrator Control */}
      <OrchestratorControl />

      {/* Create project form */}
      {creating && (
        <div className="px-4 py-3 border-b border-border bg-surface flex gap-2">
          <input
            type="text"
            placeholder="Название проекта..."
            value={newName}
            onChange={(e) => {
              setNewName(e.target.value);
              if (!newSlug) setNewSlug(e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
            }}
            className="flex-1 px-3 py-1.5 text-sm bg-surface-alt border border-border rounded-lg outline-none focus:border-accent text-foreground placeholder:text-muted"
            autoFocus
            onKeyDown={(e) => { if (e.key === "Enter") handleCreateProject(); if (e.key === "Escape") setCreating(false); }}
          />
          <input
            type="text"
            placeholder="slug"
            value={newSlug}
            onChange={(e) => setNewSlug(e.target.value.replace(/[^a-z0-9-]/g, ""))}
            className="w-32 px-3 py-1.5 text-sm bg-surface-alt border border-border rounded-lg outline-none focus:border-accent text-foreground placeholder:text-muted"
          />
          <button onClick={handleCreateProject} className="px-3 py-1.5 text-xs bg-accent text-white rounded-lg hover:bg-accent/90 cursor-pointer">Создать</button>
          <button onClick={() => setCreating(false)} className="px-3 py-1.5 text-xs text-muted-fg hover:text-foreground cursor-pointer">Отмена</button>
        </div>
      )}

      {/* Project list */}
      <div className="flex-1 overflow-y-auto p-4">
        {projects.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="text-4xl mb-4">🎵</div>
            <div className="text-lg text-foreground mb-2">Symphony v2</div>
            <div className="text-sm text-muted-fg mb-4">Многоагентная оркестрация с CTO, 10 ролями, drag&drop</div>
            <button
              onClick={() => setCreating(true)}
              className="text-sm text-accent-fg hover:underline cursor-pointer"
            >
              Создайте первый проект
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {projects.map((project) => (
              <button
                key={project.id}
                onClick={() => setView({ type: "project", slug: project.slug })}
                className="p-4 bg-surface rounded-lg border border-border hover:border-accent/30 transition-colors text-left cursor-pointer"
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium text-foreground">{project.name}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                    project.status === "active" ? "bg-success/10 text-success" : "bg-surface-alt text-muted-fg"
                  }`}>
                    {project.status}
                  </span>
                </div>
                {project.description && (
                  <div className="text-xs text-muted-fg mb-2 line-clamp-2">{project.description}</div>
                )}
                <div className="text-[10px] text-muted flex items-center gap-2">
                  <span>{project.slug}</span>
                  {project.repo_path && <span>repo</span>}
                  <span>max {project.max_agents} agents</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
