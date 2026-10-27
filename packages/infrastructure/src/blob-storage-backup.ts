import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Pool } from 'pg';
import { DomainError } from '../../domain/src/core.ts';
import { LocalBlobStore } from './blobs.ts';
import { assertStorageMarker, readStorageBinding, readStorageMarker, type StorageBinding } from './blob-storage-binding.ts';
import { blobInventoryEntrySchema, inventorySha256, verifyInventoryObjects } from './blob-storage-inventory.ts';
import { collectBlobInventory, restoreRebindStorage, type StorageEndpoint } from './blob-storage-maintenance.ts';
import type { BlobInventoryEntry } from './blob-storage-inventory.ts';
import { locatorSha256 } from './blob-storage-config.ts';

const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const blobBackupManifestSchema = z.strictObject({
  formatVersion: z.literal(1), backupSetId: z.uuid(), createdAt: z.iso.datetime(),
  source: z.strictObject({ storeId: z.uuid(), provider: z.enum(['local', 's3']), locatorSha256: sha, epoch: z.string().regex(/^[1-9][0-9]*$/), state: z.enum(['active', 'migrating']), verifiedManifestSha256: sha.nullable(), verifiedAt: z.iso.datetime().nullable() }),
  databaseDumpSha256: sha, coreManifestSha256: sha, entries: z.array(blobInventoryEntrySchema),
});
export type BlobBackupManifest = z.infer<typeof blobBackupManifestSchema>;
export function blobBackupManifestSha256(manifest: BlobBackupManifest): string { return createHash('sha256').update(JSON.stringify(blobBackupManifestSchema.parse(manifest))).digest('hex'); }
export async function readBlobBackupManifest(directory: string): Promise<BlobBackupManifest> {
  const file = await open(join(directory, 'manifest.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024 * 1024) throw new DomainError('blob_backup_manifest_invalid');
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) { const read = await file.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) throw new DomainError('blob_backup_manifest_invalid'); offset += read.bytesRead; }
    if ((await file.read(Buffer.alloc(1), 0, 1, bytes.length)).bytesRead) throw new DomainError('blob_backup_manifest_invalid');
    return blobBackupManifestSchema.parse(JSON.parse(bytes.toString('utf8')));
  } finally { await file.close(); }
}
/** pool must be the isolated database restored from the same stopped dump, never a later live DB. */
export async function exportBlobBackup(options: { pool: Pool; source: StorageEndpoint; directory: string; databaseDumpSha256: string; coreManifestSha256: string; stopped: boolean; readObject?: (entry: BlobInventoryEntry) => Promise<Buffer> }): Promise<{ manifest: BlobBackupManifest; manifestSha256: string }> {
  if (!options.stopped) throw new DomainError('blob_maintenance_requires_stop');
  const source = await readStorageBinding(options.pool);
  if (!source) throw new DomainError('blob_storage_binding_mismatch');
  assertStorageMarker(source, options.source.locator, await readStorageMarker(options.source.provider));
  const entries = await collectBlobInventory(options.pool);
  const manifest = blobBackupManifestSchema.parse({ formatVersion: 1, backupSetId: randomUUID(), createdAt: new Date().toISOString(), source, databaseDumpSha256: options.databaseDumpSha256, coreManifestSha256: options.coreManifestSha256, entries });
  await mkdir(options.directory, { mode: 0o700 });
  const archive = new LocalBlobStore(join(options.directory, 'objects'));
  await archive.init();
  for (const entry of entries) {
    const bytes = options.readObject ? await options.readObject(entry) : await options.source.provider.read(entry.key);
    if (bytes.length !== entry.size || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new DomainError('blob_integrity_error', 'Backup source differs from frozen SQL reference', 503);
    await archive.importVerifiedObject(entry.key, bytes);
  }
  await verifyInventoryObjects(archive, entries);
  const file = await open(join(options.directory, 'manifest.json'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(JSON.stringify(manifest)); await file.sync(); }
  finally { await file.close(); }
  const directory = await open(options.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
  return { manifest, manifestSha256: blobBackupManifestSha256(manifest) };
}
export async function verifyBlobBackup(options: { pool: Pool; directory: string; expectedManifestSha256: string; databaseDumpSha256: string; coreManifestSha256: string }): Promise<BlobBackupManifest> {
  const manifest = await readBlobBackupManifest(options.directory);
  if (blobBackupManifestSha256(manifest) !== options.expectedManifestSha256 || manifest.databaseDumpSha256 !== options.databaseDumpSha256 || manifest.coreManifestSha256 !== options.coreManifestSha256) throw new DomainError('blob_backup_set_mismatch');
  if (inventorySha256(await collectBlobInventory(options.pool)) !== inventorySha256(manifest.entries)) throw new DomainError('blob_inventory_changed');
  await verifyInventoryObjects(new LocalBlobStore(join(options.directory, 'objects')), manifest.entries);
  return manifest;
}
/** New independent target only; can resume the same explicit targetStoreId, never overwrite conflicts. */
export type BlobBackupImportOptions = { pool: Pool; target: StorageEndpoint; directory: string; expectedManifestSha256: string; databaseDumpSha256: string; coreManifestSha256: string; stopped: boolean; targetStoreId: string };
export async function importBlobBackup(options: BlobBackupImportOptions): Promise<BlobBackupManifest> {
  if (!options.stopped) throw new DomainError('blob_maintenance_requires_stop');
  const manifest = await verifyBlobBackup(options);
  if (manifest.source.storeId === options.targetStoreId || manifest.source.locatorSha256 === locatorSha256(options.target.locator)) throw new DomainError('blob_restore_requires_new_store');
  z.uuid().parse(options.targetStoreId);
  await options.target.provider.init();
  const marker = await readStorageMarker(options.target.provider);
  if (marker && (marker.storeId !== options.targetStoreId || marker.provider !== options.target.locator.provider || marker.locatorSha256 !== locatorSha256(options.target.locator))) throw new DomainError('blob_storage_binding_mismatch');
  const allowed = new Set(manifest.entries.map(entry => options.target.locator.provider === 'local' ? entry.key : `objects/${entry.key}`));
  allowed.add('.pm-store.json'); allowed.add('_pm/store.json'); allowed.add('_pm/health/write-probe');
  const namespace = await options.target.provider.listNamespace();
  if (namespace.some(key => !allowed.has(key)) || (!marker && namespace.some(key => key !== '_pm/health/write-probe'))) throw new DomainError('blob_storage_not_empty');
  const expectedMarker = { formatVersion: 1 as const, storeId: options.targetStoreId, provider: options.target.locator.provider, locatorSha256: locatorSha256(options.target.locator) };
  if (!marker) await options.target.provider.createMarker(Buffer.from(JSON.stringify(expectedMarker)));
  if (JSON.stringify(await readStorageMarker(options.target.provider)) !== JSON.stringify(expectedMarker)) throw new DomainError('blob_storage_binding_mismatch');
  const archive = new LocalBlobStore(join(options.directory, 'objects'));
  for (const entry of manifest.entries) {
    if (!(await options.target.provider.objectExists(entry.key))) await options.target.provider.importVerifiedObject(entry.key, await archive.read(entry.key));
    await verifyInventoryObjects(options.target.provider, [entry]);
  }
  await verifyInventoryObjects(options.target.provider, manifest.entries);
  return manifest;
}
export async function restoreBlobBackup(options: BlobBackupImportOptions & { expectedEpoch: string; operationId: string }): Promise<StorageBinding> {
  let manifest = await readBlobBackupManifest(options.directory);
  if (blobBackupManifestSha256(manifest) !== options.expectedManifestSha256 || manifest.databaseDumpSha256 !== options.databaseDumpSha256 || manifest.coreManifestSha256 !== options.coreManifestSha256) throw new DomainError('blob_backup_set_mismatch');
  const accepted = await readStorageBinding(options.pool);
  if (!(accepted?.state === 'active' && accepted.storeId === options.targetStoreId && accepted.epoch === (BigInt(options.expectedEpoch) + 1n).toString() && accepted.verifiedManifestSha256 === options.expectedManifestSha256)) manifest = await importBlobBackup(options);
  return restoreRebindStorage({ pool: options.pool, target: options.target, expectedEpoch: options.expectedEpoch, expectedSourceStoreId: manifest.source.storeId, entries: manifest.entries, backupManifestSha256: options.expectedManifestSha256, databaseDumpSha256: options.databaseDumpSha256, coreManifestSha256: options.coreManifestSha256, stopped: options.stopped, targetStoreId: options.targetStoreId, operationId: options.operationId });
}
