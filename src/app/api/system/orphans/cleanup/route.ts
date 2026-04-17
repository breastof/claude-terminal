import { NextRequest, NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";

function getUser(req: NextRequest) {
  const token = req.cookies.get("auth-token")?.value;
  return token ? verifyToken(token) : null;
}

export async function POST(request: NextRequest) {
  const user = getUser(request);
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { keys } = await request.json();

  if (!Array.isArray(keys) || keys.length === 0) {
    return NextResponse.json({ error: "keys array is required" }, { status: 400 });
  }

  const projectsDir = path.join(process.env.HOME || "/root", ".claude/projects");
  const deleted: string[] = [];
  const errors: { key: string; error: string }[] = [];

  for (const key of keys) {
    if (typeof key !== "string") {
      errors.push({ key: String(key), error: "Invalid key type" });
      continue;
    }

    // Validate: must be under ~/.claude/projects/ and must exist
    const targetPath = path.join(projectsDir, key);
    const resolved = path.resolve(targetPath);

    // Security: ensure it's actually under projectsDir
    if (!resolved.startsWith(path.resolve(projectsDir))) {
      errors.push({ key, error: "Path traversal detected" });
      continue;
    }

    if (!fs.existsSync(resolved)) {
      errors.push({ key, error: "Directory not found" });
      continue;
    }

    try {
      execSync(`rm -rf ${JSON.stringify(resolved)}`, { timeout: 10000 });
      deleted.push(key);
    } catch (err) {
      errors.push({ key, error: (err as Error).message });
    }
  }

  return NextResponse.json({ deleted, errors });
}
