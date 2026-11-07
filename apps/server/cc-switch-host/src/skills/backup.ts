/** Translated from vendor/cc-switch/src-tauri/src/services/skill.rs (uninstall backup helpers). */
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { BACKUP_RETAIN_COUNT } from "../constants.ts";
import { AppError } from "../errors.ts";
import { emptyAppFlags, APP_IDS, type AppId, type AppFlags, type InstalledSkill, type SkillBackupEntry } from "../types.ts";
import { copyDirRecursive, pathEntryExists, removePath, writeJsonFileAtomic } from "./fs.ts";
import { computeDirHash } from "./hash.ts";
import {
  appSkillsDir,
  backupDir,
  backupPathForId,
  pathsOverlap,
  sanitizeBackupSegment,
  ssotDir,
  validateSkillDirectory,
} from "./paths.ts";

export interface SkillBackupMetadata {
  skill: InstalledSkill;
  backupCreatedAt: number;
  sourcePath: string;
}

/** Hooks that let the service layer persist and project a restored skill. */
export interface RestoreHooks {
  save(skill: InstalledSkill): void;
  delete(id: string): void;
  sync(directory: string): void;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** `str::eq_ignore_ascii_case`: only A-Z fold, Unicode case is significant. */
function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function timestampSegment(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}_`
    + `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

function intField(value: unknown, key: string, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new AppError("CONFIG", `Invalid skill backup ${label}: ${key} must be an integer`);
  }
  return value;
}

function stringField(value: unknown, key: string, label: string): string {
  if (typeof value !== "string") {
    throw new AppError("CONFIG", `Invalid skill backup ${label}: ${key} must be a string`);
  }
  return value;
}

function optionalString(value: unknown, key: string, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return stringField(value, key, label);
}

function parseAppFlags(value: unknown, label: string): AppFlags {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("CONFIG", `Invalid skill backup ${label}: apps must be an object`);
  }
  const object = value as Record<string, unknown>;
  const flags = emptyAppFlags();
  for (const app of APP_IDS) {
    const enabled = object[app];
    if (enabled === undefined) continue;
    if (typeof enabled !== "boolean") {
      throw new AppError("CONFIG", `Invalid skill backup ${label}: apps.${app} must be a boolean`);
    }
    flags[app] = enabled;
  }
  return flags;
}

/** Deserialize an `InstalledSkill` the way serde does: required fields, dropped unknowns. */
function parseInstalledSkill(value: unknown): InstalledSkill {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("CONFIG", "Invalid skill backup: skill must be an object");
  }
  const object = value as Record<string, unknown>;

  const updatedAt = object.updatedAt === undefined
    ? 0
    : intField(object.updatedAt, "updatedAt", "skill");

  const skill: InstalledSkill = {
    id: stringField(object.id, "id", "skill"),
    name: stringField(object.name, "name", "skill"),
    directory: stringField(object.directory, "directory", "skill"),
    apps: parseAppFlags(object.apps, "skill"),
    installedAt: intField(object.installedAt, "installedAt", "skill"),
    updatedAt,
  };

  const description = optionalString(object.description, "description", "skill");
  if (description !== undefined) skill.description = description;
  const repoOwner = optionalString(object.repoOwner, "repoOwner", "skill");
  if (repoOwner !== undefined) skill.repoOwner = repoOwner;
  const repoName = optionalString(object.repoName, "repoName", "skill");
  if (repoName !== undefined) skill.repoName = repoName;
  const repoBranch = optionalString(object.repoBranch, "repoBranch", "skill");
  if (repoBranch !== undefined) skill.repoBranch = repoBranch;
  const readmeUrl = optionalString(object.readmeUrl, "readmeUrl", "skill");
  if (readmeUrl !== undefined) skill.readmeUrl = readmeUrl;
  const contentHash = optionalString(object.contentHash, "contentHash", "skill");
  if (contentHash !== undefined) skill.contentHash = contentHash;

  return skill;
}

export function readSkillBackupMetadata(backupPath: string): SkillBackupMetadata {
  const metadataPath = path.join(backupPath, "meta.json");
  let text: string;
  try {
    text = readFileSync(metadataPath, "utf8");
  } catch (error) {
    throw new AppError("IO", `failed to read ${metadataPath}: ${String(error)}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new AppError("CONFIG", `failed to parse ${metadataPath}: ${String(error)}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("CONFIG", `failed to parse ${metadataPath}: expected a metadata object`);
  }
  const object = value as Record<string, unknown>;

  // `SkillBackupMetadata` has no serde rename attribute, so its on-disk keys are
  // snake_case while the nested `InstalledSkill` stays camelCase.
  try {
    return {
      skill: parseInstalledSkill(object.skill),
      backupCreatedAt: intField(object.backup_created_at, "backup_created_at", "metadata"),
      sourcePath: stringField(object.source_path, "source_path", "metadata"),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new AppError("CONFIG", `failed to parse ${metadataPath}: ${detail}`);
  }
}

/** Compatibility alias used by the service layer. */
export function readBackupMetadata(backupPath: string): SkillBackupMetadata {
  return readSkillBackupMetadata(backupPath);
}

/** List every readable backup under the backup root, newest first. */
export function listBackups(): SkillBackupEntry[] {
  const root = backupDir();
  let names: string[];
  try {
    names = readdirSync(root);
  } catch (error) {
    throw new AppError("IO", `failed to read ${root}: ${String(error)}`);
  }

  const entries: SkillBackupEntry[] = [];
  for (const name of names) {
    const backupPath = path.join(root, name);
    try {
      if (!statSync(backupPath).isDirectory()) continue;
    } catch {
      continue;
    }
    try {
      const metadata = readSkillBackupMetadata(backupPath);
      entries.push({
        backupId: name,
        backupPath,
        createdAt: metadata.backupCreatedAt,
        skill: metadata.skill,
      });
    } catch {
      // Unreadable backups are skipped, matching the Rust listing behavior.
    }
  }

  entries.sort((left, right) => right.createdAt - left.createdAt);
  return entries;
}

export function deleteBackup(backupId: string): void {
  const backupPath = backupPathForId(backupId);
  let metadata;
  try {
    metadata = lstatSync(backupPath);
  } catch (error) {
    throw new AppError("IO", `failed to access ${backupPath}: ${String(error)}`);
  }
  if (!metadata.isDirectory()) {
    throw new AppError("CONFIG", `Skill backup is not a directory: ${backupPath}`);
  }
  try {
    rmSync(backupPath, { recursive: true });
  } catch (error) {
    throw new AppError("IO", `failed to delete ${backupPath}: ${String(error)}`);
  }
}

/** Compatibility alias used by the service layer. */
export function listSkillBackups(): SkillBackupEntry[] {
  return listBackups();
}

/** Compatibility alias used by the service layer. */
export function deleteSkillBackup(backupId: string): void {
  deleteBackup(backupId);
}

/**
 * Resolve the directory that will be copied into a backup. Preserved native
 * destinations are excluded so a user-maintained copy is never duplicated into
 * the backup (and never mistaken for the managed content).
 */
export function resolveUninstallBackupSource(
  skill: InstalledSkill,
  excludedPaths: readonly string[] = [],
): string | undefined {
  const directory = validateSkillDirectory(skill.directory);

  const ssotPath = path.join(ssotDir(), directory);
  if (isDirectory(ssotPath) && !excludedPaths.some((entry) => pathsOverlap(ssotPath, entry))) {
    return ssotPath;
  }

  for (const app of APP_IDS) {
    if ((app === "mcode" || app === "agy" || app === "kimi" || app === "dsh") && !skill.apps[app]) continue;
    let appDir: string;
    try {
      appDir = appSkillsDir(app);
    } catch {
      continue;
    }
    const candidate = path.join(appDir, directory);
    if (isDirectory(candidate) && !excludedPaths.some((entry) => pathsOverlap(candidate, entry))) {
      return candidate;
    }
  }

  return undefined;
}

function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** Copy a skill directory into the backup root and write its metadata. */
export function createUninstallBackup(
  skill: InstalledSkill,
  excludedPaths: readonly string[] = [],
): string | undefined {
  const sourcePath = resolveUninstallBackupSource(skill, excludedPaths);
  if (sourcePath === undefined) return undefined;

  const backupRoot = backupDir();
  const timestamp = timestampSegment(new Date());
  const slug = sanitizeBackupSegment(skill.directory);
  let backupPath = path.join(backupRoot, `${timestamp}_${slug}`);
  let counter = 1;
  while (existsSync(backupPath)) {
    backupPath = path.join(backupRoot, `${timestamp}_${slug}_${counter}`);
    counter += 1;
  }

  try {
    copyDirRecursive(sourcePath, path.join(backupPath, "skill"));
    writeJsonFileAtomic(path.join(backupPath, "meta.json"), {
      skill: { ...skill, apps: { ...skill.apps } },
      backup_created_at: nowSeconds(),
      source_path: sourcePath,
    });
  } catch (error) {
    removePath(backupPath);
    throw error;
  }

  try {
    cleanupOldSkillBackups(backupRoot);
  } catch {
    // Retention failure must not fail the uninstall; the backup itself is valid.
  }

  return backupPath;
}

/** Keep the newest `BACKUP_RETAIN_COUNT` directories, pruning oldest first. */
export function cleanupOldSkillBackups(directory: string): void {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch (error) {
    throw new AppError("IO", `failed to read ${directory}: ${String(error)}`);
  }

  const entries: Array<{ path: string; modified: number }> = [];
  for (const name of names) {
    const entryPath = path.join(directory, name);
    let metadata;
    try {
      // Rust `DirEntry::metadata` does not traverse symlinks.
      metadata = lstatSync(entryPath);
    } catch {
      continue;
    }
    if (!metadata.isDirectory()) continue;
    entries.push({ path: entryPath, modified: metadata.mtimeMs });
  }

  if (entries.length <= BACKUP_RETAIN_COUNT) return;
  entries.sort((left, right) => left.modified - right.modified);
  for (const entry of entries.slice(0, entries.length - BACKUP_RETAIN_COUNT)) {
    try {
      rmSync(entry.path, { recursive: true });
    } catch (error) {
      throw new AppError("IO", `failed to delete ${entry.path}: ${String(error)}`);
    }
  }
}

/**
 * Restore a backup into the SSOT root and persist it through the caller's
 * database/sync hooks, rolling the files back when persistence or projection
 * fails.
 */
export function restoreFromBackup(
  backupId: string,
  existingSkills: Iterable<InstalledSkill>,
  currentApp: AppId,
  hooks: RestoreHooks,
): InstalledSkill {
  const backupPath = backupPathForId(backupId);
  const metadata = readSkillBackupMetadata(backupPath);
  const backupSkillDir = path.join(backupPath, "skill");
  if (!existsSync(path.join(backupSkillDir, "SKILL.md"))) {
    throw new AppError("CONFIG", `Skill backup is invalid or missing SKILL.md: ${backupPath}`);
  }

  for (const existing of existingSkills) {
    if (existing.id === metadata.skill.id || asciiLower(existing.directory) === asciiLower(metadata.skill.directory)) {
      throw new AppError("CONFLICT", `Skill already exists, please uninstall the current one first: ${metadata.skill.directory}`);
    }
  }

  const directory = validateSkillDirectory(metadata.skill.directory);
  const restorePath = path.join(ssotDir(), directory);
  if (pathEntryExists(restorePath)) {
    throw new AppError("CONFLICT", `Restore target already exists: ${restorePath}`);
  }

  const apps = emptyAppFlags();
  apps[currentApp] = true;
  const restored: InstalledSkill = {
    ...metadata.skill,
    directory,
    apps,
    installedAt: nowSeconds(),
    updatedAt: 0,
  };

  copyDirRecursive(backupSkillDir, restorePath);
  try {
    restored.contentHash = computeDirHash(restorePath);
  } catch {
    delete restored.contentHash;
  }

  try {
    hooks.save(restored);
  } catch (error) {
    removePath(restorePath);
    throw error;
  }

  try {
    hooks.sync(restored.directory);
  } catch (error) {
    try { hooks.delete(restored.id); } catch { /* preserve the original failure */ }
    removePath(restorePath);
    throw error;
  }

  return restored;
}
