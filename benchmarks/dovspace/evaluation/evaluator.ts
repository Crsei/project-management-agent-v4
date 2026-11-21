import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { benchmarkConfig, repositoryRoot } from '../benchmark.config.ts';
import { referenceCase } from '../calibration/reference.ts';
import { gradeKnowledge, gradeProcess, gradeSafety, gradeState, RETRY_PROBES, INCIDENT_PROBES } from '../graders/index.ts';
import { EvaluatorVersionSchema, type EvaluatorVersion } from '../schemas/evaluation.ts';
import { getTaskDefinition, RUNNABLE_TASK_IDS } from '../tasks/index.ts';
import { stable } from '../graders/types.ts';
import { docker } from '../isolation/docker.ts';

export function evidenceHash(value: unknown): string { return createHash('sha256').update(stable(value)).digest('hex'); }
export function bytesHash(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
async function digestTree(names: readonly string[], root = repositoryRoot): Promise<string> {
  const files: { path: string; sha256: string }[] = [];
  async function visit(name: string): Promise<void> {
    if (name === 'benchmarks/dovspace/evaluation/release-policy-registry.json') return;
    const absolute = path.join(root, name), info = await lstat(absolute);
    if (info.isSymbolicLink() || !info.isDirectory() && (!info.isFile() || info.nlink !== 1)) throw new Error('Evaluator source is not an independent regular file');
    if (info.isDirectory()) {
      for (const entry of (await readdir(absolute)).sort()) if (!entry.startsWith('.') && !entry.endsWith('.test.ts') && entry !== 'node_modules') await visit(`${name}/${entry}`);
    } else files.push({ path: name, sha256: bytesHash(await readFile(absolute)) });
  }
  for (const name of names) await visit(name);
  return evidenceHash(files.sort((a, b) => a.path.localeCompare(b.path)));
}
const codeChecks = ['code.sandbox-execution', 'code.original-regression-file-present', 'code.original-regression.candidate-passes', 'code.real-feature-test-file', 'code.delivered-functional-tests', 'code.baseline.hidden-feature-fails', 'code.baseline.regression-passes', 'code.original-regression.baseline-passes', 'code.baseline.delivered-feature-test-fails'];
/** The required rule revision, not a claim that this revision reached the tested Agent. */
export function criterionRequirementRevision(taskId: string, criterionId: string, taskVersion: string): string {
  if (taskId !== 'L03') return taskVersion;
  if (['code.initial-requirement.independent-execution', 'process.guidance.real-initial-implementation'].includes(criterionId)) return 'retry-v1';
  if (criterionId.startsWith('code.feature.') || criterionId.startsWith('code.baseline.') || criterionId.startsWith('code.extra-tests.') || ['code.real-feature-test-file', 'code.delivered-functional-tests', 'state.code-issue-consistency', 'process.guidance.replanned-all-acceptance', 'process.guidance.current-delivery-docs', 'process.guidance.measured-rework'].includes(criterionId)) return 'retry-v2';
  return taskVersion;
}
/** Enumerates actual grader obligations, never Agent-provided criterion labels. No code is executed here. */
export function criterionCatalog(taskId: typeof RUNNABLE_TASK_IDS[number]): EvaluatorVersion['criteria'] {
  const input = referenceCase(taskId, '/criterion-catalog-not-materialized');
  const checks = [...gradeKnowledge(input), ...gradeState(input), ...gradeProcess(input), ...gradeSafety(input).safetyGate.checks];
  const ids = new Map(checks.map(item => [item.id, item.required]));
  if (['K04', 'D02', 'D04', 'L03', 'L04'].includes(taskId)) {
    for (const id of codeChecks.filter(id => taskId !== 'L04' || !id.startsWith('code.baseline.') && id !== 'code.original-regression.baseline-passes')) ids.set(id, true);
    for (const probe of RETRY_PROBES.filter(item => taskId !== 'L04' || item.kind === 'regression')) ids.set(`code.${probe.kind}.${probe.id}`, true);
    if (taskId === 'L04') { ids.set('code.incident.sandbox-execution', true); for (const probe of INCIDENT_PROBES) ids.set(`code.${probe.kind}.${probe.id}`, true); }
    if (taskId === 'D04') ids.set('code.extra-tests.test/retry-partial.test.ts', true);
    if (taskId === 'L03') { ids.set('code.extra-tests.test/retry-change.test.ts', true); ids.set('code.initial-requirement.independent-execution', true); }
  }
  return [...ids].map(([criterionId, required]): EvaluatorVersion['criteria'][number] => ({ taskId, criterionId, required, inputs: criterionId === 'safety.no-unrelated-mutations' ? ['full-authority'] : criterionId.startsWith('code.') ? ['public-snapshots', 'code-sandbox'] : criterionId.startsWith('knowledge.') ? ['public-snapshots'] : criterionId.startsWith('state.') ? ['entities-receipts', 'public-snapshots'] : criterionId === 'process.isolation' ? ['isolation'] : ['events', 'entities-receipts', 'public-snapshots'] }));
}
export const EVALUATOR_IMPLEMENTATION_INPUTS = ['benchmarks/dovspace/graders', 'benchmarks/dovspace/tasks', 'benchmarks/dovspace/fixtures', 'benchmarks/dovspace/schemas', 'benchmarks/dovspace/evaluation', 'benchmarks/dovspace/runners/guidance-checkpoints.ts', 'benchmarks/dovspace/runners/code-executor.ts', 'benchmarks/dovspace/runners/code-executor-security.ts', 'benchmarks/dovspace/isolation/docker.ts', 'benchmarks/dovspace/benchmark.config.ts'] as const;

/** Approval and revocation records are mutable authority, never evaluator implementation inputs. */
export async function collectEvaluatorImplementationHash(root = repositoryRoot): Promise<string> {
  return digestTree(EVALUATOR_IMPLEMENTATION_INPUTS, root);
}
/** Trusted public task/fixture template identity; independent of Docker and mutable approval records. */
export async function collectDatasetDefinitionHash(root = repositoryRoot): Promise<string> {
  return digestTree(['benchmarks/dovspace/fixtures/dataset.ts', 'benchmarks/dovspace/fixtures/documents.ts', 'benchmarks/dovspace/tasks/code-fixture.ts', 'benchmarks/dovspace/tasks/guidance.ts'], root);
}
export async function currentEvaluatorVersion(codeImage = benchmarkConfig.codeImage, calibrationSha256: string | null = null): Promise<EvaluatorVersion> {
  const codeSha256 = await collectEvaluatorImplementationHash();
  const dependencySha256 = await digestTree(['pnpm-lock.yaml', 'package.json', 'benchmarks/dovspace/package.json', 'packages/application/src', 'packages/agent-contracts/src', 'packages/domain/src', 'packages/pm-schema', 'packages/pm-markdown']);
  const calibrationDefinitionSha256 = await digestTree(['benchmarks/dovspace/calibration']);
  const datasetDefinitionSha256 = await collectDatasetDefinitionHash();
  const inspectedImage = /^sha256:[a-f0-9]{64}$/.test(codeImage) ? codeImage : await docker(['image', 'inspect', '--format', '{{.Id}}', '--', codeImage], {}, 10_000).catch(() => null);
  const codeImageDigest = inspectedImage && /^sha256:[a-f0-9]{64}$/.test(inspectedImage) ? inspectedImage : null;
  const value = { version: '1' as const, evaluatorId: 'dovspace-independent-graders' as const, codeSha256, dependencySha256, calibrationDefinitionSha256, datasetDefinitionSha256, runtime: { node: process.versions.node, codeImage, codeImageDigest }, applicableTasks: RUNNABLE_TASK_IDS.map(taskId => ({ taskId, taskVersion: getTaskDefinition(taskId).taskVersion })), criteria: RUNNABLE_TASK_IDS.flatMap(criterionCatalog), aggregation: 'all-required-and-clean-execution' as const, calibrationSha256 };
  return EvaluatorVersionSchema.parse({ ...value, sha256: evidenceHash(value) });
}
export function assertEvaluatorIdentity(evaluator: EvaluatorVersion): void {
  const { sha256, ...value } = evaluator;
  if (evidenceHash(value) !== sha256) throw new Error('Evaluator identity does not reconstruct its frozen version');
}
