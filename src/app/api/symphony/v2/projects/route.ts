import { NextRequest, NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { getDb } from "@/lib/db";

function getUser(req: NextRequest) {
  const token = req.cookies.get("auth-token")?.value;
  return token ? verifyToken(token) : null;
}

export async function GET(request: NextRequest) {
  const user = getUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const db = getDb();
  const projects = db.prepare("SELECT * FROM sym_projects ORDER BY created_at DESC").all();
  return NextResponse.json({ projects });
}

export async function POST(request: NextRequest) {
  const user = getUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role === "guest") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await request.json();
  const { name, slug, description, repo_path, default_branch, config, hooks, max_agents } = body;

  if (!name || !slug) {
    return NextResponse.json({ error: "name and slug are required" }, { status: 400 });
  }

  const db = getDb();
  try {
    const result = db.prepare(`
      INSERT INTO sym_projects (slug, name, description, repo_path, default_branch, config, hooks, max_agents)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      slug, name,
      description || "",
      repo_path || null,
      default_branch || "main",
      JSON.stringify(config || {}),
      JSON.stringify(hooks || {}),
      max_agents || 5
    );

    const project = db.prepare("SELECT * FROM sym_projects WHERE id = ?").get(result.lastInsertRowid);
    return NextResponse.json({ project }, { status: 201 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    if (message.includes("UNIQUE")) {
      return NextResponse.json({ error: "Slug already exists" }, { status: 409 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
