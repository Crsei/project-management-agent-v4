import { z } from 'zod';
import path from 'node:path';
import { ArmSchema, TaskIdSchema } from '../schemas/types.ts';
import { EvidencePathSchema } from '../schemas/evaluation.ts';
import { DatasetRunSelectionSchema } from './dataset-admission.ts';
import { CaptureKeyOptionsSchema } from './capture.ts';

export const RunExperimentSelectionSchema = z.object({ ledgerRoot: z.string().min(1).refine(value => path.isAbsolute(value) && path.resolve(value) === value && !value.includes('\0'), 'Explicit absolute canonical ledger path required'), cellId: z.string().min(1), archiveRef: EvidencePathSchema.optional() }).strict();
export type RunExperimentSelection = z.infer<typeof RunExperimentSelectionSchema>;
export const RunSuiteAdmissionPlanSchema = z.array(z.object({ taskId: TaskIdSchema, arm: ArmSchema, repetition: z.number().int().positive(), datasetSelection: DatasetRunSelectionSchema, captureKey: CaptureKeyOptionsSchema, experiment: RunExperimentSelectionSchema }).strict()).min(1);
export type RunSuiteAdmission = z.infer<typeof RunSuiteAdmissionPlanSchema>[number];
export function validateRunSuiteAdmissionCoverage(plan: RunSuiteAdmission[], taskIds: string[], arms: string[], repetitions: number): void {
  const expected = new Set(taskIds.flatMap(taskId => arms.flatMap(arm => Array.from({ length: repetitions }, (_, index) => `${taskId}/${arm}/${index + 1}`))));
  const actual = plan.map(item => `${item.taskId}/${item.arm}/${item.repetition}`);
  if (actual.length !== expected.size || new Set(actual).size !== expected.size || actual.some(key => !expected.has(key)) || new Set(plan.map(item => `${item.experiment.ledgerRoot}\n${item.experiment.cellId}`)).size !== plan.length) throw new Error('Admission plan must exactly cover each task/arm/1-based repetition with a unique registered ledger cell before any dispatch');
}
