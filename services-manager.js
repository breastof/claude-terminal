"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { URL } = require("url");
const { execFile } = require("child_process");
const { discoverVhosts } = require("./nginx-discovery");

const REFRESH_INTERVAL_MS = 15_000;
const HTTP_TIMEOUT_MS = 5_000;
const ACTION_TIMEOUT_MS = 30_000;

// Friendly names for known vhost ids (override DB will eventually replace this).
const KNOWN_NAMES = {
  "claude-terminal": "Claude Terminal",
  "photo.neureca.club": "Photo Studio",
  "deepresearch.neureca.club": "Deep Research",
  "research.neureca.club": "Research",
  "carter30.neureca.club": "Carter-30 (превью)",
  "carter30-1.neureca.club": "Carter-30 (превью v2)",
};

const KNOWN_DESCRIPTIONS = {
  "claude-terminal": "Веб-панель Claude Code",
  "photo.neureca.club": "Mentoring-сайт",
  "deepresearch.neureca.club": "Архив длинных ресерчей",
  "research.neureca.club": "AI-стартапы",
};

function execFileP(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: opts.timeout ?? ACTION_TIMEOUT_MS, encoding: "utf-8", maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          stdout: (stdout || "").toString(),
          stderr: (stderr || "").toString(),
          exitCode: error ? (error.code ?? 1) : 0,
        });
      }
    );
  });
}

function probeHttp(svc, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    if (!svc.url) {
      return resolve({ ok: false, code: null, ms: 0, error: "no_url" });
    }
    let parsedUrl;
    try {
      parsedUrl = new URL(svc.url);
    } catch {
      return resolve({ ok: false, code: null, ms: 0, error: "invalid_url" });
    }

    const useLocalProbe = svc.kind === "static" && svc.domain;
    const lib = useLocalProbe ? http : parsedUrl.protocol === "https:" ? https : http;
    const opts = {
      method: "GET",
      timeout: timeoutMs,
      headers: { "User-Agent": "claude-terminal-services" },
    };

    if (useLocalProbe) {
      opts.host = "127.0.0.1";
      opts.port = 80;
      opts.path = parsedUrl.pathname || "/";
      opts.headers.Host = svc.domain;
    } else {
      opts.host = parsedUrl.hostname;
      opts.port = parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80);
      opts.path = (parsedUrl.pathname || "/") + (parsedUrl.search || "");
      opts.headers.Host = parsedUrl.host;
    }

    const req = lib.request(opts, (res) => {
      const ms = Date.now() - start;
      const code = res.statusCode || 0;
      const ok =
        (code >= 200 && code < 400) ||
        (svc.acceptUnauthorized && code === 401);
      res.resume();
      resolve({ ok, code, ms });
    });

    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", (err) => {
      resolve({ ok: false, code: null, ms: Date.now() - start, error: String(err.message || err) });
    });
    req.end();
  });
}

function vhostToService(v) {
  const isStatic = v.kind === "static";
  const isSystemd = v.kind === "systemd" && v.systemdUnit;
  // Public-facing url (for the "Open" link in UI).
  const publicUrl = v.domain
    ? (v.hasSsl ? `https://${v.domain}/` : `http://${v.domain}/`)
    : null;
  // Local probe url — bypasses external DNS/firewall hairpinning.
  // For systemd-backed vhosts: hit the upstream port directly.
  // For static vhosts: hit 127.0.0.1:80 with Host header (handled in probeHttp).
  let probeUrl = null;
  if (v.proxyPass) {
    probeUrl = v.proxyPass; // already http://127.0.0.1:PORT
  } else if (publicUrl) {
    probeUrl = publicUrl; // probeHttp will rewrite to 127.0.0.1 + Host header for static
  }

  const allowedActions = ["enable", "disable"];
  if (isSystemd) {
    allowedActions.push("restart", "logs");
  }

  return {
    id: v.id,
    name: KNOWN_NAMES[v.id] || v.domain || v.id,
    kind: isStatic ? "static" : "systemd",
    unit: v.systemdUnit || null,
    staticPath: v.root,
    url: probeUrl,
    publicUrl,
    domain: v.domain,
    description: KNOWN_DESCRIPTIONS[v.id] || null,
    acceptUnauthorized: true,
    enabled: v.enabled,
    vhostPath: v.vhostPath,
    allowedActions,
    isPseudo: false,
  };
}

function pseudoNginx() {
  return {
    id: "nginx",
    name: "Nginx",
    kind: "systemd",
    unit: "nginx.service",
    url: null,
    domain: null,
    description: "Reverse proxy",
    enabled: true,
    vhostPath: null,
    allowedActions: ["reload", "test", "logs"],
    isPseudo: true,
  };
}

class ServicesManager {
  constructor() {
    this.cache = new Map();
    this.servicesCache = []; // last discovered services, refreshed on each tick
    this.timer = null;
    this.refreshing = false;
  }

  _emptyStatus(id) {
    return {
      id,
      systemd: null,
      subState: null,
      mainPid: null,
      activeSince: null,
      http: null,
      staticOk: null,
      staticMtime: null,
      lastCheck: null,
    };
  }

  start() {
    if (this.timer) return;
    this.refreshAll().catch(() => {});
    this.timer = setInterval(() => {
      this.refreshAll().catch(() => {});
    }, REFRESH_INTERVAL_MS);
  }

  destroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Discover services fresh from filesystem each call (cheap). */
  getServices() {
    const vhosts = discoverVhosts();
    const services = vhosts.map(vhostToService);
    services.push(pseudoNginx());
    this.servicesCache = services;
    return services;
  }

  getService(id) {
    const all = this.servicesCache.length ? this.servicesCache : this.getServices();
    return all.find((s) => s.id === id);
  }

  isActionAllowed(id, action) {
    const svc = this.getService(id);
    if (!svc) return false;
    return svc.allowedActions.includes(action);
  }

  getSnapshot() {
    const services = this.getServices();
    return services.map((svc) => {
      const status = this.cache.get(svc.id) || this._emptyStatus(svc.id);
      return {
        id: svc.id,
        name: svc.name,
        kind: svc.kind,
        domain: svc.domain || null,
        url: svc.publicUrl || svc.url || null, // UI shows public URL for "Open" links
        description: svc.description || null,
        enabled: svc.enabled,
        allowedActions: svc.allowedActions,
        status,
      };
    });
  }

  async refreshAll() {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const services = this.getServices();
      // Drop stale cache entries
      const validIds = new Set(services.map((s) => s.id));
      for (const id of this.cache.keys()) {
        if (!validIds.has(id)) this.cache.delete(id);
      }
      await Promise.all(services.map((svc) => this._refreshOne(svc).catch(() => {})));
    } finally {
      this.refreshing = false;
    }
  }

  async refreshOne(id) {
    const svc = this.getService(id);
    if (!svc) return null;
    await this._refreshOne(svc);
    return this.cache.get(id);
  }

  async _refreshOne(svc) {
    const status = this._emptyStatus(svc.id);
    status.lastCheck = new Date().toISOString();

    if (svc.kind === "systemd" && svc.unit) {
      const show = await execFileP(
        "/bin/systemctl",
        ["show", svc.unit, "-p", "ActiveState", "-p", "SubState", "-p", "MainPID", "-p", "ActiveEnterTimestamp"],
        { timeout: 5000 }
      );
      const props = {};
      for (const line of show.stdout.split("\n")) {
        const eq = line.indexOf("=");
        if (eq === -1) continue;
        props[line.slice(0, eq)] = line.slice(eq + 1).trim();
      }
      status.systemd = props.ActiveState || "unknown";
      status.subState = props.SubState || null;
      const pid = parseInt(props.MainPID || "", 10);
      status.mainPid = Number.isFinite(pid) && pid > 0 ? pid : null;
      status.activeSince = props.ActiveEnterTimestamp || null;
    }

    if (svc.kind === "static" && svc.staticPath) {
      try {
        const st = fs.statSync(svc.staticPath);
        status.staticOk = st.isDirectory();
        const indexPath = path.join(svc.staticPath, "index.html");
        if (fs.existsSync(indexPath)) {
          status.staticMtime = fs.statSync(indexPath).mtime.toISOString();
        } else {
          status.staticMtime = st.mtime.toISOString();
        }
      } catch {
        status.staticOk = false;
      }
    }

    // Skip HTTP probe for disabled vhosts (they don't respond) and for pseudo nginx (no url)
    if (svc.url && svc.enabled) {
      const r = await probeHttp(svc, HTTP_TIMEOUT_MS);
      status.http = r;
    }

    this.cache.set(svc.id, status);
  }

  /**
   * Run a whitelisted action. Commands are built from templates here — no user
   * input ever reaches the shell.
   */
  async runAction(id, action) {
    const svc = this.getService(id);
    if (!svc) return { ok: false, error: "unknown_service" };
    if (!svc.allowedActions.includes(action)) {
      return { ok: false, error: "action_not_allowed" };
    }

    let result;
    if (action === "restart" && svc.unit) {
      result = await execFileP("/usr/bin/sudo", ["-n", "/bin/systemctl", "restart", svc.unit]);
    } else if (action === "reload" && svc.unit) {
      result = await execFileP("/usr/bin/sudo", ["-n", "/bin/systemctl", "reload", svc.unit]);
    } else if (action === "test" && svc.id === "nginx") {
      result = await execFileP("/usr/bin/sudo", ["-n", "/usr/sbin/nginx", "-t"]);
    } else if (action === "logs" && svc.unit) {
      const r = await this.getLogs(id, 200);
      return { ok: r.ok, stdout: (r.lines || []).join("\n"), stderr: r.error || "", exitCode: r.ok ? 0 : 1 };
    } else if (action === "enable" && svc.vhostPath) {
      result = await this._enableVhost(svc);
    } else if (action === "disable" && svc.vhostPath) {
      result = await this._disableVhost(svc);
    } else {
      return { ok: false, error: "unsupported" };
    }

    // Refresh cache after action
    this._refreshOne(svc).catch(() => {});
    return result;
  }

  async _enableVhost(svc) {
    const target = `/etc/nginx/sites-enabled/${svc.id}`;
    // 1. Create symlink (force-overwrite if dangling). Whitelisted via sudoers.
    const link = await execFileP("/usr/bin/sudo", ["-n", "/bin/ln", "-sf", svc.vhostPath, target]);
    if (!link.ok) return link;
    // 2. Test config
    const test = await execFileP("/usr/bin/sudo", ["-n", "/usr/sbin/nginx", "-t"]);
    if (!test.ok) {
      // Roll back: delete the just-created symlink
      await execFileP("/usr/bin/sudo", ["-n", "/bin/rm", "-f", target]);
      return {
        ok: false,
        stdout: test.stdout,
        stderr: `nginx config test failed — rolled back: ${test.stderr}`,
        exitCode: test.exitCode,
      };
    }
    // 3. Reload nginx
    const reload = await execFileP("/usr/bin/sudo", ["-n", "/bin/systemctl", "reload", "nginx.service"]);
    return reload;
  }

  async _disableVhost(svc) {
    const target = `/etc/nginx/sites-enabled/${svc.id}`;
    const rm = await execFileP("/usr/bin/sudo", ["-n", "/bin/rm", "-f", target]);
    if (!rm.ok) return rm;
    const reload = await execFileP("/usr/bin/sudo", ["-n", "/bin/systemctl", "reload", "nginx.service"]);
    return reload;
  }

  /** Tail journalctl for a systemd service. */
  async getLogs(id, lines = 200) {
    const svc = this.getService(id);
    if (!svc || !svc.unit) {
      return { ok: false, lines: [], error: "no_logs_for_service" };
    }
    const safeLines = Math.max(10, Math.min(2000, parseInt(String(lines), 10) || 200));
    const r = await execFileP(
      "/usr/bin/sudo",
      ["-n", "/bin/journalctl", "-u", svc.unit, "-n", String(safeLines), "--no-pager", "--output=short-iso"],
      { timeout: 10_000 }
    );
    if (!r.ok) {
      return { ok: false, lines: [], error: (r.stderr || "").trim() || "journalctl_failed" };
    }
    return { ok: true, lines: r.stdout.split("\n").filter((l) => l.length > 0) };
  }
}

module.exports = { ServicesManager };
