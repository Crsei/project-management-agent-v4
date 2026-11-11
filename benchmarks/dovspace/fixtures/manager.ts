import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Pool } from 'pg';
import { createUser, createWorkspace } from '../../../packages/infrastructure/src/auth.ts';
import { createPool, migrate } from '../../../packages/infrastructure/src/database.ts';
import { LocalBlobStore } from '../../../packages/infrastructure/src/blobs.ts';
import { bindStorage } from '../../../packages/infrastructure/src/blob-storage-maintenance.ts';
import type { FileRecord } from '../../../packages/pm-schema/index.ts';
import { FIXTURE_VERSION, repositoryRoot, type BenchmarkConfig } from '../benchmark.config.ts';
import { FixtureManifestSchema } from '../schemas/types.ts';
import type { Budget, FixtureDiff, FixtureEntity, FixtureHandle, FixtureReceipt, FixtureSnapshot, FixtureTarget } from '../schemas/types.ts';
import { cleanEnvironment, docker, inspectOwned, OWNER_LABEL, ownerIdentity, removeOwnedName } from '../isolation/docker.ts';
import { startIsolatedRuntime, startProtocolIsolatedRuntime, type OwnedRuntime } from '../isolation/runtime.ts';
import { PROJECTS, ISSUES } from './dataset.ts';
import { SYNTHETIC_DOCUMENTS, SYNTHETIC_FACTS, KNOWLEDGE_FIXTURE_FILES, HISTORICAL_SESSION_FILES, L04_CURRENT_DOCUMENT } from './documents.ts';
import { CODE_FIXTURE_FILES } from '../tasks/code-fixture.ts';
import { diffSnapshots, takeSnapshot } from './snapshot.ts';
import { readRootedFile, writeRootedFile } from '../isolation/filesystem.ts';

type OwnedFixture = { owner: string; pgName: string; pmServiceSecret: string; seedReceipts: FixtureReceipt[]; pool?: Pool; api?: ChildProcess; runtime?: OwnedRuntime; device: number; inode: number; seeded: boolean; destroyed: boolean; closing?: Promise<void> };
const ownership = new WeakMap<FixtureHandle, OwnedFixture>();
const forbiddenPorts: Record<string, true> = { '3224': true, '4194': true, '4325': true, '55444': true };
export type RuntimeStartOptions = { runId: string; taskId?: string; budget: Budget; allowedTools?: string[]; allowedTargets?: FixtureTarget[] };
export interface FixtureManager {
  reset(options: { runId: string }): Promise<FixtureHandle>;
  seed(handle: FixtureHandle): Promise<void>;
  snapshot(handle: FixtureHandle): Promise<FixtureSnapshot>;
  diff(before: FixtureSnapshot, after: FixtureSnapshot, options?: { allowedEntityIds?: string[] }): FixtureDiff;
  destroy(handle: FixtureHandle): Promise<void>;
  startRuntime(handle: FixtureHandle, options: RuntimeStartOptions): Promise<NonNullable<FixtureHandle['runtime']>>;
  startProtocolRuntime(handle: FixtureHandle, options: RuntimeStartOptions & { controlledProviderScript: string }): Promise<NonNullable<FixtureHandle['runtime']>>;
  stopRuntime(handle: FixtureHandle): Promise<void>;
  pauseRuntime(handle: FixtureHandle): Promise<void>;
  resumeRuntime(handle: FixtureHandle): Promise<void>;
  bindActiveSession(handle: FixtureHandle, identity: { sessionId: string; generationId: string }): void;
  armResponseLoss(handle: FixtureHandle, options: { targetId: string }): void;
  request<T = unknown>(handle: FixtureHandle, route: string, options?: { method?: string; body?: unknown; headers?: Record<string, string> }): Promise<T>;
  applyIntervention(handle: FixtureHandle, action: string): Promise<{ path: string; before: string | null; after: string }>;
}

async function safeDirectory(directory: string): Promise<void> {
  const parts = path.resolve(directory).split(path.sep).filter(Boolean);
  let current = path.parse(directory).root;
  for (const part of parts) {
    current = path.join(current, part);
    try { await mkdir(current, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if (!(await lstat(current)).isDirectory() || (await lstat(current)).isSymbolicLink()) throw new Error('Fixture path contains a non-directory or symlink');
  }
}
async function initializeGit(handle: FixtureHandle): Promise<void> {
  for (const args of [['init', '--initial-branch=main'], ['add', '--all'], ['commit', '--no-gpg-sign', '-m', 'Fictional benchmark baseline']]) {
    const completion = Promise.withResolvers<void>();
    const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Dovspace Fictional Fixture', '-c', 'user.email=fixture@example.test', ...args], {
      cwd: path.join(handle.publicRoot, 'repo'), env: cleanEnvironment({ HOME: path.join(handle.root, 'service-home'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_DATE: '2026-11-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-11-01T00:00:00Z' }), stdio: 'ignore',
    });
    child.once('error', () => completion.reject(new Error('Git fixture prerequisite unavailable')));
    child.once('exit', code => code === 0 ? completion.resolve() : completion.reject(new Error('Git fixture initialization failed')));
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    try { await completion.promise; } finally { clearTimeout(timer); }
  }
}
async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const completion = Promise.withResolvers<void>();
  child.once('exit', () => completion.resolve());
  child.kill('SIGTERM');
  const force = setTimeout(() => child.kill('SIGKILL'), 15_000);
  const timeout = setTimeout(() => completion.reject(new Error('Owned PM service did not terminate')), 20_000);
  try { await completion.promise; } finally { clearTimeout(force); clearTimeout(timeout); child.stdout?.destroy(); child.stderr?.destroy(); if (child.connected) child.disconnect(); }
}
async function startPm(handle: FixtureHandle, owned: OwnedFixture, databaseUrl: string, secret: string, timeoutMs: number): Promise<void> {
  const readiness = Promise.withResolvers<string>();
  const child = spawn(process.execPath, ['--conditions=development', 'benchmarks/dovspace/fixtures/pm-service.ts'], {
    cwd: repositoryRoot, env: cleanEnvironment({ HOME: path.join(handle.root, 'service-home'), DOVSPACE_BENCH_FIXTURE_ID: handle.fixtureId, DOVSPACE_BENCH_ROOT: handle.root, DATABASE_URL: databaseUrl,
      CORE_WORKSPACE_ROOT: handle.authorityRoot, BLOB_ROOT: path.join(handle.root, 'blobs'), PM_CHAT_SPACE_ROOT: path.join(handle.root, 'pm-chat'), PM_AUTOMATION_SERVICE_SECRET: secret,
      CHOKIDAR_USEPOLLING: 'true', PM_DESKTOP_MANAGED: '1' }), stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  owned.api = child;
  child.stdout?.resume(); child.stderr?.resume();
  child.once('error', () => readiness.reject(new Error('Isolated PM service failed to spawn')));
  child.once('exit', () => readiness.reject(new Error('Isolated PM service exited before readiness')));
  child.on('message', message => {
    const event = message as { event?: string; origin?: string };
    if (event.event === 'ready' && event.origin) {
      const url = new URL(event.origin);
      if (url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port && !forbiddenPorts[url.port]) readiness.resolve(url.origin);
      else readiness.reject(new Error('PM allocated an unsafe service endpoint'));
    } else if (event.event === 'failed') readiness.reject(new Error('Isolated real PM startup failed'));
  });
  const timer = setTimeout(() => readiness.reject(new Error('Isolated PM service startup timed out')), timeoutMs);
  try { handle.pm.baseUrl = await readiness.promise; } finally { clearTimeout(timer); }
}
export function createFixtureManager(config: BenchmarkConfig): FixtureManager {
  function own(handle: FixtureHandle): OwnedFixture {
    const owned = ownership.get(handle);
    if (!owned || owned.destroyed) throw new Error('Fixture is not owned by this live manager');
    return owned;
  }
  async function request<T = unknown>(handle: FixtureHandle, route: string, options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
    own(handle);
    if (!route.startsWith(`/api/v1/workspaces/${handle.workspaceId}/`) && route !== '/api/v1/auth/login') throw new Error('Fixture request must have an explicit owned workspace target');
    const response = await fetch(handle.pm.baseUrl + route, { method: options.method ?? 'GET', headers: { cookie: handle.pm.token, ...(options.body === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers }, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }), signal: AbortSignal.timeout(60_000), redirect: 'error' });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Real fixture PM request failed (status=${response.status})`); }
    return await response.json() as T;
  }
  async function seed(handle: FixtureHandle): Promise<void> {
    const owned = own(handle);
    if (owned.seeded) throw new Error('Fixture seed is single-use; reset allocates an independent fixture');
    const prefix = `/api/v1/workspaces/${handle.workspaceId}/core`;
    async function create(key: string, body: Record<string, unknown>): Promise<FileRecord> {
      const operationId = randomUUID();
      const record = await request<FileRecord>(handle, `${prefix}/entities`, { method: 'POST', body, headers: { 'Idempotency-Key': operationId } });
      if (!record.id || !record.revision) throw new Error('Real PM creation returned no identity or revision');
      const attempt = await request<{ status: string; entityId?: string; revision?: string }>(handle, `${prefix}/creation-attempts/${operationId}`);
      if (attempt.status !== 'committed' || attempt.entityId !== record.id) throw new Error('PM native creation authority did not reconcile');
      owned.seedReceipts.push({ operationId, kind: 'creation', targetId: record.id, revision: record.revision, status: attempt.status, result: attempt });
      handle.targets[key] = { key, workspaceId: handle.workspaceId, projectId: record.entity.entity === 'project' ? record.id : record.entity.project ?? null, entityId: record.id, revision: record.revision, kind: record.entity.entity };
      return record;
    }
    for (const project of PROJECTS) await create(project.key, { entity: 'project', title: project.title, body: project.body });
    for (const issue of ISSUES) await create(issue.key, { entity: 'work_item', title: issue.title, body: issue.body, project: handle.targets[issue.project]!.entityId, status: ['atlas-code', 'cedar-handoff'].includes(issue.key) ? 'in_progress' : 'todo', priority: 'medium', due: '2026-12-01' });
    const dependency = handle.targets['beacon-dependency']!;
    const dependencyOperation = randomUUID();
    const linked = await request<FileRecord>(handle, `${prefix}/entities/${dependency.entityId}`, { method: 'PATCH', headers: { 'Idempotency-Key': dependencyOperation }, body: { revision: dependency.revision, changes: { blocked_by: [handle.targets['atlas-plan']!.entityId] } } });
    dependency.revision = linked.revision;
    owned.seedReceipts.push({ operationId: dependencyOperation, kind: 'native', targetId: linked.id, revision: linked.revision, status: 'committed', result: { id: linked.id, revision: linked.revision } });
    for (const document of SYNTHETIC_DOCUMENTS) {
      const target = path.join(handle.publicRoot, document.path);
      if (path.relative(path.join(handle.publicRoot, 'docs'), target).startsWith('..')) throw new Error('Synthetic document escapes fixture');
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, document.content, { mode: 0o600, flag: 'wx' });
    }
    for (const [relative, content] of Object.entries(CODE_FIXTURE_FILES)) {
      const target = path.join(handle.publicRoot, 'repo', relative);
      if (path.relative(path.join(handle.publicRoot, 'repo'), target).startsWith('..')) throw new Error('Code fixture escapes repository');
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, content, { mode: 0o600, flag: 'wx' });
    }
    await initializeGit(handle);
    for (const [relative, content] of Object.entries({ ...KNOWLEDGE_FIXTURE_FILES, ...HISTORICAL_SESSION_FILES })) {
      const target = path.join(handle.publicRoot, relative);
      if (path.relative(handle.publicRoot, target).startsWith('..')) throw new Error('Knowledge fixture escapes public root');
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, content, { mode: 0o600, flag: 'wx' });
    }
    await mkdir(path.join(handle.publicRoot, 'artifacts'), { mode: 0o700 });
    await writeFile(path.join(handle.publicRoot, 'pm-targets.json'), JSON.stringify(FixtureManifestSchema.parse({ fixtureVersion: handle.fixtureVersion, workspaceId: handle.workspaceId, targets: handle.targets }), null, 2), { mode: 0o600 });
    owned.seeded = true;
  }
  async function destroy(handle: FixtureHandle): Promise<void> {
    const owned = ownership.get(handle);
    if (!owned || owned.destroyed) return;
    return owned.closing ??= (async () => {
      const errors: unknown[] = [];
      for (const action of [async () => owned.runtime?.close(), async () => owned.api && stopChild(owned.api), async () => owned.pool?.end(), async () => removeOwnedName(owned.pgName, owned.owner)]) try { await action(); } catch (error) { errors.push(error); }
      if (!errors.length) {
        const stat = await lstat(handle.root);
        const marker = JSON.parse(await readRootedFile(handle.root, 'ownership.json')) as { fixtureId: string; owner: string };
        if (stat.isSymbolicLink() || stat.dev !== owned.device || stat.ino !== owned.inode || marker.fixtureId !== handle.fixtureId || marker.owner !== owned.owner || await realpath(handle.root) !== handle.root) throw new Error('Fixture directory identity changed; cleanup refused');
        await rm(handle.root, { recursive: true, force: false });
        owned.destroyed = true;
      }
      if (errors.length) { delete owned.closing; throw new AggregateError(errors, 'Owned fixture cleanup incomplete; private authority retained'); }
    })();
  }
  async function reset(options: { runId: string }): Promise<FixtureHandle> {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(options.runId)) throw new Error('Invalid benchmark run identity');
    await safeDirectory(config.runtimeRoot);
    await chmod(config.runtimeRoot, 0o700);
    const fixtureId = randomUUID(), owner = await ownerIdentity();
    const root = await mkdtemp(path.join(config.runtimeRoot, 'fixture-'));
    await chmod(root, 0o700);
    const stat = await lstat(root);
    const handle: FixtureHandle = { fixtureId, fixtureVersion: FIXTURE_VERSION, root, publicRoot: path.join(root, 'public'), authorityRoot: path.join(root, 'authority'), agentDataRoot: path.join(root, 'agent-private'), workspaceId: '', actorId: '', targets: {}, pm: { baseUrl: '', token: '' }, runtime: null, isolation: null };
    const owned: OwnedFixture = { owner, pgName: `dovspace-bench-postgres-${fixtureId.replaceAll('-', '')}`, pmServiceSecret: randomBytes(32).toString('hex'), seedReceipts: [], device: stat.dev, inode: stat.ino, seeded: false, destroyed: false };
    ownership.set(handle, owned);
    try {
      await writeFile(path.join(root, 'ownership.json'), JSON.stringify({ fixtureId, owner }), { mode: 0o600, flag: 'wx' });
      for (const name of ['public', 'authority', 'agent-private', 'blobs', 'service-home', 'pm-chat']) await mkdir(path.join(root, name), { mode: 0o700 });
      const password = randomBytes(32).toString('hex'), database = `dovspace_bench_${fixtureId.replaceAll('-', '')}`;
      const id = await docker(['create', '--pull', 'never', '--name', owned.pgName, '--label', `${OWNER_LABEL}=${owner}`, '--publish', '127.0.0.1::5432', '--tmpfs', '/var/lib/postgresql/data:rw,mode=0700', '--env', 'POSTGRES_USER', '--env', 'POSTGRES_DB', '--env', 'POSTGRES_PASSWORD', config.postgresImage], { POSTGRES_USER: 'dovspace_bench', POSTGRES_DB: database, POSTGRES_PASSWORD: password });
      await docker(['start', id]);
      const pg = await inspectOwned(id, owner);
      handle.imageIds = { postgres: pg.Image };
      const binding = pg.NetworkSettings.Ports['5432/tcp'];
      if (!pg.State.Running || binding?.length !== 1 || binding[0]?.HostIp !== '127.0.0.1' || !binding[0].HostPort || forbiddenPorts[binding[0].HostPort]) throw new Error('PostgreSQL allocation is not an independent loopback endpoint');
      const databaseUrl = `postgresql://dovspace_bench:${password}@127.0.0.1:${binding[0].HostPort}/${database}`;
      const pool = createPool(databaseUrl, 4); owned.pool = pool;
      const deadline = Date.now() + 30_000;
      while (true) {
        try { const row = (await pool.query<{ database: string; username: string }>('SELECT current_database() AS database, current_user AS username')).rows[0]; if (row?.database !== database || row.username !== 'dovspace_bench') throw new Error('PostgreSQL authority mismatch'); break; }
        catch { if (Date.now() >= deadline) throw new Error('Owned PostgreSQL did not become ready'); await delay(100); }
      }
      await migrate(pool);
      const accountPassword = randomBytes(32).toString('base64url');
      const user = await createUser(pool, { name: 'Benchmark fictional operator', email: 'operator@dovspace-bench.example.test', password: accountPassword });
      handle.actorId = user.id;
      handle.workspaceId = (await createWorkspace(pool, user.id, 'Dovspace fictional benchmark')).id;
      await bindStorage({ pool, provider: new LocalBlobStore(path.join(root, 'blobs')), locator: { provider: 'local', root: path.join(root, 'blobs') }, mode: 'new', stopped: true });
      await startPm(handle, owned, databaseUrl, owned.pmServiceSecret, config.startupTimeoutMs);
      const response = await fetch(handle.pm.baseUrl + '/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: user.email, password: accountPassword }), signal: AbortSignal.timeout(30_000) });
      handle.pm.token = response.headers.get('set-cookie')?.split(';')[0] ?? '';
      await response.body?.cancel();
      if (!response.ok || !handle.pm.token) throw new Error('Fictional benchmark account failed authentication');
      await seed(handle);
      return handle;
    } catch (error) { try { await destroy(handle); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Fixture provisioning and guarded cleanup failed'); } throw error; }
  }
  async function snapshot(handle: FixtureHandle): Promise<FixtureSnapshot> {
    const owned = own(handle);
    if (!owned.pool || !owned.seeded) throw new Error('Snapshot requires a complete real PM fixture');
    const deadline = Date.now() + 30_000;
    while (true) {
      const journal = await readRootedFile(handle.authorityRoot, `${handle.workspaceId}/.pm/state/pm-command-journal.ndjson`);
      const entries = journal.split('\n').filter(Boolean).length;
      const checkpoint = (await owned.pool.query<{ journal_offset: string; status: string; last_error_code: string | null }>('SELECT journal_offset::text,status,last_error_code FROM service_fact_import_checkpoints WHERE workspace_id=$1', [handle.workspaceId])).rows[0];
      if (checkpoint?.status === 'error' || checkpoint?.last_error_code) throw new Error('Real PM fact importer has an unresolved authority error');
      if (checkpoint && Number(checkpoint.journal_offset) === entries && checkpoint.status === 'current') break;
      if (Date.now() >= deadline) throw new Error('Real PM authority bookkeeping did not reach a consistent snapshot boundary');
      await delay(100);
    }
    const response = await request<{ files: FileRecord[]; errors: unknown[]; unsupportedFiles: unknown[] }>(handle, `/api/v1/workspaces/${handle.workspaceId}/core/workspace`);
    if (response.errors.length || response.unsupportedFiles.length) throw new Error('Real Markdown authority contains unresolved or unsupported files');
    const entities: FixtureEntity[] = response.files.map(record => ({ key: Object.values(handle.targets).find(target => target.entityId === record.id)?.key ?? `created:${record.id}`, id: record.id, projectId: record.entity.project ?? (record.entity.entity === 'project' ? record.id : null), kind: record.entity.entity, revision: record.revision, path: record.path, entity: record.entity as unknown as Record<string, unknown>, raw: record.raw }));
    return takeSnapshot(handle, owned.pool, entities, owned.seedReceipts);
  }
  async function startRuntime(handle: FixtureHandle, options: RuntimeStartOptions) {
    const owned = own(handle);
    if (owned.runtime) throw new Error('Runtime already allocated for this fixture');
    owned.runtime = await startIsolatedRuntime(config, handle, owned.owner, options, owned.pmServiceSecret);
    return handle.runtime!;
  }
  async function startProtocolRuntime(handle: FixtureHandle, options: RuntimeStartOptions & { controlledProviderScript: string }) {
    const owned = own(handle);
    if (owned.runtime) throw new Error('Runtime already allocated for this fixture');
    owned.runtime = await startProtocolIsolatedRuntime(config, handle, owned.owner, options, owned.pmServiceSecret, options.controlledProviderScript);
    return handle.runtime!;
  }
  async function stopRuntime(handle: FixtureHandle): Promise<void> { const owned = own(handle); await owned.runtime?.close(); }
  async function pauseRuntime(handle: FixtureHandle): Promise<void> { await own(handle).runtime?.pause(); }
  async function resumeRuntime(handle: FixtureHandle): Promise<void> { await own(handle).runtime?.resume(); }
  function bindActiveSession(handle: FixtureHandle, identity: { sessionId: string; generationId: string }): void {
    own(handle);
    if (!handle.runtime || !identity.sessionId || !identity.generationId) throw new Error('Active receipt requester requires actual runtime Session/generation identity');
    handle.runtime.activeSessionId = identity.sessionId; handle.runtime.activeGenerationId = identity.generationId;
  }
  function armResponseLoss(handle: FixtureHandle, options: { targetId: string }): void { const owned = own(handle); if (!owned.runtime) throw new Error('Response loss requires a running isolated runtime'); owned.runtime.armResponseLoss(options.targetId); }
  async function applyIntervention(handle: FixtureHandle, action: string): Promise<{ path: string; before: string | null; after: string }> {
    const owned = own(handle);
    if (!['knowledge-update', 'update-knowledge', 'publish-current-decision', 'change-decision-and-new-session'].includes(action)) throw new Error('Unsupported fixture intervention');
    const wasPaused = owned.runtime?.paused ?? false;
    await owned.runtime?.pause();
    try {
      const prior = SYNTHETIC_FACTS.find(entry => entry.key === 'incidentEscalationMinutes')!;
      const priorContent = await readRootedFile(handle.publicRoot, prior.currentPath);
      if (priorContent !== SYNTHETIC_DOCUMENTS.find(document => document.path === prior.currentPath)?.content) throw new Error('Intervention refuses a concurrently modified decision');
      await writeRootedFile(handle.publicRoot, L04_CURRENT_DOCUMENT.path, L04_CURRENT_DOCUMENT.content, { exclusive: true, createParents: false });
      await writeRootedFile(handle.publicRoot, prior.currentPath, priorContent.replace('Status: accepted and current.', `Status: superseded by ${L04_CURRENT_DOCUMENT.path}; retained for historical provenance.`));
      return { path: L04_CURRENT_DOCUMENT.path, before: null, after: L04_CURRENT_DOCUMENT.content };
    } finally { if (!wasPaused) await owned.runtime?.resume(); }
  }
  return { reset, seed, snapshot, diff: (before: FixtureSnapshot, after: FixtureSnapshot, options: { allowedEntityIds?: string[] } = {}): FixtureDiff => diffSnapshots(before, after, options), destroy, startRuntime, startProtocolRuntime, stopRuntime, pauseRuntime, resumeRuntime, bindActiveSession, armResponseLoss, request, applyIntervention };
}
