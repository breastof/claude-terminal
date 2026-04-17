"use client";

import { useState, useEffect, useCallback } from "react";
import { ChevronLeft } from "@/components/Icons";
import type { Project } from "@/lib/SymphonyContext";

export default function ProjectSettings({ slug, onBack }: { slug: string; onBack: () => void }) {
  const [project, setProject] = useState<Project | null>(null);
  const [saving, setSaving] = useState(false);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [maxAgents, setMaxAgents] = useState(5);

  const fetchProject = useCallback(async () => {
    try {
      const res = await fetch(`/api/symphony/v2/projects/${slug}`);
      if (res.ok) {
        const data = await res.json();
        setProject(data.project);
        setName(data.project.name);
        setDescription(data.project.description || "");
        setRepoPath(data.project.repo_path || "");
        setMaxAgents(data.project.max_agents);
      }
    } catch {}
  }, [slug]);

  useEffect(() => { fetchProject(); }, [fetchProject]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await fetch(`/api/symphony/v2/projects/${slug}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description, repo_path: repoPath || null, max_agents: maxAgents }),
      });
      fetchProject();
    } finally { setSaving(false); }
  };

  if (!project) return null;

  return (
    <div className="flex flex-col h-full">
      <div className="h-12 px-4 flex items-center gap-2 border-b border-border bg-surface">
        <button onClick={onBack} className="text-muted-fg hover:text-foreground cursor-pointer">
          <ChevronLeft className="w-4 h-4" />
        </button>
        <span className="text-sm font-medium text-foreground">Настройки: {project.name}</span>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4 max-w-lg">
        <div>
          <label className="text-xs text-muted-fg block mb-1">Название</label>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            className="w-full px-3 py-2 text-sm bg-surface-alt border border-border rounded-lg outline-none focus:border-accent text-foreground"
          />
        </div>

        <div>
          <label className="text-xs text-muted-fg block mb-1">Описание</label>
          <textarea
            value={description}
            onChange={e => setDescription(e.target.value)}
            rows={3}
            className="w-full px-3 py-2 text-sm bg-surface-alt border border-border rounded-lg outline-none focus:border-accent text-foreground resize-none"
          />
        </div>

        <div>
          <label className="text-xs text-muted-fg block mb-1">Путь к репозиторию</label>
          <input
            value={repoPath}
            onChange={e => setRepoPath(e.target.value)}
            placeholder="/root/projects/my-project"
            className="w-full px-3 py-2 text-sm bg-surface-alt border border-border rounded-lg outline-none focus:border-accent text-foreground placeholder:text-muted"
          />
        </div>

        <div>
          <label className="text-xs text-muted-fg block mb-1">Макс. агентов: {maxAgents}</label>
          <input
            type="range"
            min={1}
            max={10}
            value={maxAgents}
            onChange={e => setMaxAgents(Number(e.target.value))}
            className="w-full"
          />
        </div>

        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-2 text-sm bg-accent text-white rounded-lg hover:bg-accent/90 disabled:opacity-50 cursor-pointer"
        >
          {saving ? "Сохранение..." : "Сохранить"}
        </button>
      </div>
    </div>
  );
}
