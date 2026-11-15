import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { parseBenchmarkConfig, type BenchmarkConfig } from '../benchmark.config.ts';
import { approveSourceStage } from '../isolation/source.ts';
import { publicExperimentConfiguration } from '../reports/index.ts';
import { prepareReportDirectory } from '../reports/files.ts';
import { writeStudyReport, type StudySummary } from '../reports/tools-study.ts';
import type { RunResult } from '../schemas/types.ts';
import { STUDY_VARIANTS, type StudyManifest } from '../schemas/tools-study.ts';
import { runTask } from './index.ts';
import { hashValue } from './telemetry.ts';
import { verifyStudySources } from './tools-study-source.ts';

export interface RunToolsStudyOptions { manifest: StudyManifest; config: BenchmarkConfig; outputDirectory: string; signal?: AbortSignal }

/** One existing runTask/grader path; no new business Runner or cross-arm state. */
export async function runToolsStudy(options: RunToolsStudyOptions): Promise<StudySummary> {
  const { manifest, manifestHash } = await verifyStudySources(options.manifest);
  if (manifest.evidenceKind !== 'model-study') throw new Error('A report fixture cannot execute real model inference');
  if (hashValue(publicExperimentConfiguration(options.config)) !== hashValue(manifest.controls)) throw new Error('Execution configuration differs from frozen study controls');
  if (!options.config.model || options.config.budget.maxCostUsd === null) throw new Error('Study execution requires an explicit real model and positive budget');
  const stages = {
    baseline: await approveSourceStage(manifest.variants.baseline.sourceRoot, manifest.variants.baseline.sourceManifest),
    candidate: await approveSourceStage(manifest.variants.candidate.sourceRoot, manifest.variants.candidate.sourceManifest),
  };
  await prepareReportDirectory(options.outputDirectory, true);
  const runs: RunResult[] = [];
  let summary: StudySummary;
  try {
    study: for (let repeat = 0; repeat < manifest.repetitions; repeat++) for (let taskIndex = 0; taskIndex < manifest.taskIds.length; taskIndex++) {
      const taskId = manifest.taskIds[taskIndex]!;
      for (let order = 0; order < 2; order++) {
        if (options.signal?.aborted) break study;
        const variant = STUDY_VARIANTS[(repeat + taskIndex + order) % 2]!;
        const config = parseBenchmarkConfig({ ...options.config, outputsRoot: resolve(options.outputDirectory, 'runs') });
        const run = await runTask({ taskId, arm: manifest.arm, runId: `${taskId}-${variant}-${randomUUID()}`, config, ...(options.signal ? { signal: options.signal } : {}), sourceStage: stages[variant], requiredTools: manifest.requiredTools, study: { version: 1, studyId: manifest.studyId, manifestHash, variant, repeat, order: order as 0 | 1, blockId: `${manifest.studyId}:${taskId}:${repeat}` } });
        runs.push(run); // Includes every admitted provider/infrastructure/grader failure.
        if (run.failure?.category === 'interrupted') break study;
      }
    }
  } finally {
    // Persist even an interrupted/incomplete design. Missing pairs invalidate, never disappear.
    summary = await writeStudyReport(runs, manifest, options.outputDirectory);
  }
  return summary;
}
