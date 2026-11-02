import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import Fastify from 'fastify';
import { z } from 'zod';
import { registerWorkflowTaskTransitionRoutes } from '../apps/server/pm/src/workflow-task-transition-routes.ts';
import { CoreWorkspacePool } from '../apps/server/pm/src/core-routes.ts';
import { WorkspaceError } from '../packages/pm-core/index.ts';
import { DomainError } from '../packages/domain/src/core.ts';
import { createPool, migrate } from '../packages/infrastructure/src/database.ts';
import { createUser, createWorkspace } from '../packages/infrastructure/src/auth.ts';
import { runCommand } from '../packages/application/src/kernel.ts';
import { accessCommands } from '../packages/application/src/access.ts';

test('workflow state changes use real native CAS, receipts, audit, configured edges and current project authorization', async () => {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  assert.ok(url, 'Real PostgreSQL is required; a skipped test is not acceptance');
  const schema = `test_workflow_state_${randomUUID().replaceAll('-', '')}`;
  const bootstrap = createPool(url);
  await bootstrap.query(`CREATE SCHEMA ${schema}`);
  const scoped = new URL(url); scoped.searchParams.set('options', `-c search_path=${schema},public`);
  const pool = createPool(scoped.toString()), root = await mkdtemp(join(tmpdir(), 'pm-workflow-state-'));
  const cores = new CoreWorkspacePool(root, pool), app = Fastify();
  try {
    await migrate(pool);
    const owner = await createUser(pool, { email: `${randomUUID()}@example.test`, name: 'Workflow fixture', password: 'isolated-workflow-fixture-password' });
    const limited = await createUser(pool, { email: `${randomUUID()}@example.test`, name: 'Limited fixture', password: 'isolated-workflow-fixture-password' });
    const ws = await createWorkspace(pool, owner.id, 'Isolated state linkage');
    const workspace = await cores.get(ws.id);
    const project = await workspace.createEntity({ entity: 'project', title: 'Bound project' });
    const other = await workspace.createEntity({ entity: 'project', title: 'Other project' });
    const task = await workspace.createEntity({ entity: 'work_item', project: project.id, title: 'Deliver code', body: 'Keep this requirement\n\n- [ ] Preserve acceptance criteria' });
    const membership = await runCommand(pool, owner, ws.id, { commandId: randomUUID(), commandType: 'SetWorkspaceMember', payload: { userId: limited.id, capabilities: ['domain.read', 'planning.edit'], projectIds: [other.id] } }, accessCommands);
    assert.equal(membership.status, 'committed');
    app.setErrorHandler((error, _request, reply) => {
      const status = error instanceof DomainError || error instanceof WorkspaceError ? error.status : error instanceof z.ZodError ? 400 : 500;
      return reply.code(status).send({ error: error instanceof Error ? error.message : 'unknown' });
    });
    registerWorkflowTaskTransitionRoutes(app, { database: () => pool, actor: async request => request.headers['x-fixture-actor'] === 'limited' ? limited : owner, coreWorkspaces: cores });
    const endpoint = `/api/v1/workspaces/${ws.id}/workflow-task-transitions`;
    const input = { workspaceId: ws.id, projectId: project.id, taskId: task.id, runId: randomUUID(), nodeId: 'agent', revision: task.revision, phase: 'start' };
    const denied = await app.inject({ method: 'POST', url: endpoint, payload: input, headers: { 'x-fixture-actor': 'limited' } });
    assert.ok([403, 404].includes(denied.statusCode));
    assert.equal((await app.inject({ method: 'POST', url: endpoint, payload: { ...input, projectId: other.id } })).statusCode, 409);
    assert.equal((await app.inject({ method: 'POST', url: endpoint, payload: { ...input, phase: 'done' } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: `${endpoint}/reconcile`, payload: input })).json().status, 'not_found');
    assert.equal(workspace.get(task.id).entity.status, 'todo');
    const first = await app.inject({ method: 'POST', url: endpoint, payload: input });
    assert.equal(first.statusCode, 200, first.body);
    const receipt = first.json(); assert.equal(receipt.status, 'applied');
    assert.equal(workspace.get(task.id).entity.status, 'in_progress');
    assert.equal(workspace.get(task.id).entity.body, task.entity.body);
    assert.deepEqual((await app.inject({ method: 'POST', url: endpoint, payload: input })).json(), receipt);
    assert.deepEqual((await app.inject({ method: 'POST', url: `${endpoint}/reconcile`, payload: input })).json(), receipt);
    const review = { ...input, nodeId: 'ci', phase: 'review', revision: receipt.revision };
    const next = await app.inject({ method: 'POST', url: endpoint, payload: review });
    assert.equal(next.statusCode, 200, next.body); assert.equal(workspace.get(task.id).entity.status, 'review');
    const audit = await pool.query('SELECT count(*)::int AS count FROM project_audit WHERE workspace_id=$1 AND command_id=ANY($2::text[])', [ws.id, [receipt.commandId, next.json().commandId]]);
    assert.equal(audit.rows[0].count, 2);
    // Original proof remains original; a later edit is never adopted or overwritten.
    const edited = await workspace.patch(task.id, { title: 'Human updated scope', status: 'canceled' }, workspace.get(task.id).revision);
    assert.deepEqual((await app.inject({ method: 'POST', url: `${endpoint}/reconcile`, payload: input })).json(), receipt);
    assert.equal(workspace.get(task.id).revision, edited.revision);
    assert.equal((await app.inject({ method: 'POST', url: endpoint, payload: { ...input, runId: randomUUID(), revision: edited.revision } })).statusCode, 409);
    // Two attempts at the same source revision cannot overwrite one another.
    const concurrent = await workspace.createEntity({ entity: 'work_item', project: project.id, title: 'Concurrent task' });
    const replies = await Promise.all([1, 2].map(() => app.inject({ method: 'POST', url: endpoint, payload: { ...input, runId: randomUUID(), taskId: concurrent.id, revision: concurrent.revision } })));
    assert.deepEqual(replies.map(r => r.statusCode).sort(), [200, 409]);
    // Native configuration remains authoritative even for otherwise valid workflow requests.
    const configured = await workspace.createEntity({ entity: 'work_item', project: project.id, title: 'Configured edge' });
    const configuration = workspace.configuration();
    const modified = structuredClone(configuration.config);
    modified.workflows.work_item!.transitions = modified.workflows.work_item!.transitions.filter(e => !(e.from === 'todo' && e.to === 'in_progress'));
    await workspace.saveConfiguration(modified, configuration.revision);
    const refused = await app.inject({ method: 'POST', url: endpoint, payload: { ...input, runId: randomUUID(), taskId: configured.id, revision: configured.revision } });
    assert.equal(refused.statusCode, 422, refused.body); assert.equal(workspace.get(configured.id).entity.status, 'todo');
    await workspace.saveConfiguration(configuration.config, workspace.configuration().revision);
    assert.equal((await runCommand(pool, owner, ws.id, { commandId: randomUUID(), commandType: 'SetWorkspaceMember', expectedVersions: { [limited.id]: 1 }, payload: { userId: limited.id, capabilities: ['domain.read', 'planning.edit'], projectIds: [project.id] } }, accessCommands)).status, 'committed');
    const memberInput = { ...input, runId: randomUUID(), taskId: configured.id, revision: configured.revision };
    assert.equal((await app.inject({ method: 'POST', url: endpoint, payload: memberInput, headers: { 'x-fixture-actor': 'limited' } })).statusCode, 200);
    assert.equal((await runCommand(pool, owner, ws.id, { commandId: randomUUID(), commandType: 'SetWorkspaceMember', expectedVersions: { [limited.id]: 2 }, payload: { userId: limited.id, capabilities: ['domain.read'], projectIds: [project.id] } }, accessCommands)).status, 'committed');
    assert.equal((await app.inject({ method: 'POST', url: `${endpoint}/reconcile`, payload: memberInput, headers: { 'x-fixture-actor': 'limited' } })).statusCode, 403);
    await cores.close();
    const restarted = new CoreWorkspacePool(root, pool);
    const recoveredApp = Fastify();
    try {
      registerWorkflowTaskTransitionRoutes(recoveredApp, { database: () => pool, actor: async () => owner, coreWorkspaces: restarted });
      assert.deepEqual((await recoveredApp.inject({ method: 'POST', url: `${endpoint}/reconcile`, payload: review })).json(), next.json());
      assert.equal((await restarted.get(ws.id)).get(task.id).revision, edited.revision);
    } finally { await recoveredApp.close(); await restarted.close(); }
  } finally {
    await app.close(); await cores.close(); await pool.end(); await bootstrap.query(`DROP SCHEMA ${schema} CASCADE`); await bootstrap.end(); await rm(root, { recursive: true, force: true });
  }
});
