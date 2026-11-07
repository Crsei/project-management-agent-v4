import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, test } from 'node:test';
import type { WorkspaceRun } from '@agent-workspace/contracts/workspace';
import { getRun, listRuns, startExecution, stopExecution, withThreadExecution } from './engine.ts';
import { closeStore, writeRecord } from './store.ts';
import { RUN_NAMESPACE } from './resources.ts';
import { workspaceRoutes } from '../workspace.ts';

let directory: string;
const original = process.env.AGENT_WORKSPACE_DATA_DIR;
beforeEach(async () => { directory = await mkdtemp(path.join(tmpdir(), 'archived-execution-')); process.env.AGENT_WORKSPACE_DATA_DIR = directory; });
afterEach(async () => { await stopExecution(); closeStore(); if (original === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = original; await rm(directory, { recursive: true, force: true }); });
function historical(id: string, status: WorkspaceRun['status']): WorkspaceRun {
  return { id, threadId: 'old-thread', name: 'Historical resource run', kind: 'agent', status, input: 'Original frozen input', startedAt: '2026-01-01T00:00:00.000Z', steps: [{ id: 'step', name: 'Step', agentName: 'Original Agent', model: 'original-model', status: status === 'queued' ? 'pending' : status, output: 'Immutable observed evidence', sideEffects: 'unknown' }] };
}
test('old queued/running resource requests never restart or acquire a Provider; terminal evidence remains immutable', async () => {
  const completed = historical('completed', 'completed');
  for (const run of [historical('queued', 'queued'), historical('running', 'running'), completed]) writeRecord(RUN_NAMESPACE, run.id, run);
  await startExecution();
  assert.equal(getRun('queued')!.status, 'interrupted'); assert.equal(getRun('running')!.errorClass, 'session_cutover_required');
  assert.equal(getRun('running')!.steps[0]!.output, 'Immutable observed evidence');
  assert.deepEqual(getRun('completed'), completed);
  assert.equal(listRuns('old-thread').length, 3);
});
test('obsolete create/import/continue/fork/merge writes are absent rather than executable aliases', async () => {
  for (const endpoint of ['/workspace/import', '/workspace/runs', '/workspace/runs/old/continue', '/workspace/runs/old/fork', '/workspace/threads/old/merge']) {
    const response = await workspaceRoutes.request(`http://localhost${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 404, endpoint);
  }
  const put = await workspaceRoutes.request('http://localhost/workspace/threads/old', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' }); assert.equal(put.status, 404);
});
test('archival run reads retain the original evidence and cannot create a new Session', async () => {
  const run = historical('evidence', 'completed'); writeRecord(RUN_NAMESPACE, run.id, run);
  const response = await workspaceRoutes.request('http://localhost/workspace/runs/evidence');
  assert.equal(response.status, 200); assert.deepEqual((await response.json() as { run: WorkspaceRun }).run, run);
});
test('validated Chat lock serializes one Session but independent Sessions run concurrently', async () => {
  const held = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  const calls: string[] = [];
  const first = withThreadExecution('same', async () => { calls.push('first'); entered.resolve(); await held.promise; });
  await entered.promise;
  const second = withThreadExecution('same', async () => { calls.push('second'); });
  await withThreadExecution('different', async () => { calls.push('independent'); });
  assert.deepEqual(calls, ['first', 'independent']); held.resolve(); await Promise.all([first, second]);
  assert.deepEqual(calls, ['first', 'independent', 'second']);
});
test('cancellation before a queued Chat lock is acquired never dispatches its callback', async () => {
  const held = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  const first = withThreadExecution('same', async () => { entered.resolve(); await held.promise; }); await entered.promise;
  let dispatched = false; const controller = new AbortController();
  const queued = withThreadExecution('same', async () => { dispatched = true; }, controller.signal);
  controller.abort(new Error('cancelled-before-admission'));
  await assert.rejects(queued, /cancelled-before-admission/); held.resolve(); await first;
  assert.equal(dispatched, false);
});
