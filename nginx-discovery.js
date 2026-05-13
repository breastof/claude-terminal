"use strict";

/**
 * Lightweight nginx vhost discovery.
 *
 * Scans /etc/nginx/sites-available, parses each file for server_name / root /
 * proxy_pass / listen directives. Returns one entry per vhost file, with the
 * `enabled` flag computed by checking presence of a symlink in sites-enabled.
 *
 * Doesn't aim to be a full nginx parser — strips comments and runs regexes
 * across the whole file. This is fine because vhost configs in our setup are
 * single-domain and homogeneous.
 */

const fs = require("fs");
const path = require("path");

const SITES_AVAILABLE = "/etc/nginx/sites-available";
const SITES_ENABLED = "/etc/nginx/sites-enabled";

const SKIP_FILES = new Set(["default"]);
const SKIP_PATTERNS = [/\.bak/i, /\.template$/i, /\.disabled$/i, /~$/, /\.swp$/];

function stripComments(text) {
  return text.replace(/#[^\n]*/g, "");
}

function findAll(text, directive) {
  const re = new RegExp(`(^|\\s)${directive}\\s+([^;{]+);`, "g");
  const out = [];
  let m;
  while ((m = re.exec(text))) {
    out.push(m[2].trim());
  }
  return out;
}

function pickServerName(names) {
  // server_name "neureca.club www.neureca.club" → ["neureca.club", "www.neureca.club"]
  const flat = names
    .flatMap((n) => n.split(/\s+/))
    .map((n) => n.trim())
    .filter((n) => n && n !== "_");
  return flat[0] || null;
}

function pickRoot(roots) {
  return roots.length > 0 ? roots[0].split(/\s+/)[0].replace(/;$/, "") : null;
}

function pickProxyPass(passes) {
  return passes.length > 0 ? passes[0].split(/\s+/)[0].replace(/;$/, "") : null;
}

function hasSslListen(listens) {
  return listens.some((l) => /\bssl\b/i.test(l) || /\b443\b/.test(l));
}

function extractPort(proxyPass) {
  if (!proxyPass) return null;
  try {
    const url = new URL(proxyPass);
    if (url.port) return parseInt(url.port, 10);
    return url.protocol === "https:" ? 443 : 80;
  } catch {
    const m = proxyPass.match(/:(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }
}

function parseVhost(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
  const stripped = stripComments(raw);

  const serverNames = findAll(stripped, "server_name");
  const roots = findAll(stripped, "root");
  const proxyPasses = findAll(stripped, "proxy_pass");
  const listens = findAll(stripped, "listen");

  const domain = pickServerName(serverNames);
  if (!domain) return null;

  const root = pickRoot(roots);
  const proxyPass = pickProxyPass(proxyPasses);
  const port = extractPort(proxyPass);

  let kind;
  if (proxyPass) kind = "systemd";
  else if (root) kind = "static";
  else kind = "unknown";

  return {
    domain,
    root,
    proxyPass,
    port,
    kind,
    hasSsl: hasSslListen(listens),
    vhostPath: filePath,
  };
}

/**
 * Build a port → systemd unit map by inspecting `ss -tlnp`.
 * Output of `ss -tlnp`:
 *   LISTEN 0 511 127.0.0.1:3000  0.0.0.0:* users:(("node",pid=2029784,fd=41))
 * We pull the port and the PID, then resolve PID → unit via /proc/<pid>/cgroup
 * (cgroup v2 path contains the unit name like .../system.slice/foo.service).
 */
function buildPortUnitMap() {
  const { execSync } = require("child_process");
  const map = new Map();
  let out;
  try {
    out = execSync("ss -tlnp 2>/dev/null", { encoding: "utf-8" });
  } catch {
    return map;
  }
  for (const line of out.split("\n")) {
    if (!line.startsWith("LISTEN")) continue;
    const portMatch = line.match(/[:.](\d+)\s+/);
    if (!portMatch) continue;
    const port = parseInt(portMatch[1], 10);
    const pidMatch = line.match(/pid=(\d+)/);
    if (!pidMatch) continue;
    const pid = pidMatch[1];

    let unit = null;
    try {
      const cg = fs.readFileSync(`/proc/${pid}/cgroup`, "utf-8");
      const um = cg.match(/([\w-]+\.service)/);
      if (um) unit = um[1];
    } catch {}

    if (unit && !map.has(port)) {
      map.set(port, unit);
    }
  }
  return map;
}

function listEnabledSet() {
  const set = new Set();
  let entries;
  try {
    entries = fs.readdirSync(SITES_ENABLED, { withFileTypes: true });
  } catch {
    return set;
  }
  for (const ent of entries) {
    set.add(ent.name);
  }
  return set;
}

/**
 * Main: returns an array of vhost objects.
 *   { id, domain, kind, enabled, vhostPath, port, systemdUnit, root, proxyPass, hasSsl }
 */
function discoverVhosts() {
  let entries;
  try {
    entries = fs.readdirSync(SITES_AVAILABLE);
  } catch {
    return [];
  }

  const enabledSet = listEnabledSet();
  const portMap = buildPortUnitMap();
  const out = [];

  for (const file of entries) {
    if (SKIP_FILES.has(file)) continue;
    if (SKIP_PATTERNS.some((p) => p.test(file))) continue;

    const vhostPath = path.join(SITES_AVAILABLE, file);
    let stat;
    try {
      stat = fs.statSync(vhostPath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    const parsed = parseVhost(vhostPath);
    if (!parsed) continue;

    const systemdUnit = parsed.port && portMap.get(parsed.port) ? portMap.get(parsed.port) : null;
    // If proxyPass and we found a unit by port → really kind=systemd. Otherwise still proxy without unit ("unknown systemd").
    out.push({
      id: file, // vhost filename = stable id
      domain: parsed.domain,
      kind: parsed.kind,
      enabled: enabledSet.has(file),
      vhostPath,
      port: parsed.port,
      systemdUnit,
      root: parsed.root,
      proxyPass: parsed.proxyPass,
      hasSsl: parsed.hasSsl,
    });
  }

  return out;
}

module.exports = { discoverVhosts, parseVhost, buildPortUnitMap };
