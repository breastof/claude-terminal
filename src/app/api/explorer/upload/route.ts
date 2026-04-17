import { NextResponse, type NextRequest } from "next/server";
import fs from "fs/promises";
import path from "path";
import { getRoot, safeExplorerPath } from "@/lib/explorer-roots";

export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const rootKey = formData.get("root") as string | null;
  const relPath = formData.get("path") as string | null;

  if (!rootKey) {
    return NextResponse.json({ error: "Missing root field" }, { status: 400 });
  }

  const root = getRoot(rootKey);
  if (!root) {
    return NextResponse.json({ error: "Invalid root" }, { status: 400 });
  }

  if (!root.writable) {
    return NextResponse.json({ error: "Root is read-only" }, { status: 403 });
  }

  const targetDir = relPath ? safeExplorerPath(root, relPath) : root.path;
  if (!targetDir) {
    return NextResponse.json({ error: "Path denied" }, { status: 403 });
  }

  try {
    await fs.mkdir(targetDir, { recursive: true });

    let filesWritten = 0;
    const entries = formData.getAll("files");

    for (const entry of entries) {
      if (!(entry instanceof File)) continue;

      const fileName = entry.name;
      const filePath = path.join(targetDir, fileName);

      // validate each file destination
      const rel = path.relative(root.path, filePath);
      const safe = safeExplorerPath(root, rel);
      if (!safe) continue; // skip denied files

      const buffer = Buffer.from(await entry.arrayBuffer());
      await fs.writeFile(safe, buffer);
      filesWritten++;
    }

    return NextResponse.json({ ok: true, files: filesWritten });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
