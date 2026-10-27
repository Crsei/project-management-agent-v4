import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { DomainError } from '../../domain/src/core.ts';
import type { Actor } from '../../domain/src/core.ts';
import type { InvitationDeliveryStatus, InvitationFailureCode, InvitationListDto, InvitationStatus, MemberInvitationDto } from '../../domain/src/invitations.ts';
import { MEMBER_ROLES } from '../../domain/src/members.ts';
import type { MemberRole } from '../../domain/src/members.ts';
import { encryptMailToken } from '../../infrastructure/src/system-mail.ts';
import type { InvitationMailConfig } from '../../infrastructure/src/invitation-mail.ts';
import { lockWorkspace } from '../../infrastructure/src/database.ts';
import { requireCapability } from './access.ts';
import type { CommandContext, CommandRegistry, SqlExecutor } from './ports.ts';

export type InvitationProjectValidator = (sql: SqlExecutor, actor: Actor, workspaceId: string, projectIds: string[]) => Promise<void>;
export type InvitationRow = {
  id: string; workspace_id: string; email: string; role: MemberRole; project_ids: string[] | null;
  status: InvitationStatus; version: number; generation: number; token_hash: string; invited_by: string;
  accepted_by: string | null; accepted_at: Date | null; expires_at: Date; created_at: Date; updated_at: Date;
  delivery_status?: InvitationDeliveryStatus; failure_code?: InvitationFailureCode | null; delivery_updated_at?: Date;
};
export const invitationColumns = `SELECT i.*,q.status AS delivery_status,q.failure_code,q.updated_at AS delivery_updated_at
  FROM member_invitations i LEFT JOIN invitation_mail_queue q ON q.invitation_id=i.id AND q.generation=i.generation`;
export function invitationTokenHash(token: string): string { return createHash('sha256').update(token).digest('hex'); }
export function invitationDto(row: InvitationRow, now = new Date()): MemberInvitationDto {
  return { id: row.id, workspaceId: row.workspace_id, email: row.email, role: row.role, projectIds: row.project_ids,
    status: row.status === 'pending' && row.expires_at <= now ? 'expired' : row.status, version: row.version,
    expiresAt: row.expires_at.toISOString(), createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    invitedBy: row.invited_by, acceptedAt: row.accepted_at?.toISOString() ?? null,
    delivery: row.delivery_status ? { status: row.delivery_status, failureCode: row.failure_code ?? null, updatedAt: row.delivery_updated_at!.toISOString() } : null };
}
export async function listMemberInvitations(pool: Pool, actor: Actor, workspaceId: string, config?: InvitationMailConfig): Promise<InvitationListDto> {
  const sql = await pool.connect();
  try {
    await sql.query('BEGIN');
    await lockWorkspace(sql, workspaceId);
    await requireCapability(sql, actor, workspaceId, 'access.manage');
    const result = await sql.query<InvitationRow>(`${invitationColumns} WHERE i.workspace_id=$1 ORDER BY i.created_at DESC,i.id`, [workspaceId]);
    await sql.query('COMMIT');
    return { enabled: Boolean(config), items: result.rows.map(row => invitationDto(row)) };
  } catch (error) { await sql.query('ROLLBACK'); throw error; }
  finally { sql.release(); }
}

async function projectsForCommand(ctx: CommandContext, projectIds: string[] | null, validator?: InvitationProjectValidator): Promise<void> {
  if (!projectIds?.length) return;
  if (validator) return validator(ctx.sql, ctx.actor, ctx.workspaceId, projectIds);
  if (ctx.core?.validateMemberProjects) return ctx.core.validateMemberProjects(projectIds);
  if (!ctx.core) throw new DomainError('project_validation_unavailable', 'Authoritative project validation is unavailable', 503);
  for (const id of projectIds) {
    const project = await ctx.core.get(id, 'project');
    if (project.workspaceId !== ctx.workspaceId || project.data.archived === true || project.data.archivedAt) throw new DomainError('not_found_or_forbidden', 'Invitation project is unavailable', 404);
  }
}
async function invitationEvent(sql: SqlExecutor, row: InvitationRow, actorId: string, commandId: string, eventType: string): Promise<void> {
  await sql.query(`INSERT INTO outbox(event_id,workspace_id,project_id,aggregate_id,aggregate_kind,aggregate_version,aggregate_sequence,event_type,payload,actor_id,command_id)
    SELECT $1,$2,NULL,$3,'member_invitation',$4,coalesce(max(aggregate_sequence),0)+1,$5,$6::jsonb,$7,$8 FROM outbox WHERE workspace_id=$2 AND aggregate_id=$3`,
  [randomUUID(), row.workspace_id, row.id, row.version, eventType, JSON.stringify({ invitationId: row.id, version: row.version, status: row.status }), actorId, commandId]);
}
async function queueMail(sql: SqlExecutor, row: InvitationRow, token: string, config: InvitationMailConfig): Promise<void> {
  await sql.query('INSERT INTO invitation_mail_queue(id,invitation_id,generation,token_ciphertext) VALUES($1,$2,$3,$4)',
    [randomUUID(), row.id, row.generation, encryptMailToken(config.tokenKey, row.id, token)]);
}
async function currentInvitation(ctx: CommandContext): Promise<InvitationRow> {
  await ctx.require('access.manage');
  if (ctx.command.projectId || !z.uuid().safeParse(ctx.command.targetId).success) throw new DomainError('scope_mismatch', 'Invitation commands target a workspace invitation');
  const result = await ctx.sql.query<InvitationRow>(`${invitationColumns} WHERE i.workspace_id=$1 AND i.id=$2 FOR UPDATE OF i`, [ctx.workspaceId, ctx.command.targetId]);
  const row = result.rows[0];
  if (!row) throw new DomainError('not_found_or_forbidden', 'Invitation is not accessible', 404);
  if (ctx.command.expectedVersions?.[row.id] !== row.version) throw new DomainError('version_conflict', 'Invitation version changed', 409, { id: row.id, currentVersion: row.version });
  return row;
}
async function rejectExistingMember(sql: SqlExecutor, workspaceId: string, email: string): Promise<void> {
  const existing = await sql.query(`SELECT 1 FROM users u JOIN memberships m ON m.user_id=u.id WHERE u.email=$1 AND m.workspace_id=$2 AND m.revoked_at IS NULL`, [email, workspaceId]);
  if (existing.rowCount) throw new DomainError('member_already_exists', 'This account is already an active workspace member', 409);
  const disabled = await sql.query('SELECT 1 FROM users WHERE email=$1 AND disabled_at IS NOT NULL', [email]);
  if (disabled.rowCount) throw new DomainError('account_unavailable', 'The invited account is unavailable', 409);
}
function enabled(config: InvitationMailConfig | undefined): InvitationMailConfig {
  if (!config) throw new DomainError('invitation_mail_disabled', 'Email invitations are not configured', 409);
  return config;
}
const createPayload = z.strictObject({ email: z.email().max(254).transform(email => email.trim().toLowerCase()), role: z.enum(MEMBER_ROLES),
  projectIds: z.array(z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/)).max(1000).refine(ids => new Set(ids).size === ids.length, 'Duplicate project IDs').nullable() });

/** All handlers run under the kernel's workspace lock, command receipt transaction and CAS rules. */
export function createInvitationCommands(config?: InvitationMailConfig, validateProjects?: InvitationProjectValidator): CommandRegistry {
  return {
    CreateMemberInvitation: {
      payload: createPayload,
      async handler(ctx): Promise<MemberInvitationDto> {
        await ctx.require('access.manage');
        const mail = enabled(config);
        if (ctx.command.projectId || ctx.command.targetId) throw new DomainError('scope_mismatch', 'Invitation creation targets the workspace');
        const payload = createPayload.parse(ctx.command.payload);
        if (payload.role === 'admin' && payload.projectIds !== null) throw new DomainError('validation_failed', 'Administrators require workspace scope');
        await projectsForCommand(ctx, payload.projectIds, validateProjects);
        await rejectExistingMember(ctx.sql, ctx.workspaceId, payload.email);
        await ctx.sql.query("UPDATE member_invitations SET status='expired',version=version+1,updated_at=now() WHERE workspace_id=$1 AND email=$2 AND status='pending' AND expires_at<=now()", [ctx.workspaceId, payload.email]);
        const prior = await ctx.sql.query("SELECT id FROM member_invitations WHERE workspace_id=$1 AND email=$2 AND status='pending'", [ctx.workspaceId, payload.email]);
        if (prior.rowCount) throw new DomainError('invitation_already_pending', 'An active invitation already exists for this email', 409);
        const token = randomBytes(32).toString('base64url');
        const result = await ctx.sql.query<InvitationRow>(`INSERT INTO member_invitations(id,workspace_id,email,role,project_ids,token_hash,invited_by,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,now()+$8*interval '1 second') RETURNING *`,
        [randomUUID(), ctx.workspaceId, payload.email, payload.role, payload.projectIds, invitationTokenHash(token), ctx.actor.id, mail.ttlSeconds]);
        const row = result.rows[0]!;
        await queueMail(ctx.sql, row, token, mail);
        await invitationEvent(ctx.sql, row, ctx.actor.id, ctx.command.commandId, 'MemberInvitationCreated');
        return invitationDto({ ...row, delivery_status: 'queued', failure_code: null, delivery_updated_at: row.updated_at });
      },
    },
    RevokeMemberInvitation: {
      payload: z.strictObject({}),
      async handler(ctx): Promise<MemberInvitationDto> {
        const row = await currentInvitation(ctx);
        if (row.status === 'accepted' || row.status === 'revoked') throw new DomainError('invitation_not_pending', 'This invitation cannot be revoked', 409);
        const result = await ctx.sql.query<InvitationRow>("UPDATE member_invitations SET status='revoked',version=version+1,updated_at=now() WHERE id=$1 RETURNING *", [row.id]);
        await ctx.sql.query("UPDATE invitation_mail_queue SET status='cancelled',token_ciphertext=NULL,updated_at=now() WHERE invitation_id=$1 AND status='queued'", [row.id]);
        const updated = result.rows[0]!;
        await invitationEvent(ctx.sql, updated, ctx.actor.id, ctx.command.commandId, 'MemberInvitationRevoked');
        const view = await ctx.sql.query<InvitationRow>(`${invitationColumns} WHERE i.id=$1`, [row.id]);
        return invitationDto(view.rows[0]!);
      },
    },
    ResendMemberInvitation: {
      payload: z.strictObject({}),
      async handler(ctx): Promise<MemberInvitationDto> {
        const row = await currentInvitation(ctx);
        const mail = enabled(config);
        if (row.status === 'accepted' || row.status === 'revoked') throw new DomainError('invitation_not_pending', 'This invitation cannot be resent', 409);
        if (row.delivery_status === 'sending') throw new DomainError('invitation_send_in_progress', 'Wait for the sending attempt to resolve before explicitly resending', 409);
        await projectsForCommand(ctx, row.project_ids, validateProjects);
        await rejectExistingMember(ctx.sql, ctx.workspaceId, row.email);
        const other = await ctx.sql.query("SELECT 1 FROM member_invitations WHERE workspace_id=$1 AND email=$2 AND status='pending' AND id<>$3", [ctx.workspaceId, row.email, row.id]);
        if (other.rowCount) throw new DomainError('invitation_already_pending', 'Another active invitation exists for this email', 409);
        const token = randomBytes(32).toString('base64url');
        const result = await ctx.sql.query<InvitationRow>(`UPDATE member_invitations SET status='pending',token_hash=$2,generation=generation+1,version=version+1,
          invited_by=$3,expires_at=now()+$4*interval '1 second',updated_at=now() WHERE id=$1 RETURNING *`, [row.id, invitationTokenHash(token), ctx.actor.id, mail.ttlSeconds]);
        await ctx.sql.query("UPDATE invitation_mail_queue SET status='cancelled',token_ciphertext=NULL,updated_at=now() WHERE invitation_id=$1 AND status='queued'", [row.id]);
        const updated = result.rows[0]!;
        await queueMail(ctx.sql, updated, token, mail);
        await invitationEvent(ctx.sql, updated, ctx.actor.id, ctx.command.commandId, 'MemberInvitationResent');
        return invitationDto({ ...updated, delivery_status: 'queued', failure_code: null, delivery_updated_at: updated.updated_at });
      },
    },
  };
}
