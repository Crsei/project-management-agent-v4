import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { benchmarkConfig, type BenchmarkConfig } from '../benchmark.config.ts';
import { readTree } from '../fixtures/snapshot.ts';
import { createCodeExecutor } from '../runners/code-executor.ts';
import { prepareReportDirectory } from '../reports/files.ts';
import { gradeTask } from '../graders/index.ts';
import type { CodeExecutionResult, CodeExecutor, GradeResult } from '../graders/types.ts';
import { SMOKE_TASK_IDS } from '../tasks/index.ts';
import { calibrationMutations } from './cases.ts';
import { materializeReference, referenceCase, REFERENCE_SCOPE } from './reference.ts';

export interface CalibrationOptions { outputDir: string; runCodeTests?: boolean; config?: BenchmarkConfig; codeExecutor?: CodeExecutor }
export interface CalibrationCaseResult {
  taskId: string; name: string; expectedPass: boolean; actualPass: boolean; passed: boolean; exercised: boolean;
  safetyGatePassed: boolean | null; failedChecks: string[]; resultPath: string; referencePath: string; error: string | null;
}
export interface CalibrationResult {
  kind: 'grader-calibration'; agent: null; model: null; success: boolean; scope: string; createdAt: string;
  cases: CalibrationCaseResult[]; infrastructureErrors: string[]; codeExecution: { realSandboxCalls: number; exactInputCacheHits: number }; artifacts: { json: string; markdown: string };
}

/** Explicit reference calibration, deliberately separate from all adapters and model-run reporting. */
export async function calibrate(options: CalibrationOptions): Promise<CalibrationResult> {
  if (options.runCodeTests === false) throw new Error('Calibration cannot skip real hidden code execution.');
  const config = options.config ?? benchmarkConfig;
  const outputDir = path.resolve(options.outputDir);
  const relative = path.relative(config.outputsRoot, outputDir);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Calibration output must be a new directory inside the reserved outputs tree.');
  await prepareReportDirectory(outputDir, true);
  const result: CalibrationResult = { kind: 'grader-calibration', agent: null, model: null, success: false, scope: REFERENCE_SCOPE, createdAt: new Date().toISOString(), cases: [], infrastructureErrors: [], codeExecution: { realSandboxCalls: 0, exactInputCacheHits: 0 }, artifacts: { json: path.join(outputDir, 'calibration.json'), markdown: path.join(outputDir, 'calibration.md') } };
  let runtimeRoot: string | undefined;
  let scenarioIsolationFailures: string[] = [];
  const execute = options.codeExecutor ?? createCodeExecutor(config);
  // Cache only observed executions for exactly the same source/test bytes and probe inputs. Never cache a model outcome.
  const observed = new Map<string, CodeExecutionResult>();
  const codeExecutor: CodeExecutor = async (request) => {
    const bytes = await readTree(request.repoDir);
    const key = createHash('sha256').update(JSON.stringify({ files: bytes, modulePath: request.modulePath, exportName: request.exportName, invocations: request.invocations, mode: request.mode ?? 'probe' })).digest('hex');
    const previous = observed.get(key);
    if (previous) { result.codeExecution.exactInputCacheHits += 1; if (!previous.isolationVerified) scenarioIsolationFailures.push(previous.error ?? 'Code isolation unverified'); return structuredClone(previous); }
    result.codeExecution.realSandboxCalls += 1;
    const execution = await execute(request);
    if (!execution.isolationVerified) scenarioIsolationFailures.push(execution.error ?? 'Code isolation unverified');
    observed.set(key, execution);
    return execution;
  };
  try {
    await mkdir(config.runtimeRoot, { recursive: true, mode: 0o700 });
    if ((await lstat(config.runtimeRoot)).isSymbolicLink() || await realpath(config.runtimeRoot) !== path.resolve(config.runtimeRoot)) throw new Error('Calibration runtime root must be a real canonical directory.');
    runtimeRoot = await mkdtemp(path.join(config.runtimeRoot, 'calibration-'));
    for (const taskId of SMOKE_TASK_IDS) {
      const scenarios = [{ name: 'correct-reference', mutate: null }, ...calibrationMutations(taskId)];
      for (const scenario of scenarios) {
        scenarioIsolationFailures = [];
        const directory = path.join(runtimeRoot, taskId, scenario.name);
        const input = referenceCase(taskId, directory);
        if (scenario.mutate) scenario.mutate(input);
        input.codeExecutor = codeExecutor;
        input.outputDir = path.join(outputDir, 'cases', taskId, scenario.name);
        await mkdir(input.outputDir, { recursive: true, mode: 0o700 });
        const referencePath = path.join(input.outputDir, 'reference-evidence.json');
        const resultPath = path.join(input.outputDir, 'grade.json');
        const { codeExecutor: _executor, ...referenceEvidence } = input;
        await writeFile(referencePath, JSON.stringify({ kind: 'trusted-reference-calibration-input', scope: REFERENCE_SCOPE, ...referenceEvidence }, null, 2) + '\n', { mode: 0o600 });
        let grade: GradeResult | undefined;
        let error: string | null = null;
        try { await materializeReference(input); grade = await gradeTask(input); }
        catch (failure) { error = failure instanceof Error ? failure.message : 'Calibration grader failed'; }
        const expectedPass = scenario.mutate === null;
        const exercised = error === null && scenarioIsolationFailures.length === 0;
        const actualPass = grade?.success === true;
        const entry: CalibrationCaseResult = { taskId, name: scenario.name, expectedPass, actualPass, passed: exercised && actualPass === expectedPass, exercised, safetyGatePassed: grade?.safetyGate.passed ?? null, failedChecks: grade ? [...Object.values(grade.checks).flat(), ...grade.safetyGate.checks].filter((item) => item.required && !item.passed).map((item) => item.id) : [], resultPath, referencePath, error };
        result.cases.push(entry);
        for (const failure of scenarioIsolationFailures) if (!result.infrastructureErrors.includes(failure)) result.infrastructureErrors.push(failure);
        if (error) result.infrastructureErrors.push(`${taskId}/${scenario.name}: ${error}`);
        await writeFile(resultPath, JSON.stringify({ kind: 'grader-calibration-case', scope: REFERENCE_SCOPE, ...entry, grade: grade ?? null }, null, 2) + '\n', { mode: 0o600 });
      }
    }
    result.success = result.cases.length > 0 && result.cases.every((entry) => entry.passed) && result.infrastructureErrors.length === 0 && result.codeExecution.realSandboxCalls > 0;
  } catch (failure) { result.infrastructureErrors.push(failure instanceof Error ? failure.message : 'Calibration infrastructure failed'); }
  finally {
    if (runtimeRoot) {
      try { await rm(runtimeRoot, { recursive: true, force: false }); }
      catch (failure) { result.infrastructureErrors.push(failure instanceof Error ? failure.message : 'Calibration runtime cleanup failed'); result.success = false; }
    }
    await writeFile(result.artifacts.json, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
    const rows = result.cases.map((entry) => `| ${entry.taskId} | ${entry.name} | ${entry.expectedPass ? 'pass' : 'fail'} | ${entry.actualPass ? 'pass' : 'fail'} | ${entry.exercised ? 'yes' : 'no'} | ${entry.passed ? 'pass' : 'FAIL'} |`).join('\n');
    const markdown = `# Independent grader calibration\n\nKind: **grader-calibration**. Agent/model: **none**. Calibration result: **${result.success ? 'pass' : 'fail'}**.\n\n${REFERENCE_SCOPE}\n\nSynthetic reference PM/transport records test scoring logic; they do not prove a live lost-response/new-session run. Code assertions execute the actual submitted TypeScript in the trusted no-network sandbox, including baseline feature failure and regression success. Infrastructure failures never count as exercised negative cases. Original source, graders and reference answers are not mounted to the Agent.\n\n| Task | Case | Expected run outcome | Graded run outcome | Exercised | Calibration |\n|---|---|---|---|---|---|\n${rows}\n\nReal sandbox calls: ${result.codeExecution.realSandboxCalls}; exact-byte/input observed-result reuses: ${result.codeExecution.exactInputCacheHits}.\n\n## Infrastructure errors\n\n${result.infrastructureErrors.length ? result.infrastructureErrors.map((error) => `- ${error.replace(/[\r\n]/g, ' ')}`).join('\n') : 'None observed.'}\n\nEach case retains trusted reference-evidence.json and independently produced grade.json. No result is included in model A/B efficacy, token/cost, or success-rate comparisons.\n`;
    await writeFile(result.artifacts.markdown, markdown, { mode: 0o600 });
  }
  return result;
}
export { referenceCase, materializeReference, REFERENCE_SCOPE } from './reference.ts';
