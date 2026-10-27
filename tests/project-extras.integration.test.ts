import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { Command, Entity } from '../packages/domain/src/core.ts';
import type { ProjectCover, ProjectExtras, ProjectExtrasProject, ProjectFavorite, ProjectScope } from '../packages/domain/src/project-extras.ts';
import { publishOutboxBatch } from '../packages/application/src/outbox.ts';
import { createDashboardFixture, dashboardDatabaseUrl } from './dashboard-fixture.ts';
import type { DashboardCommandOptions, DashboardFixture } from './dashboard-fixture.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=', 'base64');
function command(commandType: string, payload: Record<string, unknown>, project: Entity, ...heads: { id: string; version: number }[]): Command {
  return { commandId: randomUUID(), commandType, targetId: project.id, projectId: project.id, expectedVersions: Object.fromEntries([project, ...heads].map(head => [head.id, head.version])), payload };
}
function scope(project: Entity, ...heads: { id: string; version: number }[]): DashboardCommandOptions {
  return { extra: { targetId: project.id, projectId: project.id, expectedVersions: Object.fromEntries([project, ...heads].map(head => [head.id, head.version])) } };
}

describe('project extras: real private favorites, immutable uploaded covers and CAS scope annotations', { skip: !dashboardDatabaseUrl, timeout: 180_000 }, () => {
  let fixture: DashboardFixture;
  before(async () => { fixture = await createDashboardFixture(); });
  after(async () => { await fixture?.close(); });

  async function project(name: string): Promise<Entity> {
    return fixture.command('CreateProject', { name, goal: 'Authoritative Markdown project', ownerId: fixture.owner.id, completionCriteria: [] });
  }
  async function read(cookie?: string): Promise<ProjectExtras> {
    const response = await fixture.request<ProjectExtras>(`/api/v1/workspaces/${fixture.workspaceId}/projects/extras`, cookie ? { cookie } : {});
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body;
  }
  async function row(projectId: string, cookie?: string): Promise<ProjectExtrasProject> {
    const found = (await read(cookie)).projects.find(value => value.projectId === projectId);
    assert.ok(found);
    return found;
  }
  async function image(p: Entity, mediaType = 'image/png', bytes = png): Promise<{ artifact: Entity; artifactVersion: Entity }> {
    const staged = await fixture.command<{ upload: Entity }>('StageUpload', { contentBase64: bytes.toString('base64'), fileName: 'cover.png', mediaType }, { extra: { projectId: p.id } });
    return fixture.command('RegisterArtifact', { title: 'Already uploaded image', kind: 'image', uploadId: staged.upload.id }, { extra: { projectId: p.id, expectedVersions: { [staged.upload.id]: staged.upload.version } } });
  }

  it('favorites belong to the authenticated actor, persist, replay once, remain private and disappear after current scope revocation', async () => {
    const p = await project('Per actor favorites');
    const hidden = await project('Other actor project');
    const reader = await fixture.member('Project favorite reader');
    const membership = await fixture.command<{ version: number }>('SetWorkspaceMember', { userId: reader.user.id, capabilities: ['domain.read'], projectIds: [p.id] });
    const initial = command('SetProjectFavorite', { favorite: true }, p);
    const response = await fixture.send(initial, { cookie: reader.cookie });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual((await fixture.send(initial, { cookie: reader.cookie })).body, response.body);
    assert.equal((await fixture.send({ ...initial, payload: { favorite: false } }, { cookie: reader.cookie })).body.error?.code, 'idempotency_conflict');
    const favorite = (await row(p.id, reader.cookie)).favorite!;
    assert.equal(favorite.ownerId, reader.user.id);
    assert.equal(favorite.data.favorite, true);
    assert.deepEqual((await read(reader.cookie)).projects.map(value => value.projectId), [p.id]);
    assert.equal((await row(p.id)).favorite, null);
    const own = await fixture.command<ProjectFavorite>('SetProjectFavorite', { favorite: true }, scope(p));
    assert.notEqual(own.id, favorite.id);
    const cleared = await fixture.command<ProjectFavorite>('SetProjectFavorite', { favorite: false }, { ...scope(p, favorite), cookie: reader.cookie });
    assert.equal(cleared.id, favorite.id);
    assert.equal((await row(p.id, reader.cookie)).favorite?.data.favorite, false);
    const stale = await fixture.send(command('SetProjectFavorite', { favorite: true }, p, favorite), { cookie: reader.cookie });
    assert.equal(stale.body.error?.code, 'version_conflict');
    const missingVersion = await fixture.send(command('SetProjectFavorite', { favorite: true }, p), { cookie: reader.cookie });
    assert.equal(missingVersion.body.error?.code, 'version_conflict');
    const favoriteRows = await fixture.pool.query<{ count: number }>("SELECT count(*)::int AS count FROM dashboard_records WHERE project_id=$1 AND kind='project_favorite'", [p.id]);
    assert.equal(favoriteRows.rows[0]?.count, 2);
    await assert.rejects(fixture.pool.query('INSERT INTO dashboard_records(id,workspace_id,project_id,kind,owner_id,data,created_by) VALUES($1,$2,$3,$4,$5,$6::jsonb,$5)', [randomUUID(), fixture.workspaceId, p.id, 'project_favorite', reader.user.id, JSON.stringify({ favorite: true })]), /project_favorite_actor_unique/);
    const outbox = await fixture.pool.query<{ audience_actor_id: string; payload: Record<string, unknown> }>('SELECT audience_actor_id,payload FROM outbox WHERE aggregate_id=$1', [favorite.id]);
    assert.equal(outbox.rows.length, 2);
    for (const event of outbox.rows) {
      assert.equal(event.audience_actor_id, reader.user.id);
      assert.deepEqual(Object.keys(event.payload).sort(), ['id', 'kind', 'version']);
    }
    const stored = await fixture.pool.query<{ scope_project_ids: string[]; actor_scope: number; workspace_scope: number }>('SELECT scope_project_ids,actor_scope,workspace_scope FROM command_receipts WHERE actor_id=$1 AND command_id=$2', [reader.user.id, initial.commandId]);
    assert.deepEqual(stored.rows[0], { scope_project_ids: [p.id], actor_scope: 1, workspace_scope: 0 });
    assert.equal((await fixture.request(`/api/v1/workspaces/${fixture.workspaceId}/commands/${initial.commandId}`)).status, 404);
    while (await publishOutboxBatch(fixture.pool, 500)) { /* Drain real committed outbox rows. */ }
    const authorChanges = await fixture.request<{ events: { event: { aggregateId: string } }[] }>(`/api/v1/workspaces/${fixture.workspaceId}/changes?after=0`, { cookie: reader.cookie });
    const ownerChanges = await fixture.request<{ events: { event: { aggregateId: string } }[] }>(`/api/v1/workspaces/${fixture.workspaceId}/changes?after=0`);
    assert.equal(authorChanges.body.events.filter(event => event.event.aggregateId === favorite.id).length, 2);
    assert.equal(ownerChanges.body.events.some(event => event.event.aggregateId === favorite.id), false);
    const revised = await fixture.command<{ version: number }>('SetWorkspaceMember', { userId: reader.user.id, capabilities: ['domain.read'], projectIds: [hidden.id] }, { extra: { expectedVersions: { [reader.user.id]: membership.version } } });
    assert.deepEqual((await read(reader.cookie)).projects.map(value => value.projectId), [hidden.id]);
    assert.equal((await fixture.request(`/api/v1/workspaces/${fixture.workspaceId}/commands/${initial.commandId}`, { cookie: reader.cookie })).status, 404);
    assert.equal((await fixture.send(initial, { cookie: reader.cookie })).status, 404);
    await fixture.command('RevokeWorkspaceMember', { userId: reader.user.id }, { extra: { expectedVersions: { [reader.user.id]: revised.version } } });
    assert.equal((await fixture.request(`/api/v1/workspaces/${fixture.workspaceId}/projects/extras`, { cookie: reader.cookie })).status, 404);
  });

  it('covers select an existing immutable same-project raster version, retain it when newer versions arrive, and remove with CAS', async () => {
    const p = await project('Real uploaded cover');
    const uploaded = await image(p);
    const initial = await fixture.command<ProjectCover>('SetProjectCover', { artifactVersionId: uploaded.artifactVersion.id }, scope(p));
    assert.deepEqual(initial.data, { artifactVersionId: uploaded.artifactVersion.id, mediaType: 'image/png' });
    assert.deepEqual((await row(p.id)).cover, initial);
    assert.equal(JSON.stringify(initial).includes('objectKey'), false);
    const content = await fetch(`${fixture.origin}/api/v1/workspaces/${fixture.workspaceId}/artifact-versions/${uploaded.artifactVersion.id}/content`, { headers: { cookie: fixture.ownerCookie } });
    assert.equal(content.status, 200);
    assert.equal(createHash('sha256').update(new Uint8Array(await content.arrayBuffer())).digest('hex'), createHash('sha256').update(png).digest('hex'));
    const staged = await fixture.command<{ upload: Entity }>('StageUpload', { contentBase64: png.toString('base64'), fileName: 'newer.png', mediaType: 'image/png' }, { extra: { projectId: p.id } });
    const newer = await fixture.command<{ artifactVersion: Entity }>('AddArtifactVersion', { uploadId: staged.upload.id }, { extra: { projectId: p.id, targetId: uploaded.artifact.id, expectedVersions: { [uploaded.artifact.id]: uploaded.artifact.version, [staged.upload.id]: staged.upload.version } } });
    assert.equal((await row(p.id)).cover?.data.artifactVersionId, uploaded.artifactVersion.id, 'A cover never follows the mutable latest-version pointer');
    const replaced = await fixture.command<ProjectCover>('SetProjectCover', { artifactVersionId: newer.artifactVersion.id }, scope(p, initial));
    assert.equal(replaced.id, initial.id);
    assert.equal(replaced.version, initial.version + 1);
    assert.equal((await fixture.send(command('SetProjectCover', { artifactVersionId: null }, p, initial))).body.error?.code, 'version_conflict');
    const removed = await fixture.command<ProjectCover>('SetProjectCover', { artifactVersionId: null }, scope(p, replaced));
    assert.deepEqual(removed.data, { artifactVersionId: null, mediaType: null });
    assert.deepEqual((await row(p.id)).cover, removed);
    await assert.rejects(fixture.pool.query('UPDATE entities SET data=$1::jsonb,version=version+1 WHERE id=$2', [JSON.stringify({ ...uploaded.artifactVersion.data, mediaType: 'text/html' }), uploaded.artifactVersion.id]), /immutable/);
  });

  it('rejects cross-project, unregistered, external, SVG/HTML, and MIME-spoofed covers without events', async () => {
    const p = await project('Cover rejection target');
    const other = await project('Cross-project cover source');
    const foreign = await image(other);
    const cross = await fixture.send(command('SetProjectCover', { artifactVersionId: foreign.artifactVersion.id }, p));
    assert.equal(cross.body.error?.code, 'project_mismatch');
    const staged = await fixture.command<{ upload: Entity }>('StageUpload', { contentBase64: png.toString('base64'), fileName: 'unregistered.png', mediaType: 'image/png' }, { extra: { projectId: p.id } });
    const unregistered = await fixture.send(command('SetProjectCover', { artifactVersionId: staged.upload.id }, p));
    assert.equal(unregistered.status, 404);
    const unsafe = await Promise.all([
      image(p, 'image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')),
      image(p, 'image/png', Buffer.from('<html><script>alert(1)</script></html>')),
      image(p, 'image/png', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')),
      image(p, 'text/plain', png),
    ]);
    for (const upload of unsafe) {
      const rejected = await fixture.send(command('SetProjectCover', { artifactVersionId: upload.artifactVersion.id }, p));
      assert.equal(rejected.body.error?.code, 'unsafe_project_cover');
      assert.equal((await fixture.pool.query('SELECT count(*)::int AS count FROM outbox WHERE command_id=$1', [rejected.body.commandId])).rows[0].count, 0);
    }
    const external = await fixture.send(command('SetProjectCover', { artifactVersionId: 'https://example.test/cover.svg' }, p));
    assert.equal(external.body.error?.code, 'validation_failed');
    assert.equal((await row(p.id)).cover, null);
    await assert.rejects(fixture.pool.query('INSERT INTO dashboard_records(id,workspace_id,project_id,kind,data,created_by) VALUES($1,$2,$3,$4,$5::jsonb,$6)', [randomUUID(), fixture.workspaceId, p.id, 'project_cover', JSON.stringify({ artifactVersionId: foreign.artifactVersion.id, mediaType: 'image/png' }), fixture.owner.id]), /same project/);
  });

  it('scope item identities survive text edits, checking, ordering and deletion; writes never alter Markdown lifecycle or overwrite stale heads', async () => {
    const p = await project('Stable scope checklist');
    const before = await fixture.request<{ revision: string; raw: string }>(`/api/v1/workspaces/${fixture.workspaceId}/core/files/${p.id}`);
    const firstId = randomUUID(), secondId = randomUUID(), thirdId = randomUUID();
    const initialItems = [{ id: firstId, text: 'Existing stable annotation', completed: false }, { id: secondId, text: 'Remove this annotation', completed: false }];
    const initial = await fixture.command<ProjectScope>('SetProjectScope', { items: initialItems }, scope(p));
    const edited = [{ id: thirdId, text: 'New annotation', completed: true }, { id: firstId, text: 'Edited stable annotation', completed: true }];
    const update = command('SetProjectScope', { items: edited }, p, initial);
    const saved = await fixture.send(update);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual((await fixture.send(update)).body, saved.body);
    const current = (await row(p.id)).scope!;
    assert.equal(current.id, initial.id);
    assert.deepEqual(current.data.items, edited);
    const competing = await Promise.all([
      fixture.send(command('SetProjectScope', { items: [{ id: firstId, text: 'First concurrent draft', completed: false }] }, p, current)),
      fixture.send(command('SetProjectScope', { items: [{ id: firstId, text: 'Second concurrent draft', completed: false }] }, p, current)),
    ]);
    assert.deepEqual(competing.map(value => value.status).sort(), [200, 409]);
    assert.equal(competing.find(value => value.status === 409)?.body.error?.code, 'version_conflict');
    const latest = (await row(p.id)).scope!;
    assert.equal(latest.version, current.version + 1);
    assert.equal((await fixture.send(command('SetProjectScope', { items: [] }, p))).body.error?.code, 'version_conflict');
    const duplicate = await fixture.send(command('SetProjectScope', { items: [edited[0], edited[0]] }, p, latest));
    assert.equal(duplicate.body.error?.code, 'validation_failed');
    const lifecycle = await fixture.request<{ revision: string; raw: string }>(`/api/v1/workspaces/${fixture.workspaceId}/core/files/${p.id}`);
    assert.equal(lifecycle.body.revision, before.body.revision);
    assert.equal(lifecycle.body.raw, before.body.raw);
    const empty = await fixture.command<ProjectScope>('SetProjectScope', { items: [] }, scope(p, latest));
    assert.equal(empty.id, initial.id);
    assert.deepEqual((await row(p.id)).scope?.data.items, []);
    const event = await fixture.pool.query<{ payload: Record<string, unknown> }>('SELECT payload FROM outbox WHERE command_id=$1', [update.commandId]);
    assert.equal(event.rows.length, 1);
    assert.equal(JSON.stringify(event.rows).includes('Edited stable annotation'), false);
    await assert.rejects(fixture.pool.query('UPDATE dashboard_records SET data=$1::jsonb,version=version+1 WHERE id=$2', [JSON.stringify({ items: [edited[0], edited[0]] }), initial.id]), /duplicate scope/);
  });

  it('current project edit permission, core CAS, matching envelope and archive guards apply independently from personal favorite reads', async () => {
    const p = await project('Project extras guards');
    const hidden = await project('Invisible project extras');
    const reader = await fixture.member('Read-only extras member');
    await fixture.command('SetWorkspaceMember', { userId: reader.user.id, capabilities: ['domain.read'], projectIds: [p.id] });
    const readonly = await fixture.send(command('SetProjectScope', { items: [] }, p), { cookie: reader.cookie });
    assert.equal(readonly.status, 403);
    const readonlyCover = await fixture.send(command('SetProjectCover', { artifactVersionId: null }, p), { cookie: reader.cookie });
    assert.equal(readonlyCover.status, 403);
    assert.equal((await fixture.send(command('SetProjectFavorite', { favorite: true }, hidden), { cookie: reader.cookie })).status, 404);
    const mismatch = await fixture.send({ ...command('SetProjectScope', { items: [] }, p), projectId: hidden.id });
    assert.equal(mismatch.body.error?.code, 'project_mismatch');
    const changed = await fixture.command<Entity>('UpdateProject', { name: 'New core revision', goal: 'Core owns this text', ownerId: fixture.owner.id, completionCriteria: [] }, scope(p));
    assert.equal((await fixture.send(command('SetProjectScope', { items: [] }, p))).body.error?.code, 'version_conflict');
    const archived = await fixture.command<Entity>('ArchiveObject', { kind: 'project', reason: 'Cover/scope must not bypass core archive' }, scope(changed));
    assert.equal((await fixture.send(command('SetProjectScope', { items: [] }, archived))).body.error?.code, 'object_archived');
    assert.equal((await fixture.send(command('SetProjectCover', { artifactVersionId: null }, archived))).body.error?.code, 'object_archived');
    const favorite = await fixture.command<ProjectFavorite>('SetProjectFavorite', { favorite: true }, scope(archived));
    assert.equal(favorite.data.favorite, true, 'Personal favorites require current read permission, not a planning mutation');
    assert.equal((await row(p.id)).scope, null);
  });
});
