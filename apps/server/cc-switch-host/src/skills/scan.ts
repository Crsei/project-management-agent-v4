/** Translated from vendor/cc-switch/src-tauri/src/services/skill.rs (SKILL.md scanning). */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { AppError } from "../errors.ts";
import { APP_IDS, type DiscoverableSkill, type SkillMetadata, type SkillRepo } from "../types.ts";
import { isBound } from "../host-context.ts";
import { agentsSkillsDir, appSkillsDir, skillStorageDir } from "./paths.ts";
import { validateRepoRef } from "./network.ts";

export interface UnmanagedSkill {
  directory: string;
  name: string;
  description?: string;
  foundIn: string[];
  path: string;
}

export interface NativeSkillObservation extends UnmanagedSkill {
  /** Library bookkeeping only, never a runtime-loaded or enabled observation. */
  managed: boolean;
}

export interface SkillEntry {
  directory: string;
  path: string;
  name: string;
  description?: string;
}

function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function emptyMetadata(): SkillMetadata {
  return {};
}

/**
 * Parse YAML front matter from `SKILL.md`. Malformed front matter, a non-map
 * document, or non-string name/description values yield empty metadata exactly
 * like `serde_yaml` falling back to the default struct.
 */
export function parseSkillMetadata(skillMdPath: string): SkillMetadata {
  const content = readFileSync(skillMdPath, "utf8").replace(/^\uFEFF+/, "");

  const first = content.indexOf("---");
  if (first < 0) return emptyMetadata();
  const second = content.indexOf("---", first + 3);
  if (second < 0) return emptyMetadata();

  const frontMatter = content.slice(first + 3, second).trim();

  let parsed: unknown;
  try {
    parsed = parseYaml(frontMatter);
  } catch {
    return emptyMetadata();
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return emptyMetadata();

  const object = parsed as Record<string, unknown>;
  const metadata: SkillMetadata = {};
  if (Object.prototype.hasOwnProperty.call(object, "name")) {
    const name = object.name;
    if (name !== undefined && name !== null) {
      if (typeof name !== "string") return emptyMetadata();
      metadata.name = name;
    }
  }
  if (Object.prototype.hasOwnProperty.call(object, "description")) {
    const description = object.description;
    if (description !== undefined && description !== null) {
      if (typeof description !== "string") return emptyMetadata();
      metadata.description = description;
    }
  }
  return metadata;
}

export function readSkillNameDesc(
  skillMdPath: string,
  fallbackName: string,
): { name: string; description?: string } {
  if (!existsSync(skillMdPath)) return { name: fallbackName };

  let metadata: SkillMetadata;
  try {
    metadata = parseSkillMetadata(skillMdPath);
  } catch {
    return { name: fallbackName };
  }

  return {
    name: metadata.name ?? fallbackName,
    ...(metadata.description !== undefined ? { description: metadata.description } : {}),
  };
}

function scanSkillsRecursive(current: string, results: string[]): void {
  if (existsSync(path.join(current, "SKILL.md"))) {
    results.push(current);
    return;
  }

  let names: string[];
  try {
    names = readdirSync(current);
  } catch {
    return;
  }

  for (const name of names) {
    const target = path.join(current, name);
    if (!isDirectory(target) || name.startsWith(".")) continue;
    scanSkillsRecursive(target, results);
  }
}

/** Recursively find directories containing `SKILL.md`, stopping at each skill root. */
export function scanSkillsInDir(dir: string): string[] {
  const results: string[] = [];
  scanSkillsRecursive(dir, results);
  return results;
}

function buildSkillDocUrl(owner: string, repo: string, branch: string, docPath: string): string | undefined {
  try {
    validateRepoRef(owner, repo, branch);
  } catch {
    return undefined;
  }
  return `https://github.com/${owner}/${repo}/blob/${branch}/${docPath}`;
}

function collectDiscoverable(
  current: string,
  baseDir: string,
  repo: SkillRepo,
  skills: DiscoverableSkill[],
): void {
  const skillMd = path.join(current, "SKILL.md");

  if (existsSync(skillMd)) {
    const directory = current === baseDir
      ? repo.name
      : path.relative(baseDir, current).replace(/\\/g, "/");
    const docPath = path.relative(baseDir, skillMd).replace(/\\/g, "/");

    let metadata: SkillMetadata;
    try {
      metadata = parseSkillMetadata(skillMd);
    } catch {
      return;
    }

    const readmeUrl = buildSkillDocUrl(repo.owner, repo.name, repo.branch, docPath);
    skills.push({
      key: `${repo.owner}/${repo.name}:${directory}`,
      name: metadata.name ?? directory,
      description: metadata.description ?? "",
      directory,
      ...(readmeUrl !== undefined ? { readmeUrl } : {}),
      repoOwner: repo.owner,
      repoName: repo.name,
      repoBranch: repo.branch,
    });
    return;
  }

  let names: string[];
  try {
    names = readdirSync(current);
  } catch (error) {
    throw new AppError("IO", `failed to read directory: ${current}: ${String(error)}`);
  }

  for (const name of names) {
    const target = path.join(current, name);
    if (isDirectory(target)) collectDiscoverable(target, baseDir, repo, skills);
  }
}

/** Scan a downloaded repository tree for skills, producing discoverable entries. */
export function scanDirRecursive(baseDir: string, repo: SkillRepo): DiscoverableSkill[] {
  const skills: DiscoverableSkill[] = [];
  collectDiscoverable(baseDir, baseDir, repo, skills);
  return skills;
}

/** Inspect the immediate skill directories of one root (an application skills dir). */
export function scanSkillEntries(dir: string): SkillEntry[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  const entries: SkillEntry[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const target = path.join(dir, name);
    if (!isDirectory(target)) continue;
    const skillMd = path.join(target, "SKILL.md");
    if (!existsSync(skillMd)) continue;

    const { name: displayName, description } = readSkillNameDesc(skillMd, name);
    entries.push({
      directory: name,
      path: target,
      name: displayName,
      ...(description !== undefined ? { description } : {}),
    });
  }
  return entries;
}

/**
 * Scan application, agents and SSOT roots for skills that are not managed by
 * the host, de-duplicated by directory name and labelled by discovery source.
 */
export function scanUnmanaged(managedDirectories: Iterable<string>): UnmanagedSkill[] {
  const managed = new Set(managedDirectories);
  const sources: Array<{ dir: string; label: string }> = [];

  for (const app of APP_IDS) {
    if (!isBound(app)) continue;
    try {
      sources.push({ dir: appSkillsDir(app), label: app });
    } catch {
      // Unresolvable application roots are skipped.
    }
  }
  const agents = agentsSkillsDir();
  if (agents !== undefined) sources.push({ dir: agents, label: "agents" });
  try {
    sources.push({ dir: skillStorageDir(), label: "cc-switch" });
  } catch {
    // A missing SSOT root contributes nothing to the scan.
  }

  const unmanaged = new Map<string, UnmanagedSkill>();
  for (const { dir, label } of sources) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }

    for (const name of names) {
      const target = path.join(dir, name);
      if (!isDirectory(target)) continue;
      if (name.startsWith(".") || managed.has(name)) continue;

      const skillMd = path.join(target, "SKILL.md");
      if (!existsSync(skillMd)) continue;

      const { name: displayName, description } = readSkillNameDesc(skillMd, name);
      const existing = unmanaged.get(name);
      if (existing !== undefined) {
        existing.foundIn.push(label);
        continue;
      }
      unmanaged.set(name, {
        directory: name,
        name: displayName,
        ...(description !== undefined ? { description } : {}),
        foundIn: [label],
        path: target,
      });
    }
  }

  return [...unmanaged.values()];
}
