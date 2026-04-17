"use strict";

const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const { AgentRunner } = require("./symphony-agent-runner");
const { getAutoAssignedRole, getNextStatus, STATUS_TRANSITIONS, ROLE_PERSONALITIES, ROLE_MOODS, getMoodModifiers } = require("./symphony-workflows");
const { seedRoles } = require("./symphony-db-migrations");

const WORKSPACES_ROOT = path.join(process.env.HOME || "/root", "symphony-workspaces");
const TICK_INTERVAL = 5000; // 5 seconds
const STALL_TIMEOUT = 300000; // 5 minutes default
const CLEANUP_EVERY_N_TICKS = 10;
const VALIDATE_EVERY_N_TICKS = 12; // ~1 minute
const COOLDOWN_DURATION = 60000; // 1 minute after rate limit
const PAUSE_DURATION = 300000; // 5 minutes after 3 consecutive rate limits
const TEAM_CHAT_EVERY_N_TICKS = 60; // ~5 minutes
const WATERCOOLER_EVERY_N_TICKS = 120; // ~10 minutes
const RATE_LIMIT_RECOVERY_INTERVAL = 120000; // 2 minutes — try to recover a slot
const MAX_MENTION_FAILURES = 5; // Skip poison mention after this many consecutive failures

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

class SymphonyOrchestrator {
  constructor(db, broadcast) {
    this.db = db;
    this.broadcast = broadcast || (() => {});
    this.runner = new AgentRunner(db, broadcast);
    this.tickTimer = null;
    this.tickCount = 0;
    this.activeAgents = new Map(); // sessionId → { promise, taskId, pid }
    this.cooldownUntil = 0;
    this.consecutiveRateLimits = 0;
    this.pausedUntil = 0;
    this._completionQueue = []; // processed by processQueue()
    this._started = false;
    this._originalMaxAgents = null; // for rate limit recovery
    this._lastRateLimitTime = 0;
    this._recoveryTimer = null;
    this._hasTypeColumn = null; // lazy-initialized: null = unknown, true/false = probed
    this._topicRotation = {}; // projectId → index
  }

  // ── Lifecycle ──

  async start() {
    if (this._started) {
      console.log("[symphony] Orchestrator already started, skipping");
      return;
    }
    this._started = true;

    console.log("[symphony] Orchestrator starting...");

    // Idempotent migration: ensure last_processed_mention_id column exists
    const orchCols = this.db.prepare("PRAGMA table_info(sym_orchestrator)").all();
    if (!orchCols.find(c => c.name === 'last_processed_mention_id')) {
      this.db.prepare("ALTER TABLE sym_orchestrator ADD COLUMN last_processed_mention_id INTEGER DEFAULT 0").run();
      console.log("[symphony] Added last_processed_mention_id column to sym_orchestrator");
    }
    // Idempotent migrations for mention processing (tasks #43, #307, #311)
    try { this.db.exec("ALTER TABLE sym_orchestrator ADD COLUMN last_processed_mention_id INTEGER DEFAULT 0"); } catch {}
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sym_tasks_parent_title_type
      ON sym_tasks(parent_id, title, type)
      WHERE parent_id IS NOT NULL
    `);
    // Mention processing migrations
    this._runMentionMigrations();

    // Startup recovery
    this._startupRecovery();

    // Validate all expected agent roles exist in DB
    this._validateRoles();
    // Migration: add last_processed_mention_id column (idempotent)
    try { this.db.exec("ALTER TABLE sym_orchestrator ADD COLUMN last_processed_mention_id INTEGER DEFAULT 0"); } catch {}

    // Migration: partial unique index for mention-generated subtask deduplication
    try {
      this.db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_sym_tasks_mention_idempotency
        ON sym_tasks(parent_id, title)
        WHERE title LIKE '[mention] %'
      `);
    } catch {}

    // Store original max agents for rate limit recovery
    const orch = this.db.prepare("SELECT max_concurrent_agents FROM sym_orchestrator WHERE id = 1").get();
    this._originalMaxAgents = orch?.max_concurrent_agents || 5;

    // Migration: add last_processed_mention_id column (idempotent)
    try { this.db.exec("ALTER TABLE sym_orchestrator ADD COLUMN last_processed_mention_id INTEGER DEFAULT 0"); } catch {}

    // Migration: unique index for idempotent mention subtask creation
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sym_tasks_parent_title_type
      ON sym_tasks(parent_id, title, type)
      WHERE parent_id IS NOT NULL
    `);

    // Update orchestrator row + persist auto_start = 1
    this.db.prepare(`
      UPDATE sym_orchestrator SET status = 'running', auto_start = 1, pid = ?, last_tick_at = datetime('now'), updated_at = datetime('now')
      WHERE id = 1
    `).run(process.pid);

    this.broadcast({ type: "orchestrator_status", status: "running" });

    // Start tick loop
    this.tickTimer = setInterval(() => this._tick(), TICK_INTERVAL);

    // Start rate limit recovery timer
    this._recoveryTimer = setInterval(() => this._recoverRateLimitSlots(), RATE_LIMIT_RECOVERY_INTERVAL);

    console.log("[symphony] Orchestrator running (tick every 5s, max agents: " + this._originalMaxAgents + ")");
  }

  stop() {
    if (!this._started) return;
    this._started = false;

    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this._recoveryTimer) {
      clearInterval(this._recoveryTimer);
      this._recoveryTimer = null;
    }

    this.db.prepare(`
      UPDATE sym_orchestrator SET status = 'stopped', auto_start = 0, updated_at = datetime('now') WHERE id = 1
    `).run();

    this.broadcast({ type: "orchestrator_status", status: "stopped" });
    console.log("[symphony] Orchestrator stopped");
  }

  pause() {
    this.db.prepare(`
      UPDATE sym_orchestrator SET status = 'paused', updated_at = datetime('now') WHERE id = 1
    `).run();
    this.broadcast({ type: "orchestrator_status", status: "paused" });
    console.log("[symphony] Orchestrator paused");
  }

  async resume() {
    this.db.prepare(`
      UPDATE sym_orchestrator SET status = 'running', updated_at = datetime('now') WHERE id = 1
    `).run();
    this.broadcast({ type: "orchestrator_status", status: "running" });

    // Restart tick loop if not running
    if (!this._started) {
      await this.start();
    }

    console.log("[symphony] Orchestrator resumed");
  }

  getStatus() {
    const row = this.db.prepare("SELECT * FROM sym_orchestrator WHERE id = 1").get();
    return {
      ...row,
      active_agents_detail: Array.from(this.activeAgents.entries()).map(([sid, info]) => ({
        sessionId: sid,
        taskId: info.taskId,
        pid: info.pid,
        role: info.role || null,
      })),
      cooldown_remaining: Math.max(0, this.cooldownUntil - Date.now()),
      paused_remaining: Math.max(0, this.pausedUntil - Date.now()),
    };
  }

  /**
   * Graceful shutdown: terminate all agents, wait, then stop.
   * Preserves auto_start flag so orchestrator restarts on next server boot.
   */
  async gracefulShutdown() {
    console.log("[symphony] Graceful shutdown...");

    // Stop tick loop without changing auto_start
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this._recoveryTimer) {
      clearInterval(this._recoveryTimer);
      this._recoveryTimer = null;
    }
    this._started = false;

    // Terminate all running agents
    for (const [sessionId, info] of this.activeAgents) {
      console.log(`[symphony] Terminating agent session ${sessionId} (task ${info.taskId})...`);
      this.runner.terminate(sessionId);
    }

    // Wait up to 30s for agents to finish
    const deadline = Date.now() + 30000;
    while (this.activeAgents.size > 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 1000));
    }

    // Force kill survivors
    for (const [sessionId, info] of this.activeAgents) {
      if (info.pid) {
        try { process.kill(info.pid, "SIGKILL"); } catch {}
      }
      this.db.prepare(
        "UPDATE sym_agent_sessions SET status = 'terminated', finished_at = datetime('now') WHERE id = ?"
      ).run(sessionId);
    }

    this.activeAgents.clear();

    // Set status to stopped but PRESERVE auto_start flag
    // Only update if this process still owns the orchestrator (prevents deploy race condition)
    const currentOrch = this.db.prepare("SELECT pid FROM sym_orchestrator WHERE id = 1").get();
    if (currentOrch && currentOrch.pid === process.pid) {
      this.db.prepare(`
        UPDATE sym_orchestrator SET status = 'stopped', active_agents = 0, updated_at = datetime('now') WHERE id = 1
      `).run();
    } else {
      console.log("[symphony] Skipping status update — another process owns the orchestrator");
    }

    console.log("[symphony] Graceful shutdown complete (auto_start preserved)");
  }

  // ── Tick Loop (Phase 1.5: each phase in try-catch) ──

  async _tick() {
    const orch = this.db.prepare("SELECT status FROM sym_orchestrator WHERE id = 1").get();
    if (!orch || orch.status !== "running") return;

    // Check pause timeout
    if (this.pausedUntil > Date.now()) return;

    this.tickCount++;

    // Phase: Reconcile
    try { this._reconcile(); } catch (err) {
      console.error("[symphony] _reconcile error:", err.message);
    }

    // Phase: Process Queue
    try { this._processQueue(); } catch (err) {
      console.error("[symphony] _processQueue error:", err.message);
    }

    // Phase: Unblock
    try { this._unblock(); } catch (err) {
      console.error("[symphony] _unblock error:", err.message);
    }

    // Phase: Process mentions
    try { this._processMentions(); } catch (err) {
      console.error("[symphony] _processMentions error:", err.message);
    }

    // Phase: Auto-advance backlog tasks/subtasks to analysis
    try { this._autoAdvanceBacklog(); } catch (err) {
      console.error("[symphony] _autoAdvanceBacklog error:", err.message);
    }

    // Phase: Auto-advance parents when all children done
    try { this._autoAdvance(); } catch (err) {
      console.error("[symphony] _autoAdvance error:", err.message);
    }

    // Phase: Validate config
    try {
      if (this.tickCount % VALIDATE_EVERY_N_TICKS === 0) this._validateConfig();
    } catch (err) {
      console.error("[symphony] _validateConfig error:", err.message);
    }

    // Phase: Dispatch
    try { this._dispatch(); } catch (err) {
      console.error("[symphony] _dispatch error:", err.message);
    }

    // Phase: Cleanup
    try {
      if (this.tickCount % CLEANUP_EVERY_N_TICKS === 0) this._cleanup();
    } catch (err) {
      console.error("[symphony] _cleanup error:", err.message);
    }

    // Phase: Team chat (periodic fun messages)
    try {
      if (this.tickCount % TEAM_CHAT_EVERY_N_TICKS === 0 && this.tickCount > 0) {
        this._teamChat();
      }
    } catch (err) {
      console.error("[symphony] _teamChat error:", err.message);
    }

    // Phase: Watercooler chat (cross-project banter, ~every 10 minutes)
    try {
      if (this.tickCount % WATERCOOLER_EVERY_N_TICKS === 0 && this.tickCount > 0) {
        this._watercoolerChat();
      }
    } catch (err) {
      console.error("[symphony] _watercoolerChat error:", err.message);
    }

    // Phase: Heartbeat
    try { this._heartbeat(); } catch (err) {
      console.error("[symphony] _heartbeat error:", err.message);
    }
  }

  // ── Startup Recovery ──

  _startupRecovery() {
    console.log("[symphony] Running startup recovery...");

    const orphans = this.db.prepare(`
      SELECT * FROM sym_agent_sessions
      WHERE status IN ('starting', 'running') AND finished_at IS NULL
    `).all();

    for (const s of orphans) {
      const alive = s.pid ? this.runner.isPidAlive(s.pid) : false;
      if (!alive) {
        this.db.prepare(`
          UPDATE sym_agent_sessions SET status = 'terminated', finished_at = datetime('now'), error = 'interrupted by restart', exit_code = 143
          WHERE id = ?
        `).run(s.id);

        // Don't count restart-kills as real attempts — restore attempt counter
        const task = this.db.prepare("SELECT id, attempt FROM sym_tasks WHERE id = ?").get(s.task_id);
        if (task && task.attempt > 0) {
          this.db.prepare("UPDATE sym_tasks SET attempt = attempt - 1, error_log = NULL, next_retry_at = NULL WHERE id = ? AND attempt > 0").run(s.task_id);
          console.log(`[symphony] Recovered orphan session ${s.id} (task ${s.task_id}) — attempt restored`);
        } else {
          console.log(`[symphony] Recovered orphan session ${s.id} (task ${s.task_id})`);
        }
      }
    }

    // Prune git worktrees for all projects
    const projects = this.db.prepare("SELECT * FROM sym_projects WHERE repo_path IS NOT NULL").all();
    for (const p of projects) {
      if (fs.existsSync(p.repo_path)) {
        try {
          execSync("git worktree prune", { cwd: p.repo_path, stdio: "pipe" });
        } catch {}
      }
    }

    console.log(`[symphony] Recovery done. ${orphans.length} orphans processed.`);
  }

  // ── Role Validation ──

  _validateRoles() {
    console.log("[symphony] Validating agent roles...");
    seedRoles(this.db);
  }

  // ── Reconcile (stall/crash detection) ──

  _reconcile() {
    const running = this.db.prepare(`
      SELECT s.*, p.slug as project_slug
      FROM sym_agent_sessions s
      JOIN sym_tasks t ON t.id = s.task_id
      JOIN sym_projects p ON p.id = t.project_id
      SELECT s.*, r.workflow AS role_workflow
      FROM sym_agent_sessions s
      LEFT JOIN sym_agent_roles r ON r.slug = s.role_slug
      WHERE s.status IN ('starting', 'running')
    `).all();

    for (const s of running) {
      // Check if PID is alive
      if (s.pid && !this.runner.isPidAlive(s.pid)) {
        this.db.prepare(`
          UPDATE sym_agent_sessions SET status = 'failed', finished_at = datetime('now'), error = 'process crashed'
          WHERE id = ?
        `).run(s.id);
        this.activeAgents.delete(s.id);
        this.broadcast({ type: "agent_finished", sessionId: s.id, taskId: s.task_id, error: "process crashed", projectSlug: s.project_slug });
        continue;
      }

      // Stall detection — only if PID is NOT alive (process hung as zombie or lost)
      // If PID is alive, the agent is working — don't kill it
      if (s.last_activity_at) {
        const pidAlive = s.pid && this.runner.isPidAlive(s.pid);
        if (pidAlive) {
          // Process still running — update activity timestamp to prevent future stall
          this.db.prepare(`
            UPDATE sym_agent_sessions SET last_activity_at = datetime('now') WHERE id = ?
          `).run(s.id);
        } else {
          const lastActivity = new Date(s.last_activity_at + 'Z').getTime();
          const stallTimeout = this._getStallTimeout(s.task_id);
          if (Date.now() - lastActivity > stallTimeout) {
            console.log(`[symphony] Session ${s.id} stalled (no activity for ${stallTimeout / 1000}s, PID dead)`);
            this.db.prepare(`
              UPDATE sym_agent_sessions SET status = 'stalled', finished_at = datetime('now'), error = 'stalled - no activity'
              WHERE id = ?
            `).run(s.id);
            this.activeAgents.delete(s.id);
            this.broadcast({ type: "agent_finished", sessionId: s.id, taskId: s.task_id, error: "stalled", projectSlug: s.project_slug });
          }
        }
      }
    }
  }

  _getStallTimeout(taskId) {
    try {
      const task = this.db.prepare("SELECT project_id FROM sym_tasks WHERE id = ?").get(taskId);
      if (task) {
        const project = this.db.prepare("SELECT config FROM sym_projects WHERE id = ?").get(task.project_id);
        if (project?.config) {
          const config = JSON.parse(project.config);
          if (config.stall_timeout_ms) return config.stall_timeout_ms;
        }
      }
    } catch {}
    return STALL_TIMEOUT;
  }

  // ── Process Completion Queue ──

  _processQueue() {
    while (this._completionQueue.length > 0) {
      const item = this._completionQueue.shift();
      try {
        this._handleCompletion(item);
      } catch (err) {
        console.error("[symphony] Completion processing error:", err.message);
      }
    }
  }

  _handleCompletion({ task, parsed, session }) {
    const db = this.db;

    // Save artifacts
    if (parsed.artifacts && parsed.artifacts.length > 0) {
      const insertArtifact = db.prepare(`
        INSERT INTO sym_artifacts (task_id, type, title, file_path, content, created_by_role)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const a of parsed.artifacts) {
        // Read file content if path provided and file exists
        let content = a.content || null;
        if (a.path && task.workspace_path) {
          const fullPath = path.join(task.workspace_path, a.path);
          if (fs.existsSync(fullPath)) {
            try { content = fs.readFileSync(fullPath, "utf-8").slice(0, 50000); } catch {}
          }
        }
        insertArtifact.run(task.id, a.type || "other", a.title || "", a.path || null, content, session.role_slug);
      }
    }

    // Save comments
    if (parsed.comments && parsed.comments.length > 0) {
      const insertComment = db.prepare(`
        INSERT INTO sym_comments (task_id, author_role, content, type, mention_role, agent_session_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const c of parsed.comments) {
        insertComment.run(task.id, session.role_slug, c.content, c.type || "comment", c.mention || null, session.id || null);
      }
    }

    // Save chat message
    if (parsed.chat_message && task.project_id) {
      const chatType = parsed.chat_message_type || null;
      db.prepare(`
        INSERT INTO sym_chat_messages (project_id, author_role, content, type)
        VALUES (?, ?, ?, ?)
      `).run(task.project_id, session.role_slug, parsed.chat_message, chatType);
      this.broadcast({ type: "chat_message", projectId: task.project_id, role: session.role_slug, content: parsed.chat_message, messageType: chatType });
    }

    // Create next tasks
    if (parsed.next_tasks && parsed.next_tasks.length > 0) {
      const insertTask = db.prepare(`
        INSERT INTO sym_tasks (project_id, parent_id, type, title, description, status, assigned_role, tags, priority)
        VALUES (?, ?, ?, ?, ?, 'backlog', ?, ?, ?)
      `);
      for (const nt of parsed.next_tasks) {
        const tags = JSON.stringify(nt.tags || []);
        const type = nt.type || "task";
        const assignedRole = nt.assigned_role || null;
        const result = insertTask.run(task.project_id, task.id, type, nt.title, nt.description || "", assignedRole, tags, nt.priority || task.priority || 50);

        // Audit log
        this._auditLog(result.lastInsertRowid, task.project_id, "task_created", null, type, "agent", session.role_slug);

        this.broadcast({ type: "task_created", projectId: task.project_id });
      }
    }

    // Transition status
    if (parsed.status === "completed") {
      const nextStatus = parsed.next_status || getNextStatus(task.status, null, task);
      if (nextStatus && STATUS_TRANSITIONS[task.status]?.includes(nextStatus)) {
        this._transitionTask(task, nextStatus, session.role_slug);
      }
    } else if (parsed.status === "blocked") {
      // Add system comment about block
      db.prepare(`
        INSERT INTO sym_comments (task_id, author_role, content, type)
        VALUES (?, ?, ?, 'system')
      `).run(task.id, session.role_slug, `Blocked: ${(parsed.blocked_by || []).join(", ")}`);
    }
    // If failed — check if permanently failed (dead letter queue)
    if (parsed.status === "failed") {
      this._handleTaskFailure(task, session, parsed);
    }

    // Update orchestrator token totals
    const tokensIn = session.tokens_in || 0;
    const tokensOut = session.tokens_out || 0;
    const cost = session.cost_usd || 0;
    if (tokensIn || tokensOut || cost) {
      db.prepare(`
        UPDATE sym_orchestrator
        SET total_tokens_in = total_tokens_in + ?,
            total_tokens_out = total_tokens_out + ?,
            total_cost_usd = total_cost_usd + ?,
            updated_at = datetime('now')
        WHERE id = 1
      `).run(tokensIn, tokensOut, cost);
    }
  }

  // ── Dead Letter Queue — permanently fail tasks after max attempts ──

  _handleTaskFailure(task, session, parsed) {
    const db = this.db;

    const freshTask = db.prepare("SELECT * FROM sym_tasks WHERE id = ?").get(task.id);
    if (!freshTask) return;

    if (freshTask.attempt >= 3) {
      db.prepare(`
        UPDATE sym_tasks
        SET status = 'failed',
            assigned_role = NULL,
            session_id = NULL,
            claude_session_id = NULL,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(task.id);

      db.prepare(`
        INSERT INTO sym_comments (task_id, author_role, content, type)
        VALUES (?, ?, ?, 'system')
      `).run(
        task.id,
        session.role_slug,
        `Task permanently failed after ${freshTask.attempt} attempts. Last error: ${parsed.error || parsed.summary || "unknown"}. Moved to dead letter queue. Can be re-queued manually to backlog.`
      );

      this._auditLog(task.id, task.project_id, "status_change", freshTask.status, "failed", "system", session.role_slug);
      this.broadcast({ type: "task_failed_permanently", taskId: task.id, projectId: task.project_id });
      console.warn(`[symphony] Task ${task.id} permanently failed (${freshTask.attempt} attempts) → status=failed`);
    }
  }

  // ── Unblock (dependency resolution) — Phase 1.4: include cancelled blockers ──

  _unblock() {
    // Find tasks where all blockers are done OR cancelled
    const unblockable = this.db.prepare(`
      SELECT DISTINCT d.blocked_id
      FROM sym_task_deps d
      JOIN sym_tasks bt ON bt.id = d.blocker_id
      JOIN sym_tasks blocked ON blocked.id = d.blocked_id
      WHERE blocked.status NOT IN ('done', 'cancelled')
      GROUP BY d.blocked_id
      HAVING COUNT(*) = SUM(CASE WHEN bt.status IN ('done', 'cancelled') THEN 1 ELSE 0 END)
    `).all();

    for (const { blocked_id } of unblockable) {
      // Task is unblocked — ensure it can be dispatched
      this.broadcast({ type: "task_unblocked", taskId: blocked_id });
    }
  }

  // ── Process Mentions (mention-based escalation & routing with poison protection) ──

  _processMentions() {
    // 1. Read cursor + config
    const orchRow = this.db.prepare(
      "SELECT last_processed_mention_id, config FROM sym_orchestrator WHERE id = 1"
    ).get();
    const lastId = orchRow?.last_processed_mention_id || 0;
    const config = JSON.parse(orchRow?.config || '{}');
    const mentionFailures = config.mention_failures || {};

    // 2. Fetch unprocessed mentions
    const mentions = this.db.prepare(`
      SELECT c.id, c.task_id, c.mention_role, c.content, c.author_role,
             t.status, t.assigned_role, t.project_id, t.title
      FROM sym_comments c
      JOIN sym_tasks t ON t.id = c.task_id
      WHERE c.mention_role IS NOT NULL AND c.id > ?
      ORDER BY c.id ASC
    `).all(lastId);

    if (mentions.length === 0) return;

    let maxProcessedId = lastId;
    let configChanged = false;

    for (const mention of mentions) {
      try {
        this._handleMention(mention);
        maxProcessedId = Math.max(maxProcessedId, mention.id);

        // Clear failure tracking on success
        if (mentionFailures[mention.id] !== undefined) {
          delete mentionFailures[mention.id];
          configChanged = true;
        }
      } catch (err) {
        const prevFailures = mentionFailures[mention.id] || 0;
        const failures = prevFailures + 1;

        console.warn(
          `[symphony] [mentions] Error processing mention #${mention.id} ` +
          `(attempt ${failures}/${MAX_MENTION_FAILURES}): ${err.message}`
        );

        if (failures >= MAX_MENTION_FAILURES) {
          // Poison mention — skip it, advance cursor, audit log
          console.error(
            `[mentions] Skipping poison mention #${mention.id} after ${failures} consecutive failures. ` +
            `task_id=${mention.task_id}, mention_role=${mention.mention_role}, error=${err.message}`
          );

          this._auditLog(
            mention.task_id,
            mention.project_id,
            'mention_poison_skip',
            String(failures),
            JSON.stringify({ mention_id: mention.id, mention_role: mention.mention_role, error: err.message }),
            'system',
            null
          );

          // Advance cursor past the poison mention
          maxProcessedId = Math.max(maxProcessedId, mention.id);

          // Cleanup failure tracking
          delete mentionFailures[mention.id];
          configChanged = true;

          // Do NOT break — continue processing subsequent mentions
        } else {
          // Not yet a poison — increment counter, stop for this tick
          mentionFailures[mention.id] = failures;
          configChanged = true;
          break;
        }
      }
    }

    // 3. Persist config + cursor atomically (single UPDATE to prevent crash inconsistency)
    const cursorChanged = maxProcessedId > lastId;
    if (configChanged || cursorChanged) {
      if (configChanged) {
        config.mention_failures = mentionFailures;
      }
      this.db.prepare(
        "UPDATE sym_orchestrator SET config = ?, last_processed_mention_id = ? WHERE id = 1"
      ).run(JSON.stringify(config), cursorChanged ? maxProcessedId : lastId);
    }
  }

  _handleMention(mention) {
    const { id, task_id, mention_role, status } = mention;
    console.log(`[symphony] [mentions] Processing mention #${id}: @${mention_role} in task #${task_id} (status: ${status})`);

    if (mention_role === 'human') {
      this._handleHumanMention(mention);
    } else {
      this._handleAgentMention(mention);
    }
  }

  _handleHumanMention(mention) {
    const { task_id, content, author_role } = mention;

    this.db.prepare(`
      UPDATE sym_tasks SET needs_human_review = 1, updated_at = datetime('now')
      WHERE id = ?
    `).run(task_id);

    const task = this.db.prepare("SELECT project_id FROM sym_tasks WHERE id = ?").get(task_id);
    this._auditLog(task_id, task?.project_id, 'mention_human', null, JSON.stringify({ content, author_role }), 'system', null);

    this.broadcast({
      type: 'mention',
      taskId: task_id,
      role: 'human',
      content,
      action: 'needs_human_review'
    });

    console.log(`[symphony] [mentions] Task #${task_id} flagged for human review`);
  }

  _handleAgentMention(mention) {
    const { task_id, mention_role, content, author_role, status, project_id, title } = mention;

    const roleStatuses = this._getRoleStatuses(mention_role);
    const canReassign = roleStatuses.includes(status);

    if (canReassign) {
      this.db.prepare(`
        UPDATE sym_tasks SET assigned_role = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(mention_role, task_id);

      this._auditLog(task_id, project_id, 'mention_reassign', author_role, mention_role, 'system', null);

      this.broadcast({
        type: 'mention',
        taskId: task_id,
        role: mention_role,
        content,
        action: 'reassigned'
      });

      console.log(`[symphony] [mentions] Task #${task_id} reassigned to @${mention_role}`);
    } else {
      const subtaskTitle = `[Mention] @${mention_role}: ${title}`;
      const subtaskDesc = `Created from mention by @${author_role} in task #${task_id}.\n\nContext:\n${content}`;

      const result = this.db.prepare(`
        INSERT OR IGNORE INTO sym_tasks (project_id, parent_id, title, description, type, status, assigned_role, priority, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'subtask', 'backlog', ?, 50, datetime('now'), datetime('now'))
      `).run(project_id, task_id, subtaskTitle, subtaskDesc, mention_role);

      if (result.changes === 0) {
        console.log(`[symphony] [mentions] Subtask already exists for @${mention_role} in task #${task_id}, skipping`);
        const existing = this.db.prepare(`
          SELECT id FROM sym_tasks
          WHERE parent_id = ? AND title = ? AND type = 'subtask'
        `).get(task_id, subtaskTitle);

        this._auditLog(task_id, project_id, 'mention_subtask_exists', null,
          JSON.stringify({ subtask_id: existing?.id, mention_role }), 'system', null);
        return;
      }

      const subtaskId = result.lastInsertRowid;
      this._auditLog(task_id, project_id, 'mention_subtask_created', null,
        JSON.stringify({ subtask_id: subtaskId, mention_role }), 'system', null);

      this.broadcast({
        type: 'mention',
        taskId: task_id,
        role: mention_role,
        content,
        action: 'subtask_created',
        subtaskId
      });

      console.log(`[symphony] [mentions] Created subtask #${subtaskId} for @${mention_role} from task #${task_id}`);
    }
  }

  _getRoleStatuses(role) {
    const roleStatusMap = {
      'cto': ['analysis'],
      'pm': ['analysis'],
      'sm': ['analysis'],
      'analyst': ['analysis'],
      'architect': ['analysis', 'development'],
      'designer': ['design'],
      'backend-dev': ['development'],
      'frontend-dev': ['development'],
      'fullstack-dev': ['development'],
      'qa-engineer': ['qa'],
      'code-reviewer': ['code_review'],
      'devops': ['development', 'qa'],
      'human': ['uat'],
    };
    return roleStatusMap[role] || [];
  }

  // ── Auto-advance task/subtask from backlog to analysis ──
  // Epics → CTO/PM, stories → SM handle them from backlog.
  // But tasks/subtasks have no backlog handler — advance them to analysis automatically.

  _autoAdvanceBacklog() {
    const tasks = this.db.prepare(`
      SELECT t.* FROM sym_tasks t
      WHERE t.status = 'backlog'
        AND t.type IN ('task', 'subtask')
        AND NOT EXISTS (
          SELECT 1 FROM sym_task_deps d
          JOIN sym_tasks bt ON bt.id = d.blocker_id
          WHERE d.blocked_id = t.id AND bt.status NOT IN ('done', 'cancelled')
        )
    `).all();

    for (const task of tasks) {
      // Auto-assign role for analysis
      const autoRole = getAutoAssignedRole({ ...task, status: "analysis" });
      const elapsedMs = this._computeElapsedMs(task.id);

      this.db.prepare(`
        UPDATE sym_tasks
        SET status = 'analysis', assigned_role = COALESCE(?, assigned_role), version = version + 1, updated_at = datetime('now')
        WHERE id = ? AND status = 'backlog'
      `).run(autoRole, task.id);

      // System comment
      const elapsedStr = elapsedMs != null ? ` (elapsed: ${formatDuration(elapsedMs)})` : '';
      this.db.prepare(`
        INSERT INTO sym_comments (task_id, content, type)
        VALUES (?, ?, 'system')
      `).run(task.id, `Auto-advanced from backlog to analysis (task/subtask auto-pipeline)${elapsedStr}`);

      // Audit log
      this._auditLog(task.id, task.project_id, "status_change", "backlog", "analysis", "system", null, elapsedMs);

      this.broadcast({ type: "task_updated", taskId: task.id, status: "analysis" });
    }
  }

  // ── Auto-advance parents ──

  _autoAdvance() {
    // Find parents (epic/story) where ALL children are done
    const parents = this.db.prepare(`
      SELECT p.id, p.type, p.status, p.project_id, p.title
      FROM sym_tasks p
      WHERE p.type IN ('epic', 'story')
        AND p.status NOT IN ('done', 'cancelled')
        AND (SELECT COUNT(*) FROM sym_tasks c WHERE c.parent_id = p.id) > 0
        AND (SELECT COUNT(*) FROM sym_tasks c WHERE c.parent_id = p.id AND c.status != 'done' AND c.status != 'cancelled') = 0
    `).all();

    for (const p of parents) {
      const elapsedMs = this._computeElapsedMs(p.id);

      // Advance to done
      this.db.prepare(`
        UPDATE sym_tasks SET status = 'done', next_retry_at = NULL, version = version + 1, updated_at = datetime('now')
        WHERE id = ? AND status != 'done'
      `).run(p.id);

      // System comment
      const elapsedStr = elapsedMs != null ? ` (elapsed: ${formatDuration(elapsedMs)})` : '';
      this.db.prepare(`
        INSERT INTO sym_comments (task_id, content, type)
        VALUES (?, ?, 'system')
      `).run(p.id, `All children completed. ${p.type} auto-advanced to done.${elapsedStr}`);

      // Audit log
      this._auditLog(p.id, p.project_id, "status_change", p.status, "done", "system", null, elapsedMs);

      this.broadcast({ type: "task_updated", taskId: p.id, status: "done" });

      // Hub capture: auto-create Hub note for completed parent
      this._captureToHub(p.id);

      // Epic completion notification
      if (p.type === "epic") {
        const epicProject = this.db.prepare("SELECT slug FROM sym_projects WHERE id = ?").get(p.project_id);
        this.broadcast({
          type: "epic_completed",
          projectId: p.project_id,
          projectSlug: epicProject?.slug || null,
          epicId: p.id,
          title: p.title,
        });

        // Chat message
        if (p.project_id) {
          const epicText = `🎉 Epic #${p.id} "${p.title}" completed! All stories and tasks are done.`;
          const epicMsgResult = this.db.prepare(`
            INSERT INTO sym_chat_messages (project_id, author_role, content)
            VALUES (?, ?, ?)
          `).run(p.project_id, 'scrum_master', epicText);
          const epicMsgId = Number(epicMsgResult.lastInsertRowid) || Date.now();

          const smName = 'Scrum Master';
          const smColorIndex = 'scrum_master'.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % 8;

          this.broadcast({
            type: 'chat_message',
            message: {
              id: epicMsgId,
              text: epicText,
              createdAt: new Date().toISOString(),
              user: {
                id: 0,
                login: 'scrum_master',
                firstName: smName,
                lastName: '',
                role: 'agent',
                colorIndex: smColorIndex,
              },
              attachments: [],
              agentRole: 'scrum_master',
              projectId: p.project_id,
            },
          });
        }

        console.log(`[symphony] Epic #${p.id} "${p.title}" completed!`);
      }
    }
  }

  // ── Config Validation ──

  _validateConfig() {
    // Check roles exist
    const roleCount = this.db.prepare("SELECT COUNT(*) as c FROM sym_agent_roles").get().c;
    if (roleCount === 0) {
      console.warn("[symphony] No agent roles defined!");
    }

    // Check orchestrator config
    const orch = this.db.prepare("SELECT * FROM sym_orchestrator WHERE id = 1").get();
    if (orch.max_concurrent_agents < 1 || orch.max_concurrent_agents > 10) {
      this.db.prepare("UPDATE sym_orchestrator SET max_concurrent_agents = 5 WHERE id = 1").run();
    }
  }

  // ── Dispatch ──

  _dispatch() {
    // Check cooldown
    if (Date.now() < this.cooldownUntil) return;

    const orch = this.db.prepare("SELECT * FROM sym_orchestrator WHERE id = 1").get();
    if (orch.status !== "running") return;

    const maxConcurrent = orch.max_concurrent_agents || 5;
    const availableSlots = maxConcurrent - this.activeAgents.size;
    if (availableSlots <= 0) return;

    // Find dispatchable tasks (including pending_cancel for reviewer)
    // Skip epics/stories with children — they wait for _autoAdvance to done
    // Skip tasks with needs_human_review — they wait for human input
    const tasks = this.db.prepare(`
      SELECT t.*,
        (SELECT COUNT(*) FROM sym_tasks c WHERE c.parent_id = t.id) as children_count
      FROM sym_tasks t
      WHERE t.status NOT IN ('done', 'cancelled', 'backlog', 'uat', 'failed')
        AND t.assigned_role IS NOT NULL
        AND t.attempt < 3
        AND (t.next_retry_at IS NULL OR t.next_retry_at <= datetime('now'))
        AND (t.needs_human_review IS NULL OR t.needs_human_review = 0)
        AND t.needs_human_review = 0
        AND (t.needs_human_review IS NULL OR t.needs_human_review = 0)
        AND NOT EXISTS (
          SELECT 1 FROM sym_agent_sessions
          WHERE task_id = t.id AND status IN ('starting', 'running')
        )
        AND NOT EXISTS (
          SELECT 1 FROM sym_task_deps d
          JOIN sym_tasks bt ON bt.id = d.blocker_id
          WHERE d.blocked_id = t.id AND bt.status NOT IN ('done', 'cancelled')
        )
        AND NOT (
          t.type IN ('epic', 'story')
          AND (SELECT COUNT(*) FROM sym_tasks c WHERE c.parent_id = t.id) > 0
        )
      ORDER BY t.priority DESC, t.type ASC, t.updated_at ASC
      LIMIT ?
    `).all(availableSlots);

    // Also check backlog tasks that need auto-assignment (epic/story in backlog)
    const backlogTasks = this.db.prepare(`
      SELECT t.*
      FROM sym_tasks t
      WHERE t.status = 'backlog'
        AND t.type IN ('epic', 'story')
        AND t.attempt < 3
        AND (t.next_retry_at IS NULL OR t.next_retry_at <= datetime('now'))
        AND NOT EXISTS (
          SELECT 1 FROM sym_agent_sessions
          WHERE task_id = t.id AND status IN ('starting', 'running')
        )
        AND (SELECT COUNT(*) FROM sym_tasks c WHERE c.parent_id = t.id) = 0
      ORDER BY t.priority DESC, t.created_at ASC
      LIMIT ?
    `).all(Math.max(0, availableSlots - tasks.length));

    const allTasks = [...tasks, ...backlogTasks].slice(0, availableSlots);

    // Prepared statement for per-role concurrency check — hoisted outside loop
    const countActiveForRoleStmt = this.db.prepare(`
      SELECT COUNT(*) as cnt FROM sym_agent_sessions s
      JOIN sym_tasks t ON t.id = s.task_id
      WHERE s.status IN ('starting', 'running')
        AND t.assigned_role = ?
    `);

    for (const task of allTasks) {
      // Auto-assign role if not set
      if (!task.assigned_role) {
        const autoRole = getAutoAssignedRole(task);
        if (autoRole) {
          this.db.prepare("UPDATE sym_tasks SET assigned_role = ? WHERE id = ?").run(autoRole, task.id);
          task.assigned_role = autoRole;
        } else {
          continue; // can't dispatch without role
        }
      }

      // Get role
      const role = this.db.prepare("SELECT * FROM sym_agent_roles WHERE slug = ?").get(task.assigned_role);
      if (!role) {
        console.warn(`[symphony] Role "${task.assigned_role}" not found for task ${task.id}`);
        continue;
      }

      // Per-role concurrency check
      if (role.max_concurrent !== null && role.max_concurrent !== undefined) {
        const activeForRole = countActiveForRoleStmt.get(task.assigned_role).cnt;
        if (activeForRole >= role.max_concurrent) {
          console.log(`[symphony] Skipping task ${task.id} — role "${task.assigned_role}" at concurrency limit (${activeForRole}/${role.max_concurrent})`);
          continue;
        }
      }

      // Get project
      const project = this.db.prepare("SELECT * FROM sym_projects WHERE id = ?").get(task.project_id);

      // Check per-project agent cap
      if (project?.max_agents) {
        const projectAgents = Array.from(this.activeAgents.values()).filter(a => {
          const t = this.db.prepare("SELECT project_id FROM sym_tasks WHERE id = ?").get(a.taskId);
          return t && t.project_id === project.id;
        }).length;
        if (projectAgents >= project.max_agents) continue;
      }

      // Optimistic lock: increment attempt + version
      const updated = this.db.prepare(`
        UPDATE sym_tasks SET attempt = attempt + 1, version = version + 1, updated_at = datetime('now')
        WHERE id = ? AND version = ?
      `).run(task.id, task.version);

      if (updated.changes === 0) continue; // version conflict, skip

      // Spawn agent (async)
      this._spawnAndTrack(task, role, project);
    }
  }

  // Phase 1.1: Fix activeAgents key inconsistency — use session ID from DB immediately
  async _spawnAndTrack(task, role, project) {
    // Setup worktree if applicable
    if (project?.repo_path) {
      this.runner.setupWorktree(task, project);
    }

    // Create session in DB first to get the real ID
    const sessionRow = this.db.prepare(`
      INSERT INTO sym_agent_sessions (task_id, role_slug, status, started_at, last_activity_at)
      VALUES (?, ?, 'starting', datetime('now'), datetime('now'))
    `).run(task.id, role.slug);
    const sessionId = sessionRow.lastInsertRowid;

    // Add to activeAgents with real session ID immediately
    this.activeAgents.set(sessionId, { taskId: task.id, pid: null, role: role.slug });
    this._updateActiveCount();

    try {
      const result = await this.runner.runWithSession(task, role, project, sessionId);

      // Remove from active
      this.activeAgents.delete(sessionId);
      this._updateActiveCount();

      // Check for rate limit — detect all known patterns
      const rlText = ((result.parsed?.error || "") + " " + (result.parsed?.summary || "")).toLowerCase();
      const isRateLimited = result.parsed?.status === "rate_limited"
        || rlText.includes("rate_limited") || rlText.includes("rate limit")
        || rlText.includes("out of extra usage") || rlText.includes("out of usage")
        || rlText.includes("resets") || rlText.includes("overloaded")
        || result.exitCode === 429 || result.exitCode === 529;

      if (isRateLimited) {
        // Roll back attempt — this wasn't a real failure
        this.db.prepare("UPDATE sym_tasks SET attempt = attempt - 1 WHERE id = ? AND attempt > 0").run(task.id);
        this._handleRateLimit(result.parsed?.error || result.parsed?.raw_output || "");
        // Update session as failed (rate_limited not in CHECK constraint)
        this.db.prepare(`
          UPDATE sym_agent_sessions SET status = 'failed', finished_at = datetime('now'), error = ? WHERE id = ?
        `).run("rate_limited: " + (result.parsed?.error || ""), sessionId);
        console.log(`[symphony] Task ${task.id} rate-limited — attempt rolled back, will retry after cooldown`);
        return;
      } else {
        if (this.consecutiveRateLimits > 0) {
          this.consecutiveRateLimits = 0;
          this._recoverRateLimitedTasks();
        }
      }

      // Refresh task from DB
      const freshTask = this.db.prepare("SELECT * FROM sym_tasks WHERE id = ?").get(task.id);
      if (freshTask) {
        // Log retry if failed — with exponential backoff
        if (result.parsed.status === "failed") {
          // Compute exponential backoff delay
          // attempt is post-increment: 1 = first failure, 2 = second, >=3 = DLQ
          const backoffMinutes = freshTask.attempt === 1 ? 1 : 5;
          const nextRetryAt = freshTask.attempt < 3
            ? this.db.prepare("SELECT datetime('now', ?) as t").get(`+${backoffMinutes} minutes`).t
            : null;

          this.db.prepare(`
            INSERT INTO sym_retry_log (task_id, attempt, error_reason, error_log, exit_code, duration_seconds, scheduled_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(
            task.id,
            freshTask.attempt,
            result.parsed.error || result.parsed.summary,
            (result.parsed.raw_output || "").slice(-5000),
            result.exitCode,
            null,
            nextRetryAt
          );

          // Update task error_log and next_retry_at
          this.db.prepare("UPDATE sym_tasks SET error_log = ?, next_retry_at = ?, updated_at = datetime('now') WHERE id = ?")
            .run(result.parsed.error || result.parsed.summary, nextRetryAt, task.id);

          if (nextRetryAt) {
            console.log(`[symphony] Task ${task.id} backoff: retry after ${backoffMinutes}min (attempt ${freshTask.attempt})`);
          }
        }

        // Queue completion processing
        this._completionQueue.push({
          task: freshTask,
          parsed: result.parsed,
          session: {
            id: sessionId,
            role_slug: role.slug,
            tokens_in: result.parsed._tokens_in || 0,
            tokens_out: result.parsed._tokens_out || 0,
            cost_usd: result.parsed._cost_usd || 0,
          },
        });
      }
    } catch (err) {
      this.activeAgents.delete(sessionId);
      this._updateActiveCount();
      // Update session as failed
      this.db.prepare(`
        UPDATE sym_agent_sessions SET status = 'failed', finished_at = datetime('now'), error = ? WHERE id = ?
      `).run(err.message, sessionId);
      // Apply backoff for exception-based failures too
      const taskAfterErr = this.db.prepare("SELECT attempt FROM sym_tasks WHERE id = ?").get(task.id);
      if (taskAfterErr && taskAfterErr.attempt < 3) {
        const backoffMinutes = taskAfterErr.attempt === 1 ? 1 : 5;
        const nextRetryAt = this.db.prepare("SELECT datetime('now', ?) as t").get(`+${backoffMinutes} minutes`).t;
        this.db.prepare("UPDATE sym_tasks SET next_retry_at = ?, error_log = ? WHERE id = ?")
          .run(nextRetryAt, String(err.message).slice(0, 500), task.id);
        console.log(`[symphony] Task ${task.id} backoff (exception): retry after ${backoffMinutes}min (attempt ${taskAfterErr.attempt})`);
      }
      console.error(`[symphony] Agent error for task ${task.id}:`, err.message);

      // Safely update session — wrap in try to never crash the orchestrator
      try {
        this.db.prepare(`
          UPDATE sym_agent_sessions SET status = 'failed', finished_at = datetime('now'), error = ? WHERE id = ?
        `).run(String(err.message).slice(0, 500), sessionId);
      } catch (dbErr) {
        console.error(`[symphony] DB error updating session ${sessionId}:`, dbErr.message);
      }

      // Check if task should be permanently failed (dead letter queue)
      try {
        const crashedTask = this.db.prepare("SELECT * FROM sym_tasks WHERE id = ?").get(task.id);
        if (crashedTask && crashedTask.attempt >= 3) {
          this._handleTaskFailure(crashedTask, { role_slug: role.slug }, { error: err.message, summary: "Process crashed" });
        }
      } catch (dlqErr) {
        console.error(`[symphony] DLQ error for task ${task.id}:`, dlqErr.message);
      }
    }
  }

  // ── Rate Limiting — Phase 1.2: with recovery ──

  _handleRateLimit(errorMessage) {
    this.consecutiveRateLimits++;
    this._lastRateLimitTime = Date.now();
    console.warn(`[symphony] Rate limit hit (${this.consecutiveRateLimits} consecutive)`);

    // Parse reset time from message if available
    let pauseMs;
    const resetTimeMatch = (errorMessage || "").match(/resets?\s+(?:at\s+)?(\d{1,2})\s*(?::(\d{2}))?\s*(am|pm)?\s*\(?(UTC)?\)?/i);
    const resetInMatch = (errorMessage || "").match(/resets?\s+in\s+(\d+)\s*min/i);

    if (resetInMatch) {
      pauseMs = Math.min(parseInt(resetInMatch[1]) * 60000, 30 * 60000);
    } else if (resetTimeMatch) {
      let hours = parseInt(resetTimeMatch[1]);
      const minutes = parseInt(resetTimeMatch[2] || "0");
      const ampm = (resetTimeMatch[3] || "").toLowerCase();
      if (ampm === "pm" && hours < 12) hours += 12;
      if (ampm === "am" && hours === 12) hours = 0;
      const now = new Date();
      const resetUtc = new Date(now);
      resetUtc.setUTCHours(hours, minutes, 0, 0);
      if (resetUtc <= now) resetUtc.setUTCDate(resetUtc.getUTCDate() + 1);
      pauseMs = Math.min(resetUtc - now, 30 * 60000); // cap at 30 min
    } else if (this.consecutiveRateLimits >= 3) {
      pauseMs = 30 * 60000; // 30 minutes for persistent rate limits
    } else {
      pauseMs = COOLDOWN_DURATION; // 1 minute for single rate limit
    }

    this.pausedUntil = Date.now() + pauseMs;
    const pauseMin = Math.round(pauseMs / 60000);
    console.warn(`[symphony] Pausing for ${pauseMin} minutes (consecutive: ${this.consecutiveRateLimits})`);
    this.broadcast({
      type: "rate_limited",
      duration: pauseMs,
      message: `Rate limited, pausing for ${pauseMin} min (hit #${this.consecutiveRateLimits})`,
    });

    // Reduce concurrent slots (but remember original)
    if (this._originalMaxAgents === null) {
      const orch = this.db.prepare("SELECT max_concurrent_agents FROM sym_orchestrator WHERE id = 1").get();
      this._originalMaxAgents = orch?.max_concurrent_agents || 5;
    }
    const orch = this.db.prepare("SELECT max_concurrent_agents FROM sym_orchestrator WHERE id = 1").get();
    const newMax = Math.max(1, (orch?.max_concurrent_agents || 5) - 1);
    this.db.prepare("UPDATE sym_orchestrator SET max_concurrent_agents = ? WHERE id = 1").run(newMax);
  }

  // Phase 1.2: Recovery — every 2 minutes without rate limit, restore +1 slot
  _recoverRateLimitSlots() {
    if (!this._originalMaxAgents) return;
    if (Date.now() - this._lastRateLimitTime < RATE_LIMIT_RECOVERY_INTERVAL) return;

    const orch = this.db.prepare("SELECT max_concurrent_agents FROM sym_orchestrator WHERE id = 1").get();
    if (!orch) return;

    if (orch.max_concurrent_agents < this._originalMaxAgents) {
      const newMax = Math.min(this._originalMaxAgents, orch.max_concurrent_agents + 1);
      this.db.prepare("UPDATE sym_orchestrator SET max_concurrent_agents = ? WHERE id = 1").run(newMax);
      console.log(`[symphony] Rate limit recovery: slots ${orch.max_concurrent_agents} → ${newMax} (original: ${this._originalMaxAgents})`);
    }
  }

  // Auto-recover tasks that were killed solely by rate limits
  _recoverRateLimitedTasks() {
    const recovered = this.db.prepare(`
      UPDATE sym_tasks
      SET attempt = 0, error_log = NULL, next_retry_at = NULL
      WHERE attempt >= 3
        AND status NOT IN ('done', 'cancelled')
        AND error_log LIKE '%rate_limited%'
    `).run();

    if (recovered.changes > 0) {
      console.log(`[symphony] Auto-recovered ${recovered.changes} tasks previously killed by rate limits`);
      this.broadcast({
        type: "tasks_recovered",
        count: recovered.changes,
        message: `${recovered.changes} rate-limited tasks recovered and will retry`,
      });
    }
  }

  // ── Mention Detection ──

  _extractMentions(content) {
    // Match ONLY @role-slug or @alias forms (case-insensitive)
    // Plain role names are NOT matched to prevent false positives in casual Russian chat
    // Decision documented in spec-extractmentions-decision.md (task #272)
    const ROLE_ALIASES = {
      'cto':          ['cto', 'chief-technology-officer'],
      'pm':           ['pm', 'product-manager'],
      'scrum-master': ['scrum-master', 'sm'],
      'analyst':      ['analyst'],
      'designer':     ['designer'],
      'frontend-dev': ['frontend-dev', 'frontend', 'front-end'],
      'backend-dev':  ['backend-dev', 'backend', 'back-end'],
      'reviewer':     ['reviewer'],
      'qa':           ['qa', 'qa-engineer'],
    };

    const lower = content.toLowerCase();
    const found = [];
    for (const [slug, aliases] of Object.entries(ROLE_ALIASES)) {
      if (aliases.some(a => lower.includes('@' + a))) {
        found.push(slug);
      }
    }
    return [...new Set(found)];
  }

  // ── Team Chat (periodic fun messages from agent personalities) ──

  _getMoodModifier(role, recentDone, blockers, recentReviews) {
    const doneTasks = recentDone.filter(t => t.assigned_role === role);
    const isBlocked = blockers.some(t => t.assigned_role === role);
    const reviewedByMe = recentReviews.filter(r => r.author_role === role);

    // FIX(#171): QA mood uses doneTasks (role-filtered) instead of recentDone (all tasks)
    if (role === 'qa' && doneTasks.length > 0) return 'Настроение: поймал много багов, немного злорадствуешь.';
    if (role === 'reviewer' && reviewedByMe.length > 0 && blockers.length === 0) return 'Настроение: доволен собой, ревью прошло чисто.';
    if (isBlocked) return 'Настроение: слегка раздражён, задача застряла.';
    if (doneTasks.length > 0) return 'Настроение: уверен в себе, только что завершил задачи.';
    if (recentDone.length === 0 && blockers.length > 0) return 'Настроение: саркастичный, всё идёт медленно.';
    return ''; // neutral
  }

  _teamChat() {
    // Get projects with recent activity
    const projects = this.db.prepare(`
      SELECT DISTINCT p.id, p.name, p.slug FROM sym_projects p
      JOIN sym_tasks t ON t.project_id = p.id
      WHERE t.updated_at > datetime('now', '-30 minutes')
      AND p.status = 'active'
    `).all();

    if (projects.length === 0) return;

    // Pick a random project
    const project = projects[Math.floor(Math.random() * projects.length)];

    // Get recent activity context
    const recentComments = this.db.prepare(`
      SELECT c.author_role, c.content, c.type FROM sym_comments c
      JOIN sym_tasks t ON t.id = c.task_id
      WHERE t.project_id = ? AND c.created_at > datetime('now', '-30 minutes')
      ORDER BY c.created_at DESC LIMIT 5
    `).all(project.id);

    const recentTasks = this.db.prepare(`
      SELECT t.title, t.status, t.type, t.assigned_role FROM sym_tasks t
      WHERE t.project_id = ? AND t.updated_at > datetime('now', '-30 minutes')
      ORDER BY t.updated_at DESC LIMIT 5
    `).all(project.id);

    const activeAgentRoles = this.db.prepare(`
      SELECT DISTINCT s.role_slug FROM sym_agent_sessions s
      JOIN sym_tasks t ON t.id = s.task_id
      WHERE t.project_id = ? AND s.status IN ('starting', 'running')
    `).all(project.id).map(r => r.role_slug);

    // Context enrichment queries (wrapped in try/catch with empty-array fallback)
    let recentDone = [];
    try {
      recentDone = this.db.prepare(`
        SELECT title, assigned_role, status FROM sym_tasks
        WHERE project_id = ? AND updated_at > datetime('now', '-1 hour') AND status = 'done'
        ORDER BY updated_at DESC LIMIT 5
      `).all(project.id);
    } catch {}

    let blockers = [];
    try {
      blockers = this.db.prepare(`
        SELECT title, assigned_role FROM sym_tasks
        WHERE project_id = ? AND status = 'blocked'
        ORDER BY updated_at DESC LIMIT 3
      `).all(project.id);
    } catch {}

    let recentReviews = [];
    try {
      recentReviews = this.db.prepare(`
        SELECT t.title, c.author_role FROM sym_comments c
        JOIN sym_tasks t ON c.task_id = t.id
        WHERE t.project_id = ? AND c.type = 'review'
          AND c.created_at > datetime('now', '-1 hour')
        ORDER BY c.created_at DESC LIMIT 3
      `).all(project.id);
    } catch {}

    // Pick a random role that has been active recently
    const allRoles = [...new Set([
      ...recentTasks.map(t => t.assigned_role).filter(Boolean),
      ...recentComments.map(c => c.author_role).filter(Boolean),
      ...activeAgentRoles,
    ])];

    if (allRoles.length === 0) return;
    const role = allRoles[Math.floor(Math.random() * allRoles.length)];
    const personalityData = ROLE_PERSONALITIES[role];
    if (!personalityData) return;

    const personalityText = typeof personalityData === "string"
      ? personalityData
      : personalityData.personality;

    // Build dynamics context (pick 1-2 dynamics for currently active roles)
    const dynamicsLines = [];
    if (personalityData.dynamics) {
      for (const activeRole of activeAgentRoles.slice(0, 2)) {
        const dynamic = personalityData.dynamics[activeRole];
        if (dynamic) dynamicsLines.push(`- Про ${activeRole}: ${dynamic}`);
      }
    }

    // Mood modifier from recent events
    const mood = getMoodModifiers(this.db, role, project.id);

    // Topic rotation
    const TOPIC_TYPES = ['work', 'casual', 'casual', 'complaint', 'insight', 'celebration'];
    const idx = this._topicRotation[project.id] || 0;
    let messageType = TOPIC_TYPES[idx % TOPIC_TYPES.length];
    this._topicRotation[project.id] = idx + 1;
    if (recentDone.length >= 3) messageType = 'celebration';

    // Build enriched context summary
    const contextLines = [];
    if (recentDone.length > 0) {
      contextLines.push(`Завершено за последний час: ${recentDone.map(t => `"${t.title}" (${t.assigned_role})`).join(', ')}.`);
    }
    if (blockers.length > 0) {
      contextLines.push(`Застряло: ${blockers.map(t => `"${t.title}"`).join(', ')}.`);
    }
    if (recentReviews.length > 0) {
      contextLines.push(`Недавние ревью: ${recentReviews.map(r => `${r.author_role} смотрел "${r.title}"`).join(', ')}.`);
    }
    for (const t of recentTasks.slice(0, 3)) {
      contextLines.push(`- ${t.type} "${t.title}" → ${t.status}`);
    }
    if (activeAgentRoles.length > 0) {
      contextLines.push(`Сейчас работают: ${activeAgentRoles.join(', ')}.`);
    }

    const context = contextLines.join("\n") || "Команда работает над проектом";

    // Spawn a quick haiku call for chat message
    this._generateChatMessage(project, role, personalityText, context, dynamicsLines, mood);
  }

  async _generateChatMessage(project, role, personality, context, dynamicsLines = [], mood = 'default') {
    try {
      let claudeBin;
      try {
        claudeBin = execSync("which claude", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
      } catch {
        claudeBin = "/usr/bin/claude";
      }

      // Resolve personality base and mood modifier (backward-compatible with string and object forms)
      let personalityBase, moodModifier;
      if (typeof personality === 'string') {
        personalityBase = personality;
        moodModifier = ROLE_MOODS?.[role]?.[mood] || ROLE_MOODS?.[role]?.default || '';
      } else {
        personalityBase = personality.base;
        moodModifier = personality.moods?.[mood] || personality.moods?.default || '';
      }

      const moodLine = moodModifier ? `\nСейчас твоё состояние: ${moodModifier}` : '';
      const dynamicsSection = dynamicsLines.length
        ? `\nКак ты относишься к коллегам:\n${dynamicsLines.join("\n")}`
        : "";

      const prompt = `${personalityBase}${moodLine}${dynamicsSection}

Контекст — что сейчас происходит в проекте "${project.name}":
${context}

Если хочешь обратиться к конкретному коллеге, используй @role-slug: @cto, @pm, @scrum-master, @analyst, @designer, @frontend-dev, @backend-dev, @reviewer, @qa

Напиши ОДНО короткое сообщение (1-2 предложения) в командный чат. По-русски. Живое, с характером и юмором.
НЕ пиши ничего кроме самого сообщения. Никаких пояснений, кавычек, префиксов.`;

      const { spawn: spawnProc } = require("child_process");
      const child = spawnProc(claudeBin, ["-p", prompt, "--model", "haiku", "--output-format", "stream-json"], {
        cwd: WORKSPACES_ROOT,
        env: { ...process.env, CLAUDECODE: "" },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      child.stdout.on("data", (data) => { stdout += data.toString(); });

      child.on("close", (code) => {
        if (code !== 0) return;

        // Extract text from stream-json
        let text = "";
        for (const line of stdout.split("\n")) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event.type === "assistant" && event.message?.content) {
              for (const block of event.message.content) {
                if (block.type === "text") text += block.text;
              }
            }
            if (event.type === "result" && typeof event.result === "string") {
              text += event.result;
            }
          } catch {}
        }

        text = text.trim();
        if (!text || text.length > 500) return;

        // Save to DB
        try {
          this.db.prepare(`
            INSERT INTO sym_chat_messages (project_id, author_role, content, type)
            VALUES (?, ?, ?, ?)
          `).run(project.id, role, text, 'work');
        } catch {
          // Fallback if type column doesn't exist yet
          this.db.prepare(`
            INSERT INTO sym_chat_messages (project_id, author_role, content)
            VALUES (?, ?, ?)
          `).run(project.id, role, text);
        }

        this.broadcast({
          type: "chat_message",
          projectId: project.id,
          role,
          content: text,
        });

        console.log(`[symphony] Team chat (${role}): ${text.slice(0, 80)}...`);
      });

      // Kill if takes too long (30s)
      setTimeout(() => {
        try { child.kill("SIGTERM"); } catch {}
      }, 30000);

    } catch (err) {
      console.error("[symphony] Team chat error:", err.message);
    }
  }

  // ── Watercooler Chat (cross-project banter between agents) ──

  _watercoolerChat() {
    // Need at least 2 active projects with agents in the last 2 hours
    const activeProjects = this.db.prepare(`
      SELECT DISTINCT p.id, p.name, p.slug FROM sym_projects p
      JOIN sym_tasks t ON t.project_id = p.id
      WHERE t.updated_at > datetime('now', '-2 hours')
      AND p.status = 'active'
    `).all();

    if (activeProjects.length < 2) return;

    // Get agents who were active across different projects recently
    const recentAgents = this.db.prepare(`
      SELECT DISTINCT s.role_slug, p.name as project_name, p.id as project_id
      FROM sym_agent_sessions s
      JOIN sym_tasks t ON t.id = s.task_id
      JOIN sym_projects p ON p.id = t.project_id
      WHERE s.started_at > datetime('now', '-2 hours')
      ORDER BY s.started_at DESC
      LIMIT 20
    `).all();

    if (recentAgents.length < 2) return;

    // Pick two agents from different projects
    const shuffled = recentAgents.sort(() => Math.random() - 0.5);
    let agent1 = shuffled[0];
    let agent2 = shuffled.find(a => a.project_id !== agent1.project_id);
    if (!agent2) return;

    const personality1 = ROLE_PERSONALITIES[agent1.role_slug];
    const personality2 = ROLE_PERSONALITIES[agent2.role_slug];
    if (!personality1) return;

    // The first agent initiates the watercooler message
    const role = agent1.role_slug;

    // Build cross-project context
    const contextLines = [
      `Ты сейчас работаешь над проектом "${agent1.project_name}".`,
      `В соседнем проекте "${agent2.project_name}" работает ${agent2.role_slug}.`,
    ];

    // Add some recent task context
    const recentTasks = this.db.prepare(`
      SELECT t.title, t.status, t.type, p.name as project_name
      FROM sym_tasks t
      JOIN sym_projects p ON p.id = t.project_id
      WHERE t.updated_at > datetime('now', '-1 hour')
      AND t.status NOT IN ('done', 'cancelled', 'backlog')
      ORDER BY t.updated_at DESC LIMIT 5
    `).all();

    for (const t of recentTasks.slice(0, 3)) {
      contextLines.push(`- ${t.type} "${t.title}" (${t.project_name}) — ${t.status}`);
    }

    const context = contextLines.join("\n");

    this._generateWatercoolerMessage(role, personality1, context, agent2.role_slug);
  }

  async _generateWatercoolerMessage(role, personality, context, otherRole) {
    try {
      let claudeBin;
      try {
        claudeBin = execSync("which claude", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
      } catch {
        claudeBin = "/usr/bin/claude";
      }

      const prompt = `${personality}

Контекст — кросс-проектная ситуация:
${context}

Это WATERCOOLER — неформальный кросс-проектный чат. Ты общаешься с агентами из ДРУГИХ проектов. Напиши ОДНО короткое сообщение (1-2 предложения) по-русски. Можешь:
- Пошутить про работу в разных проектах одновременно
- Обсудить что-то общее между проектами
- Пожаловаться на общие проблемы (дедлайны, рефакторинг, баги)
- Поприветствовать коллег из соседнего проекта
- Философствовать про жизнь AI-агентов
- Спросить у ${otherRole} как дела в их проекте

НЕ пиши ничего кроме самого сообщения. Никаких пояснений, кавычек, префиксов.`;

      const { spawn: spawnProc } = require("child_process");
      const child = spawnProc(claudeBin, ["-p", prompt, "--model", "haiku", "--output-format", "stream-json"], {
        cwd: WORKSPACES_ROOT,
        env: { ...process.env, CLAUDECODE: "" },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      child.stdout.on("data", (data) => { stdout += data.toString(); });

      child.on("close", (code) => {
        if (code !== 0) return;

        // Extract text from stream-json
        let text = "";
        for (const line of stdout.split("\n")) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event.type === "assistant" && event.message?.content) {
              for (const block of event.message.content) {
                if (block.type === "text") text += block.text;
              }
            }
            if (event.type === "result" && typeof event.result === "string") {
              text += event.result;
            }
          } catch {}
        }

        text = text.trim();
        if (!text || text.length > 500) return;

        // Save to DB with project_id = NULL (watercooler)
        const result = this.db.prepare(`
          INSERT INTO sym_chat_messages (project_id, author_role, content)
          VALUES (NULL, ?, ?)
        `).run(role, text);

        // Broadcast to all clients (no projectId filter for watercooler)
        this.broadcast({
          type: "chat_message",
          channel: "watercooler",
          projectId: null,
          role,
          content: text,
          id: Number(result.lastInsertRowid),
        });

        console.log(`[symphony] Watercooler (${role}): ${text.slice(0, 80)}...`);
      });

      // Kill if takes too long (30s)
      setTimeout(() => {
        try { child.kill("SIGTERM"); } catch {}
      }, 30000);

    } catch (err) {
      console.error("[symphony] Watercooler chat error:", err.message);
    }
  }

  // ── Cleanup ──

  _cleanup() {
    // Cleanup old workspaces for done/cancelled tasks (older than 7 days)
    const oldTasks = this.db.prepare(`
      SELECT t.id, t.workspace_path, p.slug as project_slug, p.repo_path
      FROM sym_tasks t
      LEFT JOIN sym_projects p ON p.id = t.project_id
      WHERE t.status IN ('done', 'cancelled', 'failed')
        AND t.workspace_path IS NOT NULL
        AND t.updated_at < datetime('now', '-7 days')
    `).all();

    for (const t of oldTasks) {
      if (t.workspace_path && fs.existsSync(t.workspace_path)) {
        const doneMarker = path.join(t.workspace_path, ".done");
        if (fs.existsSync(doneMarker)) {
          try {
            fs.rmSync(t.workspace_path, { recursive: true, force: true });
            this.db.prepare("UPDATE sym_tasks SET workspace_path = NULL WHERE id = ?").run(t.id);
          } catch {}
        }
      }
    }

    // Prune git worktrees
    const projects = this.db.prepare("SELECT * FROM sym_projects WHERE repo_path IS NOT NULL").all();
    for (const p of projects) {
      if (fs.existsSync(p.repo_path)) {
        try { execSync("git worktree prune", { cwd: p.repo_path, stdio: "pipe" }); } catch {}
      }
    }
  }

  // ── Heartbeat ──

  _heartbeat() {
    this.db.prepare(`
      UPDATE sym_orchestrator
      SET last_tick_at = datetime('now'), tick_count = ?, active_agents = ?, updated_at = datetime('now')
      WHERE id = 1
    `).run(this.tickCount, this.activeAgents.size);
  }

  _updateActiveCount() {
    this.db.prepare("UPDATE sym_orchestrator SET active_agents = ? WHERE id = 1").run(this.activeAgents.size);
  }

  // ── Task Status Transitions ──

  _transitionTask(task, newStatus, byRole) {
    const valid = STATUS_TRANSITIONS[task.status];
    if (!valid || !valid.includes(newStatus)) {
      console.warn(`[symphony] Invalid transition: ${task.status} → ${newStatus} for task ${task.id}`);
      return false;
    }

    // Auto-assign for new status
    const autoRole = getAutoAssignedRole({ ...task, status: newStatus });

    const oldStatus = task.status;
    const elapsedMs = this._computeElapsedMs(task.id);

    this.db.prepare(`
      UPDATE sym_tasks
      SET status = ?, assigned_role = COALESCE(?, assigned_role), next_retry_at = NULL, version = version + 1, updated_at = datetime('now')
      WHERE id = ?
    `).run(newStatus, autoRole, task.id);

    // System comment with elapsed time
    const elapsedStr = elapsedMs != null ? ` (elapsed: ${formatDuration(elapsedMs)})` : '';
    this.db.prepare(`
      INSERT INTO sym_comments (task_id, author_role, content, type)
      VALUES (?, ?, ?, 'status_change')
    `).run(task.id, byRole, `Status: ${oldStatus} → ${newStatus}${elapsedStr}`);

    // Audit log
    this._auditLog(task.id, task.project_id, "status_change", oldStatus, newStatus, "agent", byRole, elapsedMs);

    this.broadcast({ type: "task_updated", taskId: task.id, status: newStatus });

    // Auto-merge worktree and hub capture when task reaches "done"
    if (newStatus === "done") {
      this._mergeWorktree(task);
      this._captureToHub(task.id);
    }

    return true;
  }

  // ── Elapsed Time Computation ──

  _computeElapsedMs(taskId) {
    try {
      const lastEntry = this.db.prepare(`
        SELECT created_at FROM sym_audit_log
        WHERE task_id = ? AND action = 'status_change'
        ORDER BY id DESC LIMIT 1
      `).get(taskId);
      if (lastEntry) return Date.now() - new Date(lastEntry.created_at + 'Z').getTime();
      const task = this.db.prepare('SELECT created_at FROM sym_tasks WHERE id = ?').get(taskId);
      return task ? Date.now() - new Date(task.created_at + 'Z').getTime() : null;
    } catch (err) {
      console.error("[symphony] Elapsed ms computation error:", err.message);
      return null;
    }
  }

  // ── Mention Processing ──

  async _processMentions() {
    const orch = this.db.prepare(
      "SELECT last_processed_mention_id FROM sym_orchestrator WHERE id = 1"
    ).get();
    const lastId = orch?.last_processed_mention_id || 0;

    const mentions = this.db.prepare(`
      SELECT c.id, c.task_id, c.mention_role, c.content, c.author_role,
             t.status, t.assigned_role, t.project_id, t.title
      FROM sym_comments c
      JOIN sym_tasks t ON t.id = c.task_id
      WHERE c.mention_role IS NOT NULL AND c.id > ?
      ORDER BY c.id ASC
    `).all(lastId);

    if (mentions.length === 0) return;

    let maxProcessedId = lastId;
    for (const mention of mentions) {
      try {
        this._handleMention(mention);
        maxProcessedId = Math.max(maxProcessedId, mention.id);
      } catch (err) {
        console.error(`[symphony] [mentions] Error processing mention ${mention.id}:`, err.message);
        break;
      }
    }

    if (maxProcessedId > lastId) {
      this.db.prepare(
        "UPDATE sym_orchestrator SET last_processed_mention_id = ? WHERE id = 1"
      ).run(maxProcessedId);
    }
  }

  _handleMention(mention) {
    const { id, task_id, mention_role, status } = mention;
    console.log(`[symphony] [mentions] Processing #${id}: @${mention_role} in task #${task_id} (${status})`);

    if (mention_role === 'human') {
      this._handleHumanMention(mention);
    } else {
      this._handleAgentMention(mention);
    }
  }

  _handleHumanMention(mention) {
    const { task_id, content, author_role, project_id } = mention;

    this.db.prepare(`
      UPDATE sym_tasks SET needs_human_review = 1, updated_at = datetime('now')
      WHERE id = ?
    `).run(task_id);

    this._auditLog(task_id, project_id, 'mention_human', null,
      JSON.stringify({ content, author_role }), 'system', null);

    this.broadcast({
      type: 'mention',
      taskId: task_id,
      role: 'human',
      content,
      authorRole: author_role,
      action: 'needs_human_review'
    });

    console.log(`[symphony] [mentions] Task #${task_id} flagged for human review`);
  }

  _handleAgentMention(mention) {
    const { task_id, mention_role, content, author_role, status, project_id, title } = mention;

    const roleStatuses = this._getRoleStatuses(mention_role);
    const canReassign = roleStatuses.includes(status);

    if (canReassign) {
      this.db.prepare(`
        UPDATE sym_tasks SET assigned_role = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(mention_role, task_id);

      this._auditLog(task_id, project_id, 'mention_reassign',
        author_role, mention_role, 'system', null);

      this.broadcast({
        type: 'mention',
        taskId: task_id,
        role: mention_role,
        content,
        authorRole: author_role,
        action: 'reassigned'
      });

      console.log(`[symphony] [mentions] Task #${task_id} reassigned to @${mention_role}`);
    } else {
      const subtaskTitle = `[Mention] @${mention_role}: ${title}`;
      const subtaskDesc = `Created from mention by @${author_role} in task #${task_id}.\n\nContext:\n${content}`;

      // Check for existing subtask to prevent duplicates (no UNIQUE index on parent_id,title)
      const existing = this.db.prepare(
        "SELECT id FROM sym_tasks WHERE parent_id = ? AND title = ?"
      ).get(task_id, subtaskTitle);

      let subtaskId;
      if (existing) {
        subtaskId = existing.id;
      } else {
        const result = this.db.prepare(`
          INSERT INTO sym_tasks (project_id, parent_id, title, description, type, status, assigned_role, priority, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'subtask', 'backlog', ?, 50, datetime('now'), datetime('now'))
        `).run(project_id, task_id, subtaskTitle, subtaskDesc, mention_role);
        subtaskId = result.lastInsertRowid;
      }

      this._auditLog(task_id, project_id, 'mention_subtask_created', null,
        JSON.stringify({ subtask_id: subtaskId, mention_role }), 'system', null);

      this.broadcast({
        type: 'mention',
        taskId: task_id,
        role: mention_role,
        content,
        authorRole: author_role,
        action: 'subtask_created',
        subtaskId
      });

      console.log(`[symphony] [mentions] Created subtask #${subtaskId} for @${mention_role} from task #${task_id}`);
    }
  }

  _getRoleStatuses(role) {
    const map = {
      'cto': ['analysis'],
      'pm': ['analysis'],
      'sm': ['analysis'],
      'analyst': ['analysis'],
      'architect': ['analysis', 'development'],
      'designer': ['design'],
      'backend-dev': ['development'],
      'frontend-dev': ['development'],
      'fullstack-dev': ['development'],
      'qa-engineer': ['qa'],
      'code-reviewer': ['code_review'],
      'devops': ['development', 'qa'],
      'human': ['uat'],
    };
    return map[role] || [];
  }

  // ── Audit Log ──

  _auditLog(taskId, projectId, action, oldValue, newValue, actorType, actorId, elapsedMs = null) {
    try {
      this.db.prepare(`
        INSERT INTO sym_audit_log (task_id, project_id, action, old_value, new_value, actor_type, actor_id, elapsed_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(taskId, projectId, action, oldValue, newValue, actorType, actorId, elapsedMs);
    } catch (err) {
      // Don't let audit log failures break the flow
      console.error("[symphony] Audit log error:", err.message);
    }
  }

  // ── Auto-merge worktree into main branch on task completion ──

  _mergeWorktree(task) {
    const project = this.db.prepare("SELECT * FROM sym_projects WHERE id = ?").get(task.project_id);
    if (!project?.repo_path || !fs.existsSync(project.repo_path)) return;

    const branch = `symphony/task-${task.id}`;
    const projectSlug = project?.slug || "default";
    const workspacePath = path.join(WORKSPACES_ROOT, projectSlug, `task-${task.id}`);

    if (!fs.existsSync(workspacePath)) return;

    try {
      // Check if worktree has any changes to merge
      const diffStat = execSync(`git diff HEAD --stat`, {
        cwd: workspacePath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
      }).trim();

      // Commit any uncommitted work in the worktree
      if (diffStat) {
        execSync(`git add -A && git reset HEAD -- CLAUDE.md .claude/ node_modules/ .next/ 2>/dev/null; git diff --cached --quiet || git commit -m "task-${task.id}: final changes" --no-verify`, {
          cwd: workspacePath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], shell: true,
        });
      }

      // Check if branch has commits beyond the base
      const mainBranch = project.default_branch || "feature/pos";
      const ahead = execSync(`git rev-list ${mainBranch}..${branch} --count`, {
        cwd: project.repo_path, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
      }).trim();

      if (ahead === "0") {
        console.log(`[symphony] Task ${task.id}: no changes to merge`);
        return;
      }

      // Try merge into main branch
      const result = execSync(`git merge ${branch} --no-edit --no-verify`, {
        cwd: project.repo_path, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
      });

      console.log(`[symphony] Task ${task.id}: merged ${branch} into ${mainBranch} (${ahead} commits)`);

      // Add system comment about merge
      this.db.prepare(`
        INSERT INTO sym_comments (task_id, content, type)
        VALUES (?, ?, 'system')
      `).run(task.id, `Auto-merged branch ${branch} into ${mainBranch}`);

      this.broadcast({ type: "task_merged", taskId: task.id, branch });

    } catch (err) {
      // Merge conflict — abort, don't auto-resolve (it breaks code)
      try {
        execSync("git merge --abort", { cwd: project.repo_path, stdio: "pipe" });
      } catch {}

      console.warn(`[symphony] Task ${task.id}: merge conflict for ${branch}, skipped (worktree preserved)`);

      this.db.prepare(`
        INSERT INTO sym_comments (task_id, content, type)
        VALUES (?, ?, 'system')
      `).run(task.id, `Merge of ${branch} had conflicts — skipped. Worktree preserved for manual merge.`);
    }
  }

  // ── Hub Capture ──

  _captureToHub(taskId) {
    const scriptPath = path.join(process.env.HOME || "/root", ".claude/scripts/task-to-hub.sh");
    const dbPath = path.join(__dirname, "data/claude-terminal.db");

    if (!fs.existsSync(scriptPath)) {
      console.warn("[symphony] task-to-hub.sh not found, skipping hub capture");
      return;
    }

    // Run async — don't block the orchestrator tick
    const { exec } = require("child_process");
    exec(`bash "${scriptPath}" ${taskId} "${dbPath}"`, { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) {
        console.error(`[symphony] Hub capture failed for task #${taskId}:`, stderr || err.message);
        return;
      }
      const hubPath = (stdout || "").trim();
      if (hubPath) {
        console.log(`[symphony] Hub note created for task #${taskId}: ${hubPath}`);
        this.broadcast({ type: "hub_note_created", taskId, path: hubPath });
      }
    });
  }

  // ── Mention Migrations ──

  _runMentionMigrations() {
    // Add last_processed_mention_id column if not exists
    const cols = this.db.prepare("PRAGMA table_info(sym_orchestrator)").all();
    if (!cols.find(c => c.name === 'last_processed_mention_id')) {
      this.db.prepare("ALTER TABLE sym_orchestrator ADD COLUMN last_processed_mention_id INTEGER DEFAULT 0").run();
      console.log("[symphony] Added last_processed_mention_id column to sym_orchestrator");
    }

    // Idempotent unique index for mention subtask deduplication
    this.db.prepare(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sym_tasks_parent_title_type
      ON sym_tasks(parent_id, title, type)
      WHERE parent_id IS NOT NULL
    `).run();
  }

  // ── Mention Processing ──

  _processMentions() {
    const orch = this.db.prepare("SELECT last_processed_mention_id FROM sym_orchestrator WHERE id = 1").get();
    const lastId = orch?.last_processed_mention_id || 0;

    const mentions = this.db.prepare(`
      SELECT c.id, c.task_id, c.mention_role, c.content, c.author_role,
             t.status, t.assigned_role, t.project_id, t.title
      FROM sym_comments c
      JOIN sym_tasks t ON t.id = c.task_id
      WHERE c.mention_role IS NOT NULL AND c.id > ?
      ORDER BY c.id ASC
    `).all(lastId);

    if (mentions.length === 0) return;

    let maxProcessedId = lastId;

    for (const mention of mentions) {
      try {
        this._handleMention(mention);
        maxProcessedId = Math.max(maxProcessedId, mention.id);
      } catch (err) {
        console.error(`[symphony] [mentions] Error processing mention ${mention.id}: ${err.message}`);
        break;
      }
    }

    if (maxProcessedId > lastId) {
      this.db.prepare("UPDATE sym_orchestrator SET last_processed_mention_id = ? WHERE id = 1")
        .run(maxProcessedId);
    }
  }

  _handleMention(mention) {
    const { id, task_id, mention_role, status } = mention;

    console.log(`[symphony] [mentions] Processing mention #${id}: @${mention_role} in task #${task_id} (status: ${status})`);

    if (mention_role === 'human') {
      this._handleHumanMention(mention);
      return;
    }

    this._handleAgentMention(mention);
  }

  _handleHumanMention(mention) {
    const { task_id, content, author_role, project_id } = mention;

    this.db.prepare(`
      UPDATE sym_tasks SET needs_human_review = 1, updated_at = datetime('now')
      WHERE id = ?
    `).run(task_id);

    this._auditLog(task_id, project_id, 'mention_human', null, JSON.stringify({ content, author_role }), 'system', null);

    this.broadcast({
      type: 'mention',
      taskId: task_id,
      role: 'human',
      content,
      authorRole: author_role,
      action: 'needs_human_review'
    });

    console.log(`[symphony] [mentions] Task #${task_id} flagged for human review`);
  }

  _handleAgentMention(mention) {
    const { task_id, mention_role, content, author_role, status, project_id, title } = mention;

    const roleStatuses = this._getRoleStatuses(mention_role);
    const canReassign = roleStatuses.includes(status);

    if (canReassign) {
      this.db.prepare(`
        UPDATE sym_tasks SET assigned_role = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(mention_role, task_id);

      this._auditLog(task_id, project_id, 'mention_reassign', author_role, mention_role, 'system', null);

      this.broadcast({
        type: 'mention',
        taskId: task_id,
        role: mention_role,
        content,
        authorRole: author_role,
        action: 'reassigned'
      });

      console.log(`[symphony] [mentions] Task #${task_id} reassigned to @${mention_role}`);
    } else {
      const subtaskTitle = `[Mention] @${mention_role}: ${title}`;
      const subtaskDesc = `Created from mention by @${author_role} in task #${task_id}.\n\nContext:\n${content}`;

      const result = this.db.prepare(`
        INSERT OR IGNORE INTO sym_tasks (project_id, parent_id, title, description, type, status, assigned_role, priority, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'subtask', 'backlog', ?, 50, datetime('now'), datetime('now'))
      `).run(project_id, task_id, subtaskTitle, subtaskDesc, mention_role);

      if (result.changes === 0) {
        console.log(`[symphony] [mentions] Subtask already exists for @${mention_role} in task #${task_id}, skipping`);
        const existing = this.db.prepare(`
          SELECT id FROM sym_tasks
          WHERE parent_id = ? AND title = ? AND type = 'subtask'
        `).get(task_id, subtaskTitle);

        this._auditLog(task_id, project_id, 'mention_subtask_exists', null,
          JSON.stringify({ subtask_id: existing?.id, mention_role }), 'system', null);
        return;
      }

      const subtaskId = result.lastInsertRowid;

      this._auditLog(task_id, project_id, 'mention_subtask_created', null,
        JSON.stringify({ subtask_id: subtaskId, mention_role }), 'system', null);

      this.broadcast({
        type: 'mention',
        taskId: task_id,
        role: mention_role,
        content,
        authorRole: author_role,
        action: 'subtask_created',
        subtaskId
      });

      console.log(`[symphony] [mentions] Created subtask #${subtaskId} for @${mention_role} from task #${task_id}`);
    }
  }

  _getRoleStatuses(role) {
    const roleStatusMap = {
      'cto': ['analysis'],
      'pm': ['analysis'],
      'sm': ['analysis'],
      'analyst': ['analysis'],
      'architect': ['analysis', 'development'],
      'designer': ['design'],
      'backend-dev': ['development'],
      'frontend-dev': ['development'],
      'fullstack-dev': ['development'],
      'qa-engineer': ['qa'],
      'code-reviewer': ['code_review'],
      'devops': ['development', 'qa'],
      'human': ['uat'],
    };
    return roleStatusMap[role] || [];
  }

  // ── Public API for manual operations ──

  updateConfig(config) {
    if (config.max_concurrent_agents !== undefined) {
      const val = Math.min(10, Math.max(1, config.max_concurrent_agents));
      this.db.prepare("UPDATE sym_orchestrator SET max_concurrent_agents = ?, updated_at = datetime('now') WHERE id = 1").run(val);
      this._originalMaxAgents = val; // Update original so recovery targets new value
    }
    if (config.config) {
      this.db.prepare("UPDATE sym_orchestrator SET config = ?, updated_at = datetime('now') WHERE id = 1").run(
        JSON.stringify(config.config)
      );
    }
  }

  terminateAgent(sessionId) {
    const success = this.runner.terminate(sessionId);
    if (success) {
      this.activeAgents.delete(sessionId);
      this._updateActiveCount();
    }
    return success;
  }
}

/**
 * Returns total lead time in ms from first status_change to 'done'.
 * Sums elapsed_ms from sym_audit_log where action = 'status_change'.
 * Returns null if task has no audit entries with elapsed_ms.
 */
function getTaskLeadTime(db, taskId) {
  const row = db.prepare(`
    SELECT SUM(elapsed_ms) as total
    FROM sym_audit_log
    WHERE task_id = ? AND action = 'status_change' AND elapsed_ms IS NOT NULL
  `).get(taskId);
  return row?.total ?? null;
}

/**
 * Returns per-stage breakdown from sym_audit_log.
 * Each entry: { from, to, elapsed_ms, timestamp }
 */
function getStageBreakdown(db, taskId) {
  const rows = db.prepare(`
    SELECT old_value as "from", new_value as "to", elapsed_ms, created_at as timestamp
    FROM sym_audit_log
    WHERE task_id = ? AND action = 'status_change'
    ORDER BY created_at ASC
  `).all(taskId);
  return rows;
}

module.exports = { SymphonyOrchestrator, getTaskLeadTime, getStageBreakdown };
