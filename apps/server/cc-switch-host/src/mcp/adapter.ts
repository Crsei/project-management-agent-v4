/** Shared adapter contract translated from vendor/cc-switch/src-tauri/src/mcp/{mod,snapshot}.rs. */
import { AppError, configError } from "../errors.ts";
import type { AppId, McpServer } from "../types.ts";

export interface NativeEntry {
  spec: Record<string, unknown>;
  enabled: boolean;
}

export interface NativeRead {
  entries: Map<string, NativeEntry>;
  /** Attempted native paths, including paths that do not exist yet (Rust snapshot semantics). */
  files: string[];
  /** True when at least one attempted file physically exists. */
  initialized?: boolean;
  error?: string;
}

export interface AppAdapter {
  readonly app: AppId;
  readonly section: string;
  read(): NativeRead;
  syncAll(servers: McpServer[]): void;
  syncOne(server: McpServer): void;
  /** Disable one assignment without deleting the shared definition. */
  disable(id: string, spec?: Record<string, unknown>): void;
  /** Delete the server entry from this application (server deletion), not a toggle-off. */
  remove(id: string): void;
  project(spec: Record<string, unknown>): unknown;
  /** Optional patch is the saved per-agent override; adapters that merge native-only options use it. */
  matches(native: NativeEntry, spec: Record<string, unknown>, patch?: unknown): boolean;
}

export function emptyNativeRead(files: string[]): NativeRead {
  return { entries: new Map(), files };
}

export function readNativeError(files: string[], error: string): NativeRead {
  return { entries: new Map(), files, error };
}

export function asObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw configError();
  return value as Record<string, unknown>;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function deepEqual(left: unknown, right: unknown): boolean {
  return stable(left) === stable(right);
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** RFC 7396 merge patch, preserving explicit null removals. */
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const base = target === null || typeof target !== "object" || Array.isArray(target) ? {} : { ...(target as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === null) delete base[key];
    else base[key] = mergePatch(base[key], value);
  }
  return base;
}

export function effective(base: Record<string, unknown>, patch?: unknown): Record<string, unknown> {
  return patch === undefined ? { ...base } : (mergePatch(base, patch) as Record<string, unknown>);
}

/** Native options are patched without replacing transport fields owned by the adapter. */
export function applyOptions(native: Record<string, unknown>, patch: unknown, connectionFields: readonly string[]): void {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return;
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (connectionFields.includes(key) || ["enabled", "disabled", "serverName", "serverUrl", "transport"].includes(key)) continue;
    if (value === null) delete native[key];
    else native[key] = mergePatch(native[key], value);
  }
}

export function ensureObject(value: unknown, message = "Invalid native configuration"): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new AppError("CONFIG", message);
  return value as Record<string, unknown>;
}
