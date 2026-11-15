import test from 'node:test';
import assert from 'node:assert/strict';
import type { BenchEvent } from '../schemas/types.ts';
import { summarizeCliObservations } from './cli-observations.ts';

const productSource = { sourceHash: 'a'.repeat(64), manifestVersion: '1', cliSha256: 'b'.repeat(64) };
const reference = { workspaceId: 'workspace', kind: 'issue', id: 'ISS-1', projectId: 'PRJ-1', revision: 'source-r3', availability: 'available', reason: null };
const turnContext = { version: 1, threadId: 'session', messageId: 'input', acceptedAt: '2026-11-14T00:00:00.000Z', pmReferences: [reference] };
function observation(id: string, kind: string, value: unknown, extra: Partial<BenchEvent> = {}): BenchEvent {
  return { id, runId: 'run', timestamp: '2026-11-14T00:00:00.000Z', source: 'transport', type: 'cli_observation', sessionId: 'session', generationId: 'generation',
    data: { kind, collectionStatus: 'observed', value, productSource, ...(kind === 'message-context' ? { messageId: 'input' } : {}) }, ...extra };
}
function generation(id = 'generation-event', context = turnContext): BenchEvent {
  return observation(id, 'generation', { generation: { id: 'generation', threadId: 'session', inputMessageId: 'input', messageId: 'assistant', status: 'completed', turnContext: context } });
}
function usage(id: string, updatedAt: string | undefined, outputTokens = 3): BenchEvent {
  return observation(id, 'usage', { threadId: 'session', generationId: 'generation', providerInstanceId: 'provider', model: 'model', ...(updatedAt === undefined ? {} : { updatedAt }),
    totals: { uncachedInputTokens: 10, cachedInputTokens: 4, cacheCreationTokens: 2, outputTokens, reasoningTokens: 1 },
    reportedTurn: { inputTokens: 80, outputTokens: 7, cachedInputTokens: 50 }, context: { usedTokens: 90, maxTokens: 100, updatedAt: '2026-11-14T00:00:00.000Z' }, costUsd: 0 });
}
function interval(id: string, data: Record<string, unknown> = {}, source: BenchEvent['source'] = 'transport'): BenchEvent {
  return { id, runId: 'run', timestamp: '2026-11-14T00:00:00.000Z', source, type: 'cli_command_interval',
    data: { command: ['agent', 'session', 'read'], durationMs: 12, purpose: 'observation', exitCode: 0, outcome: 'completed', ...data } };
}

test('empty and failed pre-auth traces serialize without manufactured observations or usage', () => {
  const summary = summarizeCliObservations([]);
  assert.deepEqual(summary.counts, { events: 0, observed: 0, unavailable: 0, invalid: 0, duplicateSnapshots: 0 });
  assert.deepEqual(summary.productUsage.snapshots, []);
  assert.equal(summary.cliTiming.observedSubprocessDurationMs, null);
  assert.equal(summary.cliTiming.observedCollectionDurationMs, null);
  assert.equal(summary.cliTiming.processOverheadMs, null);
  const failed = summarizeCliObservations([interval('login-failed', { command: ['agent', 'login'], purpose: 'control', exitCode: 1, outcome: 'failed' })]);
  assert.deepEqual(failed.observations, []);
  assert.equal(failed.cliTiming.observedSubprocessDurationMs, 12);
  assert.equal(failed.cliTiming.observedCollectionDurationMs, null);
  assert.deepEqual(JSON.parse(JSON.stringify(failed)), failed);
});

test('missing product context, identities and usage fields stay unknown rather than empty or zero', () => {
  const summary = summarizeCliObservations([
    observation('context', 'message-context', { visibility: 'visible' }),
    observation('usage', 'usage', { threadId: 'session' }),
    observation('execution', 'execution', { environment: { agentWorkspaceId: 'workspace', agentWorkspaceRevision: 2, frozen: true } }),
  ]);
  assert.equal(summary.observations[0]!.identityStatus, 'missing');
  assert.ok(summary.observations[0]!.issues.includes('missing-turn-context'));
  assert.equal(summary.observations[1]!.usage!.productEstimatedCostUsd, null);
  assert.equal(summary.observations[1]!.usage!.productTokenTotals.outputTokens, null);
  assert.equal(summary.productUsage.snapshots[0]!.status, 'identity-unverified');
  assert.equal(summary.productUsage.snapshots[0]!.value, null);
  assert.equal(summary.observations[2]!.identityStatus, 'missing');
  assert.equal(summary.observations[2]!.execution!.agentWorkspaceRevision, 2);
  assert.deepEqual(summary.correlations, []);
});

test('unavailable collection invalidates current usage but retains earlier source evidence', () => {
  const unavailable = observation('unavailable', 'usage', null);
  unavailable.data.collectionStatus = 'unavailable'; unavailable.data.error = 'Agent request failed (HTTP 403)';
  const summary = summarizeCliObservations([usage('earlier', '2026-11-14T00:00:00.000Z'), unavailable]);
  assert.equal(summary.observations[1]!.collectionStatus, 'unavailable');
  assert.equal(summary.observations[1]!.identityStatus, 'unavailable');
  assert.equal(summary.observations[1]!.error, 'Agent request failed (HTTP 403)');
  assert.equal(summary.productUsage.snapshots[0]!.status, 'unavailable');
  assert.equal(summary.productUsage.snapshots[0]!.value, null);
  assert.deepEqual(summary.productUsage.snapshots[0]!.eventIds, ['earlier', 'unavailable']);
  assert.equal(summary.observations[0]!.usage!.productTokenTotals.outputTokens, 3);
});

test('requested and returned Session, generation and accepted input identities cannot silently match', () => {
  const wrongSession = generation('wrong-session'); wrongSession.sessionId = 'another-session';
  const wrongGeneration = generation('wrong-generation'); wrongGeneration.generationId = 'another-generation';
  const wrongInput = observation('wrong-input', 'message-context', { turnContext, visibility: 'visible' }); wrongInput.data.messageId = 'assistant';
  const inconsistentGeneration = generation('inconsistent', { ...turnContext, messageId: 'different-input' });
  const summary = summarizeCliObservations([wrongSession, wrongGeneration, wrongInput, inconsistentGeneration]);
  assert.ok(summary.observations.every(row => row.identityStatus === 'mismatch'));
  assert.equal(summary.observations[0]!.requested.sessionId, 'another-session');
  assert.equal(summary.observations[0]!.identities[0]!.sessionId, 'session');
  assert.equal(summary.observations[2]!.identities[0]!.inputMessageId, 'input');
  assert.deepEqual(summary.correlations, []);
});

test('actual generation links correlate Session and accepted input reference revisions without body inference', () => {
  const events = [observation('session-event', 'session', { thread: { remoteId: 'session', revision: 4 } }), generation(),
    observation('context-event', 'message-context', { turnContext: { ...turnContext, body: 'not a documented field', truncated: true }, visibility: 'visible' })];
  const before = structuredClone(events);
  const summary = summarizeCliObservations(events);
  assert.deepEqual(events, before);
  const link = summary.correlations[0]!;
  assert.equal(link.inputMessageId, 'input'); assert.equal(link.outputMessageId, 'assistant');
  assert.deepEqual(link.sessionEventIds, ['session-event']); assert.deepEqual(link.contextEventIds, ['context-event']);
  assert.deepEqual(link.issues, []);
  const context = summary.observations[2]!.contexts[0]!;
  assert.equal(context.pmReferences![0]!.revision, 'source-r3');
  assert.equal(context.body, 'not-projected');
  assert.ok(!JSON.stringify(summary).includes('not a documented field'));
  assert.ok(!('truncated' in context));
  assert.deepEqual(summary.sourceVersions[0]!.version, productSource);
  assert.deepEqual(summary.sourceVersions[0]!.eventIds, ['session-event', 'generation-event', 'context-event']);
});

test('source revision and source-version mismatches remain explicit alongside correlation', () => {
  const collected = observation('context', 'message-context', { turnContext: { ...turnContext, pmReferences: [{ ...reference, revision: 'source-r4' }] }, visibility: 'visible' });
  collected.data.productSource = { ...productSource, sourceHash: 'c'.repeat(64) };
  const summary = summarizeCliObservations([generation(), collected]);
  assert.equal(summary.sourceVersions.length, 2);
  assert.ok(summary.correlations[0]!.issues.includes('context-reference-metadata-mismatch'));
  assert.ok(summary.correlations[0]!.issues.includes('correlated-product-source-version-mismatch'));
  assert.ok(summary.observations.every(row => row.issues.includes('run-product-source-version-mismatch')));
});

test('legacy missing execution links and redacted context are not invented from request identities', () => {
  const legacy = observation('legacy', 'generation', { generation: { id: 'generation', threadId: 'session', messageId: 'assistant', status: 'completed' } });
  const redacted = observation('redacted', 'message-context', { visibility: 'redacted' });
  const summary = summarizeCliObservations([legacy, redacted]);
  assert.equal(summary.correlations[0]!.inputMessageId, null);
  assert.ok(summary.correlations[0]!.issues.includes('missing-generation-input-message'));
  assert.ok(summary.correlations[0]!.issues.includes('missing-message-context-observation'));
  assert.ok(summary.observations[1]!.issues.includes('context-visibility-not-confirmed-visible'));
});

test('duplicate snapshots retain IDs while newest product usage replaces older values without adding categories', () => {
  const first = usage('first', '2026-11-14T00:00:00.000Z');
  const repeated = { ...first, id: 'repeat' };
  const later = usage('later', '2026-11-14T00:00:02.000Z', 6);
  const summary = summarizeCliObservations([later, first, repeated]);
  assert.equal(summary.counts.duplicateSnapshots, 1);
  assert.equal(summary.observations[2]!.duplicateOfEventId, 'first');
  assert.equal(summary.productUsage.snapshots.length, 1);
  const selected = summary.productUsage.snapshots[0]!;
  assert.equal(selected.selectedEventId, 'later');
  assert.equal(selected.value!.productTokenTotals.outputTokens, 6);
  assert.equal(selected.value!.productTokenTotals.uncachedInputTokens, 10);
  assert.equal(selected.value!.productTokenTotals.reasoningTokens, 1);
  assert.equal(selected.value!.reportedTurn.inputTokens, 80);
  assert.equal(selected.value!.reportedTurn.cachedInputTokens, 50);
  assert.equal(selected.value!.reportedTurn.cacheCreationTokens, null);
  assert.equal(selected.value!.contextWindow.usedTokens, 90);
  assert.equal(selected.value!.productEstimatedCostUsd, 0);
  assert.equal(summary.productUsage.aggregation, 'not-summed-across-generations');
});

test('ambiguous cumulative snapshots cannot be summed or arbitrarily selected', () => {
  for (const updatedAt of [undefined, '2026-11-14T00:00:00.000Z']) {
    const summary = summarizeCliObservations([usage('first', updatedAt, 3), usage('second', updatedAt, 7)]);
    assert.equal(summary.productUsage.snapshots[0]!.status, 'ambiguous');
    assert.equal(summary.productUsage.snapshots[0]!.selectedEventId, null);
    assert.equal(summary.productUsage.snapshots[0]!.value, null);
  }
  const changedSource = usage('changed-source', '2026-11-14T00:00:03.000Z', 7);
  changedSource.data.productSource = { ...productSource, cliSha256: 'c'.repeat(64) };
  assert.equal(summarizeCliObservations([usage('first', '2026-11-14T00:00:00.000Z'), changedSource]).productUsage.snapshots[0]!.status, 'ambiguous');
});

test('distinct runs and generations keep product estimates separate and unknown fields nullable', () => {
  const secondGeneration = usage('second-generation', undefined); secondGeneration.generationId = 'generation-2';
  secondGeneration.data.value = { threadId: 'session', generationId: 'generation-2', reportedTurn: { inputTokens: 23 }, costUsd: Number.NaN };
  const anotherRun = usage('another-run', undefined); anotherRun.runId = 'run-2';
  const summary = summarizeCliObservations([usage('first', undefined), secondGeneration, anotherRun]);
  assert.equal(summary.productUsage.snapshots.length, 3);
  assert.equal(summary.productUsage.snapshots[1]!.value!.productEstimatedCostUsd, null);
  assert.equal(summary.productUsage.snapshots[1]!.value!.productTokenTotals.uncachedInputTokens, null);
  assert.equal(summary.productUsage.snapshots[1]!.value!.reportedTurn.inputTokens, 23);
  assert.equal(summary.counts.duplicateSnapshots, 0);
});

test('untrusted claims and conflicting event IDs do not become selected usage authority', () => {
  const untrusted = usage('claim', undefined); untrusted.source = 'agent';
  const unavailableClaim = observation('unavailable-claim', 'usage', null, { source: 'agent' }); unavailableClaim.data.collectionStatus = 'unavailable';
  const claims = summarizeCliObservations([untrusted, unavailableClaim]);
  assert.ok(claims.observations.every(row => row.collectionStatus === 'invalid'));
  assert.equal(claims.productUsage.snapshots[0]!.value, null);
  const conflict = summarizeCliObservations([usage('same-id', '2026-11-14T00:00:00.000Z'), usage('same-id', '2026-11-14T00:00:01.000Z', 7)]);
  assert.ok(conflict.observations.every(row => row.issues.includes('conflicting-event-id')));
  assert.equal(conflict.productUsage.snapshots[0]!.status, 'ambiguous');
});

test('native output item revisions and explicit truncation fields are snapshots, not extra consumption', () => {
  const event = observation('output', 'output', { records: [
    { kind: 'stream-open', generationId: 'generation' },
    { kind: 'native', generationId: 'generation', event: { kind: 'snapshot', snapshot: { generationId: 'generation', threadId: 'session', sequence: 4, status: 'running', items: [{ id: 'item', outputTruncated: true }] } } },
    { kind: 'native', generationId: 'generation', event: { kind: 'item', generationId: 'generation', sequence: 5, item: { id: 'item', outputTruncated: false } } },
    { kind: 'native', generationId: 'generation', event: { kind: 'item', generationId: 'generation', sequence: 6, item: { id: 'other', text: 'not evidence of truncation', truncated: true } } },
  ] });
  const summary = summarizeCliObservations([event]);
  assert.equal(summary.observations[0]!.identityStatus, 'matched');
  assert.deepEqual(summary.observations[0]!.output, { sequences: [4, 5, 6], statuses: ['running'], itemCount: 2, truncatedItems: 0, explicitUntruncatedItems: 1, truncationUnknownItems: 1 });
  const wrong = structuredClone(event); wrong.id = 'wrong';
  const wrongValue = wrong.data.value;
  assert.ok(wrongValue !== null && typeof wrongValue === 'object' && 'records' in wrongValue && Array.isArray(wrongValue.records));
  wrongValue.records.push({ kind: 'stream-open', generationId: 'other-generation' });
  assert.equal(summarizeCliObservations([wrong]).observations[0]!.identityStatus, 'mismatch');
});

test('trusted CLI timing deduplicates event identity but counts distinct equal-duration subprocesses', () => {
  const first = interval('first');
  const summary = summarizeCliObservations([first, first, interval('second'), interval('control', { durationMs: 5, purpose: 'control', outcome: 'unknown', exitCode: null })]);
  assert.equal(summary.cliTiming.observedSubprocessDurationMs, 29);
  assert.equal(summary.cliTiming.observedCollectionDurationMs, 24);
  assert.equal(summary.cliTiming.intervals[1]!.duplicateOfEventId, 'first');
  assert.equal(summary.cliTiming.processOverheadMs, null);
  assert.equal(summarizeCliObservations([interval('unknown-purpose', { purpose: undefined })]).cliTiming.observedCollectionDurationMs, null);
  assert.equal(summarizeCliObservations([interval('untrusted', {}, 'agent')]).cliTiming.observedSubprocessDurationMs, null);
  assert.equal(summarizeCliObservations([interval('invalid', { durationMs: -1 })]).cliTiming.observedSubprocessDurationMs, null);
  assert.equal(summarizeCliObservations([first, interval('first', { durationMs: 13 })]).cliTiming.observedSubprocessDurationMs, null);
});

test('missing output snapshots do not become zero output and unsupported context versions remain unknown', () => {
  const output = observation('detached', 'output', { records: [{ kind: 'stream-closed', generationId: 'generation' }] });
  const future = observation('future-context', 'message-context', { visibility: 'visible', turnContext: { ...turnContext, version: 2 } });
  const missingReferences = observation('missing-references', 'message-context', { visibility: 'visible', turnContext: { threadId: 'session', messageId: 'input', version: 1 } });
  const summary = summarizeCliObservations([output, future, missingReferences]);
  assert.equal(summary.observations[0]!.output!.itemCount, null);
  assert.equal(summary.observations[0]!.output!.truncatedItems, null);
  assert.equal(summary.observations[1]!.identityStatus, 'missing');
  assert.ok(summary.observations[1]!.issues.includes('unsupported-turn-context-version'));
  assert.equal(summary.observations[2]!.contexts[0]!.pmReferences, null);
});

test('cross-observation input mismatches and reordered reference metadata are distinguished', () => {
  const output = observation('output', 'output', { records: [
    { kind: 'stream-open', generationId: 'generation', inputMessageId: 'different-input' },
    { kind: 'native', generationId: 'generation', event: { kind: 'snapshot', snapshot: { generationId: 'generation', threadId: 'session', sequence: 1, status: 'completed', items: [] } } },
  ] });
  const secondReference = { ...reference, id: 'ISS-2', revision: 'source-r2' };
  const gen = generation('gen', { ...turnContext, pmReferences: [reference, secondReference] });
  const collected = observation('context', 'message-context', { turnContext: { ...turnContext, pmReferences: [secondReference, reference] }, visibility: 'visible' });
  const summary = summarizeCliObservations([gen, collected, output]);
  assert.ok(summary.correlations[0]!.issues.includes('generation-output-input-message-mismatch'));
  assert.ok(!summary.correlations[0]!.issues.includes('context-reference-metadata-mismatch'));
  assert.equal(summary.observations[2]!.output!.itemCount, 0);
});
