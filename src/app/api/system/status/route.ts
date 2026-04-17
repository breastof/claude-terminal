import { NextRequest, NextResponse } from "next/server";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";

function exec(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf-8", timeout: 10000 }).trim();
  } catch {
    return "";
  }
}

function getGitStatus(repoPath: string) {
  if (!fs.existsSync(path.join(repoPath, ".git"))) {
    return { dirty: false, lastCommit: "N/A", dirtyFiles: 0 };
  }
  const porcelain = exec(`cd ${repoPath} && git status --porcelain`);
  const lastCommit = exec(`cd ${repoPath} && git log -1 --format="%h %s (%cr)"`);
  const dirtyFiles = porcelain ? porcelain.split("\n").filter(Boolean).length : 0;
  return { dirty: dirtyFiles > 0, lastCommit: lastCommit || "N/A", dirtyFiles };
}

function estimateIntervalMs(schedule: string): number {
  const parts = schedule.split(" ");
  const minute = parts[0], hour = parts[1], dayOfWeek = parts[4];
  if (minute.startsWith("*/")) return parseInt(minute.slice(2)) * 60000;
  if (hour.startsWith("*/")) return parseInt(hour.slice(2)) * 3600000;
  if (dayOfWeek !== "*") return 7 * 86400000;
  return 86400000;
}

function parseSyncLog(logPath: string, schedule?: string): { lastRun: string; ok: boolean } {
  try {
    if (!fs.existsSync(logPath)) return { lastRun: "never", ok: false };
    const stat = fs.statSync(logPath);
    const ageMs = Date.now() - stat.mtime.getTime();
    const ageMin = Math.floor(ageMs / 60000);
    const lastRun = ageMin < 60 ? `${ageMin}m ago` : ageMin < 1440 ? `${Math.floor(ageMin / 60)}h ago` : `${Math.floor(ageMin / 1440)}d ago`;
    const expectedInterval = schedule ? estimateIntervalMs(schedule) : 3600000;
    return { lastRun, ok: ageMs < expectedInterval * 2 };
  } catch {
    return { lastRun: "unknown", ok: false };
  }
}

function getOrphans(): { count: number; entries: { key: string; size: string }[] } {
  const projectsDir = path.join(process.env.HOME || "/root", ".claude/projects");
  const sessionsDir = path.join(process.env.HOME || "/root", "projects/Claude");

  if (!fs.existsSync(projectsDir)) return { count: 0, entries: [] };

  const existingSessions = new Set<string>();
  if (fs.existsSync(sessionsDir)) {
    for (const d of fs.readdirSync(sessionsDir)) existingSessions.add(d);
  }

  const entries: { key: string; size: string }[] = [];
  for (const dir of fs.readdirSync(projectsDir)) {
    if (!dir.includes("-Claude-")) continue;
    const marker = "-Claude-";
    const idx = dir.indexOf(marker);
    if (idx === -1) continue;
    const sessionId = dir.slice(idx + marker.length);
    if (!existingSessions.has(sessionId)) {
      const dirPath = path.join(projectsDir, dir);
      const size = exec(`du -sh "${dirPath}"`).split("\t")[0] || "?";
      entries.push({ key: dir, size });
    }
  }
  return { count: entries.length, entries };
}

function getDisk() {
  const paths: [string, string][] = [
    ["/root/hub/", "hub"],
    ["/root/.claude/", "claude"],
    ["/root/projects/Claude/", "sessions"],
  ];
  const result: Record<string, string> = {};
  for (const [p, key] of paths) {
    if (fs.existsSync(p)) {
      result[key] = exec(`du -sh "${p}"`).split("\t")[0] || "?";
    } else {
      result[key] = "N/A";
    }
  }
  return result;
}

function getContentMap() {
  const projectsRoot = path.join(process.env.HOME || "/root", "projects");
  const sessionsDir = path.join(projectsRoot, "Claude");
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

  let totalSessions = 0, activeSessions = 0;
  if (fs.existsSync(sessionsDir)) {
    totalSessions = fs.readdirSync(sessionsDir).filter(d => {
      try { return fs.statSync(path.join(sessionsDir, d)).isDirectory(); } catch { return false; }
    }).length;
  }

  const orphans = getOrphans();

  return {
    projects,
    sessions: { total: totalSessions, active: activeSessions, orphanMemory: orphans.count },
  };
}

function getCronJobs(): { name: string; schedule: string; lastRun: string; ok: boolean }[] {
  const jobs: { name: string; schedule: string; lastRun: string; ok: boolean }[] = [];
  const logMap: Record<string, string> = {
    "hub-sync": "/tmp/hub-sync.log",
    "dotfiles-sync": "/tmp/dotfiles-sync.log",
    "weekly-review": "/tmp/weekly-review.log",
    "ticktick-cache": "/tmp/ticktick-cache.log",
  };

  try {
    const crontab = exec("crontab -l 2>/dev/null");
    for (const line of crontab.split("\n")) {
      if (!line.trim() || line.startsWith("#")) continue;
      const parts = line.trim().split(/\s+/);
      if (parts.length < 6) continue;
      const schedule = parts.slice(0, 5).join(" ");
      const command = parts.slice(5).join(" ");
      const name = Object.keys(logMap).find(k => command.includes(k)) || command.slice(0, 30);
      const logPath = logMap[name];
      const logInfo = logPath ? parseSyncLog(logPath, schedule) : { lastRun: "unknown", ok: true };
      jobs.push({ name, schedule, ...logInfo });
    }
  } catch {}

  return jobs;
}

export async function GET() {
  const hub = getGitStatus("/root/hub");
  const dotfiles = getGitStatus("/root/.claude");
  const orphans = getOrphans();
  const disk = getDisk();
  const contentMap = getContentMap();
  const cron = getCronJobs();

  return NextResponse.json({
    hub,
    dotfiles,
    orphans,
    cron,
    disk,
    contentMap,
  });
}
