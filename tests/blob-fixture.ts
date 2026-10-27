import type { Pool } from 'pg';
import { LocalBlobStore } from '../packages/infrastructure/src/blobs.ts';
import { bindStorage } from '../packages/infrastructure/src/blob-storage-maintenance.ts';

/** New isolated schemas must bind explicitly, just like a stopped deployment. */
export async function createBoundLocalStorage(pool: Pool, root: string) {
  const blobStore = new LocalBlobStore(root);
  const blobStorageLocator = { provider: 'local' as const, root };
  await bindStorage({ pool, provider: blobStore, locator: blobStorageLocator, mode: 'new', stopped: true });
  return { blobStore, blobStorageLocator };
}
