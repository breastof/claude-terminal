"use strict";

/**
 * Symphony DB Migrations — all sym_* tables, indexes, seed data.
 * Called from db.js after base tables are created.
 */

function runSymphonyMigrations(db) {
  // ── Tables ──

  db.exec(`
    CREATE TABLE IF NOT EXISTS sym_projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      repo_path TEXT DEFAULT NULL,
      default_branch TEXT DEFAULT 'main',
      config TEXT DEFAULT '{}',
      hooks TEXT DEFAULT '{}',
      max_agents INTEGER DEFAULT 5,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived','paused')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sym_agent_roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT 'sonnet' CHECK(model IN ('opus','sonnet','haiku')),
      max_budget_usd REAL DEFAULT 5.0,
      system_prompt TEXT NOT NULL DEFAULT '',
      workflow TEXT NOT NULL DEFAULT '{}',
      allowed_tools TEXT DEFAULT NULL,
      disallowed_tools TEXT DEFAULT NULL,
      color TEXT NOT NULL DEFAULT '#6366f1',
      icon TEXT NOT NULL DEFAULT 'bot',
      max_concurrent INTEGER DEFAULT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sym_sprints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      goal TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'planning' CHECK(status IN ('planning','active','review','completed')),
      start_date TEXT DEFAULT NULL,
      end_date TEXT DEFAULT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES sym_projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sym_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      parent_id INTEGER DEFAULT NULL,
      type TEXT NOT NULL DEFAULT 'task' CHECK(type IN ('epic','story','task','subtask')),
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'backlog' CHECK(status IN ('backlog','analysis','design','development','code_review','qa','uat','done','cancelled','pending_cancel','failed')),
      status TEXT NOT NULL DEFAULT 'backlog' CHECK(status IN ('backlog','analysis','design','development','code_review','qa','uat','done','cancelled','pending_cancel')),
      priority INTEGER NOT NULL DEFAULT 50,
      assigned_role TEXT DEFAULT NULL,
      estimated_effort TEXT DEFAULT NULL CHECK(estimated_effort IN ('xs','s','m','l','xl',NULL)),
      tags TEXT DEFAULT '[]',
      sprint_id INTEGER DEFAULT NULL,
      session_id TEXT DEFAULT NULL,
      claude_session_id TEXT DEFAULT NULL,
      branch_name TEXT DEFAULT NULL,
      workspace_path TEXT DEFAULT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      attempt INTEGER NOT NULL DEFAULT 0,
      last_activity_at TEXT DEFAULT NULL,
      error_log TEXT DEFAULT NULL,
      metadata TEXT DEFAULT '{}',
      needs_human_review INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES sym_projects(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_id) REFERENCES sym_tasks(id) ON DELETE SET NULL,
      FOREIGN KEY (sprint_id) REFERENCES sym_sprints(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS sym_task_deps (
      blocker_id INTEGER NOT NULL,
      blocked_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (blocker_id, blocked_id),
      FOREIGN KEY (blocker_id) REFERENCES sym_tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (blocked_id) REFERENCES sym_tasks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sym_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      author_role TEXT DEFAULT NULL,
      author_user_id INTEGER DEFAULT NULL,
      content TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'comment' CHECK(type IN ('comment','status_change','assignment','review','approval','rejection','system','handoff')),
      mention_role TEXT DEFAULT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (task_id) REFERENCES sym_tasks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sym_chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      project_id INTEGER DEFAULT NULL,
      author_role TEXT DEFAULT NULL,
      author_user_id INTEGER DEFAULT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES sym_projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sym_artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('prd','spec','design','code','test','review','screenshot','research','bug','other')),
      title TEXT NOT NULL DEFAULT '',
      file_path TEXT DEFAULT NULL,
      content TEXT DEFAULT NULL,
      url TEXT DEFAULT NULL,
      created_by_role TEXT DEFAULT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (task_id) REFERENCES sym_tasks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sym_agent_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      role_slug TEXT NOT NULL,
      pid INTEGER DEFAULT NULL,
      claude_session_id TEXT DEFAULT NULL,
      status TEXT NOT NULL DEFAULT 'starting' CHECK(status IN ('starting','running','completed','failed','terminated','stalled')),
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT DEFAULT NULL,
      exit_code INTEGER DEFAULT NULL,
      output_summary TEXT DEFAULT NULL,
      cost_usd REAL DEFAULT 0,
      tokens_in INTEGER DEFAULT 0,
      tokens_out INTEGER DEFAULT 0,
      error TEXT DEFAULT NULL,
      last_activity_at TEXT DEFAULT NULL,
      workspace_state_hash TEXT DEFAULT NULL,
      FOREIGN KEY (task_id) REFERENCES sym_tasks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sym_retry_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      attempt INTEGER NOT NULL,
      error_reason TEXT DEFAULT NULL,
      error_log TEXT DEFAULT NULL,
      exit_code INTEGER DEFAULT NULL,
      duration_seconds REAL DEFAULT NULL,
      scheduled_at TEXT DEFAULT NULL,
      executed_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (task_id) REFERENCES sym_tasks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sym_orchestrator (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      status TEXT NOT NULL DEFAULT 'stopped' CHECK(status IN ('running','stopped','paused')),
      pid INTEGER DEFAULT NULL,
      last_tick_at TEXT DEFAULT NULL,
      tick_count INTEGER DEFAULT 0,
      active_agents INTEGER DEFAULT 0,
      max_concurrent_agents INTEGER DEFAULT 3,
      config TEXT DEFAULT '{}',
      total_tokens_in INTEGER DEFAULT 0,
      total_tokens_out INTEGER DEFAULT 0,
      total_cost_usd REAL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // ── Indexes ──

  const indexes = [
    "CREATE INDEX IF NOT EXISTS idx_sym_tasks_status_priority ON sym_tasks(status, priority DESC)",
    "CREATE INDEX IF NOT EXISTS idx_sym_tasks_assigned_role ON sym_tasks(assigned_role)",
    "CREATE INDEX IF NOT EXISTS idx_sym_tasks_project ON sym_tasks(project_id)",
    "CREATE INDEX IF NOT EXISTS idx_sym_tasks_parent ON sym_tasks(parent_id)",
    "CREATE INDEX IF NOT EXISTS idx_sym_task_deps_blocked ON sym_task_deps(blocked_id)",
    "CREATE INDEX IF NOT EXISTS idx_sym_comments_task ON sym_comments(task_id, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_sym_artifacts_task ON sym_artifacts(task_id)",
    "CREATE INDEX IF NOT EXISTS idx_sym_agent_sessions_status ON sym_agent_sessions(status)",

    // Observability indexes (Task #66: Pipeline Metrics Queries)
    // sym_retry_log — retry frequency per task
    "CREATE INDEX IF NOT EXISTS idx_sym_retry_log_task ON sym_retry_log(task_id)",
    // sym_retry_log — time-windowed failure analysis
    "CREATE INDEX IF NOT EXISTS idx_sym_retry_log_executed ON sym_retry_log(executed_at)",
    // sym_agent_sessions — time-windowed cost/efficiency queries
    "CREATE INDEX IF NOT EXISTS idx_sym_agent_sessions_started ON sym_agent_sessions(started_at)",
    "CREATE INDEX IF NOT EXISTS idx_sym_agent_sessions_finished ON sym_agent_sessions(finished_at)",
    // sym_agent_sessions — per-role failure rate
    "CREATE INDEX IF NOT EXISTS idx_sym_agent_sessions_role_status ON sym_agent_sessions(role_slug, status)",
    // sym_tasks — current dwell time queries
    "CREATE INDEX IF NOT EXISTS idx_sym_tasks_status_updated ON sym_tasks(status, updated_at)",
    // Observability indexes (task #88) — composite indexes for time-range analytics
    "CREATE INDEX IF NOT EXISTS idx_sym_retry_log_task ON sym_retry_log(task_id, executed_at)",
    // Observability indexes (task #88) — composite indexes for time-range analytics
    "CREATE INDEX IF NOT EXISTS idx_sym_retry_log_task ON sym_retry_log(task_id, executed_at)",
    // Covers role-based session analysis AND pipeline stats queries (task #89 — role+status lookup);
    // started_at col also supports time-windowed efficiency queries without a separate index
    "CREATE INDEX IF NOT EXISTS idx_sym_agent_sessions_role_status ON sym_agent_sessions(role_slug, status, started_at)",
    "CREATE INDEX IF NOT EXISTS idx_sym_agent_sessions_started ON sym_agent_sessions(started_at)",
    // Deduplication index for idempotent mention subtask creation (Task #307)
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_sym_tasks_parent_title_type ON sym_tasks(parent_id, title, type) WHERE parent_id IS NOT NULL",
  ];
  for (const sql of indexes) {
    try { db.exec(sql); } catch (err) {
      // UNIQUE indexes may fail if duplicate data exists — log and skip
      if (!err.message.includes('UNIQUE constraint')) throw err;
      console.warn(`[symphony] Skipping index (duplicate data): ${err.message}`);
    }
  }

  // ── Audit log table (Phase 2.2) ──

  db.exec(`
    CREATE TABLE IF NOT EXISTS sym_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER,
      project_id INTEGER,
      action TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      actor_type TEXT NOT NULL,
      actor_id TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sym_audit_log_task ON sym_audit_log(task_id);
    CREATE INDEX IF NOT EXISTS idx_sym_audit_log_project ON sym_audit_log(project_id);
    -- Observability indexes (Task #66)
    CREATE INDEX IF NOT EXISTS idx_sym_audit_log_action_created ON sym_audit_log(action, created_at);
    CREATE INDEX IF NOT EXISTS idx_sym_audit_log_task_action_created ON sym_audit_log(task_id, action, created_at);
  `);

  // Observability indexes on sym_audit_log (task #88) — must be after table creation
  db.exec("CREATE INDEX IF NOT EXISTS idx_sym_audit_log_action ON sym_audit_log(action, created_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_sym_audit_log_task_action ON sym_audit_log(task_id, action, created_at)");

  // Pipeline stats indexes (task #89, Story 4, Task #112) — observability queries performance
  db.exec("CREATE INDEX IF NOT EXISTS idx_sym_audit_log_action_created ON sym_audit_log(action, created_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_sym_agent_sessions_started ON sym_agent_sessions(started_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_sym_agent_sessions_role_status ON sym_agent_sessions(role_slug, status)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_sym_retry_log_executed ON sym_retry_log(executed_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_sym_tasks_status_updated ON sym_tasks(status, updated_at)");

  // ── Agent memory table (Task #45: persistent key-value store per task) ──

  db.exec(`
    CREATE TABLE IF NOT EXISTS sym_agent_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      agent_session_id INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (task_id) REFERENCES sym_tasks(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sym_agent_memory_task_key ON sym_agent_memory(task_id, key);
  `);

  // ── Column migrations (idempotent) ──

  // Add due_date to tasks (Phase 5.1)
  try { db.exec("ALTER TABLE sym_tasks ADD COLUMN due_date TEXT DEFAULT NULL"); } catch {}
  // Add agent_session_id to comments (Phase 3.1)
  try { db.exec("ALTER TABLE sym_comments ADD COLUMN agent_session_id INTEGER DEFAULT NULL"); } catch {}
  // Add file_path/line_range to comments (Phase 3.2)
  try { db.exec("ALTER TABLE sym_comments ADD COLUMN file_path TEXT DEFAULT NULL"); } catch {}
  try { db.exec("ALTER TABLE sym_comments ADD COLUMN line_range TEXT DEFAULT NULL"); } catch {}

  // Add elapsed_ms to audit log (Story 52: elapsed time in status transitions)
  try { db.exec("ALTER TABLE sym_audit_log ADD COLUMN elapsed_ms INTEGER DEFAULT NULL"); } catch {}

  // Add auto_start flag to orchestrator (persist desired state across restarts)
  try { db.exec("ALTER TABLE sym_orchestrator ADD COLUMN auto_start INTEGER DEFAULT 0"); } catch {}

  // Add type to chat messages (task #76 — Chat Enrichment)
  try { db.exec("ALTER TABLE sym_chat_messages ADD COLUMN type TEXT NOT NULL DEFAULT 'casual'"); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_sym_chat_messages_type ON sym_chat_messages(type)"); } catch {}
  // Add chat_frequency to projects (task #76 — Chat Enrichment)
  try { db.exec("ALTER TABLE sym_projects ADD COLUMN chat_frequency INTEGER DEFAULT NULL"); } catch {}

  // Add mentions + reply_depth to chat messages (Story 82: cross-agent mentions)
  try { db.exec("ALTER TABLE sym_chat_messages ADD COLUMN mentions TEXT DEFAULT NULL"); } catch {}
  try { db.exec("ALTER TABLE sym_chat_messages ADD COLUMN reply_depth INTEGER DEFAULT 0"); } catch {}

  // Add indexes for mention query performance (Task #167)
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_chat_reply_depth ON sym_chat_messages(project_id, reply_depth, created_at)"); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_chat_mentions ON sym_chat_messages(project_id, mentions, created_at)"); } catch {}
  // Add mention_of, reply_to (with FK), type to chat messages (Story 102: cross-agent mentions)
  try { db.exec("ALTER TABLE sym_chat_messages ADD COLUMN mention_of TEXT DEFAULT NULL"); } catch {}
  try { db.exec("ALTER TABLE sym_chat_messages ADD COLUMN reply_to INTEGER DEFAULT NULL REFERENCES sym_chat_messages(id)"); } catch {}

  // Index for pending-mention queries (Story 102)
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_chat_mentions ON sym_chat_messages(mention_of, reply_to, created_at)"); } catch {}

  // Add next_retry_at for exponential retry backoff (Task #104)
  try { db.exec("ALTER TABLE sym_tasks ADD COLUMN next_retry_at TEXT DEFAULT NULL"); } catch {}

  // Add max_runtime_minutes to agent roles (Task #125: max runtime enforcement)
  // Add next_retry_at for exponential retry backoff (Task #104)
  try { db.exec("ALTER TABLE sym_tasks ADD COLUMN next_retry_at TEXT DEFAULT NULL"); } catch {}
  // Add next_retry_at for exponential retry backoff (Task #104)
  try { db.exec("ALTER TABLE sym_tasks ADD COLUMN next_retry_at TEXT DEFAULT NULL"); } catch {}
  try { db.exec("ALTER TABLE sym_agent_roles ADD COLUMN max_runtime_minutes INTEGER DEFAULT 15"); } catch {}

  // Add max_concurrent to agent roles (Task #105: per-role concurrency limits)
  try { db.exec("ALTER TABLE sym_agent_roles ADD COLUMN max_concurrent INTEGER DEFAULT NULL"); } catch {}

  // Add next_retry_at for exponential retry backoff (Task #104)
  try { db.exec("ALTER TABLE sym_tasks ADD COLUMN next_retry_at TEXT DEFAULT NULL"); } catch {}

  // Add max_runtime_minutes to agent roles (Task #103: max runtime enforcement)
  try { db.exec("ALTER TABLE sym_agent_roles ADD COLUMN max_runtime_minutes INTEGER DEFAULT 15"); } catch {}

  // Watercooler: make project_id nullable in sym_chat_messages
  _migrateWatercoolerNullableProjectId(db);

  // Fix type column DEFAULT and CHECK for existing DBs (Task #284)
  // Handles DBs where the Task #142 or Task #138 migration already ran with wrong DEFAULT 'casual'
  {
    const chatCols = db.prepare("PRAGMA table_info(sym_chat_messages)").all();
    const typeCol = chatCols.find(c => c.name === 'type');
    if (typeCol && typeCol.dflt_value === "'casual'") {
      const colNames = chatCols.map(c => c.name);
      const hasMentionOf = colNames.includes('mention_of');
      const hasReplyTo = colNames.includes('reply_to');

      db.exec(`
        CREATE TABLE sym_chat_messages_v2 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER REFERENCES sym_projects(id) ON DELETE CASCADE,
          author_role TEXT DEFAULT NULL,
          author_user_id INTEGER DEFAULT NULL,
          content TEXT NOT NULL,
          type TEXT DEFAULT 'work' CHECK(type IN ('work','celebration','complaint','insight','casual')),
          mentions TEXT DEFAULT NULL,
          reply_depth INTEGER DEFAULT 0,
          mention_of TEXT DEFAULT NULL,
          reply_to INTEGER DEFAULT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      db.exec(`
        INSERT INTO sym_chat_messages_v2 (id, project_id, author_role, author_user_id, content, type, mentions, reply_depth, mention_of, reply_to, created_at)
          SELECT id, project_id, author_role, author_user_id, content, COALESCE(type, 'work'), mentions, reply_depth,
            ${hasMentionOf ? 'mention_of' : 'NULL'},
            ${hasReplyTo ? 'reply_to' : 'NULL'},
            created_at
          FROM sym_chat_messages
      `);
      db.exec("DROP TABLE sym_chat_messages");
      db.exec("ALTER TABLE sym_chat_messages_v2 RENAME TO sym_chat_messages");
      console.log("[symphony] Fixed sym_chat_messages: type DEFAULT changed to 'work', added 'work' to CHECK");
    }
  }

  // Add mention cursor for incremental _processMentions() in tick loop (Task #43)
  try { db.exec("ALTER TABLE sym_orchestrator ADD COLUMN last_processed_mention_id INTEGER DEFAULT 0"); } catch {}

  // Composite index for fast lead time queries (task_id, created_at covering)
  db.exec("CREATE INDEX IF NOT EXISTS idx_sym_audit_log_task_time ON sym_audit_log(task_id, created_at)");

  // ── Column migrations (idempotent) ──

  try { db.exec("ALTER TABLE sym_tasks ADD COLUMN due_date TEXT DEFAULT NULL"); } catch {}
  try { db.exec("ALTER TABLE sym_comments ADD COLUMN agent_session_id INTEGER DEFAULT NULL"); } catch {}
  try { db.exec("ALTER TABLE sym_comments ADD COLUMN file_path TEXT DEFAULT NULL"); } catch {}
  try { db.exec("ALTER TABLE sym_comments ADD COLUMN line_range TEXT DEFAULT NULL"); } catch {}
  try { db.exec("ALTER TABLE sym_audit_log ADD COLUMN elapsed_ms INTEGER DEFAULT NULL"); } catch {}
  try { db.exec("ALTER TABLE sym_orchestrator ADD COLUMN auto_start INTEGER DEFAULT 0"); } catch {}
  try { db.exec("ALTER TABLE sym_chat_messages ADD COLUMN mentions TEXT DEFAULT NULL"); } catch {}
  try { db.exec("ALTER TABLE sym_chat_messages ADD COLUMN reply_depth INTEGER DEFAULT 0"); } catch {}
  try { db.exec("ALTER TABLE sym_tasks ADD COLUMN next_retry_at TEXT DEFAULT NULL"); } catch {}
  try { db.exec("ALTER TABLE sym_agent_roles ADD COLUMN max_runtime_minutes INTEGER DEFAULT 15"); } catch {}

  // ── Singleton orchestrator row ──

  db.prepare(
    "INSERT OR IGNORE INTO sym_orchestrator (id, status) VALUES (1, 'stopped')"
  ).run();

  // Update max_concurrent_agents to 5 (Phase 1.7)
  db.prepare("UPDATE sym_orchestrator SET max_concurrent_agents = 5 WHERE id = 1 AND max_concurrent_agents < 5").run();

  // ── Seed agent roles ──

  seedRoles(db);
}

/**
 * Make project_id nullable in sym_chat_messages for watercooler channel.
 * Idempotent: checks PRAGMA table_info before recreating.
 */
function _migrateWatercoolerNullableProjectId(db) {
  const columns = db.pragma("table_info(sym_chat_messages)");
  const projectIdCol = columns.find(c => c.name === "project_id");
  if (!projectIdCol || projectIdCol.notnull === 0) {
    // Already nullable or column doesn't exist — skip
    return;
  }

  console.log("[symphony] Migrating sym_chat_messages: making project_id nullable for watercooler...");

  db.transaction(() => {
    db.exec(`
      CREATE TABLE sym_chat_messages_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER DEFAULT NULL,
        author_role TEXT DEFAULT NULL,
        author_user_id INTEGER DEFAULT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        mentions TEXT DEFAULT NULL,
        reply_depth INTEGER DEFAULT 0,
        FOREIGN KEY (project_id) REFERENCES sym_projects(id) ON DELETE CASCADE
      );
      INSERT INTO sym_chat_messages_new (id, project_id, author_role, author_user_id, content, created_at, mentions, reply_depth)
        SELECT id, project_id, author_role, author_user_id, content, created_at, mentions, reply_depth
        FROM sym_chat_messages;
      DROP TABLE sym_chat_messages;
      ALTER TABLE sym_chat_messages_new RENAME TO sym_chat_messages;
    `);
  })();

  console.log("[symphony] Migration complete: sym_chat_messages.project_id is now nullable");
}

/**
 * Seed all 10 agent roles using INSERT OR IGNORE — fully idempotent.
 * Safe to call at every startup; existing rows are never overwritten.
 */
function seedRoles(db) {
  const existing = db.prepare("SELECT COUNT(*) as c FROM sym_agent_roles").get();

  // Add missing roles if they don't exist (idempotent)
  if (existing.c > 0) {
    const upsertRole = db.prepare(`
      INSERT OR IGNORE INTO sym_agent_roles (slug, name, model, max_budget_usd, system_prompt, workflow, color, icon)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const hasResearcher = db.prepare("SELECT id FROM sym_agent_roles WHERE slug = 'researcher'").get();
    if (!hasResearcher) {
      upsertRole.run('researcher', 'Researcher', 'sonnet', 3.0,
        'You are a Researcher agent. Your job is to explore the codebase, gather context, and produce research artifacts.\n\nWhen assigned a task with research/explore/audit tags:\n1. Thoroughly explore the codebase — read key files, understand architecture\n2. Produce a research artifact with findings, recommendations, and references to specific files/lines\n3. Create subtasks for follow-up work discovered during research\n4. Write detailed comments with [file:path/to/file.ts:42-58] references\n5. Set status to "completed"',
        '{"handles_types":["task","subtask"],"handles_statuses":["analysis"],"transitions_to":["design","development"],"produces":["research","spec"]}',
        '#a78bfa', 'search');
      console.log("[symphony] Added researcher role");
    }

    const hasCto = db.prepare("SELECT id FROM sym_agent_roles WHERE slug = 'cto'").get();
    if (!hasCto) {
      upsertRole.run('cto', 'CTO / Tech Lead', 'opus', 10.0,
        `You are a CTO / Tech Lead agent. Your job is to analyze large strategic Epics and break them into manageable sub-Epics.

When assigned a big Epic (no children, or tagged "strategic"/"vision"/"audit"):
1. Conduct a full codebase audit — read key files, understand current architecture, identify gaps
2. Create a **strategy artifact** (type=prd): current state analysis, goals, competitive analysis, priorities
3. Break the epic into 3-8 concrete sub-Epics (via next_tasks with type: "epic")
4. Each sub-Epic must have: clear title, detailed description with file references, priority, tags
5. Create dependency chains between epics when there's a logical order
6. Write a comprehensive handoff comment explaining the strategy

When an Epic returns (has children but came back):
1. Read comments to understand why it returned
2. Restructure sub-Epics if needed
3. Create missing sub-Epics

Always write detailed descriptions with [file:path/to/file.ts:42-58] references.
Create subtasks with full context — not "Fix bug" but "Fix XSS vulnerability in /api/auth — input not sanitized on line 42".`,
        '{"handles_types":["epic"],"handles_statuses":["backlog"],"transitions_to":"analysis","produces":["prd","epic"]}',
        '#dc2626', 'crown');
      console.log("[symphony] Added CTO role");
    }

    return;
  }

  const roles = [
    {
      slug: "cto",
      name: "CTO / Tech Lead",
      model: "opus",
      max_budget_usd: 10.0,
      max_concurrent: 1,
      system_prompt: `You are a CTO / Tech Lead agent. Your job is to analyze large strategic Epics and break them into manageable sub-Epics.

When assigned a big Epic (no children, or tagged "strategic"/"vision"/"audit"):
1. Conduct a full codebase audit — read key files, understand current architecture, identify gaps
2. Create a **strategy artifact** (type=prd): current state analysis, goals, competitive analysis, priorities
3. Break the epic into 3-8 concrete sub-Epics (via next_tasks with type: "epic")
4. Each sub-Epic must have: clear title, detailed description with file references, priority, tags
5. Create dependency chains between epics when there's a logical order
6. Write a comprehensive handoff comment explaining the strategy

When an Epic returns (has children but came back):
1. Read comments to understand why it returned
2. Restructure sub-Epics if needed
3. Create missing sub-Epics

Always write detailed descriptions with [file:path/to/file.ts:42-58] references.
Create subtasks with full context — not "Fix bug" but "Fix XSS vulnerability in /api/auth — input not sanitized on line 42".`,
      workflow: JSON.stringify({
        handles_types: ["epic"],
        handles_statuses: ["backlog"],
        transitions_to: "analysis",
        produces: ["prd", "epic"],
      }),
      color: "#dc2626",
      icon: "crown",
    },
    {
      slug: "pm",
      name: "Product Manager",
      model: "opus",
      max_budget_usd: 5.0,
      max_concurrent: 2,
      system_prompt: `You are a Product Manager agent. Your job is to analyze Epics and create actionable Product Requirements Documents (PRDs).

When assigned an Epic:
1. Analyze the epic title and description thoroughly
2. Create a PRD artifact with these sections:
   - Problem Statement: What problem are we solving?
   - User Stories: Who benefits and how?
   - Acceptance Criteria: How do we know it's done?
   - Non-functional Requirements: Performance, security, scalability
   - Technical Constraints: Known limitations or requirements
3. Break the epic into Stories (type=story, parent_id=this epic)
   - Each story should have clear acceptance criteria in its description
   - Stories should be independently deliverable
   - Order stories by dependency (foundational first)
4. Set status to "completed" when PRD and stories are ready

Be thorough but practical. Focus on clarity over exhaustiveness.`,
      workflow: JSON.stringify({
        handles_types: ["epic"],
        handles_statuses: ["backlog"],
        transitions_to: "analysis",
        produces: ["prd", "stories"],
      }),
      system_prompt: 'You are a Product Manager agent. Your job is to analyze Epics and create actionable PRDs.',
      workflow: JSON.stringify({ handles_types: ["epic"], handles_statuses: ["backlog"], transitions_to: "analysis", produces: ["prd", "stories"] }),
      color: "#8b5cf6",
      icon: "clipboard",
      color: "#8b5cf6",
      icon: "clipboard",
      max_concurrent: 2,
      color: "#8b5cf6",
      icon: "clipboard",
      color: "#8b5cf6",
      icon: "clipboard",
      max_concurrent: 2,
      color: "#8b5cf6",
      icon: "clipboard",
    },
    {
      slug: "scrum-master",
      name: "Scrum Master",
      model: "opus",
      max_budget_usd: 3.0,
      max_concurrent: null,
      system_prompt: `You are a Scrum Master agent. Your job is to decompose Stories into actionable Tasks.

When assigned a Story:
1. Read the PRD artifact from the parent Epic
2. Analyze the story's acceptance criteria
3. Break into Tasks with:
   - Clear, specific titles (verb + object)
   - Detailed description with implementation hints
   - Tags: "frontend", "backend", "api", "ui", "database" as appropriate
   - estimated_effort: xs (< 1h), s (1-4h), m (4-8h), l (1-2d), xl (2-5d)
   - assigned_role: "frontend-dev" for UI tasks, "backend-dev" for API/DB tasks
4. Create dependencies between tasks (e.g., API before frontend)
5. Set status to "completed" when decomposition is done

Keep tasks small enough for one agent session. If a task feels like "xl", split it further.`,
      workflow: JSON.stringify({
        handles_types: ["story"],
        handles_statuses: ["backlog"],
        transitions_to: "analysis",
        produces: ["tasks", "dependencies"],
      }),
      system_prompt: 'You are a Scrum Master agent. Your job is to decompose Stories into actionable Tasks.',
      workflow: JSON.stringify({ handles_types: ["story"], handles_statuses: ["backlog"], transitions_to: "analysis", produces: ["tasks", "dependencies"] }),
      color: "#06b6d4",
      icon: "layout",
      color: "#06b6d4",
      icon: "layout",
      max_concurrent: null,
      color: "#06b6d4",
      icon: "layout",
      color: "#06b6d4",
      icon: "layout",
      max_concurrent: null,
      color: "#06b6d4",
      icon: "layout",
    },
    {
      slug: "analyst",
      name: "Analyst",
      model: "sonnet",
      max_budget_usd: 3.0,
      max_concurrent: null,
      system_prompt: `You are an Analyst agent. Your job is to write technical specifications for tasks.

When assigned a task in "analysis" status:
1. Read the parent story and epic PRD for context
2. Read artifacts from dependency tasks
3. Write a spec artifact covering:
   - Technical approach
   - Data models / API contracts if relevant
   - Edge cases and error handling
   - File paths that need changes
4. Set status to "completed"

If the task has UI components, transition to "design". Otherwise, transition to "development".
Be concise and actionable — developers should be able to code from your spec.`,
      workflow: JSON.stringify({
        handles_types: ["task", "subtask"],
        handles_statuses: ["analysis"],
        transitions_to: ["design", "development"],
        produces: ["spec"],
      }),
      system_prompt: 'You are an Analyst agent. Your job is to write technical specifications for tasks.',
      workflow: JSON.stringify({ handles_types: ["task", "subtask"], handles_statuses: ["analysis"], transitions_to: ["design", "development"], produces: ["spec"] }),
      color: "#f59e0b",
      icon: "search",
    },
    {
      slug: "researcher",
      name: "Researcher",
      model: "sonnet",
      max_budget_usd: 3.0,
      system_prompt: `You are a Researcher agent. Your job is to explore the codebase, gather context, and produce research artifacts.

When assigned a task with research/explore/audit tags:
1. Thoroughly explore the codebase — read key files, understand architecture
2. Produce a research artifact with findings, recommendations, and references to specific files/lines
3. Create subtasks for follow-up work discovered during research
4. Write detailed comments with [file:path/to/file.ts:42-58] references
5. Set status to "completed"`,
      workflow: JSON.stringify({
        handles_types: ["task", "subtask"],
        handles_statuses: ["analysis"],
        transitions_to: ["design", "development"],
        produces: ["research", "spec"],
      }),
      color: "#a78bfa",
      icon: "search",
      color: "#f59e0b",
      icon: "search",
      max_concurrent: null,
    },
    {
      slug: "designer",
      name: "Designer",
      model: "opus",
      max_budget_usd: 5.0,
      max_concurrent: null,
      system_prompt: `You are a Designer agent. Your job is to create design specifications for UI tasks.

When assigned a task in "design" status:
1. Read the spec artifact and PRD
2. Create a design artifact covering:
   - Component structure (React components needed)
   - Layout description (flexbox/grid, responsive behavior)
   - Visual specs (colors, spacing, typography — use existing design tokens)
   - Interaction patterns (hover, click, loading states)
   - Accessibility requirements (ARIA, keyboard nav)
3. Set status to "completed" → transitions to "development"

Reference existing components in the codebase. Don't reinvent patterns.`,
      workflow: JSON.stringify({
        handles_types: ["task", "subtask"],
        handles_statuses: ["design"],
        transitions_to: "development",
        produces: ["design"],
      }),
      system_prompt: 'You are a Designer agent. Your job is to create design specifications for UI tasks.',
      workflow: JSON.stringify({ handles_types: ["task", "subtask"], handles_statuses: ["design"], transitions_to: "development", produces: ["design"] }),
      color: "#ec4899",
      icon: "palette",
      color: "#ec4899",
      icon: "palette",
      max_concurrent: null,
      color: "#ec4899",
      icon: "palette",
      color: "#ec4899",
      icon: "palette",
      max_concurrent: null,
      color: "#ec4899",
      icon: "palette",
    },
    {
      slug: "frontend-dev",
      name: "Frontend Developer",
      model: "opus",
      max_budget_usd: 10.0,
      max_concurrent: 2,
      system_prompt: `You are a Frontend Developer agent. You write React/TypeScript/Tailwind code.

When assigned a task in "development" status:
1. Read all artifacts: spec, design, PRD
2. Read existing code in the workspace for patterns and conventions
3. Write clean, typed React components with Tailwind CSS
4. Follow existing project patterns:
   - Use existing Icon components from Icons.tsx
   - Follow NavigationContext patterns
   - Use existing CSS variables/theme tokens
   - TypeScript strict mode
5. Git commit your changes with descriptive messages
6. Set status to "completed" → transitions to "code_review"

Write production-quality code. No TODO comments, no console.logs, no placeholder content.`,
      workflow: JSON.stringify({
        handles_types: ["task", "subtask"],
        handles_statuses: ["development"],
        transitions_to: "code_review",
        produces: ["code"],
      }),
      system_prompt: 'You are a Frontend Developer agent. You write React/TypeScript/Tailwind code.',
      workflow: JSON.stringify({ handles_types: ["task", "subtask"], handles_statuses: ["development"], transitions_to: "code_review", produces: ["code"] }),
      color: "#3b82f6",
      icon: "code",
      color: "#3b82f6",
      icon: "code",
      max_concurrent: 2,
      color: "#3b82f6",
      icon: "code",
      color: "#3b82f6",
      icon: "code",
      max_concurrent: 2,
      color: "#3b82f6",
      icon: "code",
    },
    {
      slug: "backend-dev",
      name: "Backend Developer",
      model: "opus",
      max_budget_usd: 10.0,
      max_concurrent: 2,
      system_prompt: `You are a Backend Developer agent. You write Node.js/TypeScript server code.

When assigned a task in "development" status:
1. Read all artifacts: spec, design (if any), PRD
2. Read existing code for patterns (db.js, server.js, existing API routes)
3. Write clean server code following project conventions:
   - Next.js API routes (app router)
   - better-sqlite3 for database (use global.db)
   - Proper error handling with status codes
   - Input validation
4. Git commit your changes with descriptive messages
5. Set status to "completed" → transitions to "code_review"

Follow existing patterns strictly. Use prepared statements for all SQL.`,
      workflow: JSON.stringify({
        handles_types: ["task", "subtask"],
        handles_statuses: ["development"],
        transitions_to: "code_review",
        produces: ["code"],
      }),
      system_prompt: 'You are a Backend Developer agent. You write Node.js/TypeScript server code.',
      workflow: JSON.stringify({ handles_types: ["task", "subtask"], handles_statuses: ["development"], transitions_to: "code_review", produces: ["code"] }),
      color: "#10b981",
      icon: "server",
      color: "#10b981",
      icon: "server",
      max_concurrent: 2,
      color: "#10b981",
      icon: "server",
      color: "#10b981",
      icon: "server",
      max_concurrent: 2,
      color: "#10b981",
      icon: "server",
    },
    {
      slug: "reviewer",
      name: "Code Reviewer",
      model: "sonnet",
      max_budget_usd: 3.0,
      max_concurrent: null,
      system_prompt: `You are a Code Reviewer agent. You review code changes for quality and correctness.

When assigned a task in "code_review" status:
1. Read the spec and design artifacts for requirements
2. Review all code changes in the workspace (git diff)
3. Check for:
   - Correctness: Does it meet the spec?
   - Security: SQL injection, XSS, secrets in code?
   - Style: Follows project conventions?
   - Types: Proper TypeScript usage?
   - Edge cases: Error handling, null checks?
4. Create a review artifact with findings
5. Decision:
   - APPROVE → comment with approval, set status "completed" → qa
   - REJECT → comment with specific issues, set status "completed" with next_status "development"

Be constructive. Cite specific lines. Suggest fixes, don't just complain.`,
      workflow: JSON.stringify({
        handles_types: ["task", "subtask"],
        handles_statuses: ["code_review"],
        transitions_to: ["qa", "development"],
        produces: ["review"],
      }),
      system_prompt: 'You are a Code Reviewer agent. You review code changes for quality and correctness.',
      workflow: JSON.stringify({ handles_types: ["task", "subtask"], handles_statuses: ["code_review"], transitions_to: ["qa", "development"], produces: ["review"] }),
      color: "#f97316",
      icon: "eye",
      color: "#f97316",
      icon: "eye",
      max_concurrent: null,
      color: "#f97316",
      icon: "eye",
      color: "#f97316",
      icon: "eye",
      max_concurrent: null,
      color: "#f97316",
      icon: "eye",
    },
    {
      slug: "qa",
      name: "QA Engineer",
      model: "sonnet",
      max_budget_usd: 3.0,
      max_concurrent: null,
      system_prompt: `You are a QA Engineer agent. You validate that tasks meet their acceptance criteria.

When assigned a task in "qa" status:
1. Read the spec, PRD, and acceptance criteria from parent story
2. Run tests if available: npm test / pytest (check project config)
3. Run linter if available: npm run lint
4. Verify:
   - All acceptance criteria from the story are met
   - No hardcoded values, secrets, or debug code
   - No console.log statements left in production code
   - Error handling is proper
5. Create a test artifact with results
6. Decision:
   - PASS: If task.needs_human_review → set "uat", else set "done"
   - FAIL: Set status back to "development" with detailed comments about what failed

Be thorough but fair. Test the actual behavior, not just code style.`,
      workflow: JSON.stringify({
        handles_types: ["task", "subtask"],
        handles_statuses: ["qa"],
        transitions_to: ["done", "uat", "development"],
        produces: ["test"],
      }),
      color: "#14b8a6",
      icon: "check-circle",
    },
    {
      slug: "researcher",
      name: "Researcher",
      model: "sonnet",
      max_budget_usd: 3.0,
      system_prompt: 'You are a Researcher agent. Your job is to explore the codebase, gather context, and produce research artifacts.',
      workflow: JSON.stringify({ handles_types: ["task", "subtask"], handles_statuses: ["analysis"], transitions_to: ["design", "development"], produces: ["research", "spec"] }),
      color: "#a78bfa",
      icon: "search",
      max_concurrent: null,
    },
  ];

  const insert = db.prepare(`
    INSERT OR IGNORE INTO sym_agent_roles (slug, name, model, max_budget_usd, system_prompt, workflow, color, icon, max_concurrent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction(() => {
    for (const r of roles) {
      insert.run(r.slug, r.name, r.model, r.max_budget_usd, r.system_prompt, r.workflow, r.color, r.icon, r.max_concurrent ?? null);
    }
  });

  insertMany();
  console.log("[symphony] Seeded agent roles");
}

module.exports = { runSymphonyMigrations, seedRoles };
