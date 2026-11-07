import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import type { StudioExecutionRequest } from '../../../../../packages/contracts/src/automation-studio.ts';
import type { ChatGeneration } from '../durable/chat-runtime.ts';
import { closeStore, listRecords, writeRecord } from '../durable/store.ts';
import { automationRequestFingerprint, automationRequestForNativeGeneration, authorizeAutomationNativeThreadExecution, getNativeGenerationPmTargetCeiling, registerAutomationNativeThread } from './context.ts';
import { openAutomationGenerationConnectors } from './connectors.ts';
import { chatOnlyEnvironment } from '../durable/execution.testkit.ts';
import { openAgentWorkspace } from '../agent-workspaces.ts';
import { resolveAgentExecution } from '../durable/agent-execution.ts';
let directory: string;
const originalData = process.env.AGENT_WORKSPACE_DATA_DIR, originalRoots = process.env.AGENT_WORKSPACE_ALLOWED_ROOTS, originalSecret = process.env.PM_AUTOMATION_SERVICE_SECRET, originalFetch = globalThis.fetch;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'pm-automation-bindings-'));
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
  process.env.AGENT_WORKSPACE_ALLOWED_ROOTS = JSON.stringify([directory]);
  process.env.PM_AUTOMATION_SERVICE_SECRET = 'fixture-only-automation-service-secret-32-bytes';
});
afterEach(async () => {
  closeStore(); globalThis.fetch = originalFetch;
  if (originalData === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = originalData;
  if (originalRoots === undefined) delete process.env.AGENT_WORKSPACE_ALLOWED_ROOTS; else process.env.AGENT_WORKSPACE_ALLOWED_ROOTS = originalRoots;
  if (originalSecret === undefined) delete process.env.PM_AUTOMATION_SERVICE_SECRET; else process.env.PM_AUTOMATION_SERVICE_SECRET = originalSecret;
  await rm(directory, { recursive: true, force: true });
});
function fixture() {
  const request: StudioExecutionRequest = { executionId: '11111111-1111-4111-8111-111111111111', requestId: '22222222-2222-4222-8222-222222222222', actorId: '33333333-3333-4333-8333-333333333333', workspaceId: '44444444-4444-4444-8444-444444444444', projectId: 'PRJ-001', definitionId: '55555555-5555-4555-8555-555555555555', definitionRevision: 1, config: { name: 'Template fixture', description: '', projectId: 'PRJ-001', tags: [], templateId: 'news-digest', action: { kind: 'template', templateId: 'news-digest', arguments: {}, providerInstanceId: 'fixture-provider', model: 'fixture-model', options: {}, plugins: [{ id: 'integration:66666666-6666-4666-8666-666666666666', version: '1' }], repositories: [], timeoutSeconds: 30 }, trigger: { kind: 'manual' }, dailyLimit: 1, cooldownMinutes: 0 }, trigger: 'test', payload: null, issuedAt: '2026-10-31T00:00:00.000Z' };
  const generation: ChatGeneration = { id: '77777777-7777-4777-8777-777777777777', threadId: 'native-child-fixture', messageId: 'native-message-fixture', parentId: null, status: 'running', createdAt: request.issuedAt, seq: 0, request: { id: 'native-child-fixture', idempotencyKey: 'template-child:fixture', messages: [] }, providerInstanceId: 'fixture-provider', providerInstanceRevision: 1, modelId: 'fixture-model', temperature: 0, executionSnapshot: { path: directory, environment: chatOnlyEnvironment() } };
  const record = { request, fingerprint: automationRequestFingerprint(request), phase: 'running' };
  return { request, generation, record };
}
test('native association requires a durable immutable execution and exact pre-registered submission identity', () => {
  const { request, generation, record } = fixture();
  assert.equal(automationRequestForNativeGeneration(generation), null);
  assert.throws(() => registerAutomationNativeThread(request, generation.threadId, generation.request.idempotencyKey!), /absent/);
  writeRecord('pm-automation:executions', request.executionId, record);
  registerAutomationNativeThread(request, generation.threadId, generation.request.idempotencyKey!);
  assert.deepEqual(automationRequestForNativeGeneration(generation), request);
  assert.deepEqual(getNativeGenerationPmTargetCeiling(generation), { workspaceId: request.workspaceId, projectId: request.projectId });
  assert.equal(getNativeGenerationPmTargetCeiling({ ...generation, request: { ...generation.request, idempotencyKey: 'caller-chosen' } }), undefined);
  assert.equal(automationRequestForNativeGeneration({ ...generation, request: { ...generation.request, idempotencyKey: 'guessed-other-key' } }), null);
  const binding = listRecords<Record<string, unknown>>('pm-automation:native-thread-bindings')[0]!;
  assert.deepEqual(Object.keys(binding).sort(), ['executionId', 'executionVersion', 'fingerprint', 'idempotencyKey', 'threadId']);
  const changed = structuredClone(request); changed.config.name = 'Different request';
  assert.throws(() => registerAutomationNativeThread(changed, generation.threadId, generation.request.idempotencyKey!), /different automation execution/);
});
test('terminal child identity remains identifiable for deny rules but cannot admit new native turns', () => {
  const { request, generation, record } = fixture();
  writeRecord('pm-automation:executions', request.executionId, record);
  registerAutomationNativeThread(request, generation.threadId, generation.request.idempotencyKey!);
  writeRecord('pm-automation:executions', request.executionId, { ...record, phase: 'finished' });
  assert.deepEqual(automationRequestForNativeGeneration(generation), request);
  assert.throws(() => registerAutomationNativeThread(request, generation.threadId, 'new-child'), /terminal/);
});
test('native template scratch descriptors require the original service identity before any tool admission', async () => {
  const { request, generation, record } = fixture();
  writeRecord('pm-automation:executions', request.executionId, record);
  registerAutomationNativeThread(request, generation.threadId, generation.request.idempotencyKey!);
  let authorizations = 0;
  await assert.rejects(openAutomationGenerationConnectors(generation, undefined, async () => { authorizations++; }), /original, currently authorized PM service execution/);
  assert.equal(authorizations, 0);
});
test('delivery tool ceiling requires its server receipt and exact accepted generation key, not custom or unrelated receipt', () => {
  const { request, generation } = fixture();
  writeRecord('task-code-delivery-v1', 'delivery', { threadId: generation.threadId, generationKey: generation.request.idempotencyKey, workspaceId: request.workspaceId, projectId: request.projectId });
  assert.deepEqual(getNativeGenerationPmTargetCeiling(generation), { workspaceId: request.workspaceId, projectId: request.projectId });
  assert.equal(getNativeGenerationPmTargetCeiling({ ...generation, threadId: 'ordinary-session' }), undefined);
  assert.equal(getNativeGenerationPmTargetCeiling({ ...generation, request: { ...generation.request, idempotencyKey: 'different-turn' } }), undefined);
});
test('native execution reauthorizes only its immutable PM operation while inspection and ordinary Sessions stay independent', async () => {
  const { request, generation } = fixture(), workspace = openAgentWorkspace({ path: directory });
  const selection = { version: 2 as const, agentWorkspaceId: workspace.id, agentWorkspaceRevision: workspace.revision };
  request.config.action.executionSelection = selection;
  const snapshot = await resolveAgentExecution(selection);
  writeRecord('pm-automation:executions', request.executionId, { request, fingerprint: automationRequestFingerprint(request), phase: 'running' });
  registerAutomationNativeThread(request, generation.threadId, generation.request.idempotencyKey!);
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    calls++; assert.ok(String(input).endsWith('/agent-contexts/authorize'));
    assert.deepEqual(JSON.parse(String(init?.body)), { workspaceId: request.workspaceId, projectId: request.projectId });
    return Response.json({ actorId: request.actorId, scope: { workspaceId: request.workspaceId, projectId: request.projectId }, workspaceName: 'PM', projectName: 'Target' });
  };
  await authorizeAutomationNativeThreadExecution(generation.threadId, snapshot, 'inspect');
  await authorizeAutomationNativeThreadExecution('ordinary-session', snapshot, 'execute');
  assert.equal(calls, 0);
  await authorizeAutomationNativeThreadExecution(generation.threadId, snapshot, 'execute');
  assert.equal(calls, 1);
  globalThis.fetch = async () => new Response('', { status: 403 });
  await assert.rejects(authorizeAutomationNativeThreadExecution(generation.threadId, snapshot, 'execute'), /PM/);
  await authorizeAutomationNativeThreadExecution(generation.threadId, snapshot, 'inspect');
  const binding = listRecords<Record<string, unknown>>('pm-automation:native-thread-bindings')[0]!;
  delete binding.executionVersion;
  writeRecord('pm-automation:native-thread-bindings', JSON.stringify([generation.threadId, generation.request.idempotencyKey]), binding);
  assert.equal(automationRequestForNativeGeneration(generation), null);
  await assert.rejects(authorizeAutomationNativeThreadExecution(generation.threadId, snapshot, 'execute'), /Historical/);
});
test('accepted native continuations inherit the original PM ceiling; unlinked continuation claims cannot widen authority', () => {
  const { request, generation, record } = fixture();
  writeRecord('pm-automation:executions', request.executionId, record);
  registerAutomationNativeThread(request, generation.threadId, generation.request.idempotencyKey!);
  writeRecord('chat:generations', generation.id, { ...generation, continuationId: 'accepted-continuation' });
  const continued = { ...generation, id: 'accepted-continuation', continuationOf: generation.id, request: { ...generation.request, idempotencyKey: 'continue-original' } };
  assert.deepEqual(getNativeGenerationPmTargetCeiling(continued), { workspaceId: request.workspaceId, projectId: request.projectId });
  assert.equal(getNativeGenerationPmTargetCeiling({ ...continued, id: 'unaccepted-continuation' }), undefined);
});
