import { NextRequest, NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";

function getUser(req: NextRequest) {
  const token = req.cookies.get("auth-token")?.value;
  return token ? verifyToken(token) : null;
}

export async function POST(request: NextRequest) {
  const user = getUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (user.role === "guest") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return NextResponse.json({ ok: true, message: "TickTick import not yet configured" });
}
