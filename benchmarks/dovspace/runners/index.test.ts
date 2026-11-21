import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { benchmarkConfig } from '../benchmark.config.ts';
import { boundedBudget, nativeToolPolicy, runSuite, runTask, runVersionIdentity } from './index.ts';
import { summarizeRuns } from '../reports/index.ts';
import type { BenchEvent } from '../schemas/types.ts';
import { verifyEvidenceArchive } from '../evaluation/archive.ts';
import { getTaskDefinition } from '../tasks/index.ts';

test('offline identities preserve exact task controls while one global policy covers six-task arm comparisons', () => {
  const definitions = ['K02', 'K03', 'D01', 'D02', 'L02', 'L04'].map(getTaskDefinition);
  const identities = definitions.map(task => runVersionIdentity(task, benchmarkConfig));
  assert.equal(new Set(identities.map(value => value.toolPolicySha256)).size, 1);
  assert.equal(new Set(identities.map(value => value.modelConfigSha256)).size, 1);
  assert.equal(new Set(identities.map(value => value.permissionsSha256)).size, definitions.length);
  const changedBudget = runVersionIdentity(definitions[0]!, { ...benchmarkConfig, budget: { ...benchmarkConfig.budget, maxModelCalls: 1 } });
  assert.notEqual(changedBudget.budgetSha256, identities[0]!.budgetSha256);
  assert.equal(changedBudget.modelConfigSha256, identities[0]!.modelConfigSha256);
  assert.equal(changedBudget.permissionsSha256, identities[0]!.permissionsSha256);
});

test('prerequisite failures emit complete truthful artifacts without provider calls or calibration fallback', async () => {
  await mkdir(benchmarkConfig.outputsRoot, { recursive: true });
  const root = await mkdtemp(path.join(benchmarkConfig.outputsRoot, 'runner-unit-'));
  const archives: string[] = [];
  try {
    const result = await runTask({ taskId: 'K02', arm: 'raw', outputRoot: root, config: { model: 'explicit-test-model', providerApiKey: 'test-only-secret-never-output' } });
    archives.push(result.evaluation!.archiveRoot);
    const sealed = await verifyEvidenceArchive(result.evaluation!.archiveRoot);
    assert.equal(sealed.legacy, false);
    assert.equal(sealed.admission!.attemptId, result.evaluation!.attemptId);
    assert.equal(sealed.attempt!.failure?.category, 'infrastructure');
    assert.equal(sealed.attempt!.executionFailure?.category, 'infrastructure');
    assert.equal(sealed.inputs, null);
    assert.equal(result.success, false);
    assert.equal(result.failure?.category, 'infrastructure');
    assert.ok(result.failure?.evidence.includes('provider_prerequisite'));
    assert.equal(result.usage.modelCalls, null);
    assert.equal(result.usage.costUsd, null);
    assert.equal(result.reproducibility.fixtureId, 'unavailable');
    assert.equal(result.reproducibility.controlTransport, 'http');
    assert.equal(result.artifacts.cliObservations, undefined);
    assert.equal(JSON.parse(await readFile(result.artifacts.configuration!, 'utf8')).controlTransport, 'http');
    assert.equal(result.rework.count, null);
    for (const key of ['result', 'trace', 'report', 'pmDiff', 'gitDiff', 'configuration']) {
      const content = await readFile(result.artifacts[key]!, 'utf8');
      assert.ok(!content.includes('test-only-secret-never-output'));
    }
    const trace = await readFile(result.artifacts.trace!, 'utf8');
    assert.ok(trace.includes('provider_prerequisite'));
    assert.ok(!trace.includes('provider_request'));
    assert.ok(!trace.includes('reference-driver'));
  } finally { for (const archive of archives) await chmod(archive, 0o700); await rm(root, { recursive: true, force: true }); }
});

test('budgets are bounded identically by task and explicit configuration caps', () => {
  assert.deepEqual(boundedBudget({ maxDurationMinutes: 25, maxModelCalls: 50, maxToolCalls: 110, maxCostUsd: null }, { maxDurationMinutes: 3, maxModelCalls: 6, maxToolCalls: 9, maxCostUsd: 0.5 }), { maxDurationMinutes: 3, maxModelCalls: 6, maxToolCalls: 9, maxCostUsd: 0.5 });
});

test('raw/full share actual required PM capabilities without destructive privilege escalation', () => {
  const policy = nativeToolPolicy('L04', ['read', 'search', 'pm_read', 'pm_update', 'pm_create', 'pm_receipt']);
  for (const name of ['pm_read', 'pm_read_workflow', 'pm_get_operation_result', 'pm_query', 'pm_create_task', 'pm_update_task', 'pm_transition_task']) assert.ok(policy.includes(name));
  for (const name of ['pm_delete_task', 'pm_archive_task', 'pm_restore_task', 'pm_approve']) assert.ok(!policy.includes(name));
});

test('remaining definition-only tasks are rejected before any execution is admitted', async () => {
  await assert.rejects(runTask({ taskId: 'D03', arm: 'raw' }), /not executable in Lite v0.2/);
});


test('CLI suite prerequisites preserve every failed attempt and unknown projection sidecars', async () => {
  await mkdir(benchmarkConfig.outputsRoot, { recursive: true });
  const root = await mkdtemp(path.join(benchmarkConfig.outputsRoot, 'cli-runner-unit-'));
  const archives: string[] = [];
  try {
    const results = await runSuite({ taskIds: ['K02'], arms: ['raw', 'dovspace'], outputRoot: root, config: { controlTransport: 'cli', model: 'explicit-test-model', providerApiKey: 'cli-test-only-secret-never-output' } });
    archives.push(...results.map(result => result.evaluation!.archiveRoot));
    assert.equal(new Set(results.map(result => result.evaluation!.attemptId)).size, results.length);
    assert.equal(results.length, 2);
    assert.equal(summarizeRuns(results).attempts, 2);
    assert.equal(summarizeRuns(results).successes, 0);
    assert.equal(summarizeRuns(results).failures.platform, 2);
    for (const result of results) {
      const sealed = await verifyEvidenceArchive(result.evaluation!.archiveRoot);
      assert.equal(sealed.attempt!.attemptId, result.evaluation!.attemptId);
      assert.equal(sealed.attempt!.status, 'incomplete');
      assert.equal(result.success, false);
      assert.equal(result.reproducibility.controlTransport, 'cli');
      assert.equal(result.failure?.category, 'infrastructure');
      assert.ok(result.failure?.evidence.includes('provider_prerequisite'));
      assert.equal(result.usage.modelCalls, null);
      assert.equal(result.usage.costUsd, null);
      const trace = (await readFile(result.artifacts.trace!, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as BenchEvent);
      assert.equal(trace.find(event => event.type === 'run_admitted')?.data.controlTransport, 'cli');
      assert.equal(trace.some(event => event.type === 'provider_request'), false);
      assert.equal(JSON.parse(await readFile(result.artifacts.configuration!, 'utf8')).controlTransport, 'cli');
      assert.match(await readFile(result.artifacts.report!, 'utf8'), /cli-observations/);
      for (const key of ['result', 'trace', 'report', 'configuration', 'cliObservations', 'cliObservationReport']) {
        assert.doesNotMatch(await readFile(result.artifacts[key]!, 'utf8'), /cli-test-only-secret-never-output/);
      }
    }
  } finally { for (const archive of archives) await chmod(archive, 0o700); await rm(root, { recursive: true, force: true }); }
});
