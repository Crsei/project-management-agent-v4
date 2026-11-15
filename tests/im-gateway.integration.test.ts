import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createPool, migrate } from '../packages/infrastructure/src/database.ts';
import { createUser, createWorkspace } from '../packages/infrastructure/src/auth.ts';
import { createImLinkCode, enqueueImJob, revokeImBinding, type ImBindingRow } from '../packages/application/src/im-gateway.ts';
import { deliverImBatch } from '../packages/application/src/im-delivery.ts';
import { createImSatoriRuntime } from '../apps/server/pm/src/im-satori.ts';
import type { Actor, Command, CommandReceipt, Entity } from '../packages/domain/src/core.ts';
import type { ImGatewayConfig } from '../packages/infrastructure/src/im-gateway-config.ts';

type Captured = { body: { channel_id: string; content: string }; headers: http.IncomingHttpHeaders };

async function satoriServer() {
  const captured: Captured[] = [];
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    captured.push({ body: JSON.parse(Buffer.concat(chunks).toString('utf8')), headers: request.headers });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', () => listening.resolve());
  await listening.promise;
  const port = (server.address() as AddressInfo).port;
  return {
    captured,
    port,
    close: async () => {
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    },
  };
}

function event(content: string, id = randomUUID(), overrides: Record<string, unknown> = {}) {
  return {
    sn: 1,
    type: 'message',
    self_id: 'bot-1',
    platform: 'telegram',
    timestamp: Date.now(),
    user: { id: 'platform-user-1', name: 'Operator' },
    channel: { id: 'dm-1', type: 1 },
    message: { id, content },
    ...overrides,
  };
}

async function fixture() {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  assert.ok(url, 'Real PostgreSQL required; a skipped database test is not acceptance');
  const schema = `test_im_gateway_${randomUUID().replaceAll('-', '')}`;
  const bootstrap = createPool(url);
  await bootstrap.query(`CREATE SCHEMA ${schema}`);
  const scoped = new URL(url);
  scoped.searchParams.set('options', `-c search_path=${schema},public`);
  const pool = createPool(scoped.toString());
  const root = await mkdtemp(join(tmpdir(), 'pm-im-gateway-'));
  await migrate(pool);
  const owner = await createUser(pool, { email: `${randomUUID()}@example.test`, name: 'IM owner', password: 'isolated-im-fixture-password' });
  const workspace = await createWorkspace(pool, owner.id, 'IM fixture');
  const project: Entity = {
    id: 'PRJ-001', workspaceId: workspace.id, projectId: null, kind: 'project', version: 1,
    data: { title: 'IM Project', name: 'IM Project', archived: false }, createdAt: null, updatedAt: null, createdBy: owner.id,
  };
  const task: Entity = {
    id: 'TASK-001', workspaceId: workspace.id, projectId: project.id, kind: 'work_item', version: 1,
    data: { title: 'Existing task', status: 'draft', assigneeId: owner.id, archived: false }, createdAt: null, updatedAt: null, createdBy: owner.id,
  };
  const commands: Command[] = [];
  const receipts = new Map<string, CommandReceipt>();
  return {
    url, pool, bootstrap, schema, root, owner, workspace, project, task, commands,
    execute: async (_actor: Actor, _workspaceId: string, command: Command): Promise<CommandReceipt> => {
      commands.push(command);
      const saved = receipts.get(command.commandId);
      if (saved) return saved;
      const receipt: CommandReceipt = {
        commandId: command.commandId, status: 'committed', httpStatus: 200,
        result: command.commandType === 'CreateWorkItem'
          ? { ...task, id: 'TASK-002', data: { ...task.data, title: command.payload.title, status: 'draft' } }
          : task,
      };
      receipts.set(command.commandId, receipt);
      return receipt;
    },
    read: async (_actor: Actor, _workspaceId: string, id: string): Promise<Entity> => {
      if (id === project.id) return project;
      if (id === task.id || id === 'TASK-002') return task;
      throw new Error('unexpected read');
    },
    list: async (_actor: Actor, _workspaceId: string, kind: 'project' | 'work_item'): Promise<Entity[]> => kind === 'project' ? [project] : [task],
    findWatch: async () => null,
    close: async () => {
      await pool.end();
      await bootstrap.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await bootstrap.end();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function config(apiUrl: string): ImGatewayConfig {
  return { wsUrl: 'ws://127.0.0.1:1/satori', apiUrl, token: 'T'.repeat(32), platforms: ['telegram'], timeoutMs: 2_000, linkTtlSeconds: 600, gatewayId: 'test-gateway', botUsername: 'dovspace_test_bot' };
}

test('IM gateway links a private account, routes fixed commands through the command port and drains replies exactly once', { timeout: 60_000 }, async t => {
  const f = await fixture();
  const satori = await satoriServer();
  t.after(async () => { await satori.close(); await f.close(); });
  const runtime = createImSatoriRuntime({
    config: config(`http://127.0.0.1:${satori.port}/satori`), database: () => f.pool,
    publicOrigin: 'http://127.0.0.1:3224',
    ports: { execute: f.execute, read: f.read, list: f.list, findWatch: f.findWatch },
  });
  const link = await createImLinkCode(f.pool, f.owner, f.workspace.id, 600);
  await runtime.handleEvent(event(`/link ${link.code}`));
  const binding = (await f.pool.query<ImBindingRow>('SELECT * FROM im_identities WHERE workspace_id=$1', [f.workspace.id])).rows[0]!;
  assert.equal(binding.user_id, f.owner.id);
  assert.equal(link.code.replaceAll('-', '').length, 32);
  const groupCode = await createImLinkCode(f.pool, f.owner, f.workspace.id, 600);
  const beforeGroupLink = (await f.pool.query<{ count: string }>('SELECT count(*)::text AS count FROM im_identities')).rows[0]!.count;
  await runtime.handleEvent(event(`/link ${groupCode.code}`, randomUUID(), { guild: { id: 'group-1' } }));
  assert.equal((await f.pool.query<{ count: string }>('SELECT count(*)::text AS count FROM im_identities')).rows[0]!.count, beforeGroupLink);
  const otherUser = await createUser(f.pool, { email: `${randomUUID()}@example.test`, name: 'Other IM user', password: 'isolated-im-other-password' });
  const otherWorkspace = await createWorkspace(f.pool, otherUser.id, 'Other IM workspace');
  const otherCode = await createImLinkCode(f.pool, otherUser, otherWorkspace.id, 600);
  await runtime.handleEvent(event(`/link ${otherCode.code}`));
  const stillOwner = (await f.pool.query<ImBindingRow>('SELECT * FROM im_identities WHERE id=$1', [binding.id])).rows[0]!;
  assert.equal(stillOwner.user_id, f.owner.id);
  assert.ok(satori.captured.some(message => /已绑定其他工作区/.test(message.body.content)));
  await deliverImBatch(f.pool, config(`http://127.0.0.1:${satori.port}/satori`));
  assert.equal(satori.captured.filter(message => /绑定成功/.test(message.body.content)).length, 1);
  await deliverImBatch(f.pool, config(`http://127.0.0.1:${satori.port}/satori`));
  assert.equal(satori.captured.filter(message => /绑定成功/.test(message.body.content)).length, 1);

  await runtime.handleEvent(event('/use PRJ-001'));
  await deliverImBatch(f.pool, config(`http://127.0.0.1:${satori.port}/satori`));
  const taskEvent = event('/task Fix login');
  await runtime.handleEvent(taskEvent);
  const created = f.commands.at(-1)!;
  assert.equal(created.commandType, 'CreateWorkItem');
  assert.equal(created.projectId, 'PRJ-001');
  assert.equal(created.payload.title, 'Fix login');
  await runtime.handleEvent(taskEvent);
  assert.equal(f.commands.at(-1)!.commandId, created.commandId);

  await runtime.handleEvent(event('/show TASK-001'));
  await runtime.handleEvent(event('/done TASK-001'));
  assert.equal(f.commands.at(-1)!.commandType, 'CompleteWorkItem');
  await deliverImBatch(f.pool, config(`http://127.0.0.1:${satori.port}/satori`));
  assert.ok(satori.captured.some(message => /TASK-001/.test(message.body.content)));

  const beforeGroup = f.commands.length;
  await runtime.handleEvent(event('/task grouped', randomUUID(), { guild: { id: 'group-1' } }));
  assert.equal(f.commands.length, beforeGroup);
  assert.ok(satori.captured.some(message => /仅支持私聊/.test(message.body.content)));

  await revokeImBinding(f.pool, f.owner, f.workspace.id, binding.id);
  const beforeRevoked = f.commands.length;
  await runtime.handleEvent(event('/show TASK-001'));
  assert.equal(f.commands.length, beforeRevoked);
  assert.ok(satori.captured.some(message => /尚未绑定/.test(message.body.content)));

  await enqueueImJob(f.pool, binding, 'reply', 'rebind-pending', 'must be suppressed');
  const rebindJob = (await f.pool.query<{ id: string }>("SELECT id FROM im_delivery_jobs WHERE binding_id=$1 AND payload='must be suppressed'", [binding.id])).rows[0]!;
  const secondWorkspace = await createWorkspace(f.pool, f.owner.id, 'Rebind target');
  const secondCode = await createImLinkCode(f.pool, f.owner, secondWorkspace.id, 600);
  await runtime.handleEvent(event(`/link ${secondCode.code}`));
  const rebound = (await f.pool.query<ImBindingRow>('SELECT * FROM im_identities WHERE id=$1', [binding.id])).rows[0]!;
  assert.equal(rebound.workspace_id, secondWorkspace.id);
  assert.equal((await f.pool.query<{ state: string }>('SELECT state FROM im_delivery_jobs WHERE id=$1', [rebindJob.id])).rows[0]!.state, 'suppressed');
});

test('IM delivery marks an unreachable Satori send as unknown and never retries it automatically', { timeout: 60_000 }, async t => {
  const f = await fixture();
  const satori = await satoriServer();
  t.after(async () => { await satori.close(); await f.close(); });
  const link = await createImLinkCode(f.pool, f.owner, f.workspace.id, 600);
  const runtime = createImSatoriRuntime({
    config: config(`http://127.0.0.1:${satori.port}/satori`), database: () => f.pool,
    publicOrigin: 'http://127.0.0.1:3224',
    ports: { execute: f.execute, read: f.read, list: f.list, findWatch: f.findWatch },
  });
  await runtime.handleEvent(event(`/link ${link.code}`));
  const binding = (await f.pool.query<ImBindingRow>('SELECT * FROM im_identities WHERE workspace_id=$1', [f.workspace.id])).rows[0]!;
  await f.pool.query('DELETE FROM im_delivery_jobs');
  await enqueueImJob(f.pool, binding, 'reply', 'unknown-delivery', 'cannot be confirmed');
  await satori.close();
  const result = await deliverImBatch(f.pool, config(`http://127.0.0.1:${satori.port}/satori`));
  assert.equal(result.unknown, 1);
  const job = (await f.pool.query<{ state: string }>('SELECT state FROM im_delivery_jobs WHERE binding_id=$1', [binding.id])).rows[0]!;
  assert.equal(job.state, 'unknown');
  const retry = await deliverImBatch(f.pool, config(`http://127.0.0.1:${satori.port}/satori`));
  assert.equal(retry.attempted, 0);
});
