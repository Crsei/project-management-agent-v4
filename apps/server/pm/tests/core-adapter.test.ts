import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import chokidar from 'chokidar';
import type { Pool } from 'pg';
import { Workspace, revisionOf } from '../../../../packages/pm-core/index.ts';
import { createMarkdown, parseMarkdown } from '../../../../packages/pm-markdown/index.ts';
import type { FileRecord, WorkflowDefinition } from '../../../../packages/pm-schema/index.ts';
import { DomainError, type Actor, type Capability, type Command, type CommandReceipt, type Entity } from '../../../../packages/domain/src/core.ts';
import { CoreScope } from '../src/core-routes.ts';
import {
  CORE_ENTITY_KINDS, coreRecordToEntity, coreVersion, executeCoreCommand, isCoreCommand, isCoreEntityKind, listCoreEntities,
  readCoreEntity, toCorePriority, toCoreStatus, toPmPriority, toPmStatus, type CoreCommandContext,
} from '../src/core-adapter.ts';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const principal: Actor = { id: '22222222-2222-4222-8222-222222222222', email: 'owner@example.test', name: 'Owner' };
const allCapabilities: Capability[] = ['domain.read', 'planning.edit', 'planning.lifecycle', 'workitem.cancel_reopen', 'workitem.complete'];

// Adapter unit tests never rely on external file events. Replacing the watcher
// keeps them independent of the host's inotify budget while Workspace still
// provides its durable state, projection and revision semantics.
chokidar.watch = (() => {
  const watcher = new EventEmitter() as EventEmitter & { close: () => Promise<void> };
  watcher.close = async () => undefined;
  queueMicrotask(() => watcher.emit('ready'));
  return watcher;
}) as unknown as typeof chokidar.watch;

function scopeWith(projectIds: string[] | null = null, capabilities: Capability[] = allCapabilities): CoreScope {
  return new CoreScope({ userId: principal.id, workspaceId, capabilities, projectIds, version: 1, revokedAt: null }, workspaceId);
}
function coreCommand(commandType: string, payload: Record<string, unknown>, extra: Partial<Command> = {}): Command {
  return { commandId: randomUUID(), commandType, payload, ...extra };
}

type AdapterSqlPool = Pool & { authorize(scope: CoreScope): void };

/** Only the SQL authority/transaction seam is deterministic; every core mutation still uses real files. */
function unitSqlPool(): AdapterSqlPool {
  let current: CoreScope | undefined;
  let connected = false;
  return {
    authorize(scope: CoreScope) {
      assert.equal(connected, false, 'Set current membership before opening its transaction');
      current = scope;
    },
    async connect() {
      assert.ok(current, 'The unit command must declare its authoritative membership');
      assert.equal(connected, false);
      connected = true;
      const scope = current;
      let state: 'connected' | 'transaction' | 'locked' | 'authorized' | 'finished' = 'connected';
      return {
        async query(statement: string, values?: unknown[]) {
          let rows: unknown[] = [];
          if (statement === 'BEGIN') {
            assert.equal(state, 'connected');
            state = 'transaction';
          } else if (statement.startsWith('SELECT pg_advisory_xact_lock(')) {
            assert.equal(state, 'transaction');
            assert.deepEqual(values, [scope.workspaceId]);
            state = 'locked';
          } else if (statement.startsWith('SELECT m.* FROM memberships m JOIN users u')) {
            assert.equal(state, 'locked', 'Fresh authorization must follow the workspace lock');
            assert.deepEqual(values, [scope.workspaceId, principal.id]);
            const member = scope.membership;
            rows = [{ user_id: member.userId, workspace_id: member.workspaceId, capabilities: member.capabilities,
              project_ids: member.projectIds, version: member.version, revoked_at: null }];
            state = 'authorized';
          } else if (statement.startsWith('SELECT m.user_id FROM memberships m JOIN users u')) {
            assert.equal(state, 'authorized', 'Assignment validation must share the authorized transaction');
            assert.equal(values?.[0], scope.workspaceId);
            if (values?.[1] === principal.id && scope.membership.capabilities.includes('domain.read') && scope.allowsProject(values?.[2]))
              rows = [{ user_id: principal.id }];
          } else if (statement.startsWith('SELECT ') && statement.includes(' FROM dashboard_records ')) {
            rows = []; // This fixture has no personal dashboard records or task watches.
          } else if (statement.startsWith('SELECT 1 FROM local_project_storage_operations ')) {
            rows = []; // Projects in this fixture have no storage maintenance in progress.
          } else if (statement.startsWith('SELECT source FROM (')) {
            rows = []; // No retained SQL business history in this unit fixture.
          } else if (statement === 'COMMIT' || statement === 'ROLLBACK') {
            assert.notEqual(state, 'connected');
            assert.notEqual(state, 'finished');
            state = 'finished';
          } else throw new Error(`Unexpected SQL in adapter unit fixture: ${statement}`);
          return { rows, rowCount: rows.length };
        },
        release() {
          assert.equal(state, 'finished', 'Release only a completed or rolled-back transaction');
          assert.equal(connected, true);
          connected = false;
        },
      };
    },
    async end() { assert.equal(connected, false, 'No unit SQL transaction may leak'); },
  } as unknown as AdapterSqlPool;
}
function contextFor(workspace: Workspace, scope: CoreScope, command: Command, pool: AdapterSqlPool): CoreCommandContext {
  pool.authorize(scope);
  // Core writes require the caller's version derived from the authoritative
  // Markdown revision. Fill it from the current record so each call asserts
  // the state it observed; creates carry no expected version.
  if (command.targetId && !/^Create/.test(command.commandType)) {
    command = {
      ...command,
      expectedVersions: { [command.targetId]: coreVersion(workspace.get(command.targetId).revision), ...command.expectedVersions },
    };
  }
  return { workspace, scope, principal, command, pool };
}
function committedEntity(receipt: CommandReceipt): Entity {
  assert.equal(receipt.status, 'committed', receipt.status === 'rejected' ? JSON.stringify(receipt.error) : '');
  // CommandReceipt.result is unknown; the assertion above establishes the committed shape.
  const result = receipt.result as Entity;
  assert.equal(typeof result.id, 'string');
  assert.equal(typeof result.data, 'object');
  return result;
}
function criterionTexts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const texts: string[] = [];
  for (const item of value) if (item && typeof item === 'object' && 'text' in item && typeof item.text === 'string') texts.push(item.text);
  return texts;
}
function rejectionOf(receipt: CommandReceipt): { code: string; message: string } {
  assert.equal(receipt.status, 'rejected');
  assert.ok(receipt.error);
  return receipt.error;
}
function recordOf(raw: string, filePath = 'items/item.md') {
  const entity = parseMarkdown(raw);
  return { id: entity.id, path: filePath, raw, revision: revisionOf(raw), entity };
}

test('status and priority mapping is bidirectional and preserves custom states', () => {
  assert.equal(toPmStatus('project', 'planned'), 'planning');
  assert.equal(toPmStatus('project', 'on_hold'), 'active');
  assert.equal(toPmStatus('project', 'canceled'), 'cancelled');
  assert.equal(toPmStatus('work_item', 'todo'), 'draft');
  assert.equal(toPmStatus('work_item', 'canceled'), 'cancelled');
  assert.equal(toPmStatus('milestone', 'completed'), 'achieved');
  assert.equal(toPmStatus('work_item', 'blocked_custom'), 'blocked_custom');

  assert.equal(toCoreStatus('project', 'planning'), 'planned');
  assert.equal(toCoreStatus('project', 'cancelled'), 'canceled');
  assert.equal(toCoreStatus('work_item', 'ready'), 'todo');
  assert.equal(toCoreStatus('work_item', 'in_review'), 'in_progress');
  assert.equal(toCoreStatus('work_item', 'cancelled'), 'canceled');
  assert.equal(toCoreStatus('milestone', 'achieved'), 'completed');
  assert.equal(toCoreStatus('project', 'awaiting_vendor'), 'awaiting_vendor');

  assert.equal(toPmPriority('medium'), 'normal');
  assert.equal(toPmPriority('urgent'), 'urgent');
  assert.equal(toPmPriority(null), null);
  assert.equal(toCorePriority('normal'), 'medium');
  assert.equal(toCorePriority('low'), 'low');
  assert.equal(toCorePriority(undefined), null);

  assert.deepEqual([...CORE_ENTITY_KINDS], ['project', 'work_item', 'milestone']);
  assert.equal(isCoreEntityKind('project'), true);
  assert.equal(isCoreEntityKind('conversation'), false);
  assert.equal(isCoreCommand('CreateWorkItemFromIntent'), true);
  assert.equal(isCoreCommand('ArchiveObject'), true);
  assert.equal(isCoreCommand('CreateConversation'), false);
});

test('core file records map to PM project, work item and milestone aggregates', () => {
  const project = recordOf(createMarkdown({
    id: 'PRJ-007', entity: 'project', title: 'Alpha', goal: 'Ship the thing', owner: 'owner-1',
    status: 'planned', labels: ['launch'], 'x-pm-archived-at': '2026-01-02T03:04:05.000Z', archived: true,
  }), 'projects/PRJ-007.md');
  const mappedProject = coreRecordToEntity(workspaceId, project);
  assert.equal(mappedProject.projectId, null);
  assert.equal(mappedProject.kind, 'project');
  assert.equal(mappedProject.createdAt, null);
  assert.equal(mappedProject.updatedAt, null);
  assert.deepEqual(mappedProject.data, {
    name: 'Alpha', title: 'Alpha', description: '', icon: null, color: null, goal: 'Ship the thing', ownerId: 'owner-1', status: 'planning',
    completionCriteria: [], startDate: null, dueDate: null, archivedAt: '2026-01-02T03:04:05.000Z', labStatus: 'planned',
    blocked_by: [], related_to: [], labels: ['launch'], archived: true,
  });

  const item = recordOf(createMarkdown({
    id: 'TASK-009', entity: 'work_item', title: 'Do the work', project: 'PRJ-007', status: 'in_progress',
    priority: 'medium', assignee: 'user-1', due: '2026-11-02', 'x-pm-start': '2026-11-01',
    body: 'Details\n\n- [ ] first\n- [x] second', labels: ['backend'],
    'x-pm-created-at': '2025-01-02T03:04:05.000Z', 'x-pm-updated-at': '2026-10-17T11:12:13+08:00',
  }), 'work-items/TASK-009.md');
  const mappedItem = coreRecordToEntity(workspaceId, item);
  assert.equal(mappedItem.projectId, 'PRJ-007');
  assert.equal(mappedItem.createdAt, '2025-01-02T03:04:05.000Z');
  assert.equal(mappedItem.updatedAt, '2026-10-17T11:12:13+08:00');
  assert.equal(mappedItem.data.title, 'Do the work');
  assert.equal(mappedItem.data.description, 'Details');
  assert.equal(mappedItem.data.status, 'in_progress');
  assert.equal(mappedItem.data.labStatus, 'in_progress');
  assert.equal(mappedItem.data.priority, 'normal');
  assert.equal(mappedItem.data.assigneeId, 'user-1');
  assert.equal(mappedItem.data.startDate, '2026-11-01');
  assert.equal(mappedItem.data.dueDate, '2026-11-02');
  assert.deepEqual(mappedItem.data.prerequisiteIds, []);
  assert.deepEqual(mappedItem.data.acceptanceCriteria, [
    { id: 'TASK-009-AC-1', text: 'first' },
    { id: 'TASK-009-AC-2', text: 'second' },
  ]);
  assert.equal(mappedItem.data.archivedAt, null);
  assert.equal(mappedItem.data.estimatePoints, null);

  const milestone = recordOf(createMarkdown({
    id: 'MS-001', entity: 'milestone', title: 'Beta', project: 'PRJ-007', status: 'completed',
    owner: 'owner-1', due: '2026-12-01',
  }), 'milestones/MS-001.md');
  const mappedMilestone = coreRecordToEntity(workspaceId, milestone);
  assert.equal(mappedMilestone.kind, 'milestone');
  assert.equal(mappedMilestone.projectId, 'PRJ-007');
  assert.deepEqual(mappedMilestone.data, {
    name: 'Beta', status: 'achieved', ownerId: 'owner-1', targetDate: '2026-12-01', archivedAt: null,
    labStatus: 'completed', blocked_by: [], related_to: [], labels: [], archived: false,
  });
});

test('core estimate projection keeps absent, invalid and cleared metadata unknown, never coerces strings', () => {
  const record = recordOf(createMarkdown({ id: 'TASK-010', title: 'Estimate projection', 'x-pm-estimate': 0 }));
  assert.equal(coreRecordToEntity(workspaceId, record).data.estimatePoints, 0);
  for (const value of [undefined, null, '8', -1, NaN, Infinity, 1_000_001]) {
    const observed = { ...record, entity: { ...record.entity, 'x-pm-estimate': value } } as unknown as FileRecord;
    assert.equal(coreRecordToEntity(workspaceId, observed).data.estimatePoints, null);
  }
  assert.equal(coreRecordToEntity(workspaceId, { ...record, entity: { ...record.entity, 'x-pm-estimate': 2.5 } }).data.estimatePoints, 2.5);
});

test('unknown source timestamps stay null across reads, rejected commands, metadata writes and restart', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-17T00:00:00.000Z') });
  const root = await mkdtemp(path.join(os.tmpdir(), 'core-adapter-timestamps-'));
  let workspace = new Workspace(root);
  const pool = unitSqlPool();
  t.after(async () => { await workspace.close(); await pool.end(); await rm(root, { recursive: true, force: true }); });
  await workspace.init();
  const scope = scopeWith();
  const project = committedEntity(await executeCoreCommand(contextFor(workspace, scope, coreCommand('CreateProject', { name: 'Stable source' }), pool)));
  const item = committedEntity(await executeCoreCommand(contextFor(workspace, scope, coreCommand('CreateWorkItem', {
    title: 'No invented activity', description: 'Authoritative Markdown', acceptanceCriteria: [],
  }, { projectId: project.id }), pool)));
  assert.equal(item.createdAt, null);
  assert.equal(item.updatedAt, null);
  const rawBefore = workspace.get(item.id).raw;

  t.mock.timers.tick(60_000);
  await workspace.rescan('refresh');
  assert.deepEqual(readCoreEntity(workspace, scope, item.id), item);
  assert.deepEqual((await listCoreEntities(workspace, scope, { kind: 'work_item' })).items, [item]);
  assert.equal(workspace.get(item.id).raw, rawBefore);
  const rejected = await executeCoreCommand(contextFor(workspace, scope, coreCommand('UpdateWorkItemMetadata', {
    startDate: '2026-11-03', dueDate: '2026-11-01',
  }, { targetId: item.id }), pool));
  assert.equal(rejectionOf(rejected).code, 'invalid_schedule_range');
  assert.deepEqual(readCoreEntity(workspace, scope, item.id), item);
  assert.equal(workspace.get(item.id).raw, rawBefore);

  const changed = committedEntity(await executeCoreCommand(contextFor(workspace, scope, coreCommand('UpdateWorkItemMetadata', {
    startDate: '2028-02-29', dueDate: '2028-03-02',
  }, { targetId: item.id }), pool)));
  assert.notEqual(changed.version, item.version);
  assert.equal(changed.createdAt, null);
  assert.equal(changed.updatedAt, null);
  assert.equal(changed.data.startDate, '2028-02-29');
  assert.equal(changed.data.dueDate, '2028-03-02');
  t.mock.timers.tick(60_000);
  assert.deepEqual(readCoreEntity(workspace, scope, item.id), changed);

  await workspace.close();
  workspace = new Workspace(root);
  await workspace.init();
  assert.deepEqual(readCoreEntity(workspace, scope, item.id), changed);
  assert.deepEqual((await listCoreEntities(workspace, scope, { kind: 'work_item' })).items, [changed]);
});

test('create commands map PM payloads to core files and are idempotent by command ID', async (t: TestContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'core-adapter-create-'));
  const workspace = new Workspace(root);
  const pool = unitSqlPool();
  t.after(async () => { await workspace.close(); await pool.end(); await rm(root, { recursive: true, force: true }); });
  await workspace.init();
  const scope = scopeWith();

  const createProject = coreCommand('CreateProject', { name: 'Alpha', goal: 'Ship', ownerId: null, completionCriteria: ['done'] });
  const projectReceipt = await executeCoreCommand(contextFor(workspace, scope, createProject, pool));
  const project = committedEntity(projectReceipt);
  assert.equal(projectReceipt.httpStatus, 200);
  assert.equal(project.kind, 'project');
  assert.equal(project.data.name, 'Alpha');
  assert.equal(project.data.goal, 'Ship');
  assert.equal(project.data.status, 'planning');
  assert.equal(project.data.labStatus, 'planned');
  assert.equal(project.data.ownerId, null);
  assert.equal(workspace.get(project.id).entity.owner, undefined);

  const createItem = coreCommand('CreateWorkItem', {
    title: 'First task', description: 'Implement the adapter', acceptanceCriteria: [{ id: randomUUID(), text: 'mapping works' }],
    assigneeId: null, priority: 'normal',
  }, { projectId: project.id });
  const firstReceipt = await executeCoreCommand(contextFor(workspace, scope, createItem, pool));
  const item = committedEntity(firstReceipt);
  assert.equal(firstReceipt.httpStatus, 200);
  assert.equal(item.projectId, project.id);
  assert.equal(item.data.status, 'draft');
  assert.equal(item.data.labStatus, 'todo');
  assert.equal(item.data.priority, 'normal');
  assert.deepEqual(item.data.prerequisiteIds, []);
  assert.deepEqual(criterionTexts(item.data.acceptanceCriteria), ['mapping works']);
  assert.doesNotMatch(String(item.data.description), /- \[ \] mapping works/);
  assert.match(workspace.get(item.id).raw, /- \[ \] mapping works/);

  const secondReceipt = await executeCoreCommand(contextFor(workspace, scope, createItem, pool));
  assert.equal(committedEntity(secondReceipt).id, item.id);
  assert.equal(workspace.items({ entity: 'work_item' }).filter(record => record.entity.project === project.id).length, 1);
  assert.match(workspace.get(item.id).raw, /x-pm-created-by:/);
  assert.match(workspace.get(item.id).raw, /priority: medium/);

  await executeCoreCommand(contextFor(workspace, scope, coreCommand('ActivateProject', {}, { targetId: project.id }), pool));
  assert.equal(workspace.get(project.id).entity.status, 'active');
  await executeCoreCommand(contextFor(workspace, scope, coreCommand('CompleteProject', { reason: 'done', criteriaChecks: [] }, { targetId: project.id }), pool));
  assert.equal(workspace.get(project.id).entity.status, 'completed');
  assert.equal(coreRecordToEntity(workspaceId, workspace.get(project.id)).data.status, 'completed');
});

test('work item commands update content, metadata, dependencies and lifecycle states', async (t: TestContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'core-adapter-item-'));
  const workspace = new Workspace(root);
  const pool = unitSqlPool();
  t.after(async () => { await workspace.close(); await pool.end(); await rm(root, { recursive: true, force: true }); });
  await workspace.init();
  const scope = scopeWith();
  const project = committedEntity(await executeCoreCommand(contextFor(workspace, scope, coreCommand('CreateProject', { name: 'P', goal: 'G', ownerId: null, completionCriteria: [] }), pool)));

  const item = committedEntity(await executeCoreCommand(contextFor(workspace, scope, coreCommand('CreateWorkItem', {
    title: 'Old title', description: 'Old body', acceptanceCriteria: [{ id: randomUUID(), text: 'old criterion' }], priority: 'low',
  }, { projectId: project.id }), pool)));
  const prerequisite = committedEntity(await executeCoreCommand(contextFor(workspace, scope, coreCommand('CreateWorkItem', {
    title: 'Prerequisite', description: '', acceptanceCriteria: [], priority: null,
  }, { projectId: project.id }), pool)));

  const rawBefore = workspace.get(item.id).raw;
  const content = committedEntity(await executeCoreCommand(contextFor(workspace, scope, coreCommand('UpdateWorkItemContent', {
    title: 'New title', description: 'New body', acceptanceCriteria: [{ id: randomUUID(), text: 'new criterion' }],
  }, { targetId: item.id }), pool)));
  assert.equal(content.data.title, 'New title');
  assert.equal(content.data.description, 'New body');
  assert.deepEqual(criterionTexts(content.data.acceptanceCriteria), ['new criterion']);
  const rawAfter = workspace.get(item.id).raw;
  assert.match(rawAfter, /x-pm-created-by:/);
  assert.match(rawAfter, /priority: low/);
  assert.doesNotMatch(rawAfter, /Old body/);
  assert.match(rawBefore, /Old body/);

  const metadata = committedEntity(await executeCoreCommand(contextFor(workspace, scope, coreCommand('UpdateWorkItemMetadata', {
    assigneeId: principal.id, priority: 'high', startDate: '2026-11-01', dueDate: '2026-11-05',
  }, { targetId: item.id }), pool)));
  assert.equal(metadata.data.assigneeId, principal.id);
  assert.equal(metadata.data.priority, 'high');
  assert.equal(metadata.data.startDate, '2026-11-01');
  assert.equal(metadata.data.dueDate, '2026-11-05');
  assert.equal(workspace.get(item.id).entity.priority, 'high');

  const dependency = committedEntity(await executeCoreCommand(contextFor(workspace, scope, coreCommand('AddDependency', { prerequisiteId: prerequisite.id }, { targetId: item.id }), pool)));
  assert.deepEqual(dependency.data.prerequisiteIds, [prerequisite.id]);
  const duplicate = await executeCoreCommand(contextFor(workspace, scope, coreCommand('AddDependency', { prerequisiteId: prerequisite.id }, { targetId: item.id }), pool));
  assert.equal(rejectionOf(duplicate).code, 'duplicate_dependency');
  assert.equal(duplicate.httpStatus, 409);
  const removed = committedEntity(await executeCoreCommand(contextFor(workspace, scope, coreCommand('RemoveDependency', { prerequisiteId: prerequisite.id }, { targetId: item.id }), pool)));
  assert.deepEqual(removed.data.prerequisiteIds, []);
  const missing = await executeCoreCommand(contextFor(workspace, scope, coreCommand('RemoveDependency', { prerequisiteId: prerequisite.id }, { targetId: item.id }), pool));
  assert.equal(rejectionOf(missing).code, 'dependency_not_found');

  const idReason = committedEntity(await executeCoreCommand(contextFor(workspace, scope, coreCommand('SetWorkItemBlockers', { manualBlockReasons: [prerequisite.id] }, { targetId: item.id }), pool)));
  assert.deepEqual(idReason.data.prerequisiteIds, [], 'ID-looking manual reasons must not create dependencies');
  committedEntity(await executeCoreCommand(contextFor(workspace, scope, coreCommand('AddDependency', { prerequisiteId: prerequisite.id }, { targetId: item.id }), pool)));
  for (const manualBlockReasons of [[item.id], [], ['Waiting on vendor']]) {
    const manual = committedEntity(await executeCoreCommand(contextFor(workspace, scope, coreCommand('SetWorkItemBlockers', { manualBlockReasons }, { targetId: item.id }), pool)));
    assert.deepEqual(manual.data.prerequisiteIds, [prerequisite.id], 'Manual reasons must preserve dependencies, including empty and ID-looking reasons');
    assert.deepEqual(workspace.get(item.id).entity.blocked_by, [prerequisite.id]);
    assert.deepEqual(workspace.get(item.id).entity['x-pm-manual-block-reasons'], manualBlockReasons);
  }

  assert.equal(committedEntity(await executeCoreCommand(contextFor(workspace, scope, coreCommand('StartWorkItem', {}, { targetId: item.id }), pool))).data.status, 'in_progress');
  assert.equal(committedEntity(await executeCoreCommand(contextFor(workspace, scope, coreCommand('CompleteWorkItem', {}, { targetId: item.id }), pool))).data.status, 'done');
  assert.equal(committedEntity(await executeCoreCommand(contextFor(workspace, scope, coreCommand('CancelWorkItem', { reason: 'stop' }, { targetId: item.id }), pool))).data.status, 'cancelled');
  assert.equal(committedEntity(await executeCoreCommand(contextFor(workspace, scope, coreCommand('ReopenWorkItem', { reason: 'again' }, { targetId: item.id }), pool))).data.status, 'in_progress');

  const archived = committedEntity(await executeCoreCommand(contextFor(workspace, scope, coreCommand('ArchiveObject', { kind: 'work_item', reason: 'obsolete' }, { targetId: item.id }), pool)));
  assert.equal(archived.data.archived, true);
  assert.equal(typeof archived.data.archivedAt, 'string');
  assert.equal((await listCoreEntities(workspace, scope, { kind: 'work_item' })).items.some(row => row.id === item.id), false);
  assert.equal((await listCoreEntities(workspace, scope, { kind: 'work_item', archived: 'include' })).items.some(row => row.id === item.id), true);
  const lifecycleScope = scopeWith(null, ['domain.read', 'planning.lifecycle']);
  assert.equal(readCoreEntity(workspace, lifecycleScope, item.id).data.archived, true, 'Single-entity reads must include accessible archived records');
  const restored = committedEntity(await executeCoreCommand(contextFor(workspace, lifecycleScope, coreCommand('RestoreArchivedObject', { kind: 'work_item', reason: 'needed' }, { targetId: item.id }), pool)));
  assert.equal(restored.data.archived, false);
  assert.equal(restored.data.archivedAt, null);
});

test('default lifecycle commands choose the configured work lane and remain idempotent in the current category', async (t: TestContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'core-adapter-default-workflow-'));
  let workspace = new Workspace(root);
  const pool = unitSqlPool();
  t.after(async () => { await workspace.close(); await pool.end(); await rm(root, { recursive: true, force: true }); });
  await workspace.init();
  const scope = scopeWith();
  const item = await workspace.create({ title: 'Default workflow' });
  for (const [commandType, status] of [
    ['ReadyWorkItem', 'in_progress'], ['StartWorkItem', 'in_progress'], ['CompleteWorkItem', 'done'],
    ['ReopenWorkItem', 'in_progress'], ['CancelWorkItem', 'canceled'], ['ReopenWorkItem', 'in_progress'],
  ]) {
    const command = coreCommand(commandType!, {}, { targetId: item.id });
    const result = committedEntity(await executeCoreCommand(contextFor(workspace, scope, command, pool)));
    assert.equal(result.data.labStatus, status);
    const saved = workspace.get(item.id);
    assert.deepEqual(committedEntity(await executeCoreCommand(contextFor(workspace, scope, command, pool))), result);
    assert.deepEqual(committedEntity(await executeCoreCommand(contextFor(workspace, scope, coreCommand(commandType!, {}, { targetId: item.id }), pool))), result);
    assert.equal(workspace.get(item.id).raw, saved.raw);
    assert.equal(workspace.get(item.id).revision, saved.revision);
  }

  // Persist/reload the native definition, retaining the independently selectable review lane.
  await workspace.saveConfiguration(workspace.configuration().config, 'absent');
  await workspace.close();
  workspace = new Workspace(root);
  await workspace.init();
  const reviewing = await workspace.patch(item.id, { status: 'review' }, workspace.get(item.id).revision);
  for (const commandType of ['ReadyWorkItem', 'StartWorkItem']) {
    const result = committedEntity(await executeCoreCommand(contextFor(workspace, scope, coreCommand(commandType, {}, { targetId: item.id }), pool)));
    assert.equal(result.data.labStatus, 'review', 'Starting already-started work must not move it out of review');
    assert.equal(workspace.get(item.id).raw, reviewing.raw);
    assert.equal(workspace.get(item.id).revision, reviewing.revision);
  }
  assert.equal(committedEntity(await executeCoreCommand(contextFor(workspace, scope, coreCommand('CompleteWorkItem', {}, { targetId: item.id }), pool))).data.status, 'done');
});

test('custom multiple-destination workflows reject ambiguity unless they explicitly select an allowed category target', async (t: TestContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'core-adapter-custom-workflow-'));
  const workspace = new Workspace(root);
  const pool = unitSqlPool();
  t.after(async () => { await workspace.close(); await pool.end(); await rm(root, { recursive: true, force: true }); });
  await workspace.init();
  const workflow: WorkflowDefinition = {
    initial: 'queued',
    states: [
      { id: 'queued', label: 'Queued', category: 'unstarted' },
      { id: 'running', label: 'Running', category: 'started' },
      { id: 'checking', label: 'Checking', category: 'started' },
      { id: 'shipped', label: 'Shipped', category: 'completed' },
      { id: 'merged', label: 'Merged', category: 'completed' },
      { id: 'abandoned', label: 'Abandoned', category: 'canceled' },
      { id: 'shelved', label: 'Shelved', category: 'canceled' },
    ],
    transitions: [
      { from: 'queued', to: 'running' }, { from: 'queued', to: 'checking' },
      { from: 'queued', to: 'abandoned' }, { from: 'queued', to: 'shelved' },
      { from: 'running', to: 'checking' },
      { from: 'running', to: 'shipped' }, { from: 'running', to: 'merged' },
      { from: 'shipped', to: 'running' }, { from: 'shipped', to: 'checking' },
      { from: 'abandoned', to: 'running' }, { from: 'abandoned', to: 'checking' },
    ],
  };
  const configuration = await workspace.saveConfiguration({ schema: 'pm/config/v1', workflows: { work_item: workflow } }, 'absent');
  const scope = scopeWith();
  const cases = [
    ['queued', 'ReadyWorkItem', 'checking'], ['queued', 'StartWorkItem', 'checking'],
    ['running', 'CompleteWorkItem', 'merged'], ['shipped', 'ReopenWorkItem', 'checking'],
    ['abandoned', 'ReopenWorkItem', 'checking'],
    ['queued', 'CancelWorkItem', 'shelved'],
  ] as const;
  const items: FileRecord[] = [];
  for (const [status, commandType] of cases) {
    const item = await workspace.create({ title: commandType, status });
    items.push(item);
    const receipt = await executeCoreCommand(contextFor(workspace, scope, coreCommand(commandType, {}, { targetId: item.id }), pool));
    assert.equal(rejectionOf(receipt).code, 'invalid_transition');
    assert.match(rejectionOf(receipt).message, /ambiguous destinations/);
    assert.equal(receipt.httpStatus, 409);
    assert.equal(workspace.get(item.id).raw, item.raw);
    assert.equal(workspace.get(item.id).revision, item.revision);
  }
  const current = await workspace.create({ title: 'Already started', status: 'running' });
  for (const defaultTargets of [undefined, { started: 'checking', completed: 'merged', canceled: 'shelved' }] as const) {
    if (defaultTargets) {
      configuration.config.workflows.work_item!.default_targets = defaultTargets;
      await workspace.saveConfiguration(configuration.config, configuration.revision);
    }
    for (const commandType of ['ReadyWorkItem', 'StartWorkItem']) {
      const result = committedEntity(await executeCoreCommand(contextFor(workspace, scope, coreCommand(commandType, {}, { targetId: current.id }), pool)));
      assert.equal(result.data.labStatus, 'running', 'Current-category idempotency precedes ambiguity and a different configured preference');
      assert.equal(workspace.get(current.id).revision, current.revision);
    }
  }
  for (const [index, [, commandType, status]] of cases.entries()) {
    const item = items[index]!;
    const result = committedEntity(await executeCoreCommand(contextFor(workspace, scope, coreCommand(commandType, {}, { targetId: item.id }), pool)));
    assert.equal(result.data.labStatus, status, 'Configured targets, not built-in IDs or state order, disambiguate the action');
  }
});

test('workflow target preferences cannot authorize missing edges or hide remaining ambiguity', async (t: TestContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'core-adapter-workflow-edges-'));
  const workspace = new Workspace(root);
  const pool = unitSqlPool();
  t.after(async () => { await workspace.close(); await pool.end(); await rm(root, { recursive: true, force: true }); });
  await workspace.init();
  await workspace.saveConfiguration({ schema: 'pm/config/v1', workflows: { work_item: {
    initial: 'queued',
    states: [
      { id: 'queued', label: 'Queued', category: 'unstarted' },
      { id: 'backlog', label: 'Backlog', category: 'backlog' },
      { id: 'running', label: 'Running', category: 'started' },
      { id: 'checking', label: 'Checking', category: 'started' },
      { id: 'preferred', label: 'Preferred', category: 'started' },
      { id: 'shipped', label: 'Shipped', category: 'completed' },
    ],
    transitions: [
      { from: 'queued', to: 'running' }, { from: 'backlog', to: 'running' },
      { from: 'backlog', to: 'checking' }, { from: 'checking', to: 'shipped' }, { from: 'shipped', to: 'queued' },
    ],
    default_targets: { started: 'preferred', completed: 'shipped' },
  } } }, 'absent');
  const scope = scopeWith();
  for (const [source, commandType, status] of [
    ['queued', 'StartWorkItem', 'running'], ['shipped', 'ReopenWorkItem', 'queued'],
    ['preferred', 'StartWorkItem', 'preferred'],
  ] as const) {
    const item = await workspace.create({ title: commandType, status: source });
    const result = committedEntity(await executeCoreCommand(contextFor(workspace, scope, coreCommand(commandType, {}, { targetId: item.id }), pool)));
    assert.equal(result.data.labStatus, status, 'The unique reachable destination wins over an unreachable preference');
  }
  for (const [source, commandType, message] of [
    ['backlog', 'StartWorkItem', /ambiguous destinations/], ['queued', 'CompleteWorkItem', /no allowed destination/],
  ] as const) {
    const item = await workspace.create({ title: commandType, status: source });
    const receipt = await executeCoreCommand(contextFor(workspace, scope, coreCommand(commandType, {}, { targetId: item.id }), pool));
    assert.equal(rejectionOf(receipt).code, 'invalid_transition');
    assert.match(rejectionOf(receipt).message, message);
    assert.equal(receipt.httpStatus, 409);
    assert.equal(workspace.get(item.id).raw, item.raw);
    assert.equal(workspace.get(item.id).revision, item.revision);
  }
});

test('category target selection preserves completion, reopening, scope and version authorization', async (t: TestContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'core-adapter-workflow-authority-'));
  const workspace = new Workspace(root);
  const pool = unitSqlPool();
  t.after(async () => { await workspace.close(); await pool.end(); await rm(root, { recursive: true, force: true }); });
  await workspace.init();
  const project = await workspace.createEntity({ entity: 'project', title: 'Authorized lifecycle' });
  const item = await workspace.create({ title: 'Protected work', project: project.id });
  const editor = scopeWith([project.id], ['domain.read', 'planning.edit']);
  for (const [scope, commandType, code, httpStatus] of [
    [editor, 'CompleteWorkItem', 'permission_denied', 403],
    [scopeWith([project.id], ['domain.read']), 'StartWorkItem', 'permission_denied', 403],
    [scopeWith(['OTHER-1']), 'StartWorkItem', 'not_found_or_forbidden', 404],
  ] as const) {
    const receipt = await executeCoreCommand(contextFor(workspace, scope, coreCommand(commandType, {}, { targetId: item.id }), pool));
    assert.equal(rejectionOf(receipt).code, code);
    assert.equal(receipt.httpStatus, httpStatus);
    assert.equal(workspace.get(item.id).raw, item.raw);
  }
  committedEntity(await executeCoreCommand(contextFor(workspace, editor, coreCommand('StartWorkItem', {}, { targetId: item.id }), pool)));
  const completer = scopeWith([project.id], ['domain.read', 'workitem.complete']);
  committedEntity(await executeCoreCommand(contextFor(workspace, completer, coreCommand('CompleteWorkItem', {}, { targetId: item.id }), pool)));
  const completed = workspace.get(item.id);
  for (const commandType of ['ReadyWorkItem', 'StartWorkItem', 'CancelWorkItem', 'ReopenWorkItem']) {
    const receipt = await executeCoreCommand(contextFor(workspace, editor, coreCommand(commandType, {}, { targetId: item.id }), pool));
    assert.equal(rejectionOf(receipt).code, 'permission_denied', 'A start shortcut must not bypass terminal-state reopening authorization');
    assert.equal(receipt.httpStatus, 403);
    assert.equal(workspace.get(item.id).raw, completed.raw);
  }
  const stale = await executeCoreCommand(contextFor(workspace, scopeWith(), coreCommand('ReopenWorkItem', {}, {
    targetId: item.id, expectedVersions: { [item.id]: coreVersion(item.revision) },
  }), pool));
  assert.equal(rejectionOf(stale).code, 'version_conflict');
  assert.equal(workspace.get(item.id).raw, completed.raw);
  const reopener = scopeWith([project.id], ['domain.read', 'workitem.cancel_reopen']);
  assert.equal(committedEntity(await executeCoreCommand(contextFor(workspace, reopener, coreCommand('ReopenWorkItem', {}, { targetId: item.id }), pool))).data.status, 'in_progress');
});

test('authorized core completion needs no delivery records or planning-edit permission, including without a project', async (t: TestContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'core-adapter-completion-'));
  const workspace = new Workspace(root);
  const pool = unitSqlPool();
  t.after(async () => { await workspace.close(); await pool.end(); await rm(root, { recursive: true, force: true }); });
  await workspace.init();
  const project = await workspace.createEntity({ entity: 'project', title: 'Completion scope', status: 'active' });
  const scope = scopeWith(null, ['domain.read', 'workitem.complete']);
  for (const projectId of [project.id, null]) {
    const item = await workspace.create({ title: 'Complete directly', status: 'in_progress', ...(projectId ? { project: projectId } : {}) });
    const completed = committedEntity(await executeCoreCommand(contextFor(workspace, scope, coreCommand('CompleteWorkItem', {}, { targetId: item.id }), pool)));
    assert.equal(completed.data.status, 'done');
    assert.equal(completed.projectId, projectId);
    assert.equal(workspace.get(item.id).entity.status, 'done');
  }
});

test('milestone commands map criteria, assignment and achievement states', async (t: TestContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'core-adapter-milestone-'));
  const workspace = new Workspace(root);
  const pool = unitSqlPool();
  t.after(async () => { await workspace.close(); await pool.end(); await rm(root, { recursive: true, force: true }); });
  await workspace.init();
  const scope = scopeWith();
  const project = committedEntity(await executeCoreCommand(contextFor(workspace, scope, coreCommand('CreateProject', { name: 'P', goal: 'G', ownerId: null, completionCriteria: [] }), pool)));
  const item = committedEntity(await executeCoreCommand(contextFor(workspace, scope, coreCommand('CreateWorkItem', { title: 'Task', description: '', acceptanceCriteria: [], priority: null }, { projectId: project.id }), pool)));

  const milestone = committedEntity(await executeCoreCommand(contextFor(workspace, scope, coreCommand('CreateMilestone', {
    title: 'M1', criteria: ['first', 'second'], targetDate: '2026-12-01',
  }, { projectId: project.id }), pool)));
  assert.equal(milestone.data.name, 'M1');
  assert.equal(milestone.data.targetDate, '2026-12-01');
  assert.equal(milestone.data.status, 'planned');
  assert.equal(workspace.get(milestone.id).entity.checklist.length, 2);

  const assigned = committedEntity(await executeCoreCommand(contextFor(workspace, scope, coreCommand('AssignMilestone', { milestoneId: milestone.id }, { targetId: item.id }), pool)));
  assert.equal(assigned.data.milestoneId, milestone.id);
  const unassigned = committedEntity(await executeCoreCommand(contextFor(workspace, scope, coreCommand('UnassignMilestone', { milestoneId: milestone.id }, { targetId: item.id }), pool)));
  assert.equal(unassigned.data.milestoneId, null);
  assert.equal(committedEntity(await executeCoreCommand(contextFor(workspace, scope, coreCommand('AchieveMilestone', { reason: 'done', criteriaChecks: [] }, { targetId: milestone.id }), pool))).data.status, 'achieved');
  assert.equal(committedEntity(await executeCoreCommand(contextFor(workspace, scope, coreCommand('ReopenMilestone', { reason: 'more' }, { targetId: milestone.id }), pool))).data.status, 'planned');
  assert.equal(committedEntity(await executeCoreCommand(contextFor(workspace, scope, coreCommand('CancelMilestone', { reason: 'drop' }, { targetId: milestone.id }), pool))).data.status, 'cancelled');
});

test('scope and capability guards reject without throwing across the route', async (t: TestContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'core-adapter-scope-'));
  const workspace = new Workspace(root);
  const pool = unitSqlPool();
  t.after(async () => { await workspace.close(); await pool.end(); await rm(root, { recursive: true, force: true }); });
  await workspace.init();

  const project = committedEntity(await executeCoreCommand(contextFor(workspace, scopeWith(), coreCommand('CreateProject', { name: 'P', goal: 'G', ownerId: null, completionCriteria: [] }), pool)));
  const restricted = scopeWith(['OTHER-1']);
  assert.throws(() => readCoreEntity(workspace, restricted, project.id), (error: unknown) => error instanceof DomainError && error.status === 404);
  assert.deepEqual((await listCoreEntities(workspace, restricted, { kind: 'project' })).items, []);
  const forbidden = await executeCoreCommand(contextFor(workspace, scopeWith(null, ['domain.read']), coreCommand('ActivateProject', {}, { targetId: project.id }), pool));
  assert.equal(forbidden.status, 'rejected');
  assert.equal(forbidden.status === 'rejected' ? forbidden.error?.code ?? null : null, 'permission_denied');

  const nonAdmin = scopeWith(['PRJ-999']);
  const createForbidden = await executeCoreCommand(contextFor(workspace, nonAdmin, coreCommand('CreateProject', { name: 'X', goal: '', ownerId: null, completionCriteria: [] }), pool));
  assert.equal(createForbidden.status, 'rejected');
  assert.equal(createForbidden.status === 'rejected' ? createForbidden.httpStatus : null, 403);

  const read = readCoreEntity(workspace, scopeWith([project.id]), project.id);
  assert.equal(read.id, project.id);
  assert.equal(read.workspaceId, workspaceId);
  assert.equal(read.version, coreVersion(workspace.get(project.id).revision));
  assert.equal((await listCoreEntities(workspace, scopeWith([project.id]), { kind: 'project' })).cursor, '1');
});

test('DuplicateProject requires workspace planning access, validates source versions, and returns the stable native task mapping', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pm-copy-adapter-'));
  const workspace = new Workspace(root), pool = unitSqlPool();
  t.after(async () => { await workspace.close(); await pool.end(); await rm(root, { recursive: true, force: true }); });
  await workspace.init();
  const project = await workspace.createEntity({ entity: 'project', title: 'Copy source' });
  const task = await workspace.create({ project: project.id, title: 'Source task' });
  for (const scope of [scopeWith([project.id]), scopeWith(null, ['domain.read'])]) {
    const receipt = await executeCoreCommand(contextFor(workspace, scope, coreCommand('DuplicateProject', { name: 'Denied', includeTasks: true }, { targetId: project.id, projectId: project.id }), pool));
    assert.equal(rejectionOf(receipt).code, 'permission_denied');
    assert.equal(workspace.snapshot().files.filter(record => record.entity.entity === 'project').length, 1);
  }
  const stale = await executeCoreCommand(contextFor(workspace, scopeWith(), coreCommand('DuplicateProject', { name: 'Stale', includeTasks: true }, { targetId: project.id, expectedVersions: { [project.id]: coreVersion(project.revision) + 1 } }), pool));
  assert.equal(rejectionOf(stale).code, 'version_conflict');
  const command = coreCommand('DuplicateProject', { name: 'Independent', includeTasks: true }, { targetId: project.id, projectId: project.id });
  const receipt = await executeCoreCommand(contextFor(workspace, scopeWith(), command, pool));
  assert.equal(receipt.status, 'committed');
  const copied = receipt.result as { id: string; projectId: string; taskIdMap: Record<string, string>; copiedTaskCount: number };
  assert.notEqual(copied.id, project.id); assert.equal(copied.projectId, copied.id); assert.equal(copied.copiedTaskCount, 1);
  assert.equal(workspace.get(copied.taskIdMap[task.id]!).entity.project, copied.id);
  assert.deepEqual((await executeCoreCommand(contextFor(workspace, scopeWith(), command, pool))).result, copied);
});

test('UpdateProject saves body, nullable date and safe appearance in one revision without changing omitted metadata', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pm-project-edit-adapter-'));
  const workspace = new Workspace(root), pool = unitSqlPool();
  t.after(async () => { await workspace.close(); await pool.end(); await rm(root, { recursive: true, force: true }); });
  await workspace.init();
  const project = await workspace.createEntity({ entity: 'project', title: 'Before', goal: 'Keep goal', body: 'Before body', 'x-pm-completion-criteria': ['Keep criterion'] });
  const payload = { name: 'After', goal: 'Keep goal', ownerId: null, completionCriteria: ['Keep criterion'], description: 'After body\\n\\n- [ ] Keep content criterion', dueDate: '2026-11-12', icon: 'layers', color: '#Ab1234' };
  const edited = committedEntity(await executeCoreCommand(contextFor(workspace, scopeWith(), coreCommand('UpdateProject', payload, { targetId: project.id }), pool)));
  assert.equal(edited.data.description, payload.description); assert.equal(edited.data.icon, 'layers'); assert.equal(edited.data.color, '#Ab1234');
  assert.equal(workspace.get(project.id).entity.due, '2026-11-12'); assert.equal(workspace.get(project.id).entity.goal, 'Keep goal');
  const cleared = committedEntity(await executeCoreCommand(contextFor(workspace, scopeWith(), coreCommand('UpdateProject', { name: 'After', goal: 'Keep goal', ownerId: null, completionCriteria: ['Keep criterion'], dueDate: null, icon: null, color: null }, { targetId: project.id }), pool)));
  assert.equal(cleared.data.description, payload.description); assert.equal(cleared.data.dueDate, null); assert.equal(cleared.data.icon, null); assert.equal(cleared.data.color, null);
  const invalid = await executeCoreCommand(contextFor(workspace, scopeWith(), coreCommand('UpdateProject', { ...payload, icon: '../unsafe' }, { targetId: project.id }), pool));
  assert.equal(rejectionOf(invalid).code, 'validation_failed');
});
