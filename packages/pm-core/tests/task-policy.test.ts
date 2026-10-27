import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DomainError } from '../../domain/src/core.ts';
import { assertCoreTaskMutation, type CoreTaskPolicyPorts } from '../../application/src/core-task-creation.ts';
import { Workspace, type WorkspaceMutationGuard } from '../index.ts';

// Real files and the production serialization queue; injected membership is the application port seam.
test('a queued create rechecks the project after a preceding serialized project closure and consumes no ID or key on refusal', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pm-task-policy-'));
  const workspace = new Workspace(root);
  t.after(async () => { await workspace.close(); await rm(root, { recursive: true, force: true }); });
  await workspace.init();
  const project = await workspace.createEntity({ entity: 'project', title: 'Current project authority' });
  const ports: CoreTaskPolicyPorts = {
    get: id => workspace.get(id), configuration: workspace.configuration().config,
    requireCapability(capability) { assert.ok(['domain.read', 'planning.edit'].includes(capability)); },
    allowsProject: projectId => projectId === project.id,
    async requireAssignee(projectId, assigneeId) { assert.equal(projectId, project.id); assert.equal(assigneeId, undefined); },
  };
  const taskGuard: WorkspaceMutationGuard = (before, after) => assertCoreTaskMutation(ports, after, before?.entity);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const closing = workspace.patch(project.id, { status: 'completed' }, project.revision, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const key = 'queued-creation-retained-key';
  const queued = workspace.createEntity({ entity: 'work_item', project: project.id, title: 'Must use current project authority' }, key, taskGuard);
  const rejected = assert.rejects(queued, (error: unknown) => error instanceof DomainError && error.code === 'invalid_state');
  release.resolve();
  const closed = await closing;
  await rejected;
  assert.equal(workspace.items({ entity: 'work_item' }).length, 0);
  assert.equal(workspace.snapshot().files.length, 1);
  await workspace.patch(closed.id, { status: 'active' }, closed.revision);
  const created = await workspace.createEntity({ entity: 'work_item', project: project.id, title: 'Must use current project authority' }, key, taskGuard);
  assert.equal(created.id, 'TASK-001');
  assert.equal((await readdir(path.join(root, 'work-items'))).length, 1);
  const replay = await workspace.createEntity({ entity: 'work_item', project: project.id, title: 'Must use current project authority' }, key, taskGuard);
  assert.equal(replay.id, created.id);
  assert.equal(replay.revision, created.revision);
});

test('a queued assignment uses current port authority and rejected source/property writes leave the exact Markdown revision intact', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pm-task-assignment-policy-'));
  const workspace = new Workspace(root);
  t.after(async () => { await workspace.close(); await rm(root, { recursive: true, force: true }); });
  await workspace.init();
  const project = await workspace.createEntity({ entity: 'project', title: 'Membership authority' });
  const task = await workspace.createEntity({ entity: 'work_item', project: project.id, title: 'Unassigned original', body: 'Keep **this body**.' });
  let eligible = true;
  const ports: CoreTaskPolicyPorts = {
    get: id => workspace.get(id), configuration: workspace.configuration().config,
    requireCapability(capability) { assert.ok(['domain.read', 'planning.edit'].includes(capability)); },
    allowsProject: projectId => projectId === project.id,
    async requireAssignee(_projectId, assigneeId) {
      if (assigneeId && !eligible) throw new DomainError('workspace_member_required', 'Current member authority rejects this assignment', 409);
    },
  };
  const guard: WorkspaceMutationGuard = (before, after) => assertCoreTaskMutation(ports, after, before?.entity);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const preceding = workspace.patch(project.id, { title: 'Preceding edit' }, project.revision, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const queued = workspace.patch(task.id, { assignee: '11111111-1111-4111-8111-111111111111' }, task.revision, guard);
  const rejected = assert.rejects(queued, (error: unknown) => error instanceof DomainError && error.code === 'workspace_member_required');
  eligible = false;
  release.resolve();
  await preceding;
  await rejected;
  assert.equal(workspace.get(task.id).raw, task.raw);
  assert.equal(workspace.get(task.id).revision, task.revision);
  const source = task.raw.replace('entity: work_item', 'entity: work_item\nassignee: 11111111-1111-4111-8111-111111111111');
  await assert.rejects(workspace.save(task.id, source, task.revision, guard), (error: unknown) => error instanceof DomainError && error.code === 'workspace_member_required');
  assert.equal(workspace.get(task.id).raw, task.raw);
  assert.equal(workspace.get(task.id).revision, task.revision);
});
