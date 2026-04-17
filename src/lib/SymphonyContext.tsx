"use client";

import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from "react";

// ── Types ──

interface Project {
  id: number;
  slug: string;
  name: string;
  description: string;
  repo_path: string | null;
  max_agents: number;
  status: string;
  config: string;
  hooks: string;
  created_at: string;
}

interface Task {
  id: number;
  project_id: number;
  parent_id: number | null;
  type: string;
  title: string;
  description: string;
  status: string;
  priority: number;
  assigned_role: string | null;
  estimated_effort: string | null;
  tags: string;
  version: number;
  attempt: number;
  needs_human_review: number;
  due_date: string | null;
  sprint_id: number | null;
  children_count?: number;
  has_active_agent?: number;
  unresolved_blockers?: number;
  created_at: string;
  updated_at: string;
}

interface OrchestratorStatus {
  status: string;
  pid: number | null;
  last_tick_at: string | null;
  tick_count: number;
  active_agents: number;
  max_concurrent_agents: number;
  total_tokens_in: number;
  total_tokens_out: number;
  total_cost_usd: number;
  active_agents_detail: { sessionId: number; taskId: number; pid: number | null }[];
  cooldown_remaining: number;
  paused_remaining: number;
}

interface Comment {
  id: number;
  task_id: number;
  author_role: string | null;
  author_user_id: number | null;
  author_username?: string | null;
  author_first_name?: string | null;
  author_last_name?: string | null;
  agent_session_id?: number | null;
  content: string;
  type: string;
  mention_role: string | null;
  file_path?: string | null;
  line_range?: string | null;
  created_at: string;
}

interface Artifact {
  id: number;
  task_id: number;
  type: string;
  title: string;
  file_path: string | null;
  content: string | null;
  created_by_role: string | null;
  created_at: string;
}

interface Role {
  id: number;
  slug: string;
  name: string;
  model: string;
  color: string;
  icon: string;
  max_budget_usd: number;
}

interface ChatMessage {
  id: number;
  project_id: number;
  author_role: string | null;
  author_user_id: number | null;
  content: string;
  type?: 'work' | 'casual' | 'celebration' | 'complaint' | 'insight' | null;
  created_at: string;
}

interface AuditEntry {
  id: number;
  task_id: number;
  project_id: number;
  action: string;
  old_value: string | null;
  new_value: string | null;
  actor_type: string;
  actor_id: string | null;
  created_at: string;
}

interface BudgetAlert {
  role: string;
  spent: number;
  limit: number;
  project_id: number;
  seenAt: number;
}

type SymphonyView =
  | { type: "dashboard" }
  | { type: "project"; slug: string }
  | { type: "task"; slug: string; taskId: number }
  | { type: "overview"; slug: string }
  | { type: "sprints"; slug: string }
  | { type: "backlog"; slug: string };

interface SymphonyContextValue {
  view: SymphonyView;
  setView: (view: SymphonyView) => void;
  projects: Project[];
  refreshProjects: () => Promise<void>;
  orchestratorStatus: OrchestratorStatus | null;
  refreshOrchestratorStatus: () => Promise<void>;
  roles: Role[];
  ws: WebSocket | null;
  notifications: SymphonyNotification[];
  clearNotification: (id: string) => void;
  budgetAlerts: Map<string, BudgetAlert>;
}

interface SymphonyNotification {
  id: string;
  type: string;
  message: string;
  taskId?: number;
  projectSlug?: string;
  timestamp: number;
  read: boolean;
}

// ── Context ──

const SymphonyContext = createContext<SymphonyContextValue | null>(null);

export function SymphonyProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<SymphonyView>({ type: "dashboard" });
  const [projects, setProjects] = useState<Project[]>([]);
  const [orchestratorStatus, setOrchestratorStatus] = useState<OrchestratorStatus | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [notifications, setNotifications] = useState<SymphonyNotification[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const [budgetAlerts, setBudgetAlerts] = useState<Map<string, BudgetAlert>>(new Map());
  const budgetAlertsSeenRef = useRef<Map<string, number>>(new Map());

  // Expire stale budget alerts after 30s of no new events
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setBudgetAlerts(prev => {
        let changed = false;
        const next = new Map(prev);
        for (const [key, alert] of next) {
          if (now - alert.seenAt > 30_000) {
            next.delete(key);
            budgetAlertsSeenRef.current.delete(key);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 10_000);
    return () => clearInterval(interval);
  }, []);

  const addNotification = useCallback((notif: Omit<SymphonyNotification, "id" | "timestamp" | "read">) => {
    setNotifications(prev => [{
      ...notif,
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      timestamp: Date.now(),
      read: false,
    }, ...prev].slice(0, 50)); // Keep last 50
  }, []);

  const clearNotification = useCallback((id: string) => {
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, read: true } : n));
  }, []);

  const refreshProjects = useCallback(async () => {
    try {
      const res = await fetch("/api/symphony/v2/projects");
      if (res.ok) {
        const data = await res.json();
        setProjects(data.projects || []);
      }
    } catch {}
  }, []);

  const refreshOrchestratorStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/symphony/v2/orchestrator/status");
      if (res.ok) {
        const data = await res.json();
        setOrchestratorStatus(data);
      }
    } catch {}
  }, []);

  const fetchRoles = useCallback(async () => {
    try {
      const res = await fetch("/api/symphony/v2/roles");
      if (res.ok) {
        const data = await res.json();
        setRoles(data.roles || []);
      }
    } catch {}
  }, []);

  // Initial load
  useEffect(() => {
    refreshProjects();
    refreshOrchestratorStatus();
    fetchRoles();
  }, [refreshProjects, refreshOrchestratorStatus, fetchRoles]);

  // Periodic orchestrator status refresh
  useEffect(() => {
    const interval = setInterval(refreshOrchestratorStatus, 10000);
    return () => clearInterval(interval);
  }, [refreshOrchestratorStatus]);

  // WebSocket connection
  useEffect(() => {
    function connect() {
      const token = document.cookie.split(";").find(c => c.trim().startsWith("auth-token="))?.split("=")[1];
      if (!token) return;

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${protocol}//${window.location.host}/api/symphony-ws?token=${token}`);

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "orchestrator_status") {
            refreshOrchestratorStatus();
          }
          if (msg.type === "task_updated" || msg.type === "task_created" || msg.type === "task_unblocked") {
            window.dispatchEvent(new CustomEvent("symphony:task-update", { detail: msg }));
          }
          if (msg.type === "agent_started") {
            refreshOrchestratorStatus();
            window.dispatchEvent(new CustomEvent("symphony:agent-update", { detail: msg }));
            addNotification({ type: "agent_started", message: `Agent ${msg.role} started on task #${msg.taskId}`, taskId: msg.taskId });
            addNotification({ type: "agent_started", message: `Agent ${msg.role} started on task #${msg.taskId}`, taskId: msg.taskId, projectSlug: msg.projectSlug });
          }
          if (msg.type === "agent_finished") {
            refreshOrchestratorStatus();
            window.dispatchEvent(new CustomEvent("symphony:agent-update", { detail: msg }));
            if (msg.error) {
              addNotification({ type: "agent_failed", message: `Agent failed on task #${msg.taskId}: ${msg.error}`, taskId: msg.taskId });
              addNotification({ type: "agent_failed", message: `Agent failed on task #${msg.taskId}: ${msg.error}`, taskId: msg.taskId, projectSlug: msg.projectSlug });
            }
          }
          if (msg.type === "epic_completed") {
            window.dispatchEvent(new CustomEvent("symphony:epic-completed", { detail: msg }));
            addNotification({ type: "epic_completed", message: `Epic "${msg.title}" completed!`, taskId: msg.epicId });
            addNotification({ type: "epic_completed", message: `Epic "${msg.title}" completed!`, taskId: msg.epicId, projectSlug: msg.projectSlug });
          }
          if (msg.type === "chat_message") {
            window.dispatchEvent(new CustomEvent("symphony:chat-message", { detail: msg }));
          }
          if (msg.type === "rate_limited") {
            refreshOrchestratorStatus();
            addNotification({ type: "rate_limited", message: `Rate limited — ${msg.message || "cooling down"}` });
          }
          if (msg.type === "budget_exceeded") {
            const key = `${msg.role}:${msg.project_id}`;
            const now = Date.now();
            const lastSeen = budgetAlertsSeenRef.current.get(key) ?? 0;
            if (now - lastSeen > 30_000) {
              budgetAlertsSeenRef.current.set(key, now);
              setBudgetAlerts(prev => {
                const next = new Map(prev);
                next.set(key, {
                  role: msg.role,
                  spent: msg.spent,
                  limit: msg.limit,
                  project_id: msg.project_id,
                  seenAt: now,
                });
                return next;
              });
            }
          }
        } catch {}
      };

      ws.onclose = () => {
        wsRef.current = null;
        setTimeout(connect, 5000);
      };

      wsRef.current = ws;
    }

    connect();
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [refreshOrchestratorStatus, addNotification]);

  return (
    <SymphonyContext.Provider value={{
      view, setView, projects, refreshProjects,
      orchestratorStatus, refreshOrchestratorStatus,
      roles, ws: wsRef.current,
      notifications, clearNotification,
      budgetAlerts,
    }}>
      {children}
    </SymphonyContext.Provider>
  );
}

export function useSymphony() {
  const ctx = useContext(SymphonyContext);
  if (!ctx) throw new Error("useSymphony must be used within SymphonyProvider");
  return ctx;
}

export type { Project, Task, OrchestratorStatus, Comment, Artifact, Role, ChatMessage, SymphonyView, SymphonyNotification, AuditEntry, BudgetAlert };
