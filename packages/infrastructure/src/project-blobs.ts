import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';
import { DomainError } from '../../domain/src/core.ts';
import type { SqlExecutor } from '../../application/src/ports.ts';
import { LocalBlobStore, blobKeyDigest, type BlobScope, type BlobStore } from './blobs.ts';
import { readStorageBinding } from './blob-storage-binding.ts';

export type ProjectBlobMount = { workspaceId: string; projectId: string; storageId: string; root: string; attachmentsPath: string };
export type ProjectBlobResolver = (workspaceId: string, projectId: string) => ProjectBlobMount | null | Promise<ProjectBlobMount | null>;
const markerSchema = z.strictObject({ formatVersion: z.literal(1), storageId: z.uuid(), workspaceId: z.uuid(), projectId: z.string().min(1) });
function markerFor(mount: ProjectBlobMount) { return markerSchema.parse({ formatVersion: 1, storageId: mount.storageId, workspaceId: mount.workspaceId, projectId: mount.projectId }); }
function providerFor(mount: ProjectBlobMount): LocalBlobStore {
  if (resolve(mount.root, '.pm/attachments') !== mount.attachmentsPath || resolve(mount.root) !== mount.root) throw new DomainError('blob_storage_binding_mismatch', 'Invalid project attachment mount', 503);
  return new LocalBlobStore(mount.attachmentsPath);
}
async function checkMarker(provider: LocalBlobStore, mount: ProjectBlobMount): Promise<void> {
  const bytes = await provider.readMarker();
  let marker;
  try { marker = markerSchema.parse(bytes && JSON.parse(bytes.toString('utf8'))); }
  catch { throw new DomainError('blob_storage_binding_mismatch', 'Project attachment identity is missing or conflicting', 503); }
  if (JSON.stringify(marker) !== JSON.stringify(markerFor(mount))) throw new DomainError('blob_storage_binding_mismatch', 'Project attachment identity differs', 503);
}
async function readProjectBlobRegistration(sql: SqlExecutor, workspaceId: string, projectId: string, allowFrozen: boolean) {
  if (!allowFrozen) {
    const pending = await sql.query('SELECT operation_id FROM local_project_storage_operations WHERE workspace_id=$1 AND project_id=$2 AND phase<>$3 LIMIT 1', [workspaceId, projectId, 'completed']);
    if (pending.rows.length) throw new DomainError('project_storage_maintenance_pending', 'Recover the original project storage operation before accessing its attachments', 503);
  }
  const result = await sql.query<{ storage_id: string; state: string }>('SELECT storage_id,state FROM project_blob_stores WHERE workspace_id=$1 AND project_id=$2', [workspaceId, projectId]);
  const row = result.rows[0];
  if (row && !allowFrozen && row.state !== 'active') throw new DomainError('blob_storage_binding_mismatch', 'Project storage is frozen', 503);
  return row;
}
/** Readonly current-location check. Maintenance alone may inspect its original fenced identity. */
export async function checkProjectBlobStorage(sql: SqlExecutor, mount: ProjectBlobMount, options: { allowFrozen?: boolean } = {}): Promise<void> {
  const registration = await readProjectBlobRegistration(sql, mount.workspaceId, mount.projectId, options.allowFrozen === true);
  if (!registration || registration.storage_id !== mount.storageId) throw new DomainError('blob_storage_binding_mismatch', 'Project storage registration differs', 503);
  await checkMarker(providerFor(mount), mount);
}
/** Explicit initialization only. Core must have created and validated the attachment directory. */
export async function initializeProjectBlobStorage(sql: SqlExecutor, mount: ProjectBlobMount): Promise<void> {
  const provider = providerFor(mount);
  const existing = await provider.readMarker(); // Never mkdir a missing/moved mount.
  if (!existing) {
    if ((await provider.listNamespace()).length) throw new DomainError('blob_storage_not_empty', 'Unmarked project attachments must be empty', 503);
    await provider.createMarker(Buffer.from(JSON.stringify(markerFor(mount))));
  }
  await checkMarker(provider, mount);
  await sql.query('INSERT INTO project_blob_stores(storage_id,workspace_id,project_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [mount.storageId, mount.workspaceId, mount.projectId]);
  const result = await sql.query<{ storage_id: string; state: string }>('SELECT storage_id,state FROM project_blob_stores WHERE workspace_id=$1 AND project_id=$2', [mount.workspaceId, mount.projectId]);
  if (result.rows[0]?.storage_id !== mount.storageId) throw new DomainError('blob_storage_binding_mismatch', 'Project storage registration differs', 503);
}
export type ProjectBlobStoreOptions = { sql: SqlExecutor; legacy: BlobStore; resolveProject: ProjectBlobResolver };
async function projectProvider(options: ProjectBlobStoreOptions, workspaceId: string, projectId: string, allowFrozen = false): Promise<{ provider: LocalBlobStore; mount: ProjectBlobMount } | null> {
  const row = await readProjectBlobRegistration(options.sql, workspaceId, projectId, allowFrozen);
  const mount = await options.resolveProject(workspaceId, projectId);
  if (!mount && !row) return null;
  if (!mount || !row || row.storage_id !== mount.storageId || mount.workspaceId !== workspaceId || mount.projectId !== projectId) throw new DomainError('blob_storage_binding_mismatch', 'Project storage is missing or changed', 503);
  const provider = providerFor(mount);
  await checkMarker(provider, mount);
  return { provider, mount };
}
async function legacyIdentity(options: ProjectBlobStoreOptions, storageId?: string): Promise<string> {
  const binding = await readStorageBinding(options.sql);
  if (!binding || binding.state !== 'active') throw new DomainError('blob_storage_binding_mismatch', 'Legacy storage is unavailable', 503);
  if (storageId && storageId !== binding.storeId) {
    const aliases = await options.sql.query<{ target_store_id: string }>('SELECT target_store_id FROM blob_store_aliases WHERE storage_id=$1', [z.uuid().parse(storageId)]);
    if (aliases.rows[0]?.target_store_id !== binding.storeId) throw new DomainError('blob_storage_binding_mismatch', 'Unknown immutable storage identity', 503);
  }
  return binding.storeId;
}
function requireScope(scope?: BlobScope): BlobScope {
  if (!scope || !scope.workspaceId || !scope.projectId) throw new DomainError('blob_scope_required', 'Authorized workspace/project scope is required', 403);
  if (scope.storageId !== undefined) z.uuid().parse(scope.storageId);
  return scope;
}
/** Runtime facade: scope is supplied only after application authorization. It never initializes roots. */
export function createProjectBlobStore(options: ProjectBlobStoreOptions): BlobStore {
  return {
    async init() { await options.legacy.init(); },
    async check() {
      await options.legacy.check();
      const projects = await options.sql.query<{ workspace_id: string; project_id: string }>('SELECT workspace_id,project_id FROM project_blob_stores ORDER BY workspace_id,project_id');
      for (const project of projects.rows) {
        const target = await projectProvider(options, project.workspace_id, project.project_id);
        if (!target) throw new DomainError('blob_storage_binding_mismatch');
        await target.provider.check();
      }
    },
    async put(bytes, input) {
      const scope = requireScope(input);
      const target = await projectProvider(options, scope.workspaceId, scope.projectId);
      if (target) return { ...await target.provider.put(bytes), storageId: target.mount.storageId };
      const storageId = await legacyIdentity(options);
      return { ...await options.legacy.put(bytes), storageId };
    },
    async read(key, input) {
      blobKeyDigest(key);
      const scope = requireScope(input);
      const routes = await options.sql.query<{ storage_id: string }>('SELECT storage_id FROM project_blob_object_routes WHERE workspace_id=$1 AND project_id=$2 AND object_key=$3', [scope.workspaceId, scope.projectId, key]);
      const route = routes.rows[0];
      const target = await projectProvider(options, scope.workspaceId, scope.projectId);
      if (route || (target && scope.storageId === target.mount.storageId)) {
        if (!target || (route && route.storage_id !== target.mount.storageId)) throw new DomainError('blob_storage_binding_mismatch', 'Historical object route differs', 503);
        return target.provider.read(key);
      }
      await legacyIdentity(options, scope.storageId);
      return options.legacy.read(key);
    },
  };
}
/** Stopped backup/migration reader, not a public object API. No inferred authorization or fallback roots. */
export async function readStoredBlob(options: ProjectBlobStoreOptions, entry: { key: string; storageId?: string | undefined }): Promise<Buffer> {
  blobKeyDigest(entry.key);
  const rows = await options.sql.query<{ workspace_id: string; project_id: string; storage_id: string }>(
    'SELECT workspace_id,project_id,storage_id FROM project_blob_stores WHERE storage_id=$1 UNION SELECT workspace_id,project_id,storage_id FROM project_blob_object_routes WHERE object_key=$2', [entry.storageId ?? null, entry.key]);
  if (rows.rows.length) {
    const candidates = new Map(rows.rows.map(row => [`${row.workspace_id}/${row.project_id}`, row]));
    let bytes: Buffer | undefined;
    for (const row of candidates.values()) {
      const target = await projectProvider(options, row.workspace_id, row.project_id, true);
      if (!target || target.mount.storageId !== row.storage_id) throw new DomainError('blob_storage_binding_mismatch');
      const actual = await target.provider.read(entry.key);
      if (bytes && !actual.equals(bytes)) throw new DomainError('blob_integrity_error', 'Historical routes disagree', 503);
      bytes = actual;
    }
    return bytes!;
  }
  await legacyIdentity(options, entry.storageId);
  return options.legacy.read(entry.key);
}
export function projectBlobManifestSha256(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
