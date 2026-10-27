import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { DomainError } from '../../domain/src/core.ts';
import { authenticate, consumeAuthRateLimit, hashPassword, verifyPassword } from '../../infrastructure/src/auth.ts';
import type { AccountSecurity, AccountSecurityAction, AccountSecurityActionKind, AccountSecurityActionLookup, AccountSecurityErrorCode } from '../../contracts/src/account-security.ts';
import { accountSecurityActionParamsSchema, changeOwnPasswordSchema, recoverAccountSecurityActionSchema, revokeOwnSessionsSchema } from '../../contracts/src/account-security-schemas.ts';

export type SecurityUser = { id: string; credential_version: number; password_hash: string; password_changed_at: Date | null; disabled_at: Date | null; recovery_email: string | null; recovery_email_verified_at: Date | null; recovery_email_version: number };
export type SecurityContext = { sql: PoolClient; user: SecurityUser; sessionId: string };
type ActionRow = { action_id: string; kind: AccountSecurityActionKind; status: AccountSecurityAction['status']; credential_version: number; recovery_email_version: number; challenge_id: string | null; revoked_count: number; error_code: AccountSecurityErrorCode | null; http_status: number; occurred_at: Date };
function actionDto(row: ActionRow): AccountSecurityAction {
  return { actionId: row.action_id, kind: row.kind, status: row.status, credentialVersion: row.credential_version, recoveryEmailVersion: row.recovery_email_version, challengeId: row.challenge_id, revokedCount: row.revoked_count, errorCode: row.error_code, httpStatus: row.http_status, occurredAt: row.occurred_at.toISOString() };
}

/** Re-check the actual session AFTER acquiring the user lock, including lock waits. */
export async function withSecurity<T>(pool: Pool, token: string, operation: (ctx: SecurityContext) => Promise<T>): Promise<T> {
  const actor = await authenticate(pool, token);
  const sql = await pool.connect();
  try {
    await sql.query('BEGIN');
    const users = await sql.query<SecurityUser>('SELECT id,credential_version,password_hash,password_changed_at,disabled_at FROM users WHERE id=$1 FOR UPDATE', [actor.id]);
    const user = users.rows[0];
    const sessions = await sql.query<{ id: string }>('SELECT id FROM sessions WHERE user_id=$1 AND token_hash=$2 AND expires_at>clock_timestamp()', [actor.id, createHash('sha256').update(token).digest('hex')]);
    if (!user || user.disabled_at || !sessions.rows[0]) throw new DomainError('unauthenticated', 'Session is invalid or expired', 401);
    const recovery = await sql.query<Pick<SecurityUser, 'recovery_email' | 'recovery_email_verified_at' | 'recovery_email_version'>>('SELECT recovery_email,recovery_email_verified_at,recovery_email_version FROM users WHERE id=$1', [actor.id]);
    Object.assign(user, recovery.rows[0]);
    const result = await operation({ sql, user, sessionId: sessions.rows[0].id });
    await sql.query('COMMIT');
    return result;
  } catch (error) { await sql.query('ROLLBACK'); throw error; }
  finally { sql.release(); }
}
async function readAction(ctx: SecurityContext, actionId: string): Promise<AccountSecurityAction | null> {
  const result = await ctx.sql.query<ActionRow>('SELECT * FROM account_security_actions WHERE user_id=$1 AND action_id=$2', [ctx.user.id, actionId]);
  return result.rows[0] ? actionDto(result.rows[0]) : null;
}
export async function recordAction(ctx: SecurityContext, actionId: string, kind: AccountSecurityActionKind, status: AccountSecurityAction['status'], revokedCount = 0, errorCode: AccountSecurityErrorCode | null = null, httpStatus = 200, challengeId: string | null = null): Promise<AccountSecurityAction> {
  const result = await ctx.sql.query<ActionRow>(`INSERT INTO account_security_actions(user_id,action_id,kind,status,credential_version,revoked_count,error_code,http_status,recovery_email_version,challenge_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
  [ctx.user.id, actionId, kind, status, ctx.user.credential_version, revokedCount, errorCode, httpStatus, ctx.user.recovery_email_version, challengeId]);
  return actionDto(result.rows[0]!);
}
export async function requireUnused(ctx: SecurityContext, actionId: string): Promise<void> {
  if (await readAction(ctx, actionId)) throw new DomainError('security_action_already_recorded', 'This action ID is already closed; query its original result instead of resending credentials', 409);
}

export async function getAccountSecurity(pool: Pool, token: string): Promise<AccountSecurity> {
  return withSecurity(pool, token, async ctx => {
    const result = await ctx.sql.query<{ id: string; created_at: Date; expires_at: Date }>('SELECT id,created_at,expires_at FROM sessions WHERE user_id=$1 AND expires_at>clock_timestamp() ORDER BY created_at DESC,id', [ctx.user.id]);
    const pending = await ctx.sql.query<{ id: string; candidate_email: string; expires_at: Date; delivery_id: string; status: 'queued' | 'sending' | 'smtp_accepted' | 'failed' | 'unknown' | 'cancelled'; failure_code: string | null }>(`SELECT t.id,t.candidate_email,t.expires_at,q.id AS delivery_id,q.status,q.failure_code FROM account_recovery_tokens t JOIN account_recovery_mail_queue q ON q.token_id=t.id WHERE t.user_id=$1 AND t.purpose='verify_recovery_email' AND t.status='active' AND t.expires_at>clock_timestamp() AND t.credential_version=$2 AND t.recovery_email_version=$3`, [ctx.user.id,ctx.user.credential_version,ctx.user.recovery_email_version]);
    const challenge = pending.rows[0];
    return { credentialVersion: ctx.user.credential_version, passwordChangedAt: ctx.user.password_changed_at?.toISOString() ?? null,
      passwordPolicy: { minLength: 12, maxLength: 256, currentSession: 'retained', otherSessions: 'revoked' },
      recoveryEmail: { email: ctx.user.recovery_email, verifiedAt: ctx.user.recovery_email_verified_at?.toISOString() ?? null, emailVersion: ctx.user.recovery_email_version, pending: challenge ? { challengeId: challenge.id, candidateEmail: challenge.candidate_email, expiresAt: challenge.expires_at.toISOString(), delivery: { id: challenge.delivery_id, status: challenge.status, failureCode: challenge.failure_code } } : null },
      sessions: result.rows.map(row => ({ id: row.id, current: row.id === ctx.sessionId, createdAt: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString(), device: null, ipAddress: null, location: null, lastActiveAt: null })) };
  });
}
export async function changeOwnPassword(pool: Pool, token: string, input: unknown): Promise<AccountSecurityAction> {
  const payload = changeOwnPasswordSchema.parse(input);
  const actor = await authenticate(pool, token);
  // This committed counter is deliberately outside the password transaction: a
  // wrong password, rolled-back request, or process restart cannot reset it.
  await consumeAuthRateLimit(pool, `password-change:${actor.id}`, 5, 900);
  return withSecurity(pool, token, async ctx => {
    await requireUnused(ctx, payload.actionId);
    if (ctx.user.credential_version !== payload.expectedCredentialVersion) return recordAction(ctx, payload.actionId, 'password_change', 'rejected', 0, 'credential_version_conflict', 409);
    if (!await verifyPassword(payload.currentPassword, ctx.user.password_hash)) return recordAction(ctx, payload.actionId, 'password_change', 'rejected', 0, 'current_password_invalid', 403);
    if (payload.currentPassword === payload.newPassword) return recordAction(ctx, payload.actionId, 'password_change', 'rejected', 0, 'password_unchanged', 400);
    const encoded = await hashPassword(payload.newPassword);
    await ctx.sql.query('UPDATE users SET password_hash=$2,credential_version=credential_version+1,password_changed_at=clock_timestamp() WHERE id=$1 AND credential_version=$3', [ctx.user.id, encoded, payload.expectedCredentialVersion]);
    ctx.user.credential_version++;
    const revoked = await ctx.sql.query('DELETE FROM sessions WHERE user_id=$1 AND id<>$2', [ctx.user.id, ctx.sessionId]);
    // The existing high-entropy HttpOnly session is retained. No replacement
    // cookie can be lost while committing the password, and expiry is not extended.
    return recordAction(ctx, payload.actionId, 'password_change', 'committed', revoked.rowCount ?? 0);
  });
}
export async function revokeOwnSessions(pool: Pool, token: string, input: unknown): Promise<AccountSecurityAction> {
  const payload = revokeOwnSessionsSchema.parse(input);
  const actor = await authenticate(pool, token);
  await consumeAuthRateLimit(pool, `session-management:${actor.id}`, 30, 60);
  return withSecurity(pool, token, async ctx => {
    await requireUnused(ctx, payload.actionId);
    if (ctx.user.credential_version !== payload.expectedCredentialVersion) return recordAction(ctx, payload.actionId, 'revoke_sessions', 'rejected', 0, 'credential_version_conflict', 409);
    if (payload.sessionId === ctx.sessionId) return recordAction(ctx, payload.actionId, 'revoke_sessions', 'rejected', 0, 'current_session_protected', 400);
    const result = payload.sessionId === 'others'
      ? await ctx.sql.query('DELETE FROM sessions WHERE user_id=$1 AND id<>$2', [ctx.user.id, ctx.sessionId])
      : await ctx.sql.query('DELETE FROM sessions WHERE user_id=$1 AND id=$2', [ctx.user.id, payload.sessionId]);
    if (payload.sessionId !== 'others' && !result.rowCount) return recordAction(ctx, payload.actionId, 'revoke_sessions', 'rejected', 0, 'not_found_or_forbidden', 404);
    return recordAction(ctx, payload.actionId, 'revoke_sessions', 'committed', result.rowCount ?? 0);
  });
}
export async function getAccountSecurityAction(pool: Pool, token: string, actionId: string): Promise<AccountSecurityActionLookup> {
  const { actionId: id } = accountSecurityActionParamsSchema.parse({ actionId });
  return withSecurity(pool, token, async ctx => ({ action: await readAction(ctx, id) }));
}
/** Explicit recovery fences a delayed original write before declaring it cancelled. */
export async function recoverAccountSecurityAction(pool: Pool, token: string, actionId: string, input: unknown): Promise<AccountSecurityActionLookup> {
  const { actionId: id } = accountSecurityActionParamsSchema.parse({ actionId }), payload = recoverAccountSecurityActionSchema.parse(input);
  const actor = await authenticate(pool, token);
  await consumeAuthRateLimit(pool, `security-recovery:${actor.id}`, 30, 60);
  return withSecurity(pool, token, async ctx => {
    const prior = await readAction(ctx, id);
    if (prior && prior.kind !== payload.kind) throw new DomainError('security_action_kind_conflict', 'Action ID belongs to a different security operation', 409);
    return { action: prior ?? await recordAction(ctx, id, payload.kind, 'cancelled') };
  });
}
