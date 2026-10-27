import { z } from 'zod';
import type { Pool } from 'pg';
import { DomainError } from '../../domain/src/core.ts';
import type { SqlExecutor } from '../../application/src/ports.ts';
import { blobKeyDigest, validateBlobBytes, type BlobStore } from './blobs.ts';
import type { BlobStorageProvider } from './blob-storage-admin.ts';
import { locatorSha256, type BlobStorageLocator } from './blob-storage-config.ts';

export const storageMarkerSchema = z.strictObject({ formatVersion: z.literal(1), storeId: z.uuid(), provider: z.enum(['local', 's3']), locatorSha256: z.string().regex(/^[a-f0-9]{64}$/) });
export type StorageMarker = z.infer<typeof storageMarkerSchema>;
export type StorageBinding = { storeId: string; provider: 'local' | 's3'; locatorSha256: string; epoch: string; state: 'active' | 'migrating'; verifiedManifestSha256: string | null; verifiedAt: string | null };
type BindingRow = { store_id: string; provider: 'local' | 's3'; locator_sha256: string; epoch: string; state: 'active' | 'migrating'; verified_manifest_sha256: string | null; verified_at: Date | string | null };
export async function readStorageBinding(sql: SqlExecutor, lock = false): Promise<StorageBinding | null> {
  const result = await sql.query<BindingRow>(`SELECT store_id,provider,locator_sha256,epoch::text,state,verified_manifest_sha256,verified_at FROM blob_storage_binding WHERE singleton=true${lock ? ' FOR UPDATE' : ''}`);
  const row = result.rows[0];
  return row ? { storeId: row.store_id, provider: row.provider, locatorSha256: row.locator_sha256, epoch: row.epoch, state: row.state, verifiedManifestSha256: row.verified_manifest_sha256, verifiedAt: row.verified_at === null ? null : new Date(row.verified_at).toISOString() } : null;
}
export async function readStorageMarker(provider: BlobStorageProvider, milliseconds?: number): Promise<StorageMarker | null> {
  const bytes = await provider.readMarker(milliseconds);
  if (bytes === null) return null;
  try { return storageMarkerSchema.parse(JSON.parse(bytes.toString('utf8'))); }
  catch { throw new DomainError('blob_storage_binding_mismatch', 'Invalid storage marker', 503); }
}
export function assertStorageMarker(binding: StorageBinding, locator: BlobStorageLocator, marker: StorageMarker | null): void {
  if (!marker || binding.provider !== locator.provider || binding.locatorSha256 !== locatorSha256(locator) || marker.storeId !== binding.storeId || marker.provider !== binding.provider || marker.locatorSha256 !== binding.locatorSha256) throw new DomainError('blob_storage_binding_mismatch', 'Storage binding does not match this provider', 503);
}
/** Deployment guard only: never creates a root/marker/binding or changes routing on recovery. */
export function bindBlobStore(pool: Pool, locator: BlobStorageLocator, provider: BlobStorageProvider): BlobStore {
  let pinned: { epoch: string; storeId: string } | undefined;
  let checking: Promise<void> | undefined;
  async function gate(milliseconds?: number): Promise<void> {
    try {
      const started = Date.now();
      const query = { text: 'SELECT store_id,provider,locator_sha256,epoch::text,state,verified_manifest_sha256,verified_at FROM blob_storage_binding WHERE singleton=true', query_timeout: milliseconds };
      const result = await pool.query<BindingRow>(query);
      const row = result.rows[0];
      const binding: StorageBinding | null = row ? { storeId: row.store_id, provider: row.provider, locatorSha256: row.locator_sha256, epoch: row.epoch, state: row.state, verifiedManifestSha256: row.verified_manifest_sha256, verifiedAt: row.verified_at === null ? null : new Date(row.verified_at).toISOString() } : null;
      if (!binding || binding.state !== 'active' || (pinned && (pinned.epoch !== binding.epoch || pinned.storeId !== binding.storeId))) throw new DomainError('blob_storage_binding_mismatch', 'Storage binding is missing, frozen or changed', 503);
      const remaining = milliseconds === undefined ? undefined : Math.max(1, milliseconds - (Date.now() - started));
      assertStorageMarker(binding, locator, await readStorageMarker(provider, remaining));
      pinned ??= { epoch: binding.epoch, storeId: binding.storeId };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError('blob_storage_unavailable', 'Storage binding cannot be verified', 503);
    }
  }
  return {
    async init() { await gate(); await provider.init(); },
    async check() {
      if (checking) return checking;
      const started = Date.now();
      checking = (async () => { await gate(2000); await provider.check(Math.max(1, 2000 - (Date.now() - started))); })().finally(() => { checking = undefined; });
      return checking;
    },
    async put(bytes) { validateBlobBytes(bytes); await gate(); return provider.put(bytes); },
    async read(key) { blobKeyDigest(key); await gate(); return provider.read(key); },
  };
}
