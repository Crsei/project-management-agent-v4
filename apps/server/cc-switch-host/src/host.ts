/** Translated from apps/server/cc-switch-host/src/protocol.rs and main.rs. */
import { Database } from "./database/index.ts";
import { AppError, invalidInput, publicErrorCode } from "./errors.ts";
import { initialize as initializeContext } from "./host-context.ts";
import { McpManager } from "./mcp/service.ts";
import { cancelChecks, startChecksWithId } from "./mcp/connectivity.ts";
import { SkillManager } from "./skills/service.ts";
import { addSkillRepo, checkSkillUpdates, discoverAvailableReport, discoverRepo as discoverRepository, removeSkillRepo, searchSkillsSh } from "./skills/discovery.ts";
import { migrateStorage } from "./skills/migration.ts";
import { installSkillsFromZip } from "./skills/install.ts";
import { ssotDir } from "./skills/paths.ts";
import { getSettings, reloadSettings, updateSettings } from "./settings.ts";
import type { AppId, HostInitialization, McpServer } from "./types.ts";

interface Request {
  id: string;
  command: string;
  args: Record<string, unknown>;
}

class AsyncLock {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(work: () => Promise<T> | T): Promise<T> {
    const next = this.#tail.then(work, work);
    this.#tail = next.then(() => undefined, () => undefined);
    return next;
  }
}

function parseInitialization(value: Record<string, unknown>): HostInitialization {
  const allowed: Record<string, true> = { dataDir: true, homeDir: true, appDirs: true, claudeMcpFile: true, secretKey: true };
  for (const key of Object.keys(value)) if (!allowed[key]) throw invalidInput("Invalid host initialization");
  const dataDir = value.dataDir;
  const homeDir = value.homeDir;
  const secretKey = value.secretKey;
  if (typeof dataDir !== "string" || typeof homeDir !== "string" || typeof secretKey !== "string") throw invalidInput("Invalid host initialization");
  if (value.appDirs === null || typeof value.appDirs !== "object" || Array.isArray(value.appDirs)) throw invalidInput("Invalid host initialization");
  const appDirs: Record<string, string> = {};
  for (const [app, root] of Object.entries(value.appDirs)) {
    if (typeof root !== "string") throw invalidInput("Invalid host initialization");
    appDirs[app] = root;
  }
  if (value.claudeMcpFile !== undefined && typeof value.claudeMcpFile !== "string") throw invalidInput("Invalid host initialization");
  return {
    dataDir,
    homeDir,
    appDirs,
    ...(typeof value.claudeMcpFile === "string" ? { claudeMcpFile: value.claudeMcpFile } : {}),
    secretKey,
  };
}

function requireString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value.length === 0) throw invalidInput(`Missing command argument: ${name}`);
  return value;
}

function requireBoolean(args: Record<string, unknown>, name: string): boolean {
  const value = args[name];
  if (typeof value !== "boolean") throw invalidInput(`Invalid command argument: ${name}`);
  return value;
}

function requireApp(args: Record<string, unknown>, name: string): AppId {
  const value = requireString(args, name);
  return value as AppId;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalidInput(`Invalid command argument: ${name}`);
  return value as Record<string, unknown>;
}

export class Host {
  readonly apps: string[];
  readonly #db: Database;
  readonly #mcp: McpManager;
  readonly #skills: SkillManager;
  readonly #events: (value: unknown) => void;
  readonly #operations = new AsyncLock();

  private constructor(apps: string[], db: Database, events: (value: unknown) => void) {
    this.apps = apps;
    this.#db = db;
    this.#events = events;
    this.#mcp = new McpManager(db, events);
    this.#skills = new SkillManager(db);
  }

  static async initialize(rawArgs: unknown, events: (value: unknown) => void): Promise<Host> {
    if (rawArgs === null || typeof rawArgs !== "object" || Array.isArray(rawArgs)) throw invalidInput("Invalid host initialization");
    const args = parseInitialization(rawArgs as Record<string, unknown>);
    const apps = initializeContext(args);
    reloadSettings();
    const db = await Database.init();
    return new Host(apps, db, events);
  }

  async invoke(request: Request): Promise<unknown> {
    if (request.args === null || typeof request.args !== "object" || Array.isArray(request.args)) throw invalidInput("Command arguments must be an object");
    if (request.command === "cancel_mcp_connectivity_checks") {
      cancelChecks(requireString(request.args, "batchId"));
      return null;
    }
    return this.#operations.run(() => this.#dispatch(request.command, request.args));
  }

  close(): void {
    this.#db.close();
  }

  async #dispatch(command: string, args: Record<string, unknown>): Promise<unknown> {
    switch (command) {
      case "get_mcp_servers":
        return Object.fromEntries(this.#mcp.getAllServers());
      case "get_mcp_management":
        return this.#mcp.getManagement();
      case "save_mcp_definition":
        this.#mcp.saveDefinition(args.definition);
        return null;
      case "set_mcp_agent_configuration": {
        const change = Object.hasOwn(args, "override") ? { override: args.override as unknown | null } : undefined;
        this.#mcp.setAgentConfiguration(requireString(args, "serverId"), requireApp(args, "app"), requireBoolean(args, "enabled"), change);
        return null;
      }
      case "preview_mcp_import":
        return this.#mcp.previewImport();
      case "apply_mcp_import":
        return this.#mcp.applyImport(
          requireString(args, "previewId"),
          Array.isArray(args.selections) ? args.selections.map((item) => record(item, "selections") as { entryId: string; resolution: string }) : [],
        );
      case "upsert_mcp_server": {
        const server = args.server as McpServer;
        this.#mcp.upsertServer(server);
        return null;
      }
      case "delete_mcp_server":
        return this.#mcp.deleteServer(requireString(args, "id"));
      case "toggle_mcp_app":
        this.#mcp.toggleApp(requireString(args, "serverId"), requireApp(args, "app"), requireBoolean(args, "enabled"));
        return null;
      case "resync_mcp_to_apps":
        return this.#mcp.resyncToApps(Array.isArray(args.apps) ? args.apps.filter((app): app is string => typeof app === "string") : null);
      case "validate_mcp_command":
        return this.#mcp.validateCommand(requireString(args, "cmd"));
      case "start_mcp_connectivity_checks": {
        const ids = Array.isArray(args.serverIds) ? args.serverIds.filter((id): id is string => typeof id === "string") : [];
        const servers = this.#mcp.getAllServers();
        if (ids.some((id) => !servers.has(id))) throw invalidInput("Unknown MCP server");
        const batchId = crypto.randomUUID();
        startChecksWithId(ids.map((id) => servers.get(id)!).filter(Boolean), batchId, (result) => {
          this.#events({ event: "mcp-connectivity", requestId: undefined, data: { batchId, serverId: result.serverId, connected: result.connected } });
          return true;
        });
        return batchId;
      }
      case "get_installed_skills":
        return this.#skills.getAllInstalled();
      case "get_skill_backups":
        return this.#skills.getBackups();
      case "delete_skill_backup":
        this.#skills.deleteBackup(requireString(args, "backupId"));
        return true;
      case "install_skill_unified":
        return this.#skills.installUnified(args.skill, requireApp(args, "currentApp"));
      case "uninstall_skill_unified":
        return this.#skills.uninstallUnified(requireString(args, "id"));
      case "restore_skill_backup":
        return this.#skills.restoreBackup(requireString(args, "backupId"), requireApp(args, "currentApp"));
      case "toggle_skill_app":
        this.#skills.toggleApp(requireString(args, "id"), requireApp(args, "app"), requireBoolean(args, "enabled"));
        return true;
      case "scan_unmanaged_skills":
        return this.#skills.scanUnmanaged();
      case "scan_native_skills":
        return this.#skills.scanNative();
      case "import_skills_from_apps":
        return this.#skills.importFromApps(Array.isArray(args.imports) ? args.imports as never[] : []);
      case "discover_available_skills":
        return discoverAvailableReport(this.#db.skills.getRepos(), requireBoolean(args, "forceRefresh"));
      case "discover_repo_skills": {
        const owner = requireString(args, "owner");
        const name = requireString(args, "name");
        const repo = this.#db.skills.getRepos().find((entry) => entry.owner === owner && entry.name === name);
        return repo === undefined ? { skills: [], failures: [] } : discoverRepository(repo);
      }
      case "check_skill_updates":
        return checkSkillUpdates(this.#db);
      case "resync_skills_to_apps":
        return this.#skills.resyncAll();
      case "update_skill":
        return this.#skills.updateSkill(requireString(args, "id"));
      case "migrate_skill_storage":
        return migrateStorage(this.#db, requireString(args, "target") as "cc_switch" | "unified");
      case "get_cc_switch_skills_dir":
        return ssotDir();
      case "search_skills_sh":
        return searchSkillsSh(requireString(args, "query"), Number(args.limit), Number(args.offset));
      case "get_skill_repos":
        return this.#db.skills.getRepos();
      case "add_skill_repo":
        addSkillRepo(this.#db, record(args.repo, "repo") as never);
        return true;
      case "remove_skill_repo":
        removeSkillRepo(this.#db, requireString(args, "owner"), requireString(args, "name"));
        return true;
      case "install_skills_from_zip":
        return installSkillsFromZip(this.#db, requireString(args, "zipPath"), requireApp(args, "currentApp"));
      case "get_settings":
        return getSettings();
      case "save_settings": {
        const patch = record(args.settings, "settings");
        const current = getSettings();
        const next = { ...current, visibleApps: { ...current.visibleApps } };
        if (patch.skillSyncMethod !== undefined) next.skillSyncMethod = patch.skillSyncMethod as typeof next.skillSyncMethod;
        if (patch.skillStorageLocation !== undefined) {
          if (patch.skillStorageLocation !== current.skillStorageLocation) throw invalidInput("Use migrate_skill_storage to change storage location");
          next.skillStorageLocation = current.skillStorageLocation;
        }
        if (patch.backupRetainCount !== undefined) next.backupRetainCount = patch.backupRetainCount as number | undefined;
        if (patch.language !== undefined) next.language = patch.language as string | undefined;
        if (patch.visibleApps !== undefined) next.visibleApps = record(patch.visibleApps, "visibleApps") as Record<string, boolean>;
        updateSettings(next);
        return true;
      }
      default:
        throw new AppError("INVALID_INPUT", "Unknown or host-only management command");
    }
  }
}

export { publicErrorCode };
