import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TaskBrief } from '../../agent-contracts/src/task-brief.ts';
import type { TaskCodeDelivery } from '../../contracts/src/task-code-delivery.ts';
import type { WorkflowRun } from '../../contracts/src/task-workflow.ts';
import { deriveTaskExecutionBrief, type ExecutionBriefObservation } from '../src/task-execution-brief.ts';

function fixture(): ExecutionBriefObservation {
  const revision = 'a'.repeat(64), head = 'b'.repeat(40), at = '2026-11-12T00:00:00.000Z';
  const scope = { workspaceId: '11111111-1111-4111-8111-111111111111', projectId: 'PRJ-001', taskId: 'TASK-001' };
  const currentTask: TaskBrief = { schemaVersion: 1, stage: 'recovery', generatedAt: at,
    task: { ...scope, revision, title: 'Current requirement', body: 'Acceptance: use the current version', bodyOffset: 0, bodyLength: 40, nextBodyOffset: null },
    goals: [], acceptanceCriteria: [], constraints: [], nonGoals: [], relations: [], guidance: [], sources: [], gaps: [],
    truncation: { truncated: false, body: false, statements: false, relations: false, message: null }, dispatchable: true, authorityNotice: 'PM authority' };
  const delivery: TaskCodeDelivery = { ...scope, id: 'delivery-id', baseBranch: 'main', taskRevision: revision, title: 'Original requirement', description: 'Original immutable body',
    createdAt: at, updatedAt: at, version: 7, step: 'pr', threadId: 'new-session', previousThreadIds: ['old-session'], head,
    git: { root: '/repo', directory: '/owned-tree', directoryIdentity: '1:2', commonDirectory: '/repo/.git', remote: 'https://github.com/o/r.git', owner: 'o', repo: 'r', baseBranch: 'main', baseSha: 'c'.repeat(40), branch: 'codex/task' },
    test: { taskRevision: revision, head: 'c'.repeat(40), command: 'node --test', fingerprint: 'tested-content', passed: true, exitCode: 0, outputDigest: 'digest', at },
    pr: { number: 1, url: 'https://github.com/o/r/pull/1' }, feedback: { head, taskRevision: revision, fingerprint: 'clean-head', observedAt: at, state: 'open', draft: true,
      checks: [{ name: 'test', status: 'completed', conclusion: 'success' }], reviews: [{ id: 1, author: 'reviewer', state: 'APPROVED', commit: head, body: 'Reviewed' }] } };
  return { delivery, currentTask, workflow: null, tree: { head, fingerprint: 'clean-head', files: [], diff: '' }, testCoverageFingerprint: 'tested-content', generation: null, observedAt: at };
}
test('committed unchanged content retains test coverage; CI and Review bind exact revision, HEAD and fingerprint', () => {
  const input = fixture(), brief = deriveTaskExecutionBrief(input);
  assert.deepEqual(brief.evidence.map(evidence => evidence.status), ['passed', 'passed', 'passed']);
  assert.equal(brief.execution.recordedHead, input.delivery.head);
  assert.deepEqual(brief.execution.pullRequest, input.delivery.pr);
  input.tree!.fingerprint = 'edited'; input.tree!.files = ['src/changed.ts']; input.testCoverageFingerprint = 'edited-test-content';
  assert.deepEqual(deriveTaskExecutionBrief(input).evidence.map(evidence => evidence.status), ['stale', 'stale', 'stale']);
});
test('new PM requirement invalidates old verification without rebinding the original task snapshot', () => {
  const input = fixture(); input.currentTask.task.revision = 'd'.repeat(64);
  const brief = deriveTaskExecutionBrief(input);
  assert.equal(brief.taskVersion.changed, true);
  assert.equal(brief.originalTask.body, 'Original immutable body');
  assert.equal(brief.originalTask.revision, input.delivery.taskRevision);
  assert.deepEqual(brief.evidence.map(evidence => evidence.status), ['stale', 'stale', 'stale']);
  assert.match(brief.nextSteps.join('\n'), /重新规划/);
});
test('unreadable Git and legacy evidence never inherit a previous passed claim', () => {
  const input = fixture(); input.tree = null;
  assert.deepEqual(deriveTaskExecutionBrief(input).evidence.map(evidence => evidence.status), ['unknown', 'unknown', 'unknown']);
  input.tree = fixture().tree; delete input.delivery.test!.taskRevision; delete input.delivery.feedback!.fingerprint;
  assert.deepEqual(deriveTaskExecutionBrief(input).evidence.map(evidence => evidence.status), ['unknown', 'unknown', 'unknown']);
});
test('unknown push identity, HEAD, fingerprint and next step survive every pure read without replay or mutation', () => {
  const input = fixture(); input.delivery.pending = { action: 'push', at: input.observedAt, head: input.delivery.head!, fingerprint: 'clean-head' };
  const original = structuredClone(input);
  for (let index = 0; index < 3; index++) {
    const brief = deriveTaskExecutionBrief(input), push = brief.operations.find(operation => operation.action === 'push')!;
    assert.equal(push.identity, `delivery-id:push:${input.observedAt}`); assert.equal(push.state, 'unknown');
    assert.equal(push.head, input.delivery.head); assert.equal(push.fingerprint, 'clean-head'); assert.match(push.nextStep, /不要再次 push/);
  }
  assert.deepEqual(input, original);
});
test('generation identity does not prove process termination and sent input history is separate from fresh PM content', () => {
  const input = fixture(); input.delivery.generationId = 'original-generation'; input.delivery.generationKey = 'original-key'; input.delivery.generationStatus = 'completed';
  input.sentInputs = [{ sessionId: 'old-session', messageId: 'actual-input', generationId: 'original-generation', status: 'generation_input', stage: 'development', taskRevision: input.delivery.taskRevision,
    sentAt: input.observedAt, text: 'Historical exact sent body', sources: [] }];
  const brief = deriveTaskExecutionBrief(input);
  assert.equal(brief.execution.generation?.status, 'unknown');
  assert.equal(brief.operations.find(operation => operation.action === 'generation')?.state, 'unknown');
  assert.equal(brief.history.sentInputs[0]!.text, 'Historical exact sent body');
  assert.notEqual(brief.currentTask.task.body, brief.history.sentInputs[0]!.text);
});
test('required CI names and same-HEAD latest reviews are not replaced by unrelated green checks or old approval', () => {
  const input = fixture();
  input.workflow = { id: 'delivery-id', version: 1, status: 'waiting', current: 'ci', input: { taskRevision: input.delivery.taskRevision, definitionId: 'template', definitionVersion: 1 },
    graph: { nodes: [{ kind: 'ci', config: { requiredChecks: ['required-test'] } }] } } as unknown as WorkflowRun;
  input.delivery.feedback!.reviews.push({ id: 2, author: 'reviewer', state: 'CHANGES_REQUESTED', commit: input.delivery.head!, body: 'Fix it' });
  const brief = deriveTaskExecutionBrief(input);
  assert.equal(brief.evidence.find(evidence => evidence.kind === 'ci')?.status, 'unknown');
  assert.equal(brief.evidence.find(evidence => evidence.kind === 'review')?.status, 'failed');
  input.delivery.feedback!.reviews = [{ id: 3, author: 'reviewer', state: 'APPROVED', commit: 'old-head', body: 'Old' }];
  assert.equal(deriveTaskExecutionBrief(input).evidence.find(evidence => evidence.kind === 'review')?.status, 'stale');
});
