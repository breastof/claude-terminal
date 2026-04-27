import { NextRequest, NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import fs from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";

interface ProjectEntry {
  path: string;
  label: string;
  kind: "project" | "service" | "sandbox";
  isGit: boolean;
  modifiedAt: number;
}

function getUser(req: NextRequest) {
  const token = req.cookies.get("auth-token")?.value;
  return token ? verifyToken(token) : null;
}

function listSubdirs(root: string, kind: ProjectEntry["kind"], excludeNames: Set<string> = new Set()): ProjectEntry[] {
  if (!fs.existsSync(root)) return [];
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    const out: ProjectEntry[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith(".")) continue;
      if (excludeNames.has(e.name)) continue;
      const full = path.join(root, e.name);
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(full).mtimeMs; } catch {}
      const isGit = fs.existsSync(path.join(full, ".git"));
      out.push({
        path: full,
        label: `${path.basename(root)}/${e.name}`,
        kind,
        isGit,
        modifiedAt: mtimeMs,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export async function GET(request: NextRequest) {
  const user = getUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (user.role === "guest") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const home = process.env.HOME || "/home/user1";
  const projects = listSubdirs(path.join(home, "projects"), "project", new Set(["Claude"]));
  const services = listSubdirs(path.join(home, "services"), "service");

  // Recent sandboxes from ~/projects/Claude — limit to 10 most recent
  const sandboxes = listSubdirs(path.join(home, "projects", "Claude"), "sandbox")
    .sort((a, b) => b.modifiedAt - a.modifiedAt)
    .slice(0, 10);

  const all = [...projects, ...services, ...sandboxes].sort((a, b) => b.modifiedAt - a.modifiedAt);
  return NextResponse.json({ entries: all });
}
