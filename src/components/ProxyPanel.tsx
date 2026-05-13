"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { Wifi, WifiOff, Trash } from "@/components/Icons";

type ConnectionStatus = "connected" | "disconnected" | "idle";

interface ProxyRow {
  id: number;
  label: string;
  host: string;
  port: number;
  login: string | null;
  hasPassword: boolean;
  isPrimary: boolean;
  isFallback: boolean;
  display: string;
  createdAt: string;
}

interface TestResult {
  id: number;
  ok: boolean;
  code: number | null;
  ms: number;
  error?: string | null;
}

interface ProxyPanelProps {
  connectionStatus: ConnectionStatus;
  isAdmin: boolean;
}

export default function ProxyPanel({ connectionStatus, isAdmin }: ProxyPanelProps) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [anchor, setAnchor] = useState<{ right: number; top: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);

  const [proxies, setProxies] = useState<ProxyRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [rawInput, setRawInput] = useState("");
  const [labelInput, setLabelInput] = useState("");
  const [tests, setTests] = useState<Record<number, TestResult | "running">>({});

  useEffect(() => { setMounted(true); }, []);

  const fetchProxies = useCallback(async () => {
    if (!isAdmin) return;
    setLoading(true);
    try {
      const res = await fetch("/api/proxies", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setProxies(data.proxies || []);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    if (open && isAdmin) fetchProxies();
  }, [open, isAdmin, fetchProxies]);

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

  const handleAdd = async () => {
    if (!rawInput.trim()) return;
    setAdding(true);
    try {
      const res = await fetch("/api/proxies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw: rawInput.trim(), label: labelInput.trim() || undefined }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error === "invalid_format" ? "Не распарсил формат" : data.error || "Ошибка");
        return;
      }
      setRawInput("");
      setLabelInput("");
      setError(null);
      await fetchProxies();
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm("Удалить прокси?")) return;
    const res = await fetch(`/api/proxies/${id}`, { method: "DELETE" });
    if (res.ok) fetchProxies();
  };

  const handleActivate = async (id: number, role: "primary" | "fallback") => {
    const res = await fetch(`/api/proxies/${id}/activate?role=${role}`, { method: "POST" });
    if (res.ok) fetchProxies();
    else {
      const data = await res.json().catch(() => ({}));
      setError(data.error || "Не удалось активировать");
    }
  };

  const handleTest = async (id: number) => {
    setTests((t) => ({ ...t, [id]: "running" }));
    const res = await fetch(`/api/proxies/${id}/test`, { method: "POST" });
    const data = await res.json().catch(() => ({ ok: false, code: null, ms: 0 }));
    setTests((t) => ({ ...t, [id]: { id, ...data } }));
  };

  const wsLabel =
    connectionStatus === "connected" ? "подключён"
    : connectionStatus === "disconnected" ? "разорван"
    : "нет открытой сессии";
  const wsColor =
    connectionStatus === "connected" ? "text-emerald-500"
    : connectionStatus === "disconnected" ? "text-rose-500"
    : "text-muted-fg";

  const Icon = connectionStatus === "disconnected" ? WifiOff : Wifi;
  const iconColor =
    connectionStatus === "connected" ? "text-emerald-500"
    : connectionStatus === "disconnected" ? "text-rose-500"
    : "text-muted-fg";

  const dropdown = open && anchor && (
    <div
      ref={dropRef}
      className="fixed w-80 bg-surface-alt border border-border-strong rounded-lg shadow-2xl p-3 text-xs"
      style={{ right: anchor.right, top: anchor.top, zIndex: 9999 }}
    >
      {/* WS-статус */}
      <div className="flex items-center justify-between mb-3 pb-2 border-b border-border">
        <span className="font-semibold text-foreground">Сеть</span>
        <span className={wsColor}>Терминал: {wsLabel}</span>
      </div>

      {!isAdmin && (
        <div className="text-muted-fg text-xs">
          Управление прокси доступно только администраторам.
        </div>
      )}

      {isAdmin && (
        <>
          <div className="text-muted-fg uppercase tracking-wider text-[10px] mb-1.5">
            AI-прокси
          </div>

          {error && (
            <div className="mb-2 px-2 py-1 rounded bg-rose-500/10 text-rose-400 text-[11px]">
              {error}
            </div>
          )}

          {loading && proxies.length === 0 && (
            <div className="text-muted-fg py-2">Загрузка…</div>
          )}

          {proxies.length === 0 && !loading && (
            <div className="text-muted-fg py-2 text-[11px]">
              Нет сохранённых прокси. Добавь первый ниже.
            </div>
          )}

          <div className="space-y-1.5 mb-3">
            {proxies.map((p) => {
              const test = tests[p.id];
              return (
                <div key={p.id} className="rounded border border-border bg-surface px-2 py-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-foreground font-medium truncate">{p.label}</span>
                        {p.isPrimary && (
                          <span className="px-1 py-px text-[9px] rounded bg-emerald-500/20 text-emerald-400">
                            primary
                          </span>
                        )}
                        {p.isFallback && (
                          <span className="px-1 py-px text-[9px] rounded bg-amber-500/20 text-amber-400">
                            fallback
                          </span>
                        )}
                      </div>
                      <div className="text-muted-fg text-[10px] font-mono truncate">{p.display}</div>
                    </div>
                    <button
                      onClick={() => handleDelete(p.id)}
                      className="p-1 text-muted-fg hover:text-rose-400 transition-colors cursor-pointer flex-shrink-0"
                      title="Удалить"
                      aria-label="Удалить"
                    >
                      <Trash className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="flex items-center gap-1 mt-1.5">
                    <button
                      onClick={() => handleActivate(p.id, "primary")}
                      disabled={p.isPrimary}
                      className="px-2 py-0.5 rounded text-[10px] border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
                    >
                      Сделать основным
                    </button>
                    <button
                      onClick={() => handleActivate(p.id, "fallback")}
                      disabled={p.isFallback}
                      className="px-2 py-0.5 rounded text-[10px] border border-amber-500/30 text-amber-400 hover:bg-amber-500/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
                    >
                      Резерв
                    </button>
                    <button
                      onClick={() => handleTest(p.id)}
                      disabled={test === "running"}
                      className="ml-auto px-2 py-0.5 rounded text-[10px] border border-border text-muted-fg hover:text-foreground hover:bg-surface-hover disabled:opacity-40 transition-colors cursor-pointer"
                    >
                      {test === "running" ? "…" :
                       test ? `${test.ok ? "✓" : "✗"} ${test.code ?? "-"} · ${test.ms}мс` :
                       "Тест"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Форма добавления */}
          <div className="border-t border-border pt-2">
            <div className="text-muted-fg uppercase tracking-wider text-[10px] mb-1.5">
              Добавить прокси
            </div>
            <input
              type="text"
              value={rawInput}
              onChange={(e) => setRawInput(e.target.value)}
              placeholder="ip:port:login:pass или http://..."
              className="w-full mb-1.5 px-2 py-1 text-[11px] font-mono bg-surface border border-border rounded text-foreground placeholder-muted-fg focus:outline-none focus:border-accent"
            />
            <input
              type="text"
              value={labelInput}
              onChange={(e) => setLabelInput(e.target.value)}
              placeholder="Имя (опционально)"
              className="w-full mb-1.5 px-2 py-1 text-[11px] bg-surface border border-border rounded text-foreground placeholder-muted-fg focus:outline-none focus:border-accent"
            />
            <button
              onClick={handleAdd}
              disabled={adding || !rawInput.trim()}
              className="w-full px-2 py-1 rounded text-[11px] bg-accent-muted text-accent-fg hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
            >
              {adding ? "Добавляю…" : "Добавить"}
            </button>
          </div>

          <div className="mt-2 text-[10px] text-muted-fg">
            Применяется к новым AI-сессиям. Открытые сессии используют старый прокси до Stop+Resume.
          </div>
        </>
      )}
    </div>
  );

  // Иконка показывается всегда для admin (даже без открытой сессии — нужно
  // управлять прокси). Для не-admin — только когда есть активная сессия
  // (показать WS-статус, без панели).
  if (!isAdmin && connectionStatus === "idle") return null;

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center justify-center w-7 h-7 rounded-md transition-all cursor-pointer hover:bg-surface-hover ${iconColor}`}
        title={isAdmin ? "Сеть и прокси" : `Соединение: ${wsLabel}`}
        aria-label="Сеть и прокси"
      >
        <Icon className="w-4 h-4 md:w-3.5 md:h-3.5" />
      </button>
      {mounted && dropdown ? createPortal(dropdown, document.body) : null}
    </>
  );
}
