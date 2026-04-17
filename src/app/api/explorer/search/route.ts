import { NextResponse, type NextRequest } from "next/server";
import fs from "fs/promises";
import path from "path";
import { getRoot, safeExplorerPath, isDenied } from "@/lib/explorer-roots";

const MAX_RESULTS = 100;
const MAX_FILE_SIZE = 1024 * 1024; // 1 MB — skip large files for content search

interface SearchEntry {
  name: string;
  type: "file" | "directory";
  path: string;
  match?: string; // content match line
}

async function searchDir(
  dir: string,
  rootPath: string,
  query: string,
  lowerQuery: string,
  results: SearchEntry[],
): Promise<void> {
  if (results.length >= MAX_RESULTS) return;

  let dirents;
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // permission errors — skip
  }

  for (const d of dirents) {
    if (results.length >= MAX_RESULTS) return;

    const fullPath = path.join(dir, d.name);
    if (isDenied(fullPath)) continue;

    const rel = path.relative(rootPath, fullPath);

    // filename match
    if (d.name.toLowerCase().includes(lowerQuery)) {
      results.push({
        name: d.name,
        type: d.isDirectory() ? "directory" : "file",
        path: rel,
      });
    }

    if (d.isDirectory()) {
      await searchDir(fullPath, rootPath, query, lowerQuery, results);
    } else if (d.isFile() && !d.name.toLowerCase().includes(lowerQuery)) {
      // content search for files whose name didn't match
      try {
        const stat = await fs.stat(fullPath);
        if (stat.size > MAX_FILE_SIZE) continue;
        const content = await fs.readFile(fullPath, "utf-8");
        const lines = content.split("\n");
        for (const line of lines) {
          if (line.toLowerCase().includes(lowerQuery)) {
            results.push({
              name: d.name,
              type: "file",
              path: rel,
              match: line.trim().slice(0, 200),
            });
            break; // one match per file is enough
          }
        }
      } catch {
        // binary / unreadable — skip
      }
    }
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const rootKey = searchParams.get("root");
  const query = searchParams.get("q");
  const relPath = searchParams.get("path") || ".";

  if (!rootKey || !query) {
    return NextResponse.json({ error: "Missing root or q param" }, { status: 400 });
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
    const results: SearchEntry[] = [];
    await searchDir(resolved, root.path, query, query.toLowerCase(), results);
    return NextResponse.json({ entries: results });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
