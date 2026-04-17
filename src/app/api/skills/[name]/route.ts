import { NextRequest, NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { marked } from "marked";
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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const user = getUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { name } = await params;
  const skillDir = path.join(process.env.HOME || "/root", ".claude/skills", name);

  if (!fs.existsSync(skillDir)) {
    return NextResponse.json({ error: "Skill not found" }, { status: 404 });
  }

  const skillMdPath = path.join(skillDir, "SKILL.md");
  let description = "";
  let skillMdHtml = "";

  if (fs.existsSync(skillMdPath)) {
    const raw = fs.readFileSync(skillMdPath, "utf-8");
    const fm = parseFrontmatter(raw);
    description = fm.description || "";
    skillMdHtml = await marked(raw);
  }

  // Find config.json — check root and config/ subdirectory
  let config: string | null = null;
  for (const cp of ["config.json", "config/config.json"]) {
    const configPath = path.join(skillDir, cp);
    if (fs.existsSync(configPath)) {
      config = fs.readFileSync(configPath, "utf-8");
      break;
    }
  }

  // Find memory.json — check root and data/ subdirectory
  let memory: string | null = null;
  for (const mp of ["memory.json", "data/memory.json"]) {
    const memoryPath = path.join(skillDir, mp);
    if (fs.existsSync(memoryPath)) {
      memory = fs.readFileSync(memoryPath, "utf-8");
      break;
    }
  }

  // Recursive file listing
  const files: string[] = [];
  function walkDir(dir: string, prefix: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "__pycache__" || entry.name === "node_modules") continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walkDir(path.join(dir, entry.name), rel);
      } else {
        files.push(rel);
      }
    }
  }
  walkDir(skillDir, "");

  return NextResponse.json({
    name,
    description,
    skillMd: skillMdHtml,
    config,
    memory,
    files,
  });
}
