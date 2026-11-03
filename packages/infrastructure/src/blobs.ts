import type { FileHandle } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { parse, resolve } from 'node:path';
import { DomainError } from '../../domain/src/core.ts';
import { SafeDirectory, exclusiveFileFlags, readOnlyFileFlags } from './portable-directory.ts';

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

/** Local-volume adapter: pinned Linux descriptors, checked private roots on macOS/Windows. */
export class LocalBlobStore implements BlobStore {
  root: string;
  private identity: { dev: bigint; ino: bigint } | undefined;

  constructor(root: string) {
    if (!root.trim()) throw new DomainError('invalid_blob_root');
    this.root = resolve(root);
    if (this.root === parse(this.root).root) throw new DomainError('invalid_blob_root');
  }

  private async directory(create = false): Promise<SafeDirectory> {
    let directory: SafeDirectory | undefined;
    try {
      directory = await SafeDirectory.open(this.root, create && !this.identity);
      const identity = await directory.identity();
      if (this.identity && (identity.dev !== this.identity.dev || identity.ino !== this.identity.ino)) throw new Error('Blob root identity changed');
      this.identity = identity;
      return directory;
    } catch {
      await directory?.close();
      throw new DomainError('blob_storage_unavailable', 'Blob directory is missing, unsafe, replaced, or inaccessible', 503);
    }
  }

  async init(): Promise<void> {
    const directory = await this.directory(true);
    await directory.close();
    await this.check();
  }

  async check(): Promise<void> {
    const directory = await this.directory();
    const probe = `.check-${randomUUID()}`;
    let file: FileHandle | undefined;
    try {
      file = await directory.openFile(probe, exclusiveFileFlags);
      await file.sync();
      await file.close();
      file = undefined;
      await directory.unlink(probe);
      await directory.sync();
    } catch {
      throw new DomainError('blob_storage_unavailable', 'Blob directory is not writable and durable', 503);
    } finally {
      await file?.close().catch(() => undefined);
      await directory.unlink(probe).catch(() => undefined);
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
    const temporary = `.pending-${randomUUID()}`;
    let file: FileHandle | undefined;
    try {
      file = await directory.openFile(temporary, exclusiveFileFlags);
      await file.writeFile(bytes);
      await file.sync();
      // Keep the flushed descriptor open until create-exclusive publication verifies identity.
      await directory.publish(temporary, key, file);
      await file.close();
      file = undefined;
      return { key, sha256, size: bytes.byteLength };
    } catch (error) {
      if (error instanceof DomainError && error.code !== 'blob_checkpoint_unsafe') throw error;
      if (adopt && error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        const existing = await this.read(key);
        if (!existing.equals(bytes)) throw new DomainError('blob_integrity_error', 'Import object conflicts with target', 503);
        return { key, sha256, size: bytes.byteLength };
      }
      throw new DomainError('blob_write_failed', 'Blob content could not be durably stored', 503);
    } finally {
      await file?.close().catch(() => undefined);
      await directory.unlink(temporary).catch(() => undefined);
      await directory.close();
    }
  }

  async read(key: string): Promise<Buffer> {
    const expected = blobKeyDigest(key);
    const directory = await this.directory();
    let file: FileHandle | undefined;
    try {
      file = await directory.openFile(key, readOnlyFileFlags);
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
      await directory.assertFile(key, file);
      return bytes;
    } catch (error) {
      if (error instanceof DomainError && error.code === 'blob_integrity_error') throw error;
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
      file = await directory.openFile(key, readOnlyFileFlags);
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BLOB_BYTES) throw new DomainError('blob_integrity_error', 'Import target is not a safe regular file', 503);
      await directory.assertFile(key, file);
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
      file = await directory.openFile('.pm-store.json', readOnlyFileFlags);
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
      await directory.assertFile('.pm-store.json', file);
      return bytes;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw new DomainError('blob_storage_binding_mismatch', 'Storage marker is unsafe or inaccessible', 503);
    } finally { await file?.close(); await directory.close(); }
  }

  async createMarker(bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength > 4096) throw new DomainError('blob_storage_binding_mismatch');
    const directory = await this.directory();
    const temporary = `.marker-${randomUUID()}`;
    let file: FileHandle | undefined;
    try {
      file = await directory.openFile(temporary, exclusiveFileFlags);
      await file.writeFile(bytes); await file.sync();
      await directory.publish(temporary, '.pm-store.json', file);
      await file.close(); file = undefined;
    } catch { throw new DomainError('blob_storage_binding_mismatch', 'Storage marker already exists or cannot be created', 503); }
    finally { await file?.close(); await directory.unlink(temporary).catch(() => undefined); await directory.close(); }
  }

  async listNamespace(): Promise<string[]> {
    const directory = await this.directory();
    try { return (await directory.entries()).map(entry => entry.name); }
    finally { await directory.close(); }
  }

  close(): void { /* Local operations close their own descriptors. */ }
}
