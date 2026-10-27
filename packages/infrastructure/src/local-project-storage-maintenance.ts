import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { Pool } from 'pg';
import { DomainError } from '../../domain/src/core.ts';
import type { SqlExecutor } from '../../application/src/ports.ts';
import { assertLocalProjectTargetAvailable } from '../../application/src/local-projects.ts';
import { Workspace } from '../../pm-core/index.ts';
import { ProjectLocations, readProjectLocation } from '../../pm-core/project-locations.ts';
import { LocalBlobStore, type BlobStore } from './blobs.ts';
import { storageTransaction } from './blob-storage-maintenance.ts';
import { blobInventoryEntrySchema, inventoryBlobReferences } from './blob-storage-inventory.ts';
import { checkProjectBlobStorage, initializeProjectBlobStorage, projectBlobManifestSha256, readStoredBlob, type ProjectBlobMount } from './project-blobs.ts';
import { lockWorkspace } from './database.ts';

const manifestSchema = z.strictObject({ formatVersion: z.literal(1), operationId: z.uuid(), kind: z.enum(['migrate','relocate','rebind']), workspaceId: z.uuid(), projectId: z.string().min(1), targetRoot: z.string(), targetMode: z.enum(['existing','new']), sourceMount: z.object({ workspaceId: z.string(), projectId: z.string(), storageId: z.uuid(), root: z.string(), attachmentsPath: z.string() }).nullable(), referencesSha256: z.string(), entries: z.array(blobInventoryEntrySchema) });
/** Includes receipt/outbox/event references even when no live artifact row remains. */
async function projectObjectKeys(sql: SqlExecutor, workspaceId: string, projectId: string): Promise<Set<string>> {
    const keys = new Set<string>();
    const columns = await sql.query<{ table_name: string }>("SELECT DISTINCT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema=c.table_schema AND t.table_name=c.table_name WHERE c.table_schema=current_schema() AND t.table_type='BASE TABLE' AND c.data_type IN ('json','jsonb') ORDER BY c.table_name");
    function visit(value: unknown, workspace: unknown, project: unknown): void {
      if (Array.isArray(value)) { for (const child of value) visit(child, workspace, project); return; }
      if (value === null || typeof value !== 'object') return;
      const record = value as Record<string, unknown>;
      workspace = record.workspaceId ?? record.workspace_id ?? workspace;
      project = record.projectId ?? record.project_id ?? project;
      if (record.objectKey !== undefined && workspace === workspaceId && project === projectId) {
        if (typeof record.objectKey !== 'string') throw new DomainError('blob_inventory_invalid_reference');
        keys.add(record.objectKey);
      }
      for (const child of Object.values(record)) visit(child, workspace, project);
    }
    for (const column of columns.rows) {
      if (!/^[a-z_][a-z0-9_]*$/.test(column.table_name)) throw new DomainError('blob_inventory_unknown_schema');
      await sql.query(`DECLARE pm_project_blob_scan NO SCROLL CURSOR FOR SELECT to_jsonb(pm_row) AS value FROM "${column.table_name}" pm_row`);
      try {
        for (;;) { const page = await sql.query<{ value: unknown }>('FETCH FORWARD 200 FROM pm_project_blob_scan'); if (!page.rows.length) break; for (const row of page.rows) visit(row.value, undefined, undefined); }
      } finally { await sql.query('CLOSE pm_project_blob_scan'); }
    }
    const routes = await sql.query<{ object_key: string }>('SELECT object_key FROM project_blob_object_routes WHERE workspace_id=$1 AND project_id=$2', [workspaceId, projectId]);
    for (const route of routes.rows) keys.add(route.object_key);
    return keys;
}
export type MaintainLocalProjectStorageOptions = { pool: Pool; coreRoot: string; workspaceId: string; projectId: string; targetRoot: string; targetMode?: 'existing' | 'new'; operationId: string; kind: 'migrate' | 'relocate' | 'rebind'; stopped: boolean; legacy: BlobStore; workspace?: Workspace; sql?: SqlExecutor; persistSql?: SqlExecutor };
/** Explicit stopped CLI or fenced/locked API operation; original identity reconciles every durable step. */
export async function maintainLocalProjectStorage(options: MaintainLocalProjectStorageOptions): Promise<ProjectBlobMount> {
  if (!options.stopped) throw new DomainError('blob_maintenance_requires_stop', 'Explicit external-writer stop acknowledgement and a stopped or fenced project are required');
  z.uuid().parse(options.operationId); z.uuid().parse(options.workspaceId);
  if (!options.sql) {
    const sql = await options.pool.connect();
    try {
      await sql.query('BEGIN');
      await lockWorkspace(sql, options.workspaceId);
      const mount = await maintainLocalProjectStorage({ ...options, sql });
      await sql.query('COMMIT');
      return mount;
    } catch (error) { await sql.query('ROLLBACK'); throw error; }
    finally { sql.release(); }
  }
  const coreRoot = resolve(options.coreRoot); const targetRoot = resolve(options.targetRoot);
  const workspaceRoot = join(coreRoot, options.workspaceId);
  const persist = options.persistSql ?? options.pool;
  const inTransaction = <T>(action: (sql: SqlExecutor) => Promise<T>): Promise<T> => options.sql ? action(options.sql) : storageTransaction(options.pool, action);
  const prior = await persist.query<{ manifest: unknown; manifest_sha256: string; phase: string }>('SELECT manifest,manifest_sha256,phase FROM local_project_storage_operations WHERE operation_id=$1', [options.operationId]);
  let manifest: z.infer<typeof manifestSchema>;
  const phase = prior.rows[0]?.phase ?? 'prepared';
  if (prior.rows[0]) {
    manifest = manifestSchema.parse(prior.rows[0].manifest);
    if (projectBlobManifestSha256(manifest) !== prior.rows[0].manifest_sha256 || manifest.workspaceId !== options.workspaceId || manifest.projectId !== options.projectId || manifest.kind !== options.kind || manifest.targetRoot !== targetRoot || manifest.targetMode !== (options.targetMode ?? 'existing')) throw new DomainError('blob_migration_journal_mismatch');
  } else {
    await assertLocalProjectTargetAvailable(options.sql, workspaceRoot, targetRoot, options.operationId, options.projectId);
    const sourceMount = options.kind === 'rebind'
      ? new ProjectLocations(workspaceRoot).entry(options.projectId) ?? null
      : readProjectLocation(workspaceRoot, options.projectId);
    if ((options.kind === 'migrate' && sourceMount) || (options.kind !== 'migrate' && !sourceMount)) throw new DomainError('project_storage_operation_mismatch');
    if (options.kind === 'rebind') {
      try { await lstat(sourceMount!.root); throw new DomainError('project_storage_source_still_present', 'Explicit rebind requires the old root to be absent', 409); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (options.targetMode === 'new') throw new DomainError('project_storage_operation_mismatch');
    }
    const entries = await inTransaction(async sql => {
      const keys = await projectObjectKeys(sql, options.workspaceId, options.projectId);
      const selected = (await inventoryBlobReferences(sql)).filter(entry => keys.has(entry.key));
      if (selected.length !== keys.size) throw new DomainError('blob_inventory_invalid_reference');
      return selected;
    });
    const fingerprint = projectBlobManifestSha256(entries.map(({ references: _references, ...entry }) => entry));
    manifest = manifestSchema.parse({ formatVersion: 1, operationId: options.operationId, kind: options.kind, workspaceId: options.workspaceId, projectId: options.projectId, targetRoot, targetMode: options.targetMode ?? 'existing', sourceMount, referencesSha256: fingerprint, entries });
    const pending = await persist.query('SELECT operation_id FROM local_project_storage_operations WHERE workspace_id=$1 AND project_id=$2 AND phase<>$3', [options.workspaceId, options.projectId, 'completed']);
    if (pending.rows.length) throw new DomainError('project_storage_maintenance_pending', 'Recover the original project storage operation first', 409);
    await persist.query("INSERT INTO local_project_storage_operations(operation_id,workspace_id,project_id,operation_kind,target_root,phase,manifest,manifest_sha256) VALUES($1,$2,$3,$4,$5,'prepared',$6,$7)", [options.operationId, options.workspaceId, options.projectId, options.kind, targetRoot, manifest, projectBlobManifestSha256(manifest)]);
  }
  if (phase === 'prepared') {
    const current = await inTransaction(async sql => {
      const keys = await projectObjectKeys(sql, options.workspaceId, options.projectId);
      return (await inventoryBlobReferences(sql)).filter(entry => keys.has(entry.key));
    });
    if (projectBlobManifestSha256(current.map(({ references: _references, ...entry }) => entry)) !== manifest.referencesSha256) throw new DomainError('blob_checkpoint_changed', 'Project references changed after maintenance preparation', 503);
  }
  if (options.kind === 'rebind' && phase === 'prepared') {
    const candidate = { ...manifest.sourceMount!, root: targetRoot, attachmentsPath: join(targetRoot, '.pm/attachments') };
    await checkProjectBlobStorage(persist, candidate, { allowFrozen: true });
    const provider = new LocalBlobStore(candidate.attachmentsPath);
    for (const entry of manifest.entries) {
      const bytes = await provider.read(entry.key);
      if (bytes.length !== entry.size || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new DomainError('blob_integrity_error');
    }
  }
  const workspace = options.workspace ?? new Workspace(workspaceRoot);
  let mount: ProjectBlobMount;
  try {
    if (!options.workspace) await workspace.init();
    if (phase === 'completed') {
      const committed = readProjectLocation(workspaceRoot, options.projectId);
      if (!committed || committed.root !== targetRoot) throw new DomainError('blob_storage_binding_mismatch');
      return committed;
    }
    const directory = { workspaceId: options.workspaceId, root: targetRoot, mode: manifest.targetMode };
    mount = options.kind === 'migrate'
      ? await workspace.migrateProject(options.projectId, options.operationId, directory)
      : options.kind === 'rebind'
        ? await workspace.rebindProject(options.projectId, options.operationId, directory)
        : await workspace.relocateProject(options.projectId, options.operationId, directory);
  } finally { if (!options.workspace) await workspace.close(); }
  await initializeProjectBlobStorage(persist, mount);
  await persist.query("UPDATE project_blob_stores SET state='migrating' WHERE storage_id=$1", [mount.storageId]);
  await persist.query("UPDATE local_project_storage_operations SET phase='core_committed',updated_at=clock_timestamp() WHERE operation_id=$1 AND phase<>'completed'", [options.operationId]);
  const target = new LocalBlobStore(mount.attachmentsPath);
  for (const entry of manifest.entries) {
    let bytes: Buffer;
    if (manifest.sourceMount && entry.storageId === manifest.sourceMount.storageId) {
      // Relocation may already have copied attachments as part of the core-owned .pm move.
      if (await target.objectExists(entry.key)) bytes = await target.read(entry.key);
      else bytes = await new LocalBlobStore(manifest.sourceMount.attachmentsPath).read(entry.key);
    } else {
      bytes = await readStoredBlob({ sql: persist, legacy: options.legacy, resolveProject: (workspaceId, projectId) => readProjectLocation(join(coreRoot, workspaceId), projectId) }, entry);
    }
    if (bytes.length !== entry.size || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new DomainError('blob_integrity_error');
    await target.importVerifiedObject(entry.key, bytes);
  }
  await persist.query("UPDATE local_project_storage_operations SET phase='copied',updated_at=clock_timestamp() WHERE operation_id=$1", [options.operationId]);
  await storageTransaction(options.pool, async sql => {
    for (const entry of manifest.entries) await sql.query('INSERT INTO project_blob_object_routes(workspace_id,project_id,object_key,storage_id,sha256,size) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id,project_id,object_key) DO UPDATE SET storage_id=EXCLUDED.storage_id,sha256=EXCLUDED.sha256,size=EXCLUDED.size', [options.workspaceId, options.projectId, entry.key, mount.storageId, entry.sha256, entry.size]);
    await sql.query("UPDATE project_blob_stores SET state='active' WHERE storage_id=$1", [mount.storageId]);
    await sql.query("UPDATE local_project_storage_operations SET phase='completed',updated_at=clock_timestamp() WHERE operation_id=$1", [options.operationId]);
  });
  return mount;
}
