import test from 'node:test';
import assert from 'node:assert/strict';
import type { BenchEvent, FixtureHandle, FixtureSnapshot } from '../schemas/types.ts';
import { makeEvent } from './telemetry.ts';
import { inspectCheckpoint } from './checkpoints.ts';

function evidence() {
  const fixture: FixtureHandle = { fixtureId: 'fixture', fixtureVersion: 'v', root: '/private', publicRoot: '/private/public', authorityRoot: '/private/authority', agentDataRoot: '/private/agent', workspaceId: 'workspace', actorId: 'actor', targets: { 'beacon-receipt': { key: 'beacon-receipt', workspaceId: 'workspace', projectId: 'beacon', entityId: 'TASK-1', revision: 'before', kind: 'work_item' } }, pm: { baseUrl: '', token: '' }, runtime: null, isolation: null };
  const before: FixtureSnapshot = { fixtureId: 'fixture', fixtureVersion: 'v', capturedAt: '', semanticHash: 'before', entities: [{ key: 'beacon-receipt', id: 'TASK-1', projectId: 'beacon', kind: 'work_item', revision: 'before', path: 'tasks/task.md', entity: { priority: 'medium', status: 'todo' }, raw: '' }], receipts: [], tables: {}, files: {}, publicFiles: {} };
  const after: FixtureSnapshot = structuredClone(before);
  after.entities[0]!.revision = 'committed-revision';
  after.entities[0]!.entity.priority = 'high';
  after.receipts.push({ operationId: 'original-operation', kind: 'native', targetId: 'TASK-1', revision: 'committed-revision', status: 'succeeded', result: { receipt: { operationId: 'original-operation' } } });
  after.publicFiles['artifacts/handoff.json'] = Buffer.from(JSON.stringify({ workspaceId: 'workspace', projectId: 'beacon', targetId: 'TASK-1', revision: 'before', operationId: 'original-operation' })).toString('base64');
  const lost: BenchEvent = makeEvent('r', 'transport', 'response_lost', { committed: true, targetId: 'TASK-1', revision: 'committed-revision', receiptIdentity: 'original-operation' }, { operationId: 'original-operation', sessionId: 'old-session' });
  return { fixture, before, after, lost };
}

test('lost response checkpoint requires actual authority plus matching original persisted identity', () => {
  const value = evidence();
  const checkpoint = inspectCheckpoint('L02', 'write', value.fixture, value.before, value.after, [value.lost]);
  assert.equal(checkpoint?.operationId, 'original-operation');
  assert.equal(checkpoint?.authorityVerified, true);
  value.after.receipts = [];
  assert.equal(inspectCheckpoint('L02', 'write', value.fixture, value.before, value.after, [value.lost]), null);
});

test('agent-authored response-loss markers cannot trigger trusted intervention', () => {
  const value = evidence();
  value.lost.source = 'agent';
  assert.equal(inspectCheckpoint('L02', 'write', value.fixture, value.before, value.after, [value.lost]), null);
});

test('unknown outcomes, substituted operation keys and unrelated receipts do not authorize checkpoint', () => {
  for (const mutation of ['unknown', 'replacement', 'other-target']) {
    const value = evidence();
    if (mutation === 'unknown') value.after.receipts[0]!.status = 'unknown';
    if (mutation === 'replacement') value.after.receipts[0]!.operationId = 'replacement-operation';
    if (mutation === 'other-target') value.after.receipts[0]!.targetId = 'TASK-2';
    assert.equal(inspectCheckpoint('L02', 'write', value.fixture, value.before, value.after, [value.lost]), null);
  }
});

test('self-report text mentioning a receipt is not an explicit matching handoff', () => {
  const value = evidence();
  value.after.publicFiles['artifacts/handoff.json'] = Buffer.from(JSON.stringify({ summary: 'workspace beacon TASK-1 before original-operation' })).toString('base64');
  assert.equal(inspectCheckpoint('L02', 'write', value.fixture, value.before, value.after, [value.lost]), null);
});
