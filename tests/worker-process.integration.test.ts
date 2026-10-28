/// <reference lib="es2024.promise" />
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
import { lockWorkspace } from '../packages/infrastructure/src/database.ts';
import { createBoundLocalStorage } from './blob-fixture.ts';
import { acquireMailFixtureDatabase } from './mail-fixture-database.ts';
import { closeMailApp, MailFixtureScope, mailSchemaInitTimeout } from './mail-fixture-lifecycle.ts';
import { assertV3WorkerTestDatabase, outboxWorkerEnvironment } from './worker-environment.ts';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const workerStartupMessages: Record<string, true> = {
  'Worker must not receive blob credentials or ambient cloud identity': true,
  'DATABASE_URL is required for the Worker': true, 'Run migrations before starting the Worker': true,
  'System SMTP configuration is incomplete or invalid': true, 'Mail feature configuration is incomplete or invalid': true,
  'Invitation mail configuration is incomplete or invalid': true, 'Account recovery mail configuration is incomplete or invalid': true,
  'Invalid WORKER_INTERVAL_MS': true, 'Invalid EVENT_RETENTION_DAYS': true, 'Invalid local project configuration': true,
  'LOCAL_PROJECT_ALLOWED_ROOTS must be a JSON array of absolute paths': true, 'Local projects require at least one trusted allowed root': true,
};
const workerLifecycleEvents: Record<string, true> = {
  worker_started: true, worker_stopped: true, worker_cycle_failed: true, invitation_mail_cycle_failed: true,
  account_recovery_mail_cycle_failed: true, notification_cycle_failed: true, automation_cycle_failed: true, webhook_cycle_failed: true,
};
type WorkerEvent = { event: string; consecutiveFailures?: number };
type Worker = {
  child: ChildProcessWithoutNullStreams;
  pid: number;
  events: WorkerEvent[];
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  exited: boolean;
  launchError: string | null;
  diagnostics: string[];
  signal: AbortSignal;
  stopping?: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

describe('INF-02: independent Worker processes publish and recover durable outbox', { skip: !databaseUrl }, () => {
  const workers: Worker[] = [];
  let scope: MailFixtureScope;
  let pool: Pool;
  let scopedUrl: string;
  let blobRoot: string;
  let coreRoot: string;
  let registry: CommandRegistry;
  let owner: Actor;
  let app: ReturnType<typeof buildApp>;
  let origin: string;

  async function waitUntil(check: () => Promise<boolean> | boolean, message: string, activeWorkers: Worker[] = [], timeoutMs = 15_000) {
    const signal = AbortSignal.any([scope.signal, ...activeWorkers.map(worker => worker.signal)]);
    signal.throwIfAborted();
    const loop = new AbortController();
    const deadline = Promise.withResolvers<never>();
    const evidence = () => activeWorkers.map(worker => `Worker ${worker.pid}: ${worker.diagnostics.join('\n') || '[no safe diagnostics]'}`).join('\n');
    const onAbort = () => deadline.reject(signal.reason);
    // PostgreSQL and separate real Node Workers cannot share fake timers.
    const timeout = globalThis.setTimeout(() => deadline.reject(new Error(`Timed out waiting for ${message}\n${evidence()}`)), timeoutMs);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    try {
      await Promise.race([
        (async () => {
          while (!loop.signal.aborted) {
            for (const worker of activeWorkers) {
              assert.equal(worker.launchError, null, `Owned Worker failed to launch (${worker.launchError})\n${evidence()}`);
              assert.equal(worker.exited, false, `Owned Worker exited before ${message}\n${evidence()}`);
            }
            if (await check()) return;
            await setTimeout(25, undefined, { signal: loop.signal }).catch(() => {});
          }
        })(),
        ...activeWorkers.map(worker => worker.closed.then(result => {
          throw new Error(`Owned Worker ${worker.pid} exited code=${result.code} signal=${result.signal} before ${message}\n${evidence()}`);
        })),
        deadline.promise,
      ]);
    } finally {
      loop.abort();
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
    }
  }

  function startWorker(signal: AbortSignal): Worker {
    signal.throwIfAborted();
    const child = spawn(process.execPath, ['apps/worker/src/main.ts'], {
      cwd: projectRoot, env: outboxWorkerEnvironment(scopedUrl, coreRoot), stdio: ['pipe', 'pipe', 'pipe'],
    });
    const completion = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
    const worker: Worker = {
      child, pid: child.pid ?? 0, events: [], diagnostics: [], signal,
      closed: completion.promise, exited: false, launchError: null,
    };
    workers.push(worker);
    scope.defer(() => closeWorker(worker));
    const onAbort = () => { void closeWorker(worker).catch(() => undefined); };
    child.once('error', error => {
      const code = (error as NodeJS.ErrnoException).code;
      worker.launchError = code && /^(ENOENT|EACCES|EPERM|EAGAIN|ENOMEM|ESRCH)$/.test(code) ? code : 'spawn_failed';
    });
    child.once('close', (code, exitSignal) => {
      worker.exited = true;
      signal.removeEventListener('abort', onAbort);
      completion.resolve({ code, signal: exitSignal });
    });
    for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]] as const) {
      let pending = '';
      let oversized = false;
      const record = (line: string) => {
        if (!line.trim()) return;
        let safe = '[output redacted]';
        try {
          const parsed: unknown = JSON.parse(line);
          if (parsed && typeof parsed === 'object' && 'event' in parsed && typeof parsed.event === 'string' && Object.hasOwn(workerLifecycleEvents, parsed.event)) {
            const eventName = parsed.event;
            if (!worker.events.some(event => event.event === eventName)) worker.events.push({ event: eventName });
            safe = eventName;
            if ('consecutiveFailures' in parsed && Number.isSafeInteger(parsed.consecutiveFailures) && Number(parsed.consecutiveFailures) >= 0) safe += ` consecutiveFailures=${parsed.consecutiveFailures}`;
          }
        } catch {
          const error = /^(Error|TypeError|SyntaxError|RangeError|ReferenceError):(?: (.*))?$/.exec(line.trim());
          if (error) safe = `${error[1]}: ${Object.hasOwn(workerStartupMessages, error[2] ?? '') ? error[2] : '[message redacted]'}`;
        }
        worker.diagnostics.push(`${name}: ${safe}`);
        if (worker.diagnostics.length > 32) worker.diagnostics.shift();
      };
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        for (const part of chunk.split(/(?<=\n)/)) {
          if (!oversized && pending.length + part.length <= 4096) pending += part;
          else oversized = true;
          if (part.endsWith('\n')) {
            record(oversized ? '[oversized output redacted]' : pending);
            pending = ''; oversized = false;
          }
        }
      });
      stream.once('end', () => { record(oversized ? '[oversized output redacted]' : pending); pending = ''; });
    }
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    assert.ok(child.pid, 'The Worker must have an owned OS process PID');
    return worker;
  }

  function closeWorker(worker: Worker) {
    worker.stopping ??= (async () => {
      if (!worker.exited) worker.child.kill('SIGTERM');
      const force = globalThis.setTimeout(() => { if (!worker.exited) worker.child.kill('SIGKILL'); }, 10_000);
      const expired = Promise.withResolvers<never>();
      const deadline = globalThis.setTimeout(() => expired.reject(new Error(`Owned Worker ${worker.pid} did not close after SIGKILL\n${worker.diagnostics.join('\n')}`)), 15_000);
      try { return await Promise.race([worker.closed, expired.promise]); }
      finally { clearTimeout(force); clearTimeout(deadline); }
    })();
    return worker.stopping;
  }

  async function stopWorker(worker: Worker) {
    const result = await closeWorker(worker);
    assert.equal(result.code, 0, `Owned Worker ${worker.pid} must shut down gracefully\n${worker.diagnostics.join('\n')}`);
    assert.equal(result.signal, null, worker.diagnostics.join('\n'));
    assert.ok(worker.events.some(event => event.event === 'worker_stopped'), worker.diagnostics.join('\n'));
    assert.equal(worker.events.some(event => event.event === 'worker_cycle_failed'), false, `Owned Worker ${worker.pid} reported a failed cycle\n${worker.diagnostics.join('\n')}`);
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

  before(async t => {
    assertV3WorkerTestDatabase(databaseUrl!);
    scope = new MailFixtureScope(t.signal, mailSchemaInitTimeout);
    await scope.initialize(async () => {
      const database = await acquireMailFixtureDatabase(scope);
      pool = database.pool;
      scopedUrl = database.databaseUrl;
      const testRoot = resolve(projectRoot, '.local/tests');
      await scope.step(() => mkdir(testRoot, { recursive: true }));
      blobRoot = await scope.acquire(() => mkdtemp(join(testRoot, 'worker-process-')), root => rm(root, { recursive: true, force: true }));
      coreRoot = await scope.acquire(() => mkdtemp(join(testRoot, 'core-')), root => rm(root, { recursive: true, force: true }));
      const blobs = new LocalBlobStore(blobRoot);
      await scope.step(() => blobs.init());
      registry = createRegistry(blobs);
      owner = await scope.step(() => createUser(pool, { email: 'worker-process-owner@example.test', password: 'worker-process-password-2026', name: 'Worker process owner' }));
      const storage = await scope.step(() => createBoundLocalStorage(pool, blobRoot));
      app = scope.own(buildApp({ databaseUrl: scopedUrl, ...storage, coreWorkspaceRoot: coreRoot, signal: scope.signal }), closeMailApp);
      origin = await scope.step(() => app.listen({ host: '127.0.0.1', port: 0 }));
    });
  }, { timeout: mailSchemaInitTimeout });

  after(async () => {
    const results = await Promise.allSettled(workers.map(worker => stopWorker(worker)));
    try { await scope?.close(); }
    finally { for (const result of results) if (result.status === 'rejected') throw result.reason; }
  }, { timeout: 30_000 });

  it('runs two real Node Workers concurrently and publishes every event once with continuous cursors', { timeout: 90_000 }, async t => {
    const { workspaceId } = await fixture('Two process publication', 240);
    assert.equal(await pending(workspaceId), 241);
    assert.equal((await readiness()).status, 503);
    // Hold the same production workspace lock so neither worker can finish
    // publication before its peer has entered the real process loop.
    const blocker = await pool.connect();
    let left: Worker | undefined;
    let right: Worker | undefined;
    t.after(async () => {
      const results = await Promise.allSettled([left, right].filter((worker): worker is Worker => !!worker).map(worker => stopWorker(worker)));
      for (const result of results) if (result.status === 'rejected') throw result.reason;
    });
    try {
      await blocker.query('BEGIN');
      await lockWorkspace(blocker, workspaceId);
      left = startWorker(t.signal);
      right = startWorker(t.signal);
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

  it('retains committed outbox while stopped and lets a replacement Node Worker recover without duplicates', { timeout: 90_000 }, async t => {
    const { workspaceId, discussion } = await fixture('Worker replacement recovery', 2);
    const original = startWorker(t.signal);
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
    const replacement = startWorker(t.signal);
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
