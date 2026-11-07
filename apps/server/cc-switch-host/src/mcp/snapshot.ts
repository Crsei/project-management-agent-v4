/**
 * Translated from vendor/cc-switch/src-tauri/src/mcp/snapshot.rs.
 *
 * Read-only native snapshots. Never call an adapter's write helper here.
 */
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { configError, invalidInput, mcpValidation } from "../errors.ts";
import { isBound, requireApp, requireNativeReadPath } from "../host-context.ts";
import { NATIVE_MCP_PATHS } from "../config/paths.ts";
import { APP_IDS, type AppId } from "../types.ts";
import { ADAPTERS } from "./adapters/index.ts";
import { validateEntry as validatePiEntry } from "./adapters/pi.ts";
import { validateMcpSpec as validateDshMcpSpec } from "./adapters/dsh.ts";
import { validateServerSpec } from "./validation.ts";

export interface FileSnapshot {
  path: string;
  /** Raw bytes, or undefined when the file does not exist. */
  bytes: Buffer | undefined;
}

function invalid(): never {
  throw configError("invalid_native_configuration");
}

/** Attempted native paths, including paths that do not exist yet. */
function nativePaths(app: AppId): string[] {
  const resolve = NATIVE_MCP_PATHS[app];
  if (!resolve) throw invalid();
  return resolve();
}

export function validateTargetPaths(app: AppId): void {
  try {
    requireApp(app);
  } catch {
    throw invalidInput("unbound_target");
  }
  for (const nativePath of nativePaths(app)) {
    try {
      requireNativeReadPath(app, nativePath);
    } catch {
      throw configError("native_read_failed");
    }
  }
}

function validateSpecification(app: AppId, id: string, spec: Record<string, unknown>): void {
  validateServerSpec(spec);
  if (app === "pi") {
    validatePiEntry(id, spec);
  } else if (app === "dsh") {
    validateDshMcpSpec(id, spec);
  } else if (app === "agy" && spec.type === "sse") {
    throw mcpValidation("unsupported_transport");
  }
  // The production projection must accept the spec. This is a pure converter
  // check; adapters never perform network or command discovery here.
  ADAPTERS[app].project(spec);
}

/**
 * Pure adapter projection check shared by management and writes; every failure
 * is reported as an incompatible configuration.
 */
export function validate(app: AppId, id: string, spec: Record<string, unknown>): void {
  try {
    validateSpecification(app, id, spec);
  } catch {
    throw mcpValidation("incompatible_configuration");
  }
}

export class NativeSnapshot {
  readonly app: AppId;
  readonly files: FileSnapshot[];
  readonly entries: Map<string, { spec: Record<string, unknown>; enabled: boolean }>;
  readonly error: string | undefined;

  constructor(
    app: AppId,
    files: FileSnapshot[],
    entries: Map<string, { spec: Record<string, unknown>; enabled: boolean }>,
    error: string | undefined,
  ) {
    this.app = app;
    this.files = files;
    this.entries = entries;
    this.error = error;
  }

  /** At least one attempted native file physically exists and was readable. */
  initialized(): boolean {
    return this.files.some((file) => file.bytes !== undefined);
  }

  /** Enabled assignment in the native file plus a matching configuration. */
  matches(id: string, spec: Record<string, unknown>, patch?: unknown): boolean {
    const entry = this.entries.get(id);
    if (!entry || !entry.enabled) return false;
    return this.matchesConfiguration(id, spec, patch);
  }

  /**
   * Configuration comparison only. Every attempted path must have bytes and
   * the entry must be present in the parsed native state; the adapter owns the
   * per-format projection comparison and must not gate on `enabled`.
   */
  matchesConfiguration(id: string, spec: Record<string, unknown>, patch?: unknown): boolean {
    if (this.files.length === 0) return false;
    for (const file of this.files) if (file.bytes === undefined) return false;
    const entry = this.entries.get(id);
    if (!entry) return false;
    return ADAPTERS[this.app].matches(entry, spec, patch);
  }
}

type ReadCache = Map<string, Buffer | undefined | null>;

/** `undefined` = absent, `null` = unreadable (Rust io error), otherwise bytes. */
function cachedRead(cache: ReadCache, nativePath: string): Buffer | undefined | null {
  let identity: string;
  try {
    identity = realpathSync(nativePath);
  } catch {
    identity = path.resolve(nativePath);
  }
  if (!cache.has(identity)) {
    try {
      cache.set(identity, readFileSync(nativePath));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      cache.set(identity, code === "ENOENT" || code === "ENOTDIR" ? undefined : null);
    }
  }
  return cache.get(identity);
}

/** One scan for the entire management read, in host app order. */
export function readBound(): NativeSnapshot[] {
  const cache: ReadCache = new Map();
  const snapshots: NativeSnapshot[] = [];
  for (const app of APP_IDS) {
    if (!isBound(app)) continue;
    let paths: string[];
    try {
      paths = nativePaths(app);
    } catch {
      snapshots.push(new NativeSnapshot(app, [], new Map(), "native_read_failed"));
      continue;
    }
    const files: FileSnapshot[] = [];
    let readError: string | undefined;
    for (const nativePath of paths) {
      try {
        requireNativeReadPath(app, nativePath);
      } catch {
        readError = "native_read_failed";
        continue;
      }
      const bytes = cachedRead(cache, nativePath);
      if (bytes === null) {
        readError = "native_read_failed";
        continue;
      }
      files.push({ path: nativePath, bytes });
    }
    let entries = new Map<string, { spec: Record<string, unknown>; enabled: boolean }>();
    let error = readError;
    try {
      const read = ADAPTERS[app].read();
      entries = read.entries;
      if (read.error !== undefined) error = read.error;
    } catch {
      error = readError ?? "native_read_failed";
    }
    snapshots.push(new NativeSnapshot(app, files, entries, error));
  }
  return snapshots;
}

/** Snapshot identity is its app, error code, attempted files and their bytes. */
export function nativeEqual(left: readonly NativeSnapshot[], right: readonly NativeSnapshot[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => {
    const other = right[index];
    if (value.app !== other.app || value.error !== other.error || value.files.length !== other.files.length) return false;
    return value.files.every((file, position) => {
      const candidate = other.files[position];
      if (file.path !== candidate.path) return false;
      const left = file.bytes;
      const right = candidate.bytes;
      if (left === undefined || right === undefined) return left === right;
      return left.equals(right);
    });
  });
}
