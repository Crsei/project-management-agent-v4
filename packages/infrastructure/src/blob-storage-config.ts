import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { resolve, sep } from 'node:path';

export type LocalBlobConfig = { provider: 'local'; root: string };
export type S3BlobConfig = {
  provider: 's3'; endpoint: string; region: string; bucket: string; prefix: string;
  forcePathStyle: boolean; expectedBucketOwner?: string;
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  timeoutMs: number; encryptionMode: 'bucket-default' | 'AES256' | 'aws:kms'; kmsKeyId?: string;
  allowInsecureLoopback: boolean;
};
export type BlobStoreConfig = LocalBlobConfig | S3BlobConfig | { provider: 'disabled' };
export type BlobStorageLocator = { provider: 'local'; root: string } | {
  provider: 's3'; endpoint: string; region: string; bucket: string; prefix: string;
  forcePathStyle: boolean; expectedBucketOwner: string | null;
};
const fields = ['S3_ENDPOINT', 'S3_REGION', 'S3_BUCKET', 'S3_PREFIX', 'S3_FORCE_PATH_STYLE', 'S3_EXPECTED_BUCKET_OWNER', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_SESSION_TOKEN', 'S3_TIMEOUT_MS', 'S3_ENCRYPTION_MODE', 'S3_KMS_KEY_ID', 'S3_ALLOW_INSECURE_LOOPBACK'];
function invalid(field: string): never { throw new Error(`Invalid blob storage configuration: ${field}`); }
function required(env: NodeJS.ProcessEnv, field: string): string {
  const value = env[field];
  if (!value || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) invalid(field);
  return value;
}
function bool(env: NodeJS.ProcessEnv, field: string, fallback = false): boolean {
  const value = env[field];
  if (value === undefined) return fallback;
  if (value !== 'true' && value !== 'false') invalid(field);
  return value === 'true';
}
export function isLoopback(address: string): boolean {
  const host = address.replace(/^\[|\]$/g, '').toLowerCase();
  return host === '::1' || (isIP(host) === 4 && host.split('.')[0] === '127');
}
/** Explicit credentials only; construction and parsing perform no I/O. */
export function readBlobStoreConfig(env: NodeJS.ProcessEnv = process.env): BlobStoreConfig {
  const provider = env.BLOB_PROVIDER ?? 'local';
  if (!['local', 's3', 'disabled'].includes(provider)) invalid('BLOB_PROVIDER');
  if (provider !== 's3') {
    if (fields.some(field => env[field] !== undefined)) invalid('S3 fields require BLOB_PROVIDER=s3');
    if (provider === 'disabled') return { provider };
    const root = env.BLOB_ROOT ?? '.local/blobs';
    if (!root.trim() || root.includes('\0') || resolve(root) === sep) invalid('BLOB_ROOT');
    return { provider: 'local', root: resolve(root) };
  }
  let url: URL;
  const endpoint = required(env, 'S3_ENDPOINT');
  if (!/^https?:\/\/[^/?#]+\/?$/i.test(endpoint)) invalid('S3_ENDPOINT');
  try { url = new URL(endpoint); } catch { return invalid('S3_ENDPOINT'); }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || !['https:', 'http:'].includes(url.protocol)) invalid('S3_ENDPOINT');
  const allowInsecureLoopback = bool(env, 'S3_ALLOW_INSECURE_LOOPBACK');
  if (url.protocol === 'http:' && (!allowInsecureLoopback || !(isLoopback(url.hostname) || url.hostname === 'localhost'))) invalid('S3_ENDPOINT');
  const region = required(env, 'S3_REGION');
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(region)) invalid('S3_REGION');
  const bucket = required(env, 'S3_BUCKET');
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes('..') || /^[0-9]+(?:\.[0-9]+){3}$/.test(bucket) || isIP(bucket) || /(?:^xn--|--x-s3$|--ol-s3$|\.mrap$|^sthree-|^amzn-s3-demo-)/.test(bucket)) invalid('S3_BUCKET');
  const prefix = required(env, 'S3_PREFIX');
  if (prefix.length > 512 || !prefix.split('/').every(part => /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(part) && part !== '.' && part !== '..')) invalid('S3_PREFIX');
  const expectedBucketOwner = env.S3_EXPECTED_BUCKET_OWNER;
  if (expectedBucketOwner !== undefined && !/^\d{12}$/.test(expectedBucketOwner)) invalid('S3_EXPECTED_BUCKET_OWNER');
  if (/(?:^|\.)amazonaws\.com(?:\.cn)?$/.test(url.hostname) && !expectedBucketOwner) invalid('S3_EXPECTED_BUCKET_OWNER');
  const timeout = env.S3_TIMEOUT_MS ?? '15000';
  if (!/^\d+$/.test(timeout) || Number(timeout) < 1000 || Number(timeout) > 120000) invalid('S3_TIMEOUT_MS');
  const encryptionMode = env.S3_ENCRYPTION_MODE ?? 'bucket-default';
  if (!['bucket-default', 'AES256', 'aws:kms'].includes(encryptionMode)) invalid('S3_ENCRYPTION_MODE');
  if (encryptionMode !== 'aws:kms' && env.S3_KMS_KEY_ID !== undefined) invalid('S3_KMS_KEY_ID');
  return {
    provider: 's3', endpoint: url.origin, region, bucket, prefix, forcePathStyle: bool(env, 'S3_FORCE_PATH_STYLE'),
    ...(expectedBucketOwner ? { expectedBucketOwner } : {}),
    credentials: { accessKeyId: required(env, 'S3_ACCESS_KEY_ID'), secretAccessKey: required(env, 'S3_SECRET_ACCESS_KEY'), ...(env.S3_SESSION_TOKEN !== undefined ? { sessionToken: required(env, 'S3_SESSION_TOKEN') } : {}) },
    timeoutMs: Number(timeout), encryptionMode: encryptionMode as S3BlobConfig['encryptionMode'],
    ...(encryptionMode === 'aws:kms' ? { kmsKeyId: required(env, 'S3_KMS_KEY_ID') } : {}), allowInsecureLoopback,
  };
}
export function blobStorageLocator(config: BlobStoreConfig): BlobStorageLocator | null {
  if (config.provider === 'disabled') return null;
  if (config.provider === 'local') return { provider: 'local', root: resolve(config.root) };
  return { provider: 's3', endpoint: config.endpoint, region: config.region, bucket: config.bucket, prefix: config.prefix, forcePathStyle: config.forcePathStyle, expectedBucketOwner: config.expectedBucketOwner ?? null };
}
export function locatorSha256(locator: BlobStorageLocator): string {
  // Fixed property order; never includes credentials, encryption keys or timeout knobs.
  const canonical = locator.provider === 'local' ? { provider: 'local', root: resolve(locator.root) } : { provider: 's3', endpoint: locator.endpoint, region: locator.region, bucket: locator.bucket, prefix: locator.prefix, forcePathStyle: locator.forcePathStyle, expectedBucketOwner: locator.expectedBucketOwner };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
