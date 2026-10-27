import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { CAPABILITIES, DomainError } from '../../domain/src/core.ts';
import type { Actor, Capability } from '../../domain/src/core.ts';
import type { CommandRegistry, SqlExecutor } from './ports.ts';

export type Membership = { userId: string; workspaceId: string; capabilities: Capability[]; projectIds: string[] | null; version: number; revokedAt: string | null };
type MembershipRow = { user_id: string; workspace_id: string; capabilities: Capability[]; project_ids: string[] | null; version: number; revoked_at: Date | null };
function memberFromRow(row: MembershipRow): Membership {
  return { userId: row.user_id, workspaceId: row.workspace_id, capabilities: row.capabilities, projectIds: row.project_ids, version: row.version, revokedAt: row.revoked_at?.toISOString() ?? null };
}
export async function getMembership(sql: SqlExecutor, actor: Actor, workspaceId: string): Promise<Membership> {
  const result = await sql.query<MembershipRow>('SELECT m.* FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1 AND m.user_id=$2 AND m.revoked_at IS NULL AND u.disabled_at IS NULL', [workspaceId, actor.id]);
  if (!result.rows[0]) throw new DomainError('not_found_or_forbidden', 'Workspace is not accessible', 404);
  return memberFromRow(result.rows[0]);
}
export function assertProjectScope(member: Membership, projectId?: string | null): void {
  if (member.projectIds !== null && (!projectId || !member.projectIds.some(id => id.toLowerCase() === projectId.toLowerCase()))) throw new DomainError('not_found_or_forbidden', 'Resource is not accessible', 404);
}
export async function requireCapability(sql: SqlExecutor, actor: Actor, workspaceId: string, capability: Capability, projectId?: string | null): Promise<void> {
  const member = await getMembership(sql, actor, workspaceId);
  assertProjectScope(member, projectId);
  if (!member.capabilities.includes(capability)) throw new DomainError('permission_denied', `Capability ${capability} is required`, 403);
}
export async function listMembers(pool: Pool, actor: Actor, workspaceId: string): Promise<(Membership & { email: string; name: string })[]> {
  await requireCapability(pool, actor, workspaceId, 'access.manage');
  const result = await pool.query<MembershipRow & { email: string; name: string }>('SELECT m.*,u.email,u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1 ORDER BY m.created_at,m.user_id', [workspaceId]);
  return result.rows.map((row) => ({ ...memberFromRow(row), email: row.email, name: row.name }));
}
async function protectFinalAdministrator(sql: SqlExecutor, workspaceId: string, userId: string, keepAdmin: boolean): Promise<void> {
  if (keepAdmin) return;
  const admins = await sql.query<{ user_id: string }>("SELECT m.user_id FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1 AND m.revoked_at IS NULL AND m.project_ids IS NULL AND 'access.manage'=ANY(m.capabilities) AND u.disabled_at IS NULL", [workspaceId]);
  if (admins.rows.length === 1 && admins.rows[0]!.user_id === userId) throw new DomainError('last_administrator', 'The final workspace administrator cannot be removed', 409);
}
async function emitAccessEvent(sql: SqlExecutor, workspaceId: string, userId: string, version: number, actorId: string, commandId: string, eventType: string): Promise<void> {
  await sql.query(`INSERT INTO outbox(event_id,workspace_id,project_id,aggregate_id,aggregate_kind,aggregate_version,aggregate_sequence,event_type,payload,actor_id,command_id)
    SELECT $1,$2,NULL,$3,'membership',$4,coalesce(max(aggregate_sequence),0)+1,$5,$6::jsonb,$7,$8 FROM outbox WHERE workspace_id=$2 AND aggregate_id=$3`,
  [randomUUID(), workspaceId, userId, version, eventType, JSON.stringify({ userId, version }), actorId, commandId]);
}
export const accessCommands: CommandRegistry = {
  SetWorkspaceMember: {
    payload: z.object({ userId: z.uuid().toLowerCase(), capabilities: z.array(z.enum(CAPABILITIES)).max(CAPABILITIES.length).refine((xs) => new Set(xs).size === xs.length, 'Duplicate capabilities'), projectIds: z.array(z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/)).max(1000).refine((xs) => new Set(xs).size === xs.length, 'Duplicate project IDs').nullable() }).strict(),
    async handler(ctx) {
      await ctx.require('access.manage');
      const { userId, capabilities, projectIds } = ctx.command.payload as { userId: string; capabilities: Capability[]; projectIds: string[] | null };
      if (ctx.command.projectId || ctx.command.targetId && ctx.command.targetId !== userId) throw new DomainError('scope_mismatch', 'Membership command targets the workspace and member');
      if (capabilities.includes('access.manage') && projectIds !== null) throw new DomainError('validation_failed', 'Workspace administrators require workspace scope');
      if (ctx.core?.validateMemberProjects && projectIds) await ctx.core.validateMemberProjects(projectIds);
      else if (ctx.core && projectIds) {
        for (const projectId of projectIds) {
          const project = await ctx.core.get(projectId, 'project');
          if (project.workspaceId !== ctx.workspaceId || project.kind !== 'project' || project.data.archived === true || project.data.archivedAt) throw new DomainError('not_found_or_forbidden', 'Project does not exist or is unavailable in this workspace', 404);
        }
      }
      const user = await ctx.sql.query('SELECT id FROM users WHERE id=$1 AND disabled_at IS NULL', [userId]);
      if (!user.rowCount) throw new DomainError('not_found_or_forbidden', 'User does not exist', 404);
      const previous = await ctx.sql.query<MembershipRow>('SELECT * FROM memberships WHERE workspace_id=$1 AND user_id=$2', [ctx.workspaceId, userId]);
      const existing = previous.rows[0];
      if (existing && ctx.command.expectedVersions?.[userId] !== existing.version) throw new DomainError('version_conflict', 'Membership version changed', 409, { id: userId, currentVersion: existing.version });
      await protectFinalAdministrator(ctx.sql, ctx.workspaceId, userId, capabilities.includes('access.manage') && projectIds === null);
      const updated = await ctx.sql.query<MembershipRow>(`INSERT INTO memberships(workspace_id,user_id,capabilities,project_ids) VALUES($1,$2,$3,$4)
        ON CONFLICT(workspace_id,user_id) DO UPDATE SET capabilities=excluded.capabilities,project_ids=excluded.project_ids,revoked_at=NULL,version=memberships.version+1,updated_at=now()
        WHERE memberships.version=$5 RETURNING *`, [ctx.workspaceId, userId, capabilities, projectIds, existing?.version ?? null]);
      if (!updated.rows[0]) throw new DomainError('version_conflict', 'Membership version changed', 409);
      const member = memberFromRow(updated.rows[0]!);
      await emitAccessEvent(ctx.sql, ctx.workspaceId, userId, member.version, ctx.actor.id, ctx.command.commandId, 'WorkspaceMemberSet');
      return member;
    },
  },
  RevokeWorkspaceMember: {
    payload: z.object({ userId: z.uuid().toLowerCase() }).strict(),
    async handler(ctx) {
      await ctx.require('access.manage');
      const { userId } = ctx.command.payload as { userId: string };
      if (ctx.command.projectId || ctx.command.targetId && ctx.command.targetId !== userId) throw new DomainError('scope_mismatch', 'Membership command targets the workspace and member');
      const previous = await ctx.sql.query<MembershipRow>('SELECT * FROM memberships WHERE workspace_id=$1 AND user_id=$2', [ctx.workspaceId, userId]);
      const existing = previous.rows[0];
      if (!existing) throw new DomainError('not_found_or_forbidden', 'Member does not exist', 404);
      if (ctx.command.expectedVersions?.[userId] !== existing.version) throw new DomainError('version_conflict', 'Membership version changed', 409, { id: userId, currentVersion: existing.version });
      await protectFinalAdministrator(ctx.sql, ctx.workspaceId, userId, false);
      const updated = await ctx.sql.query<MembershipRow>('UPDATE memberships SET revoked_at=now(),version=version+1,updated_at=now() WHERE workspace_id=$1 AND user_id=$2 AND version=$3 RETURNING *', [ctx.workspaceId, userId, existing.version]);
      if (!updated.rows[0]) throw new DomainError('version_conflict', 'Membership version changed', 409);
      const member = memberFromRow(updated.rows[0]);
      await emitAccessEvent(ctx.sql, ctx.workspaceId, userId, member.version, ctx.actor.id, ctx.command.commandId, 'WorkspaceMemberRevoked');
      return member;
    },
  },
};
