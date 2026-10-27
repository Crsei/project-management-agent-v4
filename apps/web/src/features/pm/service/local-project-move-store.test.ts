import assert from 'node:assert/strict';
import test from 'node:test';
import type { FileRecord } from '../../../../../../packages/pm-schema/index.ts';
import { applyLocalMoveResult, createLocalMoveStore, type LocalMoveAttempt, type LocalMoveStorage } from './local-project-move-store.ts';

const record: FileRecord = { id: 'PRJ-001', path: 'project-roots/PRJ-001/core/projects/PRJ-001.md', revision: 'same-revision', raw: '# Project\n', entity: { schema: 'pm/v1', entity: 'project', id: 'PRJ-001', title: 'Project', body: '', blocked_by: [], related_to: [], labels: [], links: [], checklist: [], views: [] } };
const attempt: LocalMoveAttempt = { key: 'same-key', projectId: 'PRJ-001', operation: 'relocate', mode: 'rebind', directory: { mode: 'existing', path: '/authorized/moved-project' }, writersStopped: true, phase: 'sending', message: '' };

test('a refreshed rebind retains original location, acknowledgement, mode and key as unknown', () => {
  const values: Record<string, string> = {};
  const storage: LocalMoveStorage = { getItem: key => values[key] ?? null, setItem: (key, value) => { values[key] = value; } };
  const store = createLocalMoveStore('host:workspace:actor:PRJ-001', storage);
  assert.equal(store.update(() => ({ directory: attempt.directory, mode: 'rebind', writersStopped: true, attempt }), true), true);
  const restored = createLocalMoveStore('host:workspace:actor:PRJ-001', storage).getSnapshot();
  assert.equal(restored.attempt!.phase, 'unknown');
  assert.equal(restored.attempt!.key, attempt.key);
  assert.equal(restored.attempt!.mode, 'rebind');
  assert.equal(restored.attempt!.writersStopped, true);
  assert.deepEqual(restored.attempt!.directory, attempt.directory);
  assert.equal(createLocalMoveStore('other-host:workspace:actor:PRJ-001', storage).getSnapshot().attempt, undefined);
  assert.equal(createLocalMoveStore('host:workspace:other-actor:PRJ-001', storage).getSnapshot().attempt, undefined);
});

test('missing and pending move outcomes do not become success or authorize a replacement request', () => {
  for (const result of [{ status: 'not_found' as const }, { status: 'pending' as const, key: attempt.key, operation: 'relocate' as const, reason: 'storage_pending' as const }]) {
    const unknown = applyLocalMoveResult(attempt, result);
    assert.equal(unknown.phase, 'unknown');
    assert.equal(unknown.key, attempt.key);
    assert.deepEqual(unknown.directory, attempt.directory);
    assert.equal(unknown.mode, 'rebind');
  }
  const ready = { status: 'ready' as const, operation: 'relocate' as const, key: attempt.key, record, location: { projectId: record.id, kind: 'local' as const, storageId: 'same-storage', path: '/authorized/moved-project', status: 'available' as const } };
  assert.equal(applyLocalMoveResult(attempt, { ...ready, location: { ...ready.location, status: 'unavailable' } }).phase, 'unknown');
  assert.equal(applyLocalMoveResult(attempt, { ...ready, key: 'replacement-key' }).phase, 'unknown');
  assert.equal(applyLocalMoveResult(attempt, { ...ready, record: { ...record, id: 'PRJ-002' } }).phase, 'unknown');
  assert.equal(applyLocalMoveResult(attempt, ready).phase, 'ready');
});

test('corrupt or full browser storage never replaces an original uncertain storage operation', () => {
  let text = JSON.stringify({ writersStopped: true, directory: attempt.directory, attempt });
  let full = false;
  const storage: LocalMoveStorage = { getItem: () => text, setItem: (_key, value) => { if (full) throw new Error('quota'); text = value; } };
  const store = createLocalMoveStore('scope', storage);
  full = true;
  assert.equal(store.update(() => ({ writersStopped: false }), true), false);
  assert.equal(store.getSnapshot().attempt!.key, attempt.key);
  assert.equal(store.persistenceError(), true);
  text = '{broken';
  store.refresh();
  full = false;
  assert.equal(store.update(() => ({ writersStopped: false }), true), false);
  assert.equal(store.getSnapshot().attempt!.key, attempt.key);
  assert.equal(text, '{broken');
});
