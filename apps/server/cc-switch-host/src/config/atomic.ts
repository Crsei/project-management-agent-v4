/** Translated from vendor/cc-switch/src-tauri/src/config.rs. */
import { chmodSync, constants, closeSync, copyFileSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import path from "node:path";
import { AppError, ioError } from "../errors.ts";

export function readTextFile(filename: string): string | undefined {
  try { return readFileSync(filename, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw ioError(filename, error);
  }
}

export function readJsonFile<T>(filename: string): T {
  const text = readTextFile(filename);
  if (text === undefined) throw new AppError("CONFIG", `Missing file: ${filename}`);
  try { return JSON.parse(text) as T; } catch { throw new AppError("CONFIG", `Invalid JSON: ${filename}`); }
}

export function sortJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      result[key] = sortJsonKeys((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}

export function writeJsonFile(filename: string, value: unknown, privateMode = false): void {
  atomicWrite(filename, Buffer.from(JSON.stringify(sortJsonKeys(value), null, 2)), privateMode ? 0o600 : 0o644);
}

export function writeTextFile(filename: string, value: string, privateMode = false): void {
  atomicWrite(filename, Buffer.from(value, "utf8"), privateMode ? 0o600 : 0o644);
}

export function atomicWrite(filename: string, bytes: Buffer, mode = 0o600): void {
  const directory = path.dirname(filename);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(filename)}.${process.pid}.${Date.now()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    writeSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, filename);
    try { chmodSync(filename, mode); } catch { /* mode already applied */ }
  } catch (error) {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } }
    try { rmSync(temporary, { force: true }); } catch { /* preserve original error */ }
    throw ioError(filename, error);
  }
}

export function stageWrite(filename: string, bytes: Buffer, mode = 0o600): string {
  const directory = path.dirname(filename);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(filename)}.${process.pid}.${Date.now()}.stage`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try { writeSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  return temporary;
}

export function commitStaged(temporary: string, filename: string): void {
  renameSync(temporary, filename);
}

export function copyFilePreservingMode(source: string, destination: string): void {
  copyFileSync(source, destination);
  try { chmodSync(destination, statSync(source).mode & 0o777); } catch { /* best effort */ }
}
