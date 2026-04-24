import path from "path";
import os from "os";

export interface ExplorerRoot {
  path: string;
  writable: boolean;
  label: string;
}

const HOME = os.homedir();

export const ROOTS: Record<string, ExplorerRoot> = {
  hub:     { path: `${HOME}/hub`,              writable: true,  label: "Hub" },
  config:  { path: `${HOME}/.claude`,          writable: true,  label: "POS Config" },
  skills:  { path: `${HOME}/.claude/skills`,   writable: true,  label: "Skills" },
  memory:  { path: `${HOME}/.claude/projects`, writable: false, label: "Memory" },
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
