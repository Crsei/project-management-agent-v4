import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Membership } from '../packages/application/src/access.ts';
import type { Command, Entity } from '../packages/domain/src/core.ts';
import type { DashboardRecord } from '../packages/domain/src/dashboard.ts';
import type { ProjectTeam } from '../packages/domain/src/project-directory.ts';
import type { MemberCapacity, TeamWorkload } from '../packages/domain/src/team-workload.ts';
import type { FileRecord, ProtocolConfiguration } from '../packages/pm-schema/index.ts';
import { patchMarkdown } from '../packages/pm-markdown/index.ts';
import { createDashboardFixture, dashboardDatabaseUrl, type DashboardFixture } from './dashboard-fixture.ts';

function capacityCommand(userId: string, capacityPoints: number | null, previous?: MemberCapacity): Command {
  return { commandId: randomUUID(), commandType: 'SetMemberCapacity', payload: { userId, capacityPoints },
    ...(previous ? { targetId: previous.id, expectedVersions: { [previous.id]: previous.version } } : {}) };
}

describe('team workload: real PostgreSQL capacity, Markdown estimates and authorization', { skip: !dashboardDatabaseUrl, timeout: 180_000 }, () => {
  let fixture: DashboardFixture;
  before(async () => { fixture = await createDashboardFixture(); });
  after(async () => { await fixture?.close(); });
  const endpoint = () => `/api/v1/workspaces/${fixture.workspaceId}`;
  async function project(name: string): Promise<Entity> {
    return fixture.command('CreateProject', { name, goal: 'Workload evidence', ownerId: fixture.owner.id, completionCriteria: [] });
  }
  async function grant(userId: string, projectIds: string[] | null, capabilities = ['domain.read', 'directory.read'], previous?: Membership): Promise<Membership> {
    return fixture.command('SetWorkspaceMember', { userId, capabilities, projectIds }, previous ? { extra: { expectedVersions: { [userId]: previous.version } } } : {});
  }
  async function capacity(userId: string, points: number | null, previous?: MemberCapacity, cookie?: string): Promise<MemberCapacity> {
    const response = await fixture.send(capacityCommand(userId, points, previous), cookie ? { cookie } : {});
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body.result as MemberCapacity;
  }
  async function patch(id: string, changes: Record<string, unknown>): Promise<FileRecord> {
    const file = await fixture.request<FileRecord>(`${endpoint()}/core/files/${id}`);
    assert.equal(file.status, 200, JSON.stringify(file.body));
    const result = await fixture.request<FileRecord>(`${endpoint()}/core/entities/${id}`, { method: 'PATCH', body: { revision: file.body.revision, changes } });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  }
  async function task(p: Entity, title: string, assigneeId: string | null, estimate?: number): Promise<Entity> {
    const created = await fixture.command('CreateWorkItem', { title, description: 'Markdown remains authoritative', acceptanceCriteria: [], assigneeId }, { extra: { projectId: p.id } });
    if (estimate !== undefined) await patch(created.id, { 'x-pm-estimate': estimate });
    return created;
  }
  async function workload(cookie?: string): Promise<TeamWorkload> {
    const result = await fixture.request<TeamWorkload>(`${endpoint()}/teams/workload`, cookie ? { cookie } : {});
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  }
  async function team(p: Entity, name: string, memberIds: string[]): Promise<DashboardRecord<ProjectTeam>> {
    const created = await fixture.command<DashboardRecord<ProjectTeam>>('CreateProjectTeam', { name, memberIds });
    await fixture.command('SetProjectTeams', { teamIds: [created.id] }, { extra: {
      projectId: p.id, targetId: p.id, expectedVersions: { [p.id]: p.version, [created.id]: created.version },
    } });
    return created;
  }

  it('preserves null/zero/positive capacities, serializes CAS and writes one transactional event on idempotent replay', async () => {
    const member = await fixture.member('Capacity subject');
    await grant(member.user.id, null);
    const command = capacityCommand(member.user.id, null);
    const first = await fixture.send(command);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const initial = first.body.result as MemberCapacity;
    assert.equal(initial.data.capacityPoints, null);
    assert.equal(initial.kind, 'member_capacity');
    assert.deepEqual((await fixture.send(command)).body, first.body);
    assert.equal((await fixture.send({ ...command, payload: { ...command.payload, capacityPoints: 10 } })).status, 409);
    assert.equal((await fixture.send(capacityCommand(member.user.id, 1))).body.error?.code, 'version_conflict');
    assert.equal((await fixture.send({ ...capacityCommand(member.user.id, 1), targetId: member.user.id, expectedVersions: { [member.user.id]: initial.version } })).status, 409);
    assert.equal((await fixture.send({ ...capacityCommand(member.user.id, 1), targetId: initial.id })).body.error?.code, 'version_conflict');
    const zero = await capacity(member.user.id, 0, initial);
    assert.equal(zero.data.capacityPoints, 0);
    assert.equal(zero.version, initial.version + 1);
    const concurrent = await Promise.all([2.5, 10].map(points => fixture.send(capacityCommand(member.user.id, points, zero))));
    assert.deepEqual(concurrent.map(result => result.status).sort(), [200, 409]);
    const saved = concurrent.find(result => result.status === 200)!.body.result as MemberCapacity;
    assert.ok(saved.data.capacityPoints! > 0);
    const cleared = await capacity(member.user.id, null, saved);
    assert.equal(cleared.data.capacityPoints, null);
    assert.equal(cleared.id, initial.id);
    const row = (await workload()).members.find(value => value.userId === member.user.id)!;
    assert.deepEqual(row.capacity, { id: cleared.id, version: cleared.version, capacityPoints: null });
    assert.equal(row.capacityPoints, null);
    assert.equal(row.overloaded, null);
    assert.equal((await fixture.pool.query('SELECT count(*)::text AS count FROM outbox WHERE command_id=$1', [command.commandId])).rows[0].count, '1');
    assert.equal((await fixture.pool.query("SELECT count(*)::text AS count FROM dashboard_records WHERE workspace_id=$1 AND kind='member_capacity' AND data->>'userId'=$2", [fixture.workspaceId, member.user.id])).rows[0].count, '1');
    const event = await fixture.pool.query('SELECT aggregate_id,aggregate_version,event_type FROM outbox WHERE command_id=$1', [command.commandId]);
    assert.deepEqual(event.rows, [{ aggregate_id: initial.id, aggregate_version: initial.version, event_type: 'MemberCapacitySet' }]);
    for (const points of [-1, 1_000_001, '0']) {
      const response = await fixture.send({ ...capacityCommand(member.user.id, null, cleared), payload: { userId: member.user.id, capacityPoints: points } });
      assert.equal(response.status, 400);
    }
  });

  it('requires workspace access.manage and an active target, but does not require business read for administration', async () => {
    const subject = await fixture.member('Revocable capacity member');
    const member = await grant(subject.user.id, null);
    const manager = await fixture.member('Capacity-only administrator');
    const administration = await grant(manager.user.id, null, ['access.manage']);
    const saved = await capacity(subject.user.id, 8, undefined, manager.cookie);
    const forbidden = await fixture.request(`${endpoint()}/teams/workload`, { cookie: manager.cookie });
    assert.equal(forbidden.status, 403);
    assert.equal(JSON.stringify(forbidden.body).includes(saved.id), false);
    const attempt = capacityCommand(subject.user.id, 10, saved);
    const denied = await fixture.send(attempt, { cookie: subject.cookie });
    assert.equal(denied.status, 403);
    assert.equal((await fixture.pool.query('SELECT count(*)::text AS count FROM outbox WHERE command_id=$1', [attempt.commandId])).rows[0].count, '0');
    await fixture.command('RevokeWorkspaceMember', { userId: subject.user.id }, { extra: { expectedVersions: { [subject.user.id]: member.version } } });
    assert.equal((await fixture.send(capacityCommand(subject.user.id, 9, saved))).status, 404);
    assert.equal((await workload()).members.some(row => row.userId === subject.user.id), false);
    assert.equal((await fixture.send(capacityCommand(randomUUID(), 3))).status, 404);
    const disabled = await fixture.member('Disabled capacity subject');
    await grant(disabled.user.id, null);
    await fixture.pool.query('UPDATE users SET disabled_at=now() WHERE id=$1', [disabled.user.id]);
    assert.equal((await fixture.send(capacityCommand(disabled.user.id, 3))).status, 404);
    const ownCommand = capacityCommand(manager.user.id, 2);
    assert.equal((await fixture.send(ownCommand, { cookie: manager.cookie })).status, 200);
    await grant(manager.user.id, null, ['domain.read', 'directory.read'], administration);
    assert.ok([403, 404].includes((await fixture.request(`${endpoint()}/commands/${ownCommand.commandId}`, { cookie: manager.cookie })).status));
    assert.ok([403, 404].includes((await fixture.send(ownCommand, { cookie: manager.cookie })).status));
    const scopedManager = await fixture.member('Not a workspace administrator');
    const p = await project('Scoped authority');
    await grant(scopedManager.user.id, [p.id], ['domain.read', 'directory.read']);
    assert.ok([403, 404].includes((await fixture.send(capacityCommand(scopedManager.user.id, 3), { cookie: scopedManager.cookie })).status));
  });

  it('enforces capacity identity, scope, bounds, active-member and uniqueness in PostgreSQL itself', async () => {
    const subject = await fixture.member('Database capacity integrity');
    await grant(subject.user.id, null);
    const created = await capacity(subject.user.id, 0);
    await assert.rejects(fixture.pool.query(`INSERT INTO dashboard_records(id,workspace_id,kind,data,created_by)
      VALUES($1,$2,'member_capacity',$3::jsonb,$4)`, [randomUUID(), fixture.workspaceId, JSON.stringify({ userId: subject.user.id, capacityPoints: 1 }), fixture.owner.id]), /unique|duplicate/);
    for (const capacityPoints of [-1, 1_000_001, '8']) await assert.rejects(fixture.pool.query('UPDATE dashboard_records SET data=$1::jsonb,version=version+1 WHERE id=$2', [JSON.stringify({ userId: subject.user.id, capacityPoints }), created.id]), /capacity/);
    await assert.rejects(fixture.pool.query('UPDATE dashboard_records SET data=$1::jsonb,version=version+1 WHERE id=$2', [JSON.stringify({ userId: fixture.owner.id, capacityPoints: 0 }), created.id]), /immutable/);
    await assert.rejects(fixture.pool.query(`INSERT INTO dashboard_records(id,workspace_id,project_id,kind,data,created_by)
      VALUES($1,$2,'PRJ-999999','member_capacity',$3::jsonb,$4)`, [randomUUID(), fixture.workspaceId, JSON.stringify({ userId: fixture.owner.id, capacityPoints: 1 }), fixture.owner.id]), /workspace scope/);
    await assert.rejects(fixture.pool.query(`INSERT INTO dashboard_records(id,workspace_id,kind,data,created_by)
      VALUES($1,$2,'member_capacity',$3::jsonb,$4)`, [randomUUID(), fixture.workspaceId, JSON.stringify({ userId: randomUUID(), capacityPoints: null }), fixture.owner.id]), /active workspace membership/);
  });

  it('projects unknown estimates and canonical terminal states while hiding unauthorized projects, groups and assignees', async () => {
    const visible = await project('Visible workload project');
    const hidden = await project('Hidden workload project');
    const reader = await fixture.member('Project workload observer');
    const broad = await fixture.member('Member with incomplete reader scope');
    const narrow = await fixture.member('Member with wholly visible current grants');
    const hiddenPerson = await fixture.member('Hidden workload identity');
    const revoked = await fixture.member('Revoked workload identity');
    await grant(reader.user.id, [visible.id]);
    await grant(broad.user.id, null);
    await grant(narrow.user.id, [visible.id]);
    await grant(hiddenPerson.user.id, [hidden.id]);
    const revokedMembership = await grant(revoked.user.id, [visible.id]);
    const visibleTeam = await team(visible, 'Visible workload team', [reader.user.id, broad.user.id, narrow.user.id]);
    const hiddenTeam = await team(hidden, 'Hidden workload team', [hiddenPerson.user.id]);
    const broadCapacity = await capacity(broad.user.id, 5);
    await capacity(narrow.user.id, 20);
    const known = await task(visible, 'Known open points', broad.user.id, 3);
    const unknown = await task(visible, 'Unknown open points', broad.user.id);
    const hiddenTask = await task(hidden, 'Invisible work', broad.user.id, 10);
    const narrowKnown = await task(visible, 'Known complete-scope work', narrow.user.id, 2);
    const zero = await task(visible, 'Explicit zero', narrow.user.id, 0);
    const done = await task(visible, 'Canonical completed', narrow.user.id, 100);
    const canceled = await task(visible, 'Canonical canceled', narrow.user.id, 100);
    const archived = await task(visible, 'Archived is not open', narrow.user.id, 100);
    const pool = await task(visible, 'Authorized unassigned pool', null, 4);
    const hiddenPool = await task(hidden, 'Hidden unassigned pool', null, 100);
    const revokedTask = await task(visible, 'Historical revoked assignee', revoked.user.id, 100);
    const unknownAssignee = randomUUID();
    const unknownTask = await task(visible, 'Unknown assignee is not a pool item', null, 100);
    // Historical external source can contain an unknown identity; authenticated
    // mutation routes must reject creating that assignment today.
    const historical = await fixture.request<FileRecord>(`${endpoint()}/core/files/${unknownTask.id}`);
    const stream = new AbortController();
    const events = await fetch(`${fixture.origin}${endpoint()}/core/events`, {
      headers: { cookie: fixture.ownerCookie },
      signal: AbortSignal.any([stream.signal, AbortSignal.timeout(10_000)]),
    });
    assert.equal(events.status, 200);
    try {
      const reader = events.body!.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      await writeFile(join(fixture.coreRoot, fixture.workspaceId, historical.body.path), patchMarkdown(historical.body.raw, { assignee: unknownAssignee }));
      while (true) {
        const event = await reader.read();
        assert.equal(event.done, false, 'Native change stream ended before indexing historical assignment');
        pending += decoder.decode(event.value, { stream: true });
        if (!pending.includes('event: change\n')) continue;
        pending = '';
        const observed = await fixture.request<FileRecord>(`${endpoint()}/core/files/${unknownTask.id}`);
        if (observed.body.entity.assignee === unknownAssignee) break;
      }
    } finally { stream.abort(); }
    await patch(canceled.id, { status: 'canceled' });
    await patch(archived.id, { archived: true });
    // A configured terminal state has no legacy PM name; its category is authoritative.
    const configuration = await fixture.request<{ config: ProtocolConfiguration; revision: string }>(`${endpoint()}/core/config`);
    const config = structuredClone(configuration.body.config);
    config.workflows.work_item!.states.push({ id: 'accepted_custom', label: 'Accepted', category: 'completed' });
    config.workflows.work_item!.transitions.push({ from: 'todo', to: 'accepted_custom' });
    assert.equal((await fixture.request(`${endpoint()}/core/config`, { method: 'PUT', body: { config, revision: configuration.body.revision } })).status, 200);
    await patch(done.id, { status: 'accepted_custom' });
    await fixture.command('RevokeWorkspaceMember', { userId: revoked.user.id }, { extra: { expectedVersions: { [revoked.user.id]: revokedMembership.version } } });
    const restricted = await workload(reader.cookie);
    assert.deepEqual(restricted.scope, { complete: false, projectIds: [visible.id], reason: 'projects' });
    const broadRow = restricted.members.find(member => member.userId === broad.user.id)!;
    assert.deepEqual([broadRow.openCount, broadRow.knownOpenPoints, broadRow.unknownEstimateCount, broadRow.overloaded], [2, 3, 1, null]);
    assert.deepEqual(broadRow.scope, { complete: false, reason: 'partial' });
    assert.deepEqual(new Set(broadRow.taskIds), new Set([known.id, unknown.id]));
    const narrowRow = restricted.members.find(member => member.userId === narrow.user.id)!;
    assert.deepEqual([narrowRow.openCount, narrowRow.doneCount, narrowRow.knownOpenPoints, narrowRow.unknownEstimateCount, narrowRow.overloaded], [2, 1, 2, 0, null]);
    assert.deepEqual(narrowRow.scope, { complete: false, reason: 'partial' });
    assert.equal(restricted.tasks.find(value => value.id === unknown.id)?.estimatePoints, null);
    assert.equal(restricted.tasks.find(value => value.id === zero.id)?.estimatePoints, 0);
    assert.equal(restricted.tasks.find(value => value.id === done.id)?.open, false);
    assert.equal(restricted.tasks.find(value => value.id === done.id)?.done, true);
    assert.equal(restricted.tasks.find(value => value.id === canceled.id)?.open, false);
    assert.deepEqual(new Set(restricted.unassignedTaskIds), new Set([pool.id, unknownTask.id, revokedTask.id]));
    assert.equal(restricted.tasks.find(value => value.id === pool.id)?.assigneeStatus, 'unassigned');
    for (const taskId of [unknownTask.id, revokedTask.id]) {
      const retained = restricted.tasks.find(value => value.id === taskId)!;
      assert.equal(retained.assigneeId, null);
      assert.equal(retained.assigneeStatus, 'unavailable');
      assert.equal(retained.estimatePoints, 100);
      assert.equal(retained.open, true);
    }
    assert.deepEqual(restricted.teams.map(value => value.id), [visibleTeam.id]);
    assert.deepEqual(new Set(restricted.teams[0]!.memberIds), new Set([reader.user.id, broad.user.id, narrow.user.id]));
    assert.ok(restricted.teams[0]!.taskIds.includes(narrowKnown.id));
    assert.ok(restricted.teams[0]!.taskIds.includes(pool.id));
    assert.deepEqual(restricted.summary, { openCount: 7, doneCount: 1, knownOpenPoints: 209, unknownEstimateCount: 1, unknownAssigneeCount: 2, overloadedMemberCount: 0, unknownOverloadMemberCount: restricted.members.filter(member => member.overloaded === null).length });
    const serialized = JSON.stringify(restricted);
    for (const secret of [hidden.id, hiddenTask.id, hiddenPool.id, hiddenPerson.user.id, hiddenTeam.id, hiddenTeam.data.name, unknownAssignee, revoked.user.id, archived.id]) assert.equal(serialized.includes(secret), false, secret);
    const full = await workload();
    assert.equal(full.members.find(member => member.userId === broad.user.id)?.overloaded, true);
    assert.equal(full.members.find(member => member.userId === broad.user.id)?.knownOpenPoints, 13);
    assert.equal(full.members.find(member => member.userId === narrow.user.id)?.overloaded, false);
    assert.deepEqual(full.members.find(member => member.userId === narrow.user.id)?.scope, { complete: true, reason: 'workspace' });
    await capacity(broad.user.id, 2, broadCapacity);
    assert.equal((await workload(reader.cookie)).members.find(member => member.userId === broad.user.id)?.overloaded, true);
    // Clearing is unknown rather than a zero estimate, and changes the native projection too.
    await patch(zero.id, { 'x-pm-estimate': null });
    const afterClear = await workload(reader.cookie);
    assert.equal(afterClear.members.find(member => member.userId === narrow.user.id)?.overloaded, null);
    assert.equal(afterClear.members.find(member => member.userId === narrow.user.id)?.unknownEstimateCount, 1);
    const entity = await fixture.request<Entity>(`${endpoint()}/entities/${zero.id}`);
    assert.equal(entity.body.data.estimatePoints, null);
    const noDirectory = await fixture.member('Task reader without directory authority');
    await grant(noDirectory.user.id, [visible.id], ['domain.read']);
    assert.equal((await fixture.request(`${endpoint()}/teams/workload`, { cookie: noDirectory.cookie })).status, 403);
  });

  it('rejects invalid native estimates without a SQL task replica and forbids ineligible task assignments', async () => {
    const p = await project('Task creation guards');
    const other = await project('Other assignment scope');
    const eligible = await fixture.member('Eligible task assignee');
    const wrong = await fixture.member('Wrong-project assignee');
    const revoked = await fixture.member('Revoked task assignee');
    const outsider = await fixture.member('Not a workspace member');
    const disabled = await fixture.member('Disabled task assignee');
    await grant(eligible.user.id, [p.id]);
    await grant(wrong.user.id, [other.id]);
    await grant(disabled.user.id, [p.id]);
    await fixture.pool.query('UPDATE users SET disabled_at=now() WHERE id=$1', [disabled.user.id]);
    const revokedMembership = await grant(revoked.user.id, [p.id]);
    await fixture.command('RevokeWorkspaceMember', { userId: revoked.user.id }, { extra: { expectedVersions: { [revoked.user.id]: revokedMembership.version } } });
    for (const assigneeId of [wrong.user.id, revoked.user.id, outsider.user.id, disabled.user.id]) {
      const result = await fixture.send({ commandId: randomUUID(), commandType: 'CreateWorkItem', projectId: p.id, payload: { title: 'Must not be created', description: '', acceptanceCriteria: [], assigneeId } });
      assert.equal(result.body.error?.code, 'workspace_member_required');
    }
    const noRead = await fixture.member('Planning-only actor');
    await grant(noRead.user.id, null, ['planning.edit']);
    const noReadCreate = await fixture.send({ commandId: randomUUID(), commandType: 'CreateWorkItem', projectId: p.id, payload: { title: 'No implicit read', description: '', acceptanceCriteria: [], assigneeId: eligible.user.id } }, { cookie: noRead.cookie });
    assert.equal(noReadCreate.status, 403);
    const created = await task(p, 'Native estimate validation', eligible.user.id, 0);
    for (const estimate of [-1, 1_000_001, '8']) {
      const file = await fixture.request<FileRecord>(`${endpoint()}/core/files/${created.id}`);
      const result = await fixture.request(`${endpoint()}/core/entities/${created.id}`, { method: 'PATCH', body: { revision: file.body.revision, changes: { 'x-pm-estimate': estimate } } });
      assert.equal(result.status, 422);
    }
    assert.equal((await fixture.pool.query("SELECT count(*)::text AS count FROM entities WHERE workspace_id=$1 AND kind='work_item'", [fixture.workspaceId])).rows[0].count, '0');
    await patch(p.id, { archived: true });
    const archived = await fixture.send({ commandId: randomUUID(), commandType: 'CreateWorkItem', projectId: p.id, payload: { title: 'Cannot create in archived project', description: '', acceptanceCriteria: [], assigneeId: eligible.user.id } });
    assert.equal(archived.body.error?.code, 'object_archived');
    assert.equal((await workload()).tasks.some(value => value.id === created.id), false);
    await patch(p.id, { archived: false, status: 'completed' });
    const terminal = await fixture.send({ commandId: randomUUID(), commandType: 'CreateWorkItem', projectId: p.id, payload: { title: 'Cannot create in terminal project', description: '', acceptanceCriteria: [], assigneeId: eligible.user.id } });
    assert.equal(terminal.body.error?.code, 'invalid_state');
  });
});
