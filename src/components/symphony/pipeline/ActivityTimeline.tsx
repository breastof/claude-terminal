"use client";

import { getRoleAbbr, ROLE_COLORS } from "./roleUtils";

interface Session {
  id: number;
  role_slug: string;
  task_id: number;
  status: "completed" | "failed" | "running";
  started_at: string;
  finished_at: string | null;
  cost_usd: number;
}

interface ActivityTimelineProps {
  sessions: Session[];
}

export default function ActivityTimeline({ sessions }: ActivityTimelineProps) {
  if (sessions.length === 0) {
    return (
      <div className="bg-surface-alt border border-border rounded-lg p-4">
        <h3 className="text-xs font-medium text-muted-fg mb-3">Agent Activity</h3>
        <div className="flex items-center justify-center h-32">
          <p className="text-muted text-xs">No recent sessions</p>
        </div>
      </div>
    );
  }

  const now = Date.now();
  const times = sessions.map((s) => new Date(s.started_at).getTime());
  const endTimes = sessions.map((s) =>
    s.finished_at ? new Date(s.finished_at).getTime() : now
  );
  const minTime = Math.min(...times);
  const maxTime = Math.max(...endTimes, now);
  const range = maxTime - minTime || 1;

  const barHeight = 20;
  const rowHeight = 28;
  const labelWidth = 48;
  const chartWidth = 600;
  const svgWidth = chartWidth + labelWidth;
  const svgHeight = sessions.length * rowHeight;

  return (
    <div className="bg-surface-alt border border-border rounded-lg p-4">
      <h3 className="text-xs font-medium text-muted-fg mb-3">Agent Activity</h3>
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${svgWidth} ${svgHeight}`}
          width="100%"
          className="min-w-[400px]"
        >
          {sessions.map((session, i) => {
            const startX =
              labelWidth +
              ((new Date(session.started_at).getTime() - minTime) / range) * chartWidth;
            const endX =
              labelWidth +
              (((session.finished_at
                ? new Date(session.finished_at).getTime()
                : now) -
                minTime) /
                range) *
                chartWidth;
            const width = Math.max(endX - startX, 2);
            const color = ROLE_COLORS[session.role_slug] ?? "#6b7280";
            const y = i * rowHeight;

            return (
              <g key={session.id}>
                <text
                  x={labelWidth - 4}
                  y={y + rowHeight / 2 + 1}
                  textAnchor="end"
                  fill="#71717a"
                  fontSize={9}
                  fontFamily="inherit"
                >
                  {getRoleAbbr(session.role_slug)}
                </text>
                <rect
                  x={startX}
                  y={y + (rowHeight - barHeight) / 2}
                  width={width}
                  height={barHeight}
                  rx={3}
                  fill={color}
                  opacity={0.8}
                  stroke={session.status === "failed" ? "#ef4444" : "none"}
                  strokeWidth={session.status === "failed" ? 1.5 : 0}
                  className={session.status === "running" ? "animate-pulse" : ""}
                >
                  <title>
                    {session.role_slug} — Task #{session.task_id} ({session.status})
                    {"\n"}${session.cost_usd.toFixed(4)}
                  </title>
                </rect>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
