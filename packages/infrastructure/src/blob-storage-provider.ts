import { DomainError } from '../../domain/src/core.ts';
import { LocalBlobStore } from './blobs.ts';
import type { BlobStorageProvider } from './blob-storage-admin.ts';
import type { BlobStoreConfig } from './blob-storage-config.ts';
import { S3BlobStore } from './s3-blobs.ts';
export type { BlobStorageProvider } from './blob-storage-admin.ts';

/** No network/filesystem/credential discovery occurs until an operation is called. */
export function createBlobStore(config: BlobStoreConfig): BlobStorageProvider {
  if (config.provider === 'local') return new LocalBlobStore(config.root);
  if (config.provider === 's3') return new S3BlobStore(config);
  const disabled = async (): Promise<never> => { throw new DomainError('blob_provider_disabled', 'Blob storage is disabled', 503); };
  return { init: disabled, check: disabled, put: disabled, read: disabled, readMarker: disabled, createMarker: disabled, listNamespace: disabled, importVerifiedObject: disabled, objectExists: disabled, close() {} };
}
