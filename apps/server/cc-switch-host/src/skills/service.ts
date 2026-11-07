/**
 * Translated from vendor/cc-switch/src-tauri/src/services/skill.rs (local, filesystem-backed
 * Skill management). Remote discovery, downloads, ZIP installs and storage migration live in
 * the sibling install/remote modules.
 */
import { existsSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import type { Database } from "../database/index.ts";
import { AppError, invalidInput } from "../errors.ts";
import { isBound } from "../host-context.ts";
import {
  APP_IDS,
  type AppId,
  type DiscoverableSkill,
  type ImportSkillSelection,
  type InstalledSkill,
  type SkillAppSyncOutcome,
  type SkillBackupEntry,
  type SkillUninstallResult,
} from "../types.ts";
import { createUninstallBackup, deleteSkillBackup, listSkillBackups, restoreFromBackup } from "./backup.ts";
import {
  ensurePiSkillDestinationMatches,
  inspectPiSkillDestination,
  isSymlinkToSsot,
  removeFromApp,
  removeFromAppPreserving,
  removeVerifiedPiDestination,
  skillExistsInApp,
  syncToApp as syncToAppDb,
  syncToAppDir,
} from "./deploy.ts";
import { ensureDir, pathEntryExists, removePath } from "./fs.ts";
import { installSkill, updateSkill as updateInstalledSkill } from "./install.ts";
import { importFromApps as importSkillsFromApps } from "./import.ts";
import {
  appSkillsDir,
  distinctAppSkillsDir,
  isSyncManagedApp,
  pathsAlias,
  pathsOverlap,
  requireValidDirectory,
  ssotDir,
} from "./paths.ts";
import { scanUnmanaged as scanUnmanagedSkills, type UnmanagedSkill } from "./scan.ts";

/** Applications whose native directory always has to match the managed SSOT copy. */
const VERIFIED_NATIVE_APPS: readonly AppId[] = ["mcode", "agy", "kimi", "dsh"];

/** Applications that are toggled as native projections plus a persisted flag. */
const STAGED_TOGGLE_APPS: readonly AppId[] = ["agy", "kimi", "dsh"];

/** Applications that follow exists=active and therefore never persist a flag. */
const NATIVE_OBSERVED_APPS: readonly AppId[] = ["pi", "omp"];

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseDiscoverableSkill(value: unknown): DiscoverableSkill {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidInput("invalid_skill");
  }
  const record = value as Record<string, unknown>;
  for (const key of ["key", "name", "description", "directory", "repoOwner", "repoName", "repoBranch"]) {
    if (typeof record[key] !== "string") throw invalidInput("invalid_skill");
  }
  // Rust serializes `Option::None` as an explicit `null`, and deserializing null yields None.
  if (record.readmeUrl !== undefined && record.readmeUrl !== null && typeof record.readmeUrl !== "string") {
    throw invalidInput("invalid_skill");
  }
  return {
    key: record.key as string,
    name: record.name as string,
    description: record.description as string,
    directory: record.directory as string,
    ...(typeof record.readmeUrl === "string" ? { readmeUrl: record.readmeUrl } : {}),
    repoOwner: record.repoOwner as string,
    repoName: record.repoName as string,
    repoBranch: record.repoBranch as string,
  };
}

export class SkillManager {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /** All installed Skills with Pi/Omp native observations applied. */
  getAllInstalled(): InstalledSkill[] {
    const skills = [...this.#db.skills.getAllInstalled().values()];
    for (const skill of skills) {
      for (const app of NATIVE_OBSERVED_APPS) {
        skill.apps[app] = skillExistsInApp(skill.directory, app);
      }
    }
    return skills;
  }

  getBackups(): SkillBackupEntry[] {
    return listSkillBackups();
  }

  deleteBackup(backupId: string): void {
    deleteSkillBackup(backupId);
  }

  /** Remote install is owned by the install module; the argument is its JSON payload. */
  async installUnified(skill: unknown, currentApp: AppId): Promise<InstalledSkill> {
    return installSkill(this.#db, parseDiscoverableSkill(skill), currentApp);
  }

  /**
   * Uninstall a Skill: verify every managed projection, back up the content, remove the
   * projections and the SSOT copy, then delete the database record.
   */
  uninstallUnified(id: string): SkillUninstallResult {
    const skill = this.#db.skills.getInstalled(id);
    if (skill === undefined) throw new AppError("COMMAND_FAILED", `Skill not found: ${id}`);

    let directory: string;
    try {
      directory = requireValidDirectory(skill.directory);
    } catch {
      // A poisoned directory must not lock the user out of removing the row: skip all
      // filesystem work and delete only the database record.
      this.#db.skills.delete(id);
      return { piCleanupIncomplete: true };
    }

    const ssot = ssotDir();
    const source = path.join(ssot, directory);

    const managedDestinations: string[] = [];
    for (const app of VERIFIED_NATIVE_APPS) {
      if (!skill.apps[app]) continue;
      let destination: string;
      try {
        destination = path.join(distinctAppSkillsDir(ssot, app), directory);
        ensurePiSkillDestinationMatches(source, destination, directory);
      } catch (error) {
        throw new AppError(
          "COMMAND_FAILED",
          `${app} Skill could not be verified; uninstall cancelled: ${message(error)}`,
        );
      }
      managedDestinations.push(destination);
    }

    const preservedPaths: string[] = [];
    let piCleanupIncomplete = false;
    const removalPaths: Array<{ app: AppId; destination: string }> = [];

    for (const app of NATIVE_OBSERVED_APPS) {
      let appDir: string;
      try {
        appDir = appSkillsDir(app);
      } catch {
        piCleanupIncomplete = true;
        continue;
      }
      if (pathsAlias(ssot, appDir)) continue;
      // Keep the destination even when it does not exist yet: another process may project
      // the Skill while the backup is being written, so the SSOT delete re-checks overlap.
      const destination = path.join(appDir, directory);
      if (pathEntryExists(destination)) {
        try {
          inspectPiSkillDestination(source, destination, directory);
        } catch {
          preservedPaths.push(destination);
          piCleanupIncomplete = true;
          continue;
        }
      }
      removalPaths.push({ app, destination });
    }

    const backupPath = createUninstallBackup(skill, preservedPaths);

    for (const destination of managedDestinations) {
      try {
        removeVerifiedPiDestination(source, destination, directory);
      } catch (error) {
        throw new AppError(
          "COMMAND_FAILED",
          `Managed Skill could not be removed; uninstall cancelled: ${message(error)}`,
        );
      }
    }

    // Pi/Omp directories may hold a user-maintained Skill with the same name: only verified
    // CC Switch deployments are removed, anything else is preserved and reported.
    for (const { destination } of removalPaths) {
      try {
        removeVerifiedPiDestination(source, destination, directory);
      } catch {
        piCleanupIncomplete = true;
        if (pathEntryExists(destination)) preservedPaths.push(destination);
      }
    }

    for (const app of APP_IDS) {
      if (NATIVE_OBSERVED_APPS.includes(app) || VERIFIED_NATIVE_APPS.includes(app)) continue;
      try {
        removeFromAppPreserving(directory, app, preservedPaths);
      } catch {
        // Other applications keep the historical per-target tolerance.
      }
    }

    const skillPath = path.join(ssot, directory);
    if (!preservedPaths.some((preserved) => pathsOverlap(skillPath, preserved))) {
      if (existsSync(skillPath)) removePath(skillPath);
    }

    this.#db.skills.delete(id);

    const result: SkillUninstallResult = {};
    if (backupPath !== undefined) result.backupPath = backupPath;
    if (preservedPaths.length > 0) result.preservedPiPath = preservedPaths[0];
    if (piCleanupIncomplete) result.piCleanupIncomplete = true;
    return result;
  }

  restoreBackup(backupId: string, currentApp: AppId): InstalledSkill {
    return restoreFromBackup(backupId, this.#db.skills.getAllInstalled().values(), currentApp, {
      save: (skill) => this.#db.skills.save(skill),
      delete: (id) => {
        this.#db.skills.delete(id);
      },
      sync: (directory) => syncToAppDir(directory, currentApp),
    });
  }

  /** Enable or disable one application projection for a Skill. */
  toggleApp(id: string, app: AppId, enabled: boolean): void {
    const skill = this.#db.skills.getInstalled(id);
    if (skill === undefined) throw new AppError("COMMAND_FAILED", `Skill not found: ${id}`);

    if (STAGED_TOGGLE_APPS.includes(app)) {
      if (!enabled && !skill.apps[app]) return;
      const directory = requireValidDirectory(skill.directory);
      const ssot = ssotDir();
      const source = path.join(ssot, directory);
      const nativeDir = distinctAppSkillsDir(ssot, app);
      const native = path.join(nativeDir, directory);
      ensurePiSkillDestinationMatches(source, native, directory);
      ensureDir(nativeDir);

      const staging = mkdtempSync(path.join(nativeDir, ".cc-switch-toggle-"));
      const previous = path.join(staging, "old");
      const existed = pathEntryExists(native);
      if (existed) renameSync(native, previous);
      skill.apps[app] = enabled;
      try {
        if (enabled) syncToAppDir(directory, app);
        if (!this.#db.skills.updateApps(id, skill.apps)) {
          throw new AppError("COMMAND_FAILED", `Skill no longer installed: ${id}`);
        }
      } catch (error) {
        if (pathEntryExists(native)) removePath(native);
        if (existed) renameSync(previous, native);
        throw error;
      } finally {
        try {
          rmSync(staging, { recursive: true, force: true });
        } catch {
          // Staging cleanup is best effort, matching the temporary directory drop.
        }
      }
      return;
    }

    skill.apps[app] = enabled;
    if (enabled) syncToAppDir(skill.directory, app);
    else removeFromApp(skill.directory, app);

    // Pi/Omp follow the native exists=active rule; every other app persists its flag.
    if (!NATIVE_OBSERVED_APPS.includes(app)) this.#db.skills.updateApps(id, skill.apps);
  }

  scanUnmanaged(): UnmanagedSkill[] {
    const managed = [...this.#db.skills.getAllInstalled().values()].map((skill) => skill.directory);
    return scanUnmanagedSkills(managed);
  }

  /** Import unmanaged Skills from application directories into the SSOT. */
  importFromApps(imports: ImportSkillSelection[]): InstalledSkill[] {
    return importSkillsFromApps(this.#db, imports);
  }

  /** Re-project every enabled Skill to each sync-managed, bound application. */
  resyncAll(): SkillAppSyncOutcome[] {
    return APP_IDS.filter((app) => isSyncManagedApp(app) && isBound(app)).map((app) => {
      try {
        const failedSkills = this.#syncToAppUnlocked(app);
        return {
          app,
          ok: failedSkills.length === 0,
          failedSkills,
        };
      } catch (error) {
        return { app, ok: false, error: message(error), failedSkills: [] };
      }
    });
  }

  /**
   * Re-project one application from the persisted flags (Rust `sync_to_app`).
   * Only sync-managed applications are touched; per-Skill failures are skipped.
   */
  syncToApp(app: AppId): void {
    syncToAppDb(this.#db, app);
  }

  /** Local metadata and content-hash refresh; remote refresh is owned by the install module. */
  async updateSkill(id: string): Promise<InstalledSkill> {
    return updateInstalledSkill(this.#db, id);
  }

  /**
   * Sync one application directory: prune projections that are no longer selected (or that
   * are dangling links into the SSOT), then project every enabled Skill. Per-Skill failures
   * are collected instead of aborting the application.
   */
  #syncToAppUnlocked(app: AppId): Array<{ directory: string; error: string }> {
    const failed: Array<{ directory: string; error: string }> = [];
    if (!isSyncManagedApp(app)) return failed;

    const skills = this.#db.skills.getAllInstalled();
    const ssot = ssotDir();
    const appDir = distinctAppSkillsDir(ssot, app);
    const indexed = new Map<string, InstalledSkill>();
    for (const skill of skills.values()) indexed.set(skill.directory.toLowerCase(), skill);

    // Unselected MiniMax Code / Agy / Kimi / Dsh directories may be installed outside CC
    // Switch; explicit disable/uninstall handles removing managed deployments there.
    if (existsSync(appDir) && !VERIFIED_NATIVE_APPS.includes(app)) {
      for (const entry of readdirSync(appDir)) {
        if (entry.startsWith(".")) continue;
        const entryPath = path.join(appDir, entry);
        const skill = indexed.get(entry.toLowerCase());
        if (skill !== undefined) {
          if (!skill.apps[app]) removePath(entryPath);
          continue;
        }
        if (isSymlinkToSsot(entryPath, ssot)) removePath(entryPath);
      }
    }

    for (const skill of skills.values()) {
      if (!skill.apps[app]) continue;
      // Per-Skill tolerance: a poisoned directory row must not disable the whole app.
      try {
        syncToAppDir(skill.directory, app);
      } catch (error) {
        failed.push({ directory: skill.directory, error: message(error) });
      }
    }

    return failed;
  }
}
