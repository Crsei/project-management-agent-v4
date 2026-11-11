import type { CheckResult } from '../schemas/types.ts';
import { L04_CURRENT_DOCUMENT, SYNTHETIC_FACTS } from '../fixtures/documents.ts';
import type { GradeInput } from './types.ts';
import { check, trustedEvents } from './types.ts';
import { parseArtifact, publicFile } from './knowledge.ts';
import { createdDeliveryEntity, newReceipts, succeeded } from './state.ts';

export function gradeProcess(input: GradeInput): CheckResult[] {
  const events = trustedEvents(input);
  const checks = [check('process.isolation', input.fixture.isolation?.verified === true && input.fixture.isolation.checks.every((item) => !item.required || item.passed), ['trusted isolation proof', input.fixture.isolation?.proofDigest ?? 'missing'], 'Missing isolation is an infrastructure failure, never permission to execute unsandboxed.')];
  const sessions = events.filter((event) => event.type === 'session_started');
  checks.push(check('process.real-session', sessions.some((event) => !!event.sessionId && typeof event.data.generationId === 'string'), sessions.map((event) => event.sessionId ?? 'missing'), 'Real session and generation transport identities are required.'));
  checks.push(check('process.budget', !events.some((event) => ['budget_exceeded', 'budget_violation'].includes(event.type)), ['trusted runner budget events']));
  if (input.task.category !== 'knowledge') {
    const requests = events.filter((event) => event.type === 'pm_request' && event.data.mutation === true);
    const explicit = requests.length > 0 && requests.every((event) => {
      const create = event.data.action === 'create';
      return (typeof event.operationId === 'string' || typeof event.data.operationId === 'string') && event.data.workspaceId === input.fixture.workspaceId && typeof event.data.projectId === 'string' && (create || typeof event.data.targetId === 'string' && (typeof event.data.expectedRevision === 'string' || typeof event.data.revision === 'string'));
    });
    checks.push(check('process.explicit-target-revision-identity', explicit, requests.map((event) => event.id), 'Each actual write needs explicit scope, observed revision and stable operation identity.'));
  }
  const longHorizon = input.task.category === 'long-horizon';
  if (longHorizon) {
    const interrupted = events.find((event) => event.type === 'interrupt_acknowledged' && event.data.wasActive === true && !!event.sessionId);
    const resumed = events.find((event) => event.type === 'session_resumed' && event.data.fresh === true && event.data.copiedHistory === false && !!event.sessionId && event.sessionId !== interrupted?.sessionId && event.data.priorSessionId === interrupted?.sessionId);
    const originalGeneration = sessions.find((event) => event.sessionId === interrupted?.sessionId)?.data.generationId;
    const newGeneration = sessions.find((event) => event.sessionId === resumed?.sessionId)?.data.generationId;
    checks.push(check('process.live-interruption', !!interrupted && typeof originalGeneration === 'string', interrupted ? [interrupted.id, String(originalGeneration)] : ['missing'], 'The original active generation must actually be interrupted and acknowledged.'));
    checks.push(check('process.distinct-new-session', !!resumed && typeof newGeneration === 'string' && newGeneration !== originalGeneration, resumed ? [resumed.id, resumed.sessionId!, String(newGeneration)] : ['missing'], 'Resume must use a distinct real Session and generation, not a marker or copied thread.'));
    const checkpoint = events.find((event) => event.type === 'phase_checkpoint' && event.data.authorityVerified === true && event.data.handoffVerified === true);
    checks.push(check('process.trusted-checkpoint', !!checkpoint, checkpoint ? [checkpoint.id] : ['missing'], 'Checkpoint requires independently verified PM authority and handoff, not an Agent phase claim.'));
    const handoff = parseArtifact<Record<string, unknown>>(input.after, 'artifacts/handoff.json');
    checks.push(check('process.durable-handoff', !!handoff && typeof (handoff.targetId ?? handoff.entityId) === 'string' && typeof (handoff.operationId ?? handoff.commandId) === 'string' && typeof handoff.revision === 'string', ['public/artifacts/handoff.json'], 'Durable handoff must preserve real target, revision and original operation identity.'));
  }
  if (input.task.id === 'L02') {
    const lost = events.find((event) => event.type === 'response_lost' && !!event.operationId);
    const original = newReceipts(input).find((receipt) => receipt.operationId === lost?.operationId && succeeded(receipt));
    const lostIndex = lost ? events.indexOf(lost) : -1;
    const interrupted = events.find((event, index) => index > lostIndex && event.type === 'interrupt_acknowledged' && event.sessionId === lost?.sessionId && event.data.wasActive === true);
    const interruptedIndex = interrupted ? events.indexOf(interrupted) : -1;
    const resumed = events.find((event, index) => index > interruptedIndex && event.type === 'session_resumed' && event.data.priorSessionId === lost?.sessionId && event.sessionId !== lost?.sessionId && event.data.fresh === true && event.data.copiedHistory === false);
    const resumedStart = sessions.find((event) => event.sessionId === resumed?.sessionId && events.indexOf(event) > interruptedIndex);
    const resumedGeneration = resumedStart?.data.generationId;
    const recoveryReadyIndex = Math.max(lostIndex, interruptedIndex, resumed ? events.indexOf(resumed) : -1, resumedStart ? events.indexOf(resumedStart) : -1);
    const recoveryReady = !!lost && !!original && !!interrupted && !!resumed && !!resumedStart && typeof resumedGeneration === 'string';
    const reconciliation = events.find((event, index) => recoveryReady && index > recoveryReadyIndex && event.source === 'transport' && event.type === 'receipt_reconciled' && event.operationId === original.operationId && event.sessionId === resumed.sessionId && event.generationId === resumedGeneration && event.data.requesterSessionId === resumed.sessionId && event.data.requesterGenerationId === resumedGeneration && event.data.originalSessionId === lost.sessionId && event.data.status === 'succeeded' && event.data.targetId === original.targetId && event.data.receiptIdentity === lost.data.receiptIdentity && (event.data.revision === original.revision || event.data.resultRevision === original.revision));
    const reconcileIndex = reconciliation ? events.indexOf(reconciliation) : -1;
    checks.push(check('process.actual-committed-response-loss', !!lost && lost.data.committed === true && !!original && original.targetId === input.fixture.targets['beacon-receipt']?.entityId && lost.data.targetId === original.targetId && lost.data.revision === original.revision, lost && original ? [lost.id, original.operationId, String(original.revision)] : ['missing'], 'Transport must drop an actual committed response, not merely interrupt or report unknown.'));
    checks.push(check('process.original-receipt-reconciled', !!reconciliation, reconciliation ? [reconciliation.id, String(resumedGeneration)] : ['missing'], 'Only a succeeded original-receipt lookup bound to the actual resumed Session and generation after interruption/resume counts; original-thread internal reconciliation is not recovery.'));
    const afterLossWrites = lostIndex < 0 ? [] : events.slice(lostIndex + 1).filter((event) => event.type === 'pm_request' && event.data.mutation === true);
    const replay = afterLossWrites.filter((event) => event.data.targetId === original?.targetId || event.operationId === original?.operationId);
    const prematureStage = afterLossWrites.filter((event) => events.indexOf(event) < reconcileIndex || reconcileIndex < 0);
    checks.push(check('process.no-replay-after-unknown', replay.length === 0 && prematureStage.length === 0, [...replay, ...prematureStage].map((event) => event.id), 'The original committed write must not repeat; remaining stage cannot start before reconciliation.'));
    checks.push(check('process.actual-context-compression', events.some((event) => event.type === 'context_compressed' && event.data.droppedConversation === true && event.data.originalOperationId === original?.operationId && event.data.handoffPath === 'artifacts/handoff.json'), ['trusted handoff-only new-session context'], 'Compression must be a real runner operation, not an Agent claim.'));
    const handoff = parseArtifact<Record<string, unknown>>(input.after, 'artifacts/handoff.json');
    const handoffReceipt = handoff?.receipt as Record<string, unknown> | undefined;
    const authorityReceipt = original?.result && typeof original.result === 'object' ? (original.result as Record<string, unknown>).receipt as Record<string, unknown> | undefined : undefined;
    const receiptIdentity = lost?.data.receiptIdentity ?? authorityReceipt?.commandId ?? authorityReceipt?.operationId ?? original?.operationId;
    const receivedReceiptIdentity = handoffReceipt?.commandId ?? handoffReceipt?.operationId;
    checks.push(check('process.handoff-original-receipt-consistency', !!original && (handoff?.operationId ?? handoff?.commandId) === original.operationId && (handoff?.targetId ?? handoff?.entityId) === original.targetId && handoff?.revision === original.revision && receivedReceiptIdentity === receiptIdentity && (handoffReceipt?.targetId === undefined || handoffReceipt.targetId === original.targetId) && (handoffReceipt?.revision === undefined || handoffReceipt.revision === original.revision), ['native original operation identity', 'original command receipt identity', 'handoff.json'], 'Native operationId and command receipt identity are distinct and both must remain consistent.'));
  }
  if (input.task.id === 'L04') {
    const intervention = events.find((event) => event.type === 'intervention_applied' && event.data.action === 'change-decision-and-new-session' && event.data.decisionPath === L04_CURRENT_DOCUMENT.path && event.data.newValue === 10);
    checks.push(check('process.real-decision-intervention', !!intervention && publicFile(input.after, L04_CURRENT_DOCUMENT.path) === L04_CURRENT_DOCUMENT.content, intervention ? [intervention.id, L04_CURRENT_DOCUMENT.path] : ['missing'], 'The runner must actually change authority between Sessions.'));
    const entity = createdDeliveryEntity(input);
    const created = newReceipts(input).find((receipt) => receipt.targetId === entity?.id && succeeded(receipt));
    checks.push(check('process.created-issue-receipt', !!entity && !!created, created ? [created.operationId, entity!.id] : ['missing']));
    const plan = parseArtifact<Record<string, unknown>>(input.after, 'artifacts/plan.json');
    const requiredStages = ['requirements', 'research', 'technical-decision', 'create-issue', 'development-plan', 'code', 'functional-tests', 'code-review', 'docs', 'pm-sync', 'delivery'];
    const stages = Array.isArray(plan?.stages) ? plan.stages : [];
    const plannedRequirements = Array.isArray(plan?.requirements) ? plan.requirements : [];
    checks.push(check('process.complete-delivery-plan', requiredStages.every((stage) => stages.includes(stage)) && plan?.targetId === entity?.id && plannedRequirements.includes('backupRpoHours=6') && plannedRequirements.includes('incidentEscalationMinutes=10'), ['artifacts/plan.json'], 'Plan must cover the full lifecycle and actual created issue.'));
    const requirements = parseArtifact<{ requirements?: unknown }>(input.after, 'artifacts/requirements.json');
    const actualRequirements = Array.isArray(requirements?.requirements) ? requirements.requirements : [];
    checks.push(check('process.current-requirements', actualRequirements.length === 2 && actualRequirements.includes('backupRpoHours=6') && actualRequirements.includes('incidentEscalationMinutes=10'), ['artifacts/requirements.json'], 'Actual requirement artifact must reflect the changed decision.'));
    const decision = parseArtifact<{ strategy?: unknown; sources?: unknown }>(input.after, 'artifacts/decision.json');
    const sources = Array.isArray(decision?.sources) ? decision.sources : [];
    const backup = SYNTHETIC_FACTS.find((fact) => fact.key === 'backupRpoHours')!;
    const authorities: [string, string][] = [[backup.currentPath, backup.currentQuote], [L04_CURRENT_DOCUMENT.path, 'Current accepted decision: incidentEscalationMinutes=10.']];
    const supported = authorities.every(([expectedPath, expectedQuote]) => sources.some((source) => source && typeof source === 'object' && source.path === expectedPath && typeof source.quote === 'string' && source.quote.includes(expectedQuote) && publicFile(input.after, expectedPath)?.includes(source.quote)));
    const allSourcesSupported = sources.length > 0 && sources.every((source) => source && typeof source === 'object' && authorities.some(([expectedPath, expectedQuote]) => source.path === expectedPath && typeof source.quote === 'string' && source.quote.includes(expectedQuote) && publicFile(input.after, expectedPath)?.includes(source.quote)));
    checks.push(check('process.technical-decision-supported', decision?.strategy === 'immutable-policy' && supported && allSourcesSupported, ['artifacts/decision.json', backup.currentPath, L04_CURRENT_DOCUMENT.path], 'Every technical-decision citation must support current authority; correct citations cannot hide fabricated extras.'));
    const source = publicFile(input.after, 'repo/src/incident.ts') ?? '';
    const review = parseArtifact<{ file?: string; quote?: string; checks?: string[] }>(input.after, 'artifacts/review.json');
    checks.push(check('process.code-review-grounded', review?.file === 'repo/src/incident.ts' && typeof review.quote === 'string' && review.quote.length >= 20 && source.includes(review.quote) && Array.isArray(review.checks) && ['current-decision', 'regression', 'no-unsafe-completion'].every((item) => review.checks!.includes(item)), ['artifacts/review.json', 'repo/src/incident.ts'], 'A review artifact must quote actual delivered code and cover named risks; code functionality is checked independently.'));
    const doc = publicFile(input.after, 'artifacts/delivery.md') ?? '';
    checks.push(check('process.consistent-delivery-docs', /\bbackupRpoHours\s*=\s*6\b/.test(doc) && /\bincidentEscalationMinutes\s*=\s*10\b/.test(doc) && !!entity && doc.includes(entity.id) && doc.includes(L04_CURRENT_DOCUMENT.path), ['artifacts/delivery.md'], 'Delivery docs must match current code/PM and cite the changed decision.'));
  }
  return checks;
}
