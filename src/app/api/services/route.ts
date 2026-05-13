import { NextRequest, NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import type { ServiceSnapshot } from "@/lib/services";

interface ManagerLike {
  getSnapshot: () => ServiceSnapshot[];
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

export async function GET(request: NextRequest) {
  const payload = getPayload(request);
  if (!payload) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (payload.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const mgr = getManager();
  if (!mgr) return NextResponse.json({ error: "manager_not_initialized" }, { status: 503 });

  return NextResponse.json({ services: mgr.getSnapshot() });
}
