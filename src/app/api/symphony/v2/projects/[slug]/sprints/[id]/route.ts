import { NextRequest, NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { getDb } from "@/lib/db";

function getUser(req: NextRequest) {
  const token = req.cookies.get("auth-token")?.value;
  return token ? verifyToken(token) : null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> }
) {
  const user = getUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const db = getDb();

  const sprint = db.prepare("SELECT * FROM sym_sprints WHERE id = ?").get(Number(id));
  if (!sprint) return NextResponse.json({ error: "Sprint not found" }, { status: 404 });

  const tasks = db.prepare(`
    SELECT t.*,
      (SELECT COUNT(*) FROM sym_tasks WHERE parent_id = t.id) as children_count,
      EXISTS(SELECT 1 FROM sym_agent_sessions s WHERE s.task_id = t.id AND s.status IN ('starting','running')) as has_active_agent,
      (SELECT COUNT(*) FROM sym_task_deps d
        JOIN sym_tasks bt ON bt.id = d.blocker_id
        WHERE d.blocked_id = t.id AND bt.status NOT IN ('done','cancelled')) as unresolved_blockers
    FROM sym_tasks t WHERE t.sprint_id = ?
    ORDER BY t.priority DESC, t.created_at ASC
  `).all(Number(id));

  return NextResponse.json({ sprint, tasks });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> }
) {
  const user = getUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role === "guest") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { slug, id } = await params;
  const body = await request.json();
  const db = getDb();

  const project = db.prepare("SELECT id FROM sym_projects WHERE slug = ?").get(slug) as { id: number } | undefined;

  const fields: string[] = [];
  const values: unknown[] = [];

  for (const key of ["name", "goal", "status", "start_date", "end_date"]) {
    if (body[key] !== undefined) {
      fields.push(`${key} = ?`);
      values.push(body[key]);
    }
  }

  if (fields.length === 0) return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  values.push(Number(id));

  const oldSprint = db.prepare("SELECT * FROM sym_sprints WHERE id = ?").get(Number(id)) as { status: string } | undefined;

  db.prepare(`UPDATE sym_sprints SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  const sprint = db.prepare("SELECT * FROM sym_sprints WHERE id = ?").get(Number(id));

  // When completing a sprint, optionally move undone tasks to next sprint
  if (body.status === "completed" && body.next_sprint_id) {
    db.prepare(`
      UPDATE sym_tasks SET sprint_id = ? WHERE sprint_id = ? AND status != 'done' AND status != 'cancelled'
    `).run(body.next_sprint_id, Number(id));
  }

  // Audit log
  if (body.status && oldSprint && body.status !== oldSprint.status && project) {
    try {
      db.prepare(`
        INSERT INTO sym_audit_log (project_id, action, old_value, new_value, actor_type, actor_id)
        VALUES (?, 'sprint_status_change', ?, ?, 'user', ?)
      `).run(project.id, oldSprint.status, body.status, user.login);
    } catch {}
  }

  return NextResponse.json({ sprint });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> }
) {
  const user = getUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role === "guest") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const db = getDb();

  // Unassign tasks from this sprint
  db.prepare("UPDATE sym_tasks SET sprint_id = NULL WHERE sprint_id = ?").run(Number(id));
  db.prepare("DELETE FROM sym_sprints WHERE id = ?").run(Number(id));

  return NextResponse.json({ ok: true });
}
