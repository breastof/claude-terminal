import { NextRequest, NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";

interface ProxyRow {
  id: number;
  label: string;
  host: string;
  port: number;
  login: string | null;
  hasPassword: boolean;
  isPrimary: boolean;
  isFallback: boolean;
  display: string;
  createdAt: string;
}

interface ManagerLike {
  list: () => ProxyRow[];
  add: (input: { label?: string; raw: string }) => { ok: boolean; id?: number; error?: string };
}

function getManager(): ManagerLike | null {
  const g = global as unknown as { proxyManager?: ManagerLike };
  return g.proxyManager ?? null;
}

function requireAdmin(req: NextRequest) {
  const token = req.cookies.get("auth-token")?.value;
  if (!token) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const payload = verifyToken(token);
  if (!payload) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (payload.role !== "admin") {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { payload };
}

export async function GET(request: NextRequest) {
  const auth = requireAdmin(request);
  if (auth.error) return auth.error;
  const mgr = getManager();
  if (!mgr) return NextResponse.json({ error: "manager_not_initialized" }, { status: 503 });
  return NextResponse.json({ proxies: mgr.list() });
}

export async function POST(request: NextRequest) {
  const auth = requireAdmin(request);
  if (auth.error) return auth.error;
  const mgr = getManager();
  if (!mgr) return NextResponse.json({ error: "manager_not_initialized" }, { status: 503 });

  let body: { raw?: string; label?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body.raw || typeof body.raw !== "string") {
    return NextResponse.json({ error: "raw_required" }, { status: 400 });
  }
  const result = mgr.add({ label: body.label, raw: body.raw });
  if (!result.ok) {
    const status = result.error === "invalid_format" ? 400 : 500;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json({ ok: true, id: result.id });
}
