/**
 * Translated from apps/server/cc-switch-host/src/mcp_management.rs and
 * vendor/cc-switch/src-tauri/src/services/mcp.rs (headless management paths).
 *
 * This module never writes native files: import approval only commits the SSOT.
 */
import { randomUUID } from "node:crypto";
import type { Database } from "../database/index.ts";
import { invalidInput } from "../errors.ts";
import { requireApp } from "../host-context.ts";
import { emptyAppFlags, type AppId, type McpServer } from "../types.ts";
import { deepEqual } from "./adapter.ts";
import { nativeEqual, readBound, validate, type NativeSnapshot } from "./snapshot.ts";
import { validateServerSpec } from "./validation.ts";

type JsonObject = Record<string, unknown>;
type Overrides = Map<string, Map<string, unknown>>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneValue(item)) as unknown as T;
  if (isObject(value)) {
    const result: JsonObject = {};
    for (const [key, item] of Object.entries(value)) result[key] = cloneValue(item);
    return result as unknown as T;
  }
  return value;
}

function cloneServer(server: McpServer): McpServer {
  return {
    id: server.id,
    name: server.name,
    server: cloneValue(server.server),
    apps: { ...server.apps },
    ...(server.description !== undefined ? { description: server.description } : {}),
    ...(server.homepage !== undefined ? { homepage: server.homepage } : {}),
    ...(server.docs !== undefined ? { docs: server.docs } : {}),
    tags: [...server.tags],
  };
}

/** RFC 7396 merge patch that preserves explicit null removals. */
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isObject(patch)) return cloneValue(patch);
  const base: JsonObject = isObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete base[key];
    else base[key] = mergePatch(base[key], value);
  }
  return base;
}

export function effective(base: JsonObject, patch?: unknown): JsonObject {
  return patch === undefined ? cloneValue(base) : (mergePatch(base, patch) as JsonObject);
}

function overlay(target: JsonObject, patch: unknown): void {
  if (!isObject(patch)) return;
  for (const [key, value] of Object.entries(patch)) {
    if (isObject(value)) {
      if (!isObject(target[key])) target[key] = {};
      overlay(target[key] as JsonObject, value);
    } else {
      target[key] = cloneValue(value);
    }
  }
}

/**
 * Managed option values plus explicit tombstones. Native-only fields remain
 * untouched, while clearing an override restores its inherited values.
 */
export function nativeProjectionPatch(
  spec: JsonObject,
  patch?: unknown,
  previous?: unknown,
): JsonObject {
  const result = cloneValue(spec);
  if (previous !== undefined) overlay(result, difference(previous, spec));
  if (patch !== undefined) overlay(result, patch);
  return result;
}

/** RFC 7396 difference. Round-trip validation at the call site rejects literal nulls. */
export function difference(base: unknown, target: unknown): unknown {
  if (!isObject(base) || !isObject(target)) return cloneValue(target);
  const patch: JsonObject = {};
  for (const key of Object.keys(base)) if (!hasOwn(target, key)) patch[key] = null;
  for (const [key, value] of Object.entries(target)) {
    if (!hasOwn(base, key) || !deepEqual(base[key], value)) {
      patch[key] = hasOwn(base, key) ? difference(base[key], value) : cloneValue(value);
    }
  }
  return patch;
}

/** Normalized SSOT spec used only for import classification. */
function normalized(spec: JsonObject): JsonObject {
  const result = cloneValue(spec);
  if (!hasOwn(result, "type")) {
    result.type = hasOwn(result, "url") ? "http" : "stdio";
  }
  if (result.type === "streamable-http") result.type = "http";
  return result;
}

/** Wire definition: the shared server without its application assignment. */
export function definition(server: McpServer): JsonObject {
  const value: JsonObject = { ...server };
  delete value.apps;
  if (server.tags.length === 0) delete value.tags;
  return value;
}

function overridesAt(overrides: Overrides, id: string, app: AppId): unknown {
  return overrides.get(id)?.get(app);
}

export function effectiveServerSpec(db: Database, server: McpServer, app: AppId): JsonObject {
  return effective(server.server, db.mcp.getOverride(server.id, app));
}

export interface Compatibility {
  supported: boolean;
  reason: string | null;
}

export function compatibility(app: AppId, id: string, spec: JsonObject): Compatibility {
  let reason: string | undefined;
  try {
    validateServerSpec(spec);
  } catch {
    reason = "invalid_configuration";
  }
  if (reason === undefined && (app === "pi" || app === "dsh" || app === "agy") && spec.type === "sse") {
    reason = "unsupported_transport";
  }
  if (reason === undefined) {
    try {
      validate(app, id, spec);
    } catch {
      reason = app === "pi" || app === "dsh" ? "invalid_server_id" : "invalid_configuration";
    }
  }
  return { supported: reason === undefined, reason: reason ?? null };
}

export type SyncState = "error" | "pending" | "unassigned" | "unavailable" | "synced";
export type SyncReason =
  | "native_configuration_differs"
  | "native_not_initialized"
  | "invalid_configuration"
  | "native_comparison_failed"
  | string;

export interface AgentConfigurationView {
  serverId: string;
  app: AppId;
  enabled: boolean;
  override: unknown;
  effective: JsonObject;
  compatibility: Compatibility;
  sync: { state: SyncState; reason: SyncReason | null };
}

export interface ManagementView {
  definitions: Record<string, JsonObject>;
  agentConfigurations: Record<string, Record<string, AgentConfigurationView>>;
  boundApps: string[];
}

/** Exactly one native scan for the entire management read. */
export function getManagement(db: Database): ManagementView {
  const servers = db.mcp.getAllServers();
  const overrides = db.mcp.getOverrides();
  const native = readBound();
  const definitions: Record<string, JsonObject> = {};
  const agentConfigurations: Record<string, Record<string, AgentConfigurationView>> = {};
  for (const [id, server] of servers) {
    definitions[id] = definition(server);
    const apps: Record<string, AgentConfigurationView> = {};
    for (const target of native) {
      const app = target.app;
      const patch = overridesAt(overrides, id, app);
      const spec = effective(server.server, patch);
      const enabled = server.apps[app];
      const appCompatibility = compatibility(app, id, spec);
      const nativeEnabled = target.entries.get(id)?.enabled === true;
      let state: SyncState;
      let reason: SyncReason | null = null;
      if (target.error !== undefined) {
        state = "error";
        reason = target.error;
      } else if (!enabled && nativeEnabled) {
        state = "pending";
        reason = "native_configuration_differs";
      } else if (!enabled) {
        state = "unassigned";
      } else if (!target.initialized()) {
        state = "unavailable";
        reason = "native_not_initialized";
      } else if (!appCompatibility.supported) {
        state = "error";
        reason = "invalid_configuration";
      } else {
        try {
          const patchForNative = nativeProjectionPatch(spec, patch, undefined);
          state = target.matches(id, spec, patchForNative) ? "synced" : "pending";
          if (state === "pending") reason = "native_configuration_differs";
        } catch {
          state = "error";
          reason = "native_comparison_failed";
        }
      }
      apps[app] = {
        serverId: id,
        app,
        enabled,
        override: patch ?? null,
        effective: spec,
        compatibility: appCompatibility,
        sync: { state, reason },
      };
    }
    agentConfigurations[id] = apps;
  }
  return { definitions, agentConfigurations, boundApps: native.map((target) => target.app) };
}

export interface ImportSelection {
  entryId: string;
  resolution: string;
}

interface ImportEntry {
  id: string;
  app: AppId;
  server: McpServer;
  enabled: boolean;
  classification: "new" | "duplicate" | "conflict";
  conflicts: string[];
  resolutions: string[];
}

interface ImportPlan {
  id: string;
  entries: ImportEntry[];
  warnings: Array<{ app: AppId; message: string }>;
  ssot: unknown;
  native: NativeSnapshot[];
}

export interface ManagementState {
  preview?: ImportPlan;
}

export interface ImportPreviewEntryView {
  entryId: string;
  sourceApp: AppId;
  serverId: string;
  name: string;
  definition: JsonObject;
  enabled: boolean;
  classification: string;
  conflicts: string[];
  resolutions: string[];
}

export interface ImportPreviewView {
  previewId: string;
  entries: ImportPreviewEntryView[];
  warnings: Array<{ app: AppId; message: string }>;
}

export interface ImportResult {
  applied: number;
  skipped: number;
  warnings: Array<{ app: AppId; message: string }>;
}

function ssotSnapshot(db: Database): unknown {
  return {
    servers: Object.fromEntries(db.mcp.getAllServers()),
    overrides: Object.fromEntries(
      [...db.mcp.getOverrides()].map(([id, apps]) => [id, Object.fromEntries(apps)]),
    ),
  };
}

function warning(app: AppId, message: string): { app: AppId; message: string } {
  return { app, message };
}

/** Upstream preview treats an unreadable/incomparable native entry as "not duplicate". */
function matchesConfigurationSafely(
  target: NativeSnapshot,
  id: string,
  spec: JsonObject,
  patch: unknown,
): boolean {
  try {
    return target.matchesConfiguration(id, spec, patch);
  } catch {
    return false;
  }
}

function syntheticServer(id: string, spec: JsonObject): McpServer {
  return { id, name: id, server: cloneValue(spec), apps: emptyAppFlags(), tags: [] };
}

/** Read-only import plan. Private preview IDs are minted per call. */
export function previewImport(db: Database, state: ManagementState): ImportPreviewView {
  const ssot = ssotSnapshot(db);
  const native = readBound();
  const existing = db.mcp.getAllServers();
  const overrides = db.mcp.getOverrides();
  const bases = new Map<string, JsonObject>();
  for (const [id, server] of existing) bases.set(id, normalized(server.server));
  const entries: ImportEntry[] = [];
  const warnings: Array<{ app: AppId; message: string }> = [];
  for (const target of native) {
    if (target.error !== undefined) {
      warnings.push(warning(target.app, target.error));
      // A partially parsed or divergent target is not safe to import.
      continue;
    }
    for (const [id, nativeEntry] of [...target.entries].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
      try {
        validate(target.app, id, nativeEntry.spec);
      } catch {
        warnings.push(warning(target.app, "invalid_import_entry"));
        continue;
      }
      const spec = normalized(nativeEntry.spec);
      const saved = existing.get(id);
      const savedPatch = overridesAt(overrides, id, target.app);
      const savedEffective = saved !== undefined ? effective(saved.server, savedPatch) : undefined;
      const chosen = savedEffective ?? bases.get(id);
      let classification: ImportEntry["classification"];
      let conflicts: string[] = [];
      let resolutions: string[];
      if (!bases.has(id)) {
        bases.set(id, spec);
        classification = "new";
        resolutions = ["import", "skip"];
      } else if (chosen !== undefined && (deepEqual(chosen, spec) || matchesConfigurationSafely(
        target, id, chosen, nativeProjectionPatch(chosen, savedPatch, undefined),
      ))) {
        classification = "duplicate";
        resolutions = ["import", "skip"];
      } else {
        classification = "conflict";
        conflicts = [saved !== undefined ? "server_configuration_differs" : "same_id_native_configuration_differs"];
        resolutions = ["merge-override", "skip"];
      }
      entries.push({
        id: randomUUID(),
        app: target.app,
        server: syntheticServer(id, nativeEntry.spec),
        enabled: nativeEntry.enabled,
        classification,
        conflicts,
        resolutions,
      });
    }
  }
  const id = randomUUID();
  state.preview = { id, entries, warnings, ssot, native };
  return {
    previewId: id,
    entries: entries.map((entry) => ({
      entryId: entry.id,
      sourceApp: entry.app,
      serverId: entry.server.id,
      name: entry.server.name,
      definition: definition(entry.server),
      enabled: entry.enabled,
      classification: entry.classification,
      conflicts: entry.conflicts,
      resolutions: entry.resolutions,
    })),
    warnings,
  };
}

function parseSelection(value: unknown): ImportSelection {
  if (!isObject(value)) throw invalidInput("invalid_import_selection");
  const { entryId, resolution } = value;
  if (typeof entryId !== "string" || typeof resolution !== "string") throw invalidInput("invalid_import_selection");
  return { entryId, resolution };
}

function assignmentKey(id: string, app: AppId): string {
  return `${id}\u0000${app}`;
}

export function applyImport(
  db: Database,
  state: ManagementState,
  previewId: string,
  selections: readonly ImportSelection[],
): ImportResult {
  const plan = state.preview;
  if (plan === undefined || plan.id !== previewId) throw invalidInput("invalid_import_preview");
  if (!deepEqual(plan.ssot, ssotSnapshot(db)) || !nativeEqual(plan.native, readBound())) {
    throw invalidInput("stale_import_preview");
  }
  const selected = new Map<string, string>();
  const byId = new Map(plan.entries.map((entry) => [entry.id, entry]));
  for (const raw of selections) {
    const selection = parseSelection(raw);
    const entry = byId.get(selection.entryId);
    if (!entry || !entry.resolutions.includes(selection.resolution) || selected.has(selection.entryId)) {
      throw invalidInput("invalid_import_selection");
    }
    selected.set(selection.entryId, selection.resolution);
  }

  const servers = db.mcp.getAllServers();
  const currentOverrides = db.mcp.getOverrides();
  const patches: Array<{ id: string; app: AppId; patch: unknown | null }> = [];
  const changed = new Set<string>();
  const assignments = new Set<string>();
  let applied = 0;

  // Establish explicitly approved new bases before processing dependents,
  // regardless of browser selection order.
  for (const entry of plan.entries) {
    if (entry.classification === "new" && selected.get(entry.id) === "import") {
      if (servers.has(entry.server.id)) throw invalidInput("conflicting_import_plan");
      servers.set(entry.server.id, cloneServer(entry.server));
    }
  }

  for (const entry of plan.entries) {
    const resolution = selected.get(entry.id);
    if (resolution === undefined || resolution === "skip") continue;
    try {
      requireApp(entry.app);
    } catch {
      throw invalidInput("unbound_target");
    }
    if (assignments.has(assignmentKey(entry.server.id, entry.app))) throw invalidInput("conflicting_import_plan");
    assignments.add(assignmentKey(entry.server.id, entry.app));
    const saved = servers.get(entry.server.id);
    if (saved === undefined) throw invalidInput("missing_import_base_selection");
    const previousPatch = overridesAt(currentOverrides, saved.id, entry.app);
    let patch: unknown;
    if (resolution === "merge-override") {
      const candidate = difference(saved.server, entry.server.server);
      if (!isObject(candidate) || !deepEqual(effective(saved.server, candidate), entry.server.server)) {
        throw invalidInput("unrepresentable_import_override");
      }
      patch = candidate;
    } else {
      const current = effective(saved.server, previousPatch);
      const target = plan.native.find((snapshot) => snapshot.app === entry.app);
      if (target === undefined) throw invalidInput("conflicting_import_plan");
      if (!deepEqual(normalized(current), normalized(entry.server.server))
        && !target.matchesConfiguration(saved.id, current, nativeProjectionPatch(current, previousPatch, undefined))) {
        throw invalidInput("conflicting_import_plan");
      }
      patch = previousPatch;
    }
    const spec = effective(saved.server, patch);
    validate(entry.app, saved.id, spec);
    saved.apps[entry.app] = entry.enabled;
    patches.push({ id: saved.id, app: entry.app, patch: patch ?? null });
    changed.add(saved.id);
    applied += 1;
  }

  const piNames = new Set<string>();
  for (const server of servers.values()) {
    if (!server.apps.pi) continue;
    const name = server.id.replace(/-/g, "_");
    if (piNames.has(name)) throw invalidInput("conflicting_import_plan");
    piNames.add(name);
  }

  // No native write occurs between approval and the single SSOT commit.
  // Recheck after planning too, so changing files during a large plan fails.
  if (!deepEqual(plan.ssot, ssotSnapshot(db)) || !nativeEqual(plan.native, readBound())) {
    throw invalidInput("stale_import_preview");
  }
  const changedServers = [...servers.values()].filter((server) => changed.has(server.id));
  if (applied > 0) db.mcp.commitImport(changedServers, patches);

  const result: ImportResult = { applied, skipped: plan.entries.length - applied, warnings: plan.warnings };
  state.preview = undefined;
  return result;
}


