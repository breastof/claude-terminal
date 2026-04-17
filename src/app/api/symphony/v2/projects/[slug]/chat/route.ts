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
  const limit = Math.min(100, Number(searchParams.get("limit")) || 50);

  const messages = db.prepare(
    "SELECT * FROM sym_chat_messages WHERE project_id = ? ORDER BY created_at DESC LIMIT ?"
  ).all(project.id, limit);

  return NextResponse.json({ messages: messages.reverse() });
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
  const { content } = body;

  if (!content) return NextResponse.json({ error: "content is required" }, { status: 400 });

  const db = getDb();
  const project = db.prepare("SELECT id FROM sym_projects WHERE slug = ?").get(slug) as { id: number } | undefined;
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  const result = db.prepare(`
    INSERT INTO sym_chat_messages (project_id, author_user_id, content)
    VALUES (?, ?, ?)
  `).run(project.id, user.userId, content);

  const message = db.prepare("SELECT * FROM sym_chat_messages WHERE id = ?").get(result.lastInsertRowid);
  return NextResponse.json({ message }, { status: 201 });
}
