/**
 * MiniMax Code (Mcode) MCP adapter.
 * Translated from vendor/cc-switch/src-tauri/src/mcp/mcode.rs and
 * vendor/cc-switch/src-tauri/src/mcp/snapshot.rs.
 *
 * Mcode keeps its own fields (timeout, tool exposure, ...) in the same entry,
 * so syncs replace only the transport fields.
 */
import { readTextFile, writeTextFile } from "../../config/atomic.ts";
import { mcodeMcpPath } from "../../config/paths.ts";
import { requireNativeReadPath } from "../../host-context.ts";
import { configError } from "../../errors.ts";
import type { McpServer } from "../../types.ts";
import {
  type AppAdapter,
  type NativeEntry,
  type NativeRead,
  applyOptions,
  asObject,
  deepEqual,
} from "../adapter.ts";
import { validateServerSpec } from "../validation.ts";

const SECTION = "mcpServers";
const TRANSPORT_FIELDS = ["command", "args", "env", "url", "headers", "type"];

interface McodeRead extends NativeRead {
  initialized: boolean;
}

function requireObject(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw configError(message);
  }
  return value as Record<string, unknown>;
}

/** `mcode::unified_spec`: native entries back to the shared connection shape. */
export function unifiedSpec(native: Record<string, unknown>): Record<string, unknown> {
  if (native === null || typeof native !== "object" || Array.isArray(native)) return native;
  const spec: Record<string, unknown> = { ...native };
  if (spec.type === "streamable-http" || (spec.type === undefined && "url" in spec)) {
    spec.type = "http";
  } else if (spec.type === undefined && "command" in spec) {
    spec.type = "stdio";
  }
  return spec;
}

/** Mcode writes the shared connection spec as-is; only assignment flags are dropped. */
function projection(spec: Record<string, unknown>): Record<string, unknown> {
  const object: Record<string, unknown> = { ...spec };
  delete object.enabled;
  delete object.disabled;
  return object;
}

function readDocument(path: string): Record<string, unknown> {
  const text = readTextFile(path);
  if (text === undefined) return { [SECTION]: {} };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw configError();
  }
  const document = requireObject(value, "Invalid MCode MCP JSON");
  const section = document[SECTION];
  if (section !== undefined) requireObject(section, "Invalid MCode mcpServers object");
  return document;
}

function serversOf(document: Record<string, unknown>): Record<string, unknown> {
  const section = document[SECTION];
  if (section === undefined) {
    const created: Record<string, unknown> = {};
    document[SECTION] = created;
    return created;
  }
  return section as Record<string, unknown>;
}

function writeDocument(path: string, document: Record<string, unknown>): void {
  writeTextFile(path, JSON.stringify(document, null, 2), true);
}

/**
 * `apply_options` semantics for an already-materialized native spec: null
 * values are removal tombstones for managed options, nested objects merge.
 */
function applyProjection(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    if (value === null) {
      delete target[key];
    } else if (typeof value === "object" && !Array.isArray(value)) {
      const nested = target[key] !== null && typeof target[key] === "object" && !Array.isArray(target[key])
        ? target[key] as Record<string, unknown>
        : {};
      applyProjection(nested, value as Record<string, unknown>);
      target[key] = nested;
    } else {
      target[key] = value;
    }
  }
}

function decode(native: unknown): NativeEntry {
  const object = asObject(native);
  const enabled = object.enabled !== false;
  const spec = unifiedSpec(object);
  delete spec.enabled;
  delete spec.disabled;
  validateServerSpec(spec);
  return { spec, enabled };
}

function read(): McodeRead {
  const entries = new Map<string, NativeEntry>();
  const files: string[] = [];
  let error: string | undefined;
  let path: string;
  try {
    path = mcodeMcpPath();
    requireNativeReadPath("mcode", path);
  } catch {
    return { entries, files, initialized: false, error: "native_read_failed" };
  }
  let text: string | undefined;
  try {
    text = readTextFile(path);
  } catch {
    return { entries, files, initialized: false, error: "native_read_failed" };
  }
  files.push(path);
  if (text === undefined) return { entries, files, initialized: false };
  let document: Record<string, unknown>;
  try {
    document = asObject(JSON.parse(text));
  } catch {
    return { entries, files, initialized: true, error: "invalid_native_configuration" };
  }
  const section = document[SECTION];
  if (section !== undefined
    && (section === null || typeof section !== "object" || Array.isArray(section))) {
    return { entries, files, initialized: true, error: "invalid_native_configuration" };
  }
  const map = (section ?? {}) as Record<string, unknown>;
  for (const [id, native] of Object.entries(map)) {
    let entry: NativeEntry;
    try {
      entry = decode(native);
    } catch {
      error = "invalid_native_configuration";
      continue;
    }
    const previous = entries.get(id);
    if (previous === undefined) {
      entries.set(id, entry);
    } else if (!deepEqual(previous.spec, entry.spec) || previous.enabled !== entry.enabled) {
      error = "native_profiles_conflict";
    }
  }
  return error === undefined
    ? { entries, files, initialized: true }
    : { entries, files, initialized: true, error };
}

function upsert(id: string, spec: Record<string, unknown>): void {
  const source = requireObject(spec, "Invalid MCode MCP entry");
  validateServerSpec(unifiedSpec(source));
  const path = mcodeMcpPath();
  const document = readDocument(path);
  const servers = serversOf(document);
  const merged: Record<string, unknown> = servers[id] === undefined
    ? {}
    : requireObject(servers[id], "Invalid MCode MCP entry");
  for (const field of TRANSPORT_FIELDS) delete merged[field];
  applyProjection(merged, projection(source));
  merged.enabled = true;
  servers[id] = merged;
  writeDocument(path, document);
}

function remove(id: string): void {
  const path = mcodeMcpPath();
  const document = readDocument(path);
  const servers = serversOf(document);
  delete servers[id];
  writeDocument(path, document);
}

function syncOne(server: McpServer): void {
  upsert(server.id, server.server);
}

function disable(id: string, _spec?: Record<string, unknown>): void {
  remove(id);
}

function syncAll(servers: McpServer[]): void {
  for (const server of servers) if (server.apps.mcode) upsert(server.id, server.server);
}

function matches(
  native: NativeEntry,
  spec: Record<string, unknown>,
  patch?: unknown,
): boolean {
  const nativeSpec = unifiedSpec(native.spec);
  const expected = unifiedSpec(spec);
  for (const field of ["enabled", "disabled"]) {
    delete nativeSpec[field];
    delete expected[field];
  }
  const merged: Record<string, unknown> = { ...nativeSpec };
  applyOptions(merged, patch, TRANSPORT_FIELDS);
  return TRANSPORT_FIELDS.every((field) => deepEqual(nativeSpec[field], expected[field]))
    && deepEqual(merged, nativeSpec);
}

export const adapter: AppAdapter = {
  app: "mcode",
  section: SECTION,
  read,
  syncAll,
  syncOne,
  disable,
  remove,
  project: projection,
  matches,
};

export const mcodeAdapter = adapter;
