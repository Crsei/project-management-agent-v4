import type { SqlExecutor } from './ports.ts';

/**
 * Caller owns the transaction and has explicitly stopped all writers/delivery workers
 * for this isolated restored TARGET database. Never call on the source database.
 * This fences bearer/session capabilities, not the old password or email trust that
 * a backup may have restored; reopening still requires the approved credential policy.
 */
export async function fenceRestoredAccountRecovery(sql: SqlExecutor): Promise<void> {
  await sql.query('SELECT id FROM users ORDER BY id FOR UPDATE');
  await sql.query('DELETE FROM sessions');
  await sql.query("UPDATE account_recovery_tokens SET status='revoked' WHERE status='active'");
  await sql.query("UPDATE account_recovery_mail_queue SET status='cancelled',token_ciphertext=NULL,updated_at=clock_timestamp() WHERE status='queued'");
  await sql.query("UPDATE account_recovery_mail_queue SET status='unknown',failure_code='send_lease_expired',token_ciphertext=NULL,lease_id=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE status='sending'");
}
