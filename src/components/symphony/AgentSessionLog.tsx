"use client";

import { useState, useEffect, useCallback } from "react";

interface AgentSession {
  id: number;
  task_id: number;
  role_slug: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  pid: number | null;
  task_title: string;
  task_type: string;
  role_name: string;
  role_color: string;
}

export default function AgentSessionLog() {
  const [agents, setAgents] = useState<AgentSession[]>([]);

  const fetchAgents = useCallback(async () => {
    try {
      const res = await fetch("/api/symphony/v2/orchestrator/agents");
      if (res.ok) {
        const data = await res.json();
        setAgents(data.agents || []);
      }
    } catch {}
  }, []);

  useEffect(() => {
    fetchAgents();
    const interval = setInterval(fetchAgents, 5000);
    return () => clearInterval(interval);
  }, [fetchAgents]);

  const handleTerminate = async (id: number) => {
    await fetch(`/api/symphony/v2/orchestrator/agents/${id}/terminate`, { method: "POST" });
    fetchAgents();
  };

  if (agents.length === 0) {
    return (
      <div className="px-3 py-4 text-xs text-muted-fg text-center">
        Нет активных агентов
      </div>
    );
  }

  return (
    <div className="space-y-2 p-2">
      {agents.map(a => (
        <div key={a.id} className="p-2 rounded-lg bg-surface-alt/50 border border-border/50 text-xs">
          <div className="flex items-center gap-2 mb-1">
            <span className="w-2 h-2 rounded-full bg-success animate-pulse" />
            <span className="font-medium" style={{ color: a.role_color }}>{a.role_name}</span>
            <span className="text-muted-fg">Task #{a.task_id}</span>
            <button
              onClick={() => handleTerminate(a.id)}
              className="ml-auto text-[9px] px-1.5 py-0.5 text-danger hover:bg-danger/10 rounded cursor-pointer"
            >
              Kill
            </button>
          </div>
          <div className="text-[10px] text-foreground truncate">{a.task_title}</div>
          <div className="text-[9px] text-muted mt-0.5">
            PID: {a.pid || "—"} | Tokens: {a.tokens_in}/{a.tokens_out}
          </div>
        </div>
      ))}
    </div>
  );
}
