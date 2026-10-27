import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { DomainError } from '../../domain/src/core.ts';
import { authenticate, consumeAuthRateLimit, hashPassword, verifyPassword } from '../../infrastructure/src/auth.ts';
import { encryptMailToken } from '../../infrastructure/src/system-mail.ts';
import type { AccountRecoveryMailConfig, RecoveryPurpose } from '../../infrastructure/src/account-recovery-mail.ts';
import type { AccountSecurityErrorCode } from '../../contracts/src/account-security.ts';
import { beginRecoveryEmailSchema, confirmRecoveryEmailSchema, cancelRecoveryEmailSchema, unbindRecoveryEmailSchema, recoveryRequestSchema, recoveryRequestIdSchema, recoveryTokenSchema, completePasswordRecoverySchema, recoveryActionInputSchema, type PasswordResetAction, type RecoveryRequestResult } from '../../contracts/src/account-recovery-schemas.ts';
import { withSecurity, requireUnused, recordAction, type SecurityContext, type SecurityUser } from './account-security.ts';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export type RecoveryTokenRow = { id: string; user_id: string; purpose: RecoveryPurpose; candidate_email: string | null; credential_version: number; recovery_email_version: number; status: string; expires_at: Date; created_at: Date; live: boolean; receipt_live: boolean };
async function transaction<T>(pool: Pool, operation: (sql: PoolClient) => Promise<T>): Promise<T> {
  const sql = await pool.connect();
  try { await sql.query('BEGIN'); const result = await operation(sql); await sql.query('COMMIT'); return result; }
  catch (error) { await sql.query('ROLLBACK'); throw error; } finally { sql.release(); }
}
async function expireTokens(sql: PoolClient, userId: string): Promise<void> {
  await sql.query("UPDATE account_recovery_tokens SET status='expired' WHERE user_id=$1 AND status='active' AND expires_at<=clock_timestamp()", [userId]);
  await sql.query("UPDATE account_recovery_mail_queue q SET status='cancelled',token_ciphertext=NULL,updated_at=clock_timestamp() FROM account_recovery_tokens t WHERE q.token_id=t.id AND t.user_id=$1 AND t.status<>'active' AND q.status='queued'", [userId]);
}
async function issue(sql: PoolClient, user: SecurityUser, purpose: RecoveryPurpose, config: AccountRecoveryMailConfig, candidate: string | null): Promise<string> {
  const id = randomUUID(), delivery = randomUUID(), token = randomBytes(32).toString('base64url');
  await sql.query(`INSERT INTO account_recovery_tokens(id,user_id,purpose,token_hash,candidate_email,credential_version,recovery_email_version,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+$8*interval '1 second')`, [id,user.id,purpose,digest(token),candidate,user.credential_version,user.recovery_email_version,purpose === 'reset_password' ? config.resetTtlSeconds : config.verifyTtlSeconds]);
  await sql.query('INSERT INTO account_recovery_mail_queue(id,token_id,purpose,token_ciphertext) VALUES($1,$2,$3,$4)', [delivery,id,purpose,encryptMailToken(config.tokenKey,`${purpose}:${id}:${delivery}`,token)]);
  return id;
}
async function emailPasswordCheck(ctx: SecurityContext, payload: { expectedCredentialVersion: number; expectedRecoveryEmailVersion: number; currentPassword: string }): Promise<AccountSecurityErrorCode | null> {
  if (ctx.user.credential_version !== payload.expectedCredentialVersion) return 'credential_version_conflict';
  if (ctx.user.recovery_email_version !== payload.expectedRecoveryEmailVersion) return 'recovery_email_version_conflict';
  return await verifyPassword(payload.currentPassword,ctx.user.password_hash) ? null : 'current_password_invalid';
}
async function emailLimit(pool: Pool, session: string): Promise<void> {
  const actor = await authenticate(pool,session);
  await consumeAuthRateLimit(pool,`recovery-email-management:${actor.id}`,5,900);
}
export async function beginRecoveryEmail(pool: Pool, session: string, input: unknown, config?: AccountRecoveryMailConfig) {
  const p = beginRecoveryEmailSchema.parse(input);
  await emailLimit(pool,session);
  return withSecurity(pool,session,async ctx => {
    await requireUnused(ctx,p.actionId);
    if (!config) throw new DomainError('account_recovery_unavailable','Account recovery issuance is not configured',503);
    const error = await emailPasswordCheck(ctx,p);
    if (error) return recordAction(ctx,p.actionId,'recovery_email_begin','rejected',0,error,error === 'current_password_invalid' ? 403 : 409);
    await expireTokens(ctx.sql,ctx.user.id);
    const pending = await ctx.sql.query("SELECT id FROM account_recovery_tokens WHERE user_id=$1 AND purpose='verify_recovery_email' AND status='active' FOR UPDATE",[ctx.user.id]);
    if (pending.rowCount) return recordAction(ctx,p.actionId,'recovery_email_begin','rejected',0,'recovery_email_pending',409);
    const sending = await ctx.sql.query("SELECT q.id FROM account_recovery_mail_queue q JOIN account_recovery_tokens t ON t.id=q.token_id WHERE t.user_id=$1 AND t.purpose='verify_recovery_email' AND q.status='sending' AND q.lease_expires_at>clock_timestamp()",[ctx.user.id]);
    if (sending.rowCount) return recordAction(ctx,p.actionId,'recovery_email_begin','rejected',0,'recovery_delivery_in_progress',409);
    const claimed = await ctx.sql.query('SELECT id FROM users WHERE recovery_email=$1',[p.email]);
    if (claimed.rowCount) return recordAction(ctx,p.actionId,'recovery_email_begin','rejected',0,'recovery_email_conflict',409);
    const id = await issue(ctx.sql,ctx.user,'verify_recovery_email',config,p.email);
    return recordAction(ctx,p.actionId,'recovery_email_begin','committed',0,null,200,id);
  });
}
export async function confirmRecoveryEmail(pool: Pool, session: string, input: unknown) {
  const p = confirmRecoveryEmailSchema.parse(input);
  return withSecurity(pool,session,async ctx => {
    await requireUnused(ctx,p.actionId);
    const result = await ctx.sql.query<RecoveryTokenRow>(`SELECT *,expires_at>clock_timestamp() AS live FROM account_recovery_tokens WHERE token_hash=$1 AND user_id=$2 FOR UPDATE`,[digest(p.token),ctx.user.id]);
    const t = result.rows[0];
    if (!t || t.purpose !== 'verify_recovery_email' || t.status !== 'active' || !t.live || t.credential_version !== ctx.user.credential_version || t.recovery_email_version !== ctx.user.recovery_email_version || p.expectedRecoveryEmailVersion !== ctx.user.recovery_email_version) return recordAction(ctx,p.actionId,'recovery_email_confirm','rejected',0,'recovery_link_unavailable',409);
    // The unique index, not locking another user's row, arbitrates concurrent claims.
    await ctx.sql.query('SAVEPOINT recovery_binding');
    try {
      await ctx.sql.query("UPDATE account_recovery_tokens SET status='consumed',consumed_at=clock_timestamp() WHERE id=$1",[t.id]);
      await ctx.sql.query('UPDATE users SET recovery_email=$2,recovery_email_verified_at=clock_timestamp(),recovery_email_version=recovery_email_version+1 WHERE id=$1',[ctx.user.id,t.candidate_email]);
      await ctx.sql.query("UPDATE account_recovery_mail_queue SET status='cancelled',token_ciphertext=NULL,updated_at=clock_timestamp() WHERE token_id=$1 AND status='queued'",[t.id]);
      await ctx.sql.query('RELEASE SAVEPOINT recovery_binding');
    } catch (error) {
      await ctx.sql.query('ROLLBACK TO SAVEPOINT recovery_binding');
      if (!(error instanceof Error) || !('code' in error) || error.code !== '23505') throw error;
      return recordAction(ctx,p.actionId,'recovery_email_confirm','rejected',0,'recovery_email_conflict',409);
    }
    ctx.user.recovery_email_version++;
    return recordAction(ctx,p.actionId,'recovery_email_confirm','committed',0,null,200,t.id);
  });
}
export async function cancelRecoveryEmail(pool: Pool, session: string, input: unknown) {
  const p = cancelRecoveryEmailSchema.parse(input);
  await emailLimit(pool,session);
  return withSecurity(pool,session,async ctx => {
    await requireUnused(ctx,p.actionId);
    const error = await emailPasswordCheck(ctx,p);
    if (error) return recordAction(ctx,p.actionId,'recovery_email_cancel','rejected',0,error,error === 'current_password_invalid' ? 403 : 409);
    const result = await ctx.sql.query("UPDATE account_recovery_tokens SET status='revoked' WHERE id=$1 AND user_id=$2 AND purpose='verify_recovery_email' AND status='active' RETURNING id",[p.challengeId,ctx.user.id]);
    if (!result.rowCount) return recordAction(ctx,p.actionId,'recovery_email_cancel','rejected',0,'recovery_link_unavailable',409);
    await ctx.sql.query("UPDATE account_recovery_mail_queue SET status='cancelled',token_ciphertext=NULL,updated_at=clock_timestamp() WHERE token_id=$1 AND status='queued'",[p.challengeId]);
    return recordAction(ctx,p.actionId,'recovery_email_cancel','committed',0,null,200,p.challengeId);
  });
}
export async function unbindRecoveryEmail(pool: Pool, session: string, input: unknown) {
  const p = unbindRecoveryEmailSchema.parse(input);
  await emailLimit(pool,session);
  return withSecurity(pool,session,async ctx => {
    await requireUnused(ctx,p.actionId);
    const error = await emailPasswordCheck(ctx,p);
    if (error) return recordAction(ctx,p.actionId,'recovery_email_unbind','rejected',0,error,error === 'current_password_invalid' ? 403 : 409);
    if (!ctx.user.recovery_email) return recordAction(ctx,p.actionId,'recovery_email_unbind','rejected',0,'recovery_email_not_registered',409);
    await ctx.sql.query('UPDATE users SET recovery_email=NULL,recovery_email_verified_at=NULL,recovery_email_version=recovery_email_version+1 WHERE id=$1',[ctx.user.id]);
    ctx.user.recovery_email_version++;
    return recordAction(ctx,p.actionId,'recovery_email_unbind','committed');
  });
}
export async function limitRecoveryBearer(pool: Pool, source: string, purpose: string, token: string): Promise<void> {
  await consumeAuthRateLimit(pool,`recovery-${purpose}-source:${source}`,30,60);
  await consumeAuthRateLimit(pool,`recovery-${purpose}-token:${token}`,10,900);
}
export async function requestPasswordRecovery(pool: Pool, input: unknown, source: string, config?: AccountRecoveryMailConfig): Promise<RecoveryRequestResult> {
  const p = recoveryRequestSchema.parse(input);
  if (!config) throw new DomainError('account_recovery_unavailable','Account recovery issuance is not configured',503);
  await consumeAuthRateLimit(pool,`recovery-request-source:${source}`,20,60);
  let eligible = true;
  try { await consumeAuthRateLimit(pool,`recovery-request-address:${p.email}`,3,900); }
  catch (error) { if (!(error instanceof DomainError) || error.code !== 'rate_limited') throw error; eligible = false; }
  const key = digest(`password-recovery-address:${p.email}`);
  return transaction(pool,async sql => {
    await sql.query("SELECT pg_advisory_xact_lock(hashtextextended('account-recovery-request:' || $1,0))",[p.requestId]);
    const prior = await sql.query<{ address_key: string | null; status: 'accepted' | 'cancelled' }>('SELECT address_key,status FROM account_recovery_requests WHERE request_id=$1',[p.requestId]);
    if (prior.rows[0]) {
      if (prior.rows[0].address_key && prior.rows[0].address_key !== key) throw new DomainError('recovery_request_conflict','Request identity belongs to a different request',409);
      return { requestId:p.requestId,status:prior.rows[0].status };
    }
    let tokenId: string | null = null;
    // All addresses traverse the same durable request path; SMTP is never awaited.
    const result = await sql.query<SecurityUser>('SELECT * FROM users WHERE recovery_email=$1 FOR UPDATE',[p.email]);
    const user = result.rows[0];
    if (user) {
      await expireTokens(sql,user.id);
      const active = await sql.query("SELECT id FROM account_recovery_tokens WHERE user_id=$1 AND purpose='reset_password' AND status='active' FOR UPDATE",[user.id]);
      if (eligible && !user.disabled_at && user.recovery_email_verified_at && !active.rowCount) tokenId = await issue(sql,user,'reset_password',config,null);
    }
    await sql.query("INSERT INTO account_recovery_requests(request_id,address_key,token_id,status) VALUES($1,$2,$3,'accepted')",[p.requestId,key,tokenId]);
    return { requestId:p.requestId,status:'accepted' };
  });
}
export async function lookupRecoveryRequest(pool: Pool, input: unknown, recover = false) {
  const p = recoveryRequestIdSchema.parse(input);
  return transaction(pool,async sql => {
    await sql.query("SELECT pg_advisory_xact_lock(hashtextextended('account-recovery-request:' || $1,0))",[p.requestId]);
    const prior = await sql.query<{ status: 'accepted' | 'cancelled' }>('SELECT status FROM account_recovery_requests WHERE request_id=$1',[p.requestId]);
    if (prior.rows[0]) return { request: { requestId:p.requestId,status:prior.rows[0].status } };
    if (!recover) return { request:null };
    await sql.query("INSERT INTO account_recovery_requests(request_id,status) VALUES($1,'cancelled')",[p.requestId]);
    return { request: { requestId:p.requestId,status:'cancelled' as const } };
  });
}
async function withRecoveryToken<T>(pool: Pool, token: string, operation: (sql: PoolClient, user: SecurityUser, t: RecoveryTokenRow) => Promise<T>): Promise<T> {
  const located = await pool.query<{ user_id: string }>("SELECT user_id FROM account_recovery_tokens WHERE token_hash=$1 AND purpose='reset_password'",[digest(token)]);
  if (!located.rows[0]) throw new DomainError('recovery_link_unavailable','Recovery link is unavailable',409);
  return transaction(pool,async sql => {
    const users = await sql.query<SecurityUser>('SELECT * FROM users WHERE id=$1 FOR UPDATE',[located.rows[0]!.user_id]);
    const tokens = await sql.query<RecoveryTokenRow>("SELECT *,expires_at>clock_timestamp() AS live,created_at+interval '30 days'>clock_timestamp() AS receipt_live FROM account_recovery_tokens WHERE token_hash=$1 AND purpose='reset_password' FOR UPDATE",[digest(token)]);
    if (!users.rows[0] || !tokens.rows[0]) throw new DomainError('recovery_link_unavailable','Recovery link is unavailable',409);
    return operation(sql,users.rows[0],tokens.rows[0]);
  });
}
function available(user: SecurityUser,t: RecoveryTokenRow): boolean {
  return !user.disabled_at && !!user.recovery_email && !!user.recovery_email_verified_at && t.status === 'active' && t.live && t.credential_version === user.credential_version && t.recovery_email_version === user.recovery_email_version;
}
export async function inspectPasswordRecovery(pool: Pool, input: unknown) {
  const p = recoveryTokenSchema.parse(input);
  return withRecoveryToken(pool,p.token,async (_sql,user,t) => {
    if (!available(user,t)) throw new DomainError('recovery_link_unavailable','Recovery link is unavailable',409);
    return { status:'available' as const,expiresAt:t.expires_at.toISOString(),passwordPolicy:{ minLength:12 as const,maxLength:256 as const,allSessions:'revoked' as const } };
  });
}
type ResetRow = { token_id:string; action_id:string; status:PasswordResetAction['status']; error_code:PasswordResetAction['errorCode']; occurred_at:Date };
function resetDto(row: ResetRow): PasswordResetAction { return { actionId:row.action_id,status:row.status,errorCode:row.error_code,occurredAt:row.occurred_at.toISOString() }; }
async function resetIdentity(sql: PoolClient,t: RecoveryTokenRow,actionId:string): Promise<ResetRow | undefined> {
  await sql.query("SELECT pg_advisory_xact_lock(hashtextextended('account-password-reset-action:' || $1,0))",[actionId]);
  const found = await sql.query<ResetRow>('SELECT token_id,action_id,status,error_code,occurred_at FROM account_password_reset_actions WHERE action_id=$1',[actionId]);
  if (found.rows[0] && found.rows[0].token_id !== t.id) throw new DomainError('security_action_token_conflict','Use the original email to reconcile this action',409);
  return found.rows[0];
}
async function writeReset(sql:PoolClient,t:RecoveryTokenRow,actionId:string,status:PasswordResetAction['status'],error:PasswordResetAction['errorCode']=null,version:number|null=null,revoked=0):Promise<PasswordResetAction> {
  const result = await sql.query<ResetRow>('INSERT INTO account_password_reset_actions(token_id,action_id,status,error_code,http_status,credential_version_after,revoked_count) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[t.id,actionId,status,error,error ? 409 : 200,version,revoked]);
  return resetDto(result.rows[0]!);
}
export async function completePasswordRecovery(pool: Pool,input:unknown):Promise<PasswordResetAction> {
  const p = completePasswordRecoverySchema.parse(input);
  return withRecoveryToken(pool,p.token,async (sql,user,t) => {
    const prior = await resetIdentity(sql,t,p.actionId);
    if (prior) throw new DomainError('security_action_already_recorded','Query the original result; never resend a password',409);
    if (!t.receipt_live) throw new DomainError('recovery_link_unavailable','Recovery link is unavailable',409);
    if (!available(user,t)) return writeReset(sql,t,p.actionId,'rejected','recovery_link_unavailable');
    if (await verifyPassword(p.newPassword,user.password_hash)) return writeReset(sql,t,p.actionId,'rejected','password_unchanged');
    const encoded = await hashPassword(p.newPassword);
    // Scrypt may take us across expiry. DB time is authoritative immediately before mutation.
    const stillLive = await sql.query('SELECT id FROM account_recovery_tokens WHERE id=$1 AND expires_at>clock_timestamp()',[t.id]);
    if (!stillLive.rowCount) return writeReset(sql,t,p.actionId,'rejected','recovery_link_unavailable');
    await sql.query("UPDATE account_recovery_tokens SET status='consumed',consumed_at=clock_timestamp() WHERE id=$1",[t.id]);
    await sql.query('UPDATE users SET password_hash=$2,credential_version=credential_version+1,password_changed_at=clock_timestamp() WHERE id=$1',[user.id,encoded]);
    const revoked = await sql.query('DELETE FROM sessions WHERE user_id=$1',[user.id]);
    return writeReset(sql,t,p.actionId,'committed',null,user.credential_version+1,revoked.rowCount ?? 0);
  });
}
export async function lookupPasswordResetAction(pool:Pool,input:unknown,recover=false) {
  const p = recoveryActionInputSchema.parse(input);
  return withRecoveryToken(pool,p.token,async (sql,_user,t) => {
    if (!t.receipt_live) throw new DomainError('recovery_link_unavailable','Recovery receipt window is unavailable; this does not prove failure',409);
    const prior = await resetIdentity(sql,t,p.actionId);
    return { action: prior ? resetDto(prior) : recover ? await writeReset(sql,t,p.actionId,'cancelled') : null };
  });
}
