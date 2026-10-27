import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { decryptMailToken } from '../../infrastructure/src/system-mail.ts';
import { sendAccountRecoveryMail, type AccountRecoveryMailConfig, type RecoveryPurpose } from '../../infrastructure/src/account-recovery-mail.ts';

type Claim = { id:string; token_id:string; purpose:RecoveryPurpose; token_ciphertext:string; email:string; expires_at:Date; lease_id:string };
export type AccountRecoveryDeliveryBatch = { attempted:number; smtpAccepted:number; failed:number; unknown:number; expiredLeases:number };
export async function deliverAccountRecoveryMailBatch(pool:Pool,config?:AccountRecoveryMailConfig,options:{batchSize?:number}={}):Promise<AccountRecoveryDeliveryBatch> {
  const size = options.batchSize ?? 1;
  if (!Number.isInteger(size) || size<1 || size>100) throw new Error('Recovery batch size must be between 1 and 100');
  const expired = await pool.query("UPDATE account_recovery_mail_queue SET status='unknown',failure_code='send_lease_expired',lease_id=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE status='sending' AND lease_expires_at<=clock_timestamp()");
  const result:AccountRecoveryDeliveryBatch = {attempted:0,smtpAccepted:0,failed:0,unknown:0,expiredLeases:expired.rowCount ?? 0};
  const candidates = await pool.query<{ id:string; user_id:string; token_id:string }>("SELECT q.id,t.user_id,t.id AS token_id FROM account_recovery_mail_queue q JOIN account_recovery_tokens t ON t.id=q.token_id WHERE q.status='queued' AND ($2::boolean OR t.expires_at<=clock_timestamp() OR t.status<>'active') ORDER BY q.created_at,q.id LIMIT $1",[size,!!config]);
  for (const candidate of candidates.rows) {
    const sql = await pool.connect();
    let claim:Claim|undefined;
    try {
      await sql.query('BEGIN');
      await sql.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[candidate.user_id]);
      await sql.query('SELECT id FROM account_recovery_tokens WHERE id=$1 FOR UPDATE',[candidate.token_id]);
      const found = await sql.query<Claim & { valid:boolean }>(`SELECT q.*,t.expires_at,COALESCE(t.candidate_email,u.recovery_email) AS email,
        t.status='active' AND t.expires_at>clock_timestamp() AND u.disabled_at IS NULL AND t.credential_version=u.credential_version AND t.recovery_email_version=u.recovery_email_version
        AND (t.purpose='verify_recovery_email' OR u.recovery_email_verified_at IS NOT NULL) AS valid
        FROM account_recovery_mail_queue q JOIN account_recovery_tokens t ON t.id=q.token_id JOIN users u ON u.id=t.user_id WHERE q.id=$1 AND q.status='queued' FOR UPDATE OF q SKIP LOCKED`,[candidate.id]);
      const state = found.rows[0];
      if (state) {
        if (!state.valid) await sql.query("UPDATE account_recovery_mail_queue SET status='cancelled',token_ciphertext=NULL,updated_at=clock_timestamp() WHERE id=$1",[state.id]);
        else if (config) {
          const lease = randomUUID();
          await sql.query("UPDATE account_recovery_mail_queue SET status='sending',token_ciphertext=NULL,lease_id=$2,lease_expires_at=clock_timestamp()+$3*interval '1 millisecond',updated_at=clock_timestamp() WHERE id=$1",[state.id,lease,config.timeoutMs*2+30000]);
          claim = {...state,lease_id:lease};
        }
      }
      await sql.query('COMMIT');
    } catch(error) { await sql.query('ROLLBACK'); throw error; } finally {sql.release();}
    if (!claim || !config) continue;
    result.attempted++;
    let outcome: {status:'smtp_accepted'|'failed'|'unknown';failureCode?:string};
    let token: string | undefined;
    try { token = decryptMailToken(config.tokenKey,`${claim.purpose}:${claim.token_id}:${claim.id}`,claim.token_ciphertext); }
    catch { /* No SMTP call has occurred; definite token-unavailable failure. */ }
    if (token === undefined) outcome = {status:'failed',failureCode:'token_unavailable'};
    else {
      try { outcome = await sendAccountRecoveryMail(config,{purpose:claim.purpose,deliveryId:claim.id,email:claim.email,token,expiresAt:claim.expires_at.toISOString()}); }
      catch { outcome = {status:'unknown',failureCode:'send_outcome_unknown'}; }
    }
    // A failed finalize leaves the wiped sending lease to become unknown. Never requeue.
    await pool.query("UPDATE account_recovery_mail_queue SET status=$3,failure_code=$4,lease_id=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=$1 AND status='sending' AND lease_id=$2",[claim.id,claim.lease_id,outcome.status,outcome.failureCode ?? null]);
    if(outcome.status==='smtp_accepted') result.smtpAccepted++;
    else if(outcome.status==='failed') result.failed++;
    else result.unknown++;
  }
  return result;
}
