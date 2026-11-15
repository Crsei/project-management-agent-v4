import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, rename, readFile, writeFile, cp, lstat, symlink, link, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace } from '../../pm-core/index.ts';
import { readProjectLocation } from '../../pm-core/project-locations.ts';
import { createPool, migrate } from '../src/database.ts';
import { createUser, createWorkspace } from '../src/auth.ts';
import { LocalBlobStore } from '../src/blobs.ts';
import { bindBlobStore } from '../src/blob-storage-binding.ts';
import { bindStorage } from '../src/blob-storage-maintenance.ts';
import { checkProjectBlobStorage, createProjectBlobStore, initializeProjectBlobStorage } from '../src/project-blobs.ts';
import { exportLocalProjectCheckpoint, restoreLocalProjectCheckpoint } from '../src/project-storage-checkpoint.ts';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
test('project facade keeps independent physical roots and refuses missing, replaced and cross-project storage', { skip: !databaseUrl }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pm-project-blobs-')));
  const schema = `test_project_blob_${randomUUID().replaceAll('-', '')}`;
  const admin = createPool(databaseUrl!);
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(databaseUrl!); url.searchParams.set('options', `-c search_path=${schema},public`);
  const pool = createPool(url.toString());
  const coreRoot = join(root, 'core');
  let workspace: Workspace | undefined;
  t.after(async () => { await workspace?.close(); await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); await rm(root, { recursive: true, force: true }); });
  await migrate(pool);
  const actor = await createUser(pool, { email: `${randomUUID()}@project-blob.example.test`, name: 'Storage boundary', password: 'isolated-project-blob-password' });
  const owner = await createWorkspace(pool, actor.id, 'Storage routing');
  workspace = new Workspace(join(coreRoot, owner.id)); await workspace.init();
  const legacyRoot = join(root, 'legacy'); const legacy = new LocalBlobStore(legacyRoot);
  const locator = { provider: 'local' as const, root: legacyRoot };
  await bindStorage({ pool, provider: legacy, locator, mode: 'new', stopped: true });
  const guarded = bindBlobStore(pool, locator, legacy);
  const first = await workspace.createEntity({ entity: 'project', title: 'First storage' });
  const second = await workspace.createEntity({ entity: 'project', title: 'Second storage' });
  const firstRoot = join(root, 'first'); const secondRoot = join(root, 'second'); await mkdir(firstRoot); await mkdir(secondRoot);
  const a = await workspace.migrateProject(first.id, randomUUID(), { workspaceId: owner.id, root: firstRoot });
  const b = await workspace.migrateProject(second.id, randomUUID(), { workspaceId: owner.id, root: secondRoot });
  await initializeProjectBlobStorage(pool, a); await initializeProjectBlobStorage(pool, b);
  const options = { sql: pool, legacy: guarded, resolveProject: (workspaceId: string, projectId: string) => readProjectLocation(join(coreRoot, workspaceId), projectId) };
  const facade = createProjectBlobStore(options);
  const scopeA = { workspaceId: owner.id, projectId: first.id }; const scopeB = { workspaceId: owner.id, projectId: second.id };
  const savedA = await facade.put(Buffer.from('first actual bytes'), scopeA);
  const savedB = await facade.put(Buffer.from('second actual bytes'), scopeB);
  assert.equal(savedA.storageId, a.storageId); assert.equal(savedB.storageId, b.storageId); assert.notEqual(savedA.storageId, savedB.storageId);
  assert.deepEqual(await readFile(join(a.attachmentsPath, savedA.key)), Buffer.from('first actual bytes'));
  await assert.rejects(lstat(join(legacyRoot, savedA.key)), { code: 'ENOENT' });
  await assert.rejects(facade.read(savedA.key, { ...scopeB, storageId: savedA.storageId! }));
  await assert.rejects(facade.read(savedA.key), { code: 'blob_scope_required' });
  const restarted = createProjectBlobStore(options);
  assert.deepEqual(await restarted.read(savedA.key, { ...scopeA, storageId: savedA.storageId! }), Buffer.from('first actual bytes'));
  await workspace.close(); workspace = undefined;
  await rename(firstRoot, `${firstRoot}-offline`);
  await assert.rejects(restarted.put(Buffer.from('must not create a replacement root'), scopeA));
  await assert.rejects(lstat(firstRoot), { code: 'ENOENT' });
  await symlink(`${firstRoot}-offline`, firstRoot, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(restarted.read(savedA.key, { ...scopeA, storageId: savedA.storageId! }));
  await unlink(firstRoot); await rename(`${firstRoot}-offline`, firstRoot);
  const extraLink = join(root, 'external-hardlink'); await link(join(a.attachmentsPath, savedA.key), extraLink);
  await assert.rejects(restarted.read(savedA.key, { ...scopeA, storageId: savedA.storageId! }), { code: 'blob_integrity_error' });
  await unlink(extraLink);
  assert.deepEqual(await restarted.read(savedB.key, { ...scopeB, storageId: savedB.storageId! }), Buffer.from('second actual bytes'));
  await checkProjectBlobStorage(pool, b);
  await pool.query("UPDATE project_blob_stores SET state='migrating' WHERE storage_id=$1", [b.storageId]);
  await assert.rejects(checkProjectBlobStorage(pool, b), { code: 'blob_storage_binding_mismatch' });
  await pool.query("UPDATE project_blob_stores SET state='active' WHERE storage_id=$1", [b.storageId]);
  await unlink(join(b.attachmentsPath, '.pm-store.json'));
  await assert.rejects(checkProjectBlobStorage(pool, b), { code: 'blob_storage_binding_mismatch' });
  await assert.rejects(lstat(join(b.attachmentsPath, '.pm-store.json')), { code: 'ENOENT' });
});

for (const layout of ['legacy', 'dovspace-v1'] as const) {
  test(`multi-root recovery reconciles only exact restored identities and preserves bytes (${layout})`, async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'pm-project-checkpoint-')));
    const sourceCore = join(root, 'source-core'); const workspaceId = randomUUID();
    const workspace = new Workspace(join(sourceCore, workspaceId));
    t.after(async () => { await workspace.close(); await rm(root, { recursive: true, force: true }); });
    await workspace.init();
    const first = await workspace.createEntity({ entity: 'project', title: 'Checkpoint project', body: 'Original **Markdown** remains authoritative.' });
    const projectRoot = join(root, 'source-project'); await mkdir(projectRoot);
    const mount = await workspace.migrateProject(first.id, randomUUID(), { workspaceId, root: projectRoot, layout });
    const bytes = Buffer.from([0, 255, 32, 10, 4]);
    const saved = await new LocalBlobStore(mount.attachmentsPath).put(bytes);
    await workspace.close();
    const backupDirectory = join(root, 'archive');
    const backup = await exportLocalProjectCheckpoint({ coreRoot: sourceCore, directory: backupDirectory, stopped: true });
    assert.equal(backup.manifest.projects.length, 1);
    const otherDirectory = join(root, 'other-archive');
    await writeFile(join(mount.corePath, first.path), first.raw.replace('Original **Markdown**', 'Another **checkpoint**'));
    const otherBackup = await exportLocalProjectCheckpoint({ coreRoot: sourceCore, directory: otherDirectory, stopped: true });
    await rename(sourceCore, `${sourceCore}-offline`); await rename(projectRoot, `${projectRoot}-offline`);
    const targetCoreRoot = join(root, 'restored-core'); const targetProjectsRoot = join(root, 'restored-projects');
    const options = { directory: backupDirectory, manifest: backup.manifest, expectedManifestSha256: backup.manifestSha256, targetCoreRoot, targetProjectsRoot, stopped: true };
    const restored = await restoreLocalProjectCheckpoint(options);
    assert.equal(restored.projects[0]!.storageId, mount.storageId);
    const restoredMount = readProjectLocation(join(targetCoreRoot, workspaceId), first.id)!;
    assert.notEqual(restoredMount.root, mount.root);
    assert.deepEqual(await new LocalBlobStore(restoredMount.attachmentsPath).read(saved.key), bytes);
    const registryPath = join(targetCoreRoot, workspaceId, '.pm/state/project-locations.json');
    const registryBytes = await readFile(registryPath);
    const reconciled = await restoreLocalProjectCheckpoint(options);
    assert.deepEqual(reconciled, restored, 'Exact restored identities reconcile without returning to source paths');
    assert.deepEqual(await readFile(registryPath), registryBytes);
    assert.deepEqual(await new LocalBlobStore(restoredMount.attachmentsPath).read(saved.key), bytes);
    assert.equal(await readFile(join(restoredMount.corePath, first.path), 'utf8'), first.raw);

    await assert.rejects(restoreLocalProjectCheckpoint({ ...options, stopped: false }), { code: 'blob_maintenance_requires_stop' });
    await assert.rejects(restoreLocalProjectCheckpoint({ ...options, expectedManifestSha256: '0'.repeat(64) }), { code: 'blob_backup_set_mismatch' });
    const alternateProjectsRoot = join(root, 'different-target');
    await assert.rejects(restoreLocalProjectCheckpoint({ ...options, targetProjectsRoot: alternateProjectsRoot }), { code: 'blob_checkpoint_mismatch' });
    await assert.rejects(lstat(alternateProjectsRoot), { code: 'ENOENT' });
    await assert.rejects(restoreLocalProjectCheckpoint({ ...options, directory: otherDirectory, manifest: otherBackup.manifest, expectedManifestSha256: otherBackup.manifestSha256 }), { code: 'blob_checkpoint_mismatch' });
    assert.deepEqual(await readFile(registryPath), registryBytes);
    assert.equal(await readFile(join(restoredMount.corePath, first.path), 'utf8'), first.raw);

    for (const field of ['identity', ...(layout === 'dovspace-v1' ? ['storageIdentity'] : []), 'initialization', 'root']) {
      const changed = JSON.parse(registryBytes.toString('utf8'));
      if (field === 'initialization') changed.entries[0].initialization.hash = 'f'.repeat(64);
      else if (field === 'root') changed.entries[0].root = projectRoot;
      else changed.entries[0][field].inode = `${changed.entries[0][field].inode}0`;
      const changedBytes = Buffer.from(JSON.stringify(changed));
      await writeFile(registryPath, changedBytes);
      try {
        await assert.rejects(restoreLocalProjectCheckpoint(options), { code: 'blob_checkpoint_mismatch' });
        assert.deepEqual(await readFile(registryPath), changedBytes, 'Rejected identity or state edits are not overwritten');
      } finally { await writeFile(registryPath, registryBytes); }
    }

    const targetDirectories = [restoredMount.root, ...(layout === 'dovspace-v1' ? [restoredMount.storageRoot] : [])];
    for (const [index, directory] of targetDirectories.entries()) {
      const detached = join(root, `detached-target-${index}`);
      await rename(directory, detached);
      try {
        await cp(detached, directory, { recursive: true });
        await assert.rejects(restoreLocalProjectCheckpoint(options), { code: 'blob_checkpoint_mismatch' });
        assert.deepEqual(await readFile(registryPath), registryBytes, 'Byte-identical replacement directories do not acquire the registered identity');
      } finally { await rm(directory, { recursive: true, force: true }); await rename(detached, directory); }
    }

    for (const path of [join(restoredMount.attachmentsPath, saved.key), join(restoredMount.corePath, first.path)]) {
      const originalBytes = await readFile(path), changedBytes = Buffer.from('User data changed after recovery');
      await writeFile(path, changedBytes);
      try {
        await assert.rejects(restoreLocalProjectCheckpoint(options), { code: 'blob_checkpoint_mismatch' });
        assert.deepEqual(await readFile(path), changedBytes, 'Restore never overwrites changed user bytes');
      } finally { await writeFile(path, originalBytes); }
    }

    const archivedRegistryPath = join(backupDirectory, 'core', workspaceId, '.pm/state/project-locations.json');
    const archivedRegistryBytes = await readFile(archivedRegistryPath);
    const changedArchive = JSON.parse(archivedRegistryBytes.toString('utf8')), changedTarget = JSON.parse(registryBytes.toString('utf8'));
    changedArchive.entries[0].initialization.hash = changedTarget.entries[0].initialization.hash = 'f'.repeat(64);
    const changedTargetBytes = Buffer.from(JSON.stringify(changedTarget));
    await writeFile(archivedRegistryPath, JSON.stringify(changedArchive)); await writeFile(registryPath, changedTargetBytes);
    try {
      await assert.rejects(restoreLocalProjectCheckpoint(options), { code: 'blob_checkpoint_changed' });
      assert.deepEqual(await readFile(registryPath), changedTargetBytes, 'Matching forged registries cannot replace the manifest-authenticated checkpoint');
    } finally { await writeFile(archivedRegistryPath, archivedRegistryBytes); await writeFile(registryPath, registryBytes); }

    assert.deepEqual(await restoreLocalProjectCheckpoint(options), restored);
    assert.deepEqual(await new LocalBlobStore(restoredMount.attachmentsPath).read(saved.key), bytes);
    const targetWorkspace = new Workspace(join(targetCoreRoot, workspaceId));
    try { await targetWorkspace.init(); assert.equal(targetWorkspace.get(first.id).raw, first.raw); }
    finally { await targetWorkspace.close(); }
    await assert.rejects(lstat(sourceCore), { code: 'ENOENT' }); await assert.rejects(lstat(projectRoot), { code: 'ENOENT' });
  });
}
