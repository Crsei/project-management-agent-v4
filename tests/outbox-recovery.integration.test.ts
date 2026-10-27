import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Pool } from 'pg';
import { runCommand } from '../packages/application/src/kernel.ts';
import { listOutboxFailures, retryFailedOutbox } from '../packages/application/src/outbox-admin.ts';
import { publishOutboxBatch } from '../packages/application/src/outbox.ts';
import { intentCommands } from '../packages/application/src/intent.ts';
import type { Actor, Entity } from '../packages/domain/src/core.ts';
import { createUser, createWorkspace } from '../packages/infrastructure/src/auth.ts';
import { createPool, migrate } from '../packages/infrastructure/src/database.ts';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const cli = fileURLToPath(new URL('../scripts/outbox-admin.ts', import.meta.url));
const worker = fileURLToPath(new URL('../apps/worker/src/main.ts', import.meta.url));

describe('Controlled outbox recovery on PostgreSQL and the operator CLI', { skip: !databaseUrl }, () => {
  const namespace = `test_outbox_recovery_${randomUUID().replaceAll('-', '')}`;
  let bootstrap: Pool;
  let pool: Pool;
  let actor: Actor;
  let isolatedUrl: string;

  before(async () => {
    bootstrap = createPool(databaseUrl!);
    await bootstrap.query(`CREATE SCHEMA ${namespace}`);
    const url = new URL(databaseUrl!);
    url.searchParams.set('options', `-c search_path=${namespace},public`);
    isolatedUrl = url.toString();
    pool = createPool(isolatedUrl);
    await migrate(pool);
    actor = await createUser(pool, { email: 'outbox-operator@example.test', name: 'Outbox fixture owner', password: 'outbox-recovery-password-01' });
  });

  after(async () => {
    await pool?.end();
    if (bootstrap) {
      await bootstrap.query(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`);
      await bootstrap.end();
    }
  });

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

  async function operator(action: 'failed' | 'retry', workspace: string) {
    return execute(process.execPath, [cli, action, '--workspace', workspace], { cwd: root, env: { ...process.env, DATABASE_URL: isolatedUrl } });
  }

  async function restartWorkerForOneCycle(): Promise<void> {
    const child = spawn(process.execPath, [worker], { cwd: root, env: { ...process.env, DATABASE_URL: isolatedUrl, WORKER_INTERVAL_MS: '25' }, stdio: 'ignore' });
    const closed = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    try {
      let observed = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        assert.equal(child.exitCode, null, 'Restarted worker exited before completing a cycle');
        const heartbeat = await pool.query("SELECT id FROM service_heartbeats WHERE role='worker' AND details->>'state'='running'");
        if (heartbeat.rowCount) { observed = true; break; }
        await delay(25);
      }
      assert.equal(observed, true, 'Restarted worker did not record a completed cycle');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      const deadline = setTimeout(() => child.kill('SIGKILL'), 4000);
      deadline.unref();
      try { assert.equal(await closed, 0, 'Own test worker must exit cleanly'); }
      finally { clearTimeout(deadline); }
    }
  }

  it('quarantines after ten failures, survives worker restart and resumes original ordered event IDs only after manual retry', async () => {
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
    await restartWorkerForOneCycle();
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM events')).rows[0]!.n, 0);
    assert.deepEqual((await listOutboxFailures(pool, workspace)).map(row => row.eventId), originals.rows.map(row => row.event_id));
    await pool.query('UPDATE outbox SET last_error=$2 WHERE workspace_id=$1', [workspace, 'private-connection-and-provider-details']);
    const failed = await operator('failed', workspace.toUpperCase());
    assert.equal(failed.stderr, '');
    assert.ok(!failed.stdout.includes('private-connection-and-provider-details'));
    assert.ok(!failed.stdout.includes('sensitive-test-payload'));
    const listed = JSON.parse(failed.stdout) as Record<string, unknown>[];
    assert.equal(listed.length, 3);
    for (const row of listed) assert.deepEqual(Object.keys(row).sort(), ['attempts', 'eventId', 'safeError', 'type']);
    assert.deepEqual(listed.map(row => row.safeError), ['publish_failed', 'publish_failed', 'publish_failed']);
    assert.deepEqual(JSON.parse((await operator('retry', workspace.toUpperCase())).stdout), { workspace, count: 3 });
    assert.deepEqual((await pool.query('SELECT attempts FROM outbox WHERE workspace_id=$1 ORDER BY id', [workspace])).rows.map(row => row.attempts), [0, 0, 0]);
    assert.equal((await listOutboxFailures(pool, unrelated.workspace))[0]!.attempts, 10);
    assert.equal(await publishOutboxBatch(pool), 3);
    const events = await pool.query<{ event_id: string; cursor: string; sequence: string }>("SELECT event_id,cursor::text,envelope->>'eventSequence' AS sequence FROM events WHERE workspace_id=$1 ORDER BY events.cursor", [workspace]);
    assert.deepEqual(events.rows.map(row => row.event_id), originals.rows.map(row => row.event_id));
    assert.deepEqual(events.rows.map(row => row.sequence), originals.rows.map(row => row.aggregate_sequence));
    assert.deepEqual(events.rows.map(row => row.cursor), ['1', '2', '3']);
    assert.deepEqual(JSON.parse((await operator('retry', workspace)).stdout), { workspace, count: 0 });
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

  it('rolls back the retry when its mandatory audit recorder fails', async () => {
    const { workspace } = await fixture();
    await pool.query('UPDATE outbox SET attempts=10 WHERE workspace_id=$1', [workspace]);
    await assert.rejects(retryFailedOutbox(pool, workspace, async operation => {
      assert.deepEqual(operation, { workspace, count: 1 });
      throw new Error('test audit recorder unavailable');
    }), /test audit recorder unavailable/);
    assert.equal((await listOutboxFailures(pool, workspace))[0]!.attempts, 10);
  });
});
