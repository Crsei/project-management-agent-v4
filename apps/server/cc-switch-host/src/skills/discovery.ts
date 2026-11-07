/** Translated from vendor/cc-switch/src-tauri/src/services/skill.rs (repository discovery, update checks, skills.sh search, repo management). */
import { readdirSync, statSync, type Dirent } from "node:fs";
import path from "node:path";
import { DISCOVERY_CACHE_TTL_MS, SKILLS_SH_TIMEOUT_MS } from "../constants.ts";
import type { Database } from "../database/index.ts";
import { AppError } from "../errors.ts";
import type {
  DiscoverableSkill, InstalledSkill, SkillDiscoveryResult, SkillRepo, SkillRepoFailure,
  SkillUpdateCheckResult, SkillUpdateInfo, SkillsShDiscoverableSkill, SkillsShSearchResult,
} from "../types.ts";
import { computeDirHash } from "./hash.ts";
import { pathExists } from "./fs.ts";
import {
  sanitizeSkillSourcePath, ssotDir, validateSkillDirectory,
} from "./paths.ts";
import { parseSkillMetadata, scanDirRecursive, scanSkillsInDir } from "./scan.ts";
import { downloadRepo, errorText, repoFailure, removeWorkspace, validateRepoRef } from "./network.ts";
import { extractRepoArchive } from "./zip.ts";

export { validateRepoRef };

const DISCOVERY_CACHE_TTL = DISCOVERY_CACHE_TTL_MS;
const discoveryCache = new Map<string, { fetchedAt: number; skills: DiscoverableSkill[] }>();

function discoveryCacheKey(repo: SkillRepo): string {
  return `${repo.owner}\u0000${repo.name}\u0000${repo.branch}`;
}

/**
 * `readme_url` ends up in `openExternal`, so an illegal coordinate must not
 * produce a link that points anywhere on github.com.
 */
export function buildSkillDocUrl(owner: string, repo: string, branch: string, docPath: string): string | undefined {
  try {
    validateRepoRef(owner, repo, branch);
  } catch {
    return undefined;
  }
  return `https://github.com/${owner}/${repo}/blob/${branch}/${docPath}`;
}

/** Extract the repository-relative document path from a stored `readme_url`. */
export function extractDocPathFromUrl(url: string): string | undefined {
  const marker = url.includes("/blob/") ? "/blob/" : url.includes("/tree/") ? "/tree/" : undefined;
  if (marker === undefined) return undefined;
  const markerIndex = url.indexOf(marker);
  const tail = url.slice(markerIndex + marker.length);
  const slash = tail.indexOf("/");
  if (slash < 0) return undefined;
  const docPath = tail.slice(slash + 1);
  return docPath.length > 0 ? docPath : undefined;
}

async function fetchRepoSkills(repo: SkillRepo): Promise<DiscoverableSkill[]> {
  const { dir, branch } = await downloadRepo(repo, (archivePath, destination, signal) =>
    extractRepoArchive(archivePath, destination, signal));
  try {
    return scanDirRecursive(dir, { ...repo, branch });
  } finally {
    removeWorkspace(dir);
  }
}

/** Cached discovery: only successfully read repositories enter the cache. */
export async function fetchRepoSkillsCached(repo: SkillRepo, forceRefresh: boolean): Promise<DiscoverableSkill[]> {
  const key = discoveryCacheKey(repo);
  if (!forceRefresh) {
    const cached = discoveryCache.get(key);
    if (cached !== undefined && Date.now() - cached.fetchedAt < DISCOVERY_CACHE_TTL) {
      return cached.skills.map((skill) => ({ ...skill }));
    }
  }

  // The timestamp is taken before the download starts: an older download that
  // finishes later must not overwrite a newer forced refresh.
  const startedAt = Date.now();
  const skills = await fetchRepoSkills(repo);
  const current = discoveryCache.get(key);
  if (current === undefined || current.fetchedAt <= startedAt) {
    discoveryCache.set(key, { fetchedAt: startedAt, skills: skills.map((skill) => ({ ...skill })) });
  }
  return skills;
}

/** De-duplicate by full `owner/name:directory` key so same-named skills from different repos survive. */
export function deduplicateDiscoverableSkills(skills: DiscoverableSkill[]): DiscoverableSkill[] {
  const seen = new Set<string>();
  return skills.filter((skill) => {
    const key = skill.key.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sortSkillsByName(skills: DiscoverableSkill[]): void {
  skills.sort((left, right) => {
    const a = left.name.toLowerCase();
    const b = right.name.toLowerCase();
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

export async function discoverAvailableReport(repos: SkillRepo[], forceRefresh: boolean): Promise<SkillDiscoveryResult> {
  const enabledRepos = repos.filter((repo) => repo.enabled);
  const results = await Promise.allSettled(
    enabledRepos.map((repo) => fetchRepoSkillsCached(repo, forceRefresh)),
  );

  const skills: DiscoverableSkill[] = [];
  const failures: SkillRepoFailure[] = [];
  results.forEach((result, index) => {
    const repo = enabledRepos[index];
    if (repo === undefined) return;
    if (result.status === "fulfilled") {
      skills.push(...result.value);
    } else {
      failures.push(repoFailure(repo, errorText(result.reason)));
    }
  });

  const unique = deduplicateDiscoverableSkills(skills);
  sortSkillsByName(unique);
  return { skills: unique, failures };
}

export async function discoverRepo(repo: SkillRepo): Promise<SkillDiscoveryResult> {
  if (!repo.enabled) return { skills: [], failures: [] };
  try {
    const skills = deduplicateDiscoverableSkills(await fetchRepoSkillsCached(repo, false));
    sortSkillsByName(skills);
    return { skills, failures: [] };
  } catch (error) {
    return { skills: [], failures: [repoFailure(repo, errorText(error))] };
  }
}

export function addSkillRepo(db: Database, repo: SkillRepo): void {
  if (typeof repo.owner !== "string" || typeof repo.name !== "string"
    || typeof repo.branch !== "string" || typeof repo.enabled !== "boolean") {
    throw new AppError("INVALID_INPUT", "Invalid skill repository", "invalid_skill_repo");
  }
  validateRepoRef(repo.owner, repo.name, repo.branch);
  db.skills.saveRepo(repo);
}

export function removeSkillRepo(db: Database, owner: string, name: string): void {
  db.skills.deleteRepo(owner, name);
}

/** Locate an installed skill in a freshly scanned repository. */
export function findRemoteSkillForInstall(
  remoteSkills: DiscoverableSkill[],
  installName: string,
  storedReadmeUrl: string | undefined,
): DiscoverableSkill | undefined {
  const storedDocPath = storedReadmeUrl === undefined ? undefined : extractDocPathFromUrl(storedReadmeUrl);
  if (storedDocPath !== undefined) {
    const byDocPath = remoteSkills.find((skill) =>
      skill.readmeUrl !== undefined && extractDocPathFromUrl(skill.readmeUrl) === storedDocPath);
    if (byDocPath !== undefined) return byDocPath;
  }

  const byDirectory = remoteSkills.find((skill) => {
    const segments = skill.directory.split("/");
    return (segments[segments.length - 1] ?? skill.directory).toLowerCase() === installName.toLowerCase();
  });
  if (byDirectory !== undefined) return byDirectory;

  const byMetadataName = remoteSkills.filter((skill) => skill.name.trim().toLowerCase() === installName.toLowerCase());
  return byMetadataName.length === 1 ? byMetadataName[0] : undefined;
}

/** Search a repository tree for a directory with this name that contains SKILL.md. */
export function findSkillDirByName(root: string, targetName: string): string | undefined {
  const walk = (directory: string, depth: number): string | undefined => {
    if (depth > 3) return undefined;
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue;
      if (entry.name.toLowerCase() === targetName.toLowerCase() && pathExists(path.join(entryPath, "SKILL.md"))) {
        return entryPath;
      }
      const found = walk(entryPath, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return walk(root, 0);
}

function isDirectory(value: string): boolean {
  try {
    return statSync(value).isDirectory();
  } catch {
    return false;
  }
}

function isFile(value: string): boolean {
  try {
    return statSync(value).isFile();
  } catch {
    return false;
  }
}

function metadataNameMatches(skillDir: string, installName: string): boolean {
  try {
    const metadata = parseSkillMetadata(path.join(skillDir, "SKILL.md"));
    return metadata.name !== undefined && metadata.name.trim().toLowerCase() === installName.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Resolve a discoverable skill's directory to a real source directory inside
 * the extracted repository. The result always contains SKILL.md.
 */
export function resolveSkillSourceDir(root: string, rawDirectory: string): string | undefined {
  const sourceRelative = sanitizeSkillSourcePath(rawDirectory);
  if (sourceRelative === undefined) return undefined;
  const installName = path.basename(sourceRelative);

  const direct = path.join(root, sourceRelative);
  if (isDirectory(direct) && isFile(path.join(direct, "SKILL.md"))) return direct;

  const byName = findSkillDirByName(root, installName);
  if (byName !== undefined) return byName;

  // skills.sh skill IDs may differ from the directory name; only a unique
  // metadata match is accepted so traversal order cannot pick a random skill.
  let metadataMatches: string[] = [];
  try {
    metadataMatches = scanSkillsInDir(root).filter((candidate) => metadataNameMatches(candidate, installName));
  } catch {
    metadataMatches = [];
  }
  if (metadataMatches.length === 1) return metadataMatches[0];
  if (metadataMatches.length > 1) return undefined;

  if (isFile(path.join(root, "SKILL.md"))) return root;
  return undefined;
}

/** Repository-relative SKILL.md path for a resolved source directory. */
export function docPathForSource(repoRoot: string, source: string): string | undefined {
  const relative = path.relative(repoRoot, source);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
  const parts = relative.split(path.sep).filter((part) => part.length > 0);
  parts.push("SKILL.md");
  return parts.join("/");
}

/** Pick the doc path for `readme_url`: resolved source, then stored URL, then directory. */
export function chooseDocPath(
  resolvedSourceDocPath: string | undefined,
  readmeUrl: string | undefined,
  directory: string,
): string {
  if (resolvedSourceDocPath !== undefined) return resolvedSourceDocPath;
  if (readmeUrl !== undefined) {
    const stored = extractDocPathFromUrl(readmeUrl);
    if (stored !== undefined) {
      if (stored === "SKILL.md" || stored.endsWith("/SKILL.md")) return stored;
      return `${stored.replace(/\/+$/, "")}/SKILL.md`;
    }
  }
  return `${directory.replace(/\/+$/, "")}/SKILL.md`;
}

function localHashForUpdateCheck(
  ssotDirectory: string,
  rawDirectory: string,
  cachedHash: string | undefined,
): { hash: string; freshlyComputed: boolean } | undefined {
  let directory: string;
  try {
    directory = validateSkillDirectory(rawDirectory);
  } catch {
    // Cannot safely join the path; never report "updatable" because update
    // would reject the same row, so keep the cached hash instead.
    return cachedHash === undefined ? undefined : { hash: cachedHash, freshlyComputed: false };
  }
  const localDir = path.join(ssotDirectory, directory);
  if (!pathExists(localDir)) return undefined;
  if (cachedHash !== undefined) return { hash: cachedHash, freshlyComputed: false };
  try {
    return { hash: computeDirHash(localDir), freshlyComputed: true };
  } catch {
    return undefined;
  }
}

/** Check updates for every installed skill that has repository coordinates. */
export async function checkSkillUpdates(db: Database): Promise<SkillUpdateCheckResult> {
  const installed: InstalledSkill[] = [...db.skills.getAllInstalled().values()];
  const groups = new Map<string, { repo: SkillRepo; skills: InstalledSkill[] }>();

  for (const skill of installed) {
    if (skill.repoOwner === undefined || skill.repoName === undefined) continue;
    const branch = skill.repoBranch ?? "main";
    const key = `${skill.repoOwner}\u0000${skill.repoName}\u0000${branch}`;
    const group = groups.get(key);
    const repo: SkillRepo = { owner: skill.repoOwner, name: skill.repoName, branch, enabled: true };
    if (group === undefined) groups.set(key, { repo, skills: [skill] });
    else group.skills.push(skill);
  }

  const ssotDirectory = ssotDir();
  const updates: SkillUpdateInfo[] = [];
  const failures: SkillRepoFailure[] = [];

  for (const { repo, skills } of groups.values()) {
    let workspace: { dir: string; branch: string };
    try {
      workspace = await downloadRepo(repo, (archivePath, destination, signal) =>
        extractRepoArchive(archivePath, destination, signal));
    } catch (error) {
      failures.push(repoFailure(repo, errorText(error)));
      continue;
    }

    try {
      let remoteSkills: DiscoverableSkill[];
      try {
        remoteSkills = scanDirRecursive(workspace.dir, repo);
      } catch (error) {
        // Report a possibly incomplete repository, but still compare what was read.
        failures.push(repoFailure(repo, errorText(error)));
        remoteSkills = [];
      }

      for (const skill of skills) {
        const remoteMatch = findRemoteSkillForInstall(remoteSkills, skill.directory, skill.readmeUrl);
        if (remoteMatch === undefined) continue;
        const remoteSource = resolveSkillSourceDir(workspace.dir, remoteMatch.directory);
        if (remoteSource === undefined) continue;

        let remoteHash: string;
        try {
          remoteHash = computeDirHash(remoteSource);
        } catch {
          continue;
        }

        const local = localHashForUpdateCheck(ssotDirectory, skill.directory, skill.contentHash);
        if (local?.freshlyComputed === true) db.skills.updateHash(skill.id, local.hash, 0);
        const localHash = local?.hash;
        if (localHash !== remoteHash) {
          updates.push({ id: skill.id, name: skill.name, currentHash: localHash, remoteHash });
        }
      }
    } finally {
      removeWorkspace(workspace.dir);
    }
  }

  failures.sort((a, b) => {
    const left = `${a.owner}\u0000${a.name}`;
    const right = `${b.owner}\u0000${b.name}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return { updates, failures };
}

interface SkillsShApiSkill { id: string; skillId: string; name: string; installs: number; source: string; }
interface SkillsShApiResponse { query: string; skills: SkillsShApiSkill[]; count: number; }

function parseSkillsShResponse(value: unknown): SkillsShApiResponse {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("CONFIG", "Invalid skills.sh response");
  }
  const object = value as Record<string, unknown>;
  if (typeof object.query !== "string" || typeof object.count !== "number" || !Array.isArray(object.skills)) {
    throw new AppError("CONFIG", "Invalid skills.sh response");
  }
  const skills: SkillsShApiSkill[] = [];
  for (const item of object.skills) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.id !== "string" || typeof entry.skillId !== "string"
      || typeof entry.name !== "string" || typeof entry.installs !== "number"
      || typeof entry.source !== "string") {
      continue;
    }
    skills.push({
      id: entry.id, skillId: entry.skillId, name: entry.name,
      installs: entry.installs, source: entry.source,
    });
  }
  return { query: object.query, skills, count: object.count };
}

/** Search the public skills.sh catalogue. */
export async function searchSkillsSh(query: string, limit: number, offset: number): Promise<SkillsShSearchResult> {
  if (!Number.isInteger(limit) || limit < 0 || !Number.isInteger(offset) || offset < 0) {
    throw new AppError("INVALID_INPUT", "Invalid skills.sh pagination", "invalid_skill_search");
  }
  const url = new URL("https://skills.sh/api/search");
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("offset", String(offset));

  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(SKILLS_SH_TIMEOUT_MS) });
  } catch (error) {
    throw new AppError("CONFIG", `skills.sh search failed: ${errorText(error)}`);
  }
  if (!response.ok) {
    throw new AppError("CONFIG", `skills.sh search failed: HTTP ${response.status}`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new AppError("CONFIG", `Invalid skills.sh response: ${errorText(error)}`);
  }
  const api = parseSkillsShResponse(payload);

  const skills: SkillsShDiscoverableSkill[] = [];
  for (const entry of api.skills) {
    const sourceParts = entry.source.split("/");
    if (sourceParts.length !== 2) continue;
    const [owner, repo] = sourceParts;
    if (owner === undefined || repo === undefined) continue;
    try {
      validateRepoRef(owner, repo, "main");
    } catch {
      continue;
    }
    skills.push({
      key: entry.id,
      name: entry.name,
      directory: entry.skillId,
      repoOwner: owner,
      repoName: repo,
      repoBranch: "main",
      installs: entry.installs,
      readmeUrl: `https://github.com/${owner}/${repo}`,
    });
  }

  return { skills, totalCount: api.count, query: api.query };
}
