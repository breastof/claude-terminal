import { NextRequest, NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { getDb } from "@/lib/db";

function getUser(req: NextRequest) {
  const token = req.cookies.get("auth-token")?.value;
  return token ? verifyToken(token) : null;
}

export async function GET(request: NextRequest) {
  const user = getUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const db = getDb();
  const agents = db.prepare(`
    SELECT s.*, t.title as task_title, t.type as task_type, r.name as role_name, r.color as role_color
    FROM sym_agent_sessions s
    JOIN sym_tasks t ON t.id = s.task_id
    LEFT JOIN sym_agent_roles r ON r.slug = s.role_slug
    WHERE s.status IN ('starting', 'running')
    ORDER BY s.started_at DESC
  `).all();

  return NextResponse.json({ agents });
}
