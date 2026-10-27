import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { CommandOutcomeUnknown, ProjectManagementClient } from '../packages/contracts/src/client.ts';
import type { Command, Entity } from '../packages/domain/src/core.ts';
import type { ProjectExtras, ProjectFavorite, ProjectSidebarOrder } from '../packages/domain/src/project-extras.ts';
import { publishOutboxBatch } from '../packages/application/src/outbox.ts';
import { createWorkspace } from '../packages/infrastructure/src/auth.ts';
import { createDashboardFixture, dashboardDatabaseUrl, type DashboardFixture } from './dashboard-fixture.ts';

type Head = { id: string; version: number };
const orderCommand = (projectIds: string[], head?: Head): Command => ({ commandId: randomUUID(), commandType: 'SetProjectSidebarOrder', expectedVersions: head ? { [head.id]: head.version } : {}, payload: { projectIds } });
async function project(f: DashboardFixture, name: string): Promise<Entity> {
  return f.command('CreateProject', { name, goal: 'Real sidebar order behavior', ownerId: f.owner.id, completionCriteria: [] });
}
async function extras(f: DashboardFixture, cookie = f.ownerCookie, workspaceId = f.workspaceId): Promise<ProjectExtras> {
  const response = await f.request<ProjectExtras>(`/api/v1/workspaces/${workspaceId}/projects/extras`, { cookie });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body;
}
async function savedOrder(f: DashboardFixture, cookie = f.ownerCookie): Promise<ProjectSidebarOrder> {
  const order = (await extras(f, cookie)).sidebarOrder;
  assert.ok(order);
  return order;
}

// Every case owns a random PostgreSQL schema and temporary Markdown root; no fixture facts or business workspace writes.
describe('personal project sidebar ordering: real SQL/Markdown authorization, receipts and invalidation', { skip: !dashboardDatabaseUrl, timeout: 240_000 }, () => {
  it('persists across fresh clients, isolates actors/workspaces, leaves favorites intact and emits only private invalidations', async t => {
    const f = await createDashboardFixture();
    t.after(() => f.close());
    const a = await project(f, 'First visible project'), b = await project(f, 'Second visible project');
    const reader = await f.member('Sidebar reader');
    await f.command('SetWorkspaceMember', { userId: reader.user.id, capabilities: ['domain.read'], projectIds: [a.id, b.id] });
    const favorite = await f.command<ProjectFavorite>('SetProjectFavorite', { favorite: true }, { cookie: reader.cookie, extra: { targetId: a.id, projectId: a.id, expectedVersions: { [a.id]: a.version } } });
    const input = orderCommand([b.id, a.id]);
    const response = await f.send(input, { cookie: reader.cookie });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const head = response.body.result as Head;
    assert.deepEqual(Object.keys(head).sort(), ['id', 'version'], 'Durable receipts contain no historical project IDs');
    const api = new ProjectManagementClient({ baseUrl: f.origin, auth: { type: 'cookie', credentials: 'include', cookie: () => reader.cookie } });
    const refreshed = await api.getProjectExtras(f.workspaceId);
    assert.deepEqual(refreshed.sidebarOrder?.data.projectIds, [b.id, a.id]);
    assert.equal(refreshed.sidebarOrder?.id, head.id);
    assert.equal(refreshed.sidebarOrder?.ownerId, reader.user.id);
    assert.equal(refreshed.sidebarOrder?.projectId, null);
    assert.equal(refreshed.projects.find(row => row.projectId === a.id)?.favorite?.id, favorite.id);
    assert.equal((await extras(f)).sidebarOrder, null, 'Another actor has no inherited order');
    const own = await f.command<Head>('SetProjectSidebarOrder', { projectIds: [a.id, b.id] });
    assert.notEqual(own.id, head.id);
    assert.deepEqual((await api.getProjectExtras(f.workspaceId)).sidebarOrder?.data.projectIds, [b.id, a.id]);
    const anotherWorkspace = await createWorkspace(f.pool, f.owner.id, 'Independent navigation workspace');
    assert.equal((await extras(f, f.ownerCookie, anotherWorkspace.id)).sidebarOrder, null);
    const otherHead = await f.command<Head>('SetProjectSidebarOrder', { projectIds: [] }, { workspace: anotherWorkspace.id });
    assert.notEqual(otherHead.id, own.id);
    assert.deepEqual((await savedOrder(f)).data.projectIds, [a.id, b.id]);
    assert.deepEqual((await f.send(input, { cookie: reader.cookie })).body, response.body);
    assert.equal((await f.send({ ...input, payload: { projectIds: [a.id, b.id] } }, { cookie: reader.cookie })).body.error?.code, 'idempotency_conflict');
    assert.equal((await f.request(`/api/v1/workspaces/${f.workspaceId}/commands/${input.commandId}`)).status, 404);
    const receiptScope = await f.pool.query<{ actor_scope: number; workspace_scope: number; scope_project_ids: string[] }>('SELECT actor_scope,workspace_scope,scope_project_ids FROM command_receipts WHERE actor_id=$1 AND command_id=$2', [reader.user.id, input.commandId]);
    assert.deepEqual(receiptScope.rows[0], { actor_scope: 1, workspace_scope: 0, scope_project_ids: [b.id, a.id] });
    const outbox = await f.pool.query<{ audience_actor_id: string; project_id: string | null; payload: unknown }>('SELECT audience_actor_id,project_id,payload FROM outbox WHERE aggregate_id=$1', [head.id]);
    assert.equal(outbox.rows.length, 1, 'Replay does not emit another event');
    assert.deepEqual(outbox.rows[0], { audience_actor_id: reader.user.id, project_id: null, payload: { id: head.id, kind: 'project_sidebar_order', version: head.version } });
    while (await publishOutboxBatch(f.pool, 500)) { /* Publish real durable events for independent tabs. */ }
    const path = `/api/v1/workspaces/${f.workspaceId}/changes?after=0`;
    const readerChanges = await f.request<{ events: { event: { aggregateId: string; eventType: string } }[] }>(path, { cookie: reader.cookie });
    const ownerChanges = await f.request<{ events: { event: { aggregateId: string } }[] }>(path);
    assert.equal(readerChanges.body.events.filter(row => row.event.aggregateId === head.id && row.event.eventType === 'ProjectSidebarOrderSet').length, 1);
    assert.equal(ownerChanges.body.events.some(row => row.event.aggregateId === head.id), false);
  });

  it('CAS-protects creation and updates, including missing versions, without modifying authoritative project revisions', async t => {
    const f = await createDashboardFixture();
    t.after(() => f.close());
    const a = await project(f, 'CAS project A'), b = await project(f, 'CAS project B');
    const before = await f.request<{ revision: string; raw: string }>(`/api/v1/workspaces/${f.workspaceId}/core/files/${a.id}`);
    const created = await Promise.all([f.send(orderCommand([a.id, b.id])), f.send(orderCommand([b.id, a.id]))]);
    assert.deepEqual(created.map(row => row.status).sort(), [200, 409]);
    const initial = await savedOrder(f);
    assert.equal(initial.version, 1);
    const updates = await Promise.all([f.send(orderCommand([a.id, b.id], initial)), f.send(orderCommand([b.id, a.id], initial))]);
    assert.deepEqual(updates.map(row => row.status).sort(), [200, 409]);
    assert.equal(updates.find(row => row.status === 409)?.body.error?.code, 'version_conflict');
    const current = await savedOrder(f);
    assert.equal(current.id, initial.id);
    assert.equal(current.version, initial.version + 1);
    assert.equal((await f.send(orderCommand([b.id, a.id]))).body.error?.code, 'version_conflict');
    const after = await f.request<{ revision: string; raw: string }>(`/api/v1/workspaces/${f.workspaceId}/core/files/${a.id}`);
    assert.deepEqual(after.body, before.body, 'Personal ordering never rewrites Markdown');
    const rows = await f.pool.query<{ count: number }>("SELECT count(*)::int AS count FROM dashboard_records WHERE workspace_id=$1 AND owner_id=$2 AND kind='project_sidebar_order'", [f.workspaceId, f.owner.id]);
    assert.equal(rows.rows[0]?.count, 1);
    const events = await f.pool.query<{ count: number }>('SELECT count(*)::int AS count FROM outbox WHERE aggregate_id=$1', [current.id]);
    assert.equal(events.rows[0]?.count, 2, 'Only committed CAS writes emit events');
  });

  it('normalizes current authorized active IDs, appends newly visible projects, and removes revoked/archived/deleted IDs without changing CAS on read', async t => {
    const f = await createDashboardFixture();
    t.after(() => f.close());
    const a = await project(f, 'Keep initially'), b = await project(f, 'Revoke later'), c = await project(f, 'Archive later');
    const hidden = await project(f, 'Never authorized');
    const reader = await f.member('Changing sidebar scope');
    let membership = await f.command<Head>('SetWorkspaceMember', { userId: reader.user.id, capabilities: ['domain.read'], projectIds: [a.id, b.id, c.id] });
    const input = orderCommand([b.id, a.id, c.id]);
    const committed = await f.send(input, { cookie: reader.cookie });
    assert.equal(committed.status, 200, JSON.stringify(committed.body));
    const initial = await savedOrder(f, reader.cookie);
    const added = await project(f, 'Newly authorized project');
    membership = await f.command<Head>('SetWorkspaceMember', { userId: reader.user.id, capabilities: ['domain.read'], projectIds: [a.id, c.id, added.id] }, { extra: { expectedVersions: { [reader.user.id]: membership.version } } });
    const normalized = await savedOrder(f, reader.cookie);
    assert.deepEqual(normalized.data.projectIds, [a.id, c.id, added.id]);
    assert.equal(normalized.version, initial.version, 'Read normalization preserves the stored CAS version');
    const serialized = JSON.stringify(await extras(f, reader.cookie));
    assert.equal(serialized.includes(b.id), false);
    assert.equal(serialized.includes(hidden.id), false);
    assert.equal((await f.request(`/api/v1/workspaces/${f.workspaceId}/commands/${input.commandId}`, { cookie: reader.cookie })).status, 404, 'Historical receipts recheck referenced project authorization');
    assert.equal((await f.send(input, { cookie: reader.cookie })).status, 404);
    const archivedC = await f.command<Entity>('ArchiveObject', { kind: 'project', reason: 'Hide from active navigation' }, { extra: { targetId: c.id, projectId: c.id, expectedVersions: { [c.id]: c.version } } });
    assert.equal(archivedC.data.archived, true);
    assert.deepEqual((await savedOrder(f, reader.cookie)).data.projectIds, [a.id, added.id]);
    await f.command('ArchiveObject', { kind: 'project', reason: 'Prepare safe deletion' }, { extra: { targetId: a.id, projectId: a.id, expectedVersions: { [a.id]: a.version } } });
    const file = await f.request<{ revision: string }>(`/api/v1/workspaces/${f.workspaceId}/core/files/${a.id}`);
    const deleted = await f.request(`/api/v1/workspaces/${f.workspaceId}/core/entities/${a.id}`, { method: 'DELETE', headers: { 'idempotency-key': randomUUID() }, body: { revision: file.body.revision } });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.deepEqual((await savedOrder(f, reader.cookie)).data.projectIds, [added.id]);
    const updated = await f.send(orderCommand([added.id], normalized), { cookie: reader.cookie });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal((await savedOrder(f, reader.cookie)).version, initial.version + 1);
    await f.command('SetWorkspaceMember', { userId: reader.user.id, capabilities: ['domain.read'], projectIds: [] }, { extra: { expectedVersions: { [reader.user.id]: membership.version } } });
    assert.deepEqual((await savedOrder(f, reader.cookie)).data.projectIds, []);
  });

  it('rejects unauthorized IDs, archived IDs, actor spoofing, project envelopes and malformed database records', async t => {
    const f = await createDashboardFixture();
    t.after(() => f.close());
    const a = await project(f, 'Reader visible'), hidden = await project(f, 'Reader hidden');
    const reader = await f.member('Order guard reader');
    await f.command('SetWorkspaceMember', { userId: reader.user.id, capabilities: ['domain.read'], projectIds: [a.id] });
    const hiddenAttempt = await f.send(orderCommand([a.id, hidden.id]), { cookie: reader.cookie });
    assert.equal(hiddenAttempt.status, 404);
    assert.equal((await extras(f, reader.cookie)).sidebarOrder, null);
    for (const payload of [{ projectIds: [a.id, a.id] }, { projectIds: [a.id], actorId: f.owner.id }, { projectIds: [a.id], workspaceId: randomUUID() }]) {
      const rejected = await f.send({ ...orderCommand([]), payload }, { cookie: reader.cookie });
      assert.equal(rejected.body.error?.code, 'validation_failed');
    }
    const scoped = await f.send({ ...orderCommand([a.id]), targetId: a.id, projectId: a.id }, { cookie: reader.cookie });
    assert.equal(scoped.body.error?.code, 'sidebar_order_scope');
    await f.command('ArchiveObject', { kind: 'project', reason: 'No archived sidebar entries' }, { extra: { targetId: a.id, projectId: a.id, expectedVersions: { [a.id]: a.version } } });
    assert.equal((await f.send(orderCommand([a.id]), { cookie: reader.cookie })).body.error?.code, 'object_archived');
    const head = await f.command<Head>('SetProjectSidebarOrder', { projectIds: [] }, { cookie: reader.cookie });
    await assert.rejects(f.pool.query('INSERT INTO dashboard_records(id,workspace_id,kind,owner_id,data,created_by) VALUES($1,$2,$3,$4,$5::jsonb,$4)', [randomUUID(), f.workspaceId, 'project_sidebar_order', reader.user.id, JSON.stringify({ projectIds: [] })]), /project_sidebar_order_actor_unique/);
    await assert.rejects(f.pool.query('UPDATE dashboard_records SET data=$1::jsonb,version=version+1 WHERE id=$2', [JSON.stringify({ projectIds: [hidden.id, hidden.id] }), head.id]), /duplicate sidebar project ID/);
    for (const data of [{ projectIds: [null] }, { projectIds: ['../escape'] }, { projectIds: [], favorite: true }, {}]) {
      await assert.rejects(f.pool.query('UPDATE dashboard_records SET data=$1::jsonb,version=version+1 WHERE id=$2', [JSON.stringify(data), head.id]));
    }
    await assert.rejects(f.pool.query('INSERT INTO dashboard_records(id,workspace_id,project_id,kind,owner_id,data,created_by) VALUES($1,$2,$3,$4,$5,$6::jsonb,$5)', [randomUUID(), f.workspaceId, hidden.id, 'project_sidebar_order', f.owner.id, JSON.stringify({ projectIds: [] })]), /personal workspace scope/);
    assert.equal((await savedOrder(f, reader.cookie)).version, head.version);
  });

  it('recovers a lost committed response through the original receipt without replaying another order mutation', async t => {
    const f = await createDashboardFixture();
    t.after(() => f.close());
    const a = await project(f, 'Transport project A'), b = await project(f, 'Transport project B');
    const input = { commandId: randomUUID(), commandType: 'SetProjectSidebarOrder' as const, expectedVersions: {}, payload: { projectIds: [b.id, a.id] } };
    let posts = 0;
    const api = new ProjectManagementClient({
      baseUrl: f.origin,
      auth: { type: 'cookie', credentials: 'include', cookie: () => f.ownerCookie },
      fetch: async (url, init) => {
        const response = await fetch(url, init);
        if (init?.method === 'POST' && String(url).endsWith('/commands')) {
          posts += 1;
          await response.arrayBuffer();
          throw new TypeError('Controlled response loss after the real server committed');
        }
        return response;
      },
    });
    await assert.rejects(api.executeCommand(f.workspaceId, input), error => error instanceof CommandOutcomeUnknown && error.commandId === input.commandId);
    assert.equal(posts, 1);
    const refreshed = await api.getProjectExtras(f.workspaceId);
    assert.deepEqual(refreshed.sidebarOrder?.data.projectIds, [b.id, a.id]);
    const original = await api.getCommandReceipt(f.workspaceId, input.commandId);
    assert.equal(original.status, 'committed');
    assert.deepEqual(original.result, { id: refreshed.sidebarOrder!.id, version: 1 });
    assert.equal(posts, 1, 'Refresh and reconciliation only read; neither sends another command');
    assert.equal((await f.pool.query<{ count: number }>('SELECT count(*)::int AS count FROM outbox WHERE command_id=$1', [input.commandId])).rows[0]?.count, 1);
  });
});
