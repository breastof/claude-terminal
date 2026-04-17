import { NextRequest, NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { getDb } from "@/lib/db";

function getUser(req: NextRequest) {
  const token = req.cookies.get("auth-token")?.value;
  return token ? verifyToken(token) : null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const user = getUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { slug } = await params;
  const db = getDb();
  const project = db.prepare("SELECT id FROM sym_projects WHERE slug = ?").get(slug) as { id: number } | undefined;
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  const by_status = db.prepare(`
    SELECT status, COUNT(*) as count FROM sym_tasks WHERE project_id = ? GROUP BY status ORDER BY count DESC
  `).all(project.id);

  const by_type = db.prepare(`
    SELECT type, COUNT(*) as count FROM sym_tasks WHERE project_id = ? GROUP BY type ORDER BY count DESC
  `).all(project.id);

  const by_role = db.prepare(`
    SELECT assigned_role, COUNT(*) as count FROM sym_tasks WHERE project_id = ? GROUP BY assigned_role ORDER BY count DESC
  `).all(project.id);

  const sessions = db.prepare(`
    SELECT s.role_slug, COUNT(*) as count,
      SUM(s.tokens_in) as total_tokens_in,
      SUM(s.tokens_out) as total_tokens_out,
      SUM(s.cost_usd) as total_cost
    FROM sym_agent_sessions s
    JOIN sym_tasks t ON t.id = s.task_id
    WHERE t.project_id = ?
    GROUP BY s.role_slug
  `).all(project.id);

  const total = db.prepare("SELECT COUNT(*) as count FROM sym_tasks WHERE project_id = ?").get(project.id) as { count: number };
  const done = db.prepare("SELECT COUNT(*) as count FROM sym_tasks WHERE project_id = ? AND status = 'done'").get(project.id) as { count: number };

  // Average cycle time (hours) for done tasks
  const avgCycle = db.prepare(`
    SELECT AVG((julianday(updated_at) - julianday(created_at)) * 24) as avg_hours
    FROM sym_tasks
    WHERE project_id = ? AND status = 'done'
  `).get(project.id) as { avg_hours: number | null };

  // Recent activity from audit log
  let recent_activity: unknown[] = [];
  try {
    recent_activity = db.prepare(`
      SELECT * FROM sym_audit_log WHERE project_id = ? ORDER BY created_at DESC LIMIT 20
    `).all(project.id);
  } catch {}

  return NextResponse.json({
    total_tasks: total.count,
    done_count: done.count,
    completion: total.count > 0 ? Math.round((done.count / total.count) * 100) : 0,
    avg_cycle_hours: avgCycle?.avg_hours || null,
    by_status,
    by_type,
    by_role,
    sessions,
    recent_activity,
  });
}
