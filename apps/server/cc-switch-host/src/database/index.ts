/** Translated from apps/server/cc-switch-host/src/database.rs. */
import { chmodSync, closeSync, existsSync, lstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import lockfile from "proper-lockfile";
import { open as openSecret, seal as sealSecret } from "../secret-codec.ts";
import { HOST_SCHEMA_VERSION } from "../constants.ts";
import { AppError, databaseError } from "../errors.ts";
import { dataDir, privateDirectory } from "../host-context.ts";
import { McpDao } from "./mcp.ts";
import { SkillsDao } from "./skills.ts";
import { SettingsDao } from "./settings.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS mcp_servers (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, server_config TEXT NOT NULL,
 description TEXT, homepage TEXT, docs TEXT, tags TEXT NOT NULL DEFAULT '[]',
 enabled_claude BOOLEAN NOT NULL DEFAULT 0, enabled_codex BOOLEAN NOT NULL DEFAULT 0,
 enabled_gemini BOOLEAN NOT NULL DEFAULT 0, enabled_grokbuild BOOLEAN NOT NULL DEFAULT 0,
 enabled_opencode BOOLEAN NOT NULL DEFAULT 0, enabled_mcode BOOLEAN NOT NULL DEFAULT 0,
 enabled_agy BOOLEAN NOT NULL DEFAULT 0, enabled_kimi BOOLEAN NOT NULL DEFAULT 0,
 enabled_dsh BOOLEAN NOT NULL DEFAULT 0, enabled_hermes BOOLEAN NOT NULL DEFAULT 0,
 enabled_pi BOOLEAN NOT NULL DEFAULT 0, enabled_omp BOOLEAN NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS mcp_agent_overrides (
 server_id TEXT NOT NULL, app TEXT NOT NULL, patch TEXT NOT NULL,
 PRIMARY KEY (server_id, app)
);
CREATE TABLE IF NOT EXISTS skills (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, directory TEXT NOT NULL,
 repo_owner TEXT, repo_name TEXT, repo_branch TEXT DEFAULT 'main', readme_url TEXT,
 enabled_claude BOOLEAN NOT NULL DEFAULT 0, enabled_codex BOOLEAN NOT NULL DEFAULT 0,
 enabled_gemini BOOLEAN NOT NULL DEFAULT 0, enabled_grokbuild BOOLEAN NOT NULL DEFAULT 0,
 enabled_opencode BOOLEAN NOT NULL DEFAULT 0, enabled_mcode BOOLEAN NOT NULL DEFAULT 0,
 enabled_agy BOOLEAN NOT NULL DEFAULT 0, enabled_kimi BOOLEAN NOT NULL DEFAULT 0,
 enabled_dsh BOOLEAN NOT NULL DEFAULT 0, enabled_hermes BOOLEAN NOT NULL DEFAULT 0,
 installed_at INTEGER NOT NULL DEFAULT 0, content_hash TEXT, updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS skill_repos (
 owner TEXT NOT NULL, name TEXT NOT NULL, branch TEXT NOT NULL DEFAULT 'main',
 enabled BOOLEAN NOT NULL DEFAULT 1, PRIMARY KEY (owner, name)
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`;

export class Database {
  readonly db: DatabaseSync;
  readonly mcp: McpDao;
  readonly skills: SkillsDao;
  readonly settings: SettingsDao;
  private release?: () => Promise<void>;

  private constructor(db: DatabaseSync) {
    this.db = db;
    this.mcp = new McpDao(db);
    this.skills = new SkillsDao(db);
    this.settings = new SettingsDao(db);
  }

  static async init(): Promise<Database> {
    const directory = dataDir();
    privateDirectory(directory);
    const lockPath = path.join(directory, ".host.lock");
    if (!existsSync(lockPath)) {
      const fd = openSync(lockPath, "a", 0o600);
      closeSync(fd);
      chmodSync(lockPath, 0o600);
    }
    let release: (() => Promise<void>) | undefined;
    try {
      release = await lockfile.lock(lockPath, { realpath: false, stale: 10_000, update: 5_000 });
    } catch {
      throw new AppError("DATABASE", "Context is already owned by another host");
    }
    const databasePath = path.join(directory, "cc-switch.db");
    if (lstatExists(databasePath) && lstatSync(databasePath).isSymbolicLink()) {
      if (release) await release();
      throw new AppError("DATABASE", "Database symlinks are refused");
    }
    let connection: DatabaseSync;
    try {
      connection = new DatabaseSync(databasePath);
      if (process.platform !== "win32") chmodSync(databasePath, 0o600);
      connection.exec("PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; PRAGMA busy_timeout=5000;");
      const row = connection.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
      const version = Number(row?.user_version ?? 0);
      if (version > HOST_SCHEMA_VERSION) throw databaseError("Unsupported headless schema version; restore a matching host build");
      if (version === 0) {
        connection.exec(SCHEMA);
        connection.exec(`PRAGMA user_version = ${HOST_SCHEMA_VERSION}`);
      }
      if (version === 1) {
        connection.exec("CREATE TABLE IF NOT EXISTS mcp_agent_overrides (server_id TEXT NOT NULL, app TEXT NOT NULL, patch TEXT NOT NULL, PRIMARY KEY (server_id, app));");
        connection.exec(`PRAGMA user_version = ${HOST_SCHEMA_VERSION}`);
      }
    } catch (error) {
      if (release) await release();
      throw error instanceof AppError ? error : databaseError(String(error));
    }
    const database = new Database(connection);
    database.release = release;
    try {
      // Authenticate before any protected record can be returned or changed.
      database.mcp.getAllServers();
      const check = database.settings.get("host_context_key_check");
      if (check) {
        openSecret("$context-key-check", check);
      } else {
        database.settings.set("host_context_key_check", sealSecret("$context-key-check", { host: 1 }));
      }
      database.skills.initDefaultRepos();
    } catch (error) {
      database.close();
      throw error instanceof AppError ? error : databaseError(String(error));
    }
    return database;
  }

  close(): void {
    try { this.db.close(); } catch { /* already closed */ }
    const release = this.release;
    this.release = undefined;
    if (release) void release().catch(() => undefined);
  }

  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* keep original error */ }
      throw error;
    }
  }
}

function lstatExists(value: string): boolean {
  try { return lstatSync(value).isSymbolicLink() || true; } catch { return false; }
}

/** Test helper: read a database file without the host lock. */
export function readDatabaseForTests(filename: string): DatabaseSync {
  return new DatabaseSync(filename);
}

export function readPrivateFile(filename: string): Buffer {
  return readFileSync(filename);
}

export function writePrivateFile(filename: string, bytes: Buffer): void {
  writeFileSync(filename, bytes, { mode: 0o600 });
}
