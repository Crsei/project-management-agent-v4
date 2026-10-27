import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { createPool, migrate } from '../src/database.ts';
import { createUser, createWorkspace, login, authenticate } from '../src/auth.ts';
import { LocalBlobStore } from '../src/blobs.ts';
import { bindBlobStore, readStorageBinding } from '../src/blob-storage-binding.ts';
import { bindStorage, collectBlobInventory, createMigrationManifest, migrateStorage, verifyStorageMigration, activateStorage, resumeSourceStorage, migrationManifestSha256, type StorageEndpoint } from '../src/blob-storage-maintenance.ts';
import { exportBlobBackup, verifyBlobBackup, restoreBlobBackup } from '../src/blob-storage-backup.ts';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
async function fixture(t: test.TestContext) {
  const admin = createPool(databaseUrl!);
  const root = await mkdtemp(join(tmpdir(), 'pm-storage-binding-'));
  const schemas: string[] = []; const pools: Pool[] = [];
  t.after(async () => { for (const pool of pools) await pool.end(); for (const schema of schemas) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); await rm(root, { recursive: true, force: true }); });
  async function database() {
    const name = `test_blob_binding_${randomUUID().replaceAll('-', '')}`; schemas.push(name);
    await admin.query(`CREATE SCHEMA "${name}"`);
    const url = new URL(databaseUrl!); url.searchParams.set('options', `-c search_path=${name},public`);
    const pool = createPool(url.toString()); pools.push(pool); await migrate(pool);
    return { pool, name };
  }
  function endpoint(name: string): StorageEndpoint {
    const path = join(root, name); return { provider: new LocalBlobStore(path), locator: { provider: 'local', root: path } };
  }
  return { root, database, endpoint };
}
async function upload(pool: Pool, source: StorageEndpoint, text: string, consume = false) {
  const actor = await createUser(pool, { email: `${randomUUID()}@storage.example.test`, name: 'Isolated storage test', password: 'test-storage-password-only' });
  const workspace = await createWorkspace(pool, actor.id, 'Storage test');
  const stored = await source.provider.put(Buffer.from(text));
  const uploadId = randomUUID(); const artifactId = randomUUID(); const versionId = randomUUID();
  const data = { objectKey: stored.key, sha256: stored.sha256, size: stored.size, ownerId: actor.id, expiresAt: '2000-01-01T00:00:00.000Z', consumedAt: consume ? new Date().toISOString() : null, consumedByArtifactVersionId: consume ? versionId : null, fileName: 'retained.txt', mediaType: 'text/plain' };
  const sql = await pool.connect();
  try {
    await sql.query('BEGIN');
    await sql.query("INSERT INTO entities(id,workspace_id,project_id,kind,data,created_by) VALUES($1,$2,'PRJ-001','upload',$3,$4)", [uploadId, workspace.id, data, actor.id]);
    if (consume) {
      await sql.query("INSERT INTO entities(id,workspace_id,project_id,kind,data,created_by) VALUES($1,$2,'PRJ-001','artifact',$3,$4)", [artifactId, workspace.id, { title: 'Immutable history', kind: 'document', versionRefs: [versionId], latestVersionId: versionId, hiddenAt: null, hiddenBy: null }, actor.id]);
      await sql.query("INSERT INTO entities(id,workspace_id,project_id,kind,data,created_by) VALUES($1,$2,'PRJ-001','artifact_version',$3,$4)", [versionId, workspace.id, { artifactId, uploadId, objectKey: stored.key, sha256: stored.sha256, contentDigest: stored.sha256, size: stored.size, mediaType: 'text/plain', fileName: 'retained.txt', sourceRunId: null, producerId: actor.id }, actor.id]);
    }
    await sql.query('COMMIT');
  } catch (error) { await sql.query('ROLLBACK'); throw error; }
  finally { sql.release(); }
  return stored;
}
test('default Local requires explicit new binding; wrong root, marker and changed epoch fail closed', { skip: !databaseUrl }, async t => {
  const f = await fixture(t); const { pool } = await f.database(); const source = f.endpoint('source');
  const guarded = bindBlobStore(pool, source.locator, source.provider);
  await assert.rejects(guarded.init(), { code: 'blob_storage_binding_mismatch' });
  const binding = await bindStorage({ pool, ...source, mode: 'new', stopped: true });
  await guarded.init(); await guarded.check();
  const item = await guarded.put(Buffer.from('private bytes'));
  const wrong = f.endpoint('wrong'); await wrong.provider.init(); await wrong.provider.importVerifiedObject(item.key, Buffer.from('private bytes'));
  await assert.rejects(bindBlobStore(pool, wrong.locator, wrong.provider).read(item.key), { code: 'blob_storage_binding_mismatch' });
  await pool.query('UPDATE blob_storage_binding SET epoch=epoch+1 WHERE singleton=true');
  await assert.rejects(guarded.read(item.key), { code: 'blob_storage_binding_mismatch' });
  assert.equal(binding.epoch, '1');
  await unlink(join(f.root, 'source', '.pm-store.json'));
  await assert.rejects(bindBlobStore(pool, source.locator, source.provider).check(), { code: 'blob_storage_binding_mismatch' });
});
test('old Local adopt verifies every expired upload and refuses missing/corrupt bytes', { skip: !databaseUrl }, async t => {
  const f = await fixture(t); const { pool } = await f.database(); const source = f.endpoint('legacy'); await source.provider.init();
  const original = await upload(pool, source, 'original retained bytes');
  await assert.rejects(bindStorage({ pool, ...source, mode: 'new', stopped: true }), { code: 'blob_storage_not_empty' });
  await writeFile(join(f.root, 'legacy', original.key), 'corrupt');
  await assert.rejects(bindStorage({ pool, ...source, mode: 'adopt', stopped: true }), { code: 'blob_integrity_error' });
  assert.equal(await readStorageBinding(pool), null);
  await writeFile(join(f.root, 'legacy', original.key), 'original retained bytes');
  await bindStorage({ pool, ...source, mode: 'adopt', stopped: true });
  const entries = await collectBlobInventory(pool);
  assert.equal(entries.length, 1); assert.equal(entries[0]!.key, original.key);
  await assert.rejects(bindStorage({ pool, ...source, mode: 'adopt', stopped: false }), { code: 'blob_maintenance_requires_stop' });
});
test('interrupted offline migration resumes original keys and only fully verified target can activate', { skip: !databaseUrl }, async t => {
  const f = await fixture(t); const { pool } = await f.database(); const source = f.endpoint('source'); const target = f.endpoint('target');
  const initial = await bindStorage({ pool, ...source, mode: 'new', stopped: true });
  const first = await upload(pool, source, 'first immutable object'); const second = await upload(pool, source, 'second expired upload');
  const guarded = bindBlobStore(pool, source.locator, source.provider); await guarded.init();
  const manifest = await createMigrationManifest({ pool, source, target, expectedEpoch: initial.epoch, stopped: true, databaseDumpSha256: 'a'.repeat(64), coreManifestSha256: 'b'.repeat(64) });
  await assert.rejects(migrateStorage({ pool, source, target, manifest, stopped: true, async onVerified() { throw new Error('Owned process interrupted after an actual object was imported'); } }));
  await assert.rejects(guarded.read(first.key), { code: 'blob_storage_binding_mismatch' });
  await assert.rejects(verifyStorageMigration({ pool, target, manifest, stopped: true }), { code: 'blob_read_failed' });
  await migrateStorage({ pool, source, target, manifest, stopped: true });
  const digest = await verifyStorageMigration({ pool, target, manifest, stopped: true });
  assert.equal(digest, migrationManifestSha256(manifest));
  await assert.rejects(activateStorage({ pool, target, manifest, expectedManifestSha256: 'c'.repeat(64), stopped: true }), { code: 'blob_migration_journal_mismatch' });
  const activated = await activateStorage({ pool, target, manifest, expectedManifestSha256: digest, stopped: true });
  assert.equal(activated.epoch, '3');
  assert.deepEqual(await activateStorage({ pool, target, manifest, expectedManifestSha256: digest, stopped: true }), activated);
  const protectedTarget = bindBlobStore(pool, target.locator, target.provider); await protectedTarget.init();
  assert.equal((await protectedTarget.read(first.key)).toString(), 'first immutable object');
  assert.equal((await protectedTarget.read(second.key)).toString(), 'second expired upload');
  await assert.rejects(guarded.put(Buffer.from('no dual write')), { code: 'blob_storage_binding_mismatch' });
});
test('provider backup restores all references into a new database/root with new marker and original keys', { skip: !databaseUrl }, async t => {
  const f = await fixture(t); const sourceDb = await f.database(); const restoreDb = await f.database();
  const source = f.endpoint('source'); const target = f.endpoint('restored');
  const binding = await bindStorage({ pool: sourceDb.pool, ...source, mode: 'new', stopped: true });
  const original = await upload(sourceDb.pool, source, 'backup keeps expired upload bytes', true);
  const loginCredentials = { email: 'restored-session@example.test', password: 'isolated-restored-session-password' };
  const account = await createUser(sourceDb.pool, { ...loginCredentials, name: 'Restore isolation subject' });
  const originalSession = await login(sourceDb.pool, loginCredentials);
  // Real rows restored into an independent schema with all constraints enabled.
  for (const table of ['users', 'workspaces', 'memberships', 'entities', 'sessions', 'blob_storage_binding', 'blob_storage_operations']) await restoreDb.pool.query(`INSERT INTO "${restoreDb.name}"."${table}" SELECT * FROM "${sourceDb.name}"."${table}"`);
  const directory = join(f.root, 'archive');
  const backup = await exportBlobBackup({ pool: restoreDb.pool, source, directory, databaseDumpSha256: 'a'.repeat(64), coreManifestSha256: 'b'.repeat(64), stopped: true });
  assert.equal(backup.manifest.entries.length, 1);
  assert.ok(backup.manifest.entries[0]!.references >= 2, 'Both consumed/expired upload and immutable version remain durable references');
  await verifyBlobBackup({ pool: restoreDb.pool, directory, expectedManifestSha256: backup.manifestSha256, databaseDumpSha256: 'a'.repeat(64), coreManifestSha256: 'b'.repeat(64) });
  const options = { pool: restoreDb.pool, target, directory, expectedManifestSha256: backup.manifestSha256, databaseDumpSha256: 'a'.repeat(64), coreManifestSha256: 'b'.repeat(64), stopped: true, targetStoreId: randomUUID(), operationId: randomUUID(), expectedEpoch: binding.epoch };
  const restored = await restoreBlobBackup(options);
  assert.notEqual(restored.storeId, binding.storeId); assert.equal(restored.epoch, '2');
  await assert.rejects(authenticate(restoreDb.pool, originalSession.token), { code: 'unauthenticated' });
  assert.equal((await authenticate(sourceDb.pool, originalSession.token)).id, account.id, 'Source DB session remains usable');
  const newSession = await login(restoreDb.pool, loginCredentials);
  assert.deepEqual(await restoreBlobBackup(options), restored);
  assert.equal((await authenticate(restoreDb.pool, newSession.token)).id, account.id, 'Original accepted restore recovery must not fence a later legitimate session again');
  assert.equal((await bindBlobStore(restoreDb.pool, target.locator, target.provider).read(original.key)).toString(), 'backup keeps expired upload bytes');
  assert.equal((await readStorageBinding(sourceDb.pool))!.storeId, binding.storeId);
  await writeFile(join(directory, 'objects', original.key), 'broken archive');
  await assert.rejects(verifyBlobBackup({ pool: restoreDb.pool, directory, expectedManifestSha256: backup.manifestSha256, databaseDumpSha256: 'a'.repeat(64), coreManifestSha256: 'b'.repeat(64) }), { code: 'blob_integrity_error' });
});

test('pre-write source rollback is CAS/idempotent and any new SQL fact forces a full new migration', { skip: !databaseUrl }, async t => {
  const f = await fixture(t);
  for (const changed of [false, true]) {
    const { pool } = await f.database(); const source = f.endpoint(`source-${changed}`); const target = f.endpoint(`target-${changed}`);
    await bindStorage({ pool, ...source, mode: 'new', stopped: true });
    const item = await upload(pool, source, `retained object ${changed}`);
    const manifest = await createMigrationManifest({ pool, source, target, expectedEpoch: '1', stopped: true, databaseDumpSha256: 'a'.repeat(64), coreManifestSha256: 'b'.repeat(64) });
    await migrateStorage({ pool, source, target, manifest, stopped: true });
    await activateStorage({ pool, target, manifest, expectedManifestSha256: migrationManifestSha256(manifest), stopped: true });
    if (changed) {
      await createUser(pool, { email: 'new-fact@example.test', name: 'New fact after cutover', password: 'isolated-new-fact-password' });
      await assert.rejects(resumeSourceStorage({ pool, source, manifest, stopped: true }), { code: 'blob_source_resume_requires_new_migration' });
      assert.equal((await readStorageBinding(pool))!.storeId, manifest.target.storeId);
    } else {
      const restored = await resumeSourceStorage({ pool, source, manifest, stopped: true });
      assert.equal(restored.storeId, manifest.source.storeId); assert.equal(restored.epoch, '4');
      assert.deepEqual(await resumeSourceStorage({ pool, source, manifest, stopped: true }), restored);
      assert.equal((await bindBlobStore(pool, source.locator, source.provider).read(item.key)).toString(), `retained object ${changed}`);
    }
  }
});
