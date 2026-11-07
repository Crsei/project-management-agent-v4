/** Translated from vendor/cc-switch/src-tauri/src/services/skill.rs (hash helpers). */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync, statSync } from "node:fs";
import path from "node:path";
import { ioError } from "../errors.ts";
import { pathExists } from "./fs.ts";
import { validateSkillDirectory } from "./paths.ts";

function toPosix(value: string): string {
  return value.replace(/\\/g, "/");
}

function compareBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function collectFilesForHash(current: string, files: string[]): void {
  let entries;
  try {
    entries = readdirSync(current);
  } catch (error) {
    throw ioError(current, error);
  }

  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const target = path.join(current, name);
    let metadata;
    try {
      // `Path::is_dir` follows symlinks; a linked directory is traversed.
      metadata = statSync(target);
    } catch (error) {
      throw ioError(target, error);
    }
    if (metadata.isDirectory()) collectFilesForHash(target, files);
    else files.push(target);
  }
}

/** SHA-256 over `relative-path\0content\0` for every non-hidden file, sorted by path. */
export function computeDirHash(dir: string): string {
  const files: string[] = [];
  collectFilesForHash(dir, files);
  files.sort(compareBytes);

  const hasher = createHash("sha256");
  for (const file of files) {
    const relative = path.relative(dir, file);
    hasher.update(Buffer.from(toPosix(relative), "utf8"));
    hasher.update(Buffer.from([0]));
    try {
      hasher.update(readFileSync(file));
    } catch (error) {
      throw ioError(file, error);
    }
    hasher.update(Buffer.from([0]));
  }
  return hasher.digest("hex");
}

function collectTreeEntries(current: string, entries: string[]): void {
  let names;
  try {
    names = readdirSync(current);
  } catch (error) {
    throw ioError(current, error);
  }

  for (const name of names) {
    const target = path.join(current, name);
    entries.push(target);
    let metadata;
    try {
      metadata = lstatSync(target);
    } catch (error) {
      throw ioError(target, error);
    }
    if (metadata.isDirectory()) collectTreeEntries(target, entries);
  }
}

/**
 * Full-tree deployment hash used by Pi-style copy checks: hidden files, empty
 * directories and file-type changes all count as native modifications.
 */
export function computePiDeploymentHash(dir: string): string {
  const entries: string[] = [];
  collectTreeEntries(dir, entries);
  entries.sort(compareBytes);

  const hasher = createHash("sha256");
  for (const entry of entries) {
    hasher.update(Buffer.from(toPosix(path.relative(dir, entry)), "utf8"));
    hasher.update(Buffer.from([0]));

    let metadata;
    try {
      metadata = lstatSync(entry);
    } catch (error) {
      throw ioError(entry, error);
    }

    if (metadata.isSymbolicLink()) {
      hasher.update(Buffer.from("link\0", "utf8"));
      hasher.update(Buffer.from(readlinkSync(entry), "utf8"));
    } else if (metadata.isDirectory()) {
      hasher.update(Buffer.from("dir\0", "utf8"));
    } else if (metadata.isFile()) {
      hasher.update(Buffer.from("file\0", "utf8"));
      try {
        hasher.update(readFileSync(entry));
      } catch (error) {
        throw ioError(entry, error);
      }
    } else {
      hasher.update(Buffer.from("other\0", "utf8"));
    }
    hasher.update(Buffer.from([0]));
  }
  return hasher.digest("hex");
}

/**
 * Local hash used by update checks. A missing SSOT directory wins over the cached
 * hash so restored databases cannot mask a vanished skill; an invalid directory
 * falls back to the cache (never reports an update the updater would refuse).
 */
export function localHashForUpdateCheck(
  ssot: string,
  rawDirectory: string,
  cachedHash?: string,
): { hash: string; fresh: boolean } | undefined {
  let directory: string;
  try {
    directory = validateSkillDirectory(rawDirectory);
  } catch {
    return cachedHash === undefined ? undefined : { hash: cachedHash, fresh: false };
  }

  if (!pathExists(path.join(ssot, directory))) return undefined;
  if (cachedHash !== undefined) return { hash: cachedHash, fresh: false };

  try {
    return { hash: computeDirHash(path.join(ssot, directory)), fresh: true };
  } catch {
    return undefined;
  }
}
