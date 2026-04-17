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

  const task = db.prepare("SELECT id FROM symphony_tasks WHERE id = ?").get(id);
  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  const proofs = db
    .prepare("SELECT * FROM symphony_proof WHERE task_id = ? ORDER BY created_at DESC")
    .all(id);

  return NextResponse.json({ proofs });
}

export async function POST(
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

  const task = db.prepare("SELECT id FROM symphony_tasks WHERE id = ?").get(id);
  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  const body = await request.json();
  const { type, title, path, url, metadata } = body;

  if (!type || typeof type !== "string") {
    return NextResponse.json({ error: "type is required" }, { status: 400 });
  }

  const result = db
    .prepare(
      `INSERT INTO symphony_proof (task_id, type, title, path, url, metadata)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      type,
      title || null,
      path || null,
      url || null,
      metadata ? JSON.stringify(metadata) : null
    );

  const proof = db
    .prepare("SELECT * FROM symphony_proof WHERE id = ?")
    .get(result.lastInsertRowid);

  return NextResponse.json({ proof }, { status: 201 });
}
