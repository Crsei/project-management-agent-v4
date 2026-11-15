import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProjectManagementClient, ApiError } from '../src/client.ts';
import { taskBriefPaths } from '../src/task-brief-openapi.ts';
import { taskBriefQuerySchema, taskKnowledgeQuerySchema } from '../../agent-contracts/src/task-brief.ts';
import { AGENT_CHAT_TOOL_REGISTRY, parseAgentChatToolInput } from '../../application/src/agent-chat-tools.ts';

const workspaceId = '33333333-3333-4333-8333-333333333333', revision = 'a'.repeat(64);
test('Task Brief client uses explicit revision, stage, project set and original authentication without writes', async () => {
  const requests: { url: URL; init: RequestInit | undefined }[] = [];
  const client = new ProjectManagementClient({ baseUrl: 'http://pm.example.test', auth: { type: 'bearer', token: 'test-opaque-bearer' },
    fetch: async (input, init) => { requests.push({ url: new URL(String(input)), init }); return Response.json({ readOnly: true }); } });
  const signal = new AbortController().signal;
  await client.taskBrief(workspaceId, 'PRJ-001', 'TASK-001', { revision, stage: 'review', bodyOffset: 0, bodyLimit: 1200 }, { signal });
  await client.searchTaskKnowledge(workspaceId, 'PRJ-001', 'TASK-001', { revision, query: 'literal policy', projectIds: ['PRJ-001', 'PRJ-002'], limit: 2, cursor: 'opaque+cursor' }, { signal });
  assert.equal(requests[0]!.url.pathname, `/api/v1/workspaces/${workspaceId}/projects/PRJ-001/tasks/TASK-001/brief`);
  assert.equal(requests[0]!.url.searchParams.get('stage'), 'review'); assert.equal(requests[0]!.url.searchParams.get('revision'), revision);
  assert.equal(requests[0]!.url.searchParams.get('bodyLimit'), '1200');
  assert.equal(requests[1]!.url.pathname, `/api/v1/workspaces/${workspaceId}/projects/PRJ-001/tasks/TASK-001/knowledge`);
  assert.equal(requests[1]!.url.searchParams.get('query'), 'literal policy');
  assert.equal(requests[1]!.url.searchParams.get('projectIds'), 'PRJ-001,PRJ-002'); assert.equal(requests[1]!.url.searchParams.get('cursor'), 'opaque+cursor');
  for (const request of requests) { assert.equal(request.init?.method, 'GET'); assert.equal(request.init?.signal, signal); assert.equal(new Headers(request.init?.headers).get('Authorization'), 'Bearer test-opaque-bearer'); assert.equal(request.init?.body, undefined); }
  await client.searchTaskKnowledge(workspaceId, 'PRJ-001', 'TASK-001', { revision, query: 'own project' });
  assert.equal(requests[2]!.url.searchParams.has('projectIds'), false);
});

test('brief client preserves unauthorized and conflict errors rather than returning empty knowledge', async () => {
  for (const [status, code] of [[401, 'unauthenticated'], [403, 'permission_denied'], [404, 'not_found_or_forbidden'], [409, 'task_brief_revision_conflict']] as const) {
    const client = new ProjectManagementClient({ baseUrl: 'http://pm.example.test', auth: { type: 'none' }, fetch: async () => Response.json({ error: { code } }, { status }) });
    await assert.rejects(client.taskBrief(workspaceId, 'PRJ-001', 'TASK-001', { revision, stage: 'analysis' }), (error: unknown) => error instanceof ApiError && error.status === status && error.code === code);
  }
});

test('brief and knowledge wire definitions require revisions and bounded explicit scopes; PM tools are genuinely read-only', () => {
  assert.equal(taskBriefQuerySchema.safeParse({ stage: 'analysis' }).success, false);
  assert.equal(taskBriefQuerySchema.safeParse({ revision, stage: 'other' }).success, false);
  assert.equal(taskKnowledgeQuerySchema.safeParse({ revision, query: 'q', projectIds: [] }).success, false);
  assert.equal(taskKnowledgeQuerySchema.safeParse({ revision, query: 'q', limit: 21 }).success, false);
  assert.equal(taskKnowledgeQuerySchema.safeParse({ revision, query: 'q', workspaceId }).success, false);
  for (const name of ['pm_task_brief', 'pm_search_knowledge'] as const) {
    const definition = AGENT_CHAT_TOOL_REGISTRY.find(tool => tool.name === name)!;
    assert.equal(definition.write, false); assert.deepEqual(definition.capabilities, ['domain.read']);
  }
  assert.throws(() => parseAgentChatToolInput('pm_task_brief', { projectId: 'PRJ-001', taskId: 'TASK-001', revision, stage: 'analysis', bodyOffset: null, bodyLimit: null, approved: true }));
  const paths = taskBriefPaths();
  assert.equal(Object.keys(paths).length, 2);
  for (const path of Object.values(paths)) { assert.ok(path.get); assert.equal(Object.keys(path).join(','), 'get'); assert.ok(path.get.parameters.some(parameter => parameter.name === 'revision' && parameter.required)); }
});
