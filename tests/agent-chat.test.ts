/// <reference lib="es2024.promise" />
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { buildApp } from '../apps/api/src/app.ts';
import Fastify from 'fastify';
import { registerAgentChatRoutes } from '../apps/api/src/agent-chat-routes.ts';
import type { AgentChatConfiguration } from '../packages/infrastructure/src/agent-chat-config.ts';
import type { AgentChatMessage, AgentChatThreadDetail } from '../packages/contracts/src/agent-chat.ts';
import { createUser, createWorkspace } from '../packages/infrastructure/src/auth.ts';
import { createPool, migrate } from '../packages/infrastructure/src/database.ts';
import { createBoundLocalStorage } from './blob-fixture.ts';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
type ChatEvent = { event: string; data: { message?: AgentChatMessage; delta?: string; code?: string } };

async function fixture(modelConfig?: AgentChatConfiguration) {
  assert.ok(databaseUrl, 'A real PostgreSQL connection is required');
  const namespace = `test_agent_chat_${randomUUID().replaceAll('-', '')}`;
  const bootstrap = createPool(databaseUrl);
  const upstreamResponse = Promise.withResolvers<ServerResponse>();
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.flushHeaders();
    upstreamResponse.resolve(response);
  });
  let pool: Pool | undefined;
  let app: FastifyInstance | undefined;
  let root: string | undefined;
  let createdSchema = false;
  async function close() {
    upstream.closeAllConnections();
    if (upstream.listening) { const closed = once(upstream, 'close'); upstream.close(); await closed; }
    try { await app?.close(); }
    finally {
      try { await pool?.end(); }
      finally {
        try { if (createdSchema) await bootstrap.query(`DROP SCHEMA ${namespace} CASCADE`); }
        finally { await bootstrap.end(); if (root) await rm(root, { recursive: true, force: true }); }
      }
    }
  }
  try {
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const address = upstream.address();
    assert.ok(address && typeof address !== 'string');
    await bootstrap.query(`CREATE SCHEMA ${namespace}`);
    createdSchema = true;
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set('options', `-c search_path=${namespace},public`);
    pool = createPool(scopedUrl.toString());
    await migrate(pool);
    const password = 'isolated-agent-chat-test-password';
    const owner = await createUser(pool, { email: `${randomUUID()}@example.test`, name: 'Chat owner', password });
    const workspace = await createWorkspace(pool, owner.id, 'Agent chat integration');
    root = await mkdtemp(join(tmpdir(), 'pm-agent-chat-'));
    app = buildApp({ databaseUrl: scopedUrl.toString(), ...await createBoundLocalStorage(pool, join(root, 'blobs')),
      coreWorkspaceRoot: join(root, 'core'), agentChat: modelConfig ?? { baseUrl: `http://127.0.0.1:${address.port}`, apiKey: '', model: 'local-test', systemPrompt: 'Test chat', historyLimit: 10 } });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const login = await fetch(`${origin}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: owner.email, password }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    await login.arrayBuffer();
    const base = `/api/v1/workspaces/${workspace.id}/agent/threads`;
    async function request(path: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}) {
      return fetch(`${origin}${path}`, { method, headers: { cookie: cookie!, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    }
    const threadId = randomUUID();
    const created = await request(base, 'POST', { id: threadId });
    assert.equal(created.status, 200);
    await created.arrayBuffer();
    const path = `${base}/${threadId}`;
    async function detail() {
      const response = await request(path);
      assert.equal(response.status, 200);
      return await response.json() as AgentChatThreadDetail;
    }
    async function start() {
      const response = await request(`${path}/messages`, 'POST', { messageId: randomUUID(), content: 'A cancellation regression' });
      assert.equal(response.status, 200);
      assert.ok(response.body);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      async function next(): Promise<ChatEvent | null> {
        while (true) {
          const end = pending.indexOf('\n\n');
          if (end !== -1) {
            const frame = pending.slice(0, end); pending = pending.slice(end + 2);
            const event = /^event: (.+)$/m.exec(frame)?.[1];
            const data = /^data: (.+)$/m.exec(frame)?.[1];
            if (event && ['capabilities', 'context', 'tool'].includes(event)) continue;
            if (event && data) return { event, data: JSON.parse(data) as ChatEvent['data'] };
            continue;
          }
          const chunk = await reader.read();
          if (chunk.done) return null;
          pending += decoder.decode(chunk.value, { stream: true });
        }
      }
      assert.equal((await next())?.event, 'user');
      const assistant = await next();
      assert.equal(assistant?.event, 'assistant');
      assert.ok(assistant);
      assert.ok(assistant.data.message);
      const provider = await upstreamResponse.promise;
      return { next, messageId: assistant.data.message.id, provider,
        delta(text: string) { provider.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`); },
        complete() { provider.end('data: [DONE]\n\n'); } };
    }
    return { pool, app, origin, workspace, owner, threadId, path, request, detail, start, close };
  } catch (error) { await close(); throw error; }
}

async function waitForPersisted(f: { detail(): Promise<AgentChatThreadDetail> }, content: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if ((await f.detail()).messages.at(-1)?.content === content) return;
    await delay(10);
  }
  assert.fail('The streaming partial text was not persisted');
}

async function waitForFinalWrite(pool: Pool, blocker: number) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await pool.query(`SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE 'UPDATE agent_chat_messages SET content=$2,status=%'`, [blocker]);
    if (result.rowCount) return;
    await delay(10);
  }
  assert.fail('The terminal write did not reach the held PostgreSQL row lock');
}

describe('Agent chat cancellation: real PostgreSQL and local upstream', { skip: !databaseUrl, timeout: 600_000 }, () => {
  it('rejects unsupported reasoning before inserting messages or contacting any model', async t => {
    const f = await fixture(); t.after(() => f.close());
    const status = await f.request(`/api/v1/workspaces/${f.workspace.id}/agent/status`);
    assert.equal(status.status, 200);
    assert.deepEqual((await status.json() as { reasoning: unknown }).reasoning, { supported: false, efforts: ['auto'], defaultEffort: 'auto' });
    for (const reasoningEffort of ['none', 'high', 'max']) {
      const response = await f.request(`${f.path}/messages`, 'POST', { messageId: randomUUID(), content: 'Must not persist', reasoningEffort });
      assert.equal(response.status, 400);
      assert.equal((await response.json() as { error: { code: string } }).error.code, 'agent_reasoning_unsupported');
    }
    assert.deepEqual((await f.detail()).messages, []);
    const stored = await f.pool.query('SELECT count(*)::int AS count FROM agent_chat_messages WHERE thread_id=$1', [f.threadId]);
    assert.equal(stored.rows[0]?.count, 0);
  });

  it('keeps selected effort and private reasoning through native tool rounds and upgrades old visible history safely', async t => {
    const config = { baseUrl: 'https://api.deepseek.com', apiKey: '', model: 'deepseek-flash', systemPrompt: 'Only server tools authorize writes', historyLimit: 40 };
    const f = await fixture(config); t.after(() => f.close());
    const actualFetch = globalThis.fetch;
    const requests: { messages: { role: string; content: string | null; reasoning_content?: string }[]; reasoning_effort?: string; thinking?: unknown; tools?: unknown[] }[] = [];
    let turn = 0;
    t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).startsWith('https://api.deepseek.com/')) {
        const body = JSON.parse(String(init?.body)) as typeof requests[number]; requests.push(body);
        turn++;
        const message = turn <= 2
          ? { content: turn === 1 ? 'Checking the project.' : null, reasoning_content: `PRIVATE_THOUGHT_${turn}`, tool_calls: [{ id: `read_${turn}`, type: 'function', function: { name: 'pm_read', arguments: JSON.stringify({ id: project.id, bodyOffset: 0, bodyLimit: 1000 }) } }] }
          : { content: 'The native reads completed.', reasoning_content: 'PRIVATE_FINAL_THOUGHT' };
        return new Response(JSON.stringify({ choices: [{ finish_reason: turn <= 2 ? 'tool_calls' : 'stop', message }] }), { headers: { 'content-type': 'application/json' } });
      }
      return actualFetch(url, init);
    });
    const seeded = await f.request(`/api/v1/workspaces/${f.workspace.id}/core/entities`, 'POST', { entity: 'project', title: 'Reasoning native read target' }, { 'idempotency-key': randomUUID() });
    assert.equal(seeded.status, 200, await seeded.clone().text());
    const project = await seeded.json() as { id: string };
    const accessResponse = await f.request(`${f.path}/access`);
    const initial = await accessResponse.json() as { revision: number };
    const enabled = await f.request(`${f.path}/access`, 'PUT', { enabled: true, expectedRevision: initial.revision, scope: { kind: 'projects', projectIds: [project.id] } });
    assert.equal(enabled.status, 200, await enabled.clone().text());
    const grant = await enabled.json() as { grantId: string; revision: number };
    await f.pool.query("INSERT INTO agent_chat_messages(id,thread_id,role,content,status) VALUES($1,$2,'user','Earlier question','complete'),($3,$2,'assistant','Earlier visible answer without persisted reasoning','complete')", [randomUUID(), f.threadId, randomUUID()]);
    const rejected = await f.request(`${f.path}/messages`, 'POST', { messageId: randomUUID(), content: 'Do not persist aliased effort', reasoningEffort: 'medium' });
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json() as { error: { code: string } }).error.code, 'agent_reasoning_unsupported');
    assert.equal((await f.detail()).messages.length, 2);
    const response = await f.request(`${f.path}/messages`, 'POST', { messageId: randomUUID(), content: 'Read this project twice', reasoningEffort: 'high' });
    assert.equal(response.status, 200);
    const streamed = await response.text();
    assert.ok(streamed.includes('event: done'));
    assert.equal(streamed.includes('PRIVATE_'), false);
    assert.equal(requests.length, 3);
    assert.ok(requests.every(body => body.reasoning_effort === 'high' && JSON.stringify(body.thinking) === '{"type":"enabled"}' && (body.tools?.length ?? 0) > 0));
    assert.equal(requests[0]!.messages.some(message => message.role === 'assistant'), false);
    assert.ok(requests[0]!.messages.some(message => message.content?.includes('Earlier visible answer')));
    assert.deepEqual(requests[2]!.messages.filter(message => message.role === 'assistant').map(message => message.reasoning_content), ['PRIVATE_THOUGHT_1', 'PRIVATE_THOUGHT_2']);
    const history = await f.detail();
    const last = history.messages.at(-1)!;
    assert.equal(last.content, 'Checking the project.\n\nThe native reads completed.');
    assert.equal(last.status, 'complete');
    assert.equal(last.toolCalls?.length, 2);
    assert.ok(last.toolCalls?.every(call => call.status === 'succeeded' && call.result?.sources.some(source => source.entityId === project.id)));
    assert.equal(JSON.stringify(history).includes('PRIVATE_'), false);
    const persisted = await f.pool.query('SELECT content,context_sources FROM agent_chat_messages WHERE thread_id=$1', [f.threadId]);
    assert.equal(JSON.stringify(persisted.rows).includes('PRIVATE_'), false);
    const after = await f.request(`${f.path}/access`);
    const current = await after.json() as { enabled: boolean; grantId: string; revision: number };
    assert.equal(current.enabled, true); assert.equal(current.grantId, grant.grantId); assert.equal(current.revision, grant.revision);
  });

  it('applies selected reasoning to the plain-chat route when no tools runtime is installed', async t => {
    const f = await fixture(); t.after(() => f.close());
    const config = { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-5.2', systemPrompt: 'Plain chat', historyLimit: 10 };
    const app = Fastify();
    registerAgentChatRoutes(app, { database: () => f.pool, actor: async () => f.owner, config });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    t.after(() => app.close());
    const actualFetch = globalThis.fetch;
    const bodies: Record<string, unknown>[] = [];
    t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).startsWith('https://api.openai.com/')) {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Plain answer', reasoning_content: 'Private, not UI text' } }] }), { headers: { 'content-type': 'application/json' } });
      }
      return actualFetch(url, init);
    });
    const response = await fetch(`${origin}${f.path}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messageId: randomUUID(), content: 'Explain', reasoningEffort: 'xhigh' }) });
    assert.equal(response.status, 200);
    const stream = await response.text();
    assert.ok(stream.includes('event: done')); assert.equal(stream.includes('Private, not UI text'), false);
    assert.equal(bodies[0]?.reasoning_effort, 'xhigh'); assert.equal(bodies[0]?.thinking, undefined); assert.equal(bodies[0]?.tools, undefined);
    assert.equal((await f.detail()).messages.at(-1)?.content, 'Plain answer');
  });

  it('waits for cancellation persistence and retains the second, unpersisted displayed delta', async t => {
    const f = await fixture(); t.after(() => f.close());
    // Freeze only Date, not network/timers: both deltas are deterministically
    // inside the production persistence throttle even on a busy test runner.
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const stream = await f.start();
    stream.delta('First ');
    assert.equal((await stream.next())?.data.delta, 'First ');
    await waitForPersisted(f, 'First ');
    stream.delta('second');
    assert.equal((await stream.next())?.data.delta, 'second');
    assert.equal((await f.detail()).messages.at(-1)?.content, 'First ');
    const cancelled = await f.request(`${f.path}/cancel`, 'POST', { messageId: stream.messageId });
    assert.equal(cancelled.status, 200);
    assert.deepEqual(await cancelled.json(), { cancelled: true });
    const message = (await f.detail()).messages.at(-1)!;
    assert.equal(message.status, 'cancelled');
    assert.equal(message.content, 'First second');
    const terminal = await stream.next();
    assert.equal(terminal?.event, 'cancelled');
    assert.ok(terminal);
    assert.deepEqual(terminal.data.message, message);
    assert.equal(await stream.next(), null);
    const repeated = await f.request(`${f.path}/cancel`, 'POST', { messageId: stream.messageId });
    assert.deepEqual(await repeated.json(), { cancelled: false });
  });

  it('reports false when completion has already entered its terminal database write', async t => {
    const f = await fixture(); t.after(() => f.close());
    const stream = await f.start();
    stream.delta('Complete text');
    await stream.next();
    await waitForPersisted(f, 'Complete text');
    const blocker = await f.pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM agent_chat_messages WHERE id=$1 FOR UPDATE', [stream.messageId]);
      const pid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      stream.complete();
      await waitForFinalWrite(f.pool, pid);
      const cancellation = f.request(`${f.path}/cancel`, 'POST', { messageId: stream.messageId });
      await delay(25);
      await blocker.query('COMMIT');
      const response = await cancellation;
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { cancelled: false });
      assert.equal((await stream.next())?.event, 'done');
      assert.equal(await stream.next(), null);
      const message = (await f.detail()).messages.at(-1)!;
      assert.equal(message.status, 'complete');
      assert.equal(message.content, 'Complete text');
    } finally { await blocker.query('ROLLBACK'); blocker.release(); }
  });

  it('never reports cancellation success when terminal persistence fails', async t => {
    const f = await fixture(); t.after(() => f.close());
    const stream = await f.start();
    stream.delta('Retained partial');
    await stream.next();
    await waitForPersisted(f, 'Retained partial');
    await f.pool.query(`CREATE FUNCTION reject_chat_cancel() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='cancelled' THEN RAISE EXCEPTION 'isolated cancellation persistence fault'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_chat_cancel BEFORE UPDATE ON agent_chat_messages FOR EACH ROW EXECUTE FUNCTION reject_chat_cancel()`);
    const response = await f.request(`${f.path}/cancel`, 'POST', { messageId: stream.messageId });
    assert.equal(response.status, 503);
    assert.equal((await response.json() as { error: { code: string } }).error.code, 'agent_chat_persistence_failed');
    const terminal = await stream.next();
    assert.equal(terminal?.event, 'error');
    assert.ok(terminal);
    assert.equal(terminal.data.code, 'agent_chat_persistence_failed');
    assert.equal(await stream.next(), null);
    assert.equal((await f.detail()).messages.at(-1)?.status, 'streaming');
    const repeated = await f.request(`${f.path}/cancel`, 'POST', { messageId: stream.messageId });
    assert.deepEqual(await repeated.json(), { cancelled: false });
  });

  it('finalizes stream errors and deletion without leaving a pending cancellation', async t => {
    const f = await fixture(); t.after(() => f.close());
    const stream = await f.start();
    stream.delta('Partial before failure');
    await stream.next();
    stream.provider.end();
    assert.equal((await stream.next())?.event, 'error');
    assert.equal(await stream.next(), null);
    assert.equal((await f.detail()).messages.at(-1)?.status, 'error');
    const response = await f.request(`${f.path}/cancel`, 'POST', { messageId: stream.messageId });
    assert.deepEqual(await response.json(), { cancelled: false });
    const deleted = await f.request(f.path, 'DELETE');
    assert.deepEqual(await deleted.json(), { deleted: true });
    assert.equal((await f.request(f.path)).status, 404);
  });

  it('deletes an active reply after aborting and settling its generation', async t => {
    const f = await fixture(); t.after(() => f.close());
    const stream = await f.start();
    stream.delta('Partial before delete');
    await stream.next();
    const response = await f.request(f.path, 'DELETE');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { deleted: true });
    assert.equal((await stream.next())?.event, 'cancelled');
    assert.equal(await stream.next(), null);
    assert.equal((await f.request(f.path)).status, 404);
    const cancellation = await f.request(`${f.path}/cancel`, 'POST', { messageId: stream.messageId });
    assert.equal(cancellation.status, 404);
  });
});
