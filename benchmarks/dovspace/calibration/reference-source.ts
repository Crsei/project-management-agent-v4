/** Trusted calibration-only solutions. Never imported by adapters, mounted in public fixtures, or counted as model output. */
export const REFERENCE_RETRY_SOURCE = `export interface RetryOptions { baseMs?: number; maxMs?: number; retryAfter?: string; nowMs?: number }
export function retryDelay(attempt: number, options: RetryOptions = {}): number {
  const baseMs = options.baseMs ?? 1000;
  const maxMs = options.maxMs ?? 30000;
  const exponent = Math.max(0, Math.floor(attempt));
  const exponential = baseMs === 0 ? 0 : exponent >= Math.log2(maxMs / baseMs) ? maxMs : baseMs * 2 ** exponent;
  const header = options.retryAfter?.trim();
  let serverMs = 0;
  if (header && /^(?:\\d+(?:\\.\\d*)?|\\.\\d+)$/.test(header)) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) serverMs = seconds * 1000;
  } else if (header && /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \\d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \\d{4} \\d{2}:\\d{2}:\\d{2} GMT$/.test(header)) {
    const deadline = Date.parse(header);
    if (Number.isFinite(deadline)) serverMs = Math.max(0, deadline - (options.nowMs ?? Date.now()));
  }
  return Math.min(maxMs, Math.max(exponential, serverMs));
}
`;
export const REFERENCE_RETRY_TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
import { retryDelay } from '../src/retry.ts';
test('Retry-After is a capped minimum, not a replacement for backoff', () => {
  assert.equal(retryDelay(0, { retryAfter: '7', nowMs: 0 }), 7000);
  assert.equal(retryDelay(3, { retryAfter: '2', nowMs: 0 }), 8000);
  assert.equal(retryDelay(0, { retryAfter: '50', maxMs: 9000, nowMs: 0 }), 9000);
});
test('HTTP-date and malformed values preserve deterministic baseline behavior', () => {
  assert.equal(retryDelay(0, { retryAfter: 'Sun, 06 Nov 1994 08:49:37 GMT', nowMs: 784111767000 }), 10000);
  assert.equal(retryDelay(1, { retryAfter: 'invalid', nowMs: 0 }), 2000);
});
`;
export const REFERENCE_INCIDENT_SOURCE = `export interface IncidentPolicy { backupRpoHours: number; incidentEscalationMinutes: number }
const currentPolicy: Readonly<IncidentPolicy> = Object.freeze({ backupRpoHours: 6, incidentEscalationMinutes: 10 });
export function incidentPolicy(): Readonly<IncidentPolicy> { return currentPolicy; }
`;
export const REFERENCE_INCIDENT_TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
import { incidentPolicy } from '../src/incident.ts';
test('current policy matches amended Cedar authority', () => {
  assert.deepEqual(incidentPolicy(), { backupRpoHours: 6, incidentEscalationMinutes: 10 });
  assert.ok(Object.isFrozen(incidentPolicy()));
});
`;
