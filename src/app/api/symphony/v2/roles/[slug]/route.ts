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
  const role = db.prepare("SELECT * FROM sym_agent_roles WHERE slug = ?").get(slug);
  if (!role) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ role });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const user = getUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { slug } = await params;
  const body = await request.json();
  const db = getDb();

  const role = db.prepare("SELECT id FROM sym_agent_roles WHERE slug = ?").get(slug) as { id: number } | undefined;
  if (!role) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const fields: string[] = [];
  const values: unknown[] = [];

  for (const key of ["name", "model", "max_budget_usd", "system_prompt", "allowed_tools", "disallowed_tools", "color", "icon"]) {
    if (body[key] !== undefined) {
      fields.push(`${key} = ?`);
      values.push(body[key]);
    }
  }
  if (body.workflow !== undefined) {
    fields.push("workflow = ?");
    values.push(JSON.stringify(body.workflow));
  }

  if (fields.length === 0) return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  values.push(role.id);

  db.prepare(`UPDATE sym_agent_roles SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  const updated = db.prepare("SELECT * FROM sym_agent_roles WHERE slug = ?").get(slug);
  return NextResponse.json({ role: updated });
}
