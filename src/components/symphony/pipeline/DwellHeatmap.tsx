"use client";

interface HeatmapBucket {
  label: string;
  avgMinutes: number | null;
}

interface HeatmapRow {
  status: string;
  buckets: HeatmapBucket[];
}

const STATUS_LABELS: Record<string, string> = {
  backlog: "Backlog",
  analysis: "Analysis",
  design: "Design",
  development: "Dev",
  code_review: "Review",
  qa: "QA",
  done: "Done",
};

const FULL_DANGER_MINUTES = 60;

interface DwellHeatmapProps {
  data: HeatmapRow[];
}

export default function DwellHeatmap({ data }: DwellHeatmapProps) {
  const hasData = data.some((row) => row.buckets.some((b) => (b.avgMinutes ?? 0) > 0));

  return (
    <div className="bg-surface-alt border border-border rounded-lg p-4">
      <h3 className="text-xs font-medium text-muted-fg mb-3">Time-in-Status Heatmap</h3>
      {!hasData ? (
        <div className="flex items-center justify-center h-32">
          <p className="text-muted text-xs">No history yet</p>
        </div>
      ) : (
        <div className="grid grid-cols-5 gap-1 text-[10px]">
          <div />
          {data[0]?.buckets.map((b, i) => (
            <div key={i} className="text-center text-muted-fg font-medium px-1 truncate">
              {b.label}
            </div>
          ))}
          {data.map((row) => (
            <div key={row.status} className="contents">
              <div className="flex items-center text-muted-fg font-medium pr-1 truncate">
                {STATUS_LABELS[row.status] ?? row.status}
              </div>
              {row.buckets.map((bucket, i) => {
                const opacity = bucket.avgMinutes != null ? Math.min(1, bucket.avgMinutes / FULL_DANGER_MINUTES) : 0;
                return (
                  <div
                    key={i}
                    className="h-8 rounded flex items-center justify-center"
                    style={{ background: `color-mix(in srgb, var(--th-danger) ${Math.round(opacity * 100)}%, transparent)` }}
                    title={bucket.avgMinutes != null ? bucket.avgMinutes.toFixed(1) + ' min avg' : 'No data'}
                  >
                    <span className="text-[10px] text-muted-fg leading-none select-none">
                      {bucket.avgMinutes != null ? bucket.avgMinutes.toFixed(1) : "\u2013"}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
