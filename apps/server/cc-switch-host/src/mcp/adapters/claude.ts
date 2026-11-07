/**
 * Claude MCP adapter.
 * Translated from vendor/cc-switch/src-tauri/src/mcp/claude.rs,
 * vendor/cc-switch/src-tauri/src/claude_mcp.rs and the Claude branch of
 * vendor/cc-switch/src-tauri/src/mcp/snapshot.rs at pinned cc-switch 4.0.25.
 *
 * Claude keeps every native server in the explicit `mcpServers` map of
 * `~/.claude.json`; entries have no managed assignment flag of their own, so
 * toggling the Claude checkbox removes the native entry.
 */
import { existsSync } from "node:fs";
import { readTextFile, writeJsonFile } from "../../config/atomic.ts";
import { claudeMcpPath } from "../../config/paths.ts";
import { appDir, requireNativeReadPath } from "../../host-context.ts";
import { configError } from "../../errors.ts";
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
/** CC Switch bookkeeping `claude_mcp::set_mcp_servers_map` never writes natively. */
const UI_FIELDS = ["enabled", "source", "id", "name", "description", "tags", "homepage", "docs"];

/** Mirrors `should_sync_claude_mcp`: uninstalled Claude is never created by a sync. */
function installed(): boolean {
  return existsSync(appDir("claude")) || existsSync(claudeMcpPath());
}

function decode(native: unknown): NativeEntry {
  const object = asObject(native);
  const enabled = object.enabled !== false;
  const spec: Record<string, unknown> = { ...object };
  // Assignment state is not part of the shared connection definition.
  delete spec.enabled;
  delete spec.disabled;
  validateServerSpec(spec);
  return { spec, enabled };
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

/** `claude_mcp::set_mcp_servers_map`: strip the wrapper and CC Switch bookkeeping. */
function projectNative(spec: Record<string, unknown>): Record<string, unknown> {
  const source = asObject(spec);
  const object: Record<string, unknown> = "server" in source
    ? { ...asObject(source.server) }
    : { ...source };
  for (const field of UI_FIELDS) delete object[field];
  return pruneNulls(object);
}

/** `pi::unified_spec`, used by the snapshot when comparing Claude entries. */
function unified(spec: Record<string, unknown>): Record<string, unknown> {
  const object = { ...spec };
  const has = (key: string) => Object.prototype.hasOwnProperty.call(object, key);
  if (object.type === "streamable-http" || (!has("type") && has("url"))) object.type = "http";
  else if (!has("type") && has("command")) object.type = "stdio";
  return object;
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

function readServers(root: Record<string, unknown>): Record<string, unknown> {
  const section = root[SECTION];
  if (section === undefined) return {};
  if (section === null || typeof section !== "object" || Array.isArray(section)) {
    throw configError();
  }
  return { ...(section as Record<string, unknown>) };
}

/** Every entry is re-projected on each write, exactly like `set_mcp_servers_map`. */
function writeServers(path: string, servers: Record<string, unknown>): void {
  const root = readRoot(path);
  const out: Record<string, unknown> = {};
  for (const [id, native] of Object.entries(servers)) {
    if (native === null || typeof native !== "object" || Array.isArray(native)) {
      throw configError(`MCP server '${id}' is not an object`);
    }
    out[id] = projectNative(native as Record<string, unknown>);
  }
  root[SECTION] = out;
  writeJsonFile(path, root, true);
}

function read(): NativeRead {
  const entries = new Map<string, NativeEntry>();
  const files: string[] = [];
  let path: string;
  try {
    path = claudeMcpPath();
    requireNativeReadPath("claude", path);
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
      entries.set(id, decode(native));
    } catch {
      error = INVALID_NATIVE;
    }
  }
  return error === undefined
    ? { entries, files, initialized: true }
    : { entries, files, initialized: true, error };
}

/** `sync_single_server_to_claude`: read-modify-write through the shared map writer. */
function upsert(id: string, spec: Record<string, unknown>): void {
  if (!installed()) return;
  const path = claudeMcpPath();
  const servers = readServers(readRoot(path));
  servers[id] = spec;
  writeServers(path, servers);
}

/** `remove_server_from_claude`: drop the entry, keep every other root key. */
function removeEntry(id: string): void {
  if (!installed()) return;
  const path = claudeMcpPath();
  const servers = readServers(readRoot(path));
  delete servers[id];
  writeServers(path, servers);
}

export const adapter: AppAdapter = {
  app: "claude",
  section: SECTION,

  read,

  /** Mirrors `services::McpService::project_servers_to_app` for Claude. */
  syncAll(servers: McpServer[]): void {
    for (const server of servers) {
      if (server.apps.claude === true) upsert(server.id, server.server);
      else removeEntry(server.id);
    }
  },

  /** Enabled write only; toggling off goes through `disable`. */
  syncOne(server: McpServer): void {
    upsert(server.id, server.server);
  },

  /** Claude has no native disable flag: toggling off removes the entry. */
  disable(id: string): void {
    removeEntry(id);
  },

  remove(id: string): void {
    removeEntry(id);
  },

  project(spec: Record<string, unknown>): unknown {
    return projectNative(spec);
  },

  matches(native: NativeEntry, spec: Record<string, unknown>): boolean {
    // The snapshot layer gates on `native.enabled`; compare connection content only.
    try {
      return deepEqual(unified(native.spec), unified(spec));
    } catch {
      return false;
    }
  },
};

export const claudeAdapter = adapter;
