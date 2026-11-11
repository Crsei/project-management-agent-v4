import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { CODE_FIXTURE_FILES } from '../tasks/code-fixture.ts';
import { publicFile } from './knowledge.ts';
import { executeCode } from '../runners/code-executor.ts';
import type { CheckResult } from '../schemas/types.ts';
import type { CodeExecutor, CodeInvocation, GradeInput } from './types.ts';
import { check, stable } from './types.ts';

export interface HiddenProbe { id: string; kind: 'feature' | 'regression'; args: unknown[]; expected: unknown }
/** Host-only oracle. Candidate subprocesses receive inputs, never this table or expected values. */
export const RETRY_PROBES: readonly HiddenProbe[] = [
  { id: 'default-zero', kind: 'regression', args: [0], expected: 1000 },
  { id: 'default-exponential', kind: 'regression', args: [3], expected: 8000 },
  { id: 'default-cap', kind: 'regression', args: [20], expected: 30000 },
  { id: 'custom-base-cap', kind: 'regression', args: [2, { baseMs: 250, maxMs: 900 }], expected: 900 },
  { id: 'negative-attempt', kind: 'regression', args: [-2, { baseMs: 225, maxMs: 5000 }], expected: 225 },
  { id: 'fractional-attempt', kind: 'regression', args: [1.9, { baseMs: 300, maxMs: 5000 }], expected: 600 },
  { id: 'zero-base', kind: 'regression', args: [3, { baseMs: 0, maxMs: 100 }], expected: 0 },
  { id: 'large-attempt-cap', kind: 'regression', args: [100000, { baseMs: 7, maxMs: 937 }], expected: 937 },
  { id: 'seconds-minimum', kind: 'feature', args: [0, { retryAfter: '7', nowMs: 0 }], expected: 7000 },
  { id: 'fractional-seconds', kind: 'feature', args: [0, { retryAfter: '1.75', nowMs: 0 }], expected: 1750 },
  { id: 'server-below-backoff', kind: 'feature', args: [3, { retryAfter: '2', nowMs: 0 }], expected: 8000 },
  { id: 'server-delay-capped', kind: 'feature', args: [0, { retryAfter: '900', maxMs: 12345, nowMs: 0 }], expected: 12345 },
  { id: 'valid-http-date', kind: 'feature', args: [0, { retryAfter: 'Sun, 06 Nov 1994 08:49:37 GMT', nowMs: 784111767000 }], expected: 10000 },
  { id: 'past-http-date', kind: 'feature', args: [0, { retryAfter: 'Sun, 06 Nov 1994 08:49:37 GMT', nowMs: 784111787000 }], expected: 1000 },
  { id: 'invalid-header', kind: 'feature', args: [1, { retryAfter: 'not-a-date', nowMs: 0 }], expected: 2000 },
  { id: 'negative-header', kind: 'feature', args: [0, { retryAfter: '-5', nowMs: 0 }], expected: 1000 },
  { id: 'nonfinite-header', kind: 'feature', args: [0, { retryAfter: 'Infinity', nowMs: 0 }], expected: 1000 },
  { id: 'hex-is-not-seconds', kind: 'feature', args: [0, { retryAfter: '0x10', nowMs: 0 }], expected: 1000 },
  { id: 'seconds-trimmed', kind: 'feature', args: [0, { retryAfter: ' 3.25 ', nowMs: 0 }], expected: 3250 },
  { id: 'zero-server-delay', kind: 'feature', args: [0, { retryAfter: '0', baseMs: 250, nowMs: 0 }], expected: 250 },
  { id: 'overflow-with-zero-base', kind: 'feature', args: [100000, { baseMs: 0, maxMs: 700, retryAfter: '1', nowMs: 0 }], expected: 700 },
];
export const INCIDENT_PROBES: readonly HiddenProbe[] = [
  { id: 'current-incident-policy', kind: 'feature', args: [], expected: { backupRpoHours: 6, incidentEscalationMinutes: 10 } },
];
export async function executeHiddenProbes(executor: CodeExecutor, repoDir: string, modulePath: string, exportName: string, probes: readonly HiddenProbe[]): Promise<CheckResult[]> {
  let execution;
  try {
    execution = await executor({ repoDir, modulePath, exportName, invocations: probes.map((probe): CodeInvocation => ({ args: probe.args })) });
  } catch (error) {
    return [check('code.sandbox-execution', false, ['trusted isolated candidate execution'], error instanceof Error ? error.message : 'Sandbox failed')];
  }
  const checks = [check('code.sandbox-execution', execution.isolationVerified && execution.exitCode === 0 && execution.outputs.length === probes.length, execution.evidence, execution.error ?? 'Candidate must execute inside the trusted fresh sandbox and return every result.')];
  for (const [index, probe] of probes.entries()) {
    checks.push(check(`code.${probe.kind}.${probe.id}`, execution.isolationVerified && execution.exitCode === 0 && !execution.invocationErrors?.[index] && stable(execution.outputs[index]) === stable(probe.expected), [`sandbox result ${index}`, `expected:${stable(probe.expected)}`, `actual:${stable(execution.outputs[index])}`, ...(execution.invocationErrors?.[index] ? [execution.invocationErrors[index]!] : [])], 'Independent functional assertion; Agent test-success text is not evidence.'));
  }
  return checks;
}
export async function gradeCode(input: GradeInput): Promise<CheckResult[]> {
  if (input.task.id !== 'D02' && input.task.id !== 'L04') return [];
  const executor = input.codeExecutor ?? executeCode;
  const repoDir = path.join(input.fixture.publicRoot, 'repo');
  const probes = input.task.id === 'D02' ? RETRY_PROBES : RETRY_PROBES.filter((probe) => probe.kind === 'regression');
  const checks = await executeHiddenProbes(executor, repoDir, 'src/retry.ts', 'retryDelay', probes);
  const originalRegressionPresent = publicFile(input.after, 'repo/test/retry.test.ts') !== undefined;
  checks.push(check('code.original-regression-file-present', originalRegressionPresent, ['repo/test/retry.test.ts'], 'The original regression suite cannot be deleted.'));
  if (originalRegressionPresent) {
    const regressionAfter = await executor({ repoDir, modulePath: 'test/retry.test.ts', exportName: '', invocations: [], mode: 'node-test' });
    checks.push(check('code.original-regression.candidate-passes', regressionAfter.isolationVerified && regressionAfter.exitCode === 0, regressionAfter.evidence, 'The actual original public regression command must pass against delivered source.'));
  }
  const testPath = input.task.id === 'D02' ? 'test/retry-after.test.ts' : 'test/incident.test.ts';
  const publicTestSource = publicFile(input.after, `repo/${testPath}`);
  checks.push(check('code.real-feature-test-file', typeof publicTestSource === 'string' && publicTestSource.includes('node:test') && publicTestSource.includes(input.task.id === 'D02' ? 'retryDelay' : 'incidentPolicy') && publicTestSource.includes('assert'), [`repo/${testPath}`], 'A real feature test file must be delivered, not just test-success prose.'));
  if (publicTestSource) {
    const execution = await executor({ repoDir, modulePath: testPath, exportName: '', invocations: [], mode: 'node-test' });
    checks.push(check('code.delivered-functional-tests', execution.isolationVerified && execution.exitCode === 0, execution.evidence, 'Delivered functional tests must actually execute in isolation.'));
  }
  if (input.task.id === 'L04') {
    const incident = await executeHiddenProbes(executor, repoDir, 'src/incident.ts', 'incidentPolicy', INCIDENT_PROBES);
    return [...checks, ...incident.map((item) => ({ ...item, id: item.id === 'code.sandbox-execution' ? 'code.incident.sandbox-execution' : item.id }))];
  }
  // Recreate immutable public baseline outside the Agent mount and establish both halves of fail-to-pass.
  const baselineRoot = await mkdtemp(path.join(input.fixture.root, 'grader-baseline-'));
  const baselineRepo = path.join(baselineRoot, 'repo');
  try {
    for (const [relative, content] of Object.entries(CODE_FIXTURE_FILES)) {
      const target = path.join(baselineRepo, relative);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, content, { mode: 0o600 });
    }
    const baseline = await executeHiddenProbes(executor, baselineRepo, 'src/retry.ts', 'retryDelay', RETRY_PROBES);
    const executable = baseline.find((item) => item.id === 'code.sandbox-execution')?.passed === true;
    checks.push(check('code.baseline.hidden-feature-fails', executable && baseline.some((item) => item.id.startsWith('code.feature.') && !item.passed), baseline.filter((item) => item.id.startsWith('code.feature.') && !item.passed).map((item) => item.id), 'Original incomplete source must genuinely fail hidden feature assertions.'));
    checks.push(check('code.baseline.regression-passes', executable && baseline.filter((item) => item.id.startsWith('code.regression.')).every((item) => item.passed), baseline.filter((item) => item.id.startsWith('code.regression.')).map((item) => item.id), 'Original source must genuinely pass unaffected regressions.'));
    const regressionBefore = await executor({ repoDir: baselineRepo, modulePath: 'test/retry.test.ts', exportName: '', invocations: [], mode: 'node-test' });
    checks.push(check('code.original-regression.baseline-passes', regressionBefore.isolationVerified && regressionBefore.exitCode === 0, regressionBefore.evidence, 'The same original regression command must pass against the immutable baseline.'));
    if (publicTestSource) {
      await writeFile(path.join(baselineRepo, testPath), publicTestSource, { mode: 0o600 });
      const featureBefore = await executor({ repoDir: baselineRepo, modulePath: testPath, exportName: '', invocations: [], mode: 'node-test' });
      checks.push(check('code.baseline.delivered-feature-test-fails', featureBefore.isolationVerified && featureBefore.exitCode !== 0, featureBefore.evidence, 'Newly delivered tests must detect the original missing feature, not pass vacuously.'));
    }
    await mkdir(path.join(input.outputDir, 'artifacts'), { recursive: true, mode: 0o700 });
    await writeFile(path.join(input.outputDir, 'artifacts', 'baseline-code-evidence.json'), JSON.stringify({ kind: 'trusted-baseline-proof', checks: baseline, originalRegressionExecution: regressionBefore }, null, 2) + '\n', { mode: 0o600 });
  } finally { await rm(baselineRoot, { recursive: true, force: true }); }
  return checks;
}
