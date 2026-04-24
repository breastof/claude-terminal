import { NextRequest, NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { readFile, statfs } from "node:fs/promises";
import os from "node:os";

export const dynamic = "force-dynamic";

function getTokenPayload(request: NextRequest) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return null;
  return verifyToken(token);
}

type CpuSnapshot = { total: number; idle: number; at: number };
let lastCpu: CpuSnapshot | null = null;

async function readCpuSnapshot(): Promise<CpuSnapshot> {
  const stat = await readFile("/proc/stat", "utf8");
  const line = stat.split("\n", 1)[0];
  const parts = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = (parts[3] ?? 0) + (parts[4] ?? 0);
  const total = parts.reduce((a, b) => a + b, 0);
  return { total, idle, at: Date.now() };
}

async function cpuPercent(): Promise<number | null> {
  const cur = await readCpuSnapshot();
  const prev = lastCpu;
  lastCpu = cur;
  if (!prev) return null;
  const dt = cur.total - prev.total;
  const di = cur.idle - prev.idle;
  if (dt <= 0) return null;
  return Math.max(0, Math.min(100, ((dt - di) / dt) * 100));
}

async function readMeminfo() {
  const raw = await readFile("/proc/meminfo", "utf8");
  const map: Record<string, number> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^(\w+):\s+(\d+)\s*kB/);
    if (m) map[m[1]] = Number(m[2]) * 1024;
  }
  const total = map.MemTotal ?? 0;
  const avail = map.MemAvailable ?? map.MemFree ?? 0;
  const used = Math.max(0, total - avail);
  const swapTotal = map.SwapTotal ?? 0;
  const swapFree = map.SwapFree ?? 0;
  const swapUsed = Math.max(0, swapTotal - swapFree);
  return { total, used, swapTotal, swapUsed };
}

async function readDisk() {
  try {
    const s = await statfs("/");
    const total = Number(s.blocks) * s.bsize;
    const free = Number(s.bavail) * s.bsize;
    const used = total - free;
    return { total, used };
  } catch {
    return { total: 0, used: 0 };
  }
}

async function readMachineUptime(): Promise<number> {
  try {
    const raw = await readFile("/proc/uptime", "utf8");
    return Math.floor(Number(raw.split(" ")[0]));
  } catch {
    return Math.floor(os.uptime());
  }
}

export async function GET(request: NextRequest) {
  const payload = getTokenPayload(request);
  if (!payload || payload.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const [cpu, mem, disk, machineUptime] = await Promise.all([
    cpuPercent(),
    readMeminfo(),
    readDisk(),
    readMachineUptime(),
  ]);

  const load = os.loadavg();
  const cores = os.cpus().length;
  const serviceUptime = Math.floor(process.uptime());

  return NextResponse.json({
    cpu: { percent: cpu, load1: load[0], load5: load[1], load15: load[2], cores },
    mem,
    disk,
    uptime: { machine: machineUptime, service: serviceUptime },
    ts: Date.now(),
  });
}
