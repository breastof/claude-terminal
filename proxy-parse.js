"use strict";
// CJS-копия src/lib/proxy-parse.ts для серверной части (proxy-manager.js).
// При изменении одной — синхронизируй вторую. Отдельные файлы потому что
// серверный node не подключён к Next-сборке и не умеет импортировать .ts.

const HOST_RE = /^[A-Za-z0-9.\-_]+$/;

function parseProxyString(raw) {
  if (!raw || typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;

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

  const parts = s.split(":");
  if (parts.length !== 2 && parts.length !== 4) return null;

  const host = parts[0];
  const port = parseInt(parts[1], 10);
  if (!HOST_RE.test(host)) return null;
  if (!Number.isFinite(port) || port < 1 || port > 65535) return null;

  if (parts.length === 2) {
    return { host, port, login: null, password: null };
  }
  const login = parts[2];
  const password = parts[3];
  if (!login || !password) return null;
  return { host, port, login, password };
}

function serializeProxyUrl(p) {
  const auth =
    p.login && p.password
      ? `${encodeURIComponent(p.login)}:${encodeURIComponent(p.password)}@`
      : "";
  return `http://${auth}${p.host}:${p.port}`;
}

function maskProxyForDisplay(p) {
  const auth = p.login ? `${p.login}:***@` : "";
  return `http://${auth}${p.host}:${p.port}`;
}

module.exports = { parseProxyString, serializeProxyUrl, maskProxyForDisplay };
