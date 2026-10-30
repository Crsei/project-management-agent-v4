import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { DomainError } from '../../../../packages/domain/src/core.ts';
import { Workspace } from '../../../../packages/pm-core/index.ts';
import type { CoreWorkspacePool } from '../src/core-routes.ts';
import {
  agentIssueSearchPageSchema, registerAgentIssueSearchRoutes, type AgentIssueSearchPage,
} from '../src/agent-issue-search-routes.ts';

const workspaceId = '0196c319-8b1d-7000-8000-00000000000a';
const actor = { id: 'user-1', email: 'fixture@example.invalid', name: 'Fixture' };
const member = (projectIds: string[] | null, capabilities: string[] = ['domain.read']) => ({
  user_id: actor.id, workspace_id: workspaceId, capabilities, project_ids: projectIds, version: 1, revoked_at: null,
});

function createApp(workspace: Workspace, membership: () => Record<string, unknown> | null): FastifyInstance {
  const database = {
    query: async () => {
      const row = membership();
      return { rows: row ? [row] : [] };
    },
  } as unknown as Pool;
  const coreWorkspaces = { get: async () => { await workspace.rescan(); return workspace; } } as unknown as CoreWorkspacePool;
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => reply
    .code(error instanceof DomainError ? error.status : error instanceof z.ZodError ? 400 : 500)
    .send({ error: error instanceof Error ? error.message : 'Unknown error' }));
  registerAgentIssueSearchRoutes(app, { database: () => database, actor: async () => actor, coreWorkspaces });
  return app;
}

function request(app: FastifyInstance, params: Record<string, string | number> = {}) {
  const search = new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)] as [string, string]));
  return app.inject({ method: 'GET', url: `/api/v1/workspaces/${workspaceId}/agent-issues${search.size ? `?${search}` : ''}` });
}

test('agent issue search filters by q, status, assignee and project and pages by stable ID cursor', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'pm-agent-issues-'));
  const workspace = new Workspace(path.join(base, 'workspace'));
  await workspace.init();
  const app = createApp(workspace, () => member(null));
  try {
    const alpha = await workspace.createEntity({ entity: 'project', title: 'Alpha' }, 'alpha');
    const beta = await workspace.createEntity({ entity: 'project', title: 'Beta' }, 'beta');
    const login = await workspace.createEntity({ entity: 'work_item', project: alpha.id, title: 'Alpha login bug', body: 'Bearer token refresh fails', status: 'todo', priority: 'high', assignee: 'user-a', due: '2026-11-01' }, 'alpha-login');
    const report = await workspace.createEntity({ entity: 'work_item', project: alpha.id, title: 'Alpha report', body: 'Quarterly ledger review', status: 'in_progress', priority: 'low', assignee: 'user-b' }, 'alpha-report');
    const retired = await workspace.createEntity({ entity: 'work_item', project: alpha.id, title: 'Alpha token retired', body: 'Retired prose', status: 'todo', assignee: 'user-a' }, 'alpha-retired');
    await workspace.archive(retired.id, retired.revision);
    const secret = await workspace.createEntity({ entity: 'work_item', project: beta.id, title: 'Beta secret', body: 'token leak', status: 'todo', assignee: 'user-a' }, 'beta-secret');

    const all = await request(app);
    assert.equal(all.statusCode, 200);
    assert.equal(all.headers['cache-control'], 'no-store');
    const page: AgentIssueSearchPage = agentIssueSearchPageSchema.parse(all.json());
    assert.deepEqual(page.items.map(item => item.id), [login.id, report.id, secret.id]);
    assert.equal(page.nextCursor, null);
    assert.deepEqual(page.items[0], {
      id: login.id, title: 'Alpha login bug', status: 'todo', priority: 'high', projectId: alpha.id,
      assigneeId: 'user-a', dueDate: '2026-11-01', revision: login.revision, updatedAt: null,
    });

    const byBody = agentIssueSearchPageSchema.parse((await request(app, { q: 'token' })).json());
    assert.deepEqual(byBody.items.map(item => item.id), [login.id, secret.id]);
    const byId = agentIssueSearchPageSchema.parse((await request(app, { q: login.id })).json());
    assert.deepEqual(byId.items.map(item => item.id), [login.id]);
    const byTitle = agentIssueSearchPageSchema.parse((await request(app, { q: 'ledger' })).json());
    assert.deepEqual(byTitle.items.map(item => item.id), [report.id]);

    const byStatus = agentIssueSearchPageSchema.parse((await request(app, { status: 'in_progress' })).json());
    assert.deepEqual(byStatus.items.map(item => item.id), [report.id]);
    assert.equal((await request(app, { status: 'missing' })).statusCode, 200);
    assert.deepEqual((await request(app, { status: 'missing' })).json(), { items: [], nextCursor: null });

    const byAssignee = agentIssueSearchPageSchema.parse((await request(app, { assigneeId: 'user-a' })).json());
    assert.deepEqual(byAssignee.items.map(item => item.id), [login.id, secret.id]);
    assert.deepEqual(agentIssueSearchPageSchema.parse((await request(app, { assigneeId: 'nobody' })).json()).items, []);

    const byProject = agentIssueSearchPageSchema.parse((await request(app, { projectId: alpha.id })).json());
    assert.deepEqual(byProject.items.map(item => item.id), [login.id, report.id]);
    const combined = agentIssueSearchPageSchema.parse((await request(app, { projectId: beta.id, q: 'token', status: 'todo', assigneeId: 'user-a' })).json());
    assert.deepEqual(combined.items.map(item => item.id), [secret.id]);

    const first = agentIssueSearchPageSchema.parse((await request(app, { limit: 2 })).json());
    assert.deepEqual(first.items.map(item => item.id), [login.id, report.id]);
    assert.equal(first.nextCursor, report.id);
    const second = agentIssueSearchPageSchema.parse((await request(app, { limit: 2, after: first.nextCursor! })).json());
    assert.deepEqual(second.items.map(item => item.id), [secret.id]);
    assert.equal(second.nextCursor, null);
    assert.deepEqual(agentIssueSearchPageSchema.parse((await request(app, { after: secret.id })).json()), { items: [], nextCursor: null });

    const walked: string[] = [];
    let cursor: string | null = null;
    do {
      const step = agentIssueSearchPageSchema.parse((await request(app, { limit: 1, ...(cursor ? { after: cursor } : {}) })).json());
      walked.push(...step.items.map(item => item.id));
      cursor = step.nextCursor;
    } while (cursor !== null);
    assert.deepEqual(walked, [login.id, report.id, secret.id]);

    assert.equal((await request(app, { limit: 0 })).statusCode, 400);
    assert.equal((await request(app, { limit: 101 })).statusCode, 400);
    assert.equal((await request(app, { limit: 1.5 })).statusCode, 400);
    assert.equal((await request(app, { unknown: 'value' })).statusCode, 400);
  } finally {
    await app.close();
    await workspace.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('agent issue search preserves membership and project scope for every request', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'pm-agent-issues-scope-'));
  const workspace = new Workspace(path.join(base, 'workspace'));
  await workspace.init();
  let membership: Record<string, unknown> | null = member(null);
  const app = createApp(workspace, () => membership);
  try {
    const alpha = await workspace.createEntity({ entity: 'project', title: 'Alpha' }, 'alpha');
    const beta = await workspace.createEntity({ entity: 'project', title: 'Beta' }, 'beta');
    const alphaTask = await workspace.createEntity({ entity: 'work_item', project: alpha.id, title: 'Alpha task', status: 'todo' }, 'alpha-task');
    const betaTask = await workspace.createEntity({ entity: 'work_item', project: beta.id, title: 'Beta task', status: 'todo' }, 'beta-task');

    membership = null;
    assert.equal((await request(app)).statusCode, 404);
    assert.equal((await request(app, { projectId: alpha.id })).statusCode, 404);

    membership = member(null, ['planning.edit']);
    assert.equal((await request(app)).statusCode, 403);

    membership = member([alpha.id]);
    const restricted = agentIssueSearchPageSchema.parse((await request(app)).json());
    assert.deepEqual(restricted.items.map(item => item.id), [alphaTask.id]);
    assert.deepEqual(agentIssueSearchPageSchema.parse((await request(app, { projectId: alpha.id })).json()).items.map(item => item.id), [alphaTask.id]);
    assert.deepEqual(agentIssueSearchPageSchema.parse((await request(app, { q: 'task' })).json()).items.map(item => item.id), [alphaTask.id]);
    assert.equal((await request(app, { projectId: beta.id })).statusCode, 404);

    membership = member([beta.id]);
    assert.equal((await request(app, { projectId: alpha.id })).statusCode, 404);
    const betaOnly = agentIssueSearchPageSchema.parse((await request(app, { projectId: beta.id })).json());
    assert.deepEqual(betaOnly.items.map(item => item.id), [betaTask.id]);
    assert.deepEqual(agentIssueSearchPageSchema.parse((await request(app)).json()).items.map(item => item.id), [betaTask.id]);

    membership = member(null);
    assert.equal((await request(app, { projectId: 'PRJ-999' })).statusCode, 404);
    assert.equal((await request(app, { projectId: alphaTask.id })).statusCode, 404);

    const unavailable = Fastify();
    unavailable.setErrorHandler((error, _request, reply) => reply
      .code(error instanceof DomainError ? error.status : error instanceof z.ZodError ? 400 : 500)
      .send({ error: error instanceof Error ? error.message : 'Unknown error' }));
    registerAgentIssueSearchRoutes(unavailable, {
      database: () => ({ query: async () => ({ rows: [member(null)] }) }) as unknown as Pool,
      actor: async () => actor, coreWorkspaces: undefined,
    });
    assert.equal((await unavailable.inject({ method: 'GET', url: `/api/v1/workspaces/${workspaceId}/agent-issues` })).statusCode, 503);
    assert.equal((await unavailable.inject({ method: 'GET', url: `/api/v1/workspaces/not-a-uuid/agent-issues` })).statusCode, 400);
    await unavailable.close();
  } finally {
    await app.close();
    await workspace.close();
    await rm(base, { recursive: true, force: true });
  }
});
