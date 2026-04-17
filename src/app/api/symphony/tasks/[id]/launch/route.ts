import { NextRequest, NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { getDb } from "@/lib/db";

function getUser(req: NextRequest) {
  const token = req.cookies.get("auth-token")?.value;
  return token ? verifyToken(token) : null;
}

function getTerminalManager() {
  return (global as Record<string, unknown>).terminalManager as {
    createSession: (providerSlug?: string) => { sessionId: string; projectDir: string };
  };
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = getUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (user.role === "guest") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const db = getDb();

  const task = db
    .prepare("SELECT * FROM symphony_tasks WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;

  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  let providerSlug = "claude";
  try {
    const body = await request.json();
    if (body.providerSlug) providerSlug = body.providerSlug;
  } catch {
    // No body or invalid JSON — use default
  }

  try {
    const tm = getTerminalManager();
    const { sessionId } = tm.createSession(providerSlug);

    db.prepare(
      "UPDATE symphony_tasks SET session_id = ?, status = 'active', updated_at = datetime('now') WHERE id = ?"
    ).run(sessionId, id);

    return NextResponse.json({ sessionId, taskId: Number(id) });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}
