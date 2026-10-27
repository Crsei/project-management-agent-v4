import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { InvitationFailureCode } from '../../domain/src/invitations.ts';
import { lockWorkspace } from '../../infrastructure/src/database.ts';
import { sendInvitationMail } from '../../infrastructure/src/invitation-mail.ts';
import { decryptMailToken } from '../../infrastructure/src/system-mail.ts';
import type { InvitationMailConfig } from '../../infrastructure/src/invitation-mail.ts';

type MailClaim = { id: string; invitation_id: string; generation: number; token_ciphertext: string; email: string; expires_at: Date; lease_id: string };
export type InvitationDeliveryBatch = { attempted: number; smtpAccepted: number; failed: number; unknown: number; expiredLeases: number };

/** Expired sending leases represent possibly completed external effects, never retryable queue entries. */
export async function deliverInvitationMailBatch(pool: Pool, config?: InvitationMailConfig, options: { batchSize?: number } = {}): Promise<InvitationDeliveryBatch> {
  const batchSize = options.batchSize ?? 1;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) throw new Error('Invitation batch size must be between 1 and 100');
  const expired = await pool.query(`UPDATE invitation_mail_queue SET status='unknown',failure_code='send_lease_expired',token_ciphertext=NULL,
    lease_id=NULL,lease_expires_at=NULL,updated_at=now() WHERE status='sending' AND lease_expires_at<=now()`);
  const result: InvitationDeliveryBatch = { attempted: 0, smtpAccepted: 0, failed: 0, unknown: 0, expiredLeases: expired.rowCount ?? 0 };
  if (!config) return result;
  const candidates = await pool.query<{ id: string; workspace_id: string }>(`SELECT q.id,i.workspace_id FROM invitation_mail_queue q
    JOIN member_invitations i ON i.id=q.invitation_id WHERE q.status='queued' ORDER BY q.created_at,q.id LIMIT $1`, [batchSize]);
  for (const candidate of candidates.rows) {
    const sql = await pool.connect();
    let claim: MailClaim | undefined;
    try {
      await sql.query('BEGIN');
      await lockWorkspace(sql, candidate.workspace_id);
      const queued = await sql.query<MailClaim & { invitation_status: string; current_generation: number; expired: boolean }>(`SELECT q.*,i.email,i.expires_at,
        i.status AS invitation_status,i.generation AS current_generation,i.expires_at<=clock_timestamp() AS expired
        FROM invitation_mail_queue q JOIN member_invitations i ON i.id=q.invitation_id
        WHERE q.id=$1 AND q.status='queued' FOR UPDATE OF q SKIP LOCKED`, [candidate.id]);
      const state = queued.rows[0];
      if (state) {
        if (state.invitation_status !== 'pending' || state.current_generation !== state.generation || state.expired) {
          await sql.query("UPDATE invitation_mail_queue SET status='cancelled',token_ciphertext=NULL,updated_at=now() WHERE id=$1", [state.id]);
        } else {
          const leaseId = randomUUID();
          await sql.query(`UPDATE invitation_mail_queue SET status='sending',token_ciphertext=NULL,lease_id=$2,
            lease_expires_at=now()+$3*interval '1 millisecond',updated_at=now() WHERE id=$1`, [state.id, leaseId, config.timeoutMs * 2 + 30_000]);
          claim = { ...state, lease_id: leaseId };
        }
      }
      await sql.query('COMMIT');
    } catch (error) { await sql.query('ROLLBACK'); throw error; }
    finally { sql.release(); }
    if (!claim) continue;
    result.attempted++;
    let outcome: { status: 'smtp_accepted' | 'failed' | 'unknown'; failureCode?: InvitationFailureCode };
    let token: string;
    try { token = decryptMailToken(config.tokenKey, claim.invitation_id, claim.token_ciphertext); }
    catch {
      outcome = { status: 'failed', failureCode: 'token_unavailable' };
      await pool.query(`UPDATE invitation_mail_queue SET status=$3,failure_code=$4,lease_id=NULL,lease_expires_at=NULL,updated_at=now()
        WHERE id=$1 AND lease_id=$2 AND status='sending'`, [claim.id, claim.lease_id, outcome.status, outcome.failureCode]);
      result.failed++;
      continue;
    }
    outcome = await sendInvitationMail(config, { invitationId: claim.invitation_id, deliveryId: claim.id, email: claim.email, token, expiresAt: claim.expires_at.toISOString() });
    // If recording this fails, the sending lease will become unknown, not be resent.
    await pool.query(`UPDATE invitation_mail_queue SET status=$3,failure_code=$4,lease_id=NULL,lease_expires_at=NULL,updated_at=now()
      WHERE id=$1 AND lease_id=$2 AND status='sending'`, [claim.id, claim.lease_id, outcome.status, outcome.failureCode ?? null]);
    if (outcome.status === 'smtp_accepted') result.smtpAccepted++;
    else if (outcome.status === 'failed') result.failed++;
    else result.unknown++;
  }
  return result;
}
