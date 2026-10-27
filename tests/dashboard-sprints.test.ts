import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { createDashboardFixture, dashboardDatabaseUrl, type DashboardFixture } from './dashboard-fixture.ts';
import type { Command, Entity } from '../packages/domain/src/core.ts';
import type { SprintsDashboard, SprintSummary } from '../packages/domain/src/dashboard-sprints.ts';
import type { FileRecord } from '../packages/pm-schema/index.ts';
import { patchMarkdown } from '../packages/pm-markdown/index.ts';
import { defaultConfiguration } from '../packages/pm-schema/index.ts';

const exec = promisify(execFile);

async function project(fixture: DashboardFixture, name: string): Promise<Entity> {
  return fixture.command('CreateProject', { name, goal: '', ownerId: null, completionCriteria: [] });
}

async function task(fixture: DashboardFixture, projectId: string, title: string): Promise<Entity> {
  return fixture.command('CreateWorkItem', { title, description: 'Native task body stays authoritative.', acceptanceCriteria: [] }, { extra: { projectId } });
}

async function sprint(fixture: DashboardFixture, projectId: string, title: string): Promise<SprintSummary> {
  return fixture.command<SprintSummary>('CreateSprint', { projectId, title, startDate: '2026-10-01', dueDate: '2026-10-14' }, { extra: { projectId } });
}

function target(item: { id: string; version: number; projectId: string | null }): Pick<Command, 'targetId' | 'projectId' | 'expectedVersions'> {
  return { targetId: item.id, ...(item.projectId ? { projectId: item.projectId } : {}), expectedVersions: { [item.id]: item.version } };
}

function change(type: string, item: { id: string; version: number; projectId: string | null }, payload: Record<string, unknown>): Command {
  return { commandId: randomUUID(), commandType: type, ...target(item), payload };
}

describe('dashboard sprint real HTTP and CLI behavior', { skip: !dashboardDatabaseUrl }, () => {
  test('native CreateSprint replay, strict payloads, date clear and lifecycle preserve task/project state', async t => {
    const fixture = await createDashboardFixture();
    t.after(() => fixture.close());
    const parent = await project(fixture, 'Sprint API project');
    const create: Command = { commandId: randomUUID(), commandType: 'CreateSprint', projectId: parent.id, payload: { projectId: parent.id, title: 'API sprint', startDate: '2026-10-01', dueDate: '2026-10-14' } };
    const first = await fixture.send(create);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const created = first.body.result as SprintSummary;
    assert.match(created.id, /^CYC-\d+$/);
    const before = await fixture.read<SprintsDashboard>('sprints');
    const replay = await fixture.send(create);
    assert.deepEqual(replay.body, first.body);
    assert.equal((await fixture.read<SprintsDashboard>('sprints')).history.observations.length, before.history.observations.length);
    const invalid = await fixture.send({ ...create, commandId: randomUUID(), payload: { ...create.payload, taskIds: ['TASK-999'] } });
    assert.equal(invalid.status, 400);
    const member = await task(fixture, parent.id, 'Lifecycle must not complete this task');
    await fixture.command('SetTaskSprint', { workItemId: member.id, sprintId: created.id }, { extra: { targetId: member.id, projectId: parent.id, expectedVersions: { [member.id]: member.version } } });
    const source = await fixture.request<FileRecord>(`/api/v1/workspaces/${fixture.workspaceId}/core/files/${created.id}`);
    assert.equal(source.status, 200);
    const raw = source.body.raw + '\nSprint body and acceptance context must survive date editing.\n';
    const rawSaved = await fixture.request<FileRecord>(`/api/v1/workspaces/${fixture.workspaceId}/core/files/${created.id}`, { method: 'PUT', body: { raw, revision: source.body.revision } });
    assert.equal(rawSaved.status, 200, JSON.stringify(rawSaved.body));
    const current = (await fixture.read<SprintsDashboard>('sprints')).sprints.find(row => row.id === created.id)!;
    const updated = await fixture.command<SprintSummary>('UpdateSprint', { sprintId: created.id, startDate: null, dueDate: '2026-10-20' }, { extra: target(current) });
    assert.equal(updated.startDate, null);
    assert.equal(updated.dueDate, '2026-10-20');
    assert.equal(updated.title, 'API sprint');
    const savedSource = await fixture.request<FileRecord>(`/api/v1/workspaces/${fixture.workspaceId}/core/files/${created.id}`);
    assert.match(savedSource.body.raw, /Sprint body and acceptance context must survive date editing\./);
    const start = await fixture.command<SprintSummary>('StartSprint', { sprintId: created.id }, { extra: target(updated) });
    assert.equal(start.category, 'started');
    assert.deepEqual((await fixture.read<SprintsDashboard>('sprints')).currentSprintIds, [created.id]);
    const complete = await fixture.command<SprintSummary>('CompleteSprint', { sprintId: created.id }, { extra: target(start) });
    assert.equal(complete.category, 'completed');
    const after = await fixture.read<SprintsDashboard>('sprints');
    assert.equal(after.tasks.find(row => row.id === member.id)?.status, 'todo');
    assert.deepEqual(after.currentSprintIds, []);
    const parentRead = await fixture.request<Entity>(`/api/v1/workspaces/${fixture.workspaceId}/entities/${parent.id}`);
    assert.equal(parentRead.body.data.status, 'planning');
  });

  test('single-task CAS has one winner; stale source edits and cross-project membership are rejected', async t => {
    const fixture = await createDashboardFixture();
    t.after(() => fixture.close());
    const parent = await project(fixture, 'CAS project');
    const other = await project(fixture, 'Other project');
    const a = await sprint(fixture, parent.id, 'Sprint A');
    const b = await sprint(fixture, parent.id, 'Sprint B');
    const foreign = await sprint(fixture, other.id, 'Foreign sprint');
    const member = await task(fixture, parent.id, 'CAS task');
    const commands = [a, b].map(row => change('SetTaskSprint', member, { workItemId: member.id, sprintId: row.id }));
    const results = await Promise.all(commands.map(command => fixture.send(command)));
    assert.equal(results.filter(result => result.body.status === 'committed').length, 1);
    assert.equal(results.filter(result => result.body.status === 'rejected' && result.body.error?.code === 'version_conflict').length, 1);
    const read = await fixture.read<SprintsDashboard>('sprints');
    const currentTask = read.tasks.find(row => row.id === member.id)!;
    const wrongProject = await fixture.send(change('SetTaskSprint', currentTask, { workItemId: member.id, sprintId: foreign.id }));
    assert.equal(wrongProject.body.status, 'rejected');
    assert.equal(wrongProject.body.error?.code, 'project_mismatch');
    const source = await fixture.request<FileRecord>(`/api/v1/workspaces/${fixture.workspaceId}/core/files/${a.id}`);
    const rawSaved = await fixture.request<FileRecord>(`/api/v1/workspaces/${fixture.workspaceId}/core/files/${a.id}`, { method: 'PUT', body: { raw: patchMarkdown(source.body.raw, { title: 'Native editor title' }), revision: source.body.revision } });
    assert.equal(rawSaved.status, 200);
    const stale = await fixture.send(change('UpdateSprint', a, { sprintId: a.id, title: 'Stale dashboard title' }));
    assert.equal(stale.body.error?.code, 'version_conflict');
    assert.equal((await fixture.read<SprintsDashboard>('sprints')).sprints.find(row => row.id === a.id)?.title, 'Native editor title');
    const winner = results.find(result => result.body.status === 'committed')!;
    const receipt = await fixture.send(commands[results.indexOf(winner)]!);
    assert.deepEqual(receipt.body, winner.body);
  });

  test('real CLI cycle/task edits feed durable observations and preserve same-object membership', async t => {
    const fixture = await createDashboardFixture();
    t.after(() => fixture.close());
    const parent = await project(fixture, 'CLI sprint project');
    const member = await task(fixture, parent.id, 'CLI-assigned task');
    const env = { ...process.env, PM_API_URL: fixture.origin, PM_WORKSPACE_ID: fixture.workspaceId, PM_SESSION_TOKEN: '', PM_EMAIL: fixture.owner.email, PM_PASSWORD: 'isolated-dashboard-test-password', PM_ACCESS_FILE: path.join(fixture.coreRoot, 'unused-test-access-file') };
    const created = await exec(process.execPath, ['packages/pm-cli/index.ts', 'entity', 'create', '--entity', 'cycle', '--title', 'CLI native cycle', '--project', parent.id, '--start', '2026-10-01', '--due', '2026-10-14'], { cwd: process.cwd(), env });
    const native = JSON.parse(created.stdout) as FileRecord;
    await exec(process.execPath, ['packages/pm-cli/index.ts', 'task', 'update', member.id, '--cycle', native.id], { cwd: process.cwd(), env });
    await exec(process.execPath, ['packages/pm-cli/index.ts', 'task', 'update', member.id, '--status', 'done'], { cwd: process.cwd(), env });
    const dashboard = await fixture.read<SprintsDashboard>('sprints');
    const cycle = dashboard.sprints.find(row => row.id === native.id)!;
    assert.equal(cycle.title, 'CLI native cycle');
    assert.deepEqual(cycle.taskIds, [member.id]);
    assert.equal(cycle.completed, 1);
    assert.equal(dashboard.history.observations.at(-1)?.source, 'core_command');
    assert.equal(dashboard.history.observations.at(-1)?.sprints.find(row => row.id === native.id)?.completed, 1);
    assert.equal((await fixture.pool.query('SELECT count(*)::integer AS count FROM entities WHERE workspace_id=$1 AND kind::text = $2', [fixture.workspaceId, 'cycle'])).rows[0]?.count, 0);
  });

  test('named sprint lifecycle uses configured native workflow categories and transitions', async t => {
    const fixture = await createDashboardFixture();
    t.after(() => fixture.close());
    const configuration = structuredClone(defaultConfiguration);
    configuration.workflows.cycle = {
      initial: 'queued',
      states: [{ id: 'queued', label: 'Queued', category: 'unstarted' }, { id: 'running', label: 'Running', category: 'started' }, { id: 'shipped', label: 'Shipped', category: 'completed' }],
      transitions: [{ from: 'queued', to: 'running' }, { from: 'running', to: 'shipped' }, { from: 'shipped', to: 'queued' }],
    };
    const configured = await fixture.request(`/api/v1/workspaces/${fixture.workspaceId}/core/config`, { method: 'PUT', body: { config: configuration, revision: 'absent' } });
    assert.equal(configured.status, 200, JSON.stringify(configured.body));
    const parent = await project(fixture, 'Custom lifecycle project');
    const queued = await sprint(fixture, parent.id, 'Custom cycle');
    assert.equal(queued.status, 'queued');
    const running = await fixture.command<SprintSummary>('StartSprint', { sprintId: queued.id }, { extra: target(queued) });
    assert.equal(running.status, 'running');
    const shipped = await fixture.command<SprintSummary>('CompleteSprint', { sprintId: running.id }, { extra: target(running) });
    assert.equal(shipped.status, 'shipped');
    const reopened = await fixture.command<SprintSummary>('ReopenSprint', { sprintId: shipped.id }, { extra: target(shipped) });
    assert.equal(reopened.status, 'queued');
    const invalidCancel = await fixture.send(change('CancelSprint', reopened, { sprintId: reopened.id }));
    assert.equal(invalidCancel.body.status, 'rejected');
    assert.equal(invalidCancel.body.error?.code, 'invalid_transition');
  });

  test('deleted members retain historical counts while members moved out of scope are redacted', async t => {
    const fixture = await createDashboardFixture();
    t.after(() => fixture.close());
    const a = await project(fixture, 'Historical member project');
    const b = await project(fixture, 'Moved member project');
    const cycle = await sprint(fixture, a.id, 'Historical cycle');
    const deleted = await task(fixture, a.id, 'Deleted member');
    const moved = await task(fixture, a.id, 'Later hidden moved member');
    for (const member of [deleted, moved]) await fixture.command('SetTaskSprint', { workItemId: member.id, sprintId: cycle.id }, { extra: target(member) });
    const before = await fixture.read<SprintsDashboard>('sprints');
    assert.equal(before.sprints.find(row => row.id === cycle.id)?.total, 2);
    const deletedSource = await fixture.request<FileRecord>(`/api/v1/workspaces/${fixture.workspaceId}/core/files/${deleted.id}`);
    const archived = await fixture.request<FileRecord>(`/api/v1/workspaces/${fixture.workspaceId}/core/entities/${deleted.id}/archive`, { method: 'POST', body: { revision: deletedSource.body.revision } });
    assert.equal(archived.status, 200, JSON.stringify(archived.body));
    const removed = await fixture.request(`/api/v1/workspaces/${fixture.workspaceId}/core/entities/${deleted.id}`, { method: 'DELETE', body: { revision: archived.body.revision } });
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    const afterDeletion = await fixture.read<SprintsDashboard>('sprints');
    assert.deepEqual(afterDeletion.history.observations.slice(0, before.history.observations.length), before.history.observations);
    const movedSource = await fixture.request<FileRecord>(`/api/v1/workspaces/${fixture.workspaceId}/core/files/${moved.id}`);
    const movedSaved = await fixture.request<FileRecord>(`/api/v1/workspaces/${fixture.workspaceId}/core/entities/${moved.id}`, { method: 'PATCH', body: { revision: movedSource.body.revision, changes: { project: b.id, cycle: null } } });
    assert.equal(movedSaved.status, 200, JSON.stringify(movedSaved.body));
    const user = await fixture.member('Historical scoped reader');
    await fixture.command('SetWorkspaceMember', { userId: user.user.id, capabilities: ['domain.read'], projectIds: [a.id] });
    const scoped = await fixture.read<SprintsDashboard>('sprints', { cookie: user.cookie });
    assert.equal(scoped.history.observations.some(observation => observation.sprints.some(row => row.taskIds.includes(deleted.id))), true);
    assert.equal(JSON.stringify(scoped).includes(moved.id), false);
    assert.equal(JSON.stringify(scoped).includes('Later hidden moved member'), false);
  });

  test('restricted members cannot read foreign sprint history or replay receipts after scope loss', async t => {
    const fixture = await createDashboardFixture();
    t.after(() => fixture.close());
    const a = await project(fixture, 'Visible project');
    const b = await project(fixture, 'Hidden project');
    await sprint(fixture, a.id, 'Visible sprint');
    const hidden = await sprint(fixture, b.id, 'Secret hidden sprint');
    const user = await fixture.member('Sprint editor');
    let membership = await fixture.command<{ id: string; version: number }>('SetWorkspaceMember', { userId: user.user.id, capabilities: ['domain.read', 'planning.edit', 'planning.lifecycle'], projectIds: null });
    const command: Command = { commandId: randomUUID(), commandType: 'UpdateSprint', targetId: hidden.id, projectId: b.id, expectedVersions: { [hidden.id]: hidden.version }, payload: { sprintId: hidden.id, title: 'Private prior-scope sprint title' } };
    assert.equal((await fixture.send(command, { cookie: user.cookie })).body.status, 'committed');
    membership = await fixture.command<{ id: string; version: number }>('SetWorkspaceMember', { userId: user.user.id, capabilities: ['domain.read', 'planning.edit', 'planning.lifecycle'], projectIds: [a.id] }, { extra: { expectedVersions: { [user.user.id]: membership.version } } });
    const restricted = await fixture.read<SprintsDashboard>('sprints', { cookie: user.cookie });
    assert.equal(restricted.sprints.every(row => row.projectId === a.id), true);
    assert.equal(JSON.stringify(restricted).includes(hidden.id), false);
    assert.equal(JSON.stringify(restricted).includes('Secret hidden sprint'), false);
    assert.equal(JSON.stringify(restricted).includes('Private prior-scope sprint title'), false);
    const replay = await fixture.request(`/api/v1/workspaces/${fixture.workspaceId}/commands/${command.commandId}`, { cookie: user.cookie });
    assert.ok(replay.status === 403 || replay.status === 404, JSON.stringify(replay.body));
    const forbidden = await fixture.send({ ...command, commandId: randomUUID() }, { cookie: user.cookie });
    assert.notEqual(forbidden.body.status, 'committed');
    await fixture.command('RevokeWorkspaceMember', { userId: user.user.id }, { extra: { expectedVersions: { [user.user.id]: membership.version } } });
    const revoked = await fixture.request(`/api/v1/workspaces/${fixture.workspaceId}/dashboard/sprints`, { cookie: user.cookie });
    assert.ok(revoked.status === 403 || revoked.status === 404, JSON.stringify(revoked.body));
  });
});
