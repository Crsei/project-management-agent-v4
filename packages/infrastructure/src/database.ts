import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { SqlExecutor } from '../../application/src/ports.ts';
import * as schema from './schema.ts';

export function createPool(databaseUrl: string, max = 10): Pool {
  let url: URL;
  try { url = new URL(databaseUrl); }
  catch { throw new Error('DATABASE_URL must be a valid PostgreSQL URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL must use PostgreSQL');
  const pool = new Pool({ connectionString: databaseUrl, max, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 30_000, statement_timeout: 15_000, application_name: 'project-management' });
  // An idle connection can disappear during PostgreSQL maintenance. Keep the
  // process alive; readiness and query errors expose the outage until recovery.
  pool.on('error', error => {
    console.error(JSON.stringify({ event: 'database_connection_error', code: (error as { code?: string }).code ?? 'connection_lost' }));
  });
  return pool;
}
export function databaseFor(pool: Pool) { return drizzle(pool, { schema }); }

/** The API, authorization commands and Worker must take this exact lock before workspace writes. */
export async function lockWorkspace(sql: SqlExecutor, workspaceId: string): Promise<void> {
  await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text, 724631))', [workspaceId]);
}

export async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('project-management:migrations', 724631))");
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    let folder = new URL('../migrations/', import.meta.url);
    let files: string[];
    try { files = await readdir(folder); }
    catch { folder = new URL('../../../../packages/infrastructure/migrations/', import.meta.url); files = await readdir(folder); }
    for (const name of files.filter((file) => /^\d+_[\w-]+\.sql$/.test(file)).sort()) {
      const content = await readFile(new URL(name, folder), 'utf8');
      const digest = createHash('sha256').update(content).digest('hex');
      const prior = await client.query<{ sha256: string }>('SELECT sha256 FROM schema_migrations WHERE name=$1', [name]);
      if (prior.rows[0]) {
        if (prior.rows[0].sha256 !== digest) throw new Error(`Applied migration checksum differs: ${name}`);
        continue;
      }
      await client.query(content);
      await client.query('INSERT INTO schema_migrations(name,sha256) VALUES($1,$2)', [name, digest]);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function checkDatabase(pool: Pool): Promise<{ ready: boolean; schemaVersion: string | null }> {
  const result = await pool.query<{ version: string | null; entities: string | null; outbox: string | null; events: string | null; heartbeats: string | null }>(
    "SELECT (SELECT max(name) FROM schema_migrations) AS version, to_regclass('entities')::text AS entities, to_regclass('outbox')::text AS outbox, to_regclass('events')::text AS events, to_regclass('service_heartbeats')::text AS heartbeats");
  const row = result.rows[0];
  let folder = new URL('../migrations/', import.meta.url);
  let files: string[];
  try { files = await readdir(folder); }
  catch { folder = new URL('../../../../packages/infrastructure/migrations/', import.meta.url); files = await readdir(folder); }
  const expected = files.filter(file => /^\d+_[\w-]+\.sql$/.test(file)).sort();
  const applied = await pool.query<{ name: string; sha256: string }>('SELECT name,sha256 FROM schema_migrations');
  const checksums = new Map(applied.rows.map(migration => [migration.name, migration.sha256]));
  let schemaMatches = expected.length > 0 && row?.version === expected.at(-1) && applied.rowCount === expected.length;
  for (const name of expected) {
    const hash = createHash('sha256').update(await readFile(new URL(name, folder), 'utf8')).digest('hex');
    if (checksums.get(name) !== hash) schemaMatches = false;
  }
  return { ready: Boolean(schemaMatches && row?.entities && row.outbox && row.events && row.heartbeats), schemaVersion: row?.version ?? null };
}
