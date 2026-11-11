import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parseBenchmarkConfig, type BenchmarkConfig } from '../benchmark.config.ts';
import type { CodeExecutionResult } from '../graders/types.ts';
import { executeCode } from './code-executor.ts';

export interface CodeExecutorSecurityResult {
  kind: 'code-executor-security-regression'; passed: boolean; resultPath: string;
  cases: { id: string; passed: boolean; execution: CodeExecutionResult }[];
}

/** Explicit real-sandbox regression, never a model benchmark or normal-run fallback. */
export async function runCodeExecutorSecurityRegression(input: Partial<BenchmarkConfig> = {}): Promise<CodeExecutorSecurityResult> {
  const config = parseBenchmarkConfig(input);
  for (const root of [config.runtimeRoot, config.outputsRoot]) {
    let directory = path.parse(root).root;
    for (const component of path.resolve(root).split(path.sep).filter(Boolean)) {
      directory = path.join(directory, component);
      try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Security regression roots cannot contain redirected ancestors.');
    }
  }
  const root = await mkdtemp(path.join(config.runtimeRoot, 'code-security-'));
  const output = path.join(config.outputsRoot, `code-security-${randomUUID()}`);
  await mkdir(output, { mode: 0o700 });
  const result: CodeExecutorSecurityResult = { kind: 'code-executor-security-regression', passed: false, resultPath: path.join(output, 'result.json'), cases: [] };
  const cases = [
    { id: 'legitimate-synchronous-function', source: 'export function incidentPolicy(){return {backupRpoHours:6,incidentEscalationMinutes:10};}\n', expected: { backupRpoHours: 6, incidentEscalationMinutes: 10 } },
    { id: 'dynamic-import-outer-error-marker-forgery', source: `let rejected=false,primitive=false;
try{await import('node:fs');}catch(error){
  rejected=true;primitive=error===null||!['object','function'].includes(typeof error);
  try{
    if(error){
      const outerProcess=error.constructor.constructor('return process')();
      const marker=outerProcess.execArgv.join(' ').match(/DOVSPACE_RESULT_[a-f0-9]+:/)?.[0];
      if(marker){outerProcess.stdout.write(marker+JSON.stringify([{backupRpoHours:6,incidentEscalationMinutes:10}])+'\\n');outerProcess.exit(0);}
    }
  }catch{}
}
export function incidentPolicy(){return {backupRpoHours:6,incidentEscalationMinutes:15,rejected,primitive};}
`, expected: { backupRpoHours: 6, incidentEscalationMinutes: 15, rejected: true, primitive: true } },
    { id: 'poisoned-json-cannot-replace-actual-return', source: `JSON.stringify=()=>'{"backupRpoHours":6,"incidentEscalationMinutes":10}';
Object.prototype.toJSON=()=>({backupRpoHours:6,incidentEscalationMinutes:10});
export function incidentPolicy(){return {backupRpoHours:6,incidentEscalationMinutes:15};}
`, expected: { backupRpoHours: 6, incidentEscalationMinutes: 15 } },
    { id: 'nonfinite-output-preserves-independent-probes', source: 'export function incidentPolicy(value){return value===2?NaN:value*2;}\n', expected: [2, null, 6], invocations: [{ args: [1] }, { args: [2] }, { args: [3] }], errors: [null, 'Candidate invocation failed', null] },
  ];
  try {
    for (const candidate of cases) {
      const repoDir = path.join(root, candidate.id);
      await mkdir(path.join(repoDir, 'src'), { recursive: true, mode: 0o700 });
      await writeFile(path.join(repoDir, 'src', 'incident.ts'), candidate.source, { mode: 0o600 });
      // Candidate source executes ONLY inside executeCode's separate Docker sandbox.
      const invocations = candidate.invocations ?? [{ args: [] }];
      const execution = await executeCode({ repoDir, modulePath: 'src/incident.ts', exportName: 'incidentPolicy', invocations }, config);
      result.cases.push({ id: candidate.id, passed: execution.exitCode === 0 && execution.isolationVerified && isDeepStrictEqual(execution.outputs, candidate.invocations ? candidate.expected : [candidate.expected]) && isDeepStrictEqual(execution.invocationErrors, candidate.errors ?? invocations.map(() => null)), execution });
    }
    result.passed = result.cases.length === cases.length && result.cases.every(candidate => candidate.passed);
  } finally {
    await writeFile(result.resultPath, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
    if (!result.cases.some(candidate => candidate.execution.error?.includes('cleanup failed'))) await rm(root, { recursive: true, force: false });
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--code-image' || !args[1]) throw new Error('Usage: node --conditions=development benchmarks/dovspace/runners/code-executor-security.ts --code-image <explicit Node24.21.0 image>');
    const result = await runCodeExecutorSecurityRegression({ codeImage: args[1] });
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
