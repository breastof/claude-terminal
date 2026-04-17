import { NextRequest, NextResponse } from "next/server";
import { getUser } from "@/lib/symphony-auth";
import { getDb } from "@/lib/db";
import { exec } from "child_process";
import { existsSync } from "fs";
import path from "path";

interface Task {
  id: number;
  project_id: number;
  status: string;
  version: number;
  [key: string]: unknown;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> }
) {
  const user = getUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const db = getDb();
  const task = db.prepare("SELECT * FROM sym_tasks WHERE id = ?").get(Number(id));
  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Enrich with children, deps, running session
  const children = db.prepare(`
    SELECT id, type, title, status, assigned_role, priority, estimated_effort
    FROM sym_tasks WHERE parent_id = ? ORDER BY priority DESC
  `).all(Number(id));
  const blockers = db.prepare(`
    SELECT t.id, t.title, t.status, t.type FROM sym_task_deps d
    JOIN sym_tasks t ON t.id = d.blocker_id
    WHERE d.blocked_id = ?
  `).all(Number(id));
  const blocks = db.prepare(`
    SELECT t.id, t.title, t.status, t.type FROM sym_task_deps d
    JOIN sym_tasks t ON t.id = d.blocked_id
    WHERE d.blocker_id = ?
  `).all(Number(id));
  const activeSession = db.prepare(
    "SELECT * FROM sym_agent_sessions WHERE task_id = ? AND status IN ('starting', 'running') ORDER BY started_at DESC LIMIT 1"
  ).get(Number(id));

  // Recent activity from audit log
  const activity = db.prepare(`
    SELECT * FROM sym_audit_log WHERE task_id = ? ORDER BY created_at DESC LIMIT 20
  `).all(Number(id));

  return NextResponse.json({ task, children, blockers, blocks, activeSession, activity });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> }
) {
  const user = getUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role === "guest") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const body = await request.json();
  const db = getDb();

  const task = db.prepare("SELECT * FROM sym_tasks WHERE id = ?").get(Number(id)) as Task | undefined;
  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const fields: string[] = [];
  const values: unknown[] = [];

  // Phase 5.1: expanded editable fields
  const allowedFields = [
    "title", "description", "status", "priority", "assigned_role",
    "estimated_effort", "needs_human_review", "sprint_id", "parent_id", "due_date"
  ];
  for (const key of allowedFields) {
    if (body[key] !== undefined) {
      fields.push(`${key} = ?`);
      values.push(body[key]);
    }
  }
  if (body.tags !== undefined) {
    fields.push("tags = ?");
    values.push(JSON.stringify(body.tags));
  }
  if (body.metadata !== undefined) {
    fields.push("metadata = ?");
    values.push(JSON.stringify(body.metadata));
  }
  // Clear stale next_retry_at when status is explicitly set (task #208)
  if (body.status !== undefined) {
    fields.push("next_retry_at = NULL");
  }

  if (fields.length === 0) return NextResponse.json({ error: "No fields to update" }, { status: 400 });

  // Optimistic locking
  fields.push("version = version + 1");
  fields.push("updated_at = datetime('now')");
  values.push(Number(id));
  values.push(body.version || task.version);

  const result = db.prepare(`UPDATE sym_tasks SET ${fields.join(", ")} WHERE id = ? AND version = ?`).run(...values);
  if (result.changes === 0) {
    return NextResponse.json({ error: "Version conflict — task was modified concurrently" }, { status: 409 });
  }

  // Status change comment + audit
  if (body.status && body.status !== task.status) {
    db.prepare(`
      INSERT INTO sym_comments (task_id, author_user_id, content, type)
      VALUES (?, ?, ?, 'status_change')
    `).run(Number(id), user.userId, `Status: ${task.status} → ${body.status}`);

    // Audit log
    try {
      db.prepare(`
        INSERT INTO sym_audit_log (task_id, project_id, action, old_value, new_value, actor_type, actor_id)
        VALUES (?, ?, 'status_change', ?, ?, 'user', ?)
      `).run(Number(id), task.project_id, task.status, body.status, String(user.userId));
    } catch (e) {
      console.warn('audit log failed:', e);
    }

    // Hub capture: when task manually set to "done", create Hub note
    if (body.status === "done") {
      const scriptPath = path.join(process.env.HOME || "/root", ".claude/scripts/task-to-hub.sh");
      const dbPath = path.join(process.cwd(), "data/claude-terminal.db");
      if (existsSync(scriptPath)) {
        exec(`bash "${scriptPath}" ${Number(id)} "${dbPath}"`, { timeout: 120000 }, (err, stdout, stderr) => {
          if (err) {
            console.error(`[hub-capture] Failed for task #${id}:`, stderr || err.message);
          } else if (stdout?.trim()) {
            console.log(`[hub-capture] Note created for task #${id}: ${stdout.trim()}`);
          }
        });
      }
    }
  }

  // Audit for other field changes
  if (body.title && body.title !== task.title) {
    try {
      db.prepare(`
        INSERT INTO sym_audit_log (task_id, project_id, action, old_value, new_value, actor_type, actor_id)
        VALUES (?, ?, 'field_update', ?, ?, 'user', ?)
      `).run(Number(id), task.project_id, `title:${task.title}`, `title:${body.title}`, String(user.userId));
    } catch (e) {
      console.warn('audit log failed:', e);
    }
  }
  if (body.priority !== undefined && body.priority !== task.priority) {
    try {
      db.prepare(`
        INSERT INTO sym_audit_log (task_id, project_id, action, old_value, new_value, actor_type, actor_id)
        VALUES (?, ?, 'field_update', ?, ?, 'user', ?)
      `).run(Number(id), task.project_id, `priority:${task.priority}`, `priority:${body.priority}`, String(user.userId));
    } catch (e) {
      console.warn('audit log failed:', e);
    }
  }

  const updated = db.prepare("SELECT * FROM sym_tasks WHERE id = ?").get(Number(id));
  return NextResponse.json({ task: updated });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> }
) {
  const user = getUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const db = getDb();

  // Get task info for audit
  const task = db.prepare("SELECT * FROM sym_tasks WHERE id = ?").get(Number(id)) as Task | undefined;

  // Check for children
  const childCount = db.prepare("SELECT COUNT(*) as c FROM sym_tasks WHERE parent_id = ?").get(Number(id)) as { c: number };
  if (childCount.c > 0) {
    // Delete children too (cascade)
    db.prepare("DELETE FROM sym_tasks WHERE parent_id = ?").run(Number(id));
  }

  db.prepare("DELETE FROM sym_tasks WHERE id = ?").run(Number(id));

  // Audit log
  if (task) {
    try {
      db.prepare(`
        INSERT INTO sym_audit_log (task_id, project_id, action, old_value, actor_type, actor_id)
        VALUES (?, ?, 'task_deleted', ?, 'user', ?)
      `).run(Number(id), task.project_id, task.title as string, String(user.userId));
    } catch (e) {
      console.warn('audit log failed:', e);
    }
  }

  return NextResponse.json({ ok: true, children_deleted: childCount.c });
}
