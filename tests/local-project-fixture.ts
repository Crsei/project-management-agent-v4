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

const repository = fileURLToPath(new URL('../', import.meta.url));
export type LocalProjectResponse<T> = { status: number; body: T; headers: Headers };
export type LocalProjectRequest = { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string>; signal?: AbortSignal };
type OwnedProcess = { child: ChildProcess; exited: boolean; failed: boolean; closed: Promise<void>; origin?: string };
export type LocalProjectFixture = {
  root: string; coreRoot: string; blobRoot: string; parents: [string, string]; schema: string;
  pool: Pool; owner: Actor; workspaceId: string; databaseUrl: string;
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
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'SYSTEMROOT']) if (process.env[key]) env[key] = process.env[key];
  return { ...env, ...extra };
}
export async function localProjectEventually(check: () => Promise<boolean>, description: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(40);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function startOwned(args: string[], env: NodeJS.ProcessEnv, readyMessage: boolean): Promise<OwnedProcess> {
  const child = spawn(process.execPath, args, { cwd: repository, env: localProjectChildEnvironment(env), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const owned: OwnedProcess = { child, exited: false, failed: false, closed: Promise.resolve() };
  const readiness = Promise.withResolvers<void>();
  const completion = Promise.withResolvers<void>();
  owned.closed = completion.promise;
  child.once('error', () => { owned.failed = true; readiness.resolve(); completion.resolve(); });
  child.once('close', () => { owned.exited = true; readiness.resolve(); completion.resolve(); });
  child.on('message', message => {
    if (!message || typeof message !== 'object') return;
    if ('event' in message && message.event === 'startup_failed') { owned.failed = true; readiness.resolve(); }
    if ('event' in message && message.event === 'ready' && 'origin' in message && typeof message.origin === 'string') {
      const url = new URL(message.origin);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) { owned.failed = true; readiness.resolve(); return; }
      owned.origin = url.origin;
      readiness.resolve();
    }
  });
  // Drain raw output without publishing database URLs, cookies or request content.
  child.stdout?.resume();
  child.stderr?.resume();
  if (readyMessage) {
    let timeout: NodeJS.Timeout | undefined;
    try {
      const deadline = Promise.withResolvers<never>();
      timeout = setTimeout(() => deadline.reject(new Error('Isolated service startup timed out')), 45_000);
      await Promise.race([readiness.promise, deadline.promise]);
      assert.ok(owned.origin && !owned.failed && !owned.exited, 'Isolated service failed to start; raw configuration diagnostics are withheld');
    } catch (error) { await stopOwned(owned); throw error; }
    finally { clearTimeout(timeout); }
  }
  return owned;
}
async function stopOwned(owned: OwnedProcess | undefined): Promise<void> {
  if (!owned || owned.exited) return;
  owned.child.kill('SIGTERM');
  const timeout = setTimeout(() => { if (!owned.exited) owned.child.kill('SIGKILL'); }, 15_000);
  try { await owned.closed; } finally { clearTimeout(timeout); }
}

/** A real HTTP API and Worker, each owning a child PID and a disposable PostgreSQL schema. */
export async function createLocalProjectFixture(options: { databaseUrl?: string; localProjectsEnabled?: boolean } = {}): Promise<LocalProjectFixture> {
  const source = options.databaseUrl ?? process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!source) throw new Error('Local-project acceptance requires a real TEST_DATABASE_URL (or explicitly env-loaded DATABASE_URL); no scenarios are skipped');
  const schema = `test_local_project_${randomUUID().replaceAll('-', '')}`;
  const bootstrap = createPool(source);
  let pool: Pool | undefined;
  let root: string | undefined;
  let createdSchema = false;
  let closed = false;
  let api: OwnedProcess | undefined;
  let worker: OwnedProcess | undefined;
  let web: OwnedProcess | undefined;
  let enabled = options.localProjectsEnabled ?? true;
  let ownerCookie = '';
  async function stopServices() {
    await stopOwned(web); web = undefined;
    await stopOwned(worker); worker = undefined;
    await stopOwned(api); api = undefined;
  }
  async function close() {
    if (closed) return;
    closed = true;
    try { await stopServices(); }
    finally {
      try { await pool?.end(); }
      finally {
        try { if (createdSchema) await bootstrap.query(`DROP SCHEMA ${schema} CASCADE`); }
        finally { await bootstrap.end(); if (root) await rm(root, { recursive: true, force: true }); }
      }
    }
  }
  try {
    root = await mkdtemp(join(tmpdir(), 'pm-local-project-'));
    await chmod(root, 0o700);
    const coreRoot = join(root, 'core'), blobRoot = join(root, 'blobs');
    const parents: [string, string] = [join(root, 'projects-a'), join(root, 'projects-b')];
    for (const path of [coreRoot, ...parents]) await mkdir(path, { recursive: true });
    await bootstrap.query(`CREATE SCHEMA ${schema}`);
    createdSchema = true;
    const url = new URL(source);
    url.searchParams.set('options', `-c search_path=${schema},public`);
    const databaseUrl = url.toString();
    pool = createPool(databaseUrl);
    await migrate(pool);
    const password = randomBytes(30).toString('base64url');
    const owner = await createUser(pool, { email: `local-project-${randomUUID()}@example.test`, name: 'Isolated local project owner', password });
    const workspaceId = (await createWorkspace(pool, owner.id, 'Local project acceptance')).id;
    await createBoundLocalStorage(pool, blobRoot);
    function environment(): NodeJS.ProcessEnv {
      return {
        DATABASE_URL: databaseUrl, CORE_WORKSPACE_ROOT: coreRoot, BLOB_ROOT: blobRoot, BLOB_STORAGE_PROVIDER: 'local',
        LOCAL_PROJECTS_ENABLED: enabled ? 'true' : 'false', LOCAL_PROJECT_ALLOWED_ROOTS: JSON.stringify(parents),
        LOCAL_PROJECT_DEFAULT_PARENT: parents[0], LOCAL_PROJECT_FIXTURE_ROOT: root,
        WORKER_INTERVAL_MS: '25', EVENT_RETENTION_DAYS: '3650', CHOKIDAR_USEPOLLING: 'true',
      };
    }
    async function restartApi(localProjectsEnabled = enabled) {
      await stopOwned(api);
      enabled = localProjectsEnabled;
      api = await startOwned(['tests/local-project-process.ts', 'api'], environment(), true);
    }
    await restartApi();
    async function request<T = unknown>(path: string, opts: LocalProjectRequest = {}): Promise<LocalProjectResponse<T>> {
      if (!api?.origin || api.exited) throw new Error('The fixture API is stopped');
      const response = await fetch(`${api.origin}${path}`, {
        method: opts.method ?? 'GET',
        headers: { cookie: opts.cookie ?? ownerCookie, ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }), ...opts.headers },
        ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }), signal: opts.signal ?? AbortSignal.timeout(30_000),
      });
      return { status: response.status, body: await response.json() as T, headers: response.headers };
    }
    async function signIn(user: Actor, origin = api?.origin): Promise<string> {
      if (!origin) throw new Error('An explicit running fixture API is required for authentication');
      const response = await fetch(`${origin}/api/v1/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: user.email, password }),
        signal: AbortSignal.timeout(30_000),
      });
      assert.equal(response.status, 200, 'Generated fixture account must authenticate');
      const cookie = response.headers.get('set-cookie')?.split(';')[0];
      await response.body?.cancel();
      assert.ok(cookie, 'Authentication must issue a session cookie');
      return cookie;
    }
    ownerCookie = await signIn(owner);
    async function send(command: Command, cookie = ownerCookie) {
      return request<CommandReceipt>(`/api/v1/workspaces/${workspaceId}/commands`, { method: 'POST', body: command, cookie });
    }
    return {
      root, coreRoot, blobRoot, parents, schema, pool, owner, workspaceId, databaseUrl,
      get origin() { if (!api?.origin) throw new Error('The fixture API is stopped'); return api.origin; },
      get ownerCookie() { return ownerCookie; },
      request, send, close, stopServices, restartApi,
      authenticateAt: origin => signIn(owner, origin),
      async crashApi() {
        if (!api || api.exited) throw new Error('No owned API is running');
        api.child.kill('SIGKILL');
        await api.closed;
        api = undefined;
      },
      async command<T = Entity>(commandType: string, payload: Record<string, unknown>, extra: Partial<Command> = {}, cookie = ownerCookie): Promise<T> {
        const response = await send({ commandId: randomUUID(), commandType, payload, ...extra }, cookie);
        assert.equal(response.status, 200, JSON.stringify(response.body));
        assert.equal(response.body.status, 'committed', JSON.stringify(response.body));
        return response.body.result as T;
      },
      async member(name: string) {
        const user = await createUser(pool!, { email: `${randomUUID()}@example.test`, name, password });
        return { user, cookie: await signIn(user) };
      },
      async startWorker() {
        if (worker && !worker.exited) return;
        worker = await startOwned(['apps/worker/src/main.ts'], environment(), false);
        await localProjectEventually(async () => {
          assert.equal(worker?.exited || worker?.failed, false, 'Owned Worker exited before its real heartbeat');
          return (await pool!.query("SELECT 1 FROM service_heartbeats WHERE role='worker' AND heartbeat_at > now()-interval '20 seconds'")).rowCount! > 0;
        }, 'the real Worker loop heartbeat');
      },
      async startBrowser() {
        if (!api?.origin) throw new Error('Start the fixture API before the browser server');
        web ??= await startOwned(['tests/local-project-process.ts', 'web'], { ...environment(), PM_API_URL: api.origin, PM_API_ORIGIN: 'http://127.0.0.1:4100', PM_ENABLE_LAB: 'true' }, true);
        const origin = web.origin!;
        const metadataPath = join(root!, 'browser-setup.json');
        // Generated credentials are only in this mode-0600 file beneath a mode-0700
        // owned temporary directory. No HTTP setup endpoint or stdout secret exists.
        await writeFile(metadataPath, JSON.stringify({ origin, apiOrigin: api.origin, workspaceId, email: owner.email, password, projectParents: parents }, null, 2) + '\n', { mode: 0o600 });
        return { origin, metadataPath };
      },
    };
  } catch (error) { await close(); throw error; }
}
