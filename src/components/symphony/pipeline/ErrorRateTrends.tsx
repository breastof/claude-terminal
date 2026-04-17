"use client";

import { getRoleAbbr, ROLE_COLORS } from "./roleUtils";

interface DayData {
  date: string;
  failureRate: number;
  total: number;
}

interface RoleErrorRate {
  role: string;
  days: DayData[];
}

interface ErrorRateTrendsProps {
  data: RoleErrorRate[];
}

export default function ErrorRateTrends({ data }: ErrorRateTrendsProps) {
  const rolesWithErrors = data.filter((r) =>
    r.days.some((d) => d.failureRate > 0)
  );

  if (rolesWithErrors.length === 0) {
    return (
      <div className="bg-surface-alt border border-border rounded-lg p-4">
        <h3 className="text-xs font-medium text-muted-fg mb-3">Error Rate (7d)</h3>
        <div className="flex items-center justify-center h-32">
          <p className="text-green-400 text-xs">No errors in the last 7 days</p>
        </div>
      </div>
    );
  }

  const viewW = 700;
  const viewH = 200;
  const padL = 36;
  const padR = 12;
  const padT = 8;
  const padB = 28;
  const chartW = viewW - padL - padR;
  const chartH = viewH - padT - padB;

  const dateLabels = rolesWithErrors[0]?.days.map((d) => d.date.slice(5)) ?? [];
  const numDays = dateLabels.length || 1;

  function xPos(i: number) {
    return padL + (i / (numDays - 1 || 1)) * chartW;
  }

  function yPos(rate: number) {
    return padT + chartH - (rate / 100) * chartH;
  }

  return (
    <div className="bg-surface-alt border border-border rounded-lg p-4">
      <h3 className="text-xs font-medium text-muted-fg mb-3">Error Rate (7d)</h3>
      <svg viewBox={`0 0 ${viewW} ${viewH}`} width="100%" className="min-w-[300px]">
        {/* Y-axis labels */}
        <text x={padL - 4} y={padT + 4} textAnchor="end" fill="#71717a" fontSize={9}>100%</text>
        <text x={padL - 4} y={yPos(50) + 3} textAnchor="end" fill="#71717a" fontSize={9}>50%</text>
        <text x={padL - 4} y={padT + chartH + 4} textAnchor="end" fill="#71717a" fontSize={9}>0%</text>

        {/* Grid lines */}
        <line x1={padL} y1={yPos(50)} x2={viewW - padR} y2={yPos(50)} stroke="#27272a" strokeDasharray="4 4" />
        <line x1={padL} y1={padT + chartH} x2={viewW - padR} y2={padT + chartH} stroke="#3f3f46" />

        {/* X-axis labels */}
        {dateLabels.map((label, i) => (
          <text
            key={i}
            x={xPos(i)}
            y={viewH - 4}
            textAnchor="middle"
            fill="#71717a"
            fontSize={9}
          >
            {label}
          </text>
        ))}

        {/* Lines per role */}
        {rolesWithErrors.map((role) => {
          const color = ROLE_COLORS[role.role] ?? "#6b7280";
          const points = role.days.map((d, i) => `${xPos(i)},${yPos(d.failureRate)}`).join(" ");
          return (
            <g key={role.role}>
              <polyline
                points={points}
                fill="none"
                stroke={color}
                strokeWidth={1.5}
                strokeLinejoin="round"
              />
              {role.days.map((d, i) => (
                <circle
                  key={i}
                  cx={xPos(i)}
                  cy={yPos(d.failureRate)}
                  r={3}
                  fill={color}
                >
                  <title>{role.role}: {d.failureRate.toFixed(1)}% ({d.total} sessions)</title>
                </circle>
              ))}
            </g>
          );
        })}
      </svg>

      {/* Legend */}
      <div className="flex flex-wrap gap-3 mt-2">
        {rolesWithErrors.map((role) => (
          <div key={role.role} className="flex items-center gap-1.5">
            <span
              className="w-2.5 h-2.5 rounded-sm inline-block"
              style={{ backgroundColor: ROLE_COLORS[role.role] ?? "#6b7280" }}
            />
            <span className="text-[10px] text-muted-fg" title={role.role}>{getRoleAbbr(role.role)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
