import { createHash } from 'node:crypto';

/** Original public task inputs, never grader answers. All arms receive these same bytes. */
export const RETAINED_BACKOFF = `export function cappedBackoff(attempt: number, baseMs: number, maxMs: number): number {
  const exponent = Math.max(0, Math.floor(attempt));
  return baseMs === 0 ? 0 : Math.min(maxMs, baseMs * 2 ** exponent);
}`;
export const PARTIAL_RETRY_SOURCE = `export interface RetryOptions { baseMs?: number; maxMs?: number; retryAfter?: string; nowMs?: number }
${RETAINED_BACKOFF}
export function retryDelay(attempt: number, options: RetryOptions = {}): number {
  const baseMs = options.baseMs ?? 1000;
  const maxMs = options.maxMs ?? 30000;
  const backoff = cappedBackoff(attempt, baseMs, maxMs);
  const header = options.retryAfter?.trim() ?? '';
  const seconds = /^(?:\\d+(?:\\.\\d*)?|\\.\\d+)$/.test(header) ? Number(header) : NaN;
  const serverMs = Number.isFinite(seconds) ? seconds * 1000 : 0;
  return Math.min(maxMs, Math.max(backoff, serverMs));
}
`;
export const PARTIAL_RETRY_TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
import { retryDelay, cappedBackoff } from '../src/retry.ts';
test('retained partial work: decimal seconds and capped backoff', () => {
  assert.equal(retryDelay(0, { retryAfter: '1.75' }), 1750);
  assert.equal(cappedBackoff(100000, 0, 700), 0);
  assert.equal(cappedBackoff(100000, 7, 937), 937);
});
`;
export const GUIDANCE_SOURCE_PATH = 'docs/atlas/retry-session-constraints.md';
export const GUIDANCE_CONSTRAINTS = [
  { key: 'capped-delay', quote: 'All retry delays, including server hints, must be capped by maxMs.' },
  { key: 'stable-api', quote: 'Preserve retryDelay, baseMs/maxMs, original regressions and unrelated incident policy.' },
  { key: 'current-authority', quote: 'Saved knowledge is a candidate: re-read current accepted sources; superseded values are not current.' },
  { key: 'original-operation', quote: 'An unknown write keeps its original operationId and must be reconciled before another write.' },
] as const;
export const GUIDANCE_DOCUMENT = `# Retry Session constraints\n\nStatus: accepted and current.\n\n${GUIDANCE_CONSTRAINTS.map(item => `${item.key}: ${item.quote}`).join('\n\n')}\n\nKnown invalid approach: uncapped-delay. Uncapped retries overload the API and must not be repeated. See history/fictional-session-a.json for the failed attempt and docs/atlas/timeline/2026-10-15-meeting.md for its original evidence.\n\nThe supplied partial cappedBackoff helper and test/retry-partial.test.ts are correct completed work. Preserve their exact bytes/implementation on handoff; remaining HTTP-date and malformed-header coverage is not complete.\n`;
export const REQUIREMENT_PATH = 'docs/atlas/retry-active-requirement.md';
export const INITIAL_REQUIREMENT = '# Active retry requirement\n\nRevision: retry-v1. Status: accepted and current for L03 (overrides generic retry-design.md).\n\nFor a valid Retry-After hint, use the server delay INSTEAD OF exponential backoff, capped by maxMs. A zero hint therefore returns zero. Keep cappedBackoff unchanged for absent or invalid hints. Support decimal seconds and IMF-fixdate HTTP dates; invalid/negative/nonfinite hints fall back. Preserve default baseMs=1000 and maxMs=30000.\n';
export const CHANGED_REQUIREMENT = '# Active retry requirement\n\nRevision: retry-v2. Status: accepted and current for L03 (overrides generic retry-design.md).\n\nThe retry-v1 replacement rule is REVOKED. Retry-After is now a MINIMUM: max(exponential backoff, server delay), capped by maxMs. A zero hint no longer cancels backoff. Keep cappedBackoff, default baseMs=1000 and maxMs=30000, public API, malformed-header behavior and unrelated code/tests unchanged. Both decimal seconds and IMF-fixdate HTTP dates remain required.\n';
export const RETRY_REQUIREMENT = 'Implement Retry-After in repo/src/retry.ts: preserve retryDelay(attempt,options), baseMs/maxMs defaults 1000/30000, clamp attempt to nonnegative integer, cap overflowing attempts without Infinity/NaN (including zero base). Nonnegative decimal seconds or valid IMF-fixdate HTTP dates specify a minimum delay max(backoff,server delay), capped at maxMs; past dates give zero server delay; invalid/negative/nonfinite headers are ignored. Add real node:test feature coverage in NEW repo/test/retry-after.test.ts. Preserve original tests, package.json and incident.ts.';
export const MEMORY_FORMAT = 'Save knowledge/session-memory.json as {records:[{key,status:"active",sourceHash,citations:[{path,quote}]}],decisions:[{key:"retryLimit",value,status:"active",citations:[{path,quote}]}],failedAttempts:[{id:"uncapped-delay",path:"history/fictional-session-a.json",quote:<exact failedApproach>}]}: one record for every named constraint in docs/atlas/retry-session-constraints.md; sourceHash is SHA256 of the complete cited source bytes. Reconcile stale knowledge against accepted decisions. Do not implement code in the first Session. Keep the generation ACTIVE after saving (use a bounded shell sleep while waiting for scheduled interruption).';
export const REUSE_FORMAT = 'Write artifacts/reuse.json {memoryHash:<SHA256 of saved session-memory.json>,constraints:[{key,file:"repo/src/retry.ts",quote:<exact implementation>,testFile:"repo/test/retry-after.test.ts",testQuote:<exact assertion>}],avoidedFailures:["uncapped-delay"]}; cover every saved constraint with actual source/test evidence (policy-only constraints may cite repo/README.md and its exact prose instead). Do not modify saved memory. Write answer.json with the CURRENT retryLimit and exact original citations.';
export const HANDOFF_FORMAT = 'Before the first PM write, save artifacts/handoff.json {workspaceId,projectId,targetId,observedRevision,revision,operationId,completed:["cappedBackoff","decimal-seconds","original-regressions"],remainingWork:["http-date","invalid-header","tests","docs","pm-sync"],failedAttempts:["uncapped-delay"],sourceHash:<SHA256 repo/src/retry.ts>,testHash:<SHA256 repo/test/retry-partial.test.ts>}. Append ONLY atlas-code body the note "dovspace:D04:partial" with that identity. The response is deliberately lost AFTER commit. Remain active; do not retry or finish until the runner hands off. The successor must query that original receipt before any write, preserve operationId/observedRevision, update handoff revision/receipt to the real result, finish the feature, then append "dovspace:D04:delivered" exactly once under a new explicit write identity; preserve both notes and status in_progress. Write answer.json with current retryLimit/citations.';
export const REPLAN_FORMAT = 'Persist artifacts/plan.json {requirementRevision:"retry-v1",requirements:["server-replacement","decimal-seconds","http-date","capped-delay"],remainingWork:["docs","pm-sync"]}, working initial source and NEW repo/test/retry-change.test.ts asserting replacement semantics (including zero hint and below-backoff hint). Include the exact public cappedBackoff implementation from docs/atlas/retry-partial.ts. Save artifacts/handoff.json {workspaceId,projectId,targetId,revision,operationId:null,remainingWork:["await-requirement-change"]}. Keep ACTIVE with a bounded sleep for the runner halfway checkpoint; no PM write yet. After the change, re-read the active requirement, revise the plan and tests, keep still-valid source/tests/docs, and finish feature delivery with explicit authorized PM synchronization. The successor receives the revised authority and artifact formatting only when the change is actually applied. Measure discarded/reused work against the captured source snapshot; no invented percentage. Write answer.json with current retryLimit/citations.';
export const REVISED_REQUIREMENT_FORMAT = 'For the CURRENT retry-v2 delivery use plan {requirementRevision:"retry-v2",requirements:["server-minimum","decimal-seconds","http-date","capped-delay"]}. Add NEW repo/test/retry-after.test.ts and revise retry-change.test.ts to current behavior. Append ONLY atlas-code body "dovspace:L03:retry-v2; server-minimum" with original receipts/status in_progress. Write artifacts/delivery.md identifying retry-v2, server-minimum, the target and current source path. Write artifacts/rework.json {checkpointSourceHash,finalSourceHash,reused:[{file:"repo/src/retry.ts",quote:<exact unchanged cappedBackoff>}],discarded:["server-replacement"],added:["server-minimum"],measurement:{unit:"changed-lines",value:<sum of positional unequal lines + absolute line-count difference between checkpoint and final retry.ts>}}. The checkpointSourceHash is SHA256 of your original retry-v1 source preserved at the interrupted checkpoint; retain/read that source before editing it. No invented percentage.';
export const contentHash = (content: string): string => createHash('sha256').update(content).digest('hex');
export function changedLines(before: string, after: string): number {
  const a = before.split('\n'), b = after.split('\n');
  let count = Math.abs(a.length - b.length);
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) count++;
  return count;
}
