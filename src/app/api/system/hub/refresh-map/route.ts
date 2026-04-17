import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export async function POST() {
  const hubDir = "/root/hub";
  if (!fs.existsSync(hubDir)) {
    return NextResponse.json({ error: "Hub directory not found" }, { status: 404 });
  }

  // Scan hub structure
  const structure: Record<string, string[]> = {};
  for (const entry of fs.readdirSync(hubDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dirPath = path.join(hubDir, entry.name);
    try {
      const files = fs.readdirSync(dirPath).filter(f => !f.startsWith("."));
      structure[entry.name] = files;
    } catch {
      structure[entry.name] = [];
    }
  }

  return NextResponse.json({ ok: true, structure });
}
