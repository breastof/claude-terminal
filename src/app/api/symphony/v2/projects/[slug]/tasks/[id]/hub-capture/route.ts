import { NextRequest, NextResponse } from "next/server";
import { getUser } from "@/lib/symphony-auth";
import { getDb } from "@/lib/db";
import { execFile } from "child_process";
import { existsSync } from "fs";
import path from "path";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> }
) {
  const user = getUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const db = getDb();

  const task = db.prepare("SELECT * FROM sym_tasks WHERE id = ?").get(Number(id));
  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });

  const scriptPath = path.join(process.env.HOME || "/root", ".claude/scripts/task-to-hub.sh");
  const dbPath = path.join(process.cwd(), "data/claude-terminal.db");

  if (!existsSync(scriptPath)) {
    return NextResponse.json({ error: "task-to-hub.sh script not found" }, { status: 500 });
  }

  return new Promise<NextResponse>((resolve) => {
    execFile("bash", [scriptPath, String(id), dbPath], { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) {
        resolve(NextResponse.json(
          { error: "Hub capture failed", details: stderr || err.message },
          { status: 500 }
        ));
        return;
      }

      const hubPath = (stdout || "").trim();
      if (!hubPath) {
        resolve(NextResponse.json(
          { message: "No hub note created — task may lack handoff/review comments" },
          { status: 200 }
        ));
        return;
      }

      resolve(NextResponse.json({ ok: true, path: hubPath }));
    });
  });
}
