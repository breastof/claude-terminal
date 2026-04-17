export interface RoleColor {
  label: string;
  hex: string;
  bg: string;
  text: string;
  ring: string;
  bgLight: string;
}

export const ROLE_COLORS: Record<string, RoleColor> = {
  "cto":            { label: "CTO",            hex: "#8b5cf6", bg: "bg-violet-500",  text: "text-violet-400",  ring: "ring-violet-500/40",  bgLight: "bg-violet-500/20"  },
  "pm":             { label: "PM",             hex: "#06b6d4", bg: "bg-cyan-500",    text: "text-cyan-400",    ring: "ring-cyan-500/40",    bgLight: "bg-cyan-500/20"    },
  "scrum-master":   { label: "Scrum Master",   hex: "#14b8a6", bg: "bg-teal-500",    text: "text-teal-400",    ring: "ring-teal-500/40",    bgLight: "bg-teal-500/20"    },
  "analyst":        { label: "Analyst",        hex: "#f59e0b", bg: "bg-amber-500",   text: "text-amber-400",   ring: "ring-amber-500/40",   bgLight: "bg-amber-500/20"   },
  "researcher":     { label: "Researcher",     hex: "#6366f1", bg: "bg-indigo-500",  text: "text-indigo-400",  ring: "ring-indigo-500/40",  bgLight: "bg-indigo-500/20"  },
  "designer":       { label: "Designer",       hex: "#ec4899", bg: "bg-pink-500",    text: "text-pink-400",    ring: "ring-pink-500/40",    bgLight: "bg-pink-500/20"    },
  "frontend-dev":   { label: "Frontend Dev",   hex: "#3b82f6", bg: "bg-blue-500",    text: "text-blue-400",    ring: "ring-blue-500/40",    bgLight: "bg-blue-500/20"    },
  "backend-dev":    { label: "Backend Dev",    hex: "#10b981", bg: "bg-emerald-500", text: "text-emerald-400", ring: "ring-emerald-500/40", bgLight: "bg-emerald-500/20" },
  "reviewer":       { label: "Reviewer",       hex: "#f97316", bg: "bg-orange-500",  text: "text-orange-400",  ring: "ring-orange-500/40",  bgLight: "bg-orange-500/20"  },
  "qa":             { label: "QA",             hex: "#f43f5e", bg: "bg-rose-500",    text: "text-rose-400",    ring: "ring-rose-500/40",    bgLight: "bg-rose-500/20"    },
};

const FALLBACK_COLOR: RoleColor = {
  label: "Unknown",
  hex: "#71717a",
  bg: "bg-zinc-500",
  text: "text-zinc-400",
  ring: "ring-zinc-500/40",
  bgLight: "bg-zinc-500/20",
};

export function getRoleColor(slug: string | null | undefined): RoleColor {
  if (!slug) return FALLBACK_COLOR;
  return ROLE_COLORS[slug] ?? FALLBACK_COLOR;
}
