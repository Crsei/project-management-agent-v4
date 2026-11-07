/** Translated from vendor/cc-switch/src-tauri/src/services/skill.rs (remote install, update, ZIP install). */
import { mkdtempSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import type { Database } from "../database/index.ts";
import { AppError } from "../errors.ts";
import { uploadedZip } from "../host-context.ts";
import {
  appFlagsFromEnabled, enabledApps, type AppId, type DiscoverableSkill, type InstalledSkill,
  type SkillMetadata, type SkillRepo, type ZipInstallResult, type ZipSkippedSkill,
} from "../types.ts";
import { createUninstallBackup } from "./backup.ts";
import { createDirSymlink, copyDirRecursive, ensureDir, isSymlink, pathExists, removePath } from "./fs.ts";
import { computeDirHash } from "./hash.ts";
import {
  appSkillsDir, ensureDistinctSkillRoots, sanitizeInstallName, sanitizeSkillSourcePath,
  skillSyncMethod, ssotDir, validateSkillDirectory,
} from "./paths.ts";
import {
  inspectPiSkillDestination, preflightInstallDestination, refreshPiSkillDestination,
  skillExistsInApp, syncToAppDir, validateSyncSourceDir, type PiSkillDeployment,
} from "./deploy.ts";
import { parseSkillMetadata, readSkillNameDesc, scanDirRecursive, scanSkillsInDir } from "./scan.ts";
import {
  buildSkillDocUrl, chooseDocPath, docPathForSource, findRemoteSkillForInstall,
  resolveSkillSourceDir,
} from "./discovery.ts";
import { downloadRepo, errorText, removeWorkspace, skillError } from "./network.ts";
import { extractLocalZip, extractRepoArchive } from "./zip.ts";

const MANAGED_APPS: AppId[] = ["mcode", "agy", "kimi", "dsh"];
const NATIVE_DEPLOY_APPS: AppId[] = ["pi", "mcode", "agy", "kimi", "dsh", "omp"];

function isNativeDeployApp(app: AppId): boolean {
  return NATIVE_DEPLOY_APPS.includes(app);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function isWithin(base: string, candidate: string): boolean {
  return candidate === base || candidate.startsWith(`${base}${path.sep}`);
}

function isDirectory(value: string): boolean {
  try {
    return statSync(value).isDirectory();
  } catch {
    return false;
  }
}

function withNativePresence(skill: InstalledSkill): InstalledSkill {
  return {
    ...skill,
    apps: {
      ...skill.apps,
      pi: skillExistsInApp(skill.directory, "pi"),
      omp: skillExistsInApp(skill.directory, "omp"),
    },
  };
}

function persistAndSyncNewSkill(db: Database, skill: InstalledSkill, app: AppId): void {
  const source = path.join(ssotDir(), skill.directory);
  preflightInstallDestination(source, skill.directory, app);
  db.skills.save(skill);
  try {
    syncToAppDir(skill.directory, app);
  } catch (error) {
    try {
      db.skills.delete(skill.id);
    } catch { /* preserve the sync failure */ }
    throw error;
  }
}

/** Reuse an existing installation or reject a directory owned by another repo. */
function reuseExistingInstall(
  db: Database,
  skill: DiscoverableSkill,
  installName: string,
  currentApp: AppId,
): InstalledSkill | undefined {
  for (const existing of db.skills.getAllInstalled().values()) {
    if (existing.directory.toLowerCase() !== installName.toLowerCase()) continue;
    const sameRepo = existing.repoOwner === skill.repoOwner && existing.repoName === skill.repoName;
    if (sameRepo) {
      const updated: InstalledSkill = {
        ...existing,
        apps: { ...existing.apps, [currentApp]: true },
      };
      db.skills.save(updated);
      syncToAppDir(updated.directory, currentApp);
      return updated;
    }
    throw skillError(
      "SKILL_DIRECTORY_CONFLICT",
      {
        directory: installName,
        existing_repo: `${existing.repoOwner ?? "unknown"}/${existing.repoName ?? "unknown"}`,
        new_repo: `${skill.repoOwner}/${skill.repoName}`,
      },
      "uninstallFirst",
    );
  }
  return undefined;
}

/** Install one discoverable skill: download to SSOT, persist, sync to the current app. */
export async function installSkill(
  db: Database,
  skill: DiscoverableSkill,
  currentApp: AppId,
): Promise<InstalledSkill> {
  const ssotDirectory = ssotDir();
  const sourceRelative = sanitizeSkillSourcePath(skill.directory);
  if (sourceRelative === undefined) {
    throw skillError("INVALID_SKILL_DIRECTORY", { directory: skill.directory }, "checkZipContent");
  }
  const lastSegment = path.basename(sourceRelative);
  const installName = sanitizeInstallName(lastSegment);
  if (installName === undefined) {
    throw skillError("INVALID_SKILL_DIRECTORY", { directory: skill.directory }, "checkZipContent");
  }

  const existing = reuseExistingInstall(db, skill, installName, currentApp);
  if (existing !== undefined) return existing;

  const destination = path.join(ssotDirectory, installName);
  let repoBranch = skill.repoBranch;
  let resolvedDocPath: string | undefined;
  let downloadedSource: { dir: string; source: string } | undefined;

  try {
    if (!pathExists(destination)) {
      const repo: SkillRepo = {
        owner: skill.repoOwner, name: skill.repoName, branch: skill.repoBranch, enabled: true,
      };
      const workspace = await downloadRepo(repo, (archivePath, destinationPath, signal) =>
        extractRepoArchive(archivePath, destinationPath, signal));
      downloadedSource = { dir: workspace.dir, source: "" };
      repoBranch = workspace.branch;

      const resolved = resolveSkillSourceDir(workspace.dir, skill.directory);
      if (resolved === undefined) {
        throw skillError(
          "SKILL_DIR_NOT_FOUND",
          { path: path.join(workspace.dir, sourceRelative) },
          "checkRepoUrl",
        );
      }
      let canonicalTemp: string;
      let canonicalSource: string;
      try {
        canonicalTemp = realpathSync(workspace.dir);
      } catch {
        canonicalTemp = workspace.dir;
      }
      try {
        canonicalSource = realpathSync(resolved);
      } catch {
        throw skillError("SKILL_DIR_NOT_FOUND", { path: resolved }, "checkRepoUrl");
      }
      if (!isWithin(canonicalTemp, canonicalSource) || !isDirectory(canonicalSource)) {
        throw skillError("INVALID_SKILL_DIRECTORY", { directory: skill.directory }, "checkZipContent");
      }
      resolvedDocPath = docPathForSource(canonicalTemp, canonicalSource);
      downloadedSource.source = canonicalSource;
    }

    const docPath = chooseDocPath(resolvedDocPath, skill.readmeUrl, skill.directory);
    const readmeUrl = buildSkillDocUrl(skill.repoOwner, skill.repoName, repoBranch, docPath);

    // The download awaited above released the state lock; another install or
    // uninstall may have completed in the meantime.
    const raced = reuseExistingInstall(db, skill, installName, currentApp);
    if (raced !== undefined) return raced;

    if (!pathExists(destination)) {
      if (downloadedSource === undefined) {
        throw new AppError("CONFIG", "Skill directory changed during install; please retry");
      }
      preflightInstallDestination(downloadedSource.source, installName, currentApp);
      copyDirRecursive(downloadedSource.source, destination);
    }

    let contentHash: string | undefined;
    try {
      contentHash = computeDirHash(destination);
    } catch {
      contentHash = undefined;
    }

    const installed: InstalledSkill = {
      id: skill.key,
      name: skill.name,
      ...(skill.description.length > 0 ? { description: skill.description } : {}),
      directory: installName,
      repoOwner: skill.repoOwner,
      repoName: skill.repoName,
      repoBranch,
      ...(readmeUrl !== undefined ? { readmeUrl } : {}),
      apps: appFlagsFromEnabled([currentApp]),
      installedAt: nowSeconds(),
      ...(contentHash !== undefined ? { contentHash } : {}),
      updatedAt: 0,
    };

    persistAndSyncNewSkill(db, installed, currentApp);
    return installed;
  } finally {
    if (downloadedSource !== undefined) removeWorkspace(downloadedSource.dir);
  }
}

function persistUpdatedSkillMetadata(db: Database, metadata: InstalledSkill): InstalledSkill {
  if (!db.skills.updateMetadata(metadata)) {
    throw new AppError("CONFIG", `Skill no longer installed: ${metadata.id}`);
  }
  const stored = db.skills.getInstalled(metadata.id);
  if (stored === undefined) throw new AppError("CONFIG", `Skill no longer installed: ${metadata.id}`);
  return stored;
}

interface StagedTarget {
  destination: string;
  staging: string;
}

function cleanupStaging(staged: StagedTarget[]): void {
  for (const { staging } of staged) {
    rmSync(staging, { recursive: true, force: true, maxRetries: 3 });
  }
}

/**
 * Replace SSOT and native copies atomically: stage every target first, swap,
 * then commit metadata. A failed swap restores the previous directories so a
 * metadata failure cannot leave a native copy looking like a user edit.
 */
function updateManagedSkillFiles<T>(
  source: string,
  ssot: string,
  directory: string,
  deployments: Array<[string, PiSkillDeployment]>,
  nativeTargets: string[],
  commit: () => T,
): T {
  validateSyncSourceDir(source, directory);
  const targets: Array<{ destination: string; symlink: boolean }> = [
    { destination: ssot, symlink: false },
  ];
  for (const [destination, deployment] of deployments) {
    inspectPiSkillDestination(ssot, destination, directory);
    targets.push({ destination, symlink: deployment.kind === "symlink" });
  }
  for (const native of nativeTargets) {
    if (!pathExists(native) && !isSymlink(native)) {
      targets.push({ destination: native, symlink: skillSyncMethod() !== "copy" });
    }
  }

  const staged: StagedTarget[] = [];
  try {
    for (const target of targets) {
      const parent = path.dirname(target.destination);
      ensureDir(parent);
      const staging = mkdtempSync(path.join(parent, ".managed-skill-update-"));
      staged.push({ destination: target.destination, staging });
      const replacement = path.join(staging, "new");
      if (target.symlink) {
        try {
          createDirSymlink(ssot, replacement);
        } catch (error) {
          if (skillSyncMethod() === "symlink" || isSymlink(target.destination)) throw error;
          copyDirRecursive(source, replacement);
        }
      } else {
        copyDirRecursive(source, replacement);
      }
    }
  } catch (error) {
    cleanupStaging(staged);
    throw error;
  }

  let changed = 0;
  let preserveStaging = false;
  try {
    for (const { destination, staging } of staged) {
      if (pathExists(destination) || isSymlink(destination)) {
        renameSync(destination, path.join(staging, "old"));
      }
      changed += 1;
      renameSync(path.join(staging, "new"), destination);
    }
    return commit();
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const { destination, staging } of staged.slice(0, changed).reverse()) {
      try {
        removePath(destination);
        const old = path.join(staging, "old");
        if (pathExists(old) || isSymlink(old)) renameSync(old, destination);
      } catch (rollbackError) {
        rollbackErrors.push(`${destination}: ${errorText(rollbackError)}`);
      }
    }
    if (rollbackErrors.length > 0) {
      preserveStaging = true;
      const backups = staged.map(({ staging }) => staging);
      throw new AppError(
        "CONFIG",
        `${errorText(error)}; MiniMax Code Skill rollback failed: ${rollbackErrors.join("; ")}`
        + `; backups: [${backups.map((backup) => `"${backup}"`).join(", ")}]`,
      );
    }
    throw error;
  } finally {
    if (!preserveStaging) cleanupStaging(staged);
  }
}

/** Re-download and replace one installed skill, including native Windows targets. */
export async function updateSkill(db: Database, skillId: string): Promise<InstalledSkill> {
  let skill = db.skills.getInstalled(skillId);
  if (skill === undefined) throw new AppError("CONFIG", `Skill not found: ${skillId}`);
  skill = withNativePresence(skill);

  // Backup source, remove and copy all join `directory`; validate before any of them.
  validateSkillDirectory(skill.directory);

  if (skill.repoOwner === undefined || skill.repoName === undefined) {
    throw new AppError("CONFIG", `Cannot update local skill: ${skillId}`);
  }
  const owner = skill.repoOwner;
  const name = skill.repoName;
  const repo: SkillRepo = {
    owner, name, branch: skill.repoBranch ?? "main", enabled: true,
  };

  const ssotDirectory = ssotDir();
  if (skill.apps.pi) ensureDistinctSkillRoots(ssotDirectory, appSkillsDir("pi"), "pi");
  if (skill.apps.omp) ensureDistinctSkillRoots(ssotDirectory, appSkillsDir("omp"), "omp");

  const workspace = await downloadRepo(repo, (archivePath, destinationPath, signal) =>
    extractRepoArchive(archivePath, destinationPath, signal));
  try {
    let remoteSkills: DiscoverableSkill[] = [];
    try {
      remoteSkills = scanDirRecursive(workspace.dir, repo);
    } catch {
      remoteSkills = [];
    }

    const remoteMatch = findRemoteSkillForInstall(remoteSkills, skill.directory, skill.readmeUrl);
    if (remoteMatch === undefined) {
      throw skillError("SKILL_DIR_NOT_FOUND", { path: skill.directory }, "checkRepoUrl");
    }
    const source = resolveSkillSourceDir(workspace.dir, remoteMatch.directory);
    if (source === undefined) {
      throw skillError(
        "SKILL_DIR_NOT_FOUND",
        { path: path.join(workspace.dir, remoteMatch.directory) },
        "checkRepoUrl",
      );
    }

    let canonicalTemp: string;
    try {
      canonicalTemp = realpathSync(workspace.dir);
    } catch {
      canonicalTemp = workspace.dir;
    }
    let canonicalSource: string | undefined;
    try {
      canonicalSource = realpathSync(source);
    } catch {
      canonicalSource = undefined;
    }
    const resolvedDocPath = canonicalSource === undefined
      ? undefined
      : docPathForSource(canonicalTemp, canonicalSource);

    // Downloads do not mutate local state. Re-read the row before any backup,
    // delete or copy: the user may have uninstalled or replaced it meanwhile.
    const current = db.skills.getInstalled(skill.id);
    if (current === undefined) throw new AppError("CONFIG", `Skill no longer installed: ${skill.id}`);
    if (current.directory !== skill.directory
      || current.repoOwner !== skill.repoOwner
      || current.repoName !== skill.repoName
      || current.repoBranch !== skill.repoBranch
      || current.installedAt !== skill.installedAt) {
      throw new AppError("CONFIG", `Skill changed during update: ${skill.id}`);
    }
    validateSkillDirectory(current.directory);
    skill = withNativePresence(current);

    const destination = path.join(ssotDirectory, skill.directory);
    const deployments: Array<[string, PiSkillDeployment]> = [];
    for (const app of ["pi", "mcode", "agy", "kimi", "dsh", "omp"] as AppId[]) {
      if (!skill.apps[app]) continue;
      const appDirectory = appSkillsDir(app);
      ensureDistinctSkillRoots(ssotDirectory, appDirectory, app);
      const appDestination = path.join(appDirectory, skill.directory);
      const deployment = inspectPiSkillDestination(destination, appDestination, skill.directory);
      if (deployment !== undefined) deployments.push([appDestination, deployment]);
    }

    try {
      createUninstallBackup(skill);
    } catch { /* best effort, matches the Rust `let _ =` */ }

    const managed = skill.apps.mcode || skill.apps.agy || skill.apps.kimi || skill.apps.dsh;
    if (!managed) {
      if (pathExists(destination) || isSymlink(destination)) removePath(destination);
      copyDirRecursive(canonicalSource ?? source, destination);
    }

    const metadataSource = managed ? (canonicalSource ?? source) : destination;
    let newHash: string | undefined;
    try {
      newHash = computeDirHash(metadataSource);
    } catch {
      newHash = undefined;
    }
    const metadata = readSkillNameDesc(path.join(metadataSource, "SKILL.md"), skill.directory);
    const docPath = chooseDocPath(resolvedDocPath, skill.readmeUrl, skill.directory);
    const readmeUrl = buildSkillDocUrl(owner, name, workspace.branch, docPath);

    const updatedMetadata: InstalledSkill = {
      id: skill.id,
      name: metadata.name,
      ...(metadata.description !== undefined ? { description: metadata.description } : {}),
      directory: skill.directory,
      repoOwner: skill.repoOwner,
      repoName: skill.repoName,
      repoBranch: workspace.branch,
      ...(readmeUrl !== undefined ? { readmeUrl } : {}),
      apps: skill.apps,
      installedAt: skill.installedAt,
      ...(newHash !== undefined ? { contentHash: newHash } : {}),
      updatedAt: nowSeconds(),
    };

    let updatedSkill: InstalledSkill;
    if (managed) {
      const nativeTargets = MANAGED_APPS
        .filter((app) => skill!.apps[app])
        .map((app) => path.join(appSkillsDir(app), skill!.directory));
      updatedSkill = updateManagedSkillFiles(
        canonicalSource ?? source,
        destination,
        skill.directory,
        deployments,
        nativeTargets,
        () => persistUpdatedSkillMetadata(db, updatedMetadata),
      );
    } else {
      for (const [appDestination, deployment] of deployments) {
        refreshPiSkillDestination(destination, appDestination, skill.directory, deployment);
      }
      updatedSkill = persistUpdatedSkillMetadata(db, updatedMetadata);
    }

    updatedSkill = withNativePresence(updatedSkill);

    for (const app of enabledApps(updatedSkill.apps)) {
      if (isNativeDeployApp(app)) continue;
      try {
        syncToAppDir(updatedSkill.directory, app);
      } catch { /* per-app sync failures do not fail the update */ }
    }
    return updatedSkill;
  } finally {
    removeWorkspace(workspace.dir);
  }
}

/** Install every skill found in a user-provided ZIP; installed names win over archive duplicates. */
export async function installSkillsFromZip(
  db: Database,
  zipPath: string,
  currentApp: AppId,
): Promise<ZipInstallResult> {
  // Only archives under the context's private `uploads/` directory are accepted.
  const ownedZipPath = uploadedZip(zipPath);
  const workspace = await extractLocalZip(ownedZipPath);
  try {
    const skillDirs = scanSkillsInDir(workspace.dir);
    if (skillDirs.length === 0) {
      throw skillError("NO_SKILLS_IN_ZIP", {}, "checkZipContent");
    }

    const ssotDirectory = ssotDir();
    const installed: InstalledSkill[] = [];
    const skipped: ZipSkippedSkill[] = [];
    const existingSkills = db.skills.getAllInstalled();
    const zipStem = path.parse(ownedZipPath).name;

    for (const skillDir of skillDirs) {
      const skillMd = path.join(skillDir, "SKILL.md");
      let metadata: SkillMetadata | undefined;
      if (pathExists(skillMd)) {
        try {
          metadata = parseSkillMetadata(skillMd);
        } catch {
          metadata = undefined;
        }
      }

      const directoryName = path.basename(skillDir);
      const metadataName = metadata?.name === undefined ? undefined : sanitizeInstallName(metadata.name);
      const zipName = sanitizeInstallName(zipStem);
      const installName = (skillDir === workspace.dir || directoryName.length === 0 || directoryName.startsWith("."))
        ? metadataName ?? zipName
        : sanitizeInstallName(directoryName) ?? metadataName ?? zipName;
      if (installName === undefined) {
        throw skillError("INVALID_SKILL_DIRECTORY", { zip: ownedZipPath }, "checkZipContent");
      }

      let conflict: InstalledSkill | undefined;
      for (const existing of existingSkills.values()) {
        if (existing.directory.toLowerCase() === installName.toLowerCase()) {
          conflict = existing;
          break;
        }
      }
      if (conflict !== undefined) {
        skipped.push({
          directory: installName,
          existingId: conflict.id,
          existingName: conflict.name,
        });
        continue;
      }

      const name = metadata?.name ?? installName;
      const description = metadata?.description;

      preflightInstallDestination(skillDir, installName, currentApp);

      const destination = path.join(ssotDirectory, installName);
      if (pathExists(destination) || isSymlink(destination)) removePath(destination);
      copyDirRecursive(skillDir, destination);

      let contentHash: string | undefined;
      try {
        contentHash = computeDirHash(destination);
      } catch {
        contentHash = undefined;
      }

      const skill: InstalledSkill = {
        id: `local:${installName}`,
        name,
        ...(description !== undefined ? { description } : {}),
        directory: installName,
        apps: appFlagsFromEnabled([currentApp]),
        installedAt: nowSeconds(),
        ...(contentHash !== undefined ? { contentHash } : {}),
        updatedAt: 0,
      };

      persistAndSyncNewSkill(db, skill, currentApp);
      installed.push(skill);
    }

    return { installed, skipped };
  } finally {
    workspace.dispose();
  }
}
