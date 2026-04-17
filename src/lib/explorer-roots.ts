import path from "path";

export interface ExplorerRoot {
  path: string;
  writable: boolean;
  label: string;
}

export const ROOTS: Record<string, ExplorerRoot> = {
  hub:     { path: "/root/hub",              writable: true,  label: "Hub" },
  config:  { path: "/root/.claude",          writable: true,  label: "POS Config" },
  skills:  { path: "/root/.claude/skills",   writable: true,  label: "Skills" },
  memory:  { path: "/root/.claude/projects", writable: false, label: "Memory" },
};

// Patterns that are always denied
const DENY_PATTERNS = [
  /\.credentials\.json$/i,
  /\.env($|\.)/i,
  /\.key$/i,
  /\.pem$/i,
  /\.git\/objects\//,
  /node_modules\//,
  /\.sessions\.json$/,
];

export function getRoot(rootKey: string): ExplorerRoot | null {
  return ROOTS[rootKey] || null;
}

export function isDenied(filePath: string): boolean {
  return DENY_PATTERNS.some(pattern => pattern.test(filePath));
}

export function safeExplorerPath(root: ExplorerRoot, relativePath: string): string | null {
  const resolved = path.resolve(root.path, relativePath);
  if (!resolved.startsWith(root.path + path.sep) && resolved !== root.path) {
    return null;
  }
  if (isDenied(resolved)) {
    return null;
  }
  return resolved;
}
