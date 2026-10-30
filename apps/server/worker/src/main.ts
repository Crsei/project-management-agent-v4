import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { createPool, checkDatabase } from '../../../../packages/infrastructure/src/database.ts';
import { runtimeConfig } from '../../../../packages/infrastructure/src/runtime-config.ts';
import { publishOutboxBatch, recordHeartbeat, pruneEventHistory } from '../../../../packages/application/src/outbox.ts';
import { readInvitationMailConfig } from '../../../../packages/infrastructure/src/invitation-mail.ts';
import { deliverInvitationMailBatch } from '../../../../packages/application/src/invitation-delivery.ts';
import { readAccountRecoveryMailConfig } from '../../../../packages/infrastructure/src/account-recovery-mail.ts';
import { deliverAccountRecoveryMailBatch } from '../../../../packages/application/src/account-recovery-delivery.ts';
import { readonlyCorePort } from '../../../../packages/pm-core/readonly.ts';
import { routeNotificationBatch } from '../../../../packages/application/src/notification-routing.ts';
import { readWebhookConfig } from '../../../../packages/infrastructure/src/webhook-config.ts';
import { runWebhookLoop } from '../../../../packages/application/src/webhook-delivery.ts';
import { runAutomationBatch } from '../../../../packages/application/src/automation.ts';

if (Object.keys(process.env).some(key => /^(?:AWS_|S3_|SOURCE_S3_|TARGET_S3_)/.test(key))) throw new Error('Worker must not receive blob credentials or ambient cloud identity');

const config = runtimeConfig();
const invitationMail = readInvitationMailConfig();
const recoveryMail = readAccountRecoveryMailConfig();
const webhooks = readWebhookConfig();
// The readonly core port follows the same durable project mapping as the API,
// including external mounts; it never initializes or repairs missing roots.
const notificationCore = readonlyCorePort(workspaceId => path.join(config.coreWorkspaceRoot, workspaceId));
if (!config.databaseUrl) throw new Error('DATABASE_URL is required for the Worker');
const pool = createPool(config.databaseUrl);
const id = `worker-${randomUUID()}`;
const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => controller.abort());
let lastMaintenance = 0;
let failures = 0;
const auxiliaryWork: Promise<void>[] = [];
async function runAuxiliaryLoop(event: string, cycle: () => Promise<unknown>): Promise<void> {
  let consecutiveFailures = 0;
  while (!controller.signal.aborted) {
    try { await cycle(); consecutiveFailures = 0; }
    catch {
      consecutiveFailures++;
      console.error(JSON.stringify({ event, consecutiveFailures }));
    }
    await setTimeout(Math.min(config.workerIntervalMs * 2 ** Math.min(consecutiveFailures, 6), 30_000), undefined, { signal: controller.signal }).catch(() => {});
  }
}
try {
  const database = await checkDatabase(pool);
  if (!database.ready) throw new Error('Run migrations before starting the Worker');
  console.log(JSON.stringify({ event: 'worker_started', id }));
  // Each bounded loop progresses independently; SMTP/HTTPS cannot stall outbox.
  auxiliaryWork.push(
    runAuxiliaryLoop('invitation_mail_cycle_failed', () => deliverInvitationMailBatch(pool, invitationMail)),
    runAuxiliaryLoop('account_recovery_mail_cycle_failed', () => deliverAccountRecoveryMailBatch(pool, recoveryMail, { batchSize: 1 })),
    runAuxiliaryLoop('notification_cycle_failed', () => routeNotificationBatch(pool, notificationCore, id, { jobLimit: 4, candidateLimit: 100 })),
    runAuxiliaryLoop('automation_cycle_failed', () => runAutomationBatch(pool, notificationCore, id)),
    runWebhookLoop(pool, webhooks, controller.signal, { intervalMs: config.workerIntervalMs, workerId: id }),
  );
  while (!controller.signal.aborted) {
    try {
      const published = await publishOutboxBatch(pool);
      if (Date.now() - lastMaintenance > 60_000) {
        await pruneEventHistory(pool, config.eventRetentionDays);
        lastMaintenance = Date.now();
      }
      await recordHeartbeat(pool, id, { published, state: 'running' });
      failures = 0;
    } catch {
      failures++;
      console.error(JSON.stringify({ event: 'worker_cycle_failed', consecutiveFailures: failures }));
    }
    await setTimeout(Math.min(config.workerIntervalMs * 2 ** Math.min(failures, 6), 30_000), undefined, { signal: controller.signal }).catch(() => {});
  }
} finally {
  controller.abort();
  await Promise.all(auxiliaryWork);
  await pool.query('DELETE FROM service_heartbeats WHERE id=$1', [id]).catch(() => {});
  await pool.query('DELETE FROM automation_scheduler_heartbeats WHERE worker_id=$1', [id]).catch(() => {});
  await pool.end();
  console.log(JSON.stringify({ event: 'worker_stopped', id }));
}
