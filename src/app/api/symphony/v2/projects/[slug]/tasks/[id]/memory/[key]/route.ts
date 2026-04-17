import { NextRequest, NextResponse } from "next/server";
import { getUser } from "@/lib/symphony-auth";
import { getDb } from "@/lib/db";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string; key: string }> }
) {
  const user = getUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role === "guest") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id, key } = await params;
  const db = getDb();

  try {
    const result = db.prepare(
      "DELETE FROM sym_agent_memory WHERE task_id = ? AND key = ?"
    ).run(Number(id), decodeURIComponent(key));

    if (result.changes === 0) {
      return NextResponse.json({ error: "Memory entry not found" }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("no such table")) {
      return NextResponse.json({ error: "Memory table not available" }, { status: 503 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
