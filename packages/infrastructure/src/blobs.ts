import { constants } from 'node:fs';
import { mkdir, open, link, unlink, readdir } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, sep } from 'node:path';
import { DomainError } from '../../domain/src/core.ts';

export const MAX_BLOB_BYTES = 8 * 1024 * 1024;
/** Project scope comes from an already-authorized application context, never an object key. */
export type BlobScope = { workspaceId: string; projectId: string; storageId?: string };
export type StoredBlob = { key: string; sha256: string; size: number; storageId?: string };
export type BlobStore = {
  init(): Promise<void>;
  check(): Promise<void>;
  put(bytes: Uint8Array, scope?: BlobScope): Promise<StoredBlob>;
  read(key: string, scope?: BlobScope): Promise<Buffer>;
};

const objectKey = /^sha256-([a-f0-9]{64})-([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.blob$/;
export function blobKeyDigest(key: string): string {
  const match = objectKey.exec(key);
  if (!match) throw new DomainError('invalid_blob_key');
  return match[1]!;
}
export function validateBlobBytes(bytes: Uint8Array): void {
  if (bytes.byteLength > MAX_BLOB_BYTES) throw new DomainError('upload_too_large', 'Maximum decoded upload size is 8 MiB', 413);
}
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const createFlags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

/** Linux local-volume adapter. Directory descriptors pin every path component. */
export class LocalBlobStore implements BlobStore {
  root: string;

  constructor(root: string) {
    if (!root.trim()) throw new DomainError('invalid_blob_root');
    this.root = resolve(root);
    if (this.root === sep) throw new DomainError('invalid_blob_root');
  }

  private async directory(create = false): Promise<FileHandle> {
    if (process.platform !== 'linux') throw new DomainError('blob_platform_unsupported', 'Local blob storage requires Linux directory descriptors', 503);
    let current = await open(sep, directoryFlags);
    try {
      for (const part of this.root.split(sep).filter(Boolean)) {
        const path = `/proc/self/fd/${current.fd}/${part}`;
        if (create) {
          try {
            await mkdir(path, { mode: 0o700 });
            await current.sync();
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          }
        }
        const next = await open(path, directoryFlags);
        await current.close();
        current = next;
      }
      return current;
    } catch (error) {
      await current.close().catch(() => undefined);
      throw new DomainError('blob_storage_unavailable', 'Blob directory is missing, unsafe, or inaccessible', 503);
    }
  }

  async init(): Promise<void> {
    const directory = await this.directory(true);
    await directory.close();
    await this.check();
  }

  async check(): Promise<void> {
    const directory = await this.directory();
    const probe = `/proc/self/fd/${directory.fd}/.check-${randomUUID()}`;
    let file: FileHandle | undefined;
    try {
      file = await open(probe, createFlags, 0o600);
      await file.sync();
      await file.close();
      file = undefined;
      await unlink(probe);
      await directory.sync();
    } catch {
      throw new DomainError('blob_storage_unavailable', 'Blob directory is not writable and durable', 503);
    } finally {
      await file?.close().catch(() => undefined);
      await unlink(probe).catch(() => undefined);
      await directory.close();
    }
  }

  async put(input: Uint8Array): Promise<StoredBlob> {
    validateBlobBytes(input);
    const bytes = Buffer.from(input);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    return this.publish(`sha256-${sha256}-${randomUUID()}.blob`, bytes, false);
  }

  /** Offline import only: preserve identity, adopt an existing object only after actual-byte verification. */
  async importVerifiedObject(key: string, bytes: Uint8Array): Promise<StoredBlob> {
    validateBlobBytes(bytes);
    if (createHash('sha256').update(bytes).digest('hex') !== blobKeyDigest(key)) throw new DomainError('blob_integrity_error', 'Import digest mismatch', 503);
    return this.publish(key, bytes, true);
  }

  private async publish(key: string, bytes: Uint8Array, adopt: boolean): Promise<StoredBlob> {
    const sha256 = blobKeyDigest(key);
    const directory = await this.directory();
    const prefix = `/proc/self/fd/${directory.fd}/`;
    const temporary = `${prefix}.pending-${randomUUID()}`;
    let file: FileHandle | undefined;
    try {
      file = await open(temporary, createFlags, 0o600);
      await file.writeFile(bytes);
      await file.sync();
      await file.close();
      file = undefined;
      // A hard link publishes atomically and never replaces an existing object.
      await link(temporary, `${prefix}${key}`);
      await unlink(temporary);
      await directory.sync();
      return { key, sha256, size: bytes.byteLength };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      if (adopt && error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        const existing = await this.read(key);
        if (!existing.equals(bytes)) throw new DomainError('blob_integrity_error', 'Import object conflicts with target', 503);
        return { key, sha256, size: bytes.byteLength };
      }
      throw new DomainError('blob_write_failed', 'Blob content could not be durably stored', 503);
    } finally {
      await file?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      await directory.close();
    }
  }

  async read(key: string): Promise<Buffer> {
    const expected = blobKeyDigest(key);
    const directory = await this.directory();
    let file: FileHandle | undefined;
    try {
      file = await open(`/proc/self/fd/${directory.fd}/${key}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BLOB_BYTES) throw new DomainError('blob_integrity_error', 'Blob is not a safe regular file', 503);
      // A bounded read also prevents concurrent external file growth consuming memory.
      const bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const result = await file.read(bytes, offset, bytes.length - offset, offset);
        if (result.bytesRead === 0) throw new DomainError('blob_integrity_error', 'Blob size changed', 503);
        offset += result.bytesRead;
      }
      const tail = await file.read(Buffer.alloc(1), 0, 1, bytes.length);
      if (tail.bytesRead !== 0 || createHash('sha256').update(bytes).digest('hex') !== expected) {
        throw new DomainError('blob_integrity_error', 'Blob digest verification failed', 503);
      }
      return bytes;
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError('blob_read_failed', 'Blob is missing, unsafe, or inaccessible', 503);
    } finally {
      await file?.close().catch(() => undefined);
      await directory.close();
    }
  }

  async objectExists(key: string): Promise<boolean> {
    blobKeyDigest(key);
    const directory = await this.directory();
    let file: FileHandle | undefined;
    try {
      file = await open(`/proc/self/fd/${directory.fd}/${key}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      return true;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
      throw new DomainError('blob_read_failed', 'Import target cannot be inspected', 503);
    } finally { await file?.close(); await directory.close(); }
  }

  async readMarker(): Promise<Buffer | null> {
    const directory = await this.directory();
    let file: FileHandle | undefined;
    try {
      file = await open(`/proc/self/fd/${directory.fd}/.pm-store.json`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096) throw new DomainError('blob_storage_binding_mismatch', 'Unsafe storage marker', 503);
      const bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const result = await file.read(bytes, offset, bytes.length - offset, offset);
        if (!result.bytesRead) throw new DomainError('blob_storage_binding_mismatch', 'Truncated storage marker', 503);
        offset += result.bytesRead;
      }
      if ((await file.read(Buffer.alloc(1), 0, 1, bytes.length)).bytesRead) throw new DomainError('blob_storage_binding_mismatch', 'Changed storage marker', 503);
      return bytes;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw new DomainError('blob_storage_binding_mismatch', 'Storage marker is unsafe or inaccessible', 503);
    } finally { await file?.close(); await directory.close(); }
  }

  async createMarker(bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength > 4096) throw new DomainError('blob_storage_binding_mismatch');
    const directory = await this.directory();
    const prefix = `/proc/self/fd/${directory.fd}/`;
    const temporary = `${prefix}.marker-${randomUUID()}`;
    let file: FileHandle | undefined;
    try {
      file = await open(temporary, createFlags, 0o600);
      await file.writeFile(bytes); await file.sync(); await file.close(); file = undefined;
      await link(temporary, `${prefix}.pm-store.json`);
      await unlink(temporary); await directory.sync();
    } catch { throw new DomainError('blob_storage_binding_mismatch', 'Storage marker already exists or cannot be created', 503); }
    finally { await file?.close(); await unlink(temporary).catch(() => undefined); await directory.close(); }
  }

  async listNamespace(): Promise<string[]> {
    const directory = await this.directory();
    try { return await readdir(`/proc/self/fd/${directory.fd}`); }
    finally { await directory.close(); }
  }

  close(): void { /* Local operations close their own descriptors. */ }
}
