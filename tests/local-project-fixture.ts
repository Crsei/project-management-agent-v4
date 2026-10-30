import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import type { Actor, Command, CommandReceipt, Entity } from '../packages/domain/src/core.ts';
import { createUser, createWorkspace } from '../packages/infrastructure/src/auth.ts';
import { createPool, migrate } from '../packages/infrastructure/src/database.ts';
import { createBoundLocalStorage } from './blob-fixture.ts';
import { MailFixtureScope, interruptMailPoolOnAbort } from './mail-fixture-lifecycle.ts';

const repository = fileURLToPath(new URL('../', import.meta.url));
export type LocalProjectResponse<T> = { status: number; body: T; headers: Headers };
export type LocalProjectRequest = { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string>; signal?: AbortSignal };
type OwnedProcess = {
  child: ChildProcess; exited: boolean; failed: boolean; closed: Promise<void>; origin?: string;
  phase: string; reasons: string[]; exitCode?: number | null; exitSignal?: NodeJS.Signals | null; stopping?: Promise<void>;
};
export const localProjectCaseTimeout = 240_000;
const schemaTimeout = 60_000;
// API startup has two real, separately bounded 60s ready phases.
const serviceStartupTimeout = 125_000;
const serviceShutdownTimeout = 15_000;
export type LocalProjectFixture = {
  root: string; coreRoot: string; blobRoot: string; parents: [string, string]; schema: string;
  pool: Pool; owner: Actor; workspaceId: string; databaseUrl: string;
  readonly signal: AbortSignal;
  readonly origin: string; readonly ownerCookie: string;
  request<T = unknown>(path: string, options?: LocalProjectRequest): Promise<LocalProjectResponse<T>>;
  authenticateAt(origin: string): Promise<string>;
  command<T = Entity>(commandType: string, payload: Record<string, unknown>, extra?: Partial<Command>, cookie?: string): Promise<T>;
  send(command: Command, cookie?: string): Promise<LocalProjectResponse<CommandReceipt>>;
  member(name: string): Promise<{ user: Actor; cookie: string }>;
  startWorker(): Promise<void>; stopServices(): Promise<void>;
  restartApi(localProjectsEnabled?: boolean): Promise<void>;
  crashApi(): Promise<void>;
  startBrowser(): Promise<{ origin: string; metadataPath: string }>;
  close(): Promise<void>;
};

/** Intentionally allowlist child environments: no dotenv, SMTP, cloud or user service configuration. */
export function localProjectChildEnvironment(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'SYSTEMROOT', 'CHOKIDAR_USEPOLLING']) if (process.env[key]) env[key] = process.env[key];
  return { ...env, ...extra };
}
export async function localProjectEventually(check: () => Promise<boolean>, description: string, timeoutMs = 20_000, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (await check()) return;
    await delay(40, undefined, { signal });
  }
  signal?.throwIfAborted();
  throw new Error(`Timed out waiting for ${description}`);
}

function serviceFailure(owned: OwnedProcess): Error {
  // Every component comes from fixed phases, machine codes or OS exit metadata.
  // Raw stdout/stderr, error messages, environment and URLs are never retained.
  return new Error(`Isolated service startup failed (phase=${owned.phase}; reasons=${owned.reasons.join(',') || 'none'}; exit=${owned.exitCode ?? 'none'}; signal=${owned.exitSignal ?? 'none'})`);
}

async function startOwned(args: string[], env: NodeJS.ProcessEnv, readyMessage: boolean, scope: MailFixtureScope): Promise<OwnedProcess> {
  scope.checkpoint();
  const child = spawn(process.execPath, args, { cwd: repository, env: localProjectChildEnvironment(env), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const completion = Promise.withResolvers<void>();
  const readiness = Promise.withResolvers<void>();
  const owned: OwnedProcess = { child, exited: false, failed: false, closed: completion.promise, phase: 'spawn', reasons: [] };
  const abort = () => { void stopOwned(owned).catch(() => undefined); readiness.resolve(); };
  // Register ownership synchronously, before waiting for the child's first IPC.
  scope.defer(async () => { scope.signal.removeEventListener('abort', abort); await stopOwned(owned); });
  scope.signal.addEventListener('abort', abort, { once: true });
  child.once('error', error => {
    owned.failed = true;
    const code = (error as NodeJS.ErrnoException).code;
    owned.reasons.push(code && /^(?:ENOENT|EACCES|ENOMEM|EMFILE|ENFILE|EAGAIN)$/.test(code) ? code : 'spawn_error');
    readiness.resolve();
    if (!child.pid) { owned.exited = true; completion.resolve(); }
  });
  child.once('exit', (code, signal) => {
    owned.exited = true; owned.exitCode = code; owned.exitSignal = signal;
    readiness.resolve(); completion.resolve();
  });
  child.on('message', message => {
    if (!message || typeof message !== 'object' || !('event' in message)) return;
    if (message.event === 'phase' && 'phase' in message && typeof message.phase === 'string' &&
        /^(?:api_build|api_listen|web_create|web_listen)$/.test(message.phase)) owned.phase = message.phase;
    if (message.event === 'startup_failed') {
      owned.failed = true;
      if ('codes' in message && Array.isArray(message.codes)) {
        owned.reasons.push(...message.codes.filter((code): code is string => typeof code === 'string' &&
          /^(?:[0-9A-Z]{5}|FST_ERR_[A-Z_]{1,64}|AVV_ERR_[A-Z_]{1,64}|ERR_[A-Z_]{1,64}|EACCES|EPERM|ENOENT|ENOSPC|ENOSYS|EMFILE|ENFILE|ENOMEM|ECONNREFUSED|ECONNRESET|ETIMEDOUT|onReady|onClose|unknown_error)$/.test(code)).slice(0, Math.max(0, 4 - owned.reasons.length)));
      }
      readiness.resolve();
    }
    if (message.event === 'ready' && 'origin' in message && typeof message.origin === 'string') {
      try {
        const url = new URL(message.origin);
        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password) throw new Error('Invalid fixture origin');
        owned.origin = url.origin;
      } catch { owned.failed = true; if (owned.reasons.length < 4) owned.reasons.push('invalid_origin'); }
      readiness.resolve();
    }
  });
  child.stdout?.resume();
  child.stderr?.resume();
  if (readyMessage) {
    const timeout = setTimeout(() => {
      owned.failed = true; owned.reasons.push('startup_timeout'); readiness.resolve();
    }, serviceStartupTimeout);
    try {
      await readiness.promise;
      scope.checkpoint();
      if (!owned.origin || owned.failed || owned.exited) throw serviceFailure(owned);
    } catch (error) {
      try { await stopOwned(owned); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Isolated service startup and cleanup failed'); }
      throw error;
    } finally { clearTimeout(timeout); }
  }
  return owned;
}

// Not async: concurrent shutdown paths share the identical completion.
function stopOwned(owned: OwnedProcess | undefined, expectedCrash = false): Promise<void> {
  if (!owned) return Promise.resolve();
  return owned.stopping ??= (async () => {
    let forced = false;
    const unexpectedExit = owned.exited;
    try {
      if (!owned.exited) {
        if (!expectedCrash) owned.child.kill('SIGTERM');
        const force = setTimeout(() => {
          if (!owned.exited) { forced = true; owned.child.kill('SIGKILL'); }
        }, serviceShutdownTimeout);
        const deadline = Promise.withResolvers<never>();
        const timeout = setTimeout(() => deadline.reject(new Error('Owned isolated service did not exit after SIGKILL')), serviceShutdownTimeout + 3_000);
        try { await Promise.race([owned.closed, deadline.promise]); }
        finally { clearTimeout(force); clearTimeout(timeout); }
      }
      if (!expectedCrash && (unexpectedExit || forced || (owned.exitCode != null && owned.exitCode !== 0) || (owned.exitSignal && owned.exitSignal !== 'SIGTERM'))) {
        throw new Error(`Owned isolated service did not shut down cleanly (unexpectedExit=${unexpectedExit}; forced=${forced}; exit=${owned.exitCode ?? 'none'}; signal=${owned.exitSignal ?? 'none'})`);
      }
    } finally {
      owned.child.stdout?.destroy();
      owned.child.stderr?.destroy();
      if (owned.child.connected) owned.child.disconnect();
    }
  })();
}

/** A real HTTP API and Worker, each owning a child PID and a disposable PostgreSQL schema. */
export async function createLocalProjectFixture(options: { databaseUrl?: string; localProjectsEnabled?: boolean; chatSpaceRoot?: string; publicOrigin?: string; signal?: AbortSignal } = {}): Promise<LocalProjectFixture> {
  const source = options.databaseUrl ?? process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!source) throw new Error('Local-project acceptance requires a real TEST_DATABASE_URL (or explicitly env-loaded DATABASE_URL); no scenarios are skipped');
  const scope = new MailFixtureScope(options.signal, 210_000);
  const active = new Set<Promise<unknown>>();
  function run<T>(operation: () => Promise<T>): Promise<T> {
    const result = scope.step(operation);
    active.add(result);
    void result.then(() => active.delete(result), () => active.delete(result));
    return result;
  }
  return scope.initialize(async () => {
    const schema = `test_local_project_${randomUUID().replaceAll('-', '')}`;
    const control = scope.own(createPool(source, 2), owned => owned.end());
    const bootstrap = scope.own(createPool(source, 1), owned => owned.end());
    const root = await scope.acquire(() => mkdtemp(join(tmpdir(), 'pm-local-project-')), owned => rm(owned, { recursive: true, force: true }));
    await scope.step(() => chmod(root, 0o700));
    const coreRoot = join(root, 'core'), blobRoot = join(root, 'blobs');
    const parents: [string, string] = [join(root, 'projects-a'), join(root, 'projects-b')];
    for (const path of [coreRoot, ...parents]) await scope.step(() => mkdir(path, { recursive: true }));
    let createdSchema = false;
    scope.defer(async () => { if (createdSchema) await bootstrap.query(`DROP SCHEMA ${schema} CASCADE`); });
    // Ownership is registered before CREATE and marked before the abort checkpoint,
    // so a successful response delivered after cancellation still drops its schema.
    await scope.step(async () => { await bootstrap.query(`CREATE SCHEMA ${schema}`); createdSchema = true; });
    const url = new URL(source);
    url.searchParams.set('options', `-c search_path=${schema},public`);
    const databaseUrl = url.toString();
    const pool = scope.own(createPool(databaseUrl), owned => owned.end());
    const interrupt = interruptMailPoolOnAbort(pool, scope.signal, control);
    scope.defer(() => interrupt.finish());
    const schemaTimer = setTimeout(() => scope.controller.abort(new Error(`Local-project schema migration exceeded ${schemaTimeout}ms`)), schemaTimeout);
    try { await scope.step(() => migrate(pool)); }
    finally { clearTimeout(schemaTimer); }
    const password = randomBytes(30).toString('base64url');
    const owner = await scope.step(() => createUser(pool, { email: `local-project-${randomUUID()}@example.test`, name: 'Isolated local project owner', password }));
    const workspaceId = (await scope.step(() => createWorkspace(pool, owner.id, 'Local project acceptance'))).id;
    await scope.step(() => createBoundLocalStorage(pool, blobRoot));
    let api: OwnedProcess | undefined;
    let worker: OwnedProcess | undefined;
    let web: OwnedProcess | undefined;
    let enabled = options.localProjectsEnabled ?? true;
    let ownerCookie = '';
    function environment(): NodeJS.ProcessEnv {
      return {
        DATABASE_URL: databaseUrl, CORE_WORKSPACE_ROOT: coreRoot, BLOB_ROOT: blobRoot, BLOB_STORAGE_PROVIDER: 'local',
        PM_CHAT_SPACE_ROOT: options.chatSpaceRoot ?? join(root, '.pmv4'),
        LOCAL_PROJECT_PUBLIC_ORIGIN: options.publicOrigin ?? 'http://127.0.0.1:4100',
        LOCAL_PROJECTS_ENABLED: enabled ? 'true' : 'false', LOCAL_PROJECT_ALLOWED_ROOTS: JSON.stringify(parents),
        LOCAL_PROJECT_DEFAULT_PARENT: parents[0], LOCAL_PROJECT_FIXTURE_ROOT: root,
        WORKER_INTERVAL_MS: '25', EVENT_RETENTION_DAYS: '3650', CHOKIDAR_USEPOLLING: 'true',
      };
    }
    async function stopServices() {
      const owned = [web, worker, api];
      web = worker = api = undefined;
      const results = await Promise.allSettled(owned.map(process => stopOwned(process)));
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Owned local-project services failed to stop');
    }
    scope.defer(stopServices);
    async function restartApi(localProjectsEnabled = enabled) {
      await stopOwned(api);
      scope.checkpoint();
      enabled = localProjectsEnabled;
      api = await startOwned(['tests/local-project-process.ts', 'api'], environment(), true, scope);
    }
    await restartApi();
    function request<T = unknown>(path: string, opts: LocalProjectRequest = {}): Promise<LocalProjectResponse<T>> {
      return run(async () => {
        if (!api?.origin || api.exited) throw new Error('The fixture API is stopped');
        const response = await fetch(`${api.origin}${path}`, {
          method: opts.method ?? 'GET',
          headers: { cookie: opts.cookie ?? ownerCookie, ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }), ...opts.headers },
          ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
          signal: AbortSignal.any([scope.signal, AbortSignal.timeout(30_000), ...(opts.signal ? [opts.signal] : [])]),
        });
        return { status: response.status, body: await response.json() as T, headers: response.headers };
      });
    }
    async function signIn(user: Actor, origin = api?.origin): Promise<string> {
      scope.checkpoint();
      if (!origin) throw new Error('An explicit running fixture API is required for authentication');
      const response = await fetch(`${origin}/api/v1/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: user.email, password }),
        signal: AbortSignal.any([scope.signal, AbortSignal.timeout(30_000)]),
      });
      assert.equal(response.status, 200, 'Generated fixture account must authenticate');
      const cookie = response.headers.get('set-cookie')?.split(';')[0];
      await response.body?.cancel();
      assert.ok(cookie, 'Authentication must issue a session cookie');
      return cookie;
    }
    ownerCookie = await scope.step(() => signIn(owner));
    async function send(command: Command, cookie = ownerCookie) {
      return request<CommandReceipt>(`/api/v1/workspaces/${workspaceId}/commands`, { method: 'POST', body: command, cookie });
    }
    // Runtime acquisitions are owned before awaiting readiness. Join their pending
    // work before removing roots/schema, including uncancellable late fs writes.
    scope.defer(async () => { while (active.size) await Promise.allSettled([...active]); });
    return {
      root, coreRoot, blobRoot, parents, schema, pool, owner, workspaceId, databaseUrl, signal: scope.signal,
      get origin() { scope.checkpoint(); if (!api?.origin) throw new Error('The fixture API is stopped'); return api.origin; },
      get ownerCookie() { return ownerCookie; },
      request, send, close: scope.close,
      stopServices: () => run(stopServices),
      restartApi: localProjectsEnabled => run(() => restartApi(localProjectsEnabled)),
      authenticateAt: origin => run(() => signIn(owner, origin)),
      crashApi: () => run(async () => {
        if (!api || api.exited) throw new Error('No owned API is running');
        api.child.kill('SIGKILL');
        await stopOwned(api, true);
        api = undefined;
      }),
      async command<T = Entity>(commandType: string, payload: Record<string, unknown>, extra: Partial<Command> = {}, cookie = ownerCookie): Promise<T> {
        const response = await send({ commandId: randomUUID(), commandType, payload, ...extra }, cookie);
        assert.equal(response.status, 200, JSON.stringify(response.body));
        assert.equal(response.body.status, 'committed', JSON.stringify(response.body));
        return response.body.result as T;
      },
      member: name => run(async () => {
        const user = await scope.step(() => createUser(pool, { email: `${randomUUID()}@example.test`, name, password }));
        return { user, cookie: await signIn(user) };
      }),
      startWorker: () => run(async () => {
        if (worker && !worker.exited) return;
        worker = await startOwned(['apps/server/worker/src/main.ts'], environment(), false, scope);
        await localProjectEventually(async () => {
          if (worker?.exited || worker?.failed) throw serviceFailure(worker);
          return (await pool.query("SELECT 1 FROM service_heartbeats WHERE role='worker' AND heartbeat_at > now()-interval '20 seconds'")).rowCount! > 0;
        }, 'the real Worker loop heartbeat', 20_000, scope.signal);
      }),
      startBrowser: () => run(async () => {
        if (!api?.origin) throw new Error('Start the fixture API before the browser server');
        web ??= await startOwned(['tests/local-project-process.ts', 'web'], { ...environment(), PM_API_URL: api.origin, PM_API_ORIGIN: 'http://127.0.0.1:4100', PM_ENABLE_LAB: 'true' }, true, scope);
        const origin = web.origin!;
        const metadataPath = join(root, 'browser-setup.json');
        // Generated credentials remain in a mode-0600 file under the owned 0700 root.
        await writeFile(metadataPath, JSON.stringify({ origin, apiOrigin: api.origin, workspaceId, email: owner.email, password, projectParents: parents }, null, 2) + '\n', { mode: 0o600 });
        return { origin, metadataPath };
      }),
    };
  });
}
