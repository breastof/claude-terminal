export const ROLE_ABBREVIATIONS: Record<string, string> = {
  analyst: "AN",
  designer: "DS",
  frontend_dev: "FE",
  backend_dev: "BE",
  reviewer: "RV",
  qa_engineer: "QA",
  cto: "CTO",
  pm: "PM",
  scrum_master: "SM",
  researcher: "RS",
};

/** Returns abbreviation if known, otherwise first 3 chars uppercased as fallback */
export function getRoleAbbr(slug: string): string {
  return ROLE_ABBREVIATIONS[slug] ?? slug.slice(0, 3).toUpperCase();
}

export const ROLE_COLORS: Record<string, string> = {
  analyst: "#60a5fa",
  designer: "#a78bfa",
  frontend_dev: "#34d399",
  backend_dev: "#f59e0b",
  reviewer: "#f87171",
  qa_engineer: "#38bdf8",
  cto: "#e879f9",
  pm: "#fb923c",
  scrum_master: "#4ade80",
  researcher: "#94a3b8",
};
