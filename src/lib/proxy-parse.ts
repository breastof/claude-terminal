/**
 * Парсер строк формата прокси. Поддерживает три популярных формата:
 *
 *   1. ip:port                          → без авторизации
 *   2. ip:port:login:pass               → с авторизацией (наш основной)
 *   3. http(s)://[login:pass@]host:port → URL (для копи-пасты от провайдеров)
 *
 * Возвращает разобранный объект или null. Никогда не throw — невалидный
 * ввод просто превращается в null, дальше обрабатывает UI.
 */

export interface ParsedProxy {
  host: string;
  port: number;
  login: string | null;
  password: string | null;
}

const HOST_RE = /^[A-Za-z0-9.\-_]+$/;

export function parseProxyString(raw: string): ParsedProxy | null {
  if (!raw || typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;

  // URL-форма
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      if (!u.hostname || !u.port) return null;
      const port = parseInt(u.port, 10);
      if (!Number.isFinite(port) || port < 1 || port > 65535) return null;
      if (!HOST_RE.test(u.hostname)) return null;
      const login = u.username ? decodeURIComponent(u.username) : null;
      const password = u.password ? decodeURIComponent(u.password) : null;
      return { host: u.hostname, port, login, password };
    } catch {
      return null;
    }
  }

  // ip:port или ip:port:login:pass
  const parts = s.split(":");
  if (parts.length !== 2 && parts.length !== 4) return null;

  const host = parts[0];
  const port = parseInt(parts[1], 10);
  if (!HOST_RE.test(host)) return null;
  if (!Number.isFinite(port) || port < 1 || port > 65535) return null;

  if (parts.length === 2) {
    return { host, port, login: null, password: null };
  }
  // length === 4
  const login = parts[2];
  const password = parts[3];
  if (!login || !password) return null;
  return { host, port, login, password };
}

/**
 * Сериализует прокси в строку, подходящую для HTTPS_PROXY / curl --proxy.
 * Login/pass URL-encod'ятся (для @, :, / и подобных в пароле).
 */
export function serializeProxyUrl(p: ParsedProxy): string {
  const auth =
    p.login && p.password
      ? `${encodeURIComponent(p.login)}:${encodeURIComponent(p.password)}@`
      : "";
  return `http://${auth}${p.host}:${p.port}`;
}

/**
 * Безопасное представление для логов и ответов API — пароль маскируется.
 * Логин остаётся (по нему обычно идентифицируют прокси у провайдера).
 */
export function maskProxyForDisplay(p: ParsedProxy): string {
  const auth = p.login ? `${p.login}:***@` : "";
  return `http://${auth}${p.host}:${p.port}`;
}
