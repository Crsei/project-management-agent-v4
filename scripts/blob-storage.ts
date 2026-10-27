import { parseArgs } from 'node:util';
import { constants } from 'node:fs';
import { open, rename, unlink, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../packages/domain/src/core.ts';
import { createPool } from '../packages/infrastructure/src/database.ts';
import { readBlobStoreConfig, blobStorageLocator } from '../packages/infrastructure/src/blob-storage-config.ts';
import { createBlobStore, type BlobStorageProvider } from '../packages/infrastructure/src/blob-storage-provider.ts';
import { readStorageBinding, readStorageMarker, assertStorageMarker } from '../packages/infrastructure/src/blob-storage-binding.ts';
import { inventorySha256, verifyInventoryObjects } from '../packages/infrastructure/src/blob-storage-inventory.ts';
import { bindStorage, collectLegacyBlobInventory, createMigrationManifest, migrateStorage, verifyStorageMigration, activateStorage, resumeSourceStorage, migrationManifestSchema, migrationManifestSha256, type StorageEndpoint } from '../packages/infrastructure/src/blob-storage-maintenance.ts';
import { importBlobBackup, restoreBlobBackup } from '../packages/infrastructure/src/blob-storage-backup.ts';
import { hashCheckpointFile, verifyCoreCheckpoint, coreCheckpointSchema } from '../packages/infrastructure/src/blob-storage-checkpoint.ts';

const options = parseArgs({ allowPositionals: true, strict: true, options: {
  'source-config': { type: 'string' }, 'target-config': { type: 'string' }, 'journal': { type: 'string' }, 'output': { type: 'string' },
  'expected-epoch': { type: 'string' }, 'manifest-sha256': { type: 'string' }, 'dump-file': { type: 'string' },
  'core-root': { type: 'string' }, 'core-manifest': { type: 'string' }, 'backup-directory': { type: 'string' },
  'target-store-id': { type: 'string' }, 'operation-id': { type: 'string' },
  'new': { type: 'boolean' }, 'adopt': { type: 'boolean' }, 'stopped': { type: 'boolean' }, 'resume-source': { type: 'boolean' },
} });
const command = options.positionals[0];
if (options.positionals.length !== 1 || !['bind', 'inventory', 'migrate', 'verify', 'activate', 'import', 'restore-rebind'].includes(command ?? '')) throw new Error('Usage: blob-storage <bind|inventory|migrate|verify|activate|import|restore-rebind> --stopped [explicit config/checkpoint options]');
function value(name: keyof typeof options.values): string {
  const result = options.values[name];
  if (typeof result !== 'string' || !result) throw new Error(`Required option: --${name}`);
  return result;
}
async function readJson(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024 * 1024) throw new Error('Unsafe or oversized maintenance input');
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) { const part = await file.read(bytes, offset, bytes.length - offset, offset); if (!part.bytesRead) throw new Error('Truncated maintenance input'); offset += part.bytesRead; }
    if ((await file.read(Buffer.alloc(1), 0, 1, bytes.length)).bytesRead) throw new Error('Changed maintenance input');
    return JSON.parse(bytes.toString('utf8'));
  } finally { await file.close(); }
}
async function writeJson(path: string, data: unknown, replace = false): Promise<void> {
  const absolute = resolve(path);
  if (await realpath(dirname(absolute)) !== dirname(absolute)) throw new Error('Unsafe maintenance output parent');
  const temporary = replace ? `${absolute}.pending-${randomUUID()}` : absolute;
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(JSON.stringify(data, null, 2) + '\n'); await file.sync(); await file.close();
    if (replace) await rename(temporary, absolute);
    const directory = await open(dirname(absolute), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) { await file.close().catch(() => undefined); if (replace) await unlink(temporary).catch(() => undefined); throw error; }
}
const descriptor = z.strictObject({
  BLOB_PROVIDER: z.enum(['local', 's3']), BLOB_ROOT: z.string().optional(), S3_ENDPOINT: z.string().optional(), S3_REGION: z.string().optional(),
  S3_BUCKET: z.string().optional(), S3_PREFIX: z.string().optional(), S3_FORCE_PATH_STYLE: z.string().optional(), S3_EXPECTED_BUCKET_OWNER: z.string().optional(),
  S3_TIMEOUT_MS: z.string().optional(), S3_ENCRYPTION_MODE: z.string().optional(), S3_KMS_KEY_ID: z.string().optional(), S3_ALLOW_INSECURE_LOOPBACK: z.string().optional(),
});
const providers: BlobStorageProvider[] = [];
async function endpoint(role: 'source' | 'target'): Promise<StorageEndpoint> {
  const input = descriptor.parse(await readJson(value(role === 'source' ? 'source-config' : 'target-config')));
  const env: NodeJS.ProcessEnv = { ...input };
  if (input.BLOB_PROVIDER === 's3') for (const field of ['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_SESSION_TOKEN']) {
    const credential = process.env[`${role.toUpperCase()}_${field}`];
    if (credential !== undefined) env[field] = credential;
  }
  const config = readBlobStoreConfig(env);
  const locator = blobStorageLocator(config);
  if (!locator) throw new Error('Disabled provider is not a maintenance endpoint');
  const provider = createBlobStore(config); providers.push(provider);
  return { provider, locator };
}
const journalSchema = z.strictObject({
  formatVersion: z.literal(1), manifest: migrationManifestSchema, manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(['prepared', 'copying', 'copied', 'verified', 'activated', 'source_resumed', 'failed']),
  verifiedKeys: z.array(z.string()), failures: z.array(z.strictObject({ at: z.iso.datetime(), category: z.string() })),
});
const pool = process.env.DATABASE_URL ? createPool(process.env.DATABASE_URL) : undefined;
try {
  if (!pool) throw new Error('DATABASE_URL is required for maintenance');
  if (options.values.stopped !== true) throw new Error('--stopped must attest API, Worker and external core writers are stopped');
  if (command === 'bind') {
    if (Boolean(options.values.new) === Boolean(options.values.adopt)) throw new Error('Choose exactly --new or --adopt');
    const target = await endpoint('target');
    const binding = await bindStorage({ pool, ...target, mode: options.values.new ? 'new' : 'adopt', stopped: true, ...(options.values['target-store-id'] ? { storeId: z.uuid().parse(value('target-store-id')) } : {}), ...(options.values['operation-id'] ? { operationId: z.uuid().parse(value('operation-id')) } : {}) });
    console.log(JSON.stringify({ binding }));
  } else if (command === 'inventory') {
    const source = await endpoint('source');
    const binding = await readStorageBinding(pool);
    if (!binding) throw new Error('Storage binding is missing');
    assertStorageMarker(binding, source.locator, await readStorageMarker(source.provider));
    const entries = await collectLegacyBlobInventory(pool);
    await verifyInventoryObjects(source.provider, entries);
    const databaseDumpSha256 = (await hashCheckpointFile(value('dump-file'))).sha256;
    const coreManifestSha256 = await verifyCoreCheckpoint(value('core-root'), coreCheckpointSchema.parse(await readJson(value('core-manifest'))));
    await writeJson(value('output'), { formatVersion: 1, createdAt: new Date().toISOString(), binding, databaseDumpSha256, coreManifestSha256, entries, inventorySha256: inventorySha256(entries) });
    console.log(JSON.stringify({ scope: 'legacy_global_provider', objects: entries.length, inventorySha256: inventorySha256(entries) }));
  } else if (command === 'import' || command === 'restore-rebind') {
    const target = await endpoint('target');
    const common = { pool, target, directory: value('backup-directory'), expectedManifestSha256: value('manifest-sha256'), databaseDumpSha256: (await hashCheckpointFile(value('dump-file'))).sha256, coreManifestSha256: await verifyCoreCheckpoint(value('core-root'), coreCheckpointSchema.parse(await readJson(value('core-manifest')))), stopped: true, targetStoreId: z.uuid().parse(value('target-store-id')) };
    const result = command === 'import' ? await importBlobBackup(common) : await restoreBlobBackup({ ...common, expectedEpoch: value('expected-epoch'), operationId: z.uuid().parse(value('operation-id')) });
    console.log(JSON.stringify({ result }));
  } else {
    const path = value('journal');
    let journal: z.infer<typeof journalSchema>;
    try { journal = journalSchema.parse(await readJson(path)); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT') || command !== 'migrate') throw error;
      const source = await endpoint('source'); const target = await endpoint('target');
      const manifest = await createMigrationManifest({ pool, source, target, expectedEpoch: value('expected-epoch'), stopped: true, databaseDumpSha256: (await hashCheckpointFile(value('dump-file'))).sha256, coreManifestSha256: await verifyCoreCheckpoint(value('core-root'), coreCheckpointSchema.parse(await readJson(value('core-manifest')))) });
      journal = { formatVersion: 1, manifest, manifestSha256: migrationManifestSha256(manifest), state: 'prepared', verifiedKeys: [], failures: [] };
      // Durable original identities precede freezing the binding or writing target objects.
      await writeJson(path, journal);
    }
    if (journal.manifestSha256 !== migrationManifestSha256(journal.manifest)) throw new Error('Migration journal digest differs');
    if (command === 'activate' && value('manifest-sha256') !== journal.manifestSha256) throw new Error('Explicit manifest digest differs');
    if (options.values['expected-epoch'] && value('expected-epoch') !== journal.manifest.source.epoch) throw new Error('Original binding epoch differs');
    if ((await hashCheckpointFile(value('dump-file'))).sha256 !== journal.manifest.databaseDumpSha256 || await verifyCoreCheckpoint(value('core-root'), coreCheckpointSchema.parse(await readJson(value('core-manifest')))) !== journal.manifest.coreManifestSha256) throw new Error('SQL/core checkpoint differs');
    try {
      if (options.values['resume-source']) {
        if (command !== 'activate') throw new Error('--resume-source is valid only with activate');
        await resumeSourceStorage({ pool, source: await endpoint('source'), manifest: journal.manifest, stopped: true }); journal.state = 'source_resumed';
      } else if (command === 'migrate') {
        journal.state = 'copying'; await writeJson(path, journal, true);
        await migrateStorage({ pool, source: await endpoint('source'), target: await endpoint('target'), manifest: journal.manifest, stopped: true, async onVerified(key) { if (!journal.verifiedKeys.includes(key)) journal.verifiedKeys.push(key); await writeJson(path, journal, true); } }); journal.state = 'copied';
      } else if (command === 'verify') {
        await verifyStorageMigration({ pool, target: await endpoint('target'), manifest: journal.manifest, stopped: true }); journal.state = 'verified';
      } else {
        await activateStorage({ pool, target: await endpoint('target'), manifest: journal.manifest, expectedManifestSha256: value('manifest-sha256'), stopped: true }); journal.state = 'activated';
      }
      await writeJson(path, journal, true);
    } catch (error) {
      journal.state = 'failed'; journal.failures.push({ at: new Date().toISOString(), category: error instanceof DomainError ? error.code : 'maintenance_failed' }); await writeJson(path, journal, true); throw error;
    }
    console.log(JSON.stringify({ migrationId: journal.manifest.migrationId, manifestSha256: journal.manifestSha256, state: journal.state, objects: journal.manifest.entries.length }));
  }
} catch (error) {
  // Never serialize SDK errors, requests, database URLs, descriptors or credentials.
  console.error(JSON.stringify({ error: error instanceof DomainError ? error.code : 'blob_maintenance_failed' })); process.exitCode = 1;
} finally { for (const provider of providers) provider.close(); await pool?.end(); }
