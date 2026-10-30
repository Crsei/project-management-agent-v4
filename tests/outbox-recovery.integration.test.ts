import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Pool } from 'pg';
import { runCommand } from '../packages/application/src/kernel.ts';
import { listOutboxFailures, retryFailedOutbox } from '../packages/application/src/outbox-admin.ts';
import { publishOutboxBatch } from '../packages/application/src/outbox.ts';
import { intentCommands } from '../packages/application/src/intent.ts';
import type { Actor, Entity } from '../packages/domain/src/core.ts';
import { createUser, createWorkspace } from '../packages/infrastructure/src/auth.ts';
import { acquireMailFixtureDatabase } from './mail-fixture-database.ts';
import { MailFixtureScope, mailSchemaInitTimeout } from './mail-fixture-lifecycle.ts';
import { startOwnedMailWorker } from './mail-worker-process.ts';
import { assertV4WorkerTestDatabase, outboxWorkerEnvironment } from './worker-environment.ts';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const cli = fileURLToPath(new URL('../scripts/outbox-admin.ts', import.meta.url));

describe('Controlled outbox recovery on PostgreSQL and the operator CLI', { skip: !databaseUrl }, () => {
  let pool: Pool;
  let actor: Actor;
  let isolatedUrl: string;
  let coreRoot: string;
  let scope: MailFixtureScope;

  before(async t => {
    assertV4WorkerTestDatabase(databaseUrl!);
    scope = new MailFixtureScope(t.signal, mailSchemaInitTimeout);
    await scope.initialize(async () => {
      const database = await acquireMailFixtureDatabase(scope);
      pool = database.pool;
      isolatedUrl = database.databaseUrl;
      coreRoot = await scope.acquire(() => mkdtemp(join(tmpdir(), 'pm-outbox-worker-')), root => rm(root, { recursive: true, force: true }));
      actor = await scope.step(() => createUser(pool, { email: 'outbox-operator@example.test', name: 'Outbox fixture owner', password: 'outbox-recovery-password-01' }));
    });
  }, { timeout: mailSchemaInitTimeout });

  after(async () => { await scope?.close(); }, { timeout: 30_000 });

  async function fixture(eventCount = 1): Promise<{ workspace: string; entity: Entity }> {
    const workspace = (await createWorkspace(pool, actor.id, 'Outbox recovery')).id;
    // Core Markdown commands no longer write PM outbox rows. PM-only
    // conversation commands produce the durable publication fixture instead.
    const created = await runCommand(pool, actor, workspace, { commandId: randomUUID(), commandType: 'CreateConversation', payload: { title: 'Recovery fixture' } }, intentCommands);
    assert.equal(created.status, 'committed');
    let entity = created.result as Entity;
    for (let index = 1; index < eventCount; index++) {
      const updated = await runCommand(pool, actor, workspace, { commandId: randomUUID(), commandType: 'AppendMessage', targetId: entity.id, expectedVersions: { [entity.id]: entity.version }, payload: { content: index === 1 ? 'sensitive-test-payload' : `Revision ${index}` } }, intentCommands);
      assert.equal(updated.status, 'committed');
      // AppendMessage's committed result is the conversation plus the new message.
      const committedMessage = updated.result as { conversation: Entity };
      entity = committedMessage.conversation;
    }
    return { workspace, entity };
  }

  async function operator(action: 'failed' | 'retry', workspace: string, signal: AbortSignal) {
    return execute(process.execPath, [cli, action, '--workspace', workspace], {
      cwd: root, env: outboxWorkerEnvironment(isolatedUrl, coreRoot), signal,
      timeout: 15_000, maxBuffer: 65_536, killSignal: 'SIGTERM',
    });
  }

  async function restartWorkerForOneCycle(signal: AbortSignal): Promise<void> {
    const child = scope.own(startOwnedMailWorker({ env: outboxWorkerEnvironment(isolatedUrl, coreRoot), signal }), worker => worker.stop());
    try {
      await child.until(() => child.hasEvent('worker_started'), 'restarted Worker startup');
      await child.until(async () => {
        const heartbeat = await pool.query("SELECT id FROM service_heartbeats WHERE role='worker' AND details->>'state'='running'");
        return !!heartbeat.rowCount;
      }, 'restarted Worker completed cycle');
    } finally {
      assert.deepEqual(await child.stop(), { code: 0, signal: null, forced: false }, child.diagnostics());
      assert.equal(child.hasEvent('worker_stopped'), true, child.diagnostics());
      assert.equal(child.hasEvent('worker_cycle_failed'), false, child.diagnostics());
    }
  }

  it('quarantines after ten failures, survives worker restart and resumes original ordered event IDs only after manual retry', { timeout: 60_000 }, async t => {
    const { workspace } = await fixture(3);
    const unrelated = await fixture();
    await pool.query('UPDATE outbox SET attempts=10 WHERE workspace_id=$1', [unrelated.workspace]);
    const originals = await pool.query<{ event_id: string; aggregate_sequence: string }>('SELECT event_id,aggregate_sequence::text FROM outbox WHERE workspace_id=$1 ORDER BY id', [workspace]);
    const receipts = (await pool.query('SELECT command_id,receipt FROM command_receipts ORDER BY command_id')).rows;
    const entities = (await pool.query('SELECT id,version,data FROM entities ORDER BY id')).rows;
    await pool.query("CREATE FUNCTION audit_fail_publication() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected publication failure'; END $$");
    await pool.query('CREATE TRIGGER audit_fail_publication BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION audit_fail_publication()');
    for (let attempt = 0; attempt < 10; attempt++) await assert.rejects(publishOutboxBatch(pool), { code: 'P0001' });
    assert.deepEqual((await listOutboxFailures(pool, workspace)).map(row => row.attempts), [10, 10, 10]);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM events')).rows[0]!.n, 0);
    await pool.query('DROP TRIGGER audit_fail_publication ON events');
    await pool.query('DROP FUNCTION audit_fail_publication()');
    // Recovery of the underlying fault plus a real Worker process restart must
    // preserve quarantine rather than silently skip or recreate the old rows.
    await restartWorkerForOneCycle(t.signal);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM events')).rows[0]!.n, 0);
    assert.deepEqual((await listOutboxFailures(pool, workspace)).map(row => row.eventId), originals.rows.map(row => row.event_id));
    await pool.query('UPDATE outbox SET last_error=$2 WHERE workspace_id=$1', [workspace, 'private-connection-and-provider-details']);
    const failed = await operator('failed', workspace.toUpperCase(), t.signal);
    assert.equal(failed.stderr, '');
    assert.ok(!failed.stdout.includes('private-connection-and-provider-details'));
    assert.ok(!failed.stdout.includes('sensitive-test-payload'));
    const listed = JSON.parse(failed.stdout) as Record<string, unknown>[];
    assert.equal(listed.length, 3);
    for (const row of listed) assert.deepEqual(Object.keys(row).sort(), ['attempts', 'eventId', 'safeError', 'type']);
    assert.deepEqual(listed.map(row => row.safeError), ['publish_failed', 'publish_failed', 'publish_failed']);
    assert.deepEqual(JSON.parse((await operator('retry', workspace.toUpperCase(), t.signal)).stdout), { workspace, count: 3 });
    assert.deepEqual((await pool.query('SELECT attempts FROM outbox WHERE workspace_id=$1 ORDER BY id', [workspace])).rows.map(row => row.attempts), [0, 0, 0]);
    assert.equal((await listOutboxFailures(pool, unrelated.workspace))[0]!.attempts, 10);
    assert.equal(await publishOutboxBatch(pool), 3);
    const events = await pool.query<{ event_id: string; cursor: string; sequence: string }>("SELECT event_id,cursor::text,envelope->>'eventSequence' AS sequence FROM events WHERE workspace_id=$1 ORDER BY events.cursor", [workspace]);
    assert.deepEqual(events.rows.map(row => row.event_id), originals.rows.map(row => row.event_id));
    assert.deepEqual(events.rows.map(row => row.sequence), originals.rows.map(row => row.aggregate_sequence));
    assert.deepEqual(events.rows.map(row => row.cursor), ['1', '2', '3']);
    assert.deepEqual(JSON.parse((await operator('retry', workspace, t.signal)).stdout), { workspace, count: 0 });
    assert.equal(await publishOutboxBatch(pool), 0);
    assert.deepEqual((await pool.query('SELECT count(*)::int AS n,count(DISTINCT event_id)::int AS unique_events FROM events WHERE workspace_id=$1', [workspace])).rows[0], { n: 3, unique_events: 3 });
    assert.deepEqual((await pool.query('SELECT command_id,receipt FROM command_receipts ORDER BY command_id')).rows, receipts);
    assert.deepEqual((await pool.query('SELECT id,version,data FROM entities ORDER BY id')).rows, entities);
    const logPath = new URL('../.local/logs/outbox-maintenance.ndjson', import.meta.url);
    assert.equal((await stat(logPath)).mode & 0o777, 0o600);
    const operations = (await readFile(logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { time: string; uid: number; workspace: string; count: number; phase: string }).filter(row => row.workspace === workspace);
    assert.deepEqual(operations.map(row => [row.phase, row.count]), [['prepared', 3], ['committed', 3], ['prepared', 0], ['committed', 0]]);
    for (const operation of operations) {
      assert.equal(operation.uid, process.getuid?.());
      assert.ok(Number.isFinite(Date.parse(operation.time)));
    }
  });

  it('rolls back the retry when its mandatory audit recorder fails', { timeout: 30_000 }, async () => {
    const { workspace } = await fixture();
    await pool.query('UPDATE outbox SET attempts=10 WHERE workspace_id=$1', [workspace]);
    await assert.rejects(retryFailedOutbox(pool, workspace, async operation => {
      assert.deepEqual(operation, { workspace, count: 1 });
      throw new Error('test audit recorder unavailable');
    }), /test audit recorder unavailable/);
    assert.equal((await listOutboxFailures(pool, workspace))[0]!.attempts, 10);
  });
});
