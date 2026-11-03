import { randomUUID } from 'node:crypto';
import type { SqlExecutor } from '../../application/src/ports.ts';
import { documentSourceMutationReceiptSchema, type DocumentSourceMutation, type DocumentSourceMutationReceipt, type DocumentSourceReference, type DocumentSourceScope } from '../../contracts/src/document-sources.ts';
import { DomainError } from '../../domain/src/core.ts';

export type DocumentSourceRow = { workspace_id: string; source_id: string; project_key: string; path: string | null; directory_device: string | null; directory_inode: string | null; revision: number; removed_at: Date | null };
const columns = 'workspace_id,source_id,project_key,path,directory_device,directory_inode,revision,removed_at';
export async function readDocumentSources(sql: SqlExecutor, workspaceId: string): Promise<DocumentSourceRow[]> {
  return (await sql.query<DocumentSourceRow>(`SELECT ${columns} FROM document_sources WHERE workspace_id=$1 AND removed_at IS NULL ORDER BY project_key,path,source_id`, [workspaceId])).rows;
}
export async function readDocumentSource(sql: SqlExecutor, reference: DocumentSourceReference, includeRemoved = false): Promise<DocumentSourceRow | undefined> {
  return (await sql.query<DocumentSourceRow>(`SELECT ${columns} FROM document_sources WHERE workspace_id=$1 AND source_id=$2${includeRemoved ? '' : ' AND removed_at IS NULL'}`, [reference.workspaceId, reference.sourceId])).rows[0];
}
export async function readDocumentSourceScopeRevisions(sql: SqlExecutor, workspaceId: string): Promise<Map<string, number>> {
  const result = await sql.query<{ project_key: string; revision: number }>('SELECT project_key,revision FROM document_source_scopes WHERE workspace_id=$1', [workspaceId]);
  return new Map(result.rows.map(row => [row.project_key, row.revision]));
}
export function documentSourceConflict(currentRevision: number): never {
  throw new DomainError('document_source_revision_conflict', 'The document source configuration changed; reload before saving again', 409, { currentRevision });
}
/** The caller owns a transaction plus the workspace and global directory locks.
 * All directory validation precedes this association-set CAS and its mutations. */
export async function writeDocumentSourceConfiguration(sql: SqlExecutor, scope: DocumentSourceScope, input: { directories: { path: string; device: string; inode: string }[]; expectedRevision: number; actorId: string }): Promise<{ revision: number; sources: DocumentSourceRow[] }> {
  const statement = input.expectedRevision === 0
    ? `INSERT INTO document_source_scopes(workspace_id,project_key,revision,updated_by)
      SELECT $1,$2,1,$4 WHERE $3::integer=0 ON CONFLICT(workspace_id,project_key) DO NOTHING RETURNING revision`
    : `UPDATE document_source_scopes SET revision=revision+1,updated_by=$4,updated_at=clock_timestamp()
      WHERE workspace_id=$1 AND project_key=$2 AND revision=$3 RETURNING revision`;
  const result = await sql.query<{ revision: number }>(statement, [scope.workspaceId, scope.projectId ?? '', input.expectedRevision, input.actorId]);
  if (!result.rows[0]) documentSourceConflict((await readDocumentSourceScopeRevisions(sql, scope.workspaceId)).get(scope.projectId ?? '') ?? 0);
  await sql.query(`UPDATE document_sources SET removed_at=clock_timestamp(),updated_at=clock_timestamp(),updated_by=$4
    WHERE workspace_id=$1 AND project_key=$2 AND removed_at IS NULL AND NOT(path=ANY($3::text[]))`,
  [scope.workspaceId, scope.projectId ?? '', input.directories.map(directory => directory.path), input.actorId]);
  const previous = (await readDocumentSources(sql, scope.workspaceId)).filter(row => row.project_key === (scope.projectId ?? ''));
  for (const directory of input.directories) {
    const existing = previous.find(row => row.path === directory.path);
    if (existing) {
      if (existing.directory_device !== directory.device || existing.directory_inode !== directory.inode)
        await sql.query(`UPDATE document_sources SET directory_device=$3,directory_inode=$4,revision=revision+1,updated_by=$5,updated_at=clock_timestamp()
          WHERE workspace_id=$1 AND source_id=$2`, [scope.workspaceId, existing.source_id, directory.device, directory.inode, input.actorId]);
    } else {
      await sql.query(`INSERT INTO document_sources(workspace_id,source_id,project_key,path,directory_device,directory_inode,revision,updated_by)
        VALUES($1,$2,$3,$4,$5,$6,1,$7)`, [scope.workspaceId, randomUUID(), scope.projectId ?? '', directory.path, directory.device, directory.inode, input.actorId]);
    }
  }
  return { revision: result.rows[0]!.revision, sources: (await readDocumentSources(sql, scope.workspaceId)).filter(row => row.project_key === (scope.projectId ?? '')) };
}

export type DocumentSourceOperationRequest = {
  action: DocumentSourceMutation['action']; path: string; sourceRevision: number;
  expectedRevision?: string; targetSourceId?: string; targetPath?: string; targetSourceRevision?: number;
  sourceRoot?: string; targetRoot?: string;
  /** Persisted pre-cutover requests are immutable evidence, not an HTTP alias. */
  targetScope?: string;
};
export type DocumentSourceOperationRow = {
  operation_id: string; source_id: string; source_project_key: string; request_hash: string; request: DocumentSourceOperationRequest;
  status: 'prepared' | 'applying' | 'succeeded' | 'not_applied' | 'unknown';
  receipt: DocumentSourceMutationReceipt | null;
};
/** Decode old SQL/disk evidence without changing its original request/proof hash. */
export function parseDocumentSourceReceipt(value: unknown): DocumentSourceMutationReceipt {
  if (value && typeof value === 'object' && 'targetScope' in value) {
    const { targetScope, ...receipt } = value as Record<string, unknown>;
    return documentSourceMutationReceiptSchema.parse({ ...receipt, targetSourceId: targetScope });
  }
  return documentSourceMutationReceiptSchema.parse(value);
}
function operationRow(row: DocumentSourceOperationRow | undefined): DocumentSourceOperationRow | undefined {
  return row ? { ...row, receipt: row.receipt ? parseDocumentSourceReceipt(row.receipt) : null } : undefined;
}
/** Autocommit while session-level locks are held: SQL rollback cannot undo IO. */
export async function beginDocumentSourceOperation(sql: SqlExecutor, reference: DocumentSourceReference, projectId: string | null, actorId: string, operationId: string, hash: string, request: DocumentSourceOperationRequest, historicalHash?: string): Promise<{ row: DocumentSourceOperationRow; created: boolean }> {
  const inserted = await sql.query<DocumentSourceOperationRow>(`INSERT INTO document_source_operations(workspace_id,actor_id,operation_id,source_id,source_project_key,request_hash,request)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(workspace_id,actor_id,operation_id) DO NOTHING RETURNING *`,
  [reference.workspaceId, actorId, operationId, reference.sourceId, projectId ?? '', hash, JSON.stringify(request)]);
  const row = operationRow(inserted.rows[0]) ?? await readDocumentSourceOperation(sql, reference, actorId, operationId);
  if (!row || row.source_id !== reference.sourceId || row.request_hash !== hash && row.request_hash !== historicalHash)
    throw new DomainError('document_source_operation_id_conflict', 'The operation ID was already used with different parameters', 409);
  return { row, created: Boolean(inserted.rows[0]) };
}
export async function readDocumentSourceOperation(sql: SqlExecutor, reference: DocumentSourceReference, actorId: string, operationId: string): Promise<DocumentSourceOperationRow | undefined> {
  return operationRow((await sql.query<DocumentSourceOperationRow>('SELECT * FROM document_source_operations WHERE workspace_id=$1 AND actor_id=$2 AND operation_id=$3', [reference.workspaceId, actorId, operationId])).rows[0]);
}
export async function dispatchDocumentSourceOperation(sql: SqlExecutor, reference: DocumentSourceReference, actorId: string, operationId: string, request: DocumentSourceOperationRequest): Promise<void> {
  const result = await sql.query("UPDATE document_source_operations SET status='applying',request=$4::jsonb,updated_at=clock_timestamp() WHERE workspace_id=$1 AND actor_id=$2 AND operation_id=$3 AND status='prepared' RETURNING operation_id", [reference.workspaceId, actorId, operationId, JSON.stringify(request)]);
  if (!result.rows[0]) throw new DomainError('document_source_operation_pending', 'Query the original operation before another write', 409);
}
export async function finishDocumentSourceOperation(sql: SqlExecutor, reference: DocumentSourceReference, actorId: string, receipt: DocumentSourceMutationReceipt): Promise<void> {
  await sql.query('UPDATE document_source_operations SET status=$4,receipt=$5::jsonb,updated_at=clock_timestamp() WHERE workspace_id=$1 AND actor_id=$2 AND operation_id=$3',
    [reference.workspaceId, actorId, receipt.operationId, receipt.status, receipt.status === 'unknown' ? null : JSON.stringify(receipt)]);
}
