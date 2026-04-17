import { NextRequest, NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { getDb } from "@/lib/db";

interface MessageRow {
  id: number;
  project_id: number | null;
  author_role: string | null;
  content: string;
  created_at: string;
  role_name: string | null;
  role_color: string | null;
  role_icon: string | null;
}

function getUser(req: NextRequest) {
  const token = req.cookies.get("auth-token")?.value;
  return token ? verifyToken(token) : null;
}

export async function GET(request: NextRequest) {
  const user = getUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const before = searchParams.get("before") ?? null;
  const limitParam = parseInt(searchParams.get("limit") ?? "50", 10);
  const limit = Math.min(Math.max(limitParam || 50, 1), 50);

  const db = getDb();

  const rows = db.prepare(`
    SELECT
      m.id, m.project_id, m.author_role, m.content, m.created_at,
      r.name  AS role_name,
      r.color AS role_color,
      r.icon  AS role_icon
    FROM sym_chat_messages m
    LEFT JOIN sym_agent_roles r ON r.slug = m.author_role
    WHERE m.project_id IS NULL
      AND (? IS NULL OR m.created_at < ?)
    ORDER BY m.created_at DESC
    LIMIT ?
  `).all(before, before, limit + 1) as MessageRow[];

  const hasMore = rows.length > limit;
  const messages = hasMore ? rows.slice(0, limit) : rows;

  return NextResponse.json({ messages, hasMore });
}
