import { NextResponse, type NextRequest } from "next/server";
import fs from "fs/promises";
import { getRoot, safeExplorerPath } from "@/lib/explorer-roots";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const rootKey = searchParams.get("root");
  const relPath = searchParams.get("path") || ".";

  if (!rootKey) {
    return NextResponse.json({ error: "Missing root param" }, { status: 400 });
  }

  const root = getRoot(rootKey);
  if (!root) {
    return NextResponse.json({ error: "Invalid root" }, { status: 400 });
  }

  const resolved = safeExplorerPath(root, relPath);
  if (!resolved) {
    return NextResponse.json({ error: "Path denied" }, { status: 400 });
  }

  try {
    const dirents = await fs.readdir(resolved, { withFileTypes: true });
    const entries = await Promise.all(
      dirents.map(async (d) => {
        const entry: {
          name: string;
          type: "file" | "directory";
          size?: number;
          modifiedAt?: string;
        } = {
          name: d.name,
          type: d.isDirectory() ? "directory" : "file",
        };
        try {
          const stat = await fs.stat(`${resolved}/${d.name}`);
          entry.size = stat.size;
          entry.modifiedAt = stat.mtime.toISOString();
        } catch {
          // stat may fail on broken symlinks — skip metadata
        }
        return entry;
      }),
    );

    // directories first, then alphabetical
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return NextResponse.json({ entries });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
