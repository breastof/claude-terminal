import { NextRequest, NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { getDb } from "@/lib/db";

// Import metrics helpers — CommonJS module loaded at runtime via global.db
const { getTaskLeadTime, getTaskStageTimings } = require("@/../symphony-metrics");

function getUser(req: NextRequest) {
  const token = req.cookies.get("auth-token")?.value;
  return token ? verifyToken(token) : null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> }
) {
  const user = getUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const db = getDb();

  const task = db.prepare("SELECT id FROM sym_tasks WHERE id = ?").get(Number(id));
  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });

  const taskId = Number(id);
  const lead_time_ms = getTaskLeadTime(db, taskId);
  const stages = getTaskStageTimings(db, taskId);

  return NextResponse.json({ lead_time_ms, stages });
}
