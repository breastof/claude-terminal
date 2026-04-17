import { NextRequest, NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { getDb } from "@/lib/db";

function getUser(req: NextRequest) {
  const token = req.cookies.get("auth-token")?.value;
  return token ? verifyToken(token) : null;
}

export async function GET(request: NextRequest) {
  const user = getUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const db = getDb();
    const roles = db.prepare("SELECT slug, name, color, icon FROM sym_agent_roles ORDER BY name").all();
    return NextResponse.json({ roles });
  } catch (e) {
    console.error("[api/roles] Failed to fetch roles:", e);
    return NextResponse.json({ roles: [] });
  }
}
