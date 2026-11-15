import test from 'node:test';
import assert from 'node:assert/strict';
import type { BenchEvent } from '../schemas/types.ts';
import { summarizeCliObservations } from '../runners/cli-observations.ts';
import { renderCliObservationReport } from './cli-observations.ts';

function event(id: string, kind: string, value: unknown): BenchEvent {
  return { id, timestamp: '2026-11-14T00:00:00.000Z', runId: 'run', source: 'transport', type: 'cli_observation', sessionId: 'session', generationId: 'generation',
    data: { kind, value, collectionStatus: 'observed', messageId: 'input', productSource: { sourceHash: 'a'.repeat(64), cliSha256: 'b'.repeat(64), manifestVersion: '1' } } };
}

test('empty CLI report labels missing evidence as unknown and keeps authoritative dimensions separate', () => {
  const report = renderCliObservationReport(summarizeCliObservations([]));
  assert.match(report, /Collection events: 0; observed: 0; unavailable: 0/);
  assert.match(report, /CLI collection may not have reached an authenticated Session/);
  assert.match(report, /Observed subprocess-duration sum: unknown ms/);
  assert.match(report, /Product CLI projections only/);
  assert.match(report, /Independent task grades and broker wire\/model evidence remain authoritative/);
  assert.match(report, /No task-success, exact-prompt, model-read or billing conclusion/);
  assert.ok(!report.includes('cost USD | 0'));
});

test('report preserves original evidence IDs, unavailable failures, revision metadata and estimate semantics', () => {
  const turnContext = { version: 1, threadId: 'session', messageId: 'input', acceptedAt: '2026-11-14T00:00:00.000Z', pmReferences: [{ workspaceId: 'workspace', kind: 'issue', projectId: 'PRJ-1', id: 'ISS-1', revision: 'source-r7', availability: 'available', reason: null }] };
  const usage = event('usage-first', 'usage', { threadId: 'session', generationId: 'generation', reportedTurn: { inputTokens: 13 }, costUsd: 0 });
  const unavailable = event('context-failed', 'message-context', null); unavailable.data.collectionStatus = 'unavailable'; unavailable.data.error = 'Agent denied (HTTP 403)';
  const summary = summarizeCliObservations([
    event('session-source', 'session', { thread: { remoteId: 'session', revision: 4 } }),
    event('generation-source', 'generation', { generation: { id: 'generation', threadId: 'session', inputMessageId: 'input', messageId: 'assistant', status: 'completed', turnContext } }),
    event('context-source', 'message-context', { visibility: 'visible', turnContext }),
    usage, { ...usage, id: 'usage-repeated' }, unavailable,
  ]);
  const before = structuredClone(summary);
  const report = renderCliObservationReport(summary);
  assert.deepEqual(summary, before);
  for (const id of ['session-source', 'generation-source', 'context-source', 'usage-first', 'usage-repeated', 'context-failed']) assert.ok(report.includes(id));
  assert.ok(report.includes('a'.repeat(64))); assert.ok(report.includes('b'.repeat(64)));
  assert.match(report, /revision source-r7/);
  assert.match(report, /PM body\/truncation not projected/);
  assert.match(report, /unavailable \/ unavailable/);
  assert.match(report, /Agent denied \(HTTP 403\)/);
  assert.match(report, /Product estimated cost USD/);
  assert.match(report, /\| unknown \/ unknown \/ unknown \/ unknown \/ unknown \| 0 \| 13 \/ unknown/);
  assert.match(report, /Distinct generations are not summed/);
  assert.match(report, /repeated snapshots: 1/);
  assert.match(report, /generation status completed \(not a task grade\)/);
});

test('untrusted projection text cannot create HTML, extra table rows or reconstructed prompt content', () => {
  const malicious = event('event|<script>\nnext-row', 'message-context', { visibility: 'visible', turnContext: { version: 1, threadId: 'session', messageId: 'input', acceptedAt: '2026-11-14T00:00:00.000Z',
    body: 'PRIVATE-PM-BODY', prompt: 'PRIVATE-EXACT-PROMPT', truncated: false,
    pmReferences: [{ workspaceId: 'workspace', kind: 'issue', id: 'ISS-1', projectId: 'PRJ-1', revision: 'r1|<img>', availability: 'stale', reason: 'stale|<script>\nnew-row', body: 'PRIVATE-REFERENCE-BODY' }] } });
  const report = renderCliObservationReport(summarizeCliObservations([malicious]));
  assert.ok(!report.includes('<script>')); assert.ok(!report.includes('<img>'));
  assert.ok(report.includes('&lt;script&gt;'));
  assert.ok(report.includes('event\\|&lt;script&gt; next-row'));
  for (const privateContent of ['PRIVATE-PM-BODY', 'PRIVATE-EXACT-PROMPT', 'PRIVATE-REFERENCE-BODY']) assert.ok(!report.includes(privateContent));
  assert.match(report, /not actual Provider wire requests/);
});

test('timing report shows failed or unknown transport outcomes without declaring business outcome', () => {
  const timing: BenchEvent = { id: 'command-source', timestamp: '2026-11-14T00:00:00.000Z', runId: 'run', source: 'transport', type: 'cli_command_interval',
    data: { command: ['agent', 'message', 'send'], purpose: 'control', durationMs: 17, exitCode: null, outcome: 'unknown' } };
  const report = renderCliObservationReport(summarizeCliObservations([timing]));
  assert.match(report, /Observed subprocess-duration sum: 17 ms; observation-command subtotal: unknown ms; isolated process overhead: unknown/);
  assert.match(report, /command-source/);
  assert.match(report, /agent message send/);
  assert.match(report, /unknown \/ unknown/);
  assert.match(report, /including startup, authentication and service latency/);
});
