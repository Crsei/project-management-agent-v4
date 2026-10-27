import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { Membership } from '../packages/application/src/access.ts';
import type { Command, Entity } from '../packages/domain/src/core.ts';
import type { DashboardRecord } from '../packages/domain/src/dashboard.ts';
import type { ProjectDirectory, ProjectTeam, ProjectTeamAssignment } from '../packages/domain/src/project-directory.ts';
import type { TeamDirectory } from '../packages/domain/src/team-directory.ts';
import { createWorkspace } from '../packages/infrastructure/src/auth.ts';
import { createDashboardFixture, dashboardDatabaseUrl } from './dashboard-fixture.ts';
import type { DashboardFixture } from './dashboard-fixture.ts';

function teamCommand(commandType: string, payload: Record<string, unknown>, team?: DashboardRecord<ProjectTeam>): Command {
  return { commandId: randomUUID(), commandType, payload, ...(team ? { targetId: team.id, expectedVersions: { [team.id]: team.version } } : {}) };
}
function assignmentCommand(project: Entity, teams: DashboardRecord<ProjectTeam>[], assignment?: DashboardRecord<ProjectTeamAssignment>): Command {
  return { commandId: randomUUID(), commandType: 'SetProjectTeams', targetId: project.id, projectId: project.id,
    expectedVersions: Object.fromEntries([project, ...teams, ...(assignment ? [assignment] : [])].map(record => [record.id, record.version])), payload: { teamIds: teams.map(team => team.id) } };
}

describe('project directory: real team organization never expands membership authority', { skip: !dashboardDatabaseUrl, timeout: 180_000 }, () => {
  let fixture: DashboardFixture;
  before(async () => { fixture = await createDashboardFixture(); });
  after(async () => { await fixture?.close(); });
  async function project(name: string): Promise<Entity> {
    return fixture.command('CreateProject', { name, goal: 'Directory authorization boundary', ownerId: fixture.owner.id, completionCriteria: ['Reviewed'] });
  }
  async function directory(cookie?: string): Promise<ProjectDirectory> {
    const response = await fixture.request<ProjectDirectory>(`/api/v1/workspaces/${fixture.workspaceId}/projects/directory`, cookie ? { cookie } : {});
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body;
  }
  async function teamsDirectory(cookie?: string): Promise<TeamDirectory> {
    const response = await fixture.request<TeamDirectory>(`/api/v1/workspaces/${fixture.workspaceId}/teams/directory`, cookie ? { cookie } : {});
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body;
  }
  async function grant(userId: string, projectIds: string[] | null, capabilities = ['domain.read'], previous?: Membership): Promise<Membership> {
    return fixture.command('SetWorkspaceMember', { userId, capabilities, projectIds }, previous ? { extra: { expectedVersions: { [userId]: previous.version } } } : {});
  }
  async function team(name: string, memberIds: string[]): Promise<DashboardRecord<ProjectTeam>> {
    return fixture.command('CreateProjectTeam', { name, memberIds });
  }

  it('returns only minimal lawful identities and associated project fragments to scoped readers', async () => {
    const visible = await project('Visible directory project');
    const hidden = await project('Hidden directory project');
    const reader = await fixture.member('Visible reader');
    const assignee = await fixture.member('Visible assignee');
    const hiddenMember = await fixture.member('Hidden-only member');
    const unrelated = await fixture.member('Unrelated workspace member');
    const noRead = await fixture.member('Member without project read');
    await grant(reader.user.id, [visible.id]);
    await grant(assignee.user.id, [visible.id]);
    await grant(hiddenMember.user.id, [hidden.id]);
    await grant(unrelated.user.id, null);
    await grant(noRead.user.id, null, []);
    await fixture.command('CreateWorkItem', { title: 'Real assignee relation', description: '', acceptanceCriteria: [], assigneeId: assignee.user.id }, { extra: { projectId: visible.id } });
    const associated = await team('Visible associated team', [reader.user.id, hiddenMember.user.id, noRead.user.id]);
    const unrelatedTeam = await team('Private unrelated organization', [unrelated.user.id]);
    await fixture.send(assignmentCommand(visible, [associated])).then(response => assert.equal(response.status, 200, JSON.stringify(response.body)));
    await fixture.send(assignmentCommand(hidden, [unrelatedTeam])).then(response => assert.equal(response.status, 200, JSON.stringify(response.body)));
    const result = await directory(reader.cookie);
    assert.equal(result.management, null);
    assert.deepEqual(result.projects.map(row => row.projectId), [visible.id]);
    const row = result.projects[0]!;
    assert.deepEqual(new Set(row.identities.map(identity => identity.id)), new Set([fixture.owner.id, reader.user.id, assignee.user.id]));
    assert.deepEqual(row.teams, [{ id: associated.id, name: associated.data.name, members: [{ id: reader.user.id, name: reader.user.name }] }]);
    for (const identity of [...row.identities, ...row.teams.flatMap(value => value.members)]) assert.deepEqual(Object.keys(identity).sort(), ['id', 'name']);
    const serialized = JSON.stringify(result);
    for (const secret of [hidden.id, hiddenMember.user.id, unrelated.user.id, unrelatedTeam.id, unrelatedTeam.data.name, noRead.user.id, reader.user.email, 'capabilities', 'memberIds', 'projectIds', 'createdBy']) assert.equal(serialized.includes(secret), false, secret);
    assert.deepEqual(Object.keys(row.assignment!).sort(), ['id', 'version']);
    const complete = await directory();
    assert.ok(complete.management?.members.some(member => member.id === unrelated.user.id));
    assert.ok(complete.management?.teams.some(value => value.id === unrelatedTeam.id));
    const inaccessible = await fixture.request(`/api/v1/workspaces/${fixture.workspaceId}/members`, { cookie: reader.cookie });
    assert.ok([403, 404].includes(inaccessible.status));
  });

  it('requires existing active workspace members and does not modify grants when creating or assigning teams', async () => {
    const p = await project('Teams do not grant access');
    const outsider = await fixture.member('Not yet a workspace member');
    const invalid = await fixture.send(teamCommand('CreateProjectTeam', { name: 'No invitations', memberIds: [outsider.user.id] }));
    assert.equal(invalid.status, 404);
    assert.equal((await fixture.pool.query('SELECT count(*)::text AS count FROM memberships WHERE workspace_id=$1 AND user_id=$2', [fixture.workspaceId, outsider.user.id])).rows[0].count, '0');
    const hidden = await project('Only authorized project');
    const original = await grant(outsider.user.id, [hidden.id]);
    const organization = await team('Existing members only', [outsider.user.id]);
    const saved = await fixture.send(assignmentCommand(p, [organization]));
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const membership = (await fixture.pool.query<{ capabilities: string[]; project_ids: string[]; version: number }>('SELECT capabilities,project_ids,version FROM memberships WHERE workspace_id=$1 AND user_id=$2', [fixture.workspaceId, outsider.user.id])).rows[0]!;
    assert.deepEqual(membership, { capabilities: original.capabilities, project_ids: original.projectIds, version: original.version });
    const result = await directory(outsider.cookie);
    assert.deepEqual(result.projects.map(row => row.projectId), [hidden.id]);
    assert.equal(JSON.stringify(result).includes(organization.id), false);
    const forged = await fixture.send(teamCommand('SetProjectTeamMembers', { memberIds: [randomUUID()] }, organization));
    assert.equal(forged.status, 404);
    assert.equal((await directory()).management?.teams.find(value => value.id === organization.id)?.version, organization.version);
    const duplicate = await fixture.send(teamCommand('SetProjectTeamMembers', { memberIds: [outsider.user.id, outsider.user.id] }, organization));
    assert.equal(duplicate.status, 400);
    const updated = await fixture.command<DashboardRecord<ProjectTeam>>('SetProjectTeamMembers', { memberIds: [fixture.owner.id] }, { extra: { targetId: organization.id, expectedVersions: { [organization.id]: organization.version } } });
    assert.equal(updated.version, organization.version + 1);
    assert.deepEqual(updated.data.memberIds, [fixture.owner.id]);
    assert.deepEqual((await directory()).projects.find(row => row.projectId === p.id)?.teams[0]?.members, [{ id: fixture.owner.id, name: fixture.owner.name }]);
    const foreignWorkspace = await createWorkspace(fixture.pool, fixture.owner.id, 'Other directory workspace');
    const foreignTeam = await fixture.command<DashboardRecord<ProjectTeam>>('CreateProjectTeam', { name: 'Foreign organization', memberIds: [fixture.owner.id] }, { workspace: foreignWorkspace.id });
    assert.equal((await fixture.send(assignmentCommand(p, [foreignTeam]))).status, 404);
    assert.equal((await fixture.send(teamCommand('RenameProjectTeam', { name: 'Cannot cross workspaces' }, foreignTeam))).status, 404);
  });

  it('refreshes revoked and disabled members immediately and hides archived teams without removing history', async () => {
    const p = await project('Live authorization intersections');
    const member = await fixture.member('Revocable roster member');
    const observer = await fixture.member('Directory observer');
    const disabled = await fixture.member('Disabled roster member');
    const membership = await grant(member.user.id, [p.id]);
    await grant(observer.user.id, [p.id]);
    await grant(disabled.user.id, [p.id]);
    const organization = await team('Live roster', [member.user.id, disabled.user.id]);
    const assignment = await fixture.send(assignmentCommand(p, [organization]));
    assert.equal(assignment.status, 200);
    assert.equal((await directory(observer.cookie)).projects[0]?.teams[0]?.members.length, 2);
    await fixture.command('RevokeWorkspaceMember', { userId: member.user.id }, { extra: { expectedVersions: { [member.user.id]: membership.version } } });
    await fixture.pool.query('UPDATE users SET disabled_at=now() WHERE id=$1', [disabled.user.id]);
    const result = await directory(observer.cookie);
    assert.deepEqual(result.projects[0]?.teams[0]?.members, []);
    assert.equal(JSON.stringify(result).includes(member.user.id), false);
    assert.equal(JSON.stringify(result).includes(disabled.user.id), false);
    assert.equal((await fixture.request(`/api/v1/workspaces/${fixture.workspaceId}/projects/directory`, { cookie: member.cookie })).status, 404);
    const renamed = await fixture.command<DashboardRecord<ProjectTeam>>('RenameProjectTeam', { name: 'Renamed after revocation' }, { extra: { targetId: organization.id, expectedVersions: { [organization.id]: organization.version } } });
    const invalidRoster = await fixture.send(teamCommand('SetProjectTeamMembers', { memberIds: [member.user.id] }, renamed));
    assert.equal(invalidRoster.status, 404);
    const archived = await fixture.command<DashboardRecord<ProjectTeam>>('ArchiveProjectTeam', {}, { extra: { targetId: renamed.id, expectedVersions: { [renamed.id]: renamed.version } } });
    const afterArchive = await directory(observer.cookie);
    assert.deepEqual(afterArchive.projects[0]?.teams, []);
    assert.equal(JSON.stringify(afterArchive).includes(archived.id), false);
    assert.ok((await directory()).management?.teams.some(value => value.id === archived.id && value.data.archivedAt !== null));
    assert.equal((await fixture.send(teamCommand('RenameProjectTeam', { name: 'Cannot revive' }, archived))).body.error?.code, 'team_archived');
    assert.equal((await fixture.send(assignmentCommand(p, [archived]))).body.error?.code, 'team_archived');
    assert.equal((await fixture.pool.query('SELECT count(*)::text AS count FROM dashboard_records WHERE id=$1', [organization.id])).rows[0].count, '1');
  });

  it('serializes team CAS, preserves idempotency, and requires assignment and referenced-team versions', async () => {
    const create = teamCommand('CreateProjectTeam', { name: 'Idempotent organization', memberIds: [fixture.owner.id] });
    const first = await fixture.send(create);
    assert.equal(first.status, 200);
    assert.deepEqual((await fixture.send(create)).body, first.body);
    assert.equal((await fixture.send({ ...create, payload: { ...create.payload, name: 'Different same-key request' } })).status, 409);
    const organization = first.body.result as DashboardRecord<ProjectTeam>;
    const contenders = [teamCommand('RenameProjectTeam', { name: 'Rename A' }, organization), teamCommand('RenameProjectTeam', { name: 'Rename B' }, organization)];
    const responses = await Promise.all(contenders.map(command => fixture.send(command)));
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
    const renamed = responses.find(response => response.status === 200)!.body.result as DashboardRecord<ProjectTeam>;
    const p = await project('Assignment CAS');
    assert.equal((await fixture.send(assignmentCommand(p, [organization]))).body.error?.code, 'version_conflict');
    const assigned = await fixture.send(assignmentCommand(p, [renamed]));
    assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
    const saved = assigned.body.result as DashboardRecord<ProjectTeamAssignment>;
    const missingHead = await fixture.send(assignmentCommand(p, [renamed]));
    assert.equal(missingHead.body.error?.code, 'version_conflict');
    const removal = assignmentCommand(p, [], saved);
    const removed = await fixture.send(removal);
    assert.equal(removed.status, 200);
    assert.deepEqual((await fixture.send(removal)).body, removed.body);
    assert.equal((await fixture.send(assignmentCommand(p, [renamed], saved))).body.error?.code, 'version_conflict');
    assert.equal((await fixture.pool.query('SELECT count(*)::text AS count FROM outbox WHERE command_id=$1', [create.commandId])).rows[0].count, '1');
    assert.equal((await fixture.pool.query('SELECT count(*)::text AS count FROM outbox WHERE command_id=$1', [removal.commandId])).rows[0].count, '1');
    assert.equal((await fixture.pool.query("SELECT count(*)::text AS count FROM dashboard_records WHERE kind='project_team_assignment' AND project_id=$1", [p.id])).rows[0].count, '1');
  });

  it('allows access.manage-only team maintenance without granting or reading business projects', async () => {
    const p = await project('No implicit business read');
    const manager = await fixture.member('Team-only manager');
    await grant(manager.user.id, null, ['access.manage']);
    const organization = await fixture.command<DashboardRecord<ProjectTeam>>('CreateProjectTeam', { name: 'Administration only', memberIds: [manager.user.id] }, { cookie: manager.cookie });
    const result = await directory(manager.cookie);
    assert.deepEqual(result.projects, []);
    assert.ok(result.management?.teams.some(row => row.id === organization.id));
    assert.ok(result.management?.members.some(row => row.id === fixture.owner.id));
    assert.equal(JSON.stringify(result).includes(p.id), false);
    const renamed = await fixture.command<DashboardRecord<ProjectTeam>>('RenameProjectTeam', { name: 'Still no business grant' }, { cookie: manager.cookie, extra: { targetId: organization.id, expectedVersions: { [organization.id]: organization.version } } });
    const roster = await fixture.command<DashboardRecord<ProjectTeam>>('SetProjectTeamMembers', { memberIds: [fixture.owner.id] }, { cookie: manager.cookie, extra: { targetId: renamed.id, expectedVersions: { [renamed.id]: renamed.version } } });
    assert.equal((await fixture.send(assignmentCommand(p, [roster]), { cookie: manager.cookie })).status, 403);
    const archived = await fixture.command<DashboardRecord<ProjectTeam>>('ArchiveProjectTeam', {}, { cookie: manager.cookie, extra: { targetId: roster.id, expectedVersions: { [roster.id]: roster.version } } });
    assert.ok(archived.data.archivedAt);
    const actual = (await fixture.pool.query<{ capabilities: string[]; version: number }>('SELECT capabilities,version FROM memberships WHERE workspace_id=$1 AND user_id=$2', [fixture.workspaceId, manager.user.id])).rows[0]!;
    assert.deepEqual(actual.capabilities, ['access.manage']);
    assert.equal(actual.version, 1);
    assert.equal((await fixture.request(`/api/v1/workspaces/${fixture.workspaceId}/entities?kind=project`, { cookie: manager.cookie })).status, 403);
    assert.equal((await fixture.request(`/api/v1/workspaces/${fixture.workspaceId}/dashboard/personal`, { cookie: manager.cookie })).status, 403);
  });

  it('restricts all management and sensitive receipt replay to current workspace access.manage', async () => {
    const p = await project('Workspace management authority');
    const user = await fixture.member('Scoped planning editor');
    await grant(user.user.id, [p.id], ['domain.read', 'planning.edit']);
    const organization = await team('Managed organization', [fixture.owner.id]);
    for (const command of [teamCommand('CreateProjectTeam', { name: 'Unauthorized', memberIds: [] }), teamCommand('RenameProjectTeam', { name: 'Unauthorized' }, organization), teamCommand('UpdateProjectTeamDetails', { name: 'Unauthorized', identifier: null, description: '', focus: null, responseTargetHours: null }, organization), teamCommand('SetProjectTeamMaintainers', { maintainerIds: [fixture.owner.id] }, organization), teamCommand('SetProjectTeamMembers', { memberIds: [] }, organization), teamCommand('ArchiveProjectTeam', {}, organization), assignmentCommand(p, [organization])]) {
      assert.ok([403, 404].includes((await fixture.send(command, { cookie: user.cookie })).status), command.commandType);
    }
    const admin = await fixture.member('Temporary team administrator');
    const membership = await grant(admin.user.id, null, ['domain.read', 'access.manage']);
    const create = teamCommand('CreateProjectTeam', { name: 'Sensitive administration result', memberIds: [fixture.owner.id] });
    assert.equal((await fixture.send(create, { cookie: admin.cookie })).status, 200);
    await grant(admin.user.id, null, ['domain.read'], membership);
    const downgraded = await directory(admin.cookie);
    assert.equal(downgraded.management, null);
    assert.equal(JSON.stringify(downgraded).includes('Sensitive administration result'), false);
    assert.ok([403, 404].includes((await fixture.request(`/api/v1/workspaces/${fixture.workspaceId}/commands/${create.commandId}`, { cookie: admin.cookie })).status));
    assert.ok([403, 404].includes((await fixture.send(create, { cookie: admin.cookie })).status));
    const archived = await fixture.command<Entity>('ArchiveObject', { kind: 'project', reason: 'Assignment archive guard' }, { extra: { targetId: p.id, projectId: p.id, expectedVersions: { [p.id]: p.version } } });
    assert.equal((await fixture.send(assignmentCommand(archived, [organization]))).body.error?.code, 'object_archived');
  });

  it('persists explicit team details with CAS and maintains active member-only responsibilities', async () => {
    const member = await fixture.member('Team maintainer');
    const membership = await grant(member.user.id, null);
    const organization = await team('Detailed team', [fixture.owner.id, member.user.id]);
    assert.deepEqual(organization.data, { name: 'Detailed team', memberIds: [fixture.owner.id, member.user.id],
      identifier: null, description: '', focus: null, responseTargetHours: null, maintainerIds: [], archivedAt: null });
    const details = { name: 'Support and triage', identifier: 'SUP', description: 'A real support team', focus: 'Incident triage', responseTargetHours: 0 };
    const update = teamCommand('UpdateProjectTeamDetails', details, organization);
    const first = await fixture.send(update);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual((await fixture.send(update)).body, first.body);
    const updated = first.body.result as DashboardRecord<ProjectTeam>;
    assert.deepEqual(updated.data, { ...organization.data, ...details });
    assert.equal(updated.version, organization.version + 1);
    assert.equal((await fixture.send(teamCommand('UpdateProjectTeamDetails', { ...details, description: 'Stale edit' }, organization))).body.error?.code, 'version_conflict');
    assert.equal((await fixture.send({ ...teamCommand('UpdateProjectTeamDetails', details, updated), expectedVersions: {} })).body.error?.code, 'version_conflict');
    assert.equal((await fixture.send(teamCommand('UpdateProjectTeamDetails', { ...details, memberIds: [] }, updated))).status, 400);
    assert.equal((await fixture.send(teamCommand('SetProjectTeamMaintainers', { maintainerIds: [fixture.owner.id, fixture.owner.id] }, updated))).status, 400);
    const outsider = await fixture.member('Active non-roster member');
    await grant(outsider.user.id, null);
    assert.equal((await fixture.send(teamCommand('SetProjectTeamMaintainers', { maintainerIds: [outsider.user.id] }, updated))).body.error?.code, 'invalid_team_maintainers');
    assert.equal((await fixture.send(teamCommand('CreateProjectTeam', { name: 'Invalid responsibilities', memberIds: [fixture.owner.id], maintainerIds: [member.user.id] }))).body.error?.code, 'invalid_team_maintainers');
    const roles = await fixture.command<DashboardRecord<ProjectTeam>>('SetProjectTeamMaintainers', { maintainerIds: [fixture.owner.id, member.user.id] },
      { extra: { targetId: updated.id, expectedVersions: { [updated.id]: updated.version } } });
    assert.deepEqual((await teamsDirectory()).teams.find(team => team.id === organization.id)?.data.maintainerIds, [fixture.owner.id, member.user.id]);
    const pruned = await fixture.command<DashboardRecord<ProjectTeam>>('SetProjectTeamMembers', { memberIds: [member.user.id] },
      { extra: { targetId: roles.id, expectedVersions: { [roles.id]: roles.version } } });
    assert.deepEqual(pruned.data.maintainerIds, [member.user.id]);
    await fixture.command('RevokeWorkspaceMember', { userId: member.user.id }, { extra: { expectedVersions: { [member.user.id]: membership.version } } });
    const read = (await teamsDirectory()).teams.find(team => team.id === organization.id)!;
    assert.deepEqual(read.data.memberIds, []);
    assert.deepEqual(read.data.maintainerIds, []);
    assert.equal((await fixture.send(teamCommand('SetProjectTeamMaintainers', { maintainerIds: [member.user.id] }, pruned))).status, 404);
    const renamed = await fixture.command<DashboardRecord<ProjectTeam>>('RenameProjectTeam', { name: 'Revocation remains manageable' },
      { extra: { targetId: pruned.id, expectedVersions: { [pruned.id]: pruned.version } } });
    assert.deepEqual(renamed.data.maintainerIds, []);
    assert.equal((await fixture.pool.query('SELECT count(*)::text AS count FROM outbox WHERE command_id=$1 AND event_type=$2', [update.commandId, 'ProjectTeamDetailsUpdated'])).rows[0].count, '1');
  });

  it('team directory hides hidden project/member/creator IDs and counts only distinct visible open work', async () => {
    const visible = await project('Team directory visible project');
    const hidden = await project('Team directory hidden project');
    const reader = await fixture.member('Team directory scoped reader');
    const hiddenMember = await fixture.member('Team directory hidden member');
    const manager = await fixture.member('Team directory non-business creator');
    await grant(reader.user.id, [visible.id]);
    await grant(hiddenMember.user.id, [hidden.id]);
    await grant(manager.user.id, null, ['access.manage']);
    const organization = await fixture.command<DashboardRecord<ProjectTeam>>('CreateProjectTeam', {
      name: 'Cross-scope real team', memberIds: [reader.user.id, hiddenMember.user.id], maintainerIds: [reader.user.id, hiddenMember.user.id],
      description: 'Visible team facts', identifier: 'VISIBLE',
    }, { cookie: manager.cookie });
    const visibleAssignment = await fixture.send(assignmentCommand(visible, [organization]));
    assert.equal(visibleAssignment.status, 200, JSON.stringify(visibleAssignment.body));
    assert.equal((await fixture.send(assignmentCommand(hidden, [organization]))).status, 200);
    await fixture.command('CreateWorkItem', { title: 'Visible open team work', description: '', acceptanceCriteria: [], assigneeId: reader.user.id }, { extra: { projectId: visible.id } });
    await fixture.command('CreateWorkItem', { title: 'Hidden open team work', description: '', acceptanceCriteria: [], assigneeId: hiddenMember.user.id }, { extra: { projectId: hidden.id } });
    const scoped = await teamsDirectory(reader.cookie);
    assert.equal(scoped.canManage, false);
    assert.deepEqual(scoped.projects.map(project => project.id), [visible.id]);
    assert.equal(scoped.projects[0]?.canManage, false);
    const teamView = scoped.teams.find(team => team.id === organization.id)!;
    assert.deepEqual(teamView.projectIds, [visible.id]);
    assert.deepEqual(teamView.data.memberIds, [reader.user.id]);
    assert.deepEqual(teamView.data.maintainerIds, [reader.user.id]);
    assert.equal(teamView.createdBy, null);
    assert.equal(teamView.openWorkCount, 1);
    assert.equal(teamView.scopeComplete, false);
    assert.equal(teamView.activityAt, (visibleAssignment.body.result as DashboardRecord<ProjectTeamAssignment>).updatedAt);
    for (const secret of [hidden.id, hiddenMember.user.id, manager.user.id]) assert.equal(JSON.stringify(scoped).includes(secret), false, secret);
    const administration = await teamsDirectory(manager.cookie);
    assert.equal(administration.canManage, true);
    assert.deepEqual(administration.projects, []);
    const administrativeTeam = administration.teams.find(team => team.id === organization.id)!;
    assert.deepEqual(administrativeTeam.projectIds, []);
    assert.equal(administrativeTeam.openWorkCount, null);
    assert.equal(administrativeTeam.scopeComplete, false);
    assert.equal(administrativeTeam.activityAt, organization.updatedAt);
    assert.equal(JSON.stringify(administration).includes(hidden.id), false);
    assert.equal(JSON.stringify(administration).includes(visible.id), false);
    const complete = (await teamsDirectory()).teams.find(team => team.id === organization.id)!;
    assert.deepEqual(new Set(complete.projectIds), new Set([visible.id, hidden.id]));
    assert.equal(complete.openWorkCount, 2);
    assert.equal(complete.scopeComplete, true);
    assert.ok((await teamsDirectory()).projects.find(project => project.id === visible.id)?.canManage);
  });
});
