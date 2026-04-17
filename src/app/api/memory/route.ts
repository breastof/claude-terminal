import { NextRequest, NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import fs from "fs";
import path from "path";

function getUser(req: NextRequest) {
  const token = req.cookies.get("auth-token")?.value;
  return token ? verifyToken(token) : null;
}

function extractSessionId(projectKey: string): string | null {
  // projectKey format: -root-projects-Claude-11-03-2026-17-31-25
  // Session ID format: 11-03-2026-17-31-25
  const marker = "-Claude-";
  const idx = projectKey.indexOf(marker);
  if (idx === -1) return null;
  return projectKey.slice(idx + marker.length);
}

export async function GET(request: NextRequest) {
  const user = getUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const projectsDir = path.join(process.env.HOME || "/root", ".claude/projects");
  const sessionsDir = path.join(process.env.HOME || "/root", "projects/Claude");

  if (!fs.existsSync(projectsDir)) {
    return NextResponse.json({ entries: [] });
  }

  // Get existing session directories for orphan detection
  const existingSessions = new Set<string>();
  if (fs.existsSync(sessionsDir)) {
    for (const d of fs.readdirSync(sessionsDir)) {
      existingSessions.add(d);
    }
  }

  const entries: {
    projectKey: string;
    displayName: string;
    lastModified: string;
    preview: string;
    isOrphan: boolean;
  }[] = [];

  const projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true });

  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue;
    const memoryPath = path.join(projectsDir, dir.name, "memory", "MEMORY.md");
    if (!fs.existsSync(memoryPath)) continue;

    try {
      const stat = fs.statSync(memoryPath);
      const content = fs.readFileSync(memoryPath, "utf-8");
      const firstLine = content.split("\n").find((l) => l.trim().length > 0) || "";

      const sessionId = extractSessionId(dir.name);
      const isOrphan = sessionId ? !existingSessions.has(sessionId) : true;

      entries.push({
        projectKey: dir.name,
        displayName: sessionId || dir.name,
        lastModified: stat.mtime.toISOString(),
        preview: firstLine.slice(0, 200),
        isOrphan,
      });
    } catch {
      // Skip unreadable entries
    }
  }

  // Sort by lastModified descending
  entries.sort((a, b) => b.lastModified.localeCompare(a.lastModified));

  return NextResponse.json({ entries });
}
