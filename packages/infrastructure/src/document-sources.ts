import type { SqlExecutor } from '../../application/src/ports.ts';
import type { DocumentSourceScope } from '../../contracts/src/document-sources.ts';
import { DomainError } from '../../domain/src/core.ts';

export type DocumentSourceRow = { workspace_id: string; project_key: string; path: string | null; directory_device: string | null; directory_inode: string | null; revision: number };
const columns = 'workspace_id,project_key,path,directory_device,directory_inode,revision';
export async function readDocumentSources(sql: SqlExecutor, workspaceId: string): Promise<Map<string, DocumentSourceRow>> {
  const result = await sql.query<DocumentSourceRow>(`SELECT ${columns} FROM document_sources WHERE workspace_id=$1`, [workspaceId]);
  return new Map(result.rows.map(row => [row.project_key, row]));
}
export async function readDocumentSource(sql: SqlExecutor, scope: DocumentSourceScope): Promise<DocumentSourceRow | undefined> {
  return (await sql.query<DocumentSourceRow>(`SELECT ${columns} FROM document_sources WHERE workspace_id=$1 AND project_key=$2`, [scope.workspaceId, scope.projectId ?? ''])).rows[0];
}
export function documentSourceConflict(currentRevision: number): never {
  throw new DomainError('document_source_revision_conflict', 'The document source changed; reload before saving again', 409, { currentRevision });
}
/** The caller holds the workspace lock and the shared directory-claim lock. */
export async function writeDocumentSource(sql: SqlExecutor, scope: DocumentSourceScope, input: { path: string | null; device: string | null; inode: string | null; expectedRevision: number; actorId: string }): Promise<DocumentSourceRow> {
  const statement = input.expectedRevision === 0
    ? `INSERT INTO document_sources(workspace_id,project_key,path,directory_device,directory_inode,revision,updated_by)
      SELECT $1,$2,$3,$4,$5,1,$7 WHERE $6::integer=0 ON CONFLICT(workspace_id,project_key) DO NOTHING RETURNING ${columns}`
    : `UPDATE document_sources SET path=$3,directory_device=$4,directory_inode=$5,revision=revision+1,updated_by=$7,updated_at=clock_timestamp()
      WHERE workspace_id=$1 AND project_key=$2 AND revision=$6 RETURNING ${columns}`;
  const values = [scope.workspaceId, scope.projectId ?? '', input.path, input.device, input.inode, input.expectedRevision, input.actorId];
  const result = await sql.query<DocumentSourceRow>(statement, values);
  if (!result.rows[0]) return documentSourceConflict((await readDocumentSource(sql, scope))?.revision ?? 0);
  return result.rows[0];
}
