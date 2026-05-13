import { NextRequest, NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import type { ServiceAction, ActionResult, ServiceSnapshot } from "@/lib/services";

interface ManagerLike {
  isActionAllowed: (id: string, action: ServiceAction) => boolean;
  getService: (id: string) => { id: string } | undefined;
  runAction: (id: string, action: ServiceAction) => Promise<ActionResult>;
  refreshOne?: (id: string) => Promise<unknown>;
  getSnapshot?: () => ServiceSnapshot[];
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

const VALID_ACTIONS: ServiceAction[] = ["restart", "reload", "test", "logs", "backup", "enable", "disable"];

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

  let body: { action?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const action = body.action as ServiceAction | undefined;
  if (!action || !VALID_ACTIONS.includes(action)) {
    return NextResponse.json({ error: "invalid_action" }, { status: 400 });
  }
  if (!mgr.isActionAllowed(id, action)) {
    return NextResponse.json({ error: "action_not_allowed" }, { status: 400 });
  }

  // Self-restart guard: claude-terminal restarting itself would cut the response
  // mid-flight. Send response synchronously, then exec on next tick — systemd
  // takes over, the WS clients reconnect via existing reconnect logic.
  if (id === "claude-terminal" && action === "restart") {
    setTimeout(() => {
      mgr.runAction(id, action).catch(() => {});
    }, 200);
    return NextResponse.json({ ok: true, scheduled: true });
  }

  const result = await mgr.runAction(id, action);
  return NextResponse.json(result);
}
