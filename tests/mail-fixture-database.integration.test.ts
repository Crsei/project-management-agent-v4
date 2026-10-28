import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { PoolClient } from 'pg';
import { createPool } from '../packages/infrastructure/src/database.ts';
import { createRecoveryFixture } from './account-recovery-fixture.ts';
import { createMailFixtureDatabase, mailTestDatabaseUrl } from './mail-fixture-database.ts';
import type { MailFixtureDatabase } from './mail-fixture-database.ts';
import { MailFixtureScope, mailFixtureCaseTimeout, mailFixtureCleanupTimeout, mailSchemaInitTimeout } from './mail-fixture-lifecycle.ts';
import { createInvitationFixture } from './member-invitations-fixture.ts';

async function waitForOwnedWaiter(client: PoolClient, blocker: number, signal: AbortSignal) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    await client.query('SELECT pg_stat_clear_snapshot()');
    const result = await client.query<{ pid: number }>(
      "SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock'", [blocker]);
    if (result.rows[0]) return result.rows[0].pid;
    await delay(10, undefined, { signal });
  }
  assert.fail('The owned initialization did not reach the controlled database lock');
}

describe('mail fixture owned schema reuse', { skip: !mailTestDatabaseUrl, concurrency: false }, () => {
  let database: MailFixtureDatabase;
  const queryWarnings: string[] = [];
  const observeWarning = (warning: Error) => {
    if (warning.message.includes('Calling client.query() when the client is already executing a query')) queryWarnings.push(warning.message);
  };
  before(async t => {
    process.on('warning', observeWarning);
    database = await createMailFixtureDatabase({ signal: t.signal });
  }, { timeout: mailSchemaInitTimeout });
  after(async () => {
    try { await database?.close(); }
    finally { process.off('warning', observeWarning); }
    assert.deepEqual(queryWarnings, [], 'Backend identity capture must finish before the borrower executes a query');
  }, { timeout: mailFixtureCleanupTimeout });

  it('resets every business table and identity without remigrating, with fresh auth, SMTP and files', { timeout: mailFixtureCaseTimeout }, async t => {
    const first = await createRecoveryFixture({ database, signal: t.signal });
    t.after(() => first.close(), { timeout: mailFixtureCleanupTimeout });
    const migrations = (await first.pool.query('SELECT name,sha256,applied_at FROM schema_migrations ORDER BY name')).rows;
    const relationFiles = (await first.pool.query(
      "SELECT relname,relfilenode FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND relkind IN ('r','i') ORDER BY relname", [database.namespace])).rows;
    assert.equal((await first.pool.query('SELECT current_schema() AS schema')).rows[0].schema, database.namespace);
    assert.match(database.namespace, /^test_mail_[a-f0-9]{32}$/);
    assert.equal(new URL(database.databaseUrl).searchParams.get('options'), `-c search_path=${database.namespace}`);
    const email = await first.bind();
    await first.request('/api/v1/auth/password-recovery/requests', { requestId: randomUUID(), email }, '');
    await first.pool.query("INSERT INTO account_auth_limits(key,attempts,expires_at) VALUES($1,100,clock_timestamp()+interval '1 hour')", ['a'.repeat(64)]);
    await first.pool.query("INSERT INTO service_heartbeats(id,role,heartbeat_at) VALUES('old-case','worker',clock_timestamp())");
    assert.equal((await first.pool.query("SELECT nextval('outbox_id_seq') AS id")).rows[0].id, '1');
    await mkdir(first.coreRoot, { recursive: true });
    await writeFile(join(first.coreRoot, 'old-case.txt'), 'Only the previous case may see this');
    const closing = first.close();
    assert.equal(first.close(), closing);
    await closing;
    assert.equal(first.app.server.listening, false);
    await assert.rejects(stat(first.coreRoot), { code: 'ENOENT' });

    const raw = new MailFixtureScope(t.signal);
    t.after(() => raw.close(), { timeout: mailFixtureCleanupTimeout });
    await raw.initialize(async () => {
      const { pool } = await database.acquire(raw);
      const tables = await pool.query<{ name: string }>(
        "SELECT tablename AS name FROM pg_tables WHERE schemaname=$1 AND tablename<>'schema_migrations'", [database.namespace]);
      for (const table of tables.rows) {
        const name = `"${database.namespace}"."${table.name.replaceAll('"', '""')}"`;
        assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${name}`)).rows[0].n, 0, `${table.name} leaked prior case data`);
      }
      assert.deepEqual((await pool.query('SELECT name,sha256,applied_at FROM schema_migrations ORDER BY name')).rows, migrations);
      assert.deepEqual((await pool.query(
        "SELECT relname,relfilenode FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND relkind IN ('r','i') ORDER BY relname", [database.namespace])).rows, relationFiles,
      'Per-case reset must reuse migrated heap/index files rather than recreate them with TRUNCATE');
      assert.equal((await pool.query("SELECT nextval('outbox_id_seq') AS id")).rows[0].id, '1');
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND NOT t.tgisinternal AND t.tgenabled='D'", [database.namespace])).rows[0].n, 0);
    });
    await raw.close();

    const second = await createRecoveryFixture({ database, signal: t.signal });
    t.after(() => second.close(), { timeout: mailFixtureCleanupTimeout });
    assert.equal(second.databaseUrl, first.databaseUrl);
    assert.notEqual(second.user.id, first.user.id);
    assert.notEqual(second.cookie, first.cookie);
    assert.notEqual(second.coreRoot, first.coreRoot);
    assert.notDeepEqual(second.config.tokenKey, first.config.tokenKey);
    assert.deepEqual(second.smtp.messages, []);
    assert.equal(second.smtp.mode, 'accept');
    assert.equal((await second.request('/api/v1/auth/me', undefined, first.cookie)).status, 401);
    assert.equal((await second.pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 1);
    assert.equal((await second.pool.query('SELECT count(*)::int AS n FROM memberships')).rows[0].n, 0);
    assert.equal((await second.pool.query('SELECT recovery_email,credential_version FROM users')).rows[0].recovery_email, null);
    assert.equal((await second.pool.query('SELECT epoch::text,state FROM blob_storage_binding')).rows[0].epoch, '1');
    await second.close();

    const disabled = await createInvitationFixture({ database, signal: t.signal, disabled: true });
    t.after(() => disabled.close(), { timeout: mailFixtureCleanupTimeout });
    assert.equal((await disabled.send({ commandId: randomUUID(), commandType: 'CreateMemberInvitation', payload: { email: 'disabled@example.test', role: 'member', projectIds: null } })).body.error?.code, 'invitation_mail_disabled');
    assert.equal((await disabled.pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 1);
    assert.equal((await disabled.pool.query('SELECT epoch::text FROM blob_storage_binding')).rows[0].epoch, '1');
  });

  it('rolls back an interrupted per-case reset and releases its lease before the next case', { timeout: mailFixtureCaseTimeout }, async t => {
    const previous = await createInvitationFixture({ database, signal: t.signal });
    t.after(() => previous.close(), { timeout: mailFixtureCleanupTimeout });
    const invitation = await previous.invite();
    await previous.close();
    const blockerPool = createPool(database.databaseUrl);
    const blocker = await blockerPool.connect();
    const controller = new AbortController();
    const reason = new Error('Cancel while the owned schema reset is blocked');
    let initialization: Promise<unknown> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE users IN ACCESS EXCLUSIVE MODE');
      const pid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      initialization = createRecoveryFixture({ database, signal: AbortSignal.any([controller.signal, t.signal]) });
      const rejected = assert.rejects(initialization, error => error === reason);
      const waitingPid = await waitForOwnedWaiter(blocker, pid, t.signal);
      controller.abort(reason);
      // Do not release the lock to make cancellation pass: abort must terminate
      // the owned reset query, roll it back, and settle while this lock is held.
      await rejected;
      await blocker.query('SELECT pg_stat_clear_snapshot()');
      assert.equal((await blocker.query('SELECT 1 FROM pg_stat_activity WHERE pid=$1', [waitingPid])).rowCount, 0);
      assert.equal((await blocker.query('SELECT count(*)::int AS n FROM users WHERE id=$1', [previous.owner.id])).rows[0].n, 1);
      assert.equal((await blocker.query('SELECT count(*)::int AS n FROM member_invitations WHERE id=$1', [invitation.id])).rows[0].n, 1,
        'Canceled reset must roll back deletions already performed before the blocked parent table');
      await blocker.query('ROLLBACK');
      const next = await createInvitationFixture({ database, signal: t.signal });
      t.after(() => next.close(), { timeout: mailFixtureCleanupTimeout });
      assert.equal((await next.pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 1);
      assert.equal((await next.pool.query("SELECT count(*)::int AS n FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND NOT t.tgisinternal AND t.tgenabled='D'", [database.namespace])).rows[0].n, 0);
    } finally {
      controller.abort(reason);
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
      await initialization?.catch(() => undefined);
      await blockerPool.end();
    }
  });

  it('cancels a real migration waiting on its lock, drops its partial schema and ends its connection', { timeout: mailFixtureCaseTimeout }, async t => {
    const observer = createPool(mailTestDatabaseUrl!);
    const blocker = await observer.connect();
    const controller = new AbortController();
    const reason = new Error('Cancel an owned migration before it can proceed');
    let initialization: Promise<MailFixtureDatabase> | undefined;
    try {
      const before = new Set((await blocker.query<{ nspname: string }>("SELECT nspname FROM pg_namespace WHERE nspname LIKE 'test_mail_%'")).rows.map(row => row.nspname));
      await blocker.query('BEGIN');
      await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended('project-management:migrations',724631))");
      const pid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      initialization = createMailFixtureDatabase({ signal: AbortSignal.any([controller.signal, t.signal]) });
      const rejected = assert.rejects(initialization, error => error === reason);
      const waitingPid = await waitForOwnedWaiter(blocker, pid, t.signal);
      const owned = (await blocker.query<{ nspname: string }>("SELECT nspname FROM pg_namespace WHERE nspname LIKE 'test_mail_%'")).rows.filter(row => !before.has(row.nspname));
      assert.equal(owned.length, 1, 'Only this initialization should create a new schema');
      controller.abort(reason);
      await rejected;
      assert.equal((await blocker.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [owned[0]!.nspname])).rowCount, 0);
      await blocker.query('SELECT pg_stat_clear_snapshot()');
      assert.equal((await blocker.query('SELECT 1 FROM pg_stat_activity WHERE pid=$1', [waitingPid])).rowCount, 0);
    } finally {
      controller.abort(reason);
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
      const late = await initialization?.catch(() => undefined);
      await late?.close();
      await observer.end();
    }
  });

  it('rejects fabricated database owners rather than resetting a caller-selected schema', { timeout: 5000 }, async t => {
    let acquired = false;
    const fabricated: MailFixtureDatabase = {
      namespace: 'public', databaseUrl: database.databaseUrl,
      async acquire() { acquired = true; throw new Error('Must never acquire an unowned schema'); },
      async close() {},
    };
    await assert.rejects(createRecoveryFixture({ database: fabricated, signal: t.signal }), /Only a database created by createMailFixtureDatabase/);
    assert.equal(acquired, false);
  });
});
