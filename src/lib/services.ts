export type ServiceKind = "systemd" | "static";
export type ServiceAction = "restart" | "reload" | "test" | "logs" | "backup" | "enable" | "disable";

export type SystemdState =
  | "active"
  | "inactive"
  | "failed"
  | "activating"
  | "deactivating"
  | "unknown"
  | null;

export interface ServiceStatus {
  id: string;
  systemd: SystemdState;
  subState: string | null;
  mainPid: number | null;
  activeSince: string | null;
  http: { ok: boolean; code: number | null; ms: number | null; error?: string } | null;
  staticOk: boolean | null;
  staticMtime: string | null;
  lastCheck: string | null;
}

export interface ServiceSnapshot {
  id: string;
  name: string;
  kind: ServiceKind;
  domain: string | null;
  url: string | null;
  description: string | null;
  enabled: boolean;
  allowedActions: readonly ServiceAction[];
  status: ServiceStatus;
}

export interface ServicesResponse {
  services: ServiceSnapshot[];
}

export interface ActionResult {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  scheduled?: boolean;
  error?: string;
}

export type StatusColor = "emerald" | "amber" | "red" | "zinc";

export function statusColor(svc: ServiceSnapshot): StatusColor {
  // Disabled vhosts: zinc (off, but intentional)
  if (svc.enabled === false) return "zinc";
  const { kind } = svc;
  const { systemd, http, staticOk } = svc.status;
  if (kind === "systemd") {
    if (systemd === "active" && (http === null || http.ok)) return "emerald";
    if (systemd === "active" && http && !http.ok) return "amber";
    if (systemd === "failed" || systemd === "inactive") return "red";
    if (systemd === "activating" || systemd === "deactivating") return "amber";
    return "zinc";
  }
  if (kind === "static") {
    if (staticOk && http?.ok) return "emerald";
    if (staticOk && http && !http.ok) return "amber";
    if (staticOk === false) return "red";
    return "zinc";
  }
  return "zinc";
}

const SYSTEMD_LABELS: Record<string, string> = {
  active: "работает",
  inactive: "остановлен",
  failed: "упал",
  activating: "запускается",
  deactivating: "останавливается",
  unknown: "неизвестно",
};

export function statusLabel(svc: ServiceSnapshot): string {
  if (svc.enabled === false) return "выключен";
  if (svc.kind === "systemd") {
    const s = svc.status.systemd;
    if (!s) return "неизвестно";
    return SYSTEMD_LABELS[s] || s;
  }
  if (svc.kind === "static") {
    if (svc.status.staticOk === true) return "опубликован";
    if (svc.status.staticOk === false) return "не найден";
    return "неизвестно";
  }
  return "неизвестно";
}

export function kindLabel(kind: ServiceKind): string {
  if (kind === "systemd") return "сервис";
  if (kind === "static") return "сайт";
  return kind;
}
