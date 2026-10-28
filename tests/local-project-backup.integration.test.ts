import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { it } from 'node:test';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { buildApp } from '../apps/api/src/app.ts';
import type { LocalProjectAttempt } from '../packages/contracts/src/local-projects.ts';
import type { Command, CommandReceipt, Entity } from '../packages/domain/src/core.ts';
import type { FileRecord } from '../packages/pm-schema/index.ts';
import { readProjectLocation } from '../packages/pm-core/project-locations.ts';
import { LocalBlobStore } from '../packages/infrastructure/src/blobs.ts';
import { bindBlobStore, readStorageBinding } from '../packages/infrastructure/src/blob-storage-binding.ts';
import { exportBlobBackup } from '../packages/infrastructure/src/blob-storage-backup.ts';
import { hashCheckpointFile } from '../packages/infrastructure/src/blob-storage-checkpoint.ts';
import { createPool } from '../packages/infrastructure/src/database.ts';
import { readStoredBlob } from '../packages/infrastructure/src/project-blobs.ts';
import { exportLocalProjectCheckpoint } from '../packages/infrastructure/src/project-storage-checkpoint.ts';
import { createLocalProjectFixture, localProjectChildEnvironment } from './local-project-fixture.ts';

const exec = promisify(execFile);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=', 'base64');
type Delivery = { artifact: Entity; artifactVersion: Entity };

/** Passwords go to the owned PostgreSQL client environment, never argv/stdout. */
function postgresEnvironment(databaseUrl: string): NodeJS.ProcessEnv {
  const url = new URL(databaseUrl);
  return localProjectChildEnvironment({
    PGHOST: url.hostname, PGPORT: url.port || '5432', PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGOPTIONS: url.searchParams.get('options') ?? '', PGAPPNAME: 'local-project-acceptance-backup',
    ...(url.searchParams.has('sslmode') ? { PGSSLMODE: url.searchParams.get('sslmode')! } : {}),
  });
}

it('LP-A08: stopped real SQL/core/project/blob backup restores into entirely new roots, with source roots hidden and historical references intact', { timeout: 300_000 }, async t => {
  const f = await createLocalProjectFixture({ signal: t.signal });
  const restoreDatabase = `test_local_restore_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(f.databaseUrl); adminUrl.searchParams.delete('options');
  const admin = createPool(adminUrl.toString());
  let restoredPool: Pool | undefined;
  let app: FastifyInstance | undefined;
  let createdDatabase = false;
  try {
    const prefix = `/api/v1/workspaces/${f.workspaceId}`;
    const projects: Extract<LocalProjectAttempt, { status: 'ready' }>[] = [];
    for (const [index, parentPath] of f.parents.entries()) {
      const response = await f.request<LocalProjectAttempt>(`${prefix}/local-projects/initializations`, { method: 'POST', headers: { 'Idempotency-Key': randomUUID() }, body: { input: { entity: 'project', title: `Backup physical project ${index + 1}` }, directory: { mode: 'new', parentPath, folderName: `backup-${index + 1}` } } });
      assert.equal(response.status, 200, JSON.stringify(response.body)); assert.equal(response.body.status, 'ready');
      if (response.body.status !== 'ready') throw new Error('Backup project did not become ready');
      projects.push(response.body);
    }
    const a = projects[0]!, b = projects[1]!;
    const task = await f.request<FileRecord>(`${prefix}/core/entities`, { method: 'POST', headers: { 'Idempotency-Key': randomUUID() }, body: { entity: 'work_item', project: a.record.id, title: 'Keep stable backup task', body: 'Immutable backup source body', due: '2026-10-30' } });
    assert.equal(task.status, 200);
    const document = await f.request<FileRecord>(`${prefix}/core/entities`, { method: 'POST', headers: { 'Idempotency-Key': randomUUID() }, body: { entity: 'document', project: b.record.id, title: 'Keep linked document', body: `Reference [[${task.body.id}]] and [[${a.record.id}]].` } });
    assert.equal(document.status, 200);
    const staged = await f.command<{ upload: Entity }>('StageUpload', { contentBase64: png.toString('base64'), fileName: 'original.png', mediaType: 'image/png' }, { projectId: a.record.id });
    const original = await f.command<Delivery>('RegisterArtifact', { title: 'Historical image', kind: 'image', uploadId: staged.upload.id }, { projectId: a.record.id, expectedVersions: { [staged.upload.id]: staged.upload.version } });
    const newerBytes = Buffer.from('Current version must not replace the historical image reference');
    const newer = await f.command<{ upload: Entity }>('StageUpload', { contentBase64: newerBytes.toString('base64'), fileName: 'current.txt', mediaType: 'text/plain' }, { projectId: a.record.id });
    const latest = await f.command<Delivery>('AddArtifactVersion', { uploadId: newer.upload.id }, { projectId: a.record.id, targetId: original.artifact.id, expectedVersions: { [original.artifact.id]: original.artifact.version, [newer.upload.id]: newer.upload.version } });
    const projectEntityA = (await f.request<Entity>(`${prefix}/entities/${a.record.id}`)).body;
    const projectEntityB = (await f.request<Entity>(`${prefix}/entities/${b.record.id}`)).body;
    const cover = await f.command<Entity>('SetProjectCover', { artifactVersionId: original.artifactVersion.id }, { projectId: a.record.id, targetId: a.record.id, expectedVersions: { [a.record.id]: projectEntityA.version } });
    const copied = await f.command<Delivery>('CopyArtifactVersion', { targetTitle: 'Independent other-project image', targetKind: 'image' }, { projectId: b.record.id, targetId: original.artifactVersion.id, expectedVersions: { [latest.artifact.id]: latest.artifact.version, [original.artifactVersion.id]: original.artifactVersion.version, [b.record.id]: projectEntityB.version } });
    assert.equal(copied.artifactVersion.data.storageId, b.location.storageId);
    const sqlBefore = (await f.pool.query('SELECT id,data,version FROM entities ORDER BY id')).rows;
    const auditBefore = (await f.pool.query('SELECT project_id,command_id,dedupe_key,changes FROM project_audit ORDER BY id')).rows;
    await f.startWorker();
    await f.stopServices(); // Only owned PIDs; source SQL remains a stopped immutable view.
    const backupDirectory = join(f.root, 'backup-set'); await mkdir(backupDirectory);
    const dump = join(backupDirectory, 'database.dump');
    try {
      await exec(process.env.PM_TEST_PG_DUMP ?? 'pg_dump', ['--format=custom', `--schema=${f.schema}`, '--no-owner', '--no-privileges', `--file=${dump}`], { env: postgresEnvironment(f.databaseUrl), timeout: 60_000 });
    } catch { throw new Error('Real pg_dump failed; install matching PostgreSQL clients and provide a reachable isolated-test connection'); }
    const databaseDumpSha256 = (await hashCheckpointFile(dump)).sha256;
    const core = await exportLocalProjectCheckpoint({ coreRoot: f.coreRoot, directory: join(backupDirectory, 'files'), stopped: true });
    assert.equal(core.manifest.projects.length, 2);
    await admin.query(`CREATE DATABASE ${restoreDatabase}`); createdDatabase = true;
    const restoredUrl = new URL(f.databaseUrl); restoredUrl.pathname = `/${restoreDatabase}`;
    try {
      await exec(process.env.PM_TEST_PG_RESTORE ?? 'pg_restore', ['--dbname', restoreDatabase, '--exit-on-error', '--no-owner', '--no-privileges', dump], { env: postgresEnvironment(restoredUrl.toString()), timeout: 60_000 });
    } catch { throw new Error('Real pg_restore into the owned random database failed; PostgreSQL client compatibility and CREATEDB permission are required'); }
    restoredPool = createPool(restoredUrl.toString());
    assert.deepEqual((await restoredPool.query('SELECT id,data,version FROM entities ORDER BY id')).rows, sqlBefore);
    // Inventory comes from the exact restored dump, not a later source SQL view.
    const inventoryPool = restoredPool;
    const sourceLocator = { provider: 'local' as const, root: f.blobRoot };
    const sourceProvider = new LocalBlobStore(f.blobRoot);
    const source = bindBlobStore(inventoryPool, sourceLocator, sourceProvider);
    const blobBackup = await exportBlobBackup({ pool: inventoryPool, source: { provider: sourceProvider, locator: sourceLocator }, directory: join(backupDirectory, 'blobs'), databaseDumpSha256, coreManifestSha256: core.manifestSha256, stopped: true, readObject: entry => readStoredBlob({ sql: inventoryPool, legacy: source, resolveProject: (workspaceId, projectId) => readProjectLocation(join(f.coreRoot, workspaceId), projectId) }, entry) });
    assert.ok(blobBackup.manifest.entries.length >= 3);
    // Source core, both external parents and legacy blob roots disappear BEFORE
    // restore opens its first workspace. Any absolute-path dependency now fails.
    for (const path of [f.coreRoot, f.blobRoot, ...f.parents]) await rename(path, `${path}.owned-source-offline`);
    const target = join(f.root, 'restored'); await mkdir(target);
    const restoredCore = join(target, 'core'), restoredProjects = join(target, 'projects'), restoredBlobRoot = join(target, 'blobs');
    const binding = await readStorageBinding(restoredPool); assert.ok(binding);
    const targetProvider = new LocalBlobStore(restoredBlobRoot), targetLocator = { provider: 'local' as const, root: restoredBlobRoot };
    await writeFile(join(backupDirectory, 'manifest.json'), JSON.stringify({
      formatVersion: 3, databaseDumpSha256, coreManifestSha256: core.manifestSha256, blobManifestSha256: blobBackup.manifestSha256,
      sourceBinding: { storeId: binding.storeId, epoch: binding.epoch },
    }), { mode: 0o600 });
    const restored = await exec(process.execPath, [
      'scripts/local-project-storage.ts', 'restore', '--stopped', '--restored-target', '--operation-id', randomUUID(),
      '--backup-directory', backupDirectory, '--target-core-root', restoredCore, '--target-projects-root', restoredProjects,
      '--target-blob-root', restoredBlobRoot, '--target-store-id', randomUUID(), '--expected-epoch', binding.epoch,
    ], { env: localProjectChildEnvironment({ DATABASE_URL: restoredUrl.toString() }), timeout: 60_000 });
    z.object({ state: z.literal('completed'), projectRoots: z.literal(2), productionCredentialPolicyApproved: z.literal(false) }).parse(JSON.parse(restored.stdout));
    app = buildApp({ databaseUrl: restoredUrl.toString(), blobStore: targetProvider, blobStorageLocator: targetLocator, coreWorkspaceRoot: restoredCore, localProjects: { enabled: true, dataRoot: target, defaultParent: restoredProjects, allowedRoots: [restoredProjects], backupRoot: join(target, 'backups') } });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    assert.equal((await fetch(`${origin}/api/v1/auth/me`, { headers: { cookie: f.ownerCookie } })).status, 401, 'Restore fences source sessions; credentials must authenticate again');
    const restoredCookie = await f.authenticateAt(origin);
    async function restoredRead<T>(path: string): Promise<T> {
      const response = await fetch(`${origin}${path}`, { headers: { cookie: restoredCookie }, signal: AbortSignal.timeout(20_000) });
      assert.equal(response.status, 200); return await response.json() as T;
    }
    async function restoredCommand<T>(command: Command): Promise<T> {
      const response = await fetch(`${origin}${prefix}/commands`, { method: 'POST', headers: { cookie: restoredCookie, 'content-type': 'application/json' }, body: JSON.stringify(command), signal: AbortSignal.timeout(30_000) });
      assert.equal(response.status, 200);
      const receipt = await response.json() as CommandReceipt;
      assert.equal(receipt.status, 'committed', JSON.stringify(receipt));
      return receipt.result as T;
    }
    for (const expected of [a.record, b.record, task.body, document.body]) {
      const actual = await restoredRead<FileRecord>(`${prefix}/core/files/${expected.id}`);
      assert.equal(actual.id, expected.id); assert.equal(actual.revision, expected.revision); assert.equal(actual.raw, expected.raw);
    }
    for (const [version, expected] of [[original.artifactVersion, png], [latest.artifactVersion, newerBytes], [copied.artifactVersion, png]] as const) {
      const response = await fetch(`${origin}${prefix}/artifact-versions/${version.id}/content`, { headers: { cookie: restoredCookie }, signal: AbortSignal.timeout(20_000) });
      assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
      const anonymous = await fetch(`${origin}${prefix}/artifact-versions/${version.id}/content`); assert.equal(anonymous.status, 401);
    }
    const extras = await restoredRead<{ projects: { projectId: string; cover: Entity | null }[] }>(`${prefix}/projects/extras`);
    assert.equal(extras.projects.find(row => row.projectId === a.record.id)?.cover?.id, cover.id);
    // Exercise the separate cover command's real byte-validation reader as well
    // as download routing; merely reading persisted cover metadata is insufficient.
    const coverCommand: Command = { commandId: randomUUID(), commandType: 'SetProjectCover', projectId: a.record.id, targetId: a.record.id, expectedVersions: { [a.record.id]: projectEntityA.version, [cover.id]: cover.version }, payload: { artifactVersionId: original.artifactVersion.id } };
    await restoredCommand<Entity>(coverCommand);
    for (const project of core.manifest.projects) {
      const mount = readProjectLocation(join(restoredCore, project.workspaceId), project.projectId);
      assert.ok(mount);
      assert.ok(mount.root.startsWith(restoredProjects + '/')); assert.equal(mount.storageId, project.storageId);
      assert.equal(await readFile(join(mount.root, '.pm/core/projects', `${project.projectId}.md`), 'utf8'), projects.find(item => item.record.id === project.projectId)!.record.raw);
    }
    assert.deepEqual((await restoredPool.query('SELECT id,data,version FROM entities ORDER BY id')).rows, sqlBefore);
    const auditAfter = (await restoredPool.query('SELECT project_id,command_id,dedupe_key,changes FROM project_audit ORDER BY id')).rows;
    for (const row of auditBefore) assert.ok(auditAfter.some(actual => JSON.stringify(actual) === JSON.stringify(row)));
    const restoredBytes = Buffer.from('New immutable bytes written after restoration into entirely new roots');
    const restoredUpload = await restoredCommand<{ upload: Entity }>({ commandId: randomUUID(), commandType: 'StageUpload', projectId: a.record.id, payload: { contentBase64: restoredBytes.toString('base64'), fileName: 'after-restore.txt', mediaType: 'text/plain' } });
    const restoredArtifact = await restoredCommand<Delivery>({ commandId: randomUUID(), commandType: 'RegisterArtifact', projectId: a.record.id, expectedVersions: { [restoredUpload.upload.id]: restoredUpload.upload.version }, payload: { title: 'After independent restore', kind: 'document', uploadId: restoredUpload.upload.id } });
    assert.equal(restoredArtifact.artifactVersion.data.storageId, a.location.storageId);
    const restoredMount = readProjectLocation(join(restoredCore, f.workspaceId), a.record.id)!;
    const objectKey = restoredArtifact.artifactVersion.data.objectKey;
    assert.equal(typeof objectKey, 'string');
    assert.deepEqual(await readFile(join(restoredMount.root, '.pm/attachments', objectKey as string)), restoredBytes);
    const restoredDownload = await fetch(`${origin}${prefix}/artifact-versions/${restoredArtifact.artifactVersion.id}/content`, { headers: { cookie: restoredCookie } });
    assert.equal(restoredDownload.status, 200); assert.deepEqual(Buffer.from(await restoredDownload.arrayBuffer()), restoredBytes);
    for (const path of [f.coreRoot, f.blobRoot, ...f.parents]) await assert.rejects(lstat(path), { code: 'ENOENT' });
  } finally {
    try { await app?.close(); }
    finally {
      try { await restoredPool?.end(); }
      finally {
        try { if (createdDatabase) await admin.query(`DROP DATABASE ${restoreDatabase}`); }
        finally { await admin.end(); await f.close(); }
      }
    }
  }
});
