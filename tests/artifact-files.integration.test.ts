import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { CommandOutcomeUnknown, ProjectManagementClient, type Command as ClientCommand } from '../packages/contracts/src/client.ts';
import type { ArtifactCopyOriginResponse } from '../packages/contracts/src/artifact-files.ts';
import type { Command, Entity } from '../packages/domain/src/core.ts';
import { DomainError } from '../packages/domain/src/core.ts';
import { readArtifactCopyOrigin } from '../packages/application/src/artifact-copy-origins.ts';
import { createDashboardFixture, dashboardDatabaseUrl, type DashboardFixture } from './dashboard-fixture.ts';

type Delivery = { artifact: Entity; artifactVersion: Entity };
type EntityPage = { items: Entity[]; nextCursor: string | null; cursor: string };
const expected = (...entities: Entity[]) => Object.fromEntries(entities.map(entity => [entity.id, entity.version]));

describe('Files lifecycle: real PostgreSQL, HTTP and independently stored immutable bytes', { skip: !dashboardDatabaseUrl, timeout: 180_000 }, () => {
  let f: DashboardFixture;
  before(async () => { f = await createDashboardFixture(); });
  after(async () => { await f?.close(); });
  const prefix = () => `/api/v1/workspaces/${f.workspaceId}`;
  const blobRoot = () => join(dirname(f.coreRoot), 'blobs');
  async function project(name = 'Files lifecycle') { return f.command('CreateProject', { name, goal: 'Real immutable delivery', ownerId: f.owner.id, completionCriteria: [] }); }
  async function stage(project: Entity, text: string, fileName: string) {
    return (await f.command<{ upload: Entity }>('StageUpload', { contentBase64: Buffer.from(text).toString('base64'), fileName, mediaType: 'text/plain' }, { extra: { projectId: project.id } })).upload;
  }
  async function register(project: Entity, text = 'first bytes X', fileName = 'first.txt'): Promise<Delivery> {
    const upload = await stage(project, text, fileName);
    return f.command('RegisterArtifact', { title: 'Display title', kind: 'document', uploadId: upload.id }, { extra: { projectId: project.id, expectedVersions: expected(upload) } });
  }
  async function read(id: string) { const response = await f.request<Entity>(`${prefix()}/entities/${id}`); assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body; }
  function metadata(type: string, artifact: Entity, payload: Record<string, unknown> = {}): Command {
    return { commandId: randomUUID(), commandType: type, targetId: artifact.id, projectId: artifact.projectId!, expectedVersions: expected(artifact), payload };
  }
  function copy(artifact: Entity, version: Entity, target: Entity): Command {
    return { commandId: randomUUID(), commandType: 'CopyArtifactVersion', targetId: version.id, projectId: target.id, expectedVersions: expected(artifact, version, target), payload: { targetTitle: 'Independent copy', targetKind: 'document' } };
  }
  async function committed(request: Command): Promise<Delivery> {
    const response = await f.send(request); assert.equal(response.status, 200, JSON.stringify(response.body)); assert.equal(response.body.status, 'committed'); return response.body.result as Delivery;
  }
  async function content(version: Entity, cookie = f.ownerCookie) {
    const response = await fetch(`${f.origin}${prefix()}/artifact-versions/${version.id}/content`, { headers: { cookie } });
    assert.equal(response.status, 200); return { bytes: Buffer.from(await response.arrayBuffer()), disposition: response.headers.get('content-disposition') };
  }
  async function list(kind: string, project: Entity, visibility = 'visible', after = '', limit = 2) {
    const response = await f.request<EntityPage>(`${prefix()}/entities?kind=${kind}&projectId=${project.id}&visibility=${visibility}&limit=${limit}${after ? `&after=${encodeURIComponent(after)}` : ''}`);
    assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body;
  }
  async function all(kind: string, project: Entity, visibility: string) {
    const result: Entity[] = []; let cursor = '';
    do { const page = await list(kind, project, visibility, cursor); result.push(...page.items); cursor = page.nextCursor ?? ''; } while (cursor);
    return result;
  }

  it('renames only the title, preserves Evidence and exact version downloads, then hides/restores the same identity with strict no-op CAS', async () => {
    const p = await project(); const original = await register(p);
    const staged = await stage(p, 'second bytes Y', 'second.txt');
    const next = await f.command<Delivery>('AddArtifactVersion', { uploadId: staged.id }, { extra: { projectId: p.id, targetId: original.artifact.id, expectedVersions: expected(original.artifact, staged) } });
    const evidence = (await f.command<{ evidence: Entity }>('RecordEvidence', { subjectRefs: [p.id], method: 'Read originals', scope: 'Both immutable versions', result: 'pass', observedAt: new Date().toISOString(), artifactVersionRefs: [original.artifactVersion.id, next.artifactVersion.id] }, { extra: { projectId: p.id } })).evidence;
    const rename = metadata('RenameArtifact', next.artifact, { title: '交付显示名 / pretend.png' });
    const renamed = (await committed(rename)).artifact;
    assert.equal(renamed.data.title, '交付显示名 / pretend.png'); assert.equal(renamed.version, next.artifact.version + 1);
    for (const [version, bytes, filename] of [[original.artifactVersion, 'first bytes X', 'first.txt'], [next.artifactVersion, 'second bytes Y', 'second.txt']] as const) {
      assert.deepEqual(await read(version.id), version);
      const downloaded = await content(version); assert.equal(downloaded.bytes.toString(), bytes); assert.ok(downloaded.disposition?.includes(filename));
    }
    assert.deepEqual(await read(evidence.id), evidence);
    assert.deepEqual((await f.send(rename)).body.result, { artifact: renamed });
    assert.equal((await f.send({ ...rename, payload: { title: 'Different' } })).body.error?.code, 'idempotency_conflict');
    const hidden = (await committed(metadata('HideArtifact', renamed))).artifact;
    assert.equal(hidden.data.hiddenBy, f.owner.id); assert.ok(hidden.data.hiddenAt);
    assert.equal((await all('artifact', p, 'visible')).length, 0); assert.equal((await all('artifact_version', p, 'visible')).length, 0);
    assert.deepEqual((await all('artifact', p, 'hidden')).map(row => row.id), [hidden.id]);
    assert.equal((await all('artifact_version', p, 'hidden')).length, 2);
    assert.equal((await content(original.artifactVersion)).bytes.toString(), 'first bytes X');
    assert.deepEqual(await read(evidence.id), evidence);
    assert.equal((await f.send(metadata('RenameArtifact', hidden, { title: 'Blocked' }))).body.error?.code, 'artifact_hidden');
    const newUpload = await stage(p, 'new retained staging', 'third.txt');
    const add = await f.send({ commandId: randomUUID(), commandType: 'AddArtifactVersion', projectId: p.id, targetId: hidden.id, expectedVersions: expected(hidden, newUpload), payload: { uploadId: newUpload.id } });
    assert.equal(add.body.error?.code, 'artifact_hidden'); assert.equal((await read(newUpload.id)).data.consumedAt, null);
    const restored = (await committed(metadata('RestoreArtifact', hidden))).artifact;
    assert.equal(restored.id, original.artifact.id); assert.deepEqual(restored.data.versionRefs, next.artifact.data.versionRefs); assert.equal(restored.data.hiddenAt, null);
    const noOp = metadata('RestoreArtifact', restored); assert.deepEqual((await committed(noOp)).artifact, restored);
    assert.equal((await f.pool.query('SELECT count(*)::int AS count FROM outbox WHERE command_id=$1', [noOp.commandId])).rows[0].count, 0);
    assert.equal((await f.send(metadata('RestoreArtifact', hidden))).body.error?.code, 'version_conflict');
  });

  it('serializes competing metadata writers and commits only one event against the same frozen artifact version', async () => {
    const p = await project('Concurrent title metadata'); const source = await register(p);
    const requests = ['First writer', 'Second writer'].map(title => metadata('RenameArtifact', source.artifact, { title }));
    const responses = await Promise.all(requests.map(request => f.send(request)));
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
    assert.equal(responses.find(response => response.status === 409)!.body.error?.code, 'version_conflict');
    assert.equal((await read(source.artifact.id)).version, source.artifact.version + 1);
    const count = await f.pool.query('SELECT count(*)::int AS count FROM outbox WHERE command_id=ANY($1::uuid[])', [requests.map(request => request.commandId)]);
    assert.equal(count.rows[0].count, 1);
  });

  it('filters before pagination for both entities, binds visibility in cursors and rejects legacy cursors', async () => {
    const p = await project('Complete visibility pagination'); const visible: string[] = []; const hidden: string[] = [];
    for (let index = 0; index < 7; index += 1) { const delivery = await register(p, `bytes ${index}`); if (index % 2) { await committed(metadata('HideArtifact', delivery.artifact)); hidden.push(delivery.artifact.id); } else visible.push(delivery.artifact.id); }
    assert.deepEqual((await all('artifact', p, 'visible')).map(row => row.id).sort(), visible.sort());
    assert.deepEqual((await all('artifact', p, 'hidden')).map(row => row.id).sort(), hidden.sort());
    assert.equal((await all('artifact_version', p, 'visible')).length, 4); assert.equal((await all('artifact_version', p, 'hidden')).length, 3); assert.equal((await all('artifact_version', p, 'all')).length, 7);
    const page = await list('artifact', p); assert.ok(page.nextCursor);
    assert.equal((await f.request(`${prefix()}/entities?kind=artifact&projectId=${p.id}&visibility=hidden&after=${page.nextCursor}`)).status, 400);
    const legacy = Buffer.from(JSON.stringify({ kind: 'artifact', projectId: p.id, id: page.items[0]!.id })).toString('base64url');
    assert.equal((await f.request(`${prefix()}/entities?kind=artifact&projectId=${p.id}&after=${legacy}`)).status, 400);
    assert.equal((await f.request(`${prefix()}/entities?kind=evidence&projectId=${p.id}&visibility=all`)).status, 400);
  });

  it('copies the explicitly selected old version to an independent target upload/key, stores deferred provenance and protects source IDs from target-only readers', async () => {
    const a = await project('Private source'); const b = await project('Target audience'); const original = await register(a);
    const newerUpload = await stage(a, 'newest Y', 'second.txt');
    const latest = await f.command<Delivery>('AddArtifactVersion', { uploadId: newerUpload.id }, { extra: { projectId: a.id, targetId: original.artifact.id, expectedVersions: expected(original.artifact, newerUpload) } });
    const request = copy(latest.artifact, original.artifactVersion, b);
    const copied = await committed(request);
    assert.notEqual(copied.artifact.id, latest.artifact.id); assert.notEqual(copied.artifactVersion.id, original.artifactVersion.id);
    assert.notEqual(copied.artifactVersion.data.objectKey, original.artifactVersion.data.objectKey);
    assert.notEqual(copied.artifactVersion.data.uploadId, original.artifactVersion.data.uploadId);
    for (const field of ['sha256', 'contentDigest', 'size', 'mediaType', 'fileName']) assert.equal(copied.artifactVersion.data[field], original.artifactVersion.data[field]);
    assert.equal(copied.artifactVersion.data.producerId, f.owner.id); assert.equal(copied.artifactVersion.data.sourceRunId, null);
    assert.deepEqual(copied.artifact.data.versionRefs, [copied.artifactVersion.id]); assert.equal(copied.artifact.projectId, b.id);
    assert.equal((await content(copied.artifactVersion)).bytes.toString(), 'first bytes X');
    assert.deepEqual(await read(latest.artifact.id), latest.artifact);
    const originalFile = await readFile(join(blobRoot(), original.artifactVersion.data.objectKey));
    assert.deepEqual(await readFile(join(blobRoot(), copied.artifactVersion.data.objectKey)), originalFile);
    const origin = await f.request<ArtifactCopyOriginResponse>(`${prefix()}/artifact-versions/${copied.artifactVersion.id}/copy-origin`);
    assert.equal(origin.status, 200); assert.equal(origin.body.origin?.sourceArtifactVersionId, original.artifactVersion.id); assert.equal(origin.headers.get('cache-control'), 'private,no-store');
    const targetReader = await f.member('Target-only reader');
    await f.command('SetWorkspaceMember', { userId: targetReader.user.id, capabilities: ['domain.read', 'audit.read'], projectIds: [b.id] });
    const originPrivate = await f.request<ArtifactCopyOriginResponse>(`${prefix()}/artifact-versions/${copied.artifactVersion.id}/copy-origin`, { cookie: targetReader.cookie });
    assert.deepEqual(originPrivate.body, { origin: null });
    let sourceReads = 0;
    assert.deepEqual(await readArtifactCopyOrigin(f.pool, targetReader.user, f.workspaceId, copied.artifactVersion.id, async () => { sourceReads += 1; throw new DomainError('core_source_unavailable', 'Injected source unavailability', 503); }), { origin: null });
    assert.equal(sourceReads, 0, 'Target-only readers must not initialize or read the private source core');
    assert.deepEqual(await readArtifactCopyOrigin(f.pool, f.owner, f.workspaceId, copied.artifactVersion.id, async () => { throw new DomainError('core_source_unavailable', 'Injected source unavailability', 503); }), { origin: null });
    assert.equal((await content(copied.artifactVersion, targetReader.cookie)).bytes.toString(), 'first bytes X');
    const publicRows = await f.request<EntityPage>(`${prefix()}/entities?kind=artifact_version&projectId=${b.id}`, { cookie: targetReader.cookie });
    const audit = await f.request(`${prefix()}/projects/${b.id}/audit`, { cookie: targetReader.cookie });
    const targetUpload = await f.request(`${prefix()}/entities/${copied.artifactVersion.data.uploadId}`, { cookie: targetReader.cookie });
    for (const response of [publicRows, audit, targetUpload]) assert.equal(response.status, 200, JSON.stringify(response.body));
    const safe = JSON.stringify([publicRows.body, audit.body, targetUpload.body, copied]);
    for (const sourceId of [a.id, original.artifact.id, original.artifactVersion.id]) assert.equal(safe.includes(sourceId), false);
    const publishedKeys = await readdir(blobRoot());
    assert.deepEqual((await f.send(request)).body.result, copied);
    assert.deepEqual(await readdir(blobRoot()), publishedKeys);
    const origins = await f.pool.query('SELECT * FROM artifact_copy_origins WHERE command_id=$1', [request.commandId]); assert.equal(origins.rowCount, 1);
    const scope = await f.pool.query('SELECT scope_project_ids FROM command_receipts WHERE command_id=$1', [request.commandId]); assert.deepEqual(scope.rows[0].scope_project_ids.sort(), [a.id, b.id].sort());
    for (const statement of ['UPDATE artifact_copy_origins SET copied_at=now()', 'DELETE FROM artifact_copy_origins', 'TRUNCATE artifact_copy_origins']) await assert.rejects(f.pool.query(statement), /immutable/);
    for (const id of [original.artifactVersion.id]) await assert.rejects(f.pool.query('UPDATE entities SET data=data,version=version+1 WHERE id=$1', [id]), /immutable/);
  });

  it('rejects stale source/target CAS and unauthorized copy without any blob publication; writer recovery retains both current project scopes', async () => {
    const a = await project('CAS source'); const b = await project('CAS target'); const delivery = await register(a);
    const initial = copy(delivery.artifact, delivery.artifactVersion, b); const before = await readdir(blobRoot());
    const renamed = (await committed(metadata('RenameArtifact', delivery.artifact, { title: 'Changed while dialog open' }))).artifact;
    assert.equal((await f.send(initial)).body.error?.code, 'version_conflict'); assert.deepEqual(await readdir(blobRoot()), before);
    const missing = copy(renamed, delivery.artifactVersion, b); delete missing.expectedVersions![b.id];
    assert.equal((await f.send(missing)).body.error?.code, 'version_conflict');
    const writer = await f.member('Two-scope writer');
    const membership = await f.command<{ version: number }>('SetWorkspaceMember', { userId: writer.user.id, capabilities: ['domain.read', 'delivery.write'], projectIds: [a.id, b.id] });
    const request = copy(renamed, delivery.artifactVersion, b); const result = await f.send(request, { cookie: writer.cookie }); assert.equal(result.status, 200, JSON.stringify(result.body));
    const scoped = await f.command<{ version: number }>('SetWorkspaceMember', { userId: writer.user.id, capabilities: ['domain.read', 'delivery.write'], projectIds: [b.id] }, { extra: { expectedVersions: { [writer.user.id]: membership.version } } });
    assert.equal((await f.request(`${prefix()}/commands/${request.commandId}`, { cookie: writer.cookie })).status, 404);
    const newRequest = copy(renamed, delivery.artifactVersion, b); const files = await readdir(blobRoot());
    assert.equal((await f.send(newRequest, { cookie: writer.cookie })).status, 404); assert.deepEqual(await readdir(blobRoot()), files);
    const copied = result.body.result as Delivery;
    assert.deepEqual((await f.request(`${prefix()}/artifact-versions/${copied.artifactVersion.id}/copy-origin`, { cookie: writer.cookie })).body, { origin: null });
    assert.equal((await content(copied.artifactVersion, writer.cookie)).bytes.toString(), 'first bytes X');
    await f.command('SetWorkspaceMember', { userId: writer.user.id, capabilities: ['domain.read', 'delivery.write'], projectIds: [a.id, b.id] }, { extra: { expectedVersions: { [writer.user.id]: scoped.version } } });
    assert.deepEqual((await f.request(`${prefix()}/commands/${request.commandId}`, { cookie: writer.cookie })).body, result.body);
  });

  it('retains staged uploads across a frozen add-version conflict, rejects reader metadata writes and permits archived source history copying', async () => {
    const a = await project('Frozen upload/source history'); const b = await project('Writable destination'); const source = await register(a);
    const frozenArtifact = source.artifact;
    const upload = await stage(a, 'staged before concurrent rename', 'third.txt');
    const renamed = (await committed(metadata('RenameArtifact', frozenArtifact, { title: 'Concurrent title' }))).artifact;
    const stale: Command = { commandId: randomUUID(), commandType: 'AddArtifactVersion', targetId: source.artifact.id, projectId: a.id, expectedVersions: expected(frozenArtifact, upload), payload: { uploadId: upload.id } };
    assert.equal((await f.send(stale)).body.error?.code, 'version_conflict');
    assert.equal((await read(upload.id)).data.consumedAt, null);
    const added = await committed({ ...stale, commandId: randomUUID(), expectedVersions: expected(renamed, upload) });
    assert.equal(added.artifact.data.title, renamed.data.title); assert.equal(added.artifactVersion.data.fileName, 'third.txt');
    const reader = await f.member('Read-only history');
    await f.command('SetWorkspaceMember', { userId: reader.user.id, capabilities: ['domain.read'], projectIds: [a.id] });
    for (const type of ['RenameArtifact', 'HideArtifact', 'RestoreArtifact']) assert.equal((await f.send(metadata(type, added.artifact, type === 'RenameArtifact' ? { title: 'Forbidden' } : {}), { cookie: reader.cookie })).status, 403);
    assert.equal((await f.send(copy(added.artifact, source.artifactVersion, a), { cookie: reader.cookie })).status, 403);
    const cancelled = await f.command('CancelProject', { reason: 'Retain archived source history' }, { extra: { targetId: a.id, expectedVersions: expected(a) } });
    await f.command('ArchiveObject', { kind: 'project', reason: 'Historical source remains readable' }, { extra: { targetId: a.id, expectedVersions: expected(cancelled) } });
    const copied = await committed(copy(added.artifact, source.artifactVersion, b));
    assert.equal((await content(copied.artifactVersion)).bytes.toString(), 'first bytes X');
    const hiddenAttempt = await f.send(metadata('HideArtifact', added.artifact));
    assert.equal(hiddenAttempt.body.status, 'rejected');
  });

  it('rolls back deferred origin rejection including its provisional success receipt; retains only the rejected receipt and orphan blob', async () => {
    const a = await project('Constraint source'); const b = await project('Constraint target'); const source = await register(a);
    const request = copy(source.artifact, source.artifactVersion, b);
    const before = await f.pool.query('SELECT count(*)::int AS count FROM entities'); const files = await readdir(blobRoot());
    await f.pool.query(`CREATE FUNCTION test_files_corrupt_origin() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.source_project_id := 'PRJ-999999999'; RETURN NEW; END $$`);
    await f.pool.query('CREATE TRIGGER test_files_origin_fault BEFORE INSERT ON artifact_copy_origins FOR EACH ROW EXECUTE FUNCTION test_files_corrupt_origin()');
    try {
      const response = await f.send(request); assert.equal(response.body.status, 'rejected'); assert.equal(response.body.error?.code, 'validation_failed');
      assert.deepEqual((await f.request(`${prefix()}/commands/${request.commandId}`)).body, response.body);
      assert.equal((await f.pool.query('SELECT count(*)::int AS count FROM entities')).rows[0].count, before.rows[0].count);
      for (const table of ['outbox', 'artifact_copy_origins']) assert.equal((await f.pool.query(`SELECT count(*)::int AS count FROM ${table} WHERE command_id=$1`, [request.commandId])).rows[0].count, 0);
      const receipts = await f.pool.query('SELECT receipt FROM command_receipts WHERE command_id=$1', [request.commandId]); assert.equal(receipts.rowCount, 1); assert.equal(receipts.rows[0].receipt.status, 'rejected');
      assert.equal((await readdir(blobRoot())).length, files.length + 1);
    } finally { await f.pool.query('DROP TRIGGER test_files_origin_fault ON artifact_copy_origins'); await f.pool.query('DROP FUNCTION test_files_corrupt_origin()'); }
  });

  it('rejects corrupt source bytes and recovers real committed response loss for copy, rename, hide and restore only through each original receipt', async () => {
    const a = await project('Response-loss source'); const b = await project('Response-loss target'); const source = await register(a);
    const file = join(blobRoot(), source.artifactVersion.data.objectKey); const original = await readFile(file); const files = await readdir(blobRoot());
    await writeFile(file, Buffer.from('corrupted'));
    try { assert.equal((await f.send(copy(source.artifact, source.artifactVersion, b))).body.error?.code, 'blob_integrity_error'); assert.equal((await readdir(blobRoot())).length, files.length); }
    finally { await writeFile(file, original); }
    const request = copy(source.artifact, source.artifactVersion, b) as ClientCommand;
    let forwarded = 0;
    const proxy = createServer((incoming, outgoing) => {
      void (async () => {
        const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
        forwarded += 1;
        const response = await fetch(`${f.origin}${incoming.url}`, { method: 'POST', headers: { cookie: f.ownerCookie, 'content-type': 'application/json' }, body: Buffer.concat(chunks) });
        const actual = await response.json() as { status?: string }; assert.equal(actual.status, 'committed');
        outgoing.destroy(); // Actual upstream COMMIT, then real downstream socket loss.
      })().catch(error => { outgoing.destroy(error instanceof Error ? error : undefined); });
    });
    const listening = once(proxy, 'listening'); proxy.listen(0, '127.0.0.1'); await listening;
    const address = proxy.address(); assert.ok(address && typeof address !== 'string');
    const client = new ProjectManagementClient({ baseUrl: `http://127.0.0.1:${address.port}`, auth: { type: 'none' } });
    try {
      await assert.rejects(client.executeCommand(f.workspaceId, request), CommandOutcomeUnknown);
      const receipt = await f.request<{ result: Delivery }>(`${prefix()}/commands/${request.commandId}`); assert.equal(receipt.status, 200);
      let artifact = receipt.body.result.artifact;
      for (const commandType of ['RenameArtifact', 'HideArtifact', 'RestoreArtifact']) {
        const originalRequest = metadata(commandType, artifact, commandType === 'RenameArtifact' ? { title: 'Recovered display title' } : {}) as ClientCommand;
        await assert.rejects(client.executeCommand(f.workspaceId, originalRequest), CommandOutcomeUnknown);
        const recovered = await f.request<{ status: string; result: Delivery }>(`${prefix()}/commands/${originalRequest.commandId}`);
        assert.equal(recovered.status, 200); assert.equal(recovered.body.status, 'committed');
        artifact = recovered.body.result.artifact;
        assert.equal(artifact.id, receipt.body.result.artifact.id);
        assert.equal((await f.pool.query('SELECT count(*)::int AS count FROM command_receipts WHERE command_id=$1', [originalRequest.commandId])).rows[0].count, 1);
      }
      assert.equal(artifact.data.hiddenAt, null); assert.equal(artifact.data.title, 'Recovered display title');
    } finally { const closed = once(proxy, 'close'); proxy.close(); await closed; }
    assert.equal(forwarded, 4);
    const rows = await f.pool.query('SELECT * FROM artifact_copy_origins WHERE command_id=$1', [request.commandId]); assert.equal(rows.rowCount, 1);
    assert.equal((await readdir(blobRoot())).length, files.length + 1);
  });
});
