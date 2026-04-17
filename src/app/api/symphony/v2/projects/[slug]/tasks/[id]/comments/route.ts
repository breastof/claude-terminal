import { NextRequest, NextResponse } from "next/server";
import { getUser } from "@/lib/symphony-auth";
import { getDb } from "@/lib/db";

const ALLOWED_TYPES = new Set(["comment", "review", "handoff", "status_change"]);

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> }
) {
  const user = getUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const db = getDb();

  const task = db.prepare("SELECT id FROM sym_tasks WHERE id = ?").get(Number(id));
  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Phase 3.5: Join with users table for human comments
  const comments = db.prepare(`
    SELECT c.*,
      u.login as author_username,
      u.first_name as author_first_name,
      u.last_name as author_last_name
    FROM sym_comments c
    LEFT JOIN users u ON u.id = c.author_user_id
    WHERE c.task_id = ?
    ORDER BY c.created_at ASC
  `).all(Number(id));

  return NextResponse.json({ comments });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> }
) {
  const user = getUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role === "guest") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const body = await request.json();
  const { content, type, mention_role, file_path, line_range } = body;

  if (!content) return NextResponse.json({ error: "content is required" }, { status: 400 });

  const db = getDb();
  const existingTask = db.prepare('SELECT id, project_id FROM sym_tasks WHERE id = ?').get(Number(id)) as { id: number; project_id: number } | undefined;
  if (!existingTask) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const result = db.prepare(`
    INSERT INTO sym_comments (task_id, author_user_id, content, type, mention_role, file_path, line_range)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(Number(id), user.userId, content, type || "comment", mention_role || null, file_path || null, line_range || null);

  // Audit log — reuse existingTask.project_id, no second DB query
  try {
    db.prepare(`
      INSERT INTO sym_audit_log (task_id, project_id, action, new_value, actor_type, actor_id)
      VALUES (?, ?, 'comment_added', ?, 'user', ?)
    `).run(Number(id), existingTask.project_id || null, content.slice(0, 200), String(user.userId));
  } catch {}

  const comment = db.prepare(`
    SELECT c.*, u.login as author_username, u.first_name as author_first_name
    FROM sym_comments c
    LEFT JOIN users u ON u.id = c.author_user_id
    WHERE c.id = ?
  `).get(result.lastInsertRowid);
  return NextResponse.json({ ok: true, comment }, { status: 201 });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> }
) {
  const user = getUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const commentId = searchParams.get("comment_id");
  if (!commentId) return NextResponse.json({ error: "comment_id query param required" }, { status: 400 });

  const db = getDb();
  const comment = db.prepare("SELECT * FROM sym_comments WHERE id = ?").get(Number(commentId)) as Record<string, unknown> | undefined;
  if (!comment) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Only author or admin can delete
  if (comment.author_user_id !== user.userId && user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  db.prepare("DELETE FROM sym_comments WHERE id = ?").run(Number(commentId));
  return NextResponse.json({ ok: true });
}
