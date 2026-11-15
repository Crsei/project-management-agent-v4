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
import type { PmToolTarget, PmToolApprovalAuthority } from '../../../../packages/agent-contracts/src/pm-tools.ts';
import { pmToolRequestHash } from '../../../../packages/infrastructure/src/pm-tool-service-auth.ts';
import type { MigrationPlan } from '../../../../packages/pm-core/migrations.ts';
import { requestHash } from '../../../../packages/application/src/kernel.ts';
import { workflowFor } from '../../../../packages/pm-schema/index.ts';
import { createMcpServiceBearer, type McpInvocationIdentity } from '../../../../packages/infrastructure/src/mcp-service-auth.ts';
import { createAgentChatTools } from '../src/agent-chat-tools.ts';
import type { CoreWorkspacePool } from '../src/core-routes.ts';
import { registerAgentToolRoutes } from '../src/agent-tool-routes.ts';

const workspaceId = '0196c319-8b1d-7000-8000-000000000001';
const otherWorkspaceId = '0196c319-8b1d-7000-8000-000000000002';
const actor = { id: '0196c319-8b1d-7000-8000-000000000010', email: 'fixture@example.invalid', name: 'Fixture' };
const PM_TOOL_APPROVAL_AUTHORITY_HEADER = 'x-pm-approval-authority';
type Operation = {
  operation_id: string; workspace_id: string; actor_id: string; request_hash: string; name: string;
  thread_id: string; message_id: string; generation_id: string; status: string;
  result: unknown; error: unknown; created_at: Date; finished_at: Date | null;
  target: unknown; recovery_identity: unknown; linkage: unknown; delegation_id: string | null; outcome_evidence: unknown;
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
        thread_id: String(values[5]), message_id: String(values[6]), generation_id: String(values[7]), status: 'running', result: null, error: null, created_at: new Date(), finished_at: null,
        target: JSON.parse(String(values[8])), recovery_identity: values[9] === null ? null : JSON.parse(String(values[9])),
        linkage: values[10] === null ? null : JSON.parse(String(values[10])), delegation_id: values[11] === null ? null : String(values[11]), outcome_evidence: null };
      operations.set(id, row);
      return { rows: [row], rowCount: 1 };
    }
    if (text.startsWith('UPDATE pm_agent_tool_operations')) {
      const row = operations.get(String(values[0]));
      if (!row || !['running', 'unknown'].includes(row.status)) return { rows: [], rowCount: 0 };
      row.status = String(values[1]);
      row.result = values[2] === null ? null : JSON.parse(String(values[2]));
      row.error = values[3] === null ? null : JSON.parse(String(values[3]));
      row.outcome_evidence = values[4];
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
  const call = (input: unknown, action = 'call', extraHeaders: Record<string, string> = {}) => app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspaceId}/agent-tools/${action}`, headers: { 'content-type': 'application/json', ...extraHeaders }, payload: JSON.stringify(input) });
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

test('invalid query pagination never executes and corrected new reads paginate the real authorized collection', async () => {
  const f = await fixture();
  let executions = 0;
  const execute = f.tools.execute;
  f.tools.execute = async (...args) => { executions++; return execute(...args); };
  try {
    for (let index = 0; index < 20; index++) {
      await f.workspace.createEntity({ entity: 'work_item', project: f.project.id, title: `Page task ${index}` }, `page-task-${index}`);
    }
    const args = { entity: 'work_item', projectId: null, query: null, after: null, limit: 100 };
    const invalid = f.request('pm_query', args);
    const rejected = await f.call(invalid);
    assert.equal(rejected.statusCode, 400);
    assert.equal(rejected.json().error.code, 'agent_tool_invalid_input');
    assert.match(rejected.json().error.message, /limit: must be at most 20/);
    assert.equal(executions, 0);
    assert.equal(f.operations.has(invalid.operationId), false, 'frontloaded validation never reserves an executing PM operation');
    const first = f.request('pm_query', { ...args, limit: 20 });
    const response = await f.call(first);
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, 'succeeded');
    const page = response.json().result;
    assert.equal(page.items.length, 20);
    assert.equal(page.truncated, true);
    assert.equal(page.nextCursor, page.items.at(-1).id);
    const continued = await f.call(f.request('pm_query', { ...args, limit: 20, after: page.nextCursor }));
    assert.equal(continued.json().status, 'succeeded');
    assert.equal(continued.json().result.items.length, 1);
    assert.equal(continued.json().result.nextCursor, null);
    const ids = [...page.items, ...continued.json().result.items].map((item: { id: string }) => item.id);
    assert.equal(new Set(ids).size, 21);
    assert.equal(executions, 2);
    const forged = await f.call({ ...first, arguments: { ...args, limit: 20, after: page.nextCursor } }, 'result');
    assert.equal(forged.statusCode, 409);
    assert.equal(forged.json().error.code, 'agent_tool_identity_conflict');
    assert.equal(executions, 2);
  } finally { await f.close(); }
});

test('exact approval authority is read-only and uses current from/to workflow categories and source revisions', async () => {
  const f = await fixture();
  try {
    f.allow([f.project.id], ['domain.read', 'planning.edit', 'workitem.complete', 'workitem.cancel_reopen']);
    const input = f.request('pm_transition_task', { id: f.task.id, revision: f.task.revision, status: 'done' });
    const first = await f.call(input, 'approval-authority');
    assert.equal(first.statusCode, 200);
    assert.equal(first.headers['cache-control'], 'private, no-store');
    const original = first.json<PmToolApprovalAuthority>();
    assert.deepEqual(original.capabilities, ['domain.read', 'workitem.complete']);
    assert.equal(original.requestHash, pmToolRequestHash(input, actor.id));
    assert.equal(original.entity?.revision, f.task.revision);
    assert.equal(original.configuration?.revision, 'absent');
    const workflow = await f.tools.execute('pm_read_workflow', { projectId: f.project.id }, {
      actor, workspaceId, threadId: input.threadId, messageId: input.messageId, operationId: randomUUID(), scope: { kind: 'projects', projectIds: [f.project.id] },
    });
    assert.equal(workflow.kind, 'workflow');
    if (workflow.kind === 'workflow') assert.equal(original.configuration?.workflowRevision, workflow.workflow.configuration.workflowRevision);
    assert.equal(f.operations.size, 0, 'Authority reads never reserve an operation or issue a command');
    assert.equal(f.workspace.get(f.task.id).revision, f.task.revision);
    f.allow([f.project.id], ['domain.read', 'planning.edit', 'workitem.cancel_reopen']);
    assert.equal((await f.call(input, 'approval-authority')).statusCode, 403, 'Effective workitem.complete is checked, not just static domain.read');

    const configuration = f.workspace.configuration(), states = configuration.config.workflows.work_item!;
    states.states.find(state => state.id === 'done')!.category = 'started';
    delete states.default_targets;
    await f.workspace.saveConfiguration(configuration.config, configuration.revision);
    assert.equal(f.workspace.get(f.task.id).revision, f.task.revision, 'Workflow changes do not have to change the task revision');
    const changed = (await f.call(input, 'approval-authority')).json<PmToolApprovalAuthority>();
    assert.deepEqual(changed.capabilities, ['domain.read', 'planning.edit']);
    assert.notEqual(changed.fingerprint, original.fingerprint);
    assert.notEqual(changed.configuration?.workflowRevision, original.configuration?.workflowRevision);
    assert.notEqual(changed.configuration?.revision, original.configuration?.revision);

    const from = f.workspace.configuration();
    from.config.workflows.work_item!.states.find(state => state.id === 'todo')!.category = 'completed';
    await f.workspace.saveConfiguration(from.config, from.revision);
    const reopened = (await f.call(input, 'approval-authority')).json<PmToolApprovalAuthority>();
    assert.deepEqual(reopened.capabilities, ['domain.read', 'workitem.cancel_reopen'], 'The current from-category matters even when the requested target is merely started');
    assert.notEqual(reopened.fingerprint, changed.fingerprint);
    assert.equal(f.operations.size, 0);
    assert.equal(f.workspace.get(f.task.id).raw, f.task.raw);
    const forged = await f.call({ ...input, arguments: { ...input.arguments as object, extra: 'unvalidated' } }, 'approval-authority');
    assert.equal(forged.statusCode, 400);
  } finally { await f.close(); }
});

test('exact approval authority preserves workspace-admin migration scope and native lifecycle permission', async () => {
  const f = await fixture();
  try {
    const plan = await f.workspace.migration('preview', { kind: 'transform', changes: [{ id: f.task.id, set: { status: 'in_progress' } }] }) as MigrationPlan;
    assert.deepEqual(plan.diagnostics, [], 'The original preview must be a valid native migration, not a rejected derived-title edit');
    const args = { id: plan.id, revision: plan.revision, after: null, limit: 20 };
    f.allow(null, ['domain.read', 'planning.lifecycle']);
    for (const name of ['pm_apply_migration', 'pm_restore_migration']) {
      const input = f.request(name, args, f.target(null));
      const response = await f.call(input, 'approval-authority');
      assert.equal(response.statusCode, 200);
      const authority = response.json<PmToolApprovalAuthority>();
      assert.deepEqual(authority.capabilities, ['domain.read', 'planning.lifecycle']);
      assert.deepEqual(authority.migration, { id: plan.id, revision: plan.revision });
      assert.equal(authority.entity, null);
      assert.equal((await f.call({ ...input, target: f.target() }, 'approval-authority')).statusCode, 403);
      const result = await f.call(input, 'call', { [PM_TOOL_APPROVAL_AUTHORITY_HEADER]: authority.fingerprint });
      assert.equal(result.json().status, 'succeeded', `${name}: ${JSON.stringify(result.json().error ?? null)}`);
      assert.equal(result.json().result.migration.status, name === 'pm_apply_migration' ? 'applied' : 'restored');
      assert.equal(f.workspace.get(f.task.id).entity.status, name === 'pm_apply_migration' ? 'in_progress' : 'todo');
    }
    assert.equal(f.workspace.get(f.task.id).raw, f.task.raw, 'Only the exact original apply/restore pair runs');
    f.allow(null, ['domain.read']);
    assert.equal((await f.call(f.request('pm_apply_migration', args, f.target(null)), 'approval-authority')).statusCode, 403);
    f.allow([f.project.id], ['domain.read', 'planning.lifecycle']);
    assert.equal((await f.call(f.request('pm_apply_migration', args, f.target(null)), 'approval-authority')).statusCode, 404);
  } finally { await f.close(); }
});

test('exact approval authority blocks a workflow mutation race after the final transaction authorization read', async () => {
  const f = await fixture();
  try {
    // Holding both old and new effective permissions proves the fingerprint is restrictive,
    // rather than accidentally relying on native permission denial after the semantic change.
    f.allow([f.project.id], ['domain.read', 'planning.edit', 'workitem.complete']);
    const input = f.request('pm_transition_task', { id: f.task.id, revision: f.task.revision, status: 'done' });
    // This header is deliberately untrusted restrictive input, derived from real native sources.
    // Keeping the race entry independent of the new query also reproduces the old mutation bug.
    const configuration = f.workspace.configuration();
    const facts = { capabilities: ['domain.read', 'workitem.complete'],
      entity: { id: f.task.id, kind: f.task.entity.entity, revision: f.task.revision, status: f.task.entity.status ?? null, archived: f.task.entity.archived ?? false },
      configuration: { schema: configuration.config.schema, revision: configuration.revision,
        workflowRevision: requestHash({ entity: 'work_item', workflow: workflowFor('work_item', configuration.config) ?? null }) },
      migration: null };
    const fingerprint = requestHash({ name: input.name, arguments: input.arguments, actorId: actor.id, workspaceId,
      scope: { kind: 'projects', projectIds: [f.project.id] }, ...facts });
    const patch = f.workspace.patch.bind(f.workspace);
    let raced = false;
    f.workspace.patch = async (...args: Parameters<Workspace['patch']>) => {
      raced = true;
      const configuration = f.workspace.configuration(), workflow = configuration.config.workflows.work_item!;
      workflow.states.find(state => state.id === 'done')!.category = 'started';
      delete workflow.default_targets;
      await f.workspace.saveConfiguration(configuration.config, configuration.revision);
      return patch(...args);
    };
    const result = await f.call(input, 'call', { [PM_TOOL_APPROVAL_AUTHORITY_HEADER]: fingerprint });
    assert.equal(raced, true, 'Change lands after route/transaction reads but before the native serialized patch');
    assert.equal(result.statusCode, 200);
    assert.equal(result.json().status, 'failed');
    assert.equal(f.workspace.get(f.task.id).raw, f.task.raw);
    assert.equal(f.workspace.get(f.task.id).revision, f.task.revision);
    assert.equal(f.workspace.get(f.task.id).entity.status, 'todo');
  } finally { await f.close(); }
});

test('exact approval precondition cannot grant a revoked effective capability', async () => {
  const f = await fixture();
  try {
    f.allow([f.project.id], ['domain.read', 'workitem.complete']);
    const input = f.request('pm_transition_task', { id: f.task.id, revision: f.task.revision, status: 'done' });
    const authority = (await f.call(input, 'approval-authority')).json<PmToolApprovalAuthority>();
    f.allow([f.project.id], ['domain.read']);
    const result = await f.call(input, 'call', { [PM_TOOL_APPROVAL_AUTHORITY_HEADER]: authority.fingerprint });
    assert.equal(result.json().status, 'failed');
    assert.equal(f.workspace.get(f.task.id).revision, f.task.revision);
    assert.equal(f.workspace.get(f.task.id).raw, f.task.raw);
  } finally { await f.close(); }
});
