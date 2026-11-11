import test from 'node:test';
import assert from 'node:assert/strict';
import { TraceRedactor, hashValue, makeEvent, usageFromEvents } from './telemetry.ts';

test('trace redaction removes nested credentials and JSON-encoded tool payloads', () => {
  const redactor = new TraceRedactor(['explicit-paid-key']);
  const safe = redactor.value({ headers: { authorization: 'Bearer should-never-leak', cookie: 'pm_session=private' }, error: 'upstream rejected explicit-paid-key', output: JSON.stringify({ providerApiKey: 'hidden', detail: 'Bearer abcdefghijklmnop' }), url: 'postgres://user:pass@private/db' });
  const encoded = JSON.stringify(safe);
  for (const secret of ['should-never-leak', 'pm_session=private', 'explicit-paid-key', 'hidden', 'abcdefghijklmnop', 'user:pass']) assert.ok(!encoded.includes(secret));
  assert.ok(encoded.includes('[REDACTED]'));
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
