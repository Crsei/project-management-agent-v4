import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { DomainError, type Actor } from '../../domain/src/core.ts';
import type { NotificationInboxItem } from '../../domain/src/notifications.ts';
import type { NotificationCorePort } from '../../pm-core/readonly.ts';
import type { ImGatewayConfig } from '../../infrastructure/src/im-gateway-config.ts';
import { sendSatoriMessage } from '../../infrastructure/src/satori-client.ts';
import { requireCapability } from './access.ts';
import { enqueueImJob, truncateImText, type ImBindingRow } from './im-gateway.ts';
import { readNotificationInbox } from './notifications.ts';

type DeliveryRow = {
  id: string;
  workspace_id: string;
  binding_id: string;
  source_kind: 'reply' | 'notification';
  payload: string;
  project_id: string | null;
  task_id: string | null;
  state: string;
  attempts: number;
  lease_id: string | null;
  lease_until: Date | null;
  next_attempt_at: Date;
  last_error_code: string | null;
};

type Claim = { job: DeliveryRow; binding: ImBindingRow };

function notificationLabel(item: NotificationInboxItem): string {
  if (item.event.completion) return '任务已完成';
  if (item.reasons.includes('mention')) return '你在评论中被提及';
  if (item.event.changedFields?.includes('status')) return '任务状态有变化';
  return '任务有新变更';
}

function renderNotification(item: NotificationInboxItem, workspaceId: string, taskTitle: string, projectName: string, publicOrigin: string): string {
  const taskId = item.target?.taskId;
  if (!taskId) return '';
  return truncateImText([
    `[${projectName}] ${taskId} ${taskTitle}`,
    `事件：${notificationLabel(item)}`,
    `打开：${publicOrigin.replace(/\/+$/, '')}/pm/${workspaceId}/entities/${taskId}`,
  ].join('\n'));
}

/** Enqueue only routed notifications for explicitly opted-in bindings. No historical replay. */
export async function enqueueImNotifications(pool: Pool, core: NotificationCorePort, publicOrigin: string): Promise<{ bindings: number; enqueued: number }> {
  const bindings = await pool.query<ImBindingRow>(
    `SELECT i.* FROM im_identities i JOIN workspaces w ON w.id=i.workspace_id
     WHERE i.revoked_at IS NULL AND i.notify_enabled AND i.notification_cursor<w.notification_head
     ORDER BY i.last_seen_at,i.id LIMIT 20`,
  );
  let enqueued = 0;
  for (const binding of bindings.rows) {
    const actor: Actor = { id: binding.user_id, email: '', name: '' };
    let page;
    try {
      page = await readNotificationInbox(pool, actor, binding.workspace_id, core, { after: binding.notification_cursor });
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== 'notification_not_activated') throw error;
      const head = await pool.query<{ head: string }>('SELECT notification_head::text AS head FROM workspaces WHERE id=$1', [binding.workspace_id]);
      await pool.query('UPDATE im_identities SET notification_cursor=$2 WHERE id=$1 AND revoked_at IS NULL', [binding.id, head.rows[0]?.head ?? '0']);
      continue;
    }
    const snapshot = await core.read(binding.workspace_id);
    for (const item of page.items) {
      if (!item.target?.taskId || !item.event.projectId) continue;
      const task = snapshot.files.find(file => file.id === item.target!.taskId && file.entity.entity === 'work_item');
      const project = snapshot.files.find(file => file.id === item.event.projectId && file.entity.entity === 'project');
      if (!task || !project) continue;
      const text = renderNotification(item, binding.workspace_id, task.entity.title, project.entity.title, publicOrigin);
      if (!text) continue;
      if (await enqueueImJob(pool, binding, 'notification', item.event.eventId, text, { projectId: item.event.projectId, taskId: item.target.taskId })) enqueued++;
    }
    await pool.query('UPDATE im_identities SET notification_cursor=$2 WHERE id=$1 AND revoked_at IS NULL', [binding.id, page.cursor]);
  }
  return { bindings: bindings.rowCount ?? 0, enqueued };
}

async function claimDelivery(pool: Pool): Promise<Claim | null> {
  const candidates = await pool.query<{ id: string }>(
    `SELECT j.id FROM im_delivery_jobs j
     WHERE j.state='pending' AND j.lease_id IS NULL AND j.next_attempt_at<=clock_timestamp()
       AND NOT EXISTS (SELECT 1 FROM im_delivery_jobs active WHERE active.binding_id=j.binding_id AND active.lease_id IS NOT NULL)
     ORDER BY j.created_at,j.id LIMIT 20`,
  );
  for (const candidate of candidates.rows) {
    const sql = await pool.connect();
    try {
      await sql.query('BEGIN');
      const pending = await sql.query<{ binding_id: string }>(
        `SELECT binding_id FROM im_delivery_jobs WHERE id=$1 AND state='pending' AND lease_id IS NULL AND next_attempt_at<=clock_timestamp()`,
        [candidate.id],
      );
      if (!pending.rows[0]) { await sql.query('ROLLBACK'); continue; }
      // Lock the binding before the job so revocation and delivery share one order.
      const binding = await sql.query<ImBindingRow>('SELECT * FROM im_identities WHERE id=$1 FOR UPDATE', [pending.rows[0].binding_id]);
      if (!binding.rows[0]) { await sql.query("UPDATE im_delivery_jobs SET state='suppressed',last_error_code='binding_missing' WHERE id=$1", [candidate.id]); await sql.query('COMMIT'); continue; }
      const job = await sql.query<DeliveryRow>(
        `SELECT * FROM im_delivery_jobs WHERE id=$1 AND state='pending' AND lease_id IS NULL
         AND next_attempt_at<=clock_timestamp() FOR UPDATE SKIP LOCKED`,
        [candidate.id],
      );
      if (!job.rows[0]) { await sql.query('ROLLBACK'); continue; }
      const leaseId = randomUUID();
      const claimed = await sql.query<DeliveryRow>(
        `UPDATE im_delivery_jobs SET state='sending',lease_id=$2,lease_until=clock_timestamp()+interval '45 seconds',attempts=attempts+1
         WHERE id=$1 RETURNING *`,
        [candidate.id, leaseId],
      );
      await sql.query('COMMIT');
      return { job: claimed.rows[0]!, binding: binding.rows[0] };
    } catch (error) {
      await sql.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { sql.release(); }
  }
  return null;
}

async function finishDelivery(pool: Pool, job: DeliveryRow, state: DeliveryRow['state'], errorCode: string | null, retryDelaySeconds: number | null): Promise<void> {
  await pool.query(
    `UPDATE im_delivery_jobs SET state=$3,last_error_code=$4,
     accepted_at=CASE WHEN $3='accepted' THEN clock_timestamp() ELSE accepted_at END,
     next_attempt_at=CASE WHEN $5::integer IS NULL THEN next_attempt_at ELSE clock_timestamp()+($5::integer*interval '1 second') END,
     lease_id=NULL,lease_until=NULL
     WHERE id=$1 AND lease_id=$2`,
    [job.id, job.lease_id, state, errorCode, retryDelaySeconds],
  );
}

async function suppress(pool: Pool, job: DeliveryRow, code: string): Promise<void> {
  await pool.query("UPDATE im_delivery_jobs SET state='suppressed',last_error_code=$3,lease_id=NULL,lease_until=NULL WHERE id=$1 AND lease_id=$2", [job.id, job.lease_id, code]);
}

export async function deliverImBatch(pool: Pool, config: ImGatewayConfig): Promise<{ attempted: number; accepted: number; unknown: number; failed: number; suppressed: number }> {
  await pool.query("UPDATE im_delivery_jobs SET state='unknown',last_error_code='delivery_lease_expired',lease_id=NULL,lease_until=NULL WHERE state='sending' AND lease_until<clock_timestamp()");
  const result = { attempted: 0, accepted: 0, unknown: 0, failed: 0, suppressed: 0 };
  for (let index = 0; index < 10; index++) {
    const claim = await claimDelivery(pool);
    if (!claim) break;
    result.attempted++;
    const { job, binding } = claim;
    if (binding.revoked_at !== null || job.workspace_id !== binding.workspace_id || job.source_kind === 'notification' && !binding.notify_enabled) {
      await suppress(pool, job, 'binding_inactive');
      result.suppressed++;
      continue;
    }
    try {
      await requireCapability(pool, { id: binding.user_id, email: '', name: '' }, binding.workspace_id, 'domain.read', job.project_id);
    } catch {
      await suppress(pool, job, 'permission_revoked');
      result.suppressed++;
      continue;
    }
    try {
      const response = await sendSatoriMessage({
        apiUrl: config.apiUrl,
        token: config.token,
        platform: binding.platform,
        selfId: binding.bot_self_id,
        channelId: binding.reply_channel_id,
        content: job.payload,
        timeoutMs: config.timeoutMs,
      });
      if (response.status >= 200 && response.status < 300) {
        await finishDelivery(pool, job, 'accepted', null, null);
        result.accepted++;
      } else if (response.status === 429 || response.status >= 500) {
        if (job.attempts >= 3) {
          await finishDelivery(pool, job, 'failed', `satori_http_${response.status}`, null);
          result.failed++;
        } else {
          await finishDelivery(pool, job, 'pending', `satori_http_${response.status}`, [1, 5, 30][job.attempts - 1] ?? 30);
        }
      } else {
        await finishDelivery(pool, job, 'failed', `satori_http_${response.status}`, null);
        result.failed++;
      }
    } catch {
      await finishDelivery(pool, job, 'unknown', 'satori_outcome_unknown', null);
      result.unknown++;
    }
  }
  return result;
}

export async function readImDeliveryStatus(pool: Pool): Promise<{ counts: Record<string, number>; oldestPendingAt: Date | null }> {
  const counts = await pool.query<{ state: string; count: string }>('SELECT state,count(*)::text AS count FROM im_delivery_jobs GROUP BY state ORDER BY state');
  const oldest = await pool.query<{ oldest: Date | null }>("SELECT min(created_at) AS oldest FROM im_delivery_jobs WHERE state IN ('pending','sending','unknown')");
  return { counts: Object.fromEntries(counts.rows.map(row => [row.state, Number(row.count)])), oldestPendingAt: oldest.rows[0]?.oldest ?? null };
}

/** Explicit operator recovery only. Never called by the delivery loop. */
export async function retryImDelivery(pool: Pool, id: string): Promise<{ retried: true }> {
  const result = await pool.query("UPDATE im_delivery_jobs SET state='pending',attempts=0,next_attempt_at=clock_timestamp(),last_error_code='manual_retry',lease_id=NULL,lease_until=NULL WHERE id=$1 AND state IN ('unknown','failed')", [id]);
  if (!result.rowCount) throw new DomainError('im_delivery_not_retryable', 'Only unknown or failed deliveries can be retried explicitly', 409);
  return { retried: true };
}
