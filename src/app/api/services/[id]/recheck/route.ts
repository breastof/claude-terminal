import { NextRequest, NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import type { ServiceStatus } from "@/lib/services";

interface ManagerLike {
  getService: (id: string) => { id: string } | undefined;
  refreshOne: (id: string) => Promise<ServiceStatus | null>;
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

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const payload = getPayload(request);
  if (!payload) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (payload.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const mgr = getManager();
  if (!mgr) return NextResponse.json({ error: "manager_not_initialized" }, { status: 503 });
  if (!mgr.getService(id)) return NextResponse.json({ error: "unknown_service" }, { status: 404 });

  const status = await mgr.refreshOne(id);
  return NextResponse.json({ status });
}
