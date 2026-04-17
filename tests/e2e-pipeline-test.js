#!/usr/bin/env node

/**
 * E2E Pipeline Test Script
 *
 * Exercises the full Symphony pipeline end-to-end:
 * backlog → analysis → design → development → code_review → qa → done
 *
 * Usage:
 *   node tests/e2e-pipeline-test.js [options]
 *
 * Options:
 *   --project-id=N       Symphony project ID (default: first project in DB)
 *   --timeout=N          Total timeout in seconds (default: 900 = 15 min)
 *   --stall-timeout=N    Per-stage stall threshold in seconds (default: 900 = 15 min)
 *   --dry-run            Validate DB schema and transition rules only
 *   --cleanup            Delete test task after completion
 *   --db=PATH            Path to SQLite database (default: ./data/claude-terminal.db)
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// --- Status transition graph (mirrors symphony-workflows.js) ---
const STATUS_TRANSITIONS = {
  backlog: ['analysis', 'cancelled'],
  analysis: ['design', 'development', 'cancelled'],
  design: ['development', 'cancelled'],
  development: ['code_review', 'cancelled'],
  code_review: ['qa', 'development', 'cancelled'],
  qa: ['done', 'development', 'cancelled'],
  done: [],
  cancelled: [],
};

const EXPECTED_SEQUENCE = ['backlog', 'analysis', 'design', 'development', 'code_review', 'qa', 'done'];

const REQUIRED_TABLES = ['sym_tasks', 'sym_audit_log', 'sym_agent_sessions', 'sym_comments', 'sym_projects'];
const REQUIRED_TASK_COLUMNS = ['id', 'project_id', 'type', 'title', 'status', 'tags', 'attempt'];

// --- CLI argument parsing ---
function parseArgs() {
  const args = {
    projectId: null,
    timeout: 900,
    stallTimeout: 900,
    dryRun: false,
    cleanup: false,
    dbPath: path.join(process.cwd(), 'data', 'claude-terminal.db'),
  };

  for (const arg of process.argv.slice(2)) {
    if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--cleanup') {
      args.cleanup = true;
    } else if (arg.startsWith('--project-id=')) {
      args.projectId = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--timeout=')) {
      args.timeout = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--stall-timeout=')) {
      args.stallTimeout = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--db=')) {
      args.dbPath = arg.split('=')[1];
    } else {
      console.error(`Unknown option: ${arg}`);
      process.exit(1);
    }
  }

  return args;
}

// --- Formatting helpers ---
function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min === 0) return `${sec}s`;
  return `${min}m ${sec}s`;
}

function timestamp() {
  return new Date().toLocaleTimeString('en-GB', { hour12: false });
}

function log(msg) {
  console.log(`[${timestamp()}] ${msg}`);
}

// --- Schema validation ---
function validateSchema(db) {
  let valid = true;

  // Check required tables
  const tables = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'sym_%'`
  ).all().map(r => r.name);

  for (const table of REQUIRED_TABLES) {
    if (tables.includes(table)) {
      console.log(`  ✓ Table ${table} exists`);
    } else {
      console.log(`  ✗ Table ${table} MISSING`);
      valid = false;
    }
  }

  // Check required columns on sym_tasks
  if (tables.includes('sym_tasks')) {
    const columns = db.prepare(`PRAGMA table_info(sym_tasks)`).all().map(c => c.name);
    for (const col of REQUIRED_TASK_COLUMNS) {
      if (columns.includes(col)) {
        console.log(`  ✓ sym_tasks.${col} exists`);
      } else {
        console.log(`  ✗ sym_tasks.${col} MISSING`);
        valid = false;
      }
    }
  }

  return valid;
}

// --- Check if elapsed_ms column exists in audit log ---
function hasElapsedMs(db) {
  try {
    const columns = db.prepare(`PRAGMA table_info(sym_audit_log)`).all().map(c => c.name);
    return columns.includes('elapsed_ms');
  } catch {
    return false;
  }
}

// --- Stage timing from audit log ---
function computeStageTimings(db, taskId) {
  const transitions = db.prepare(
    `SELECT action, old_value, new_value, created_at
     FROM sym_audit_log
     WHERE task_id = ? AND action = 'status_change'
     ORDER BY created_at ASC`
  ).all(taskId);

  if (transitions.length === 0) return [];

  return transitions.map((t, i) => {
    const prev = transitions[i - 1];
    const elapsed_ms = prev
      ? new Date(t.created_at).getTime() - new Date(prev.created_at).getTime()
      : null;
    return {
      from: t.old_value,
      to: t.new_value,
      elapsed_ms,
      timestamp: t.created_at,
    };
  });
}

// --- Get last agent session for stall reporting ---
function getLastSession(db, taskId) {
  return db.prepare(
    `SELECT role_slug, status, started_at, finished_at, error
     FROM sym_agent_sessions
     WHERE task_id = ?
     ORDER BY started_at DESC LIMIT 1`
  ).get(taskId);
}

// --- Get last comment for stall reporting ---
function getLastComment(db, taskId) {
  return db.prepare(
    `SELECT author_role, content, created_at
     FROM sym_comments
     WHERE task_id = ?
     ORDER BY created_at DESC LIMIT 1`
  ).get(taskId);
}

// --- Dry run mode ---
function dryRun(db, args) {
  console.log('[E2E-TEST] Dry-run mode: validating schema and transition rules\n');

  console.log('Schema validation:');
  const valid = validateSchema(db);
  console.log();

  console.log('Status transition rules:');
  for (const [from, tos] of Object.entries(STATUS_TRANSITIONS)) {
    console.log(`  ${from} → ${tos.length > 0 ? tos.join(', ') : '(terminal)'}`);
  }
  console.log();

  console.log('Expected full pipeline sequence:');
  console.log(`  ${EXPECTED_SEQUENCE.join(' → ')}`);
  console.log();

  const projectId = args.projectId || getDefaultProjectId(db);
  console.log('Test task preview (not created):');
  console.log(`  project_id: ${projectId || '(no projects found)'}`);
  console.log(`  type: task`);
  console.log(`  title: [E2E-TEST] Pipeline Verification`);
  console.log(`  status: backlog`);
  console.log(`  tags: ["frontend","ui","e2e-test"]`);
  console.log();

  if (!valid) {
    console.log('=== FAIL: Schema validation failed ===');
    process.exit(1);
  }

  console.log('=== PASS: Dry-run validation complete ===');
  process.exit(0);
}

// --- Get default project ID ---
function getDefaultProjectId(db) {
  const row = db.prepare('SELECT id FROM sym_projects ORDER BY id LIMIT 1').get();
  return row ? row.id : null;
}

// --- Print failure report ---
function printFailure(db, taskId, currentStatus, reason, startTime, lastChangeTime) {
  const totalElapsed = Date.now() - startTime;
  const stuckDuration = Date.now() - lastChangeTime;

  console.log();
  console.log(`=== FAIL: Task #${taskId} ${reason} ===`);
  console.log();
  console.log(`Current status: ${currentStatus}`);
  console.log(`Time in current status: ${formatDuration(stuckDuration)}`);
  console.log(`Total elapsed: ${formatDuration(totalElapsed)}`);

  const session = getLastSession(db, taskId);
  if (session) {
    console.log();
    console.log('Last agent session:');
    console.log(`  Role: ${session.role_slug}`);
    console.log(`  Status: ${session.status}`);
    console.log(`  Started: ${session.started_at}`);
    console.log(`  Error: ${session.error || 'null'}`);
  }

  const comment = getLastComment(db, taskId);
  if (comment) {
    console.log();
    console.log('Last comment:');
    console.log(`  [${comment.created_at}] [${comment.author_role}] ${comment.content.substring(0, 200)}`);
  }

  // Show stages completed
  const timings = computeStageTimings(db, taskId);
  if (timings.length > 0) {
    const stages = timings.map(t => t.from);
    stages.push(timings[timings.length - 1].to);
    console.log();
    console.log(`Stages completed: ${stages.join(' → ')} (stuck)`);
  } else {
    console.log();
    console.log(`Stages completed: ${currentStatus} (stuck — no transitions recorded)`);
    if (currentStatus === 'backlog' || currentStatus === 'analysis') {
      console.log('Hint: orchestrator may not be running');
    }
  }
}

// --- Print success report ---
function printSuccess(db, taskId, startTime, observedTransitions) {
  const totalElapsed = Date.now() - startTime;

  console.log();
  console.log(`=== PASS: Pipeline completed in ${formatDuration(totalElapsed)} ===`);
  console.log();

  // Use observed transitions for timing
  if (observedTransitions.length > 0) {
    console.log('Stage Breakdown:');
    for (const t of observedTransitions) {
      const label = `${t.from} → ${t.to}:`;
      console.log(`  ${label.padEnd(30)} ${formatDuration(t.elapsed_ms)}`);
    }
    console.log(`  ${'─'.repeat(40)}`);
    console.log(`  ${'Total lead time:'.padEnd(30)} ${formatDuration(totalElapsed)}`);
  }

  // Also try audit log for additional detail
  const auditTimings = computeStageTimings(db, taskId);
  if (auditTimings.length > 0 && auditTimings.length !== observedTransitions.length) {
    console.log();
    console.log('Audit Log Transitions (includes code_review loops if any):');
    for (const t of auditTimings) {
      const elapsed = t.elapsed_ms != null ? formatDuration(t.elapsed_ms) : 'N/A';
      console.log(`  ${t.from} → ${t.to}: ${elapsed} (at ${t.timestamp})`);
    }
  }

  // Verify all expected statuses were hit
  const visitedStatuses = new Set(['backlog']);
  for (const t of observedTransitions) {
    visitedStatuses.add(t.to);
  }
  // Also add from audit log
  for (const t of auditTimings) {
    visitedStatuses.add(t.from);
    visitedStatuses.add(t.to);
  }

  const allHit = EXPECTED_SEQUENCE.every(s => visitedStatuses.has(s));
  console.log();
  if (allHit) {
    console.log(`Verified: ALL ${EXPECTED_SEQUENCE.length} statuses traversed including design stage ✓`);
  } else {
    const missing = EXPECTED_SEQUENCE.filter(s => !visitedStatuses.has(s));
    console.log(`Warning: Missing statuses: ${missing.join(', ')}`);
  }
}

// --- Cleanup test task ---
function cleanupTask(db, taskId) {
  try {
    db.prepare('DELETE FROM sym_audit_log WHERE task_id = ?').run(taskId);
    db.prepare('DELETE FROM sym_comments WHERE task_id = ?').run(taskId);
    db.prepare('DELETE FROM sym_agent_sessions WHERE task_id = ?').run(taskId);
    db.prepare('DELETE FROM sym_artifacts WHERE task_id = ?').run(taskId);
    db.prepare('DELETE FROM sym_tasks WHERE id = ?').run(taskId);
    log(`Cleaned up test task #${taskId}`);
  } catch (err) {
    log(`Warning: cleanup failed: ${err.message}`);
  }
}

// --- Main execution ---
async function main() {
  const args = parseArgs();

  // Open database
  if (!fs.existsSync(args.dbPath)) {
    console.error(`Database not found: ${args.dbPath}`);
    console.error(`Use --db=PATH to specify the database location`);
    process.exit(1);
  }

  const db = new Database(args.dbPath, { readonly: false });
  db.pragma('journal_mode = WAL');

  // Dry-run mode
  if (args.dryRun) {
    dryRun(db, args);
    return;
  }

  // Validate schema first
  console.log('[E2E-TEST] Validating schema...');
  if (!validateSchema(db)) {
    console.error('\nSchema validation failed. Run with --dry-run for details.');
    process.exit(1);
  }
  console.log();

  // Resolve project ID
  const projectId = args.projectId || getDefaultProjectId(db);
  if (!projectId) {
    console.error('No projects found. Create a project in sym_projects first.');
    const projects = db.prepare('SELECT id, name FROM sym_projects').all();
    if (projects.length > 0) {
      console.error('Available projects:');
      projects.forEach(p => console.error(`  id=${p.id}: ${p.name}`));
    }
    process.exit(1);
  }

  // Create test task
  const result = db.prepare(
    `INSERT INTO sym_tasks (project_id, type, title, status, tags, created_at, updated_at)
     VALUES (?, 'task', '[E2E-TEST] Pipeline Verification', 'backlog', '["frontend","ui","e2e-test"]', datetime('now'), datetime('now'))`
  ).run(projectId);

  const taskId = result.lastInsertRowid;
  console.log(`[E2E-TEST] Starting pipeline test for project ${projectId}`);
  console.log(`[E2E-TEST] Created task #${taskId}: "[E2E-TEST] Pipeline Verification" (tags: frontend, ui, e2e-test)`);
  console.log(`[E2E-TEST] Timeout: ${formatDuration(args.timeout * 1000)}, Stall timeout: ${formatDuration(args.stallTimeout * 1000)}`);
  console.log(`[E2E-TEST] Waiting for orchestrator to process...\n`);

  const startTime = Date.now();
  let lastChangeTime = Date.now();
  let lastStatus = 'backlog';
  const observedTransitions = [];

  // Poll loop
  const pollInterval = 5000; // 5s, matching orchestrator tick

  const exitWithResult = (code) => {
    if (args.cleanup) {
      cleanupTask(db, taskId);
    }
    db.close();
    process.exit(code);
  };

  const poll = () => {
    const task = db.prepare('SELECT id, status, updated_at, attempt FROM sym_tasks WHERE id = ?').get(taskId);

    if (!task) {
      log(`Task #${taskId} not found in database — may have been deleted`);
      exitWithResult(1);
      return;
    }

    const currentStatus = task.status;

    // Status changed
    if (currentStatus !== lastStatus) {
      const elapsed_ms = Date.now() - lastChangeTime;
      const transition = { from: lastStatus, to: currentStatus, elapsed_ms };
      observedTransitions.push(transition);

      log(`Status: ${lastStatus} → ${currentStatus} (elapsed: ${formatDuration(elapsed_ms)})`);

      lastStatus = currentStatus;
      lastChangeTime = Date.now();
    }

    // Success: reached done
    if (currentStatus === 'done') {
      printSuccess(db, taskId, startTime, observedTransitions);
      exitWithResult(0);
      return;
    }

    // Unexpected terminal state
    if (currentStatus === 'cancelled') {
      console.log();
      console.log(`=== FAIL: Task #${taskId} was cancelled ===`);
      printFailure(db, taskId, currentStatus, 'was cancelled', startTime, lastChangeTime);
      exitWithResult(1);
      return;
    }

    // Check per-stage stall
    const stuckDuration = Date.now() - lastChangeTime;
    if (stuckDuration > args.stallTimeout * 1000) {
      printFailure(db, taskId, currentStatus,
        `stalled in '${currentStatus}' for ${formatDuration(stuckDuration)}`,
        startTime, lastChangeTime);
      exitWithResult(1);
      return;
    }

    // Check total timeout
    const totalElapsed = Date.now() - startTime;
    if (totalElapsed > args.timeout * 1000) {
      printFailure(db, taskId, currentStatus,
        `total timeout (${formatDuration(totalElapsed)}) exceeded in '${currentStatus}'`,
        startTime, lastChangeTime);
      exitWithResult(1);
      return;
    }

    // Schedule next poll
    setTimeout(poll, pollInterval);
  };

  // Start polling
  poll();
}

main().catch(err => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
