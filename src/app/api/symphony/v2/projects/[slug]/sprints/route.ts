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

  const sprints = db.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM sym_tasks WHERE sprint_id = s.id) as task_count,
      (SELECT COUNT(*) FROM sym_tasks WHERE sprint_id = s.id AND status = 'done') as done_count,
      (SELECT SUM(CASE
        WHEN estimated_effort = 'xs' THEN 1
        WHEN estimated_effort = 's' THEN 2
        WHEN estimated_effort = 'm' THEN 5
        WHEN estimated_effort = 'l' THEN 8
        WHEN estimated_effort = 'xl' THEN 13
        ELSE 0 END)
       FROM sym_tasks WHERE sprint_id = s.id) as total_points,
      (SELECT SUM(CASE
        WHEN estimated_effort = 'xs' THEN 1
        WHEN estimated_effort = 's' THEN 2
        WHEN estimated_effort = 'm' THEN 5
        WHEN estimated_effort = 'l' THEN 8
        WHEN estimated_effort = 'xl' THEN 13
        ELSE 0 END)
       FROM sym_tasks WHERE sprint_id = s.id AND status = 'done') as done_points
    FROM sym_sprints s
    WHERE s.project_id = ?
    ORDER BY
      CASE s.status WHEN 'active' THEN 0 WHEN 'planning' THEN 1 WHEN 'review' THEN 2 ELSE 3 END,
      s.created_at DESC
  `).all(project.id);

  return NextResponse.json({ sprints });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const user = getUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role === "guest") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { slug } = await params;
  const body = await request.json();
  const db = getDb();

  const project = db.prepare("SELECT id FROM sym_projects WHERE slug = ?").get(slug) as { id: number } | undefined;
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  const { name, goal, start_date, end_date } = body;
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });

  const result = db.prepare(`
    INSERT INTO sym_sprints (project_id, name, goal, start_date, end_date)
    VALUES (?, ?, ?, ?, ?)
  `).run(project.id, name, goal || "", start_date || null, end_date || null);

  const sprint = db.prepare("SELECT * FROM sym_sprints WHERE id = ?").get(result.lastInsertRowid);
  return NextResponse.json({ sprint }, { status: 201 });
}
