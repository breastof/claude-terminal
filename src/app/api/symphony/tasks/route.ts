import { NextRequest, NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { getDb } from "@/lib/db";

function getUser(req: NextRequest) {
  const token = req.cookies.get("auth-token")?.value;
  return token ? verifyToken(token) : null;
}

export async function GET(request: NextRequest) {
  const user = getUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = getDb();
  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");

  let tasks;
  if (status) {
    tasks = db
      .prepare("SELECT * FROM symphony_tasks WHERE status = ? ORDER BY created_at DESC")
      .all(status);
  } else {
    tasks = db
      .prepare("SELECT * FROM symphony_tasks ORDER BY created_at DESC")
      .all();
  }

  return NextResponse.json({ tasks });
}

export async function POST(request: NextRequest) {
  const user = getUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (user.role === "guest") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json();
  const { title, description, priority, source } = body;

  if (!title || typeof title !== "string") {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }

  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO symphony_tasks (title, description, priority, source)
       VALUES (?, ?, ?, ?)`
    )
    .run(
      title,
      description || null,
      priority || "medium",
      source || null
    );

  const task = db
    .prepare("SELECT * FROM symphony_tasks WHERE id = ?")
    .get(result.lastInsertRowid);

  return NextResponse.json({ task }, { status: 201 });
}
