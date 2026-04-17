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
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const taskId = Number(id);
  if (!taskId || isNaN(taskId)) {
    return NextResponse.json({ error: "Invalid task id" }, { status: 400 });
  }

  const db = getDb();

  // Verify task exists
  const task = db.prepare("SELECT id, status FROM sym_tasks WHERE id = ?").get(taskId) as
    | { id: number; status: string }
    | undefined;
  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const stages = db.prepare(`
      SELECT old_value as "from", new_value as "to", elapsed_ms, created_at as timestamp
      FROM sym_audit_log
      WHERE task_id = ? AND action = 'status_change'
      ORDER BY created_at ASC
    `).all(taskId) as Array<{ from: string; to: string; elapsed_ms: number | null; timestamp: string }>;

    const row = db.prepare(`
      SELECT SUM(elapsed_ms) as total
      FROM sym_audit_log
      WHERE task_id = ? AND action = 'status_change' AND elapsed_ms IS NOT NULL
    `).get(taskId) as { total: number | null };

    return NextResponse.json({
      task_id: taskId,
      status: task.status,
      lead_time_ms: row.total ?? null,
      stages,
    });
  } catch (err) {
    // elapsed_ms column absent — Story #38 migration not yet applied
    console.warn(`[metrics] elapsed_ms column missing for task ${taskId}:`, (err as Error).message);
    return NextResponse.json(
      { task_id: taskId, status: task.status, lead_time_ms: null, stages: [] },
      { headers: { "X-Metrics-Warning": "elapsed_ms column not available" } }
    );
  }
}
