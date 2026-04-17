import { NextRequest, NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { getDb } from "@/lib/db";

function getUser(req: NextRequest) {
  const token = req.cookies.get("auth-token")?.value;
  return token ? verifyToken(token) : null;
}

function safeQuery<T>(fn: () => T, fallback: T): { value: T; error: string | null } {
  try {
    return { value: fn(), error: null };
  } catch (e) {
    return { value: fallback, error: e instanceof Error ? e.message : String(e) };
  }
}

const VALID_WINDOWS: Record<string, string> = {
  "1h": "-1 hours",
  "24h": "-24 hours",
  "7d": "-7 days",
};

function ensureIndexes(db: ReturnType<typeof getDb>) {
  const indexes = [
    `CREATE INDEX IF NOT EXISTS idx_sym_audit_log_action_created ON sym_audit_log(action, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_sym_audit_log_task_action_created ON sym_audit_log(task_id, action, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_sym_agent_sessions_started ON sym_agent_sessions(started_at)`,
    `CREATE INDEX IF NOT EXISTS idx_sym_agent_sessions_role_status ON sym_agent_sessions(role_slug, status)`,
    `CREATE INDEX IF NOT EXISTS idx_sym_retry_log_executed ON sym_retry_log(executed_at)`,
    `CREATE INDEX IF NOT EXISTS idx_sym_tasks_status_updated ON sym_tasks(status, updated_at)`,
  ];
  for (const sql of indexes) {
    try { db.exec(sql); } catch { /* table may not exist yet */ }
  }
}

let indexesEnsured = false;

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)];
}

export async function GET(request: NextRequest) {
  const user = getUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = getDb();

  // Ensure observability indexes on first call
  if (!indexesEnsured) {
    ensureIndexes(db);
    indexesEnsured = true;
  }

  // Parse window param
  const windowParam = request.nextUrl.searchParams.get("window") ?? "24h";
  const windowOffset = VALID_WINDOWS[windowParam] ?? VALID_WINDOWS["24h"];
  const windowKey = windowParam in VALID_WINDOWS ? windowParam : "24h";

  const pipelineErrors: string[] = [];

  // ── Existing CostDashboard fields (backward-compatible) ──

  const orchestrator = safeQuery(
    () => db.prepare("SELECT * FROM sym_orchestrator WHERE id = 1").get(),
    null
  ).value;

  const tasksByStatus = safeQuery(
    () => db.prepare("SELECT status, COUNT(*) as count FROM sym_tasks GROUP BY status").all(),
    []
  ).value;

  const sessionsByStatus = safeQuery(
    () => db.prepare("SELECT status, COUNT(*) as count FROM sym_agent_sessions GROUP BY status").all(),
    []
  ).value;

  const costByRole = safeQuery(
    () =>
      db.prepare(
        `SELECT role_slug, SUM(cost_usd) as total_cost, SUM(tokens_in) as total_tokens_in,
                SUM(tokens_out) as total_tokens_out, COUNT(*) as session_count
         FROM sym_agent_sessions GROUP BY role_slug ORDER BY total_cost DESC`
      ).all(),
    []
  ).value;

  const costByProject = safeQuery(
    () =>
      db.prepare(
        `SELECT p.slug, p.name, SUM(s.cost_usd) as total_cost, COUNT(s.id) as session_count
         FROM sym_agent_sessions s
         JOIN sym_tasks t ON t.id = s.task_id
         JOIN sym_projects p ON p.id = t.project_id
         GROUP BY p.id ORDER BY total_cost DESC`
      ).all(),
    []
  ).value;

  const dailyCost = safeQuery(
    () =>
      db.prepare(
        `SELECT date(started_at) as day, SUM(cost_usd) as cost, COUNT(*) as sessions
         FROM sym_agent_sessions
         WHERE started_at >= datetime('now', '-30 days')
         GROUP BY day ORDER BY day ASC`
      ).all(),
    []
  ).value;

  const recentSessions = safeQuery(
    () =>
      db.prepare(
        `SELECT id, task_id, role_slug, status, started_at, finished_at,
                cost_usd, tokens_in, tokens_out, error
         FROM sym_agent_sessions ORDER BY started_at DESC LIMIT 50`
      ).all(),
    []
  ).value;

  // ── Pipeline metrics ──

  // 1. Lead time by task type (backlog exit -> done entry)
  let leadTimeByType: {
    type: string;
    avg_seconds: number;
    p50_seconds: number | null;
    p95_seconds: number | null;
    count: number;
  }[] = [];

  const ltResult = safeQuery(() => {
    const rows = db.prepare(
      `SELECT
         t.type,
         (julianday(last_done.created_at) - julianday(first_exit.created_at)) * 24 * 3600 AS duration_seconds
       FROM (
         SELECT task_id, MIN(created_at) AS created_at
         FROM sym_audit_log
         WHERE action = 'status_change' AND old_value = 'backlog'
         GROUP BY task_id
       ) first_exit
       JOIN (
         SELECT task_id, MAX(created_at) AS created_at
         FROM sym_audit_log
         WHERE action = 'status_change' AND new_value = 'done'
           AND created_at > datetime('now', ?)
         GROUP BY task_id
       ) last_done ON last_done.task_id = first_exit.task_id
       JOIN sym_tasks t ON t.id = first_exit.task_id
       ORDER BY t.type, duration_seconds ASC`
    ).all(windowOffset) as { type: string; duration_seconds: number }[];

    // Group by type and compute avg/p50/p95
    const byType = new Map<string, number[]>();
    for (const r of rows) {
      if (!byType.has(r.type)) byType.set(r.type, []);
      byType.get(r.type)!.push(r.duration_seconds);
    }

    return Array.from(byType.entries()).map(([type, durations]) => {
      const sum = durations.reduce((a, b) => a + b, 0);
      return {
        type,
        avg_seconds: Math.round(sum / durations.length),
        p50_seconds: durations.length >= 2 ? Math.round(percentile(durations, 0.5)!) : null,
        p95_seconds: durations.length >= 2 ? Math.round(percentile(durations, 0.95)!) : null,
        count: durations.length,
      };
    });
  }, []);
  leadTimeByType = ltResult.value;
  if (ltResult.error) pipelineErrors.push(`leadTimeByType: ${ltResult.error}`);

  // 2. Dwell time by status
  const dwellResult = safeQuery(
    () =>
      db.prepare(
        `SELECT
           al_enter.new_value AS status,
           AVG(
             (julianday(al_leave.created_at) - julianday(al_enter.created_at)) * 24 * 3600
           ) AS avg_seconds,
           COUNT(*) AS sample_count
         FROM sym_audit_log al_enter
         JOIN sym_audit_log al_leave
           ON al_leave.task_id = al_enter.task_id
           AND al_leave.action = 'status_change'
           AND al_leave.old_value = al_enter.new_value
           AND al_leave.created_at > al_enter.created_at
         WHERE al_enter.action = 'status_change'
           AND al_enter.created_at > datetime('now', ?)
         GROUP BY al_enter.new_value
         ORDER BY avg_seconds DESC`
      ).all(windowOffset) as { status: string; avg_seconds: number; sample_count: number }[],
    []
  );
  const dwellTimeByStatus = dwellResult.value.map(r => ({ ...r, avg_seconds: Math.round(r.avg_seconds) }));
  if (dwellResult.error) pipelineErrors.push(`dwellTimeByStatus: ${dwellResult.error}`);

  // 3. Bottleneck detection
  const queueResult = safeQuery(
    () =>
      db.prepare(
        `SELECT status, COUNT(*) AS count
         FROM sym_tasks
         WHERE status NOT IN ('done', 'cancelled')
         GROUP BY status`
      ).all() as { status: string; count: number }[],
    []
  );
  if (queueResult.error) pipelineErrors.push(`bottleneck.queue: ${queueResult.error}`);

  let bottleneck: {
    status: string;
    avg_seconds: number;
    queue_depth: number;
    queue_by_status: { status: string; count: number }[];
  } | null = null;

  if (dwellTimeByStatus.length > 0) {
    const top = dwellTimeByStatus[0];
    const queueDepth = queueResult.value.find(q => q.status === top.status)?.count ?? 0;
    bottleneck = {
      status: top.status,
      avg_seconds: Math.round(top.avg_seconds),
      queue_depth: queueDepth,
      queue_by_status: queueResult.value,
    };
  }

  // 4. Velocity
  const hourlyResult = safeQuery(
    () =>
      db.prepare(
        `SELECT
           strftime('%Y-%m-%dT%H:00:00', created_at) AS hour,
           COUNT(*) AS completed
         FROM sym_audit_log
         WHERE action = 'status_change'
           AND new_value = 'done'
           AND created_at > datetime('now', '-24 hours')
         GROUP BY hour
         ORDER BY hour ASC`
      ).all() as { hour: string; completed: number }[],
    []
  );
  if (hourlyResult.error) pipelineErrors.push(`velocityHourly: ${hourlyResult.error}`);

  const dailyResult = safeQuery(
    () =>
      db.prepare(
        `SELECT
           date(created_at) AS day,
           COUNT(*) AS completed
         FROM sym_audit_log
         WHERE action = 'status_change'
           AND new_value = 'done'
           AND created_at > datetime('now', '-7 days')
         GROUP BY day
         ORDER BY day ASC`
      ).all() as { day: string; completed: number }[],
    []
  );
  if (dailyResult.error) pipelineErrors.push(`velocityDaily: ${dailyResult.error}`);

  // 5. Agent efficiency
  const effResult = safeQuery(
    () =>
      db.prepare(
        `SELECT
           s.role_slug,
           COUNT(CASE WHEN s.status = 'completed' THEN 1 END) AS completed_sessions,
           COUNT(CASE WHEN s.status = 'failed' THEN 1 END) AS failed_sessions,
           COUNT(*) AS total_sessions,
           SUM(s.cost_usd) AS total_cost,
           SUM(s.tokens_in + s.tokens_out) AS total_tokens,
           AVG(
             CASE WHEN s.finished_at IS NOT NULL
             THEN (julianday(s.finished_at) - julianday(s.started_at)) * 24 * 3600
             END
           ) AS avg_duration_seconds,
           CASE
             WHEN COUNT(CASE WHEN s.status = 'completed' THEN 1 END) > 0
             THEN SUM(s.cost_usd) / COUNT(CASE WHEN s.status = 'completed' THEN 1 END)
             ELSE NULL
           END AS cost_per_completed
         FROM sym_agent_sessions s
         WHERE s.started_at > datetime('now', ?)
         GROUP BY s.role_slug
         ORDER BY cost_per_completed DESC`
      ).all(windowOffset) as {
        role_slug: string;
        completed_sessions: number;
        failed_sessions: number;
        total_sessions: number;
        total_cost: number;
        total_tokens: number;
        avg_duration_seconds: number | null;
        cost_per_completed: number | null;
      }[],
    []
  );
  if (effResult.error) pipelineErrors.push(`agentEfficiency: ${effResult.error}`);

  // 6. Failure hotspots
  const errorResult = safeQuery(
    () =>
      db.prepare(
        `SELECT
           error_reason,
           COUNT(*) AS occurrences,
           AVG(duration_seconds) AS avg_duration_seconds
         FROM sym_retry_log
         WHERE executed_at > datetime('now', ?)
           AND error_reason IS NOT NULL
         GROUP BY error_reason
         ORDER BY occurrences DESC
         LIMIT 10`
      ).all(windowOffset) as { error_reason: string; occurrences: number; avg_duration_seconds: number }[],
    []
  );
  if (errorResult.error) pipelineErrors.push(`failureHotspots.byErrorReason: ${errorResult.error}`);

  // Failure rate per role (derived from efficiency query)
  const failureRateByRole = effResult.value.map(r => ({
    role_slug: r.role_slug,
    failure_rate: r.total_sessions > 0 ? r.failed_sessions / r.total_sessions : 0,
    total: r.total_sessions,
  }));

  // 7. Retry frequency
  const topRetriesResult = safeQuery(
    () =>
      db.prepare(
        `SELECT
           rl.task_id,
           COUNT(*) AS retry_count,
           t.title,
           t.type
         FROM sym_retry_log rl
         JOIN sym_tasks t ON t.id = rl.task_id
         WHERE rl.executed_at > datetime('now', ?)
         GROUP BY rl.task_id
         ORDER BY retry_count DESC
         LIMIT 10`
      ).all(windowOffset) as { task_id: number; retry_count: number; title: string; type: string }[],
    []
  );
  if (topRetriesResult.error) pipelineErrors.push(`retryFrequency.topTasks: ${topRetriesResult.error}`);

  const avgRetriesResult = safeQuery(
    () =>
      db.prepare(
        `SELECT
           t.type,
           AVG(rc.retry_count) AS avg_retries,
           MAX(rc.retry_count) AS max_retries
         FROM (
           SELECT task_id, COUNT(*) AS retry_count
           FROM sym_retry_log
           WHERE executed_at > datetime('now', ?)
           GROUP BY task_id
         ) rc
         JOIN sym_tasks t ON t.id = rc.task_id
         GROUP BY t.type`
      ).all(windowOffset) as { type: string; avg_retries: number; max_retries: number }[],
    []
  );
  if (avgRetriesResult.error) pipelineErrors.push(`retryFrequency.avgByType: ${avgRetriesResult.error}`);

  return NextResponse.json({
    // Existing CostDashboard fields
    orchestrator,
    tasksByStatus,
    sessionsByStatus,
    costByRole,
    costByProject,
    dailyCost,
    recentSessions,
    // Pipeline extension
    pipeline: {
      window: windowKey,
      leadTimeByType,
      dwellTimeByStatus,
      bottleneck,
      velocityHourly: windowKey === "7d" ? [] : hourlyResult.value,
      velocityDaily: dailyResult.value,
      agentEfficiency: effResult.value,
      failureHotspots: {
        byErrorReason: errorResult.value,
        failureRateByRole,
      },
      retryFrequency: {
        topTasks: topRetriesResult.value,
        avgByType: avgRetriesResult.value,
      },
    },
    ...(pipelineErrors.length > 0 ? { pipeline_errors: pipelineErrors } : {}),
  });
}
