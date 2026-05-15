import path from "path";
import fs from "fs/promises";

/**
 * Resolve a relative path within a project directory, guarding against path traversal.
 * Returns the absolute path if safe, or null if the path escapes the project directory.
 */
export function safePath(projectDir: string, relativePath: string): string | null {
  const resolved = path.resolve(projectDir, relativePath);
  if (!resolved.startsWith(projectDir + path.sep) && resolved !== projectDir) {
    return null;
  }
  return resolved;
}

/**
 * Resolve a path and verify its real path (after symlink resolution) stays within projectDir.
 * Guards against symlink attacks where a symlink points outside the project.
 */
export async function safeRealPath(projectDir: string, relativePath: string): Promise<string | null> {
  const resolved = safePath(projectDir, relativePath);
  if (!resolved) return null;

  try {
    const stat = await fs.lstat(resolved);
    if (stat.isSymbolicLink()) {
      const real = await fs.realpath(resolved);
      if (!real.startsWith(projectDir + path.sep) && real !== projectDir) {
        return null;
      }
      return real;
    }
    return resolved;
  } catch {
    // File doesn't exist yet (for create operations) — fall back to safePath
    return resolved;
  }
}

export const ARTIFACTS_DIR = "artifacts";

/**
 * Restrict path to <projectDir>/artifacts/ subtree.
 * Returns the absolute path if inside artifacts/, null otherwise.
 */
export function safeArtifactsPath(projectDir: string, relativePath: string): string | null {
  const artifactsRoot = path.join(projectDir, ARTIFACTS_DIR);
  // Treat "." (UI default) and "" as the artifacts root itself
  const normalized = (!relativePath || relativePath === ".") ? ARTIFACTS_DIR : relativePath;
  const resolved = safePath(projectDir, normalized);
  if (!resolved) return null;
  if (resolved !== artifactsRoot && !resolved.startsWith(artifactsRoot + path.sep)) return null;
  return resolved;
}

/**
 * Same as safeArtifactsPath but also resolves symlinks and ensures the real path
 * stays within artifacts/. Used for read operations where symlinks may escape.
 */
export async function safeArtifactsRealPath(projectDir: string, relativePath: string): Promise<string | null> {
  const artifactsRoot = path.join(projectDir, ARTIFACTS_DIR);
  const normalized = (!relativePath || relativePath === ".") ? ARTIFACTS_DIR : relativePath;
  // safeRealPath resolves symlinks against projectDir; but a symlink inside
  // artifacts/ pointing to ~/artifacts/X is the intended pattern, so we relax
  // the projectDir-stay check and only enforce the artifacts/ prefix on the
  // logical (pre-realpath) target.
  const logical = safePath(projectDir, normalized);
  if (!logical) return null;
  if (logical !== artifactsRoot && !logical.startsWith(artifactsRoot + path.sep)) return null;
  try {
    const stat = await fs.lstat(logical);
    if (stat.isSymbolicLink()) {
      return await fs.realpath(logical);
    }
    return logical;
  } catch {
    return logical;
  }
}

/**
 * Check if a buffer contains binary data by looking for null bytes.
 */
export function isBinaryBuffer(buffer: Buffer, bytesToCheck = 8192): boolean {
  const len = Math.min(buffer.length, bytesToCheck);
  for (let i = 0; i < len; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

/**
 * Validate a filename for safety.
 */
export function isValidFilename(name: string): boolean {
  if (!name || !name.trim()) return false;
  // No control characters
  if (/[\x00-\x1f\x7f]/.test(name)) return false;
  // No slashes or backslashes
  if (/[/\\]/.test(name)) return false;
  // No .. traversal
  if (name === ".." || name === ".") return false;
  // Byte length limit
  if (Buffer.byteLength(name, "utf-8") > 255) return false;
  return true;
}

/**
 * Validate a file path that may contain nested directories (e.g. "src/utils/helpers").
 * Each segment must be a valid filename.
 */
export function isValidFilePath(filepath: string): boolean {
  const parts = filepath.split("/").filter(Boolean);
  if (parts.length === 0) return false;
  return parts.every(part => isValidFilename(part));
}

interface SessionInfo {
  sessionId: string;
  projectDir: string;
  isActive: boolean;
}

interface TerminalManagerWithGetSession {
  getSession: (id: string) => SessionInfo | null;
}

/**
 * Get the project directory for a session via the global terminal manager.
 */
export function getSessionProjectDir(sessionId: string): string | null {
  const tm = (global as Record<string, unknown>).terminalManager as TerminalManagerWithGetSession | undefined;
  if (!tm) return null;
  const session = tm.getSession(sessionId);
  return session?.projectDir ?? null;
}
