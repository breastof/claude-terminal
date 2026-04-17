import { NextResponse, type NextRequest } from "next/server";
import fs from "fs/promises";
import path from "path";
import { getRoot, safeExplorerPath } from "@/lib/explorer-roots";

export async function POST(request: NextRequest) {
  let body: { root?: string; oldPath?: string; newName?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { root: rootKey, oldPath, newName } = body;

  if (!rootKey || !oldPath || !newName) {
    return NextResponse.json({ error: "Missing root, oldPath or newName" }, { status: 400 });
  }

  // newName must be a plain filename, no slashes
  if (newName.includes("/") || newName.includes("\\")) {
    return NextResponse.json({ error: "newName must not contain path separators" }, { status: 400 });
  }

  const root = getRoot(rootKey);
  if (!root) {
    return NextResponse.json({ error: "Invalid root" }, { status: 400 });
  }

  if (!root.writable) {
    return NextResponse.json({ error: "Root is read-only" }, { status: 403 });
  }

  const resolvedOld = safeExplorerPath(root, oldPath);
  if (!resolvedOld) {
    return NextResponse.json({ error: "Old path denied" }, { status: 403 });
  }

  const newPath = path.join(path.dirname(resolvedOld), newName);
  const newRelative = path.relative(root.path, newPath);
  const resolvedNew = safeExplorerPath(root, newRelative);
  if (!resolvedNew) {
    return NextResponse.json({ error: "New path denied" }, { status: 403 });
  }

  try {
    await fs.rename(resolvedOld, resolvedNew);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
