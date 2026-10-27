import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, request, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { TestContext } from 'node:test';
import { S3Client, S3ServiceException, BucketLocationConstraint, HeadBucketCommand, CreateBucketCommand, ListObjectsV2Command, DeleteObjectsCommand, DeleteBucketCommand } from '@aws-sdk/client-s3';
import { readBlobStoreConfig, type S3BlobConfig } from '../packages/infrastructure/src/blob-storage-config.ts';

async function listen(server: Server): Promise<number> {
  const listening = once(server, 'listening'); server.listen(0, '127.0.0.1'); await listening;
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Owned fixture did not listen');
  return address.port;
}
export const s3FixtureConfigured = Boolean(process.env.PM_S3_TEST_MINIO_BINARY || process.env.TEST_S3_ENDPOINT);
/** Only explicit TEST_S3_* credentials or a newly owned MinIO process; never application env credentials. */
export async function s3StorageFixture(t: TestContext): Promise<{ config: S3BlobConfig; admin: S3Client }> {
  const cleanup: (() => Promise<void>)[] = [];
  t.after(async () => {
    const errors: unknown[] = [];
    for (const action of cleanup.reverse()) { try { await action(); } catch (error) { errors.push(error); } }
    if (errors.length) throw new AggregateError(errors, 'Owned S3 fixture cleanup failed');
  });
  let owned: ChildProcess | undefined;
  let temporary: string | undefined;
  let endpoint = process.env.TEST_S3_ENDPOINT;
  let accessKeyId = process.env.TEST_S3_ACCESS_KEY_ID;
  let secretAccessKey = process.env.TEST_S3_SECRET_ACCESS_KEY;
  if (process.env.PM_S3_TEST_MINIO_BINARY) {
    if (endpoint) throw new Error('Choose either newly owned MinIO or explicit test endpoint');
    temporary = await mkdtemp(join(tmpdir(), 'pm-minio-isolated-'));
    const portReservation = createServer(); const port = await listen(portReservation); const reservationClosed = once(portReservation, 'close'); portReservation.close(); await reservationClosed;
    accessKeyId = `pm${randomBytes(12).toString('hex')}`; secretAccessKey = randomBytes(32).toString('hex');
    endpoint = `http://127.0.0.1:${port}`;
    owned = spawn(process.env.PM_S3_TEST_MINIO_BINARY, ['server', '--address', `127.0.0.1:${port}`, '--console-address', '127.0.0.1:0', temporary], { env: { ...process.env, MINIO_ROOT_USER: accessKeyId, MINIO_ROOT_PASSWORD: secretAccessKey }, stdio: 'ignore' });
    let spawnError = false; owned.once('error', () => { spawnError = true; });
    cleanup.push(async () => {
      if (owned?.pid && owned.exitCode === null) { const exit = once(owned, 'exit'); owned.kill('SIGTERM'); await exit; }
      if (temporary) await rm(temporary, { recursive: true, force: true });
    });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (spawnError || owned.exitCode !== null) throw new Error('Owned MinIO fixture failed to start');
      try { ready = (await fetch(`${endpoint}/minio/health/ready`, { signal: AbortSignal.timeout(1000) })).ok; } catch { /* Startup, not a storage success. */ }
      if (ready) break; await delay(100);
    }
    if (!ready) throw new Error('Owned MinIO fixture never became ready');
  }
  if (!endpoint || !accessKeyId || !secretAccessKey) throw new Error('Explicit isolated S3 test endpoint and test credentials, or PM_S3_TEST_MINIO_BINARY, are required');
  const bucket = `pm-s3-test-${randomUUID()}`;
  const config = readBlobStoreConfig({ BLOB_PROVIDER: 's3', S3_ENDPOINT: endpoint, S3_REGION: process.env.TEST_S3_REGION ?? 'us-east-1', S3_BUCKET: bucket, S3_PREFIX: `run-${randomUUID()}`, S3_FORCE_PATH_STYLE: 'true', S3_ALLOW_INSECURE_LOOPBACK: 'true', S3_TIMEOUT_MS: '1000', S3_ACCESS_KEY_ID: accessKeyId, S3_SECRET_ACCESS_KEY: secretAccessKey, ...(process.env.TEST_S3_SESSION_TOKEN ? { S3_SESSION_TOKEN: process.env.TEST_S3_SESSION_TOKEN } : {}), ...(process.env.TEST_S3_EXPECTED_BUCKET_OWNER ? { S3_EXPECTED_BUCKET_OWNER: process.env.TEST_S3_EXPECTED_BUCKET_OWNER } : {}) });
  if (config.provider !== 's3') throw new Error('S3 fixture config mismatch');
  const admin = new S3Client({ endpoint: config.endpoint, region: config.region, credentials: config.credentials, forcePathStyle: true, maxAttempts: 1 });
  try {
    if (owned) {
      // MinIO's HTTP /health/ready can precede object-layer initialization.
      // Only a real authenticated 404 for our not-yet-created random bucket crosses this barrier.
      let initialized = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          await admin.send(new HeadBucketCommand({ Bucket: bucket }), { abortSignal: AbortSignal.timeout(1000) });
          throw new Error('Owned random test bucket unexpectedly exists');
        } catch (error) {
          const status = error instanceof S3ServiceException ? error.$metadata.httpStatusCode : undefined;
          if (status === 404) { initialized = true; break; }
          const startingTransport = error instanceof Error && (['AbortError', 'TimeoutError'].includes(error.name) || ('code' in error && ['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT'].includes(String(error.code))));
          if (status !== 503 && !startingTransport) throw error;
        }
        await delay(100);
      }
      if (!initialized) throw new Error('Owned MinIO S3 object layer did not initialize');
    }
    const location = Object.values(BucketLocationConstraint).find(value => value === config.region);
    if (config.region !== 'us-east-1' && !location) throw new Error('Unsupported isolated test bucket region');
    // Exactly one bucket creation; never replay an unknown external write.
    await admin.send(new CreateBucketCommand({ Bucket: bucket, ...(location ? { CreateBucketConfiguration: { LocationConstraint: location } } : {}) }));
  } catch (error) { admin.destroy(); throw error; }
  cleanup.push(async () => {
    try {
      let continuation: string | undefined;
      do {
        const page = await admin.send(new ListObjectsV2Command({ Bucket: bucket, ...(continuation ? { ContinuationToken: continuation } : {}) }));
        const objects = (page.Contents ?? []).flatMap(item => item.Key ? [{ Key: item.Key }] : []);
        if (objects.length) await admin.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } }));
        continuation = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (continuation);
      await admin.send(new DeleteBucketCommand({ Bucket: bucket }));
    } finally { admin.destroy(); }
  });
  return { config, admin };
}
export type S3ProxyFault = 'none' | 'lose-put-response' | 'lose-put-and-get' | 'corrupt-get' | 'missing-length' | 'truncated-get' | 'oversized-length' | 'reject-put-409';
export async function s3FaultProxy(t: TestContext, endpoint: string) {
  const target = new URL(endpoint);
  if (target.protocol !== 'http:') throw new Error('Fault proxy is loopback MinIO-only, not a production TLS interception facility');
  let fault: S3ProxyFault = 'none';
  const requests: { method: string; path: string; conditional: string | undefined; checksum: string | undefined }[] = [];
  const server = createServer((incoming, outgoing) => {
    const object = incoming.url?.includes('/objects/') ?? false;
    requests.push({ method: incoming.method ?? '', path: incoming.url ?? '', conditional: typeof incoming.headers['if-none-match'] === 'string' ? incoming.headers['if-none-match'] : undefined, checksum: typeof incoming.headers['x-amz-checksum-sha256'] === 'string' ? incoming.headers['x-amz-checksum-sha256'] : undefined });
    if (object && incoming.method === 'PUT' && fault === 'reject-put-409') { outgoing.writeHead(409, { 'content-type': 'application/xml' }); outgoing.end('<Error><Code>ConditionalRequestConflict</Code></Error>'); incoming.resume(); return; }
    const upstream = request({ hostname: target.hostname, port: target.port, method: incoming.method, path: incoming.url, headers: incoming.headers }, response => {
      const successful = (response.statusCode ?? 500) < 300;
      if (object && successful && incoming.method === 'PUT' && ['lose-put-response', 'lose-put-and-get'].includes(fault)) { response.resume(); response.once('end', () => outgoing.destroy()); return; }
      if (object && successful && incoming.method === 'GET' && fault === 'lose-put-and-get') { response.resume(); outgoing.destroy(); return; }
      if (object && successful && incoming.method === 'GET' && ['corrupt-get', 'missing-length', 'truncated-get', 'oversized-length'].includes(fault)) {
        const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(Buffer.from(chunk))); response.once('end', () => {
          const body = Buffer.concat(chunks); const headers = { ...response.headers };
          delete headers['x-amz-checksum-sha256']; delete headers['x-amz-checksum-crc32'];
          if (fault === 'missing-length') { delete headers['content-length']; headers['transfer-encoding'] = 'chunked'; }
          if (fault === 'oversized-length') headers['content-length'] = String(8 * 1024 * 1024 + 1);
          outgoing.writeHead(response.statusCode!, headers);
          if (fault === 'corrupt-get' && body.length) body[0] = body[0]! ^ 255;
          if (fault === 'truncated-get') { outgoing.write(body.subarray(0, Math.max(0, body.length - 1))); outgoing.destroy(); }
          else outgoing.end(body);
        }); return;
      }
      outgoing.writeHead(response.statusCode ?? 502, response.headers); response.pipe(outgoing);
    });
    upstream.once('error', () => outgoing.destroy()); incoming.pipe(upstream);
    outgoing.once('close', () => upstream.destroy());
  });
  const port = await listen(server);
  t.after(async () => { const closed = once(server, 'close'); server.closeAllConnections(); server.close(); await closed; });
  return { endpoint: `http://127.0.0.1:${port}`, requests, setFault(next: S3ProxyFault) { fault = next; } };
}
