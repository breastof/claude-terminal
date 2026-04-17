"use client";

import { useState, useEffect, useCallback } from "react";
import { Music, Plus } from "@/components/Icons";
import { useNavigation } from "@/lib/NavigationContext";

interface SymphonyProject {
  id: number;
  slug: string;
  name: string;
  status: string;
  created_at: string;
}

interface OrchestratorInfo {
  status: string;
  active_agents: number;
  max_concurrent_agents: number;
}

export default function SymphonyPanel() {
  const { setWorkspaceView } = useNavigation();
  const [projects, setProjects] = useState<SymphonyProject[]>([]);
  const [orchestrator, setOrchestrator] = useState<OrchestratorInfo | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const [projRes, orchRes] = await Promise.all([
        fetch("/api/symphony/v2/projects"),
        fetch("/api/symphony/v2/orchestrator/status"),
      ]);
      if (projRes.ok) {
        const data = await projRes.json();
        setProjects(data.projects || []);
      }
      if (orchRes.ok) {
        setOrchestrator(await orchRes.json());
      }
    } catch {} finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 10000);
    return () => clearInterval(interval);
  }, [fetchData]);

  return (
    <div className="flex flex-col h-full">
      <div className="h-14 px-3 flex items-center justify-between border-b border-border">
        <div className="flex items-center gap-2">
          <Music className="w-4 h-4 text-accent-fg" />
          <span className="text-sm font-medium">Symphony</span>
        </div>
      </div>

      {/* Orchestrator status */}
      {orchestrator && (
        <div className="px-3 py-2 flex items-center gap-2 text-[10px] text-muted-fg border-b border-border">
          <div className={`w-1.5 h-1.5 rounded-full ${
            orchestrator.status === "running" ? "bg-success animate-pulse" :
            orchestrator.status === "paused" ? "bg-warning" : "bg-muted"
          }`} />
          <span>{orchestrator.status === "running" ? "Работает" : orchestrator.status === "paused" ? "Пауза" : "Стоп"}</span>
          <span className="ml-auto">{orchestrator.active_agents}/{orchestrator.max_concurrent_agents} агентов</span>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-2 py-1">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin h-5 w-5 border-2 border-accent border-t-transparent rounded-full" />
          </div>
        ) : projects.length === 0 ? (
          <div className="text-center py-8">
            <p className="text-muted text-sm mb-2">Нет проектов</p>
            <p className="text-[10px] text-muted-fg">Откройте борд для создания</p>
          </div>
        ) : (
          projects.map((project) => (
            <button
              key={project.id}
              onClick={() => setWorkspaceView({ type: "symphony" })}
              className="w-full px-3 py-2.5 rounded-lg hover:bg-surface-hover transition-colors text-left cursor-pointer"
            >
              <div className="flex items-center gap-2">
                <span className="text-sm text-foreground truncate flex-1">{project.name}</span>
                <span className={`text-[9px] px-1 rounded ${
                  project.status === "active" ? "bg-success/10 text-success" : "bg-surface-alt text-muted-fg"
                }`}>
                  {project.status}
                </span>
              </div>
              <div className="text-[10px] text-muted mt-0.5">{project.slug}</div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
