import { NextRequest, NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";

function getUser(req: NextRequest) {
  const token = req.cookies.get("auth-token")?.value;
  return token ? verifyToken(token) : null;
}

export async function POST(request: NextRequest) {
  const user = getUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role === "guest") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const orchestrator = (global as Record<string, unknown>).symphonyOrchestrator as { pause: () => void; resume: () => void; getStatus: () => Record<string, unknown> } | undefined;
  if (!orchestrator) return NextResponse.json({ error: "Orchestrator not initialized" }, { status: 503 });

  const status = orchestrator.getStatus();
  if (status.status === "paused") {
    orchestrator.resume();
  } else {
    orchestrator.pause();
  }

  return NextResponse.json(orchestrator.getStatus());
}
