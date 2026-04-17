import { NextRequest, NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { getDb } from "@/lib/db";

interface WatercoolerMessage {
  id: number;
  author_role: string | null;
  content: string;
  created_at: string;
  mentions: string | null;
  reply_depth: number;
}

function getUser(req: NextRequest) {
  const token = req.cookies.get("auth-token")?.value;
  return token ? verifyToken(token) : null;
}

/**
 * GET /api/symphony/v2/chat?channel=watercooler&limit=50&before=123
 *
 * Returns watercooler messages (project_id IS NULL) with pagination.
 */
export async function GET(request: NextRequest) {
  const user = getUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const channel = searchParams.get("channel");

  if (channel !== "watercooler") {
    return NextResponse.json({ error: "Invalid channel. Use ?channel=watercooler" }, { status: 400 });
  }

  const limit = Math.min(Math.max(1, Number(searchParams.get("limit")) || 50), 100);
  const before = searchParams.get("before") ? Number(searchParams.get("before")) : null;

  const db = getDb();

  const params: (number | null)[] = [];
  let whereClause = "WHERE m.project_id IS NULL";

  if (before) {
    whereClause += " AND m.id < ?";
    params.push(before);
  }

  params.push(limit);

  const messages = db.prepare(`
    SELECT
      m.id,
      m.author_role,
      m.content,
      m.created_at,
      m.mentions,
      m.reply_depth
    FROM sym_chat_messages m
    ${whereClause}
    ORDER BY m.created_at DESC
    LIMIT ?
  `).all(...params) as WatercoolerMessage[];

  // Check if there are more messages
  const hasMore = messages.length === limit && messages.length > 0
    ? Boolean(db.prepare(`
        SELECT 1 FROM sym_chat_messages
        WHERE project_id IS NULL AND id < ?
        LIMIT 1
      `).get(messages[messages.length - 1].id))
    : false;

  return NextResponse.json({
    messages: messages.reverse(),
    hasMore,
    channel: "watercooler",
  });
}
