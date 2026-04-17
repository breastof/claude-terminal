import { NextRequest, NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import fs from "fs";
import path from "path";

function getUser(req: NextRequest) {
  const token = req.cookies.get("auth-token")?.value;
  return token ? verifyToken(token) : null;
}

export async function GET(request: NextRequest) {
  const user = getUser(request);
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const projectsDir = path.join(process.env.HOME || "/root", ".claude/projects");
  const sessionsDir = path.join(process.env.HOME || "/root", "projects/Claude");

  if (!fs.existsSync(projectsDir)) {
    return NextResponse.json({ orphans: [] });
  }

  const existingSessions = new Set<string>();
  if (fs.existsSync(sessionsDir)) {
    for (const d of fs.readdirSync(sessionsDir)) {
      existingSessions.add(d);
    }
  }

  const orphans: { key: string; sessionId: string; hasMemory: boolean; sizeMb: string }[] = [];

  for (const dir of fs.readdirSync(projectsDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    if (!dir.name.includes("-Claude-")) continue;

    const marker = "-Claude-";
    const idx = dir.name.indexOf(marker);
    if (idx === -1) continue;
    const sessionId = dir.name.slice(idx + marker.length);

    if (existingSessions.has(sessionId)) continue;

    const dirPath = path.join(projectsDir, dir.name);
    const hasMemory = fs.existsSync(path.join(dirPath, "memory", "MEMORY.md"));

    let sizeMb = "?";
    try {
      const { execSync } = require("child_process");
      sizeMb = execSync(`du -sh ${dirPath}`, { encoding: "utf-8" }).split("\t")[0] || "?";
    } catch {
      // ignore
    }

    orphans.push({
      key: dir.name,
      sessionId,
      hasMemory,
      sizeMb,
    });
  }

  return NextResponse.json({ orphans });
}
