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
  member(name: string): Promise<{ user: Actor; cookie: string }>;
  close(): Promise<void>;
};

/** Every fixture owns its schema, account, HTTP listener and temporary content roots. */
export async function createDashboardFixture(): Promise<DashboardFixture> {
  if (!dashboardDatabaseUrl) throw new Error('A real TEST_DATABASE_URL or DATABASE_URL is required');
  const namespace = `test_dashboard_${randomUUID().replaceAll('-', '')}`;
  const bootstrap = createPool(dashboardDatabaseUrl);
  let pool: Pool | undefined;
  let app: FastifyInstance | undefined;
  let root: string | undefined;
  let createdSchema = false;
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    try { await app?.close(); }
    finally {
      try { await pool?.end(); }
      finally {
        try { if (createdSchema) await bootstrap.query(`DROP SCHEMA ${namespace} CASCADE`); }
        finally {
          await bootstrap.end();
          if (root) await rm(root, { recursive: true, force: true });
        }
      }
    }
  }
  try {
    await bootstrap.query(`CREATE SCHEMA ${namespace}`);
    createdSchema = true;
    const scopedUrl = new URL(dashboardDatabaseUrl);
    scopedUrl.searchParams.set('options', `-c search_path=${namespace},public`);
    pool = createPool(scopedUrl.toString());
    await migrate(pool);
    const password = 'isolated-dashboard-test-password';
    const owner = await createUser(pool, { email: `${randomUUID()}@example.test`, name: 'Dashboard owner', password });
    const workspaceId = (await createWorkspace(pool, owner.id, 'Dashboard integration')).id;
    root = await mkdtemp(join(tmpdir(), 'pm-dashboard-'));
    const coreRoot = join(root, 'core');
    app = buildApp({ databaseUrl: scopedUrl.toString(), ...await createBoundLocalStorage(pool, join(root, 'blobs')), coreWorkspaceRoot: coreRoot });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    let ownerCookie = '';
    async function request<T = unknown>(path: string, options: DashboardRequestOptions = {}): Promise<DashboardResponse<T>> {
      const response = await fetch(`${origin}${path}`, {
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
      app, pool, owner, workspaceId, origin, coreRoot, ownerCookie, request, send, close,
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
  } catch (error) { await close(); throw error; }
}
