import { constants } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { Hono, type Context } from "hono";
import type {
  InspectorErrorBody,
  InspectorFileEntry,
  InspectorFileResponse,
  InspectorSearchEntry,
  InspectorSearchResponse,
  InspectorTreeResponse,
} from "@agent-workspace/contracts/inspector";
import {
  IGNORED_DIRECTORIES,
  InspectorPathError,
  resolveInsideRoot,
} from "./paths.ts";
import { DurableError } from "../durable/errors.ts";
import { readInspectorProjection } from "./scope.ts";

/** Maximum number of directory entries returned in one listing. */
export const DIRECTORY_ENTRY_LIMIT = 2000;
/** Maximum number of bytes read from a single file. */
export const FILE_READ_LIMIT = 256 * 1024;
/** Bytes inspected when deciding whether a file is binary. */
const BINARY_SNIFF_BYTES = 8 * 1024;
/** Maximum query length accepted by the project-wide search. */
export const SEARCH_QUERY_LIMIT = 256;
/** Maximum number of matches returned by the project-wide search. */
export const SEARCH_RESULT_LIMIT = 100;
/** Maximum number of filesystem entries visited before the search stops. */
export const SEARCH_SCAN_LIMIT = 20_000;
/** Maximum number of matches collected before ranking the best results. */
const SEARCH_MATCH_LIMIT = 500;

type InspectorErrorStatus = 400 | 403 | 404 | 415 | 500;

interface InspectorFailure {
  body: InspectorErrorBody;
  status: InspectorErrorStatus;
}

function fail(body: InspectorErrorBody, status: InspectorErrorStatus): InspectorFailure {
  return { body, status };
}

function errorOf(error: unknown, fallback: string): InspectorFailure {
  if (error instanceof InspectorPathError) {
    return fail({ error: error.message, code: "invalid_path" }, 400);
  }
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  if (code === "ENOENT" || code === "ENOTDIR") {
    return fail({ error: "路径不存在。", code: "not_found" }, 404);
  }
  if (code === "EACCES" || code === "EPERM") {
    return fail({ error: "没有访问该路径的权限。", code: "forbidden" }, 403);
  }
  return fail(
    {
      error: error instanceof Error ? error.message || fallback : fallback,
      code: "internal_error",
    },
    500,
  );
}

async function statOrNull(absolute: string) {
  try {
    return await stat(absolute);
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
}

/** True when a symlink target stays inside the project root. */
async function symlinkInsideRoot(relative: string, root: string): Promise<boolean> {
  try {
    await resolveInsideRoot(relative, root);
    return true;
  } catch (error) {
    if (error instanceof InspectorPathError) return false;
    throw error;
  }
}

/** Failure carrying an already-decided HTTP response. */
class InspectorRouteError extends Error {
  readonly failure: InspectorFailure;

  constructor(failure: InspectorFailure) {
    super(failure.body.error);
    this.name = "InspectorRouteError";
    this.failure = failure;
  }
}

async function readTree(relative: string, root: string): Promise<InspectorTreeResponse> {
  const { absolute, relative: displayRelative } = await resolveInsideRoot(relative, root);
  const directoryStat = await statOrNull(absolute);
  if (!directoryStat) {
    throw new InspectorRouteError(fail({ error: "路径不存在。", code: "not_found" }, 404));
  }
  if (!directoryStat.isDirectory()) {
    const failure = fail({ error: "该路径不是目录。", code: "not_a_directory" }, 400);
    throw new InspectorRouteError(failure);
  }

  const dirents = await readdir(absolute, { withFileTypes: true });
  const entries: InspectorFileEntry[] = [];
  for (const dirent of dirents) {
    if (IGNORED_DIRECTORIES[dirent.name]) continue;
    const childAbsolute = path.join(absolute, dirent.name);
    const childRelative = displayRelative ? `${displayRelative}/${dirent.name}` : dirent.name;
    let entry: InspectorFileEntry | null = null;

    if (dirent.isDirectory()) {
      entry = { name: dirent.name, path: childRelative, kind: "directory", size: null };
    } else if (dirent.isFile()) {
      const childStat = await statOrNull(childAbsolute);
      if (childStat?.isFile()) {
        entry = { name: dirent.name, path: childRelative, kind: "file", size: childStat.size };
      }
    } else if (dirent.isSymbolicLink()) {
      // Symlinks are shown only when they resolve inside the root.
      if (!(await symlinkInsideRoot(childRelative, root))) continue;
      const childStat = await statOrNull(childAbsolute);
      if (childStat?.isDirectory()) {
        entry = { name: dirent.name, path: childRelative, kind: "directory", size: null };
      } else if (childStat?.isFile()) {
        entry = { name: dirent.name, path: childRelative, kind: "file", size: childStat.size };
      }
    }

    if (entry) entries.push(entry);
  }

  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const truncated = entries.length > DIRECTORY_ENTRY_LIMIT;
  if (truncated) entries.length = DIRECTORY_ENTRY_LIMIT;
  const finalDirectory = await stat(absolute);
  await resolveInsideRoot(relative, root);
  if (directoryStat.dev !== finalDirectory.dev || directoryStat.ino !== finalDirectory.ino || directoryStat.birthtimeMs !== finalDirectory.birthtimeMs)
    throw new DurableError(409, "inspector_path_changed", "Directory identity changed during inspection.");

  return { root, path: displayRelative, entries, truncated };
}

export async function readFile(relative: string, root: string): Promise<InspectorFileResponse> {
  const { absolute, relative: displayRelative } = await resolveInsideRoot(relative, root);
  const canonical = await realpath(absolute);
  const canonicalRelative = path.relative(root, canonical);
  if (canonicalRelative === ".." || canonicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(canonicalRelative))
    throw new InspectorPathError("路径不能通过符号链接超出项目根目录。");
  const expected = await stat(canonical);
  if (!expected.isFile())
    throw new InspectorRouteError(fail({ error: "该路径不是普通文件。", code: "not_a_file" }, 400));
  const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino || opened.birthtimeMs !== expected.birthtimeMs || opened.size !== expected.size)
      throw new DurableError(409, "inspector_path_changed", "File identity changed before it could be read.");
    const buffer = Buffer.alloc(Math.min(opened.size, FILE_READ_LIMIT));
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    const final = await handle.stat(), visible = await stat(canonical);
    await resolveInsideRoot(relative, root);
    if (offset !== buffer.length || final.size !== opened.size || final.mtimeMs !== opened.mtimeMs ||
        visible.dev !== opened.dev || visible.ino !== opened.ino || visible.birthtimeMs !== opened.birthtimeMs ||
        await realpath(absolute) !== canonical)
      throw new DurableError(409, "inspector_path_changed", "File path or content changed during inspection.");
    if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0))
      throw new InspectorRouteError(fail({ error: "不支持二进制文件。", code: "binary_file" }, 415));
    return { path: displayRelative, size: opened.size, content: buffer.toString("utf8"), truncated: opened.size > FILE_READ_LIMIT };
  } finally { await handle.close(); }
}

function searchRank(entry: InspectorSearchEntry, needle: string): number {
  const name = entry.name.toLowerCase();
  if (name === needle) return 0;
  if (name.startsWith(needle)) return 1;
  if (name.includes(needle)) return 2;
  return 3;
}

/**
 * Walk the project once and return files whose relative path contains the
 * query. Ignored directories are skipped, symlinks are never followed, and
 * both visited entries and matches are bounded so a large repository cannot
 * block the inspector.
 */
async function searchFiles(query: string, root: string): Promise<InspectorSearchResponse> {
  const trimmed = query.trim();
  const needle = trimmed.toLowerCase();
  if (!needle) return { query: "", entries: [], truncated: false };

  const matches: InspectorSearchEntry[] = [];
  const directories: string[] = [""];
  let visited = 0;
  let truncated = false;

  while (directories.length > 0) {
    const relative = directories.pop()!;
    let dirents;
    const resolved = await resolveInsideRoot(relative, root);
    const before = await stat(resolved.absolute);
    try {
      dirents = await readdir(resolved.absolute, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    await resolveInsideRoot(relative, root);
    const after = await stat(resolved.absolute);
    if (before.dev !== after.dev || before.ino !== after.ino || before.birthtimeMs !== after.birthtimeMs)
      throw new DurableError(409, "inspector_path_changed", "Search directory identity changed during inspection.");
    dirents.sort((left, right) => left.name.localeCompare(right.name));

    for (const dirent of dirents) {
      visited += 1;
      if (visited > SEARCH_SCAN_LIMIT) {
        truncated = true;
        break;
      }
      if (IGNORED_DIRECTORIES[dirent.name]) continue;
      const childRelative = relative ? `${relative}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) {
        directories.push(childRelative);
        continue;
      }
      // Symbolic links are excluded from search: their targets are not
      // guaranteed to stay inside the project root.
      if (!dirent.isFile()) continue;
      if (!childRelative.toLowerCase().includes(needle)) continue;
      matches.push({ name: dirent.name, path: childRelative });
      if (matches.length >= SEARCH_MATCH_LIMIT) {
        truncated = true;
        break;
      }
    }
    if (truncated) break;
  }

  matches.sort(
    (left, right) =>
      searchRank(left, needle) - searchRank(right, needle) ||
      left.path.length - right.path.length ||
      left.path.localeCompare(right.path),
  );
  const entries = matches.slice(0, SEARCH_RESULT_LIMIT);
  return { query: trimmed, entries, truncated: truncated || matches.length > entries.length };
}

function respondFailure(c: Context, error: unknown): Response {
  if (error instanceof DurableError)
    return c.json({ error: error.message, code: error.code }, error.status);
  if (error instanceof InspectorRouteError) {
    return c.json(error.failure.body, error.failure.status);
  }
  const failure = errorOf(error, "读取路径失败。");
  return c.json(failure.body, failure.status);
}

export const filesRoutes = new Hono()
  .get("/files", async (c) => {
    try {
      const tree = await readInspectorProjection(new URL(c.req.url), c.req.raw.headers,
        root => readTree(c.req.query("path") ?? "", root));
      return c.json(tree);
    } catch (error) {
      return respondFailure(c, error);
    }
  })
  .get("/file", async (c) => {
    try {
      const file = await readInspectorProjection(new URL(c.req.url), c.req.raw.headers,
        root => readFile(c.req.query("path") ?? "", root));
      return c.json(file);
    } catch (error) {
      return respondFailure(c, error);
    }
  })
  .get("/search", async (c) => {
    const query = (c.req.query("q") ?? "").trim();
    if (!query) {
      return c.json({ error: "搜索内容不能为空。", code: "invalid_query" }, 400);
    }
    if (query.length > SEARCH_QUERY_LIMIT) {
      return c.json(
        { error: `搜索内容不能超过 ${SEARCH_QUERY_LIMIT} 个字符。`, code: "invalid_query" },
        400,
      );
    }
    try {
      const result = await readInspectorProjection(new URL(c.req.url), c.req.raw.headers, root => searchFiles(query, root));
      return c.json(result);
    } catch (error) {
      return respondFailure(c, error);
    }
  });
