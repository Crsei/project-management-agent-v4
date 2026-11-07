/**
 * Oh My Pi (OMP) MCP adapter.
 * Translated from vendor/cc-switch/src-tauri/src/mcp/omp.rs,
 * vendor/cc-switch/src-tauri/src/omp_config.rs and the OMP branch of
 * vendor/cc-switch/src-tauri/src/mcp/snapshot.rs at pinned cc-switch 4.0.25.
 *
 * OMP shares Pi's entry/transport shape (`mcpServers`), but tracks assignment
 * in the top-level `disabledServers` / `enabledServers` name lists and keeps
 * per-server options on the native entry. Disabling writes an `enabled: false`
 * tombstone plus the denylist entry so project or foreign discovery cannot
 * reactivate the server; deleting the shared definition removes the entry.
 */
import { existsSync } from "node:fs";
import { readTextFile, writeTextFile } from "../../config/atomic.ts";
import { ompMcpPath } from "../../config/paths.ts";
import { requireNativeReadPath } from "../../host-context.ts";
import { configError, invalidInput } from "../../errors.ts";
import type { McpServer } from "../../types.ts";
import {
  type AppAdapter,
  type NativeEntry,
  type NativeRead,
  applyOptions,
  asObject,
  deepEqual,
  readNativeError,
} from "../adapter.ts";
import { validateServerSpec } from "../validation.ts";
import { TRANSPORT_FIELDS, transportSpec, unifiedSpec } from "./pi.ts";

const SECTION = "mcpServers";
const INVALID_NATIVE = "invalid_native_configuration";
const NATIVE_READ_FAILED = "native_read_failed";

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** `omp_config::update_omp_mcp_document`: missing is empty, malformed is an error. */
function readDocument(): Record<string, unknown> {
  const text = readTextFile(ompMcpPath());
  if (text === undefined) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw configError("omp.errors.invalidMcp");
  }
  if (!isObject(value)) throw configError("omp.errors.invalidMcp");
  if (value[SECTION] !== undefined && !isObject(value[SECTION])) {
    throw configError("omp.errors.invalidMcp");
  }
  return value;
}

/**
 * Mutate the native document and persist it only when something changed, like
 * `update_omp_mcp_document` returning whether the document differs.
 */
function updateDocument(update: (document: Record<string, unknown>) => void): void {
  const path = ompMcpPath();
  const document = readDocument();
  const before = structuredClone(document);
  update(document);
  if (deepEqual(document, before)) return;
  writeTextFile(path, `${JSON.stringify(document, null, 2)}\n`, true);
}

function serversOf(document: Record<string, unknown>): Record<string, unknown> {
  const current = document[SECTION];
  if (current === undefined) {
    const created: Record<string, unknown> = {};
    document[SECTION] = created;
    return created;
  }
  if (!isObject(current)) throw configError("Oh My Pi MCP 'mcpServers' must be an object");
  return current;
}

/** `omp::update_list`: keep the name list ordered and free of duplicates. */
function updateList(
  document: Record<string, unknown>,
  field: string,
  id: string,
  include: boolean,
): void {
  const current = document[field];
  if (current === undefined && !include) return;
  if (current === undefined) document[field] = [id];
  else if (!Array.isArray(current)) {
    throw configError(`Oh My Pi MCP '${field}' must be an array`);
  } else {
    document[field] = [...current.filter((value) => value !== id), ...(include ? [id] : [])];
  }
}

/** `omp::native_enabled`: denylist first, then the entry flag and allowlist. */
function nativeEnabled(document: Record<string, unknown>, id: string, native: Record<string, unknown>): boolean {
  const listed = (field: string): boolean => {
    const list = document[field];
    return Array.isArray(list) && list.some((value) => value === id);
  };
  if (listed("disabledServers")) return false;
  const value = native.enabled;
  const disabled = value === false
    || (typeof value === "string" && ["false", "0"].includes(value.toLowerCase()));
  return !disabled || listed("enabledServers");
}

function decode(
  document: Record<string, unknown>,
  id: string,
  native: unknown,
): NativeEntry {
  const object = asObject(native);
  const enabled = nativeEnabled(document, id, object);
  const spec = unifiedSpec(object);
  delete spec.enabled;
  delete spec.disabled;
  validateServerSpec(spec);
  return { spec, enabled };
}

function read(): NativeRead {
  const entries = new Map<string, NativeEntry>();
  let path: string;
  try {
    path = ompMcpPath();
    requireNativeReadPath("omp", path);
  } catch {
    return { ...readNativeError([], NATIVE_READ_FAILED), initialized: false };
  }
  const files = [path];
  const initialized = existsSync(path);
  let text: string | undefined;
  try {
    text = readTextFile(path);
  } catch {
    return { ...readNativeError(files, NATIVE_READ_FAILED), initialized };
  }
  if (text === undefined) return { entries, files, initialized };
  let document: Record<string, unknown>;
  try {
    document = asObject(JSON.parse(text));
  } catch {
    return { ...readNativeError(files, INVALID_NATIVE), initialized };
  }
  const section = document[SECTION];
  if (section !== undefined && !isObject(section)) {
    return { ...readNativeError(files, INVALID_NATIVE), initialized };
  }
  let invalid = false;
  for (const [id, native] of Object.entries(isObject(section) ? section : {})) {
    try {
      entries.set(id, decode(document, id, native));
    } catch {
      invalid = true;
    }
  }
  return invalid
    ? { entries, files, initialized, error: INVALID_NATIVE }
    : { entries, files, initialized };
}

/** Mirror `omp::sync_locked_overridden` for enable/disable. */
function applyChange(
  id: string,
  spec: Record<string, unknown>,
  enabled: boolean,
): void {
  updateDocument((document) => {
    const servers = serversOf(document);
    const unified = unifiedSpec(spec);
    validateServerSpec(unified);
    const existing = servers[id];
    // A server configured independently of CC Switch keeps its configuration.
    if (existing !== undefined) {
      if (!isObject(existing) || !deepEqual(transportSpec(existing), transportSpec(unified))) {
        throw invalidInput(
          `Oh My Pi MCP '${id}' conflicts with an independently configured server; native configuration preserved`,
        );
      }
    }
    // Native options edited by OMP win; stored options restore a removed entry.
    const merged: Record<string, unknown> = existing === undefined
      ? structuredClone(unified)
      : structuredClone(asObject(existing));
    for (const field of TRANSPORT_FIELDS) delete merged[field];
    for (const field of TRANSPORT_FIELDS) {
      if (field in unified) merged[field] = unified[field];
    }
    // The caller folds the saved override into `spec`, exactly the patch Rust
    // applies to native-only options.
    applyOptions(merged, spec, TRANSPORT_FIELDS);
    merged.enabled = enabled;
    servers[id] = merged;
    updateList(document, "disabledServers", id, !enabled);
    updateList(document, "enabledServers", id, false);
  });
}

function enable(id: string, spec: Record<string, unknown>): void {
  applyChange(id, spec, true);
}

function disable(id: string, spec?: Record<string, unknown>): void {
  let effective = spec;
  if (effective === undefined) {
    // No shared definition supplied: disable the existing native entry only.
    const servers = readDocument()[SECTION];
    const native = isObject(servers) ? servers[id] : undefined;
    if (!isObject(native)) return;
    effective = unifiedSpec(native);
  }
  applyChange(id, effective, false);
}

function remove(id: string): void {
  updateDocument((document) => {
    const servers = serversOf(document);
    delete servers[id];
    updateList(document, "disabledServers", id, false);
    updateList(document, "enabledServers", id, false);
  });
}

function syncOne(server: McpServer): void {
  enable(server.id, server.server);
}

function syncAll(servers: McpServer[]): void {
  // Rust `project_servers_to_app`: a false OMP flag never removes an entry.
  for (const server of servers) if (server.apps.omp) enable(server.id, server.server);
}

function project(spec: Record<string, unknown>): unknown {
  return transportSpec(spec);
}

/** Snapshot comparison: the projected transport plus native-only options. */
function matches(native: NativeEntry, spec: Record<string, unknown>, patch?: unknown): boolean {
  try {
    const expected = transportSpec(spec);
    const merged = structuredClone(native.spec);
    applyOptions(merged, patch, TRANSPORT_FIELDS);
    return deepEqual(transportSpec(native.spec), transportSpec(expected))
      && deepEqual(merged, native.spec);
  } catch {
    return false;
  }
}

export const adapter: AppAdapter = {
  app: "omp",
  section: SECTION,
  read,
  syncAll,
  syncOne,
  disable,
  remove,
  project,
  matches,
};

export const ompAdapter = adapter;
