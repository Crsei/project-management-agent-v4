import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { Hono, type Context } from "hono";
import type {
  InspectorErrorBody,
  InspectorFileEntry,
  InspectorFileResponse,
  InspectorTreeResponse,
} from "@agent-workspace/contracts/inspector";
import {
  IGNORED_DIRECTORIES,
  InspectorPathError,
  resolveInsideRoot,
} from "./paths.ts";
import { DurableError } from "../durable/errors.ts";
import { resolveInspectorRoot } from "./scope.ts";

/** Maximum number of directory entries returned in one listing. */
export const DIRECTORY_ENTRY_LIMIT = 2000;
/** Maximum number of bytes read from a single file. */
export const FILE_READ_LIMIT = 256 * 1024;
/** Bytes inspected when deciding whether a file is binary. */
const BINARY_SNIFF_BYTES = 8 * 1024;

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
  } catch {
    return null;
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

  return { root, path: displayRelative, entries, truncated };
}

async function readFile(relative: string, root: string): Promise<InspectorFileResponse> {
  const { absolute, relative: displayRelative } = await resolveInsideRoot(relative, root);
  const fileStat = await statOrNull(absolute);
  if (!fileStat)
    throw new InspectorRouteError(fail({ error: "路径不存在。", code: "not_found" }, 404));
  if (fileStat.isDirectory()) {
    throw new InspectorRouteError(fail({ error: "该路径不是文件。", code: "not_a_file" }, 400));
  }
  if (!fileStat.isFile()) {
    throw new InspectorRouteError(fail({ error: "该路径不是普通文件。", code: "not_a_file" }, 400));
  }

  const length = Math.min(fileStat.size, FILE_READ_LIMIT);
  const buffer = Buffer.alloc(length);
  const handle = await open(absolute, "r");
  try {
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset < length) buffer.fill(0, offset);
  } finally {
    await handle.close();
  }

  if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
    throw new InspectorRouteError(fail({ error: "不支持二进制文件。", code: "binary_file" }, 415));
  }

  return {
    path: displayRelative,
    size: fileStat.size,
    content: buffer.toString("utf8"),
    truncated: fileStat.size > FILE_READ_LIMIT,
  };
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
      const root = await resolveInspectorRoot(new URL(c.req.url), c.req.raw.headers);
      const tree = await readTree(c.req.query("path") ?? "", root);
      return c.json(tree);
    } catch (error) {
      return respondFailure(c, error);
    }
  })
  .get("/file", async (c) => {
    try {
      const root = await resolveInspectorRoot(new URL(c.req.url), c.req.raw.headers);
      const file = await readFile(c.req.query("path") ?? "", root);
      return c.json(file);
    } catch (error) {
      return respondFailure(c, error);
    }
  });
