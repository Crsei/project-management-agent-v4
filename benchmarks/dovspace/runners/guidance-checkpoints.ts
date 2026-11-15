import { z } from 'zod';
import type { BenchEvent, FixtureHandle, FixtureSnapshot } from '../schemas/types.ts';
import { GUIDANCE_CONSTRAINTS, GUIDANCE_SOURCE_PATH, INITIAL_REQUIREMENT, PARTIAL_RETRY_TEST, REQUIREMENT_PATH, RETAINED_BACKOFF, contentHash } from '../tasks/guidance.ts';
import { parseArtifact, publicFile } from '../graders/knowledge.ts';
import { SYNTHETIC_FACTS } from '../fixtures/documents.ts';
import type { CheckpointEvidence } from './checkpoints.ts';

const citation = z.object({ path: z.string(), quote: z.string().min(1) }).strict();
export const SessionMemorySchema = z.object({
  records: z.array(z.object({ key: z.string(), status: z.literal('active'), sourceHash: z.string(), citations: z.array(citation).min(1) }).strict()),
  decisions: z.array(z.object({ key: z.literal('retryLimit'), value: z.number(), status: z.literal('active'), citations: z.array(citation).min(1) }).strict()),
  failedAttempts: z.array(z.object({ id: z.literal('uncapped-delay'), path: z.literal('history/fictional-session-a.json'), quote: z.string().min(1) }).strict()),
}).strict();
export function validSessionMemory(snapshot: FixtureSnapshot): boolean {
  const parsed = SessionMemorySchema.safeParse(parseArtifact(snapshot, 'knowledge/session-memory.json'));
  if (!parsed.success) return false;
  const memory = parsed.data;
  const source = publicFile(snapshot, GUIDANCE_SOURCE_PATH);
  const decision = SYNTHETIC_FACTS.find(fact => fact.key === 'retryLimit')!;
  const historical = parseArtifact<{ failedApproach?: string }>(snapshot, 'history/fictional-session-a.json');
  return !!source && memory.records.length === GUIDANCE_CONSTRAINTS.length && GUIDANCE_CONSTRAINTS.every(constraint => {
    const records = memory.records.filter(record => record.key === constraint.key);
    return records.length === 1 && records[0]!.sourceHash === contentHash(source) && records[0]!.citations.every(item => item.path === GUIDANCE_SOURCE_PATH && item.quote.includes(constraint.quote) && source.includes(item.quote));
  }) && memory.decisions.length === 1 && memory.decisions[0]!.value === decision.current && memory.decisions[0]!.citations.every(item => item.path === decision.currentPath && item.quote.includes(decision.currentQuote) && publicFile(snapshot, item.path)?.includes(item.quote)) && memory.failedAttempts.length === 1 && memory.failedAttempts[0]!.quote === historical?.failedApproach;
}

/** Original source/artifact snapshots are retained host-side, never grader expected outputs. */
export function inspectGuidanceCheckpoint(taskId: string, phaseId: string, fixture: FixtureHandle, before: FixtureSnapshot, after: FixtureSnapshot, events: readonly BenchEvent[]): CheckpointEvidence | null {
  if (!['K04', 'D04', 'L03'].includes(taskId)) return null;
  const target = after.entities.find(entity => entity.id === fixture.targets['atlas-code']?.entityId);
  if (!target) return null;
  const names = ['repo/src/retry.ts', 'repo/test/retry-change.test.ts', 'repo/test/retry-partial.test.ts', 'artifacts/plan.json', 'artifacts/handoff.json', 'knowledge/session-memory.json'];
  const publicFiles = Object.fromEntries(names.filter(name => after.publicFiles[name] !== undefined).map(name => [name, after.publicFiles[name]!]));
  const base = { phaseId, targetId: target.id, revision: target.revision, authorityVerified: true as const, handoffVerified: true as const, publicFiles };
  if (taskId === 'K04') {
    if (!validSessionMemory(after) || publicFile(after, 'repo/src/retry.ts') !== publicFile(before, 'repo/src/retry.ts')) return null;
    return { ...base, operationId: '', receiptIdentity: '', memoryHash: contentHash(publicFile(after, 'knowledge/session-memory.json')!) };
  }
  const handoff = parseArtifact<Record<string, unknown>>(after, 'artifacts/handoff.json');
  if (!handoff || handoff.workspaceId !== fixture.workspaceId || handoff.projectId !== target.projectId || handoff.targetId !== target.id) return null;
  const source = publicFile(after, 'repo/src/retry.ts') ?? '';
  if (!source.includes(RETAINED_BACKOFF)) return null;
  if (taskId === 'D04') {
    const lost = events.find(event => event.source === 'transport' && event.type === 'response_lost' && event.data.committed === true && event.data.targetId === target.id);
    const receipt = after.receipts.find(item => item.kind === 'native' && item.status === 'succeeded' && item.operationId === lost?.operationId && item.targetId === target.id && item.revision === target.revision);
    const original = before.entities.find(entity => entity.id === target.id);
    if (!lost || !receipt || !original || handoff.operationId !== receipt.operationId || handoff.observedRevision !== original.revision || handoff.sourceHash !== contentHash(source) || handoff.testHash !== contentHash(PARTIAL_RETRY_TEST) || publicFile(after, 'repo/test/retry-partial.test.ts') !== PARTIAL_RETRY_TEST || source !== publicFile(before, 'repo/src/retry.ts')) return null;
    const completed = handoff.completed, remaining = handoff.remainingWork, failures = handoff.failedAttempts;
    if (!Array.isArray(completed) || !['cappedBackoff', 'decimal-seconds', 'original-regressions'].every(item => completed.includes(item)) || !Array.isArray(remaining) || !['http-date', 'invalid-header', 'tests', 'docs', 'pm-sync'].every(item => remaining.includes(item)) || !Array.isArray(failures) || !failures.includes('uncapped-delay') || !String(target.entity.body).includes('dovspace:D04:partial')) return null;
    return { ...base, operationId: receipt.operationId, receiptIdentity: String(lost.data.receiptIdentity), sourceHash: contentHash(source) };
  }
  const parsedPlan = z.object({ requirementRevision: z.string(), requirements: z.array(z.string()) }).safeParse(parseArtifact(after, 'artifacts/plan.json'));
  const plan = parsedPlan.success ? parsedPlan.data : null;
  const test = publicFile(after, 'repo/test/retry-change.test.ts') ?? '';
  if (publicFile(after, REQUIREMENT_PATH) !== INITIAL_REQUIREMENT || plan?.requirementRevision !== 'retry-v1' || !['server-replacement', 'decimal-seconds', 'http-date', 'capped-delay'].every(item => plan.requirements.includes(item)) || !test.includes('node:test') || !test.includes('assert') || source === publicFile(before, 'repo/src/retry.ts') || handoff.operationId !== null || handoff.revision !== target.revision) return null;
  if (after.receipts.some(receipt => !before.receipts.some(old => old.operationId === receipt.operationId))) return null;
  return { ...base, operationId: '', receiptIdentity: '', sourceHash: contentHash(source) };
}
