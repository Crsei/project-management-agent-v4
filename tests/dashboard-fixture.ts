import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { buildApp } from '../apps/api/src/app.ts';
import type { Actor, Command, CommandReceipt, Entity } from '../packages/domain/src/core.ts';
import { createUser, createWorkspace } from '../packages/infrastructure/src/auth.ts';
import { createPool, migrate } from '../packages/infrastructure/src/database.ts';
import { createBoundLocalStorage } from './blob-fixture.ts';
import { MailFixtureScope, closeMailApp, interruptMailPoolOnAbort } from './mail-fixture-lifecycle.ts';

export const dashboardDatabaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
export type DashboardModule = 'personal' | 'time' | 'sprints' | 'portfolio' | 'planning';
export type DashboardResponse<T> = { status: number; body: T; headers: Headers };
export type DashboardCommandOptions = { extra?: Partial<Command>; cookie?: string; workspace?: string };
export type DashboardRequestOptions = { method?: string; cookie?: string; body?: unknown; headers?: Record<string, string> };
export type DashboardFixture = {
  app: FastifyInstance; pool: Pool; owner: Actor; workspaceId: string; origin: string; coreRoot: string; ownerCookie: string;
  command<T = Entity>(type: string, payload: Record<string, unknown>, options?: DashboardCommandOptions): Promise<T>;
  send(command: Command, options?: DashboardCommandOptions): Promise<DashboardResponse<CommandReceipt>>;
  read<T>(module: DashboardModule, options?: DashboardCommandOptions): Promise<T>;
  request<T = unknown>(path: string, options?: DashboardRequestOptions): Promise<DashboardResponse<T>>;
  ownApp(create: () => FastifyInstance): FastifyInstance;
  deferCleanup(cleanup: () => Promise<unknown>): void;
  member(name: string): Promise<{ user: Actor; cookie: string }>;
  close(): Promise<void>;
};

/** Every fixture owns its schema, account, HTTP listener and temporary content roots. */
export async function createDashboardFixture(options: { signal?: AbortSignal } = {}): Promise<DashboardFixture> {
  if (!dashboardDatabaseUrl) throw new Error('A real TEST_DATABASE_URL or DATABASE_URL is required');
  // Cold migrations measured 25s; restart recovery also performs durable disk
  // initialization. This bounds acquisition, not the sum of the suite's cases.
  const scope = new MailFixtureScope(options.signal, 120_000);
  return scope.initialize(async () => {
    const namespace = `test_dashboard_${randomUUID().replaceAll('-', '')}`;
    const bootstrap = scope.own(createPool(dashboardDatabaseUrl), owned => owned.end());
    let createdSchema = false;
    scope.defer(async () => { if (createdSchema) await bootstrap.query(`DROP SCHEMA ${namespace} CASCADE`); });
    await scope.step(async () => {
      await bootstrap.query(`CREATE SCHEMA ${namespace}`);
      createdSchema = true;
    });
    const scopedUrl = new URL(dashboardDatabaseUrl);
    scopedUrl.searchParams.set('options', `-c search_path=${namespace},public`);
    const pool = scope.own(createPool(scopedUrl.toString()), owned => owned.end());
    const interruption = interruptMailPoolOnAbort(pool, scope.signal, bootstrap);
    scope.defer(() => interruption.finish());
    await scope.step(() => migrate(pool));
    const password = 'isolated-dashboard-test-password';
    const owner = await scope.step(() => createUser(pool, { email: `${randomUUID()}@example.test`, name: 'Dashboard owner', password }));
    const workspaceId = (await scope.step(() => createWorkspace(pool, owner.id, 'Dashboard integration'))).id;
    const root = await scope.acquire(() => mkdtemp(join(tmpdir(), 'pm-dashboard-')), owned => rm(owned, { recursive: true, force: true }));
    const coreRoot = join(root, 'core');
    const storage = await scope.step(() => createBoundLocalStorage(pool, join(root, 'blobs')));
    const app = scope.own(buildApp({ databaseUrl: scopedUrl.toString(), ...storage, coreWorkspaceRoot: coreRoot, signal: scope.signal }), closeMailApp);
    const origin = await scope.step(() => app.listen({ host: '127.0.0.1', port: 0 }));
    let ownerCookie = '';
    async function request<T = unknown>(path: string, options: DashboardRequestOptions = {}): Promise<DashboardResponse<T>> {
      const response = await fetch(`${origin}${path}`, {
        signal: scope.signal,
        method: options.method ?? 'GET',
        headers: { cookie: options.cookie ?? ownerCookie, ...(options.body === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
      return { status: response.status, body: await response.json() as T, headers: response.headers };
    }
    async function signIn(user: Actor) {
      const response = await request('/api/v1/auth/login', { method: 'POST', cookie: '', body: { email: user.email, password } });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      const cookie = response.headers.get('set-cookie');
      assert.ok(cookie);
      return cookie.split(';')[0]!;
    }
    ownerCookie = await signIn(owner);
    async function send(command: Command, options: DashboardCommandOptions = {}) {
      return request<CommandReceipt>(`/api/v1/workspaces/${options.workspace ?? workspaceId}/commands`, { method: 'POST', cookie: options.cookie ?? ownerCookie, body: command });
    }
    return {
      app, pool, owner, workspaceId, origin, coreRoot, ownerCookie, request, send, close: scope.close,
      ownApp(create) {
        scope.checkpoint();
        return scope.own(create(), closeMailApp);
      },
      deferCleanup(cleanup) {
        scope.checkpoint();
        scope.defer(cleanup);
      },
      async command<T = Entity>(commandType: string, payload: Record<string, unknown>, options: DashboardCommandOptions = {}): Promise<T> {
        const response = await send({ commandId: randomUUID(), commandType, payload, ...options.extra }, options);
        assert.equal(response.status, 200, JSON.stringify(response.body));
        assert.equal(response.body.status, 'committed', JSON.stringify(response.body));
        return response.body.result as T;
      },
      async read<T>(module: DashboardModule, options: DashboardCommandOptions = {}): Promise<T> {
        const response = await request<T>(`/api/v1/workspaces/${options.workspace ?? workspaceId}/dashboard/${module}`, { cookie: options.cookie ?? ownerCookie });
        assert.equal(response.status, 200, JSON.stringify(response.body));
        return response.body;
      },
      async member(name: string) {
        const user = await createUser(pool!, { email: `${randomUUID()}@example.test`, name, password });
        return { user, cookie: await signIn(user) };
      },
    };
  });
}
