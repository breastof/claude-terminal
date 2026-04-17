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

  const rows = db
    .prepare(
      "SELECT status, COUNT(*) as count FROM symphony_tasks GROUP BY status"
    )
    .all() as { status: string; count: number }[];

  const stats: Record<string, number> = {
    pending: 0,
    active: 0,
    proof: 0,
    done: 0,
    cancelled: 0,
    total: 0,
  };

  for (const row of rows) {
    stats[row.status] = row.count;
    stats.total += row.count;
  }

  return NextResponse.json(stats);
}
