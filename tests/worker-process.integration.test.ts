import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { buildApp } from '../apps/api/src/app.ts';
import { runCommand } from '../packages/application/src/kernel.ts';
import { createRegistry } from '../packages/application/src/registry.ts';
import type { CommandRegistry } from '../packages/application/src/ports.ts';
import type { Actor, Command, Entity } from '../packages/domain/src/core.ts';
import { createUser, createWorkspace } from '../packages/infrastructure/src/auth.ts';
import { LocalBlobStore } from '../packages/infrastructure/src/blobs.ts';
import { createPool, lockWorkspace, migrate } from '../packages/infrastructure/src/database.ts';
import { createBoundLocalStorage } from './blob-fixture.ts';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
type WorkerEvent = { event: string; id?: string; consecutiveFailures?: number };
type Worker = {
  child: ChildProcessWithoutNullStreams;
  pid: number;
  events: WorkerEvent[];
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  exited: boolean;
  launchError: string | null;
};

describe('INF-02: independent Worker processes publish and recover durable outbox', { skip: !databaseUrl, timeout: 90_000 }, () => {
  const namespace = `test_worker_process_${randomUUID().replaceAll('-', '')}`;
  const workers: Worker[] = [];
  let bootstrap: Pool;
  let pool: Pool;
  let scopedUrl: string;
  let blobRoot: string;
  let coreRoot: string;
  let registry: CommandRegistry;
  let owner: Actor;
  let app: ReturnType<typeof buildApp>;
  let origin: string;

  async function waitUntil(check: () => Promise<boolean> | boolean, message: string, activeWorkers: Worker[] = [], timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const worker of activeWorkers) {
        assert.equal(worker.launchError, null, `Owned Worker ${worker.pid} failed to launch: ${worker.launchError}`);
        assert.equal(worker.exited, false, `Owned Worker ${worker.pid} exited before ${message}`);
      }
      if (await check()) return;
      await setTimeout(25);
    }
    assert.fail(`Timed out waiting for ${message}`);
  }

  function startWorker(): Worker {
    const child = spawn(process.execPath, ['apps/worker/src/main.ts'], {
      cwd: projectRoot,
      env: { ...process.env, DATABASE_URL: scopedUrl, CORE_WORKSPACE_ROOT: coreRoot, WORKER_INTERVAL_MS: '25', EVENT_RETENTION_DAYS: '3650' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    assert.ok(child.pid, 'The Worker must have an owned OS process PID');
    const worker: Worker = { child, pid: child.pid, events: [], closed: Promise.resolve({ code: null, signal: null }), exited: false, launchError: null };
    worker.closed = new Promise(resolveExit => {
      child.once('error', error => { worker.launchError = (error as NodeJS.ErrnoException).code ?? 'spawn_failed'; });
      child.once('close', (code, signal) => { worker.exited = true; resolveExit({ code, signal }); });
    });
    for (const stream of [child.stdout, child.stderr]) {
      let pending = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        pending += chunk;
        let newline: number;
        while ((newline = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          try {
            const parsed = JSON.parse(line) as WorkerEvent;
            // Keep only the Worker's known non-secret lifecycle diagnostics.
            // Raw process output and environment values are never printed.
            if (['worker_started', 'worker_stopped', 'worker_cycle_failed'].includes(parsed.event)) worker.events.push(parsed);
          } catch { /* Non-JSON startup errors are represented by process exit. */ }
        }
      });
    }
    workers.push(worker);
    return worker;
  }

  async function stopWorker(worker: Worker) {
    if (!worker.exited) {
      // The ChildProcess handle owns this PID; no process-name matching,
      // service registry, process group, existing API or Docker is involved.
      worker.child.kill('SIGTERM');
      await waitUntil(() => worker.exited, `owned Worker ${worker.pid} to stop`, [], 15_000);
    }
    const result = await worker.closed;
    assert.equal(result.code, 0, `Owned Worker ${worker.pid} must shut down gracefully`);
    assert.equal(result.signal, null);
    assert.ok(worker.events.some(event => event.event === 'worker_stopped'));
    assert.equal(worker.events.some(event => event.event === 'worker_cycle_failed'), false, `Owned Worker ${worker.pid} reported a failed cycle`);
  }

  async function command<T = Entity>(workspaceId: string, commandType: string, payload: Record<string, unknown>, extra: Partial<Command> = {}): Promise<T> {
    const receipt = await runCommand(pool, owner, workspaceId, { commandId: randomUUID(), commandType, payload, ...extra }, registry);
    assert.equal(receipt.status, 'committed', JSON.stringify(receipt));
    return receipt.result as T;
  }
  async function fixture(name: string, itemCount: number) {
    const workspace = await createWorkspace(pool, owner.id, name);
    // Core Markdown commands do not write PM outbox rows. Conversation commands
    // are PM-only and each contributes exactly one durable outbox event.
    const created = await command(workspace.id, 'CreateConversation', { title: `${name} discussion` });
    const discussion = await createItems(workspace.id, created, itemCount);
    return { workspaceId: workspace.id, discussion };
  }
  async function createItems(workspaceId: string, discussion: Entity, count: number) {
    let current = discussion;
    for (let index = 0; index < count; index++) {
      const appended = await command<{ conversation: Entity; message: { id: string } }>(workspaceId, 'AppendMessage', { content: `Worker fixture ${index}` }, { targetId: current.id, expectedVersions: { [current.id]: current.version } });
      current = appended.conversation;
    }
    return current;
  }
  async function eventRows(workspaceId: string) {
    return (await pool.query<{ cursor: string; event_id: string }>('SELECT e.cursor::text,e.event_id FROM events e WHERE e.workspace_id=$1 ORDER BY e.cursor', [workspaceId])).rows;
  }
  async function pending(workspaceId: string) {
    return Number((await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM outbox WHERE workspace_id=$1 AND published_at IS NULL', [workspaceId])).rows[0]!.count);
  }
  async function heartbeatCount() {
    return Number((await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM service_heartbeats WHERE role='worker' AND heartbeat_at>now()-interval '20 seconds'")).rows[0]!.count);
  }
  async function readiness() {
    const response = await fetch(`${origin}/health/ready`);
    return { status: response.status, body: await response.json() as { checks: { database: boolean; storage: boolean; worker: boolean } } };
  }
  async function assertPublished(workspaceId: string, expectedCount: number) {
    const events = await eventRows(workspaceId);
    assert.equal(events.length, expectedCount);
    assert.equal(new Set(events.map(event => event.event_id)).size, expectedCount);
    assert.deepEqual(events.map(event => event.cursor), Array.from({ length: expectedCount }, (_, index) => String(index + 1)));
    const comparison = await pool.query<{ missing: string; unexpected: string }>(`SELECT
      (SELECT count(*)::text FROM outbox o LEFT JOIN events e ON e.event_id=o.event_id AND e.workspace_id=o.workspace_id WHERE o.workspace_id=$1 AND e.event_id IS NULL) AS missing,
      (SELECT count(*)::text FROM events e LEFT JOIN outbox o ON o.event_id=e.event_id AND o.workspace_id=e.workspace_id WHERE e.workspace_id=$1 AND o.event_id IS NULL) AS unexpected`, [workspaceId]);
    assert.deepEqual(comparison.rows[0], { missing: '0', unexpected: '0' });
    assert.equal(await pending(workspaceId), 0);
    return events;
  }

  before(async () => {
    bootstrap = createPool(databaseUrl!);
    await bootstrap.query(`CREATE SCHEMA ${namespace}`);
    const url = new URL(databaseUrl!);
    url.searchParams.set('options', `-c search_path=${namespace},public`);
    scopedUrl = url.toString();
    pool = createPool(scopedUrl);
    await migrate(pool);
    const testRoot = resolve(projectRoot, '.local/tests');
    await mkdir(testRoot, { recursive: true });
    blobRoot = await mkdtemp(join(testRoot, 'worker-process-'));
    coreRoot = await mkdtemp(join(testRoot, 'core-'));
    const blobs = new LocalBlobStore(blobRoot);
    await blobs.init();
    registry = createRegistry(blobs);
    owner = await createUser(pool, { email: 'worker-process-owner@example.test', password: 'worker-process-password-2026', name: 'Worker process owner' });
    app = buildApp({ databaseUrl: scopedUrl, ...await createBoundLocalStorage(pool, blobRoot), coreWorkspaceRoot: coreRoot });
    origin = await app.listen({ host: '127.0.0.1', port: 0 });
  });

  after(async () => {
    // All test-owned children stop before their schema or API pool disappears.
    const results = await Promise.allSettled(workers.map(worker => stopWorker(worker)));
    await app?.close();
    await pool?.end();
    if (bootstrap) {
      try { await bootstrap.query(`DROP SCHEMA ${namespace} CASCADE`); }
      finally { await bootstrap.end(); }
    }
    if (blobRoot) await rm(blobRoot, { recursive: true, force: true });
    if (coreRoot) await rm(coreRoot, { recursive: true, force: true });
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  });

  it('runs two real Node Workers concurrently and publishes every event once with continuous cursors', async () => {
    const { workspaceId } = await fixture('Two process publication', 240);
    assert.equal(await pending(workspaceId), 241);
    assert.equal((await readiness()).status, 503);
    // Hold the same production workspace lock so neither worker can finish
    // publication before its peer has entered the real process loop.
    const blocker = await pool.connect();
    let left: Worker | undefined;
    let right: Worker | undefined;
    try {
      await blocker.query('BEGIN');
      await lockWorkspace(blocker, workspaceId);
      left = startWorker();
      right = startWorker();
      assert.notEqual(left.pid, right.pid);
      await waitUntil(() => [left!, right!].every(worker => worker.events.some(event => event.event === 'worker_started')), 'both Worker process startup events', [left, right]);
      assert.equal(await pending(workspaceId), 241);
      await blocker.query('COMMIT');
    } catch (error) { await blocker.query('ROLLBACK'); throw error; }
    finally { blocker.release(); }
    try {
      await waitUntil(async () => await pending(workspaceId) === 0 && await heartbeatCount() === 2, 'both live Workers and all durable events', [left!, right!]);
      const ready = await readiness();
      assert.equal(ready.status, 200);
      assert.deepEqual(ready.body.checks, { database: true, storage: true, worker: true, core: true, quarantinedEvents: 0 });
      await assertPublished(workspaceId, 241);
    } finally { await Promise.all([stopWorker(left!), stopWorker(right!)]); }
    assert.equal(await heartbeatCount(), 0);
    assert.equal((await readiness()).status, 503);
    await assertPublished(workspaceId, 241);
  });

  it('retains committed outbox while stopped and lets a replacement Node Worker recover without duplicates', async () => {
    const { workspaceId, discussion } = await fixture('Worker replacement recovery', 2);
    const original = startWorker();
    let baseline: Awaited<ReturnType<typeof eventRows>>;
    try {
      await waitUntil(async () => await pending(workspaceId) === 0 && await heartbeatCount() === 1, 'initial Worker publication', [original]);
      baseline = await assertPublished(workspaceId, 3);
      assert.equal((await readiness()).status, 200);
    } finally { await stopWorker(original); }
    assert.equal(await heartbeatCount(), 0);
    assert.equal((await readiness()).status, 503);
    await createItems(workspaceId, discussion, 12);
    assert.equal(await pending(workspaceId), 12);
    assert.deepEqual(await eventRows(workspaceId), baseline);
    assert.equal((await fetch(`${origin}/health/live`)).status, 200);
    const replacement = startWorker();
    assert.notEqual(replacement.pid, original.pid);
    try {
      await waitUntil(async () => await pending(workspaceId) === 0 && await heartbeatCount() === 1, 'replacement Worker to recover pending events', [replacement]);
      const recovered = await assertPublished(workspaceId, 15);
      assert.deepEqual(recovered.slice(0, baseline.length), baseline);
      assert.equal((await readiness()).status, 200);
    } finally { await stopWorker(replacement); }
    assert.equal(await heartbeatCount(), 0);
    assert.equal((await readiness()).status, 503);
    await assertPublished(workspaceId, 15);
  });
});
