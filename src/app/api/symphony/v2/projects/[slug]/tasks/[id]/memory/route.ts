import { NextRequest, NextResponse } from "next/server";
import { getUser } from "@/lib/symphony-auth";
import { getDb } from "@/lib/db";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> }
) {
  const user = getUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const db = getDb();

  const task = db.prepare("SELECT id FROM sym_tasks WHERE id = ?").get(Number(id));
  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const memory = db.prepare(
      "SELECT id, task_id, key, value, agent_session_id, created_at FROM sym_agent_memory WHERE task_id = ? ORDER BY key"
    ).all(Number(id));
    return NextResponse.json({ memory });
  } catch {
    return NextResponse.json({ memory: [] });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> }
) {
  const user = getUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role === "guest") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const body = await request.json();

  const { key, value } = body;
  if (!key || typeof key !== "string") {
    return NextResponse.json({ error: "key is required and must be a string" }, { status: 400 });
  }
  if (key.length > 255) {
    return NextResponse.json(
      { error: `Key too long (${key.length} chars, max 255): "${key.slice(0, 40)}..."` },
      { status: 400 }
    );
  }
  if (value === undefined || value === null) {
    return NextResponse.json({ error: "value is required" }, { status: 400 });
  }

  const db = getDb();

  const task = db.prepare("SELECT id, project_id FROM sym_tasks WHERE id = ?").get(Number(id)) as { id: number; project_id: number } | undefined;
  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const serialized = typeof value === "string" ? value : JSON.stringify(value);

  try {
    db.prepare(`
      INSERT INTO sym_agent_memory (task_id, key, value)
      VALUES (?, ?, ?)
      ON CONFLICT(task_id, key) DO UPDATE SET
        value = excluded.value,
        created_at = datetime('now')
    `).run(Number(id), key, serialized);

    // Audit log
    try {
      db.prepare(`
        INSERT INTO sym_audit_log (task_id, project_id, action, new_value, actor_type, actor_id)
        VALUES (?, ?, 'memory_updated', ?, 'user', ?)
      `).run(Number(id), task.project_id, key, String(user.userId));
    } catch (e) {
      console.warn('audit log failed:', e);
    }

    const entry = db.prepare(
      "SELECT id, task_id, key, value, created_at FROM sym_agent_memory WHERE task_id = ? AND key = ?"
    ).get(Number(id), key);
    return NextResponse.json({ ok: true, entry });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("no such table")) {
      return NextResponse.json({ error: "Memory table not available" }, { status: 503 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
