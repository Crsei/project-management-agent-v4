/** Translated from vendor/cc-switch/src-tauri/src/services/skill.rs (file sync helpers) and config.rs (atomic writes). */
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  mkdtempSync, openSync, readdirSync, readlinkSync, readSync, realpathSync, renameSync,
  rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeSync, type BigIntStats,
} from "node:fs";
import path from "node:path";
import { makePrivatePath } from "../../../../../packages/pm-core/private-path.ts";
import { assertNoWindowsReparsePath, cacheWindowsPathAttributes } from "../../../../../packages/pm-core/windows-reparse.ts";
import { copyFilePreservingMode, writeJsonFile, writeTextFile } from "../config/atomic.ts";
import { AppError, ioError } from "../errors.ts";

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

interface ImportEntry {
  source: string;
  relative: string;
  metadata: BigIntStats;
}

export interface SkillImportTree {
  readonly root: string;
  assertUnchanged(): void;
  copyTo(destination: string): void;
}

function importChanged(): AppError {
  return new AppError("INVALID_INPUT", "Skill import source changed or crosses an unsafe filesystem boundary");
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.birthtimeNs === right.birthtimeNs;
}

function sameImportEntry(left: BigIntStats, right: BigIntStats): boolean {
  return sameIdentity(left, right) && (left.isDirectory()
    || (left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs));
}

/**
 * Native import is a trust boundary, unlike the upstream deployment copy helper.
 * Pin the explicitly selected root (which may be an authorized alias), resolve
 * every descendant, and reject escapes/cycles before creating managed content.
 * Known internal links are materialized; unknown Windows reparse points fail closed.
 */
export function inspectSkillImportTree(source: string, storageRoot?: string): SkillImportTree {
  const watched = new Map<string, BigIntStats>();
  const listings = new Map<string, string[]>();
  const entries: ImportEntry[] = [];
  const remember = (filename: string): BigIntStats => {
    const metadata = lstatSync(filename, { bigint: true });
    if (!metadata.isSymbolicLink()) assertNoWindowsReparsePath(filename, metadata);
    const previous = watched.get(filename);
    if (previous && !sameImportEntry(previous, metadata)) throw importChanged();
    watched.set(filename, metadata);
    return metadata;
  };

  // Walk link targets component by component. realpath alone would hide an
  // intermediate unknown reparse point; normalizing ".." before links is wrong.
  const resolve = (filename: string): string => {
    if (!path.isAbsolute(filename)) throw importChanged();
    let current = path.parse(filename).root;
    let pending = filename.slice(current.length).split(path.sep);
    let links = 0;
    remember(current);
    while (pending.length > 0) {
      const name = pending.shift()!;
      if (name === "" || name === ".") continue;
      if (name === "..") { current = path.dirname(current); continue; }
      const next = path.join(current, name);
      const metadata = remember(next);
      if (metadata.isSymbolicLink()) {
        if (++links > 40) throw importChanged();
        const target = readlinkSync(next);
        if (path.isAbsolute(target)) {
          current = path.parse(target).root;
          remember(current);
          pending = [...target.slice(current.length).split(path.sep), ...pending];
        } else {
          pending = [...target.split(path.sep), ...pending];
        }
      } else {
        if (pending.length > 0 && !metadata.isDirectory()) throw importChanged();
        current = next;
      }
    }
    return realpathSync(current);
  };

  const root = resolve(source);
  const rootMetadata = remember(root);
  if (!rootMetadata.isDirectory()) throw importChanged();
  const within = (parent: string, metadata: BigIntStats, filename: string): boolean => {
    if (filename === parent || filename.startsWith(parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`)) return true;
    // Canonical namespace/casing aliases need filesystem identity, not lowercasing:
    // Windows supports case-sensitive directories.
    let ancestor = filename;
    for (;;) {
      if (sameIdentity(remember(ancestor), metadata)) return true;
      const next = path.dirname(ancestor);
      if (next === ancestor) return false;
      ancestor = next;
    }
  };
  if (storageRoot !== undefined) {
    const storage = resolve(storageRoot);
    if (!within(storage, remember(storage), root)) throw importChanged();
  }

  const visit = (filename: string, relative: string, ancestors: Set<string>): void => {
    const canonical = resolve(filename);
    if (!within(root, rootMetadata, canonical)) throw importChanged();
    const metadata = remember(canonical);
    if (!metadata.isDirectory() && !metadata.isFile()) throw importChanged();
    entries.push({ source: canonical, relative, metadata });
    if (!metadata.isDirectory()) return;
    const identity = `${metadata.dev}:${metadata.ino}`;
    if (ancestors.has(identity)) throw importChanged();
    ancestors.add(identity);
    const names = readdirSync(canonical).sort();
    listings.set(canonical, names);
    cacheWindowsPathAttributes(names.map(name => path.join(canonical, name)));
    for (const name of names) visit(path.join(canonical, name), path.join(relative, name), ancestors);
    ancestors.delete(identity);
  };
  visit(root, "", new Set());

  const assertUnchanged = (): void => {
    if (resolve(source) !== root) throw importChanged();
    for (const [filename, metadata] of watched) {
      if (!sameImportEntry(metadata, remember(filename))) throw importChanged();
    }
    for (const [directory, names] of listings) {
      const current = readdirSync(directory).sort();
      if (current.length !== names.length || current.some((name, index) => name !== names[index])) throw importChanged();
    }
  };

  return {
    root,
    assertUnchanged,
    copyTo(destination): void {
      assertUnchanged();
      const parent = resolve(path.dirname(destination));
      const target = path.join(parent, path.basename(destination));
      if (pathEntryExists(target)) throw importChanged();
      const temporary = mkdtempSync(path.join(parent, ".skill-import-"));
      try {
        makePrivatePath(temporary);
        const buffer = Buffer.allocUnsafe(64 * 1024);
        for (const entry of entries) {
          const output = path.join(temporary, entry.relative);
          if (entry.metadata.isDirectory()) {
            if (entry.relative !== "") mkdirSync(output);
            continue;
          }
          let inputFd: number | undefined;
          let outputFd: number | undefined;
          try {
            inputFd = openSync(entry.source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            if (!sameImportEntry(entry.metadata, fstatSync(inputFd, { bigint: true }))) throw importChanged();
            outputFd = openSync(output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
            if (entry.metadata.size > BigInt(Number.MAX_SAFE_INTEGER)) throw importChanged();
            const size = Number(entry.metadata.size);
            let offset = 0;
            while (offset < size) {
              const count = readSync(inputFd, buffer, 0, Math.min(buffer.length, size - offset), offset);
              if (count === 0) throw importChanged();
              let written = 0;
              while (written < count) written += writeSync(outputFd, buffer, written, count - written);
              offset += count;
            }
            if (!sameImportEntry(entry.metadata, fstatSync(inputFd, { bigint: true }))) throw importChanged();
            fchmodSync(outputFd, Number(entry.metadata.mode & 0o777n));
            fsyncSync(outputFd);
          } finally {
            if (outputFd !== undefined) closeSync(outputFd);
            if (inputFd !== undefined) closeSync(inputFd);
          }
        }
        assertUnchanged();
        if (pathEntryExists(target)) throw importChanged();
        renameSync(temporary, target);
      } catch (error) {
        try { rmSync(temporary, { recursive: true, force: true }); } catch { /* preserve original failure */ }
        throw error;
      }
    },
  };
}

/** Atomic text write with the shared temporary-file + fsync + rename contract. */
export function writeTextFileAtomic(filename: string, text: string, privateMode = false): void {
  writeTextFile(filename, text, privateMode);
}

/** Atomic pretty JSON write with the shared key-sorting contract. */
export function writeJsonFileAtomic(filename: string, value: unknown, privateMode = false): void {
  writeJsonFile(filename, value, privateMode);
}
