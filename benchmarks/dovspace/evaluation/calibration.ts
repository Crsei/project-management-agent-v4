import { CalibrationEvidenceSchema, EvaluatorVersionSchema, type EvaluatorVersion } from '../schemas/evaluation.ts';
import { calibrationMutations, calibrationExpectedPasses, CALIBRATION_EXPECTED_FAILURES } from '../calibration/cases.ts';
import { RUNNABLE_TASK_IDS } from '../tasks/index.ts';
import { safeEvidenceBytes } from './archive.ts';
import { bytesHash, currentEvaluatorVersion, evidenceHash } from './evaluator.ts';

export interface EvaluatorCalibrationSnapshot { evaluator: EvaluatorVersion; calibrationBytes: Buffer | null }
/** Validates before model admission and returns the exact bytes to seal, never a path to reopen later. */
export async function loadEvaluatorCalibration(codeImage: string, calibrationPath?: string, task?: { taskId: string; taskVersion: string }): Promise<EvaluatorCalibrationSnapshot> {
  const evaluator = await currentEvaluatorVersion(codeImage);
  if (task && !evaluator.applicableTasks.some(item => item.taskId === task.taskId && item.taskVersion === task.taskVersion)) throw new Error('Evaluator is inapplicable to the admitted task version');
  if (!calibrationPath) return { evaluator, calibrationBytes: null };
  const calibrationBytes = await safeEvidenceBytes(calibrationPath);
  let value: unknown; try { value = JSON.parse(calibrationBytes.toString('utf8')); } catch { throw new Error('Malformed calibration JSON'); }
  const parsed = CalibrationEvidenceSchema.safeParse(value);
  if (!parsed.success) throw new Error('Calibration is missing, incomplete or belongs to changed evaluator/dependencies/runtime');
  const calibration = parsed.data;
  if (!calibration.success || calibration.evaluatorSha256 !== evaluator.sha256 || calibration.calibrationDefinitionSha256 !== evaluator.calibrationDefinitionSha256 || calibration.infrastructureErrors.length || calibration.codeExecution.realSandboxCalls === 0 || evaluator.runtime.codeImageDigest === null) throw new Error('Calibration is missing, incomplete or belongs to changed evaluator/dependencies/runtime');
  const expected = RUNNABLE_TASK_IDS.flatMap(taskId => ['correct-reference', ...calibrationMutations(taskId).map(item => item.name)].map(name => ({ taskId, name })));
  if (calibration.cases.length !== expected.length || new Set(calibration.cases.map(item => `${item.taskId}/${item.name}`)).size !== expected.length || expected.some(item => !calibration.cases.some(actual => {
    const positive = item.name === 'correct-reference', expectedFailure = positive ? null : CALIBRATION_EXPECTED_FAILURES[item.taskId]?.[item.name];
    return actual.taskId === item.taskId && actual.name === item.name && actual.passed && actual.exercised && actual.expectedPass === positive && actual.actualPass === positive && actual.error === null && actual.intendedFailureObserved && actual.boundaryChecksObserved && JSON.stringify(actual.expectedPassedChecks) === JSON.stringify(positive ? [] : calibrationExpectedPasses(item.name)) && actual.expectedFailedCheck === expectedFailure && (positive ? actual.failedChecks.length === 0 : typeof expectedFailure === 'string' && actual.failedChecks.includes(expectedFailure));
  }))) throw new Error('Calibration does not cover every independent targeted negative and positive');
  const { sha256: _previousIdentity, ...version } = evaluator;
  const calibrated = { ...version, calibrationSha256: bytesHash(calibrationBytes) };
  return { evaluator: EvaluatorVersionSchema.parse({ ...calibrated, sha256: evidenceHash(calibrated) }), calibrationBytes };
}
