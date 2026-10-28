import type { SqlExecutor } from '../../application/src/ports.ts';
import type { AgentScope } from '../../contracts/src/agent-file-areas.ts';
import { DomainError } from '../../domain/src/core.ts';

export type AgentFileAreaRow = { project_key: string; path: string; directory_device: string; directory_inode: string; revision: number; source: 'explicit' | 'default' };
export async function readAgentFileAreas(sql: SqlExecutor, workspaceId: string): Promise<Map<string, AgentFileAreaRow>> {
  const result = await sql.query<AgentFileAreaRow>('SELECT project_key,path,directory_device,directory_inode,revision,source FROM agent_file_areas WHERE workspace_id=$1', [workspaceId]);
  return new Map(result.rows.map(row => [row.project_key, row]));
}
export async function readAgentFileArea(sql: SqlExecutor, scope: AgentScope): Promise<AgentFileAreaRow | undefined> {
  return (await sql.query<AgentFileAreaRow>('SELECT project_key,path,directory_device,directory_inode,revision,source FROM agent_file_areas WHERE workspace_id=$1 AND project_key=$2', [scope.workspaceId, scope.projectId ?? ''])).rows[0];
}
export function agentFileAreaConflict(currentRevision: number): never {
  throw new DomainError('agent_file_area_revision_conflict', 'The Agent file area changed; reload before saving again', 409, { currentRevision });
}
/** Caller holds the shared workspace transaction lock; SQL CAS also prevents accidental overwrite. */
export async function writeAgentFileArea(sql: SqlExecutor, scope: AgentScope, input: { path: string; device: string; inode: string; expectedRevision: number; actorId: string; source: 'explicit' | 'default' }): Promise<AgentFileAreaRow> {
  const statement = input.expectedRevision === 0
    ? `INSERT INTO agent_file_areas(workspace_id,project_key,path,directory_device,directory_inode,revision,updated_by,source)
      SELECT $1,$2,$3,$4,$5,1,$7,$8 WHERE $6::integer=0
      ON CONFLICT(workspace_id,project_key) DO NOTHING
      RETURNING project_key,path,directory_device,directory_inode,revision,source`
    : `UPDATE agent_file_areas SET path=$3,directory_device=$4,directory_inode=$5,source=$8,
      revision=revision+1,updated_by=$7,updated_at=clock_timestamp()
      WHERE workspace_id=$1 AND project_key=$2 AND revision=$6
      RETURNING project_key,path,directory_device,directory_inode,revision,source`;
  const result = await sql.query<AgentFileAreaRow>(statement,
    [scope.workspaceId, scope.projectId ?? '', input.path, input.device, input.inode, input.expectedRevision, input.actorId, input.source]);
  if (result.rows[0]) return result.rows[0];
  return agentFileAreaConflict((await readAgentFileArea(sql, scope))?.revision ?? 0);
}
