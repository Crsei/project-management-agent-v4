import { lockWorkspace } from '../../infrastructure/src/database.ts';
import type { SqlExecutor } from './ports.ts';

/** Caller owns a transaction on the restored, stopped destination DB. Never call against the source. */
export async function fenceRestoredWebhooks(sql: SqlExecutor): Promise<void> {
  const workspaces = await sql.query<{ id: string }>('SELECT id FROM workspaces ORDER BY id');
  for (const workspace of workspaces.rows) {
    await lockWorkspace(sql, workspace.id);
    await sql.query("INSERT INTO webhook_restore_fences(workspace_id,safe_reason) VALUES($1,'receiver_ledger_alignment_required') ON CONFLICT(workspace_id) DO NOTHING", [workspace.id]);
    await sql.query("UPDATE webhook_endpoints SET state='blocked',safe_block_code='webhook_restore_alignment_required',version=version+1 WHERE workspace_id=$1 AND state<>'retired'", [workspace.id]);
    await sql.query(`UPDATE webhook_delivery_attempts a SET phase='unknown',finished_at=now(),safe_outcome_code='webhook_restore_fenced' FROM webhook_deliveries d WHERE a.delivery_id=d.id AND d.workspace_id=$1 AND a.finished_at IS NULL`, [workspace.id]);
    // A ready row in an old backup may have been accepted after that backup. A restore is not proof of non-delivery.
    await sql.query(`UPDATE webhook_deliveries SET state='unknown',safe_failure_code='webhook_restore_fenced',reconcile_requested=false,lease_id=NULL,lease_kind=NULL,lease_expires_at=NULL,accepted_at=NULL,version=version+1 WHERE workspace_id=$1 AND state NOT IN ('accepted','suppressed')`, [workspace.id]);
  }
  await sql.query('DELETE FROM webhook_key_health');
  await sql.query('DELETE FROM webhook_loop_health');
}
