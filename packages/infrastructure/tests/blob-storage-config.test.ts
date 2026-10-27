import test from 'node:test';
import assert from 'node:assert/strict';
import { readBlobStoreConfig, blobStorageLocator, locatorSha256 } from '../src/blob-storage-config.ts';
import { createBlobStore } from '../src/blob-storage-provider.ts';

const s3 = { BLOB_PROVIDER: 's3', S3_ENDPOINT: 'https://s3.example.test', S3_REGION: 'test-1', S3_BUCKET: 'pm-test-bucket', S3_PREFIX: 'deployment-a', S3_ACCESS_KEY_ID: 'isolated-test-id', S3_SECRET_ACCESS_KEY: 'isolated-test-secret' };
test('provider selection is explicit, inert and never falls back after invalid S3 input', async () => {
  assert.equal(readBlobStoreConfig({}).provider, 'local');
  for (const env of [{ BLOB_PROVIDER: 'S3' }, { BLOB_PROVIDER: 'local', S3_REGION: '' }, { BLOB_PROVIDER: 'disabled', S3_BUCKET: 'unused' }, { ...s3, S3_ACCESS_KEY_ID: '' }, { ...s3, S3_SECRET_ACCESS_KEY: '' }, { ...s3, S3_BUCKET: 'arn:aws:s3:::bucket' }, { ...s3, S3_PREFIX: 'a/../b' }, { ...s3, S3_FORCE_PATH_STYLE: '1' }, { ...s3, S3_TIMEOUT_MS: '999' }, { ...s3, S3_KMS_KEY_ID: 'unexpected' }, { ...s3, S3_ENDPOINT: 'https://s3.amazonaws.com' }]) assert.throws(() => readBlobStoreConfig(env), /Invalid blob storage configuration/);
  const disabled = createBlobStore(readBlobStoreConfig({ BLOB_PROVIDER: 'disabled' }));
  for (const action of [() => disabled.init(), () => disabled.check(), () => disabled.put(Buffer.from('no bytes')), () => disabled.read('invalid')]) await assert.rejects(action(), { code: 'blob_provider_disabled' });
  disabled.close();
  const remote = createBlobStore(readBlobStoreConfig(s3)); remote.close(); // Constructor has no network or credential discovery.
});
test('endpoint rules reject userinfo, path, redirects and insecure non-loopback destinations', () => {
  for (const endpoint of ['https://user:secret@s3.example.test', 'https://s3.example.test/other', 'https://s3.example.test/.', 'https://s3.example.test/a/..', 'https://s3.example.test?token=secret', 'https://s3.example.test/#x', 'http://example.test', 'http://192.168.1.1']) assert.throws(() => readBlobStoreConfig({ ...s3, S3_ENDPOINT: endpoint, S3_ALLOW_INSECURE_LOOPBACK: 'true' }));
  assert.throws(() => readBlobStoreConfig({ ...s3, S3_ENDPOINT: 'http://127.0.0.1:9000' }));
  assert.equal(readBlobStoreConfig({ ...s3, S3_ENDPOINT: 'http://127.0.0.1:9000', S3_ALLOW_INSECURE_LOOPBACK: 'true' }).provider, 's3');
});
test('binding locator is deterministic, credential-free and sensitive to routing changes', () => {
  const original = blobStorageLocator(readBlobStoreConfig(s3))!;
  const rotated = blobStorageLocator(readBlobStoreConfig({ ...s3, S3_SECRET_ACCESS_KEY: 'rotated-private-secret', S3_SESSION_TOKEN: 'temporary-private-token', S3_TIMEOUT_MS: '1000', S3_ENCRYPTION_MODE: 'AES256' }))!;
  assert.equal(locatorSha256(original), locatorSha256(rotated));
  assert.doesNotMatch(JSON.stringify(original), /isolated-test|secret|credential|token/);
  for (const change of [{ S3_BUCKET: 'other-bucket' }, { S3_PREFIX: 'deployment-b' }, { S3_FORCE_PATH_STYLE: 'true' }, { S3_EXPECTED_BUCKET_OWNER: '123456789012' }]) assert.notEqual(locatorSha256(original), locatorSha256(blobStorageLocator(readBlobStoreConfig({ ...s3, ...change }))!));
});
