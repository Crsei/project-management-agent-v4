/**
 * Antigravity (Agy) MCP adapter.
 * Translated from vendor/cc-switch/src-tauri/src/mcp/agy.rs and
 * vendor/cc-switch/src-tauri/src/mcp/snapshot.rs.
 *
 * Agy marks a server with `disabled: true` instead of deleting it when the
 * assignment is unchecked, keeps no `type` field, and supports stdio plus
 * streamable HTTP only.
 */
import { readTextFile, writeTextFile } from "../../config/atomic.ts";
import { agyMcpPath } from "../../config/paths.ts";
import { requireNativeReadPath } from "../../host-context.ts";
import { AppError, configError } from "../../errors.ts";
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
const NATIVE_ONLY_FIELDS = ["type", "enabled", "disabled", "serverUrl"];

interface AgyRead extends NativeRead {
  initialized: boolean;
}

function requireObject(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw configError(message);
  }
  return value as Record<string, unknown>;
}

/** `agy::unified_spec`: legacy `serverUrl` is the `url` of an HTTP server. */
export function unifiedSpec(native: Record<string, unknown>): Record<string, unknown> {
  if (native === null || typeof native !== "object" || Array.isArray(native)) return native;
  const spec: Record<string, unknown> = { ...native };
  if ("serverUrl" in spec) {
    const url = spec.serverUrl;
    if (!("url" in spec)) spec.url = url;
    delete spec.serverUrl;
  }
  if (spec.type === "streamable-http" || (spec.type === undefined && "url" in spec)) {
    spec.type = "http";
  } else if (spec.type === undefined && "command" in spec) {
    spec.type = "stdio";
  }
  return spec;
}

/** Connection-only projection; Agy-native fields are dropped. */
export function transportSpec(spec: Record<string, unknown>): Record<string, unknown> {
  const unified = unifiedSpec(spec);
  if (unified === null || typeof unified !== "object" || Array.isArray(unified)) return unified;
  const result: Record<string, unknown> = { ...unified };
  for (const key of Object.keys(result)) {
    if (!TRANSPORT_FIELDS.includes(key)) delete result[key];
  }
  return result;
}

function projection(spec: Record<string, unknown>): Record<string, unknown> {
  const native = unifiedSpec(spec);
  for (const field of NATIVE_ONLY_FIELDS) delete native[field];
  return native;
}

function readDocument(path: string): Record<string, unknown> {
  const text = readTextFile(path);
  // Agy creates a zero-byte mcp_config.json on first launch.
  if (text === undefined || text.trim() === "") return { [SECTION]: {} };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw configError();
  }
  const document = requireObject(value, "Invalid Antigravity MCP JSON");
  const section = document[SECTION];
  if (section !== undefined) requireObject(section, "Invalid Antigravity mcpServers object");
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
  const enabled = object.disabled !== true;
  const spec = unifiedSpec(object);
  delete spec.enabled;
  delete spec.disabled;
  validateServerSpec(spec);
  return { spec, enabled };
}

function read(): AgyRead {
  const entries = new Map<string, NativeEntry>();
  const files: string[] = [];
  let error: string | undefined;
  let path: string;
  try {
    path = agyMcpPath();
    requireNativeReadPath("agy", path);
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
  const source = requireObject(spec, "Invalid Antigravity MCP entry");
  validateServerSpec(unifiedSpec(source));
  if (source.type === "sse") {
    throw new AppError("CONFIG", "Antigravity supports stdio and streamable HTTP, not SSE");
  }
  const path = agyMcpPath();
  const document = readDocument(path);
  const servers = serversOf(document);
  const merged: Record<string, unknown> = servers[id] === undefined
    ? {}
    : requireObject(servers[id], "Invalid Antigravity MCP entry");
  for (const field of TRANSPORT_FIELDS) delete merged[field];
  applyProjection(merged, projection(source));
  merged.disabled = false;
  servers[id] = merged;
  writeDocument(path, document);
}

function disable(id: string, _spec?: Record<string, unknown>): void {
  const path = agyMcpPath();
  const document = readDocument(path);
  const servers = serversOf(document);
  const existing = servers[id];
  if (existing !== undefined) {
    const entry = requireObject(existing, "Invalid Antigravity MCP entry");
    entry.disabled = true;
    servers[id] = entry;
  }
  writeDocument(path, document);
}

function remove(id: string): void {
  const path = agyMcpPath();
  const document = readDocument(path);
  const servers = serversOf(document);
  delete servers[id];
  writeDocument(path, document);
}

function syncOne(server: McpServer): void {
  upsert(server.id, server.server);
}

function syncAll(servers: McpServer[]): void {
  for (const server of servers) if (server.apps.agy) upsert(server.id, server.server);
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
  app: "agy",
  section: SECTION,
  read,
  syncAll,
  syncOne,
  disable,
  remove,
  project: projection,
  matches,
};

export const agyAdapter = adapter;
