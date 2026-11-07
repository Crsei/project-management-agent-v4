/**
 * Translated from vendor/cc-switch/src-tauri/src/services/skill.rs (import_from_apps and the
 * agents lock helpers). Imports unmanaged Skills from application Skill directories into the
 * SSOT and records them in the database.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Database } from "../database/index.ts";
import { AppError } from "../errors.ts";
import { homeDir } from "../host-context.ts";
import { getSkillStorageLocation } from "../settings.ts";
import {
  APP_IDS,
  emptyAppFlags,
  type AppFlags,
  type AppId,
  type ImportSkillSelection,
  type InstalledSkill,
  type SkillRepo,
} from "../types.ts";
import {
  inspectPiSkillDestination,
  preflightInstallDestination,
  refreshPiSkillDestination,
  skillExistsInApp,
  syncToAppDir,
} from "./deploy.ts";
import { copyDirRecursive, isSymlink } from "./fs.ts";
import { computeDirHash, computePiDeploymentHash } from "./hash.ts";
import {
  agentsSkillsDir,
  appSkillsDir,
  distinctAppSkillsDir,
  pathsAlias,
  requireValidDirectory,
  ssotDir,
} from "./paths.ts";
import { buildSkillDocUrl, validateRepoRef } from "./discovery.ts";
import { readSkillNameDesc } from "./scan.ts";

/** Applications whose native directory must keep pointing at the managed SSOT copy. */
const MANAGED_NATIVE_APPS: readonly AppId[] = ["mcode", "agy", "kimi", "dsh"];

/**
 * Applications handled by their own projection block: Pi/Omp by native observation and the
 * MiniMax-style apps by verified copies. The generic flag projection must skip them.
 */
const SKIPPED_BY_FLAG_PROJECTION: readonly AppId[] = ["pi", "mcode", "agy", "kimi", "dsh", "omp"];

interface LockRepoInfo {
  owner: string;
  repo: string;
  skillPath?: string;
  branch?: string;
}

interface RepoInfo {
  id: string;
  repoOwner?: string;
  repoName?: string;
  repoBranch?: string;
  readmeUrl?: string;
}

function normalizeOptionalBranch(branch: unknown): string | undefined {
  if (typeof branch !== "string") return undefined;
  const trimmed = branch.trim();
  return trimmed === "" ? undefined : trimmed;
}

function parseBranchFromSourceUrl(sourceUrl: unknown): string | undefined {
  if (typeof sourceUrl !== "string") return undefined;
  const url = sourceUrl.trim();
  if (url === "") return undefined;

  // https://github.com/owner/repo/tree/<branch>/...
  const treeIndex = url.indexOf("/tree/");
  if (treeIndex >= 0) {
    const branch = url.slice(treeIndex + "/tree/".length).split("/")[0]?.trim();
    return branch ? branch : undefined;
  }

  // URL fragment: ...git#branch
  const hashIndex = url.indexOf("#");
  if (hashIndex >= 0) {
    const branch = url.slice(hashIndex + 1).split("&")[0]?.trim();
    return branch ? branch : undefined;
  }

  // Query: ...?branch=xxx / ?ref=xxx
  const queryIndex = url.indexOf("?");
  if (queryIndex >= 0) {
    for (const pair of url.slice(queryIndex + 1).split("&")) {
      const equals = pair.indexOf("=");
      if (equals < 0) continue;
      const key = pair.slice(0, equals);
      if (key !== "branch" && key !== "ref") continue;
      const branch = pair.slice(equals + 1).trim();
      if (branch !== "") return branch;
    }
  }

  return undefined;
}

/**
 * Parse `~/.agents/.skill-lock.json` into skill_name -> repository information.
 * Only unified storage exposes the shared agents lock file.
 */
function parseAgentsLock(): Map<string, LockRepoInfo> {
  const parsed = new Map<string, LockRepoInfo>();
  if (getSkillStorageLocation() !== "unified") return parsed;

  const lockPath = path.join(homeDir(), ".agents", ".skill-lock.json");
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    return parsed;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return parsed;
  const skills = (value as Record<string, unknown>).skills;
  if (skills === null || typeof skills !== "object" || Array.isArray(skills)) return parsed;

  for (const [name, raw] of Object.entries(skills as Record<string, unknown>)) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const skill = raw as Record<string, unknown>;
    if (typeof skill.source !== "string") continue;
    if (skill.sourceType !== "github") continue;
    const slash = skill.source.indexOf("/");
    if (slash < 0) continue;
    const owner = skill.source.slice(0, slash);
    const repo = skill.source.slice(slash + 1);
    if (owner === "" || repo === "") continue;
    const branch =
      normalizeOptionalBranch(skill.branch) ??
      normalizeOptionalBranch(skill.sourceBranch) ??
      parseBranchFromSourceUrl(skill.sourceUrl);
    parsed.set(name, {
      owner,
      repo,
      ...(typeof skill.skillPath === "string" ? { skillPath: skill.skillPath } : {}),
      ...(branch !== undefined ? { branch } : {}),
    });
  }
  return parsed;
}

/** Build the ID, repository fields and readme URL from the agents lock information. */
function buildRepoInfoFromLock(lock: Map<string, LockRepoInfo>, directory: string): RepoInfo {
  const info = lock.get(directory);
  if (!info) return { id: `local:${directory}` };

  const urlBranch = info.branch ?? "HEAD";
  const docPath = info.skillPath ?? `${directory}/SKILL.md`;
  const readmeUrl = buildSkillDocUrl(info.owner, info.repo, urlBranch, docPath);
  return {
    id: `${info.owner}/${info.repo}:${directory}`,
    repoOwner: info.owner,
    repoName: info.repo,
    ...(info.branch !== undefined ? { repoBranch: info.branch } : {}),
    ...(readmeUrl !== undefined ? { readmeUrl } : {}),
  };
}

/** Persist repositories discovered in the agents lock file, deduplicated and validated. */
function saveReposFromLock(
  db: Database,
  lock: Map<string, LockRepoInfo>,
  directories: readonly string[],
): void {
  let existing: SkillRepo[] = [];
  try {
    existing = db.skills.getRepos();
  } catch {
    existing = [];
  }
  const known = new Set(existing.map((repo) => `${repo.owner}\u0000${repo.name}`));
  const added = new Set<string>();

  for (const directory of directories) {
    const info = lock.get(directory);
    if (!info) continue;
    const key = `${info.owner}\u0000${info.repo}`;
    if (known.has(key) || added.has(key)) continue;
    added.add(key);
    const repo: SkillRepo = {
      owner: info.owner,
      name: info.repo,
      branch: info.branch ?? "HEAD",
      enabled: true,
    };
    try {
      validateRepoRef(repo.owner, repo.name, repo.branch);
    } catch {
      continue;
    }
    try {
      db.skills.saveRepo(repo);
    } catch {
      // Repository bookkeeping must not abort importing the Skill itself.
    }
  }
}

function normalizeApps(value: unknown): AppFlags {
  const apps = emptyAppFlags();
  if (value === null || typeof value !== "object" || Array.isArray(value)) return apps;
  const record = value as Record<string, unknown>;
  for (const app of APP_IDS) if (record[app] === true) apps[app] = true;
  return apps;
}

/**
 * `Vec<ImportSkillSelection>` is deserialized before the Rust command does any work, so one
 * malformed element fails the whole command; `SkillApps` defaults to all-false but rejects
 * non-boolean flags and `null`.
 */
function parseSelections(imports: readonly ImportSkillSelection[]): ImportSkillSelection[] {
  return (imports as readonly unknown[]).map((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new AppError("COMMAND_FAILED", "Invalid skill import selection");
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.directory !== "string") {
      throw new AppError("COMMAND_FAILED", "Invalid skill import selection");
    }
    const rawApps = record.apps;
    if (rawApps !== undefined) {
      if (rawApps === null || typeof rawApps !== "object" || Array.isArray(rawApps)) {
        throw new AppError("COMMAND_FAILED", "Invalid skill import selection");
      }
      const flags = rawApps as Record<string, unknown>;
      for (const app of APP_IDS) {
        if (flags[app] !== undefined && typeof flags[app] !== "boolean") {
          throw new AppError("COMMAND_FAILED", "Invalid skill import selection");
        }
      }
    }
    return { directory: record.directory, apps: normalizeApps(rawApps) };
  });
}

function searchSources(ssot: string): Array<{ base: string; label: string }> {
  const sources: Array<{ base: string; label: string }> = [];
  for (const app of APP_IDS) {
    try {
      sources.push({ base: appSkillsDir(app), label: app });
    } catch {
      // Unbound application roots cannot be scanned.
    }
  }
  const agentsDir = agentsSkillsDir();
  if (agentsDir !== undefined) sources.push({ base: agentsDir, label: "agents" });
  sources.push({ base: ssot, label: "cc-switch" });
  return sources;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Import unmanaged Skills from application directories into the SSOT.
 *
 * Every selection is validated, copied into the SSOT when missing, projected to the selected
 * applications, and persisted. Partial failures are reported through the same aggregate error
 * message as the Rust implementation while the successful imports stay committed.
 */
export function importFromApps(db: Database, imports: ImportSkillSelection[]): InstalledSkill[] {
  // Deserialization happens before any filesystem or database work in Rust.
  const selections = parseSelections(imports);
  const ssot = ssotDir();
  const agentsLock = parseAgentsLock();
  const imported: InstalledSkill[] = [];
  const skippedManaged: string[] = [];
  const notEnabled: string[] = [];

  const directories = selections.map((selection) => selection.directory);
  saveReposFromLock(db, agentsLock, directories);

  const sources = searchSources(ssot);

  selectionLoop: for (const selection of selections) {
    let directory: string;
    try {
      directory = requireValidDirectory(selection.directory);
    } catch {
      continue;
    }

    let sourcePath: string | undefined;
    for (const source of sources) {
      const candidate = path.join(source.base, directory);
      if (existsSync(candidate) && sourcePath === undefined) sourcePath = candidate;
    }
    if (sourcePath === undefined) continue;
    if (!existsSync(path.join(sourcePath, "SKILL.md"))) continue;

    const dest = path.join(ssot, directory);
    if (!existsSync(dest)) copyDirRecursive(sourcePath, dest);

    const { name, description } = readSkillNameDesc(path.join(dest, "SKILL.md"), directory);

    const apps = { ...selection.apps };
    for (const app of ["pi", "omp"] as const) apps[app] = skillExistsInApp(directory, app);

    for (const app of MANAGED_NATIVE_APPS) {
      if (!apps[app]) continue;
      try {
        const nativeDir = distinctAppSkillsDir(ssot, app);
        const native = path.join(nativeDir, directory);
        if (isSymlink(native) && !pathsAlias(native, dest)) {
          if (computePiDeploymentHash(native) !== computePiDeploymentHash(dest)) {
            throw new AppError(
              "COMMAND_FAILED",
              `Skill 与托管副本内容不同，拒绝替换链接: ${directory}`,
            );
          }
          const deployment = inspectPiSkillDestination(native, native, directory);
          if (deployment !== undefined) {
            refreshPiSkillDestination(dest, native, directory, deployment);
          }
        } else {
          preflightInstallDestination(dest, directory, app);
        }
        if (!existsSync(native)) syncToAppDir(directory, app);
      } catch (error) {
        skippedManaged.push(`${directory}: ${message(error)}`);
        continue selectionLoop;
      }
    }

    // Selected applications that do not have the Skill yet are projected now; a failed
    // projection clears the flag so the database always matches the disk.
    for (const app of APP_IDS) {
      if (SKIPPED_BY_FLAG_PROJECTION.includes(app)) continue;
      if (!apps[app] || skillExistsInApp(directory, app)) continue;
      try {
        syncToAppDir(directory, app);
      } catch (error) {
        apps[app] = false;
        notEnabled.push(`${directory} (${app}): ${message(error)}`);
      }
    }

    const repo = buildRepoInfoFromLock(agentsLock, directory);
    let contentHash: string | undefined;
    try {
      contentHash = computeDirHash(dest);
    } catch {
      contentHash = undefined;
    }

    const skill: InstalledSkill = {
      id: repo.id,
      name,
      ...(description !== undefined ? { description } : {}),
      directory,
      ...(repo.repoOwner !== undefined ? { repoOwner: repo.repoOwner } : {}),
      ...(repo.repoName !== undefined ? { repoName: repo.repoName } : {}),
      ...(repo.repoBranch !== undefined ? { repoBranch: repo.repoBranch } : {}),
      ...(repo.readmeUrl !== undefined ? { readmeUrl: repo.readmeUrl } : {}),
      apps,
      installedAt: Math.floor(Date.now() / 1000),
      ...(contentHash !== undefined ? { contentHash } : {}),
      updatedAt: 0,
    };

    db.skills.save(skill);
    imported.push(skill);
  }

  const problems: string[] = [];
  if (skippedManaged.length > 0) {
    problems.push(`skipped MiniMax Code entries: ${skippedManaged.join("; ")}`);
  }
  if (notEnabled.length > 0) problems.push(`could not enable: ${notEnabled.join("; ")}`);
  if (problems.length > 0) {
    throw new AppError("COMMAND_FAILED", `Imported ${imported.length} Skills; ${problems.join("; ")}`);
  }
  return imported;
}
