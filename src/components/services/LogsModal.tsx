"use client";

import { useEffect, useState, useCallback } from "react";
import { X, RefreshCw } from "@/components/Icons";

interface LogsModalProps {
  serviceId: string;
  serviceName: string;
  onClose: () => void;
}

export default function LogsModal({ serviceId, serviceName, onClose }: LogsModalProps) {
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/services/${serviceId}/logs?lines=300`);
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "request_failed");
        setLines([]);
      } else if (!data.ok) {
        setError(data.error || "logs_failed");
        setLines([]);
      } else {
        setLines(data.lines || []);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [serviceId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="w-full max-w-4xl max-h-[80vh] flex flex-col rounded-xl border border-border bg-surface shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-12 flex items-center justify-between px-4 border-b border-border">
          <div className="text-sm font-medium text-foreground">
            Логи · <span className="text-muted-fg">{serviceName}</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={load}
              disabled={loading}
              className="p-1.5 text-muted-fg hover:text-foreground transition-colors cursor-pointer disabled:opacity-50"
              title="Обновить"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            </button>
            <button
              onClick={onClose}
              className="p-1.5 text-muted-fg hover:text-foreground transition-colors cursor-pointer"
              title="Закрыть"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto bg-black/40 font-mono text-[11px] leading-relaxed text-foreground/90 p-3 whitespace-pre">
          {loading && lines.length === 0 ? (
            <div className="text-muted-fg">Загрузка…</div>
          ) : error ? (
            <div className="text-danger">
              Не удалось загрузить логи: {error === "journalctl_failed" || error.includes("password is required")
                ? "нужны права sudo (см. инструкцию по /etc/sudoers.d/claude-terminal-ops)"
                : error}
            </div>
          ) : lines.length === 0 ? (
            <div className="text-muted-fg">Логов нет</div>
          ) : (
            lines.join("\n")
          )}
        </div>

        <div className="h-8 px-4 flex items-center text-[10px] text-muted border-t border-border">
          {lines.length} строк · системный журнал
        </div>
      </div>
    </div>
  );
}
