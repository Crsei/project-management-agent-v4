import { chmod, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { benchmarkConfig, parseBenchmarkConfig } from '../benchmark.config.ts';
import { prepareReportDirectory } from '../reports/files.ts';
import { RunResultSchema } from '../schemas/types.ts';
import { FrozenGradeInputSchema } from '../schemas/evaluation.ts';
import { getTaskDefinition } from '../tasks/index.ts';
import { admitEvidence, archiveCalibrationEvidence, assertReservedOutput, safeEvidenceBytes, safeEvidenceJson, sealEvidence, verifyEvidenceArchive, writeImmutableJson } from './archive.ts';
import { bytesHash, currentEvaluatorVersion, evidenceHash } from './evaluator.ts';
import { regradeEvidenceArchive } from './regrade.ts';
import { validateDatasetVersion, resolveDatasetArchiveRoot, isCanonicalDatasetMember } from './dataset.ts';
import { referenceCase } from '../calibration/reference.ts';
import { calibrationMutations, CALIBRATION_EXPECTED_FAILURES } from '../calibration/cases.ts';
import { gradeTask } from '../graders/index.ts';
import { CAPTURE_COMMAND_FLAGS, runCaptureCommand } from './commands-capture.ts';
import { EXPERIMENT_COMMAND_FLAGS, runExperimentCommand } from './commands-experiment.ts';

export const EVIDENCE_COMMAND_FLAGS: Record<string, readonly string[]> = {
  ...CAPTURE_COMMAND_FLAGS, ...EXPERIMENT_COMMAND_FLAGS,
  archive: ['input', 'output-root'], verify: ['input', 'output-root'],
  regrade: ['input', 'output-root', 'calibration', 'previous-grade', 'previous-grade-sha256', 'code-image'],
  'regrade-dataset': ['input', 'output-root', 'registry', 'calibration', 'code-image'],
  'archive-fixture': ['input', 'output-root', 'code-image'],
};
const archiveReference = z.object({ archiveRoot: z.string().min(1), manifestSha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
const importReference = z.object({ kind: z.literal('legacy-run-evidence'), resultPath: z.string().min(1), frozenInputPath: z.string().min(1).optional() }).strict();
function requiredFlag(flags: Record<string, string>, name: string): string { const value = flags[name]; if (!value) throw new Error(`Missing --${name}`); return value; }
function exactFlags(command: string, flags: Record<string, string>): void {
  for (const name of Object.keys(flags)) if (!EVIDENCE_COMMAND_FLAGS[command]!.includes(name)) throw new Error(`Unsupported evaluation ${command} flag --${name}`);
  requiredFlag(flags, 'input'); requiredFlag(flags, 'output-root');
}
export async function runEvidenceCommand(command: string, flags: Record<string, string>): Promise<{ exitCode: number; result: unknown } | undefined> {
  const capture = await runCaptureCommand(command, flags); if (capture) return capture;
  const experiment = await runExperimentCommand(command, flags); if (experiment) return experiment;
  if (!Object.hasOwn(EVIDENCE_COMMAND_FLAGS, command)) return undefined;
  exactFlags(command, flags);
  const input = await safeEvidenceJson(requiredFlag(flags, 'input'));
  const outputRoot = assertReservedOutput(requiredFlag(flags, 'output-root'));
  if (command === 'archive-fixture') {
    // Existing trusted grader-calibration inputs only; never provision an Agent or execute submitted code on the host.
    const selection = z.object({ taskId: z.enum(['K02', 'K03', 'D01', 'L02']), mutation: z.string().min(1).optional() }).strict().parse(input);
    const reference = referenceCase(selection.taskId, path.join(benchmarkConfig.runtimeRoot, 'offline-unmaterialized-reference'));
    const mutation = selection.mutation ? calibrationMutations(selection.taskId).find(item => item.name === selection.mutation) : null;
    if (selection.mutation && !mutation) throw new Error('Unknown trusted calibration mutation');
    mutation?.mutate(reference);
    const evaluator = await currentEvaluatorVersion(flags['code-image'] ?? benchmarkConfig.codeImage);
    const grade = await gradeTask(reference);
    const sealed = await archiveCalibrationEvidence(reference, grade, null, outputRoot, evaluator);
    const archive = await verifyEvidenceArchive(outputRoot, sealed.manifestSha256);
    return { exitCode: 0, result: { operation: 'archive-existing-calibration-fixture', archiveRoot: outputRoot, manifestSha256: sealed.manifestSha256, attemptId: archive.attempt!.attemptId, initialGradePath: sealed.initialGradePath, initialGradeSha256: sealed.initialGradeSha256, producer: 'synthetic-calibration', actualCriterionFailures: [...Object.values(grade.checks).flat(), ...grade.safetyGate.checks].filter(item => !item.passed).map(item => item.id), expectedFailedCheck: selection.mutation ? CALIBRATION_EXPECTED_FAILURES[selection.taskId]?.[selection.mutation] ?? null : null, inferencePerformed: false, modelQualityEvidence: false } };
  }
  if (command === 'archive') {
    const existing = archiveReference.safeParse(input);
    if (existing.success) {
      const archive = await verifyEvidenceArchive(existing.data.archiveRoot, existing.data.manifestSha256);
      if (!archive.manifest) throw new Error('A legacy result must use explicit legacy-run-evidence import');
      await prepareReportDirectory(outputRoot, true);
      for (const file of [...archive.manifest.files, { path: 'manifest.json', sha256: archive.manifestSha256! }]) {
        const bytes = await safeEvidenceBytes(path.join(archive.root, file.path));
        if (bytesHash(bytes) !== file.sha256) throw new Error('Archive changed while copying verified bytes');
        await writeFile(path.join(outputRoot, file.path), bytes, { flag: 'wx', mode: 0o400 });
      }
      await chmod(outputRoot, 0o500);
      return { exitCode: 0, result: { operation: 'archive-copy', archiveRoot: outputRoot, manifestSha256: archive.manifestSha256, representation: archive.manifest.representation, attemptId: archive.attempt!.attemptId, producer: archive.admission!.producer, authenticity: 'byte-identity-only-not-authorization', inferencePerformed: false } };
    }
    const imported = importReference.parse(input), result = RunResultSchema.parse(await safeEvidenceJson(imported.resultPath));
    const current = getTaskDefinition(result.taskId), task = { ...current, taskVersion: result.taskVersion, fixtureVersion: result.fixtureVersion };
    const admission = await admitEvidence({ root: outputRoot, runId: result.runId, task, arm: result.arm, producer: 'imported-claim', modelConfigSha256: evidenceHash({ claimed: result.reproducibility.modelConfigHash }), toolPolicySha256: evidenceHash({ claimed: result.reproducibility.permissionsHash }), harnessSha256: evidenceHash({ originalHarness: 'unknown-legacy' }), productSha256: null, codeImage: benchmarkConfig.codeImage });
    const inputs = imported.frozenInputPath ? FrozenGradeInputSchema.parse(await safeEvidenceJson(imported.frozenInputPath)) : undefined;
    const sealed = await sealEvidence({ ...admission, result, ...(inputs ? { inputs } : {}), events: inputs?.events ?? [] });
    return { exitCode: 0, result: { operation: 'archive-imported-claim', archiveRoot: outputRoot, ...sealed, inferencePerformed: false, modelQualityEvidence: false } };
  }
  if (command === 'verify') {
    const reference = archiveReference.parse(input), archive = await verifyEvidenceArchive(reference.archiveRoot, reference.manifestSha256);
    await prepareReportDirectory(outputRoot, true);
    const result = { operation: 'verify-not-regrade', archiveRoot: archive.root, manifestSha256: archive.manifestSha256, representation: archive.manifest?.representation ?? null, legacy: archive.legacy, admission: archive.admission, attempt: archive.attempt, evaluator: archive.evaluator, missingInputs: archive.inputs?.omittedInputs ?? ['public-snapshots', 'entities-receipts', 'events', 'isolation', 'full-authority'], authenticity: 'byte-identity-only-not-authorization', inferencePerformed: false };
    await writeImmutableJson(path.join(outputRoot, 'verification.json'), result);
    return { exitCode: archive.legacy ? 2 : 0, result };
  }
  const config = parseBenchmarkConfig({ ...benchmarkConfig, ...(flags['code-image'] ? { codeImage: flags['code-image'] } : {}) });
  if (command === 'regrade') {
    const reference = archiveReference.parse(input);
    if (Boolean(flags['previous-grade']) !== Boolean(flags['previous-grade-sha256'])) throw new Error('Previous grade requires both path and digest');
    const result = await regradeEvidenceArchive({ archiveRoot: reference.archiveRoot, ...(reference.manifestSha256 ? { manifestSha256: reference.manifestSha256 } : {}), outputRoot, config, ...(flags['calibration'] ? { calibrationPath: flags['calibration'] } : {}), ...(flags['previous-grade'] ? { previousGradePath: flags['previous-grade'], previousGradeSha256: flags['previous-grade-sha256']! } : {}) });
    return { exitCode: result.grade.status === 'passed' ? 0 : 2, result: { operation: 'regrade-not-rerun', grade: result.grade, gradePath: result.gradePath, gradeSha256: result.gradeSha256, archiveRoot: result.archive.root, inferencePerformed: false, pmReplayPerformed: false } };
  }
  const selection = z.object({ datasetId: z.string().min(1), version: z.string().min(1) }).strict().parse(input);
  const registryRoot = requiredFlag(flags, 'registry');
  const dataset = await validateDatasetVersion({ registryRoot, ...selection });
  await prepareReportDirectory(outputRoot, true);
  const members: unknown[] = []; let matched = 0;
  for (const [index, member] of dataset.members.entries()) {
    if (isCanonicalDatasetMember(member)) { members.push({ memberId: member.memberId, evaluationMode: 'canonical-task', status: 'not-applicable', labelsMatched: false, reason: 'Fresh canonical task has no frozen output to regrade; execute its registered task contract through actual run admission' }); continue; }
    try {
      const regraded = await regradeEvidenceArchive({ archiveRoot: resolveDatasetArchiveRoot(registryRoot, member.archiveRoot), manifestSha256: member.manifestDigest, outputRoot: path.join(outputRoot, `member-${index + 1}`), config, ...(flags['calibration'] ? { calibrationPath: flags['calibration'] } : {}) });
      const labels = member.expectedCriteria.map(label => { const actual = regraded.grade.criteria.find(item => item.criterionId === label.criterionId)?.status ?? 'not-evaluable'; return { criterionId: label.criterionId, expected: label.expected, actual, matched: actual === (label.expected === 'pass' ? 'passed' : 'failed') }; });
      const labelsMatched = labels.length > 0 && labels.every(item => item.matched); if (labelsMatched) matched += 1;
      members.push({ memberId: member.memberId, attemptId: regraded.grade.attemptId, gradeId: regraded.grade.gradeId, gradePath: regraded.gradePath, gradeSha256: regraded.gradeSha256, status: regraded.grade.status, labels, labelsMatched });
    } catch { members.push({ memberId: member.memberId, status: 'not-evaluable', labelsMatched: false, reason: 'Member archive/evaluator validation or regrading failed; no inference or PM replay attempted' }); }
  }
  const result = { operation: 'dataset-regrade-not-rerun', datasetId: dataset.datasetId, version: dataset.version, datasetDigest: dataset.digest, denominator: dataset.members.length, independentlyMatchedMembers: matched, complete: members.length === dataset.members.length && matched === dataset.members.length && dataset.members.length > 0, members, releaseEligible: false, inferencePerformed: false, pmReplayPerformed: false };
  await writeImmutableJson(path.join(outputRoot, 'dataset-regrade.json'), result);
  return { exitCode: result.complete ? 0 : 2, result };
}
