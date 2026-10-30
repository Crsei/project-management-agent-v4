import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { DomainError } from '../../../../packages/domain/src/core.ts';
import { Workspace } from '../../../../packages/pm-core/index.ts';
import type { CoreWorkspacePool } from '../src/core-routes.ts';
import type { AgentChatTools } from '../src/agent-chat-tools.ts';
import { registerAgentCapabilityRoutes } from '../src/agent-capability-routes.ts';

const workspaceId = '0196c319-8b1d-7000-8000-000000000001';
const actor = { id: 'user-1', email: 'fixture@example.invalid', name: 'Fixture' };
const registry = [
  { name: 'pm_query', description: 'Query', write: false, capabilities: ['domain.read'], available: true, denyReason: null },
  { name: 'pm_create_project', description: 'Create project', write: true, capabilities: ['domain.read', 'planning.edit'], available: true, denyReason: null },
  { name: 'pm_create_task', description: 'Create task', write: true, capabilities: ['domain.read', 'planning.edit'], available: true, denyReason: null },
  { name: 'pm_create_document', description: 'Create document', write: true, capabilities: ['domain.read', 'planning.edit'], available: false, denyReason: 'local_project_directory_required' },
] as unknown as AgentChatTools['registry'];

type ToolView = { name: string; allowed: boolean; denyReason: string | null };
type CapabilityView = { scope: { kind: string; projectIds: string[] }; tools: ToolView[] };

test('capability advertisement follows current membership, explicit scopes and the registry', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'pm-capabilities-'));
  const workspace = new Workspace(path.join(base, 'workspace'));
  await workspace.init();
  let row: Record<string, unknown> | null = null;
  const database = { query: async () => ({ rows: row ? [row] : [] }) } as unknown as Pool;
  const coreWorkspaces = { get: async () => { await workspace.rescan(); return workspace; } } as unknown as CoreWorkspacePool;
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof z.ZodError ? 400 : error instanceof DomainError ? error.status : 500).send({ error: error instanceof Error ? error.message : 'Unknown error' }));
  registerAgentCapabilityRoutes(app, { database: () => database, actor: async () => actor, coreWorkspaces, tools: { registry } as AgentChatTools });
  const read = (projectId?: string) => app.inject({
    method: 'GET', url: `/api/v1/workspaces/${workspaceId}/agent-capabilities${projectId ? `?projectId=${projectId}` : ''}`,
  });
  const member = (projectIds: string[] | null, caps = ['domain.read', 'planning.edit']) => ({
    user_id: actor.id, workspace_id: workspaceId, capabilities: caps, project_ids: projectIds, version: 1, revoked_at: null,
  });
  const tools = (view: CapabilityView) => new Map(view.tools.map(tool => [tool.name, tool]));
  try {
    const project = await workspace.createEntity({ entity: 'project', title: 'Fixture' }, 'fixture');
    const other = await workspace.createEntity({ entity: 'project', title: 'Other' }, 'other');

    row = member(null);
    const workspaceView = await read();
    assert.equal(workspaceView.statusCode, 200);
    const workspaceBody = workspaceView.json() as CapabilityView;
    assert.deepEqual(workspaceBody.scope, { kind: 'workspace', projectIds: [] });
    const workspaceTools = tools(workspaceBody);
    assert.equal(workspaceTools.get('pm_query')!.allowed, true);
    assert.equal(workspaceTools.get('pm_create_project')!.allowed, true);
    assert.deepEqual(
      { allowed: workspaceTools.get('pm_create_task')!.allowed, reason: workspaceTools.get('pm_create_task')!.denyReason },
      { allowed: false, reason: 'project_scope_required' },
    );
    assert.deepEqual(
      { allowed: workspaceTools.get('pm_create_document')!.allowed, reason: workspaceTools.get('pm_create_document')!.denyReason },
      { allowed: false, reason: 'local_project_directory_required' },
    );

    row = member([project.id]);
    const projectView = await read(project.id);
    assert.equal(projectView.statusCode, 200);
    const projectBody = projectView.json() as CapabilityView;
    assert.deepEqual(projectBody.scope, { kind: 'projects', projectIds: [project.id] });
    const projectTools = tools(projectBody);
    assert.equal(projectTools.get('pm_create_task')!.allowed, true);
    assert.equal(projectTools.get('pm_create_task')!.denyReason, null);
    assert.deepEqual(
      { allowed: projectTools.get('pm_create_project')!.allowed, reason: projectTools.get('pm_create_project')!.denyReason },
      { allowed: false, reason: 'workspace_scope_required' },
    );
    assert.equal(projectTools.get('pm_query')!.allowed, true);

    row = member([project.id], ['domain.read']);
    const readOnly = tools((await read(project.id)).json() as CapabilityView);
    assert.deepEqual(
      { allowed: readOnly.get('pm_create_task')!.allowed, reason: readOnly.get('pm_create_task')!.denyReason },
      { allowed: false, reason: 'capability_required' },
    );
    assert.equal(readOnly.get('pm_query')!.allowed, true);

    row = member(null, ['domain.read']);
    assert.equal((await read()).statusCode, 200);
    assert.equal((await read(project.id)).statusCode, 200);
    const missingCapability = tools((await read(project.id)).json() as CapabilityView);
    assert.equal(missingCapability.get('pm_create_project')!.denyReason, 'capability_required');

    row = member([project.id], ['planning.edit']);
    assert.equal((await read(project.id)).statusCode, 403);
    assert.equal((await read()).statusCode, 403);

    row = member(null);
    assert.equal((await read()).statusCode, 200);
    row = member([project.id]);
    assert.equal((await read()).statusCode, 403);
    assert.equal((await read(other.id)).statusCode, 404);
    row = member([other.id]);
    assert.equal((await read(project.id)).statusCode, 404);
    row = member(null);
    assert.equal((await read('PRJ-999')).statusCode, 404);
    assert.equal((await read('not-a-project')).statusCode, 400);

    row = null;
    assert.equal((await read()).statusCode, 404);
  } finally {
    await app.close();
    await workspace.close();
    await rm(base, { recursive: true, force: true });
  }
});
