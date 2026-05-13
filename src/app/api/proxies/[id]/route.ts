import { NextRequest, NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";

interface ManagerLike {
  remove: (id: number) => { ok: boolean; error?: string };
}

function getManager(): ManagerLike | null {
  const g = global as unknown as { proxyManager?: ManagerLike };
  return g.proxyManager ?? null;
}

function requireAdmin(req: NextRequest) {
  const token = req.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const payload = verifyToken(token);
  if (!payload) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (payload.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return null;
}

export async function DELETE(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = requireAdmin(request);
  if (guard) return guard;

  const params = await ctx.params;
  const id = parseInt(params.id, 10);
  if (!Number.isFinite(id)) return NextResponse.json({ error: "invalid_id" }, { status: 400 });

  const mgr = getManager();
  if (!mgr) return NextResponse.json({ error: "manager_not_initialized" }, { status: 503 });

  const result = mgr.remove(id);
  if (!result.ok) {
    const status = result.error === "not_found" ? 404 : 500;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json({ ok: true });
}
