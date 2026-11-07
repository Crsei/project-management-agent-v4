/** Translated from vendor/cc-switch/src-tauri/src/services/skill.rs (repository download, URL guards, branch fallback). */
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MAX_ARCHIVE_DOWNLOAD_BYTES, SKILL_DOWNLOAD_TIMEOUT_MS } from "../constants.ts";
import { AppError } from "../errors.ts";
import type { SkillRepo, SkillRepoFailure } from "../types.ts";

/** GitHub archive downloads are rate limited more aggressively without a User-Agent (#8813). */
const SKILL_DOWNLOAD_USER_AGENT = "CC-Switch/4.0.25";

/** Context values Rust renders with serde_json; field order matches the serialized object. */
export interface SkillErrorPayload {
  code: string;
  context: Record<string, string>;
  suggestion: string | null;
}

/**
 * Structured error message used by the Rust service (`format_skill_error`).
 * The frontend parses the message as JSON, so the payload must stay verbatim.
 */
export function skillError(
  code: string,
  context: Record<string, string> = {},
  suggestion?: string,
): AppError {
  const payload: SkillErrorPayload = { code, context, suggestion: suggestion ?? null };
  return new AppError("CONFIG", JSON.stringify(payload));
}

function parseSkillErrorPayload(error: unknown): SkillErrorPayload | undefined {
  if (!(error instanceof Error)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(error.message);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const payload = value as Partial<SkillErrorPayload>;
  if (typeof payload.code !== "string") return undefined;
  if (payload.context === null || typeof payload.context !== "object" || Array.isArray(payload.context)) return undefined;
  return payload as SkillErrorPayload;
}

/**
 * GitHub account name. Deliberately stricter than GitHub itself: this value is
 * interpolated into the archive URL, so `/`, `.`, `%` and `\` must not pass.
 */
export function isValidGithubOwner(owner: string): boolean {
  return owner.length > 0
    && Buffer.byteLength(owner, "utf8") <= 39
    && /^[A-Za-z0-9-]+$/.test(owner);
}

/** GitHub repository name; `.` `-` `_` are legal, but `.` and `..` are not. */
export function isValidGithubRepoName(name: string): boolean {
  return name.length > 0
    && Buffer.byteLength(name, "utf8") <= 100
    && name !== "."
    && name !== ".."
    && /^[A-Za-z0-9._-]+$/.test(name);
}

/**
 * Git branch name. Empty and `HEAD` are the "use the default branch" sentinels
 * and never reach a URL, so they are accepted. `#` and `%` are rejected because
 * they can turn the trailing part of the archive URL into a fragment or an
 * encoded bypass.
 */
export function isValidGitBranch(branch: string): boolean {
  if (branch.length === 0 || branch.toLowerCase() === "head") return true;
  if (Buffer.byteLength(branch, "utf8") > 255) return false;
  if (branch.startsWith("/") || branch.endsWith("/") || branch.includes("//")) return false;
  if (branch.includes("@{")) return false;
  for (const character of branch) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return false;
    if (" ~^:?*[\\#%".includes(character)) return false;
  }
  return branch.split("/").every((segment) =>
    segment.length > 0
    && !segment.startsWith(".")
    && !segment.endsWith(".")
    && !segment.endsWith(".lock"));
}

/** Validate coordinates anywhere they are interpolated into a github.com URL. */
export function validateRepoRef(owner: string, name: string, branch: string): void {
  if (!isValidGithubOwner(owner) || !isValidGithubRepoName(name)) {
    throw skillError("INVALID_REPO_REF", { owner, name }, "checkRepoUrl");
  }
  if (!isValidGitBranch(branch)) {
    throw skillError("INVALID_REPO_REF", { owner, name, branch }, "checkRepoUrl");
  }
}

/** Defence in depth: after assembly the URL must still point at the expected path. */
export function assertGithubArchiveUrl(url: string, owner: string, name: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (error) {
    throw new AppError("CONFIG", `Invalid archive URL: ${String(error)}`);
  }
  const expectedPrefix = `/${owner}/${name}/archive/refs/heads/`;
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || !parsed.pathname.startsWith(expectedPrefix)) {
    throw skillError("INVALID_REPO_REF", { owner, name }, "checkRepoUrl");
  }
}

/** Archive URL for one candidate branch. */
export function githubArchiveUrl(owner: string, name: string, branch: string): string {
  return `https://github.com/${owner}/${name}/archive/refs/heads/${branch}.zip`;
}

export function repoFailure(repo: SkillRepo, error: string): SkillRepoFailure {
  return { owner: repo.owner, name: repo.name, branch: repo.branch, error };
}

/** Rust's `e.to_string()`: the message without the `Error:` prefix. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function downloadTimeoutError(repo: SkillRepo): AppError {
  return skillError(
    "DOWNLOAD_TIMEOUT",
    { owner: repo.owner, name: repo.name, timeout: "60" },
    "checkNetwork",
  );
}

/** A 404 means the branch (or the whole repository) does not exist. */
export function isBranchNotFound(error: unknown): boolean {
  const payload = parseSkillErrorPayload(error);
  return payload?.code === "DOWNLOAD_FAILED" && payload.context.status === "404";
}

/** Attach repository coordinates to a structured download/extract error. */
export function withRepoContext(error: unknown, repo: SkillRepo): unknown {
  const payload = parseSkillErrorPayload(error);
  if (!payload) return error;
  const context: Record<string, string> = { ...payload.context };
  if (context.owner === undefined) context.owner = repo.owner;
  if (context.name === undefined) context.name = repo.name;
  return skillError(payload.code, context, payload.suggestion ?? undefined);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function abortToTimeout(error: unknown, repo: SkillRepo): unknown {
  if (!isAbortError(error)) return error;
  return downloadTimeoutError(repo);
}

function rmWorkspace(directory: string): void {
  try {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  } catch { /* best effort cleanup */ }
}

/**
 * Stream one archive to disk while enforcing the download byte budget.
 * The budget is measured on received bytes, never on the Content-Length header.
 */
async function downloadArchive(url: string, destination: string, signal: AbortSignal): Promise<void> {
  const response = await fetch(url, {
    headers: { "user-agent": SKILL_DOWNLOAD_USER_AGENT },
    redirect: "follow",
    signal,
  });
  if (!response.ok) {
    const status = String(response.status);
    const suggestion = status === "403" ? "http403"
      : status === "404" ? "http404"
      : status === "429" ? "http429"
      : "checkNetwork";
    throw skillError("DOWNLOAD_FAILED", { status }, suggestion);
  }

  mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const descriptor = openSync(destination, "wx", 0o600);
  try {
    if (response.body === null) return;
    let received = 0;
    for await (const chunk of response.body) {
      received += chunk.byteLength;
      if (received > MAX_ARCHIVE_DOWNLOAD_BYTES) {
        throw skillError(
          "ARCHIVE_DOWNLOAD_TOO_LARGE",
          { limit_mb: String(MAX_ARCHIVE_DOWNLOAD_BYTES / 1024 / 1024) },
        );
      }
      writeSync(descriptor, chunk);
    }
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Try the configured branch, then `main`, then `master`, returning the branch
 * that actually downloaded. Only a 404 advances to the next candidate: a
 * timeout, size violation or extraction failure would fail identically there
 * and would bury the real cause under `master`'s 404.
 */
export async function tryRepoBranches(
  repo: SkillRepo,
  tempPath: string,
  attempt: (url: string) => Promise<void>,
): Promise<string> {
  const branches: string[] = [];
  if (repo.branch.length > 0 && repo.branch.toLowerCase() !== "head") branches.push(repo.branch);
  if (!branches.includes("main")) branches.push("main");
  if (!branches.includes("master")) branches.push("master");

  let lastError: unknown;
  for (const branch of branches) {
    const url = githubArchiveUrl(repo.owner, repo.name, branch);
    assertGithubArchiveUrl(url, repo.owner, repo.name);
    try {
      await attempt(url);
      return branch;
    } catch (error) {
      if (!isBranchNotFound(error)) throw withRepoContext(error, repo);
      // Each branch gets a fresh budget, so the previous attempt must not leave
      // up to 512 MiB of partial content behind.
      rmWorkspace(tempPath);
      mkdirSync(tempPath, { recursive: true, mode: 0o700 });
      lastError = error;
    }
  }
  throw withRepoContext(lastError ?? new Error("所有分支下载失败"), repo);
}

/**
 * Download a repository archive into a private workspace and extract it.
 * The caller owns `dir` and must remove it when finished.
 */
export async function downloadRepo(
  repo: SkillRepo,
  extract: (archivePath: string, destination: string, signal: AbortSignal) => Promise<void>,
  timeoutMs: number = SKILL_DOWNLOAD_TIMEOUT_MS,
): Promise<{ dir: string; branch: string }> {
  validateRepoRef(repo.owner, repo.name, repo.branch);
  const dir = mkdtempSync(path.join(tmpdir(), "cc-switch-skill-"));
  const scratch = mkdtempSync(path.join(tmpdir(), "cc-switch-download-"));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const branch = await tryRepoBranches(repo, dir, async (url) => {
      const archive = path.join(scratch, "archive.zip");
      await downloadArchive(url, archive, controller.signal);
      try {
        await extract(archive, dir, controller.signal);
      } finally {
        rmSync(archive, { force: true });
      }
    });
    return { dir, branch };
  } catch (error) {
    rmWorkspace(dir);
    throw abortToTimeout(error, repo);
  } finally {
    clearTimeout(timer);
    rmWorkspace(scratch);
  }
}

/** Release a workspace returned by {@link downloadRepo}. */
export function removeWorkspace(dir: string): void {
  rmWorkspace(dir);
}
