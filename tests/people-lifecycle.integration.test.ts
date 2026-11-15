import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { Membership } from '../packages/application/src/access.ts';
import { continueMemberHandover, reconcileMemberHandover, type HandoverExecutor } from '../packages/application/src/member-lifecycle.ts';
import type { Command, CommandReceipt, Entity } from '../packages/domain/src/core.ts';
import type { MemberHandover, MemberImpact } from '../packages/domain/src/member-lifecycle.ts';
import { createDashboardFixture, dashboardDatabaseUrl, type DashboardFixture } from './dashboard-fixture.ts';

describe('people lifecycle: real Markdown, PG, receipts and authorization', { skip: !dashboardDatabaseUrl, timeout: 180_000 }, () => {
  let fixture: DashboardFixture;
  before(async () => { fixture = await createDashboardFixture(); });
  after(async () => { await fixture?.close(); });
  const root = () => `/api/v1/workspaces/${fixture.workspaceId}`;
  async function person(name: string, capabilities = ['domain.read']) {
    const member = await fixture.member(name);
    const membership = await fixture.command<Membership>('SetWorkspaceMember', { userId: member.user.id, capabilities, projectIds: null });
    return { ...member, membership };
  }
  async function impact(userId: string, cookie?: string) {
    const result = await fixture.request<MemberImpact>(`${root()}/people/members/${userId}/impact`, cookie ? { cookie } : {});
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.headers.get('cache-control'), 'no-store');
    return result.body;
  }
  async function project(ownerId: string, name: string) {
    return fixture.command<Entity>('CreateProject', { name, goal: 'Lifecycle responsibility test', ownerId, completionCriteria: [] });
  }
  async function task(projectId: string, userId: string, parentId?: string) {
    return fixture.command<Entity>('CreateWorkItem', { title: parentId ? 'Actual subtask' : 'Actual parent task', description: 'Keep authoritative content', acceptanceCriteria: [{ id: randomUUID(), text: 'Deliver real content' }], assigneeId: userId, priority: 'normal', ...(parentId ? { parentId, kind: 'subtask' } : {}) }, { extra: { projectId } });
  }
  async function prepare(userId: string, recipientId: string, selected?: string[]) {
    const current = await impact(userId);
    return fixture.command<MemberHandover>('PrepareMemberHandover', { userId, recipientId,
      items: current.duties.filter(duty => !selected || selected.includes(duty.id)).map(({ id, kind, version }) => ({ id, kind, version })) },
    { extra: { targetId: userId, expectedVersions: { [userId]: current.membershipVersion } } });
  }
  const departure = (userId: string, version: number, type = 'LeaveWorkspace'): Command => ({ commandId: randomUUID(), commandType: type, targetId: userId, expectedVersions: { [userId]: version }, payload: { userId } });

  it('includes project, milestone, subtask and maintainer duties; transfers actual owners without completing work', async () => {
    const source = await person('Departing responsible member'); const recipient = await person('Responsible recipient');
    const scope = await project(source.user.id, 'Owned source project');
    const parent = await task(scope.id, source.user.id); const child = await task(scope.id, source.user.id, parent.id);
    const milestone = await fixture.command<Entity>('CreateMilestone', { title: 'Owned milestone', criteria: [], targetDate: null }, { extra: { projectId: scope.id } });
    const owned = await fixture.command<Entity>('UpdateMilestone', { ownerId: source.user.id }, { extra: { targetId: milestone.id, projectId: scope.id, expectedVersions: { [milestone.id]: milestone.version } } });
    const team = await fixture.command<{ id: string }>('CreateProjectTeam', { name: 'Real human maintainers', memberIds: [source.user.id], maintainerIds: [source.user.id] });
    const before = await impact(source.user.id);
    assert.equal(before.scopeComplete, true);
    assert.deepEqual(new Set(before.duties.map(duty => duty.id)), new Set([scope.id, parent.id, child.id, owned.id, team.id]));
    assert.equal(before.duties.find(duty => duty.id === child.id)?.parentId, parent.id);
    const deniedLeave = await fixture.send(departure(source.user.id, source.membership.version), { cookie: source.cookie });
    assert.equal(deniedLeave.body.error?.code, 'handover_required');
    const operation = await prepare(source.user.id, recipient.user.id);
    const continued = await fixture.request<MemberHandover>(`${root()}/people/handovers/${operation.id}/continue`, { method: 'POST', body: { expectedVersion: operation.version } });
    assert.equal(continued.status, 200, JSON.stringify(continued.body));
    assert.equal(continued.body.status, 'completed');
    assert.ok(continued.body.items.every(item => item.receipt?.status === 'committed'));
    assert.equal((await impact(source.user.id)).duties.length, 0);
    const after = await impact(recipient.user.id);
    assert.deepEqual(new Set(after.duties.map(duty => duty.id)), new Set(before.duties.map(duty => duty.id)));
    const teamData = (await fixture.pool.query<{ data: { memberIds: string[]; maintainerIds: string[] } }>('SELECT data FROM dashboard_records WHERE workspace_id=$1 AND id=$2', [fixture.workspaceId, team.id])).rows[0]!.data;
    assert.ok(teamData.memberIds.includes(source.user.id));
    assert.deepEqual(teamData.maintainerIds, [recipient.user.id]);
    assert.equal((await fixture.send(departure(source.user.id, source.membership.version), { cookie: source.cookie })).status, 200);
  });

  it('records real partial success with exact CAS; normal departure still fails and immediate revocation bypasses duties', async () => {
    const source = await person('Partial source'); const recipient = await person('Partial recipient');
    const scope = await project(fixture.owner.id, 'Partial transfer project');
    const first = await task(scope.id, source.user.id); const second = await task(scope.id, source.user.id);
    const operation = await prepare(source.user.id, recipient.user.id, [first.id, second.id]);
    await fixture.command('UpdateWorkItemMetadata', { priority: 'high' }, { extra: { targetId: second.id, projectId: scope.id, expectedVersions: { [second.id]: second.version } } });
    const result = await fixture.request<MemberHandover>(`${root()}/people/handovers/${operation.id}/continue`, { method: 'POST', body: { expectedVersion: operation.version } });
    assert.equal(result.body.status, 'partial');
    assert.equal(result.body.items.find(item => item.duty.id === first.id)?.state, 'committed');
    assert.equal(result.body.items.find(item => item.duty.id === second.id)?.receipt?.error?.code, 'version_conflict');
    assert.equal((await fixture.send(departure(source.user.id, source.membership.version))).body.error?.code, 'handover_required');
    assert.equal((await fixture.send(departure(source.user.id, source.membership.version, 'RevokeWorkspaceMember'))).status, 200);
    assert.equal((await impact(source.user.id)).duties.some(duty => duty.id === second.id), true);
    assert.equal((await fixture.request(`${root()}/people/members/${source.user.id}/impact`, { cookie: source.cookie })).status, 404);
  });

  it('hands over a revoked member’s team and tasks without restoring access', async () => {
    const source = await person('Urgently revoked source'); const recipient = await person('Post-revocation recipient');
    const scope = await project(fixture.owner.id, 'Post-revocation handover'); const item = await task(scope.id, source.user.id);
    const team = await fixture.command<{ id: string }>('CreateProjectTeam', { name: 'Urgent responsibility', memberIds: [source.user.id], maintainerIds: [source.user.id] });
    const revoked = await fixture.send(departure(source.user.id, source.membership.version, 'RevokeWorkspaceMember'));
    assert.equal(revoked.status, 200);
    const operation = await prepare(source.user.id, recipient.user.id, [team.id, item.id]);
    const result = await fixture.request<MemberHandover>(`${root()}/people/handovers/${operation.id}/continue`, { method: 'POST', body: { expectedVersion: operation.version } });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.status, 'completed', JSON.stringify(result.body));
    const data = (await fixture.pool.query<{ data: { memberIds: string[]; maintainerIds: string[] } }>('SELECT data FROM dashboard_records WHERE workspace_id=$1 AND id=$2', [fixture.workspaceId, team.id])).rows[0]!.data;
    assert.deepEqual(data.memberIds, [recipient.user.id]); assert.deepEqual(data.maintainerIds, [recipient.user.id]);
    const membership = (await fixture.request<Membership[]>(`${root()}/members`)).body.find(member => member.userId === source.user.id)!;
    assert.ok(membership.revokedAt); assert.equal(membership.version, source.membership.version + 1);
    assert.equal((await impact(source.user.id)).duties.length, 0);
    assert.equal((await fixture.request(`${root()}/people/members/${source.user.id}/impact`, { cookie: source.cookie })).status, 404);
  });

  it('persists unknown before dispatch, never replays it, and reconciles the actual original receipt', async () => {
    const source = await person('Unknown source'); const recipient = await person('Unknown recipient');
    const scope = await project(fixture.owner.id, 'Unknown result project'); const item = await task(scope.id, source.user.id);
    const operation = await prepare(source.user.id, recipient.user.id, [item.id]);
    let writes = 0;
    const executor: HandoverExecutor = {
      async execute(_actor, _workspaceId, command) { writes++; const saved = await fixture.send(command); assert.equal(saved.status, 200); throw new Error('Simulated transport loss after real commit'); },
      async receipt(_actor, _workspaceId, command) { return (await fixture.request<CommandReceipt>(`${root()}/commands/${command.commandId}`)).body; },
    };
    const unknown = await continueMemberHandover(fixture.pool, fixture.owner, fixture.workspaceId, operation.id, operation.version, executor);
    assert.equal(unknown.status, 'unknown'); assert.equal(writes, 1);
    await assert.rejects(() => continueMemberHandover(fixture.pool, fixture.owner, fixture.workspaceId, operation.id, unknown.version, executor), { code: 'handover_outcome_unknown' });
    const missing = await reconcileMemberHandover(fixture.pool, fixture.owner, fixture.workspaceId, operation.id, { ...executor, receipt: async () => null });
    assert.equal(missing.status, 'unknown'); assert.equal(writes, 1);
    const confirmed = await reconcileMemberHandover(fixture.pool, fixture.owner, fixture.workspaceId, operation.id, executor);
    assert.equal(confirmed.status, 'completed'); assert.equal(writes, 1);
    assert.equal(confirmed.items[0]?.receipt?.commandId, operation.items[0]?.command.commandId);
    assert.equal((await fixture.pool.query('SELECT count(*)::int AS n FROM command_receipts WHERE command_id=$1', [operation.items[0]!.command.commandId])).rows[0].n, 1);
  });

  it('rejects stale plans, unavailable recipients and callers without planning permissions before dispatch', async () => {
    const source = await person('Permission source'); const recipient = await person('No project access recipient');
    const scope = await project(fixture.owner.id, 'Recipient authorization project'); const item = await task(scope.id, source.user.id);
    const recipientVersion = await fixture.command<Membership>('SetWorkspaceMember', { userId: recipient.user.id, capabilities: ['domain.read'], projectIds: [] }, { extra: { expectedVersions: { [recipient.user.id]: recipient.membership.version } } });
    const before = await impact(source.user.id);
    const input: Command = { commandId: randomUUID(), commandType: 'PrepareMemberHandover', targetId: source.user.id,
      expectedVersions: { [source.user.id]: before.membershipVersion }, payload: { userId: source.user.id, recipientId: recipient.user.id,
        items: [{ id: item.id, kind: 'work_item', version: item.version }] } };
    assert.equal((await fixture.send(input)).body.error?.code, 'invalid_handover_recipient');
    await fixture.command('SetWorkspaceMember', { userId: recipient.user.id, capabilities: ['domain.read'], projectIds: [scope.id] }, { extra: { expectedVersions: { [recipient.user.id]: recipientVersion.version } } });
    const operation = await prepare(source.user.id, recipient.user.id, [item.id]);
    assert.equal((await fixture.request(`${root()}/people/handovers/${operation.id}/continue`, { method: 'POST', body: { expectedVersion: operation.version + 1 } })).status, 409);
    const denied = await fixture.request<Record<string, unknown>>(`${root()}/people/handovers/${operation.id}`, { cookie: recipient.cookie });
    assert.ok([403, 404].includes(denied.status));
    assert.equal('items' in denied.body, false, 'Unauthorized recipients cannot read frozen responsibilities or commands');
    const manager = await person('Manager without planning', ['domain.read', 'access.manage']);
    assert.equal((await fixture.send({ ...input, commandId: randomUUID() }, { cookie: manager.cookie })).body.error?.code, 'permission_denied');
    const revoked = (await fixture.request<Membership[]>(`${root()}/members`)).body.find(member => member.userId === recipient.user.id)!;
    await fixture.send(departure(recipient.user.id, revoked.version, 'RevokeWorkspaceMember'));
    assert.equal((await fixture.request(`${root()}/people/handovers/${operation.id}/continue`, { method: 'POST', body: { expectedVersion: operation.version } })).status, 409);
    assert.equal((await impact(source.user.id)).duties.some(duty => duty.id === item.id), true);
    assert.equal((await fixture.send(departure(manager.user.id, manager.membership.version, 'RevokeWorkspaceMember'))).status, 200);
  });

  it('redacts frozen handover receipts after business-read permission is removed', async () => {
    const source = await person('Receipt source'); const recipient = await person('Receipt recipient');
    const manager = await person('Handover manager', ['access.manage', 'domain.read', 'planning.edit']);
    const scope = await project(fixture.owner.id, 'Private frozen responsibility'); const item = await task(scope.id, source.user.id);
    const input: Command = { commandId: randomUUID(), commandType: 'PrepareMemberHandover', targetId: source.user.id,
      expectedVersions: { [source.user.id]: source.membership.version }, payload: { userId: source.user.id, recipientId: recipient.user.id, items: [{ id: item.id, kind: 'work_item', version: item.version }] } };
    assert.equal((await fixture.send(input, { cookie: manager.cookie })).status, 200);
    const changed = await fixture.command<Membership>('SetWorkspaceMember', { userId: manager.user.id, capabilities: ['access.manage'], projectIds: null }, { extra: { expectedVersions: { [manager.user.id]: manager.membership.version } } });
    assert.equal((await fixture.request(`${root()}/commands/${input.commandId}`, { cookie: manager.cookie })).status, 403);
    assert.equal((await fixture.send(input, { cookie: manager.cookie })).status, 403);
    assert.equal((await fixture.request(`${root()}/people/handovers/${input.commandId}`, { cookie: manager.cookie })).status, 403);
    assert.equal((await fixture.send(departure(manager.user.id, changed.version, 'RevokeWorkspaceMember'))).status, 200);
  });

  it('rechecks self/admin permissions, project scope, last administrator and narrow post-leave receipts', async () => {
    const reader = await person('Self leaver'); const stranger = await person('Other reader');
    assert.equal((await fixture.request(`${root()}/people/members/${reader.user.id}/impact`, { cookie: stranger.cookie })).status, 403);
    const scope = await project(fixture.owner.id, 'Restricted source');
    const limited = await person('Restricted member');
    const scoped = await fixture.command<Membership>('SetWorkspaceMember', { userId: limited.user.id, capabilities: ['domain.read'], projectIds: [scope.id] }, { extra: { expectedVersions: { [limited.user.id]: limited.membership.version } } });
    assert.equal((await impact(limited.user.id, limited.cookie)).scopeComplete, false);
    assert.equal((await fixture.send(departure(limited.user.id, scoped.version), { cookie: limited.cookie })).body.error?.code, 'impact_incomplete');
    const owner = (await fixture.request<Membership[]>(`${root()}/members`)).body.find(member => member.userId === fixture.owner.id)!;
    assert.equal((await fixture.send(departure(fixture.owner.id, owner.version, 'RevokeWorkspaceMember'))).body.error?.code, 'last_administrator');
    const unrelated: Command = { commandId: randomUUID(), commandType: 'SetWorkspaceMember', payload: { userId: reader.user.id, capabilities: ['domain.read'], projectIds: null }, expectedVersions: { [reader.user.id]: reader.membership.version } };
    assert.equal((await fixture.send(unrelated, { cookie: reader.cookie })).status, 403);
    const command = departure(reader.user.id, reader.membership.version);
    const left = await fixture.send(command, { cookie: reader.cookie }); assert.equal(left.status, 200);
    const normal = await fixture.request(`${root()}/commands/${command.commandId}`, { cookie: reader.cookie }); assert.equal(normal.status, 200);
    const narrow = await fixture.request(`${root()}/people/members/${reader.user.id}/departure-receipts/${command.commandId}`, { cookie: reader.cookie }); assert.equal(narrow.status, 200);
    assert.deepEqual(normal.body, narrow.body);
    assert.equal((await fixture.request(`${root()}/people/members/${reader.user.id}/departure-receipts/${command.commandId}`, { cookie: stranger.cookie })).status, 404);
    assert.equal((await fixture.request(`${root()}/commands/${randomUUID()}`, { cookie: reader.cookie })).status, 404);
    assert.equal((await fixture.request(`${root()}/commands/${unrelated.commandId}`, { cookie: reader.cookie })).status, 404);
    assert.equal((await fixture.request(`${root()}/people/members/${reader.user.id}/departure-receipts/${unrelated.commandId}`, { cookie: reader.cookie })).status, 404);
    assert.equal((await fixture.request(`${root()}/people/members/${reader.user.id}/departure-receipts/${randomUUID()}`, { cookie: reader.cookie })).status, 404);
  });
});
