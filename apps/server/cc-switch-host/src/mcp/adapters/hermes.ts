/**
 * Hermes MCP adapter.
 * Translated from vendor/cc-switch/src-tauri/src/mcp/hermes.rs, the Hermes
 * branch of mcp/snapshot.rs and hermes_config.rs (`mcp_servers` section
 * access) at pinned cc-switch 4.0.25.
 *
 * Hermes keeps servers in the `mcp_servers` mapping of `~/.hermes/config.yaml`
 * with no explicit `type`: `command` means stdio, `url` means HTTP/SSE. Hermes
 * adds per-server fields CC Switch has no UI for (`enabled`, `timeout`,
 * `tools`, `sampling`, `auth`, ...); they survive every write and are stripped
 * from the shared definition on read.
 */
import { existsSync } from "node:fs";
import { readTextFile } from "../../config/atomic.ts";
import { hermesConfigPath } from "../../config/paths.ts";
import { appDir, requireNativeReadPath } from "../../host-context.ts";
import { mcpValidation } from "../../errors.ts";
import {
  asYamlMapping,
  deduplicateTopLevelKeys,
  parseYamlValue,
  updateYamlSectionFile,
} from "../../config/yaml.ts";
import {
  type AppAdapter,
  type NativeEntry,
  type NativeRead,
  applyOptions,
  asObject,
  deepEqual,
} from "../adapter.ts";
import { specTransportType, validateServerSpec } from "../validation.ts";
import type { McpServer } from "../../types.ts";

const SECTION = "mcp_servers";
const INVALID_NATIVE = "invalid_native_configuration";
const NATIVE_READ_FAILED = "native_read_failed";

/** Hermes-only per-server fields: preserved on merge-on-write, stripped on import. */
const HERMES_EXTRA_FIELDS = [
  "enabled",
  "timeout",
  "connect_timeout",
  "tools",
  "sampling",
  "roots",
  "auth",
];

/** Fields the unified definition owns; explicit overrides may not rewrite them. */
const CONNECTION_FIELDS = ["type", "command", "args", "env", "url", "headers", "cwd"];

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Rust `should_sync_hermes_mcp`: nothing is written for an uninstalled Hermes. */
function installed(): boolean {
  return existsSync(appDir("hermes"));
}

/* -------------------------------------------------------------------------- */
/* Format conversion: unified <-> Hermes                                      */
/* -------------------------------------------------------------------------- */

/** `convert_to_hermes_format`: connection fields only, plus `enabled: true`. */
export function convertToHermesFormat(spec: Record<string, unknown>): Record<string, unknown> {
  const object = asObject(spec);
  const transport = specTransportType(object);
  const result: Record<string, unknown> = {};
  if (transport === "stdio") {
    if (Object.hasOwn(object, "command")) result.command = object.command;
    if (Array.isArray(object.args) && object.args.length > 0) result.args = object.args;
    if (isObject(object.env) && Object.keys(object.env).length > 0) result.env = object.env;
  } else if (transport === "sse" || transport === "http") {
    if (Object.hasOwn(object, "url")) result.url = object.url;
    if (isObject(object.headers) && Object.keys(object.headers).length > 0) {
      result.headers = object.headers;
    }
  } else {
    throw mcpValidation(`Unknown MCP type: ${transport}`);
  }
  result.enabled = true;
  return result;
}

/**
 * `convert_from_hermes_format`: `command` wins over `url`, HTTP entries are
 * reported as SSE, and every Hermes-only field (including `auth`) is dropped.
 */
export function convertFromHermesFormat(id: string, spec: unknown): Record<string, unknown> {
  if (!isObject(spec)) throw mcpValidation("Hermes MCP spec must be a JSON object");
  const result: Record<string, unknown> = {};
  if (Object.hasOwn(spec, "command")) {
    result.type = "stdio";
    result.command = spec.command;
    if (Array.isArray(spec.args) && spec.args.length > 0) result.args = spec.args;
    if (isObject(spec.env) && Object.keys(spec.env).length > 0) result.env = spec.env;
  } else if (Object.hasOwn(spec, "url")) {
    result.type = "sse";
    result.url = spec.url;
    if (isObject(spec.headers) && Object.keys(spec.headers).length > 0) {
      result.headers = spec.headers;
    }
  } else {
    throw mcpValidation(`Hermes MCP server '${id}' has neither 'command' nor 'url' field`);
  }
  return result;
}

/**
 * `merge_hermes_spec`: core fields come from the unified definition while every
 * Hermes-only field already on disk keeps the user's value.
 */
export function mergeHermesSpec(existing: unknown, newSpec: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const existingObject = isObject(existing) ? existing : {};
  for (const field of HERMES_EXTRA_FIELDS) {
    if (Object.hasOwn(existingObject, field)) result[field] = existingObject[field];
  }
  const newObject = isObject(newSpec) ? newSpec : {};
  for (const [key, value] of Object.entries(newObject)) {
    if (HERMES_EXTRA_FIELDS.includes(key) && Object.hasOwn(result, key)) continue;
    result[key] = value;
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* Read                                                                       */
/* -------------------------------------------------------------------------- */

function decodeEntry(id: string, native: unknown): NativeEntry {
  const entry = asObject(native);
  const spec = convertFromHermesFormat(id, entry);
  validateServerSpec(spec);
  return { spec, enabled: entry.enabled !== false };
}

function read(): NativeRead {
  const entries = new Map<string, NativeEntry>();
  const files: string[] = [];
  let path: string;
  try {
    path = hermesConfigPath();
    requireNativeReadPath("hermes", path);
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
    document = text.trim() === ""
      ? {}
      : asYamlMapping(
        parseYamlValue(deduplicateTopLevelKeys(text)),
        "Failed to parse Hermes config as YAML",
      );
  } catch {
    return { entries, files, initialized: true, error: INVALID_NATIVE };
  }

  const section = document[SECTION];
  // Present but not a mapping (including null) is a broken section, exactly as
  // the snapshot reader treats `mcp_servers` that is not an object.
  if (section !== undefined && !isObject(section)) {
    return { entries, files, initialized: true, error: INVALID_NATIVE };
  }
  let error: string | undefined;
  for (const [id, native] of Object.entries(isObject(section) ? section : {})) {
    let entry: NativeEntry;
    try {
      entry = decodeEntry(id, native);
    } catch {
      error = INVALID_NATIVE;
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

/* -------------------------------------------------------------------------- */
/* Write                                                                      */
/* -------------------------------------------------------------------------- */

function editServers(update: (servers: Record<string, unknown>) => void): void {
  if (!installed()) return;
  updateYamlSectionFile(hermesConfigPath(), SECTION, update);
}

function syncOne(server: McpServer): void {
  if (!installed()) return;
  const spec = convertToHermesFormat(server.server);
  editServers((servers) => {
    const merged = Object.hasOwn(servers, server.id)
      ? mergeHermesSpec(servers[server.id], spec)
      : { ...spec };
    // The caller hands over the native projection: connection fields are
    // replaced from the definition, every other field is an option override.
    applyOptions(merged, server.server, CONNECTION_FIELDS);
    servers[server.id] = merged;
  });
}

/** Toggle-off: Hermes has no disable marker, the live entry is removed. */
function disable(id: string): void {
  remove(id);
}

/** Mirror `remove_server_from_hermes`. */
function remove(id: string): void {
  editServers((servers) => {
    delete servers[id];
  });
}

/** Mirror the Hermes branch of `project_servers_to_app`. */
function syncAll(servers: McpServer[]): void {
  if (!installed()) return;
  for (const server of servers) {
    if (server.apps.hermes === true) syncOne(server);
    else remove(server.id);
  }
}

/* -------------------------------------------------------------------------- */
/* Adapter                                                                    */
/* -------------------------------------------------------------------------- */

export const adapter: AppAdapter = {
  app: "hermes",
  section: SECTION,

  read,

  syncAll,

  syncOne,

  disable,

  remove,

  project(spec: Record<string, unknown>): unknown {
    return convertToHermesFormat(spec);
  },

  /**
   * The Hermes branch of `NativeSnapshot::matches`: merge the projection onto the
   * entry as it is on disk (Hermes-only fields stay), apply the override options,
   * and require that this leaves the native entry unchanged.
   *
   * Decoded entries drop Hermes-only fields, so the raw entry is located by its
   * decoded connection definition; two servers with identical transports are
   * interchangeable for this comparison.
   */
  matches(native: NativeEntry, spec: Record<string, unknown>, patch?: unknown): boolean {
    try {
      const text = readTextFile(hermesConfigPath());
      if (text === undefined) return false;
      const document = text.trim() === ""
        ? {}
        : asYamlMapping(
          parseYamlValue(deduplicateTopLevelKeys(text)),
          "Failed to parse Hermes config as YAML",
        );
      const section = document[SECTION];
      if (section === null || section === undefined || !isObject(section)) return false;
      const expected = convertToHermesFormat(spec);
      for (const raw of Object.values(section)) {
        if (!isObject(raw)) continue;
        let decoded: Record<string, unknown>;
        try {
          decoded = convertFromHermesFormat("", raw);
        } catch {
          continue;
        }
        if (!deepEqual(decoded, native.spec)) continue;
        const merged = mergeHermesSpec(raw, expected);
        applyOptions(merged, patch, CONNECTION_FIELDS);
        if (deepEqual(merged, raw)) return true;
      }
      return false;
    } catch {
      return false;
    }
  },
};

export const hermesAdapter = adapter;
