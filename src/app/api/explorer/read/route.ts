import { NextResponse, type NextRequest } from "next/server";
import fs from "fs/promises";
import { getRoot, safeExplorerPath } from "@/lib/explorer-roots";

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".svg",
  ".pdf", ".zip", ".gz", ".tar", ".7z", ".rar",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp3", ".mp4", ".wav", ".ogg", ".webm",
  ".exe", ".dll", ".so", ".dylib",
  ".sqlite", ".db",
]);

function isBinaryFile(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot === -1) return false;
  return BINARY_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

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

    if (isBinaryFile(relPath)) {
      return NextResponse.json({ binary: true, size: stat.size });
    }

    const content = await fs.readFile(resolved, "utf-8");
    return NextResponse.json({ content, mtime: stat.mtime.toISOString() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
