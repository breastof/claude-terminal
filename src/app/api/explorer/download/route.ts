import { NextResponse, type NextRequest } from "next/server";
import fs from "fs/promises";
import path from "path";
import { getRoot, safeExplorerPath } from "@/lib/explorer-roots";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const rootKey = searchParams.get("root");
  const relPath = searchParams.get("path");

  if (!rootKey || !relPath) {
    return NextResponse.json({ error: "Missing root or path param" }, { status: 400 });
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
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) {
      return NextResponse.json({ error: "Not a file" }, { status: 400 });
    }

    const buffer = await fs.readFile(resolved);
    const filename = path.basename(resolved);

    return new NextResponse(buffer, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(filename)}"`,
        "Content-Length": String(stat.size),
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
