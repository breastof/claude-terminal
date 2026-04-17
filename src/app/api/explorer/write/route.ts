import { NextResponse, type NextRequest } from "next/server";
import fs from "fs/promises";
import path from "path";
import { getRoot, safeExplorerPath } from "@/lib/explorer-roots";

export async function POST(request: NextRequest) {
  let body: { root?: string; path?: string; content?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { root: rootKey, path: relPath, content } = body;

  if (!rootKey || !relPath || content === undefined) {
    return NextResponse.json({ error: "Missing root, path or content" }, { status: 400 });
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
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content, "utf-8");
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
