import { NextRequest, NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import fs from "fs";
import path from "path";

function getUser(req: NextRequest) {
  const token = req.cookies.get("auth-token")?.value;
  return token ? verifyToken(token) : null;
}

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

export async function GET(request: NextRequest) {
  const user = getUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const skillsDir = path.join(process.env.HOME || "/root", ".claude/skills");

  if (!fs.existsSync(skillsDir)) {
    return NextResponse.json({ skills: [] });
  }

  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  const skills: { name: string; description: string; trigger: string }[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillMdPath = path.join(skillsDir, entry.name, "SKILL.md");
    if (!fs.existsSync(skillMdPath)) continue;

    try {
      const content = fs.readFileSync(skillMdPath, "utf-8");
      const fm = parseFrontmatter(content);
      skills.push({
        name: fm.name || entry.name,
        description: fm.description || "",
        trigger: fm.user_invocable === "true" ? `/${fm.name || entry.name}` : "",
      });
    } catch {
      // Skip unreadable skill files
    }
  }

  return NextResponse.json({ skills });
}
