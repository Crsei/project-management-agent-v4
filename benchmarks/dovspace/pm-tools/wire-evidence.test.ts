import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { measureApplicationBaseline } from './application-baseline.ts';
import { observeBriefsInProviderRequest } from './wire-evidence.ts';

/** Parser test vectors only: constructing an envelope here is NOT an observed OMP/provider request or a benchmark success. */
test('request observer counts only actual tool-message text locations, never user prose or Host details', async () => {
  const application = await measureApplicationBaseline();
  const brief = application.measurements[0]!.brief;
  const result = { kind: 'task_brief', items: [], brief, sources: brief.sources.map(source => ({ kind: source.kind === 'work_item' ? 'task' : source.kind, workspaceId: source.workspaceId, projectId: source.projectId, entityId: source.entityId, title: source.title, revision: source.revision, truncated: brief.truncation.truncated })), nextCursor: null, truncated: brief.truncation.truncated };
  const literal = JSON.stringify({ operationId: randomUUID(), name: 'pm_task_brief', status: 'succeeded', result, error: null, workspaceId: brief.task.workspaceId, threadId: 'parser-vector', messageId: 'parser-vector', generationId: 'parser-vector', createdAt: '2026-11-13T00:00:00Z', finishedAt: '2026-11-13T00:00:01Z' });
  assert.deepEqual(observeBriefsInProviderRequest(JSON.stringify({ messages: [{ role: 'user', content: literal }], details: JSON.parse(literal) })), []);
  const request = JSON.stringify({ messages: [{ role: 'user', content: 'Read the current task' }, { role: 'tool', content: literal }], details: JSON.parse(literal) });
  const observations = observeBriefsInProviderRequest(request);
  assert.equal(observations.length, 1);
  assert.equal(observations[0]!.pointer, '/messages/1/content');
  assert.equal(observations[0]!.literal, literal);
  assert.equal(observations[0]!.requestUtf8Bytes, Buffer.byteLength(request, 'utf8'));
  assert.equal(observations[0]!.toolTextUtf8Bytes, Buffer.byteLength(literal, 'utf8'));
  assert.equal(observations[0]!.outerSources.occurrences, result.sources.length);
  assert.ok(observations[0]!.outerSources.repeatedOccurrences > 0);
  assert.equal(observations[0]!.measurement.tokens, null);
  const responsesInput = JSON.stringify({ input: [{ type: 'function_call_output', call_id: 'parser-vector', output: literal }] });
  assert.equal(observeBriefsInProviderRequest(responsesInput)[0]!.pointer, '/input/0/output');
  assert.deepEqual(observeBriefsInProviderRequest(JSON.stringify({ content: [{ type: 'text', text: literal }], details: JSON.parse(literal) })), [], 'Host content/details is not a provider request');
});

test('missing request/invalid operation results are not fabricated into source evidence', () => {
  assert.throws(() => observeBriefsInProviderRequest('null'), /JSON object/);
  assert.deepEqual(observeBriefsInProviderRequest(JSON.stringify({ messages: [{ role: 'tool', content: '{"result":{"sources":[{},{}]}}' }] })), []);
  assert.deepEqual(observeBriefsInProviderRequest(JSON.stringify({ messages: [{ role: 'tool', content: 'not JSON' }] })), []);
});
