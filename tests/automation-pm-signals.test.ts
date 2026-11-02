import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { parseMarkdown } from '../packages/pm-markdown/index.ts';
import { defaultConfiguration, type FileRecord, type ProtocolConfiguration } from '../packages/pm-schema/index.ts';
import { revisionOf } from '../packages/pm-core/repository.ts';
import { coreFactSummary, summarySchema } from '../packages/pm-core/service-facts.ts';
import { capturePmAutomationEvents, currentPmAutomationOrigin, insertPmAutomationSignal, pmAutomationEventFromOutbox, pmAutomationTaskFromFile, withPmAutomationOrigin } from '../packages/application/src/automation-pm-signals.ts';

const actorId = randomUUID(), workspaceId = randomUUID();
const configuration: ProtocolConfiguration = { ...defaultConfiguration, workflows: { ...defaultConfiguration.workflows, work_item: {
  initial: 'queued-custom', states: [{ id: 'queued-custom', label: 'Queued', category: 'backlog' }, { id: 'accepted-custom', label: 'Accepted', category: 'completed' }],
  transitions: [{ from: 'queued-custom', to: 'accepted-custom' }],
} } };
function task(body = 'Original requirement\n\n- [ ] Verifiable acceptance', fields = ''): FileRecord {
  const raw = `---\nschema: pm/v1\nid: TASK-001\nentity: work_item\nproject: PRJ-001\nstatus: queued-custom\n${fields}---\n# Exact source title\n\n${body}\n`;
  return { id: 'TASK-001', path: 'work-items/TASK-001.md', raw, revision: revisionOf(raw), entity: parseMarkdown(raw, configuration) };
}

test('native task versions preserve parsed acceptance and custom workflow categories without duplicating title or fenced checklist text', () => {
  const source = task('Original requirement\n\n```text\n- [ ] Not a criterion\n```\n\n- [x] Verifiable acceptance');
  const value = pmAutomationTaskFromFile(source, configuration);
  assert.ok(value);
  assert.equal(value.description, 'Original requirement\n\n```text\n- [ ] Not a criterion\n```');
  assert.deepEqual(value.acceptanceCriteria, ['Verifiable acceptance']);
  assert.equal(value.statusCategory, 'backlog');
  assert.equal(pmAutomationTaskFromFile(source)?.statusCategory, null, 'Unknown configuration is not silently replaced by hardcoded statuses');
});

test('native requirement changes freeze both exact source revisions; state/dependency signals are actual differences', () => {
  const before = task();
  const after = task('Changed requirement\n\n- [ ] New acceptance');
  const eventId = randomUUID();
  const event = capturePmAutomationEvents({ eventId, actorId, workspaceId, before, after, configuration });
  assert.deepEqual(event.map(item => item.key), ['task.updated']);
  assert.equal(event[0]?.before?.task.description, 'Original requirement');
  assert.equal(event[0]?.after?.task.description, 'Changed requirement');
  assert.equal(event[0]?.before?.task.revision, before.revision);
  assert.equal(event[0]?.after?.task.revision, after.revision);
  assert.equal(event[0]?.before?.provenance, 'durable-event');
  assert.deepEqual(capturePmAutomationEvents({ eventId, actorId, workspaceId, before, after: before }), []);
  const completedRaw = after.raw.replace('queued-custom', 'accepted-custom');
  const completed = { ...after, raw: completedRaw, revision: revisionOf(completedRaw), entity: parseMarkdown(completedRaw, configuration) };
  const state = capturePmAutomationEvents({ eventId, actorId, workspaceId, before: after, after: completed, configuration });
  assert.deepEqual(state.map(item => item.key), ['task.updated', 'task.state_changed']);
  assert.equal(state[1]?.after?.task.statusCategory, 'completed');
  const dependencies = task(undefined, 'blocked_by: [TASK-002]\n');
  assert.deepEqual(capturePmAutomationEvents({ eventId, actorId, workspaceId, before, after: dependencies, configuration }).map(item => item.key), ['task.updated', 'task.dependencies_changed']);
  assert.deepEqual(pmAutomationTaskFromFile(dependencies, configuration)?.dependsOn, ['TASK-002'], 'Dependencies are not filtered into false readiness');
});

test('real task creation and milestone boundaries emit, stale/cross-project sources fail closed, oversized versions remain explicitly missing', () => {
  const source = task();
  const events = capturePmAutomationEvents({ eventId: randomUUID(), actorId, workspaceId, after: source, configuration });
  assert.deepEqual(events.map(item => item.key), ['task.created']);
  assert.equal(events[0]?.before, null);
  assert.equal(events[0]?.after?.task.id, source.id);
  assert.equal(events[0]?.sourceRef.url, `/pm/${workspaceId}/entities/TASK-001`);
  const movedRaw = source.raw.replace('PRJ-001', 'PRJ-002');
  const moved = { ...source, raw: movedRaw, revision: revisionOf(movedRaw), entity: parseMarkdown(movedRaw, configuration) };
  assert.deepEqual(capturePmAutomationEvents({ eventId: randomUUID(), actorId, workspaceId, before: source, after: moved }), []);
  assert.deepEqual(capturePmAutomationEvents({ eventId: randomUUID(), actorId, workspaceId, after: { ...source, stale: true } }), []);
  const huge = task('x'.repeat(100001));
  const missing = capturePmAutomationEvents({ eventId: randomUUID(), actorId, workspaceId, before: source, after: huge, configuration });
  assert.equal(missing[0]?.after, null, 'A current truncated prefix is never presented as a complete old or new requirement');
  const raw = '---\nschema: pm/v1\nid: MS-001\nentity: milestone\nproject: PRJ-001\n---\n# Real milestone\n';
  const milestone = { id: 'MS-001', path: 'milestones/MS-001.md', raw, revision: revisionOf(raw), entity: parseMarkdown(raw, configuration) };
  const milestoneEvents = capturePmAutomationEvents({ eventId: randomUUID(), actorId, workspaceId, after: milestone });
  assert.deepEqual(milestoneEvents.map(item => item.key), ['milestone.changed']);
  assert.equal(milestoneEvents[0]?.sourceRef.url, `/pm/${workspaceId}/entities/MS-001`);
});

test('trusted automation origin survives async capture and suppresses ingestion without granting a write or leaking across contexts', async () => {
  const executionId = randomUUID();
  const [generated, ordinary] = await Promise.all([
    withPmAutomationOrigin(executionId, async () => { await Promise.resolve(); return capturePmAutomationEvents({ eventId: randomUUID(), actorId, workspaceId, after: task() })[0]!; }),
    Promise.resolve().then(() => capturePmAutomationEvents({ eventId: randomUUID(), actorId, workspaceId, after: task() })[0]!),
  ]);
  assert.equal(generated.originExecutionId, executionId);
  assert.equal(ordinary.originExecutionId, null);
  assert.equal(currentPmAutomationOrigin(), null);
  let queries = 0;
  assert.equal(await insertPmAutomationSignal({ query: async () => { queries++; throw new Error('Suppressed automation must not touch the event queue'); } }, generated), false);
  assert.equal(queries, 0);
});

test('existing observation hashes stay backward-compatible and distinguish an absent dependency boundary from unchanged dependencies', () => {
  const summary = coreFactSummary(task());
  assert.ok(summary?.dependencies);
  const { dependencies: _dependencies, ...historical } = summary;
  assert.equal(summarySchema.parse(historical).dependencies, undefined);
  assert.equal(coreFactSummary(task('Content only'))?.dependencies, summary.dependencies);
  assert.notEqual(coreFactSummary(task(undefined, 'blocked_by: [TASK-002]\n'))?.dependencies, summary.dependencies);
  assert.equal(JSON.stringify(summary).includes('Original requirement'), false);
});

test('outbox metadata uses original source identity and never fabricates before/after or exposes actor-private events', () => {
  const row = { id: '77', event_id: randomUUID(), workspace_id: workspaceId, project_id: 'PRJ-001', actor_id: actorId, aggregate_id: 'TASK-001', aggregate_kind: 'work_item', aggregate_version: 4, event_type: 'WorkItemCompleted', created_at: new Date(), audience_actor_id: null, payload: {} };
  const value = pmAutomationEventFromOutbox(row);
  assert.equal(value?.eventId, `outbox:${row.event_id}`);
  assert.equal(value?.key, 'task.state_changed');
  assert.equal(value?.before, null);
  assert.equal(value?.after, null);
  assert.equal(pmAutomationEventFromOutbox({ ...row, audience_actor_id: actorId }), null);
  assert.equal(pmAutomationEventFromOutbox({ ...row, project_id: null }), null);
});
