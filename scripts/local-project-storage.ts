import { parseArgs } from 'node:util';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { DomainError } from '../packages/domain/src/core.ts';
import { createPool } from '../packages/infrastructure/src/database.ts';
import { runtimeConfig } from '../packages/infrastructure/src/runtime-config.ts';
import { readBlobStoreConfig, blobStorageLocator } from '../packages/infrastructure/src/blob-storage-config.ts';
import { createBlobStore, type BlobStorageProvider } from '../packages/infrastructure/src/blob-storage-provider.ts';
import { bindBlobStore, readStorageBinding } from '../packages/infrastructure/src/blob-storage-binding.ts';
import { maintainLocalProjectStorage } from '../packages/infrastructure/src/local-project-storage-maintenance.ts';
import { assertIndependentStorageRoots, restoreLocalProjectCheckpoint, localProjectCheckpointSchema } from '../packages/infrastructure/src/project-storage-checkpoint.ts';
import { restoreBlobBackup } from '../packages/infrastructure/src/blob-storage-backup.ts';
import { hashCheckpointFile } from '../packages/infrastructure/src/blob-storage-checkpoint.ts';

const args = parseArgs({ strict: true, allowPositionals: true, options: {
  stopped: { type: 'boolean' }, 'workspace-id': { type: 'string' }, 'project-id': { type: 'string' }, 'target-root': { type: 'string' },
  'operation-id': { type: 'string' }, 'core-root': { type: 'string' }, 'backup-directory': { type: 'string' },
  'target-core-root': { type: 'string' }, 'target-projects-root': { type: 'string' }, 'target-blob-root': { type: 'string' },
  'target-store-id': { type: 'string' }, 'expected-epoch': { type: 'string' },
  'target-mode': { type: 'string' }, 'restored-target': { type: 'boolean' },
} });
function required(name: keyof typeof args.values): string {
  const value = args.values[name];
  if (typeof value !== 'string' || !value) throw new DomainError('local_storage_cli_argument', `Required option --${name}`);
  return value;
}
async function readJson(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024 * 1024) throw new DomainError('blob_backup_manifest_invalid');
    const bytes = Buffer.alloc(stat.size); let offset = 0;
    while (offset < bytes.length) { const result = await file.read(bytes, offset, bytes.length - offset, offset); if (!result.bytesRead) throw new DomainError('blob_backup_manifest_invalid'); offset += result.bytesRead; }
    if ((await file.read(Buffer.alloc(1), 0, 1, bytes.length)).bytesRead) throw new DomainError('blob_backup_manifest_invalid');
    return JSON.parse(bytes.toString('utf8'));
  } finally { await file.close(); }
}
const pool = process.env.DATABASE_URL ? createPool(process.env.DATABASE_URL) : undefined;
let source: BlobStorageProvider | undefined;
let target: BlobStorageProvider | undefined;
try {
  if (!pool) throw new DomainError('database_required');
  if (args.values.stopped !== true) throw new DomainError('blob_maintenance_requires_stop', '--stopped must attest API, Worker and external file writers are stopped');
  const command = args.positionals[0];
  if (args.positionals.length !== 1 || !['migrate','relocate','rebind','recover','restore'].includes(command ?? '')) throw new DomainError('local_storage_cli_argument', 'Usage: local-project-storage <migrate|relocate|rebind|recover|restore> --stopped [original operation options]');
  const operationId = z.uuid().parse(required('operation-id'));
  if (command === 'restore') {
    if (args.values['restored-target'] !== true) throw new DomainError('blob_restore_target_acknowledgement', '--restored-target must attest DATABASE_URL is an isolated restored target, never the source');
    // DATABASE_URL must already point at an isolated, fully restored target SQL database.
    const directory = resolve(required('backup-directory'));
    const report = z.object({ formatVersion: z.literal(3), databaseDumpSha256: z.string(), coreManifestSha256: z.string(), blobManifestSha256: z.string(), sourceBinding: z.object({ storeId: z.uuid(), epoch: z.string() }) }).parse(await readJson(join(directory, 'manifest.json')));
    if ((await hashCheckpointFile(join(directory, 'database.dump'))).sha256 !== report.databaseDumpSha256) throw new DomainError('blob_backup_set_mismatch');
    const binding = await readStorageBinding(pool);
    const targetStoreId = z.uuid().parse(required('target-store-id'));
    if (!binding || (binding.storeId !== report.sourceBinding.storeId && binding.storeId !== targetStoreId)) throw new DomainError('blob_storage_binding_mismatch');
    const targetCoreRoot = resolve(required('target-core-root'));
    const targetProjectsRoot = resolve(required('target-projects-root'));
    const targetBlobRoot = resolve(required('target-blob-root'));
    assertIndependentStorageRoots([directory, targetCoreRoot, targetProjectsRoot, targetBlobRoot]);
    const manifest = localProjectCheckpointSchema.parse(await readJson(join(directory, 'files', 'manifest.json')));
    await restoreLocalProjectCheckpoint({ directory: join(directory, 'files'), manifest, expectedManifestSha256: report.coreManifestSha256, targetCoreRoot, targetProjectsRoot, stopped: true });
    target = createBlobStore({ provider: 'local', root: targetBlobRoot });
    const restored = await restoreBlobBackup({ pool, target: { provider: target, locator: { provider: 'local', root: targetBlobRoot } }, directory: join(directory, 'blobs'), expectedManifestSha256: report.blobManifestSha256, databaseDumpSha256: report.databaseDumpSha256, coreManifestSha256: report.coreManifestSha256, stopped: true, targetStoreId, expectedEpoch: required('expected-epoch'), operationId });
    console.log(JSON.stringify({ state: 'completed', operationId, storageEpoch: restored.epoch, projectRoots: manifest.projects.length, targetCoreRoot, targetProjectsRoot, targetBlobRoot, productionCredentialPolicyApproved: false }));
  } else {
    let workspaceId: string; let projectId: string; let targetRoot: string; let kind: 'migrate' | 'relocate' | 'rebind';
    let targetMode = z.enum(['existing','new']).parse(args.values['target-mode'] ?? 'existing');
    if (command === 'recover') {
      const prior = await pool.query<{ workspace_id: string; project_id: string; target_root: string; operation_kind: 'migrate' | 'relocate' | 'rebind'; target_mode: 'existing' | 'new' }>("SELECT workspace_id,project_id,target_root,operation_kind,manifest->>'targetMode' AS target_mode FROM local_project_storage_operations WHERE operation_id=$1", [operationId]);
      const row = prior.rows[0];
      if (!row || !['migrate','relocate','rebind'].includes(row.operation_kind)) throw new DomainError('project_storage_operation_not_found', 'Original maintenance operation was not found', 404);
      workspaceId = row.workspace_id; projectId = row.project_id; targetRoot = row.target_root; kind = row.operation_kind; targetMode = row.target_mode;
    } else {
      workspaceId = z.uuid().parse(required('workspace-id')); projectId = required('project-id'); targetRoot = resolve(required('target-root')); kind = command as 'migrate' | 'relocate' | 'rebind';
    }
    const config = readBlobStoreConfig(); const locator = blobStorageLocator(config);
    if (!locator) throw new DomainError('blob_provider_disabled');
    source = createBlobStore(config);
    const result = await maintainLocalProjectStorage({ pool, coreRoot: args.values['core-root'] ?? runtimeConfig().coreWorkspaceRoot, workspaceId, projectId, targetRoot, targetMode, operationId, kind, stopped: true, legacy: bindBlobStore(pool, locator, source) });
    console.log(JSON.stringify({ state: 'completed', operationId, workspaceId, projectId, storageId: result.storageId, root: result.root }));
  }
} catch (error) {
  console.error(JSON.stringify({ error: error instanceof DomainError ? error.code : 'local_project_storage_failed', recovery: 'Preserve the original operation id and target; no services were stopped and no user directory was removed.' }));
  process.exitCode = 1;
} finally { source?.close(); target?.close(); await pool?.end(); }
