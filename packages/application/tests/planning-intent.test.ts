import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { DomainError } from '../../domain/src/core.ts';
import type { Capability, Command, Entity, EntityKind } from '../../domain/src/core.ts';
import { planningCommands } from '../src/planning.ts';
import { intentCommands } from '../src/intent.ts';
import type { CommandContext } from '../src/ports.ts';
import { entityFromRow } from '../src/kernel.ts';
import { assertSchedule } from '../../domain/src/planning.ts';

// These tests exercise application/domain guards with an in-memory context.
// They do not prove SQL constraints, workspace locking, receipts or rollback.
class Fixture {
  workspaceId = randomUUID();
  actorId = randomUUID();
  entities = new Map<string, Entity>();
  events: { type: string; id: string; payload: unknown }[] = [];
  capabilities = new Set<Capability>(['domain.read', 'intent.propose', 'intent.decide', 'planning.edit', 'planning.lifecycle', 'workitem.cancel_reopen', 'workitem.complete']);
  members = new Set<string>([this.actorId]);

  add(kind: EntityKind, data: Record<string, any>, projectId: string | null = null): Entity {
    const entity: Entity = { id: randomUUID(), workspaceId: this.workspaceId, projectId, kind, data, version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), createdBy: this.actorId };
    this.entities.set(entity.id, entity);
    return entity;
  }

  async run(commandType: string, payload: Record<string, unknown> = {}, target?: Entity, projectId?: string): Promise<any> {
    const definition = { ...planningCommands, ...intentCommands }[commandType]!;
    const command: Command = { commandId: randomUUID(), commandType, payload: definition.payload.parse(payload) as Record<string, unknown>, expectedVersions: Object.fromEntries([...this.entities].map(([id, entity]) => [id, entity.version])) };
    if (target) command.targetId = target.id;
    if (projectId) command.projectId = projectId;
    const checked = new Set<string>();
    const fixture = this;
    const ctx: CommandContext = {
      actor: { id: this.actorId, email: 'unit@example.test', name: 'Unit' }, workspaceId: this.workspaceId, command,
      sql: { async query<T>(_sql: string, values?: unknown[]) { return { rows: (fixture.members.has(values?.[1] as string) ? [{ user_id: values?.[1] }] : []) as T[], rowCount: 1 }; } },
      async require(capability) { if (!fixture.capabilities.has(capability)) throw new DomainError('forbidden', 'forbidden', 403); },
      async requireSelf() { await ctx.require('domain.read'); },
      async get(id, kind) { const entity = fixture.entities.get(id); if (!entity || (kind && entity.kind !== kind)) throw new DomainError('not_found', 'not_found', 404); return entity; },
      async list(kind, scope) { return [...fixture.entities.values()].filter(entity => entity.kind === kind && (scope === undefined || entity.projectId === scope)); },
      async insert(kind, data, scope) { return fixture.add(kind, data, scope ?? null); },
      async update(entity, data) { assert.ok(checked.has(entity.id), 'Every modified aggregate must check its version'); const updated = { ...entity, data, version: entity.version + 1 }; fixture.entities.set(entity.id, updated); return updated; },
      checkVersion(entity) { assert.equal(command.expectedVersions?.[entity.id], entity.version); checked.add(entity.id); },
      async emit(type, entity, eventPayload) { fixture.events.push({ type, id: entity.id, payload: eventPayload }); },
    };
    return definition.handler(ctx);
  }

  async project(): Promise<Entity> {
    const entity = await this.run('CreateProject', { name: 'Project', goal: 'Deliver', ownerId: this.actorId, completionCriteria: ['Accepted'] });
    return this.run('ActivateProject', {}, entity);
  }

  async work(project: Entity): Promise<Entity> {
    return this.run('CreateWorkItem', { title: 'Task', description: 'Scope', acceptanceCriteria: [{ id: randomUUID(), text: 'Works' }], assigneeId: this.actorId }, undefined, project.id);
  }

  current(entity: Entity): Entity { return this.entities.get(entity.id)!; }
}

function rejectsCode(operation: Promise<unknown>, code: string): Promise<void> {
  return assert.rejects(operation, (error: any) => error.code === code);
}

function reviewed(f: Fixture, item: Entity): { item: Entity; submission: Entity; review: Entity } {
  const artifactId = randomUUID();
  const submission = f.add('submission', { workItemId: item.id, contentRevision: item.data.contentRevision, workScopeSnapshot: { workItemId: item.id, contentRevision: item.data.contentRevision, title: item.data.title, description: item.data.description, acceptanceCriteria: structuredClone(item.data.acceptanceCriteria) }, artifactVersionIds: [artifactId], evidenceIds: [] }, item.projectId);
  const review = f.add('review', { workItemId: item.id, contentRevision: item.data.contentRevision, submissionId: submission.id, verdict: 'passed', reviewerId: f.actorId, criterionResults: item.data.acceptanceCriteria.map((criterion: any) => ({ criterionId: criterion.id, result: 'pass', basisRefs: [artifactId], explanation: 'Inspected result' })) }, item.projectId);
  const updated = { ...item, data: { ...item.data, status: 'in_review', currentSubmissionId: submission.id } };
  f.entities.set(item.id, updated);
  return { item: updated, submission, review };
}

test('legacy work-item schedules map to null and domain dates reject rollover', () => {
  const row = { id: randomUUID(), workspace_id: randomUUID(), project_id: randomUUID(), kind: 'work_item' as const, version: 1, data: { title: 'Legacy item' }, created_at: new Date(), updated_at: new Date(), created_by: randomUUID() };
  const mapped = entityFromRow(row);
  assert.equal(mapped.data.startDate, null);
  assert.equal(mapped.data.dueDate, null);
  assert.deepEqual(row.data, { title: 'Legacy item' });
  assertSchedule('2028-02-29', '2028-02-29');
  assertSchedule(null, '2028-02-29');
  assertSchedule('2028-02-29', null);
  for (const value of ['2027-02-29', '2028-04-31', '2028-02-29T00:00:00Z', '', 2028]) {
    assert.throws(() => assertSchedule(value, null), (error: unknown) => error instanceof DomainError && error.code === 'invalid_schedule_date');
  }
  assert.throws(() => assertSchedule('2028-03-01', '2028-02-29'), (error: unknown) => error instanceof DomainError && error.code === 'invalid_schedule_range');
});

test('task command schemas preserve explicit creation metadata and both creation commands share calendar and type rules', async () => {
  const fields = {
    title: 'Complete creation', description: 'Markdown description', acceptanceCriteria: [],
    startDate: '2028-02-29', dueDate: '2028-03-01', labels: ['release', '标签'], kind: 'subtask',
    parentId: 'TASK-42', estimatePoints: 0, location: '  Room 12  ',
  };
  for (const commandType of ['CreateWorkItem', 'CreateWorkItemFromIntent']) {
    const payload = commandType === 'CreateWorkItem' ? fields : { ...fields, intentId: randomUUID(), acceptedRevision: 1, decisionId: randomUUID() };
    const parsed = planningCommands[commandType]!.payload.parse(payload) as Record<string, unknown>;
    assert.equal(parsed.startDate, fields.startDate);
    assert.equal(parsed.dueDate, fields.dueDate);
    assert.deepEqual(parsed.labels, fields.labels);
    assert.equal(parsed.kind, 'subtask');
    assert.equal(parsed.parentId, 'TASK-42');
    assert.equal(parsed.estimatePoints, 0);
    assert.equal(parsed.location, 'Room 12');
    for (const invalid of [{ startDate: '2027-02-29' }, { dueDate: '2028-04-31' }, { labels: [0] }, { estimatePoints: '8' }, { estimatePoints: -1 }, { estimatePoints: 1_000_001 }, { location: 'x'.repeat(1001) }, { parentId: 'not-a-task-id' }, { kind: 'unknown' }]) {
      assert.equal(planningCommands[commandType]!.payload.safeParse({ ...payload, ...invalid }).success, false);
    }
  }
  const f = new Fixture();
  const project = await f.project();
  const created = await f.run('CreateWorkItem', { title: 'Scheduled immediately', description: '', acceptanceCriteria: [], startDate: fields.startDate, dueDate: fields.dueDate, labels: fields.labels, estimatePoints: 0, location: 'Room' }, undefined, project.id);
  assert.equal(created.data.startDate, fields.startDate);
  assert.equal(created.data.dueDate, fields.dueDate);
  assert.deepEqual(created.data.labels, fields.labels);
  assert.equal(created.data.estimatePoints, 0);
});

test('SC-01: conversation and proposed intent create no work or execution', async () => {
  const f = new Fixture();
  const conversation = await f.run('CreateConversation', { title: 'Discussion' });
  const appended = await f.run('AppendMessage', { content: 'Idea' }, conversation);
  const intent = await f.run('ProposeIntent', { summary: 'Idea', goal: 'Discuss', conversationId: conversation.id, sourceMessageRefs: [{ messageId: appended.message.id, contentVersion: 1 }] });
  assert.equal(intent.projectId, null);
  assert.equal(intent.data.status, 'proposed');
  assert.equal([...f.entities.values()].filter(item => item.kind === 'work_item').length, 0);
  assert.deepEqual(f.events.map(item => item.type), ['ConversationCreated', 'MessageAppended', 'IntentProposed']);
});

test('SC-02: accepted revision can explicitly convert once', async () => {
  const f = new Fixture();
  const project = await f.project();
  const intent = await f.run('ProposeIntent', { summary: 'Idea', goal: 'Goal' });
  const payload = { title: 'Task', description: 'Scope', acceptanceCriteria: [], intentId: intent.id, acceptedRevision: 1, decisionId: randomUUID() };
  await rejectsCode(f.run('CreateWorkItemFromIntent', payload, undefined, project.id), 'accepted_intent_required');
  const accepted = await f.run('AcceptIntent', { revision: 1, reason: 'Proceed' }, intent);
  payload.decisionId = accepted.decision.id;
  const item = await f.run('CreateWorkItemFromIntent', payload, undefined, project.id);
  assert.deepEqual(item.data.originIntentRef, { intentId: intent.id, acceptedRevision: 1, decisionId: accepted.decision.id });
  await rejectsCode(f.run('CreateWorkItemFromIntent', payload, undefined, project.id), 'intent_already_converted');
  await rejectsCode(f.run('ReviseIntent', { revision: 1, summary: 'Changed', goal: 'Changed' }, f.current(intent)), 'invalid_state');
});

test('Intent decisions reject stale revisions and generic decisions cannot accept', async () => {
  const f = new Fixture();
  const intent = await f.run('ProposeIntent', { summary: 'Idea', goal: 'Goal' });
  const revised = await f.run('ReviseIntent', { summary: 'New idea', goal: 'Goal', revision: 1 }, intent);
  await rejectsCode(f.run('AcceptIntent', { revision: 1, reason: 'Proceed' }, revised), 'intent_revision_mismatch');
  assert.equal(intentCommands.RecordDecision!.payload.safeParse({ subjectRef: { kind: 'intent', id: intent.id }, decisionType: 'accept_intent', reason: 'Bypass' }).success, false);
  const note = await f.run('RecordDecision', { subjectRef: { kind: 'intent', id: intent.id }, decisionType: 'note', reason: 'Discuss further' });
  assert.equal(f.current(intent).data.status, 'proposed');
  assert.equal(note.data.actorId, f.actorId);
});

test('withdrawal by a different proposer requires current decision capability', async () => {
  const f = new Fixture();
  const intent = await f.run('ProposeIntent', { summary: 'Idea', goal: 'Goal' });
  f.actorId = randomUUID();
  f.capabilities.delete('intent.decide');
  await rejectsCode(f.run('WithdrawIntent', { reason: 'Withdraw' }, intent), 'forbidden');
  assert.equal(f.current(intent).data.status, 'proposed');
});

test('SC-11: dependency state, self edge, cycle and cross-project edge guards', async () => {
  const f = new Fixture();
  const project = await f.project();
  const a = await f.work(project);
  const b = await f.work(project);
  const dependent = await f.run('AddDependency', { prerequisiteId: b.id }, a);
  await rejectsCode(f.run('AddDependency', { prerequisiteId: a.id }, b), 'dependency_cycle');
  await rejectsCode(f.run('AddDependency', { prerequisiteId: b.id }, dependent), 'duplicate_dependency');
  await rejectsCode(f.run('AddDependency', { prerequisiteId: b.id }, b), 'dependency_self_reference');
  const ready = await f.run('ReadyWorkItem', {}, dependent);
  await rejectsCode(f.run('StartWorkItem', {}, ready), 'prerequisite_not_done');
  await f.run('CancelWorkItem', { reason: 'Cancelled' }, b);
  await rejectsCode(f.run('StartWorkItem', {}, ready), 'prerequisite_not_done');
  const other = await f.work(await f.project());
  await rejectsCode(f.run('AddDependency', { prerequisiteId: other.id }, ready), 'project_mismatch');
});

test('SC-07: changing current scope invalidates current submission and increments contentRevision', async () => {
  const f = new Fixture();
  const project = await f.project();
  const records = reviewed(f, await f.work(project));
  const changed = await f.run('UpdateWorkItemContent', { title: 'New task', description: 'New scope', acceptanceCriteria: records.item.data.acceptanceCriteria }, records.item);
  assert.equal(changed.data.contentRevision, 2);
  assert.equal(changed.data.currentSubmissionId, null);
  assert.equal(changed.data.status, 'in_progress');
  assert.equal(f.current(records.submission).data.contentRevision, 1);
  assert.equal(f.current(records.review).data.contentRevision, 1);
  await rejectsCode(f.run('CompleteWorkItem', { submissionId: records.submission.id, reviewId: records.review.id }, changed), 'invalid_state');
});

test('SC-06/16: explicit complete requires current passed review, preserves history on reopen', async () => {
  const f = new Fixture();
  const project = await f.project();
  const records = reviewed(f, await f.work(project));
  const done = await f.run('CompleteWorkItem', { submissionId: records.submission.id, reviewId: records.review.id }, records.item);
  assert.equal(done.data.status, 'done');
  assert.deepEqual(done.data.completionRecord, { reviewId: records.review.id, submissionId: records.submission.id, contentRevision: 1, completedBy: f.actorId, completedAt: done.data.completionRecord.completedAt });
  const reopened = await f.run('ReopenWorkItem', { reason: 'New requirements' }, done);
  assert.equal(reopened.data.status, 'draft');
  assert.equal(reopened.data.currentSubmissionId, null);
  assert.deepEqual(reopened.data.completionHistory, [done.data.completionRecord]);
  assert.ok(f.entities.has(records.review.id));
});

test('shared completion input permits core completion without weakening SQL reviewed completion', async () => {
  const definition = planningCommands.CompleteWorkItem!;
  assert.deepEqual(definition.payload.parse({}), {});
  const f = new Fixture();
  const { item, submission, review } = reviewed(f, await f.work(await f.project()));
  for (const payload of [{}, { submissionId: submission.id }, { reviewId: review.id }]) {
    await rejectsCode(f.run('CompleteWorkItem', payload, item), 'validation_failed');
    assert.equal(f.current(item).data.status, 'in_review');
  }
  assert.equal(f.events.some(event => event.type === 'WorkItemCompleted'), false);
});

test('SC-06/18: stale, incomplete or unbound review cannot complete', async () => {
  for (const invalid of ['revision', 'criterion', 'submission', 'basis', 'snapshot', 'verdict']) {
    const f = new Fixture();
    const { item, submission, review } = reviewed(f, await f.work(await f.project()));
    if (invalid === 'revision') review.data.contentRevision = 0;
    if (invalid === 'criterion') review.data.criterionResults = [];
    if (invalid === 'submission') review.data.submissionId = randomUUID();
    if (invalid === 'basis') review.data.criterionResults[0].basisRefs = [randomUUID()];
    if (invalid === 'snapshot') submission.data.workScopeSnapshot.description = 'Other scope';
    if (invalid === 'verdict') review.data.verdict = 'changes_requested';
    await assert.rejects(f.run('CompleteWorkItem', { submissionId: submission.id, reviewId: review.id }, item), DomainError);
    assert.equal(f.current(item).data.status, 'in_review');
    assert.equal(f.events.some(event => event.type === 'WorkItemCompleted'), false);
  }
});

test('completion rechecks blockers and dependencies after review', async () => {
  const f = new Fixture();
  const records = reviewed(f, await f.work(await f.project()));
  const blocked = await f.run('SetWorkItemBlockers', { manualBlockReasons: ['Waiting'] }, records.item);
  await rejectsCode(f.run('CompleteWorkItem', { submissionId: records.submission.id, reviewId: records.review.id }, blocked), 'work_item_blocked');
  const clear = await f.run('SetWorkItemBlockers', { manualBlockReasons: [] }, blocked);
  const prerequisite = await f.work(f.entities.get(clear.projectId!)!);
  const dependent = await f.run('AddDependency', { prerequisiteId: prerequisite.id }, clear);
  await rejectsCode(f.run('CompleteWorkItem', { submissionId: records.submission.id, reviewId: records.review.id }, dependent), 'prerequisite_not_done');
});

test('SC-14: current capability and workspace-member checks prevent writes', async () => {
  const f = new Fixture();
  await rejectsCode(f.run('CreateProject', { name: 'Other', goal: 'Goal', ownerId: randomUUID(), completionCriteria: ['Accepted'] }), 'workspace_member_required');
  const records = reviewed(f, await f.work(await f.project()));
  f.capabilities.delete('workitem.complete');
  f.capabilities.add('access.manage');
  await rejectsCode(f.run('CompleteWorkItem', { submissionId: records.submission.id, reviewId: records.review.id }, records.item), 'forbidden');
  assert.equal(f.events.some(item => item.type === 'WorkItemCompleted'), false);
});

test('SC-17: achieved milestone blocks reopening members; unassignment enables cancellation', async () => {
  const f = new Fixture();
  const project = await f.project();
  const milestone = await f.run('CreateMilestone', { title: 'M1', criteria: ['Inspected'] }, undefined, project.id);
  const item = await f.run('AssignMilestone', { milestoneId: milestone.id }, await f.work(project));
  await rejectsCode(f.run('CancelMilestone', { reason: 'Stop' }, milestone), 'milestone_has_members');
  const cancelled = await f.run('CancelWorkItem', { reason: 'Stop' }, item);
  await rejectsCode(f.run('AchieveMilestone', { reason: 'Met', criteriaChecks: [{ criterionIndex: 0, explanation: 'Observed' }] }, milestone), 'milestone_members_not_done');
  const detached = await f.run('UnassignMilestone', { milestoneId: milestone.id }, cancelled);
  assert.equal(detached.data.status, 'cancelled');
  assert.equal(detached.data.contentRevision, 1);
  await f.run('CancelMilestone', { reason: 'Stop' }, milestone);
  const completed = await f.run('CompleteProject', { reason: 'Confirmed', criteriaChecks: [{ criterionIndex: 0, explanation: 'Confirmed' }] }, project);
  assert.equal(completed.data.status, 'completed');
});

test('milestone independent criteria and achieved-member reopen guards', async () => {
  const f = new Fixture();
  const project = await f.project();
  const milestone = await f.run('CreateMilestone', { title: 'M1', criteria: ['Inspected'] }, undefined, project.id);
  const attached = await f.run('AssignMilestone', { milestoneId: milestone.id }, await f.work(project));
  const records = reviewed(f, attached);
  const done = await f.run('CompleteWorkItem', { submissionId: records.submission.id, reviewId: records.review.id }, records.item);
  const achieved = await f.run('AchieveMilestone', { reason: 'Met', criteriaChecks: [{ criterionIndex: 0, explanation: 'Observed' }] }, milestone);
  await rejectsCode(f.run('ReopenWorkItem', { reason: 'More work' }, done), 'invalid_state');
  await rejectsCode(f.run('UnassignMilestone', { milestoneId: milestone.id }, done), 'invalid_state');
  await f.run('ReopenMilestone', { reason: 'New work' }, achieved);
  assert.equal((await f.run('ReopenWorkItem', { reason: 'More work' }, done)).data.status, 'draft');
});

test('archive is independent from reopening and blocks project descendants', async () => {
  const f = new Fixture();
  const project = await f.project();
  const cancelled = await f.run('CancelWorkItem', { reason: 'Stopped' }, await f.work(project));
  const archivedItem = await f.run('ArchiveObject', { kind: 'work_item', reason: 'Store' }, cancelled);
  await rejectsCode(f.run('UpdateWorkItemMetadata', { priority: 'high' }, archivedItem), 'object_archived');
  const closedProject = await f.run('CancelProject', { reason: 'Stopped' }, project);
  const archivedProject = await f.run('ArchiveObject', { kind: 'project', reason: 'Store' }, closedProject);
  await rejectsCode(f.run('RestoreArchivedObject', { kind: 'work_item', reason: 'Need it' }, archivedItem), 'object_archived');
  const restoredProject = await f.run('RestoreArchivedObject', { kind: 'project', reason: 'Need it' }, archivedProject);
  assert.equal(restoredProject.data.status, 'cancelled');
  const restoredItem = await f.run('RestoreArchivedObject', { kind: 'work_item', reason: 'Need it' }, archivedItem);
  assert.equal(restoredItem.data.status, 'cancelled');
});

test('every command payload is strict and state/actor injection is rejected', () => {
  for (const definition of Object.values({ ...planningCommands, ...intentCommands })) {
    assert.equal(definition.payload.safeParse({ actorId: randomUUID(), status: 'done' }).success, false);
  }
  assert.equal(planningCommands.UpdateWorkItemMetadata!.payload.safeParse({ assigneeId: null, currentSubmissionId: randomUUID() }).success, false);
});

test('a new intent can supersede an earlier decision while retaining its converted work', async () => {
  const f = new Fixture();
  const project = await f.project();
  const oldIntent = await f.run('ProposeIntent', { summary: 'Old direction', goal: 'Goal' });
  const accepted = await f.run('AcceptIntent', { revision: 1, reason: 'Proceed' }, oldIntent);
  const work = await f.run('CreateWorkItemFromIntent', { title: 'Work', description: 'Scope', acceptanceCriteria: [], intentId: oldIntent.id, acceptedRevision: 1, decisionId: accepted.decision.id }, undefined, project.id);
  const newIntent = await f.run('ProposeIntent', { summary: 'New direction', goal: 'Different goal' });
  const superseding = await f.run('RecordDecision', { subjectRef: { kind: 'intent', id: newIntent.id }, decisionType: 'supersede', reason: 'Direction changed', supersedesDecisionId: accepted.decision.id });
  assert.equal(superseding.data.supersedesDecisionId, accepted.decision.id);
  assert.equal(f.current(work).data.status, 'draft');
  assert.equal(f.current(oldIntent).data.status, 'accepted');
  assert.equal(f.current(newIntent).data.status, 'proposed');
});
