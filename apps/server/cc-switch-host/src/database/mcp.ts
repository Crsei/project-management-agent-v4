/** Translated from vendor/cc-switch/src-tauri/src/database/dao/mcp.rs and host mcp_assignments.rs. */
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { databaseError, invalidInput } from "../errors.ts";
import { open, openOverride, seal, sealOverride } from "../secret-codec.ts";
import { APP_IDS, emptyAppFlags, type AppId, type McpServer } from "../types.ts";

const SELECT = `SELECT id, name, server_config, description, homepage, docs, tags,
 enabled_claude, enabled_codex, enabled_gemini, enabled_grokbuild, enabled_opencode, enabled_hermes,
 enabled_mcode, enabled_pi, enabled_agy, enabled_kimi, enabled_omp, enabled_dsh FROM mcp_servers`;

type Row = Record<string, unknown>;

function bool(row: Row, key: string): boolean {
  return row[key] === 1 || row[key] === true || row[key] === "1";
}

export function mcpAppEnabledColumn(app: AppId): string {
  return `enabled_${app}`;
}

export class McpDao {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  getAllServers(): Map<string, McpServer> {
    const rows = this.#db.prepare(`${SELECT} ORDER BY name ASC, id ASC`).all() as Row[];
    const servers = new Map<string, McpServer>();
    for (const row of rows) {
      const id = String(row.id);
      const apps = emptyAppFlags();
      for (const app of APP_IDS) apps[app] = bool(row, `enabled_${app}`);
      let server: Record<string, unknown>;
      try { server = open(id, String(row.server_config)) as Record<string, unknown>; } catch { throw databaseError("Cannot authenticate protected MCP definition"); }
      let tags: string[] = [];
      try { tags = JSON.parse(String(row.tags ?? "[]")) as string[]; } catch { tags = []; }
      servers.set(id, {
        id,
        name: String(row.name),
        server,
        apps,
        ...(row.description != null ? { description: String(row.description) } : {}),
        ...(row.homepage != null ? { homepage: String(row.homepage) } : {}),
        ...(row.docs != null ? { docs: String(row.docs) } : {}),
        tags: Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === "string") : [],
      });
    }
    return servers;
  }

  updateAppEnabled(id: string, app: AppId, enabled: boolean): McpServer | undefined {
    const column = mcpAppEnabledColumn(app);
    const result = this.#db.prepare(`UPDATE mcp_servers SET ${column} = ?1 WHERE id = ?2`).run(enabled ? 1 : 0, id);
    if (Number(result.changes) === 0) return undefined;
    return this.getServer(id);
  }

  getServer(id: string): McpServer | undefined {
    const row = this.#db.prepare(`${SELECT} WHERE id = ?1`).get(id) as Row | undefined;
    if (!row) return undefined;
    return this.getAllServers().get(String(row.id));
  }

  saveServer(server: McpServer): void {
    this.#saveServer(this.#db, server);
  }

  #saveServer(db: DatabaseSync, server: McpServer): void {
    const config = seal(server.id, server.server);
    db.prepare(`INSERT INTO mcp_servers (
      id, name, server_config, description, homepage, docs, tags,
      enabled_claude, enabled_codex, enabled_gemini, enabled_grokbuild, enabled_opencode, enabled_hermes,
      enabled_mcode, enabled_pi, enabled_agy, enabled_kimi, enabled_omp, enabled_dsh
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, server_config=excluded.server_config,
      description=excluded.description, homepage=excluded.homepage, docs=excluded.docs, tags=excluded.tags,
      enabled_claude=excluded.enabled_claude, enabled_codex=excluded.enabled_codex,
      enabled_gemini=excluded.enabled_gemini, enabled_grokbuild=excluded.enabled_grokbuild,
      enabled_opencode=excluded.enabled_opencode, enabled_hermes=excluded.enabled_hermes,
      enabled_mcode=excluded.enabled_mcode, enabled_pi=excluded.enabled_pi, enabled_agy=excluded.enabled_agy,
      enabled_kimi=excluded.enabled_kimi, enabled_omp=excluded.enabled_omp, enabled_dsh=excluded.enabled_dsh`)
      .run(
        server.id, server.name, config, server.description ?? null, server.homepage ?? null, server.docs ?? null,
        JSON.stringify(server.tags), ...APP_IDS.map((app) => server.apps[app] ? 1 : 0),
      );
  }

  deleteServer(id: string): boolean {
    this.#transaction(() => {
      this.#db.prepare("DELETE FROM mcp_agent_overrides WHERE server_id = ?1").run(id);
      this.#db.prepare("DELETE FROM mcp_servers WHERE id = ?1").run(id);
    });
    return true;
  }

  getOverrides(): Map<string, Map<string, unknown>> {
    const rows = this.#db.prepare("SELECT server_id, app, patch FROM mcp_agent_overrides ORDER BY server_id, app").all() as Row[];
    const result = new Map<string, Map<string, unknown>>();
    for (const row of rows) {
      const id = String(row.server_id);
      const app = String(row.app);
      const patch = openOverride(id, app, String(row.patch));
      if (!isObject(patch)) throw databaseError("Invalid protected override");
      let apps = result.get(id);
      if (!apps) { apps = new Map(); result.set(id, apps); }
      apps.set(app, patch);
    }
    return result;
  }

  getOverride(id: string, app: AppId): unknown | undefined {
    const row = this.#db.prepare("SELECT patch FROM mcp_agent_overrides WHERE server_id = ?1 AND app = ?2").get(id, app) as Row | undefined;
    if (!row) return undefined;
    return openOverride(id, app, String(row.patch));
  }

  saveAssignment(server: McpServer, app: AppId, change: { override?: unknown | null } | undefined): void {
    this.#transaction(() => {
      const column = mcpAppEnabledColumn(app);
      const result = this.#db.prepare(`UPDATE mcp_servers SET ${column} = ?1 WHERE id = ?2`).run(server.apps[app] ? 1 : 0, server.id);
      if (Number(result.changes) !== 1) throw invalidInput("unknown_server");
      if (change) this.#writeOverride(this.#db, server.id, app, change.override);
    });
  }

  commitImport(servers: McpServer[], overrides: Array<{ id: string; app: AppId; patch: unknown | null }>): void {
    this.#transaction(() => {
      for (const server of servers) this.#saveServer(this.#db, server);
      for (const entry of overrides) this.#writeOverride(this.#db, entry.id, entry.app, entry.patch);
    });
  }

  #writeOverride(db: DatabaseSync, id: string, app: string, patch: unknown | null | undefined): void {
    if (patch === undefined) return;
    if (patch === null) {
      db.prepare("DELETE FROM mcp_agent_overrides WHERE server_id = ?1 AND app = ?2").run(id, app);
      return;
    }
    if (!isObject(patch)) throw invalidInput("invalid_override");
    db.prepare("INSERT INTO mcp_agent_overrides (server_id, app, patch) VALUES (?1, ?2, ?3) ON CONFLICT(server_id, app) DO UPDATE SET patch=excluded.patch")
      .run(id, app, sealOverride(id, app, patch));
  }

  #transaction<T>(work: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.#db.exec("ROLLBACK"); } catch { /* keep original */ }
      throw error;
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type { StatementSync };
