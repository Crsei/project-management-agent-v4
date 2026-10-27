import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Command, CommandReceipt, Entity } from '../packages/domain/src/core.ts';
import type { PersonalDashboard, PrivateNote, TaskWatch } from '../packages/domain/src/dashboard-personal.ts';
import type { PlanningDashboard } from '../packages/domain/src/dashboard-planning.ts';
import { publishOutboxBatch } from '../packages/application/src/outbox.ts';
import { createDashboardFixture, dashboardDatabaseUrl } from './dashboard-fixture.ts';

type Changes = { events: { cursor: string; event: { aggregateId: string; aggregateKind: string; projectId: string | null } }[]; cursor: string; head: string };
const input = (commandType: string, payload: Record<string, unknown>, extra: Partial<Command> = {}): Command => ({ commandId: randomUUID(), commandType, payload, ...extra });

describe('dashboard foundation authorization, receipts and concurrency', { skip: !dashboardDatabaseUrl, timeout: 240_000 }, () => {
  it('keeps private data and committed/rejected receipt replay actor-scoped for restricted members', async t => {
    const f = await createDashboardFixture();
    t.after(() => f.close());
    const first = await f.member('Restricted first'), second = await f.member('Restricted second');
    let membership = await f.command<{ version: number }>('SetWorkspaceMember', { userId: first.user.id, capabilities: ['domain.read'], projectIds: [] });
    await f.command('SetWorkspaceMember', { userId: second.user.id, capabilities: ['domain.read'], projectIds: [] });
    const command = input('CreatePrivateNote', { content: 'A private restricted-member note' });
    const created = await f.send(command, { cookie: first.cookie });
    assert.equal(created.body.status, 'committed', JSON.stringify(created.body));
    const note = created.body.result as PrivateNote;
    assert.equal(note.ownerId, first.user.id);
    assert.equal(note.projectId, null);
    assert.deepEqual((await f.send(command, { cookie: first.cookie })).body, created.body);
    const receipt = await f.request<CommandReceipt>(`/api/v1/workspaces/${f.workspaceId}/commands/${command.commandId}`, { cookie: first.cookie });
    assert.deepEqual(receipt.body, created.body);
    assert.equal(receipt.status, 200);
    assert.equal((await f.request(`/api/v1/workspaces/${f.workspaceId}/commands/${command.commandId}`, { cookie: second.cookie })).status, 404);
    assert.deepEqual((await f.read<PersonalDashboard>('personal', { cookie: second.cookie })).notes, []);
    const own = await f.read<PersonalDashboard>('personal', { cookie: first.cookie });
    assert.deepEqual(own.notes.map(row => row.id), [note.id]);
    assert.equal(own.canListParticipants, false);
    assert.deepEqual(own.meetingParticipants.map(row => row.userId), [first.user.id]);
    assert.equal((await f.request(`/api/v1/workspaces/${f.workspaceId}/members`, { cookie: first.cookie })).status, 404);
    const otherUpdate = input('UpdatePrivateNote', { content: 'Cannot overwrite another user' }, { targetId: note.id, expectedVersions: { [note.id]: note.version } });
    const forbidden = await f.send(otherUpdate, { cookie: second.cookie });
    assert.equal(forbidden.status, 404);
    assert.equal(forbidden.body.error?.code, 'not_found_or_forbidden');
    assert.deepEqual((await f.send(otherUpdate, { cookie: second.cookie })).body, forbidden.body);
    assert.deepEqual((await f.request(`/api/v1/workspaces/${f.workspaceId}/commands/${otherUpdate.commandId}`, { cookie: second.cookie })).body, forbidden.body);
    const altered = await f.send({ ...command, payload: { content: 'Same ID cannot mean another write' } }, { cookie: first.cookie });
    assert.equal(altered.status, 409);
    assert.equal((await f.read<PersonalDashboard>('personal', { cookie: first.cookie })).notes[0]!.data.content, note.data.content);
    membership = await f.command('SetWorkspaceMember', { userId: first.user.id, capabilities: [], projectIds: [] }, { extra: { expectedVersions: { [first.user.id]: membership.version } } });
    assert.equal((await f.request(`/api/v1/workspaces/${f.workspaceId}/commands/${command.commandId}`, { cookie: first.cookie })).status, 403);
    assert.equal((await f.send(command, { cookie: first.cookie })).status, 403);
    assert.equal((await f.request(`/api/v1/workspaces/${f.workspaceId}/dashboard/personal`, { cookie: first.cookie })).status, 403);
    await f.command('RevokeWorkspaceMember', { userId: first.user.id }, { extra: { expectedVersions: { [first.user.id]: membership.version } } });
    assert.equal((await f.request(`/api/v1/workspaces/${f.workspaceId}/commands/${command.commandId}`, { cookie: first.cookie })).status, 404);
  });

  it('CASes private records and atomically deduplicates commands, records, receipts and outbox', async t => {
    const f = await createDashboardFixture();
    t.after(() => f.close());
    const create = input('CreatePrivateNote', { content: 'Exactly once' });
    const replay = await Promise.all([f.send(create), f.send(create)]);
    assert.deepEqual(replay[0]!.body, replay[1]!.body);
    assert.equal(replay[0]!.body.status, 'committed');
    const note = replay[0]!.body.result as PrivateNote;
    const counts = await f.pool.query<{ records: string; receipts: string; events: string }>(`SELECT (SELECT count(*) FROM dashboard_records WHERE id=$1)::text AS records,
      (SELECT count(*) FROM command_receipts WHERE command_id=$2)::text AS receipts,
      (SELECT count(*) FROM outbox WHERE command_id=$2)::text AS events`, [note.id, create.commandId]);
    assert.deepEqual(counts.rows[0], { records: '1', receipts: '1', events: '1' });
    const missing = await f.send(input('UpdatePrivateNote', { content: 'Missing expected version' }, { targetId: note.id }));
    assert.equal(missing.status, 409);
    assert.equal(missing.body.error?.code, 'version_conflict');
    const contenders = await Promise.all(['First contender', 'Second contender'].map(content => f.send(input('UpdatePrivateNote', { content }, { targetId: note.id, expectedVersions: { [note.id]: note.version } }))));
    assert.deepEqual(contenders.map(row => row.status).sort(), [200, 409]);
    const current = (await f.read<PersonalDashboard>('personal')).notes.find(row => row.id === note.id)!;
    assert.equal(current.version, note.version + 1);
    assert.ok(['First contender', 'Second contender'].includes(current.data.content));
    const outbox = await f.pool.query<{ count: string }>('SELECT count(*)::text AS count FROM outbox WHERE aggregate_id=$1', [note.id]);
    assert.equal(outbox.rows[0]!.count, '2');
    await assert.rejects(f.pool.query('UPDATE dashboard_records SET owner_id=$2,version=version+1 WHERE id=$1', [note.id, null]), error => typeof error === 'object' && error !== null && 'code' in error && error.code === '23514');
  });

  it('filters private events before delivery while checkpointing every scanned stream position', async t => {
    const f = await createDashboardFixture();
    t.after(() => f.close());
    const member = await f.member('Private stream member');
    await f.command('SetWorkspaceMember', { userId: member.user.id, capabilities: ['domain.read'], projectIds: [] });
    for (let i = 0; i < 205; i++) await f.command('CreatePrivateNote', { content: `Owner-private record ${i}` });
    const own = await f.command<PrivateNote>('CreatePrivateNote', { content: 'Visible only to stream member' }, { cookie: member.cookie });
    while (await publishOutboxBatch(f.pool, 500)) { /* Publish through the actual worker application service. */ }
    const path = `/api/v1/workspaces/${f.workspaceId}/changes`;
    const first = await f.request<Changes>(`${path}?after=0`, { cookie: member.cookie });
    assert.equal(first.status, 200);
    assert.equal(first.body.cursor, '200');
    assert.equal(first.body.events.some(row => row.event.aggregateKind === 'private_note'), false);
    const second = await f.request<Changes>(`${path}?after=${first.body.cursor}`, { cookie: member.cookie });
    assert.equal(second.status, 200);
    assert.equal(second.body.cursor, second.body.head);
    assert.deepEqual(second.body.events.filter(row => row.event.aggregateKind === 'private_note').map(row => row.event.aggregateId), [own.id]);
    const owner = await f.request<Changes>(`${path}?after=200`);
    assert.equal(owner.body.events.some(row => row.event.aggregateId === own.id), false);
    const raw = await f.pool.query<{ payload: unknown; audience_actor_id: string }>('SELECT payload,audience_actor_id FROM outbox WHERE aggregate_id=$1', [own.id]);
    assert.equal(raw.rows[0]!.audience_actor_id, member.user.id);
    assert.deepEqual(raw.rows[0]!.payload, { id: own.id, kind: 'private_note', version: 1 });
    const stream = await fetch(`${f.origin}/api/v1/workspaces/${f.workspaceId}/events?after=200`, { headers: { cookie: member.cookie }, signal: AbortSignal.timeout(10_000) });
    assert.equal(stream.status, 200);
    assert.ok(stream.body);
    const reader = stream.body.getReader();
    try {
      let frames = '';
      const decoder = new TextDecoder();
      while (!frames.includes('event: checkpoint')) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false, 'The stream must checkpoint the scanned positions');
        frames += decoder.decode(chunk.value, { stream: true });
      }
      assert.match(frames, /event: change/);
      assert.match(frames, new RegExp(own.id));
      assert.equal(frames.includes('Owner-private record'), false);
    } finally { await reader.cancel(); reader.releaseLock(); }
  });

  it('rechecks project grants for private references and every native receipt dependency endpoint', async t => {
    const f = await createDashboardFixture();
    t.after(() => f.close());
    const createProject = (name: string) => f.command<Entity>('CreateProject', { name, goal: 'Foundation authorization', ownerId: f.owner.id, completionCriteria: [] });
    const project = await createProject('Source'), dependency = await createProject('Dependency');
    const task = await f.command<Entity>('CreateWorkItem', { title: 'Watched task', description: '', acceptanceCriteria: [] }, { extra: { projectId: project.id } });
    const member = await f.member('Project reader');
    let grant = await f.command<{ version: number }>('SetWorkspaceMember', { userId: member.user.id, capabilities: ['domain.read', 'planning.edit'], projectIds: [project.id, dependency.id] });
    const watchCommand = input('WatchTask', { taskId: task.id });
    const watched = await f.send(watchCommand, { cookie: member.cookie });
    assert.equal(watched.status, 200);
    const watch = watched.body.result as TaskWatch;
    const graphCommand = input('SetProjectDependencies', { dependsOn: [dependency.id] }, { targetId: project.id, expectedVersions: { [project.id]: project.version } });
    const graph = await f.send(graphCommand, { cookie: member.cookie });
    assert.equal(graph.status, 200, JSON.stringify(graph.body));
    const scopes = await f.pool.query<{ scope_project_ids: string[] }>('SELECT scope_project_ids FROM command_receipts WHERE command_id=$1', [graphCommand.commandId]);
    assert.deepEqual(scopes.rows[0]!.scope_project_ids.sort(), [project.id, dependency.id].sort());
    grant = await f.command('SetWorkspaceMember', { userId: member.user.id, capabilities: ['domain.read', 'planning.edit'], projectIds: [project.id] }, { extra: { expectedVersions: { [member.user.id]: grant.version } } });
    assert.equal((await f.request(`/api/v1/workspaces/${f.workspaceId}/commands/${graphCommand.commandId}`, { cookie: member.cookie })).status, 404);
    assert.equal((await f.send(graphCommand, { cookie: member.cookie })).status, 404);
    const visible = await f.read<PlanningDashboard>('planning', { cookie: member.cookie });
    assert.equal(visible.projects[0]!.hasUnavailableDependencies, true);
    assert.deepEqual(visible.projects[0]!.dependsOn, []);
    assert.equal(JSON.stringify(visible).includes(dependency.id), false);
    grant = await f.command('SetWorkspaceMember', { userId: member.user.id, capabilities: ['domain.read'], projectIds: [] }, { extra: { expectedVersions: { [member.user.id]: grant.version } } });
    assert.deepEqual((await f.read<PersonalDashboard>('personal', { cookie: member.cookie })).watches, []);
    assert.equal((await f.request(`/api/v1/workspaces/${f.workspaceId}/commands/${watchCommand.commandId}`, { cookie: member.cookie })).status, 404);
    assert.equal((await f.send(input('UnwatchTask', {}, { targetId: watch.id, expectedVersions: { [watch.id]: watch.version } }), { cookie: member.cookie })).status, 404);
    assert.equal(grant.version, 3);
  });
});
