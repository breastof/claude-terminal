import { NextRequest, NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { getDb } from "@/lib/db";

function getUser(req: NextRequest) {
  const token = req.cookies.get("auth-token")?.value;
  return token ? verifyToken(token) : null;
}

const STATUSES = ["backlog", "analysis", "design", "development", "code_review", "qa", "uat", "done", "pending_cancel"];

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

  // Phase 5.4: Parse filter params
  const { searchParams } = new URL(request.url);
  const search = searchParams.get("search")?.toLowerCase();
  const filterRole = searchParams.get("role");
  const filterType = searchParams.get("type");
  const filterPriorityMin = searchParams.get("priority_min");
  const filterPriorityMax = searchParams.get("priority_max");
  const filterTag = searchParams.get("tag");
  const filterHasBlockers = searchParams.get("has_blockers");
  const filterSprintId = searchParams.get("sprint_id");
  const showCancelled = searchParams.get("show_cancelled") === "true";

  // Build dynamic WHERE clauses
  const conditions = ["t.project_id = ?"];
  const params_arr: unknown[] = [project.id];

  if (!showCancelled) {
    conditions.push("t.status != 'cancelled'");
  }
  if (filterRole) {
    conditions.push("t.assigned_role = ?");
    params_arr.push(filterRole);
  }
  if (filterType) {
    conditions.push("t.type = ?");
    params_arr.push(filterType);
  }
  if (filterPriorityMin) {
    conditions.push("t.priority >= ?");
    params_arr.push(Number(filterPriorityMin));
  }
  if (filterPriorityMax) {
    conditions.push("t.priority <= ?");
    params_arr.push(Number(filterPriorityMax));
  }
  if (filterSprintId) {
    conditions.push("t.sprint_id = ?");
    params_arr.push(Number(filterSprintId));
  }

  const tasks = db.prepare(`
    SELECT t.*,
      (SELECT COUNT(*) FROM sym_tasks c WHERE c.parent_id = t.id) as children_count,
      (SELECT COUNT(*) FROM sym_agent_sessions s WHERE s.task_id = t.id AND s.status IN ('starting','running')) as has_active_agent,
      (SELECT COUNT(*) FROM sym_task_deps d JOIN sym_tasks bt ON bt.id = d.blocker_id WHERE d.blocked_id = t.id AND bt.status NOT IN ('done','cancelled')) as unresolved_blockers
    FROM sym_tasks t
    WHERE ${conditions.join(" AND ")}
    ORDER BY t.priority DESC, t.created_at ASC
  `).all(...params_arr) as Record<string, unknown>[];

  // Apply in-memory filters (search, tags, has_blockers)
  let filtered = tasks;

  if (search) {
    filtered = filtered.filter(t => {
      const title = (t.title as string || "").toLowerCase();
      const desc = (t.description as string || "").toLowerCase();
      const id = String(t.id);
      return title.includes(search) || desc.includes(search) || id.includes(search);
    });
  }

  if (filterTag) {
    filtered = filtered.filter(t => {
      try {
        const tags = JSON.parse(t.tags as string || "[]");
        return tags.includes(filterTag);
      } catch { return false; }
    });
  }

  if (filterHasBlockers === "true") {
    filtered = filtered.filter(t => (t.unresolved_blockers as number) > 0);
  }

  // Group by status
  const columns: Record<string, unknown[]> = {};
  for (const s of STATUSES) {
    columns[s] = [];
  }
  for (const task of filtered) {
    const status = task.status as string;
    if (columns[status]) {
      columns[status].push(task);
    }
  }

  return NextResponse.json({ columns, statuses: STATUSES });
}
