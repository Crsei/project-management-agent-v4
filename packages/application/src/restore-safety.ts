import type { SqlExecutor } from './ports.ts';
import { fenceRestoredAccountRecovery } from './account-recovery-restore.ts';
import { fenceRestoredNotifications } from './notification-routing.ts';
import { fenceRestoredWebhooks } from './webhook-restore.ts';

/** Only inside the stopped TARGET restore transaction, before its new store activates. */
export async function fenceRestoredServices(sql: SqlExecutor): Promise<void> {
  await fenceRestoredNotifications(sql);
  await fenceRestoredWebhooks(sql);
  await fenceRestoredAccountRecovery(sql);
  await sql.query("UPDATE member_invitations SET status='revoked',version=version+1,updated_at=clock_timestamp() WHERE status='pending'");
  await sql.query("UPDATE invitation_mail_queue SET status='cancelled',token_ciphertext=NULL,updated_at=clock_timestamp() WHERE status='queued'");
  await sql.query("UPDATE invitation_mail_queue SET status='unknown',failure_code='send_lease_expired',token_ciphertext=NULL,lease_id=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE status='sending'");
  await sql.query('DELETE FROM service_heartbeats');
}
