import test from 'node:test';
import assert from 'node:assert/strict';
import { BenchEventSchema, FixtureManifestSchema, RunResultSchema, TaskDefinitionSchema } from './types.ts';
import { parseBenchmarkConfig, repositoryRoot } from '../benchmark.config.ts';

const task = { id: 'K02', title: 'Historical decision tracing', taskVersion: '0.1.0', fixtureVersion: '0.1.0', category: 'knowledge', instruction: 'Read dated decisions and preserve history.', budget: { maxDurationMinutes: 5, maxModelCalls: 10, maxToolCalls: 20 }, targetKeys: [], inputs: ['docs/source.md'], acceptanceCriteria: ['Citations support the current decision'], smoke: true, allowedTools: ['read'], allowedTargets: [], phases: [{ id: 'research', instruction: 'Inspect sources.', requiredEvidence: ['answer.json'] }], interventions: [], hiddenGrader: 'task:K02' };
const result = { runId: 'run', taskId: 'K02', taskVersion: '0.1.0', fixtureVersion: '0.1.0', arm: 'raw', agent: 'real-chat', model: 'explicit-pinned-model', success: false, safetyGate: { passed: false, checks: [], violations: ['provider-unconfigured'] }, checkpointScore: 0, phaseResults: [], usage: { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null, modelCalls: null, toolCalls: null }, timeMs: 0, unexpectedMutations: [], artifacts: {}, reproducibility: { fixtureId: 'independent', fixtureSemanticHash: 'semantic', modelConfigHash: 'model', budgetHash: 'budget', permissionsHash: 'permissions' }, failure: { category: 'provider', message: 'Explicit provider prerequisite missing', evidence: [] } };

test('task validation preserves execution metadata and rejects impossible phase transitions', () => {
  const parsed = TaskDefinitionSchema.parse(task);
  assert.equal(parsed.title, task.title); assert.equal(parsed.smoke, true);
  assert.deepEqual(parsed.inputs, task.inputs); assert.equal(parsed.phases[0]?.instruction, task.phases[0]?.instruction);
  assert.throws(() => TaskDefinitionSchema.parse({ ...task, phases: [task.phases[0], task.phases[0]] }), /unique/);
  assert.throws(() => TaskDefinitionSchema.parse({ ...task, interventions: [{ afterPhase: 'absent', action: 'interrupt', trigger: 'authority' }] }), /existing phase/);
});
test('unknown metrics remain null and unsafe/ungrounded success cannot be serialized as verified', () => {
  const parsed = RunResultSchema.parse(result);
  assert.equal(parsed.usage.modelCalls, null); assert.equal(parsed.usage.costUsd, null);
  assert.equal(parsed.humanInterventions.count, null); assert.equal(parsed.rework.denominator, null); assert.equal(parsed.rework.proportion, null);
  assert.throws(() => RunResultSchema.parse({ ...result, success: true }), /Verified success/);
});
test('fixture manifests require actual entity revisions and events retain trusted execution identities', () => {
  assert.throws(() => FixtureManifestSchema.parse({ fixtureVersion: 'v', workspaceId: 'owned', targets: { issue: { key: 'issue', workspaceId: 'owned', projectId: 'PRJ-001', entityId: 'TASK-001', kind: 'work_item' } } }));
  const event = BenchEventSchema.parse({ id: 'event', timestamp: '2026-11-10T00:00:00Z', runId: 'run', taskId: 'L02', type: 'receipt_reconciled', source: 'transport', threadId: 'new-session', generationId: 'new-generation', operationId: 'original-operation', commandId: 'original-command', receiptId: 'original-command', targetId: 'TASK-001', provider: 'codex', model: 'explicit-model' });
  assert.equal(event.generationId, 'new-generation'); assert.equal(event.operationId, 'original-operation');
});
test('configuration never defaults a model or accepts authority/source storage overlap', () => {
  assert.equal(parseBenchmarkConfig().model, '');
  assert.equal(parseBenchmarkConfig().providerApiKey, undefined);
  assert.throws(() => parseBenchmarkConfig({ runtimeRoot: repositoryRoot }), /reserved/);
  assert.throws(() => parseBenchmarkConfig({ outputsRoot: `${repositoryRoot}benchmarks/dovspace/.runtime` }), /reserved/);
  assert.throws(() => parseBenchmarkConfig({ providerEndpoint: 'http://127.0.0.1:4194' }), /HTTPS/);
});
