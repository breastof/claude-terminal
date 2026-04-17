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

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const type = searchParams.get("type");
  const parentId = searchParams.get("parent_id");

  let sql = "SELECT * FROM sym_tasks WHERE project_id = ?";
  const sqlParams: unknown[] = [project.id];

  if (status) { sql += " AND status = ?"; sqlParams.push(status); }
  if (type) { sql += " AND type = ?"; sqlParams.push(type); }
  if (parentId) { sql += " AND parent_id = ?"; sqlParams.push(Number(parentId)); }

  sql += " ORDER BY priority DESC, created_at DESC";

  const tasks = db.prepare(sql).all(...sqlParams);
  return NextResponse.json({ tasks });
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

  const { title, description, type, parent_id, priority, assigned_role, estimated_effort, tags, needs_human_review, status: taskStatus, due_date, sprint_id } = body;

  if (!title) return NextResponse.json({ error: "title is required" }, { status: 400 });

  const result = db.prepare(`
    INSERT INTO sym_tasks (project_id, parent_id, type, title, description, status, priority, assigned_role, estimated_effort, tags, needs_human_review, due_date, sprint_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    project.id,
    parent_id || null,
    type || "task",
    title,
    description || "",
    taskStatus || "backlog",
    priority ?? 50,
    assigned_role || null,
    estimated_effort || null,
    JSON.stringify(tags || []),
    needs_human_review ? 1 : 0,
    due_date || null,
    sprint_id || null
  );

  const task = db.prepare("SELECT * FROM sym_tasks WHERE id = ?").get(result.lastInsertRowid);

  // Add system comment
  db.prepare(`
    INSERT INTO sym_comments (task_id, content, type)
    VALUES (?, ?, 'system')
  `).run(result.lastInsertRowid, `Task created by ${user.login}`);

  // Audit log
  try {
    db.prepare(`
      INSERT INTO sym_audit_log (task_id, project_id, action, new_value, actor_type, actor_id)
      VALUES (?, ?, 'task_created', ?, 'user', ?)
    `).run(result.lastInsertRowid, project.id, title, user.login);
  } catch {}

  return NextResponse.json({ task }, { status: 201 });
}
