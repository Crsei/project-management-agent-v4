import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { buildApp } from '../apps/api/src/app.ts';
import { createPool, migrate } from '../packages/infrastructure/src/database.ts';
import { createUser, createWorkspace } from '../packages/infrastructure/src/auth.ts';
import { ProjectManagementClient } from '../packages/contracts/src/client.ts';
import type { AgentChatAccess, AgentChatStreamEvent, AgentChatThreadDetail } from '../packages/contracts/src/agent-chat.ts';
import { createBoundLocalStorage } from './blob-fixture.ts';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
type ProviderBody = { messages: { role: string; content: string | null }[]; tools?: unknown[] };
const answer = (content: string) => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] });
const tool = (id: string, name: string, args: Record<string, unknown>) => ({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] });
async function fixture() {
  assert.ok(databaseUrl, 'A real database is required');
  const schema = `test_chat_access_${randomUUID().replaceAll('-', '')}`;
  const admin = createPool(databaseUrl);
  let pool: Pool | undefined, app: FastifyInstance | undefined, root: string | undefined;
  let created = false;
  let provider: (body: ProviderBody) => unknown | Promise<unknown> = () => answer('Ordinary chat');
  const requests: ProviderBody[] = [];
  const upstream = createServer(async (request, response) => {
    try {
      let text = '';
      for await (const part of request) text += String(part);
      const body = JSON.parse(text) as ProviderBody;
      requests.push(body);
      const output = await provider(body);
      if (!response.destroyed) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(output)); }
    } catch { if (!response.destroyed) { response.writeHead(500); response.end(); } }
  });
  async function close() {
    upstream.closeAllConnections();
    if (upstream.listening) { const closed = once(upstream, 'close'); upstream.close(); await closed; }
    try { await app?.close(); }
    finally {
      try { await pool?.end(); }
      finally {
        try { if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`); }
        finally { await admin.end(); if (root) await rm(root, { recursive: true, force: true }); }
      }
    }
  }
  try {
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
    const address = upstream.address(); assert.ok(address && typeof address !== 'string');
    await admin.query(`CREATE SCHEMA ${schema}`); created = true;
    const url = new URL(databaseUrl); url.searchParams.set('options', `-c search_path=${schema},public`);
    pool = createPool(url.toString()); await migrate(pool);
    const password = 'Isolated-Chat-Access-Only!';
    const owner = await createUser(pool, { email: `${randomUUID()}@example.test`, name: 'Chat owner', password });
    const workspace = await createWorkspace(pool, owner.id, 'Scoped chat');
    root = await mkdtemp(join(tmpdir(), 'pm-chat-access-'));
    app = buildApp({ databaseUrl: url.toString(), ...await createBoundLocalStorage(pool, join(root, 'blobs')), coreWorkspaceRoot: join(root, 'core'), agentChat: { baseUrl: `http://127.0.0.1:${address.port}`, apiKey: '', model: 'boundary-provider', systemPrompt: 'Use authorized tools only', historyLimit: 40 } });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    async function login(email: string) {
      const response = await fetch(`${origin}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
      assert.equal(response.status, 200); const cookie = response.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie); await response.arrayBuffer(); return cookie;
    }
    const cookie = await login(owner.email);
    async function request(path: string, method = 'GET', body?: unknown, session = cookie, extra: Record<string, string> = {}) {
      return fetch(`${origin}${path}`, { method, headers: { cookie: session, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
    }
    const base = `/api/v1/workspaces/${workspace.id}`;
    async function seed(input: Record<string, string>) {
      const response = await request(`${base}/core/entities`, 'POST', input, cookie, { 'idempotency-key': randomUUID() });
      assert.equal(response.status, 200, await response.clone().text());
      return await response.json() as { id: string; revision: string };
    }
    const projectA = await seed({ entity: 'project', title: 'Private Alpha Marker', body: 'Private Alpha body' });
    const projectB = await seed({ entity: 'project', title: 'Project Beta', body: 'Public to the other scope' });
    async function thread(session = cookie) {
      const id = randomUUID(); const response = await request(`${base}/agent/threads`, 'POST', { id }, session); assert.equal(response.status, 200); await response.arrayBuffer(); return id;
    }
    const threadId = await thread();
    const client = new ProjectManagementClient({ baseUrl: origin, auth: { type: 'cookie', credentials: 'include', cookie: () => cookie } });
    async function access(id = threadId, session = cookie) {
      const response = await request(`${base}/agent/threads/${id}/access`, 'GET', undefined, session); assert.equal(response.status, 200); return await response.json() as AgentChatAccess;
    }
    async function enable(projectIds: string[], id = threadId, session = cookie) {
      const before = await access(id, session);
      const response = await request(`${base}/agent/threads/${id}/access`, 'PUT', { enabled: true, expectedRevision: before.revision, scope: { kind: 'projects', projectIds } }, session);
      assert.equal(response.status, 200, await response.clone().text()); return await response.json() as AgentChatAccess;
    }
    async function member(capabilities: string[], projectIds: string[]) {
      const user = await createUser(pool!, { email: `${randomUUID()}@example.test`, name: 'Scoped user', password });
      const response = await request(`${base}/commands`, 'POST', { commandId: randomUUID(), commandType: 'SetWorkspaceMember', payload: { userId: user.id, capabilities, projectIds } });
      assert.equal(response.status, 200, await response.clone().text()); await response.arrayBuffer();
      return { user, cookie: await login(user.email) };
    }
    async function messages(id = threadId, session = cookie) {
      const response = await request(`${base}/agent/threads/${id}`, 'GET', undefined, session); assert.equal(response.status, 200); return await response.json() as AgentChatThreadDetail;
    }
    return { pool, owner, workspace, projectA, projectB, base, origin, cookie, threadId, client, access, enable, seed, member, thread, request, messages, requests, setProvider(fn: typeof provider) { provider = fn; }, close };
  } catch (error) { await close(); throw error; }
}

async function collect(stream: AsyncIterable<AgentChatStreamEvent>) { const events = []; for await (const event of stream) events.push(event); return events; }

describe('Chat Full access boundaries and durable native tools', { skip: !databaseUrl, timeout: 300000 }, () => {
  it('persists disabled context with CAS without granting tools or refreshing an old grant', async t => {
    const f = await fixture(); t.after(f.close);
    const initial = await f.access();
    const save = await f.request(`${f.base}/agent/threads/${f.threadId}/access`, 'PUT', {
      enabled: false, expectedRevision: initial.revision, scope: { kind: 'projects', projectIds: [f.projectA.id] },
    });
    assert.equal(save.status, 200, await save.clone().text());
    const saved = await save.json() as AgentChatAccess;
    assert.equal(saved.revision, initial.revision + 1);
    assert.deepEqual(saved.scope, { kind: 'projects', projectIds: [f.projectA.id] });
    assert.equal(saved.enabled, false); assert.equal(saved.grantId, null); assert.equal(saved.expiresAt, null);
    assert.equal(saved.tools.some(item => item.allowed), false);
    assert.deepEqual(await f.access(), saved, 'A fresh read must retain disabled context');
    assert.equal(f.requests.length, 0, 'Saving context never contacts the provider');
    const stale = await f.request(`${f.base}/agent/threads/${f.threadId}/access`, 'PUT', {
      enabled: false, expectedRevision: initial.revision, scope: { kind: 'projects', projectIds: [f.projectB.id] },
    });
    assert.equal(stale.status, 409); await stale.arrayBuffer();
    assert.deepEqual(await f.access(), saved, 'A stale context save cannot change scope or access');
    const enabled = await f.enable(saved.scope.projectIds);
    assert.equal(enabled.enabled, true);
    const replace = await f.request(`${f.base}/agent/threads/${f.threadId}/access`, 'PUT', {
      enabled: false, expectedRevision: enabled.revision, scope: { kind: 'projects', projectIds: [f.projectB.id] },
    });
    assert.equal(replace.status, 200, await replace.clone().text());
    const disabled = await replace.json() as AgentChatAccess;
    assert.deepEqual(disabled.scope, { kind: 'projects', projectIds: [f.projectB.id] });
    assert.equal(disabled.enabled, false); assert.equal(disabled.tools.some(item => item.allowed), false);
    assert.equal(disabled.grantId, enabled.grantId, 'A disabled context save must not issue a grant');
    assert.equal(disabled.expiresAt, enabled.expiresAt, 'A disabled context save must not renew expiry');
    assert.ok(disabled.revokedAt);
    const stored = await f.pool.query<{ access_enabled: boolean; access_scope: unknown }>('SELECT access_enabled,access_scope FROM agent_chat_threads WHERE id=$1', [f.threadId]);
    assert.equal(stored.rows[0]?.access_enabled, false); assert.deepEqual(stored.rows[0]?.access_scope, disabled.scope);
    f.setProvider(body => { assert.equal(body.tools?.length ?? 0, 0, 'Disabled saved context must not offer tools'); return answer('Chat only.'); });
    assert.equal((await collect(f.client.streamAgentMessage(f.workspace.id, f.threadId, { messageId: randomUUID(), content: 'Keep tools disabled.' }))).at(-1)?.type, 'done');
    assert.equal((await f.access()).enabled, false);
    const workspaceThread = await f.thread();
    const workspaceInitial = await f.access(workspaceThread);
    const workspaceSave = await f.request(`${f.base}/agent/threads/${workspaceThread}/access`, 'PUT', {
      enabled: false, expectedRevision: workspaceInitial.revision, scope: { kind: 'workspace', projectIds: [] },
    });
    assert.equal(workspaceSave.status, 200, await workspaceSave.clone().text());
    const workspaceContext = await workspaceSave.json() as AgentChatAccess;
    assert.equal(workspaceContext.scope.kind, 'workspace');
    assert.deepEqual([...workspaceContext.scope.projectIds].sort(), [f.projectA.id, f.projectB.id].sort());
    assert.equal(workspaceContext.enabled, false); assert.equal(workspaceContext.grantId, null);
    assert.equal(workspaceContext.tools.some(item => item.allowed), false);
    const later = await f.seed({ entity: 'project', title: 'Later disabled context project', body: 'Not silently included' });
    const refreshed = await f.access(workspaceThread);
    assert.deepEqual(refreshed.scope, workspaceContext.scope);
    assert.equal(refreshed.scope.projectIds.includes(later.id), false);
  });

  it('checks native project/workspace ACL and private thread ownership on disabled scope saves', async t => {
    const f = await fixture(); t.after(f.close);
    const reader = await f.member(['domain.read'], [f.projectA.id]);
    const id = await f.thread(reader.cookie);
    const initial = await f.access(id, reader.cookie);
    const save = await f.request(`${f.base}/agent/threads/${id}/access`, 'PUT', {
      enabled: false, expectedRevision: initial.revision, scope: { kind: 'projects', projectIds: [f.projectA.id] },
    }, reader.cookie);
    assert.equal(save.status, 200, await save.clone().text());
    const saved = await save.json() as AgentChatAccess;
    assert.equal(saved.enabled, false); assert.equal(saved.tools.some(item => item.allowed), false);
    for (const scope of [{ kind: 'projects', projectIds: [f.projectB.id] }, { kind: 'workspace', projectIds: [] }]) {
      const denied = await f.request(`${f.base}/agent/threads/${id}/access`, 'PUT', { enabled: false, expectedRevision: saved.revision, scope }, reader.cookie);
      assert.equal(denied.status, 404); await denied.arrayBuffer();
      assert.deepEqual(await f.access(id, reader.cookie), saved, 'A denied save leaves the existing context intact');
    }
    const privateThread = await f.request(`${f.base}/agent/threads/${f.threadId}/access`, 'PUT', {
      enabled: false, expectedRevision: 0, scope: { kind: 'projects', projectIds: [f.projectA.id] },
    }, reader.cookie);
    assert.equal(privateThread.status, 404); await privateThread.arrayBuffer();
    const otherWorkspace = await createWorkspace(f.pool, f.owner.id, 'Separate workspace');
    const wrongWorkspace = await f.request(`/api/v1/workspaces/${otherWorkspace.id}/agent/threads/${f.threadId}/access`, 'PUT', {
      enabled: false, expectedRevision: 0, scope: { kind: 'projects', projectIds: [f.projectA.id] },
    });
    assert.equal(wrongWorkspace.status, 404); await wrongWorkspace.arrayBuffer();
    const changed = await f.request(`${f.base}/commands`, 'POST', {
      commandId: randomUUID(), commandType: 'SetWorkspaceMember', expectedVersions: { [reader.user.id]: 1 },
      payload: { userId: reader.user.id, capabilities: ['domain.read'], projectIds: [f.projectB.id] },
    });
    assert.equal(changed.status, 200); await changed.arrayBuffer();
    const revokedProject = await f.request(`${f.base}/agent/threads/${id}/access`, 'PUT', {
      enabled: false, expectedRevision: saved.revision, scope: { kind: 'projects', projectIds: [f.projectA.id] },
    }, reader.cookie);
    assert.equal(revokedProject.status, 404); await revokedProject.arrayBuffer();
    const current = await f.access(id, reader.cookie);
    assert.equal(current.enabled, false); assert.deepEqual(current.scope.projectIds, []);
    assert.equal(current.revision, saved.revision, 'Native ACL failure does not consume the access revision');
  });

  it('requires explicit CAS authorization, freezes workspace projects and excludes expired grants', async t => {
    const f = await fixture(); t.after(f.close);
    const initial = await f.access(); assert.equal(initial.enabled, false); assert.equal(initial.tools.some(item => item.allowed), false);
    const enabled = await f.enable([f.projectA.id]);
    assert.equal(enabled.tools.find(item => item.name === 'pm_create_task')?.allowed, true);
    assert.equal(enabled.tools.find(item => item.name === 'pm_create_project')?.allowed, false);
    const stale = await f.request(`${f.base}/agent/threads/${f.threadId}/access`, 'PUT', { enabled: false, expectedRevision: initial.revision });
    assert.equal(stale.status, 409); await stale.arrayBuffer(); assert.equal((await f.access()).enabled, true);
    await f.pool.query("UPDATE agent_chat_threads SET access_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [f.threadId]);
    const expired = await f.access(); assert.equal(expired.enabled, false); assert.equal(expired.tools.some(item => item.allowed), false);
    const workspaceGrant = await f.request(`${f.base}/agent/threads/${f.threadId}/access`, 'PUT', { enabled: true, expectedRevision: enabled.revision, scope: { kind: 'workspace', projectIds: [] } });
    assert.equal(workspaceGrant.status, 200); await workspaceGrant.arrayBuffer();
    const later = await f.seed({ entity: 'project', title: 'Later project', body: 'Not part of the frozen grant' });
    assert.equal((await f.access()).scope.projectIds.includes(later.id), false);
    const reader = await f.member(['domain.read'], [f.projectA.id]);
    const readerThread = await f.thread(reader.cookie);
    const readerAccess = await f.enable([f.projectA.id], readerThread, reader.cookie);
    assert.equal(readerAccess.tools.find(item => item.name === 'pm_read')?.allowed, true);
    assert.equal(readerAccess.tools.some(item => item.write && item.allowed), false);
    const wrongProject = await f.request(`${f.base}/agent/threads/${readerThread}/access`, 'PUT', { enabled: true, expectedRevision: readerAccess.revision, scope: { kind: 'projects', projectIds: [f.projectB.id] } }, reader.cookie);
    assert.equal(wrongProject.status, 404); await wrongProject.arrayBuffer();
    const privateThread = await f.request(`${f.base}/agent/threads/${f.threadId}`, 'GET', undefined, reader.cookie);
    assert.equal(privateThread.status, 404); await privateThread.arrayBuffer();
  });

  it('persists one native creation for repeated model calls and recovers only its original receipt', async t => {
    const f = await fixture(); t.after(f.close); await f.enable([f.projectA.id]);
    const args = { projectId: f.projectA.id, title: 'One durable agent task', description: 'Created through the native tool', assigneeId: null, priority: null, startDate: null, dueDate: null, labels: null };
    let turn = 0;
    f.setProvider(() => ++turn <= 2 ? tool(`create_${turn}`, 'pm_create_task', args) : answer('The native tool confirmed creation.'));
    const messageId = randomUUID();
    const events = await collect(f.client.streamAgentMessage(f.workspace.id, f.threadId, { messageId, content: 'Create the task once.' }));
    assert.equal(events.at(-1)?.type, 'done', JSON.stringify(events.at(-1)));
    const last = (await f.messages()).messages.at(-1)!;
    assert.equal(last.toolCalls?.length, 1); assert.equal(last.toolCalls[0]?.status, 'succeeded');
    const result = last.toolCalls[0]?.result; assert.ok(result && result.kind === 'task'); assert.equal(result.items[0]?.title, args.title); assert.ok(result.receipt);
    const records = await f.request(`${f.base}/entities?kind=work_item&projectId=${f.projectA.id}`);
    assert.equal((await records.json() as { items: unknown[] }).items.length, 1);
    await f.pool.query("UPDATE agent_chat_tool_calls SET call=jsonb_set(jsonb_set(call,'{status}',to_jsonb('unknown'::text)),'{result}','null'::jsonb) WHERE operation_id=$1", [last.toolCalls[0]!.operationId]);
    const recovered = (await f.messages()).messages.at(-1)!;
    assert.equal(recovered.toolCalls?.[0]?.status, 'succeeded'); assert.equal(recovered.toolCalls?.[0]?.result?.receipt?.commandId, result.receipt.commandId);
    assert.equal(turn, 3, 'Receipt reconciliation must not contact the model again');
    const duplicate = await f.request(`${f.base}/agent/threads/${f.threadId}/messages`, 'POST', { messageId, content: 'Create the task once.' });
    assert.equal(duplicate.status, 409); await duplicate.arrayBuffer(); assert.equal(turn, 3);
  });

  it('revocation during model generation cancels before a pending tool can create a task', async t => {
    const f = await fixture(); t.after(f.close); const grant = await f.enable([f.projectA.id]);
    const arrived = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); t.after(() => release.resolve());
    f.setProvider(async () => { arrived.resolve(); await release.promise; return tool('late_create', 'pm_create_task', { projectId: f.projectA.id, title: 'Must not exist', description: '', assigneeId: null, priority: null, startDate: null, dueDate: null, labels: null }); });
    const completed = collect(f.client.streamAgentMessage(f.workspace.id, f.threadId, { messageId: randomUUID(), content: 'Create after authorization check.' }));
    await arrived.promise;
    const revoke = await f.request(`${f.base}/agent/threads/${f.threadId}/access`, 'PUT', { enabled: false, expectedRevision: grant.revision });
    assert.equal(revoke.status, 200); await revoke.arrayBuffer(); release.resolve();
    assert.equal((await completed).at(-1)?.type, 'cancelled');
    const records = await f.request(`${f.base}/entities?kind=work_item&projectId=${f.projectA.id}`);
    assert.equal((await records.json() as { items: unknown[] }).items.length, 0);
  });

  it('does not expose or replay old project context after the delegator loses that project', async t => {
    const f = await fixture(); t.after(f.close);
    const member = await f.member(['domain.read', 'planning.edit'], [f.projectA.id, f.projectB.id]);
    const id = await f.thread(member.cookie); await f.enable([f.projectA.id], id, member.cookie);
    let turn = 0;
    f.setProvider(() => ++turn === 1 ? tool('read_private', 'pm_read', { id: f.projectA.id, bodyOffset: 0, bodyLimit: 1000 }) : answer(turn === 2 ? 'Private Alpha Marker is the actual authorized project.' : 'Now using only current context.'));
    const client = new ProjectManagementClient({ baseUrl: f.origin, auth: { type: 'cookie', credentials: 'include', cookie: () => member.cookie } });
    assert.equal((await collect(client.streamAgentMessage(f.workspace.id, id, { messageId: randomUUID(), content: 'Read my selected project.' }))).at(-1)?.type, 'done');
    const changed = await f.request(`${f.base}/commands`, 'POST', { commandId: randomUUID(), commandType: 'SetWorkspaceMember', expectedVersions: { [member.user.id]: 1 }, payload: { userId: member.user.id, capabilities: ['domain.read', 'planning.edit'], projectIds: [f.projectB.id] } });
    assert.equal(changed.status, 200); await changed.arrayBuffer();
    assert.equal(JSON.stringify(await f.messages(id, member.cookie)).includes('Private Alpha Marker'), false);
    await f.enable([f.projectB.id], id, member.cookie);
    await collect(client.streamAgentMessage(f.workspace.id, id, { messageId: randomUUID(), content: 'Explain your current scope.' }));
    assert.equal(JSON.stringify(f.requests.at(-1)?.messages).includes('Private Alpha Marker'), false);
  });

  it('rechecks source authorization before sending the next model round', async t => {
    const f = await fixture(); t.after(f.close);
    const member = await f.member(['domain.read'], [f.projectA.id, f.projectB.id]);
    const id = await f.thread(member.cookie); await f.enable([f.projectA.id, f.projectB.id], id, member.cookie);
    // Deterministically revoke the read project after its tool receipt is saved,
    // before the next provider request; no timing sleeps or mocked ACL checks.
    await f.pool.query(`CREATE FUNCTION revoke_read_project() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.call->>'name'='pm_read' AND NEW.call->>'status'='succeeded' THEN
          UPDATE memberships SET project_ids=array_remove(project_ids,NEW.call->'arguments'->>'id'),version=version+1
            WHERE workspace_id=(SELECT workspace_id FROM agent_chat_threads WHERE id=NEW.thread_id)
              AND user_id=(NEW.call->>'onBehalfOf')::uuid;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER revoke_after_tool AFTER UPDATE ON agent_chat_tool_calls FOR EACH ROW EXECUTE FUNCTION revoke_read_project()`);
    f.setProvider(() => f.requests.length === 1 ? tool('read_then_revoke', 'pm_read', { id: f.projectA.id, bodyOffset: 0, bodyLimit: 1000 }) : answer('This request must not receive revoked context.'));
    const client = new ProjectManagementClient({ baseUrl: f.origin, auth: { type: 'cookie', credentials: 'include', cookie: () => member.cookie } });
    const events = await collect(client.streamAgentMessage(f.workspace.id, id, { messageId: randomUUID(), content: 'Read the selected project.' }));
    assert.ok(events.some(event => event.type === 'error' && event.code === 'agent_context_access_changed'));
    assert.equal(f.requests.length, 1, 'Revoked tool output must never reach another provider request');
  });

  it('reports a native version conflict as rejected rather than an unknowable side effect', async t => {
    const f = await fixture(); t.after(f.close); await f.enable([f.projectA.id]);
    f.setProvider(() => f.requests.length === 1
      ? tool('stale_update', 'pm_update_project', { id: f.projectA.id, revision: '0'.repeat(64), title: 'Must not overwrite', goal: null, description: null, startDate: null, dueDate: null })
      : answer('The version conflict prevented the update.'));
    const events = await collect(f.client.streamAgentMessage(f.workspace.id, f.threadId, { messageId: randomUUID(), content: 'Try an ordinary title update.' }));
    assert.equal(events.at(-1)?.type, 'done');
    const call = (await f.messages()).messages.at(-1)?.toolCalls?.[0];
    assert.equal(call?.status, 'failed');
    assert.equal(call?.result, null);
    await f.pool.query("UPDATE agent_chat_tool_calls SET call=jsonb_set(call,'{status}',to_jsonb('unknown'::text)) WHERE operation_id=$1", [call!.operationId]);
    const recovered = (await f.messages()).messages.at(-1)?.toolCalls?.[0];
    assert.equal(recovered?.status, 'failed');
    assert.equal(recovered?.error?.code, 'agent_tool_recovered_rejection');
    assert.equal(f.requests.length, 2);
    const records = await f.request(`${f.base}/entities?kind=project`);
    assert.equal((await records.json() as { items: { id: string; data: { name: string } }[] }).items.find(item => item.id === f.projectA.id)?.data.name, 'Private Alpha Marker');
  });
});
