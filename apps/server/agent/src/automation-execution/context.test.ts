import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import type { StudioExecutionRequest } from '../../../../../packages/contracts/src/automation-studio.ts';
import type { ChatGeneration } from '../durable/chat-runtime.ts';
import { closeStore, listRecords, writeRecord } from '../durable/store.ts';
import { automationRequestFingerprint, automationRequestForNativeGeneration, registerAutomationNativeThread } from './context.ts';
import { openAutomationGenerationConnectors } from './connectors.ts';
let directory: string;
const originalData = process.env.AGENT_WORKSPACE_DATA_DIR;
beforeEach(async () => { directory = await mkdtemp(path.join(tmpdir(), 'pm-automation-bindings-')); process.env.AGENT_WORKSPACE_DATA_DIR = directory; });
afterEach(async () => { closeStore(); if (originalData === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = originalData; await rm(directory, { recursive: true, force: true }); });
function fixture() {
  const request: StudioExecutionRequest = { executionId: '11111111-1111-4111-8111-111111111111', requestId: '22222222-2222-4222-8222-222222222222', actorId: '33333333-3333-4333-8333-333333333333', workspaceId: '44444444-4444-4444-8444-444444444444', projectId: 'PRJ-001', definitionId: '55555555-5555-4555-8555-555555555555', definitionRevision: 1, config: { name: 'Template fixture', description: '', projectId: 'PRJ-001', tags: [], templateId: 'news-digest', action: { kind: 'template', templateId: 'news-digest', arguments: {}, providerInstanceId: 'fixture-provider', model: 'fixture-model', options: {}, plugins: [{ id: 'integration:66666666-6666-4666-8666-666666666666', version: '1' }], repositories: [], timeoutSeconds: 30 }, trigger: { kind: 'manual' }, dailyLimit: 1, cooldownMinutes: 0 }, trigger: 'test', payload: null, issuedAt: '2026-10-31T00:00:00.000Z' };
  const generation: ChatGeneration = { id: '77777777-7777-4777-8777-777777777777', threadId: 'native-child-fixture', messageId: 'native-message-fixture', parentId: null, status: 'running', createdAt: request.issuedAt, seq: 0, request: { id: 'native-child-fixture', idempotencyKey: 'template-child:fixture', messages: [] }, providerInstanceId: 'fixture-provider', providerInstanceRevision: 1, modelId: 'fixture-model', temperature: 0, executionSnapshot: { scope: { workspaceId: request.workspaceId, projectId: request.projectId }, workspaceName: 'Fixture', projectName: 'Fixture', path: directory } };
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
  assert.equal(automationRequestForNativeGeneration({ ...generation, request: { ...generation.request, idempotencyKey: 'guessed-other-key' } }), null);
  const binding = listRecords<Record<string, unknown>>('pm-automation:native-thread-bindings')[0]!;
  assert.deepEqual(Object.keys(binding).sort(), ['executionId', 'fingerprint', 'idempotencyKey', 'threadId']);
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
