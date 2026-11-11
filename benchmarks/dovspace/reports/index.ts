import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { BenchmarkConfigSchema } from '../benchmark.config.ts';
import type { BenchmarkConfig } from '../benchmark.config.ts';
import { RunResultSchema } from '../schemas/types.ts';
import type { Arm, RunResult } from '../schemas/types.ts';
import { costPerSuccess, summarizeMetric, wilsonInterval } from './statistics.ts';
import type { CostPerSuccess, MetricSummary } from './statistics.ts';
import { readReportJson, writeReportFile } from './files.ts';

export type FailureCategory = 'task' | 'model' | 'platform' | 'grader';
export type ExperimentConfiguration = Pick<BenchmarkConfig, 'provider' | 'model' | 'modelOptions' | 'budget' | 'prices' | 'providerEndpoint' | 'providerBinary' | 'agentImage' | 'codeImage' | 'postgresImage'>;
const ConfigurationSchema = BenchmarkConfigSchema.pick({ provider: true, model: true, modelOptions: true, budget: true, prices: true, providerEndpoint: true, providerBinary: true, agentImage: true, codeImage: true, postgresImage: true }).strip();

/** A deliberate whitelist: provider keys, runtime environment and PM credentials cannot be serialized here. */
export function publicExperimentConfiguration(config: BenchmarkConfig): ExperimentConfiguration {
  return ConfigurationSchema.parse(config);
}
export interface ExperimentDesign {
  arms: Arm[];
  taskIds: string[];
  repetitions: number;
}
export interface ReportOptions {
  experimentId: string;
  design?: ExperimentDesign;
  createdAt?: string;
  resultPaths?: Record<string, string>;
  configuration?: ExperimentConfiguration;
}
export interface OutcomeSummary {
  attempts: number;
  successes: number;
  successRate: number | null;
  descriptiveWilson95: { lower: number; upper: number } | null;
  failures: Record<FailureCategory, number>;
  failureKinds: Record<string, number>;
  safetyFailures: number;
  unexpectedMutationRuns: number;
  checkpointScore: MetricSummary;
  humanInterventions: MetricSummary;
  rework: MetricSummary;
  reworkDenominator: MetricSummary;
  reworkProportion: number | null;
  timeMs: MetricSummary;
  inputTokens: MetricSummary;
  outputTokens: MetricSummary;
  cacheReadTokens: MetricSummary;
  cacheWriteTokens: MetricSummary;
  modelCalls: MetricSummary;
  toolCalls: MetricSummary;
  costUsd: MetricSummary;
  costPerSuccess: CostPerSuccess;
  checks: Record<string, { passed: number; evaluated: number; passRate: number }>;
}
export interface ExperimentSummary {
  kind: 'model-experiment';
  schemaVersion: '0.1';
  experimentId: string;
  createdAt: string;
  model: string | null;
  inferenceObservation: { runsWithObservedModelRequest: number; runsWithoutObservedModelRequest: number };
  design: ExperimentDesign;
  configuration: ExperimentConfiguration | null;
  fairness: { valid: boolean; issues: string[] };
  caveats: string[];
  overall: OutcomeSummary;
  arms: Partial<Record<Arm, OutcomeSummary>>;
  tasks: Record<string, Partial<Record<Arm, OutcomeSummary>>>;
  runs: Array<{ runId: string; taskId: string; arm: Arm; success: boolean; failureCategory: FailureCategory | null; resultPath: string | null }>;
}

export function failureCategory(result: RunResult): FailureCategory | null {
  if (verifiedSuccess(result)) return null;
  if (result.success) return 'grader';
  switch (result.failure?.category) {
    case 'infrastructure': return 'platform';
    case 'provider': case 'model': return 'model';
    case 'grader': return 'grader';
    default: return 'task';
  }
}

/** Reported success is never allowed to override independent checks or safety. */
export function verifiedSuccess(result: RunResult): boolean {
  return result.success && result.failure === null && result.safetyGate.passed
    && result.safetyGate.violations.length === 0
    && result.safetyGate.checks.some((check) => check.required)
    && result.safetyGate.checks.every((check) => !check.required || check.passed)
    && result.unexpectedMutations.length === 0
    && result.phaseResults.length > 0
    && result.phaseResults.every((phase) => phase.passed && phase.checks.length > 0
      && phase.checks.some((check) => check.required)
      && phase.checks.every((check) => !check.required || check.passed));
}

export function summarizeRuns(runs: readonly RunResult[]): OutcomeSummary {
  let successes = 0;
  let safetyFailures = 0;
  let unexpectedMutationRuns = 0;
  const failures: Record<FailureCategory, number> = { task: 0, model: 0, platform: 0, grader: 0 };
  const failureKinds: Record<string, number> = {};
  const checks: OutcomeSummary['checks'] = {};
  for (const run of runs) {
    if (verifiedSuccess(run)) successes += 1;
    else {
      failures[failureCategory(run) ?? 'grader'] += 1;
      const kind = run.failure?.category ?? (run.success ? 'contradictory-success' : 'unclassified-task-failure');
      failureKinds[kind] = (failureKinds[kind] ?? 0) + 1;
    }
    if (!run.safetyGate.passed || run.safetyGate.violations.length > 0) safetyFailures += 1;
    if (run.unexpectedMutations.length > 0) unexpectedMutationRuns += 1;
    for (const phase of run.phaseResults) {
      for (const check of phase.checks) {
        const key = `${phase.id}/${check.id}`;
        const aggregate = checks[key] ?? { passed: 0, evaluated: 0, passRate: 0 };
        aggregate.evaluated += 1;
        aggregate.passed += Number(check.passed);
        aggregate.passRate = aggregate.passed / aggregate.evaluated;
        checks[key] = aggregate;
      }
    }
  }
  const rework = summarizeMetric(runs.map((run) => run.rework.count));
  const reworkDenominator = summarizeMetric(runs.map((run) => run.rework.denominator));
  const reworkProportion = rework.total !== null && reworkDenominator.total !== null && reworkDenominator.total > 0 && rework.total <= reworkDenominator.total ? rework.total / reworkDenominator.total : null;
  return {
    attempts: runs.length, successes, successRate: runs.length ? successes / runs.length : null,
    descriptiveWilson95: wilsonInterval(successes, runs.length), failures,
    safetyFailures,
    unexpectedMutationRuns,
    checkpointScore: summarizeMetric(runs.map((run) => run.checkpointScore)),
    humanInterventions: summarizeMetric(runs.map((run) => run.humanInterventions.count)),
    rework, reworkDenominator, reworkProportion,
    failureKinds,
    timeMs: summarizeMetric(runs.map((run) => run.timeMs)),
    inputTokens: summarizeMetric(runs.map((run) => run.usage.inputTokens)),
    outputTokens: summarizeMetric(runs.map((run) => run.usage.outputTokens)),
    cacheReadTokens: summarizeMetric(runs.map((run) => run.usage.cacheReadTokens)),
    cacheWriteTokens: summarizeMetric(runs.map((run) => run.usage.cacheWriteTokens)),
    modelCalls: summarizeMetric(runs.map((run) => run.usage.modelCalls)),
    toolCalls: summarizeMetric(runs.map((run) => run.usage.toolCalls)),
    costUsd: summarizeMetric(runs.map((run) => run.usage.costUsd)),
    costPerSuccess: costPerSuccess(runs.map((run) => run.usage.costUsd), successes), checks,
  };
}

const hashKeys = ['fixtureSemanticHash', 'modelConfigHash', 'budgetHash', 'permissionsHash', 'environmentHash'] as const;
function knownIdentity(value: string): boolean {
  return value.trim().length > 0 && !/^(unknown|unavailable|not[-_ ]?(started|created|available)|none|null)$/i.test(value);
}

export function evaluateFairness(runs: readonly RunResult[], design: ExperimentDesign): ExperimentSummary['fairness'] {
  const issues = new Set<string>();
  if (runs.length === 0) issues.add('No model runs were supplied.');
  if (!Number.isInteger(design.repetitions) || design.repetitions < 1) issues.add('Repetitions must be a positive integer.');
  if (new Set(design.arms).size !== design.arms.length || design.arms.length === 0) issues.add('Arms must be nonempty and distinct.');
  if (new Set(design.taskIds).size !== design.taskIds.length || design.taskIds.length === 0) issues.add('Tasks must be nonempty and distinct.');
  const runIds = new Set<string>();
  const fixtureIds = new Set<string>();
  const globalModels = new Set<string>();
  const modelHashes = new Set<string>();
  const environmentHashes = new Set<string>();
  const effectiveModelHashes = new Set<string>();
  for (const run of runs) {
    if (runIds.has(run.runId)) issues.add(`Duplicate run identity: ${run.runId}.`);
    runIds.add(run.runId);
    if (!knownIdentity(run.reproducibility.fixtureId)) issues.add(`No isolated fixture identity for ${run.runId}.`);
    else if (fixtureIds.has(run.reproducibility.fixtureId)) issues.add(`Fixture reused across attempts: ${run.reproducibility.fixtureId}.`);
    fixtureIds.add(run.reproducibility.fixtureId);
    if (!knownIdentity(run.model)) issues.add(`No explicit real model for ${run.runId}.`);
    globalModels.add(run.model);
    for (const key of hashKeys) {
      if (!/^[a-f0-9]{64}$/i.test(run.reproducibility[key])) issues.add(`Missing or invalid SHA-256 ${key} evidence for ${run.runId}.`);
    }
    modelHashes.add(run.reproducibility.modelConfigHash);
    environmentHashes.add(run.reproducibility.environmentHash);
    const effectiveHash = run.reproducibility.effectiveModelSettingsHash;
    if (effectiveHash !== null) {
      if (!/^[a-f0-9]{64}$/i.test(effectiveHash)) issues.add(`Invalid effective model-settings proof for ${run.runId}.`);
      else effectiveModelHashes.add(effectiveHash);
    } else if ((run.usage.modelCalls ?? 0) > 0) issues.add(`Observed model requests lack effective model-settings proof for ${run.runId}.`);
    if (!design.arms.includes(run.arm) || !design.taskIds.includes(run.taskId)) issues.add(`Run outside experiment design: ${run.runId}.`);
    if (run.success && !verifiedSuccess(run)) issues.add(`Claimed success contradicts independent/safety evidence: ${run.runId}.`);
  }
  if (globalModels.size > 1) issues.add('Model differs across attempts.');
  if (modelHashes.size > 1) issues.add('Provider/model/options configuration differs across attempts.');
  if (environmentHashes.size > 1) issues.add('Actual runtime images, staged product source or lockfile environment differs across attempts.');
  if (effectiveModelHashes.size > 1) issues.add('Effective model request settings differ across attempts.');
  for (const taskId of design.taskIds) {
    const taskRuns = runs.filter((run) => run.taskId === taskId);
    for (const key of ['taskVersion', 'fixtureVersion'] as const) {
      if (new Set(taskRuns.map((run) => run[key])).size > 1) issues.add(`${taskId}: ${key} differs across attempts.`);
    }
    for (const key of ['fixtureSemanticHash', 'budgetHash', 'permissionsHash'] as const) {
      if (new Set(taskRuns.map((run) => run.reproducibility[key])).size > 1) issues.add(`${taskId}: ${key} differs across arms/repeats.`);
    }
    for (const arm of design.arms) {
      const count = taskRuns.filter((run) => run.arm === arm).length;
      if (count !== design.repetitions) issues.add(`${taskId}/${arm}: expected ${design.repetitions} independent attempts, found ${count}.`);
    }
  }
  return { valid: issues.size === 0, issues: [...issues] };
}

export function aggregateExperiment(runs: readonly RunResult[], options: ReportOptions): ExperimentSummary {
  const arms = [...new Set(runs.map((run) => run.arm))];
  const taskIds = [...new Set(runs.map((run) => run.taskId))].sort();
  const firstTask = taskIds[0];
  const firstArm = arms[0];
  const repetitions = runs.filter((run) => run.taskId === firstTask && run.arm === firstArm).length || 1;
  const design = options.design ?? { arms, taskIds, repetitions };
  const byArm: ExperimentSummary['arms'] = {};
  const byTask: ExperimentSummary['tasks'] = {};
  for (const arm of design.arms) byArm[arm] = summarizeRuns(runs.filter((run) => run.arm === arm));
  for (const taskId of design.taskIds) {
    const taskArms: Partial<Record<Arm, OutcomeSummary>> = {};
    for (const arm of design.arms) taskArms[arm] = summarizeRuns(runs.filter((run) => run.taskId === taskId && run.arm === arm));
    byTask[taskId] = taskArms;
  }
  const models = new Set(runs.map((run) => run.model));
  const observedRequestRuns = runs.reduce((count, run) => count + Number((run.usage.modelCalls ?? 0) > 0 || (run.reproducibility.effectiveModelSettingsHash !== null && /^[a-f0-9]{64}$/i.test(run.reproducibility.effectiveModelSettingsHash))), 0);
  return {
    kind: 'model-experiment', schemaVersion: '0.1', experimentId: options.experimentId,
    createdAt: options.createdAt ?? new Date().toISOString(), model: models.size === 1 ? runs[0]!.model : null,
    design, fairness: evaluateFairness(runs, design),
    configuration: options.configuration ? ConfigurationSchema.parse(options.configuration) : null,
    caveats: [
      'This is a small original synthetic benchmark, not a general model ranking or production-readiness claim.',
      ...(design.repetitions <= 3 ? [`n-small: only ${design.repetitions} attempt(s) per task/arm; n=2–3 cannot establish a reliable advantage.`] : []),
      'Wilson intervals are descriptive only. Repeats of the same task are correlated and are not independent new tasks.',
      'All attempts, including platform/model/grader errors, remain in the primary success-rate denominator; error categories are reported separately.',
      'Unknown cost/token observations are null, never zero. Cost per success includes failed attempts and is undefined with zero successes or incomplete cost observations.',
      'Human interventions exclude scheduled benchmark injections. Rework is only the identical failed-PM-mutation retry proxy, excluding read-only reconciliation and injected lost-response originals; it is not total coding/semantic rework. Missing/incomplete observation or zero attributable denominator yields a null proportion.',
      'Run termination, model claims, checkpoint credit and PM task completion are different facts; verified success requires all independent required checks and safety.',
    ],
    overall: summarizeRuns(runs), arms: byArm, tasks: byTask,
    inferenceObservation: { runsWithObservedModelRequest: observedRequestRuns, runsWithoutObservedModelRequest: runs.length - observedRequestRuns },
    runs: runs.map((run) => ({ runId: run.runId, taskId: run.taskId, arm: run.arm, success: verifiedSuccess(run), failureCategory: failureCategory(run), resultPath: options.resultPaths?.[run.runId] ?? null })),
  };
}

function cell(value: unknown): string {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');
}
function number(value: number | null, digits = 3): string {
  return value === null ? 'unknown' : value.toFixed(digits);
}
function percent(value: number | null): string {
  return value === null ? 'undefined' : `${(value * 100).toFixed(1)}%`;
}
function link(label: string, path: string, fromDirectory?: string): string {
  const target = fromDirectory && isAbsolute(path) ? relative(fromDirectory, path) : path;
  return `[${cell(label).replaceAll('[', '\\[').replaceAll(']', '\\]')}](${target.split(/[\\/]/).map(encodeURIComponent).join('/')})`;
}

function evidenceItem(value: string, result: RunResult, runDirectory?: string): string {
  const publicPath = value.replace(/^public\//, '');
  const direct = result.artifacts[value] ?? Object.values(result.artifacts).find((path) => path === value);
  if (direct) return link(value, direct, runDirectory);
  if (publicPath.startsWith('artifacts/')) {
    const collected = result.artifacts[`agent/${publicPath.slice('artifacts/'.length)}`];
    if (collected) return link(value, collected, runDirectory);
  }
  if (/^(docs|repo|knowledge|\.dovspace)\//.test(publicPath) && result.artifacts.sourceSnapshot) return link(`${value} (source snapshot)`, result.artifacts.sourceSnapshot, runDirectory);
  if (['trace.jsonl', 'pm-diff.json', 'git.diff', 'result.json'].includes(value)) return link(value, value);
  if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value)) return link(`identity ${value} in trace`, result.artifacts.trace ?? 'trace.jsonl', runDirectory);
  return cell(value);
}

export function renderRunReport(result: RunResult, runDirectory?: string): string {
  const success = verifiedSuccess(result);
  const lines = [
    `# Run ${cell(result.runId)}`, '',
    `- Task: **${cell(result.taskId)}** (${cell(result.taskVersion)}); fixture: ${cell(result.fixtureVersion)}`,
    `- Arm: **${result.arm}**; agent: ${cell(result.agent)}; explicit model: **${cell(result.model)}**`,
    `- Verified success: **${success ? 'yes' : 'no'}**; reported success: ${result.success ? 'yes' : 'no'}`,
    `- Safety gate: **${result.safetyGate.passed ? 'passed' : 'failed'}**; checkpoint score: ${number(result.checkpointScore)}`,
    `- Failure category: ${failureCategory(result) ?? 'none'}${result.failure ? ` (${result.failure.category}): ${cell(result.failure.message)}` : ''}`,
    `- Duration: ${number(result.timeMs / 1000)} s; model/tool calls: ${number(result.usage.modelCalls, 0)}/${number(result.usage.toolCalls, 0)}`,
    `- Tokens input/output/cache-read/cache-write: ${number(result.usage.inputTokens, 0)}/${number(result.usage.outputTokens, 0)}/${number(result.usage.cacheReadTokens, 0)}/${number(result.usage.cacheWriteTokens, 0)}`,
    `- Cost USD: ${number(result.usage.costUsd, 6)} (unknown is not free)`, '',
    '## Independent checks', '', '| Phase / check | Required | Pass | Score | Evidence |', '| --- | --- | --- | --- | --- |',
  ];
  for (const phase of result.phaseResults) {
    for (const check of phase.checks) lines.push(`| ${cell(`${phase.id}/${check.id}`)} | ${check.required ? 'yes' : 'no'} | ${check.passed ? 'yes' : 'no'} | ${number(check.score)} | ${check.evidence.map((value) => evidenceItem(value, result, runDirectory)).join(', ')}${check.reason ? `; ${cell(check.reason)}` : ''} |`);
  }
  if (result.phaseResults.length === 0) lines.push('| Not evaluated | — | no | — | No independent task grade was produced. |');
  lines.push('', '## Safety and unrelated mutations', '');
  for (const check of result.safetyGate.checks) lines.push(`- ${check.passed ? 'PASS' : 'FAIL'} ${cell(check.id)}${check.reason ? `: ${cell(check.reason)}` : ''}${check.evidence.length ? ` — ${check.evidence.map((value) => evidenceItem(value, result, runDirectory)).join(', ')}` : ''}`);
  for (const violation of result.safetyGate.violations) lines.push(`- Violation: ${cell(violation)}`);
  lines.push(`- Unexpected mutations: ${result.unexpectedMutations.length}`);
  for (const mutation of result.unexpectedMutations) lines.push(`  - ${cell(mutation.domain)}/${cell(mutation.identity)}: ${mutation.kind}`);
  lines.push('', '## Human intervention and rework', '',
    `- Human interventions: ${number(result.humanInterventions.count, 0)} — ${cell(result.humanInterventions.definition)}${result.humanInterventions.reason ? ` (${cell(result.humanInterventions.reason)})` : ''}`,
    `- PM retry rework proxy: ${number(result.rework.count, 0)} / ${number(result.rework.denominator, 0)} attributable attempts; proportion ${percent(result.rework.proportion)} — ${cell(result.rework.definition)}${result.rework.reason ? ` (${cell(result.rework.reason)})` : ''}`);
  lines.push('', '## Reproducibility', '', '```json', JSON.stringify(result.reproducibility, null, 2), '```', '', '## Evidence', '');
  lines.push(`- ${link('Structured result', 'result.json')}`, `- ${link('Trusted trace', 'trace.jsonl')}`, `- ${link('PM diff', 'pm-diff.json')}`, `- ${link('Code diff', 'git.diff')}`);
  for (const [name, path] of Object.entries(result.artifacts)) lines.push(`- ${link(name, path, runDirectory)}`);
  for (const value of result.failure?.evidence ?? []) lines.push(`- Failure evidence: ${evidenceItem(value, result, runDirectory)}`);
  lines.push('', '> A completed model run or CLI exit is not task completion. Missing independent evidence cannot be converted into success.', '');
  return lines.join('\n');
}

export async function writeRunReport(result: RunResult, runDirectory: string): Promise<void> {
  await writeReportFile(resolve(runDirectory, 'report.md'), renderRunReport(result, runDirectory));
}

export function renderComparison(summary: ExperimentSummary, reportDirectory?: string): string {
  const lines = [`# Experiment ${cell(summary.experimentId)}`, '', `Created: ${summary.createdAt}`, '',
    `- Kind: **model-evaluation attempts** (not deterministic grader calibration)`,
    `- Runs with observed model requests: ${summary.inferenceObservation.runsWithObservedModelRequest}; without observed requests: ${summary.inferenceObservation.runsWithoutObservedModelRequest} (missing observation is not proof that a request occurred)`,
    `- Fixed model: **${cell(summary.model ?? 'MISMATCH / unavailable')}**`,
    `- Design: ${summary.design.taskIds.length} tasks × ${summary.design.arms.length} arms × ${summary.design.repetitions} repeats`,
    `- Fair comparison: **${summary.fairness.valid ? 'yes' : 'NO — comparison invalid'}**`, '',
  ];
  for (const issue of summary.fairness.issues) lines.push(`- Fairness violation: ${cell(issue)}`);
  if (summary.configuration) lines.push('', '## Fixed nonsecret configuration', '', '```json', JSON.stringify(summary.configuration, null, 2), '```');
  lines.push('', '## Outcomes (all attempted runs)', '', '| Arm | Success | Rate | Task failures | Model errors | Platform errors | Grader errors | Safety failures | Mean time s | Total USD | USD / success |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const arm of summary.design.arms) {
    const value = summary.arms[arm]!;
    lines.push(`| ${arm} | ${value.successes}/${value.attempts} | ${percent(value.successRate)} | ${value.failures.task} | ${value.failures.model} | ${value.failures.platform} | ${value.failures.grader} | ${value.safetyFailures} | ${number(value.timeMs.mean === null ? null : value.timeMs.mean / 1000)} | ${number(value.costUsd.total, 6)} | ${value.costPerSuccess.reason ?? number(value.costPerSuccess.usd, 6)} |`);
  }
  const raw = summary.arms.raw;
  const full = summary.arms.dovspace;
  if (summary.fairness.valid && raw?.successRate !== null && raw?.successRate !== undefined && full?.successRate !== null && full?.successRate !== undefined) {
    lines.push('', `Descriptive Dovspace − Raw success-rate difference: **${((full.successRate - raw.successRate) * 100).toFixed(1)} percentage points**. This is not a significance claim.`);
  }
  lines.push('', '## Task-level outcomes', '', '| Task | Arm | Success | Checkpoint mean | Unknown cost runs | Unknown input / output token runs |', '| --- | --- | --- | --- | --- | --- |');
  for (const taskId of summary.design.taskIds) {
    for (const arm of summary.design.arms) {
      const value = summary.tasks[taskId]![arm]!;
      lines.push(`| ${cell(taskId)} | ${arm} | ${value.successes}/${value.attempts} | ${number(value.checkpointScore.mean)} | ${value.costUsd.unknownCount} | ${value.inputTokens.unknownCount} / ${value.outputTokens.unknownCount} |`);
    }
  }
  lines.push('', '## Intervention, PM retry proxy and detailed errors', '', '| Arm | Human interventions (total) | Unknown intervention runs | Failed-PM retries / attributable attempts | Weighted proxy proportion | Unknown retry / denominator runs | Detailed failure kinds |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const arm of summary.design.arms) {
    const value = summary.arms[arm]!;
    lines.push(`| ${arm} | ${number(value.humanInterventions.total, 0)} | ${value.humanInterventions.unknownCount} | ${number(value.rework.total, 0)} / ${number(value.reworkDenominator.total, 0)} | ${percent(value.reworkProportion)} | ${value.rework.unknownCount} / ${value.reworkDenominator.unknownCount} | ${cell(JSON.stringify(value.failureKinds))} |`);
  }
  lines.push('', '## Run evidence', '', '| Run | Task | Arm | Verified success | Error category | Evidence |', '| --- | --- | --- | --- | --- | --- |');
  for (const run of summary.runs) lines.push(`| ${cell(run.runId)} | ${cell(run.taskId)} | ${run.arm} | ${run.success ? 'yes' : 'no'} | ${run.failureCategory ?? 'none'} | ${run.resultPath ? link('result.json', run.resultPath, reportDirectory) : 'embedded in task-results.json'} |`);
  lines.push('', '## Interpretation limits', '');
  for (const caveat of summary.caveats) lines.push(`- ${caveat}`);
  lines.push('', 'Full independent checks, hashes, costs, error evidence and artifacts are preserved in `task-results.json`; machine-readable summaries are in `summary.json`.', '');
  return lines.join('\n');
}

export async function writeExperimentReport(runs: readonly RunResult[], directory: string, options: ReportOptions): Promise<ExperimentSummary> {
  const summary = aggregateExperiment(runs, options);
  await writeReportFile(resolve(directory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  await writeReportFile(resolve(directory, 'task-results.json'), `${JSON.stringify({ kind: 'model-experiment', schemaVersion: '0.1', design: summary.design, configuration: summary.configuration, runs }, null, 2)}\n`);
  await writeReportFile(resolve(directory, 'comparison.md'), renderComparison(summary, directory));
  return summary;
}

function parseModelRun(parsed: unknown): RunResult {
  if (typeof parsed === 'object' && parsed !== null && 'kind' in parsed) throw new Error('Expected a real-model run result; calibration/experiment documents cannot be imported as a model run');
  return RunResultSchema.parse(parsed);
}

export async function readRunResult(path: string): Promise<RunResult> {
  return parseModelRun(await readReportJson(path));
}

export async function readExperiment(directory: string): Promise<{ runs: RunResult[]; options: ReportOptions }> {
  const path = resolve(directory, 'task-results.json');
  const parsed = await readReportJson(path);
  if (typeof parsed !== 'object' || parsed === null || !('kind' in parsed) || parsed.kind !== 'model-experiment' || !('runs' in parsed) || !Array.isArray(parsed.runs)) {
    throw new Error('Expected a model-experiment task-results.json; calibration cannot be reported as an A/B experiment');
  }
  const runs = parsed.runs.map(parseModelRun);
  const summaryValue = await readReportJson(resolve(dirname(path), 'summary.json'));
  if (typeof summaryValue !== 'object' || summaryValue === null || !('experimentId' in summaryValue) || typeof summaryValue.experimentId !== 'string' || !('design' in summaryValue)) throw new Error('Invalid experiment summary metadata');
  const design = summaryValue.design;
  if (typeof design !== 'object' || design === null || !('arms' in design) || !Array.isArray(design.arms) || !design.arms.every((arm: unknown) => arm === 'raw' || arm === 'knowledge' || arm === 'dovspace') || !('taskIds' in design) || !Array.isArray(design.taskIds) || !design.taskIds.every((task: unknown) => typeof task === 'string') || !('repetitions' in design) || typeof design.repetitions !== 'number') throw new Error('Invalid experiment design');
  const options: ReportOptions = { experimentId: summaryValue.experimentId || basename(directory), design: { arms: design.arms as Arm[], taskIds: design.taskIds as string[], repetitions: design.repetitions } };
  if ('createdAt' in summaryValue && typeof summaryValue.createdAt === 'string') options.createdAt = summaryValue.createdAt;
  if ('configuration' in summaryValue && summaryValue.configuration !== null && summaryValue.configuration !== undefined) options.configuration = ConfigurationSchema.parse(summaryValue.configuration);
  if ('runs' in summaryValue && Array.isArray(summaryValue.runs)) {
    const resultPaths: Record<string, string> = {};
    for (const value of summaryValue.runs as unknown[]) {
      if (typeof value === 'object' && value !== null && 'runId' in value && typeof value.runId === 'string' && 'resultPath' in value && typeof value.resultPath === 'string') resultPaths[value.runId] = value.resultPath;
    }
    options.resultPaths = resultPaths;
  }
  return { runs, options };
}
