/**
 * Translated from vendor/cc-switch/src-tauri/src/mcp/opencode.rs and the
 * OpenCode MCP accessors in vendor/cc-switch/src-tauri/src/opencode_config.rs
 * at pinned cc-switch 4.0.25. Reads mirror `snapshot::decode`; writes mirror
 * `set_mcp_server` / `remove_mcp_server` through the format-preserving JSONC
 * document (comments and unrelated keys survive every edit).
 *
 * Format mapping (unified -> OpenCode):
 * - `stdio` -> `local`, `command` + `args` -> `command` array, `env` -> `environment`
 * - `sse`/`http` -> `remote`, `url`/`headers` preserved
 * - every written entry carries `enabled: true`; `enabled: false` is only read
 */
import { existsSync } from "node:fs";
import { AppError, mcpValidation } from "../../errors.ts";
import { editJsoncFile, isJsonObject, readJsoncFile, type JsoncFileContents } from "../../config/jsonc.ts";
import { opencodeConfigPath } from "../../config/paths.ts";
import { appDir } from "../../host-context.ts";
import {
  deepEqual,
  mergePatch,
  readNativeError,
  type AppAdapter,
  type NativeEntry,
  type NativeRead,
} from "../adapter.ts";
import { specTransportType, validateServerSpec } from "../validation.ts";
import type { McpServer } from "../../types.ts";

const INVALID_NATIVE = "invalid_native_configuration";
const NATIVE_READ_FAILED = "native_read_failed";

/** `mcp/opencode.rs::convert_to_opencode_format`. */
export function convertToOpenCodeFormat(spec: Record<string, unknown>): Record<string, unknown> {
  if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
    throw mcpValidation("MCP spec must be a JSON object");
  }
  const transport = specTransportType(spec);
  const result: Record<string, unknown> = {};

  if (transport === "stdio") {
    result.type = "local";
    const command = typeof spec.command === "string" ? spec.command : "";
    result.command = [command, ...(Array.isArray(spec.args) ? spec.args : [])];
    if (isJsonObject(spec.env) && Object.keys(spec.env).length > 0) {
      result.environment = spec.env;
    }
    result.enabled = true;
    return result;
  }
  if (transport === "sse" || transport === "http") {
    result.type = "remote";
    if (spec.url !== undefined) result.url = spec.url;
    if (isJsonObject(spec.headers) && Object.keys(spec.headers).length > 0) {
      result.headers = spec.headers;
    }
    result.enabled = true;
    return result;
  }
  throw mcpValidation(`Unknown MCP type: ${transport}`);
}

/** `mcp/opencode.rs::convert_from_opencode_format`. */
export function convertFromOpenCodeFormat(spec: Record<string, unknown>): Record<string, unknown> {
  if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
    throw mcpValidation("OpenCode MCP spec must be a JSON object");
  }
  const transport = typeof spec.type === "string" ? spec.type : "local";
  const result: Record<string, unknown> = {};

  if (transport === "local") {
    result.type = "stdio";
    if (Array.isArray(spec.command) && spec.command.length > 0) {
      const [command, ...args] = spec.command;
      if (typeof command === "string") result.command = command;
      if (args.length > 0) result.args = args;
    }
    if (isJsonObject(spec.environment) && Object.keys(spec.environment).length > 0) {
      result.env = spec.environment;
    }
    return result;
  }
  if (transport === "remote") {
    // OpenCode `remote` has no protocol marker; the unified default is SSE.
    result.type = "sse";
    if (spec.url !== undefined) result.url = spec.url;
    if (isJsonObject(spec.headers) && Object.keys(spec.headers).length > 0) {
      result.headers = spec.headers;
    }
    return result;
  }
  throw mcpValidation(`Unknown OpenCode MCP type: ${transport}`);
}

function decodeNativeEntry(value: unknown): NativeEntry {
  if (!isJsonObject(value)) throw mcpValidation("OpenCode MCP spec must be a JSON object");
  const spec = convertFromOpenCodeFormat(value);
  delete spec.enabled;
  delete spec.disabled;
  validateServerSpec(spec);
  return { spec, enabled: value.enabled !== false };
}

/* -------------------------------------------------------------------------- */
/* Native file access                                                         */
/* -------------------------------------------------------------------------- */

/** `should_sync_opencode_mcp`: never create the OpenCode directory or file. */
function shouldSync(): boolean {
  return existsSync(appDir("opencode"));
}

function readNativeFile(): NativeRead {
  const file = opencodeConfigPath();
  const files = [file];
  const initialized = existsSync(file);

  let contents: JsoncFileContents;
  try {
    contents = readJsoncFile(file);
  } catch (error) {
    const invalid = error instanceof AppError && error.code === "CONFIG";
    return { ...readNativeError(files, invalid ? INVALID_NATIVE : NATIVE_READ_FAILED), initialized };
  }
  const value = contents.value;
  if (value === undefined) return { entries: new Map(), files, initialized };

  const section = value.mcp;
  if (section !== undefined && !isJsonObject(section)) {
    return { ...readNativeError(files, INVALID_NATIVE), initialized };
  }

  const entries = new Map<string, NativeEntry>();
  let invalid = false;
  for (const [id, native] of Object.entries(section ?? {})) {
    try {
      entries.set(id, decodeNativeEntry(native));
    } catch {
      invalid = true;
    }
  }
  return invalid
    ? { entries, files, initialized, error: INVALID_NATIVE }
    : { entries, files, initialized };
}

/** `opencode_config::set_mcp_server`: normalize a malformed section, then upsert. */
function writeNativeEntry(id: string, native: Record<string, unknown>): void {
  editJsoncFile(opencodeConfigPath(), (root) => {
    const section = isJsonObject(root.mcp) ? root.mcp : {};
    root.mcp = { ...section, [id]: native };
  });
}

/** `opencode_config::remove_mcp_server`: absent file/section is a no-op. */
function removeNativeEntry(id: string): void {
  editJsoncFile(
    opencodeConfigPath(),
    (root) => {
      if (isJsonObject(root.mcp)) delete root.mcp[id];
    },
    { create: false },
  );
}

/* -------------------------------------------------------------------------- */
/* Adapter                                                                    */
/* -------------------------------------------------------------------------- */

export const adapter: AppAdapter = {
  app: "opencode",
  section: "mcp",

  read(): NativeRead {
    return readNativeFile();
  },

  /** Mirror `project_servers_to_app`: enabled rows are written, unassigned rows removed. */
  syncAll(servers: McpServer[]): void {
    if (!shouldSync()) return;
    for (const server of servers) {
      if (server.apps.opencode) writeNativeEntry(server.id, convertToOpenCodeFormat(server.server));
      else removeNativeEntry(server.id);
    }
  },

  syncOne(server: McpServer): void {
    if (!shouldSync()) return;
    writeNativeEntry(server.id, convertToOpenCodeFormat(server.server));
  },

  /** OpenCode has no tombstone: toggling off removes the native entry. */
  disable(id: string): void {
    if (!shouldSync()) return;
    removeNativeEntry(id);
  },

  remove(id: string): void {
    if (!shouldSync()) return;
    removeNativeEntry(id);
  },

  project(spec: Record<string, unknown>): unknown {
    return convertToOpenCodeFormat(spec);
  },

  /**
   * OpenCode replaces the whole entry on every write and has no native-only
   * options, so the comparison uses the effective spec. Assignment state is
   * compared by the snapshot layer, not here.
   */
  matches(native: NativeEntry, spec: Record<string, unknown>, patch?: unknown): boolean {
    try {
      const expected = isJsonObject(patch)
        ? (mergePatch(spec, patch) as Record<string, unknown>)
        : spec;
      return deepEqual(convertToOpenCodeFormat(native.spec), convertToOpenCodeFormat(expected));
    } catch {
      return false;
    }
  },
};

export const opencodeAdapter = adapter;
