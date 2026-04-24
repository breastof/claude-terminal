"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ServerPulse } from "@/components/Icons";

type Stats = {
  cpu: { percent: number | null; load1: number; load5: number; load15: number; cores: number };
  mem: { total: number; used: number; swapTotal: number; swapUsed: number };
  disk: { total: number; used: number };
  uptime: { machine: number; service: number };
  ts: number;
};

type Level = "ok" | "warn" | "crit";

function worstLevel(s: Stats): Level {
  const cpuPct = s.cpu.percent ?? 0;
  const memPct = s.mem.total ? (s.mem.used / s.mem.total) * 100 : 0;
  const diskPct = s.disk.total ? (s.disk.used / s.disk.total) * 100 : 0;
  const loadRatio = s.cpu.cores ? s.cpu.load5 / s.cpu.cores : 0;

  if (cpuPct > 90 || memPct > 90 || diskPct > 95 || loadRatio > 2) return "crit";
  if (cpuPct > 60 || memPct > 70 || diskPct > 80 || loadRatio > 1) return "warn";
  return "ok";
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

function fmtDuration(sec: number): string {
  if (sec < 60) return `${sec}с`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}м`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm ? `${h}ч ${rm}м` : `${h}ч`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d}д ${rh}ч` : `${d}д`;
}

const LEVEL_COLOR: Record<Level, string> = {
  ok: "text-emerald-500",
  warn: "text-amber-500",
  crit: "text-rose-500",
};

const LEVEL_TITLE: Record<Level, string> = {
  ok: "Сервер в норме",
  warn: "Повышенная нагрузка",
  crit: "Критическая нагрузка",
};

function Bar({ percent, level }: { percent: number; level: Level }) {
  const color =
    level === "crit" ? "bg-rose-500" : level === "warn" ? "bg-amber-500" : "bg-emerald-500";
  return (
    <div className="w-full h-1.5 bg-surface-hover rounded-full overflow-hidden">
      <div className={`h-full ${color} transition-all`} style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
    </div>
  );
}

function rowLevel(pct: number, warn: number, crit: number): Level {
  if (pct > crit) return "crit";
  if (pct > warn) return "warn";
  return "ok";
}

export default function SystemHealth() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [anchor, setAnchor] = useState<{ right: number; top: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/system/stats", { cache: "no-store" });
        if (!res.ok) { if (!cancelled) setError(true); return; }
        const data = (await res.json()) as Stats;
        if (!cancelled) { setStats(data); setError(false); }
      } catch {
        if (!cancelled) setError(true);
      }
    };
    tick();
    const interval = open ? 5000 : 15000;
    const id = setInterval(tick, interval);
    return () => { cancelled = true; clearInterval(id); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t)) return;
      if (dropRef.current?.contains(t)) return;
      setOpen(false);
    };
    const updateAnchor = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (r) setAnchor({ right: window.innerWidth - r.right, top: r.bottom + 8 });
    };
    updateAnchor();
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("resize", updateAnchor);
    window.addEventListener("scroll", updateAnchor, true);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("resize", updateAnchor);
      window.removeEventListener("scroll", updateAnchor, true);
    };
  }, [open]);

  const level: Level = error ? "crit" : stats ? worstLevel(stats) : "ok";
  const color = LEVEL_COLOR[level];
  const title = error ? "Нет данных от сервера" : LEVEL_TITLE[level];

  const memPct = stats?.mem.total ? (stats.mem.used / stats.mem.total) * 100 : 0;
  const diskPct = stats?.disk.total ? (stats.disk.used / stats.disk.total) * 100 : 0;
  const swapPct = stats?.mem.swapTotal ? (stats.mem.swapUsed / stats.mem.swapTotal) * 100 : 0;
  const cpuPct = stats?.cpu.percent ?? null;

  const dropdown = open && anchor && (
    <div
      ref={dropRef}
      className="fixed w-72 bg-surface-alt border border-border-strong rounded-lg shadow-2xl p-3 text-xs"
      style={{ right: anchor.right, top: anchor.top, zIndex: 9999 }}
    >
          <div className="flex items-center justify-between mb-2">
            <span className="font-semibold text-foreground">Состояние сервера</span>
            <span className={color}>{title}</span>
          </div>
          {error && <div className="text-rose-500">Не удалось получить данные</div>}
          {stats && !error && (
            <div className="space-y-2.5">
              <div>
                <div className="flex justify-between text-muted-fg mb-1">
                  <span>CPU</span>
                  <span className="text-foreground">
                    {cpuPct !== null ? `${cpuPct.toFixed(0)}%` : "…"}
                  </span>
                </div>
                <Bar percent={cpuPct ?? 0} level={cpuPct !== null ? rowLevel(cpuPct, 60, 90) : "ok"} />
                <div className="flex justify-between text-muted-fg mt-1">
                  <span>Load Avg</span>
                  <span className="text-foreground">
                    {stats.cpu.load1.toFixed(2)} / {stats.cpu.load5.toFixed(2)} / {stats.cpu.load15.toFixed(2)}
                    <span className="text-muted-fg"> · {stats.cpu.cores} ядер</span>
                  </span>
                </div>
              </div>

              <div>
                <div className="flex justify-between text-muted-fg mb-1">
                  <span>RAM</span>
                  <span className="text-foreground">
                    {fmtBytes(stats.mem.used)} / {fmtBytes(stats.mem.total)}
                    <span className="text-muted-fg"> · {memPct.toFixed(0)}%</span>
                  </span>
                </div>
                <Bar percent={memPct} level={rowLevel(memPct, 70, 90)} />
              </div>

              {stats.mem.swapTotal > 0 && (
                <div>
                  <div className="flex justify-between text-muted-fg mb-1">
                    <span>Swap</span>
                    <span className="text-foreground">
                      {fmtBytes(stats.mem.swapUsed)} / {fmtBytes(stats.mem.swapTotal)}
                      <span className="text-muted-fg"> · {swapPct.toFixed(0)}%</span>
                    </span>
                  </div>
                  <Bar percent={swapPct} level={rowLevel(swapPct, 50, 80)} />
                </div>
              )}

              <div>
                <div className="flex justify-between text-muted-fg mb-1">
                  <span>Диск /</span>
                  <span className="text-foreground">
                    {fmtBytes(stats.disk.used)} / {fmtBytes(stats.disk.total)}
                    <span className="text-muted-fg"> · {diskPct.toFixed(0)}%</span>
                  </span>
                </div>
                <Bar percent={diskPct} level={rowLevel(diskPct, 80, 95)} />
              </div>

              <div className="pt-1.5 border-t border-border flex justify-between text-muted-fg">
                <span>Аптайм ВМ</span>
                <span className="text-foreground">{fmtDuration(stats.uptime.machine)}</span>
              </div>
              <div className="flex justify-between text-muted-fg">
                <span>claude-terminal</span>
                <span className="text-foreground">{fmtDuration(stats.uptime.service)}</span>
              </div>
            </div>
          )}
        </div>
  );

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center justify-center w-7 h-7 rounded-md transition-all cursor-pointer hover:bg-surface-hover ${color}`}
        title={title}
        aria-label={title}
      >
        <ServerPulse className="w-4 h-4 md:w-3.5 md:h-3.5" />
      </button>
      {mounted && dropdown ? createPortal(dropdown, document.body) : null}
    </>
  );
}
