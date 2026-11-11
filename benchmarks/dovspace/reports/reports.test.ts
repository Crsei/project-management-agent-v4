import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseBenchmarkConfig } from '../benchmark.config.ts';
import type { RunResult } from '../schemas/types.ts';
import { aggregateExperiment, evaluateFairness, failureCategory, publicExperimentConfiguration, readExperiment, readRunResult, renderComparison, renderRunReport, summarizeRuns, verifiedSuccess, writeExperimentReport } from './index.ts';
import { costPerSuccess, summarizeMetric } from './statistics.ts';

function run(overrides: Partial<RunResult> = {}): RunResult {
  return {
    runId: 'run-raw', taskId: 'K02', taskVersion: '0.1.0', fixtureVersion: '0.1.0', arm: 'raw',
    agent: 'real-chat-adapter', model: 'explicit-fixed-model', success: true,
    safetyGate: { passed: true, checks: [{ id: 'isolation', passed: true, required: true, score: 1, evidence: ['artifacts/isolation.json'] }], violations: [] },
    checkpointScore: 1, phaseResults: [{ id: 'answer', passed: true, checks: [{ id: 'knowledge', passed: true, required: true, score: 1, evidence: ['artifacts/answer.json'] }], evidence: ['trace.jsonl'] }],
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: null, cacheWriteTokens: null, modelCalls: 1, toolCalls: 2, costUsd: 0.1 },
    timeMs: 5000, unexpectedMutations: [], artifacts: { answer: 'artifacts/answer.json' },
    reproducibility: { fixtureId: 'fixture-raw', fixtureSemanticHash: 'a'.repeat(64), modelConfigHash: 'b'.repeat(64), budgetHash: 'c'.repeat(64), permissionsHash: 'd'.repeat(64), environmentHash: 'e'.repeat(64), effectiveModelSettingsHash: 'f'.repeat(64) }, failure: null,
    humanInterventions: { count: null, definition: 'Unplanned operator instructions, excluding scheduled injections', reason: 'Not observed by this unit fixture' },
    rework: { count: null, denominator: null, proportion: null, definition: 'Identical failed-PM-mutation retry proxy, not general coding rework', reason: 'Not observed by this unit fixture' },
    ...overrides,
  };
}
const design = { arms: ['raw', 'dovspace'] as Array<'raw' | 'dovspace'>, taskIds: ['K02'], repetitions: 1 };
function pairedRuns(): RunResult[] {
  return [run(), run({ runId: 'run-dovspace', arm: 'dovspace', reproducibility: { ...run().reproducibility, fixtureId: 'fixture-dovspace' } })];
}

test('unknown metrics remain null and known subtotal cannot masquerade as total', () => {
  assert.deepEqual(summarizeMetric([3, null, 5]), { total: null, mean: null, median: null, knownTotal: 8, knownCount: 2, unknownCount: 1 });
  assert.deepEqual(summarizeMetric([]), { total: null, mean: null, median: null, knownTotal: null, knownCount: 0, unknownCount: 0 });
  assert.equal(summarizeMetric([0, 0]).total, 0);
  assert.throws(() => summarizeMetric([Number.NaN]), /finite/);
  const summary = summarizeRuns([run({ usage: { ...run().usage, costUsd: null, modelCalls: null, toolCalls: null } })]);
  assert.equal(summary.costUsd.total, null);
  assert.equal(summary.modelCalls.total, null);
  assert.equal(summary.humanInterventions.total, null);
  assert.equal(summary.rework.total, null);
  assert.equal(summary.reworkDenominator.total, null);
  assert.equal(summary.reworkProportion, null);
  assert.match(renderRunReport(run({ usage: { ...run().usage, modelCalls: null, toolCalls: null } })), /model\/tool calls: unknown\/unknown/);
});

test('cost per success includes failed attempts and has an explicit zero-success state', () => {
  assert.deepEqual(costPerSuccess([0.1, 0.3], 1), { usd: 0.4, reason: null });
  assert.deepEqual(costPerSuccess([0.2, null], 0), { usd: null, reason: 'no_successes' });
  assert.deepEqual(costPerSuccess([0.2, null], 1), { usd: null, reason: 'unknown_cost' });
  assert.throws(() => costPerSuccess([1], 2), /Success count/);
});

test('model platform grader and task errors stay separate and all remain in denominator', () => {
  const categories = ['provider', 'infrastructure', 'grader', 'knowledge'] as const;
  const runs = categories.map((category, index) => run({ runId: `failure-${index}`, success: false, failure: { category, message: 'Observed failure', evidence: ['trace.jsonl'] } }));
  assert.deepEqual(runs.map(failureCategory), ['model', 'platform', 'grader', 'task']);
  const value = summarizeRuns(runs);
  assert.deepEqual(value.failures, { task: 1, model: 1, platform: 1, grader: 1 });
  assert.equal(value.attempts, 4);
  assert.equal(value.successRate, 0);
  assert.deepEqual(value.costPerSuccess, { usd: null, reason: 'no_successes' });
});

test('independent failure or unrelated mutation overrides claimed success', () => {
  const unsafe = run({ safetyGate: { ...run().safetyGate, passed: false, violations: ['forbidden target'] } });
  const mutated = run({ unexpectedMutations: [{ domain: 'pm', identity: 'unrelated', kind: 'changed' }] });
  const noChecks = run({ phaseResults: [] });
  const noSafetyEvidence = run({ safetyGate: { ...run().safetyGate, checks: [] } });
  for (const value of [unsafe, mutated, noChecks, noSafetyEvidence]) {
    assert.equal(verifiedSuccess(value), false);
    assert.equal(summarizeRuns([value]).successes, 0);
    assert.equal(evaluateFairness([value], { arms: ['raw'], taskIds: ['K02'], repetitions: 1 }).valid, false);
  }
});

test('fair comparison requires fixed model configuration independent resets and balanced cells', () => {
  assert.equal(evaluateFairness(pairedRuns(), design).valid, true);
  const changes: Array<(value: RunResult) => RunResult> = [
    (value) => ({ ...value, model: 'different-model' }),
    (value) => ({ ...value, reproducibility: { ...value.reproducibility, fixtureId: 'fixture-raw' } }),
    (value) => ({ ...value, reproducibility: { ...value.reproducibility, modelConfigHash: 'other' } }),
    (value) => ({ ...value, reproducibility: { ...value.reproducibility, environmentHash: 'f'.repeat(64) } }),
    (value) => ({ ...value, reproducibility: { ...value.reproducibility, environmentHash: '' } }),
    (value) => ({ ...value, reproducibility: { ...value.reproducibility, effectiveModelSettingsHash: 'a'.repeat(64) } }),
    (value) => ({ ...value, reproducibility: { ...value.reproducibility, effectiveModelSettingsHash: null } }),
    (value) => ({ ...value, reproducibility: { ...value.reproducibility, permissionsHash: 'other' } }),
    (value) => ({ ...value, reproducibility: { ...value.reproducibility, budgetHash: 'other' } }),
    (value) => ({ ...value, reproducibility: { ...value.reproducibility, fixtureSemanticHash: 'other' } }),
    (value) => ({ ...value, reproducibility: { ...value.reproducibility, fixtureSemanticHash: '' } }),
  ];
  for (const change of changes) {
    const [raw, full] = pairedRuns();
    assert.equal(evaluateFairness([raw!, change(full!)], design).valid, false);
  }
  assert.equal(evaluateFairness([run()], design).valid, false);
  assert.equal(evaluateFairness([run(), run()], { arms: ['raw'], taskIds: ['K02'], repetitions: 2 }).valid, false);
});

test('invalid fairness suppresses comparative advantage and small-n caveat is explicit', () => {
  const runs = pairedRuns();
  const valid = aggregateExperiment(runs, { experimentId: 'paired', design });
  assert.match(renderComparison(valid), /n-small/);
  assert.match(renderComparison(valid), /percentage points/);
  runs[1]!.model = 'different-model';
  const invalid = aggregateExperiment(runs, { experimentId: 'mismatch', design });
  const markdown = renderComparison(invalid);
  assert.match(markdown, /comparison invalid/);
  assert.doesNotMatch(markdown, /success-rate difference:/);
});

test('experiment writes self-contained results and can regenerate without model execution', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dovspace-report-'));
  try {
    const runs = pairedRuns();
    const summary = await writeExperimentReport(runs, directory, { experimentId: 'roundtrip', design, createdAt: '2026-11-10T00:00:00.000Z', resultPaths: { 'run-raw': '/private/outputs/run-raw/result.json' } });
    const loaded = await readExperiment(directory);
    assert.deepEqual(loaded.runs, runs);
    assert.deepEqual(aggregateExperiment(loaded.runs, loaded.options), summary);
    const taskResults = JSON.parse(await readFile(join(directory, 'task-results.json'), 'utf8')) as { runs: RunResult[] };
    assert.equal(taskResults.runs[0]!.phaseResults[0]!.checks[0]!.evidence[0], 'artifacts/answer.json');
    assert.match(await readFile(join(directory, 'comparison.md'), 'utf8'), /result\.json/);
    await writeFile(join(directory, 'task-results.json'), JSON.stringify({ kind: 'grader-calibration', runs }));
    await assert.rejects(readExperiment(directory), /calibration cannot be reported/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('evidence links retained snapshots and trace identities, not prose quotations as phantom files', () => {
  const value = run();
  value.artifacts.sourceSnapshot = '/outputs/run-raw/artifacts/public-source-snapshot.json';
  value.artifacts.trace = '/outputs/run-raw/trace.jsonl';
  value.phaseResults[0]!.checks[0]!.evidence = ['docs/accepted-decision.md', 'This exact accepted assertion is evidence.', '12345678-1234-1234-1234-123456789abc'];
  const report = renderRunReport(value, '/outputs/run-raw');
  assert.match(report, /docs\/accepted-decision\.md \(source snapshot\).*artifacts\/public-source-snapshot\.json/);
  assert.match(report, /identity 12345678-1234-1234-1234-123456789abc in trace.*trace\.jsonl/);
  assert.doesNotMatch(report, /This%20exact%20accepted/);
});

test('unconfigured attempts are not labelled observed real inference and detailed tool errors survive aggregation', () => {
  const missing = run({ success: false, usage: { ...run().usage, modelCalls: null, costUsd: null }, reproducibility: { ...run().reproducibility, effectiveModelSettingsHash: null }, failure: { category: 'infrastructure', message: 'Provider prerequisite unavailable; no request made.', evidence: ['provider_prerequisite'] } });
  const summary = aggregateExperiment([missing], { experimentId: 'unconfigured' });
  assert.deepEqual(summary.inferenceObservation, { runsWithObservedModelRequest: 0, runsWithoutObservedModelRequest: 1 });
  assert.equal(summary.overall.failures.platform, 1);
  assert.match(renderComparison(summary), /model-evaluation attempts/);
  assert.doesNotMatch(renderComparison(summary), /real model experiment/);
  const toolFailures = ['tool', 'permission'].map((category) => run({ success: false, failure: { category: category as 'tool' | 'permission', message: 'Observed tool failure', evidence: ['trace.jsonl'] } }));
  assert.deepEqual(summarizeRuns(toolFailures).failureKinds, { tool: 1, permission: 1 });
});

test('reproduction settings preserve explicit controls while excluding credentials and private roots', () => {
  const config = parseBenchmarkConfig({ model: 'explicit-fixed-model', providerEndpoint: 'https://example.test/v1', providerApiKey: 'unit-only-secret-not-an-actual-credential', modelOptions: { reasoningEffort: 'xhigh' }, budget: { maxDurationMinutes: 8, maxModelCalls: 18, maxToolCalls: 45, maxCostUsd: 2 } });
  const configuration = publicExperimentConfiguration(config);
  const serialized = JSON.stringify(configuration);
  assert.doesNotMatch(serialized, /unit-only-secret|providerApiKey|runtimeRoot|outputsRoot/);
  assert.equal(configuration.model, 'explicit-fixed-model');
  assert.deepEqual(configuration.modelOptions, { reasoningEffort: 'xhigh' });
  const summary = aggregateExperiment(pairedRuns(), { experimentId: 'settings', design, configuration });
  assert.equal(summary.configuration?.budget.maxCostUsd, 2);
  assert.match(renderComparison(summary), /Fixed nonsecret configuration/);
});

test('rework reports a weighted narrow PM retry proxy and preserves unknown/no-attempt proportions', () => {
  const first = run({ rework: { count: 1, denominator: 4, proportion: 0.25, definition: 'Identical failed-PM-mutation retry proxy', reason: null } });
  const second = run({ rework: { count: 2, denominator: 6, proportion: 1 / 3, definition: first.rework.definition, reason: null } });
  const summary = summarizeRuns([first, second]);
  assert.equal(summary.rework.total, 3);
  assert.equal(summary.reworkDenominator.total, 10);
  assert.equal(summary.reworkProportion, 0.3);
  assert.equal(summarizeRuns([first, run()]).reworkProportion, null);
  const noAttempts = run({ rework: { count: 0, denominator: 0, proportion: null, definition: first.rework.definition, reason: 'No attributable PM mutation attempts' } });
  assert.equal(summarizeRuns([noAttempts]).reworkProportion, null);
  assert.match(renderRunReport(first), /PM retry rework proxy: 1 \/ 4 attributable attempts; proportion 25.0%/);
});

test('explicit protocol and grader calibration modes cannot be promoted to model runs by adding run-shaped fields', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dovspace-mode-boundary-'));
  try {
    const path = join(directory, 'result.json');
    for (const kind of ['grader-calibration', 'protocol-calibration']) {
      await writeFile(path, JSON.stringify({ ...run(), kind }));
      await assert.rejects(readRunResult(path), /calibration\/experiment documents cannot be imported/);
      await writeFile(join(directory, 'task-results.json'), JSON.stringify({ kind: 'model-experiment', runs: [{ ...run(), kind }] }));
      await assert.rejects(readExperiment(directory), /calibration\/experiment documents cannot be imported/);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
