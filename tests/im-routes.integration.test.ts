import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildApp } from '../apps/server/pm/src/app.ts';
import { createPool, migrate } from '../packages/infrastructure/src/database.ts';
import { createUser, createWorkspace } from '../packages/infrastructure/src/auth.ts';
import type { ImGatewayConfig } from '../packages/infrastructure/src/im-gateway-config.ts';

test('IM settings routes expose only the current actor bindings and enforce link-code configuration', { timeout: 90_000 }, async t => {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  assert.ok(url, 'Real PostgreSQL required; a skipped database test is not acceptance');
  const schema = `test_im_routes_${randomUUID().replaceAll('-', '')}`;
  const bootstrap = createPool(url);
  await bootstrap.query(`CREATE SCHEMA ${schema}`);
  const scoped = new URL(url);
  scoped.searchParams.set('options', `-c search_path=${schema},public`);
  const pool = createPool(scoped.toString());
  const root = await mkdtemp(join(tmpdir(), 'pm-im-routes-'));
  await migrate(pool);
  const owner = await createUser(pool, { email: `${randomUUID()}@example.test`, name: 'IM route owner', password: 'isolated-im-route-password' });
  const other = await createUser(pool, { email: `${randomUUID()}@example.test`, name: 'Other member', password: 'isolated-im-route-password' });
  const workspace = await createWorkspace(pool, owner.id, 'IM routes');
  await pool.query('INSERT INTO memberships(workspace_id,user_id,capabilities,project_ids) VALUES($1,$2,$3,NULL)', [workspace.id, other.id, ['domain.read']]);
  const im: ImGatewayConfig = { wsUrl: 'ws://127.0.0.1:1/satori', apiUrl: 'http://127.0.0.1:1/satori', token: 'T'.repeat(32), platforms: ['telegram'], timeoutMs: 1_000, linkTtlSeconds: 600, gatewayId: 'test-gateway', botUsername: 'dovspace_test_bot' };
  const app = buildApp({ databaseUrl: scoped.toString(), coreWorkspaceRoot: join(root, 'core'), publicOrigin: 'http://127.0.0.1:3224', im });
  t.after(async () => {
    await app.close();
    await pool.end();
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await bootstrap.end();
    await rm(root, { recursive: true, force: true });
  });
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: owner.email, password: 'isolated-im-route-password' } });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = login.headers['set-cookie'];
  assert.ok(cookie);
  const headers = { cookie: Array.isArray(cookie) ? cookie[0]!.split(';')[0]! : cookie.split(';')[0]! };

  const initial = await app.inject({ method: 'GET', url: `/api/v1/workspaces/${workspace.id}/im`, headers });
  assert.equal(initial.statusCode, 200, initial.body);
  const initialBody = initial.json<{ configuration: string; connectivity: { satori: { state: string }; bots: unknown[] }; bindings: unknown[] }>();
  assert.equal(initialBody.configuration, 'configured');
  assert.equal(initialBody.connectivity.satori.state, 'disconnected');
  assert.deepEqual(initialBody.connectivity.bots, []);
  assert.deepEqual(initialBody.bindings, []);

  const created = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspace.id}/im/link-codes`, headers, payload: {} });
  assert.equal(created.statusCode, 200, created.body);
  const code = created.json<{ code: string; expiresAt: string }>();
  assert.match(code.code, /^[0-9A-F]{4}(?:-[0-9A-F]{4}){7}$/);
  assert.equal(code.code.replaceAll('-', '').length, 32);
  assert.ok(Date.parse(code.expiresAt) > Date.now());

  const bindingId = randomUUID();
  await pool.query(
    'INSERT INTO im_identities(id,workspace_id,user_id,platform,bot_self_id,platform_user_id,platform_user_name,reply_channel_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [bindingId, workspace.id, owner.id, 'telegram', 'bot-1', 'platform-user-1', 'Operator', 'dm-1'],
  );
  const listed = await app.inject({ method: 'GET', url: `/api/v1/workspaces/${workspace.id}/im`, headers });
  const listedBody = listed.json<{ bindings: Array<{ id: string; accountLabel: string; notifyEnabled: boolean }> }>();
  assert.equal(listedBody.bindings.length, 1);
  assert.equal(listedBody.bindings[0]!.id, bindingId);
  assert.match(listedBody.bindings[0]!.accountLabel, /Operator/);

  const updated = await app.inject({ method: 'PATCH', url: `/api/v1/workspaces/${workspace.id}/im/bindings/${bindingId}`, headers, payload: { notifyEnabled: true } });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.equal(updated.json<{ notifyEnabled: boolean }>().notifyEnabled, true);
  const revoked = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspace.id}/im/bindings/${bindingId}/revoke`, headers, payload: {} });
  assert.equal(revoked.statusCode, 200, revoked.body);
  assert.deepEqual(revoked.json(), { revoked: true });
  const after = await app.inject({ method: 'GET', url: `/api/v1/workspaces/${workspace.id}/im`, headers });
  assert.deepEqual(after.json<{ bindings: unknown[] }>().bindings, []);

  const otherLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: other.email, password: 'isolated-im-route-password' } });
  const otherCookie = otherLogin.headers['set-cookie'];
  assert.ok(otherCookie);
  const otherHeaders = { cookie: Array.isArray(otherCookie) ? otherCookie[0]!.split(';')[0]! : otherCookie.split(';')[0]! };
  const otherList = await app.inject({ method: 'GET', url: `/api/v1/workspaces/${workspace.id}/im`, headers: otherHeaders });
  assert.deepEqual(otherList.json<{ bindings: unknown[] }>().bindings, []);
});
