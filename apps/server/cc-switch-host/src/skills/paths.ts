/** Translated from vendor/cc-switch/src-tauri/src/services/skill.rs ("路径管理"). */
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { appDir, dataDir, homeDir } from "../host-context.ts";
import { AppError } from "../errors.ts";
import { getSkillStorageLocation, getSkillSyncMethod } from "../settings.ts";
import { APP_IDS, type AppId, type SyncMethod } from "../types.ts";

const STORAGE_DIR_MODE = 0o700;

/** SSOT skill root: `dataDir/skills` or `homeDir/.agents/skills`, created on demand. */
export function ssotDir(): string {
  const location = getSkillStorageLocation();
  const dir = location === "unified"
    ? path.join(homeDir(), ".agents", "skills")
    : path.join(dataDir(), "skills");
  mkdirSync(dir, { recursive: true, mode: STORAGE_DIR_MODE });
  return dir;
}

/** Managed skill directory under the SSOT root; the directory name is traversal-checked. */
export function installedSkillDir(directory: string): string {
  return path.join(ssotDir(), validateSkillDirectory(directory));
}

/** Uninstall backup root: `dataDir/skill-backups`, created on demand. */
export function backupDir(): string {
  const dir = path.join(dataDir(), "skill-backups");
  mkdirSync(dir, { recursive: true, mode: STORAGE_DIR_MODE });
  return dir;
}

/** Compatibility alias used by the service layer. */
export function skillBackupDir(): string {
  return backupDir();
}

/** Native skills directory of one application: `appDir(app)/skills`. */
export function appSkillsDir(app: AppId): string {
  return path.join(appDir(app), "skills");
}

/**
 * `~/.agents/skills` when the unified storage location is active and the directory
 * exists; headless hosts never scan the shared agents tree for the cc-switch location.
 */
export function agentsSkillsDir(): string | undefined {
  if (getSkillStorageLocation() !== "unified") return undefined;
  const dir = path.join(homeDir(), ".agents", "skills");
  return existsSync(dir) ? dir : undefined;
}

export function skillSyncMethod(): SyncMethod {
  return getSkillSyncMethod();
}

/** Lexical or canonical path identity. Missing paths only compare lexically. */
export function pathsAlias(left: string, right: string): boolean {
  if (left === right) return true;
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

function componentPrefix(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function overlap(left: string, right: string): boolean {
  return left === right || componentPrefix(left, right) || componentPrefix(right, left);
}

/**
 * Component-wise overlap of two paths: equal, ancestor, descendant, a shared
 * canonical target, or the same directory entry reached through aliased parents.
 *
 * The final parent resolution matters for dangling symlinks: `realpath` fails on
 * the entry itself, but two application roots may still point at one parent.
 */
export function pathsOverlap(left: string, right: string): boolean {
  if (overlap(left, right)) return true;

  let canonicalLeft: string | undefined;
  let canonicalRight: string | undefined;
  try { canonicalLeft = realpathSync(left); } catch { canonicalLeft = undefined; }
  try { canonicalRight = realpathSync(right); } catch { canonicalRight = undefined; }
  if (canonicalLeft !== undefined && canonicalRight !== undefined && overlap(canonicalLeft, canonicalRight)) return true;

  const entry = (value: string): string | undefined => {
    try {
      return path.join(realpathSync(path.dirname(value)), path.basename(value));
    } catch {
      return undefined;
    }
  };
  const entryLeft = entry(left);
  const entryRight = entry(right);
  return entryLeft !== undefined && entryRight !== undefined && overlap(entryLeft, entryRight);
}

/** The SSOT root may never be the same directory as an application's skills root. */
export function ensureDistinctSkillRoots(ssot: string, appSkills: string, app: AppId): void {
  if (pathsAlias(ssot, appSkills)) {
    throw new AppError("INVALID_INPUT", `Skill storage directory must differ from ${app} skills directory: ${ssot}`);
  }
}

/** App skills root that is guaranteed not to alias the SSOT root. */
export function distinctAppSkillsDir(ssot: string, app: AppId): string {
  const dir = appSkillsDir(app);
  ensureDistinctSkillRoots(ssot, dir, app);
  return dir;
}

/** Validate a prospective SSOT root against every application skills root. */
export function validateSkillStorageDestination(ssot: string): void {
  for (const app of APP_IDS) {
    ensureDistinctSkillRoots(ssot, appSkillsDir(app), app);
  }
}

/**
 * Normalize a single-segment install name exactly like the Rust installer:
 * rejects both separators, dot names, leading-dot names and blank results.
 * Returns the normalized value; callers that must not mutate the stored value
 * compare it with the raw input (see `validateSkillDirectory`).
 */
export function sanitizeInstallName(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  if (trimmed.includes("/") || trimmed.includes("\\")) return undefined;
  if (trimmed === "." || trimmed === ".." || trimmed.startsWith(".")) return undefined;
  return trimmed;
}

/** Validate and normalize a multi-segment skill source path (no absolute/traversal). */
export function sanitizeSkillSourcePath(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  if (path.isAbsolute(trimmed)) return undefined;

  const segments: string[] = [];
  // `Path::components` collapses empty components and only treats `/` as a
  // separator on this platform; a backslash stays part of a normal segment.
  for (const part of trimmed.split("/")) {
    if (part === "") continue;
    const segment = part.trim();
    if (segment === "" || segment === "." || segment === "..") return undefined;
    segments.push(segment);
  }
  if (segments.length === 0) return undefined;
  return path.join(...segments);
}

/**
 * Validate a directory name coming from a database row or a backup `meta.json`.
 * The value must already be a normalized single segment; a normalized-but-different
 * value means the on-disk directory would not match, so it is rejected.
 */
export function validateSkillDirectory(directory: string): string {
  const normalized = sanitizeInstallName(directory);
  if (normalized === undefined || normalized !== directory) {
    throw new AppError("INVALID_INPUT", `Invalid skill directory (possible path traversal): ${JSON.stringify(directory)}`);
  }
  return normalized;
}

/** Compatibility alias used by the service layer. */
export function requireValidDirectory(directory: string): string {
  return validateSkillDirectory(directory);
}

/** Filesystem-safe segment for backup directory names and temporary siblings. */
export function sanitizeBackupSegment(segment: string): string {
  const sanitized = segment
    .replace(/[^a-zA-Z0-9\-_.]/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return sanitized === "" ? "skill" : sanitized;
}

/** Opaque backup directory name -> absolute path; separators and dot-dot are refused. */
export function backupPathForId(backupId: string): string {
  if (backupId.includes("..") || backupId.includes("/") || backupId.includes("\\") || backupId.trim() === "") {
    throw new AppError("INVALID_INPUT", `Invalid backup id: ${backupId}`);
  }
  return path.join(backupDir(), backupId);
}

/** Claude Desktop/OpenClaw/Pi/OMP are not projected by the generic resync loop. */
export function isSyncManagedApp(app: AppId): boolean {
  return app !== "pi" && app !== "omp";
}
