/** Translated from vendor/cc-switch/src-tauri/src/services/skill.rs (archive budgets, ZIP extraction, symlink materialization). */
import {
  closeSync, createReadStream, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync,
  realpathSync, rmSync, statSync, writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { openPromise } from "yauzl";
import type { Entry, ZipFile } from "yauzl";
import {
  DIRECTORY_BUDGET_COST, FILE_ENTRY_BUDGET_COST, MAX_ARCHIVE_ENTRIES, MAX_ARCHIVE_TOTAL_BYTES,
  MAX_SYMLINK_TARGET_BYTES,
} from "../constants.ts";
import { AppError } from "../errors.ts";
import { skillError } from "./network.ts";

/**
 * Shared accounting for everything an archive may consume on disk. Content
 * bytes alone are not enough: empty directories and symlink materialization
 * cost inodes even when they write nothing.
 */
export interface ArchiveBudget {
  total: number;
}

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const MAX_ARCHIVE_LIMIT_MB = String(MAX_ARCHIVE_TOTAL_BYTES / 1024 / 1024);

export function chargeArchiveBudget(budget: ArchiveBudget, amount: number): void {
  if (budget.total + amount > MAX_ARCHIVE_TOTAL_BYTES) {
    throw skillError("ARCHIVE_TOO_LARGE", { limit_mb: MAX_ARCHIVE_LIMIT_MB }, "checkZipContent");
  }
  budget.total += amount;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw skillError("DOWNLOAD_TIMEOUT", { timeout: "60" }, "checkNetwork");
  }
}

async function openArchive(archivePath: string, description: string): Promise<ZipFile> {
  try {
    return await openPromise(archivePath, {
      lazyEntries: true,
      autoClose: false,
      decodeStrings: true,
      validateEntrySizes: true,
    });
  } catch (error) {
    throw new AppError("CONFIG", `Failed to read ZIP file: ${description}: ${String(error)}`);
  }
}

function assertArchiveEntryCount(count: number): void {
  if (count > MAX_ARCHIVE_ENTRIES) {
    throw skillError(
      "ARCHIVE_TOO_MANY_ENTRIES",
      { count: String(count), limit: String(MAX_ARCHIVE_ENTRIES) },
      "checkZipContent",
    );
  }
}

/**
 * Normalize one archive entry into a safe relative path.
 * Absolute paths, drive prefixes, NUL bytes and any `..` component are
 * rejected; both separators are treated as separators so Windows extraction
 * semantics cannot be used to escape.
 */
function normalizeEntryPath(fileName: string): string | undefined {
  const normalized = fileName.replaceAll("\\", "/");
  if (normalized.length === 0 || normalized.includes("\0")) return undefined;
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) return undefined;
  const segments = normalized.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.some((segment) => segment === "..")) return undefined;
  return segments.join("/");
}

/**
 * Strip GitHub's `<repo>-<branch>/` wrapper directory. Rust strips the first
 * path component taken from the archive's first entry, so entries outside that
 * root are ignored rather than extracted.
 */
function stripArchiveRoot(relativePath: string, rootName: string): string | undefined {
  if (rootName.length === 0) return undefined;
  if (relativePath === rootName) return undefined;
  const prefix = `${rootName}/`;
  if (!relativePath.startsWith(prefix)) return undefined;
  return relativePath.slice(prefix.length);
}

function entryMode(entry: Entry): number {
  return (entry.externalFileAttributes >>> 16) & 0o170000;
}

function entryIsSymlink(entry: Entry): boolean {
  return entryMode(entry) === 0o120000;
}

function entryIsDirectory(entry: Entry): boolean {
  return entry.fileName.replaceAll("\\", "/").endsWith("/") || entryMode(entry) === 0o040000;
}

/** Create every missing ancestor, charging one block per directory actually created. */
function createDirAllWithinBudget(directory: string, budget: ArchiveBudget): void {
  let missing = 0;
  let current = directory;
  while (!existsSync(current)) {
    missing += 1;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (missing > 0) chargeArchiveBudget(budget, missing * DIRECTORY_BUDGET_COST);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
}

/** Write one stream to disk, charging actual bytes and at least one block per file. */
async function writeFileWithinBudget(stream: Readable, destination: string, budget: ArchiveBudget): Promise<void> {
  const descriptor = openSync(destination, "w", 0o600);
  const before = budget.total;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk as Buffer);
      chargeArchiveBudget(budget, bytes.length);
      writeSync(descriptor, bytes);
    }
  } finally {
    closeSync(descriptor);
  }
  const written = budget.total - before;
  if (written < FILE_ENTRY_BUDGET_COST) {
    chargeArchiveBudget(budget, FILE_ENTRY_BUDGET_COST - written);
  }
}

/**
 * Read a symlink target from its decompressed entry stream. Oversized or
 * non-UTF-8 targets are skipped: neither shape can be a real path, and an
 * unbounded read would be a memory bomb.
 */
async function readSymlinkTarget(stream: Readable, budget: ArchiveBudget): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk as Buffer);
    length += bytes.length;
    if (length > MAX_SYMLINK_TARGET_BYTES) return undefined;
    chunks.push(bytes);
  }
  chargeArchiveBudget(budget, length);
  try {
    return UTF8_DECODER.decode(Buffer.concat(chunks)).trim();
  } catch {
    return undefined;
  }
}

function isWithin(base: string, candidate: string): boolean {
  return candidate === base || candidate.startsWith(`${base}${path.sep}`);
}

/** Copy a directory tree while charging every file and directory it materializes. */
async function copyDirWithinBudget(source: string, destination: string, budget: ArchiveBudget): Promise<void> {
  createDirAllWithinBudget(destination, budget);
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyDirWithinBudget(sourcePath, destinationPath, budget);
    } else {
      await writeFileWithinBudget(createReadStream(sourcePath), destinationPath, budget);
    }
  }
}

async function copyFileWithinBudget(source: string, destination: string, budget: ArchiveBudget): Promise<void> {
  await writeFileWithinBudget(createReadStream(source), destination, budget);
}

/**
 * Materialize deferred symlink entries by copying the target's content into
 * the link position. Targets outside the archive root and targets that contain
 * their own link are skipped; copying the latter would recurse until PATH_MAX.
 */
async function resolveArchiveSymlinks(
  baseDirectory: string,
  symlinks: Array<{ linkPath: string; target: string }>,
  budget: ArchiveBudget,
): Promise<void> {
  let canonicalBase: string;
  try {
    canonicalBase = realpathSync(baseDirectory);
  } catch {
    canonicalBase = baseDirectory;
  }

  for (const { linkPath, target } of symlinks) {
    const parent = path.dirname(linkPath);
    let resolved: string;
    try {
      resolved = realpathSync(path.resolve(parent, target));
    } catch {
      // Target does not exist inside the archive: nothing to materialize.
      continue;
    }
    if (!isWithin(canonicalBase, resolved)) continue;

    let canonicalLink: string;
    try {
      canonicalLink = path.join(realpathSync(parent), path.basename(linkPath));
    } catch {
      const relative = path.relative(baseDirectory, linkPath);
      canonicalLink = relative.startsWith("..") ? linkPath : path.join(canonicalBase, relative);
    }
    if (isWithin(resolved, canonicalLink)) continue;

    const targetStat = statSync(resolved);
    if (targetStat.isDirectory()) {
      await copyDirWithinBudget(resolved, linkPath, budget);
    } else if (targetStat.isFile()) {
      createDirAllWithinBudget(parent, budget);
      await copyFileWithinBudget(resolved, linkPath, budget);
    }
  }
}

interface DeferredSymlink {
  linkPath: string;
  target: string;
}

async function materializeEntry(
  zipfile: ZipFile,
  entry: Entry,
  outputPath: string,
  budget: ArchiveBudget,
  symlinks: DeferredSymlink[],
): Promise<void> {
  if (entryIsSymlink(entry)) {
    const stream = await zipfile.openReadStreamPromise(entry);
    const target = await readSymlinkTarget(stream, budget);
    stream.destroy();
    if (target !== undefined && target.length > 0) symlinks.push({ linkPath: outputPath, target });
    return;
  }
  if (entryIsDirectory(entry)) {
    createDirAllWithinBudget(outputPath, budget);
    return;
  }
  createDirAllWithinBudget(path.dirname(outputPath), budget);
  const stream = await zipfile.openReadStreamPromise(entry);
  try {
    await writeFileWithinBudget(stream, outputPath, budget);
  } finally {
    stream.destroy();
  }
}

/** Extract a GitHub repository archive, dropping its wrapper directory. */
export async function extractRepoArchive(
  archivePath: string,
  destination: string,
  signal?: AbortSignal,
): Promise<void> {
  const zipfile = await openArchive(archivePath, archivePath);
  try {
    if (zipfile.entryCount === 0) throw skillError("EMPTY_ARCHIVE", {}, "checkRepoUrl");
    assertArchiveEntryCount(zipfile.entryCount);
    mkdirSync(destination, { recursive: true, mode: 0o700 });

    const budget: ArchiveBudget = { total: 0 };
    const symlinks: DeferredSymlink[] = [];
    let rootName: string | undefined;

    for await (const entry of zipfile.eachEntry()) {
      throwIfAborted(signal);
      if (rootName === undefined) rootName = entry.fileName.split("/")[0] ?? "";
      const relative = normalizeEntryPath(entry.fileName);
      if (relative === undefined) continue;
      const stripped = stripArchiveRoot(relative, rootName);
      if (stripped === undefined || stripped.length === 0) continue;
      await materializeEntry(zipfile, entry, path.join(destination, stripped), budget, symlinks);
    }

    throwIfAborted(signal);
    await resolveArchiveSymlinks(destination, symlinks, budget);
  } finally {
    zipfile.close();
  }
}

export interface ExtractedWorkspace {
  dir: string;
  dispose(): void;
}

/**
 * Extract a user-provided ZIP into a private temporary directory using the
 * same entry, size, traversal and symlink limits as remote archives.
 * The returned workspace owns the tree until the caller disposes it.
 */
export async function extractLocalZip(zipPath: string, baseDirectory: string = tmpdir()): Promise<ExtractedWorkspace> {
  if (!existsSync(zipPath)) {
    throw new AppError("CONFIG", `Failed to open ZIP file: ${zipPath}`);
  }
  const zipfile = await openArchive(zipPath, zipPath);
  let directory: string | undefined;
  try {
    if (zipfile.entryCount === 0) throw skillError("EMPTY_ARCHIVE", {}, "checkZipContent");
    assertArchiveEntryCount(zipfile.entryCount);
    directory = mkdtempSync(path.join(baseDirectory, ".skill-zip-"));

    const budget: ArchiveBudget = { total: 0 };
    const symlinks: DeferredSymlink[] = [];
    for await (const entry of zipfile.eachEntry()) {
      const relative = normalizeEntryPath(entry.fileName);
      if (relative === undefined || relative.length === 0) continue;
      await materializeEntry(zipfile, entry, path.join(directory, relative), budget, symlinks);
    }
    await resolveArchiveSymlinks(directory, symlinks, budget);

    const owned = directory;
    return {
      dir: owned,
      dispose(): void {
        rmSync(owned, { recursive: true, force: true, maxRetries: 3 });
      },
    };
  } catch (error) {
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
    throw error;
  } finally {
    zipfile.close();
  }
}
