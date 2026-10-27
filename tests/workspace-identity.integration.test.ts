import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { Membership } from '../packages/application/src/access.ts';
import { publishOutboxBatch } from '../packages/application/src/outbox.ts';
import type { Command, Entity } from '../packages/domain/src/core.ts';
import type { WorkspaceIdentity } from '../packages/domain/src/workspace-identity.ts';
import { createWorkspace } from '../packages/infrastructure/src/auth.ts';
import { createDashboardFixture, dashboardDatabaseUrl, type DashboardFixture } from './dashboard-fixture.ts';

function update(identity: WorkspaceIdentity, name: string): Command {
  return { commandId: randomUUID(), commandType: 'UpdateWorkspaceIdentity', targetId: identity.workspaceId,
    expectedVersions: { [identity.workspaceId]: identity.version }, payload: { name, icon: 'rocket', color: '#23918A' } };
}

describe('workspace identity: real HTTP authorization, CAS, receipts and minimal data', { skip: !dashboardDatabaseUrl, timeout: 180_000 }, () => {
  let fixture: DashboardFixture;
  before(async () => { fixture = await createDashboardFixture(); });
  after(async () => { await fixture?.close(); });
  const root = () => `/api/v1/workspaces/${fixture.workspaceId}`;
  async function identity(cookie?: string): Promise<WorkspaceIdentity> {
    const response = await fixture.request<WorkspaceIdentity>(`${root()}/identity`, cookie ? { cookie } : {});
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return response.body;
  }
  async function grant(userId: string, capabilities: string[], projectIds: string[] | null = null, previous?: Membership): Promise<Membership> {
    return fixture.command('SetWorkspaceMember', { userId, capabilities, projectIds }, previous ? { extra: { expectedVersions: { [userId]: previous.version } } } : {});
  }

  it('saves/reloads the actual name/icon/color without changing membership version, workspace UUID or core source', async () => {
    const project = await fixture.command<Entity>('CreateProject', { name: 'Identity core boundary', goal: 'Do not rename core directories', ownerId: fixture.owner.id, completionCriteria: [] });
    const source = await fixture.request(`${root()}/core/files/${project.id}`);
    const beforeList = await fixture.request<{ items: { id: string; version: number; identityVersion: number }[] }>('/api/v1/workspaces');
    const before = beforeList.body.items.find(row => row.id === fixture.workspaceId)!;
    const initial = await identity();
    const command = update(initial, '  正式工作区 · Identity  ');
    const saved = await fixture.send(command);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const result = saved.body.result as WorkspaceIdentity;
    assert.deepEqual({ name: result.name, icon: result.icon, color: result.color, version: result.version },
      { name: '正式工作区 · Identity', icon: 'rocket', color: '#23918A', version: initial.version + 1 });
    assert.equal(result.workspaceId, fixture.workspaceId);
    assert.deepEqual(await identity(), result);
    const afterList = await fixture.request<{ items: { id: string; name: string; icon: string; color: string; identityVersion: number; version: number }[] }>('/api/v1/workspaces');
    const selected = afterList.body.items.find(row => row.id === fixture.workspaceId)!;
    assert.deepEqual({ name: selected.name, icon: selected.icon, color: selected.color, identityVersion: selected.identityVersion, version: selected.version },
      { name: result.name, icon: result.icon, color: result.color, identityVersion: result.version, version: before.version });
    assert.deepEqual((await fixture.request(`${root()}/core/files/${project.id}`)).body, source.body);
  });

  it('CAS admits one writer, rejects stale/missing versions, and persists only one outbox event per original command', async () => {
    const initial = await identity();
    const commands = [update(initial, 'CAS writer A'), update(initial, 'CAS writer B')];
    const responses = await Promise.all(commands.map(command => fixture.send(command)));
    assert.deepEqual(responses.map(row => row.status).sort(), [200, 409]);
    const successIndex = responses.findIndex(row => row.status === 200);
    const command = commands[successIndex]!;
    const response = responses[successIndex]!;
    assert.deepEqual((await fixture.send(command)).body, response.body);
    assert.deepEqual((await fixture.request(`${root()}/commands/${command.commandId}`)).body, response.body);
    assert.equal((await fixture.send({ ...command, payload: { ...command.payload, name: 'A different intention' } })).status, 409);
    const winner = response.body.result as WorkspaceIdentity;
    const stale = await fixture.send(update(initial, 'Stale must not overwrite'));
    assert.equal(stale.body.error?.code, 'version_conflict');
    const missing = update(winner, 'Missing version must not overwrite');
    delete missing.expectedVersions;
    assert.equal((await fixture.send(missing)).body.error?.code, 'version_conflict');
    assert.deepEqual(await identity(), winner);
    const events = await fixture.pool.query('SELECT aggregate_kind,aggregate_version,payload FROM outbox WHERE command_id=$1', [command.commandId]);
    assert.deepEqual(events.rows, [{ aggregate_kind: 'workspace_identity', aggregate_version: winner.version,
      payload: { id: fixture.workspaceId, kind: 'workspace_identity', version: winner.version } }]);
    const loser = commands[successIndex === 0 ? 1 : 0]!;
    assert.equal((await fixture.pool.query('SELECT count(*)::int AS n FROM outbox WHERE command_id=ANY($1::uuid[])', [[loser.commandId, stale.body.commandId, missing.commandId]])).rows[0].n, 0);
  });

  it('requires unrestricted access.manage, rechecks receipt permission and never grants business data to managers', async () => {
    const reader = await fixture.member('Identity reader');
    await grant(reader.user.id, ['domain.read']);
    const manager = await fixture.member('Identity-only manager');
    const managed = await grant(manager.user.id, ['access.manage']);
    const initial = await identity(reader.cookie);
    const deniedCommand = update(initial, 'Reader cannot write');
    assert.equal((await fixture.send(deniedCommand, { cookie: reader.cookie })).status, 403);
    assert.equal((await fixture.pool.query('SELECT count(*)::int AS n FROM outbox WHERE command_id=$1', [deniedCommand.commandId])).rows[0].n, 0);
    const command = update(initial, 'Manager without business read');
    const saved = await fixture.send(command, { cookie: manager.cookie });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal((await fixture.request(`${root()}/core/workspace`, { cookie: manager.cookie })).status, 403);
    assert.equal((await fixture.request(`${root()}/commands/${command.commandId}`, { cookie: reader.cookie })).status, 404);
    await grant(manager.user.id, ['domain.read'], null, managed);
    assert.equal((await fixture.request(`${root()}/commands/${command.commandId}`, { cookie: manager.cookie })).status, 403);
    assert.equal((await fixture.send(command, { cookie: manager.cookie })).status, 403);
    const current = await identity();
    assert.equal((await fixture.send({ ...update(current, 'Wrong target'), targetId: randomUUID() })).status, 400);
    assert.equal((await fixture.send({ ...update(current, 'Wrong project scope'), projectId: 'PRJ-999999' })).status, 400);
  });

  it('returns only minimal authorized identity, hides private data and forbids unknown/revoked/cross-workspace access', async () => {
    const outsider = await fixture.member('Unrelated identity');
    const membershipOnly = await fixture.member('Identity with no business capabilities');
    const membership = await grant(membershipOnly.user.id, []);
    await fixture.command('CreatePrivateNote', { content: 'PRIVATE_NOTE_MUST_NOT_LEAK_IN_WORKSPACE_IDENTITY' });
    const managerView = await identity(membershipOnly.cookie);
    assert.deepEqual(Object.keys(managerView).sort(), ['color', 'icon', 'name', 'updatedAt', 'version', 'workspaceId']);
    assert.equal(JSON.stringify(managerView).includes('PRIVATE_NOTE_MUST_NOT_LEAK'), false);
    assert.equal((await fixture.request(`${root()}/identity?actorId=${fixture.owner.id}`)).status, 400);
    assert.equal((await fixture.request(`${root()}/identity`, { cookie: outsider.cookie })).status, 404);
    const other = await createWorkspace(fixture.pool, outsider.user.id, 'Unrelated private workspace');
    const cross = await fixture.request(`/api/v1/workspaces/${other.id}/identity`);
    assert.equal(cross.status, 404);
    assert.equal(JSON.stringify(cross.body).includes('Unrelated private workspace'), false);
    assert.equal((await fixture.send(update({ ...managerView, workspaceId: other.id }, 'Cross workspace'), { workspace: other.id })).status, 404);
    await fixture.command('RevokeWorkspaceMember', { userId: membershipOnly.user.id }, { extra: { expectedVersions: { [membershipOnly.user.id]: membership.version } } });
    assert.equal((await fixture.request(`${root()}/identity`, { cookie: membershipOnly.cookie })).status, 404);
    const list = await fixture.request<{ items: { id: string }[] }>('/api/v1/workspaces', { cookie: membershipOnly.cookie });
    assert.equal(list.body.items.some(row => row.id === fixture.workspaceId), false);
  });

  it('rejects remote/arbitrary icons and CSS, but scoped readers receive only identity invalidation metadata', async () => {
    const current = await identity();
    for (const patch of [{ icon: 'https://example.test/tracker.svg' }, { icon: '<svg onload=alert(1) />' }, { color: 'url(https://example.test/)' }, { name: '   ' }, { name: 'x'.repeat(201) }, { ownerId: fixture.owner.id }]) {
      const command = update(current, 'Invalid identity');
      const response = await fixture.send({ ...command, payload: { ...command.payload, ...patch } });
      assert.equal(response.status, 400, JSON.stringify(response.body));
      assert.equal((await fixture.pool.query('SELECT count(*)::int AS n FROM outbox WHERE command_id=$1', [command.commandId])).rows[0].n, 0);
    }
    const project = await fixture.command<Entity>('CreateProject', { name: 'Scoped identity reader', goal: 'Only presentation facts', ownerId: fixture.owner.id, completionCriteria: [] });
    const reader = await fixture.member('Restricted identity navigation');
    await grant(reader.user.id, ['domain.read'], [project.id]);
    assert.deepEqual(await identity(reader.cookie), current);
    assert.ok([403, 404].includes((await fixture.send(update(current, 'Scoped write denied'), { cookie: reader.cookie })).status));
    const command = update(current, 'Scoped readers see latest identity');
    const saved = await fixture.send(command);
    assert.equal(saved.status, 200);
    while (await publishOutboxBatch(fixture.pool, 500)) { /* Publish committed facts through the real worker path. */ }
    const changes = await fixture.request<{ events: { event: { eventType: string; aggregateKind: string; aggregateId: string } }[] }>(`${root()}/changes?after=0`, { cookie: reader.cookie });
    assert.equal(changes.status, 200, JSON.stringify(changes.body));
    const notification = changes.body.events.find(row => row.event.eventType === 'WorkspaceIdentityUpdated');
    assert.ok(notification, 'Restricted navigation needs the safe workspace identity invalidation');
    assert.equal(notification.event.aggregateKind, 'workspace_identity');
    assert.equal(notification.event.aggregateId, fixture.workspaceId);
    assert.equal(JSON.stringify(changes.body).includes('PRIVATE_NOTE_MUST_NOT_LEAK'), false);
    assert.equal(JSON.stringify(changes.body).includes('self_profile'), false);
    assert.deepEqual(await identity(reader.cookie), saved.body.result);
  });
});
