import { NextRequest, NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { getDb } from "@/lib/db";

function getUser(req: NextRequest) {
  const token = req.cookies.get("auth-token")?.value;
  return token ? verifyToken(token) : null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const user = getUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { slug } = await params;
  const db = getDb();
  const project = db.prepare("SELECT * FROM sym_projects WHERE slug = ?").get(slug);
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ project });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const user = getUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role === "guest") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { slug } = await params;
  const body = await request.json();
  const db = getDb();

  const project = db.prepare("SELECT * FROM sym_projects WHERE slug = ?").get(slug);
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const fields: string[] = [];
  const values: unknown[] = [];

  for (const key of ["name", "description", "repo_path", "default_branch", "max_agents", "status"] as const) {
    if (body[key] !== undefined) {
      fields.push(`${key} = ?`);
      values.push(body[key]);
    }
  }
  if (body.config !== undefined) {
    fields.push("config = ?");
    values.push(JSON.stringify(body.config));
  }
  if (body.hooks !== undefined) {
    fields.push("hooks = ?");
    values.push(JSON.stringify(body.hooks));
  }

  if (fields.length === 0) return NextResponse.json({ error: "No fields to update" }, { status: 400 });

  fields.push("updated_at = datetime('now')");
  values.push((project as Record<string, unknown>).id);

  db.prepare(`UPDATE sym_projects SET ${fields.join(", ")} WHERE id = ?`).run(...values);

  const updated = db.prepare("SELECT * FROM sym_projects WHERE slug = ?").get(slug);
  return NextResponse.json({ project: updated });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const user = getUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { slug } = await params;
  const db = getDb();
  const result = db.prepare("DELETE FROM sym_projects WHERE slug = ?").run(slug);
  if (result.changes === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ ok: true });
}
