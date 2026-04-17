import { NextRequest, NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";

function getUser(req: NextRequest) {
  const token = req.cookies.get("auth-token")?.value;
  return token ? verifyToken(token) : null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = getUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role === "guest") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const orchestrator = (global as Record<string, unknown>).symphonyOrchestrator as { terminateAgent: (id: number) => boolean } | undefined;
  if (!orchestrator) return NextResponse.json({ error: "Orchestrator not initialized" }, { status: 503 });

  const success = orchestrator.terminateAgent(Number(id));
  return NextResponse.json({ ok: success });
}
