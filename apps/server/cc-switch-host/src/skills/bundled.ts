/** Local Dovspace adaptation over cc-switch's managed library, staging, hashes and deployment. */
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Database } from "../database/index.ts";
import { AppError } from "../errors.ts";
import { isBound, physicalRoot, requireApp, requireNativeReadPath } from "../host-context.ts";
import { APP_IDS, appFlagsFromEnabled, type AppId, type InstalledSkill } from "../types.ts";
import { createUninstallBackup } from "./backup.ts";
import { inspectPiSkillDestination, type PiSkillDeployment } from "./deploy.ts";
import { pathEntryExists } from "./fs.ts";
import { computeDirHash, computePiDeploymentHash } from "./hash.ts";
import { updateManagedSkillFiles } from "./install.ts";
import { appSkillsDir, distinctAppSkillsDir, skillStorageDir, ssotDir, validateSkillDirectory } from "./paths.ts";

const bundleSchema = z.array(z.strictObject({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: z.string().min(1).max(300), description: z.string().max(20000),
  sourcePath: z.string().regex(/^(?:\.agents\/skills|plugins\/dovspace-pm\/skills)\/[a-z0-9-]+\/SKILL\.md$/),
  content: z.string().max(2 * 1024 * 1024), sha256: z.string().regex(/^[0-9a-f]{64}$/),
})).min(1).max(9).refine(items => new Set(items.map(item => item.id)).size === items.length);
export type HostBundledSkill = z.infer<typeof bundleSchema>[number];
export type HostBundledSkillState = { id: string; status: "not-installed" | "installed" | "update-available" | "conflict"; reason?: string };
export const BUNDLED_CONFLICT_REASON = "Existing managed or native content is not an unchanged Dovspace deployment; it was preserved.";
const managedId = (id: string) => `bundled:dovspace:${id}`;

export function parseHostBundledSkills(value: unknown): HostBundledSkill[] {
  const bundles = bundleSchema.parse(value);
  for (const skill of bundles) {
    if (!skill.sourcePath.endsWith(`/${skill.id}/SKILL.md`) ||
        createHash("sha256").update(skill.content, "utf8").digest("hex") !== skill.sha256)
      throw new AppError("INVALID_INPUT", "Bundled Skill content identity is invalid.");
  }
  return bundles;
}

function assertStorageRoot(): void {
  const root = skillStorageDir();
  if (!pathEntryExists(root)) return;
  const metadata = lstatSync(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new AppError("CONFIG", BUNDLED_CONFLICT_REASON);
}


/** Verify full trees (including hidden/extra files), not just the visible manifest. */
export function assertBundledSkillUnedited(skill: InstalledSkill): void {
  if (!skill.source) return;
  assertStorageRoot();
  validateSkillDirectory(skill.directory);
  const source = path.join(skillStorageDir(), skill.directory);
  const metadata = lstatSync(source);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
      computePiDeploymentHash(source) !== skill.source.treeHash ||
      createHash("sha256").update(readFileSync(path.join(source, "SKILL.md"))).digest("hex") !== skill.source.sha256)
    throw new AppError("CONFIG", BUNDLED_CONFLICT_REASON);
}

/** All bound destinations are checked: a disabled assignment cannot authorize deleting user edits. */
export function assertBundledSkillDestinations(skill: InstalledSkill): void {
  if (!skill.source) return;
  assertBundledSkillUnedited(skill);
  const source = path.join(skillStorageDir(), skill.directory);
  for (const app of APP_IDS.filter(isBound)) {
    requireNativeReadPath(app, appSkillsDir(app));
    const destination = path.join(distinctAppSkillsDir(skillStorageDir(), app), skill.directory);
    inspectPiSkillDestination(source, destination, skill.directory);
  }
}

function findOwned(db: Database, bundle: HostBundledSkill): InstalledSkill | undefined {
  assertStorageRoot();
  const entries = [...db.skills.getAllInstalled().values()];
  const matching = entries.filter(skill => skill.directory.toLowerCase() === bundle.id.toLowerCase());
  const owned = db.skills.getInstalled(managedId(bundle.id));
  if (matching.some(skill => skill.id !== owned?.id) || owned &&
      (owned.directory !== bundle.id || owned.source?.sourcePath !== bundle.sourcePath || owned.source?.sourceLabel !== "Dovspace"))
    throw new AppError("CONFIG", BUNDLED_CONFLICT_REASON);
  if (!owned && pathEntryExists(path.join(skillStorageDir(), bundle.id))) throw new AppError("CONFIG", BUNDLED_CONFLICT_REASON);
  if (owned) assertBundledSkillDestinations(owned);
  return owned;
}

export function inspectBundledSkill(db: Database, bundle: HostBundledSkill, app: AppId): HostBundledSkillState {
  requireApp(app);
  try {
    const owned = findOwned(db, bundle);
    const destination = path.join(distinctAppSkillsDir(skillStorageDir(), app), bundle.id);
    requireNativeReadPath(app, appSkillsDir(app));
    const exists = pathEntryExists(destination);
    if (!owned) {
      if (exists) throw new AppError("CONFIG", BUNDLED_CONFLICT_REASON);
      return { id: bundle.id, status: "not-installed" };
    }
    if (owned.source!.sha256 !== bundle.sha256) return { id: bundle.id, status: "update-available" };
    return { id: bundle.id, status: exists ? "installed" : "not-installed" };
  } catch {
    return { id: bundle.id, status: "conflict", reason: BUNDLED_CONFLICT_REASON };
  }
}

/** The native target is selected by the Agent binding; callers cannot choose an arbitrary path. */
export function installBundledSkill(db: Database, bundle: HostBundledSkill, app: AppId): { id: string; status: "installed" | "updated" | "unchanged" | "conflict" | "error"; error?: { code: string; message: string } } {
  requireApp(app);
  const state = inspectBundledSkill(db, bundle, app);
  if (state.status === "conflict") return { id: bundle.id, status: "conflict", error: { code: "bundled_skill_conflict", message: BUNDLED_CONFLICT_REASON } };
  let staging: string | undefined;
  try {
    const owned = findOwned(db, bundle);
    if (state.status === "installed" && (app === "pi" || app === "omp" || owned?.apps[app])) return { id: bundle.id, status: "unchanged" };
    const ssot = ssotDir();
    const source = path.join(ssot, bundle.id);
    const selectedDestination = path.join(distinctAppSkillsDir(ssot, app), bundle.id);
    if (!owned && pathEntryExists(selectedDestination)) throw new AppError("CONFIG", BUNDLED_CONFLICT_REASON);
    staging = mkdtempSync(path.join(ssot, ".bundled-skill-"));
    writeFileSync(path.join(staging, "SKILL.md"), bundle.content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const deployments: Array<[string, PiSkillDeployment]> = [];
    const absent: string[] = [];
    const destinations = new Set<string>();
    // Update all assigned copies, including observed Pi/OMP, while preserving every assignment.
    for (const target of APP_IDS.filter(isBound)) {
      const physicalDestination = path.join(physicalRoot(target)!, "skills", bundle.id);
      if (destinations.has(physicalDestination)) continue;
      const destination = path.join(distinctAppSkillsDir(ssot, target), bundle.id);
      const deployment = owned ? inspectPiSkillDestination(source, destination, bundle.id) : undefined;
      if (deployment) { deployments.push([destination, deployment]); destinations.add(physicalDestination); }
      else if (target === app || owned?.apps[target]) { absent.push(destination); destinations.add(physicalDestination); }
    }
    const now = Math.floor(Date.now() / 1000);
    const skill: InstalledSkill = {
      id: managedId(bundle.id), name: bundle.name, description: bundle.description, directory: bundle.id,
      apps: { ...(owned?.apps ?? appFlagsFromEnabled([])), [app]: true },
      installedAt: owned?.installedAt ?? now, updatedAt: owned ? now : 0,
      contentHash: computeDirHash(staging),
      source: { sourceLabel: "Dovspace", sourcePath: bundle.sourcePath, sha256: bundle.sha256, treeHash: computePiDeploymentHash(staging) },
    };
    if (owned && owned.source!.sha256 !== bundle.sha256) createUninstallBackup(owned);
    updateManagedSkillFiles(staging, source, bundle.id, deployments, absent,
      () => db.transaction(() => db.skills.save(skill)),
      () => {
        assertStorageRoot();
        for (const target of APP_IDS.filter(isBound)) requireNativeReadPath(target, appSkillsDir(target));
        if (owned) assertBundledSkillDestinations(owned);
        else if (pathEntryExists(source)) throw new AppError("CONFIG", BUNDLED_CONFLICT_REASON);
        for (const destination of absent) if (pathEntryExists(destination)) throw new AppError("CONFIG", BUNDLED_CONFLICT_REASON);
      });
    return { id: bundle.id, status: owned && owned.source!.sha256 !== bundle.sha256 ? "updated" : "installed" };
  } catch {
    const current = inspectBundledSkill(db, bundle, app);
    return current.status === "conflict"
      ? { id: bundle.id, status: "conflict", error: { code: "bundled_skill_conflict", message: BUNDLED_CONFLICT_REASON } }
      : { id: bundle.id, status: "error", error: { code: "bundled_skill_install_failed", message: "Installation failed or completion is unconfirmed. Read the current state before another explicit attempt." } };
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true });
  }
}
