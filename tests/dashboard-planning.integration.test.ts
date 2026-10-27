import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Command, Entity } from '../packages/domain/src/core.ts';
import type { PlanningDashboard } from '../packages/domain/src/dashboard-planning.ts';
import type { FileRecord } from '../packages/pm-schema/index.ts';
import { createMarkdown, inspectFrontmatter, patchMarkdown } from '../packages/pm-markdown/index.ts';
import { createDashboardFixture, dashboardDatabaseUrl, type DashboardFixture } from './dashboard-fixture.ts';

async function project(fixture: DashboardFixture, name: string): Promise<Entity> {
  return fixture.command('CreateProject', { name, goal: 'A real project definition', ownerId: fixture.owner.id, completionCriteria: ['Delivered'] });
}
async function task(fixture: DashboardFixture, projectId: string, title: string): Promise<Entity> {
  return fixture.command('CreateWorkItem', { title, description: 'Source description', acceptanceCriteria: [{ id: randomUUID(), text: 'Measurable criterion' }], assigneeId: null, priority: 'normal' }, { extra: { projectId } });
}
function update(commandType: string, entity: Entity, payload: Record<string, unknown>): Command {
  return { commandId: randomUUID(), commandType, targetId: entity.id, projectId: entity.kind === 'project' ? entity.id : entity.projectId!, expectedVersions: { [entity.id]: entity.version }, payload };
}

describe('dashboard planning real HTTP, Markdown and PostgreSQL receipt integration', { skip: !dashboardDatabaseUrl }, () => {
  test('a newly malformed source with no previous valid record makes planning inputs unavailable', async t => {
    const fixture = await createDashboardFixture(); t.after(() => fixture.close());
    assert.deepEqual((await fixture.read<PlanningDashboard>('planning')).tasks, [], 'initialize the cached workspace before adding external sources');
    const root = join(fixture.coreRoot, fixture.workspaceId);
    await mkdir(join(root, 'projects'), { recursive: true });
    await mkdir(join(root, 'work-items'), { recursive: true });
    await writeFile(join(root, 'projects', 'PRJ-001.md'), createMarkdown({ id: 'PRJ-001', entity: 'project', title: 'Actual project' }));
    await writeFile(join(root, 'work-items', 'TASK-001.md'), createMarkdown({ id: 'TASK-001', entity: 'work_item', project: 'PRJ-001', title: 'Known task', estimated_duration_days: 2 }));
    await writeFile(join(root, 'work-items', 'TASK-999.md'), '---\nschema: pm/v1\nid: TASK-999\nentity: work_item\nproject: PRJ-001\nestimated_duration_days: [\n---\n# Broken new task\n');
    const response = await fixture.request<{ error: { code: string } }>(`/api/v1/workspaces/${fixture.workspaceId}/dashboard/planning`);
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'core_inputs_unavailable');
    const endpoint = `/api/v1/workspaces/${fixture.workspaceId}/core/files/TASK-001`;
    const initial = await fixture.request<FileRecord>(endpoint);
    assert.equal(initial.status, 200, JSON.stringify(initial.body));
    const malformed = initial.body.raw.replace('estimated_duration_days: 2', 'estimated_duration_days: [');
    await writeFile(join(root, initial.body.path), malformed);
    const invalid = await fixture.request<FileRecord>(endpoint);
    assert.equal(invalid.status, 200, JSON.stringify(invalid.body));
    assert.equal(invalid.body.stale, true);
    assert.equal(invalid.body.raw, malformed, 'invalid sources expose current disk bytes, not cached valid raw');
    const mutation = await fixture.request(`/api/v1/workspaces/${fixture.workspaceId}/core/entities/TASK-001`, {
      method: 'PATCH', body: { revision: invalid.body.revision, changes: { estimated_duration_days: 4 } },
    });
    assert.equal(mutation.status, 409, JSON.stringify(mutation.body));
    const staleRepair = await fixture.request(endpoint, { method: 'PUT', body: { revision: initial.body.revision, raw: initial.body.raw } });
    assert.equal(staleRepair.status, 409, JSON.stringify(staleRepair.body));
    assert.equal(await readFile(join(root, initial.body.path), 'utf8'), malformed, 'rejected writes preserve the authoritative invalid source');
    const repaired = await fixture.request<FileRecord>(endpoint, { method: 'PUT', body: { revision: invalid.body.revision, raw: initial.body.raw } });
    assert.equal(repaired.status, 200, JSON.stringify(repaired.body));
    assert.equal(repaired.body.stale, undefined);
    const stillUnavailable = await fixture.request<{ error: { code: string } }>(`/api/v1/workspaces/${fixture.workspaceId}/dashboard/planning`);
    assert.equal(stillUnavailable.status, 409, 'repairing one source cannot hide the other malformed new task');
    assert.equal(stillUnavailable.body.error.code, 'core_inputs_unavailable');
  });

  test('formal project DAG authorizes every endpoint and receipt after scope revocation', async t => {
    const fixture = await createDashboardFixture(); t.after(() => fixture.close());
    const first = await project(fixture, 'Visible project'); const second = await project(fixture, 'Hidden prerequisite');
    const member = await fixture.member('Graph editor');
    const grant = await fixture.command<{ version: number }>('SetWorkspaceMember', { userId: member.user.id, capabilities: ['domain.read', 'planning.edit'], projectIds: [first.id, second.id] });
    const command = update('SetProjectDependencies', first, { dependsOn: [second.id] });
    const result = await fixture.send(command, { cookie: member.cookie });
    assert.equal(result.body.status, 'committed', JSON.stringify(result.body));
    let changed = result.body.result as Entity;
    assert.equal((await fixture.send(command, { cookie: member.cookie })).body.status, 'committed');
    const replayScope = await fixture.pool.query<{ scope_project_ids: string[] }>('SELECT scope_project_ids FROM command_receipts WHERE workspace_id=$1 AND actor_id=$2 AND command_id=$3', [fixture.workspaceId, member.user.id, command.commandId]);
    assert.deepEqual(replayScope.rows[0]!.scope_project_ids.sort(), [first.id, second.id].sort());
    const removal = update('SetProjectDependencies', changed, { dependsOn: [] });
    const removed = await fixture.send(removal, { cookie: member.cookie });
    assert.equal(removed.body.status, 'committed', JSON.stringify(removed.body));
    const removedScope = await fixture.pool.query<{ scope_project_ids: string[] }>('SELECT scope_project_ids FROM command_receipts WHERE workspace_id=$1 AND actor_id=$2 AND command_id=$3', [fixture.workspaceId, member.user.id, removal.commandId]);
    assert.deepEqual(removedScope.rows[0]!.scope_project_ids.sort(), [first.id, second.id].sort(), 'removed endpoints remain receipt-scoped');
    const restored = await fixture.send(update('SetProjectDependencies', removed.body.result as Entity, { dependsOn: [second.id] }), { cookie: member.cookie });
    assert.equal(restored.body.status, 'committed', JSON.stringify(restored.body));
    changed = restored.body.result as Entity;
    const cycle = await fixture.send(update('SetProjectDependencies', second, { dependsOn: [first.id] }));
    assert.equal(cycle.body.status, 'rejected');
    assert.equal(cycle.status, 422);
    assert.equal((await fixture.send(update('SetProjectDependencies', first, { dependsOn: [] }))).body.error?.code, 'version_conflict');
    const raw = await fixture.request<FileRecord>(`/api/v1/workspaces/${fixture.workspaceId}/core/files/${second.id}`);
    const rawCycle = await fixture.request(`/api/v1/workspaces/${fixture.workspaceId}/core/files/${second.id}`, { method: 'PUT', body: { revision: raw.body.revision, raw: patchMarkdown(raw.body.raw, { depends_on: [first.id] }) } });
    assert.equal(rawCycle.status, 422);
    await fixture.command('SetWorkspaceMember', { userId: member.user.id, capabilities: ['domain.read', 'planning.edit'], projectIds: [first.id] }, { extra: { expectedVersions: { [member.user.id]: grant.version } } });
    const planning = await fixture.read<PlanningDashboard>('planning', { cookie: member.cookie });
    assert.deepEqual(planning.projects.map(item => item.id), [first.id]);
    assert.equal(planning.projects[0]!.hasUnavailableDependencies, true);
    assert.deepEqual(planning.projects[0]!.dependsOn, []);
    assert.ok(!JSON.stringify(planning).includes(second.id));
    const denied = await fixture.send(update('SetProjectDependencies', changed, { dependsOn: [] }), { cookie: member.cookie });
    assert.equal(denied.status, 404);
    const deniedReceipt = await fixture.request(`/api/v1/workspaces/${fixture.workspaceId}/commands/${command.commandId}`, { cookie: member.cookie });
    assert.equal(deniedReceipt.status, 404);
    const rawFirst = await fixture.request<FileRecord>(`/api/v1/workspaces/${fixture.workspaceId}/core/files/${first.id}`);
    const rawDenied = await fixture.request(`/api/v1/workspaces/${fixture.workspaceId}/core/entities/${first.id}`, { method: 'PATCH', cookie: member.cookie, body: { revision: rawFirst.body.revision, changes: { depends_on: [] } } });
    assert.equal(rawDenied.status, 404, 'raw patches must authorize removed hidden relation endpoints');
  });

  test('duration CAS and cross-project hidden blockers return genuine unavailability', async t => {
    const fixture = await createDashboardFixture(); t.after(() => fixture.close());
    const first = await project(fixture, 'Analysis'); const second = await project(fixture, 'External task project');
    let dependent = await task(fixture, first.id, 'Dependent'); let prerequisite = await task(fixture, second.id, 'Prerequisite');
    let dashboard = await fixture.read<PlanningDashboard>('planning');
    assert.equal(dashboard.projects.find(item => item.id === first.id)!.criticalPath.status, 'unavailable');
    prerequisite = await fixture.command('UpdateTaskDuration', { estimatedDurationDays: 3 }, { extra: { targetId: prerequisite.id, projectId: second.id, expectedVersions: { [prerequisite.id]: prerequisite.version } } });
    const stale = dependent;
    dependent = await fixture.command('UpdateTaskDuration', { estimatedDurationDays: 2 }, { extra: { targetId: dependent.id, projectId: first.id, expectedVersions: { [dependent.id]: dependent.version } } });
    const staleResult = await fixture.send(update('UpdateTaskDuration', stale, { estimatedDurationDays: 40 }));
    assert.equal(staleResult.body.error?.code, 'version_conflict');
    dependent = await fixture.command('AddDependency', { prerequisiteId: prerequisite.id }, { extra: { targetId: dependent.id, projectId: first.id, expectedVersions: { [dependent.id]: dependent.version } } });
    dashboard = await fixture.read<PlanningDashboard>('planning');
    const complete = dashboard.projects.find(item => item.id === first.id)!.criticalPath;
    assert.equal(complete.status, 'available');
    if (complete.status === 'available') { assert.equal(complete.durationDays, 5); assert.deepEqual(complete.criticalPaths, [[prerequisite.id, dependent.id]]); }
    const member = await fixture.member('Restricted analyst');
    await fixture.command('SetWorkspaceMember', { userId: member.user.id, capabilities: ['domain.read', 'planning.edit'], projectIds: [first.id] });
    const scoped = await fixture.read<PlanningDashboard>('planning', { cookie: member.cookie });
    const unavailable = scoped.projects[0]!.criticalPath;
    assert.equal(unavailable.status, 'unavailable');
    assert.ok(!JSON.stringify(unavailable).includes(prerequisite.id));
    const raw = await fixture.request<FileRecord>(`/api/v1/workspaces/${fixture.workspaceId}/core/files/${dependent.id}`);
    const invalid = await fixture.request(`/api/v1/workspaces/${fixture.workspaceId}/core/files/${dependent.id}`, { method: 'PUT', body: { revision: raw.body.revision, raw: raw.body.raw.replace('estimated_duration_days: 2', 'estimated_duration_days: -2') } });
    assert.equal(invalid.status, 422);
    const noEdit = await fixture.member('Read-only analyst');
    await fixture.command('SetWorkspaceMember', { userId: noEdit.user.id, capabilities: ['domain.read'], projectIds: [first.id] });
    assert.equal((await fixture.send(update('UpdateTaskDuration', dependent, { estimatedDurationDays: 9 }), { cookie: noEdit.cookie })).status, 403);
    await fixture.command('UpdateTaskDuration', { estimatedDurationDays: null }, { extra: { targetId: dependent.id, projectId: first.id, expectedVersions: { [dependent.id]: dependent.version } } });
    const cleared = await fixture.read<PlanningDashboard>('planning');
    assert.equal(cleared.tasks.find(item => item.id === dependent.id)!.estimatedDurationDays, null);
    assert.equal(cleared.projects.find(item => item.id === first.id)!.criticalPath.status, 'unavailable');
  });

  test('strict milestone rescheduling preserves exact prose/checklists and rejects stale writers', async t => {
    const fixture = await createDashboardFixture(); t.after(() => fixture.close());
    const scope = await project(fixture, 'Milestones');
    const milestone = await fixture.command('CreateMilestone', { title: 'Launch', criteria: ['Actual acceptance criterion'], targetDate: '2026-10-20' }, { extra: { projectId: scope.id } });
    const endpoint = `/api/v1/workspaces/${fixture.workspaceId}/core/files/${milestone.id}`;
    const initial = await fixture.request<FileRecord>(endpoint);
    const prose = `${initial.body.raw}\n## Delivery notes\n\nPreserve **rich prose** and trailing spaces.  \n\n\`\`\`text\n- [ ] not a real criterion\n\`\`\`\n`;
    const saved = await fixture.request<FileRecord>(endpoint, { method: 'PUT', body: { raw: prose, revision: initial.body.revision } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const current = (await fixture.request<Entity>(`/api/v1/workspaces/${fixture.workspaceId}/entities/${milestone.id}`)).body;
    const changed = await fixture.command('UpdateMilestone', { targetDate: '2026-11-03' }, { extra: { targetId: milestone.id, projectId: scope.id, expectedVersions: { [milestone.id]: current.version } } });
    const after = await fixture.request<FileRecord>(endpoint);
    assert.equal(inspectFrontmatter(after.body.raw).body, inspectFrontmatter(prose).body);
    assert.equal(after.body.entity.due, '2026-11-03');
    const stale = await fixture.send(update('UpdateMilestone', current, { targetDate: '2026-12-01' }));
    assert.equal(stale.body.error?.code, 'version_conflict');
    for (const payload of [{ targetDate: '2026-02-30' }, { targetDate: null, body: 'overwrite' }, {}]) {
      const invalid = await fixture.send(update('UpdateMilestone', changed, payload));
      assert.equal(invalid.status, 400, JSON.stringify(invalid.body));
    }
    await fixture.command('UpdateMilestone', { targetDate: null }, { extra: { targetId: changed.id, projectId: scope.id, expectedVersions: { [changed.id]: changed.version } } });
    const cleared = await fixture.request<FileRecord>(endpoint);
    assert.equal(cleared.body.entity.due, undefined);
    assert.equal(inspectFrontmatter(cleared.body.raw).body, inspectFrontmatter(prose).body);
    assert.equal((await fixture.read<PlanningDashboard>('planning')).milestones[0]!.targetDate, null);
  });
});
