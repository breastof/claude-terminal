"use strict";

const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { buildAgentClaudeMd, buildAgentPrompt } = require("./symphony-workflows");

const WORKSPACES_ROOT = path.join(process.env.HOME || "/root", "symphony-workspaces");

class AgentRunner {
  constructor(db, broadcast) {
    this.db = db;
    this.broadcast = broadcast || (() => {});
  }

  /**
   * Spawn an agent for a task with a pre-created session ID.
   * Called by orchestrator which creates the session row first.
   */
  async runWithSession(task, role, project, sessionId) {
    // Try to set up git worktree (full codebase), fall back to empty dir
    let workspacePath = this.setupWorktree(task, project);
    if (!workspacePath) {
      workspacePath = this._ensureWorkspace(task, project);
    }
    const attempt = task.attempt || 0;

    try {
      // Gather context
      const parentChain = this._getParentChain(task);
      const comments = this._getComments(task.id);
      const depArtifacts = this._getDepArtifacts(task.id);

      // Also get artifacts from parent chain (strategy artifacts)
      const parentArtifacts = this._getParentArtifacts(parentChain);
      const allArtifacts = [...depArtifacts, ...parentArtifacts];

      // Run hooks
      await this._runHook(project, "after_create", workspacePath, task, /* onlyIfNew */ true);
      await this._runHook(project, "before_run", workspacePath, task, false);

      // Write CLAUDE.md
      const claudeMd = buildAgentClaudeMd({ role, task, project, parentChain, comments, depArtifacts: allArtifacts, attempt });
      fs.writeFileSync(path.join(workspacePath, "CLAUDE.md"), claudeMd, "utf-8");

      // Update session status
      this._updateSession(sessionId, { status: "running", last_activity_at: new Date().toISOString() });
      this._updateTask(task.id, { workspace_path: workspacePath, last_activity_at: new Date().toISOString() });
      this.broadcast({ type: "agent_started", taskId: task.id, role: role.slug, sessionId });
      this.broadcast({ type: "agent_started", taskId: task.id, role: role.slug, sessionId, projectSlug: project.slug });

      // Spawn claude CLI
      const result = await this._spawnAgent(task, role, project, workspacePath, { id: sessionId });

      // Run after_run hook (always, even on error)
      await this._runHook(project, "after_run", workspacePath, task, false).catch(() => {});

      // Process result (Phase 1.6: robust parsing)
      const parsed = this._parseOutput(result.stdout, result.exitCode);

      // Update session
      this._updateSession(sessionId, {
        status: parsed.status === "completed" ? "completed" : "failed",
        finished_at: new Date().toISOString(),
        exit_code: result.exitCode,
        output_summary: (result.stdout || "").slice(-10000),
        tokens_in: parsed._tokens_in || 0,
        tokens_out: parsed._tokens_out || 0,
        cost_usd: parsed._cost_usd || 0,
        error: parsed.status !== "completed" ? [parsed.error, result.stderr?.slice(-2000)].filter(Boolean).join(" | ") : null,
      });

      this.broadcast({ type: "agent_finished", taskId: task.id, role: role.slug, sessionId, result: parsed });
      this.broadcast({ type: "agent_finished", taskId: task.id, role: role.slug, sessionId, result: parsed, projectSlug: project.slug });

      return { session: { id: sessionId }, parsed, exitCode: result.exitCode };
    } catch (err) {
      // Run after_run hook even on exception
      await this._runHook(project, "after_run", workspacePath, task, false).catch(() => {});

      this._updateSession(sessionId, {
        status: "failed",
        finished_at: new Date().toISOString(),
        error: err.message,
      });

      this.broadcast({ type: "agent_finished", taskId: task.id, role: role.slug, sessionId, error: err.message });
      this.broadcast({ type: "agent_finished", taskId: task.id, role: role.slug, sessionId, error: err.message, projectSlug: project.slug });

      return { session: { id: sessionId }, parsed: { status: "failed", summary: err.message, error: err.message }, exitCode: -1 };
    }
  }

  /**
   * Legacy run method — creates its own session. Kept for backward compatibility.
   */
  async run(task, role, project) {
    const sessionRow = this._createSession(task, role);
    const result = await this.runWithSession(task, role, project, sessionRow.id);
    return result;
  }

  /**
   * Spawn the claude CLI process and collect output.
   * Uses --output-format json for reliable single-JSON-object output.
   */
  _spawnAgent(task, role, project, workspacePath, session) {
    return new Promise((resolve, reject) => {
      const prompt = buildAgentPrompt(task, role);
      const args = ["-p", prompt, "--output-format", "json"];
      if (role.model) args.push("--model", role.model);

      // Find claude binary
      let claudeBin;
      try {
        claudeBin = execSync("which claude", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
      } catch {
        claudeBin = "/usr/bin/claude";
      }

      const env = {
        ...process.env,
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        GIT_AUTHOR_NAME: role.name,
        GIT_AUTHOR_EMAIL: `${role.slug}@symphony`,
        GIT_COMMITTER_NAME: role.name,
        GIT_COMMITTER_EMAIL: `${role.slug}@symphony`,
      };
      // Remove all Claude nested session detection env vars
      delete env.CLAUDECODE;
      delete env.CLAUDE_CODE_ENTRYPOINT;
      delete env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;

      console.log(`[symphony] Spawning agent: ${claudeBin} ${args.slice(0, 4).join(" ")} ... (cwd: ${workspacePath})`);

      const child = spawn(claudeBin, args, {
        cwd: workspacePath,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      // Track PID
      this._updateSession(session.id, { pid: child.pid });

      let stdout = "";
      let stderr = "";
      let lastActivityTime = Date.now();

      // Stall watchdog: 10 min without output → SIGTERM (agents can take a while)
      const stallTimeout = 600000;
      const stallCheck = setInterval(() => {
        if (Date.now() - lastActivityTime > stallTimeout) {
          clearInterval(stallCheck);
          console.log(`[symphony] Session ${session.id} stalled (no activity for ${stallTimeout/1000}s)`);
          try { child.kill("SIGTERM"); } catch {}
          this._updateSession(session.id, { status: "stalled" });
        }
      }, 30000);

      child.stdout.on("data", (data) => {
        stdout += data.toString();
        lastActivityTime = Date.now();
        // Update activity periodically
        this._updateTask(task.id, { last_activity_at: new Date().toISOString() });
        this._updateSession(session.id, { last_activity_at: new Date().toISOString() });
      });

      child.stderr.on("data", (data) => {
        const chunk = data.toString();
        stderr += chunk;
        lastActivityTime = Date.now();
        // Log stderr for debugging
        if (chunk.trim()) console.log(`[symphony] Agent stderr (task ${task.id}):`, chunk.trim().slice(0, 200));
      });

      child.on("error", (err) => {
        clearInterval(stallCheck);
        reject(err);
      });

      child.on("close", (code) => {
        clearInterval(stallCheck);
        console.log(`[symphony] Agent exited (task ${task.id}, code ${code}, stdout ${stdout.length} bytes)`);

        // Parse JSON output for token/cost tracking
        let tokensIn = 0, tokensOut = 0, costUsd = 0, claudeSessionId = null;
        try {
          const result = JSON.parse(stdout);
          if (result.usage) {
            tokensIn = (result.usage.input_tokens || 0) + (result.usage.cache_read_input_tokens || 0);
            tokensOut = result.usage.output_tokens || 0;
          }
          costUsd = result.total_cost_usd || 0;
          claudeSessionId = result.session_id || null;
        } catch {}

        if (claudeSessionId) {
          this._updateSession(session.id, { claude_session_id: claudeSessionId });
          this._updateTask(task.id, { claude_session_id: claudeSessionId });
        }

        resolve({
          stdout,
          stderr,
          exitCode: code,
          tokensIn,
          tokensOut,
          costUsd,
          claudeSessionId,
        });
      });
    });
  }

  /**
   * Parse agent output — handles --output-format json.
   * The stdout is a single JSON object with { type, result, usage, session_id, total_cost_usd, ... }
   * The `result` field contains the agent's text output, which should end with a ```json block.
   */
  _parseOutput(stdout, exitCode) {
    // Step 1: Extract the text content from claude's JSON envelope
    let textContent = "";
    let envelope = null;
    if (stdout) {
      try {
        envelope = JSON.parse(stdout.trim());
        textContent = typeof envelope.result === "string" ? envelope.result : "";
      } catch {
        // If not valid JSON, treat entire stdout as text
        textContent = stdout;
      }
    }

    // Rate limit detection — check envelope signals + text patterns
    const rateLimitPatterns = /out of extra usage|rate limit|usage limit|too many requests|exceeded.*limit/i;
    const isRateLimitByEnvelope = envelope && envelope.is_error === true
      && (envelope.total_cost_usd === 0 || !envelope.total_cost_usd)
      && (!envelope.usage?.input_tokens);
    const isRateLimitByText = rateLimitPatterns.test(textContent) || rateLimitPatterns.test(envelope?.error || "");

    if (isRateLimitByEnvelope || isRateLimitByText) {
      const msg = textContent.trim() || envelope?.error || "Rate limit hit";
      return {
        status: "rate_limited",
        summary: "Rate limited by Claude CLI",
        error: `rate_limited: ${msg.slice(0, 500)}`,
        raw_output: msg,
        artifacts: [],
        next_tasks: [],
        comments: [],
        chat_message: null,
        blocked_by: [],
      };
    }

    if (!textContent.trim()) {
      return {
        status: "failed",
        summary: exitCode !== 0 ? `Agent exited with code ${exitCode}` : "No output from agent",
        error: `Exit code: ${exitCode}`,
        artifacts: [],
        next_tasks: [],
        comments: [],
        chat_message: null,
        blocked_by: [],
      };
    }

    // Step 2: Find the agent's structured JSON output within the text
    let parsed = null;

    // Strategy 1: Find ```json ... ``` block (preferred)
    const jsonBlockMatch = textContent.match(/```json\s*\n([\s\S]*?)\n\s*```/);
    if (jsonBlockMatch) {
      try {
        parsed = JSON.parse(jsonBlockMatch[1].trim());
      } catch {}
    }

    // Strategy 2: Find last {"status": pattern
    if (!parsed) {
      const statusPattern = /\{"status"\s*:/g;
      let lastMatch = null;
      let match;
      while ((match = statusPattern.exec(textContent)) !== null) {
        lastMatch = match;
      }
      if (lastMatch) {
        const candidate = textContent.slice(lastMatch.index);
        let depth = 0, endIdx = -1;
        for (let i = 0; i < candidate.length; i++) {
          if (candidate[i] === "{") depth++;
          else if (candidate[i] === "}") { depth--; if (depth === 0) { endIdx = i + 1; break; } }
        }
        if (endIdx > 0) {
          try { parsed = JSON.parse(candidate.slice(0, endIdx)); } catch {}
        }
      }
    }

    if (!parsed) {
      return {
        status: "failed",
        summary: "No valid JSON output found in agent response",
        error: exitCode !== 0 ? `Exit code: ${exitCode}` : "Agent did not produce structured output",
        raw_output: textContent.slice(-5000),
        artifacts: [],
        next_tasks: [],
        comments: [],
        chat_message: null,
        blocked_by: [],
      };
    }

    // Normalize with defaults
    return {
      status: parsed.status || "completed",
      summary: parsed.summary || "",
      next_status: parsed.next_status || null,
      artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts : [],
      next_tasks: Array.isArray(parsed.next_tasks) ? parsed.next_tasks : [],
      comments: Array.isArray(parsed.comments) ? parsed.comments : [],
      chat_message: parsed.chat_message || null,
      blocked_by: Array.isArray(parsed.blocked_by) ? parsed.blocked_by : [],
      error: parsed.error || null,
      _tokens_in: envelope?.usage?.input_tokens || 0,
      _tokens_out: envelope?.usage?.output_tokens || 0,
      _cost_usd: envelope?.total_cost_usd || 0,
    };
  }

  // ── Workspace Management ──

  _ensureWorkspace(task, project) {
    const projectSlug = project?.slug || "default";
    const dir = path.join(WORKSPACES_ROOT, projectSlug, `task-${task.id}`);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  async _runHook(project, hookName, workspacePath, task, onlyIfNew) {
    if (!project) return;
    const hooks = typeof project.hooks === "string" ? JSON.parse(project.hooks) : (project.hooks || {});
    const cmd = hooks[hookName];
    if (!cmd) return;

    // For after_create, only run if workspace was just created (no .hook-ran marker)
    if (onlyIfNew) {
      const marker = path.join(workspacePath, ".symphony-created");
      if (fs.existsSync(marker)) return;
      fs.writeFileSync(marker, new Date().toISOString(), "utf-8");
    }

    // Template substitution
    const expanded = cmd
      .replace(/\{repo_url\}/g, project.repo_path || "")
      .replace(/\{default_branch\}/g, project.default_branch || "main")
      .replace(/\{task_id\}/g, String(task.id))
      .replace(/\{branch\}/g, `symphony/task-${task.id}`);

    try {
      execSync(expanded, { cwd: workspacePath, stdio: "pipe", timeout: 60000 });
    } catch (err) {
      console.error(`[symphony] Hook ${hookName} failed:`, err.message);
    }
  }

  /**
   * Set up git worktree for a task if project has a repo.
   */
  setupWorktree(task, project) {
    if (!project?.repo_path || !fs.existsSync(project.repo_path)) return null;

    const branch = `symphony/task-${task.id}`;
    const projectSlug = project?.slug || "default";
    const workspacePath = path.join(WORKSPACES_ROOT, projectSlug, `task-${task.id}`);

    try {
      // Check if worktree already exists
      const worktrees = execSync("git worktree list --porcelain", {
        cwd: project.repo_path,
        encoding: "utf-8",
      });
      if (worktrees.includes(workspacePath)) return workspacePath;

      // Clean up stale directory if exists (from failed previous run)
      if (fs.existsSync(workspacePath)) {
        fs.rmSync(workspacePath, { recursive: true, force: true });
      }

      // Prune stale worktrees first
      execSync("git worktree prune", { cwd: project.repo_path, stdio: "pipe" });

      // Delete branch if it already exists (from previous attempt)
      try {
        execSync(`git branch -D "${branch}"`, { cwd: project.repo_path, stdio: "pipe" });
      } catch {} // branch might not exist, that's fine

      // Create worktree with new branch from HEAD
      execSync(`git worktree add "${workspacePath}" -b "${branch}" HEAD`, {
        cwd: project.repo_path,
        stdio: "pipe",
      });
      console.log(`[symphony] Worktree created: ${workspacePath} (branch ${branch})`);
      return workspacePath;
    } catch (err) {
      console.error(`[symphony] Worktree setup failed:`, err.message);
      // Fallback: ensure directory exists at minimum
      if (!fs.existsSync(workspacePath)) {
        fs.mkdirSync(workspacePath, { recursive: true });
      }
      return workspacePath;
    }
  }

  /**
   * Cleanup workspace for a completed/cancelled task.
   */
  cleanupWorkspace(task, project) {
    const projectSlug = project?.slug || "default";
    const dir = path.join(WORKSPACES_ROOT, projectSlug, `task-${task.id}`);

    // Prune git worktree if applicable
    if (project?.repo_path && fs.existsSync(project.repo_path)) {
      try {
        execSync("git worktree prune", { cwd: project.repo_path, stdio: "pipe" });
      } catch {}
    }

    // Mark as done (don't delete immediately — cleanup cron handles old ones)
    try {
      fs.writeFileSync(path.join(dir, ".done"), new Date().toISOString(), "utf-8");
    } catch {}
  }

  // ── DB Helpers ──

  _createSession(task, role) {
    const stmt = this.db.prepare(`
      INSERT INTO sym_agent_sessions (task_id, role_slug, status, started_at, last_activity_at)
      VALUES (?, ?, 'starting', datetime('now'), datetime('now'))
    `);
    const info = stmt.run(task.id, role.slug);
    return { id: info.lastInsertRowid };
  }

  _updateSession(id, fields) {
    const sets = [];
    const values = [];
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) {
        sets.push(`${k} = ?`);
        values.push(v);
      }
    }
    if (sets.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE sym_agent_sessions SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  }

  _updateTask(id, fields) {
    const sets = [];
    const values = [];
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) {
        sets.push(`${k} = ?`);
        values.push(v);
      }
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    values.push(id);
    this.db.prepare(`UPDATE sym_tasks SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  }

  _getParentChain(task) {
    const chain = [];
    let current = task;
    while (current.parent_id) {
      const parent = this.db.prepare("SELECT * FROM sym_tasks WHERE id = ?").get(current.parent_id);
      if (!parent) break;
      chain.unshift(parent);
      current = parent;
    }
    return chain;
  }

  _getComments(taskId) {
    return this.db.prepare(
      "SELECT * FROM sym_comments WHERE task_id = ? ORDER BY created_at ASC"
    ).all(taskId);
  }

  _getDepArtifacts(taskId) {
    // Get artifacts from blocker tasks
    return this.db.prepare(`
      SELECT a.* FROM sym_artifacts a
      JOIN sym_task_deps d ON d.blocker_id = a.task_id
      WHERE d.blocked_id = ?
      ORDER BY a.created_at ASC
    `).all(taskId);
  }

  // Phase 3.6: Get strategy artifacts from parent chain
  _getParentArtifacts(parentChain) {
    if (!parentChain || parentChain.length === 0) return [];
    const artifacts = [];
    for (const parent of parentChain) {
      const parentArtifacts = this.db.prepare(`
        SELECT * FROM sym_artifacts WHERE task_id = ? AND type IN ('prd', 'research', 'spec')
        ORDER BY created_at ASC
      `).all(parent.id);
      artifacts.push(...parentArtifacts);
    }
    return artifacts;
  }

  /**
   * Terminate a running agent by session ID.
   */
  terminate(sessionId) {
    const session = this.db.prepare("SELECT * FROM sym_agent_sessions WHERE id = ?").get(sessionId);
    if (!session || !session.pid) return false;

    try {
      process.kill(session.pid, "SIGTERM");
      // Give 30s, then force kill
      setTimeout(() => {
        try { process.kill(session.pid, "SIGKILL"); } catch {}
      }, 30000);
    } catch {}

    this._updateSession(sessionId, {
      status: "terminated",
      finished_at: new Date().toISOString(),
    });

    return true;
  }

  /**
   * Check if a PID is still alive.
   */
  isPidAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = { AgentRunner };
