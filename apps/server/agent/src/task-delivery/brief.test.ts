import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import type { TaskBrief, TaskBriefStage } from '@agent-workspace/contracts/task-brief';
import type { TaskCodeDelivery } from '../../../../../packages/contracts/src/task-code-delivery.ts';
import type { TaskExecutionBrief } from '../../../../../packages/contracts/src/task-execution-brief.ts';
import { openAgentWorkspace } from '../agent-workspaces.ts';
import { closeStore, writeRecord } from '../durable/store.ts';
import { CHAT_FORMAT, ensureThread, getThread, getThreadBranch, saveFormattedMessage } from '../durable/threads.ts';
import { listChatGenerations } from '../durable/chat-runtime.ts';
import { deliveryStore } from './binding.ts';
import { git, prepareWorktree, readTree } from './git.ts';
import { createDeliverySession, deliveryService, taskDeliveryRoutes } from './index.ts';
import { deliveryGeneration, readTaskExecutionBrief, taskExecutionInput, taskExecutionPrompt } from './brief.ts';

const env = { data: process.env.AGENT_WORKSPACE_DATA_DIR, roots: process.env.AGENT_WORKSPACE_ALLOWED_ROOTS };
const originalFetch = globalThis.fetch;
const scope = { workspaceId: '11111111-1111-4111-8111-111111111111', projectId: 'PRJ-001', taskId: 'TASK-001' };
const revision = 'a'.repeat(64), at = '2026-11-12T00:00:00.000Z';
const headers = new Headers({ cookie: 'fixture-session' });
let root = '', repository = '', currentRevision = revision, denied = false, knowledgeDenied = false;
let value: TaskCodeDelivery;
let includeCrossProjectSource = false;
const calls: string[] = [];
function pmBrief(stage: TaskBriefStage): TaskBrief {
  const source = { workspaceId: scope.workspaceId, projectId: scope.projectId, entityId: scope.taskId, kind: 'work_item' as const, revision: currentRevision, title: 'Current task', location: { type: 'field' as const, path: 'body' } };
  return { schemaVersion: 1, stage, generatedAt: at, task: { ...scope, revision: currentRevision, title: 'Current task', body: 'Current acceptance and constraints', bodyOffset: 0, bodyLength: 34, nextBodyOffset: null },
    goals: [{ text: 'Current goal', sourceRefs: [source] }], acceptanceCriteria: [{ text: 'Preserve the current acceptance', sourceRefs: [source] }],
    constraints: [{ text: 'No publication', sourceRefs: [source] }], nonGoals: [], relations: [], guidance: [`phase:${stage}`],
    sources: includeCrossProjectSource && !knowledgeDenied ? [source, { ...source, projectId: 'PRJ-002', entityId: 'DOC-001', kind: 'document', title: 'Private cross-project source' }] : [source], gaps: [],
    truncation: { truncated: false, body: false, statements: false, relations: false, message: null }, dispatchable: true, authorityNotice: 'Read-only PM facts, not authority' };
}
before(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'task-guidance-')));
  repository = path.join(root, 'repo'); await mkdir(repository);
  process.env.AGENT_WORKSPACE_DATA_DIR = path.join(root, 'agent-data');
  process.env.AGENT_WORKSPACE_ALLOWED_ROOTS = JSON.stringify([root]);
  const workspace = openAgentWorkspace({ path: repository });
  await git(repository, 'init', '-b', 'main'); await git(repository, 'config', 'user.name', 'Fixture'); await git(repository, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(path.join(repository, 'index.txt'), 'original'); await git(repository, 'add', 'index.txt'); await git(repository, 'commit', '-m', 'fixture');
  await git(repository, 'remote', 'add', 'origin', 'https://github.com/example/fixture.git');
  value = { ...scope, id: '22222222-2222-4222-8222-222222222222', baseBranch: 'main', taskRevision: revision, title: 'Original title', description: 'Original task body',
    createdAt: at, updatedAt: at, step: 'tested', version: 1, threadId: 'original-session', executionSelection: { version: 2, agentWorkspaceId: workspace.id, agentWorkspaceRevision: workspace.revision } };
  value.git = await prepareWorktree(value, repository, 'main', (cwd, ...args) => args[0] === 'fetch' ? git(cwd, '-c', 'protocol.file.allow=always', 'fetch', '--no-tags', repository, 'refs/heads/main') : git(cwd, ...args));
  const tree = await readTree(value);
  value.test = { command: 'fixture-command', fingerprint: tree.fingerprint, head: tree.head, taskRevision: revision, passed: true, exitCode: 0, outputDigest: 'digest', at };
  deliveryStore.save(value);
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input)); calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    if (url.pathname.includes('/core/files/')) return denied ? new Response('', { status: 403 }) : Response.json({ id: scope.taskId, revision: currentRevision, entity: { entity: 'work_item', project: scope.projectId, title: 'Current task', body: 'Current acceptance and constraints' } });
    if (url.pathname.endsWith('/brief')) return Response.json(pmBrief(url.searchParams.get('stage') as TaskBriefStage));
    if (url.pathname.endsWith('/agent-capabilities')) return Response.json({ scope: { kind: 'projects', projectIds: ['PRJ-001'] }, tools: [{ name: 'pm_update_task', description: 'update', write: true, capabilities: ['planning.edit'], allowed: true, denyReason: null }] });
    if (url.pathname.endsWith('/agent-contexts/authorize')) {
      const body = JSON.parse(String(init?.body)) as { workspaceId: string; projectId: string };
      if (knowledgeDenied && body.projectId === 'PRJ-002') return new Response('', { status: 403 });
      return Response.json({ actorId: '33333333-3333-4333-8333-333333333333', scope: body });
    }
    throw new Error(`Unexpected external effect: ${url.pathname}`);
  };
});
after(async () => {
  globalThis.fetch = originalFetch; closeStore();
  if (env.data === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = env.data;
  if (env.roots === undefined) delete process.env.AGENT_WORKSPACE_ALLOWED_ROOTS; else process.env.AGENT_WORKSPACE_ALLOWED_ROOTS = env.roots;
  await rm(root, { recursive: true, force: true });
});
test('real local Git and four-stage HTTP brief reads never create Sessions, mutate receipts or replay unknown push', async () => {
  const record = deliveryStore.read(value.id)!; record.pending = { action: 'push', at, head: record.test!.head!, fingerprint: record.test!.fingerprint }; record.version++; deliveryStore.save(record);
  const before = deliveryStore.read(value.id);
  const app = new Hono().route('/api', taskDeliveryRoutes);
  for (const stage of ['analysis', 'development', 'review', 'recovery'] as const) {
    const response = await app.request(`/api/task-deliveries/${value.id}/brief?stage=${stage}`, { headers });
    assert.equal(response.status, 200); const brief: TaskExecutionBrief = await response.json();
    assert.equal(brief.stage, stage); assert.equal(brief.currentTask.guidance[0], `phase:${stage}`);
    assert.equal(brief.evidence[0]!.status, 'passed'); assert.equal(brief.operations[0]!.identity, `${value.id}:push:${at}`);
    assert.match(brief.operations[0]!.nextStep, /不要再次 push/);
  }
  assert.deepEqual(deliveryStore.read(value.id), before);
  assert.equal(getThread(value.threadId), null); assert.deepEqual(listChatGenerations(value.threadId), []);
  assert.ok(calls.every(call => call.startsWith('GET ')));
  const invalid = await app.request(`/api/task-deliveries/${value.id}/brief?stage=invalid`, { headers }); assert.equal(invalid.status, 400);
  const restored = deliveryStore.read(value.id)!; delete restored.pending; restored.version++; deliveryStore.save(restored);
});
test('current PM revocation hides old private content and directory identity change fails closed', async () => {
  const app = new Hono().route('/api', taskDeliveryRoutes);
  denied = true;
  const response = await app.request(`/api/task-deliveries/${value.id}/brief?stage=recovery`, { headers });
  assert.equal(response.status, 403); assert.doesNotMatch(await response.text(), /Original task body|Current acceptance/); denied = false;
  const record = deliveryStore.read(value.id)!, identity = record.git!.directoryIdentity;
  record.git!.directoryIdentity = 'changed'; record.version++; deliveryStore.save(record);
  assert.equal((await app.request(`/api/task-deliveries/${value.id}/brief?stage=recovery`, { headers })).status, 409);
  record.git!.directoryIdentity = identity; record.version++; deliveryStore.save(record);
});
test('changed requirements and worktree edits make old verification stale, not passed', async () => {
  currentRevision = 'd'.repeat(64);
  let brief = await readTaskExecutionBrief(value.id, 'recovery', headers);
  assert.equal(brief.taskVersion.changed, true); assert.equal(brief.originalTask.revision, revision); assert.equal(brief.evidence[0]!.status, 'stale');
  currentRevision = revision;
  await writeFile(path.join(value.git!.directory, 'index.txt'), 'changed');
  brief = await readTaskExecutionBrief(value.id, 'review', headers); assert.equal(brief.evidence[0]!.status, 'stale');
  await writeFile(path.join(value.git!.directory, 'index.txt'), 'original');
});
test('unavailable current Git becomes unknown rather than recycling a previous passed test', async () => {
  const previousPath = process.env.PATH; process.env.PATH = '/nonexistent-task-guidance-git';
  try {
    const brief = await readTaskExecutionBrief(value.id, 'review', headers, false);
    assert.equal(brief.repository.status, 'unknown');
    assert.deepEqual(brief.evidence.map(evidence => evidence.status), ['unknown', 'unknown', 'unknown']);
  } finally { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; }
});
test('actual prompt inputs differ by phase, retain all constraints and sources, and reject incomplete or oversized dispatch', async () => {
  const texts = new Set<string>();
  for (const stage of ['analysis', 'development', 'review', 'recovery'] as const) {
    const brief = await readTaskExecutionBrief(value.id, stage, headers, false);
    const text = taskExecutionPrompt(brief, 'Node-specific restriction', { driver: 'omp', providerInstanceId: 'real-omp', instanceRevision: 7,
      capabilities: { nativeResume: true, nativeFork: false, boundedFork: false, modelTransition: 'portable', portableHandoff: true } });
    texts.add(text); assert.match(text, /Preserve the current acceptance/); assert.match(text, /No publication/); assert.match(text, /Node-specific restriction/);
    assert.match(text, /OMP Skill 调用禁用/); assert.match(text, /安装.*不等于/); assert.match(text, /"nativeFork":false/);
    const message = taskExecutionInput(brief, text), part = message.parts[0];
    assert.equal(message.role, 'user'); assert.equal(part && 'text' in part ? part.text : undefined, text);
  }
  assert.equal(texts.size, 4);
  const brief = await readTaskExecutionBrief(value.id, 'development', headers, false);
  brief.currentTask.dispatchable = false; assert.throws(() => taskExecutionPrompt(brief, ''), { code: 'task_brief_incomplete' });
  brief.currentTask.dispatchable = true; assert.throws(() => taskExecutionPrompt(brief, 'x'.repeat(50_000)), { code: 'task_brief_too_large' });
});
test('explicit replacement persists a trusted recovery input, not old chat, and changed requirement still forbids execution', async () => {
  ensureThread(value.threadId, 'Original', value.executionSelection);
  saveFormattedMessage(value.threadId, { id: 'old-chat', parent_id: null, format: CHAT_FORMAT, content: { role: 'assistant', parts: [{ type: 'text', text: 'UNTRUSTED_OLD_CHAT_SENTINEL' }] } }, true);
  currentRevision = 'e'.repeat(64); includeCrossProjectSource = true;
  const replacement = await deliveryService(headers).act(value.id, { action: 'new-session', executionSelection: value.executionSelection!, confirm: true });
  await createDeliverySession(replacement, headers); await createDeliverySession(replacement, headers);
  const branch = getThreadBranch(replacement.threadId);
  assert.equal(branch.length, 1);
  const parts = branch[0]!.content.parts; assert.ok(Array.isArray(parts));
  const text = parts.flatMap(part => typeof part?.text === 'string' ? [part.text] : []).join('\n');
  assert.match(text, /原收据与当前观察派生/); assert.match(text, /Original task body/); assert.match(text, /Current acceptance/); assert.match(text, /重新规划/);
  assert.doesNotMatch(text, /UNTRUSTED_OLD_CHAT_SENTINEL/);
  assert.deepEqual(listChatGenerations(replacement.threadId), []);
  assert.equal(replacement.taskRevision, revision); assert.equal(replacement.description, 'Original task body');
  await assert.rejects(deliveryService(headers).act(value.id, { action: 'develop', providerInstanceId: 'unused', model: 'unused' }), { code: 'task_changed' });
  let brief = await readTaskExecutionBrief(value.id, 'recovery', headers);
  assert.equal(brief.history.sentInputs.length, 1); assert.equal(brief.history.sentInputs[0]!.generationId, null);
  assert.equal(brief.history.sentInputs[0]!.status, 'persisted_handoff');
  knowledgeDenied = true;
  brief = await readTaskExecutionBrief(value.id, 'recovery', headers);
  assert.equal(brief.history.sentInputs.length, 0, 'revoked relation-source content is removed by the existing history projection');
  assert.doesNotMatch(JSON.stringify(brief), /Private cross-project source/);
  knowledgeDenied = false; includeCrossProjectSource = false; currentRevision = revision;
});
test('unrelated generations without a delivery key are never claimed as original execution evidence', () => {
  const record = deliveryStore.read(value.id)!;
  writeRecord('chat:generations', 'unrelated-generation', { id: 'unrelated-generation', threadId: record.threadId, status: 'completed', request: {} });
  assert.equal(deliveryGeneration(record), null);
});
