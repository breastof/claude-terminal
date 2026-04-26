"use client";

import { useState, useEffect } from "react";
import { useSymphony } from "@/lib/SymphonyContext";

interface CreateTaskModalProps {
  projectSlug: string;
  parentId?: number;
  onClose: () => void;
  onCreated: () => void;
}

const EFFORT_OPTIONS = ["xs", "s", "m", "l", "xl"];

export default function CreateTaskModal({ projectSlug, parentId, onClose, onCreated }: CreateTaskModalProps) {
  const { roles } = useSymphony();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<string>(parentId ? "task" : "epic");
  const [priority, setPriority] = useState(50);
  const [assignedRole, setAssignedRole] = useState("");
  const [tags, setTags] = useState("");
  const [effort, setEffort] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [sprintId, setSprintId] = useState("");
  const [sprints, setSprints] = useState<{ id: number; name: string; status: string }[]>([]);
  const [needsReview, setNeedsReview] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch(`/api/symphony/v2/projects/${projectSlug}/sprints`)
      .then(r => r.ok ? r.json() : { sprints: [] })
      .then(d => setSprints((d.sprints || []).filter((s: { status: string }) => s.status !== "completed")))
      .catch(() => {});
  }, [projectSlug]);

  const handleSubmit = async () => {
    if (!title.trim() || submitting) return;
    setSubmitting(true);

    try {
      const res = await fetch(`/api/symphony/v2/projects/${projectSlug}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          description,
          type,
          parent_id: parentId || null,
          priority,
          assigned_role: assignedRole || null,
          estimated_effort: effort || null,
          due_date: dueDate || null,
          sprint_id: sprintId ? Number(sprintId) : null,
          tags: tags.split(",").map(t => t.trim()).filter(Boolean),
          needs_human_review: needsReview,
        }),
      });
      if (res.ok) onCreated();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl w-[520px] max-h-[85dvh] overflow-y-auto shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <span className="text-sm font-medium text-foreground">Новая задача</span>
          <button onClick={onClose} className="text-muted-fg hover:text-foreground cursor-pointer text-lg">×</button>
        </div>

        <div className="p-4 space-y-3">
          {/* Type */}
          <div>
            <label className="text-[10px] text-muted-fg block mb-1">Тип</label>
            <div className="flex gap-1">
              {["epic", "story", "task", "subtask"].map(t => (
                <button
                  key={t}
                  onClick={() => setType(t)}
                  className={`px-3 py-1 text-xs rounded-md cursor-pointer transition-colors ${
                    type === t ? "bg-accent text-white" : "bg-surface-alt text-muted-fg hover:text-foreground"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          {/* Title */}
          <div>
            <label className="text-[10px] text-muted-fg block mb-1">Название</label>
            <input
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder={type === "epic" ? "Build authentication system" : "Название задачи..."}
              className="w-full px-3 py-2 text-sm bg-surface-alt border border-border rounded-lg outline-none focus:border-accent text-foreground placeholder:text-muted"
              autoFocus
              onKeyDown={e => { if (e.key === "Enter" && e.metaKey) handleSubmit(); }}
            />
          </div>

          {/* Description */}
          <div>
            <label className="text-[10px] text-muted-fg block mb-1">Описание</label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Подробное описание задачи, acceptance criteria..."
              rows={4}
              className="w-full px-3 py-2 text-sm bg-surface-alt border border-border rounded-lg outline-none focus:border-accent text-foreground placeholder:text-muted resize-none"
            />
          </div>

          {/* Priority + Effort row */}
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="text-[10px] text-muted-fg block mb-1">Приоритет: {priority}</label>
              <input
                type="range"
                min={0}
                max={100}
                value={priority}
                onChange={e => setPriority(Number(e.target.value))}
                className="w-full"
              />
            </div>
            <div className="w-24">
              <label className="text-[10px] text-muted-fg block mb-1">Объём</label>
              <select
                value={effort}
                onChange={e => setEffort(e.target.value)}
                className="w-full px-2 py-1.5 text-xs bg-surface-alt border border-border rounded-lg text-foreground outline-none"
              >
                <option value="">—</option>
                {EFFORT_OPTIONS.map(e => <option key={e} value={e}>{e.toUpperCase()}</option>)}
              </select>
            </div>
          </div>

          {/* Role + Due date row */}
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="text-[10px] text-muted-fg block mb-1">Роль (опционально)</label>
              <select
                value={assignedRole}
                onChange={e => setAssignedRole(e.target.value)}
                className="w-full px-2 py-1.5 text-xs bg-surface-alt border border-border rounded-lg text-foreground outline-none"
              >
                <option value="">Автоматически</option>
                {roles.map(r => <option key={r.slug} value={r.slug}>{r.name}</option>)}
              </select>
            </div>
            <div className="w-36">
              <label className="text-[10px] text-muted-fg block mb-1">Срок</label>
              <input
                type="date"
                value={dueDate}
                onChange={e => setDueDate(e.target.value)}
                className="w-full px-2 py-1.5 text-xs bg-surface-alt border border-border rounded-lg text-foreground outline-none"
              />
            </div>
          </div>

          {/* Sprint */}
          {sprints.length > 0 && (
            <div>
              <label className="text-[10px] text-muted-fg block mb-1">Спринт</label>
              <select
                value={sprintId}
                onChange={e => setSprintId(e.target.value)}
                className="w-full px-2 py-1.5 text-xs bg-surface-alt border border-border rounded-lg text-foreground outline-none"
              >
                <option value="">Бэклог</option>
                {sprints.map(s => <option key={s.id} value={s.id}>{s.name} ({s.status})</option>)}
              </select>
            </div>
          )}

          {/* Tags */}
          <div>
            <label className="text-[10px] text-muted-fg block mb-1">Теги (через запятую)</label>
            <input
              type="text"
              value={tags}
              onChange={e => setTags(e.target.value)}
              placeholder="frontend, api, database, strategic"
              className="w-full px-3 py-1.5 text-xs bg-surface-alt border border-border rounded-lg outline-none focus:border-accent text-foreground placeholder:text-muted"
            />
          </div>

          {/* Human review */}
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={needsReview}
              onChange={e => setNeedsReview(e.target.checked)}
              className="rounded"
            />
            <span className="text-xs text-foreground">Требует ручной проверки (UAT)</span>
          </label>
        </div>

        <div className="px-4 py-3 border-t border-border flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-1.5 text-xs text-muted-fg hover:text-foreground cursor-pointer">
            Отмена
          </button>
          <button
            onClick={handleSubmit}
            disabled={!title.trim() || submitting}
            className="px-4 py-1.5 text-xs bg-accent text-white rounded-lg hover:bg-accent/90 disabled:opacity-50 cursor-pointer"
          >
            {submitting ? "Создание..." : "Создать"}
          </button>
        </div>
      </div>
    </div>
  );
}
