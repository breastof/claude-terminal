"use strict";

/**
 * Symphony pipeline metrics — lead time and stage timing queries.
 * Importable by both the orchestrator and Next.js API routes.
 */

/**
 * Returns total lead time in ms for a task.
 * Primary: SUM(elapsed_ms) across all status_change entries.
 * Fallback: wall-clock diff between first backlog exit and done entry (for pre-migration rows).
 * Returns null if task has no sufficient audit data.
 */
function getTaskLeadTime(db, taskId) {
  const sumResult = db.prepare(`
    SELECT SUM(elapsed_ms) AS lead_time_ms
    FROM sym_audit_log
    WHERE task_id = ? AND action = 'status_change' AND elapsed_ms IS NOT NULL
  `).get(taskId);

  if (sumResult?.lead_time_ms != null) {
    return sumResult.lead_time_ms;
  }

  // Fallback: wall-clock diff (pre-migration rows with NULL elapsed_ms)
  const wallResult = db.prepare(`
    SELECT
      MIN(CASE WHEN old_value = 'backlog' THEN created_at END) AS started_at,
      MAX(CASE WHEN new_value = 'done'    THEN created_at END) AS done_at
    FROM sym_audit_log
    WHERE task_id = ? AND action = 'status_change'
  `).get(taskId);

  if (wallResult?.started_at && wallResult?.done_at) {
    const startMs = new Date(wallResult.started_at.replace(' ', 'T') + 'Z').getTime();
    const doneMs  = new Date(wallResult.done_at.replace(' ', 'T') + 'Z').getTime();
    return Math.max(0, doneMs - startMs);
  }

  return null;
}

/**
 * Returns per-stage breakdown ordered chronologically.
 * Each element: { from_status, to_status, elapsed_ms, timestamp }
 * elapsed_ms may be null for pre-migration rows.
 */
function getTaskStageTimings(db, taskId) {
  return db.prepare(`
    SELECT
      old_value   AS from_status,
      new_value   AS to_status,
      elapsed_ms,
      created_at  AS timestamp
    FROM sym_audit_log
    WHERE task_id = ? AND action = 'status_change'
    ORDER BY created_at ASC
  `).all(taskId);
}

module.exports = { getTaskLeadTime, getTaskStageTimings };
