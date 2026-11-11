/** Public candidate repository. Hidden probes and the reference implementation are never mounted here. */
export const CODE_FIXTURE_FILES: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'fictional-atlas-retry', version: '1.0.0', private: true, type: 'module', scripts: { test: 'node --test test/retry.test.ts' } }, null, 2) + '\n',
  'src/incident.ts': `export interface IncidentPolicy { backupRpoHours: number; incidentEscalationMinutes: number }
const currentPolicy: Readonly<IncidentPolicy> = Object.freeze({ backupRpoHours: 6, incidentEscalationMinutes: 15 });
export function incidentPolicy(): Readonly<IncidentPolicy> { return currentPolicy; }
`,
  'src/retry.ts': `export interface RetryOptions { baseMs?: number; maxMs?: number }

/** Deterministic capped exponential backoff. attempt zero is the first retry. */
export function retryDelay(attempt: number, options: RetryOptions = {}): number {
  const baseMs = options.baseMs ?? 1000;
  const maxMs = options.maxMs ?? 30000;
  const exponent = Math.max(0, Math.floor(attempt));
  return Math.min(maxMs, baseMs * 2 ** exponent);
}
`,
  'test/retry.test.ts': `import test from 'node:test';
import assert from 'node:assert/strict';
import { retryDelay } from '../src/retry.ts';

test('default backoff is capped', () => {
  assert.equal(retryDelay(0), 1000);
  assert.equal(retryDelay(3), 8000);
  assert.equal(retryDelay(10), 30000);
});
test('custom base and cap remain supported', () => {
  assert.equal(retryDelay(2, { baseMs: 250, maxMs: 900 }), 900);
  assert.equal(retryDelay(-1, { baseMs: 250 }), 250);
});
`,
  'README.md': '# Fictional Atlas retry library\n\n`retryDelay(attempt, options)` returns capped deterministic exponential backoff in milliseconds. Run real public regressions with `node --test test/retry.test.ts`; add feature tests separately without altering the original suite. The feature adds Retry-After support without changing baseline callers.\n\nSubmission contract: src/retry.ts and src/incident.ts are pure synchronous self-contained ESM TypeScript modules. No static/dynamic imports, process/fs/network/IO or async results; exports return JSON-data values. Hidden evaluation strips types and bounds module evaluation and every invocation to 1000ms inside a fresh OS sandbox. Public node:test files may import Node test/assert and submitted modules. No network or dependencies are needed.\n',
};
