/**
 * Translated from vendor/cc-switch/src-tauri/src/services/mcp.rs (headless
 * paths) and apps/server/cc-switch-host/src/mcp_management.rs.
 *
 * Definitions, assignments, overrides and resync stay synchronous because the
 * host serializes command-level mutations; native writes target bound paths only.
 */
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { Database } from "../database/index.ts";
import { AppError, invalidInput } from "../errors.ts";
import { isBound, requireApp } from "../host-context.ts";
import { APP_IDS, emptyAppFlags, isAppId, type AppFlags, type AppId, type McpServer } from "../types.ts";
import { ADAPTERS } from "./adapters/index.ts";
import { transportSpec as piTransportSpec } from "./adapters/pi.ts";
import { deepEqual } from "./adapter.ts";
import {
  applyImport,
  effective,
  effectiveServerSpec,
  getManagement,
  nativeProjectionPatch,
  previewImport,
  type ImportPreviewView,
  type ImportResult,
  type ImportSelection,
  type ManagementState,
  type ManagementView,
} from "./management.ts";
import { validate, validateTargetPaths } from "./snapshot.ts";
import { validateServerSpec } from "./validation.ts";

/** Apps whose native files carry disable/tombstone semantics. */
const MANAGED_APPS = ["mcode", "pi", "agy", "kimi", "dsh", "omp"] as const;
const SIMPLE_APPS = ["claude", "codex", "gemini", "grokbuild", "opencode", "hermes"] as const;
/** Native write order used by the upstream rollback closures. */
const MANAGED_WRITE_ORDER = ["mcode", "pi", "agy", "kimi", "dsh", "omp"] as const;
const MANAGED_DELETE_ORDER = ["mcode", "pi", "agy", "omp", "kimi", "dsh"] as const;

export interface McpAppSyncOutcome {
  app: string;
  ok: boolean;
  error?: string;
}

export interface AgentChange {
  override: unknown | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function managed(app: AppId): boolean {
  return (MANAGED_APPS as readonly string[]).includes(app);
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  if (field === undefined || field === null) return undefined;
  if (typeof field !== "string") throw invalidInput("invalid_definition");
  return field;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw invalidInput("invalid_definition");
  }
  return value as string[];
}

/** Wire definition input: strict keys, no assignment state. */
function parseDefinition(value: unknown): McpServer {
  if (!isObject(value)) throw invalidInput("invalid_definition");
  const allowed = new Set(["id", "name", "server", "description", "homepage", "docs", "tags"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw invalidInput("invalid_definition");
  const { id, name } = value;
  if (typeof id !== "string" || typeof name !== "string" || id.length === 0 || name.length === 0) {
    throw invalidInput("invalid_definition");
  }
  if (!Object.hasOwn(value, "server")) throw invalidInput("invalid_definition");
  const server = value.server;
  validateServerSpec(server);
  const description = stringField(value, "description");
  const homepage = stringField(value, "homepage");
  const docs = stringField(value, "docs");
  const tags = value.tags === undefined ? [] : stringList(value.tags);
  return {
    id,
    name,
    server,
    apps: emptyAppFlags(),
    ...(description !== undefined ? { description } : {}),
    ...(homepage !== undefined ? { homepage } : {}),
    ...(docs !== undefined ? { docs } : {}),
    tags,
  };
}

/** Runtime validation for the upstream `upsert_mcp_server` command payload. */
function coerceServer(value: unknown): McpServer {
  if (!isObject(value)) throw invalidInput("invalid_server");
  const id = value.id;
  const name = value.name;
  if (typeof id !== "string" || typeof name !== "string" || !Object.hasOwn(value, "server")) {
    throw invalidInput("invalid_server");
  }
  const server = value.server;
  if (!Object.hasOwn(value, "apps") || !isObject(value.apps)) throw invalidInput("invalid_server");
  const apps = emptyAppFlags();
  for (const app of APP_IDS) {
    const flag = value.apps[app];
    if (flag === undefined) continue;
    if (typeof flag !== "boolean") throw invalidInput("invalid_server");
    apps[app] = flag;
  }
  const description = value.description;
  const homepage = value.homepage;
  const docs = value.docs;
  for (const field of [description, homepage, docs]) {
    if (field !== undefined && field !== null && typeof field !== "string") throw invalidInput("invalid_server");
  }
  const tags = value.tags === undefined ? [] : value.tags;
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string")) throw invalidInput("invalid_server");
  validateServerSpec(server);
  return {
    id,
    name,
    server,
    apps,
    ...(typeof description === "string" ? { description } : {}),
    ...(typeof homepage === "string" ? { homepage } : {}),
    ...(typeof docs === "string" ? { docs } : {}),
    tags: tags as string[],
  };
}

function enabledAppsOf(flags: AppFlags): AppId[] {
  return APP_IDS.filter((app) => flags[app]);
}

function projectionPatch(db: Database, server: McpServer, app: AppId, previous: McpServer | undefined): Record<string, unknown> | undefined {
  try {
    if (!isBound(app)) return undefined;
    validateTargetPaths(app);
  } catch {
    return undefined;
  }
  const spec = effectiveServerSpec(db, server, app);
  const patch = db.mcp.getOverride(server.id, app);
  const previousSpec = previous !== undefined ? effectiveServerSpec(db, previous, app) : undefined;
  return nativeProjectionPatch(spec, patch, previousSpec);
}

function syncServerToApp(db: Database, server: McpServer, app: AppId, previous?: McpServer): void {
  const spec = effectiveServerSpec(db, server, app);
  validate(app, server.id, spec);
  const nativeSpec = projectionPatch(db, server, app, previous) ?? spec;
  ADAPTERS[app].syncOne({ ...server, server: nativeSpec, apps: { ...server.apps }, tags: [...server.tags] });
}

function disableServerForApp(db: Database, server: McpServer, app: AppId): void {
  ADAPTERS[app].disable(server.id, effectiveServerSpec(db, server, app));
}

function validateMutation(db: Database, server: McpServer): void {
  validateServerSpec(server.server);
  const existing = db.mcp.getAllServers();
  const previous = existing.get(server.id);
  const targets = new Set<AppId>([
    ...enabledAppsOf(server.apps),
    ...(previous !== undefined ? enabledAppsOf(previous.apps) : []),
  ]);
  for (const app of targets) {
    try {
      requireApp(app);
    } catch {
      throw invalidInput("unbound_target");
    }
    validateTargetPaths(app);
    if (server.apps[app]) validate(app, server.id, effectiveServerSpec(db, server, app));
  }
  // Pi treats '-' and '_' as the same server name even before installation.
  if (server.apps.pi) {
    const name = server.id.replace(/-/g, "_");
    for (const [id, other] of existing) {
      if (id === server.id || !other.apps.pi) continue;
      if (id.replace(/-/g, "_") === name) throw invalidInput("invalid_server_id");
    }
  }
}

/**
 * OMP keeps a disabled managed tombstone while the assignment is off; editing
 * the definition must keep that tombstone's transport in step.
 */
function ompTombstoneManaged(db: Database, previous: McpServer | undefined): boolean {
  if (previous === undefined || !isBound("omp")) return false;
  try {
    validateTargetPaths("omp");
  } catch {
    return false;
  }
  let read;
  try {
    read = ADAPTERS.omp.read();
  } catch {
    return false;
  }
  if (read.error !== undefined) return false;
  const entry = read.entries.get(previous.id);
  if (entry === undefined || entry.enabled) return false;
  return deepEqual(piTransportSpec(entry.spec), piTransportSpec(effectiveServerSpec(db, previous, "omp")));
}

function removeDisabledIfManaged(app: "pi" | "omp", id: string, spec: Record<string, unknown>): void {
  let bound: boolean;
  try {
    bound = isBound(app);
    if (bound) validateTargetPaths(app);
  } catch {
    return;
  }
  if (!bound) return;
  let read;
  try {
    read = ADAPTERS[app].read();
  } catch {
    return;
  }
  if (read.error !== undefined) return;
  const entry = read.entries.get(id);
  if (entry === undefined || entry.enabled) return;
  if (!deepEqual(piTransportSpec(entry.spec), piTransportSpec(spec))) return;
  try {
    ADAPTERS[app].remove(id);
  } catch {
    // Best-effort cleanup after the managed record is already gone.
  }
}

function resyncTargets(apps: readonly string[] | null): AppId[] {
  if (apps === null || apps.length === 0) return APP_IDS.filter((app) => isBound(app));
  const targets: AppId[] = [];
  for (const raw of apps) {
    if (!isAppId(raw)) throw new AppError("MESSAGE", `Unknown application: ${raw}`);
    requireApp(raw);
    if (!targets.includes(raw)) targets.push(raw);
  }
  return targets;
}

function projectServersToApp(db: Database, app: AppId): void {
  validateTargetPaths(app);
  const servers = db.mcp.getAllServers();
  const failures = new Map<string, string[]>();
  const record = (error: unknown, id: string): void => {
    const message = error instanceof Error ? error.message : String(error);
    const ids = failures.get(message);
    if (ids) ids.push(id);
    else failures.set(message, [id]);
  };
  for (const server of servers.values()) {
    try {
      if (server.apps[app]) syncServerToApp(db, server, app);
      else if (!managed(app)) disableServerForApp(db, server, app);
      // Managed apps keep their disabled/tombstone entries on resync.
    } catch (error) {
      record(error, server.id);
    }
  }
  if (failures.size === 0) return;
  const detail = [...failures].map(([error, ids]) => `${ids.join(", ")}: ${error}`).join("; ");
  throw new AppError("MESSAGE", `部分 MCP 服务器同步到 ${app} 失败: ${detail}`);
}

function isExecutable(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

export class McpManager {
  readonly #db: Database;
  readonly #management: ManagementState = {};

  constructor(db: Database, _emitEvent: (value: unknown) => void) {
    this.#db = db;
  }

  getAllServers(): Map<string, McpServer> {
    return this.#db.mcp.getAllServers();
  }

  getManagement(): ManagementView {
    return getManagement(this.#db);
  }

  saveDefinition(value: unknown): void {
    const server = parseDefinition(value);
    const previous = this.#db.mcp.getAllServers().get(server.id);
    if (previous !== undefined) server.apps = { ...previous.apps };
    this.upsertServer(server);
  }

  setAgentConfiguration(serverId: string, app: AppId, enabled: boolean, change: AgentChange | undefined): void {
    if (!isAppId(app)) throw new AppError("MESSAGE", `Unknown application: ${app}`);
    if (change !== undefined && change.override !== null && !isObject(change.override)) {
      throw invalidInput("invalid_override");
    }
    requireApp(app);
    validateTargetPaths(app);
    const server = this.#db.mcp.getAllServers().get(serverId);
    if (server === undefined) throw invalidInput("unknown_server");
    const previousEffective = effectiveServerSpec(this.#db, server, app);
    const savedPatch = this.#db.mcp.getOverride(server.id, app);
    const effectiveSpec = change === undefined
      ? previousEffective
      : effective(server.server, change.override === null ? undefined : change.override);
    validate(app, serverId, effectiveSpec);
    server.apps[app] = enabled;
    const activePatch = change === undefined ? savedPatch : change.override;
    const projection = nativeProjectionPatch(effectiveSpec, activePatch, previousEffective);
    if (managed(app)) {
      if (enabled) {
        ADAPTERS[app].syncOne({ ...server, server: projection, apps: { ...server.apps }, tags: [...server.tags] });
      } else {
        ADAPTERS[app].disable(server.id, effectiveSpec);
      }
      this.#db.mcp.saveAssignment(server, app, change);
    } else {
      this.#db.mcp.saveAssignment(server, app, change);
      if (enabled) {
        ADAPTERS[app].syncOne({ ...server, server: projection, apps: { ...server.apps }, tags: [...server.tags] });
      } else {
        ADAPTERS[app].disable(server.id, effectiveSpec);
      }
    }
  }

  previewImport(): ImportPreviewView {
    return previewImport(this.#db, this.#management);
  }

  applyImport(previewId: string, selections: readonly ImportSelection[]): ImportResult {
    return applyImport(this.#db, this.#management, previewId, selections);
  }

  upsertServer(value: McpServer): void {
    const server = coerceServer(value);
    validateMutation(this.#db, server);
    const previous = this.#db.mcp.getAllServers().get(server.id);
    const previousApps = previous?.apps;
    for (const app of MANAGED_WRITE_ORDER) {
      const tombstone = app === "omp" && ompTombstoneManaged(this.#db, previous);
      if (!server.apps[app] && !previousApps?.[app] && !tombstone) continue;
      if (server.apps[app]) syncServerToApp(this.#db, server, app, previous);
      else disableServerForApp(this.#db, server, app);
    }
    this.#db.mcp.saveServer(server);
    for (const app of SIMPLE_APPS) {
      if (previousApps?.[app] && !server.apps[app]) disableServerForApp(this.#db, server, app);
    }
    for (const app of APP_IDS) {
      if (!server.apps[app] || managed(app)) continue;
      syncServerToApp(this.#db, server, app, previous);
    }
  }

  deleteServer(id: string): boolean {
    const server = this.#db.mcp.getAllServers().get(id);
    if (server === undefined) return false;
    for (const app of enabledAppsOf(server.apps)) {
      try {
        requireApp(app);
      } catch {
        throw invalidInput("unbound_target");
      }
      validateTargetPaths(app);
    }
    const piSpec = effectiveServerSpec(this.#db, server, "pi");
    const ompSpec = effectiveServerSpec(this.#db, server, "omp");
    for (const app of MANAGED_DELETE_ORDER) {
      if (server.apps[app]) ADAPTERS[app].remove(id);
    }
    this.#db.mcp.deleteServer(id);
    // A false flag carries no ownership history; only an identical disabled
    // native entry is proven managed and safe to clean up.
    if (!server.apps.pi) removeDisabledIfManaged("pi", id, piSpec);
    if (!server.apps.omp) removeDisabledIfManaged("omp", id, ompSpec);
    for (const app of SIMPLE_APPS) {
      if (server.apps[app]) ADAPTERS[app].remove(id);
    }
    return true;
  }

  toggleApp(serverId: string, app: AppId, enabled: boolean): void {
    this.setAgentConfiguration(serverId, app, enabled, undefined);
  }

  resyncToApps(apps: readonly string[] | null): McpAppSyncOutcome[] {
    const targets = resyncTargets(apps);
    const outcomes: McpAppSyncOutcome[] = [];
    for (const app of targets) {
      try {
        projectServersToApp(this.#db, app);
        outcomes.push({ app, ok: true });
      } catch (error) {
        outcomes.push({ app, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return outcomes;
  }

  /** Upstream `validate_command_in_path`: a path or an executable on PATH. */
  validateCommand(command: string): boolean {
    if (command.trim() === "") return false;
    if (command.includes("/") || command.includes("\\")) return existsSync(command);
    const search = process.env.PATH ?? "";
    const extensions = process.platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((extension) => extension.trim().toUpperCase()).filter(Boolean)
      : [];
    for (const entry of search.split(path.delimiter)) {
      const candidate = path.join(entry, command);
      if (isExecutable(candidate)) return true;
      if (process.platform === "win32") {
        for (const extension of extensions) {
          if (isExecutable(`${candidate}${extension}`)) return true;
        }
      }
    }
    return false;
  }
}
