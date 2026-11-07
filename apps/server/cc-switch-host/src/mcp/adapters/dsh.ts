/**
 * DeepSeek Harness MCP adapter.
 * Translated from vendor/cc-switch/src-tauri/src/mcp/dsh.rs, the MCP section of
 * dsh_config.rs and the DSH branch of mcp/snapshot.rs at pinned cc-switch
 * 4.0.25.
 *
 * DSH keeps MCP servers as `@deepseek-ai/dsh-mcp-client` plugin overrides in
 * `profiles/<name>/cordis.patch.yml`. Every initialized profile (`web`,
 * `desktop` and any created `headless` / `acp`) is written as one logical
 * change: entries are spliced into the patch text so unrelated overrides,
 * comments and dynamic `!!js` nodes stay byte-identical, and profiles that
 * disagree about a server are rejected instead of silently overwritten.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import path from "node:path";
import { isMap, isNode, isScalar, isSeq, type Node } from "yaml";
import { atomicWrite, readTextFile, writeTextFile } from "../../config/atomic.ts";
import { dshConfigPath, dshTargetPaths } from "../../config/paths.ts";
import { requireNativeReadPath } from "../../host-context.ts";
import { AppError, configError, conflict, invalidInput, ioError } from "../../errors.ts";
import {
  hasDynamicYamlNode,
  hasYamlReferenceTokens,
  parseYamlSequence,
  stringifyYaml,
  type ParsedYamlSequence,
} from "../../config/yaml.ts";
import {
  type AppAdapter,
  type NativeEntry,
  type NativeRead,
  applyOptions,
  asObject,
  deepEqual,
} from "../adapter.ts";
import { validateServerSpec } from "../validation.ts";
import type { McpServer } from "../../types.ts";

const SECTION = "mcpServers";
const MCP_CLIENT_PLUGIN = "@deepseek-ai/dsh-mcp-client";
const INVALID_NATIVE = "invalid_native_configuration";
const NATIVE_READ_FAILED = "native_read_failed";
const NATIVE_PROFILES_CONFLICT = "native_profiles_conflict";
const INVALID_PROFILE = "Invalid DeepSeek Harness profile YAML";
const STALE_LOCK_AGE_MS = 10 * 60 * 1000;

/** Fields the unified definition owns; explicit overrides may not rewrite them. */
const CONNECTION_FIELDS = ["command", "args", "env", "cwd", "url", "headers", "type"];
/** Fields rewritten from the unified definition on every edit. */
const REPLACED_CONFIG_FIELDS = ["command", "args", "env", "cwd", "url", "headers", "transport"];

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function entryId(value: unknown): string | undefined {
  return isObject(value) && typeof value.id === "string" ? value.id : undefined;
}

function profileName(file: string): string {
  return path.basename(path.dirname(file)) || "profile";
}

/* -------------------------------------------------------------------------- */
/* Profile patch parsing                                                      */
/* -------------------------------------------------------------------------- */

interface ProfileEntry {
  /** Top-level patch index. */
  index: number;
  /** Position inside the patch's `insert` sequence, when the entry lives there. */
  insertIndex?: number;
  value: unknown;
  /** The entry carries a tag (`!!js`, custom) that cannot round-trip as JSON. */
  dynamic: boolean;
}

function insertItemNodes(node: Node | null): (Node | null)[] {
  if (node === null || !isMap(node)) return [];
  const pair = node.items.find((item) => isScalar(item.key) && item.key.value === "insert");
  if (pair === undefined || !isSeq(pair.value)) return [];
  return pair.value.items.map((item) => (isNode(item) ? item : null));
}

function parseProfile(text: string): ParsedYamlSequence {
  return parseYamlSequence(text, INVALID_PROFILE);
}

/** Every patch entry plus each entry of its `insert` list, in file order. */
function pluginEntries(parsed: ParsedYamlSequence): ProfileEntry[] {
  const result: ProfileEntry[] = [];
  parsed.values.forEach((value, index) => {
    const node = parsed.nodes[index] ?? null;
    result.push({ index, value, dynamic: hasDynamicYamlNode(node) });
    if (!isObject(value) || !Array.isArray(value.insert)) return;
    const nodes = insertItemNodes(node);
    value.insert.forEach((inserted, insertIndex) => {
      result.push({
        index,
        insertIndex,
        value: inserted,
        dynamic: hasDynamicYamlNode(nodes[insertIndex] ?? null),
      });
    });
  });
  return result;
}

function mcpClientEntry(value: unknown): Record<string, unknown> | undefined {
  if (!isObject(value) || value.name !== MCP_CLIENT_PLUGIN) return undefined;
  return value;
}

function isMcpServerEntry(value: unknown, id: string): boolean {
  const entry = mcpClientEntry(value);
  if (entry === undefined) return false;
  const config = entry.config;
  return isObject(config) && config.serverName === id;
}

/** `mcp_entries_from`: MCP client plugin entries in file order. */
export function mcpEntriesFrom(text: string): unknown[] {
  return pluginEntries(parseProfile(text))
    .filter((candidate) => mcpClientEntry(candidate.value) !== undefined)
    .map((candidate) => candidate.value);
}

function existingMcpEntry(text: string, id: string): ProfileEntry | undefined {
  return pluginEntries(parseProfile(text))
    .find((candidate) => isMcpServerEntry(candidate.value, id));
}

/* -------------------------------------------------------------------------- */
/* Text splicing                                                              */
/* -------------------------------------------------------------------------- */

/** `str::lines` equivalent: splits on `\n`, keeping a trailing `\r` off the token. */
function lines(text: string): string[] {
  return text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

function splitInclusiveLines(text: string): string[] {
  const result: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") {
      result.push(text.slice(start, index + 1));
      start = index + 1;
    }
  }
  if (start < text.length) result.push(text.slice(start));
  return result;
}

function splicePatch(
  text: string,
  parsed: unknown[],
  index: number | undefined,
  entry: unknown | undefined,
): string {
  // DSH requires a sequence even when the last patch is removed.
  const empty = parsed.length === 0 || (parsed.length === 1 && index !== undefined) ? "[]\n" : "";
  const reserialized = entry !== undefined;
  const replacement = entry !== undefined ? stringifyYaml([entry]) : empty;
  if (parsed.length === 0) {
    // Native profiles start with comments followed by `[]`; appending a block
    // entry to that flow sequence would produce invalid YAML.
    let next = splitInclusiveLines(text)
      .filter((line) => line.trim() === "" || line.trimStart().startsWith("#"))
      .join("");
    if (next !== "" && !next.endsWith("\n")) next += "\n";
    return next + replacement;
  }
  const starts: number[] = [];
  let offset = 0;
  for (const line of splitInclusiveLines(text)) {
    if (line.startsWith("- ") || line.trimEnd() === "-") starts.push(offset);
    offset += line.length;
  }
  if (parsed.length !== starts.length) {
    throw configError("Use block-style YAML for the DeepSeek Harness profile");
  }
  if (index !== undefined) {
    const end = index + 1 < starts.length ? starts[index + 1] : text.length;
    // The serializer drops `!!js` tags and expands anchors, so rewriting such an
    // entry would silently change what DSH evaluates.
    if (reserialized && lines(text.slice(starts[index], end)).some((line) => hasYamlReferenceTokens(line))) {
      throw configError(
        "This DeepSeek Harness profile entry uses YAML tags (such as !!js), anchors or aliases; edit it in cordis.patch.yml directly",
      );
    }
    return text.slice(0, starts[index]) + replacement + text.slice(end);
  }
  if (replacement === "") return text;
  return text + (text === "" || text.endsWith("\n") ? "" : "\n") + replacement;
}

function replacePatch(
  text: string,
  parsed: unknown[],
  index: number | undefined,
  entry: unknown | undefined,
): string {
  const next = splicePatch(text, parsed, index, entry);
  // Removing or rewriting an entry can strand an alias whose anchor lived in
  // it; refuse rather than write a profile DSH can no longer load.
  try {
    parseProfile(next);
  } catch {
    throw configError("This change would leave a YAML alias without its anchor; edit cordis.patch.yml directly");
  }
  return next;
}

/** Copy an existing profile entry into a profile that does not have it yet. */
function insertMcpEntry(text: string, source: ProfileEntry): string {
  if (source.dynamic) {
    throw configError(
      "This DeepSeek Harness MCP entry contains dynamic YAML; edit it in DeepSeek Harness",
    );
  }
  const parsed = parseProfile(text);
  const id = entryId(source.value);
  if (id !== undefined && pluginEntries(parsed).some((candidate) => entryId(candidate.value) === id)) {
    throw conflict(`DeepSeek Harness plugin id '${id}' is already in use`);
  }
  return replacePatch(text, parsed.values, undefined, { insert: [source.value] });
}

/* -------------------------------------------------------------------------- */
/* MCP editing                                                                */
/* -------------------------------------------------------------------------- */

function configObject(value: unknown): Record<string, unknown> | undefined {
  if (!isObject(value)) return undefined;
  return isObject(value.config) ? { ...value.config } : undefined;
}

function buildEntry(
  existing: unknown | undefined,
  id: string,
  spec: Record<string, unknown>,
  patch: unknown,
): Record<string, unknown> {
  const entry: Record<string, unknown> = existing !== undefined && isObject(existing)
    ? { ...existing }
    : { id: `cc-switch-mcp-${id}`, name: MCP_CLIENT_PLUGIN, config: {} };
  delete entry.disabled;
  const config = configObject(entry);
  if (config === undefined) throw configError("Invalid DeepSeek Harness MCP configuration");
  for (const field of REPLACED_CONFIG_FIELDS) delete config[field];
  for (const [key, value] of Object.entries(spec)) if (key !== "type") config[key] = value;
  applyOptions(config, patch, CONNECTION_FIELDS);
  config.serverName = id;
  config.transport = Object.hasOwn(spec, "url") ? "streamable-http" : "stdio";
  entry.config = config;
  return entry;
}

/**
 * One profile's text with MCP server `id` added, replaced or (when `spec` is
 * undefined) removed. `patch` carries native options applied on top.
 */
export function mcpEditOverridden(
  text: string,
  id: string,
  spec: Record<string, unknown> | undefined,
  patch?: unknown,
): string {
  const parsed = parseProfile(text);
  const entries = pluginEntries(parsed);
  const matches = entries.filter((candidate) => isMcpServerEntry(candidate.value, id));
  if (matches.length > 1) throw configError(`Duplicate DeepSeek Harness MCP server '${id}'`);
  const location = matches[0];
  const existing = location?.value;
  if (existing === undefined && spec === undefined) return text;

  const existingId = entryId(existing);
  const pluginId = existingId ?? `cc-switch-mcp-${id}`;
  if (existing !== undefined && existingId === undefined) {
    throw configError("Assign an id to this native MCP entry before editing it in CC Switch");
  }
  const idMatches = entries.filter((candidate) => entryId(candidate.value) === pluginId).length;
  if (idMatches > (existing !== undefined ? 1 : 0)) {
    throw conflict(`DeepSeek Harness plugin id '${pluginId}' is already in use`);
  }

  const next = spec === undefined ? undefined : buildEntry(existing, id, spec, patch);
  if (location === undefined) {
    return replacePatch(text, parsed.values, undefined, next === undefined ? undefined : { insert: [next] });
  }
  if (location.insertIndex === undefined) {
    return replacePatch(text, parsed.values, location.index, next);
  }
  const patchEntry = parsed.values[location.index];
  const source: Record<string, unknown> = isObject(patchEntry) ? patchEntry : {};
  const inserted = Array.isArray(source.insert) ? [...source.insert] : [];
  if (next === undefined) inserted.splice(location.insertIndex, 1);
  else inserted[location.insertIndex] = next;
  const updated = inserted.length === 0 ? undefined : { ...source, insert: inserted };
  return replacePatch(text, parsed.values, location.index, updated);
}

function mcpEditWithSource(
  text: string,
  id: string,
  spec: Record<string, unknown> | undefined,
  source: ProfileEntry | undefined,
  patch: unknown,
): string {
  // A missing copy inherits the native plugin id and extension fields of an
  // existing copy, so creating it does not manufacture a conflict later.
  if (source !== undefined && spec !== undefined && existingMcpEntry(text, id) === undefined) {
    return mcpEditOverridden(insertMcpEntry(text, source), id, spec, patch);
  }
  return mcpEditOverridden(text, id, spec, patch);
}

/* -------------------------------------------------------------------------- */
/* Read                                                                       */
/* -------------------------------------------------------------------------- */

function decodeEntry(value: unknown): NativeEntry {
  const entry = asObject(value);
  const config = asObject(entry.config);
  const kind = config.transport;
  delete config.serverName;
  delete config.transport;
  const spec: Record<string, unknown> = { ...config };
  if (kind === "stdio") spec.type = "stdio";
  else if (kind === "streamable-http") spec.type = "http";
  else throw configError("Invalid DeepSeek Harness MCP transport");
  delete spec.enabled;
  delete spec.disabled;
  validateServerSpec(spec);
  return { spec, enabled: entry.disabled !== true };
}

function read(): NativeRead {
  const entries = new Map<string, NativeEntry>();
  const files: string[] = [];
  let error: string | undefined;
  let initialized = false;

  for (const file of dshTargetPaths()) {
    try {
      requireNativeReadPath("dsh", file);
    } catch {
      error = NATIVE_READ_FAILED;
      continue;
    }
    let text: string | undefined;
    try {
      text = readTextFile(file);
    } catch {
      error = NATIVE_READ_FAILED;
      continue;
    }
    files.push(file);
    if (text === undefined) continue;
    initialized = true;

    let parsed: ParsedYamlSequence;
    try {
      parsed = parseProfile(text);
    } catch {
      error = INVALID_NATIVE;
      continue;
    }
    const servers: [string, unknown][] = [];
    const names = new Set<string>();
    let fileInvalid = false;
    for (const candidate of pluginEntries(parsed)) {
      if (mcpClientEntry(candidate.value) === undefined) continue;
      // serde_yaml tags cannot be represented as JSON, so the upstream reader
      // treats such an entry as an unreadable profile.
      if (candidate.dynamic) {
        fileInvalid = true;
        break;
      }
      const entry = isObject(candidate.value) ? candidate.value : undefined;
      const config = entry === undefined ? undefined : entry.config;
      if (!isObject(config) || typeof config.serverName !== "string") {
        fileInvalid = true;
        break;
      }
      if (names.has(config.serverName)) {
        fileInvalid = true;
        break;
      }
      names.add(config.serverName);
      servers.push([config.serverName, candidate.value]);
    }
    if (fileInvalid) {
      error = INVALID_NATIVE;
      continue;
    }
    for (const [id, native] of servers) {
      let decoded: NativeEntry;
      try {
        decoded = decodeEntry(native);
      } catch {
        error = INVALID_NATIVE;
        continue;
      }
      const previous = entries.get(id);
      if (previous === undefined) {
        entries.set(id, decoded);
      } else if (!deepEqual(previous.spec, decoded.spec) || previous.enabled !== decoded.enabled) {
        error = NATIVE_PROFILES_CONFLICT;
      }
    }
  }
  return error === undefined
    ? { entries, files, initialized }
    : { entries, files, initialized, error };
}

/* -------------------------------------------------------------------------- */
/* Multi-profile transactional writes                                         */
/* -------------------------------------------------------------------------- */

function processIsAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function clearStaleLock(lock: string): boolean {
  let ownerGone = false;
  try {
    const pid = Number.parseInt(readFileSync(lock, "utf8").trim(), 10);
    ownerGone = Number.isFinite(pid) && !processIsAlive(pid);
  } catch {
    ownerGone = false;
  }
  let tooOld = false;
  try {
    tooOld = Date.now() - statSync(lock).mtimeMs > STALE_LOCK_AGE_MS;
  } catch {
    tooOld = false;
  }
  if (!ownerGone && !tooOld) return false;
  try {
    rmSync(lock);
    return true;
  } catch {
    return false;
  }
}

function createLock(lock: string): () => void {
  const descriptor = createExclusiveFile(lock);
  try {
    writeSync(descriptor, `${process.pid}\n`);
  } catch (cause) {
    try {
      rmSync(lock, { force: true });
    } catch {
      // Preserve the original failure.
    }
    throw ioError(lock, cause);
  } finally {
    closeSync(descriptor);
  }
  return () => {
    try {
      rmSync(lock, { force: true });
    } catch {
      // Lock cleanup is best effort; a stale lock is cleared by the next writer.
    }
  };
}

function createExclusiveFile(lock: string): number {
  try {
    return openSync(lock, "wx", 0o600);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
      throw conflict("DeepSeek Harness is saving its configuration; retry shortly");
    }
    throw ioError(lock, cause);
  }
}

/** Same `<file>.lock` exclusive-create protocol as dsh-atomic-write. */
function acquireLock(file: string): () => void {
  const lock = `${file}.lock`;
  // Preparing Web and Desktop may create their profile directory on first write.
  mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  try {
    return createLock(lock);
  } catch (cause) {
    if (!(cause instanceof AppError) || cause.code !== "CONFLICT") throw cause;
    if (!clearStaleLock(lock)) throw cause;
    return createLock(lock);
  }
}

function restore(file: string, previous: Buffer | undefined): void {
  if (previous !== undefined) {
    atomicWrite(file, previous, 0o600);
    return;
  }
  try {
    rmSync(file);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw ioError(file, cause);
  }
}

/**
 * Edit every profile as one change: each file holds its own DSH `<file>.lock`,
 * an invalid edit writes nothing, and a failed write restores every file that
 * was already written.
 */
function editFilesAndCommit(files: string[], plan: (texts: string[]) => string[]): void {
  const lockOrder = files.map((_, index) => index)
    .sort((left, right) => (files[left] < files[right] ? -1 : files[left] > files[right] ? 1 : 0));
  const releases: (() => void)[] = [];
  try {
    for (const index of lockOrder) releases.push(acquireLock(files[index]));
    const previous: (Buffer | undefined)[] = [];
    const current: string[] = [];
    for (const file of files) {
      let bytes: Buffer | undefined;
      try {
        bytes = readFileSync(file);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw ioError(file, cause);
      }
      previous.push(bytes);
      current.push(bytes === undefined ? "" : bytes.toString("utf8"));
    }
    const next = plan(current);
    if (next.length !== files.length) {
      throw configError(
        `DeepSeek Harness write plan returned ${next.length} file(s) for ${files.length} file(s); nothing was written`,
      );
    }
    const written: number[] = [];
    try {
      files.forEach((file, index) => {
        if (current[index] === next[index]) return;
        writeTextFile(file, next[index], true);
        written.push(index);
      });
    } catch (cause) {
      const failures: string[] = [];
      for (const index of written.reverse()) {
        try {
          restore(files[index], previous[index]);
        } catch (rollback) {
          failures.push(String(rollback));
        }
      }
      if (failures.length === 0) throw cause;
      throw configError(`${String(cause)}; restoring DeepSeek Harness configuration failed: ${failures.join("; ")}`);
    }
  } finally {
    for (const release of releases.reverse()) release();
  }
}

function authoritativeIndex(files: string[]): number {
  const index = files.indexOf(dshConfigPath());
  return index < 0 ? 0 : index;
}

function divergedError(id: string, other: string | undefined, source: string | undefined): AppError {
  const otherName = other === undefined ? "" : profileName(other);
  const sourceName = source === undefined ? "" : profileName(source);
  return configError(
    `MCP server '${id}' differs between the '${otherName}' and the '${sourceName}' profiles; writing would discard your changes in '${otherName}'. Make them identical in DeepSeek Harness, or edit profiles/${otherName}/cordis.patch.yml directly.`,
  );
}

/**
 * Compare existing copies, preferring the displayed profile when it has one. A
 * missing copy is expected when a profile was initialized later; only differing
 * contents are a conflict.
 */
function ensureMcpCopiesAgree(
  files: string[],
  authoritative: number,
  texts: string[],
  id: string,
): ProfileEntry | undefined {
  let source: { index: number; entry: ProfileEntry } | undefined;
  const authoritativeText = texts[authoritative];
  if (authoritativeText !== undefined) {
    const found = existingMcpEntry(authoritativeText, id);
    if (found !== undefined) source = { index: authoritative, entry: found };
  }
  for (let index = 0; index < texts.length; index += 1) {
    const copy = existingMcpEntry(texts[index], id);
    if (copy === undefined) continue;
    if (source !== undefined) {
      if (!deepEqual(copy.value, source.entry.value)) {
        throw divergedError(id, files[index], files[source.index]);
      }
    } else {
      source = { index, entry: copy };
    }
  }
  return source?.entry;
}

function syncSpec(id: string, spec: Record<string, unknown> | undefined, patch?: unknown): void {
  if (spec !== undefined) validateMcpSpec(id, spec);
  const files = spec === undefined ? dshTargetPaths().filter(existsSync) : dshTargetPaths();
  if (files.length === 0) return;
  editFilesAndCommit(files, (texts) => {
    const source = ensureMcpCopiesAgree(files, authoritativeIndex(files), texts, id);
    return texts.map((text) => mcpEditWithSource(text, id, spec, source, patch));
  });
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * `validate_mcp_spec`: DSH accepts stdio and Streamable HTTP only, and server
 * names must be a 1-32 character `[A-Za-z0-9_-]` identifier.
 */
export function validateMcpSpec(id: string, spec: Record<string, unknown>): void {
  validateServerSpec(spec);
  if (spec.type === "sse") {
    throw invalidInput(
      "DeepSeek Harness supports stdio and Streamable HTTP MCP; use an HTTP endpoint instead of SSE",
    );
  }
  if (id.length === 0 || id.length > 32 || [...id].some((character) => !/^[A-Za-z0-9_-]$/.test(character))) {
    throw invalidInput("DeepSeek Harness MCP names must contain 1–32 letters, digits, '-' or '_'");
  }
}

/* -------------------------------------------------------------------------- */
/* Adapter                                                                    */
/* -------------------------------------------------------------------------- */

function syncOne(server: McpServer): void {
  // Managed app: an unassigned server is left untouched, never removed.
  if (server.apps.dsh !== true) return;
  syncSpec(server.id, server.server);
}

function disable(id: string): void {
  syncSpec(id, undefined);
}

function remove(id: string): void {
  syncSpec(id, undefined);
}

function syncAll(servers: McpServer[]): void {
  for (const server of servers) {
    if (server.apps.dsh === true) syncOne(server);
  }
}

/**
 * Expected decoded spec after writing `spec` (plus `patch`) into an entry that
 * currently decodes to `native`. DSH keeps native-only config fields on write,
 * so the comparison preserves fields the unified definition does not own.
 */
function expectedSpec(
  native: Record<string, unknown>,
  spec: Record<string, unknown>,
  patch: unknown,
): Record<string, unknown> {
  const expected: Record<string, unknown> = { ...native };
  for (const field of CONNECTION_FIELDS) delete expected[field];
  for (const [key, value] of Object.entries(spec)) if (key !== "type") expected[key] = value;
  applyOptions(expected, patch, CONNECTION_FIELDS);
  delete expected.serverName;
  delete expected.transport;
  expected.type = Object.hasOwn(spec, "url") ? "http" : "stdio";
  delete expected.enabled;
  delete expected.disabled;
  return expected;
}

export const adapter: AppAdapter = {
  app: "dsh",
  section: SECTION,

  read,

  syncAll,

  syncOne,

  disable,

  remove,

  project(spec: Record<string, unknown>): unknown {
    return { ...spec };
  },

  matches(native: NativeEntry, spec: Record<string, unknown>, patch?: unknown): boolean {
    try {
      return deepEqual(native.spec, expectedSpec(native.spec, spec, patch));
    } catch {
      return false;
    }
  },
};

export const dshAdapter = adapter;
