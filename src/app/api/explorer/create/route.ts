import { NextResponse, type NextRequest } from "next/server";
import fs from "fs/promises";
import path from "path";
import { getRoot, safeExplorerPath } from "@/lib/explorer-roots";

export async function POST(request: NextRequest) {
  let body: { root?: string; path?: string; type?: "file" | "directory" };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { root: rootKey, path: relPath, type } = body;

  if (!rootKey || !relPath || !type) {
    return NextResponse.json({ error: "Missing root, path or type" }, { status: 400 });
  }

  if (type !== "file" && type !== "directory") {
    return NextResponse.json({ error: "Type must be file or directory" }, { status: 400 });
  }

  const root = getRoot(rootKey);
  if (!root) {
    return NextResponse.json({ error: "Invalid root" }, { status: 400 });
  }

  if (!root.writable) {
    return NextResponse.json({ error: "Root is read-only" }, { status: 403 });
  }

  const resolved = safeExplorerPath(root, relPath);
  if (!resolved) {
    return NextResponse.json({ error: "Path denied" }, { status: 403 });
  }

  try {
    if (type === "directory") {
      await fs.mkdir(resolved, { recursive: true });
    } else {
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, "", { flag: "wx" });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      return NextResponse.json({ error: "Already exists" }, { status: 409 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
