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
    const output = execSync(
      'cd /root/.claude && git add -A && git diff --cached --quiet && echo "Nothing to commit" || (git commit -m "auto-sync" && git push)',
      {
        encoding: "utf-8",
        timeout: 30000,
      }
    );
    return NextResponse.json({ ok: true, output: output.trim() });
  } catch (err) {
    const error = err as { stderr?: string; stdout?: string; message: string };
    // "Nothing to commit" exits with code 0 via echo, but if git diff --cached fails it could error
    const output = error.stdout || error.stderr || error.message;
    // If it contains "Nothing to commit" that's fine
    if (output.includes("Nothing to commit") || output.includes("nothing to commit")) {
      return NextResponse.json({ ok: true, output: "Nothing to commit" });
    }
    return NextResponse.json(
      { ok: false, output },
      { status: 500 }
    );
  }
}
