import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import { DomainError } from '../../domain/src/core.ts';
import { fenceRestoredServices } from '../../application/src/restore-safety.ts';
import type { BlobStorageProvider } from './blob-storage-admin.ts';
import { locatorSha256, type BlobStorageLocator } from './blob-storage-config.ts';
import { assertStorageMarker, readStorageBinding, readStorageMarker, storageMarkerSchema, type StorageBinding, type StorageMarker } from './blob-storage-binding.ts';
import { blobInventoryEntrySchema, inventoryBlobReferences, inventorySha256, verifyInventoryObjects, type BlobInventoryEntry } from './blob-storage-inventory.ts';
import { databaseContentSha256 } from './blob-storage-sql-checkpoint.ts';

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const epoch = z.string().regex(/^[1-9][0-9]*$/);
const bindingSchema = z.strictObject({ storeId: z.uuid(), provider: z.enum(['local', 's3']), locatorSha256: sha, epoch, state: z.enum(['active', 'migrating']), verifiedManifestSha256: sha.nullable(), verifiedAt: z.iso.datetime().nullable() });
export const migrationManifestSchema = z.strictObject({
  formatVersion: z.literal(1), migrationId: z.uuid(), activationId: z.uuid(), rollbackId: z.uuid(), createdAt: z.iso.datetime(),
  source: bindingSchema, target: storageMarkerSchema, frozenEpoch: epoch,
  databaseDumpSha256: sha, databaseContentSha256: sha, coreManifestSha256: sha, entries: z.array(blobInventoryEntrySchema),
});
export type MigrationManifest = z.infer<typeof migrationManifestSchema>;
export type StorageEndpoint = { provider: BlobStorageProvider; locator: BlobStorageLocator };
function offline(stopped: boolean): void { if (stopped !== true) throw new DomainError('blob_maintenance_requires_stop', 'Explicit API/Worker/external-core-writer stop confirmation is required'); }
export function migrationManifestSha256(manifest: MigrationManifest): string { return createHash('sha256').update(JSON.stringify(migrationManifestSchema.parse(manifest))).digest('hex'); }
export async function storageTransaction<T>(pool: Pool, action: (sql: PoolClient) => Promise<T>, readOnly = false): Promise<T> {
  const sql = await pool.connect();
  try {
    await sql.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
    if (!readOnly) await sql.query("SELECT pg_advisory_xact_lock(hashtextextended('pm:blob-storage-maintenance',724631))");
    const result = await action(sql); await sql.query('COMMIT'); return result;
  } catch (error) { await sql.query('ROLLBACK'); throw error; }
  finally { sql.release(); }
}
export async function collectBlobInventory(pool: Pool): Promise<BlobInventoryEntry[]> { return storageTransaction(pool, sql => inventoryBlobReferences(sql), true); }
async function legacyBlobReferences(sql: PoolClient): Promise<BlobInventoryEntry[]> {
  const entries = await inventoryBlobReferences(sql);
  const stores = await sql.query<{ storage_id: string }>('SELECT storage_id FROM project_blob_stores');
  const routes = await sql.query<{ object_key: string }>('SELECT object_key FROM project_blob_object_routes');
  const projectStores = new Set(stores.rows.map(row => row.storage_id));
  const projectKeys = new Set(routes.rows.map(row => row.object_key));
  return entries.filter(entry => !projectKeys.has(entry.key) && (!entry.storageId || !projectStores.has(entry.storageId)));
}
/** Explicit global-provider maintenance excludes independently bound project volumes. */
export async function collectLegacyBlobInventory(pool: Pool): Promise<BlobInventoryEntry[]> { return storageTransaction(pool, legacyBlobReferences, true); }
function markerFor(locator: BlobStorageLocator, storeId: string = randomUUID()): StorageMarker { return { formatVersion: 1, storeId, provider: locator.provider, locatorSha256: locatorSha256(locator) }; }
async function ensureMarker(endpoint: StorageEndpoint, marker: StorageMarker, allowExisting: boolean): Promise<void> {
  const existing = await readStorageMarker(endpoint.provider);
  if (existing) {
    if (!allowExisting || JSON.stringify(existing) !== JSON.stringify(marker)) throw new DomainError('blob_storage_binding_mismatch', 'Target marker differs or was not explicitly approved', 503);
  } else await endpoint.provider.createMarker(Buffer.from(JSON.stringify(marker)));
  const actual = await readStorageMarker(endpoint.provider);
  if (JSON.stringify(actual) !== JSON.stringify(marker)) throw new DomainError('blob_storage_binding_mismatch', 'Target marker verification failed', 503);
}
async function record(sql: PoolClient, id: string, kind: string, expected: string, source: StorageBinding | null, target: unknown, digest: string): Promise<void> {
  await sql.query('INSERT INTO blob_storage_operations(operation_id,operation_kind,expected_epoch,source_binding,target_binding,manifest_sha256) VALUES($1,$2,$3,$4,$5,$6)', [id, kind, expected, source, target, digest]);
}
async function preserveStorageAliases(sql: PoolClient, sourceId: string, targetId: string): Promise<void> {
  if (sourceId === targetId) return;
  await sql.query('DELETE FROM blob_store_aliases WHERE storage_id=$1', [targetId]);
  await sql.query('UPDATE blob_store_aliases SET target_store_id=$1 WHERE target_store_id=$2', [targetId, sourceId]);
  await sql.query('INSERT INTO blob_store_aliases(storage_id,target_store_id) VALUES($1,$2) ON CONFLICT(storage_id) DO UPDATE SET target_store_id=EXCLUDED.target_store_id', [sourceId, targetId]);
}
export async function bindStorage(options: StorageEndpoint & { pool: Pool; mode: 'new' | 'adopt'; stopped: boolean; storeId?: string; operationId?: string }): Promise<StorageBinding> {
  offline(options.stopped);
  return storageTransaction(options.pool, async sql => {
    if (await readStorageBinding(sql, true)) throw new DomainError('blob_storage_already_bound', 'Database already has a binding');
    await options.provider.init();
    const entries = await legacyBlobReferences(sql);
    if (options.mode === 'new' && entries.length) throw new DomainError('blob_storage_not_empty', 'New binding cannot contain existing SQL references');
    if (options.mode === 'new' && (await options.provider.listNamespace()).some(key => key !== '_pm/health/write-probe' && !(options.storeId && ['.pm-store.json', '_pm/store.json'].includes(key)))) throw new DomainError('blob_storage_not_empty', 'New binding requires an empty namespace');
    await verifyInventoryObjects(options.provider, entries);
    const marker = markerFor(options.locator, options.storeId);
    await ensureMarker(options, marker, Boolean(options.storeId));
    const digest = inventorySha256(entries);
    await sql.query("INSERT INTO blob_storage_binding(singleton,store_id,provider,locator_sha256,epoch,state,verified_manifest_sha256,verified_at) VALUES(true,$1,$2,$3,1,'active',$4,clock_timestamp())", [marker.storeId, marker.provider, marker.locatorSha256, digest]);
    await record(sql, options.operationId ?? randomUUID(), options.mode === 'new' ? 'bind_new' : 'bind_adopt', '0', null, marker, digest);
    return (await readStorageBinding(sql))!;
  });
}
export async function createMigrationManifest(options: { pool: Pool; source: StorageEndpoint; target: StorageEndpoint; expectedEpoch: string; stopped: boolean; databaseDumpSha256: string; coreManifestSha256: string }): Promise<MigrationManifest> {
  offline(options.stopped);
  if (locatorSha256(options.source.locator) === locatorSha256(options.target.locator)) throw new DomainError('blob_migration_same_locator');
  const source = await readStorageBinding(options.pool);
  if (!source || source.state !== 'active' || source.epoch !== options.expectedEpoch) throw new DomainError('version_conflict');
  assertStorageMarker(source, options.source.locator, await readStorageMarker(options.source.provider));
  const entries = await collectLegacyBlobInventory(options.pool);
  await verifyInventoryObjects(options.source.provider, entries);
  await options.target.provider.init();
  if ((await options.target.provider.listNamespace()).some(key => key !== '_pm/health/write-probe')) throw new DomainError('blob_storage_not_empty', 'Migration target must be an empty independent namespace');
  const databaseDigest = await storageTransaction(options.pool, sql => databaseContentSha256(sql), true);
  return migrationManifestSchema.parse({ formatVersion: 1, migrationId: randomUUID(), activationId: randomUUID(), rollbackId: randomUUID(), createdAt: new Date().toISOString(), source, target: markerFor(options.target.locator), frozenEpoch: (BigInt(source.epoch) + 1n).toString(), databaseDumpSha256: options.databaseDumpSha256, databaseContentSha256: databaseDigest, coreManifestSha256: options.coreManifestSha256, entries });
}
async function assertManifestReferences(pool: Pool, manifest: MigrationManifest, includeFacts = false): Promise<void> {
  if (inventorySha256(await collectLegacyBlobInventory(pool)) !== inventorySha256(manifest.entries)) throw new DomainError('blob_inventory_changed', 'Legacy persistent references must match the frozen manifest', 503);
  if (includeFacts && await storageTransaction(pool, sql => databaseContentSha256(sql), true) !== manifest.databaseContentSha256) throw new DomainError('blob_checkpoint_changed', 'Frozen SQL facts changed', 503);
}
function assertEndpoint(marker: StorageMarker, endpoint: StorageEndpoint): void {
  if (marker.provider !== endpoint.locator.provider || marker.locatorSha256 !== locatorSha256(endpoint.locator)) throw new DomainError('blob_storage_binding_mismatch', 'Manifest locator differs', 503);
}
export async function migrateStorage(options: { pool: Pool; source: StorageEndpoint; target: StorageEndpoint; manifest: MigrationManifest; stopped: boolean; onVerified?: (key: string) => Promise<void> }): Promise<void> {
  offline(options.stopped);
  const manifest = migrationManifestSchema.parse(options.manifest);
  assertEndpoint(manifest.target, options.target);
  assertStorageMarker(manifest.source, options.source.locator, await readStorageMarker(options.source.provider));
  if (manifest.source.locatorSha256 === manifest.target.locatorSha256) throw new DomainError('blob_migration_same_locator');
  await assertManifestReferences(options.pool, manifest, true);
  const digest = migrationManifestSha256(manifest);
  await storageTransaction(options.pool, async sql => {
    const current = await readStorageBinding(sql, true);
    if (!current || current.storeId !== manifest.source.storeId || current.locatorSha256 !== manifest.source.locatorSha256) throw new DomainError('blob_storage_binding_mismatch');
    if (current.state === 'migrating' && current.epoch === manifest.frozenEpoch) {
      const prior = await sql.query<{ manifest_sha256: string }>('SELECT manifest_sha256 FROM blob_storage_operations WHERE operation_id=$1', [manifest.migrationId]);
      if (prior.rows[0]?.manifest_sha256 !== digest) throw new DomainError('blob_migration_journal_mismatch');
    } else {
      if (current.state !== 'active' || current.epoch !== manifest.source.epoch) throw new DomainError('version_conflict');
      await sql.query("UPDATE blob_storage_binding SET state='migrating',epoch=epoch+1,updated_at=clock_timestamp() WHERE singleton=true AND epoch=$1", [manifest.source.epoch]);
      await record(sql, manifest.migrationId, 'migrate', manifest.source.epoch, current, manifest.target, digest);
    }
  });
  await options.target.provider.init();
  const existingMarker = await readStorageMarker(options.target.provider);
  if (existingMarker && JSON.stringify(existingMarker) !== JSON.stringify(manifest.target)) throw new DomainError('blob_storage_binding_mismatch');
  const allowed = new Set(manifest.entries.map(item => options.target.locator.provider === 'local' ? item.key : `objects/${item.key}`));
  allowed.add('.pm-store.json'); allowed.add('_pm/store.json'); allowed.add('_pm/health/write-probe');
  const namespace = await options.target.provider.listNamespace();
  if (namespace.some(key => !allowed.has(key)) || (!existingMarker && namespace.some(key => key !== '_pm/health/write-probe'))) throw new DomainError('blob_storage_not_empty', 'Target contains unapproved objects');
  await ensureMarker(options.target, manifest.target, true);
  for (const entry of manifest.entries) {
    const bytes = await options.source.provider.read(entry.key);
    if (bytes.length !== entry.size || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new DomainError('blob_integrity_error', 'Source differs from frozen manifest', 503);
    if (!(await options.target.provider.objectExists(entry.key))) await options.target.provider.importVerifiedObject(entry.key, bytes);
    await verifyInventoryObjects(options.target.provider, [entry]);
    await options.onVerified?.(entry.key);
  }
}
export async function verifyStorageMigration(options: { pool: Pool; target: StorageEndpoint; manifest: MigrationManifest; stopped: boolean }): Promise<string> {
  offline(options.stopped);
  const manifest = migrationManifestSchema.parse(options.manifest);
  assertEndpoint(manifest.target, options.target);
  await assertManifestReferences(options.pool, manifest, true);
  const marker = await readStorageMarker(options.target.provider);
  if (JSON.stringify(marker) !== JSON.stringify(manifest.target)) throw new DomainError('blob_storage_binding_mismatch');
  await verifyInventoryObjects(options.target.provider, manifest.entries);
  return migrationManifestSha256(manifest);
}
export async function activateStorage(options: { pool: Pool; target: StorageEndpoint; manifest: MigrationManifest; expectedManifestSha256: string; stopped: boolean }): Promise<StorageBinding> {
  offline(options.stopped);
  const manifest = migrationManifestSchema.parse(options.manifest);
  const digest = migrationManifestSha256(manifest);
  if (digest !== options.expectedManifestSha256) throw new DomainError('blob_migration_journal_mismatch');
  assertEndpoint(manifest.target, options.target);
  const accepted = await readStorageBinding(options.pool);
  if (accepted?.state === 'active' && accepted.storeId === manifest.target.storeId && accepted.epoch === (BigInt(manifest.frozenEpoch) + 1n).toString() && accepted.verifiedManifestSha256 === digest) {
    const prior = await options.pool.query<{ manifest_sha256: string }>('SELECT manifest_sha256 FROM blob_storage_operations WHERE operation_id=$1', [manifest.activationId]);
    if (prior.rows[0]?.manifest_sha256 !== digest) throw new DomainError('blob_migration_journal_mismatch');
    assertStorageMarker(accepted, options.target.locator, await readStorageMarker(options.target.provider));
    return accepted;
  }
  await verifyStorageMigration({ ...options, manifest });
  return storageTransaction(options.pool, async sql => {
    const current = await readStorageBinding(sql, true);
    if (!current) throw new DomainError('blob_storage_binding_mismatch');
    // A lost COMMIT response is recovered by the same activation identity, not another cutover.
    if (current.state === 'active' && current.storeId === manifest.target.storeId && current.epoch === (BigInt(manifest.frozenEpoch) + 1n).toString() && current.verifiedManifestSha256 === digest) {
      const prior = await sql.query<{ manifest_sha256: string }>('SELECT manifest_sha256 FROM blob_storage_operations WHERE operation_id=$1', [manifest.activationId]);
      if (prior.rows[0]?.manifest_sha256 !== digest) throw new DomainError('blob_migration_journal_mismatch');
      return current;
    }
    if (current.state !== 'migrating' || current.epoch !== manifest.frozenEpoch || current.storeId !== manifest.source.storeId || current.locatorSha256 !== manifest.source.locatorSha256) throw new DomainError('version_conflict');
    if (inventorySha256(await legacyBlobReferences(sql)) !== inventorySha256(manifest.entries)) throw new DomainError('blob_inventory_changed');
    if (await databaseContentSha256(sql) !== manifest.databaseContentSha256) throw new DomainError('blob_checkpoint_changed', 'Frozen SQL facts changed', 503);
    const changed = await sql.query("UPDATE blob_storage_binding SET store_id=$1,provider=$2,locator_sha256=$3,epoch=epoch+1,state='active',verified_manifest_sha256=$4,verified_at=clock_timestamp(),updated_at=clock_timestamp() WHERE singleton=true AND epoch=$5 AND state='migrating'", [manifest.target.storeId, manifest.target.provider, manifest.target.locatorSha256, digest, manifest.frozenEpoch]);
    if (changed.rowCount !== 1) throw new DomainError('version_conflict');
    await preserveStorageAliases(sql, current.storeId, manifest.target.storeId);
    await record(sql, manifest.activationId, 'activate', manifest.frozenEpoch, current, manifest.target, digest);
    return (await readStorageBinding(sql))!;
  });
}
/** Resume original source only while the complete SQL/core checkpoint has no later facts. */
export async function resumeSourceStorage(options: { pool: Pool; source: StorageEndpoint; manifest: MigrationManifest; stopped: boolean }): Promise<StorageBinding> {
  offline(options.stopped);
  const manifest = migrationManifestSchema.parse(options.manifest);
  await assertManifestReferences(options.pool, manifest);
  assertStorageMarker(manifest.source, options.source.locator, await readStorageMarker(options.source.provider));
  await verifyInventoryObjects(options.source.provider, manifest.entries);
  return storageTransaction(options.pool, async sql => {
    const current = await readStorageBinding(sql, true);
    if (!current) throw new DomainError('version_conflict');
    if (await databaseContentSha256(sql) !== manifest.databaseContentSha256) throw new DomainError('blob_source_resume_requires_new_migration', 'New SQL facts require a full forward/reverse migration', 503);
    const digest = migrationManifestSha256(manifest);
    const prior = await sql.query<{ manifest_sha256: string }>('SELECT manifest_sha256 FROM blob_storage_operations WHERE operation_id=$1', [manifest.rollbackId]);
    if (prior.rows[0]) {
      if (prior.rows[0].manifest_sha256 !== digest || current.state !== 'active' || current.storeId !== manifest.source.storeId || current.verifiedManifestSha256 !== digest) throw new DomainError('blob_migration_journal_mismatch');
      return current;
    }
    const frozenSource = current.state === 'migrating' && current.storeId === manifest.source.storeId && current.epoch === manifest.frozenEpoch;
    const activatedWithoutWrites = current.state === 'active' && current.storeId === manifest.target.storeId && current.locatorSha256 === manifest.target.locatorSha256 && current.epoch === (BigInt(manifest.frozenEpoch) + 1n).toString() && current.verifiedManifestSha256 === digest;
    if (!frozenSource && !activatedWithoutWrites) throw new DomainError('version_conflict');
    await sql.query("UPDATE blob_storage_binding SET store_id=$1,provider=$2,locator_sha256=$3,state='active',epoch=epoch+1,verified_manifest_sha256=$4,verified_at=clock_timestamp(),updated_at=clock_timestamp() WHERE singleton=true AND epoch=$5", [manifest.source.storeId, manifest.source.provider, manifest.source.locatorSha256, digest, current.epoch]);
    await preserveStorageAliases(sql, current.storeId, manifest.source.storeId);
    await record(sql, manifest.rollbackId, 'resume_source', current.epoch, current, manifest.source, digest);
    return (await readStorageBinding(sql))!;
  });
}
export async function restoreRebindStorage(options: { pool: Pool; target: StorageEndpoint; expectedEpoch: string; expectedSourceStoreId: string; entries: BlobInventoryEntry[]; backupManifestSha256: string; databaseDumpSha256: string; coreManifestSha256: string; stopped: boolean; targetStoreId: string; operationId: string }): Promise<StorageBinding> {
  offline(options.stopped);
  sha.parse(options.backupManifestSha256); sha.parse(options.databaseDumpSha256); sha.parse(options.coreManifestSha256);
  const marker = markerFor(options.target.locator, z.uuid().parse(options.targetStoreId));
  if (marker.storeId === options.expectedSourceStoreId) throw new DomainError('blob_restore_requires_new_store');
  const accepted = await readStorageBinding(options.pool);
  if (accepted?.state === 'active' && accepted.storeId === marker.storeId && accepted.epoch === (BigInt(options.expectedEpoch) + 1n).toString() && accepted.verifiedManifestSha256 === options.backupManifestSha256) {
    const prior = await options.pool.query<{ manifest_sha256: string }>('SELECT manifest_sha256 FROM blob_storage_operations WHERE operation_id=$1', [options.operationId]);
    if (prior.rows[0]?.manifest_sha256 !== options.backupManifestSha256) throw new DomainError('blob_migration_journal_mismatch');
    assertStorageMarker(accepted, options.target.locator, await readStorageMarker(options.target.provider));
    return accepted;
  }
  if (inventorySha256(await collectBlobInventory(options.pool)) !== inventorySha256(options.entries)) throw new DomainError('blob_inventory_changed');
  await verifyInventoryObjects(options.target.provider, options.entries);
  const existingMarker = await readStorageMarker(options.target.provider);
  const allowed = new Set(options.entries.map(entry => options.target.locator.provider === 'local' ? entry.key : `objects/${entry.key}`));
  allowed.add('.pm-store.json'); allowed.add('_pm/store.json'); allowed.add('_pm/health/write-probe');
  const namespace = await options.target.provider.listNamespace();
  if (namespace.some(key => !allowed.has(key)) || (!existingMarker && namespace.some(key => key !== '_pm/health/write-probe'))) throw new DomainError('blob_storage_not_empty');
  await ensureMarker(options.target, marker, true);
  return storageTransaction(options.pool, async sql => {
    const current = await readStorageBinding(sql, true);
    if (current?.storeId === marker.storeId && current.epoch === (BigInt(options.expectedEpoch) + 1n).toString() && current.verifiedManifestSha256 === options.backupManifestSha256) {
      const prior = await sql.query<{ manifest_sha256: string }>('SELECT manifest_sha256 FROM blob_storage_operations WHERE operation_id=$1', [options.operationId]);
      if (prior.rows[0]?.manifest_sha256 !== options.backupManifestSha256) throw new DomainError('blob_migration_journal_mismatch');
      return current;
    }
    if (!current || current.storeId !== options.expectedSourceStoreId || current.epoch !== options.expectedEpoch || current.locatorSha256 === marker.locatorSha256) throw new DomainError('version_conflict');
    if (inventorySha256(await inventoryBlobReferences(sql)) !== inventorySha256(options.entries)) throw new DomainError('blob_inventory_changed');
    // pool is the isolated restored target DB. Fence external effects atomically with its new binding.
    // Original-operation recovery returns above and must never re-fence later legitimate target sessions.
    await fenceRestoredServices(sql);
    await preserveStorageAliases(sql, current.storeId, marker.storeId);
    await sql.query("UPDATE blob_storage_binding SET store_id=$1,provider=$2,locator_sha256=$3,epoch=epoch+1,state='active',verified_manifest_sha256=$4,verified_at=clock_timestamp(),updated_at=clock_timestamp() WHERE singleton=true AND epoch=$5", [marker.storeId, marker.provider, marker.locatorSha256, options.backupManifestSha256, options.expectedEpoch]);
    await record(sql, options.operationId, 'restore_rebind', options.expectedEpoch, current, { ...marker, databaseDumpSha256: options.databaseDumpSha256, coreManifestSha256: options.coreManifestSha256 }, options.backupManifestSha256);
    return (await readStorageBinding(sql))!;
  });
}
