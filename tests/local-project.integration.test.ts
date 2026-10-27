import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomInt, randomUUID } from 'node:crypto';
import { cp, link, lstat, mkdir, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ProjectManagementClient } from '../packages/contracts/src/client.ts';
import type { LocalDirectory, LocalProjectAttempt, LocalProjectInitialization, LocalProjectLocation, LocalProjectSettings } from '../packages/contracts/src/local-projects.ts';
import type { Command, Entity } from '../packages/domain/src/core.ts';
import type { FileRecord } from '../packages/pm-schema/index.ts';
import { createLocalProjectFixture, localProjectEventually } from './local-project-fixture.ts';
import type { LocalProjectFixture } from './local-project-fixture.ts';
import { lockWorkspace } from '../packages/infrastructure/src/database.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=', 'base64');
type Ready = Extract<LocalProjectAttempt, { status: 'ready' }>;
type Delivery = { artifact: Entity; artifactVersion: Entity };

async function initialize(f: LocalProjectFixture, title: string, directory: LocalDirectory, key = randomUUID()): Promise<Ready> {
  const response = await f.request<LocalProjectAttempt>(`/api/v1/workspaces/${f.workspaceId}/local-projects/initializations`, {
    method: 'POST', headers: { 'Idempotency-Key': key }, body: { input: { entity: 'project', title, body: `Original project body: ${title}` }, directory },
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.status, 'ready', JSON.stringify(response.body));
  if (response.body.status !== 'ready') throw new Error('Project initialization did not become ready');
  assert.equal(response.body.location.status, 'available');
  return response.body;
}
async function upload(f: LocalProjectFixture, projectId: string, bytes: Buffer, fileName = 'acceptance.bin', mediaType = 'application/octet-stream'): Promise<Delivery> {
  const { upload } = await f.command<{ upload: Entity }>('StageUpload', { contentBase64: bytes.toString('base64'), fileName, mediaType }, { projectId });
  return f.command<Delivery>('RegisterArtifact', { title: fileName, kind: mediaType === 'image/png' ? 'image' : 'document', uploadId: upload.id }, { projectId, expectedVersions: { [upload.id]: upload.version } });
}
async function download(f: LocalProjectFixture, versionId: string, cookie = f.ownerCookie): Promise<Buffer> {
  const response = await fetch(`${f.origin}/api/v1/workspaces/${f.workspaceId}/artifact-versions/${versionId}/content`, { headers: { cookie }, signal: AbortSignal.timeout(20_000) });
  assert.equal(response.status, 200);
  return Buffer.from(await response.arrayBuffer());
}
async function filesBelow(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    assert.equal(entry.isSymbolicLink(), false, 'Acceptance never traverses a symlink');
    if (entry.isDirectory()) files.push(...await filesBelow(path));
    else files.push(path);
  }
  return files;
}

// These cases deliberately do not skip without PostgreSQL. The explicit command
// is an acceptance gate, not a model/unit suite or a health-check substitution.
describe('LP-ACCEPT: isolated disk / PostgreSQL / HTTP / real Worker boundaries', { timeout: 300_000, concurrency: 1 }, () => {
  it('LP-A01/A02/A03/A06: keeps two roots separate, preserves source bytes, aggregates Markdown and persists uploads across restart', async t => {
    const f = await createLocalProjectFixture(); t.after(() => f.close());
    const rootA = join(f.parents[0], 'existing-code');
    await mkdir(join(rootA, 'src'), { recursive: true });
    const originals: Record<string, Buffer> = { 'README.md': Buffer.from('# User README\r\nDo not rewrite.\r\n'), 'src/main.bin': Buffer.from([0, 255, 127, 10, 0, 13]) };
    for (const [name, bytes] of Object.entries(originals)) await writeFile(join(rootA, name), bytes);
    const a = await initialize(f, 'First physical project', { mode: 'existing', path: rootA });
    const b = await initialize(f, 'Second physical project', { mode: 'new', parentPath: f.parents[1], folderName: 'second-project' });
    const rootB = join(f.parents[1], 'second-project');
    assert.notEqual(a.record.id, b.record.id); assert.notEqual(a.location.storageId, b.location.storageId);
    for (const project of [a, b]) {
      assert.ok(project.location.path);
      assert.equal(await readFile(join(project.location.path, '.pm/core/projects', `${project.record.id}.md`), 'utf8'), project.record.raw);
      assert.ok((await lstat(join(project.location.path, '.pm/core/work-items'))).isDirectory());
      assert.ok((await lstat(join(project.location.path, '.pm/core/docs'))).isDirectory());
      const marker = JSON.parse(await readFile(join(project.location.path, '.pm/project.json'), 'utf8')) as Record<string, unknown>;
      assert.equal(marker.projectId, project.record.id); assert.equal(marker.workspaceId, f.workspaceId);
      assert.equal(JSON.stringify(marker).includes(project.record.entity.title), false, 'Marker is storage identity, not a second project title authority');
    }
    const core = `/api/v1/workspaces/${f.workspaceId}/core`;
    const task = await f.request<FileRecord>(`${core}/entities`, { method: 'POST', headers: { 'Idempotency-Key': randomUUID() }, body: { entity: 'work_item', project: a.record.id, title: 'Root A task', body: 'Task body\n\n- [ ] Human criterion', 'x-pm-start': '2026-10-24', due: '2026-10-28' } });
    assert.equal(task.status, 200, JSON.stringify(task.body));
    const doc = await f.request<FileRecord>(`${core}/entities`, { method: 'POST', headers: { 'Idempotency-Key': randomUUID() }, body: { entity: 'document', project: b.record.id, title: 'Root B design', document_kind: 'design', body: `See [[${task.body.id}]] without copying it.` } });
    assert.equal(doc.status, 200, JSON.stringify(doc.body));
    const edited = await f.request<FileRecord>(`${core}/entities/${task.body.id}`, { method: 'PATCH', body: { revision: task.body.revision, changes: { due: '2026-10-30' } } });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    const taskDisk = join(rootA, '.pm/core/work-items', `${task.body.id}.md`), docDisk = join(rootB, '.pm/core/docs', `${doc.body.id}.md`);
    assert.equal(await readFile(taskDisk, 'utf8'), edited.body.raw); assert.equal(await readFile(docDisk, 'utf8'), doc.body.raw);
    await assert.rejects(lstat(join(rootB, '.pm/core/work-items', `${task.body.id}.md`)), { code: 'ENOENT' });
    await assert.rejects(lstat(join(rootA, '.pm/core/docs', `${doc.body.id}.md`)), { code: 'ENOENT' });
    const binaryA = Buffer.from([0, 255, 1, 19, 42]), binaryB = Buffer.from('Project B immutable original\n');
    const artifactA = await upload(f, a.record.id, binaryA), artifactB = await upload(f, b.record.id, binaryB);
    assert.deepEqual(await download(f, artifactA.artifactVersion.id), binaryA); assert.deepEqual(await download(f, artifactB.artifactVersion.id), binaryB);
    const diskA = await filesBelow(join(rootA, '.pm/attachments')), diskB = await filesBelow(join(rootB, '.pm/attachments'));
    assert.ok((await Promise.all(diskA.map(path => readFile(path)))).some(bytes => bytes.equals(binaryA)));
    assert.ok((await Promise.all(diskB.map(path => readFile(path)))).some(bytes => bytes.equals(binaryB)));
    assert.equal((await Promise.all(diskB.map(path => readFile(path)))).some(bytes => bytes.equals(binaryA)), false);
    const globalBytes = await Promise.all((await filesBelow(f.blobRoot)).map(path => readFile(path)));
    assert.equal(globalBytes.some(bytes => bytes.equals(binaryA) || bytes.equals(binaryB)), false, 'New project uploads do not silently land in global BLOB_ROOT');
    const beforeWorker = new Map<string, Buffer>();
    for (const root of [rootA, rootB]) for (const path of await filesBelow(join(root, '.pm'))) beforeWorker.set(path, await readFile(path));
    await f.startWorker();
    const conversation = await f.command<Entity>('CreateConversation', { title: 'Real Worker publication' });
    await localProjectEventually(async () => (await f.pool.query("SELECT 1 FROM events WHERE envelope->>'aggregateId'=$1", [conversation.id])).rowCount! > 0, 'the real Worker to publish a real PM outbox event');
    const afterWorkerPaths = [...await filesBelow(join(rootA, '.pm')), ...await filesBelow(join(rootB, '.pm'))];
    assert.deepEqual(afterWorkerPaths.sort(), [...beforeWorker.keys()].sort(), 'The real Worker does not create project authority files');
    for (const [path, bytes] of beforeWorker) assert.deepEqual(await readFile(path), bytes, 'Worker observation never mutates project authority');
    const all = await f.request<{ items: FileRecord[] }>(`${core}/query`, { method: 'POST', body: { view: { layout: 'table' } } });
    assert.equal(all.status, 200);
    for (const id of [a.record.id, b.record.id, task.body.id, doc.body.id]) assert.equal(all.body.items.filter(file => file.id === id).length, 1);
    const frozen = await readFile(taskDisk);
    await f.restartApi();
    const after = await f.request<FileRecord>(`${core}/files/${task.body.id}`);
    assert.equal(after.status, 200); assert.equal(after.body.id, task.body.id); assert.equal(after.body.revision, edited.body.revision); assert.deepEqual(await readFile(taskDisk), frozen);
    const external = edited.body.raw + '\nExternal legal Markdown change.\n';
    await writeFile(taskDisk, external);
    await localProjectEventually(async () => {
      const read = await f.request<FileRecord>(`${core}/files/${task.body.id}`);
      return read.status === 200 && read.body.raw === external && read.body.revision !== edited.body.revision;
    }, 'the external-root watcher to publish changed authoritative bytes');
    for (const [name, bytes] of Object.entries(originals)) assert.deepEqual(await readFile(join(rootA, name)), bytes);
  });

  it('LP-A02/A05/A06: rejects unauthorized host probing, untrusted origins, escaping/symlink/nested/duplicate and hard-linked markers', async t => {
    const f = await createLocalProjectFixture(); t.after(() => f.close());
    const prefix = `/api/v1/workspaces/${f.workspaceId}/local-projects`;
    const configured = await f.request<LocalProjectSettings>(`${prefix}/settings`);
    assert.equal(configured.status, 200); assert.equal(configured.body.enabled, true); assert.equal(configured.body.canManage, true);
    assert.deepEqual(configured.body.allowedRoots, f.parents);
    const changeDefault = await f.request<LocalProjectSettings>(`${prefix}/settings`, { method: 'PUT', body: { defaultParent: f.parents[1] } });
    assert.equal(changeDefault.status, 200); assert.equal(changeDefault.body.defaultParent, f.parents[1]);
    const noExpansion = await f.request(`${prefix}/settings`, { method: 'PUT', body: { defaultParent: f.root } });
    assert.ok(noExpansion.status >= 400, 'Browser path text cannot expand the host-configured directory allowlist');
    await f.restartApi();
    assert.equal((await f.request<LocalProjectSettings>(`${prefix}/settings`)).body.defaultParent, f.parents[1]);
    const listed = await f.request<{ path: string; directories: { path: string }[] }>(`${prefix}/directories?path=${encodeURIComponent(f.parents[0])}`);
    assert.equal(listed.status, 200); assert.equal(listed.body.path, f.parents[0]);
    const encodedParent = join(f.parents[0], '目录 with spaces & query');
    await mkdir(join(encodedParent, 'real child'), { recursive: true });
    const client = new ProjectManagementClient({ baseUrl: f.origin, auth: { type: 'cookie', credentials: 'include', cookie: () => f.ownerCookie } });
    const clientDirectories = await client.localProjects.directories(f.workspaceId, encodedParent);
    assert.equal(clientDirectories.path, encodedParent);
    assert.deepEqual(clientDirectories.directories.map(directory => directory.name), ['real child']);
    const a = await initialize(f, 'Protected root', { mode: 'new', parentPath: f.parents[0], folderName: 'protected' });
    const member = await f.member('Restricted project reader');
    await f.command('SetWorkspaceMember', { userId: member.user.id, capabilities: ['domain.read', 'planning.edit'], projectIds: [a.record.id] });
    const probing = await f.request(`${prefix}/directories?path=${encodeURIComponent(f.parents[0])}`, { cookie: member.cookie });
    assert.ok(probing.status === 403 || probing.status === 404, JSON.stringify(probing.body));
    assert.equal(JSON.stringify(probing.body).includes(f.parents[0]), false);
    const redacted = await f.request<LocalProjectLocation>(`${prefix}/projects/${a.record.id}/location`, { cookie: member.cookie });
    assert.equal(redacted.status, 200); assert.equal(redacted.body.path, null);
    assert.equal(JSON.stringify(redacted.body).includes(f.parents[0]), false);
    const settings = await f.request<LocalProjectSettings>(`${prefix}/settings`, { cookie: member.cookie });
    assert.equal(settings.status, 200); assert.equal(settings.body.canManage, false); assert.deepEqual(settings.body.allowedRoots, []); assert.equal(settings.body.defaultParent, null);
    assert.equal((await f.request(`${prefix}/directories`, { cookie: '' })).status, 401);
    assert.equal((await f.request(`${prefix}/directories`, { headers: { origin: 'https://hostile.example' } })).status, 403);
    const forbidden = await f.request(`${prefix}/preview`, { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' }, body: { directory: { mode: 'existing', path: f.parents[0] } } });
    assert.equal(forbidden.status, 403);
    const preflightPath = join(f.parents[1], 'preflight-candidate'); await mkdir(preflightPath);
    const preview = await f.request(`${prefix}/preview`, { method: 'POST', body: { directory: { mode: 'existing', path: preflightPath } } });
    assert.equal(preview.status, 200);
    const preflightOffline = `${preflightPath}-owned-original`;
    await rename(preflightPath, preflightOffline); await symlink(a.location.path!, preflightPath, 'dir');
    const replaced = await f.request(`${prefix}/initializations`, { method: 'POST', headers: { 'Idempotency-Key': randomUUID() }, body: { input: { entity: 'project', title: 'No stale preview authority' }, directory: { mode: 'existing', path: preflightPath } } });
    assert.ok(replaced.status >= 400, 'Initialization rechecks disk identity instead of trusting an earlier preview');
    await assert.rejects(lstat(join(preflightOffline, '.pm/project.json')), { code: 'ENOENT' });
    const linkPath = join(f.parents[1], 'symlink-project'); await symlink(a.location.path!, linkPath, 'dir');
    const nested = join(a.location.path!, 'nested'); await mkdir(nested);
    const damaged = join(f.parents[1], 'damaged'); await mkdir(join(damaged, '.pm'), { recursive: true }); await writeFile(join(damaged, '.pm/project.json'), '{broken-marker');
    const hardlinked = join(f.parents[1], 'hardlink-marker'); await mkdir(join(hardlinked, '.pm'), { recursive: true });
    await writeFile(join(hardlinked, '.pm/project.json'), await readFile(join(a.location.path!, '.pm/project.json')));
    await link(join(hardlinked, '.pm/project.json'), join(hardlinked, '.pm/marker-hardlink'));
    const invalid: LocalDirectory[] = [
      { mode: 'existing', path: a.location.path! }, { mode: 'existing', path: nested }, { mode: 'existing', path: f.parents[0] },
      { mode: 'existing', path: linkPath }, { mode: 'existing', path: damaged }, { mode: 'existing', path: hardlinked },
      { mode: 'existing', path: join(f.root, 'outside-authorized-roots') }, { mode: 'existing', path: '/etc' },
      { mode: 'new', parentPath: f.parents[1], folderName: '../escape' },
    ];
    for (const directory of invalid) {
      const response = await f.request(`${prefix}/initializations`, { method: 'POST', headers: { 'Idempotency-Key': randomUUID() }, body: { input: { entity: 'project', title: 'Must not be created' }, directory } });
      assert.ok(response.status >= 400, `Unsafe directory unexpectedly accepted: ${directory.mode}`);
    }
    const scopedCreate = await f.request(`${prefix}/initializations`, { method: 'POST', cookie: member.cookie, headers: { 'Idempotency-Key': randomUUID() }, body: { input: { entity: 'project', title: 'No host management' }, directory: { mode: 'new', parentPath: f.parents[1], folderName: 'forbidden' } } });
    assert.equal(scopedCreate.status, 403);
    const files = await f.request<{ items: FileRecord[] }>(`/api/v1/workspaces/${f.workspaceId}/core/items?entity=project`);
    assert.deepEqual(files.body.items.filter(file => file.entity.entity === 'project').map(file => file.id), [a.record.id]);
    const binary = await upload(f, a.record.id, Buffer.from('private object'));
    const outsider = await f.member('No workspace access');
    const hidden = await fetch(`${f.origin}/api/v1/workspaces/${f.workspaceId}/artifact-versions/${binary.artifactVersion.id}/content`, { headers: { cookie: outsider.cookie } });
    assert.equal(hidden.status, 404); assert.equal((await hidden.text()).includes(a.location.path!), false);
    const arbitrary = await f.request(`/api/v1/workspaces/${f.workspaceId}/core/files/${encodeURIComponent(join(a.location.path!, '.pm/project.json'))}`);
    assert.ok(arbitrary.status >= 400, 'Authorized ordinary core file reads never accept host absolute paths');
  });

  it('LP-A04/A09: original key survives duplicate/mismatched submissions and every native/command entry requires a local directory', async t => {
    const f = await createLocalProjectFixture(); t.after(() => f.close());
    const prefix = `/api/v1/workspaces/${f.workspaceId}`;
    const input: LocalProjectInitialization = { input: { entity: 'project', title: 'Exactly once' }, directory: { mode: 'new', parentPath: f.parents[0], folderName: 'once' } };
    const key = randomUUID();
    const first = await f.request<LocalProjectAttempt>(`${prefix}/local-projects/initializations`, { method: 'POST', headers: { 'Idempotency-Key': key }, body: input });
    assert.equal(first.status, 200); assert.equal(first.body.status, 'ready');
    const again = await f.request<LocalProjectAttempt>(`${prefix}/local-projects/initializations`, { method: 'POST', headers: { 'Idempotency-Key': key }, body: input });
    assert.equal(again.status, 200); assert.deepEqual(again.body, first.body);
    const mismatch = await f.request(`${prefix}/local-projects/initializations`, { method: 'POST', headers: { 'Idempotency-Key': key }, body: { ...input, input: { ...input.input, title: 'Different immutable request' } } });
    assert.equal(mismatch.status, 409);
    assert.deepEqual((await f.request(`${prefix}/local-projects/initializations/${key}`)).body, first.body);
    assert.equal((await f.request(`${prefix}/core/entities`, { method: 'POST', headers: { 'Idempotency-Key': randomUUID() }, body: { entity: 'project', title: 'No directory native bypass' } })).status, 400);
    const missing: Command = { commandId: randomUUID(), commandType: 'CreateProject', payload: { name: 'No directory command bypass', goal: '', ownerId: f.owner.id, completionCriteria: [] } };
    const denied = await f.send(missing); assert.ok(denied.status >= 400 || denied.body.status === 'rejected');
    const receiptsBeforeNative = (await f.pool.query('SELECT command_id FROM command_receipts ORDER BY command_id')).rows;
    const nativeKey = randomUUID();
    const native = await f.request<FileRecord>(`${prefix}/core/entities`, { method: 'POST', headers: { 'Idempotency-Key': nativeKey }, body: { entity: 'project', title: 'Native initialization', localDirectory: { mode: 'new', parentPath: f.parents[0], folderName: 'native' } } });
    assert.equal(native.status, 200, JSON.stringify(native.body));
    const nativeOutcome = await f.request<{ status: string; entityId?: string }>(`${prefix}/core/creation-attempts/${nativeKey}`);
    assert.equal(nativeOutcome.body.status, 'committed'); assert.equal(nativeOutcome.body.entityId, native.body.id);
    assert.deepEqual((await f.pool.query('SELECT command_id FROM command_receipts ORDER BY command_id')).rows, receiptsBeforeNative, 'A native journal write never creates an ordinary PM receipt');
    const command: Command = { commandId: randomUUID(), commandType: 'CreateProject', payload: { name: 'Command initialization', goal: '', ownerId: f.owner.id, completionCriteria: [], localDirectory: { mode: 'new', parentPath: f.parents[1], folderName: 'command' } } };
    const commandResponse = await f.send(command); assert.equal(commandResponse.status, 200, JSON.stringify(commandResponse.body)); assert.equal(commandResponse.body.status, 'committed');
    const project = commandResponse.body.result as Entity;
    assert.equal(await readFile(join(f.parents[1], 'command/.pm/core/projects', `${project.id}.md`), 'utf8'), (await f.request<FileRecord>(`${prefix}/core/files/${project.id}`)).body.raw);
    assert.deepEqual((await f.request(`${prefix}/commands/${command.commandId}`)).body, commandResponse.body);
    assert.deepEqual((await f.request(`${prefix}/core/creation-attempts/${command.commandId}`)).body, { status: 'not_found' }, 'A PM command receipt never becomes a native journal outcome');
  });

  it('LP-A04: recovers real dropped HTTP responses using the fixed original initialization key', async t => {
    const f = await createLocalProjectFixture(); t.after(() => f.close());
    const key = randomUUID(), path = `/api/v1/workspaces/${f.workspaceId}/local-projects/initializations`;
    const body: LocalProjectInitialization = { input: { entity: 'project', title: 'Lost successful response' }, directory: { mode: 'new', parentPath: f.parents[0], folderName: 'lost-response' } };
    const completion = Promise.withResolvers<Ready>();
    const proxy = createServer((incoming, outgoing) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
        const originalKey = incoming.headers['idempotency-key'];
        assert.equal(typeof originalKey, 'string');
        const upstream = await f.request<LocalProjectAttempt>(incoming.url!, { method: 'POST', headers: { 'Idempotency-Key': originalKey as string }, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        assert.equal(upstream.status, 200); assert.equal(upstream.body.status, 'ready');
        if (upstream.body.status !== 'ready') throw new Error('Expected durable initialization');
        outgoing.destroy(); completion.resolve(upstream.body);
      })().catch(error => { completion.reject(error); outgoing.destroy(); });
    });
    const listening = once(proxy, 'listening'); proxy.listen(0, '127.0.0.1'); await listening;
    t.after(async () => { const closed = once(proxy, 'close'); proxy.closeAllConnections(); proxy.close(); await closed; });
    const address = proxy.address(); assert.ok(address && typeof address !== 'string');
    await assert.rejects(fetch(`http://127.0.0.1:${address.port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) }));
    const committed = await completion.promise;
    await f.restartApi();
    assert.deepEqual((await f.request(`${path}/${key}`)).body, committed);
    assert.deepEqual((await f.request(`${path}/${key}/recover`, { method: 'POST', body: {} })).body, committed);
    assert.equal((await readdir(join(f.parents[0], 'lost-response/.pm/core/projects'))).filter(file => file.endsWith('.md')).length, 1);
    const unknown = randomUUID();
    assert.deepEqual((await f.request(`${path}/${unknown}`)).body, { status: 'not_found' });
    assert.deepEqual((await f.request(`${path}/${unknown}/recover`, { method: 'POST', body: {} })).body, { status: 'not_found' });
    assert.equal((await readdir(f.parents[0])).length, 1, 'Result lookup/recovery never retries an unknown create under a new key');
  });

  it('LP-A04: survives a genuine API SIGKILL after disk commit but before SQL audit commit; GET is read-only and recovery is exactly once', async t => {
    const f = await createLocalProjectFixture();
    const lock = await f.pool.connect();
    t.after(async () => { lock.release(); await f.close(); });
    const lockNamespace = randomInt(1, 2_147_483_647), lockId = randomInt(1, 2_147_483_647);
    await lock.query('SELECT pg_advisory_lock($1,$2)', [lockNamespace, lockId]);
    await f.pool.query(`CREATE FUNCTION local_accept_block_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(${lockNamespace},${lockId}); RETURN NEW; END $$;
      CREATE TRIGGER local_accept_block_audit BEFORE INSERT ON project_audit FOR EACH ROW EXECUTE FUNCTION local_accept_block_audit()`);
    const key = randomUUID(), prefix = `/api/v1/workspaces/${f.workspaceId}/local-projects/initializations`, root = join(f.parents[0], 'crash');
    const dispatched = f.request(prefix, { method: 'POST', headers: { 'Idempotency-Key': key }, body: { input: { entity: 'project', title: 'Crash original' }, directory: { mode: 'new', parentPath: f.parents[0], folderName: 'crash' } } }).then(() => 'responded', () => 'connection_lost');
    try {
      await localProjectEventually(async () => {
        const waiting = await f.pool.query("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=$1::oid AND objid=$2::oid AND objsubid=2 AND NOT granted", [lockNamespace, lockId]);
        return waiting.rowCount! > 0;
      }, 'the real API to block at its post-file SQL audit boundary');
      const names = (await readdir(join(root, '.pm/core/projects'))).filter(file => file.endsWith('.md'));
      assert.equal(names.length, 1);
      const original = await readFile(join(root, '.pm/core/projects', names[0]!));
      await f.crashApi(); assert.equal(await dispatched, 'connection_lost');
      await lock.query('SELECT pg_advisory_unlock($1,$2)', [lockNamespace, lockId]);
      await f.pool.query('DROP TRIGGER local_accept_block_audit ON project_audit; DROP FUNCTION local_accept_block_audit()');
      await f.restartApi();
      // The background importer may already have recovered audit history at
      // startup. Hold its shared SQL lock to isolate the read-only GET itself.
      await lock.query('BEGIN'); await lockWorkspace(lock, f.workspaceId);
      try {
        const auditBeforeRead = (await lock.query('SELECT id,command_id,dedupe_key,changes FROM project_audit ORDER BY id')).rows;
        const before = await f.request<LocalProjectAttempt>(`${prefix}/${key}`);
        assert.equal(before.status, 200); assert.equal(before.body.status, 'pending');
        assert.deepEqual((await lock.query('SELECT id,command_id,dedupe_key,changes FROM project_audit ORDER BY id')).rows, auditBeforeRead, 'GET must not repair SQL history as a side effect');
      } finally { await lock.query('ROLLBACK'); }
      assert.deepEqual(await readFile(join(root, '.pm/core/projects', names[0]!)), original);
      const recovered = await f.request<LocalProjectAttempt>(`${prefix}/${key}/recover`, { method: 'POST', body: {} });
      assert.equal(recovered.status, 200); assert.equal(recovered.body.status, 'ready');
      if (recovered.body.status !== 'ready') throw new Error('Original initialization remains unresolved');
      assert.equal(recovered.body.record.raw, original.toString('utf8'));
      assert.deepEqual((await f.request(`${prefix}/${key}/recover`, { method: 'POST', body: {} })).body, recovered.body);
      assert.equal((await f.pool.query('SELECT 1 FROM project_audit WHERE target_id=$1', [recovered.body.record.id])).rowCount, 1);
      assert.equal((await readdir(join(root, '.pm/core/projects'))).filter(file => file.endsWith('.md')).length, 1);
    } finally { await lock.query('SELECT pg_advisory_unlock($1,$2)', [lockNamespace, lockId]); }
  });

  it('LP-A05: missing disks are unavailable rather than silently recreated and become readable under their original identity when reattached', async t => {
    const f = await createLocalProjectFixture(); t.after(() => f.close());
    const a = await initialize(f, 'Removable disk project', { mode: 'new', parentPath: f.parents[0], folderName: 'removable' });
    const artifact = await upload(f, a.record.id, Buffer.from('History on the removable disk'));
    const root = a.location.path!, offline = join(f.parents[0], 'owned-offline-disk');
    await f.stopServices(); await rename(root, offline); await f.restartApi();
    const prefix = `/api/v1/workspaces/${f.workspaceId}`;
    const location = await f.request<LocalProjectLocation>(`${prefix}/local-projects/projects/${a.record.id}/location`);
    assert.equal(location.status, 200); assert.equal(location.body.status, 'unavailable');
    const write = await f.request(`${prefix}/core/entities`, { method: 'POST', headers: { 'Idempotency-Key': randomUUID() }, body: { entity: 'work_item', project: a.record.id, title: 'Must not use an empty fallback root' } });
    assert.ok(write.status >= 400);
    const read = await fetch(`${f.origin}${prefix}/artifact-versions/${artifact.artifactVersion.id}/content`, { headers: { cookie: f.ownerCookie } }); assert.ok(read.status >= 400);
    await assert.rejects(lstat(root), { code: 'ENOENT' });
    assert.equal(await readFile(join(offline, '.pm/core/projects', `${a.record.id}.md`), 'utf8'), a.record.raw);
    await f.stopServices(); await rename(offline, root); await f.restartApi();
    const reattached = await f.request<FileRecord>(`${prefix}/core/files/${a.record.id}`);
    assert.equal(reattached.status, 200); assert.equal(reattached.body.revision, a.record.revision);
    assert.deepEqual(await download(f, artifact.artifactVersion.id), Buffer.from('History on the removable disk'));
  });

  it('LP-A07: migrates a genuine legacy project and relocates it without changing IDs, revisions, historic references or original user files', async t => {
    const f = await createLocalProjectFixture({ localProjectsEnabled: false }); t.after(() => f.close());
    const disabled = await f.request<LocalProjectSettings>(`/api/v1/workspaces/${f.workspaceId}/local-projects/settings`);
    assert.equal(disabled.status, 200); assert.equal(disabled.body.enabled, false); assert.equal(disabled.body.reason, 'not_configured');
    const project = await f.command<Entity>('CreateProject', { name: 'Legacy project before local directories', goal: 'Preserve this body', ownerId: f.owner.id, completionCriteria: [] });
    const prefix = `/api/v1/workspaces/${f.workspaceId}`;
    const original = await f.request<FileRecord>(`${prefix}/core/files/${project.id}`);
    assert.equal(original.status, 200);
    const task = await f.request<FileRecord>(`${prefix}/core/entities`, { method: 'POST', headers: { 'Idempotency-Key': randomUUID() }, body: { entity: 'work_item', project: project.id, title: 'Legacy task', body: `Linked to [[${project.id}]]`, due: '2026-10-30' } });
    assert.equal(task.status, 200);
    const historical = await upload(f, project.id, png, 'historic-cover.png', 'image/png');
    const newerUpload = await f.command<{ upload: Entity }>('StageUpload', { contentBase64: Buffer.from('Newer immutable version').toString('base64'), fileName: 'newer.txt', mediaType: 'text/plain' }, { projectId: project.id });
    const latest = await f.command<Delivery>('AddArtifactVersion', { uploadId: newerUpload.upload.id }, { projectId: project.id, targetId: historical.artifact.id, expectedVersions: { [historical.artifact.id]: historical.artifact.version, [newerUpload.upload.id]: newerUpload.upload.version } });
    const cover = await f.command<Entity>('SetProjectCover', { artifactVersionId: historical.artifactVersion.id }, { projectId: project.id, targetId: project.id, expectedVersions: { [project.id]: project.version } });
    const historyBefore = (await f.pool.query('SELECT id,data,version FROM entities WHERE id=ANY($1::uuid[]) ORDER BY id', [[historical.artifactVersion.id, latest.artifactVersion.id]])).rows;
    const auditBefore = (await f.pool.query('SELECT command_id,dedupe_key,changes FROM project_audit WHERE project_id=$1 ORDER BY id', [project.id])).rows;
    await f.restartApi(true);
    const migrateRoot = join(f.parents[0], 'migrated-code');
    await mkdir(migrateRoot); const userBytes = Buffer.from('# Existing migrated repository\n');
    await writeFile(join(migrateRoot, 'README.md'), userBytes);
    const migrateKey = randomUUID(), movePath = `${prefix}/local-projects/projects/${project.id}`;
    const migrated = await f.request<LocalProjectAttempt>(`${movePath}/migrate`, { method: 'POST', headers: { 'Idempotency-Key': migrateKey }, body: { directory: { mode: 'existing', path: migrateRoot }, writersStopped: true } });
    assert.equal(migrated.status, 200, JSON.stringify(migrated.body)); assert.equal(migrated.body.status, 'ready');
    assert.equal(await readFile(join(migrateRoot, '.pm/core/projects', `${project.id}.md`), 'utf8'), original.body.raw);
    assert.equal(await readFile(join(migrateRoot, '.pm/core/work-items', `${task.body.id}.md`), 'utf8'), task.body.raw);
    await assert.rejects(lstat(join(f.coreRoot, f.workspaceId, 'projects', `${project.id}.md`)), { code: 'ENOENT' });
    assert.deepEqual(await download(f, historical.artifactVersion.id), png);
    assert.deepEqual(await download(f, latest.artifactVersion.id), Buffer.from('Newer immutable version'));
    assert.deepEqual((await f.request(`${movePath}/migrate`, { method: 'POST', headers: { 'Idempotency-Key': migrateKey }, body: { directory: { mode: 'existing', path: migrateRoot }, writersStopped: true } })).body, migrated.body);
    const relocatedRoot = join(f.parents[1], 'relocated-code'); await mkdir(relocatedRoot);
    await writeFile(join(relocatedRoot, 'source.bin'), Buffer.from([9, 8, 7, 0]));
    const relocationKey = randomUUID();
    const relocated = await f.request<LocalProjectAttempt>(`${movePath}/relocate`, { method: 'POST', headers: { 'Idempotency-Key': relocationKey }, body: { mode: 'move', directory: { mode: 'existing', path: relocatedRoot }, writersStopped: true } });
    assert.equal(relocated.status, 200, JSON.stringify(relocated.body)); assert.equal(relocated.body.status, 'ready');
    const after = await f.request<FileRecord>(`${prefix}/core/files/${project.id}`);
    assert.equal(after.status, 200); assert.equal(after.body.id, project.id); assert.equal(after.body.revision, original.body.revision); assert.equal(after.body.raw, original.body.raw);
    assert.equal(await readFile(join(relocatedRoot, '.pm/core/work-items', `${task.body.id}.md`), 'utf8'), task.body.raw);
    await assert.rejects(lstat(join(migrateRoot, '.pm/core/projects', `${project.id}.md`)), { code: 'ENOENT' });
    assert.deepEqual(await readFile(join(migrateRoot, 'README.md')), userBytes);
    assert.deepEqual(await readFile(join(relocatedRoot, 'source.bin')), Buffer.from([9, 8, 7, 0]));
    assert.deepEqual((await f.pool.query('SELECT id,data,version FROM entities WHERE id=ANY($1::uuid[]) ORDER BY id', [[historical.artifactVersion.id, latest.artifactVersion.id]])).rows, historyBefore, 'Migration routes immutable history instead of rewriting version object keys/storage IDs');
    const auditAfter = (await f.pool.query('SELECT command_id,dedupe_key,changes FROM project_audit WHERE project_id=$1 ORDER BY id', [project.id])).rows;
    for (const row of auditBefore) assert.ok(auditAfter.some(current => JSON.stringify(current) === JSON.stringify(row)));
    await f.restartApi();
    assert.deepEqual(await download(f, historical.artifactVersion.id), png);
    const extras = await f.request<{ projects: { projectId: string; cover: Entity | null }[] }>(`${prefix}/projects/extras`);
    assert.equal(extras.body.projects.find(row => row.projectId === project.id)?.cover?.id, cover.id);
    const target = await initialize(f, 'Independent copy target', { mode: 'new', parentPath: f.parents[0], folderName: 'copy-target' });
    const targetEntity = (await f.request<Entity>(`${prefix}/entities/${target.record.id}`)).body;
    const copied = await f.command<Delivery>('CopyArtifactVersion', { targetTitle: 'Historical project-scoped copy', targetKind: 'image' }, { projectId: target.record.id, targetId: historical.artifactVersion.id, expectedVersions: { [latest.artifact.id]: latest.artifact.version, [historical.artifactVersion.id]: historical.artifactVersion.version, [targetEntity.id]: targetEntity.version } });
    assert.notEqual(copied.artifactVersion.id, historical.artifactVersion.id);
    assert.notEqual(copied.artifactVersion.data.storageId, historical.artifactVersion.data.storageId);
    assert.equal(copied.artifactVersion.data.storageId, target.location.storageId);
    assert.deepEqual(await download(f, copied.artifactVersion.id), png);
  });

  it('LP-A07: explicitly rebinds an externally renamed matching root, rejects a clone while the original exists, and never recreates the missing source', async t => {
    const f = await createLocalProjectFixture(); t.after(() => f.close());
    const project = await initialize(f, 'Externally moved project', { mode: 'new', parentPath: f.parents[0], folderName: 'before-external-move' });
    const originalRoot = project.location.path!, prefix = `/api/v1/workspaces/${f.workspaceId}`;
    const task = await f.request<FileRecord>(`${prefix}/core/entities`, { method: 'POST', headers: { 'Idempotency-Key': randomUUID() }, body: { entity: 'work_item', project: project.record.id, title: 'Task survives an OS folder move' } });
    assert.equal(task.status, 200);
    const artifact = await upload(f, project.record.id, Buffer.from('External-move historical bytes'));
    const marker = await readFile(join(originalRoot, '.pm/project.json'));
    const clone = join(f.parents[1], 'clone-while-original-exists');
    await f.stopServices(); await cp(originalRoot, clone, { recursive: true, errorOnExist: true, force: false }); await f.restartApi();
    const relocate = `${prefix}/local-projects/projects/${project.record.id}/relocate`;
    const cloneAttempt = await f.request(relocate, { method: 'POST', headers: { 'Idempotency-Key': randomUUID() }, body: { mode: 'rebind', directory: { mode: 'existing', path: clone }, writersStopped: true } });
    assert.ok(cloneAttempt.status >= 400, 'A matching cloned marker is insufficient while the registered source still exists');
    assert.deepEqual(await readFile(join(originalRoot, '.pm/project.json')), marker);
    const movedRoot = join(f.parents[1], 'after-external-move');
    await f.stopServices(); await rename(originalRoot, movedRoot); await f.restartApi();
    const missing = await f.request<LocalProjectLocation>(`${prefix}/local-projects/projects/${project.record.id}/location`);
    assert.equal(missing.status, 200); assert.equal(missing.body.status, 'unavailable');
    await assert.rejects(lstat(originalRoot), { code: 'ENOENT' });
    const key = randomUUID();
    const rebound = await f.request<LocalProjectAttempt>(relocate, { method: 'POST', headers: { 'Idempotency-Key': key }, body: { mode: 'rebind', directory: { mode: 'existing', path: movedRoot }, writersStopped: true } });
    assert.equal(rebound.status, 200, JSON.stringify(rebound.body)); assert.equal(rebound.body.status, 'ready');
    if (rebound.body.status !== 'ready') throw new Error('Externally moved project did not rebind');
    assert.equal(rebound.body.location.path, movedRoot); assert.equal(rebound.body.location.storageId, project.location.storageId);
    const restoredTask = await f.request<FileRecord>(`${prefix}/core/files/${task.body.id}`);
    assert.equal(restoredTask.status, 200); assert.equal(restoredTask.body.revision, task.body.revision); assert.equal(restoredTask.body.raw, task.body.raw);
    assert.deepEqual(await download(f, artifact.artifactVersion.id), Buffer.from('External-move historical bytes'));
    assert.deepEqual(await readFile(join(movedRoot, '.pm/project.json')), marker);
    await assert.rejects(lstat(originalRoot), { code: 'ENOENT' });
    assert.deepEqual((await f.request(relocate, { method: 'POST', headers: { 'Idempotency-Key': key }, body: { mode: 'rebind', directory: { mode: 'existing', path: movedRoot }, writersStopped: true } })).body, rebound.body);
    const updated = await f.request<FileRecord>(`${prefix}/core/entities/${task.body.id}`, { method: 'PATCH', body: { revision: task.body.revision, changes: { due: '2026-11-01' } } });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(await readFile(join(movedRoot, '.pm/core/work-items', `${task.body.id}.md`), 'utf8'), updated.body.raw);
  });

  it('LP-A05: missing workspace authority state fails closed without creating replacement IDs or journals', async t => {
    const f = await createLocalProjectFixture(); t.after(() => f.close());
    const project = await initialize(f, 'Workspace authority must survive', { mode: 'new', parentPath: f.parents[0], folderName: 'retained-project' });
    const prefix = `/api/v1/workspaces/${f.workspaceId}`;
    const state = join(f.coreRoot, f.workspaceId, '.pm/state'), offlineState = `${state}.owned-offline`;
    const frozenState = await readFile(join(state, 'state.json'));
    const frozenProject = await readFile(join(project.location.path!, '.pm/core/projects', `${project.record.id}.md`));
    await f.stopServices(); await rename(state, offlineState); await f.restartApi();
    const missing = await f.request(`${prefix}/core/workspace`);
    assert.equal(missing.status, 503, JSON.stringify(missing.body));
    const initialization = await f.request(`${prefix}/local-projects/initializations/${project.key}`);
    assert.equal(initialization.status, 503, JSON.stringify(initialization.body));
    await assert.rejects(lstat(state), { code: 'ENOENT' });
    assert.deepEqual(await readFile(join(offlineState, 'state.json')), frozenState);
    assert.deepEqual(await readFile(join(project.location.path!, '.pm/core/projects', `${project.record.id}.md`)), frozenProject);
    await f.stopServices(); await rename(offlineState, state); await f.restartApi();
    const recovered = await f.request<LocalProjectAttempt>(`${prefix}/local-projects/initializations/${project.key}/recover`, { method: 'POST', body: {} });
    assert.equal(recovered.status, 200); assert.equal(recovered.body.status, 'ready');
    if (recovered.body.status !== 'ready') throw new Error('Restored original workspace state did not recover');
    assert.equal(recovered.body.record.id, project.record.id); assert.equal(recovered.body.record.revision, project.record.revision);
    assert.deepEqual(await readFile(join(state, 'state.json')), frozenState);
  });
});
