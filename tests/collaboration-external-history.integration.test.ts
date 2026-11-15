import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { PmToolCallRecord, PmToolRequest } from '../packages/agent-contracts/src/pm-tools.ts';
import { CollaborationToolResultSchema } from '../packages/agent-contracts/src/pm-tool-collaboration.ts';
import { createLocalProjectFixture, localProjectCaseTimeout, type LocalProjectFixture } from './local-project-fixture.ts';
import { configureDocumentSource, configureDocumentSources, mutateDocumentSource, readSourceContent } from './document-sources-fixture.ts';
import { dashboardDatabaseUrl } from './dashboard-fixture.ts';

function input(f: LocalProjectFixture, name: string, args: unknown): PmToolRequest {
  return { operationId: randomUUID(), name, arguments: args, target: { workspaceId: f.workspaceId, projectId: null }, threadId: 'external-collaboration', messageId: randomUUID(), generationId: randomUUID() };
}
async function call(f: LocalProjectFixture, request: PmToolRequest) {
  const response = await f.request<PmToolCallRecord>(`/api/v1/workspaces/${f.workspaceId}/agent-tools/call`, { method: 'POST', body: request });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.status, 'succeeded', JSON.stringify(response.body));
  return CollaborationToolResultSchema.parse(response.body.result);
}

describe('T9 delegated external-document history retains current source authority', { skip: !dashboardDatabaseUrl, concurrency: 1 }, () => {
  it('returns exact endpoints, leaves a concurrent edit unread, and withholds retained tool payload after source unlink without any byte or watermark replay', { timeout: localProjectCaseTimeout }, async t => {
    const f = await createLocalProjectFixture({ signal: t.signal }); t.after(() => f.close());
    const root = join(f.parents[1], 'collaboration-source'); await mkdir(root);
    const first = '# Original external bytes\r\nA\r\n', middle = '# Exact controlled save\nB\n', newest = '# Newer concurrent bytes\nC\n';
    await writeFile(join(root, 'history.md'), first);
    const source = await configureDocumentSource(f, null, root, 0);
    const initial = await readSourceContent(f, source.sourceId, 'history.md');
    const saved = await mutateDocumentSource(f, source.sourceId, { operationId: randomUUID(), action: 'save', path: 'history.md', sourceRevision: source.revision, expectedRevision: initial.revision, content: middle });
    const target = { kind: 'external' as const, sourceId: source.sourceId, path: 'history.md' };
    const historyInput = input(f, 'pm_read_change_history', { target, includeRelated: true, cursor: null, head: null, limit: 10 });
    const seen = await call(f, historyInput); assert.equal(seen.result.type, 'history'); if (seen.result.type !== 'history') return;
    assert.equal(seen.result.page.pendingCount, 1);
    const change = seen.result.page.items[0]!; assert.equal(change.completeness, 'exact'); assert.equal(change.actorId, f.owner.id);
    const detailInput = input(f, 'pm_read_change_detail', { changeId: change.changeId, offset: 0, limit: 12000 });
    const detail = await call(f, detailInput); assert.equal(detail.result.type, 'change_detail'); if (detail.result.type !== 'change_detail') return;
    assert.equal(detail.result.before?.raw, first); assert.equal(detail.result.after?.raw, middle);
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM change_history_cursors WHERE actor_id=$1', [f.owner.id])).rows[0].n, 0);
    await mutateDocumentSource(f, source.sourceId, { operationId: randomUUID(), action: 'save', path: 'history.md', sourceRevision: source.revision, expectedRevision: saved.content!.revision, content: newest });
    const ack = await call(f, input(f, 'pm_acknowledge_changes', { target, through: seen.result.page.head, observationToken: seen.result.page.observationToken }));
    assert.equal(ack.result.type, 'acknowledgement'); if (ack.result.type !== 'acknowledgement') return;
    assert.equal(ack.result.acknowledgement.reviewedThrough, seen.result.page.head); assert.equal(ack.result.acknowledgement.pendingCount, 1);
    const comparison = await call(f, input(f, 'pm_compare_changes', { target, fromMode: 'reviewed', fromChangeId: null, toChangeId: null, through: null, offset: 0, limit: 12000 }));
    assert.equal(comparison.result.type, 'comparison'); if (comparison.result.type !== 'comparison') return;
    assert.equal(comparison.result.before?.raw, middle); assert.equal(comparison.result.after?.raw, newest);
    const before = (await f.pool.query('SELECT target_key,reviewed_through::text FROM change_history_cursors WHERE actor_id=$1 ORDER BY target_key', [f.owner.id])).rows;
    const observations = (await f.pool.query('SELECT count(*)::int AS n FROM change_history_observations')).rows[0].n;
    const readable = await f.request<PmToolCallRecord>(`/api/v1/workspaces/${f.workspaceId}/agent-tools/result`, { method: 'POST', body: historyInput });
    assert.equal(readable.status, 200);
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM change_history_observations')).rows[0].n, observations);
    await configureDocumentSources(f, null, [], 1);
    for (const request of [historyInput, detailInput]) {
      const removed = await f.request(`/api/v1/workspaces/${f.workspaceId}/agent-tools/result`, { method: 'POST', body: request });
      assert.notEqual(removed.status, 200); assert.equal(JSON.stringify(removed.body).includes(middle), false); assert.equal(JSON.stringify(removed.body).includes(root), false);
      assert.equal((await f.pool.query('SELECT status FROM pm_agent_tool_operations WHERE operation_id=$1', [request.operationId])).rows[0].status, 'succeeded', 'delivery denial never rewrites original execution fact');
    }
    const oldAck = await f.request<PmToolCallRecord>(`/api/v1/workspaces/${f.workspaceId}/agent-tools/call`, { method: 'POST', body: input(f, 'pm_acknowledge_changes', { target, through: seen.result.page.head, observationToken: seen.result.page.observationToken }) });
    assert.equal(oldAck.status, 200); assert.equal(oldAck.body.status, 'unknown');
    assert.deepEqual((await f.pool.query('SELECT target_key,reviewed_through::text FROM change_history_cursors WHERE actor_id=$1 ORDER BY target_key', [f.owner.id])).rows, before);
    assert.equal(await readFile(join(root, 'history.md'), 'utf8'), newest);
  });
});
