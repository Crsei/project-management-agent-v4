import test from 'node:test';
import assert from 'node:assert/strict';
import { TraceRedactor, hashValue, makeEvent, observationsFromEvents, usageFromEvents } from './telemetry.ts';

test('trace redaction removes nested credentials and JSON-encoded tool payloads', () => {
  const redactor = new TraceRedactor(['explicit-paid-key']);
  const safe = redactor.value({ headers: { authorization: 'Bearer should-never-leak', cookie: 'pm_session=private' }, error: 'upstream rejected explicit-paid-key', output: JSON.stringify({ providerApiKey: 'hidden', detail: 'Bearer abcdefghijklmnop' }), url: 'postgres://user:pass@private/db' });
  const encoded = JSON.stringify(safe);
  for (const secret of ['should-never-leak', 'pm_session=private', 'explicit-paid-key', 'hidden', 'abcdefghijklmnop', 'user:pass']) assert.ok(!encoded.includes(secret));
  assert.ok(encoded.includes('[REDACTED]'));
});

test('shared evidence objects retain every redacted projection while real cycles terminate', () => {
  const evidence = { sourceHash: 'a'.repeat(64), tokens: 17, credential: 'private-observation-key' };
  const input: Record<string, unknown> = { observation: evidence, selectedUsage: evidence, sources: [evidence] };
  input.self = input;
  assert.deepEqual(new TraceRedactor().value(input), {
    observation: { sourceHash: 'a'.repeat(64), tokens: 17, credential: '[REDACTED]' },
    selectedUsage: { sourceHash: 'a'.repeat(64), tokens: 17, credential: '[REDACTED]' },
    sources: [{ sourceHash: 'a'.repeat(64), tokens: 17, credential: '[REDACTED]' }],
    self: '[CIRCULAR]',
  });
});

test('unknown provider usage is null, not invented free inference', () => {
  assert.deepEqual(usageFromEvents([]), { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null, modelCalls: null, toolCalls: null });
  const outputOnly = makeEvent('r', 'provider', 'usage', { generationId: 'g', outputTokens: 5 });
  assert.equal(usageFromEvents([outputOnly]).costUsd, null);
  assert.equal(usageFromEvents([outputOnly]).inputTokens, null);
  assert.equal(usageFromEvents([outputOnly]).outputTokens, 5);
});

test('provider request identity deduplicates observations but never counts agent claims', () => {
  const first = makeEvent('r', 'transport', 'provider_request', { requestId: 'p1' });
  const agentClaim = makeEvent('r', 'agent', 'provider_request', { requestId: 'fiction' });
  assert.equal(usageFromEvents([first, first, agentClaim]).modelCalls, 1);
  assert.equal(usageFromEvents([agentClaim]).modelCalls, null);
});

test('model usage cumulative revisions replace, distinct generations sum, unknown cost poisons total', () => {
  const events = [makeEvent('r', 'provider', 'usage', { generationId: 'g1', inputTokens: 2, outputTokens: 3, costUsd: 0.1 }), makeEvent('r', 'provider', 'usage', { generationId: 'g1', inputTokens: 4, outputTokens: 5, costUsd: 0.2 }), makeEvent('r', 'provider', 'usage', { generationId: 'g2', inputTokens: 7, outputTokens: 9 })];
  const usage = usageFromEvents(events);
  assert.equal(usage.inputTokens, 11);
  assert.equal(usage.outputTokens, 14);
  assert.equal(usage.costUsd, null);
});

test('comparison hashes are insensitive to object insertion order, not parameters', () => {
  assert.equal(hashValue({ model: 'm', options: { x: 1, y: true } }), hashValue({ options: { y: true, x: 1 }, model: 'm' }));
  assert.notEqual(hashValue({ model: 'm' }), hashValue({ model: 'other' }));
});

test('canonical PM calls dedupe bridge/service nesting without inventing missing identities', () => {
  const pm = makeEvent('r', 'transport', 'pm_request', { operationId: 'op' }, { operationId: 'op', toolName: 'pm_read' });
  const nested = makeEvent('r', 'transport', 'pm_tool_call', { operationId: 'op' }, { operationId: 'op', toolName: 'pm_read' });
  const complete = makeEvent('r', 'transport', 'observation_complete', { providerRequests: true, pmTools: true, nativeTools: true });
  const observations = observationsFromEvents([pm, pm, nested, complete], ['pm_read', 'pm_task_brief']);
  assert.equal(observations.pmToolCalls, 1);
  assert.deepEqual(observations.pmTools, { pm_read: 1 });
  assert.equal(observations.requiredToolCoverage.fraction, 0.5);
  assert.equal(observations.avoidableRepeatReads, null);
  assert.equal(observationsFromEvents([pm]).pmToolCalls, null);
  assert.equal(observationsFromEvents([makeEvent('r', 'transport', 'pm_request', {}, { toolName: 'pm_read' }), complete]).pmToolCalls, null);
  assert.equal(usageFromEvents([makeEvent('r', 'transport', 'provider_request')]).modelCalls, null);
});

test('request terminal usage coverage preserves subtotal but missing final usage poisons totals', () => {
  const request = (requestId: string) => makeEvent('r', 'transport', 'provider_request', { requestId, requestBytes: 20, toolSchemaBytes: 5 });
  const first = request('first'), second = request('second');
  const usage = makeEvent('r', 'transport', 'provider_usage', { requestId: 'first', inputTokens: 10, outputTokens: 2, costUsd: 0.1 });
  const complete = makeEvent('r', 'transport', 'observation_complete', { providerRequests: true, pmTools: true, nativeTools: true });
  const observations = observationsFromEvents([first, first, second, usage, complete]);
  assert.equal(observations.providerRequests, 2);
  assert.equal(observations.requestBytes, 40);
  assert.equal(observations.pmResultBytes, null);
  assert.deepEqual(observations.usageCoverage.inputTokens, { knownRequests: 1, totalRequests: 2, knownSubtotal: 10, complete: false });
  assert.equal(usageFromEvents([first, second, usage]).inputTokens, null);
  assert.equal(observationsFromEvents([first, usage]).requestBytes, null);
  assert.equal(observationsFromEvents([first, usage]).usageCoverage.inputTokens?.totalRequests, null);
});

test('untrusted claims do not manufacture zero counts, bytes, intervals or retained-context proof', () => {
  const claim = makeEvent('r', 'agent', 'observation_complete', { providerRequests: true, pmTools: true });
  const observations = observationsFromEvents([claim]);
  assert.equal(observations.providerRequests, null);
  assert.equal(observations.pmToolCalls, null);
  assert.equal(observations.requestBytes, null);
  assert.equal(observations.avoidableRepeatReads, null);
  assert.deepEqual(observations.intervals, []);
});

test('distinct canonical attempts sharing an original operation are counted, not erased as nesting', () => {
  const first = makeEvent('r', 'transport', 'pm_request', { requestNumber: 1 }, { operationId: 'same-original', toolName: 'pm_update_task' });
  const second = makeEvent('r', 'transport', 'pm_request', { requestNumber: 2 }, { operationId: 'same-original', toolName: 'pm_update_task' });
  const nested = makeEvent('r', 'transport', 'pm_tool_call', {}, { operationId: 'same-original', toolName: 'pm_update_task' });
  const complete = makeEvent('r', 'transport', 'observation_complete', { providerRequests: true, pmTools: true });
  assert.equal(observationsFromEvents([first, first, second, nested, complete]).pmToolCalls, 2);
  assert.equal(usageFromEvents([first, first, second, nested]).toolCalls, 2);
  const interval = makeEvent('r', 'transport', 'pm_response', { intervalKind: 'pm', clockId: 'broker:r', startedMonotonicMs: 10, endedMonotonicMs: 20 }, { operationId: 'same-original' });
  assert.equal(observationsFromEvents([interval, interval]).intervals.length, 1);
});
