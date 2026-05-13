import { NextRequest, NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";

interface ManagerLike {
  getService: (id: string) => { id: string; kind: string } | undefined;
  getLogs: (id: string, lines?: number) => Promise<{ ok: boolean; lines: string[]; error?: string }>;
}

function getManager(): ManagerLike | null {
  const g = global as unknown as { servicesManager?: ManagerLike };
  return g.servicesManager ?? null;
}

function getPayload(req: NextRequest) {
  const token = req.cookies.get("auth-token")?.value;
  if (!token) return null;
  return verifyToken(token);
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const payload = getPayload(request);
  if (!payload) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (payload.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const mgr = getManager();
  if (!mgr) return NextResponse.json({ error: "manager_not_initialized" }, { status: 503 });
  const svc = mgr.getService(id);
  if (!svc) return NextResponse.json({ error: "unknown_service" }, { status: 404 });

  const url = new URL(request.url);
  const linesParam = parseInt(url.searchParams.get("lines") || "200", 10);
  const lines = Number.isFinite(linesParam) ? Math.max(10, Math.min(2000, linesParam)) : 200;

  const result = await mgr.getLogs(id, lines);
  return NextResponse.json(result);
}
