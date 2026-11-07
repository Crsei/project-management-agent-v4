/**
 * Pi MCP adapter.
 * Translated from vendor/cc-switch/src-tauri/src/mcp/pi.rs and the Pi branch
 * of vendor/cc-switch/src-tauri/src/mcp/snapshot.rs at pinned cc-switch 4.0.25.
 *
 * Pi keeps MCP servers in the user-level `<Pi agent dir>/mcp.json` under the
 * top-level `mcpServers` map. Compared with Claude the format has four rules:
 * SSE is unsupported, `type` is `stdio`/`http`/`streamable-http` or omitted,
 * server names are limited to `[A-Za-z0-9_-]` and two names that differ only by
 * `-`/`_` are the same server. Pi's own entry fields (`enabled`, `timeout`,
 * `description`, `exposure`, `toolExposure`, `oauth`, `auth`) are preserved on
 * every write; only the transport fields are replaced.
 */
import { existsSync, statSync } from "node:fs";
import { readTextFile, writeTextFile } from "../../config/atomic.ts";
import { piAgentDir, piMcpPath } from "../../config/paths.ts";
import { requireNativeReadPath } from "../../host-context.ts";
import { configError, mcpValidation } from "../../errors.ts";
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

const SECTION = "mcpServers";
const INVALID_NATIVE = "invalid_native_configuration";
const NATIVE_READ_FAILED = "native_read_failed";

/** Connection fields owned by CC Switch; every other field belongs to Pi. */
export const TRANSPORT_FIELDS = [
  "command",
  "args",
  "env",
  "cwd",
  "url",
  "headers",
  "type",
] as const;

/** Pi's own entry fields, restored from the saved connection definition. */
const PI_FIELDS = [
  "timeout",
  "description",
  "exposure",
  "toolExposure",
  "oauth",
  "auth",
] as const;

type PiChange =
  | { readonly kind: "enable"; readonly spec: Record<string, unknown> }
  | { readonly kind: "disable" }
  | { readonly kind: "remove" };

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Pi is installed only when its agent directory exists; never create it on sync. */
function installed(): boolean {
  try {
    return statSync(piAgentDir()).isDirectory();
  } catch {
    return false;
  }
}

/** Pi's server-name rule: letters, digits, `_` and `-` only. */
function validateName(id: string): void {
  if (id.length === 0 || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw mcpValidation(`Pi MCP server names may only contain letters, digits, _ and -: ${id}`);
  }
}

/** Pi treats names that differ only by `-` and `_` as the same server. */
function normalizedName(id: string): string {
  return id.replaceAll("-", "_");
}

/** Reject another name that differs from `id` only by `-` / `_`. */
function checkNameCollision(id: string, names: Iterable<string>): void {
  const key = normalizedName(id);
  for (const name of names) {
    if (name !== id && normalizedName(name) === key) {
      throw mcpValidation(
        `Pi treats server names that differ only by - and _ as the same: ${id} conflicts with existing ${name}`,
      );
    }
  }
}

/**
 * Pi rejects these entries regardless of the rest of the file: illegal names,
 * SSE and invalid connections.
 */
export function validateEntry(id: string, spec: Record<string, unknown>): void {
  validateName(id);
  nativeTransport(spec);
}

/**
 * Unified CC Switch format -> the connection fields Pi stores. SSE is rejected.
 */
export function nativeTransport(spec: Record<string, unknown>): Record<string, unknown> {
  validateServerSpec(spec);
  if (spec.type === "sse") {
    throw mcpValidation(
      "Pi does not support SSE MCP servers; use HTTP (streamable HTTP) instead",
    );
  }
  const native: Record<string, unknown> = {};
  for (const field of TRANSPORT_FIELDS) {
    if (field in spec) native[field] = spec[field];
  }
  return native;
}

/** `pi::unified_spec`: `streamable-http` becomes `http`, an omitted type is inferred. */
export function unifiedSpec(native: Record<string, unknown>): Record<string, unknown> {
  const spec: Record<string, unknown> = { ...native };
  if (spec.type === "streamable-http" || (spec.type === undefined && "url" in spec)) {
    spec.type = "http";
  } else if (spec.type === undefined && "command" in spec) {
    spec.type = "stdio";
  }
  return spec;
}

/** `pi::transport_spec`: unified spec restricted to the connection fields. */
export function transportSpec(spec: Record<string, unknown>): Record<string, unknown> {
  const unified = unifiedSpec(spec);
  const transport: Record<string, unknown> = {};
  for (const field of TRANSPORT_FIELDS) {
    if (field in unified) transport[field] = unified[field];
  }
  return transport;
}

/** Saved Pi fields -> the starting point when the native entry no longer exists. */
function piFields(spec: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const field of PI_FIELDS) {
    if (field in spec) fields[field] = spec[field];
  }
  return fields;
}

/** `pi::read`: a missing file is a fresh document; malformed files are errors. */
function readDocument(path: string): Record<string, unknown> {
  const text = readTextFile(path);
  if (text === undefined) return { [SECTION]: {} };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw configError("Invalid Pi MCP JSON");
  }
  if (!isObject(value)) throw configError("Invalid Pi mcpServers object");
  if (value[SECTION] !== undefined && !isObject(value[SECTION])) {
    throw configError("Invalid Pi mcpServers object");
  }
  return value;
}

function writeDocument(path: string, document: Record<string, unknown>): void {
  // Rust `atomic_write_private(serde_json::to_string_pretty(...))`: no trailing newline.
  writeTextFile(path, JSON.stringify(document, null, 2), true);
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

function read(): NativeRead {
  const entries = new Map<string, NativeEntry>();
  let path: string;
  try {
    path = piMcpPath();
    requireNativeReadPath("pi", path);
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
      entries.set(id, decode(native));
    } catch {
      invalid = true;
    }
  }
  return invalid
    ? { entries, files, initialized, error: INVALID_NATIVE }
    : { entries, files, initialized };
}

/** Mirror `pi::sync_file_overridden`: only the transport fields are replaced. */
function syncFile(id: string, change: PiChange, patch?: unknown): void {
  const path = piMcpPath();
  const document = readDocument(path);
  if (document[SECTION] === undefined) document[SECTION] = {};
  const servers = asObject(document[SECTION]);
  switch (change.kind) {
    case "enable": {
      validateEntry(id, change.spec);
      checkNameCollision(id, Object.keys(servers));
      const transport = nativeTransport(change.spec);
      const existing = servers[id];
      if (existing !== undefined && !isObject(existing)) {
        throw configError("Invalid Pi MCP entry");
      }
      // A surviving entry wins (the user may have edited it in Pi); otherwise
      // rebuild from the Pi fields stored in the connection definition.
      const merged: Record<string, unknown> = existing === undefined
        ? piFields(change.spec)
        : structuredClone(asObject(existing));
      for (const field of TRANSPORT_FIELDS) delete merged[field];
      Object.assign(merged, transport);
      // The caller folds the saved override (and the previous effective spec)
      // into `spec`, exactly the patch Rust applies to native-only options.
      applyOptions(merged, change.spec, TRANSPORT_FIELDS);
      merged.enabled = true;
      servers[id] = merged;
      break;
    }
    case "disable": {
      const entry = servers[id];
      // Nothing to disable: Rust never creates an entry just to disable it.
      if (!isObject(entry)) return;
      applyOptions(entry, patch, TRANSPORT_FIELDS);
      entry.enabled = false;
      break;
    }
    case "remove": {
      if (!(id in servers)) return;
      delete servers[id];
      break;
    }
  }
  writeDocument(path, document);
}

/** Mirror `pi::sync_overridden` when Pi is installed. */
function enable(id: string, spec: Record<string, unknown>): void {
  if (!installed()) {
    // Pi is not installed: still reject what Pi would reject.
    validateEntry(id, spec);
    return;
  }
  syncFile(id, { kind: "enable", spec });
}

function disable(id: string, spec?: Record<string, unknown>): void {
  if (!installed()) return;
  // `enabled: false` keeps the entry and Pi's own settings for re-enable.
  syncFile(id, { kind: "disable" }, spec);
}

function remove(id: string): void {
  syncFile(id, { kind: "remove" });
}

function syncOne(server: McpServer): void {
  enable(server.id, server.server);
}

function syncAll(servers: McpServer[]): void {
  // Rust `project_servers_to_app`: a false Pi flag never removes an entry.
  for (const server of servers) if (server.apps.pi) enable(server.id, server.server);
}

function project(spec: Record<string, unknown>): unknown {
  return nativeTransport(spec);
}

/** Snapshot comparison: the projected transport plus native-only options. */
function matches(native: NativeEntry, spec: Record<string, unknown>, patch?: unknown): boolean {
  try {
    const expected = nativeTransport(spec);
    const merged = structuredClone(native.spec);
    applyOptions(merged, patch, TRANSPORT_FIELDS);
    return deepEqual(transportSpec(native.spec), transportSpec(expected))
      && deepEqual(merged, native.spec);
  } catch {
    return false;
  }
}

export const adapter: AppAdapter = {
  app: "pi",
  section: SECTION,
  read,
  syncAll,
  syncOne,
  disable,
  remove,
  project,
  matches,
};

export const piAdapter = adapter;
