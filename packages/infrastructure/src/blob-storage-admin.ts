import type { BlobStore, StoredBlob } from './blobs.ts';

/** Infrastructure-only maintenance surface; never pass this port to HTTP/business code. */
export type BlobStorageProvider = BlobStore & {
  check(milliseconds?: number): Promise<void>;
  readMarker(milliseconds?: number): Promise<Buffer | null>;
  createMarker(bytes: Uint8Array): Promise<void>;
  listNamespace(): Promise<string[]>;
  importVerifiedObject(key: string, bytes: Uint8Array): Promise<StoredBlob>;
  objectExists(key: string): Promise<boolean>;
  close(): void;
};
