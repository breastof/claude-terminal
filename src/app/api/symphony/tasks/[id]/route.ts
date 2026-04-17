import { NextRequest, NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { getDb } from "@/lib/db";

function getUser(req: NextRequest) {
  const token = req.cookies.get("auth-token")?.value;
  return token ? verifyToken(token) : null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = getUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const db = getDb();

  const task = db
    .prepare("SELECT * FROM symphony_tasks WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;

  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  const proofCount = db
    .prepare("SELECT COUNT(*) as count FROM symphony_proof WHERE task_id = ?")
    .get(id) as { count: number };

  return NextResponse.json({ task: { ...task, proofCount: proofCount.count } });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = getUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (user.role === "guest") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const db = getDb();

  const existing = db.prepare("SELECT id FROM symphony_tasks WHERE id = ?").get(id);
  if (!existing) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  const body = await request.json();
  const updates: string[] = [];
  const values: unknown[] = [];

  if (body.title !== undefined) {
    updates.push("title = ?");
    values.push(body.title);
  }
  if (body.description !== undefined) {
    updates.push("description = ?");
    values.push(body.description);
  }
  if (body.status !== undefined) {
    updates.push("status = ?");
    values.push(body.status);
  }
  if (body.priority !== undefined) {
    updates.push("priority = ?");
    values.push(body.priority);
  }
  if (body.session_id !== undefined) {
    updates.push("session_id = ?");
    values.push(body.session_id);
  }

  if (updates.length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  updates.push("updated_at = datetime('now')");
  values.push(id);

  db.prepare(`UPDATE symphony_tasks SET ${updates.join(", ")} WHERE id = ?`).run(
    ...values
  );

  const task = db.prepare("SELECT * FROM symphony_tasks WHERE id = ?").get(id);
  return NextResponse.json({ task });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = getUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (user.role === "guest") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const db = getDb();

  const result = db.prepare("DELETE FROM symphony_tasks WHERE id = ?").run(id);
  if (result.changes === 0) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}
