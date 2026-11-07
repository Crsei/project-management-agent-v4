/**
 * Translated from vendor/cc-switch/src-tauri/src/mcp/grokbuild.rs (and the
 * Grok Build branch of mcp/snapshot.rs) at pinned cc-switch 4.0.25.
 *
 * Grok Build stores MCP servers in `~/.grok/config.toml` with the same
 * top-level `[mcp_servers]` layout as Codex. It infers transport from
 * `command`/`url` and keeps auth headers under `headers` (the shared converter
 * emits Codex's `http_headers` name, so the projection renames it).
 */
import { existsSync } from "node:fs";
import { parse, stringify } from "smol-toml";
import { readTextFile, writeTextFile } from "../../config/atomic.ts";
import { grokConfigPath } from "../../config/paths.ts";
import { TomlDocument } from "../../config/toml.ts";
import { appDir } from "../../host-context.ts";
import {
  asObject,
  deepEqual,
  readNativeError,
  type AppAdapter,
  type NativeEntry,
  type NativeRead,
} from "../adapter.ts";
import { validateServerSpec } from "../validation.ts";
import type { McpServer } from "../../types.ts";
import { jsonServerToTomlTable, tomlEntryToUnifiedSpec } from "./codex.ts";

const INVALID_NATIVE = "invalid_native_configuration";
const NATIVE_READ_FAILED = "native_read_failed";

/** Grok Build projection: shared converter plus Grok's `headers` field name. */
export function jsonServerToGrokbuildTomlTable(
  spec: Record<string, unknown>,
): Record<string, unknown> {
  const table = jsonServerToTomlTable(spec);
  // Defensive: old specs or callers may still pass an explicit transport.
  delete table.type;
  if ("http_headers" in table) {
    table.headers = table.http_headers;
    delete table.http_headers;
  }
  return table;
}

function projectTable(table: Record<string, unknown>): unknown {
  const parsed = asObject(parse(stringify({ entry: table })));
  return asObject(parsed.entry);
}

function shouldSync(): boolean {
  // Grok Build not installed/initialized: never create the directory or file.
  return existsSync(appDir("grokbuild"));
}

function readNativeFile(): NativeRead {
  const file = grokConfigPath();
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
      const entry = asObject(native);
      const spec = tomlEntryToUnifiedSpec(entry);
      validateServerSpec(spec);
      entries.set(id, { spec, enabled: entry.enabled !== false });
    } catch {
      invalid = true;
    }
  }
  return invalid
    ? { entries, files, initialized, error: INVALID_NATIVE }
    : { entries, files, initialized };
}

function openDocument(text: string): TomlDocument {
  return text.trim() === "" ? TomlDocument.empty() : TomlDocument.parse(text);
}

function writeDocument(path: string, document: TomlDocument): void {
  writeTextFile(path, document.toString(), true);
}

export const adapter: AppAdapter = {
  app: "grokbuild",
  section: "mcp_servers",

  read(): NativeRead {
    return readNativeFile();
  },

  /** Grok Build has no bulk writer upstream; mirror the Codex table shape. */
  syncAll(servers: McpServer[]): void {
    if (!shouldSync()) return;
    const path = grokConfigPath();
    const document = openDocument(readTextFile(path) ?? "");

    const enabled = servers.filter((server) => server.apps.grokbuild === true);
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
      table[id] = jsonServerToGrokbuildTomlTable(server.server);
    }
    document.setTopLevelTable("mcp_servers", table);
    writeDocument(path, document);
  },

  /** Mirror `sync_single_server_to_grokbuild`, including non-table normalization. */
  syncOne(server: McpServer): void {
    if (!shouldSync()) return;
    const path = grokConfigPath();
    const document = openDocument(readTextFile(path) ?? "");
    document.upsertTableEntry(
      "mcp_servers",
      server.id,
      jsonServerToGrokbuildTomlTable(server.server),
    );
    writeDocument(path, document);
  },

  /** Mirror `remove_server_from_grokbuild`: unparseable config is left untouched. */
  disable(id: string): void {
    this.remove(id);
  },

  remove(id: string): void {
    if (!shouldSync()) return;
    const path = grokConfigPath();
    const text = readTextFile(path);
    if (text === undefined) return;
    let document: TomlDocument;
    try {
      document = openDocument(text);
    } catch {
      console.warn(`Parsing Grok Build config.toml failed, skipping removal of MCP server '${id}'`);
      return;
    }
    document.removeTableEntry("mcp_servers", id);
    writeDocument(path, document);
  },

  project(spec: Record<string, unknown>): unknown {
    return projectTable(jsonServerToGrokbuildTomlTable(spec));
  },

  matches(native: NativeEntry, spec: Record<string, unknown>): boolean {
    try {
      return deepEqual(
        projectTable(jsonServerToGrokbuildTomlTable(native.spec)),
        projectTable(jsonServerToGrokbuildTomlTable(spec)),
      );
    } catch {
      return false;
    }
  },
};

export const grokbuildAdapter = adapter;
