import { NextRequest, NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { getDb } from "@/lib/db";

function getUser(req: NextRequest) {
  const token = req.cookies.get("auth-token")?.value;
  return token ? verifyToken(token) : null;
}

// Phase 1.3: Circular dependency detection via BFS
function wouldCreateCycle(db: ReturnType<typeof getDb>, blockerId: number, blockedId: number): boolean {
  // Check if adding blockerId → blockedId creates a cycle
  // i.e., can we reach blockerId starting from blockedId's existing blockers?
  const visited = new Set<number>();
  const queue = [blockerId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === blockedId) return true; // cycle detected
    if (visited.has(current)) continue;
    visited.add(current);

    // Get all tasks that block `current`
    const deps = db.prepare(
      "SELECT blocker_id FROM sym_task_deps WHERE blocked_id = ?"
    ).all(current) as { blocker_id: number }[];

    for (const dep of deps) {
      queue.push(dep.blocker_id);
    }
  }

  return false;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> }
) {
  const user = getUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role === "guest") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const body = await request.json();
  const { blocker_id } = body;

  if (!blocker_id) return NextResponse.json({ error: "blocker_id is required" }, { status: 400 });

  const db = getDb();

  // Prevent self-dependency
  if (Number(blocker_id) === Number(id)) {
    return NextResponse.json({ error: "Cannot depend on self" }, { status: 400 });
  }

  // Phase 1.3: Check for circular dependency
  if (wouldCreateCycle(db, Number(blocker_id), Number(id))) {
    return NextResponse.json({ error: "Circular dependency detected — this would create a deadlock" }, { status: 400 });
  }

  try {
    db.prepare("INSERT INTO sym_task_deps (blocker_id, blocked_id) VALUES (?, ?)").run(Number(blocker_id), Number(id));

    // Audit log
    try {
      const task = db.prepare("SELECT project_id FROM sym_tasks WHERE id = ?").get(Number(id)) as { project_id: number } | undefined;
      db.prepare(`
        INSERT INTO sym_audit_log (task_id, project_id, action, old_value, new_value, actor_type, actor_id)
        VALUES (?, ?, 'dep_added', NULL, ?, 'user', ?)
      `).run(Number(id), task?.project_id || null, `blocker:${blocker_id}`, user.userId);
    } catch {}

    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    if (message.includes("UNIQUE") || message.includes("PRIMARY")) {
      return NextResponse.json({ error: "Dependency already exists" }, { status: 409 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> }
) {
  const user = getUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role === "guest") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const blockerId = searchParams.get("blocker_id");

  if (!blockerId) return NextResponse.json({ error: "blocker_id query param required" }, { status: 400 });

  const db = getDb();
  db.prepare("DELETE FROM sym_task_deps WHERE blocker_id = ? AND blocked_id = ?").run(Number(blockerId), Number(id));
  return NextResponse.json({ ok: true });
}
