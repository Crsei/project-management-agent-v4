import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import type { Pool } from 'pg';
import { DomainError } from '../../../../packages/domain/src/core.ts';
import { Workspace } from '../../../../packages/pm-core/index.ts';
import { createMcpServiceBearer } from '../../../../packages/infrastructure/src/mcp-service-auth.ts';
import type { CoreWorkspacePool } from '../src/core-routes.ts';
import { registerAgentCoreFilesRoutes } from '../src/agent-core-files-routes.ts';

test('registered shared and independent core files preserve invalid raw content without crossing project scope', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'pm-core-source-'));
  const root = path.join(base, 'workspace'), local = path.join(base, 'local');
  await mkdir(root); await mkdir(local);
  const workspace = new Workspace(root); await workspace.init();
  const workspaceId = '0196c319-8b1d-7000-8000-000000000001';
  const actor = { id: 'user-1', email: 'fixture@example.invalid', name: 'Fixture' };
  const app = Fastify();
  let allowed = ['PRJ-001', 'PRJ-002'];
  const database = { query: async () => ({ rows: [{ user_id: actor.id, workspace_id: workspaceId, capabilities: ['domain.read'], project_ids: allowed, version: 1, revoked_at: null }] }) } as unknown as Pool;
  const coreWorkspaces = { get: async () => { await workspace.rescan(); return workspace; } } as unknown as CoreWorkspacePool;
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof DomainError ? error.status : 500).send({ error: error instanceof Error ? error.message : 'Unknown error' }));
  registerAgentCoreFilesRoutes(app, { database: () => database, actor: async () => actor, coreWorkspaces });
  try {
    const shared = await workspace.createEntity({ entity: 'project', title: 'Shared' }, 'shared');
    const task = await workspace.createEntity({ entity: 'work_item', project: shared.id, title: 'Shared task' }, 'shared-task');
    const mounted = await workspace.initializeProject({ entity: 'project', title: 'Mounted' }, 'mounted', { workspaceId, root: local });
    const document = await workspace.createEntity({ entity: 'document', project: mounted.id, title: 'Mounted document' }, 'mounted-doc');
    await writeFile(path.join(local, 'README.md'), 'not managed');
    await writeFile(path.join(root, task.path), 'broken shared markdown');
    await writeFile(path.join(local, '.pm/core', document.path.replace(`project-roots/${mounted.id}/`, '')), 'broken mounted markdown');
    const read = async (projectId: string) => app.inject({ method: 'GET', url: `/api/v1/workspaces/${workspaceId}/agent-tools/core-files?projectId=${projectId}` });
    const first = await read(shared.id); assert.equal(first.statusCode, 200);
    const sharedFiles = first.json() as { files: { path: string; content: string }[]; complete: boolean };
    assert.ok(sharedFiles.files.some(file => file.path === task.path && file.content === 'broken shared markdown'));
    assert.ok(sharedFiles.files.every(file => !file.path.startsWith('project-roots/')));
    const second = await read(mounted.id); assert.equal(second.statusCode, 200);
    const mountedFiles = second.json() as { files: { path: string; content: string }[] };
    assert.ok(mountedFiles.files.some(file => file.path === document.path && file.content === 'broken mounted markdown'));
    assert.ok(!mountedFiles.files.some(file => file.content === 'not managed'));
    allowed = [shared.id]; assert.equal((await read(mounted.id)).statusCode, 404);
  } finally { await app.close(); await workspace.close(); await rm(base, { recursive: true, force: true }); }
});

test('revoked delegated core-file reads fail before traversing any registered repository', async t => {
  const oldSecret = process.env.PM_AUTOMATION_SERVICE_SECRET, oldUrl = process.env.PM_MCP_AGENT_URL;
  process.env.PM_AUTOMATION_SERVICE_SECRET = 'test-only-core-files-secret'.repeat(4);
  process.env.PM_MCP_AGENT_URL = 'http://127.0.0.1:4123';
  const workspaceId = '0196c319-8b1d-7000-8000-000000000001';
  const actor = { id: '0196c319-8b1d-7000-8000-000000000010', email: 'fixture@example.invalid', name: 'Fixture' };
  const bearer = createMcpServiceBearer({ grantId: '0196c319-8b1d-7000-8000-000000000020', actorId: actor.id, scope: { workspaceId, projectId: 'PRJ-001' }, access: 'read-only', threadIds: [], version: 1 });
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'revoked' }, { status: 401 }));
  let traversals = 0;
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof DomainError ? error.status : 500).send({ error: error instanceof DomainError ? error.code : 'unexpected' }));
  registerAgentCoreFilesRoutes(app, { database: () => ({ query: async () => { throw new Error('Revoked grant must fail before PM data reads'); } }) as unknown as Pool,
    actor: async () => actor, coreWorkspaces: { get: async () => { traversals++; throw new Error('Must not traverse'); } } as unknown as CoreWorkspacePool });
  try {
    const response = await app.inject({ method: 'GET', url: `/api/v1/workspaces/${workspaceId}/agent-tools/core-files?projectId=PRJ-001`, headers: { authorization: `Bearer ${bearer}` } });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error, 'mcp_grant_revoked');
    assert.equal(traversals, 0);
  } finally {
    await app.close();
    if (oldSecret === undefined) delete process.env.PM_AUTOMATION_SERVICE_SECRET; else process.env.PM_AUTOMATION_SERVICE_SECRET = oldSecret;
    if (oldUrl === undefined) delete process.env.PM_MCP_AGENT_URL; else process.env.PM_MCP_AGENT_URL = oldUrl;
  }
});
