import { createHash, randomUUID } from 'node:crypto';
import { Agent as HttpAgent, IncomingMessage } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { lookup } from 'node:dns';
import { S3Client, S3ServiceException, PutObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { DomainError } from '../../domain/src/core.ts';
import { blobKeyDigest, MAX_BLOB_BYTES, validateBlobBytes, type StoredBlob } from './blobs.ts';
import { isLoopback, readBlobStoreConfig, type S3BlobConfig } from './blob-storage-config.ts';
import type { BlobStorageProvider } from './blob-storage-admin.ts';

type SafeDiagnostic = { event: string; storeId: string | null; key: string; category: string; at: string; requestId?: string };
type StreamBody = AsyncIterable<Uint8Array> & { destroy?: () => void };
function status(error: unknown): number | undefined { return error instanceof S3ServiceException ? error.$metadata.httpStatusCode : undefined; }
function unavailable(code = 'blob_storage_unavailable'): DomainError { return new DomainError(code, 'Object storage request failed', 503); }

/** Real SigV4 SDK adapter. Business writes are conditional single PUTs, never multipart or retried. */
export class S3BlobStore implements BlobStorageProvider {
  private readonly client: S3Client;
  private readonly config: S3BlobConfig;
  private readonly uuid: () => string;
  private readonly diagnostic: (event: SafeDiagnostic) => void;
  private storeId: string | null = null;
  private health: Promise<void> | undefined;

  constructor(config: S3BlobConfig, dependencies: { uuid?: () => string; diagnostic?: (event: SafeDiagnostic) => void } = {}) {
    // Runtime callers (including direct .ts/JS consumers) cannot accidentally enable SDK credential discovery.
    const validated = readBlobStoreConfig({
      BLOB_PROVIDER: 's3', S3_ENDPOINT: config.endpoint, S3_REGION: config.region, S3_BUCKET: config.bucket, S3_PREFIX: config.prefix,
      S3_FORCE_PATH_STYLE: String(config.forcePathStyle), S3_TIMEOUT_MS: String(config.timeoutMs), S3_ENCRYPTION_MODE: config.encryptionMode,
      S3_ALLOW_INSECURE_LOOPBACK: String(config.allowInsecureLoopback),
      S3_ACCESS_KEY_ID: config.credentials?.accessKeyId, S3_SECRET_ACCESS_KEY: config.credentials?.secretAccessKey,
      ...(config.credentials?.sessionToken !== undefined ? { S3_SESSION_TOKEN: config.credentials.sessionToken } : {}),
      ...(config.expectedBucketOwner !== undefined ? { S3_EXPECTED_BUCKET_OWNER: config.expectedBucketOwner } : {}),
      ...(config.kmsKeyId !== undefined ? { S3_KMS_KEY_ID: config.kmsKeyId } : {}),
    });
    if (validated.provider !== 's3') throw new Error('Invalid blob storage configuration: BLOB_PROVIDER');
    config = validated;
    this.config = config;
    this.uuid = dependencies.uuid ?? randomUUID;
    this.diagnostic = dependencies.diagnostic ?? (event => console.error(JSON.stringify(event)));
    const httpAgent = new HttpAgent({ keepAlive: true, maxSockets: 16, lookup(hostname, options, callback) {
      lookup(hostname, options, (error, address, family) => {
        if (error) return callback(error, address, family);
        const addresses = Array.isArray(address) ? address.map(item => item.address) : [address];
        if (!addresses.every(isLoopback)) return callback(new Error('Insecure S3 endpoint is not loopback'), address, family);
        callback(null, address, family);
      });
    } });
    this.client = new S3Client({
      endpoint: config.endpoint, region: config.region, credentials: config.credentials,
      forcePathStyle: config.forcePathStyle, maxAttempts: 1, followRegionRedirects: false,
      requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
      requestHandler: { httpAgent, httpsAgent: new HttpsAgent({ keepAlive: true, maxSockets: 16 }), connectionTimeout: config.timeoutMs, socketTimeout: config.timeoutMs },
    });
    this.client.middlewareStack.add(next => async args => {
      const result = await next(args);
      const response = result.response;
      if (response && typeof response === 'object' && 'statusCode' in response && typeof response.statusCode === 'number' && response.statusCode >= 400 && 'body' in response && response.body instanceof IncomingMessage) {
        // Some S3 servers close rejected requests without Connection: close.
        // Consume the error normally, then retire its socket before another command can reuse it; never retry.
        const socket = response.body.socket;
        response.body.once('end', () => socket?.destroy());
      }
      return result;
    }, { step: 'deserialize', priority: 'low', name: 'retireRejectedResponseSocket' });
  }
  private owner() { return this.config.expectedBucketOwner ? { ExpectedBucketOwner: this.config.expectedBucketOwner } : {}; }
  private encryption() {
    return this.config.encryptionMode === 'bucket-default' ? {} : {
      ServerSideEncryption: this.config.encryptionMode,
      ...(this.config.kmsKeyId ? { SSEKMSKeyId: this.config.kmsKeyId } : {}),
    };
  }
  private path(key: string): string { blobKeyDigest(key); return `${this.config.prefix}/objects/${key}`; }
  private async deadline<T>(milliseconds: number, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), milliseconds);
    timeout.unref();
    try { return await action(controller.signal); }
    finally { clearTimeout(timeout); }
  }
  private async get(path: string, max: number, signal: AbortSignal): Promise<Buffer> {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: path, ...this.owner() }), { abortSignal: signal });
    const body = response.Body as StreamBody | undefined;
    try {
      const length = response.ContentLength;
      if (!Number.isSafeInteger(length) || length! < 0 || length! > max || !body || typeof body[Symbol.asyncIterator] !== 'function') throw unavailable('blob_integrity_error');
      const result = Buffer.alloc(length!);
      let offset = 0;
      for await (const chunk of body) {
        if (!(chunk instanceof Uint8Array) || chunk.byteLength > result.length - offset || signal.aborted) throw unavailable('blob_integrity_error');
        result.set(chunk, offset); offset += chunk.byteLength;
      }
      if (offset !== result.length || signal.aborted) throw unavailable('blob_integrity_error');
      return result;
    } finally { body?.destroy?.(); }
  }
  private async readWithSignal(key: string, signal: AbortSignal): Promise<Buffer> {
    const expected = blobKeyDigest(key);
    const bytes = await this.get(this.path(key), MAX_BLOB_BYTES, signal);
    if (createHash('sha256').update(bytes).digest('hex') !== expected) throw unavailable('blob_integrity_error');
    return bytes;
  }
  async read(key: string): Promise<Buffer> {
    blobKeyDigest(key);
    try { return await this.deadline(this.config.timeoutMs, signal => this.readWithSignal(key, signal)); }
    catch (error) { if (error instanceof DomainError) throw error; throw unavailable('blob_read_failed'); }
  }
  async init(): Promise<void> { await this.check(); }
  async check(milliseconds = 2000): Promise<void> {
    if (this.health) return this.health;
    this.health = this.deadline(Math.min(milliseconds, 2000), async signal => {
      const bytes = Buffer.from(randomUUID());
      const path = `${this.config.prefix}/_pm/health/write-probe`;
      await this.client.send(new PutObjectCommand({ Bucket: this.config.bucket, Key: path, Body: bytes, ContentLength: bytes.length, ChecksumSHA256: createHash('sha256').update(bytes).digest('base64'), ...this.owner(), ...this.encryption() }), { abortSignal: signal });
      if (!(await this.get(path, 128, signal)).equals(bytes)) throw unavailable('blob_integrity_error');
    }).catch(() => { throw unavailable(); }).finally(() => { this.health = undefined; });
    return this.health;
  }
  async put(input: Uint8Array): Promise<StoredBlob> {
    validateBlobBytes(input);
    // Snapshot caller-owned memory once before asynchronous network I/O, matching Local.
    const bytes = Buffer.from(input);
    const hash = createHash('sha256').update(bytes).digest();
    const key = `sha256-${hash.toString('hex')}-${this.uuid()}.blob`;
    return this.write(key, bytes, hash, false);
  }
  async importVerifiedObject(key: string, bytes: Uint8Array): Promise<StoredBlob> {
    validateBlobBytes(bytes);
    const hash = createHash('sha256').update(bytes).digest();
    if (hash.toString('hex') !== blobKeyDigest(key)) throw unavailable('blob_integrity_error');
    return this.write(key, bytes, hash, true);
  }
  private async write(key: string, bytes: Uint8Array, hash: Buffer, adopt: boolean): Promise<StoredBlob> {
    const path = this.path(key);
    const stored = { key, sha256: hash.toString('hex'), size: bytes.byteLength };
    this.diagnostic({ event: 'blob_write_candidate', storeId: this.storeId, key, category: adopt ? 'offline_import' : 'conditional_put', at: new Date().toISOString() });
    try {
      await this.deadline(this.config.timeoutMs, async signal => {
        await this.client.send(new PutObjectCommand({ Bucket: this.config.bucket, Key: path, Body: bytes, ContentLength: bytes.byteLength, ChecksumSHA256: hash.toString('base64'), IfNoneMatch: '*', ...this.owner(), ...this.encryption() }), { abortSignal: signal });
        const actual = await this.readWithSignal(key, signal);
        if (actual.length !== stored.size) throw unavailable('blob_integrity_error');
      });
      return stored;
    } catch (error) {
      if (status(error) === 412 && !adopt) throw unavailable('blob_key_conflict');
      // Only this candidate is reconciled. No second UUID, re-PUT, alternate provider or implicit retry.
      try {
        await this.deadline(this.config.timeoutMs, async signal => {
          const head = await this.client.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: path, ...this.owner() }), { abortSignal: signal });
          if (head.ContentLength !== stored.size) throw unavailable('blob_integrity_error');
          const actual = await this.readWithSignal(key, signal);
          if (actual.length !== stored.size) throw unavailable('blob_integrity_error');
        });
        return stored;
      } catch {
        const requestId = error instanceof S3ServiceException ? error.$metadata.requestId : undefined;
        this.diagnostic({ event: 'blob_write_outcome_unknown', storeId: this.storeId, key, category: status(error) ? `http_${status(error)}` : 'transport_or_verification', at: new Date().toISOString(), ...(requestId ? { requestId } : {}) });
        throw unavailable('blob_write_outcome_unknown');
      }
    }
  }
  async readMarker(milliseconds = this.config.timeoutMs): Promise<Buffer | null> {
    try {
      const bytes = await this.deadline(milliseconds, signal => this.get(`${this.config.prefix}/_pm/store.json`, 4096, signal));
      try {
        const marker: unknown = JSON.parse(bytes.toString('utf8'));
        this.storeId = marker && typeof marker === 'object' && 'storeId' in marker && typeof marker.storeId === 'string' && /^[0-9a-f-]{36}$/.test(marker.storeId) ? marker.storeId : null;
      } catch { this.storeId = null; }
      return bytes;
    } catch (error) { if (status(error) === 404) return null; throw unavailable('blob_storage_binding_mismatch'); }
  }
  async createMarker(bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength > 4096) throw unavailable('blob_storage_binding_mismatch');
    try {
      await this.deadline(this.config.timeoutMs, async signal => {
        try {
          await this.client.send(new PutObjectCommand({ Bucket: this.config.bucket, Key: `${this.config.prefix}/_pm/store.json`, Body: bytes, ContentLength: bytes.byteLength, ChecksumSHA256: createHash('sha256').update(bytes).digest('base64'), IfNoneMatch: '*', ...this.owner(), ...this.encryption() }), { abortSignal: signal });
        } catch (error) {
          if (status(error) === 412) throw error;
          // Lost marker response may be accepted only for the identical explicit initialization attempt.
          if (!(await this.get(`${this.config.prefix}/_pm/store.json`, 4096, signal)).equals(bytes)) throw error;
        }
      });
    } catch { throw unavailable('blob_storage_binding_mismatch'); }
  }
  async listNamespace(): Promise<string[]> {
    const result: string[] = [];
    let token: string | undefined;
    do {
      const page = await this.deadline(this.config.timeoutMs, signal => this.client.send(new ListObjectsV2Command({ Bucket: this.config.bucket, Prefix: `${this.config.prefix}/`, ...(token ? { ContinuationToken: token } : {}), ...this.owner() }), { abortSignal: signal }));
      for (const object of page.Contents ?? []) if (object.Key) result.push(object.Key.slice(this.config.prefix.length + 1));
      if (page.IsTruncated && (!page.NextContinuationToken || page.NextContinuationToken === token)) throw unavailable();
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return result;
  }
  async objectExists(key: string): Promise<boolean> {
    const path = this.path(key);
    try {
      await this.deadline(this.config.timeoutMs, signal => this.client.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: path, ...this.owner() }), { abortSignal: signal }));
      return true;
    } catch (error) {
      if (status(error) === 404) return false;
      throw unavailable('blob_read_failed');
    }
  }
  close(): void { this.client.destroy(); }
}
