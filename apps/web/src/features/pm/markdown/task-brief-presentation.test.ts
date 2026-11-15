import test from 'node:test';
import assert from 'node:assert/strict';
import type { TaskBriefSourceRef } from '../../../../../../packages/agent-contracts/src/task-brief.ts';
import { guidanceReadFailure, guidanceSnapshot, guidanceSourceMatches, guidanceSourceOffset, knowledgeProjectScope } from './task-brief-presentation.ts';

const source: TaskBriefSourceRef = { workspaceId: '11111111-1111-4111-8111-111111111111', projectId: 'PRJ-1', entityId: 'DOC-1', kind: 'document', revision: 'a'.repeat(64), title: 'Readable source', location: { type: 'body', offset: 120, length: 40 } };
const file = { id: source.entityId, revision: source.revision, entity: { entity: 'document', project: source.projectId } };

test('authorization failures clear sensitive snapshots rather than preserving stale source text', () => {
  for (const status of [401, 403, 404]) {
    assert.equal(guidanceReadFailure({ status }), 'access');
    assert.deepEqual(guidanceSnapshot({ text: 'private task' }, { status }, true), { data: undefined, stale: false, failure: 'access' });
  }
});

test('revision and directory conflicts require a fresh read, never reuse the previous successful result', () => {
  for (const status of [409, 412]) {
    const view = guidanceSnapshot({ revision: 'old' }, { status }, true);
    assert.equal(view.data, undefined);
    assert.equal(view.failure, 'conflict');
  }
});

test('disconnected and unavailable reads retain an explicitly stale snapshot, not an empty success', () => {
  const prior = { taskId: 'TASK-1', text: 'last authorized snapshot' };
  for (const [error, online] of [[new TypeError('Failed to fetch'), true], [{ status: 503 }, true], [null, false]] as const) {
    const view = guidanceSnapshot(prior, error, online);
    assert.equal(view.data, prior);
    assert.equal(view.stale, true);
  }
  assert.deepEqual(guidanceSnapshot(undefined, { status: 503 }, true), { data: undefined, stale: false, failure: 'unavailable' });
  assert.deepEqual(guidanceSnapshot(prior, null, true), { data: prior, stale: false, failure: null });
  assert.deepEqual(guidanceSnapshot(prior, null, true, true), { data: prior, stale: true, failure: null }, 'Reconnection cannot freshen a snapshot before a successful re-read');
});

test('knowledge defaults to the current project, not every authorized project', () => {
  assert.deepEqual(knowledgeProjectScope('PRJ-1', [], ['PRJ-1', 'PRJ-2', 'PRJ-3']), ['PRJ-1']);
  assert.deepEqual(knowledgeProjectScope('PRJ-1', ['PRJ-2', 'PRJ-2', 'PRJ-hidden'], ['PRJ-1', 'PRJ-2', 'PRJ-3']), ['PRJ-1', 'PRJ-2']);
  assert.deepEqual(knowledgeProjectScope('PRJ-1', ['PRJ-2'], ['PRJ-1']), ['PRJ-1'], 'Revocation drops a previously selected cross-project scope');
});

test('source reading requires the exact entity, project, kind and revision', () => {
  assert.equal(guidanceSourceMatches(source, file), true);
  assert.equal(guidanceSourceMatches(source, { ...file, revision: 'b'.repeat(64) }), false);
  assert.equal(guidanceSourceMatches(source, { ...file, id: 'DOC-2' }), false);
  assert.equal(guidanceSourceMatches(source, { ...file, entity: { entity: 'document', project: 'PRJ-2' } }), false);
  assert.equal(guidanceSourceMatches(source, { ...file, entity: { entity: 'requirement', project: 'PRJ-1' } }), false);
  assert.equal(guidanceSourceMatches({ ...source, entityId: 'PRJ-1', kind: 'project' }, { id: 'PRJ-1', revision: source.revision, entity: { entity: 'project' } }), true);
});

test('source location uses body coordinates and never starts beyond the readable body', () => {
  assert.equal(guidanceSourceOffset(source, 1000), 120);
  assert.equal(guidanceSourceOffset(source, 80), 80);
  assert.equal(guidanceSourceOffset({ ...source, location: { type: 'field', path: 'status' } }, 1000), 0);
});
