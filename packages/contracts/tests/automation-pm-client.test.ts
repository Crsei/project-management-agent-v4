import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StudioClient } from '../src/automation-studio-client.ts';
import type { PmAutomationCandidate } from '../src/automation-pm.ts';

const requestId = '00000000-0000-4000-a000-000000000001';
const workspaceId = '00000000-0000-4000-a000-000000000002';
const executionId = '00000000-0000-4000-a000-000000000003';
const at = '2026-10-31T12:00:00Z';
const ref = { refId: 'task:TASK-001:r1', kind: 'task' as const, id: 'TASK-001', revision: 'r1', actorId: requestId, workspaceId, projectId: 'PRJ-001', label: 'Task source', url: null, updatedAt: at };
const candidate: PmAutomationCandidate = { id: 'source-derived', kind: 'task-comment', title: 'Review', rationale: 'Observed task evidence', sourceRefs: [ref], evidence: [{ sourceRefId: ref.refId, quote: 'Task source' }], status: 'pending', revision: 1, taskId: 'TASK-001', expectedRevision: 'r1', body: 'Human-approved note' };


test('PM apply never retries unknown writes and does not rotate the original request ID', async context => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls++;
    assert.deepEqual(JSON.parse(String(init?.body)), { requestId, expectedRevision: 1, previewToken: 'original-preview-token' });
    throw new TypeError('Connection lost after send');
  };
  await assert.rejects(new StudioClient(workspaceId).pmApplyCandidate(executionId, candidate.id, requestId, 1, 'original-preview-token'), /Connection lost/);
  assert.equal(calls, 1);
});

test('PM browser result and review responses reject unvalidated command/result escape objects', async context => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => Response.json({ requestId, httpStatus: 200, result: { command: 'arbitrary', succeeded: true } });
  await assert.rejects(new StudioClient(workspaceId).pmReceipt(requestId));
  await assert.rejects(new StudioClient(workspaceId).pmResult(executionId));
});

