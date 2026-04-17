import { NextResponse, type NextRequest } from "next/server";
import fs from "fs/promises";
import { getRoot, safeExplorerPath } from "@/lib/explorer-roots";

export async function POST(request: NextRequest) {
  let body: { root?: string; paths?: string[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { root: rootKey, paths } = body;

  if (!rootKey || !Array.isArray(paths) || paths.length === 0) {
    return NextResponse.json({ error: "Missing root or paths" }, { status: 400 });
  }

  const root = getRoot(rootKey);
  if (!root) {
    return NextResponse.json({ error: "Invalid root" }, { status: 400 });
  }

  if (!root.writable) {
    return NextResponse.json({ error: "Root is read-only" }, { status: 403 });
  }

  try {
    let deleted = 0;
    for (const relPath of paths) {
      const resolved = safeExplorerPath(root, relPath);
      if (!resolved) {
        continue; // skip denied paths silently
      }
      // prevent deleting the root itself
      if (resolved === root.path) {
        continue;
      }
      await fs.rm(resolved, { recursive: true, force: true });
      deleted++;
    }
    return NextResponse.json({ ok: true, deleted });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
