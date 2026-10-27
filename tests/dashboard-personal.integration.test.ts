import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { Actor, Command, Entity } from '../packages/domain/src/core.ts';
import type { PersonalDashboard, PrivateNote, ProjectMeeting, SelfProfile, TaskWatch } from '../packages/domain/src/dashboard-personal.ts';
import { publishOutboxBatch } from '../packages/application/src/outbox.ts';
import { createWorkspace } from '../packages/infrastructure/src/auth.ts';
import { createDashboardFixture, dashboardDatabaseUrl } from './dashboard-fixture.ts';
import type { DashboardCommandOptions, DashboardFixture } from './dashboard-fixture.ts';

describe('dashboard personal: real private persistence, global profile CAS and project meetings', { skip: !dashboardDatabaseUrl, timeout: 180_000 }, () => {
  let fixture: DashboardFixture;
  before(async () => { fixture = await createDashboardFixture(); });
  after(async () => { await fixture?.close(); });

  async function project(name: string): Promise<Entity> {
    return fixture.command('CreateProject', { name, goal: 'Real personal dashboard regression', ownerId: fixture.owner.id, completionCriteria: ['Verified'] });
  }
  async function task(scope: Entity): Promise<Entity> {
    return fixture.command('CreateWorkItem', { title: `Unassigned task ${randomUUID()}`, description: 'Visible, but not assigned to the watching member.', acceptanceCriteria: [{ id: randomUUID(), text: 'Done' }], assigneeId: null }, { extra: { projectId: scope.id } });
  }
  function command(commandType: string, payload: Record<string, unknown>, extra: Partial<Command> = {}): Command {
    return { commandId: randomUUID(), commandType, payload, ...extra };
  }
  async function grant(userId: string, projectIds: string[] | null, capabilities = ['domain.read'], version?: number): Promise<{ userId: string; version: number }> {
    return fixture.command('SetWorkspaceMember', { userId, capabilities, projectIds }, { extra: { targetId: userId, ...(version ? { expectedVersions: { [userId]: version } } : {}) } });
  }
  async function flushOutbox(): Promise<void> {
    while (await publishOutboxBatch(fixture.pool, 500)) { /* Publish all actual private/shared events. */ }
  }

  it('watch/unwatch is durable and unique, keeps another actor private, and hides revoked tasks and receipts', async () => {
    const firstProject = await project('Watching allowed');
    const nextProject = await project('Watching after scope change');
    const work = await task(firstProject);
    const guest = await fixture.member('Restricted watcher');
    const membership = await grant(guest.user.id, [firstProject.id]);
    const options = { cookie: guest.cookie };
    const initial = command('WatchTask', { taskId: work.id }, { projectId: firstProject.id });
    const response = await fixture.send(initial, options);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const watch = response.body.result as TaskWatch;
    assert.equal(watch.ownerId, guest.user.id);
    assert.deepEqual((await fixture.send(initial, options)).body, response.body);
    const duplicate = await fixture.command<TaskWatch>('WatchTask', { taskId: work.id }, { ...options, extra: { projectId: firstProject.id } });
    assert.equal(duplicate.id, watch.id);
    assert.equal((await fixture.read<PersonalDashboard>('personal', options)).watches.filter(row => row.data.taskId === work.id).length, 1);
    assert.equal((await fixture.read<PersonalDashboard>('personal')).watches.some(row => row.id === watch.id), false);
    const stale = await fixture.send(command('UnwatchTask', {}, { targetId: watch.id, expectedVersions: { [watch.id]: watch.version + 1 } }), options);
    assert.equal(stale.body.error?.code, 'version_conflict');
    await fixture.command<TaskWatch>('UnwatchTask', {}, { ...options, extra: { targetId: watch.id, expectedVersions: { [watch.id]: watch.version } } });
    assert.equal((await fixture.read<PersonalDashboard>('personal', options)).watches.some(row => row.id === watch.id), false);
    const watchedAgain = await fixture.command<TaskWatch>('WatchTask', { taskId: work.id }, options);
    assert.notEqual(watchedAgain.id, watch.id);
    await grant(guest.user.id, [nextProject.id], ['domain.read'], membership.version);
    assert.deepEqual((await fixture.read<PersonalDashboard>('personal', options)).watches, []);
    const forbiddenReceipt = await fixture.request(`/api/v1/workspaces/${fixture.workspaceId}/commands/${initial.commandId}`, { cookie: guest.cookie });
    assert.equal(forbiddenReceipt.status, 404);
    const active = await fixture.pool.query("SELECT count(*)::int AS count FROM dashboard_records WHERE workspace_id=$1 AND owner_id=$2 AND kind='task_watch' AND data->>'watching'='true'", [fixture.workspaceId, guest.user.id]);
    assert.equal(active.rows[0].count, 1, 'Revocation hides, rather than erases, a historical private watch');
  });

  it('deleted Markdown tasks disappear from watching without erasing private history', async () => {
    const scope = await project('Task deletion visibility');
    let work = await task(scope);
    const watch = await fixture.command<TaskWatch>('WatchTask', { taskId: work.id });
    work = await fixture.command('ArchiveObject', { kind: 'work_item', reason: 'Verify watched task deletion visibility' }, { extra: { targetId: work.id, expectedVersions: { [work.id]: work.version } } });
    const source = await fixture.request<{ revision: string }>(`/api/v1/workspaces/${fixture.workspaceId}/core/files/${work.id}`);
    assert.equal(source.status, 200);
    const deletion = await fixture.request(`/api/v1/workspaces/${fixture.workspaceId}/core/entities/${work.id}`, { method: 'DELETE', body: { revision: source.body.revision } });
    assert.equal(deletion.status, 200, JSON.stringify(deletion.body));
    assert.equal((await fixture.read<PersonalDashboard>('personal')).watches.some(row => row.id === watch.id), false);
    const retained = await fixture.pool.query('SELECT id FROM dashboard_records WHERE id=$1', [watch.id]);
    assert.equal(retained.rows.length, 1);
  });

  it('restricted members can create/edit/complete/reopen/delete notes with CAS, private receipts and metadata-only events', async () => {
    const scope = await project('Private notes membership');
    const guest = await fixture.member('Private note author');
    await grant(guest.user.id, [scope.id]);
    const options: DashboardCommandOptions = { cookie: guest.cookie };
    const initial = command('CreatePrivateNote', { content: 'A genuinely private note; never publish this content.' });
    const response = await fixture.send(initial, options);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    let note = response.body.result as PrivateNote;
    assert.equal(note.ownerId, guest.user.id);
    assert.equal((await fixture.read<PersonalDashboard>('personal', options)).notes.find(row => row.id === note.id)?.data.content, note.data.content);
    assert.equal((await fixture.read<PersonalDashboard>('personal')).notes.some(row => row.id === note.id), false);
    const denied = await fixture.send(command('UpdatePrivateNote', { content: 'An administrator must not read or overwrite this' }, { targetId: note.id, expectedVersions: { [note.id]: note.version } }));
    assert.equal(denied.status, 404);
    const old = note;
    note = await fixture.command<PrivateNote>('UpdatePrivateNote', { content: 'Actual updated private note' }, { ...options, extra: { targetId: note.id, expectedVersions: { [note.id]: note.version } } });
    const stale = await fixture.send(command('UpdatePrivateNote', { content: 'Lost update' }, { targetId: note.id, expectedVersions: { [note.id]: old.version } }), options);
    assert.equal(stale.body.error?.code, 'version_conflict');
    note = await fixture.command<PrivateNote>('CompletePrivateNote', {}, { ...options, extra: { targetId: note.id, expectedVersions: { [note.id]: note.version } } });
    assert.ok(note.data.completedAt);
    note = await fixture.command<PrivateNote>('ReopenPrivateNote', {}, { ...options, extra: { targetId: note.id, expectedVersions: { [note.id]: note.version } } });
    assert.equal(note.data.completedAt, null);
    note = await fixture.command<PrivateNote>('DeletePrivateNote', {}, { ...options, extra: { targetId: note.id, expectedVersions: { [note.id]: note.version } } });
    assert.ok(note.data.deletedAt);
    assert.equal((await fixture.read<PersonalDashboard>('personal', options)).notes.some(row => row.id === note.id), false);
    const resurrect = await fixture.send(command('UpdatePrivateNote', { content: 'Cannot resurrect deleted note' }, { targetId: note.id, expectedVersions: { [note.id]: note.version } }), options);
    assert.equal(resurrect.status, 404);
    const receipt = await fixture.request(`/api/v1/workspaces/${fixture.workspaceId}/commands/${initial.commandId}`, { cookie: guest.cookie });
    assert.equal(receipt.status, 200);
    assert.equal((await fixture.request(`/api/v1/workspaces/${fixture.workspaceId}/commands/${initial.commandId}`)).status, 404);
    const outbox = await fixture.pool.query('SELECT payload,audience_actor_id FROM outbox WHERE aggregate_id=$1 ORDER BY id', [note.id]);
    assert.equal(outbox.rows.length, 5);
    for (const row of outbox.rows) {
      assert.equal(row.audience_actor_id, guest.user.id);
      assert.deepEqual(Object.keys(row.payload).sort(), ['id', 'kind', 'version']);
    }
    await flushOutbox();
    const authorChanges = await fixture.request<{ events: { event: { aggregateId: string } }[] }>(`/api/v1/workspaces/${fixture.workspaceId}/changes?after=0`, { cookie: guest.cookie });
    const adminChanges = await fixture.request<{ events: { event: { aggregateId: string } }[] }>(`/api/v1/workspaces/${fixture.workspaceId}/changes?after=0`);
    assert.equal(authorChanges.status, 200);
    assert.equal(authorChanges.body.events.filter(row => row.event.aggregateId === note.id).length, 5);
    assert.equal(adminChanges.body.events.some(row => row.event.aggregateId === note.id), false);
  });

  it('profile changes update users and session/member names, use membership join dates and conflict globally across workspaces', async () => {
    const otherWorkspace = (await createWorkspace(fixture.pool, fixture.owner.id, 'Global profile concurrency')).id;
    const joinedAt = '2026-01-02T03:04:05.000Z';
    await fixture.pool.query("UPDATE users SET created_at='2020-01-01T00:00:00Z' WHERE id=$1", [fixture.owner.id]);
    await fixture.pool.query('UPDATE memberships SET created_at=$3 WHERE workspace_id=$1 AND user_id=$2', [fixture.workspaceId, fixture.owner.id, joinedAt]);
    const profile = (await fixture.read<PersonalDashboard>('personal')).profile;
    assert.equal(profile.joinedAt, joinedAt);
    const [left, right] = await Promise.all([
      fixture.send(command('UpdateSelfProfile', { name: 'Left global rename', timeZone: 'Pacific/Chatham' }, { targetId: fixture.owner.id, expectedVersions: { [fixture.owner.id]: profile.version } })),
      fixture.send(command('UpdateSelfProfile', { name: 'Right global rename', timeZone: 'America/New_York' }, { targetId: fixture.owner.id, expectedVersions: { [fixture.owner.id]: profile.version } }), { workspace: otherWorkspace }),
    ]);
    assert.deepEqual([left.status, right.status].sort(), [200, 409]);
    const winner = (left.status === 200 ? left : right).body.result as SelfProfile;
    const loser = left.status === 409 ? left : right;
    assert.equal(loser.body.error?.code, 'version_conflict');
    const current = (await fixture.read<PersonalDashboard>('personal')).profile;
    const other = (await fixture.read<PersonalDashboard>('personal', { workspace: otherWorkspace })).profile;
    assert.equal(current.version, profile.version + 1);
    assert.equal(other.version, current.version);
    assert.equal(other.name, winner.name);
    assert.equal(current.timeZone, winner.timeZone);
    assert.equal(current.joinedAt, joinedAt);
    assert.notEqual(other.joinedAt, joinedAt);
    const me = await fixture.request<{ actor: Actor }>('/api/v1/auth/me');
    const members = await fixture.request<{ userId: string; name: string }[]>(`/api/v1/workspaces/${fixture.workspaceId}/members`);
    assert.equal(me.body.actor.name, winner.name);
    assert.equal(members.body.find(member => member.userId === fixture.owner.id)?.name, winner.name);
    const invalid = await fixture.send(command('UpdateSelfProfile', { name: 'Must not be saved', timeZone: 'Mars/Invalid' }, { targetId: fixture.owner.id, expectedVersions: { [fixture.owner.id]: current.version } }));
    assert.equal(invalid.body.error?.code, 'validation_failed');
    const missingVersion = await fixture.send(command('UpdateSelfProfile', { name: 'Missing CAS', timeZone: 'UTC' }, { targetId: fixture.owner.id }));
    assert.equal(missingVersion.body.error?.code, 'version_conflict');
    const rows = await fixture.pool.query('SELECT name,time_zone,profile_version FROM users WHERE id=$1', [fixture.owner.id]);
    assert.equal(rows.rows[0].name, winner.name);
    assert.equal(rows.rows[0].time_zone, winner.timeZone);
    assert.equal(rows.rows[0].profile_version, current.version);
  });

  it('restricted self profiles cannot rename another account or reveal the full participant directory', async () => {
    const scope = await project('Restricted self profile');
    const guest = await fixture.member('Restricted profile');
    await grant(guest.user.id, [scope.id]);
    const options = { cookie: guest.cookie };
    const dashboard = await fixture.read<PersonalDashboard>('personal', options);
    assert.equal(dashboard.canListParticipants, false);
    assert.deepEqual(dashboard.meetingParticipants.map(member => member.userId), [guest.user.id]);
    const saved = await fixture.command<SelfProfile>('UpdateSelfProfile', { name: 'Actual restricted rename', timeZone: 'Asia/Shanghai' }, { ...options, extra: { targetId: guest.user.id, expectedVersions: { [guest.user.id]: dashboard.profile.version } } });
    assert.equal(saved.name, 'Actual restricted rename');
    assert.equal((await fixture.request<{ actor: Actor }>('/api/v1/auth/me', { cookie: guest.cookie })).body.actor.name, saved.name);
    const impersonation = await fixture.send(command('UpdateSelfProfile', { name: 'Cannot rename owner', timeZone: 'UTC' }, { targetId: fixture.owner.id, expectedVersions: { [fixture.owner.id]: 1 } }), options);
    assert.equal(impersonation.body.error?.code, 'invalid_scope');
    const privateEvents = await fixture.pool.query("SELECT audience_actor_id,payload FROM outbox WHERE aggregate_id=$1 AND aggregate_kind='self_profile'", [guest.user.id]);
    assert.equal(privateEvents.rows.length, 1);
    assert.equal(privateEvents.rows[0].audience_actor_id, guest.user.id);
    assert.deepEqual(Object.keys(privateEvents.rows[0].payload).sort(), ['id', 'kind', 'version']);
  });

  it('meetings validate actual intervals and active project participants, reject stale edits and retain cancellations', async () => {
    const scope = await project('Meeting project');
    const hidden = await project('Other meeting scope');
    const participant = await fixture.member('Meeting participant');
    const other = await fixture.member('Wrong-project participant');
    const membership = await grant(participant.user.id, [scope.id], ['domain.read', 'planning.edit']);
    await grant(other.user.id, [hidden.id], ['domain.read', 'planning.edit']);
    const payload = { title: 'Real project review', description: 'No external calendar sync', startsAt: '2026-11-01T09:00:00+08:00', endsAt: '2026-11-01T10:00:00+08:00', participantIds: [fixture.owner.id, participant.user.id] };
    const wrongInterval = await fixture.send(command('CreateProjectMeeting', { ...payload, endsAt: '2026-11-01T00:59:59Z' }, { projectId: scope.id }));
    assert.equal(wrongInterval.body.error?.code, 'invalid_meeting_interval');
    const wrongParticipant = await fixture.send(command('CreateProjectMeeting', { ...payload, participantIds: [other.user.id] }, { projectId: scope.id }));
    assert.equal(wrongParticipant.body.error?.code, 'meeting_participant_not_active');
    const disabled = await fixture.member('Disabled meeting participant');
    await grant(disabled.user.id, [scope.id]);
    await fixture.pool.query('UPDATE users SET disabled_at=now() WHERE id=$1', [disabled.user.id]);
    assert.equal((await fixture.send(command('CreateProjectMeeting', { ...payload, participantIds: [disabled.user.id] }, { projectId: scope.id }))).body.error?.code, 'meeting_participant_not_active');
    let meeting = await fixture.command<ProjectMeeting>('CreateProjectMeeting', payload, { cookie: participant.cookie, extra: { projectId: scope.id } });
    assert.equal(meeting.data.startsAt, '2026-11-01T01:00:00.000Z');
    assert.equal((await fixture.read<PersonalDashboard>('personal', { cookie: participant.cookie })).meetings.some(row => row.id === meeting.id), true);
    assert.equal((await fixture.read<PersonalDashboard>('personal', { cookie: other.cookie })).meetings.some(row => row.id === meeting.id), false);
    const noAccess = await fixture.send(command('UpdateProjectMeeting', payload, { targetId: meeting.id, expectedVersions: { [meeting.id]: meeting.version } }), { cookie: other.cookie });
    assert.equal(noAccess.status, 404);
    const old = meeting;
    meeting = await fixture.command<ProjectMeeting>('UpdateProjectMeeting', { ...payload, title: 'Updated meeting title', endsAt: '2026-11-01T11:00:00+08:00' }, { extra: { targetId: meeting.id, expectedVersions: { [meeting.id]: meeting.version } } });
    const stale = await fixture.send(command('UpdateProjectMeeting', payload, { targetId: meeting.id, expectedVersions: { [meeting.id]: old.version } }));
    assert.equal(stale.body.error?.code, 'version_conflict');
    await fixture.command('RevokeWorkspaceMember', { userId: participant.user.id }, { extra: { targetId: participant.user.id, expectedVersions: { [participant.user.id]: membership.version } } });
    const revokedParticipant = await fixture.send(command('UpdateProjectMeeting', payload, { targetId: meeting.id, expectedVersions: { [meeting.id]: meeting.version } }));
    assert.equal(revokedParticipant.body.error?.code, 'meeting_participant_not_active');
    const cancel = command('CancelProjectMeeting', { reason: 'Reschedule after access changes' }, { targetId: meeting.id, expectedVersions: { [meeting.id]: meeting.version } });
    const cancellation = await fixture.send(cancel);
    assert.equal(cancellation.status, 200, JSON.stringify(cancellation.body));
    assert.deepEqual((await fixture.send(cancel)).body, cancellation.body);
    meeting = cancellation.body.result as ProjectMeeting;
    assert.ok(meeting.data.cancelledAt);
    assert.equal(meeting.data.cancelledBy, fixture.owner.id);
    assert.equal(meeting.data.cancellationReason, 'Reschedule after access changes');
    const retained = (await fixture.read<PersonalDashboard>('personal')).meetings.find(row => row.id === meeting.id);
    assert.equal(retained?.data.cancelledAt, meeting.data.cancelledAt);
    const cannotEdit = await fixture.send(command('UpdateProjectMeeting', { ...payload, participantIds: [fixture.owner.id] }, { targetId: meeting.id, expectedVersions: { [meeting.id]: meeting.version } }));
    assert.equal(cannotEdit.body.error?.code, 'meeting_cancelled');
    const events = await fixture.pool.query('SELECT event_type,audience_actor_id FROM outbox WHERE aggregate_id=$1 ORDER BY id', [meeting.id]);
    assert.deepEqual(events.rows.map(row => row.event_type), ['ProjectMeetingCreated', 'ProjectMeetingUpdated', 'ProjectMeetingCancelled']);
    assert.equal(events.rows.every(row => row.audience_actor_id === null), true);
  });
});
