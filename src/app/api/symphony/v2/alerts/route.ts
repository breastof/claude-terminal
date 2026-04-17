import { NextRequest, NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";

function getUser(req: NextRequest) {
  const token = req.cookies.get("auth-token")?.value;
  return token ? verifyToken(token) : null;
}

export async function GET(request: NextRequest) {
  const user = getUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const orchestrator = (global as any).symphonyOrchestrator;
  if (!orchestrator) {
    return NextResponse.json({ error: "Orchestrator not running" }, { status: 503 });
  }

  const alerts = orchestrator.getAlerts();
  return NextResponse.json({ ...alerts, timestamp: new Date().toISOString() });
}
