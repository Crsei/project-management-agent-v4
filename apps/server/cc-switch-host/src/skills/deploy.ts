/** Translated from vendor/cc-switch/src-tauri/src/services/skill.rs (symlink/copy deployment). */
import { readdirSync, readlinkSync, realpathSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { AppError } from "../errors.ts";
import { requireApp } from "../host-context.ts";
import type { AppId, InstalledSkill } from "../types.ts";
import {
  createDirSymlink,
  copyDirRecursive,
  ensureDir,
  isSymlink,
  pathEntryExists,
  pathExists,
  removePath,
} from "./fs.ts";
import { computePiDeploymentHash } from "./hash.ts";
import {
  appSkillsDir,
  distinctAppSkillsDir,
  isSyncManagedApp,
  pathsOverlap,
  sanitizeBackupSegment,
  skillSyncMethod,
  ssotDir,
  validateSkillDirectory,
} from "./paths.ts";

/** How a Pi-style native directory is currently deployed from the SSOT copy. */
export type PiSkillDeployment =
  | { kind: "symlink"; expectedTarget: string }
  | { kind: "copy"; expectedHash: string };

const GUARDED_APPS: Readonly<Partial<Record<AppId, true>>> = {
  pi: true, mcode: true, agy: true, kimi: true, dsh: true, omp: true,
};
const EXTERNALLY_MANAGED_APPS: Readonly<Partial<Record<AppId, true>>> = {
  mcode: true, agy: true, kimi: true, dsh: true,
};

function within(child: string, parent: string): boolean {
  if (child === parent) return true;
  const relative = path.relative(parent, child);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function joinRaw(parent: string, target: string): string {
  return parent.endsWith(path.sep) ? `${parent}${target}` : `${parent}${path.sep}${target}`;
}

function linkTarget(destination: string): string {
  const target = readlinkSync(destination);
  return path.isAbsolute(target)
    ? target
    : joinRaw(path.dirname(destination), target);
}

function unverifiableDestination(directory: string): AppError {
  return new AppError("CONFIG", `Native skill differs from the managed copy, refusing to overwrite or delete: ${directory}`);
}

function changedDuringOperation(directory: string): AppError {
  return new AppError("CONFIG", `Native skill changed during the operation, refusing to overwrite: ${directory}`);
}

/** WSL UNC targets reject directory symlinks outright, so `auto` must copy. */
function isWslPath(target: string): boolean {
  if (process.platform !== "win32") return false;
  const normalized = target.toLowerCase();
  return normalized.startsWith("\\\\wsl$\\") || normalized.startsWith("\\\\wsl.localhost\\");
}

export function skillExistsInApp(directory: string, app: AppId): boolean {
  let safeDirectory: string;
  try {
    safeDirectory = validateSkillDirectory(directory);
  } catch {
    return false;
  }
  try {
    return statSync(path.join(appSkillsDir(app), safeDirectory)).isDirectory();
  } catch {
    return false;
  }
}

export function validateSyncSourceDir(source: string, directory: string): void {
  let metadata;
  try {
    metadata = statSync(source);
  } catch {
    metadata = undefined;
  }
  if (!metadata?.isDirectory()) {
    throw new AppError("CONFIG", `Skill does not exist in SSOT: ${directory}`);
  }

  let manifest;
  try {
    manifest = statSync(path.join(source, "SKILL.md"));
  } catch {
    manifest = undefined;
  }
  if (!manifest?.isFile()) {
    throw new AppError("CONFIG", `Skill source directory is missing SKILL.md, refusing to overwrite: ${source}`);
  }
}

/**
 * Inspect a native Pi-style skill directory and classify its deployment.
 * A same-named directory that is neither a link to the SSOT copy nor an
 * exact-content copy is treated as user-owned and must not be replaced.
 */
export function inspectPiSkillDestination(
  source: string,
  destination: string,
  directory: string,
): PiSkillDeployment | undefined {
  if (!pathEntryExists(destination)) return undefined;

  if (isSymlink(destination)) {
    const resolved = linkTarget(destination);
    try {
      if (realpathSync(resolved) === realpathSync(source)) {
        return { kind: "symlink", expectedTarget: resolved };
      }
    } catch {
      // Dangling or unreadable links cannot be verified as ours.
    }
  } else {
    let isDirectory = false;
    try { isDirectory = statSync(destination).isDirectory(); } catch { isDirectory = false; }
    if (isDirectory) {
      try {
        const destinationHash = computePiDeploymentHash(destination);
        const sourceHash = computePiDeploymentHash(source);
        if (destinationHash === sourceHash) {
          return { kind: "copy", expectedHash: destinationHash };
        }
      } catch {
        // Unreadable trees are handled as foreign content below.
      }
    }
  }

  throw unverifiableDestination(directory);
}

export function ensurePiSkillDestinationMatches(source: string, destination: string, directory: string): void {
  inspectPiSkillDestination(source, destination, directory);
}

export function removeVerifiedPiDestination(source: string, destination: string, directory: string): void {
  if (inspectPiSkillDestination(source, destination, directory) !== undefined) removePath(destination);
}

/**
 * Replace a verified Pi-style destination with the current managed content.
 * The deployment snapshot is re-checked so a concurrent change cannot be
 * overwritten by a stale decision.
 */
export function refreshPiSkillDestination(
  source: string,
  destination: string,
  directory: string,
  deployment: PiSkillDeployment,
): void {
  validateSyncSourceDir(source, directory);

  if (deployment.kind === "symlink") {
    if (!isSymlink(destination) || linkTarget(destination) !== deployment.expectedTarget) {
      throw changedDuringOperation(directory);
    }
    removePath(destination);
    createDirSymlink(source, destination);
    return;
  }

  let isDirectory = false;
  try { isDirectory = statSync(destination).isDirectory(); } catch { isDirectory = false; }
  if (isSymlink(destination) || !isDirectory) throw changedDuringOperation(directory);

  let currentHash: string;
  try {
    currentHash = computePiDeploymentHash(destination);
  } catch {
    throw changedDuringOperation(directory);
  }
  if (currentHash !== deployment.expectedHash) throw changedDuringOperation(directory);

  replaceDestWithCopy(source, destination, directory);
}

export function preflightInstallDestination(source: string, directory: string, app: AppId): void {
  const ssot = ssotDir();
  const appDir = distinctAppSkillsDir(ssot, app);
  if (GUARDED_APPS[app] !== true) return;

  const destination = path.join(appDir, directory);
  if (pathEntryExists(destination)) ensurePiSkillDestinationMatches(source, destination, directory);
}

/** Copy through a temporary sibling and rename, so a failed copy never truncates the destination. */
export function replaceDestWithCopy(source: string, destination: string, directory: string): void {
  validateSyncSourceDir(source, directory);

  const parent = path.dirname(destination);
  ensureDir(parent);

  const temporary = path.join(
    parent,
    `.${sanitizeBackupSegment(directory)}.tmp-${process.pid}-${process.hrtime.bigint()}`,
  );
  if (pathEntryExists(temporary)) removePath(temporary);

  try {
    copyDirRecursive(source, temporary);
  } catch (error) {
    try { removePath(temporary); } catch { /* preserve the copy failure */ }
    throw error;
  }

  if (pathEntryExists(destination)) removePath(destination);

  try {
    renameSync(temporary, destination);
  } catch (error) {
    try { removePath(temporary); } catch { /* preserve the rename failure */ }
    throw new AppError("IO", `Failed to replace skill directory: ${temporary} -> ${destination}: ${String(error)}`);
  }
}

/** True when `target` is a symlink whose resolved target lives inside the SSOT root. */
export function isSymlinkToSsot(target: string, ssot: string): boolean {
  if (!isSymlink(target)) return false;

  let link: string;
  try {
    link = readlinkSync(target);
  } catch {
    return false;
  }

  if (path.isAbsolute(link) && within(link, ssot)) return true;

  const resolved = path.isAbsolute(link) ? link : joinRaw(path.dirname(target), link);
  let canonicalSsot: string;
  let canonicalTarget: string;
  try { canonicalSsot = realpathSync(ssot); } catch { canonicalSsot = ssot; }
  try { canonicalTarget = realpathSync(resolved); } catch { canonicalTarget = resolved; }
  return within(canonicalTarget, canonicalSsot);
}

/**
 * Project one managed skill into an application skills directory. `auto`
 * prefers a directory symlink and falls back to a full copy.
 */
export function syncToAppDir(directory: string, app: AppId): void {
  requireApp(app);

  const safeDirectory = validateSkillDirectory(directory);
  const ssot = ssotDir();
  const source = path.join(ssot, safeDirectory);
  validateSyncSourceDir(source, safeDirectory);

  const appDir = distinctAppSkillsDir(ssot, app);
  ensureDir(appDir);

  const destination = path.join(appDir, safeDirectory);
  if (GUARDED_APPS[app] === true && pathEntryExists(destination)) {
    ensurePiSkillDestinationMatches(source, destination, safeDirectory);
  }

  let method = skillSyncMethod();
  if (method === "auto" && isWslPath(destination)) method = "copy";

  if (method === "auto") {
    if (pathExists(destination) && !isSymlink(destination)) {
      replaceDestWithCopy(source, destination, safeDirectory);
      return;
    }
    if (isSymlink(destination)) removePath(destination);

    try {
      createDirSymlink(source, destination);
      return;
    } catch {
      // Fall back to copying when the platform or filesystem refuses symlinks.
    }
    replaceDestWithCopy(source, destination, safeDirectory);
    return;
  }

  if (method === "symlink") {
    if (pathEntryExists(destination)) removePath(destination);
    createDirSymlink(source, destination);
    return;
  }

  replaceDestWithCopy(source, destination, safeDirectory);
}

export function removeFromAppPreserving(
  directory: string,
  app: AppId,
  preservedPaths: readonly string[] = [],
): void {
  const safeDirectory = validateSkillDirectory(directory);
  const ssot = ssotDir();
  const skillPath = path.join(distinctAppSkillsDir(ssot, app), safeDirectory);

  if (preservedPaths.some((preserved) => pathsOverlap(skillPath, preserved))) return;
  if (!pathEntryExists(skillPath)) return;

  if (GUARDED_APPS[app] === true) {
    ensurePiSkillDestinationMatches(path.join(ssot, safeDirectory), skillPath, safeDirectory);
  }
  removePath(skillPath);
}

export function removeFromApp(directory: string, app: AppId): void {
  removeFromAppPreserving(directory, app, []);
}

/** Minimal durable contract for the skills DAO used by `syncToApp`. */
export interface SkillInstallStore {
  getAllInstalled(): Map<string, InstalledSkill>;
}

/**
 * Project every skill enabled for `app` and remove stale projections. Failures
 * for individual skills are skipped so one bad row cannot break the whole app.
 */
export function syncToApp(
  db: { readonly skills: SkillInstallStore } | SkillInstallStore,
  app: AppId,
): void {
  if (!isSyncManagedApp(app)) return;

  const skills = "skills" in db ? db.skills.getAllInstalled() : db.getAllInstalled();
  const ssot = ssotDir();
  const appDir = distinctAppSkillsDir(ssot, app);

  const indexed = new Map<string, InstalledSkill>();
  for (const skill of skills.values()) indexed.set(skill.directory.toLowerCase(), skill);

  if (pathExists(appDir) && EXTERNALLY_MANAGED_APPS[app] !== true) {
    for (const name of readdirSync(appDir)) {
      if (name.startsWith(".")) continue;
      const entryPath = path.join(appDir, name);

      const skill = indexed.get(name.toLowerCase());
      if (skill !== undefined) {
        if (!skill.apps[app]) removePath(entryPath);
        continue;
      }

      if (isSymlinkToSsot(entryPath, ssot)) removePath(entryPath);
    }
  }

  for (const skill of skills.values()) {
    if (!skill.apps[app]) continue;
    try {
      syncToAppDir(skill.directory, app);
    } catch {
      // Individual failures are reported by the caller's resync wrapper.
    }
  }
}
