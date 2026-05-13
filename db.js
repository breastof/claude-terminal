const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");

const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, "claude-terminal.db");
const db = new Database(DB_PATH);

// WAL mode for better concurrent read performance
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("cache_size = -64000");       // 64 MB memory cache
db.pragma("temp_store = MEMORY");
db.pragma("mmap_size = 30000000");      // 30 MB memory-mapped reads
db.pragma("wal_autocheckpoint = 1000");
db.pragma("foreign_keys = ON");

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    login TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin', 'user', 'guest')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
    color_index INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL,
    file_path TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS cli_providers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    command TEXT NOT NULL,
    resume_command TEXT DEFAULT NULL,
    icon TEXT NOT NULL DEFAULT 'terminal',
    color TEXT NOT NULL DEFAULT '#8b5cf6',
    sort_order INTEGER NOT NULL DEFAULT 100,
    is_builtin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Прокси для AI-инструментов (Claude CLI, Anthropic SDK).
  -- Активные роли primary/fallback пишутся в ~/.config/ai-proxy.env
  -- скриптом ai-proxy-pick (он же дёргает HTTPS_PROXY/HTTP_PROXY).
  -- Один прокси может быть и primary, и fallback одновременно (= нет резерва).
  CREATE TABLE IF NOT EXISTS proxies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    login TEXT DEFAULT NULL,
    password TEXT DEFAULT NULL,
    is_primary INTEGER NOT NULL DEFAULT 0,
    is_fallback INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_proxies_primary ON proxies(is_primary) WHERE is_primary = 1;
  CREATE INDEX IF NOT EXISTS idx_proxies_fallback ON proxies(is_fallback) WHERE is_fallback = 1;

  CREATE TABLE IF NOT EXISTS symphony_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    external_id TEXT DEFAULT NULL,
    source TEXT DEFAULT NULL,
    title TEXT NOT NULL,
    description TEXT DEFAULT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'active', 'proof', 'done', 'cancelled')),
    priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low', 'medium', 'high', 'critical')),
    session_id TEXT DEFAULT NULL,
    workflow TEXT DEFAULT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS symphony_proof (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    title TEXT DEFAULT NULL,
    path TEXT DEFAULT NULL,
    url TEXT DEFAULT NULL,
    metadata TEXT DEFAULT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (task_id) REFERENCES symphony_tasks(id) ON DELETE CASCADE
  );
`);

// Add reply threading support (idempotent)
try {
  db.exec("ALTER TABLE messages ADD COLUMN reply_to_id INTEGER REFERENCES messages(id) ON DELETE SET NULL");
} catch {}

// Seed admin user from env vars on first run
function seedAdmin() {
  const login = process.env.LOGIN_USERNAME;
  const passwordHash = process.env.PASSWORD_HASH;

  if (!login || !passwordHash) {
    console.log("[db] LOGIN_USERNAME or PASSWORD_HASH not set, skipping admin seed");
    return;
  }

  const existing = db.prepare("SELECT id FROM users WHERE login = ?").get(login);
  if (existing) {
    return;
  }

  // Assign color_index 0 to admin
  db.prepare(
    `INSERT INTO users (login, password_hash, first_name, last_name, role, status, color_index)
     VALUES (?, ?, ?, '', 'admin', 'approved', 0)`
  ).run(login, passwordHash, "Admin");

  console.log(`[db] Admin user "${login}" seeded`);
}

seedAdmin();

// Auto-detect Claude CLI path
function findClaude() {
  try {
    return execSync("which claude", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return "/usr/bin/claude";
  }
}

// Seed built-in CLI providers
function seedProviders() {
  const claudePath = findClaude();
  const builtins = [
    { slug: "terminal", name: "Terminal", command: "/bin/bash", resume_command: null, icon: "terminal", color: "#52525b", sort_order: 1 },
    { slug: "claude", name: "Claude", command: claudePath, resume_command: `${claudePath} --continue`, icon: "claude", color: "#d4a574", sort_order: 2 },
  ];

  const insert = db.prepare(
    `INSERT OR IGNORE INTO cli_providers (slug, name, command, resume_command, icon, color, sort_order, is_builtin)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
  );

  for (const p of builtins) {
    insert.run(p.slug, p.name, p.command, p.resume_command, p.icon, p.color, p.sort_order);
  }
}

seedProviders();

// Add reply threading support (idempotent)
try {
  db.exec("ALTER TABLE messages ADD COLUMN reply_to_id INTEGER REFERENCES messages(id) ON DELETE SET NULL");
} catch {}

// Symphony schema — all sym_* tables, indexes, seed data
const { runSymphonyMigrations } = require("./symphony-db-migrations");
runSymphonyMigrations(db);

module.exports = db;
