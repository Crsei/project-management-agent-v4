import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { benchmarkConfig, parseBenchmarkConfig, type BenchmarkConfig } from '../benchmark.config.ts';
import { gradeTask } from '../graders/index.ts';
import type { GradeInput, GradeResult } from '../graders/types.ts';
import { createCodeExecutor } from '../runners/code-executor.ts';
import { prepareReportDirectory } from '../reports/files.ts';
import { CalibrationEvidenceSchema, EvaluatorVersionSchema, GradeRunSchema, type GradeRun, type FrozenGradeInput, type EvaluatorVersion } from '../schemas/evaluation.ts';
import type { FixtureHandle, FixtureSnapshot } from '../schemas/types.ts';
import { getTaskDefinition, resolveTaskDefinition, RUNNABLE_TASK_IDS } from '../tasks/index.ts';
import { assertReservedOutput, safeEvidenceBytes, safeEvidenceJson, verifyEvidenceArchive, writeImmutableJson, type VerifiedEvidenceArchive } from './archive.ts';
import { assertEvaluatorIdentity, bytesHash, criterionRequirementRevision, evidenceHash } from './evaluator.ts';
import { loadEvaluatorCalibration } from './calibration.ts';

export async function readGradeRun(archive: VerifiedEvidenceArchive, gradePath: string, expectedSha256: string): Promise<GradeRun> {
  const bytes = await safeEvidenceBytes(gradePath);
  if (!/^[a-f0-9]{64}$/.test(expectedSha256) || bytesHash(bytes) !== expectedSha256) throw new Error('Grade digest mismatch');
  let value: unknown; try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Malformed grade JSON'); }
  const grade = GradeRunSchema.parse(value);
  if (grade.attemptId !== (archive.attempt?.attemptId ?? null) || grade.manifestSha256 !== archive.manifestSha256) throw new Error('Grade is bound to different archived evidence');
  const evaluator = grade.kind === 'initial' ? archive.evaluator : EvaluatorVersionSchema.parse(await safeEvidenceJson(path.join(path.dirname(path.resolve(gradePath)), 'evaluator.json')));
  if (!evaluator) throw new Error('Grade has no immutable evaluator version');
  assertEvaluatorIdentity(evaluator);
  if (grade.evaluatorSha256 !== evaluator.sha256 || grade.calibrationSha256 !== evaluator.calibrationSha256) throw new Error('Grade evaluator/calibration binding mismatch');
  if (evaluator.calibrationSha256 !== null) {
    const calibrationBytes = await safeEvidenceBytes(path.join(path.dirname(path.resolve(gradePath)), 'calibration.json'));
    if (bytesHash(calibrationBytes) !== evaluator.calibrationSha256) throw new Error('Frozen calibration artifact digest mismatch');
    const calibration = CalibrationEvidenceSchema.parse(JSON.parse(calibrationBytes.toString('utf8')) as unknown);
    const { sha256: _calibratedIdentity, ...version } = evaluator;
    if (!calibration.success || calibration.evaluatorSha256 !== evidenceHash({ ...version, calibrationSha256: null }) || calibration.calibrationDefinitionSha256 !== evaluator.calibrationDefinitionSha256 || calibration.infrastructureErrors.length || calibration.codeExecution.realSandboxCalls === 0 || calibration.cases.length === 0 || calibration.cases.some(item => !item.passed || !item.exercised || !item.intendedFailureObserved || !item.boundaryChecksObserved || item.error !== null || item.expectedPass !== item.actualPass)) throw new Error('Frozen calibration is incomplete or bound to a different evaluator');
  }
  return grade;
}
async function materializeFrozen(inputs: FrozenGradeInput, root: string, outputDir: string): Promise<GradeInput> {
  const publicRoot = path.join(root, 'public'); await mkdir(publicRoot, { mode: 0o700 });
  let total = 0;
  for (const [name, encoded] of Object.entries(inputs.after.publicFiles)) {
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded || (total += bytes.length) > 64 * 1024 * 1024 || bytes.length > 8 * 1024 * 1024) throw new Error('Invalid or oversized frozen public input');
    const target = path.join(publicRoot, name); await mkdir(path.dirname(target), { recursive: true, mode: 0o700 }); await writeFile(target, bytes, { mode: 0o400, flag: 'wx' });
  }
  const snapshot = (value: FrozenGradeInput['before']): FixtureSnapshot => ({ ...value, tables: {}, files: {} });
  const fixture: FixtureHandle = { ...inputs.fixture, root, publicRoot, authorityRoot: path.join(root, 'authority-unavailable'), agentDataRoot: path.join(root, 'agent-unavailable'), actorId: 'offline-not-authorized', pm: { baseUrl: 'http://127.0.0.1:0', token: '' }, runtime: null, isolation: inputs.fixture.isolation ? { ...inputs.fixture.isolation, backend: 'docker', containerId: 'archived-not-running', networkId: 'archived-not-running' } : null };
  return { task: { ...resolveTaskDefinition(inputs.taskId, fixture), allowedTargets: inputs.allowedTargets }, fixture, before: snapshot(inputs.before), after: snapshot(inputs.after), events: inputs.events, outputDir };
}
function criterionGrades(archive: VerifiedEvidenceArchive, evaluator: EvaluatorVersion, graded: GradeResult | null, reason: string | null, sandboxUnavailable: boolean): GradeRun['criteria'] {
  const taskId = archive.admission?.taskId ?? archive.result?.taskId;
  if (!RUNNABLE_TASK_IDS.includes(taskId as typeof RUNNABLE_TASK_IDS[number])) return [{ criterionId: 'archive.task-applicability', required: true, status: 'not-evaluable', reason: 'Unsupported or unidentified archived task', evidence: [], taskVersion: archive.result?.taskVersion ?? 'unknown', requirementRevision: 'unknown' }];
  const catalog = evaluator.criteria.filter(item => item.taskId === taskId);
  const observed = new Map(graded ? [...Object.values(graded.checks).flat(), ...graded.safetyGate.checks].map(item => [item.id, item]) : []);
  // Retain new conditional grader checks too; an inventory must never hide a failed obligation.
  for (const item of observed.values()) if (!catalog.some(entry => entry.criterionId === item.id)) catalog.push({ taskId: taskId as typeof RUNNABLE_TASK_IDS[number], criterionId: item.id, required: item.required, inputs: ['public-snapshots'] });
  return catalog.map(item => {
    const found = observed.get(item.criterionId), version = archive.admission?.taskVersion ?? archive.result?.taskVersion ?? 'unknown';
    const revision = criterionRequirementRevision(taskId!, item.criterionId, version);
    let unavailable = reason;
    if (!unavailable && item.inputs.includes('full-authority')) unavailable = 'Full authorization/account/authority snapshot deliberately not exported; never refill from current PM';
    if (!unavailable && (sandboxUnavailable || evaluator.runtime.codeImageDigest === null) && item.criterionId.startsWith('code.')) unavailable = 'Independent code sandbox/runtime identity did not establish isolated pinned execution';
    const revised = revision === 'retry-v2' && !archive.attempt?.requirementRevisions.includes(revision);
    return { criterionId: item.criterionId, required: item.required, status: unavailable ? 'not-evaluable' as const : revised ? 'not-applicable' as const : found ? found.passed ? 'passed' as const : 'failed' as const : 'not-evaluable' as const, reason: unavailable ?? (revised ? 'Revised requirement was not delivered before original execution stopped' : found?.reason ?? (found ? null : 'Evaluator did not produce this required obligation')), evidence: found?.evidence ?? [], taskVersion: version, requirementRevision: revision };
  });
}
export async function regradeEvidenceArchive(options: { archiveRoot: string; manifestSha256?: string; outputRoot: string; calibrationPath?: string; previousGradePath?: string; previousGradeSha256?: string; config?: BenchmarkConfig }): Promise<{ grade: GradeRun; gradePath: string; gradeSha256: string; archive: VerifiedEvidenceArchive }> {
  const archive = await verifyEvidenceArchive(options.archiveRoot, options.manifestSha256), config = parseBenchmarkConfig(options.config ?? benchmarkConfig);
  const outputRoot = assertReservedOutput(options.outputRoot);
  await prepareReportDirectory(outputRoot, true);
  const { evaluator, calibrationBytes } = await loadEvaluatorCalibration(config.codeImage, options.calibrationPath);
  const previous = options.previousGradePath ? await readGradeRun(archive, options.previousGradePath, options.previousGradeSha256 ?? '') : null;
  let gradeResult: GradeResult | null = null, reason: string | null = null, sandboxUnavailable = false, runtime: string | undefined;
  if (!archive.inputs || !archive.admission) reason = archive.legacy ? 'Legacy archive has no frozen host grading inputs; per-criterion regrade is unsupported' : 'Admitted attempt lacks complete captured grading inputs';
  else if (!evaluator.applicableTasks.some(item => item.taskId === archive.admission!.taskId && item.taskVersion === archive.admission!.taskVersion) || archive.inputs.taskVersion !== getTaskDefinition(archive.inputs.taskId).taskVersion) reason = 'Current evaluator is inapplicable to archived task version; rerun requires a new admission';
  try {
    if (!reason && archive.inputs) {
      await prepareReportDirectory(config.runtimeRoot);
      runtime = await mkdtemp(path.join(config.runtimeRoot, 'regrade-'));
      const input = await materializeFrozen(archive.inputs, runtime, outputRoot), execute = createCodeExecutor({ ...config, codeImage: evaluator.runtime.codeImageDigest ?? config.codeImage });
      input.codeExecutor = async request => { const execution = await execute(request); if (!execution.isolationVerified) sandboxUnavailable = true; return execution; };
      try { gradeResult = await gradeTask(input); } catch { reason = 'Independent evaluator could not complete on the sealed inputs'; }
    }
  } finally { if (runtime) await rm(runtime, { recursive: true, force: false }); }
  const criteria = criterionGrades(archive, evaluator, gradeResult, reason, sandboxUnavailable);
  const failed = criteria.some(item => item.required && item.status === 'failed');
  const complete = criteria.some(item => item.required) && criteria.every(item => !item.required || item.status === 'passed') && archive.attempt !== null && archive.attempt.executionFailure === null;
  const grade = GradeRunSchema.parse({ version: '1', gradeId: `grade-${randomUUID()}`, attemptId: archive.attempt?.attemptId ?? null, manifestSha256: archive.manifestSha256, evaluatorSha256: evaluator.sha256, calibrationSha256: evaluator.calibrationSha256, previousGradeId: previous?.gradeId ?? null, createdAt: new Date().toISOString(), kind: 'regrade', status: failed ? 'failed' : complete ? 'passed' : 'not-evaluable', releaseEligible: false, criteria, executionFailure: archive.attempt?.executionFailure ?? null });
  const gradePath = path.join(outputRoot, 'grade.json');
  await writeImmutableJson(path.join(outputRoot, 'evaluator.json'), evaluator);
  if (calibrationBytes) await writeFile(path.join(outputRoot, 'calibration.json'), calibrationBytes, { mode: 0o400, flag: 'wx' });
  await writeImmutableJson(gradePath, grade);
  const gradeSha256 = bytesHash(await safeEvidenceBytes(gradePath));
  await writeImmutableJson(path.join(outputRoot, 'grade-manifest.json'), { version: '1', gradeId: grade.gradeId, gradeSha256, evaluatorSha256: evaluator.sha256, attemptId: grade.attemptId, manifestSha256: grade.manifestSha256, operation: 'regrade-not-rerun', inferencePerformed: false, pmReplayPerformed: false });
  return { grade, gradePath, gradeSha256, archive };
}
