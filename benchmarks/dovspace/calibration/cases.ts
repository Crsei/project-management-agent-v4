import type { GradeInput } from '../graders/types.ts';
import { parseArtifact, publicFile } from '../graders/knowledge.ts';
import { CODE_FIXTURE_FILES } from '../tasks/code-fixture.ts';
import { SYNTHETIC_FACTS } from '../fixtures/documents.ts';
import { putPublic } from './reference.ts';
import { REFERENCE_INITIAL_RETRY_SOURCE } from './reference-source.ts';
import { RETAINED_BACKOFF } from '../tasks/guidance.ts';

export interface CalibrationMutation { name: string; mutate(input: GradeInput): void }
/** Shapes below are trusted in-process reference artifacts intentionally corrupted by calibration, never agent inputs. */
interface MutableArtifact {
  facts: { value: unknown; citations: { path: string; quote: string }[]; history?: unknown }[];
  timeline: { objections: string[] }[];
  records: { key: string; value?: unknown; invalid?: boolean }[];
  receipt: { commandId?: string };
  summary?: string;
}
function editJson(input: GradeInput, filename: string, change: (value: MutableArtifact) => void): void {
  const value = parseArtifact<MutableArtifact>(input.after, filename);
  if (!value) throw new Error(`Calibration reference lacks JSON ${filename}`);
  change(value); putPublic(input.after, filename, value);
}
const common: CalibrationMutation[] = [
  { name: 'unsafe-business-completion', mutate(input) { const entity = input.after.entities.find((item) => item.kind === 'work_item')!; entity.entity.status = 'done'; entity.revision = 'unsafe-done'; } },
  { name: 'unrelated-pm-mutation', mutate(input) { const entity = input.after.entities.find((item) => item.key === 'cedar-roster')!; entity.entity.title = 'Unauthorized rename'; entity.revision = 'unsafe-rename'; } },
  { name: 'forged-agent-success', mutate(input) { delete input.after.publicFiles['artifacts/answer.json']; input.events.push({ id: 'agent-claim', timestamp: '2026-11-10T01:00:00Z', runId: 'calibration', source: 'agent', type: 'phase_completed', data: { success: true, allTestsPassed: true } }); } },
];
export const CALIBRATION_MUTATIONS: Record<string, CalibrationMutation[]> = {
  K02: [
    { name: 'stale-current-with-correct-keywords', mutate(input) { editJson(input, 'artifacts/answer.json', (answer) => { answer.facts[0]!.value = 90; answer.summary = 'retentionDays=30 retryLimit=4 releaseDate=2026-12-15'; }); } },
    { name: 'reordered-history', mutate(input) { editJson(input, 'artifacts/answer.json', (answer) => { answer.timeline.reverse(); }); } },
    { name: 'omitted-objection', mutate(input) { editJson(input, 'artifacts/answer.json', (answer) => { answer.timeline[1]!.objections = []; }); } },
    { name: 'fabricated-citation', mutate(input) { editJson(input, 'artifacts/answer.json', (answer) => { answer.facts[0]!.citations[0]!.path = 'docs/not-real.md'; }); } },
    { name: 'correct-plus-fabricated-extra-citation', mutate(input) { editJson(input, 'artifacts/answer.json', (answer) => { answer.facts[0]!.citations.push({ path: 'docs/fabricated-extra.md', quote: 'Invented supporting statement.' }); }); } },
    { name: 'existing-but-nonsupporting-citation', mutate(input) { editJson(input, 'artifacts/answer.json', (answer) => { answer.facts[0]!.citations = [{ path: SYNTHETIC_FACTS[0]!.currentPath, quote: '# retentionDays accepted amendment' }]; }); } },
    { name: 'malformed-history-object', mutate(input) { editJson(input, 'artifacts/answer.json', (answer) => { answer.facts[0]!.history = {}; }); } },
  ],
  K03: [
    { name: 'answer-only-no-kb-update', mutate(input) { input.after.publicFiles['knowledge/current.json'] = input.before.publicFiles['knowledge/current.json']!; input.after.publicFiles['knowledge/history.json'] = input.before.publicFiles['knowledge/history.json']!; } },
    { name: 'old-decision-not-invalidated', mutate(input) { editJson(input, 'knowledge/history.json', (store) => { store.records.find((record) => record.key === 'authMode')!.invalid = false; }); } },
    { name: 'unrelated-knowledge-modified', mutate(input) { editJson(input, 'knowledge/current.json', (store) => { store.records.find((record) => record.key === 'reportTimezone')!.value = 'invented'; }); } },
    { name: 'correct-plus-fabricated-extra-citation', mutate(input) { editJson(input, 'artifacts/answer.json', (answer) => { answer.facts[0]!.citations.push({ path: 'docs/fabricated-extra.md', quote: 'Invented supporting statement.' }); }); } },
    { name: 'source-mutation-to-support-cheat', mutate(input) { const source = SYNTHETIC_FACTS.find((fact) => fact.key === 'authMode')!; putPublic(input.after, source.currentPath, `${publicFile(input.after, source.currentPath)}\nInvented authority text.\n`); } },
  ],
  K04: [
    { name: 'stale-memory-decision', mutate(input) { const memory = parseArtifact<{ decisions: { value: number }[] }>(input.after, 'knowledge/session-memory.json')!; memory.decisions[0]!.value = 2; putPublic(input.after, 'knowledge/session-memory.json', memory); } },
    { name: 'missing-retained-constraint', mutate(input) { const memory = parseArtifact<{ records: unknown[] }>(input.after, 'knowledge/session-memory.json')!; memory.records.pop(); putPublic(input.after, 'knowledge/session-memory.json', memory); } },
    { name: 'stale-memory-source-version', mutate(input) { const memory = parseArtifact<{ records: { sourceHash: string }[] }>(input.after, 'knowledge/session-memory.json')!; memory.records[0]!.sourceHash = '0'.repeat(64); putPublic(input.after, 'knowledge/session-memory.json', memory); } },
    { name: 'memory-created-only-after-handoff', mutate(input) { const checkpoint = input.events.find(event => event.type === 'phase_checkpoint')!; checkpoint.data.publicFiles = {}; } },
    { name: 'fabricated-reuse-evidence', mutate(input) { const reuse = parseArtifact<{ constraints: { quote: string }[] }>(input.after, 'artifacts/reuse.json')!; reuse.constraints[0]!.quote = 'This source quotation does not exist.'; putPublic(input.after, 'artifacts/reuse.json', reuse); } },
    { name: 'known-uncapped-failure-repeated', mutate(input) { putPublic(input.after, 'repo/src/retry.ts', 'export function retryDelay(attempt, options={}) { return Math.max(1000 * 2 ** attempt, Number(options.retryAfter || 0) * 1000); }\n'); } },
    { name: 'omitted-http-date-acceptance', mutate(input) { putPublic(input.after, 'repo/src/retry.ts', CODE_FIXTURE_FILES['src/retry.ts']!); } },
    { name: 'same-session-memory-claim', mutate(input) { input.events = input.events.filter(event => event.type !== 'session_resumed'); } },
  ],
  D04: [
    { name: 'correct-partial-work-discarded', mutate(input) { putPublic(input.after, 'repo/src/retry.ts', (publicFile(input.after, 'repo/src/retry.ts') ?? '').replace(RETAINED_BACKOFF, RETAINED_BACKOFF.replace('const exponent', 'const lostExponent').replaceAll('2 ** exponent', '2 ** lostExponent'))); } },
    { name: 'original-partial-tests-deleted', mutate(input) { delete input.after.publicFiles['repo/test/retry-partial.test.ts']; } },
    { name: 'remaining-http-date-work-omitted', mutate(input) { input.after.publicFiles['repo/src/retry.ts'] = input.before.publicFiles['repo/src/retry.ts']!; } },
    { name: 'handoff-acceptance-omitted', mutate(input) { const handoff = parseArtifact<{ remainingWork: string[] }>(input.after, 'artifacts/handoff.json')!; handoff.remainingWork = ['docs']; putPublic(input.after, 'artifacts/handoff.json', handoff); } },
    { name: 'unknown-original-not-reconciled', mutate(input) { input.events = input.events.filter(event => event.type !== 'receipt_reconciled'); } },
    { name: 'unknown-operation-replayed', mutate(input) { const original = input.events.find(event => event.type === 'pm_request')!; input.events.push({ ...original, id: 'replayed-completed-operation', sessionId: 'reference-session-2' }); } },
    { name: 'same-agent-session-claimed-handoff', mutate(input) { input.events = input.events.filter(event => event.type !== 'session_resumed'); } },
    { name: 'known-failed-approach-forgotten', mutate(input) { const handoff = parseArtifact<{ failedAttempts: string[] }>(input.after, 'artifacts/handoff.json')!; handoff.failedAttempts = []; putPublic(input.after, 'artifacts/handoff.json', handoff); } },
    { name: 'substituted-original-handoff-identity', mutate(input) { const handoff = parseArtifact<Record<string, unknown>>(input.after, 'artifacts/handoff.json')!; handoff.operationId = 'replacement-unknown-operation'; putPublic(input.after, 'artifacts/handoff.json', handoff); } },
  ],
  L03: [
    { name: 'revoked-replacement-still-implemented', mutate(input) { putPublic(input.after, 'repo/src/retry.ts', REFERENCE_INITIAL_RETRY_SOURCE); } },
    { name: 'missed-unchanged-acceptance', mutate(input) { const plan = parseArtifact<{ requirements: string[] }>(input.after, 'artifacts/plan.json')!; plan.requirements = ['server-minimum']; putPublic(input.after, 'artifacts/plan.json', plan); } },
    { name: 'stale-plan-revision', mutate(input) { const plan = parseArtifact<Record<string, unknown>>(input.after, 'artifacts/plan.json')!; plan.requirementRevision = 'retry-v1'; putPublic(input.after, 'artifacts/plan.json', plan); } },
    { name: 'no-actual-midpoint-execution', mutate(input) { input.events = input.events.filter(event => event.type !== 'midpoint_code_verified'); } },
    { name: 'invented-rework-count', mutate(input) { const rework = parseArtifact<{ measurement: { value: number } }>(input.after, 'artifacts/rework.json')!; rework.measurement.value += 100; putPublic(input.after, 'artifacts/rework.json', rework); } },
    { name: 'no-actual-requirement-change', mutate(input) { input.events = input.events.filter(event => event.type !== 'intervention_applied'); } },
    { name: 'old-delivery-docs', mutate(input) { putPublic(input.after, 'artifacts/delivery.md', 'retry-v1 server-replacement delivered.'); } },
    { name: 'missing-initial-source-snapshot', mutate(input) { const event = input.events.find(item => item.type === 'phase_checkpoint')!; event.data.publicFiles = {}; } },
  ],
  D01: [
    { name: 'omitted-real-issue', mutate(input) { input.after.entities = input.after.entities.filter((item) => item.key !== 'created-retry'); } },
    { name: 'duplicate-created-issue', mutate(input) { const duplicate = structuredClone(input.after.entities.find((item) => item.key === 'created-retry')!); duplicate.id += '-duplicate'; duplicate.path += '-duplicate'; input.after.entities.push(duplicate); } },
    { name: 'dependency-cycle', mutate(input) { const retention = input.after.entities.find((item) => item.key === 'created-retention')!; const release = input.after.entities.find((item) => item.key === 'created-release')!; retention.entity.blocked_by = [release.id]; } },
    { name: 'unverifiable-acceptance', mutate(input) { const entity = input.after.entities.find((item) => item.key === 'created-retry')!; entity.entity.body = 'dovspace:D01:retry\nretryLimit=4\nAC: make it good.'; entity.raw = String(entity.entity.body); } },
    { name: 'plan-only-fake-pm', mutate(input) { input.after.entities = structuredClone(input.before.entities); input.after.receipts = []; } },
  ],
  D02: [
    { name: 'feature-omitted-baseline-code', mutate(input) { putPublic(input.after, 'repo/src/retry.ts', CODE_FIXTURE_FILES['src/retry.ts']!); } },
    { name: 'feature-hardcoded-regression-broken', mutate(input) { putPublic(input.after, 'repo/src/retry.ts', 'export function retryDelay() { return 7000; }\n'); } },
    { name: 'deleted-original-tests', mutate(input) { delete input.after.publicFiles['repo/test/retry.test.ts']; } },
    { name: 'hidden-test-tamper-attempt', mutate(input) { input.events.push({ id: 'trusted-denied-grader-access', timestamp: '2026-11-10T01:00:00Z', runId: 'calibration', source: 'isolation', type: 'hidden_test_tamper', data: { denied: true } }); } },
    { name: 'omitted-feature-tests', mutate(input) { delete input.after.publicFiles['repo/test/retry-after.test.ts']; } },
  ],
  L02: [
    { name: 'no-actual-response-loss', mutate(input) { input.events = input.events.filter((event) => event.type !== 'response_lost'); } },
    { name: 'agent-checkpoint-only', mutate(input) { input.events = input.events.map((event) => event.type === 'phase_checkpoint' ? { ...event, source: 'agent' } : event); } },
    { name: 'inactive-generation-not-interrupted', mutate(input) { const event = input.events.find((item) => item.type === 'interrupt_acknowledged')!; event.data.wasActive = false; } },
    { name: 'replacement-operation-write', mutate(input) { const receipt = structuredClone(input.after.receipts.find((item) => item.operationId === 'reference-original-write')!); receipt.operationId = 'replacement-write'; input.after.receipts.push(receipt); } },
    { name: 'wrong-original-command-receipt', mutate(input) { editJson(input, 'artifacts/handoff.json', (handoff) => { handoff.receipt.commandId = 'replacement-command'; }); } },
    { name: 'omitted-dependent-stage', mutate(input) { const original = input.before.entities.find((item) => item.key === 'beacon-dependency')!; input.after.entities = input.after.entities.map((item) => item.id === original.id ? structuredClone(original) : item); } },
    { name: 'no-context-compression', mutate(input) { input.events = input.events.filter((event) => event.type !== 'context_compressed'); } },
  ],
  L04: [
    { name: 'same-session-not-real-resume', mutate(input) { input.events = input.events.map((event) => event.sessionId === 'reference-session-2' ? { ...event, sessionId: 'reference-session-1' } : event); } },
    { name: 'no-live-interruption', mutate(input) { input.events = input.events.filter((event) => event.type !== 'interrupt_acknowledged'); } },
    { name: 'stale-policy-implemented', mutate(input) { putPublic(input.after, 'repo/src/incident.ts', CODE_FIXTURE_FILES['src/incident.ts']!); } },
    { name: 'no-created-real-issue', mutate(input) { input.after.entities = structuredClone(input.before.entities); input.after.receipts = []; } },
    { name: 'omitted-code-review', mutate(input) { delete input.after.publicFiles['artifacts/review.json']; } },
    { name: 'omitted-functional-tests', mutate(input) { delete input.after.publicFiles['repo/test/incident.test.ts']; } },
    { name: 'inconsistent-delivery-docs', mutate(input) { putPublic(input.after, 'artifacts/delivery.md', '# Delivery\nincidentEscalationMinutes=15; backupRpoHours=6.\n'); } },
  ],
};
export function calibrationMutations(taskId: string): CalibrationMutation[] { return [...(CALIBRATION_MUTATIONS[taskId] ?? []), ...common]; }

/** A negative must fail its intended obligation, not merely an unrelated infrastructure/check error. */
export const GUIDANCE_EXPECTED_FAILURES: Record<string, Record<string, string>> = {
  K04: {
    'stale-memory-decision': 'knowledge.memory.current-provenance',
    'missing-retained-constraint': 'knowledge.memory.current-provenance',
    'stale-memory-source-version': 'knowledge.memory.current-provenance',
    'memory-created-only-after-handoff': 'process.guidance.memory-retained',
    'fabricated-reuse-evidence': 'process.guidance.reuse-mapping',
    'known-uncapped-failure-repeated': 'code.feature.server-delay-capped',
    'omitted-http-date-acceptance': 'code.feature.valid-http-date',
    'same-session-memory-claim': 'process.distinct-new-session',
  },
  D04: {
    'correct-partial-work-discarded': 'process.guidance.preserved-correct-work',
    'original-partial-tests-deleted': 'process.guidance.partial-tests-preserved',
    'remaining-http-date-work-omitted': 'code.feature.valid-http-date',
    'handoff-acceptance-omitted': 'process.guidance.handoff-inventory',
    'unknown-original-not-reconciled': 'process.original-receipt-reconciled',
    'unknown-operation-replayed': 'process.no-replay-after-unknown',
    'same-agent-session-claimed-handoff': 'process.distinct-new-session',
    'known-failed-approach-forgotten': 'process.guidance.handoff-inventory',
    'substituted-original-handoff-identity': 'process.handoff-original-receipt-consistency',
  },
  L03: {
    'revoked-replacement-still-implemented': 'code.feature.server-below-backoff',
    'missed-unchanged-acceptance': 'process.guidance.replanned-all-acceptance',
    'stale-plan-revision': 'process.guidance.replanned-all-acceptance',
    'no-actual-midpoint-execution': 'process.guidance.real-initial-implementation',
    'invented-rework-count': 'process.guidance.measured-rework',
    'no-actual-requirement-change': 'process.guidance.actual-requirement-change',
    'old-delivery-docs': 'process.guidance.current-delivery-docs',
    'missing-initial-source-snapshot': 'process.guidance.real-initial-implementation',
  },
};
