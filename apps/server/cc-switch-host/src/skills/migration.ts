/** Translated from vendor/cc-switch/src-tauri/src/services/skill.rs (migrate_storage). */
import { renameSync, rmSync } from "node:fs";
import path from "node:path";
import type { Database } from "../database/index.ts";
import { AppError } from "../errors.ts";
import { dataDir, hasNativeTargets, homeDir, isBound } from "../host-context.ts";
import { getSkillStorageLocation, setSkillStorageLocation } from "../settings.ts";
import { APP_IDS, type AppId, type MigrationResult, type SkillStorageLocation } from "../types.ts";
import {
  inspectPiSkillDestination, refreshPiSkillDestination, syncToApp, syncToAppDir,
  type PiSkillDeployment,
} from "./deploy.ts";
import { copyDirRecursive, ensureDir, pathExists } from "./fs.ts";
import { errorText } from "./network.ts";
import {
  appSkillsDir, pathsAlias, ssotDir, validateSkillDirectory, validateSkillStorageDestination,
} from "./paths.ts";

const MANAGED_APPS: AppId[] = ["mcode", "agy", "kimi", "dsh"];

/** Rust swallows inspection errors here: an external same-name directory is simply not migrated. */
function inspectDeployment(
  source: string,
  destination: string,
  directory: string,
): PiSkillDeployment | undefined {
  try {
    return inspectPiSkillDestination(source, destination, directory);
  } catch {
    return undefined;
  }
}

function moveDirectory(source: string, destination: string): void {
  try {
    renameSync(source, destination);
    return;
  } catch {
    // Cross-device moves fall back to copy + delete.
  }
  copyDirRecursive(source, destination);
  try {
    rmSync(source, { recursive: true, force: true });
  } catch {
    // Rust ignores a failed cleanup after a successful copy.
  }
}

/**
 * Move the SSOT directory between `dataDir/skills` and `~/.agents/skills`.
 * Files move first and the setting changes afterwards, so a crash mid-flight
 * leaves the setting pointing at the still-complete old directory.
 */
export function migrateStorage(db: Database, target: SkillStorageLocation): MigrationResult {
  if (target !== "cc_switch" && target !== "unified") {
    throw new AppError("INVALID_INPUT", "Invalid skill storage location", "invalid_skill_storage");
  }
  if (target === "unified" && !hasNativeTargets()) {
    throw new AppError(
      "CONFIG",
      "Project-private contexts cannot publish into native Unified storage",
    );
  }
  const current = getSkillStorageLocation();
  if (current === target) return { migratedCount: 0, skippedCount: 0, errors: [] };

  const oldDirectory = ssotDir();
  const newDirectory = target === "cc_switch"
    ? path.join(dataDir(), "skills")
    : path.join(homeDir(), ".agents", "skills");
  ensureDir(newDirectory);
  // Unified storage is exclusive: no bound application may alias the new root.
  validateSkillStorageDestination(newDirectory);

  const skills = [...db.skills.getAllInstalled().values()];
  const piDirectory = appSkillsDir("pi");
  const piUsesOldSsot = pathsAlias(oldDirectory, piDirectory);
  const piDeployments: Array<[string, PiSkillDeployment]> = [];
  const managedDeployments: Array<[string, string, PiSkillDeployment]> = [];
  const piNativeSources: string[] = [];
  const result: MigrationResult = { migratedCount: 0, skippedCount: 0, errors: [] };

  for (const skill of skills) {
    // The renames/removals below can move or delete any path if `directory` is
    // dirty; report the row and keep migrating the remaining skills.
    let directory: string;
    try {
      directory = validateSkillDirectory(skill.directory);
    } catch (error) {
      result.errors.push(`${JSON.stringify(skill.directory)}: ${errorText(error)}`);
      continue;
    }

    const source = path.join(oldDirectory, directory);
    const destination = path.join(newDirectory, directory);
    if (!pathExists(source)) {
      result.skippedCount += 1;
      continue;
    }
    if (pathExists(destination)) {
      result.skippedCount += 1;
      continue;
    }

    // Confirm the Pi destination is genuinely managed by the old SSOT before
    // moving it; an unrelated same-named directory must not be touched.
    const piDeployment = piUsesOldSsot
      ? undefined
      : inspectDeployment(source, path.join(piDirectory, directory), directory);
    for (const app of MANAGED_APPS) {
      if (!skill.apps[app]) continue;
      const appDestination = path.join(appSkillsDir(app), directory);
      const deployment = inspectDeployment(source, appDestination, directory);
      if (deployment !== undefined) managedDeployments.push([directory, appDestination, deployment]);
    }
    // Omp has no enable column; presence of a managed native copy is the signal.
    const ompDestination = path.join(appSkillsDir("omp"), directory);
    const ompDeployment = inspectDeployment(source, ompDestination, directory);
    if (ompDeployment !== undefined) managedDeployments.push([directory, ompDestination, ompDeployment]);

    try {
      moveDirectory(source, destination);
    } catch (error) {
      result.errors.push(`${skill.directory}: ${errorText(error)}`);
      continue;
    }

    result.migratedCount += 1;
    if (piUsesOldSsot) {
      piNativeSources.push(directory);
    } else if (piDeployment !== undefined) {
      piDeployments.push([directory, piDeployment]);
    }
  }

  // Only after every file moved may the setting change.
  setSkillStorageLocation(target);

  for (const [directory, appDestination, deployment] of managedDeployments) {
    try {
      refreshPiSkillDestination(path.join(newDirectory, directory), appDestination, directory, deployment);
    } catch (error) {
      result.errors.push(`${directory}: ${errorText(error)}`);
    }
  }

  // Re-point every bound application directory at the new SSOT.
  for (const app of APP_IDS) {
    if (!isBound(app)) continue;
    try {
      syncToApp(db, app);
    } catch (error) {
      result.errors.push(`${app}: ${errorText(error)}`);
    }
  }

  for (const [directory, deployment] of piDeployments) {
    try {
      refreshPiSkillDestination(
        path.join(newDirectory, directory),
        path.join(piDirectory, directory),
        directory,
        deployment,
      );
    } catch (error) {
      result.errors.push(`${directory}: ${errorText(error)}`);
    }
  }
  for (const directory of piNativeSources) {
    try {
      syncToAppDir(directory, "pi");
    } catch (error) {
      result.errors.push(`${directory}: ${errorText(error)}`);
    }
  }

  return result;
}
