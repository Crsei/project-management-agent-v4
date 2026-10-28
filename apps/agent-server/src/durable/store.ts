import { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  closeSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { dataDirectory } from "../paths.ts";

type StoreState = {
  database: DatabaseSync;
  directory: string;
  depth: number;
  token: string;
  release: () => void;
};
const storeKey = Symbol.for("agent-workspace.durable-store");
const globals = globalThis as typeof globalThis & { [storeKey]?: StoreState };

/** One process owns the database and its execution queue, including across dev HMR. */
export function getDatabase(): DatabaseSync {
  if (globals[storeKey]) return globals[storeKey].database;
  const directory = dataDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lockPath = join(directory, "workspace.lock");
  const token = randomUUID();
  const acquire = () => {
    const descriptor = openSync(lockPath, "wx", 0o600);
    try {
      writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token }));
    } finally {
      closeSync(descriptor);
    }
  };
  try {
    acquire();
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    let owner: { pid?: number };
    try {
      owner = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number };
    } catch {
      throw new Error(`Invalid durable store lock at ${lockPath}; refuse to risk a second worker.`);
    }
    if (!Number.isInteger(owner.pid) || (owner.pid ?? 0) <= 0) {
      throw new Error(`Invalid durable store lock at ${lockPath}.`);
    }
    try {
      process.kill(owner.pid!, 0);
      throw new Error(
        `Durable store already owned by process ${owner.pid}. Stop it before starting another server.`,
      );
    } catch (cause) {
      if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "ESRCH") throw cause;
    }
    unlinkSync(lockPath);
    acquire();
  }
  const release = () => {
    try {
      const owner = JSON.parse(readFileSync(lockPath, "utf8")) as { token?: string };
      if (owner.token === token) unlinkSync(lockPath);
    } catch {
      // A removed lock must not prevent process shutdown.
    }
  };
  let database: DatabaseSync | undefined;
  try {
    const filename = join(directory, "workspace.sqlite");
    database = new DatabaseSync(filename);
    chmodSync(filename, 0o600);
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS records (
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (namespace, key)
      );
      CREATE TABLE IF NOT EXISTS run_events (
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event TEXT NOT NULL,
        PRIMARY KEY (run_id, seq)
      );
      CREATE TABLE IF NOT EXISTS worker_owner (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        pid INTEGER NOT NULL,
        token TEXT NOT NULL
      );
    `);
    database.exec("BEGIN IMMEDIATE");
    const owner = database.prepare("SELECT pid, token FROM worker_owner WHERE singleton = 1").get();
    if (owner) {
      let alive = true;
      try {
        process.kill(Number(owner.pid), 0);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH") alive = false;
        else throw error;
      }
      if (alive) throw new Error(`Durable worker already active in process ${String(owner.pid)}.`);
    }
    database
      .prepare(
        "INSERT INTO worker_owner(singleton, pid, token) VALUES (1, ?, ?) ON CONFLICT(singleton) DO UPDATE SET pid = excluded.pid, token = excluded.token",
      )
      .run(process.pid, token);
    database.exec("COMMIT");
  } catch (error) {
    database?.close();
    release();
    throw error;
  }
  globals[storeKey] = { database, directory, depth: 0, token, release };
  process.once("exit", release);
  return database;
}

/** Call only after chat, execution and automation workers have stopped. */
export function closeStore(): void {
  const state = globals[storeKey];
  if (!state) return;
  if (state.depth) throw new Error("Cannot close durable store inside a transaction.");
  state.database
    .prepare("DELETE FROM worker_owner WHERE singleton = 1 AND token = ?")
    .run(state.token);
  state.database.close();
  process.removeListener("exit", state.release);
  state.release();
  delete globals[storeKey];
}

export function readRecord<T>(namespace: string, key: string): T | null {
  const row = getDatabase()
    .prepare("SELECT value FROM records WHERE namespace = ? AND key = ?")
    .get(namespace, key);
  return row ? (JSON.parse(String(row.value)) as T) : null;
}

export function writeRecord<T>(namespace: string, key: string, value: T): void {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("Durable records must be JSON values.");
  getDatabase()
    .prepare(
      "INSERT INTO records(namespace, key, value) VALUES (?, ?, ?) ON CONFLICT(namespace, key) DO UPDATE SET value = excluded.value",
    )
    .run(namespace, key, encoded);
}

export function deleteRecord(namespace: string, key: string): void {
  getDatabase().prepare("DELETE FROM records WHERE namespace = ? AND key = ?").run(namespace, key);
}

export function listRecords<T>(namespace: string): T[] {
  return getDatabase()
    .prepare("SELECT value FROM records WHERE namespace = ? ORDER BY rowid")
    .all(namespace)
    .map((row) => JSON.parse(String(row.value)) as T);
}

/** Synchronous transactions compose through savepoints; async callbacks are rejected. */
export function transaction<T>(fn: () => T): T {
  const database = getDatabase();
  const state = globals[storeKey]!;
  const depth = state.depth++;
  const savepoint = `nested_${depth}`;
  try {
    database.exec(depth ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
    const result = fn();
    if (
      result &&
      (typeof result === "object" || typeof result === "function") &&
      "then" in result &&
      typeof result.then === "function"
    ) {
      throw new TypeError("A durable transaction callback must be synchronous.");
    }
    database.exec(depth ? `RELEASE ${savepoint}` : "COMMIT");
    return result;
  } catch (error) {
    if (database.isTransaction) {
      database.exec(depth ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : "ROLLBACK");
    }
    throw error;
  } finally {
    state.depth--;
  }
}
