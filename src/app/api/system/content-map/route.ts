import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export async function GET() {
  const home = process.env.HOME || "/root";
  const projectsRoot = path.join(home, "projects");
  const sessionsDir = path.join(projectsRoot, "Claude");
  const hubDir = path.join(home, "hub");
  const claudeDir = path.join(home, ".claude");

  const projects: { name: string; path: string; hasClaude: boolean }[] = [];
  if (fs.existsSync(projectsRoot)) {
    for (const entry of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "Claude") continue;
      const dirPath = path.join(projectsRoot, entry.name);
      projects.push({
        name: entry.name,
        path: dirPath,
        hasClaude: fs.existsSync(path.join(dirPath, "CLAUDE.md")),
      });
    }
  }

  let totalSessions = 0;
  if (fs.existsSync(sessionsDir)) {
    totalSessions = fs.readdirSync(sessionsDir).filter(d => {
      try { return fs.statSync(path.join(sessionsDir, d)).isDirectory(); } catch { return false; }
    }).length;
  }

  const hubFolders: string[] = [];
  let hubTotalFiles = 0;
  if (fs.existsSync(hubDir)) {
    for (const entry of fs.readdirSync(hubDir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        hubFolders.push(entry.name);
        try {
          const files = fs.readdirSync(path.join(hubDir, entry.name));
          hubTotalFiles += files.length;
        } catch {}
      }
    }
  }

  let rulesCount = 0, scriptsCount = 0, skillsCount = 0;
  try { rulesCount = fs.readdirSync(path.join(claudeDir, "rules")).length; } catch {}
  try { scriptsCount = fs.readdirSync(path.join(claudeDir, "scripts")).length; } catch {}
  try { skillsCount = fs.readdirSync(path.join(claudeDir, "skills")).filter(d => {
    try { return fs.statSync(path.join(claudeDir, "skills", d)).isDirectory(); } catch { return false; }
  }).length; } catch {}

  return NextResponse.json({
    projects,
    sessions: { total: totalSessions },
    hub: { folders: hubFolders, totalFiles: hubTotalFiles },
    config: {
      claudeMd: fs.existsSync(path.join(claudeDir, "CLAUDE.md")),
      rulesCount,
      scriptsCount,
      skillsCount,
    },
  });
}
