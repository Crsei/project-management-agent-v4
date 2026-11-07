/**
 * Translated from vendor/cc-switch/src-tauri/src/mcp/codex.rs (and the
 * Codex branch of mcp/snapshot.rs) at pinned cc-switch 4.0.25.
 *
 * Codex keeps MCP servers in `~/.codex/config.toml` as a top-level
 * `[mcp_servers]` table. The headless host never calls the desktop import
 * entry point; reads mirror `snapshot::decode`, while writes mirror
 * `sync_enabled_to_codex` / `sync_single_server_to_codex` /
 * `remove_server_from_codex`.
 */
import { existsSync } from "node:fs";
import { parse, stringify } from "smol-toml";
import { readTextFile, writeTextFile } from "../../config/atomic.ts";
import { codexConfigPath } from "../../config/paths.ts";
import { TomlDocument, jsonValueToToml } from "../../config/toml.ts";
import { appDir } from "../../host-context.ts";
import {
  asObject,
  deepEqual,
  readNativeError,
  type AppAdapter,
  type NativeEntry,
  type NativeRead,
} from "../adapter.ts";
import { specTransportType, validateServerSpec } from "../validation.ts";
import type { McpServer } from "../../types.ts";

const INVALID_NATIVE = "invalid_native_configuration";
const NATIVE_READ_FAILED = "native_read_failed";

/** Infer the Codex entry transport: explicit `type` first, then `url` presence. */
export function codexEntryTransportType(entry: Record<string, unknown>): string {
  const explicit = entry.type;
  if (typeof explicit === "string") return explicit;
  return "url" in entry ? "http" : "stdio";
}

/**
 * `snapshot::decode` for Codex/Grok Build entries: Codex writes auth headers as
 * `http_headers`, while the unified schema keeps them as `headers`; an entry
 * without `type` is inferred from `url`. Assignment state is not part of the
 * shared connection definition.
 */
export function tomlEntryToUnifiedSpec(value: unknown): Record<string, unknown> {
  const entry = asObject(value);
  const spec: Record<string, unknown> = { ...entry };
  if ("http_headers" in spec) {
    spec.headers = spec.http_headers;
    delete spec.http_headers;
  }
  if (!("type" in spec)) spec.type = "url" in spec ? "http" : "stdio";
  delete spec.enabled;
  delete spec.disabled;
  return spec;
}

function decodeNativeEntry(value: unknown): NativeEntry {
  const entry = asObject(value);
  const spec = tomlEntryToUnifiedSpec(entry);
  validateServerSpec(spec);
  return { spec, enabled: entry.enabled !== false };
}

/* -------------------------------------------------------------------------- */
/* JSON spec -> TOML entry table                                              */
/* -------------------------------------------------------------------------- */

/** Fields other clients understand but Codex rejects under `--strict-config`. */
const NON_CODEX_SERVER_FIELDS = ["timeout", "autoApprove"] as const;

const STDIO_SKIPPED_FIELDS = [
  "type",
  "command",
  "args",
  "env",
  "cwd",
  "url",
  "headers",
  "http_headers",
  "env_http_headers",
  "http_headers_helper",
  "bearer_token_env_var",
  "oauth_resource",
] as const;

const REMOTE_SKIPPED_FIELDS = [
  "type",
  "url",
  "headers",
  "http_headers",
  "command",
  "args",
  "env",
  "env_vars",
  "cwd",
] as const;

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") result[key] = item;
  }
  return Object.keys(result).length ? result : undefined;
}

/**
 * Shared JSON -> TOML converter (codex.rs `json_server_to_toml_table`).
 *
 * Only the chosen transport's connection fields are written: Codex refuses to
 * load a config whose stdio entry carries `url`/`headers` (or whose HTTP entry
 * carries `command`/`args`/`env`). The `type` field is never emitted because
 * `[mcp_servers.*]` infers transport from `command`/`url`.
 *
 * Grok Build reuses this converter unchanged (see grokbuild.rs).
 */
export function jsonServerToTomlTable(spec: Record<string, unknown>): Record<string, unknown> {
  const table: Record<string, unknown> = {};
  const transport = specTransportType(spec);

  if (transport === "stdio") {
    table.command = typeof spec.command === "string" ? spec.command : "";
    if (Array.isArray(spec.args)) {
      const args = spec.args.filter((item): item is string => typeof item === "string");
      if (args.length) table.args = args;
    }
    if (typeof spec.cwd === "string" && spec.cwd.trim() !== "") table.cwd = spec.cwd;
    const env = stringRecord(spec.env);
    if (env !== undefined) table.env = env;
  } else if (transport === "http" || transport === "sse") {
    table.url = typeof spec.url === "string" ? spec.url : "";
    const headers = stringRecord(spec.headers);
    if (headers !== undefined) table.http_headers = headers;
  }

  const skipped: readonly string[] =
    transport === "stdio"
      ? STDIO_SKIPPED_FIELDS
      : transport === "http" || transport === "sse"
        ? REMOTE_SKIPPED_FIELDS
        : ["type"];
  for (const [key, value] of Object.entries(spec)) {
    if (skipped.includes(key)) continue;
    const converted = jsonValueToToml(value);
    if (converted !== undefined) table[key] = converted;
  }
  return table;
}

/** Codex projection: the shared table minus fields Codex refuses to load. */
export function jsonServerToCodexTomlTable(spec: Record<string, unknown>): Record<string, unknown> {
  const table = jsonServerToTomlTable(spec);
  for (const key of NON_CODEX_SERVER_FIELDS) delete table[key];
  return table;
}

/** Round-trip a converted table through TOML so projections use native shapes. */
function projectTable(table: Record<string, unknown>): unknown {
  const parsed = asObject(parse(stringify({ entry: table })));
  return asObject(parsed.entry);
}

/* -------------------------------------------------------------------------- */
/* Native file access                                                         */
/* -------------------------------------------------------------------------- */

function shouldSync(): boolean {
  // Codex not installed/initialized: never create the directory or file.
  return existsSync(appDir("codex"));
}

function readNativeFile(): NativeRead {
  const file = codexConfigPath();
  const files = [file];
  const initialized = existsSync(file);
  let text: string | undefined;
  try {
    text = readTextFile(file);
  } catch {
    return { ...readNativeError(files, NATIVE_READ_FAILED), initialized };
  }
  if (text === undefined || text.trim() === "") return { entries: new Map(), files, initialized };

  let root: Record<string, unknown>;
  try {
    root = asObject(parse(text));
  } catch {
    return { ...readNativeError(files, INVALID_NATIVE), initialized };
  }

  const value = root.mcp_servers;
  if (value !== undefined && (value === null || typeof value !== "object" || Array.isArray(value))) {
    return { ...readNativeError(files, INVALID_NATIVE), initialized };
  }

  const entries = new Map<string, NativeEntry>();
  let invalid = false;
  for (const [id, native] of Object.entries(value ?? {})) {
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

function openDocument(text: string): TomlDocument {
  // Rust `read_and_validate_codex_config_text`: empty text is a fresh document;
  // an unparseable existing file must abort instead of being overwritten empty.
  return text.trim() === "" ? TomlDocument.empty() : TomlDocument.parse(text);
}

function writeDocument(path: string, document: TomlDocument): void {
  writeTextFile(path, document.toString(), true);
}

/* -------------------------------------------------------------------------- */
/* Adapter                                                                    */
/* -------------------------------------------------------------------------- */

export const adapter: AppAdapter = {
  app: "codex",
  section: "mcp_servers",

  read(): NativeRead {
    return readNativeFile();
  },

  /** Mirror `sync_enabled_to_codex`: replace the whole table with enabled rows. */
  syncAll(servers: McpServer[]): void {
    if (!shouldSync()) return;
    const path = codexConfigPath();
    const document = openDocument(readTextFile(path) ?? "");

    // Legacy wrong format `[mcp.servers]` is cleaned on every write.
    document.removeTableKey("mcp", "servers");

    const enabled = servers.filter((server) => server.apps.codex === true);
    if (enabled.length === 0) {
      document.removeTopLevel("mcp_servers");
      writeDocument(path, document);
      return;
    }

    const table: Record<string, unknown> = {};
    const ids = enabled.map((server) => server.id).sort();
    for (const id of ids) {
      const server = enabled.find((candidate) => candidate.id === id);
      if (server === undefined) continue;
      table[id] = jsonServerToCodexTomlTable(server.server);
    }
    document.setTopLevelTable("mcp_servers", table);
    writeDocument(path, document);
  },

  /** Mirror `sync_single_server_to_codex`, including non-table normalization. */
  syncOne(server: McpServer): void {
    if (!shouldSync()) return;
    const path = codexConfigPath();
    const document = openDocument(readTextFile(path) ?? "");
    document.removeTableKey("mcp", "servers");
    document.upsertTableEntry("mcp_servers", server.id, jsonServerToCodexTomlTable(server.server));
    writeDocument(path, document);
  },

  /** Mirror `remove_server_from_codex`: clean both the correct and legacy tables. */
  disable(id: string): void {
    this.remove(id);
  },

  remove(id: string): void {
    if (!shouldSync()) return;
    const path = codexConfigPath();
    const text = readTextFile(path);
    if (text === undefined) return;
    let document: TomlDocument;
    try {
      document = openDocument(text);
    } catch {
      // An unparseable config cannot be edited safely; Rust skips the removal.
      console.warn(`Parsing Codex config.toml failed, skipping removal of MCP server '${id}'`);
      return;
    }
    document.removeTableEntry("mcp_servers", id);
    document.removeTableKey("mcp", "servers");
    writeDocument(path, document);
  },

  project(spec: Record<string, unknown>): unknown {
    return projectTable(jsonServerToCodexTomlTable(spec));
  },

  matches(native: NativeEntry, spec: Record<string, unknown>): boolean {
    try {
      return deepEqual(
        projectTable(jsonServerToCodexTomlTable(native.spec)),
        projectTable(jsonServerToCodexTomlTable(spec)),
      );
    } catch {
      return false;
    }
  },
};

export const codexAdapter = adapter;
