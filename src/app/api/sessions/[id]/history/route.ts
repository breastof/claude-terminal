import { NextRequest, NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { getSessionProjectDir } from "@/lib/files";
import fs from "fs/promises";
import path from "path";
import { Readable } from "stream";

const BUFFERS_DIR = path.join(process.cwd(), "data", "buffers");
const MAX_TAIL = 50 * 1024 * 1024;

function authCheck(request: NextRequest): boolean {
  const token = request.cookies.get("auth-token")?.value;
  return !!token && !!verifyToken(token);
}

function respHeaders(len: number, total: number, start: number, end: number): Record<string, string> {
  return {
    "Content-Type": "application/octet-stream",
    "Content-Length": String(len),
    "X-Total-Size": String(total),
    "X-Range-Start": String(start),
    "X-Range-End": String(end),
    "Cache-Control": "no-cache",
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!authCheck(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    return NextResponse.json({ error: "Invalid session id" }, { status: 400 });
  }
  if (!getSessionProjectDir(id)) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const filePath = path.join(BUFFERS_DIR, `${id}.log`);
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return NextResponse.json({ error: "history_not_recorded" }, { status: 404 });
  }

  const sp = new URL(request.url).searchParams;
  const tailParam = sp.get("tail");
  const beforeParam = sp.get("before");
  const sizeParam = sp.get("size");

  let start: number;
  let end: number;
  if (tailParam) {
    const n = Math.min(Math.max(0, parseInt(tailParam, 10) || 0), MAX_TAIL);
    end = stat.size;
    start = Math.max(0, stat.size - n);
  } else if (beforeParam) {
    const before = Math.min(Math.max(0, parseInt(beforeParam, 10) || 0), stat.size);
    const size = Math.min(Math.max(0, parseInt(sizeParam || "0", 10) || 0), MAX_TAIL);
    end = before;
    start = Math.max(0, before - size);
  } else {
    end = stat.size;
    start = Math.max(0, stat.size - MAX_TAIL);
  }

  if (start >= end) {
    return new NextResponse(new Uint8Array(0), {
      status: 200,
      headers: respHeaders(0, stat.size, start, end),
    });
  }

  const fh = await fs.open(filePath, "r");
  const nodeStream = fh.createReadStream({ start, end: end - 1 });
  const webStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
  return new NextResponse(webStream, {
    status: 200,
    headers: respHeaders(end - start, stat.size, start, end),
  });
}
