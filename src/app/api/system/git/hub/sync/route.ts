import { NextRequest, NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { execSync } from "child_process";

function getUser(req: NextRequest) {
  const token = req.cookies.get("auth-token")?.value;
  return token ? verifyToken(token) : null;
}

export async function POST(request: NextRequest) {
  const user = getUser(request);
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const output = execSync("bash /root/.claude/scripts/hub-sync.sh", {
      encoding: "utf-8",
      timeout: 30000,
    });
    return NextResponse.json({ ok: true, output: output.trim() });
  } catch (err) {
    const error = err as { stderr?: string; stdout?: string; message: string };
    return NextResponse.json(
      {
        ok: false,
        output: error.stderr || error.stdout || error.message,
      },
      { status: 500 }
    );
  }
}
