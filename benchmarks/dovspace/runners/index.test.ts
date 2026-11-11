import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { benchmarkConfig } from '../benchmark.config.ts';
import { boundedBudget, nativeToolPolicy, runTask } from './index.ts';

test('prerequisite failures emit complete truthful artifacts without provider calls or calibration fallback', async () => {
  await mkdir(benchmarkConfig.outputsRoot, { recursive: true });
  const root = await mkdtemp(path.join(benchmarkConfig.outputsRoot, 'runner-unit-'));
  try {
    const result = await runTask({ taskId: 'K02', arm: 'raw', outputRoot: root, config: { model: 'explicit-test-model', providerApiKey: 'test-only-secret-never-output' } });
    assert.equal(result.success, false);
    assert.equal(result.failure?.category, 'infrastructure');
    assert.ok(result.failure?.evidence.includes('provider_prerequisite'));
    assert.equal(result.usage.modelCalls, null);
    assert.equal(result.usage.costUsd, null);
    assert.equal(result.reproducibility.fixtureId, 'unavailable');
    assert.equal(result.rework.count, null);
    for (const key of ['result', 'trace', 'report', 'pmDiff', 'gitDiff', 'configuration']) {
      const content = await readFile(result.artifacts[key]!, 'utf8');
      assert.ok(!content.includes('test-only-secret-never-output'));
    }
    const trace = await readFile(result.artifacts.trace!, 'utf8');
    assert.ok(trace.includes('provider_prerequisite'));
    assert.ok(!trace.includes('provider_request'));
    assert.ok(!trace.includes('reference-driver'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('budgets are bounded identically by task and explicit configuration caps', () => {
  assert.deepEqual(boundedBudget({ maxDurationMinutes: 25, maxModelCalls: 50, maxToolCalls: 110, maxCostUsd: null }, { maxDurationMinutes: 3, maxModelCalls: 6, maxToolCalls: 9, maxCostUsd: 0.5 }), { maxDurationMinutes: 3, maxModelCalls: 6, maxToolCalls: 9, maxCostUsd: 0.5 });
});

test('raw/full share actual required PM capabilities without destructive privilege escalation', () => {
  const policy = nativeToolPolicy('L04', ['read', 'search', 'pm_read', 'pm_update', 'pm_create', 'pm_receipt']);
  for (const name of ['pm_read', 'pm_query', 'pm_create_task', 'pm_update_task', 'pm_transition_task']) assert.ok(policy.includes(name));
  for (const name of ['pm_delete_task', 'pm_archive_task', 'pm_restore_task', 'pm_approve']) assert.ok(!policy.includes(name));
});

test('non-smoke complete definitions are rejected before any execution is admitted', async () => {
  await assert.rejects(runTask({ taskId: 'D03', arm: 'raw' }), /not executable in Lite v0.1/);
});
