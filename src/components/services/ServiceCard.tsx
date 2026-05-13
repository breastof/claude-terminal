"use client";

import { useState } from "react";
import {
  RefreshCw,
  Play,
  Pause,
  CheckCircle,
  AlertTriangle,
  FileIcon,
  ServerPulse,
  Server,
} from "@/components/Icons";
import {
  type ServiceSnapshot,
  type ServiceAction,
  type ActionResult,
  statusColor,
  statusLabel,
  kindLabel,
} from "@/lib/services";

interface ServiceCardProps {
  service: ServiceSnapshot;
  onShowLogs: (id: string, name: string) => void;
  onActionDone: () => void;
}

const DOT_CLASS: Record<ReturnType<typeof statusColor>, string> = {
  emerald: "bg-success",
  amber: "bg-warning",
  red: "bg-danger",
  zinc: "bg-muted-fg/40",
};

const ERROR_TRANSLATIONS: Record<string, string> = {
  unknown_service: "сервис не найден",
  action_not_allowed: "действие не разрешено для этого сервиса",
  invalid_action: "неизвестное действие",
  invalid_json: "ошибка запроса",
  manager_not_initialized: "менеджер сервисов не запущен",
  unsupported: "действие не поддерживается",
  no_logs_for_service: "у этого сервиса нет логов",
  journalctl_failed: "не удалось получить логи (нужны права sudo)",
};

function translateError(raw: string): string {
  if (ERROR_TRANSLATIONS[raw]) return ERROR_TRANSLATIONS[raw];
  if (raw.includes("a password is required") || raw.includes("sudo:")) {
    return "Не настроены права sudo. Добавь /etc/sudoers.d/claude-terminal-ops";
  }
  return raw;
}

function formatActiveSince(iso: string | null): string | null {
  if (!iso) return null;
  // systemd ActiveEnterTimestamp format: "Mon 2026-04-30 12:00:00 UTC"
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  const diff = Date.now() - parsed.getTime();
  if (diff < 0) return "—";
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

export default function ServiceCard({ service, onShowLogs, onActionDone }: ServiceCardProps) {
  const [busy, setBusy] = useState<ServiceAction | null>(null);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  const color = statusColor(service);
  const label = statusLabel(service);

  const runAction = async (action: ServiceAction) => {
    setBusy(action);
    setFeedback(null);
    try {
      const res = await fetch(`/api/services/${service.id}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data: ActionResult = await res.json();
      if (data.scheduled) {
        setFeedback({ ok: true, text: "Запланировано — сервис перезапустит сам себя" });
      } else if (data.ok) {
        const out = (data.stdout || "").trim() || (data.stderr || "").trim() || "Готово";
        setFeedback({ ok: true, text: out.split("\n").slice(-3).join(" · ") });
      } else {
        const err = (data.error || data.stderr || data.stdout || "ошибка").trim();
        setFeedback({ ok: false, text: translateError(err) });
      }
    } catch (e) {
      setFeedback({ ok: false, text: String(e) });
    } finally {
      setBusy(null);
      onActionDone();
      setTimeout(() => setFeedback(null), 6000);
    }
  };

  const has = (a: ServiceAction) => service.allowedActions.includes(a);
  const since = formatActiveSince(service.status.activeSince);
  const isDisabled = service.enabled === false;

  return (
    <div
      className={`p-4 rounded-xl border flex flex-col gap-3 ${
        isDisabled
          ? "bg-surface/40 border-border/50 opacity-75"
          : "bg-surface border-border"
      }`}
    >
      <div className="flex items-start gap-3">
        <span className={`mt-1.5 w-2.5 h-2.5 rounded-full flex-shrink-0 ${DOT_CLASS[color]}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-sm font-medium truncate ${isDisabled ? "text-muted-fg" : "text-foreground"}`}>
              {service.name}
            </span>
            <span className="text-[10px] uppercase tracking-wider text-muted-fg/70 px-1.5 py-0.5 rounded bg-surface-hover">
              {kindLabel(service.kind)}
            </span>
            {isDisabled && (
              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-zinc-500/15 text-zinc-400">
                выключен
              </span>
            )}
          </div>
          {service.domain && (
            <a
              href={service.url || `https://${service.domain}`}
              target="_blank"
              rel="noreferrer"
              className="text-[11px] text-muted-fg hover:text-accent-fg truncate block"
            >
              {service.domain}
            </a>
          )}
          {service.description && (
            <div className="text-[11px] text-muted/80 mt-0.5 truncate">{service.description}</div>
          )}
        </div>
        {service.kind === "systemd" ? (
          <ServerPulse className="w-4 h-4 text-muted-fg/60 flex-shrink-0" />
        ) : (
          <Server className="w-4 h-4 text-muted-fg/60 flex-shrink-0" />
        )}
      </div>

      <div className="flex items-center gap-1.5 flex-wrap text-[11px]">
        <span
          className={`px-1.5 py-0.5 rounded font-mono ${
            color === "emerald"
              ? "bg-success/15 text-success"
              : color === "amber"
              ? "bg-warning/15 text-warning"
              : color === "red"
              ? "bg-danger/15 text-danger"
              : "bg-surface-hover text-muted-fg"
          }`}
        >
          {label}
        </span>
        {service.status.http && (
          <span
            className={`px-1.5 py-0.5 rounded font-mono ${
              service.status.http.ok ? "bg-success/15 text-success" : "bg-danger/15 text-danger"
            }`}
          >
            HTTP {service.status.http.code ?? "—"}
            {typeof service.status.http.ms === "number" ? ` · ${service.status.http.ms}ms` : ""}
          </span>
        )}
        {since && (
          <span className="px-1.5 py-0.5 rounded bg-surface-hover text-muted-fg font-mono">{since}</span>
        )}
        {service.status.mainPid && (
          <span className="text-muted-fg/60 font-mono">PID {service.status.mainPid}</span>
        )}
      </div>

      {(has("restart") || has("reload") || has("test") || has("logs") || has("enable") || has("disable")) && (
        <div className="flex items-center gap-2 flex-wrap">
          {has("enable") && isDisabled && (
            <button
              onClick={() => runAction("enable")}
              disabled={busy !== null}
              className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded bg-success/15 text-success hover:bg-success/25 cursor-pointer disabled:opacity-50"
              title="Активировать в nginx (создать симлинк + reload)"
            >
              {busy === "enable" ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
              Включить
            </button>
          )}
          {has("disable") && !isDisabled && (
            <button
              onClick={() => runAction("disable")}
              disabled={busy !== null}
              className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded bg-surface-hover text-muted-fg hover:bg-danger/15 hover:text-danger cursor-pointer disabled:opacity-50"
              title="Убрать из nginx (файлы остаются)"
            >
              {busy === "disable" ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Pause className="w-3 h-3" />}
              Выключить
            </button>
          )}
          {has("restart") && !isDisabled && (
            <button
              onClick={() => runAction("restart")}
              disabled={busy !== null}
              className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded bg-accent-muted text-accent-fg hover:opacity-80 cursor-pointer disabled:opacity-50"
              title="Полный перезапуск сервиса"
            >
              {busy === "restart" ? (
                <RefreshCw className="w-3 h-3 animate-spin" />
              ) : (
                <RefreshCw className="w-3 h-3" />
              )}
              Перезапустить
            </button>
          )}
          {has("reload") && !isDisabled && (
            <button
              onClick={() => runAction("reload")}
              disabled={busy !== null}
              className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded bg-accent-muted text-accent-fg hover:opacity-80 cursor-pointer disabled:opacity-50"
              title="Перечитать конфиг без перезапуска"
            >
              {busy === "reload" ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
              Перезагрузить
            </button>
          )}
          {has("test") && !isDisabled && (
            <button
              onClick={() => runAction("test")}
              disabled={busy !== null}
              className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded bg-surface-hover text-foreground hover:bg-surface cursor-pointer disabled:opacity-50"
              title="Проверить синтаксис nginx.conf"
            >
              {busy === "test" ? <RefreshCw className="w-3 h-3 animate-spin" /> : <CheckCircle className="w-3 h-3" />}
              Проверить конфиг
            </button>
          )}
          {has("logs") && !isDisabled && (
            <button
              onClick={() => onShowLogs(service.id, service.name)}
              disabled={busy !== null}
              className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded bg-surface-hover text-foreground hover:bg-surface cursor-pointer disabled:opacity-50"
              title="Последние записи системного журнала"
            >
              <FileIcon className="w-3 h-3" />
              Логи
            </button>
          )}
        </div>
      )}

      {feedback && (
        <div
          className={`flex items-start gap-1.5 text-[11px] p-2 rounded font-mono break-words ${
            feedback.ok ? "bg-success/10 text-success" : "bg-danger/10 text-danger"
          }`}
        >
          {feedback.ok ? (
            <CheckCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />
          ) : (
            <AlertTriangle className="w-3 h-3 mt-0.5 flex-shrink-0" />
          )}
          <span className="whitespace-pre-wrap">{feedback.text}</span>
        </div>
      )}
    </div>
  );
}
