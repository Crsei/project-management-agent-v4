import { execFile } from "node:child_process";
import path from "node:path";
import { Hono, type Context } from "hono";
import type {
  GitChangedFile,
  GitDiffResponse,
  GitFileStatus,
  GitStatusResponse,
  InspectorErrorBody,
} from "@agent-workspace/contracts/inspector";
import { InspectorPathError, resolveInsideRoot, toPosix } from "./paths.ts";
import { DurableError } from "../durable/errors.ts";
import { resolveInspectorRoot } from "./scope.ts";

const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 4 * 1024 * 1024;
/** Maximum number of patch bytes returned by the diff endpoint. */
export const GIT_DIFF_LIMIT = 512 * 1024;

class GitCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitCommandError";
  }
}

interface GitResult {
  stdout: string;
}

function runGit(args: string[], cwd: string, allowNonZero = false): Promise<GitResult> {
  const { promise, resolve, reject } = Promise.withResolvers<GitResult>();
  execFile(
    "git",
    ["--literal-pathspecs", ...args],
    { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, encoding: "utf8" },
    (error, stdout, stderr) => {
      if (!error) {
        resolve({ stdout });
        return;
      }
      const rawCode =
        typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      if (allowNonZero && typeof rawCode === "number") {
        resolve({ stdout });
        return;
      }
      reject(new GitCommandError((stderr.trim() || error.message).slice(0, 2000)));
    },
  );
  return promise;
}

async function repositoryRoot(root: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(["rev-parse", "--show-toplevel"], root);
    const resolved = stdout.trim();
    return resolved.length > 0 ? resolved : null;
  } catch {
    return null;
  }
}

const CONFLICT_STATUSES: Record<string, true> = {
  DD: true,
  AU: true,
  UD: true,
  UA: true,
  DU: true,
  AA: true,
  UU: true,
};

function mapStatus(index: string, worktree: string): GitFileStatus {
  const pair = `${index}${worktree}`;
  if (pair === "??") return "untracked";
  if (CONFLICT_STATUSES[pair]) return "conflicted";
  if (pair.includes("R")) return "renamed";
  if (pair.includes("C")) return "copied";
  if (pair.includes("A")) return "added";
  if (pair.includes("D")) return "deleted";
  return "modified";
}

interface ParsedBranch {
  branch?: string;
  upstream?: string;
  ahead: number;
  behind: number;
}

function parseBranchHeader(header: string): ParsedBranch {
  const result: ParsedBranch = { ahead: 0, behind: 0 };
  const noCommits = /^No commits yet on (.+)$/.exec(header);
  if (noCommits) {
    result.branch = noCommits[1];
    return result;
  }
  if (header.startsWith("HEAD ")) return result;

  const detailsStart = header.indexOf(" [");
  const trackingPart = detailsStart === -1 ? header : header.slice(0, detailsStart);
  const details = detailsStart === -1 ? "" : header.slice(detailsStart + 2, -1);

  const separator = trackingPart.indexOf("...");
  const branch = (separator === -1 ? trackingPart : trackingPart.slice(0, separator)).trim();
  const upstream = (separator === -1 ? "" : trackingPart.slice(separator + 3)).trim();
  if (branch.length > 0) result.branch = branch;
  if (upstream.length > 0) result.upstream = upstream;

  const ahead = /ahead (\d+)/.exec(details);
  const behind = /behind (\d+)/.exec(details);
  if (ahead) result.ahead = Number(ahead[1]);
  if (behind) result.behind = Number(behind[1]);
  return result;
}

interface ParsedStatus {
  branch?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  files: GitChangedFile[];
}

function parseStatus(output: string): ParsedStatus {
  const parsed: ParsedStatus = { ahead: 0, behind: 0, files: [] };
  const tokens = output.split("\0");
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.length === 0) continue;
    if (token.startsWith("## ")) {
      const header = parseBranchHeader(token.slice(3));
      parsed.branch = header.branch;
      parsed.upstream = header.upstream;
      parsed.ahead = header.ahead;
      parsed.behind = header.behind;
      continue;
    }
    if (token.length < 3) continue;

    const indexStatus = token[0];
    const worktreeStatus = token[1];
    const filePath = token.slice(3);
    const status = mapStatus(indexStatus, worktreeStatus);

    let oldPath: string | undefined;
    if (status === "renamed" || status === "copied") {
      const candidate = tokens[index + 1];
      if (candidate !== undefined) {
        oldPath = candidate;
        index += 1;
      }
    }

    const staged = indexStatus !== " " && indexStatus !== "?";
    const unstaged =
      status === "untracked" ? true : worktreeStatus !== " " && worktreeStatus !== "?";

    const file: GitChangedFile = { path: filePath, status, staged, unstaged };
    if (oldPath !== undefined) file.oldPath = oldPath;
    parsed.files.push(file);
  }
  return parsed;
}

async function readStatus(root: string): Promise<GitStatusResponse> {
  const repoRoot = await repositoryRoot(root);
  if (!repoRoot) {
    return { repo: false, ahead: 0, behind: 0, files: [], truncated: false };
  }
  const { stdout } = await runGit(
    // Limit a nested project to its own subtree; for a repo root this is the whole repo.
    ["status", "--porcelain=v1", "-z", "--branch", "--untracked-files=all", "--", "."],
    root,
  );
  const parsed = parseStatus(stdout);
  // Porcelain paths are repository-relative even when git runs in a subdirectory.
  // The UI and the diff endpoint use project-relative paths, so normalize and drop
  // entries outside the inspected project (a no-op when the roots are equal).
  const files: GitChangedFile[] = [];
  for (const file of parsed.files) {
    const relative = toPosix(path.resolve(repoRoot, file.path), root);
    if (relative === ".." || relative.startsWith(`..${path.sep}`)) continue;
    const normalized: GitChangedFile = { ...file, path: relative };
    if (file.oldPath !== undefined) {
      delete normalized.oldPath;
      const oldRelative = toPosix(path.resolve(repoRoot, file.oldPath), root);
      if (oldRelative !== ".." && !oldRelative.startsWith(`..${path.sep}`))
        normalized.oldPath = oldRelative;
    }
    files.push(normalized);
  }
  const response: GitStatusResponse = {
    repo: true,
    root,
    ahead: parsed.ahead,
    behind: parsed.behind,
    files,
    truncated: false,
  };
  if (parsed.branch !== undefined) response.branch = parsed.branch;
  if (parsed.upstream !== undefined) response.upstream = parsed.upstream;
  return response;
}

function capPatch(patch: string): { patch: string; truncated: boolean } {
  const bytes = Buffer.from(patch, "utf8");
  if (bytes.length <= GIT_DIFF_LIMIT) return { patch, truncated: false };
  return { patch: bytes.subarray(0, GIT_DIFF_LIMIT).toString("utf8"), truncated: true };
}

async function readDiff(
  root: string,
  relative: string,
  staged: boolean,
): Promise<GitDiffResponse | null> {
  if (!(await repositoryRoot(root))) return null;

  const target = relative.length > 0 ? relative : ".";
  if (staged) {
    const { stdout } = await runGit(
      ["diff", "--cached", "--no-renames", "--no-color", "--unified=3", "--", target],
      root,
    );
    const capped = capPatch(stdout);
    return {
      path: relative,
      staged: true,
      patch: capped.patch,
      truncated: capped.truncated,
      untracked: false,
    };
  }

  const { stdout } = await runGit(
    ["diff", "--no-renames", "--no-color", "--unified=3", "--", target],
    root,
  );
  if (stdout.length > 0) {
    const capped = capPatch(stdout);
    return {
      path: relative,
      staged: false,
      patch: capped.patch,
      truncated: capped.truncated,
      untracked: false,
    };
  }

  const status = await runGit(
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", target],
    root,
  );
  if (!status.stdout.startsWith("?? ")) {
    return { path: relative, staged: false, patch: "", truncated: false, untracked: false };
  }

  // `--no-index` exits with 1 whenever the inputs differ; that is expected.
  const untrackedDiff = await runGit(
    ["diff", "--no-index", "--no-color", "--unified=3", "--", "/dev/null", target],
    root,
    true,
  );
  const capped = capPatch(untrackedDiff.stdout);
  return {
    path: relative,
    staged: false,
    patch: capped.patch,
    truncated: capped.truncated,
    untracked: true,
  };
}

type InspectorErrorStatus = 400 | 409 | 500;

interface InspectorFailure {
  body: InspectorErrorBody;
  status: InspectorErrorStatus;
}

function fail(body: InspectorErrorBody, status: InspectorErrorStatus): InspectorFailure {
  return { body, status };
}

function respondFailure(c: Context, error: unknown): Response {
  if (error instanceof DurableError)
    return c.json({ error: error.message, code: error.code }, error.status);
  if (error instanceof InspectorPathError) {
    return c.json({ error: error.message, code: "invalid_path" }, 400);
  }
  const failure =
    error instanceof GitCommandError
      ? fail({ error: error.message, code: "git_failed" }, 500)
      : fail(
          {
            error: error instanceof Error ? error.message || "git 命令失败。" : "git 命令失败。",
            code: "internal_error",
          },
          500,
        );
  return c.json(failure.body, failure.status);
}

export const gitRoutes = new Hono()
  .get("/git", async (c) => {
    try {
      const root = await resolveInspectorRoot(new URL(c.req.url), c.req.raw.headers);
      return c.json(await readStatus(root));
    } catch (error) {
      return respondFailure(c, error);
    }
  })
  .get("/git/diff", async (c) => {
    const stagedParam = (c.req.query("staged") ?? "").toLowerCase();
    const staged = stagedParam === "1" || stagedParam === "true";
    try {
      const root = await resolveInspectorRoot(new URL(c.req.url), c.req.raw.headers);
      const { relative } = await resolveInsideRoot(c.req.query("path") ?? "", root);
      const diff = await readDiff(root, relative, staged);
      if (!diff) {
        return c.json({ error: "当前目录不是 git 仓库。", code: "not_a_repo" }, 409);
      }
      return c.json(diff);
    } catch (error) {
      return respondFailure(c, error);
    }
  });
