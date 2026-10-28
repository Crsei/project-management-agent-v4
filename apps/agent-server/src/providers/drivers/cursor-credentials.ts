// Credential schema and private-store semantics ported from t3code provider-cursor
// src/server/credentialStore.ts and auth.ts (MIT).
import {
  chmodSync, closeSync, constants, mkdirSync, openSync, readFileSync,
  realpathSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { StoredSdkCredentials } from "@cursor/sdk";

export function cursorCredentialPath(homeDirectory: string): string {
  return path.join(homeDirectory, ".cursor", "sdk", "auth.json");
}

export function parseCursorCredentials(value: unknown): StoredSdkCredentials | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.backendUrl !== "string" ||
      typeof record.apiKey !== "string" || !record.apiKey.trim() ||
      typeof record.createdAtMs !== "number" || !Number.isFinite(record.createdAtMs) ||
      (record.apiKeyExpiresAtMs !== undefined &&
        (typeof record.apiKeyExpiresAtMs !== "number" || !Number.isFinite(record.apiKeyExpiresAtMs))) ||
      (record.email !== undefined && typeof record.email !== "string")) return undefined;
  return {
    version: 1,
    backendUrl: record.backendUrl,
    apiKey: record.apiKey,
    createdAtMs: record.createdAtMs,
    ...(typeof record.apiKeyExpiresAtMs === "number" ? { apiKeyExpiresAtMs: record.apiKeyExpiresAtMs } : {}),
    ...(typeof record.email === "string" ? { email: record.email } : {}),
  };
}

function assertPrivateDirectory(homeDirectory: string, directory: string): void {
  const home = realpathSync(homeDirectory);
  const actual = realpathSync(directory);
  if (actual !== home && !actual.startsWith(`${home}${path.sep}`))
    throw new Error("Cursor credential storage must stay inside this provider's private home.");
}

export function assertCursorStorageIsolation(homeDirectory: string): void {
  for (const relative of [".cursor", ".cursor/sdk", ".cursor/sdk/state"]) {
    try { assertPrivateDirectory(homeDirectory, path.join(homeDirectory, relative)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export function readCursorCredentials(homeDirectory: string): StoredSdkCredentials | undefined {
  const filename = cursorCredentialPath(homeDirectory);
  let fd: number | undefined;
  try {
    assertPrivateDirectory(homeDirectory, path.dirname(filename));
    fd = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    return parseCursorCredentials(JSON.parse(readFileSync(fd, "utf8")));
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Commit synchronously after the caller's abort/generation check: cancellation
// cannot interleave an asynchronous credential write and resurrect a login.
export function saveCursorCredentials(homeDirectory: string, credentials: StoredSdkCredentials): void {
  const value = parseCursorCredentials(credentials);
  if (!value) throw new Error("Cursor returned an unsupported credential format.");
  const filename = cursorCredentialPath(homeDirectory);
  const directory = path.dirname(filename);
  for (const component of [path.join(homeDirectory, ".cursor"), directory]) {
    try { mkdirSync(component, { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    assertPrivateDirectory(homeDirectory, component);
  }
  chmodSync(directory, 0o700);
  const temporary = path.join(directory, `.auth-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    renameSync(temporary, filename);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* Preserve the credential write/rename failure. */ }
    throw error;
  }
}

export function clearCursorCredentials(homeDirectory: string): void {
  const filename = cursorCredentialPath(homeDirectory);
  try {
    assertPrivateDirectory(homeDirectory, path.dirname(filename));
    unlinkSync(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
