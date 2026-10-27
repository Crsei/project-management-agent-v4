import { randomUUID } from 'node:crypto';
import { DomainError } from '../../domain/src/core.ts';
import type { Actor } from '../../domain/src/core.ts';
import type { WorkspaceIdentity, WorkspaceIcon, WorkspaceColor } from '../../domain/src/workspace-identity.ts';
import { updateWorkspaceIdentityPayloadSchema } from '../../contracts/src/workspace-identity.ts';
import { getMembership } from './access.ts';
import type { CommandRegistry, SqlExecutor } from './ports.ts';

type IdentityRow = {
  id: string; name: string; icon: WorkspaceIcon; color: WorkspaceColor;
  identity_version: number; identity_updated_at: Date;
};
function identityFromRow(row: IdentityRow): WorkspaceIdentity {
  return { workspaceId: row.id, name: row.name, icon: row.icon, color: row.color,
    version: row.identity_version, updatedAt: row.identity_updated_at.toISOString() };
}

/** The same minimal presentation facts already visible in authorized workspace selection. */
export async function readWorkspaceIdentity(sql: SqlExecutor, actor: Actor, workspaceId: string): Promise<WorkspaceIdentity> {
  await getMembership(sql, actor, workspaceId);
  const result = await sql.query<IdentityRow>(`SELECT w.id,w.name,w.icon,w.color,w.identity_version,w.identity_updated_at
    FROM workspaces w JOIN memberships m ON m.workspace_id=w.id JOIN users u ON u.id=m.user_id
    WHERE w.id=$1 AND m.user_id=$2 AND m.revoked_at IS NULL AND u.disabled_at IS NULL`, [workspaceId, actor.id]);
  if (!result.rows[0]) throw new DomainError('not_found_or_forbidden', 'Workspace is not accessible', 404);
  return identityFromRow(result.rows[0]);
}

export const workspaceIdentityCommands: CommandRegistry = {
  UpdateWorkspaceIdentity: {
    payload: updateWorkspaceIdentityPayloadSchema,
    async handler(ctx): Promise<WorkspaceIdentity> {
      await ctx.require('access.manage');
      if (ctx.command.projectId || ctx.command.targetId !== ctx.workspaceId) {
        throw new DomainError('scope_mismatch', 'Workspace identity requires its workspace target and no project scope');
      }
      const payload = updateWorkspaceIdentityPayloadSchema.parse(ctx.command.payload);
      const updated = await ctx.sql.query<IdentityRow>(`UPDATE workspaces SET name=$2,icon=$3,color=$4,
        identity_version=identity_version+1,identity_updated_at=clock_timestamp()
        WHERE id=$1 AND identity_version=$5 RETURNING id,name,icon,color,identity_version,identity_updated_at`,
      [ctx.workspaceId, payload.name, payload.icon, payload.color, ctx.command.expectedVersions?.[ctx.workspaceId] ?? null]);
      if (!updated.rows[0]) {
        const current = await readWorkspaceIdentity(ctx.sql, ctx.actor, ctx.workspaceId);
        throw new DomainError('version_conflict', 'Workspace identity version changed or expected version is missing', 409,
          { id: ctx.workspaceId, currentVersion: current.version });
      }
      const identity = identityFromRow(updated.rows[0]);
      // Metadata-only invalidation: never publishes account, membership, project or draft contents.
      await ctx.sql.query(`INSERT INTO outbox(event_id,workspace_id,project_id,aggregate_id,aggregate_kind,aggregate_version,aggregate_sequence,event_type,payload,actor_id,command_id)
        SELECT $1,$2,NULL,$2,'workspace_identity',$3,coalesce(max(aggregate_sequence),0)+1,'WorkspaceIdentityUpdated',$4::jsonb,$5,$6
        FROM outbox WHERE workspace_id=$2 AND aggregate_id=$2`,
      [randomUUID(), ctx.workspaceId, identity.version, JSON.stringify({ id: ctx.workspaceId, kind: 'workspace_identity', version: identity.version }), ctx.actor.id, ctx.command.commandId]);
      return identity;
    },
  },
};
