import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { createPool, migrate } from '../packages/infrastructure/src/database.ts';
import { interruptMailPoolOnAbort, MailFixtureScope, mailSchemaInitTimeout } from './mail-fixture-lifecycle.ts';

export const mailTestDatabaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
export type MailFixtureDatabase = {
  readonly namespace: string;
  readonly databaseUrl: string;
  acquire(scope: MailFixtureScope): Promise<{ pool: Pool; databaseUrl: string }>;
  close(): Promise<void>;
};
const issuedDatabases = new WeakSet<MailFixtureDatabase>();
const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`;
async function assertEmptyMigratedBaseline(pool: Pool, namespace: string, oid: number, scope: MailFixtureScope) {
  const tables = await scope.step(() => pool.query<{ name: string }>(
    "SELECT relname AS name FROM pg_class WHERE relnamespace=$1 AND relkind IN ('r','p') AND relname<>'schema_migrations'", [oid]));
  for (const table of tables.rows) {
    const result = await scope.step(() => pool.query<{ seeded: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM ${identifier(namespace)}.${identifier(table.name)}) AS seeded`));
    assert.equal(result.rows[0]!.seeded, false,
      `Migration seed data in ${table.name}: update the mail fixture reset baseline before reusing this schema`);
  }
}

/** Resets data only in this invocation's verified, random, privately owned schema. */
async function resetOwnedSchema(pool: Pool, control: Pool, namespace: string, oid: number, scope: MailFixtureScope) {
  assert.match(namespace, /^test_mail_[a-f0-9]{32}$/);
  assert.ok(Number.isSafeInteger(oid));
  scope.checkpoint();
  const interruption = interruptMailPoolOnAbort(pool, scope.signal, control);
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    scope.checkpoint();
    // One auto-commit DO is atomic. DELETE reuses the migrated heap/index files;
    // TRUNCATE would recreate hundreds of files and dominate this HDD fixture.
    await scope.step(() => client!.query(`DO $mail_fixture_reset$
    DECLARE
      own_schema constant text := '${namespace}';
      own_oid constant oid := ${oid};
      remaining oid[];
      target oid;
      target_name text;
      has_rows boolean;
      guards jsonb;
      guard record;
      seq record;
      sequence_value bigint;
      sequence_called boolean;
    BEGIN
      IF current_schema() IS DISTINCT FROM own_schema OR
         (SELECT n.oid FROM pg_namespace n WHERE n.nspname=own_schema) IS DISTINCT FROM own_oid THEN
        RAISE EXCEPTION 'Mail reset schema ownership changed';
      END IF;
      SELECT array_agg(c.oid ORDER BY c.relname) INTO remaining FROM pg_class c
        WHERE c.relnamespace=own_oid AND c.relkind IN ('r','p') AND c.relname<>'schema_migrations';
      IF EXISTS(SELECT 1 FROM pg_constraint f WHERE f.contype='f' AND f.confrelid=ANY(remaining)
                AND NOT f.conrelid=ANY(remaining)) THEN
        RAISE EXCEPTION 'Mail reset refuses foreign keys from outside its owned tables';
      END IF;
      -- Deferred inbound FK checks otherwise remain queued when restoring a
      -- parent's DELETE guard. Child-first deletion permits immediate checks.
      SET CONSTRAINTS ALL IMMEDIATE;
      WHILE coalesce(cardinality(remaining),0)>0 LOOP
        SELECT candidate INTO target FROM unnest(remaining) AS candidates(candidate)
          WHERE NOT EXISTS(SELECT 1 FROM pg_constraint f WHERE f.contype='f'
            AND f.confrelid=candidate AND f.conrelid=ANY(remaining) AND f.conrelid<>candidate)
          ORDER BY candidate LIMIT 1;
        IF target IS NULL THEN RAISE EXCEPTION 'Mail reset requires acyclic inter-table foreign keys'; END IF;
        SELECT c.relname INTO STRICT target_name FROM pg_class c WHERE c.oid=target;
        EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.%I)',own_schema,target_name) INTO has_rows;
        IF has_rows THEN
          SELECT coalesce(jsonb_agg(jsonb_build_object('name',t.tgname,'enabled',t.tgenabled)),'[]'::jsonb)
            INTO guards FROM pg_trigger t WHERE t.tgrelid=target AND NOT t.tgisinternal
              AND (t.tgtype::int & 8)<>0 AND t.tgenabled<>'D';
          FOR guard IN SELECT * FROM jsonb_to_recordset(guards) AS g(name text,enabled text) LOOP
            EXECUTE format('ALTER TABLE %I.%I DISABLE TRIGGER %I',own_schema,target_name,guard.name);
          END LOOP;
          EXECUTE format('DELETE FROM %I.%I',own_schema,target_name);
          FOR guard IN SELECT * FROM jsonb_to_recordset(guards) AS g(name text,enabled text) LOOP
            EXECUTE format('ALTER TABLE %I.%I ENABLE %s TRIGGER %I',own_schema,target_name,
              CASE guard.enabled WHEN 'A' THEN 'ALWAYS' WHEN 'R' THEN 'REPLICA' ELSE '' END,guard.name);
          END LOOP;
        END IF;
        remaining := array_remove(remaining,target);
      END LOOP;
      FOR seq IN SELECT c.relname,s.seqstart FROM pg_class c JOIN pg_sequence s ON s.seqrelid=c.oid
        WHERE c.relnamespace=own_oid LOOP
        EXECUTE format('SELECT last_value,is_called FROM %I.%I',own_schema,seq.relname)
          INTO sequence_value,sequence_called;
        IF sequence_called OR sequence_value<>seq.seqstart THEN
          EXECUTE format('ALTER SEQUENCE %I.%I RESTART WITH %s',own_schema,seq.relname,seq.seqstart);
        END IF;
      END LOOP;
    END $mail_fixture_reset$`));
  } finally {
    client?.release();
    await interruption.finish();
  }
}

/** One real migration run per explicitly owned suite database, not per case. */
export async function createMailFixtureDatabase(options: { signal?: AbortSignal } = {}): Promise<MailFixtureDatabase> {
  if (!mailTestDatabaseUrl) throw new Error('A real TEST_DATABASE_URL or DATABASE_URL is required');
  const scope = new MailFixtureScope(options.signal, mailSchemaInitTimeout);
  return scope.initialize(async () => {
    const namespace = `test_mail_${randomUUID().replaceAll('-', '')}`;
    const control = scope.own(createPool(mailTestDatabaseUrl, 1), pool => pool.end());
    const bootstrap = scope.own(createPool(mailTestDatabaseUrl), pool => pool.end());
    let oid: number | undefined = undefined;
    let attemptedCreate = false;
    // Register before CREATE: a canceled query can commit before its reply is lost.
    scope.defer(async () => {
      if (!attemptedCreate) return;
      const found = await bootstrap.query<{ oid: number }>('SELECT oid FROM pg_namespace WHERE nspname=$1', [namespace]);
      if (!found.rows[0]) return;
      if (oid !== undefined) assert.equal(found.rows[0].oid, oid, 'Do not drop a replaced schema');
      await bootstrap.query(`DROP SCHEMA ${identifier(namespace)} CASCADE`);
    });
    const bootstrapInterruption = interruptMailPoolOnAbort(bootstrap, scope.signal, control);
    scope.defer(() => bootstrapInterruption.finish());
    await scope.step(async () => {
      attemptedCreate = true;
      try { await bootstrap.query(`CREATE SCHEMA ${identifier(namespace)}`); }
      catch (error) {
        // Even a UUID collision must not make someone else's schema ours.
        if ((error as NodeJS.ErrnoException).code === '42P06') attemptedCreate = false;
        throw error;
      }
    });
    oid = (await scope.step(() => bootstrap.query<{ oid: number }>('SELECT oid FROM pg_namespace WHERE nspname=$1', [namespace]))).rows[0]!.oid;
    const url = new URL(mailTestDatabaseUrl);
    // No public fallback: missing fixture relations must never hit business data.
    url.searchParams.set('options', `-c search_path=${namespace}`);
    const databaseUrl = url.toString();
    const pool = scope.own(createPool(databaseUrl), owned => owned.end());
    const migrationInterruption = interruptMailPoolOnAbort(pool, scope.signal, control);
    scope.defer(() => migrationInterruption.finish());
    await scope.step(() => migrate(pool));
    await assertEmptyMigratedBaseline(pool, namespace, oid, scope);
    migrationInterruption.detach();
    bootstrapInterruption.detach();
    const schemaOid = oid;
    let active: MailFixtureScope | undefined;
    let pristine = true;
    scope.defer(async () => { await active?.close(); });
    const database: MailFixtureDatabase = {
      namespace, databaseUrl, close: scope.close,
      async acquire(caseScope) {
        scope.checkpoint();
        caseScope.checkpoint();
        assert.equal(active, undefined, 'Mail fixture databases only support sequential cases; close the previous fixture first');
        active = caseScope;
        caseScope.defer(() => { if (active === caseScope) active = undefined; });
        if (pristine) {
          pristine = false;
          const ownership = await caseScope.step(() => pool.query<{ oid: number; current_schema: string }>(
            'SELECT oid,current_schema() FROM pg_namespace WHERE nspname=$1', [namespace]));
          assert.equal(ownership.rows[0]?.oid, schemaOid, 'The originally created schema must still be owned');
          assert.equal(ownership.rows[0]?.current_schema, namespace, 'Never use a caller-selected schema');
        } else await resetOwnedSchema(pool, control, namespace, schemaOid, caseScope);
        return { pool, databaseUrl };
      },
    };
    issuedDatabases.add(database);
    return database;
  }, true);
}

/** Standalone fixtures own a database; suites opt in to a single exclusive schema. */
export async function acquireMailFixtureDatabase(scope: MailFixtureScope, database?: MailFixtureDatabase) {
  if (database) {
    assert.ok(issuedDatabases.has(database), 'Only a database created by createMailFixtureDatabase can be reused');
  } else {
    database = await scope.acquire(() => createMailFixtureDatabase({ signal: scope.signal }), owned => owned.close());
  }
  const owned = database;
  return scope.step(() => owned.acquire(scope));
}
