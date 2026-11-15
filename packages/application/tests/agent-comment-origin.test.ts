import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { agentCollaborationSourceSchema, taskCommentAgentOriginSchema } from '../../domain/src/task-comments.ts';
import { pmCollaborationSourceSchema, pmCommentAgentOriginSchema } from '../../agent-contracts/src/pm-tool-linkage.ts';
import { currentAgentCommentOrigin, withAgentCommentOrigin } from '../src/agent-comment-origin.ts';

const origin = {
  runId: 'run-readable-id', agentId: 'agent-readable-id', agentVersion: 2, delegationId: null,
  target: { workspaceId: '10000000-0000-4000-8000-000000000001', projectId: 'PRJ-001', taskId: 'TASK-001', taskRevision: 'a'.repeat(64) },
  operationId: '20000000-0000-4000-8000-000000000001', threadId: 'actual-session', generationId: 'actual-generation',
};

test('PM domain and independently built Agent wire projections have the same strict trusted origin contract', () => {
  assert.deepEqual(taskCommentAgentOriginSchema.parse(origin), pmCommentAgentOriginSchema.parse(origin));
  const source = { runId: origin.runId, agentId: origin.agentId, agentVersion: origin.agentVersion, delegationId: origin.delegationId, target: origin.target };
  assert.deepEqual(agentCollaborationSourceSchema.parse(source), pmCollaborationSourceSchema.parse(source));
  for (const schema of [taskCommentAgentOriginSchema, pmCommentAgentOriginSchema]) {
    assert.equal(schema.safeParse({ ...origin, sourceAgentId: 'browser-claim' }).success, false);
    assert.equal(schema.safeParse({ ...origin, actorId: randomUUID() }).success, false);
    assert.equal(schema.safeParse({ ...origin, target: { ...origin.target, taskRevision: 'old' } }).success, false);
    assert.equal(schema.safeParse({ ...origin, agentVersion: 0 }).success, false);
    assert.equal(schema.safeParse({ ...origin, delegationId: 'x'.repeat(129) }).success, false);
  }
});

test('trusted comment producer contexts remain isolated across concurrent requests and exceptions', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const second = { ...origin, runId: 'second-run', operationId: randomUUID() };
  const firstRequest = withAgentCommentOrigin(origin, async () => {
    assert.deepEqual(currentAgentCommentOrigin(), origin); entered.resolve();
    await release.promise;
    assert.deepEqual(currentAgentCommentOrigin(), origin);
  });
  await entered.promise;
  assert.equal(currentAgentCommentOrigin(), null);
  await withAgentCommentOrigin(second, async () => {
    assert.deepEqual(currentAgentCommentOrigin(), second);
    await Promise.resolve();
    assert.deepEqual(currentAgentCommentOrigin(), second);
  });
  release.resolve(); await firstRequest;
  await assert.rejects(withAgentCommentOrigin(origin, async () => { throw new Error('producer failure'); }), /producer failure/);
  assert.equal(currentAgentCommentOrigin(), null);
});
