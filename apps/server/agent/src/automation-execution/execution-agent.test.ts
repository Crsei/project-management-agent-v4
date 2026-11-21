import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import type { StudioExecutionRequest } from '../../../../../packages/contracts/src/automation-studio.ts';
import { defaultCollaborationResourceLimits } from '../../../../../packages/agent-contracts/src/collaboration.ts';
import { createAgentDefinition, updateAgentDefinition } from '../collaboration/definitions.ts';
import { closeStore } from '../durable/store.ts';
import { automationExecutionAgentInstructions } from './execution-agent.ts';

let directory: string;
const originalData = process.env.AGENT_WORKSPACE_DATA_DIR;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'automation-agent-pin-'));
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
});
afterEach(async () => {
  closeStore();
  if (originalData === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = originalData;
  await rm(directory, { recursive: true, force: true });
});

const workspaceId = '44444444-4444-4444-8444-444444444444';
const actorId = '33333333-3333-4333-8333-333333333333';
const request = (providerInstanceId: string, model: string): StudioExecutionRequest => ({
  executionId: '11111111-1111-4111-8111-111111111111', requestId: '22222222-2222-4222-8222-222222222222', actorId,
  workspaceId, projectId: 'PRJ-001', definitionId: '55555555-5555-4555-8555-555555555555', definitionRevision: 1,
  config: {
    name: 'Pinned Agent request', description: '', projectId: 'PRJ-001', tags: [], templateId: 'pm-requirement-review',
    templateVersion: '1.0.0', templateInputs: {}, executionAgent: { id: 'reviewer', version: 1 },
    action: { kind: 'template', templateId: 'pm-requirement-review', arguments: {}, providerInstanceId, model, options: {}, repositories: [], plugins: [], timeoutSeconds: 60 },
    trigger: { kind: 'manual' }, dailyLimit: 1, cooldownMinutes: 0,
  },
  trigger: 'test', payload: null, issuedAt: '2026-11-21T00:00:00.000Z',
});
function agent(executionMode: 'read-only' | 'write' = 'read-only', project = 'PRJ-001') {
  return createAgentDefinition({ requestId: 'create-agent', id: 'reviewer', workspaceId, config: {
    name: 'Requirement reviewer', role: 'Reviewer', instructions: 'Check acceptance criteria against evidence.', providerInstanceId: 'provider-a', model: 'model-a',
    modelOptions: [], interactionMode: 'default', temperature: 0, owner: { label: 'Fixture', actorId: null }, allowedProjectIds: [project],
    capabilityBindings: { restriction: 'observe', mcp: [], skills: [], hostTools: [] }, resourceLimits: { ...defaultCollaborationResourceLimits }, executionMode,
  } }, { workspaceId, actorId });
}

test('a pinned read-only Agent contributes bounded instructions only for its frozen identity', () => {
  agent();
  assert.equal(automationExecutionAgentInstructions(request('provider-a', 'model-a')), 'Check acceptance criteria against evidence.');
});
test('pin mismatch, non-read-only Agents and unauthorized projects fail closed', () => {
  agent('read-only', 'PRJ-999');
  assert.throws(() => automationExecutionAgentInstructions(request('provider-a', 'model-a')), /project-reference ceiling|outside/);
});
test('a changed Agent model cannot silently replace the frozen automation identity', () => {
  const created = agent();
  updateAgentDefinition('reviewer', { requestId: 'update-agent', revision: created.revision, config: { ...created.config, model: 'model-b' } }, { workspaceId, actorId });
  const pinned = request('provider-a', 'model-a');
  pinned.config.executionAgent = { id: 'reviewer', version: 2 };
  assert.throws(() => automationExecutionAgentInstructions(pinned), /no longer matches/);
});
test('write-capable Agents are rejected for read-only automation', () => {
  agent('write');
  assert.throws(() => automationExecutionAgentInstructions(request('provider-a', 'model-a')), /read-only/);
});
