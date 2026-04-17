"use client";

import { useState } from "react";
import { useSymphony } from "@/lib/SymphonyContext";

const ROLE_COLORS: Record<string, string> = {
  cto: "#dc2626", pm: "#8b5cf6", "scrum-master": "#06b6d4", analyst: "#f59e0b",
  researcher: "#a78bfa", designer: "#ec4899", "frontend-dev": "#3b82f6",
  "backend-dev": "#10b981", reviewer: "#f97316", qa: "#14b8a6",
};

export default function OrchestratorControl() {
  const { orchestratorStatus, refreshOrchestratorStatus } = useSymphony();
  const [showAgents, setShowAgents] = useState(false);

  if (!orchestratorStatus) return null;

  const isRunning = orchestratorStatus.status === "running";
  const isPaused = orchestratorStatus.status === "paused";
  const isStopped = orchestratorStatus.status === "stopped";

  const handleAction = async (action: "start" | "stop" | "pause") => {
    await fetch(`/api/symphony/v2/orchestrator/${action}`, { method: "POST" });
    refreshOrchestratorStatus();
  };

  const lastTick = orchestratorStatus.last_tick_at
    ? new Date(orchestratorStatus.last_tick_at + "Z").toLocaleTimeString("ru-RU")
    : "—";

  const activeAgents = orchestratorStatus.active_agents_detail || [];

  return (
    <>
      <div className="px-4 py-2 flex items-center gap-3 border-b border-border bg-surface-alt/30 text-xs">
        {/* Status indicator */}
        <div className="flex items-center gap-1.5">
          <div className={`w-2 h-2 rounded-full ${
            isRunning ? "bg-success animate-pulse" : isPaused ? "bg-warning" : "bg-muted"
          }`} />
          <span className="text-foreground font-medium">
            {isRunning ? "Работает" : isPaused ? "Пауза" : "Остановлен"}
          </span>
        </div>

        {/* Controls */}
        <div className="flex items-center gap-1">
          {isStopped && (
            <button onClick={() => handleAction("start")} className="px-2 py-0.5 bg-success/10 text-success rounded hover:bg-success/20 cursor-pointer">
              ▶ Старт
            </button>
          )}
          {isRunning && (
            <>
              <button onClick={() => handleAction("pause")} className="px-2 py-0.5 bg-warning/10 text-warning rounded hover:bg-warning/20 cursor-pointer">
                ⏸ Пауза
              </button>
              <button onClick={() => handleAction("stop")} className="px-2 py-0.5 bg-danger/10 text-danger rounded hover:bg-danger/20 cursor-pointer">
                ⏹ Стоп
              </button>
            </>
          )}
          {isPaused && (
            <>
              <button onClick={() => handleAction("pause")} className="px-2 py-0.5 bg-success/10 text-success rounded hover:bg-success/20 cursor-pointer">
                ▶ Продолжить
              </button>
              <button onClick={() => handleAction("stop")} className="px-2 py-0.5 bg-danger/10 text-danger rounded hover:bg-danger/20 cursor-pointer">
                ⏹ Стоп
              </button>
            </>
          )}
        </div>

        {/* Stats */}
        <div className="flex-1" />
        <div className="flex items-center gap-3 text-muted-fg">
          <button
            onClick={() => setShowAgents(!showAgents)}
            className={`cursor-pointer hover:text-foreground transition-colors ${showAgents ? "text-accent-fg" : ""}`}
          >
            Агентов: {orchestratorStatus.active_agents}/{orchestratorStatus.max_concurrent_agents}
          </button>
          <span>Тиков: {orchestratorStatus.tick_count}</span>
          <span>Последний: {lastTick}</span>
          {orchestratorStatus.cooldown_remaining > 0 && (
            <span className="text-warning">Cooldown: {Math.ceil(orchestratorStatus.cooldown_remaining / 1000)}s</span>
          )}
          {orchestratorStatus.total_cost_usd > 0 && (
            <span>${orchestratorStatus.total_cost_usd.toFixed(2)}</span>
          )}
        </div>
      </div>

      {/* Agent debug panel */}
      {showAgents && activeAgents.length > 0 && (
        <div className="px-4 py-2 border-b border-border bg-surface-alt/10 text-[10px] space-y-1">
          {activeAgents.map((a: { sessionId: number; taskId: number; pid: number | null; role?: string }) => (
            <div key={a.sessionId} className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-accent animate-pulse flex-shrink-0" />
              <span
                className="w-20 font-medium"
                style={a.role && ROLE_COLORS[a.role] ? { color: ROLE_COLORS[a.role] } : {}}
              >
                {a.role || "agent"}
              </span>
              <span className="text-muted-fg">Session #{a.sessionId}</span>
              <span className="text-muted-fg">Task #{a.taskId}</span>
              {a.pid && <span className="text-muted">PID: {a.pid}</span>}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
