/**
 * Canonical role color mapping for all 10 Symphony agent roles.
 * Hex values — use as inline style: style={{ color: ROLE_COLORS[role] }}
 */
export const ROLE_COLORS: Record<string, string> = {
  cto: "#dc2626",
  pm: "#8b5cf6",
  "scrum-master": "#06b6d4",
  analyst: "#f59e0b",
  researcher: "#a78bfa",
  designer: "#ec4899",
  "frontend-dev": "#3b82f6",
  "backend-dev": "#10b981",
  "code-reviewer": "#f97316",
  "qa-engineer": "#14b8a6",
};

/** Default color for unknown/missing roles */
export const ROLE_COLOR_DEFAULT = "#71717a";

/** Default Tailwind bg class for unknown/missing roles */
export const ROLE_COLORS_TAILWIND_DEFAULT = "bg-zinc-500";

/**
 * Tailwind bg class equivalents — use for className-based coloring
 * (e.g. timeline bars in PipelineHealth)
 */
export const ROLE_COLORS_TAILWIND: Record<string, string> = {
  cto: "bg-red-600",
  pm: "bg-violet-500",
  "scrum-master": "bg-cyan-500",
  analyst: "bg-amber-500",
  researcher: "bg-violet-400",
  designer: "bg-pink-500",
  "frontend-dev": "bg-blue-500",
  "backend-dev": "bg-emerald-500",
  "code-reviewer": "bg-orange-500",
  "qa-engineer": "bg-teal-500",
};
