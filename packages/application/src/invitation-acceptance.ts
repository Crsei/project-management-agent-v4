import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { DomainError } from '../../domain/src/core.ts';
import type { Actor } from '../../domain/src/core.ts';
import type { InvitationAcceptDto, InvitationInspectDto, InvitationReceiptDto } from '../../domain/src/invitations.ts';
import { memberRoleCapabilities } from '../../domain/src/members.ts';
import { hashPassword, verifyPassword } from '../../infrastructure/src/auth.ts';
import { lockWorkspace } from '../../infrastructure/src/database.ts';
import { requireCapability } from './access.ts';
import { invitationTokenHash } from './invitations.ts';
import type { InvitationProjectValidator, InvitationRow } from './invitations.ts';

const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const inspectInvitationPayload = z.strictObject({ token: tokenSchema });
export const acceptInvitationPayload = z.strictObject({ commandId: z.uuid().toLowerCase(), token: tokenSchema,
  password: z.string().max(256), name: z.string().trim().min(1).max(200).optional() });
export const invitationReceiptPayload = z.strictObject({ commandId: z.uuid().toLowerCase(), token: tokenSchema, password: z.string().max(256) });
export type InvitationAcceptanceOptions = { validateProjects?: InvitationProjectValidator };
type InvitationUser = Actor & { password_hash: string; disabled_at: Date | null };
type AcceptanceReceipt = { invitation_id: string; user_id: string; requested_name: string | null; result: InvitationAcceptDto };

/** Only token digests are used for lookup. Errors intentionally never echo request values. */
async function withInvitation<T>(pool: Pool, token: string, operation: (sql: PoolClient, row: InvitationRow) => Promise<T>): Promise<T> {
  const digest = invitationTokenHash(token);
  const sql = await pool.connect();
  try {
    await sql.query('BEGIN');
    const initial = await sql.query<{ workspace_id: string }>('SELECT workspace_id FROM member_invitations WHERE token_hash=$1', [digest]);
    if (!initial.rows[0]) throw new DomainError('invitation_invalid', 'Invitation is invalid or unavailable', 404);
    await lockWorkspace(sql, initial.rows[0].workspace_id);
    const result = await sql.query<InvitationRow>('SELECT * FROM member_invitations WHERE token_hash=$1 FOR UPDATE', [digest]);
    const row = result.rows[0];
    if (!row || row.status === 'revoked') throw new DomainError('invitation_invalid', 'Invitation is invalid or unavailable', 404);
    const clock = await sql.query<{ expired: boolean }>('SELECT $1::timestamptz<=clock_timestamp() AS expired', [row.expires_at]);
    // A committed acceptance remains recoverable with its original token and account password;
    // this never grants membership again. Unconsumed expired tokens remain invalid.
    if (row.status === 'expired' || row.status !== 'accepted' && clock.rows[0]!.expired) throw new DomainError('invitation_expired', 'Invitation has expired', 410);
    // A normalized-email lock serializes invited account creation across workspaces too.
    await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 724633))', [row.email]);
    const value = await operation(sql, row);
    await sql.query('COMMIT');
    return value;
  } catch (error) {
    await sql.query('ROLLBACK');
    if (error && typeof error === 'object' && 'code' in error && error.code === '23505') throw new DomainError('idempotency_conflict', 'An acceptance or account already exists for this request', 409);
    throw error;
  } finally { sql.release(); }
}
async function invitedAccount(sql: PoolClient, email: string): Promise<InvitationUser | undefined> {
  const result = await sql.query<InvitationUser>('SELECT id,email,name,password_hash,disabled_at FROM users WHERE email=$1 FOR UPDATE', [email]);
  const user = result.rows[0];
  if (user?.disabled_at) throw new DomainError('account_unavailable', 'The invited account is unavailable', 403);
  return user;
}
async function currentInviter(sql: PoolClient, row: InvitationRow, options: InvitationAcceptanceOptions): Promise<void> {
  const result = await sql.query<Actor>('SELECT id,email,name FROM users WHERE id=$1 AND disabled_at IS NULL', [row.invited_by]);
  if (!result.rows[0]) throw new DomainError('invitation_authority_revoked', 'The invitation no longer has administrator authorization', 403);
  try { await requireCapability(sql, result.rows[0], row.workspace_id, 'access.manage'); }
  catch (error) {
    if (error instanceof DomainError) throw new DomainError('invitation_authority_revoked', 'The invitation no longer has administrator authorization', 403);
    throw error;
  }
  if (row.role === 'admin' && row.project_ids !== null) throw new DomainError('invitation_invalid', 'Invitation scope is invalid', 409);
  if (row.project_ids?.length) {
    if (!options.validateProjects) throw new DomainError('project_validation_unavailable', 'Authoritative project validation is unavailable', 503);
    await options.validateProjects(sql, result.rows[0], row.workspace_id, row.project_ids);
  }
}
async function authenticateInvitee(user: InvitationUser, password: string): Promise<void> {
  if (!await verifyPassword(password, user.password_hash)) throw new DomainError('invalid_credentials', 'The existing account password is required', 401);
}

export async function inspectMemberInvitation(pool: Pool, input: unknown, options: InvitationAcceptanceOptions = {}): Promise<InvitationInspectDto> {
  const payload = inspectInvitationPayload.parse(input);
  return withInvitation(pool, payload.token, async (sql, row) => {
    if (row.status !== 'pending') throw new DomainError('invitation_already_accepted', 'This invitation has already been accepted', 409);
    await currentInviter(sql, row, options);
    const user = await invitedAccount(sql, row.email);
    const workspace = await sql.query<{ name: string }>('SELECT name FROM workspaces WHERE id=$1', [row.workspace_id]);
    return { workspaceId: row.workspace_id, workspaceName: workspace.rows[0]!.name, email: row.email,
      role: row.role, projectIds: row.project_ids, expiresAt: row.expires_at.toISOString(), accountExists: Boolean(user) };
  });
}

export async function getMemberInvitationAcceptance(pool: Pool, input: unknown, options: InvitationAcceptanceOptions = {}): Promise<InvitationReceiptDto> {
  const payload = invitationReceiptPayload.parse(input);
  return withInvitation(pool, payload.token, async (sql, row) => {
    const user = await invitedAccount(sql, row.email);
    if (user) await authenticateInvitee(user, payload.password);
    const result = await sql.query<AcceptanceReceipt>('SELECT * FROM invitation_acceptance_receipts WHERE command_id=$1', [payload.commandId]);
    const receipt = result.rows[0];
    if (receipt) {
      if (receipt.invitation_id !== row.id || receipt.user_id !== user?.id) throw new DomainError('idempotency_conflict', 'Command ID already represents another acceptance', 409);
      return { outcome: receipt.result };
    }
    if (row.status !== 'pending') throw new DomainError('invitation_already_accepted', 'This invitation was accepted by another command', 409);
    await currentInviter(sql, row, options);
    return { outcome: null };
  });
}

export async function acceptMemberInvitation(pool: Pool, input: unknown, options: InvitationAcceptanceOptions = {}): Promise<InvitationAcceptDto> {
  const payload = acceptInvitationPayload.parse(input);
  return withInvitation(pool, payload.token, async (sql, row) => {
    let user = await invitedAccount(sql, row.email);
    if (user) await authenticateInvitee(user, payload.password);
    const prior = await sql.query<AcceptanceReceipt>('SELECT * FROM invitation_acceptance_receipts WHERE command_id=$1', [payload.commandId]);
    if (prior.rows[0]) {
      const receipt = prior.rows[0];
      if (receipt.invitation_id !== row.id || receipt.user_id !== user?.id || receipt.requested_name !== (payload.name ?? null)) throw new DomainError('idempotency_conflict', 'Command ID already represents another acceptance request', 409);
      return receipt.result;
    }
    if (row.status !== 'pending') throw new DomainError('invitation_already_accepted', 'This invitation was already accepted', 409);
    await currentInviter(sql, row, options);
    if (!user) {
      if (!payload.name || payload.password.length < 12) throw new DomainError('validation_failed', 'New accounts require a name and a password of at least 12 characters', 400);
      const passwordHash = await hashPassword(payload.password);
      const created = await sql.query<InvitationUser>('INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,$4) RETURNING id,email,name,password_hash,disabled_at',
        [randomUUID(), row.email, payload.name, passwordHash]);
      user = created.rows[0]!;
    }
    // Refuse stale invitations rather than overwriting an existing active grant.
    const membership = await sql.query<{ version: number }>(`INSERT INTO memberships(workspace_id,user_id,capabilities,project_ids)
      VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,user_id) DO UPDATE SET capabilities=excluded.capabilities,project_ids=excluded.project_ids,
      revoked_at=NULL,version=memberships.version+1,updated_at=now() WHERE memberships.revoked_at IS NOT NULL RETURNING version`,
    [row.workspace_id, user.id, memberRoleCapabilities(row.role), row.project_ids]);
    if (!membership.rows[0]) throw new DomainError('member_already_exists', 'This account is already an active workspace member', 409);
    const accepted = await sql.query<InvitationRow>(`UPDATE member_invitations SET status='accepted',accepted_by=$2,accepted_at=clock_timestamp(),version=version+1,updated_at=now()
      WHERE id=$1 AND status='pending' AND expires_at>clock_timestamp() RETURNING *`, [row.id, user.id]);
    if (!accepted.rows[0]) throw new DomainError('invitation_expired', 'Invitation has expired', 410);
    await sql.query("UPDATE invitation_mail_queue SET status='cancelled',token_ciphertext=NULL,updated_at=now() WHERE invitation_id=$1 AND status='queued'", [row.id]);
    const outcome: InvitationAcceptDto = { workspaceId: row.workspace_id, userId: user.id, email: row.email, alreadyAccepted: false };
    await sql.query('INSERT INTO invitation_acceptance_receipts(command_id,invitation_id,user_id,requested_name,result) VALUES($1,$2,$3,$4,$5::jsonb)',
      [payload.commandId, row.id, user.id, payload.name ?? null, JSON.stringify(outcome)]);
    for (const event of [
      { id: row.id, kind: 'member_invitation', version: accepted.rows[0].version, type: 'MemberInvitationAccepted', payload: { invitationId: row.id, userId: user.id, version: accepted.rows[0].version } },
      { id: user.id, kind: 'membership', version: membership.rows[0].version, type: 'WorkspaceMemberSet', payload: { userId: user.id, version: membership.rows[0].version } },
    ]) {
      await sql.query(`INSERT INTO outbox(event_id,workspace_id,project_id,aggregate_id,aggregate_kind,aggregate_version,aggregate_sequence,event_type,payload,actor_id,command_id)
        SELECT $1,$2,NULL,$3,$4,$5,coalesce(max(aggregate_sequence),0)+1,$6,$7::jsonb,$8,$9 FROM outbox WHERE workspace_id=$2 AND aggregate_id=$3`,
      [randomUUID(), row.workspace_id, event.id, event.kind, event.version, event.type, JSON.stringify(event.payload), user.id, payload.commandId]);
    }
    return outcome;
  });
}
