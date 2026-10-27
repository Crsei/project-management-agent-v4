import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { S3Client, S3ServiceException, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { S3BlobStore } from '../packages/infrastructure/src/s3-blobs.ts';
import { MAX_BLOB_BYTES } from '../packages/infrastructure/src/blobs.ts';
import { s3StorageFixture, s3FaultProxy, s3FixtureConfigured } from './s3-storage-fixture.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPool, migrate } from '../packages/infrastructure/src/database.ts';
import { createUser, createWorkspace } from '../packages/infrastructure/src/auth.ts';
import { LocalBlobStore } from '../packages/infrastructure/src/blobs.ts';
import { blobStorageLocator } from '../packages/infrastructure/src/blob-storage-config.ts';
import { bindBlobStore } from '../packages/infrastructure/src/blob-storage-binding.ts';
import { bindStorage, createMigrationManifest, migrateStorage, verifyStorageMigration, activateStorage } from '../packages/infrastructure/src/blob-storage-maintenance.ts';
import { createBlobStore } from '../packages/infrastructure/src/blob-storage-provider.ts';

const required = process.env.PM_REQUIRE_S3_TESTS === 'true';
test('requested S3 protocol acceptance requires a real isolated fixture, never a skipped success', { skip: !required }, () => {
  assert.ok(s3FixtureConfigured, 'Set PM_S3_TEST_MINIO_BINARY or explicit TEST_S3_ENDPOINT/test credentials');
  assert.ok(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL, 'Real isolated PostgreSQL is also required for the provider-binding acceptance matrix');
});
test('real S3 provider preserves 0/1/8MiB bytes, independent identities, restart and single conditional PUT headers', { skip: !s3FixtureConfigured }, async t => {
  const f = await s3StorageFixture(t);
  const provider = new S3BlobStore(f.config, { diagnostic() {} }); t.after(() => provider.close());
  await provider.init();
  for (const size of [0, 1, MAX_BLOB_BYTES]) {
    const bytes = Buffer.alloc(size, 131); const stored = await provider.put(bytes);
    assert.equal(stored.size, size); assert.deepEqual(await provider.read(stored.key), bytes);
    const restarted = new S3BlobStore(f.config, { diagnostic() {} });
    try { assert.deepEqual(await restarted.read(stored.key), bytes); } finally { restarted.close(); }
    const repeated = await provider.put(bytes); assert.notEqual(repeated.key, stored.key);
  }
  await assert.rejects(provider.put(Buffer.alloc(MAX_BLOB_BYTES + 1)), { code: 'upload_too_large' });
  const concurrent = await Promise.all(Array.from({ length: 20 }, (_, index) => provider.put(Buffer.from(`real object ${index}`))));
  assert.equal(new Set(concurrent.map(item => item.key)).size, 20);
  for (const [index, item] of concurrent.entries()) assert.equal((await provider.read(item.key)).toString(), `real object ${index}`);
  const existing = concurrent[0]!;
  const anonymous = await fetch(`${f.config.endpoint}/${f.config.bucket}/${f.config.prefix}/objects/${existing.key}`);
  assert.ok([403, 404].includes(anonymous.status), `Anonymous existing-object GET must be denied, got ${anonymous.status}`);
  const list = await fetch(`${f.config.endpoint}/${f.config.bucket}?list-type=2&prefix=${f.config.prefix}`);
  assert.ok([403, 404].includes(list.status));
});
test('real conditional conflict never adopts an existing identity and offline import explicitly verifies exact bytes', { skip: !s3FixtureConfigured }, async t => {
  const f = await s3StorageFixture(t); const uuid = randomUUID();
  const provider = new S3BlobStore(f.config, { uuid: () => uuid, diagnostic() {} }); t.after(() => provider.close());
  const client = Reflect.get(provider, 'client'); assert.ok(client instanceof S3Client);
  const protocol: string[] = []; const requestedKeys = new Set<unknown>();
  client.middlewareStack.add((next, context) => async args => {
    requestedKeys.add(Reflect.get(args.input, 'Key'));
    if (context.commandName === 'PutObjectCommand') assert.equal(Reflect.get(args.input, 'IfNoneMatch'), '*');
    try {
      const result = await next(args);
      assert.equal(result.output.$metadata.attempts, 1);
      protocol.push(`${context.commandName}:${result.output.$metadata.httpStatusCode}`);
      return result;
    } catch (error) {
      if (error instanceof S3ServiceException) assert.equal(error.$metadata.attempts, 1);
      protocol.push(`${context.commandName}:${error instanceof S3ServiceException ? error.$metadata.httpStatusCode : 'transport_error'}`);
      throw error;
    }
  }, { step: 'initialize', name: 'recordConditionalConflictProtocol' });
  const stored = await provider.put(Buffer.from('immutable original'));
  await assert.rejects(provider.put(Buffer.from('immutable original')), { code: 'blob_key_conflict' });
  assert.deepEqual(protocol.filter(value => value.startsWith('PutObjectCommand:')), ['PutObjectCommand:200', 'PutObjectCommand:412']);
  // No delay, restart or retry may hide a rejected PUT leaving an unusable pooled socket.
  assert.equal((await provider.read(stored.key)).toString(), 'immutable original');
  assert.deepEqual(await provider.importVerifiedObject(stored.key, Buffer.from('immutable original')), stored);
  assert.deepEqual(protocol.filter(value => value.startsWith('PutObjectCommand:')), ['PutObjectCommand:200', 'PutObjectCommand:412', 'PutObjectCommand:412']);
  assert.deepEqual([...requestedKeys], [`${f.config.prefix}/objects/${stored.key}`]);
  const beforeInvalidImport = protocol.length;
  await assert.rejects(provider.importVerifiedObject(stored.key, Buffer.from('different bytes')), { code: 'blob_integrity_error' });
  assert.equal(protocol.length, beforeInvalidImport);
  await f.admin.send(new PutObjectCommand({ Bucket: f.config.bucket, Key: `${f.config.prefix}/objects/${stored.key}`, Body: Buffer.from('admin corruption') }));
  await assert.rejects(provider.read(stored.key), { code: 'blob_integrity_error' });
  await assert.rejects(provider.read(`sha256-${'a'.repeat(64)}-${randomUUID()}.blob`), { code: 'blob_read_failed' });
});
test('real forwarded PUT response loss reconciles only the original candidate; unreadable outcomes never replay PUT', { skip: !s3FixtureConfigured }, async t => {
  const f = await s3StorageFixture(t);
  if (!f.config.endpoint.startsWith('http://127.')) throw new Error('Run fault acceptance against isolated loopback MinIO');
  const proxy = await s3FaultProxy(t, f.config.endpoint);
  const diagnostics: { event: string; key: string }[] = [];
  const provider = new S3BlobStore({ ...f.config, endpoint: proxy.endpoint }, { diagnostic(event) { diagnostics.push(event); } }); t.after(() => provider.close());
  proxy.setFault('lose-put-response');
  const recovered = await provider.put(Buffer.from('stored once despite lost PUT response'));
  const writes = proxy.requests.filter(item => item.method === 'PUT' && item.path.includes('/objects/'));
  assert.equal(writes.length, 1); assert.equal(writes[0]!.conditional, '*'); assert.ok(writes[0]!.checksum);
  assert.ok(proxy.requests.filter(item => ['HEAD', 'GET'].includes(item.method) && item.path.includes('/objects/')).every(item => item.path.includes(recovered.key)));
  proxy.setFault('lose-put-and-get');
  await assert.rejects(provider.put(Buffer.from('orphan may exist; no business success')), { code: 'blob_write_outcome_unknown' });
  assert.equal(proxy.requests.filter(item => item.method === 'PUT' && item.path.includes('/objects/')).length, 2);
  const unknown = diagnostics.findLast(item => item.event === 'blob_write_outcome_unknown'); assert.ok(unknown);
  assert.ok((await f.admin.send(new HeadObjectCommand({ Bucket: f.config.bucket, Key: `${f.config.prefix}/objects/${unknown.key}` }))).ContentLength);
  proxy.setFault('none'); assert.equal((await provider.read(unknown.key)).toString(), 'orphan may exist; no business success');
  const before = proxy.requests.length;
  await assert.rejects(provider.read('../not-a-key'), { code: 'invalid_blob_key' });
  await assert.rejects(provider.put(Buffer.alloc(MAX_BLOB_BYTES + 1)), { code: 'upload_too_large' });
  assert.equal(proxy.requests.length, before);
  proxy.setFault('reject-put-409');
  await assert.rejects(provider.put(Buffer.from('409 is not an invitation to retry')), { code: 'blob_write_outcome_unknown' });
  assert.equal(proxy.requests.filter(item => item.method === 'PUT' && item.path.includes('/objects/')).length, 3);
});
test('real response streaming rejects missing lengths, oversized declarations, corruption and interrupted bodies', { skip: !s3FixtureConfigured }, async t => {
  const f = await s3StorageFixture(t); const proxy = await s3FaultProxy(t, f.config.endpoint);
  const provider = new S3BlobStore({ ...f.config, endpoint: proxy.endpoint }, { diagnostic() {} }); t.after(() => provider.close());
  const stored = await provider.put(Buffer.from('actual response stream must be checked'));
  for (const fault of ['missing-length', 'oversized-length', 'corrupt-get', 'truncated-get'] as const) {
    proxy.setFault(fault);
    await assert.rejects(provider.read(stored.key), (error: unknown) => error instanceof Error && 'code' in error && ['blob_integrity_error', 'blob_read_failed'].includes(String(error.code)));
  }
  proxy.setFault('none'); assert.equal((await provider.read(stored.key)).toString(), 'actual response stream must be checked');
});

test('real Local to S3 migration preserves SQL referenced keys and wrong prefix never becomes readable', { skip: !s3FixtureConfigured || !(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL) }, async t => {
  const f = await s3StorageFixture(t);
  const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  const namespace = `test_s3_binding_${randomUUID().replaceAll('-', '')}`;
  const bootstrap = createPool(databaseUrl!); await bootstrap.query(`CREATE SCHEMA "${namespace}"`);
  const scoped = new URL(databaseUrl!); scoped.searchParams.set('options', `-c search_path=${namespace},public`);
  const pool = createPool(scoped.toString()); const root = await mkdtemp(join(tmpdir(), 'pm-s3-source-'));
  t.after(async () => { await pool.end(); await bootstrap.query(`DROP SCHEMA "${namespace}" CASCADE`); await bootstrap.end(); await rm(root, { recursive: true, force: true }); });
  await migrate(pool);
  const source = { provider: new LocalBlobStore(root), locator: { provider: 'local' as const, root } };
  await bindStorage({ pool, ...source, mode: 'new', stopped: true });
  const actor = await createUser(pool, { email: 's3-binding@example.test', name: 'Isolated S3 test', password: 'isolated-s3-test-password' });
  const workspace = await createWorkspace(pool, actor.id, 'Storage protocol');
  const original = await source.provider.put(Buffer.from('expired uploads remain referenced across provider cutover'));
  await pool.query("INSERT INTO entities(id,workspace_id,project_id,kind,data,created_by) VALUES($1,$2,'PRJ-001','upload',$3,$4)", [randomUUID(), workspace.id, { objectKey: original.key, sha256: original.sha256, size: original.size, ownerId: actor.id, expiresAt: '2000-01-01T00:00:00.000Z', consumedAt: null, consumedByArtifactVersionId: null }, actor.id]);
  const provider = new S3BlobStore(f.config, { diagnostic() {} }); t.after(() => provider.close());
  const locator = blobStorageLocator(f.config)!; const target = { provider, locator };
  const manifest = await createMigrationManifest({ pool, source, target, expectedEpoch: '1', stopped: true, databaseDumpSha256: 'a'.repeat(64), coreManifestSha256: 'b'.repeat(64) });
  await migrateStorage({ pool, source, target, manifest, stopped: true });
  const digest = await verifyStorageMigration({ pool, target, manifest, stopped: true });
  await activateStorage({ pool, target, manifest, expectedManifestSha256: digest, stopped: true });
  assert.equal((await bindBlobStore(pool, locator, provider).read(original.key)).toString(), 'expired uploads remain referenced across provider cutover');
  const wrongConfig = { ...f.config, prefix: `${f.config.prefix}-wrong` };
  const wrong = new S3BlobStore(wrongConfig, { diagnostic() {} }); t.after(() => wrong.close());
  await wrong.importVerifiedObject(original.key, Buffer.from('expired uploads remain referenced across provider cutover'));
  await assert.rejects(bindBlobStore(pool, blobStorageLocator(wrongConfig)!, wrong).read(original.key), { code: 'blob_storage_binding_mismatch' });
  await assert.rejects(bindBlobStore(pool, source.locator, source.provider).read(original.key), { code: 'blob_storage_binding_mismatch' });
});

test('empty S3 installation executes complete factory to explicit SQL bind before any business user exists', { skip: !s3FixtureConfigured || !(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL) }, async t => {
  const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  const namespace = `test_s3_new_bind_${randomUUID().replaceAll('-', '')}`;
  const bootstrap = createPool(databaseUrl!); await bootstrap.query(`CREATE SCHEMA "${namespace}"`);
  const scoped = new URL(databaseUrl!); scoped.searchParams.set('options', `-c search_path=${namespace},public`);
  const pool = createPool(scoped.toString());
  t.after(async () => { await pool.end(); await bootstrap.query(`DROP SCHEMA "${namespace}" CASCADE`); await bootstrap.end(); });
  await migrate(pool);
  const fixture = await s3StorageFixture(t);
  const provider = createBlobStore(fixture.config); t.after(() => provider.close());
  const client = Reflect.get(provider, 'client');
  assert.ok(client instanceof S3Client);
  client.middlewareStack.add((next, context) => async args => {
    try { return await next(args); }
    catch (error) {
      t.diagnostic(JSON.stringify({ operation: context.commandName, name: error instanceof Error ? error.name : 'UnknownError', status: error instanceof S3ServiceException ? error.$metadata.httpStatusCode : undefined }));
      throw error;
    }
  }, { step: 'initialize', name: 'safeNewInstallationProtocolDiagnostic' });
  const locator = blobStorageLocator(fixture.config)!;
  assert.equal((await pool.query<{ count: string }>('SELECT count(*)::text FROM users')).rows[0]!.count, '0');
  const binding = await bindStorage({ pool, provider, locator, mode: 'new', stopped: true });
  assert.equal(binding.provider, 's3'); assert.equal(binding.state, 'active'); assert.equal(binding.epoch, '1');
  assert.equal((await pool.query<{ count: string }>('SELECT count(*)::text FROM blob_storage_binding')).rows[0]!.count, '1');
  assert.equal((await pool.query<{ count: string }>('SELECT count(*)::text FROM users')).rows[0]!.count, '0');
  const guarded = bindBlobStore(pool, locator, provider); await guarded.init(); await guarded.check();
  const bytes = Buffer.from('real new S3 binding guards real immutable bytes');
  const stored = await guarded.put(bytes); assert.deepEqual(await guarded.read(stored.key), bytes);
});
