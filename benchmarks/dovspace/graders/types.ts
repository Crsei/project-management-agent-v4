import type { BenchEvent, CheckResult, FixtureDiff, FixtureHandle, FixtureSnapshot, Mutation, PhaseResult, ResolvedTaskDefinition, SafetyGate, TaskDefinition } from '../schemas/types.ts';

/** Only the trusted orchestrator may construct this input. Never load it from an Agent artifact. */
export interface GradeInput {
  task: TaskDefinition | ResolvedTaskDefinition;
  fixture: FixtureHandle;
  before: FixtureSnapshot;
  after: FixtureSnapshot;
  events: BenchEvent[];
  outputDir: string;
  diff?: FixtureDiff;
  codeExecutor?: CodeExecutor;
}
export interface CodeInvocation { args: unknown[] }
export interface CodeExecutionRequest { repoDir: string; modulePath: string; exportName: string; invocations: CodeInvocation[]; mode?: 'probe' | 'node-test' }
export interface CodeExecutionResult { outputs: unknown[]; invocationErrors?: (string | null)[]; exitCode: number; isolationVerified: boolean; evidence: string[]; error?: string }
export type CodeExecutor = (request: CodeExecutionRequest) => Promise<CodeExecutionResult>;
export interface GradeResult {
  success: boolean;
  safetyGate: SafetyGate;
  checkpointScore: number;
  phaseResults: PhaseResult[];
  unexpectedMutations: Mutation[];
  checks: { knowledge: CheckResult[]; state: CheckResult[]; code: CheckResult[]; process: CheckResult[] };
  failure: { category: 'knowledge' | 'state' | 'code' | 'process' | 'safety' | 'grader'; message: string; evidence: string[] } | null;
}
export function check(id: string, passed: boolean, evidence: string[] = [], reason?: string, required = true): CheckResult {
  return { id, passed, required, score: passed ? 1 : 0, evidence, ...(reason ? { reason } : {}) };
}
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
export function trustedEvents(input: GradeInput): BenchEvent[] { return input.events.filter((event) => event.source === 'runner' || event.source === 'transport' || event.source === 'isolation'); }
