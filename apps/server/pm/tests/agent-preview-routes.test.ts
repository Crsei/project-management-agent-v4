import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { DomainError, type Capability } from '../../../../packages/domain/src/core.ts';
import { Workspace } from '../../../../packages/pm-core/index.ts';
import type { CoreWorkspacePool } from '../src/core-routes.ts';
import { registerAgentPreviewRoutes } from '../src/agent-preview-routes.ts';

const workspaceId = '0196c319-8b1d-7000-8000-000000000001';
const actor = { id: '0196c319-8b1d-7000-8000-000000000010', email: 'fixture@example.invalid', name: 'Fixture' };
type Member = { user_id: string; workspace_id: string; capabilities: Capability[]; project_ids: string[] | null; version: number; revoked_at: null };
const ALL_CAPABILITIES: Capability[] = ['domain.read', 'planning.edit', 'planning.lifecycle', 'workitem.complete', 'workitem.cancel_reopen'];

/** The preview route needs membership only; every source read comes from the real Markdown core. */
function fakeDatabase(member: () => Member): Pool {
  const query = async (text: string) => (/SELECT m\.\* FROM memberships/.test(text) ? { rows: [member()], rowCount: 1 } : { rows: [], rowCount: 0 });
  return { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Pool;
}

type PreviewResponse = { statusCode: number; headers: Record<string, string | number | string[] | undefined>; json: () => unknown };
type PreviewFixture = {
  base: string; app: FastifyInstance; workspace: Workspace;
  project: string; other: string; task: string;
  post: (payload: Record<string, unknown>) => Promise<PreviewResponse>;
  allow: (capabilities: Capability[], projects: string[] | null) => void;
  snapshots: () => { id: string; revision: string; title: string }[];
};

async function fixture(): Promise<PreviewFixture> {
  const base = await mkdtemp(path.join(tmpdir(), 'pm-agent-preview-'));
  const workspace = new Workspace(path.join(base, 'workspace'));
  await workspace.init();
  let capabilities: Capability[] = [...ALL_CAPABILITIES];
  let membershipProjects: string[] | null = null;
  const database = fakeDatabase(() => ({ user_id: actor.id, workspace_id: workspaceId, capabilities, project_ids: membershipProjects, version: 1, revoked_at: null }));
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    const status = error instanceof z.ZodError ? 400 : error instanceof DomainError ? error.status : 500;
    const code = error instanceof z.ZodError ? 'validation_failed' : error instanceof DomainError ? error.code : 'internal_error';
    return reply.code(status).send({ error: { code, message: error instanceof Error ? error.message : 'Unknown error' } });
  });
  registerAgentPreviewRoutes(app, { database: () => database, actor: async () => actor, coreWorkspaces: { get: async () => workspace } as unknown as CoreWorkspacePool });
  const project = (await workspace.createEntity({ entity: 'project', title: 'Preview project' }, 'preview-project')).id;
  const other = (await workspace.createEntity({ entity: 'project', title: 'Other project' }, 'other-project')).id;
  const task = (await workspace.createEntity({ entity: 'work_item', project, title: 'Preview task' }, 'preview-task')).id;
  return {
    base, app, workspace, project, other, task,
    post: payload => app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspaceId}/agent-tools/preview`, payload }),
    allow: (nextCapabilities, nextProjects) => { capabilities = nextCapabilities; membershipProjects = nextProjects; },
    snapshots: () => workspace.items().map(record => ({ id: record.id, revision: record.revision, title: record.entity.title })),
  };
}

async function withFixture(body: (f: PreviewFixture) => Promise<void>): Promise<void> {
  const f = await fixture();
  try { await body(f); }
  finally { await f.app.close(); await f.workspace.close(); await rm(f.base, { recursive: true, force: true }); }
}

const previewBodySchema = z.strictObject({
  id: z.string(), kind: z.string(), state: z.string(), targetId: z.string().nullable(), targetTitle: z.string().nullable(),
  projectId: z.string().nullable(), summary: z.string(), createdAt: z.string(),
  fields: z.array(z.object({ field: z.string(), label: z.string(), before: z.string().nullable(), after: z.string().nullable() })).optional(),
});
type PreviewBody = z.infer<typeof previewBodySchema>;
const errorBodySchema = z.object({ error: z.object({ code: z.string() }) });
function previewBody(response: PreviewResponse): PreviewBody {
  assert.equal(response.statusCode, 200);
  return previewBodySchema.parse(response.json());
}
function errorCode(response: PreviewResponse): string { return errorBodySchema.parse(response.json()).error.code; }
function field(body: PreviewBody, name: string) {
  const found = body.fields?.find(item => item.field === name);
  assert.ok(found, `expected a ${name} field`);
  return found;
}

test('update preview returns current before/after values and never writes', () => withFixture(async f => {
  const current = f.workspace.get(f.task);
  const response = await f.post({
    name: 'pm_update_task',
    arguments: { id: f.task, revision: current.revision, title: 'Renamed task', description: null, assigneeId: null, priority: 'high', startDate: null, dueDate: null, labels: null },
    target: { workspaceId, projectId: f.project },
  });
  const body = previewBody(response);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual({ kind: body.kind, state: body.state, targetId: body.targetId, targetTitle: body.targetTitle, projectId: body.projectId },
    { kind: 'update', state: 'proposed', targetId: f.task, targetTitle: 'Preview task', projectId: f.project });
  assert.deepEqual(
    { before: field(body, 'title').before, after: field(body, 'title').after },
    { before: 'Preview task', after: 'Renamed task' },
  );
  assert.deepEqual({ before: field(body, 'priority').before, after: field(body, 'priority').after }, { before: 'medium', after: 'high' });
  assert.equal(body.fields?.some(item => item.field === 'description'), false);
  assert.deepEqual({ before: field(body, 'revision').before, after: field(body, 'revision').after }, { before: current.revision, after: null });
  const unchanged = f.workspace.get(f.task);
  assert.equal(unchanged.revision, current.revision);
  assert.equal(unchanged.entity.title, 'Preview task');
}));

test('create preview plans fields without a target and allocates nothing', () => withFixture(async f => {
  const before = f.snapshots();
  const response = await f.post({
    name: 'pm_create_task',
    arguments: { projectId: f.project, title: 'New task', description: 'Details', assigneeId: null, priority: 'urgent', startDate: '', dueDate: null, labels: ['api', 'docs'] },
    target: { workspaceId, projectId: f.project },
  });
  const body = previewBody(response);
  assert.deepEqual({ kind: body.kind, targetId: body.targetId, targetTitle: body.targetTitle, projectId: body.projectId },
    { kind: 'create', targetId: null, targetTitle: 'New task', projectId: f.project });
  assert.deepEqual({ before: field(body, 'title').before, after: field(body, 'title').after }, { before: null, after: 'New task' });
  assert.equal(field(body, 'description').after, 'Details');
  assert.equal(field(body, 'priority').after, 'urgent');
  assert.equal(field(body, 'labels').after, 'api, docs');
  assert.equal(field(body, 'startDate').after, null);
  assert.equal(body.fields?.some(item => item.field === 'dueDate'), false);
  assert.deepEqual(f.snapshots(), before);
}));

test('relation preview shows the field change and both endpoint revisions without writing', () => withFixture(async f => {
  const target = (await f.workspace.createEntity({ entity: 'work_item', project: f.project, title: 'Target task' }, 'target-task')).id;
  const source = f.workspace.get(f.task), endpoint = f.workspace.get(target);
  const added = previewBody(await f.post({
    name: 'pm_add_relation',
    arguments: { sourceId: f.task, targetId: target, relation: 'parent', revision: source.revision, targetRevision: endpoint.revision },
    target: { workspaceId, projectId: f.project },
  }));
  assert.deepEqual({ kind: added.kind, targetId: added.targetId, projectId: added.projectId }, { kind: 'relation', targetId: f.task, projectId: f.project });
  assert.deepEqual({ before: field(added, 'parent').before, after: field(added, 'parent').after }, { before: null, after: target });
  assert.equal(field(added, 'sourceRevision').before, source.revision);
  assert.equal(field(added, 'targetRevision').before, endpoint.revision);
  assert.equal(f.workspace.get(f.task).revision, source.revision);

  const linked = await f.workspace.patch(f.task, { parent: target }, source.revision);
  const removed = previewBody(await f.post({
    name: 'pm_remove_relation',
    arguments: { sourceId: f.task, targetId: target, relation: 'parent', revision: linked.revision, targetRevision: endpoint.revision },
    target: { workspaceId, projectId: f.project },
  }));
  assert.deepEqual({ before: field(removed, 'parent').before, after: field(removed, 'parent').after }, { before: target, after: null });
  assert.equal(f.workspace.get(f.task).revision, linked.revision);
}));

test('lifecycle previews describe archive, restore and permanent deletion without changing the source', () => withFixture(async f => {
  const current = f.workspace.get(f.task);
  const archive = previewBody(await f.post({
    name: 'pm_archive_task', arguments: { id: f.task, revision: current.revision }, target: { workspaceId, projectId: f.project },
  }));
  assert.deepEqual({ kind: archive.kind, before: field(archive, 'archived').before, after: field(archive, 'archived').after },
    { kind: 'archive', before: 'false', after: 'true' });
  assert.equal(f.workspace.get(f.task).revision, current.revision);

  const archived = await f.workspace.archive(f.task, current.revision);
  const restore = previewBody(await f.post({
    name: 'pm_restore_task', arguments: { id: f.task, revision: archived.revision }, target: { workspaceId, projectId: f.project },
  }));
  assert.deepEqual({ before: field(restore, 'archived').before, after: field(restore, 'archived').after }, { before: 'true', after: 'false' });

  const deletion = previewBody(await f.post({
    name: 'pm_delete_task', arguments: { id: f.task, revision: archived.revision }, target: { workspaceId, projectId: f.project },
  }));
  assert.equal(deletion.kind, 'delete');
  assert.match(deletion.summary, /Permanently delete/);
  assert.deepEqual({ before: field(deletion, 'deletion').before, after: field(deletion, 'deletion').after }, { before: 'false', after: 'true' });
  assert.equal(f.workspace.get(f.task).entity.archived, true);
}));

test('delete preview requires an archived task and points at permanent deletion', () => withFixture(async f => {
  const current = f.workspace.get(f.task);
  const response = await f.post({
    name: 'pm_delete_task', arguments: { id: f.task, revision: current.revision }, target: { workspaceId, projectId: f.project },
  });
  assert.equal(response.statusCode, 422);
  assert.equal(errorCode(response), 'DELETE_REQUIRES_ARCHIVE');
  assert.equal(f.workspace.get(f.task).revision, current.revision);
}));

test('transition preview defers to the workflow configuration and never calls the core', () => withFixture(async f => {
  const current = f.workspace.get(f.task);
  const planned = previewBody(await f.post({
    name: 'pm_transition_task',
    arguments: { id: f.task, revision: current.revision, status: 'in_progress' },
    target: { workspaceId, projectId: f.project },
  }));
  assert.deepEqual({ kind: planned.kind, before: field(planned, 'status').before, after: field(planned, 'status').after },
    { kind: 'status', before: 'todo', after: 'in_progress' });
  assert.equal(f.workspace.get(f.task).revision, current.revision);
  assert.equal(f.workspace.get(f.task).entity.status, 'todo');

  const unknown = await f.post({
    name: 'pm_transition_task',
    arguments: { id: f.task, revision: current.revision, status: 'imaginary' },
    target: { workspaceId, projectId: f.project },
  });
  assert.equal(unknown.statusCode, 422);
  assert.equal(errorCode(unknown), 'agent_tool_transition_not_allowed');
  assert.equal(f.workspace.get(f.task).revision, current.revision);
}));

test('read-only tools are not previewable', () => withFixture(async f => {
  for (const [name, args] of [
    ['pm_read', { id: f.task, bodyOffset: 0, bodyLimit: 200 }],
    ['pm_query', { entity: null, projectId: null, query: null, after: null, limit: 5 }],
  ] as const) {
    const response = await f.post({ name, arguments: args, target: { workspaceId, projectId: f.project } });
    assert.equal(response.statusCode, 400);
    assert.equal(errorCode(response), 'preview_not_supported');
  }
}));

test('unknown tools and unauthorized targets are rejected without leaking sources', () => withFixture(async f => {
  const unknown = await f.post({ name: 'pm_drop_task', arguments: {}, target: { workspaceId, projectId: null } });
  assert.equal(unknown.statusCode, 403);
  assert.equal(errorCode(unknown), 'agent_tool_not_available');

  f.allow(ALL_CAPABILITIES, [f.project]);
  const forbidden = await f.post({ name: 'pm_create_task',
    arguments: { projectId: f.other, title: 'Hidden task', description: '', assigneeId: null, priority: null, startDate: null, dueDate: null, labels: null },
    target: { workspaceId, projectId: f.other } });
  assert.equal(forbidden.statusCode, 404);
  assert.equal(errorCode(forbidden), 'not_found_or_forbidden');

  const workspaceScope = await f.post({ name: 'pm_create_task',
    arguments: { projectId: f.project, title: 'Hidden task', description: '', assigneeId: null, priority: null, startDate: null, dueDate: null, labels: null },
    target: { workspaceId, projectId: null } });
  assert.equal(workspaceScope.statusCode, 404);

  const missing = await f.post({ name: 'pm_create_task',
    arguments: { projectId: f.project, title: 'Hidden task', description: '', assigneeId: null, priority: null, startDate: null, dueDate: null, labels: null },
    target: { workspaceId } });
  assert.equal(missing.statusCode, 400);
  const mismatched = await f.post({ name: 'pm_update_task',
    arguments: { id: f.task, revision: f.workspace.get(f.task).revision, title: 'Forged', description: null, assigneeId: null, priority: null, startDate: null, dueDate: null, labels: null },
    target: { workspaceId: '0196c319-8b1d-7000-8000-000000000099', projectId: f.project } });
  assert.equal(mismatched.statusCode, 400);
  assert.equal(errorCode(mismatched), 'agent_tool_target_mismatch');
  assert.equal(f.workspace.get(f.task).entity.title, 'Preview task');
}));

test('a stale revision still previews current state and does not write', () => withFixture(async f => {
  const stale = f.workspace.get(f.task).revision;
  const changed = await f.workspace.patch(f.task, { title: 'Changed elsewhere' }, stale);
  const response = await f.post({
    name: 'pm_update_task',
    arguments: { id: f.task, revision: stale, title: 'Latest title', description: null, assigneeId: null, priority: null, startDate: null, dueDate: null, labels: null },
    target: { workspaceId, projectId: f.project },
  });
  const body = previewBody(response);
  assert.deepEqual({ before: field(body, 'title').before, after: field(body, 'title').after }, { before: 'Changed elsewhere', after: 'Latest title' });
  assert.equal(field(body, 'revision').before, changed.revision);
  const current = f.workspace.get(f.task);
  assert.equal(current.revision, changed.revision);
  assert.equal(current.entity.title, 'Changed elsewhere');
}));

test('a full preview batch leaves every workspace source untouched', () => withFixture(async f => {
  const before = f.snapshots();
  const target = { workspaceId, projectId: null };
  const current = f.workspace.get(f.task);
  for (const [name, args] of [
    ['pm_update_task', { id: f.task, revision: current.revision, title: 'Batch title', description: null, assigneeId: null, priority: 'low', startDate: null, dueDate: null, labels: null }],
    ['pm_create_project', { title: 'Batch project', description: '', goal: null }],
    ['pm_create_task', { projectId: f.project, title: 'Batch task', description: '', assigneeId: null, priority: null, startDate: null, dueDate: null, labels: null }],
    ['pm_create_comment', { projectId: f.project, taskId: f.task, content: 'Batch comment' }],
    ['pm_transition_task', { id: f.task, revision: current.revision, status: 'done' }],
    ['pm_archive_task', { id: f.task, revision: current.revision }],
  ] as const) {
    const response = await f.post({ name, arguments: args, target });
    assert.equal(response.statusCode, 200, `${name} preview should succeed`);
  }
  assert.deepEqual(f.snapshots(), before);
}));
