import { realpath } from "node:fs/promises";
import path from "node:path";

/** Directories that never appear in the inspector tree. */
export const IGNORED_DIRECTORIES: Record<string, true> = {
  ".git": true,
  ".pm": true,
  node_modules: true,
  dist: true,
  ".vite-cache": true,
  coverage: true,
  ".next": true,
  ".turbo": true,
  ".cache": true,
};

export class InspectorPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InspectorPathError";
  }
}

/**
 * Resolve a user-supplied POSIX-style path against the project root and reject
 * absolute paths, traversal and symlinks that escape the root. Returns the
 * lexical path even when it does not exist; callers decide how to handle ENOENT.
 */
export async function resolveInsideRoot(
  relative: string,
  root: string,
): Promise<{ absolute: string; relative: string }> {
  if (typeof relative !== "string") throw new InspectorPathError("路径必须是字符串。");
  if (relative.includes("\0")) throw new InspectorPathError("路径包含非法字符。");
  const normalizedInput = relative.replaceAll("\\", "/").replace(/^\/+/, "");
  if (path.isAbsolute(relative)) throw new InspectorPathError("路径必须相对于项目根目录。");
  const absolute = path.resolve(root, normalizedInput);
  const lexicalRelative = path.relative(root, absolute);
  if (lexicalRelative === ".." || lexicalRelative.startsWith(`..${path.sep}`)) {
    throw new InspectorPathError("路径不能超出项目根目录。");
  }
  const display = lexicalRelative.split(path.sep).join("/");

  // Check the nearest existing ancestor too: deleted Git paths may sit below
  // a symlink whose target escapes the root.
  const realRoot = await realpath(root);
  let candidate = absolute;
  while (true) {
    try {
      const realTarget = await realpath(candidate);
      const realRelative = path.relative(realRoot, realTarget);
      if (realRelative === ".." || realRelative.startsWith(`..${path.sep}`))
        throw new InspectorPathError("路径不能通过符号链接超出项目根目录。");
      break;
    } catch (error) {
      if (error instanceof InspectorPathError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== "ENOENT" && code !== "ENOTDIR") || candidate === root) throw error;
      candidate = path.dirname(candidate);
    }
  }

  return { absolute, relative: display };
}
