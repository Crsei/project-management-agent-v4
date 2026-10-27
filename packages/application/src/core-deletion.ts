import { DomainError } from '../../domain/src/core.ts';
import type { FileRecord } from '../../pm-schema/index.ts';
import type { SqlExecutor } from './ports.ts';

/** Under the workspace lock, retain all SQL-owned business history before a core tombstone. */
export async function assertCoreDeletionSafe(sql: SqlExecutor, workspaceId: string, record: FileRecord): Promise<void> {
  if (record.entity.entity !== 'project' && record.entity.entity !== 'work_item') return;
  const project = record.entity.entity === 'project';
  const result = await sql.query(`SELECT source FROM (
    SELECT 'entities' AS source FROM entities WHERE workspace_id=$1 AND
      (CASE WHEN $3::boolean THEN project_id=$2 ELSE data->>'workItemId'=$2 OR data->>'taskId'=$2 END)
    UNION ALL SELECT 'dashboard_records' FROM dashboard_records WHERE workspace_id=$1 AND kind NOT IN ('project_favorite','task_watch') AND
      (CASE WHEN $3::boolean THEN project_id=$2 OR data->>'projectId'=$2 ELSE data->>'taskId'=$2 OR data->>'workItemId'=$2 END)
    UNION ALL SELECT 'task_comments' FROM task_comments WHERE workspace_id=$1 AND
      (CASE WHEN $3::boolean THEN project_id=$2 ELSE task_id=$2 END)
    UNION ALL SELECT 'artifact_copy_origins' FROM artifact_copy_origins WHERE workspace_id=$1 AND $3::boolean
      AND (source_project_id=$2 OR target_project_id=$2)
    UNION ALL SELECT 'automation_rules' FROM automation_rules WHERE workspace_id=$1 AND $3::boolean AND project_id=$2
  ) retained LIMIT 1`, [workspaceId, record.id, project]);
  if (result.rows.length) throw new DomainError('DELETE_REFERENCED', 'Permanent deletion is blocked by retained SQL business records or immutable history; archive the object instead', 422);
  // Audit, command receipts and service facts deliberately survive with tombstoned stable IDs.
  // They record deletion itself and must neither prohibit every delete nor be cascaded away.
}
