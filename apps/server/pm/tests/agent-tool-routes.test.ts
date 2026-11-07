import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { DomainError, type Capability } from '../../../../packages/domain/src/core.ts';
import { Workspace, WorkspaceError } from '../../../../packages/pm-core/index.ts';
import type { PmToolTarget } from '../../../../packages/agent-contracts/src/pm-tools.ts';
import { createMcpServiceBearer, type McpInvocationIdentity } from '../../../../packages/infrastructure/src/mcp-service-auth.ts';
import { createAgentChatTools } from '../src/agent-chat-tools.ts';
import type { CoreWorkspacePool } from '../src/core-routes.ts';
import { registerAgentToolRoutes } from '../src/agent-tool-routes.ts';

const workspaceId = '0196c319-8b1d-7000-8000-000000000001';
const otherWorkspaceId = '0196c319-8b1d-7000-8000-000000000002';
const actor = { id: '0196c319-8b1d-7000-8000-000000000010', email: 'fixture@example.invalid', name: 'Fixture' };
type Operation = {
  operation_id: string; workspace_id: string; actor_id: string; request_hash: string; name: string;
  thread_id: string; message_id: string; generation_id: string; status: string;
  result: unknown; error: unknown; created_at: Date; finished_at: Date | null;
};

async function fixture() {
  const base = await mkdtemp(path.join(tmpdir(), 'pm-agent-targets-'));
  const workspace = new Workspace(path.join(base, 'workspace'));
  await workspace.init();
  const project = await workspace.createEntity({ entity: 'project', title: 'Alpha' }, 'alpha');
  const other = await workspace.createEntity({ entity: 'project', title: 'Beta' }, 'beta');
  const task = await workspace.createEntity({ entity: 'work_item', project: project.id, title: 'Alpha task' }, 'alpha-task');
  const otherTask = await workspace.createEntity({ entity: 'work_item', project: other.id, title: 'Beta task' }, 'beta-task');
  let projectIds: string[] | null = null;
  let capabilities: Capability[] = ['domain.read', 'planning.edit', 'planning.lifecycle'];
  let membershipReads = 0, workspaceReads = 0;
  let authenticated = true;
  const operations = new Map<string, Operation>();
  let historyHead = 0;
  const query = async (text: string, values: unknown[] = []) => {
    if (text.includes('SELECT m.* FROM memberships')) {
      membershipReads++;
      return { rows: [{ user_id: actor.id, workspace_id: workspaceId, capabilities, project_ids: projectIds, version: 1, revoked_at: null }], rowCount: 1 };
    }
    if (text.includes('FROM users')) return { rows: [actor], rowCount: 1 };
    if (text.startsWith('SELECT * FROM pm_agent_tool_operations')) {
      const row = operations.get(String(values[0]));
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (text.startsWith('INSERT INTO pm_agent_tool_operations')) {
      const id = String(values[0]);
      if (operations.has(id)) return { rows: [], rowCount: 0 };
      const row: Operation = { operation_id: id, workspace_id: String(values[1]), actor_id: String(values[2]), request_hash: String(values[3]), name: String(values[4]),
        thread_id: String(values[5]), message_id: String(values[6]), generation_id: String(values[7]), status: 'running', result: null, error: null, created_at: new Date(), finished_at: null };
      operations.set(id, row);
      return { rows: [row], rowCount: 1 };
    }
    if (text.startsWith('UPDATE pm_agent_tool_operations')) {
      const row = operations.get(String(values[0]));
      if (!row || !['running', 'unknown'].includes(row.status)) return { rows: [], rowCount: 0 };
      row.status = String(values[1]);
      row.result = values[2] === null ? null : JSON.parse(String(values[2]));
      row.error = values[3] === null ? null : JSON.parse(String(values[3]));
      row.finished_at = ['succeeded', 'failed'].includes(row.status) ? new Date() : null;
      return { rows: [row], rowCount: 1 };
    }
    if (text.includes('UPDATE workspaces SET service_fact_head')) return { rows: [{ sequence: '1' }], rowCount: 1 };
    if (text.includes('UPDATE workspaces SET change_history_head')) return { rows: [{ head: String(++historyHead) }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  const database = { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Pool;
  const coreWorkspaces = { get: async () => { workspaceReads++; await workspace.rescan(); return workspace; }, rootFor: () => workspace.root } as unknown as CoreWorkspacePool;
  const tools = createAgentChatTools({ database: () => database, coreWorkspaces,
    executeCommand: async () => { throw new Error('This fixture uses native core mutations, not command creation'); },
    readCommandReceipt: async () => null,
    readComments: async () => { throw new Error('This fixture does not read comments'); },
    localProjects: { enabled: false, defaultParent: null } });
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof z.ZodError ? 400 : error instanceof DomainError || error instanceof WorkspaceError ? error.status : 500)
    .send({ error: { code: error instanceof DomainError ? error.code : 'invalid_request', message: error instanceof Error ? error.message : 'Unknown error' } }));
  registerAgentToolRoutes(app, { database: () => database, actor: async () => {
    if (!authenticated) throw new DomainError('unauthenticated', 'PM login is required', 401);
    return actor;
  }, coreWorkspaces, tools });
  const target = (projectId: string | null = project.id): PmToolTarget => ({ workspaceId, projectId });
  const request = (name: string, args: unknown, selected = target(), operationId = randomUUID()) => ({
    name, arguments: args, target: selected, operationId, threadId: 'independent-code-session', messageId: 'message', generationId: 'generation',
  });
  const call = (input: unknown, action = 'call') => app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspaceId}/agent-tools/${action}`, headers: { 'content-type': 'application/json' }, payload: JSON.stringify(input) });
  return { app, workspace, project, other, task, otherTask, tools, target, request, call, operations,
    allow: (projects: string[] | null, caps: Capability[] = capabilities) => { projectIds = projects; capabilities = caps; },
    authenticate: (value: boolean) => { authenticated = value; },
    reads: () => ({ membershipReads, workspaceReads }),
    close: async () => { await app.close(); await workspace.close(); await rm(base, { recursive: true, force: true }); } };
}

test('global native catalog is authenticated schema-only discovery with explicit target envelopes', async () => {
  const f = await fixture();
  try {
    const response = await f.app.inject({ method: 'GET', url: '/api/v1/agent-tools' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'private, no-store');
    assert.deepEqual(f.reads(), { membershipReads: 0, workspaceReads: 0 });
    const tools = response.json().tools;
    assert.ok(tools.length > 0);
    for (const tool of tools) {
      assert.deepEqual(tool.inputSchema.required, ['target', 'arguments']);
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.deepEqual(Object.keys(tool.inputSchema.properties), ['target', 'arguments']);
      assert.equal('workspaceId' in tool, false);
      assert.equal('path' in tool, false);
    }
    const workspaceCatalog = await f.app.inject({ method: 'GET', url: `/api/v1/workspaces/${workspaceId}/agent-tools` });
    assert.equal(workspaceCatalog.statusCode, 200);
    assert.deepEqual(workspaceCatalog.json().tools[0].inputSchema, tools[0].inputSchema);
    f.authenticate(false);
    assert.equal((await f.app.inject({ method: 'GET', url: '/api/v1/agent-tools' })).statusCode, 401);
  } finally { await f.close(); }
});

test('one independent session queries multiple explicit targets and never inherits an implicit project', async () => {
  const f = await fixture();
  const args = { entity: 'work_item', projectId: null, query: null, after: null, limit: 20 };
  try {
    for (const [project, task] of [[f.project, f.task], [f.other, f.otherTask]]) {
      const response = await f.call(f.request('pm_query', args, f.target(project!.id)));
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().status, 'succeeded');
      assert.deepEqual(response.json().target, f.target(project!.id));
      assert.equal(response.json().actorId, actor.id);
      assert.deepEqual(response.json().result.items.map((item: { id: string }) => item.id), [task!.id]);
    }
    const foreignRead = await f.call(f.request('pm_read', { id: f.otherTask.id, bodyOffset: 0, bodyLimit: 1000 }));
    assert.equal(foreignRead.json().status, 'failed');
    assert.equal(foreignRead.json().error.code, 'not_found_or_forbidden');
    const mismatched = await f.call(f.request('pm_query', args, { ...f.target(), workspaceId: otherWorkspaceId }));
    assert.equal(mismatched.statusCode, 400);
    assert.equal(mismatched.json().error.code, 'agent_tool_target_mismatch');
    const legacy = { ...f.request('pm_query', args), target: undefined, scope: { kind: 'projects', projectIds: [f.project.id] } };
    assert.equal((await f.call(legacy)).statusCode, 400);
    f.allow([f.project.id]);
    assert.equal((await f.call(f.request('pm_query', args, f.target(null)))).statusCode, 404);
    assert.equal((await f.call(f.request('pm_query', args, f.target(f.other.id)))).statusCode, 404);
    const allowed = await f.call(f.request('pm_read', { id: f.task.id, bodyOffset: 0, bodyLimit: 1000 }));
    assert.equal(allowed.json().status, 'succeeded');
    f.allow([]);
    assert.equal((await f.call(f.request('pm_read', { id: f.task.id, bodyOffset: 0, bodyLimit: 1000 }))).statusCode, 404);
  } finally { await f.close(); }
});

test('targeted native writes retain exact revision CAS and operation identity', async () => {
  const f = await fixture();
  try {
    const stale = await f.call(f.request('pm_archive_task', { id: f.task.id, revision: 'a'.repeat(64) }));
    assert.equal(stale.json().status, 'failed');
    assert.equal(f.workspace.get(f.task.id).revision, f.task.revision);
    const input = f.request('pm_archive_task', { id: f.task.id, revision: f.task.revision });
    const response = await f.call(input);
    assert.equal(response.json().status, 'succeeded');
    assert.equal(response.json().result.receipt.targetId, f.task.id);
    assert.equal(f.workspace.get(f.task.id).entity.archived, true);
    const current = f.workspace.get(f.task.id).revision;
    const repeated = await f.call(input);
    assert.equal(repeated.json().status, 'succeeded');
    assert.equal(f.workspace.get(f.task.id).revision, current);
    const forged = await f.call({ ...input, target: f.target(f.other.id) }, 'result');
    assert.equal(forged.statusCode, 409);
    assert.equal(forged.json().error.code, 'agent_tool_identity_conflict');
  } finally { await f.close(); }
});

test('unknown committed writes reconcile their original receipt without native redispatch', async () => {
  const f = await fixture();
  const execute = f.tools.execute;
  let dispatched = 0;
  f.tools.execute = async (name, input, context) => { dispatched++; await execute(name, input, context); throw new Error('Lost response after native commit'); };
  try {
    const input = f.request('pm_archive_task', { id: f.task.id, revision: f.task.revision });
    const response = await f.call(input);
    assert.equal(response.json().status, 'unknown');
    const committed = f.workspace.get(f.task.id).revision;
    const recovered = await f.call(input, 'result');
    assert.equal(recovered.json().status, 'succeeded');
    assert.deepEqual(recovered.json().target, input.target);
    assert.equal(recovered.json().result.receipt.revision, committed);
    assert.equal((await f.call(input)).json().status, 'succeeded');
    assert.equal(dispatched, 1);
    assert.equal(f.workspace.get(f.task.id).revision, committed);
    f.allow([]);
    assert.equal((await f.call(input, 'result')).statusCode, 404);
    assert.equal(dispatched, 1);
  } finally { await f.close(); }
});

test('unproven writes stay unknown across call and result retries instead of replaying', async () => {
  const f = await fixture();
  let dispatched = 0;
  f.tools.execute = async () => { dispatched++; throw new Error('No durable outcome is available'); };
  try {
    const input = f.request('pm_archive_task', { id: f.task.id, revision: f.task.revision });
    for (const action of ['call', 'call', 'result']) {
      const response = await f.call(input, action);
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().status, 'unknown');
    }
    assert.equal(dispatched, 1);
    assert.equal(f.workspace.get(f.task.id).revision, f.task.revision);
    assert.equal(f.workspace.get(f.task.id).entity.archived, false);
  } finally { await f.close(); }
});

test('delegated catalogs and calls apply the live explicit target ceiling on every request', async t => {
  const oldSecret = process.env.PM_AUTOMATION_SERVICE_SECRET, oldUrl = process.env.PM_MCP_AGENT_URL;
  process.env.PM_AUTOMATION_SERVICE_SECRET = 'test-only-native-target-secret'.repeat(4);
  process.env.PM_MCP_AGENT_URL = 'http://127.0.0.1:4123';
  const f = await fixture();
  let grant: McpInvocationIdentity = { grantId: randomUUID(), actorId: actor.id, scope: f.target(), access: 'read-only', threadIds: ['independent-code-session'], version: 1 };
  t.mock.method(globalThis, 'fetch', async () => Response.json(grant));
  const headers = () => ({ authorization: `Bearer ${createMcpServiceBearer(grant)}` });
  try {
    const readOnly = await f.app.inject({ method: 'GET', url: '/api/v1/agent-tools', headers: headers() });
    assert.equal(readOnly.statusCode, 200);
    assert.ok(readOnly.json().tools.every((tool: { write: boolean }) => !tool.write));
    grant = { ...grant, access: 'full' };
    const full = await f.app.inject({ method: 'GET', url: '/api/v1/agent-tools', headers: headers() });
    assert.equal(full.statusCode, 200);
    assert.ok(full.json().tools.some((tool: { write: boolean }) => tool.write));
    assert.equal(full.json().tools.some((tool: { name: string }) => tool.name === 'pm_create_project'), false);
    const input = f.request('pm_read', { id: f.task.id, bodyOffset: 0, bodyLimit: 1000 });
    const url = `/api/v1/workspaces/${workspaceId}/agent-tools/call`;
    for (const target of [f.target(null), f.target(f.other.id), { ...f.target(), workspaceId: otherWorkspaceId }]) {
      const forged = await f.app.inject({ method: 'POST', url, headers: headers(), payload: { ...input, target } });
      assert.equal(forged.statusCode, 403);
      assert.equal(forged.json().error.code, 'mcp_scope_forbidden');
    }
    assert.equal(f.operations.size, 0);
    const delegatedHeaders = headers();
    const result = await f.app.inject({ method: 'POST', url, headers: delegatedHeaders, payload: input });
    assert.equal(result.json().status, 'succeeded');
    grant = { ...grant, threadIds: [] };
    const revoked = await f.app.inject({ method: 'POST', url: url.replace('/call', '/result'), headers: delegatedHeaders, payload: input });
    assert.equal(revoked.statusCode, 403);
    assert.equal(revoked.json().error.code, 'mcp_scope_forbidden');
  } finally {
    await f.close();
    if (oldSecret === undefined) delete process.env.PM_AUTOMATION_SERVICE_SECRET; else process.env.PM_AUTOMATION_SERVICE_SECRET = oldSecret;
    if (oldUrl === undefined) delete process.env.PM_MCP_AGENT_URL; else process.env.PM_MCP_AGENT_URL = oldUrl;
  }
});
