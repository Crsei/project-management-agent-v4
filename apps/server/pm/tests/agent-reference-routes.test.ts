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
import { pmReferenceResolveResponseSchema } from '../../../../packages/agent-contracts/src/pm-references.ts';
import { createMcpServiceBearer, type McpInvocationIdentity } from '../../../../packages/infrastructure/src/mcp-service-auth.ts';
import type { CoreWorkspacePool } from '../src/core-routes.ts';
import { registerAgentReferenceRoutes } from '../src/agent-reference-routes.ts';

test('agent reference resolution reports available, stale, forbidden and deleted references per actor scope', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'pm-agent-references-'));
  const root = path.join(base, 'workspace');
  const workspace = new Workspace(root);
  await workspace.init();
  const workspaceId = '0196c319-8b1d-7000-8000-000000000002';
  const actor = { id: 'user-1', email: 'fixture@example.invalid', name: 'Fixture' };
  const app = Fastify();
  const allowed: string[] = [];
  const database = { query: async () => ({ rows: [{ user_id: actor.id, workspace_id: workspaceId, capabilities: ['domain.read'], project_ids: allowed, version: 1, revoked_at: null }] }) } as unknown as Pool;
  const coreWorkspaces = { get: async () => workspace } as unknown as CoreWorkspacePool;
  app.setErrorHandler((error, _request, reply) => reply
    .code(error instanceof DomainError ? error.status : error instanceof z.ZodError ? 400 : 500)
    .send({ error: error instanceof Error ? error.message : 'Unknown error' }));
  registerAgentReferenceRoutes(app, { database: () => database, actor: async () => actor, coreWorkspaces });
  const resolve = (references: unknown[]) => app.inject({
    method: 'POST', url: `/api/v1/workspaces/${workspaceId}/agent-references/resolve`, payload: { references },
  });
  try {
    const alpha = await workspace.createEntity({ entity: 'project', title: 'Alpha' }, 'alpha');
    allowed.push(alpha.id);
    const beta = await workspace.createEntity({ entity: 'project', title: 'Beta' }, 'beta');
    const issue = await workspace.createEntity({ entity: 'work_item', project: alpha.id, title: 'Alpha issue' }, 'alpha-issue');
    const document = await workspace.createEntity({ entity: 'document', project: alpha.id, title: 'Alpha document' }, 'alpha-document');
    const otherIssue = await workspace.createEntity({ entity: 'work_item', project: beta.id, title: 'Beta issue' }, 'beta-issue');
    const retired = await workspace.createEntity({ entity: 'work_item', project: alpha.id, title: 'Retired issue' }, 'retired-issue');
    await workspace.archive(retired.id, retired.revision);

    const response = await resolve([
      { kind: 'issue', id: issue.id, workspaceId, projectId: alpha.id, revision: null },
      { kind: 'document', id: document.id, workspaceId, projectId: null, revision: 'obsolete' },
      { kind: 'project', id: alpha.id, workspaceId, projectId: alpha.id, revision: alpha.revision },
      { kind: 'issue', id: issue.id, workspaceId, projectId: beta.id, revision: null },
      { kind: 'issue', id: otherIssue.id, workspaceId, projectId: null, revision: null },
      { kind: 'issue', id: retired.id, workspaceId, projectId: alpha.id, revision: null },
      { kind: 'issue', id: 'TASK-999', workspaceId, projectId: null, revision: null },
      { kind: 'project', id: beta.id, workspaceId, projectId: beta.id, revision: null },
    ]);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    const items = pmReferenceResolveResponseSchema.parse(response.json()).items;
    assert.deepEqual(items.map(item => [item.kind, item.id, item.availability]), [
      ['issue', issue.id, 'available'],
      ['document', document.id, 'stale'],
      ['project', alpha.id, 'available'],
      ['issue', issue.id, 'forbidden'],
      ['issue', otherIssue.id, 'forbidden'],
      ['issue', retired.id, 'deleted'],
      ['issue', 'TASK-999', 'forbidden'],
      ['project', beta.id, 'forbidden'],
    ]);
    assert.equal(items[0]!.title, 'Alpha issue');
    assert.equal(items[0]!.revision, issue.revision);
    assert.equal(items[0]!.projectId, alpha.id);
    assert.ok(items.every(item => item.workspaceId === workspaceId));
    assert.equal(items[1]!.revision, document.revision);
    assert.equal(items[1]!.title, 'Alpha document');
    assert.deepEqual(items[3]!.projectId, beta.id);
    assert.equal(items[6]!.title, '');
    assert.equal(items[6]!.revision, null);

    const fifty = Array.from({ length: 50 }, () => ({ kind: 'issue', id: issue.id, workspaceId, projectId: null, revision: null }));
    const atLimit = await resolve(fifty);
    assert.equal(atLimit.statusCode, 200);
    assert.equal(pmReferenceResolveResponseSchema.parse(atLimit.json()).items.length, 50);
    const overLimit = await resolve(Array.from({ length: 51 }, () => ({ kind: 'issue', id: issue.id, workspaceId, projectId: null, revision: null })));
    assert.equal(overLimit.statusCode, 400);

    const mismatched = await resolve([{ kind: 'issue', id: issue.id, workspaceId: '0196c319-8b1d-7000-8000-000000000099', projectId: alpha.id, revision: null }]);
    assert.equal(mismatched.statusCode, 400);
    const missingTarget = await resolve([{ kind: 'issue', id: issue.id, projectId: alpha.id, revision: null }]);
    assert.equal(missingTarget.statusCode, 400);
  } finally {
    await app.close();
    await workspace.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('agent reference resolution rejects actors without domain.read', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'pm-agent-references-'));
  const root = path.join(base, 'workspace');
  const workspace = new Workspace(root);
  await workspace.init();
  const workspaceId = '0196c319-8b1d-7000-8000-000000000003';
  const actor = { id: 'user-2', email: 'fixture@example.invalid', name: 'Fixture' };
  const app = Fastify();
  const database = { query: async () => ({ rows: [{ user_id: actor.id, workspace_id: workspaceId, capabilities: [], project_ids: null, version: 1, revoked_at: null }] }) } as unknown as Pool;
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof DomainError ? error.status : 500).send({ error: error instanceof Error ? error.message : 'Unknown error' }));
  registerAgentReferenceRoutes(app, { database: () => database, actor: async () => actor, coreWorkspaces: { get: async () => workspace } as unknown as CoreWorkspacePool });
  try {
    const response = await app.inject({
      method: 'POST', url: `/api/v1/workspaces/${workspaceId}/agent-references/resolve`,
      payload: { references: [{ kind: 'issue', id: 'TASK-001', workspaceId, projectId: null, revision: null }] },
    });
    assert.equal(response.statusCode, 403);
  } finally {
    await app.close();
    await workspace.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('explicit reference targets intersect live delegation with unrestricted native membership', async t => {
  const oldSecret = process.env.PM_AUTOMATION_SERVICE_SECRET, oldUrl = process.env.PM_MCP_AGENT_URL;
  process.env.PM_AUTOMATION_SERVICE_SECRET = 'test-only-reference-secret'.repeat(4);
  process.env.PM_MCP_AGENT_URL = 'http://127.0.0.1:4123';
  const base = await mkdtemp(path.join(tmpdir(), 'pm-delegated-references-'));
  const workspace = new Workspace(path.join(base, 'workspace'));
  await workspace.init();
  const workspaceId = '0196c319-8b1d-7000-8000-000000000001';
  const actor = { id: '0196c319-8b1d-7000-8000-000000000010', email: 'fixture@example.invalid', name: 'Fixture' };
  const alpha = await workspace.createEntity({ entity: 'project', title: 'Alpha' }, 'alpha');
  const beta = await workspace.createEntity({ entity: 'project', title: 'Beta' }, 'beta');
  const issue = await workspace.createEntity({ entity: 'work_item', project: beta.id, title: 'Hidden issue' }, 'hidden');
  const grant: McpInvocationIdentity = { grantId: '0196c319-8b1d-7000-8000-000000000020', actorId: actor.id, scope: { workspaceId, projectId: alpha.id }, access: 'read-only', threadIds: [], version: 1 };
  let revoked = false;
  t.mock.method(globalThis, 'fetch', async () => revoked ? Response.json({ error: 'revoked' }, { status: 401 }) : Response.json(grant));
  const database = { query: async (text: string) => ({ rows: text.includes('FROM users') ? [actor] : [{ user_id: actor.id, workspace_id: workspaceId, capabilities: ['domain.read'], project_ids: null, version: 1, revoked_at: null }] }) } as unknown as Pool;
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof z.ZodError ? 400 : error instanceof DomainError ? error.status : 500).send({ error: error instanceof DomainError ? error.code : 'invalid_request' }));
  registerAgentReferenceRoutes(app, { database: () => database, actor: async () => actor, coreWorkspaces: { get: async () => workspace } as unknown as CoreWorkspacePool });
  const headers = { authorization: `Bearer ${createMcpServiceBearer(grant)}` };
  const resolve = (projectId: string | null) => app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspaceId}/agent-references/resolve`, headers,
    payload: { references: [{ kind: 'issue', id: issue.id, workspaceId, projectId, revision: null }] } });
  try {
    const implicitParent = await resolve(null);
    assert.equal(implicitParent.statusCode, 200);
    const item = pmReferenceResolveResponseSchema.parse(implicitParent.json()).items[0]!;
    assert.equal(item.workspaceId, workspaceId);
    assert.equal(item.availability, 'forbidden');
    assert.equal(item.title, '');
    assert.equal((await resolve(beta.id)).statusCode, 403);
    const forgedParent = await resolve(alpha.id);
    assert.equal(forgedParent.statusCode, 200);
    assert.equal(pmReferenceResolveResponseSchema.parse(forgedParent.json()).items[0]!.availability, 'forbidden');
    revoked = true;
    const denied = await resolve(null);
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.json().error, 'mcp_grant_revoked');
  } finally {
    await app.close(); await workspace.close(); await rm(base, { recursive: true, force: true });
    if (oldSecret === undefined) delete process.env.PM_AUTOMATION_SERVICE_SECRET; else process.env.PM_AUTOMATION_SERVICE_SECRET = oldSecret;
    if (oldUrl === undefined) delete process.env.PM_MCP_AGENT_URL; else process.env.PM_MCP_AGENT_URL = oldUrl;
  }
});
