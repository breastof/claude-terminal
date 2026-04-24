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
    const memoryDir = path.join(projectsDir, dir.name, "memory");
    if (!fs.existsSync(memoryDir)) continue;

    const memoryPath = path.join(memoryDir, "MEMORY.md");
    const hasMemoryFile = fs.existsSync(memoryPath);

    const sessionId = extractSessionId(dir.name);
    const isOrphan = sessionId !== null && !existingSessions.has(sessionId);

    if (!hasMemoryFile && !isOrphan) continue;

    try {
      const stat = hasMemoryFile ? fs.statSync(memoryPath) : fs.statSync(memoryDir);
      let preview = "";
      if (hasMemoryFile) {
        const content = fs.readFileSync(memoryPath, "utf-8");
        preview = (content.split("\n").find((l) => l.trim().length > 0) || "").slice(0, 200);
      } else {
        preview = "(пусто — MEMORY.md отсутствует)";
      }

      entries.push({
        projectKey: dir.name,
        displayName: sessionId || dir.name,
        lastModified: stat.mtime.toISOString(),
        preview,
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
