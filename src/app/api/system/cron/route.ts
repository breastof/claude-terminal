import { NextRequest, NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { execSync } from "child_process";

function getUser(req: NextRequest) {
  const token = req.cookies.get("auth-token")?.value;
  return token ? verifyToken(token) : null;
}

export async function GET(request: NextRequest) {
  const user = getUser(request);
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const output = execSync("crontab -l 2>/dev/null || echo ''", {
      encoding: "utf-8",
      timeout: 5000,
    });

    const jobs = output
      .split("\n")
      .filter((line) => line.trim() && !line.startsWith("#"))
      .map((line) => {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 6) return null;
        const schedule = parts.slice(0, 5).join(" ");
        const command = parts.slice(5).join(" ");
        return { schedule, command };
      })
      .filter(Boolean);

    return NextResponse.json({ jobs });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}
