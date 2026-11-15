import { randomUUID } from 'node:crypto';
import { DomainError } from '../../domain/src/core.ts';
import type { ProjectTeam } from '../../domain/src/project-directory.ts';
import type { SqlExecutor } from './ports.ts';

type InvitationTeam = { id: string; version: number; data: ProjectTeam };

/** Caller holds the workspace lock and has checked current inviter authority. */
export async function readInvitationTeams(sql: SqlExecutor, workspaceId: string, teamIds: readonly string[]): Promise<InvitationTeam[]> {
  if (!teamIds.length) return [];
  const result = await sql.query<InvitationTeam>(`SELECT id,version,data FROM dashboard_records
    WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND kind='project_team' AND project_id IS NULL AND owner_id IS NULL
      AND data->>'archivedAt' IS NULL ORDER BY id FOR UPDATE`, [workspaceId, teamIds]);
  if (result.rows.length !== teamIds.length) throw new DomainError('invitation_team_unavailable', 'An invited team is no longer available; ask an administrator to replace the invitation', 409);
  return result.rows;
}

/** Runs after activation, in the SAME transaction as account/membership/acceptance. */
export async function joinInvitationTeams(sql: SqlExecutor, workspaceId: string, teams: readonly InvitationTeam[], userId: string, commandId: string): Promise<void> {
  for (const team of teams) {
    if (team.data.memberIds.includes(userId)) continue;
    if (team.data.memberIds.length >= 1000) throw new DomainError('team_member_limit', 'An invited team cannot accept another member', 409);
    const result = await sql.query<{ version: number }>(`UPDATE dashboard_records SET data=$1::jsonb,version=version+1,updated_at=clock_timestamp()
      WHERE workspace_id=$2 AND id=$3 AND version=$4 RETURNING version`,
    [JSON.stringify({ ...team.data, memberIds: [...team.data.memberIds, userId] }), workspaceId, team.id, team.version]);
    const updated = result.rows[0];
    if (!updated) throw new DomainError('version_conflict', 'Invited team version changed', 409);
    await sql.query(`INSERT INTO outbox(event_id,workspace_id,project_id,aggregate_id,aggregate_kind,aggregate_version,aggregate_sequence,event_type,payload,actor_id,command_id)
      SELECT $1,$2,NULL,$3,'project_team',$4,coalesce(max(aggregate_sequence),0)+1,'ProjectTeamMembersSet',$5::jsonb,$6,$7 FROM outbox WHERE workspace_id=$2 AND aggregate_id=$3`,
    [randomUUID(), workspaceId, team.id, updated.version, JSON.stringify({ id: team.id, kind: 'project_team', version: updated.version }), userId, commandId]);
  }
}
