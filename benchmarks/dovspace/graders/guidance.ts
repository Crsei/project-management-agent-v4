import { z } from 'zod';
import type { CheckResult, FixtureSnapshot } from '../schemas/types.ts';
import { GUIDANCE_CONSTRAINTS, REQUIREMENT_PATH, CHANGED_REQUIREMENT, RETAINED_BACKOFF, changedLines, contentHash } from '../tasks/guidance.ts';
import { validSessionMemory } from '../runners/guidance-checkpoints.ts';
import { parseArtifact, publicFile } from './knowledge.ts';
import { check, trustedEvents, type GradeInput } from './types.ts';

const evidence = z.object({ key: z.string(), file: z.string(), quote: z.string().min(12), testFile: z.string(), testQuote: z.string().min(12) }).strict();
const reuseSchema = z.object({ memoryHash: z.string(), constraints: z.array(evidence), avoidedFailures: z.array(z.string()) }).strict();
const reworkSchema = z.object({ checkpointSourceHash: z.string(), finalSourceHash: z.string(), reused: z.array(z.object({ file: z.string(), quote: z.string() }).strict()), discarded: z.array(z.string()), added: z.array(z.string()), measurement: z.object({ unit: z.literal('changed-lines'), value: z.number().int().nonnegative() }).strict() }).strict();
export function checkpointSnapshot(input: GradeInput): FixtureSnapshot | null {
  const event = trustedEvents(input).find(item => item.source === 'runner' && item.type === 'phase_checkpoint' && item.data.authorityVerified === true && item.data.handoffVerified === true);
  const files = z.record(z.string(), z.string()).safeParse(event?.data.publicFiles);
  if (!files.success) return null;
  return { ...input.before, publicFiles: { ...input.before.publicFiles, ...files.data } };
}
export function gradeGuidance(input: GradeInput): CheckResult[] {
  if (!['K04', 'D04', 'L03'].includes(input.task.id)) return [];
  const events = trustedEvents(input);
  const checkpoint = checkpointSnapshot(input);
  const source = publicFile(input.after, 'repo/src/retry.ts') ?? '';
  const checks = [check('process.guidance.checkpoint-snapshots', !!checkpoint, ['trusted phase_checkpoint.publicFiles'], 'The actual saved/half-finished state must exist before intervention, not be invented in final prose.')];
  if (input.task.id === 'K04') {
    const memory = publicFile(input.after, 'knowledge/session-memory.json');
    checks.push(check('knowledge.memory.current-provenance', validSessionMemory(input.after), ['knowledge/session-memory.json'], 'All constraints/current decisions/failed approaches require supported original citations and matching source versions.'));
    checks.push(check('process.guidance.memory-retained', !!memory && !!checkpoint && memory === publicFile(checkpoint, 'knowledge/session-memory.json'), ['checkpoint saved memory', 'final saved memory'], 'The second Session must reuse actual prior memory rather than fabricate it after development.'));
    const reuse = reuseSchema.safeParse(parseArtifact(input.after, 'artifacts/reuse.json'));
    const entries = reuse.success ? reuse.data.constraints : [];
    const supported = entries.length === GUIDANCE_CONSTRAINTS.length && GUIDANCE_CONSTRAINTS.every(constraint => entries.filter(item => item.key === constraint.key).length === 1) && entries.every(item => ['repo/src/retry.ts', 'repo/README.md'].includes(item.file) && ['repo/test/retry-after.test.ts', 'repo/README.md'].includes(item.testFile) && publicFile(input.after, item.file)?.includes(item.quote) && publicFile(input.after, item.testFile)?.includes(item.testQuote));
    checks.push(check('process.guidance.reuse-mapping', reuse.success && !!memory && reuse.data.memoryHash === contentHash(memory) && supported && reuse.data.avoidedFailures.length === 1 && reuse.data.avoidedFailures[0] === 'uncapped-delay', ['artifacts/reuse.json', 'independent functional/regression checks'], 'Every saved constraint maps to actual code/test or policy documentation; known failure avoidance is verified by capped-delay hidden probes.'));
  } else {
    checks.push(check('process.guidance.preserved-correct-work', !!checkpoint && publicFile(checkpoint, 'repo/src/retry.ts')?.includes(RETAINED_BACKOFF) === true && source.includes(RETAINED_BACKOFF), ['repo/src/retry.ts', 'unchanged cappedBackoff'], 'Correct completed work must survive handoff or requirement change, not just be re-described.'));
  }
  if (input.task.id === 'D04') {
    const parsedHandoff = z.object({ failedAttempts: z.array(z.string()), completed: z.array(z.string()), remainingWork: z.array(z.string()) }).safeParse(parseArtifact(input.after, 'artifacts/handoff.json'));
    const handoff = parsedHandoff.success ? parsedHandoff.data : null;
    const partialTest = publicFile(input.before, 'repo/test/retry-partial.test.ts');
    checks.push(check('process.guidance.partial-tests-preserved', !!partialTest && publicFile(input.after, 'repo/test/retry-partial.test.ts') === partialTest, ['repo/test/retry-partial.test.ts']));
    checks.push(check('process.guidance.handoff-inventory', Array.isArray(handoff?.completed) && ['cappedBackoff', 'decimal-seconds', 'original-regressions'].every(item => handoff.completed!.includes(item)) && Array.isArray(handoff?.remainingWork) && ['http-date', 'invalid-header', 'tests', 'docs', 'pm-sync'].every(item => handoff.remainingWork!.includes(item)) && handoff?.failedAttempts?.includes('uncapped-delay') === true, ['artifacts/handoff.json'], 'Handoff retains complete decisions, completed work, remaining obligations and invalid approach.'));
    const original = events.find(event => event.type === 'response_lost');
    const writes = events.filter(event => event.type === 'pm_request' && event.data.mutation === true);
    checks.push(check('process.guidance.exact-write-identities', writes.length === 2 && new Set(writes.map(event => event.operationId)).size === 2 && writes[0]?.operationId === original?.operationId, writes.map(event => event.id), 'One original partial mutation and one post-reconciliation delivery mutation; no completed-write replay.'));
    const docs = publicFile(input.after, 'artifacts/delivery.md') ?? '';
    checks.push(check('process.guidance.delivery-docs', docs.includes('Retry-After') && docs.includes(input.fixture.targets['atlas-code']!.entityId) && !!original?.operationId && docs.includes(original.operationId) && docs.includes('docs/atlas/retry-design.md'), ['artifacts/delivery.md']));
  }
  if (input.task.id === 'L03') {
    const midpoint = input.events.find(event => event.type === 'midpoint_code_verified' && event.source === 'grader' && event.data.passed === true);
    checks.push(check('process.guidance.real-initial-implementation', !!midpoint && !!checkpoint && midpoint.data.sourceHash === contentHash(publicFile(checkpoint, 'repo/src/retry.ts') ?? ''), ['trusted isolated retry-v1 execution'], 'Halfway source and its original delivered tests must execute and satisfy the actual initial replacement requirement.'));
    checks.push(check('process.guidance.actual-requirement-change', publicFile(input.after, REQUIREMENT_PATH) === CHANGED_REQUIREMENT && events.some(event => event.source === 'runner' && event.type === 'intervention_applied' && event.data.action === 'change-requirement' && event.data.decisionPath === REQUIREMENT_PATH), [REQUIREMENT_PATH]));
    const parsedPlan = z.object({ requirementRevision: z.string(), requirements: z.array(z.string()) }).safeParse(parseArtifact(input.after, 'artifacts/plan.json'));
    const plan = parsedPlan.success ? parsedPlan.data : null;
    checks.push(check('process.guidance.replanned-all-acceptance', plan?.requirementRevision === 'retry-v2' && Array.isArray(plan.requirements) && plan.requirements.length === 4 && ['server-minimum', 'decimal-seconds', 'http-date', 'capped-delay'].every(item => plan.requirements!.includes(item)), ['artifacts/plan.json'], 'The revised plan cannot retain revoked replacement behavior or omit unchanged acceptance criteria.'));
    const rework = reworkSchema.safeParse(parseArtifact(input.after, 'artifacts/rework.json'));
    const priorSource = checkpoint && publicFile(checkpoint, 'repo/src/retry.ts');
    checks.push(check('process.guidance.measured-rework', rework.success && !!priorSource && rework.data.checkpointSourceHash === contentHash(priorSource) && rework.data.finalSourceHash === contentHash(source) && rework.data.discarded.length === 1 && rework.data.discarded[0] === 'server-replacement' && rework.data.added.length === 1 && rework.data.added[0] === 'server-minimum' && rework.data.measurement.value === changedLines(priorSource, source) && rework.data.measurement.value > 0 && rework.data.reused.length === 1 && rework.data.reused[0]!.file === 'repo/src/retry.ts' && rework.data.reused[0]!.quote === RETAINED_BACKOFF, ['artifacts/rework.json', 'trusted checkpoint/final source snapshots'], 'Rework is the declared deterministic positional changed-line count, not an invented semantic percentage.'));
    const docs = publicFile(input.after, 'artifacts/delivery.md') ?? '';
    checks.push(check('process.guidance.current-delivery-docs', docs.includes('retry-v2') && docs.includes('server-minimum') && docs.includes(REQUIREMENT_PATH) && docs.includes(input.fixture.targets['atlas-code']!.entityId), ['artifacts/delivery.md']));
  }
  return checks;
}
