/**
 * Gemini MCP adapter.
 * Translated from vendor/cc-switch/src-tauri/src/mcp/gemini.rs,
 * vendor/cc-switch/src-tauri/src/gemini_mcp.rs and the Gemini branch of
 * vendor/cc-switch/src-tauri/src/mcp/snapshot.rs at pinned cc-switch 4.0.25.
 *
 * Gemini CLI infers the transport from field names (`command` = stdio,
 * `url` = SSE, `httpUrl` = streamable HTTP) and stores a single collapsed
 * `timeout` in milliseconds. Every write replaces only the `mcpServers` key.
 */
import { existsSync } from "node:fs";
import { readTextFile, writeJsonFile } from "../../config/atomic.ts";
import { geminiSettingsPath } from "../../config/paths.ts";
import { appDir, requireNativeReadPath } from "../../host-context.ts";
import { configError, mcpValidation } from "../../errors.ts";
import type { McpServer } from "../../types.ts";
import {
  type AppAdapter,
  type NativeEntry,
  type NativeRead,
  asObject,
  deepEqual,
} from "../adapter.ts";
import { validateServerSpec } from "../validation.ts";

const SECTION = "mcpServers";
const INVALID_NATIVE = "invalid_native_configuration";
const NATIVE_READ_FAILED = "native_read_failed";
/** `gemini_mcp::native_server_spec` drops the shared-schema transport/bookkeeping fields. */
const UI_FIELDS = [
  "type",
  "enabled",
  "source",
  "id",
  "name",
  "description",
  "tags",
  "homepage",
  "docs",
];
const TIMEOUT_FIELDS = [
  "startup_timeout_sec",
  "startup_timeout_ms",
  "tool_timeout_sec",
  "tool_timeout_ms",
];
const DEFAULT_STARTUP_MS = 10_000;
const DEFAULT_TOOL_MS = 60_000;

/** Raw native entries, so `matches` can compare the file exactly like the Rust snapshot. */
const rawNative = new WeakMap<NativeEntry, Record<string, unknown>>();

/** `gemini_mcp::normalize_native_spec`: native field names back to the shared shape. */
export function normalizeNativeSpec(spec: Record<string, unknown>): Record<string, unknown> {
  const object: Record<string, unknown> = { ...spec };
  const has = (key: string) => Object.prototype.hasOwnProperty.call(object, key);
  if (has("httpUrl")) {
    object.url = object.httpUrl;
    delete object.httpUrl;
    object.type = "http";
  }
  if (!has("type")) {
    if (has("command")) object.type = "stdio";
    else if (has("url")) object.type = "sse";
  }
  return object;
}

/** Materialized projection patches use null as a removal tombstone (Rust `mergePatch`). */
function pruneNulls(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === null) continue;
    result[key] = typeof item === "object" && !Array.isArray(item)
      ? pruneNulls(item as Record<string, unknown>)
      : item;
  }
  return result;
}

function asU64(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** serde `as_u64` then `as_f64`; the source key is always consumed. */
function takeTimeout(object: Record<string, unknown>, key: string, multiplier: number): number | undefined {
  if (!Object.prototype.hasOwnProperty.call(object, key)) return undefined;
  const value = object[key];
  delete object[key];
  const integer = asU64(value);
  if (integer !== undefined) return integer * multiplier;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.trunc(value * multiplier));
}

/**
 * `gemini_mcp::native_server_spec`: the same native projection serves writes and
 * read-only synchronization checks.
 */
export function nativeServerSpec(id: string, spec: Record<string, unknown>): Record<string, unknown> {
  let object: Record<string, unknown> = { ...asObject(spec) };
  if ("server" in object) {
    const server = object.server;
    delete object.server;
    if (server === null || typeof server !== "object" || Array.isArray(server)) {
      throw mcpValidation(`MCP server '${id}' server field is not an object`);
    }
    object = { ...(server as Record<string, unknown>) };
  }

  // Gemini CLI infers the transport from field names: HTTP uses httpUrl, SSE uses url.
  if (object.type === "http" && "url" in object) {
    object.httpUrl = object.url;
    delete object.url;
  }
  for (const field of UI_FIELDS) delete object[field];
  // Materialized projection patches use null as a removal tombstone (Rust mergePatch).
  object = pruneNulls(object);

  // A read-modify-write of another server must preserve Gemini's native timeout.
  const nativeTimeout = TIMEOUT_FIELDS.some((field) => field in object)
    ? undefined
    : asU64(object.timeout);
  const startupMs = takeTimeout(object, "startup_timeout_sec", 1000)
    ?? takeTimeout(object, "startup_timeout_ms", 1)
    ?? DEFAULT_STARTUP_MS;
  const toolMs = takeTimeout(object, "tool_timeout_sec", 1000)
    ?? takeTimeout(object, "tool_timeout_ms", 1)
    ?? DEFAULT_TOOL_MS;
  object.timeout = nativeTimeout ?? Math.max(startupMs, toolMs);
  return object;
}

function decode(native: unknown): NativeEntry {
  const object = asObject(native);
  const enabled = object.enabled !== false;
  const spec = normalizeNativeSpec(object);
  // Assignment state is not part of the shared connection definition.
  delete spec.enabled;
  delete spec.disabled;
  validateServerSpec(spec);
  return { spec, enabled };
}

function readRoot(path: string): Record<string, unknown> {
  const text = readTextFile(path);
  if (text === undefined) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw configError();
  }
  return asObject(value);
}

/** `gemini_mcp::read_mcp_servers_map`; a non-object section reads as empty. */
function readServers(root: Record<string, unknown>): Record<string, unknown> {
  const section = root[SECTION];
  if (section === undefined) return {};
  if (section === null || typeof section !== "object" || Array.isArray(section)) return {};
  return { ...(section as Record<string, unknown>) };
}

/** `gemini_mcp::set_mcp_servers_map`: every entry is re-projected on write. */
function writeServers(path: string, servers: Record<string, unknown>): void {
  const root = readRoot(path);
  const out: Record<string, unknown> = {};
  for (const [id, native] of Object.entries(servers)) {
    out[id] = nativeServerSpec(id, asObject(native));
  }
  root[SECTION] = out;
  writeJsonFile(path, root, true);
}

/** `should_sync_gemini_mcp`: never create `~/.gemini`. */
function installed(): boolean {
  return existsSync(appDir("gemini"));
}

function read(): NativeRead {
  const entries = new Map<string, NativeEntry>();
  const files: string[] = [];
  let path: string;
  try {
    path = geminiSettingsPath();
    requireNativeReadPath("gemini", path);
  } catch {
    return { entries, files, initialized: false, error: NATIVE_READ_FAILED };
  }
  let text: string | undefined;
  try {
    text = readTextFile(path);
  } catch {
    return { entries, files, initialized: false, error: NATIVE_READ_FAILED };
  }
  files.push(path);
  if (text === undefined) return { entries, files, initialized: false };

  let document: Record<string, unknown>;
  try {
    document = asObject(JSON.parse(text));
  } catch {
    return { entries, files, initialized: true, error: INVALID_NATIVE };
  }
  const section = document[SECTION];
  if (section !== undefined
    && (section === null || typeof section !== "object" || Array.isArray(section))) {
    return { entries, files, initialized: true, error: INVALID_NATIVE };
  }

  let error: string | undefined;
  for (const [id, native] of Object.entries((section ?? {}) as Record<string, unknown>)) {
    try {
      const entry = decode(native);
      rawNative.set(entry, asObject(native));
      entries.set(id, entry);
    } catch {
      error = INVALID_NATIVE;
    }
  }
  return error === undefined
    ? { entries, files, initialized: true }
    : { entries, files, initialized: true, error };
}

/** `sync_single_server_to_gemini`: the whole map is re-projected on write. */
function upsert(id: string, spec: Record<string, unknown>): void {
  if (!installed()) return;
  const path = geminiSettingsPath();
  const servers = readServers(readRoot(path));
  servers[id] = spec;
  writeServers(path, servers);
}

/** `remove_server_from_gemini`: delete one entry and re-project the rest. */
function removeEntry(id: string): void {
  if (!installed()) return;
  const path = geminiSettingsPath();
  const servers = readServers(readRoot(path));
  delete servers[id];
  writeServers(path, servers);
}

export const adapter: AppAdapter = {
  app: "gemini",
  section: SECTION,

  read,

  /** Mirrors `services::McpService::project_servers_to_app` for Gemini. */
  syncAll(servers: McpServer[]): void {
    for (const server of servers) {
      if (server.apps.gemini === true) upsert(server.id, server.server);
      else removeEntry(server.id);
    }
  },

  /** Enabled write only; toggling off goes through `disable`. */
  syncOne(server: McpServer): void {
    upsert(server.id, server.server);
  },

  /** Gemini has no native disable flag: toggling off removes the entry. */
  disable(id: string): void {
    removeEntry(id);
  },

  remove(id: string): void {
    removeEntry(id);
  },

  project(spec: Record<string, unknown>): unknown {
    return nativeServerSpec("managed", spec);
  },

  matches(native: NativeEntry, spec: Record<string, unknown>): boolean {
    // The snapshot layer gates on `native.enabled`; compare native fields only.
    try {
      return deepEqual(rawNative.get(native) ?? native.spec, nativeServerSpec("managed", spec));
    } catch {
      return false;
    }
  },
};

export const geminiAdapter = adapter;
