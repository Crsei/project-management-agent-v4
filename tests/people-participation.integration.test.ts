import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { Membership } from '../packages/application/src/access.ts';
import type { Command, Entity } from '../packages/domain/src/core.ts';
import type { DashboardRecord } from '../packages/domain/src/dashboard.ts';
import type { PeopleAccountLookup, PeopleCandidatePage, ProjectParticipation, ProjectPeople } from '../packages/domain/src/people.ts';
import type { ProjectDirectory, ProjectTeam } from '../packages/domain/src/project-directory.ts';
import { createDashboardFixture, dashboardDatabaseUrl, type DashboardFixture } from './dashboard-fixture.ts';

function participationCommand(project: Entity, memberIds: string[], saved?: DashboardRecord<ProjectParticipation>): Command {
  return { commandId: randomUUID(), commandType: 'SetProjectParticipants', targetId: project.id, projectId: project.id,
    expectedVersions: { [project.id]: project.version, ...(saved ? { [saved.id]: saved.version } : {}) }, payload: { memberIds } };
}

describe('explicit people participation, eligibility and organization-only restoration', { skip: !dashboardDatabaseUrl, timeout: 180_000 }, () => {
  let fixture: DashboardFixture;
  before(async () => { fixture = await createDashboardFixture(); });
  after(async () => { await fixture?.close(); });
  const base = () => `/api/v1/workspaces/${fixture.workspaceId}/people`;
  async function project(name: string): Promise<Entity> {
    return fixture.command('CreateProject', { name, goal: 'Distinct people semantics', ownerId: fixture.owner.id, completionCriteria: ['Reviewed'] });
  }
  async function grant(userId: string, projectIds: string[] | null, capabilities = ['domain.read'], previous?: Membership): Promise<Membership> {
    return fixture.command('SetWorkspaceMember', { userId, capabilities, projectIds }, previous ? { extra: { expectedVersions: { [userId]: previous.version } } } : {});
  }
  async function people(p: Entity, cookie?: string): Promise<ProjectPeople> {
    const response = await fixture.request<ProjectPeople>(`${base()}/projects/${p.id}`, cookie ? { cookie } : {});
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.match(response.headers.get('cache-control')!, /no-store/);
    return response.body;
  }

  it('does not infer participants from ownership, assignments, teams, or access; removing participation keeps all of those facts', async () => {
    const p = await project('Independent participation');
    const person = await fixture.member('Participating assignee');
    const membership = await grant(person.user.id, [p.id]);
    const task = await fixture.command('CreateWorkItem', { title: 'Keep human assignment', description: '', acceptanceCriteria: [], assigneeId: person.user.id }, { extra: { projectId: p.id } });
    const team = await fixture.command<DashboardRecord<ProjectTeam>>('CreateProjectTeam', { name: 'Human organization', memberIds: [person.user.id] });
    await fixture.command('SetProjectTeams', { teamIds: [team.id] }, { extra: { targetId: p.id, projectId: p.id, expectedVersions: { [p.id]: p.version, [team.id]: team.version } } });
    assert.deepEqual((await people(p)).participants, []);
    const before = await fixture.request<ProjectDirectory>(`/api/v1/workspaces/${fixture.workspaceId}/projects/directory`);
    assert.ok(before.body.projects.find(row => row.projectId === p.id)!.identities.some(row => row.id === person.user.id));
    assert.deepEqual(before.body.projects.find(row => row.projectId === p.id)!.participants, []);
    const set = participationCommand(p, [person.user.id]);
    const response = await fixture.send(set);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const saved = response.body.result as DashboardRecord<ProjectParticipation>;
    assert.deepEqual((await fixture.send(set)).body, response.body);
    assert.deepEqual((await people(p, person.cookie)).participants.map(row => row.userId), [person.user.id]);
    assert.equal((await fixture.send(participationCommand(p, []))).body.error?.code, 'version_conflict');
    assert.equal((await fixture.send({ ...participationCommand(p, [], saved), expectedVersions: { [saved.id]: saved.version } })).body.error?.code, 'version_conflict');
    assert.equal((await fixture.send(participationCommand(p, [], saved))).status, 200);
    assert.deepEqual((await people(p)).participants, []);
    assert.equal((await fixture.request(`${base()}/projects/${p.id}`, { cookie: person.cookie })).status, 200);
    const currentMembership = (await fixture.pool.query<{ version: number; project_ids: string[] }>('SELECT version,project_ids FROM memberships WHERE workspace_id=$1 AND user_id=$2', [fixture.workspaceId, person.user.id])).rows[0]!;
    assert.equal(currentMembership.version, membership.version);
    assert.deepEqual(currentMembership.project_ids, [p.id]);
    const taskRead = await fixture.request<Entity>(`/api/v1/workspaces/${fixture.workspaceId}/entities/${task.id}`);
    assert.equal(taskRead.status, 200, JSON.stringify(taskRead.body));
    assert.equal(taskRead.body.data.assigneeId, person.user.id);
    const storedTeam = (await fixture.pool.query<{ data: ProjectTeam }>('SELECT data FROM dashboard_records WHERE id=$1', [team.id])).rows[0]!;
    assert.deepEqual(storedTeam.data.memberIds, [person.user.id]);
  });

  it('rejects unauthorized/ineligible edits, serializes first-write and update CAS, and rechecks receipt authority', async () => {
    const p = await project('Participation CAS');
    const hidden = await project('Other scope');
    const reader = await fixture.member('Reader without management');
    const outsider = await fixture.member('Out of project');
    await grant(reader.user.id, [p.id]);
    await grant(outsider.user.id, [hidden.id]);
    assert.ok([403, 404].includes((await fixture.send(participationCommand(p, [reader.user.id]), { cookie: reader.cookie })).status));
    assert.equal((await fixture.send(participationCommand(p, [outsider.user.id]))).status, 404);
    const attempts = await Promise.all([fixture.send(participationCommand(p, [reader.user.id])), fixture.send(participationCommand(p, []))]);
    assert.deepEqual(attempts.map(row => row.status).sort(), [200, 409]);
    const current = attempts.find(row => row.status === 200)!.body.result as DashboardRecord<ProjectParticipation>;
    const updates = await Promise.all([fixture.send(participationCommand(p, [reader.user.id], current)), fixture.send(participationCommand(p, [], current))]);
    assert.deepEqual(updates.map(row => row.status).sort(), [200, 409]);
    const manager = await fixture.member('Temporary people manager');
    const managerMembership = await grant(manager.user.id, null, ['access.manage', 'domain.read']);
    const latest = updates.find(row => row.status === 200)!.body.result as DashboardRecord<ProjectParticipation>;
    const command = participationCommand(p, [], latest);
    assert.equal((await fixture.send(command, { cookie: manager.cookie })).status, 200);
    await grant(manager.user.id, null, ['domain.read'], managerMembership);
    assert.ok([403, 404].includes((await fixture.send(command, { cookie: manager.cookie })).status));
    assert.ok([403, 404].includes((await fixture.request(`/api/v1/workspaces/${fixture.workspaceId}/commands/${command.commandId}`, { cookie: manager.cookie })).status));
  });

  it('pages eligible identities without leaking email/grants and binds cursors to the current query', async () => {
    const p = await project('Eligible candidate pages');
    const hidden = await project('Hidden candidate scope');
    const reader = await fixture.member('Candidate reader');
    await grant(reader.user.id, [p.id]);
    const expected: string[] = [];
    for (let index = 0; index < 3; index++) {
      const member = await fixture.member(`paging-eligible-${index}`);
      await grant(member.user.id, [p.id]);
      expected.push(member.user.id);
    }
    const hiddenMember = await fixture.member('paging-eligible-hidden');
    const noRead = await fixture.member('paging-eligible-no-read');
    const disabled = await fixture.member('paging-eligible-disabled');
    const revoked = await fixture.member('paging-eligible-revoked');
    await grant(hiddenMember.user.id, [hidden.id]);
    await grant(noRead.user.id, [p.id], []);
    await grant(disabled.user.id, [p.id]);
    const revokedMembership = await grant(revoked.user.id, [p.id]);
    await fixture.pool.query('UPDATE users SET disabled_at=now() WHERE id=$1', [disabled.user.id]);
    await fixture.command('RevokeWorkspaceMember', { userId: revoked.user.id }, { extra: { expectedVersions: { [revoked.user.id]: revokedMembership.version } } });
    const query = `${base()}/candidates?purpose=assignee&projectId=${p.id}&q=paging-eligible&limit=1`;
    const ids: string[] = [];
    let cursor: string | null = null;
    let firstCursor = '';
    do {
      const response: { status: number; body: PeopleCandidatePage } = await fixture.request<PeopleCandidatePage>(`${query}${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`, { cookie: reader.cookie });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.items.length, 1);
      for (const person of response.body.items) assert.deepEqual(Object.keys(person).sort(), ['avatarDataUrl', 'jobTitle', 'name', 'userId']);
      ids.push(...response.body.items.map(person => person.userId));
      cursor = response.body.nextCursor;
      if (!firstCursor && cursor) firstCursor = cursor;
    } while (cursor);
    assert.deepEqual(ids, expected.sort());
    assert.equal((await fixture.request(`${query.replace('purpose=assignee', 'purpose=participant')}&after=${encodeURIComponent(firstCursor)}`, { cookie: reader.cookie })).status, 400);
    assert.equal((await fixture.request(`${base()}/candidates?purpose=assignee&projectId=${hidden.id}`, { cookie: reader.cookie })).status, 404);
    assert.ok([403, 404].includes((await fixture.request(`${base()}/candidates?purpose=team`, { cookie: reader.cookie })).status));
  });

  it('redacts newly ineligible participation immediately without erasing the saved roster or task history', async () => {
    const p = await project('Live participation read');
    const participant = await fixture.member('Revoked participant');
    const observer = await fixture.member('Remaining observer');
    const membership = await grant(participant.user.id, [p.id]);
    await grant(observer.user.id, [p.id]);
    const save = await fixture.send(participationCommand(p, [participant.user.id]));
    assert.equal(save.status, 200);
    await fixture.command('RevokeWorkspaceMember', { userId: participant.user.id }, { extra: { expectedVersions: { [participant.user.id]: membership.version } } });
    const ordinary = await people(p, observer.cookie);
    assert.deepEqual(ordinary.participants, []);
    assert.deepEqual(ordinary.participation?.memberIds, []);
    assert.equal(JSON.stringify(ordinary).includes(participant.user.id), false);
    assert.deepEqual((await people(p)).participation?.memberIds, [participant.user.id]);
    assert.equal((await fixture.request(`${base()}/projects/${p.id}`, { cookie: participant.cookie })).status, 404);
  });

  it('uses exact admin-only account lookup, not global or partial email enumeration', async () => {
    const outsider = await fixture.member('Existing account without workspace membership');
    const lookup = await fixture.request<PeopleAccountLookup>(`${base()}/account?${new URLSearchParams({ email: outsider.user.email.toUpperCase() })}`);
    assert.equal(lookup.status, 200);
    assert.equal(lookup.body.account?.userId, outsider.user.id);
    assert.deepEqual(Object.keys(lookup.body.account!).sort(), ['avatarDataUrl', 'jobTitle', 'name', 'userId']);
    assert.equal((await fixture.request(`${base()}/account?email=partial`)).status, 400);
    assert.equal((await fixture.request(`${base()}/account`)).status, 400);
    const absent = await fixture.request<PeopleAccountLookup>(`${base()}/account?email=${randomUUID()}@example.test`);
    assert.deepEqual(absent.body, { account: null });
    await grant(outsider.user.id, null);
    assert.equal((await fixture.request(`${base()}/account?${new URLSearchParams({ email: fixture.owner.email })}`, { cookie: outsider.cookie })).status, 403);
  });

  it('allows project creation owners only through unrestricted planning and read authority', async () => {
    const p = await project('Owner candidate scope');
    const editor = await fixture.member('Owner candidate creator');
    const scoped = await fixture.member('Owner candidate restricted');
    await grant(editor.user.id, null, ['domain.read', 'planning.edit']);
    await grant(scoped.user.id, [p.id], ['domain.read', 'planning.edit']);
    const response = await fixture.request<PeopleCandidatePage>(`${base()}/candidates?purpose=project_owner&q=Owner%20candidate`, { cookie: editor.cookie });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(response.body.items.map(person => person.userId), [editor.user.id]);
    assert.equal((await fixture.request(`${base()}/candidates?purpose=project_owner`, { cookie: scoped.cookie })).status, 404);
    assert.equal((await fixture.request(`${base()}/candidates?purpose=team`, { cookie: editor.cookie })).status, 403);
  });

  it('restores archived teams with exact CAS, prunes inactive relations, and never restores grants', async () => {
    const p = await project('Restored organization');
    const member = await fixture.member('Departed team member');
    const membership = await grant(member.user.id, [p.id]);
    const team = await fixture.command<DashboardRecord<ProjectTeam>>('CreateProjectTeam', { name: 'Restorable team', memberIds: [fixture.owner.id, member.user.id], maintainerIds: [member.user.id] });
    await fixture.command('SetProjectTeams', { teamIds: [team.id] }, { extra: { targetId: p.id, projectId: p.id, expectedVersions: { [p.id]: p.version, [team.id]: team.version } } });
    const archived = await fixture.command<DashboardRecord<ProjectTeam>>('ArchiveProjectTeam', {}, { extra: { targetId: team.id, expectedVersions: { [team.id]: team.version } } });
    const revoked = await fixture.command<Membership>('RevokeWorkspaceMember', { userId: member.user.id }, { extra: { expectedVersions: { [member.user.id]: membership.version } } });
    const restore: Command = { commandId: randomUUID(), commandType: 'RestoreProjectTeam', targetId: team.id, expectedVersions: { [team.id]: archived.version }, payload: {} };
    const reader = await fixture.member('Team reader, not administrator');
    await grant(reader.user.id, [p.id]);
    assert.ok([403, 404].includes((await fixture.send({ ...restore, commandId: randomUUID() }, { cookie: reader.cookie })).status));
    assert.equal((await fixture.send({ ...restore, commandId: randomUUID(), expectedVersions: { [team.id]: team.version } })).body.error?.code, 'version_conflict');
    const response = await fixture.send(restore);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual((await fixture.send(restore)).body, response.body);
    const restored = response.body.result as DashboardRecord<ProjectTeam>;
    assert.equal(restored.data.archivedAt, null);
    assert.deepEqual(restored.data.memberIds, [fixture.owner.id]);
    assert.deepEqual(restored.data.maintainerIds, []);
    assert.equal(restored.version, archived.version + 1);
    assert.equal(restored.data.name, team.data.name);
    assert.equal(restored.data.description, team.data.description);
    const current = (await fixture.pool.query<{ version: number; revoked_at: Date | null }>('SELECT version,revoked_at FROM memberships WHERE workspace_id=$1 AND user_id=$2', [fixture.workspaceId, member.user.id])).rows[0]!;
    assert.equal(current.version, revoked.version);
    assert.ok(current.revoked_at);
    assert.equal((await fixture.request(`${base()}/projects/${p.id}`, { cookie: member.cookie })).status, 404);
    assert.ok((await people(p)).teams.some(value => value.id === team.id));
  });
});
