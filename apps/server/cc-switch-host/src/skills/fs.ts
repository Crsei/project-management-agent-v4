/** Translated from vendor/cc-switch/src-tauri/src/services/skill.rs (file sync helpers) and config.rs (atomic writes). */
import { lstatSync, mkdirSync, readdirSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import path from "node:path";
import { copyFilePreservingMode, writeJsonFile, writeTextFile } from "../config/atomic.ts";
import { ioError } from "../errors.ts";

export function isSymlink(target: string): boolean {
  try {
    return lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

/** `Path::exists`: follows symlinks, so a dangling link is false. */
export function pathExists(target: string): boolean {
  try {
    statSync(target);
    return true;
  } catch {
    return false;
  }
}

/** `exists() || is_symlink()`: true for dangling links the caller must still remove. */
export function pathEntryExists(target: string): boolean {
  return isSymlink(target) || pathExists(target);
}

export function ensureDir(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
}

/** Remove a directory symlink, a real tree, or a plain file without following links. */
export function removePath(target: string): void {
  if (isSymlink(target)) {
    try {
      unlinkSync(target);
    } catch (error) {
      // Windows directory symlinks are removed with rmdir, not unlink.
      if ((error as NodeJS.ErrnoException).code === "EPERM" || (error as NodeJS.ErrnoException).code === "EISDIR") {
        try { rmdirSync(target); } catch (fallback) { throw ioError(target, fallback); }
      } else {
        throw ioError(target, error);
      }
    }
    return;
  }

  let metadata;
  try {
    metadata = statSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw ioError(target, error);
  }

  try {
    if (metadata.isDirectory()) rmSync(target, { recursive: true, force: true });
    else unlinkSync(target);
  } catch (error) {
    throw ioError(target, error);
  }
}

/** Directory symlink creation: `symlink_dir` on Windows, plain symlink elsewhere. */
export function createDirSymlink(target: string, linkPath: string): void {
  try {
    symlinkSync(target, linkPath, process.platform === "win32" ? "dir" : undefined);
  } catch (error) {
    throw ioError(linkPath, error);
  }
}

/**
 * Recursive directory copy with the same following semantics as `fs::copy`:
 * symlinked files are copied by content and symlinked directories are traversed.
 */
export function copyDirRecursive(source: string, destination: string): void {
  try {
    mkdirSync(destination, { recursive: true });
  } catch (error) {
    throw ioError(destination, error);
  }

  let entries;
  try {
    entries = readdirSync(source);
  } catch (error) {
    throw ioError(source, error);
  }

  for (const name of entries) {
    const from = path.join(source, name);
    const to = path.join(destination, name);
    let metadata;
    try {
      metadata = statSync(from);
    } catch (error) {
      throw ioError(from, error);
    }
    if (metadata.isDirectory()) {
      copyDirRecursive(from, to);
    } else {
      try {
        copyFilePreservingMode(from, to);
      } catch (error) {
        throw ioError(from, error);
      }
    }
  }
}

/** Atomic text write with the shared temporary-file + fsync + rename contract. */
export function writeTextFileAtomic(filename: string, text: string, privateMode = false): void {
  writeTextFile(filename, text, privateMode);
}

/** Atomic pretty JSON write with the shared key-sorting contract. */
export function writeJsonFileAtomic(filename: string, value: unknown, privateMode = false): void {
  writeJsonFile(filename, value, privateMode);
}
