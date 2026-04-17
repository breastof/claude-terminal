"use client";

import { useState, useEffect, useCallback } from "react";
import { ChevronLeft } from "@/components/Icons";
import { useSymphony, type Comment, type Artifact, type Task, type AuditEntry } from "@/lib/SymphonyContext";

const STATUS_OPTIONS = ["backlog", "analysis", "design", "development", "code_review", "qa", "uat", "done", "pending_cancel", "cancelled", "failed"];
const EFFORT_OPTIONS = ["xs", "s", "m", "l", "xl"];

const COMMENT_TYPE_BADGES: Record<string, { label: string; class: string }> = {
  comment: { label: "", class: "" },
  status_change: { label: "статус", class: "bg-blue-500/10 text-blue-400" },
  system: { label: "система", class: "bg-gray-500/10 text-gray-400" },
  handoff: { label: "handoff", class: "bg-purple-500/10 text-purple-400" },
  review: { label: "ревью", class: "bg-orange-500/10 text-orange-400" },
  approval: { label: "одобрено", class: "bg-green-500/10 text-green-400" },
  rejection: { label: "отклонено", class: "bg-red-500/10 text-red-400" },
};

const ROLE_COLORS: Record<string, string> = {
  cto: "#dc2626", pm: "#8b5cf6", "scrum-master": "#06b6d4", analyst: "#f59e0b",
  researcher: "#a78bfa", designer: "#ec4899", "frontend-dev": "#3b82f6",
  "backend-dev": "#10b981", reviewer: "#f97316", qa: "#14b8a6",
};

interface TaskDetailData {
  task: Task;
  children: Task[];
  blockers: { id: number; title: string; status: string; type: string }[];
  blocks: { id: number; title: string; status: string; type: string }[];
  activeSession: { id: number; role_slug: string; status: string; started_at: string } | null;
  activity: AuditEntry[];
}

// Parse [file:path:lines] references in text
function renderContent(text: string): React.ReactNode {
  const parts = text.split(/(\[file:[^\]]+\])/g);
  return parts.map((part, i) => {
    const match = part.match(/\[file:([^:\]]+)(?::(\S+))?\]/);
    if (match) {
      return (
        <code key={i} className="text-accent-fg bg-accent/5 px-1 rounded text-[10px]" title={match[0]}>
          {match[1]}{match[2] ? `:${match[2]}` : ""}
        </code>
      );
    }
    return part;
  });
}

export default function TaskDetail({ slug, taskId }: { slug: string; taskId: number }) {
  const { setView, roles } = useSymphony();
  const [data, setData] = useState<TaskDetailData | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [newComment, setNewComment] = useState("");
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"comments" | "artifacts" | "children" | "activity">("comments");

  // Inline editing state
  const [editingTitle, setEditingTitle] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editingDesc, setEditingDesc] = useState(false);
  const [editDesc, setEditDesc] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [sprints, setSprints] = useState<{ id: number; name: string; status: string }[]>([]);

  const fetchTask = useCallback(async () => {
    try {
      const res = await fetch(`/api/symphony/v2/projects/${slug}/tasks/${taskId}`);
      if (res.ok) setData(await res.json());
    } catch {} finally { setLoading(false); }
  }, [slug, taskId]);

  const fetchComments = useCallback(async () => {
    try {
      const res = await fetch(`/api/symphony/v2/projects/${slug}/tasks/${taskId}/comments`);
      if (res.ok) {
        const d = await res.json();
        setComments(d.comments || []);
      }
    } catch {}
  }, [slug, taskId]);

  const fetchArtifacts = useCallback(async () => {
    try {
      const res = await fetch(`/api/symphony/v2/projects/${slug}/tasks/${taskId}/artifacts`);
      if (res.ok) {
        const d = await res.json();
        setArtifacts(d.artifacts || []);
      }
    } catch {}
  }, [slug, taskId]);

  const fetchSprints = useCallback(async () => {
    try {
      const res = await fetch(`/api/symphony/v2/projects/${slug}/sprints`);
      if (res.ok) {
        const data = await res.json();
        setSprints((data.sprints || []).filter((s: { status: string }) => s.status !== "completed"));
      }
    } catch {}
  }, [slug]);

  useEffect(() => {
    fetchTask();
    fetchComments();
    fetchArtifacts();
    fetchSprints();
  }, [fetchTask, fetchComments, fetchArtifacts, fetchSprints]);

  // WS updates
  useEffect(() => {
    const handler = () => { fetchTask(); fetchComments(); };
    window.addEventListener("symphony:task-update", handler);
    window.addEventListener("symphony:agent-update", handler);
    return () => {
      window.removeEventListener("symphony:task-update", handler);
      window.removeEventListener("symphony:agent-update", handler);
    };
  }, [fetchTask, fetchComments]);

  const patchTask = async (fields: Record<string, unknown>) => {
    if (!data) return;
    await fetch(`/api/symphony/v2/projects/${slug}/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...fields, version: data.task.version }),
    });
    fetchTask();
    fetchComments();
  };

  const handleStatusChange = (newStatus: string) => patchTask({ status: newStatus });

  const handleComment = async () => {
    if (!newComment.trim()) return;
    await fetch(`/api/symphony/v2/projects/${slug}/tasks/${taskId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: newComment }),
    });
    setNewComment("");
    fetchComments();
  };

  const handleDeleteComment = async (commentId: number) => {
    await fetch(`/api/symphony/v2/projects/${slug}/tasks/${taskId}/comments?comment_id=${commentId}`, { method: "DELETE" });
    fetchComments();
  };

  const handleDeleteTask = async () => {
    await fetch(`/api/symphony/v2/projects/${slug}/tasks/${taskId}`, { method: "DELETE" });
    setView({ type: "project", slug });
  };

  const handleSaveTitle = () => {
    if (editTitle.trim() && data && editTitle !== data.task.title) {
      patchTask({ title: editTitle.trim() });
    }
    setEditingTitle(false);
  };

  const handleSaveDesc = () => {
    if (data && editDesc !== data.task.description) {
      patchTask({ description: editDesc });
    }
    setEditingDesc(false);
  };

  if (loading || !data) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin h-6 w-6 border-2 border-accent border-t-transparent rounded-full" />
      </div>
    );
  }

  const { task, children, blockers, blocks, activeSession, activity } = data;
  const tags: string[] = (() => { try { return JSON.parse(task.tags); } catch { return []; } })();

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="h-12 px-4 flex items-center gap-2 border-b border-border bg-surface">
        <button onClick={() => setView({ type: "project", slug })} className="text-muted-fg hover:text-foreground cursor-pointer">
          <ChevronLeft className="w-4 h-4" />
        </button>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-400">{task.type}</span>
        {editingTitle ? (
          <input
            value={editTitle}
            onChange={e => setEditTitle(e.target.value)}
            onBlur={handleSaveTitle}
            onKeyDown={e => { if (e.key === "Enter") handleSaveTitle(); if (e.key === "Escape") setEditingTitle(false); }}
            className="text-sm font-medium text-foreground bg-surface-alt border border-accent rounded px-2 py-0.5 flex-1 outline-none"
            autoFocus
          />
        ) : (
          <span
            className="text-sm font-medium text-foreground truncate cursor-pointer hover:text-accent-fg"
            onClick={() => { setEditTitle(task.title); setEditingTitle(true); }}
          >
            #{task.id} {task.title}
          </span>
        )}
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Main content */}
        <div className="flex-1 overflow-y-auto p-4">
          {/* Description */}
          <div className="mb-4">
            <div className="text-xs text-muted-fg mb-1">Описание</div>
            {editingDesc ? (
              <div>
                <textarea
                  value={editDesc}
                  onChange={e => setEditDesc(e.target.value)}
                  onBlur={handleSaveDesc}
                  rows={6}
                  className="w-full text-sm text-foreground bg-surface-alt p-3 rounded-lg border border-accent outline-none resize-none"
                  autoFocus
                />
                <div className="flex gap-2 mt-1">
                  <button onClick={handleSaveDesc} className="text-[10px] text-accent-fg hover:underline cursor-pointer">Сохранить</button>
                  <button onClick={() => setEditingDesc(false)} className="text-[10px] text-muted-fg hover:underline cursor-pointer">Отмена</button>
                </div>
              </div>
            ) : (
              <div
                className="text-sm text-foreground whitespace-pre-wrap bg-surface-alt p-3 rounded-lg border border-border cursor-pointer hover:border-accent/30"
                onClick={() => { setEditDesc(task.description || ""); setEditingDesc(true); }}
              >
                {task.description ? renderContent(task.description) : "(нет описания — нажмите для редактирования)"}
              </div>
            )}
          </div>

          {/* Tabs */}
          <div className="flex gap-1 mb-3 border-b border-border">
            {(["comments", "artifacts", "children", "activity"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-3 py-1.5 text-xs border-b-2 transition-colors cursor-pointer ${
                  tab === t ? "border-accent text-accent-fg" : "border-transparent text-muted-fg hover:text-foreground"
                }`}
              >
                {t === "comments" && `Комментарии (${comments.length})`}
                {t === "artifacts" && `Артефакты (${artifacts.length})`}
                {t === "children" && `Подзадачи (${children.length})`}
                {t === "activity" && `Активность (${(activity || []).length})`}
              </button>
            ))}
          </div>

          {/* Tab content */}
          {tab === "comments" && (
            <div className="space-y-2">
              {comments.map((c) => {
                const badge = COMMENT_TYPE_BADGES[c.type] || COMMENT_TYPE_BADGES.comment;
                const isAgent = !!c.author_role && !c.author_user_id;
                const roleColor = c.author_role ? ROLE_COLORS[c.author_role] : undefined;
                const authorName = c.author_first_name
                  ? `${c.author_first_name}${c.author_last_name ? " " + c.author_last_name : ""}`
                  : c.author_username || c.author_role || "user";

                return (
                  <div key={c.id} className={`p-2.5 rounded-lg border border-border/50 ${
                    isAgent ? "bg-surface-alt/50" : "bg-surface/50"
                  }`}>
                    <div className="flex items-center gap-2 mb-1">
                      {isAgent ? (
                        <span
                          className="text-[10px] font-medium px-1.5 py-0.5 rounded"
                          style={roleColor ? { backgroundColor: roleColor + "15", color: roleColor } : {}}
                        >
                          🤖 {c.author_role}
                        </span>
                      ) : (
                        <span className="text-[10px] font-medium text-foreground">
                          👤 {authorName}
                        </span>
                      )}
                      {badge.label && (
                        <span className={`text-[9px] px-1 rounded ${badge.class}`}>{badge.label}</span>
                      )}
                      {c.mention_role && (
                        <span className="text-[9px] text-accent-fg">@{c.mention_role}</span>
                      )}
                      <span className="text-[9px] text-muted ml-auto">
                        {new Date(c.created_at + "Z").toLocaleString("ru-RU", { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" })}
                      </span>
                      {c.author_user_id && (
                        <button
                          onClick={() => handleDeleteComment(c.id)}
                          className="text-[9px] text-muted hover:text-danger cursor-pointer opacity-0 group-hover:opacity-100"
                          title="Удалить"
                        >
                          ×
                        </button>
                      )}
                    </div>
                    <div className="text-xs text-foreground whitespace-pre-wrap">{renderContent(c.content)}</div>
                    {c.file_path && (
                      <div className="text-[10px] text-accent-fg mt-1">
                        📁 {c.file_path}{c.line_range ? `:${c.line_range}` : ""}
                      </div>
                    )}
                  </div>
                );
              })}

              {/* New comment */}
              <div className="flex gap-2 mt-3">
                <input
                  type="text"
                  placeholder="Написать комментарий..."
                  value={newComment}
                  onChange={(e) => setNewComment(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleComment(); }}
                  className="flex-1 px-3 py-1.5 text-xs bg-surface border border-border rounded-lg outline-none focus:border-accent text-foreground placeholder:text-muted"
                />
                <button
                  onClick={handleComment}
                  className="px-3 py-1.5 text-xs bg-accent text-white rounded-lg hover:bg-accent/90 cursor-pointer"
                >
                  Отправить
                </button>
              </div>
            </div>
          )}

          {tab === "artifacts" && (
            <div className="space-y-2">
              {artifacts.length === 0 ? (
                <div className="text-xs text-muted-fg text-center py-4">Нет артефактов</div>
              ) : artifacts.map((a) => (
                <div key={a.id} className="p-2.5 rounded-lg bg-surface-alt/50 border border-border/50">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[10px] px-1.5 rounded bg-accent-muted text-accent-fg">{a.type}</span>
                    <span className="text-xs text-foreground">{a.title}</span>
                    {a.created_by_role && (
                      <span
                        className="text-[9px] text-muted-fg ml-auto px-1 rounded"
                        style={ROLE_COLORS[a.created_by_role] ? { color: ROLE_COLORS[a.created_by_role] } : {}}
                      >
                        {a.created_by_role}
                      </span>
                    )}
                  </div>
                  {a.file_path && <div className="text-[10px] text-muted-fg">📁 {a.file_path}</div>}
                  {a.content && (
                    <pre className="text-[10px] text-foreground mt-1 p-2 bg-surface rounded border border-border overflow-x-auto max-h-48">
                      {a.content.slice(0, 3000)}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          )}

          {tab === "children" && (
            <div className="space-y-1.5">
              {children.length === 0 ? (
                <div className="text-xs text-muted-fg text-center py-4">Нет подзадач</div>
              ) : children.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setView({ type: "task", slug, taskId: c.id })}
                  className="w-full px-3 py-2 rounded-lg bg-surface-alt/50 border border-border/50 hover:border-accent/30 transition-colors text-left cursor-pointer flex items-center gap-2"
                >
                  <span className="text-[9px] px-1 rounded bg-blue-500/10 text-blue-400">{c.type}</span>
                  <span className="text-xs text-foreground flex-1 truncate">{c.title}</span>
                  <span className="text-[9px] text-muted-fg">{c.status}</span>
                  {c.assigned_role && <span className="text-[9px] text-muted">{c.assigned_role}</span>}
                </button>
              ))}
            </div>
          )}

          {tab === "activity" && (
            <div className="space-y-1">
              {(!activity || activity.length === 0) ? (
                <div className="text-xs text-muted-fg text-center py-4">Нет активности</div>
              ) : activity.map((a) => (
                <div key={a.id} className="flex items-center gap-2 py-1.5 border-b border-border/30 text-[10px]">
                  <span className={`w-2 h-2 rounded-full ${
                    a.action === "status_change" ? "bg-blue-400" :
                    a.action === "task_created" ? "bg-green-400" :
                    a.action === "task_deleted" ? "bg-red-400" :
                    "bg-gray-400"
                  }`} />
                  <span className="text-foreground">{a.action}</span>
                  {a.old_value && <span className="text-muted-fg">{a.old_value}</span>}
                  {a.old_value && a.new_value && <span className="text-muted">→</span>}
                  {a.new_value && <span className="text-foreground">{a.new_value}</span>}
                  <span className="text-muted ml-auto">
                    {a.actor_type}:{a.actor_id || "system"}
                  </span>
                  <span className="text-muted">
                    {new Date(a.created_at + "Z").toLocaleString("ru-RU", { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" })}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Sidebar */}
        <div className="w-60 border-l border-border bg-surface p-3 overflow-y-auto flex-shrink-0">
          {/* Status */}
          <div className="mb-3">
            <div className="text-[10px] text-muted-fg mb-1">Статус</div>
            <select
              value={task.status}
              onChange={(e) => handleStatusChange(e.target.value)}
              className="w-full px-2 py-1 text-xs bg-surface-alt border border-border rounded text-foreground outline-none"
            >
              {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          {/* Priority */}
          <div className="mb-3">
            <div className="text-[10px] text-muted-fg mb-1">Приоритет: {task.priority}</div>
            <input
              type="range"
              min={0} max={100}
              value={task.priority}
              onChange={e => patchTask({ priority: Number(e.target.value) })}
              className="w-full"
            />
          </div>

          {/* Assigned role */}
          <div className="mb-3">
            <div className="text-[10px] text-muted-fg mb-1">Роль</div>
            <select
              value={task.assigned_role || ""}
              onChange={e => patchTask({ assigned_role: e.target.value || null })}
              className="w-full px-2 py-1 text-xs bg-surface-alt border border-border rounded text-foreground outline-none"
            >
              <option value="">Авто</option>
              {roles.map(r => <option key={r.slug} value={r.slug}>{r.name}</option>)}
            </select>
          </div>

          {/* Effort */}
          <div className="mb-3">
            <div className="text-[10px] text-muted-fg mb-1">Объём</div>
            <select
              value={task.estimated_effort || ""}
              onChange={e => patchTask({ estimated_effort: e.target.value || null })}
              className="w-full px-2 py-1 text-xs bg-surface-alt border border-border rounded text-foreground outline-none"
            >
              <option value="">—</option>
              {EFFORT_OPTIONS.map(e => <option key={e} value={e}>{e.toUpperCase()}</option>)}
            </select>
          </div>

          {/* Due date */}
          <div className="mb-3">
            <div className="text-[10px] text-muted-fg mb-1">Срок</div>
            <input
              type="date"
              value={task.due_date || ""}
              onChange={e => patchTask({ due_date: e.target.value || null })}
              className="w-full px-2 py-1 text-xs bg-surface-alt border border-border rounded text-foreground outline-none"
            />
          </div>

          {/* Sprint */}
          {sprints.length > 0 && (
            <div className="mb-3">
              <div className="text-[10px] text-muted-fg mb-1">Спринт</div>
              <select
                value={task.sprint_id || ""}
                onChange={e => patchTask({ sprint_id: e.target.value ? Number(e.target.value) : null })}
                className="w-full px-2 py-1 text-xs bg-surface-alt border border-border rounded text-foreground outline-none"
              >
                <option value="">Бэклог</option>
                {sprints.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          )}

          {/* Tags */}
          <div className="mb-3">
            <div className="text-[10px] text-muted-fg mb-1">Теги</div>
            <div className="flex flex-wrap gap-1 mb-1">
              {tags.map(t => (
                <span key={t} className="text-[9px] px-1.5 py-0.5 bg-surface-alt rounded text-foreground inline-flex items-center gap-1">
                  {t}
                  <button
                    onClick={() => patchTask({ tags: tags.filter(tag => tag !== t) })}
                    className="text-muted hover:text-danger cursor-pointer"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            <input
              type="text"
              placeholder="Добавить тег..."
              onKeyDown={e => {
                if (e.key === "Enter" && (e.target as HTMLInputElement).value.trim()) {
                  const val = (e.target as HTMLInputElement).value.trim();
                  if (!tags.includes(val)) patchTask({ tags: [...tags, val] });
                  (e.target as HTMLInputElement).value = "";
                }
              }}
              className="w-full px-2 py-1 text-[10px] bg-surface-alt border border-border rounded text-foreground outline-none placeholder:text-muted"
            />
          </div>

          {/* Active session */}
          {activeSession && (
            <div className="mb-3">
              <div className="text-[10px] text-muted-fg mb-1">Агент</div>
              <div className="text-xs text-success animate-pulse">
                🤖 {activeSession.role_slug} — {activeSession.status}
              </div>
            </div>
          )}

          {/* Dependencies */}
          {blockers.length > 0 && (
            <div className="mb-3">
              <div className="text-[10px] text-muted-fg mb-1">Заблокировано</div>
              {blockers.map(b => (
                <button
                  key={b.id}
                  onClick={() => setView({ type: "task", slug, taskId: b.id })}
                  className="text-xs text-accent-fg hover:underline cursor-pointer block"
                >
                  #{b.id} {b.title} ({b.status})
                </button>
              ))}
            </div>
          )}

          {blocks.length > 0 && (
            <div className="mb-3">
              <div className="text-[10px] text-muted-fg mb-1">Блокирует</div>
              {blocks.map(b => (
                <button
                  key={b.id}
                  onClick={() => setView({ type: "task", slug, taskId: b.id })}
                  className="text-xs text-accent-fg hover:underline cursor-pointer block"
                >
                  #{b.id} {b.title} ({b.status})
                </button>
              ))}
            </div>
          )}

          {/* Actions */}
          <div className="mt-4 space-y-2">
            {/* Cancel button */}
            {!["done", "cancelled", "pending_cancel", "failed"].includes(task.status) && (
              <button
                onClick={() => handleStatusChange("pending_cancel")}
                className="w-full py-1.5 text-xs bg-danger/10 text-danger rounded hover:bg-danger/20 cursor-pointer"
              >
                Отменить задачу
              </button>
            )}

            {/* Re-queue failed task */}
            {task.status === "failed" && (
              <button
                onClick={() => handleStatusChange("backlog")}
                className="w-full py-1.5 text-xs bg-warning/10 text-warning rounded hover:bg-warning/20 cursor-pointer"
              >
                Вернуть в очередь
              </button>
            )}

            {/* UAT Controls */}
            {task.status === "uat" && (
              <>
                <button
                  onClick={() => handleStatusChange("done")}
                  className="w-full py-1.5 text-xs bg-success/10 text-success rounded hover:bg-success/20 cursor-pointer"
                >
                  Одобрить
                </button>
                <button
                  onClick={() => handleStatusChange("development")}
                  className="w-full py-1.5 text-xs bg-danger/10 text-danger rounded hover:bg-danger/20 cursor-pointer"
                >
                  Отклонить
                </button>
              </>
            )}

            {/* Delete */}
            {confirmDelete ? (
              <div className="flex gap-2">
                <button onClick={handleDeleteTask} className="flex-1 py-1.5 text-xs bg-danger text-white rounded cursor-pointer">
                  Подтвердить
                </button>
                <button onClick={() => setConfirmDelete(false)} className="flex-1 py-1.5 text-xs bg-surface-alt text-muted-fg rounded cursor-pointer">
                  Отмена
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmDelete(true)}
                className="w-full py-1.5 text-xs text-danger/60 hover:text-danger cursor-pointer"
              >
                Удалить задачу
              </button>
            )}
          </div>

          {/* Metadata */}
          <div className="mt-4 text-[9px] text-muted space-y-0.5">
            <div>Попытка: {task.attempt}/3</div>
            <div>Версия: {task.version}</div>
            <div>Создан: {new Date(task.created_at + "Z").toLocaleString("ru-RU")}</div>
            <div>Обновлён: {new Date(task.updated_at + "Z").toLocaleString("ru-RU")}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
