import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Pool, PoolClient } from 'pg';
import { DomainError } from '../../domain/src/core.ts';
import { projectWebhookFact, sha256, webhookBodySchema, type WebhookFact, type WebhookRequestIdentity } from '../../domain/src/webhooks.ts';
import { lockWorkspace } from '../../infrastructure/src/database.ts';
import { readWebhookSigningKey, type WebhookConfig } from '../../infrastructure/src/webhook-config.ts';
import { webhookTransport, WebhookNetworkError, type WebhookTransport, type WebhookTransportResult } from '../../infrastructure/src/webhook-transport.ts';
import { assertWebhookNewDispatchAllowed, assertWebhookReceiptReadable, authorizeWebhookHistoryDispatch, requireWebhookTarget } from './webhooks.ts';
import type { WebhookDeliveryRow, WebhookEndpointRow } from './webhook-store.ts';

export type WebhookBatch = { enqueued: number; filtered: number; attempted: number; accepted: number; unknown: number; expiredLeases: number };
type Claim = { endpoint: WebhookEndpointRow; delivery: WebhookDeliveryRow; kind: 'dispatch' | 'reconcile'; leaseId: string };
async function transaction<T>(pool: Pool, workspaceId: string, action: (sql: PoolClient) => Promise<T>): Promise<T> {
  const sql = await pool.connect();
  try { await sql.query('BEGIN'); await lockWorkspace(sql, workspaceId); const result = await action(sql); await sql.query('COMMIT'); return result; }
  catch (error) { await sql.query('ROLLBACK'); throw error; }
  finally { sql.release(); }
}
async function blockEndpoint(sql: PoolClient, endpoint: WebhookEndpointRow, code: string): Promise<void> {
  await sql.query("UPDATE webhook_endpoints SET state='blocked',safe_block_code=$2,version=version+1 WHERE id=$1 AND state NOT IN ('retired','blocked')", [endpoint.id, code]);
  await sql.query("UPDATE webhook_deliveries SET state='blocked',safe_failure_code=$2,version=version+1 WHERE endpoint_id=$1 AND state IN ('ready','retry_wait')", [endpoint.id, code]);
}
async function consumeFacts(pool: Pool, config: WebhookConfig, result: WebhookBatch, size: number): Promise<void> {
  const endpoints = await pool.query<WebhookEndpointRow>(`SELECT e.* FROM webhook_endpoints e WHERE e.state IN ('enabled','paused') AND NOT EXISTS(SELECT 1 FROM webhook_restore_fences r WHERE r.workspace_id=e.workspace_id) AND EXISTS(SELECT 1 FROM service_fact_events f WHERE f.workspace_id=e.workspace_id AND f.fact_sequence>e.activation_sequence AND NOT EXISTS(SELECT 1 FROM webhook_fact_consumptions c WHERE c.endpoint_id=e.id AND c.fact_id=f.fact_id)) AND (SELECT count(*) FROM webhook_deliveries d WHERE d.endpoint_id=e.id AND d.state NOT IN ('accepted','suppressed','failed_safe'))<10000 ORDER BY e.created_at,e.id LIMIT $1`, [size]);
  for (const candidate of endpoints.rows) await transaction(pool, candidate.workspace_id, async sql => {
    const endpoint = (await sql.query<WebhookEndpointRow>("SELECT * FROM webhook_endpoints WHERE id=$1 AND state IN ('enabled','paused') FOR UPDATE SKIP LOCKED", [candidate.id])).rows[0];
    if (!endpoint) return;
    try { await assertWebhookNewDispatchAllowed(sql, endpoint.workspace_id); requireWebhookTarget(config, endpoint); await assertWebhookReceiptReadable(sql, { id: endpoint.authorizer_user_id, email: '', name: '' }, endpoint.workspace_id, endpoint.project_ids); }
    catch (error) { await blockEndpoint(sql, endpoint, error instanceof DomainError && error.code.startsWith('webhook_') ? error.code : 'webhook_authorization_revoked'); return; }
    const count = await sql.query<{ count: string }>("SELECT count(*)::text FROM webhook_deliveries WHERE endpoint_id=$1 AND state NOT IN ('accepted','suppressed','failed_safe')", [endpoint.id]);
    if (Number(count.rows[0]!.count) >= 10000) return;
    const facts = await sql.query<WebhookFact>(`SELECT f.* FROM service_fact_events f WHERE f.workspace_id=$1 AND f.fact_sequence>$2 AND NOT EXISTS(SELECT 1 FROM webhook_fact_consumptions c WHERE c.endpoint_id=$3 AND c.fact_id=f.fact_id) ORDER BY f.fact_sequence LIMIT $4`, [endpoint.workspace_id, endpoint.activation_sequence, endpoint.id, Math.min(100, 10000 - Number(count.rows[0]!.count))]);
    for (const fact of facts.rows) {
      const deliveryId = randomUUID();
      const projected = projectWebhookFact(fact, deliveryId);
      const selected = projected && fact.project_id && endpoint.project_ids.includes(fact.project_id) && endpoint.event_types.includes(projected.eventType);
      // Every irreversible consumption decision and immutable delivery body commits in one workspace transaction.
      if (selected) {
        await authorizeWebhookHistoryDispatch(sql, endpoint, fact, config);
        await sql.query(`INSERT INTO webhook_deliveries(id,workspace_id,endpoint_id,fact_id,target_digest,payload_bytes,payload_sha256) VALUES($1,$2,$3,$4,$5,$6,$7)`, [deliveryId, endpoint.workspace_id, endpoint.id, fact.fact_id, endpoint.target_digest, projected.body, projected.sha256]);
        result.enqueued++;
      } else result.filtered++;
      await sql.query('INSERT INTO webhook_fact_consumptions(workspace_id,endpoint_id,fact_id,decision,safe_reason) VALUES($1,$2,$3,$4,$5)', [endpoint.workspace_id, endpoint.id, fact.fact_id, selected ? 'queued' : 'filtered', selected ? null : 'outside_safe_selection']);
    }
  });
}
async function recoverLeases(pool: Pool): Promise<number> {
  const rows = await pool.query<{ id: string; workspace_id: string }>('SELECT id,workspace_id FROM webhook_deliveries WHERE lease_expires_at<=now() ORDER BY lease_expires_at LIMIT 100');
  let recovered = 0;
  for (const row of rows.rows) await transaction(pool, row.workspace_id, async sql => {
    const d = (await sql.query<WebhookDeliveryRow>('SELECT * FROM webhook_deliveries WHERE id=$1 AND lease_expires_at<=now() FOR UPDATE SKIP LOCKED', [row.id])).rows[0];
    if (!d) return;
    await sql.query("UPDATE webhook_delivery_attempts SET phase='unknown',finished_at=now(),safe_outcome_code='webhook_lease_expired' WHERE delivery_id=$1 AND lease_id=$2 AND finished_at IS NULL", [d.id, d.lease_id]);
    await sql.query(`UPDATE webhook_deliveries SET state=CASE WHEN state='preparing' THEN 'ready' ELSE 'unknown' END,reconcile_requested=CASE WHEN lease_kind='reconcile' THEN true ELSE reconcile_requested END,lease_id=NULL,lease_kind=NULL,lease_expires_at=NULL,safe_failure_code='webhook_lease_expired',version=version+1 WHERE id=$1 AND lease_id=$2`, [d.id, d.lease_id]);
    recovered++;
  });
  return recovered;
}
async function claimDelivery(pool: Pool): Promise<Claim | null> {
  const candidates = await pool.query<{ id: string; workspace_id: string }>(`SELECT d.id,d.workspace_id FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id=d.endpoint_id WHERE d.lease_id IS NULL AND ((e.state='enabled' AND d.state IN ('ready','retry_wait') AND d.next_attempt_at<=now()) OR (d.state='unknown' AND d.reconcile_requested)) AND NOT EXISTS(SELECT 1 FROM webhook_deliveries active WHERE active.endpoint_id=e.id AND active.lease_id IS NOT NULL) ORDER BY d.created_at,d.id LIMIT 20`);
  for (const candidate of candidates.rows) {
    const claimed = await transaction(pool, candidate.workspace_id, async sql => {
      const d = (await sql.query<WebhookDeliveryRow>(`SELECT * FROM webhook_deliveries WHERE id=$1 AND lease_id IS NULL AND ((state IN ('ready','retry_wait') AND next_attempt_at<=now()) OR (state='unknown' AND reconcile_requested)) FOR UPDATE SKIP LOCKED`, [candidate.id])).rows[0];
      if (!d) return null;
      const endpoint = (await sql.query<WebhookEndpointRow>('SELECT * FROM webhook_endpoints WHERE id=$1 FOR UPDATE', [d.endpoint_id])).rows[0]!;
      const active = await sql.query('SELECT id FROM webhook_deliveries WHERE endpoint_id=$1 AND lease_id IS NOT NULL', [endpoint.id]);
      if (active.rowCount) return null;
      const kind: Claim['kind'] = d.state === 'unknown' ? 'reconcile' : 'dispatch';
      if (kind === 'dispatch' && endpoint.state !== 'enabled') return null;
      const leaseId = randomUUID();
      const updated = await sql.query<WebhookDeliveryRow>(`UPDATE webhook_deliveries SET state=$2,lease_id=$3,lease_kind=$4,lease_expires_at=clock_timestamp()+interval '45 seconds',reconcile_requested=false,version=version+1 WHERE id=$1 RETURNING *`, [d.id, kind === 'dispatch' ? 'preparing' : 'unknown', leaseId, kind]);
      return { endpoint, delivery: updated.rows[0]!, kind, leaseId };
    });
    if (claimed) return claimed;
  }
  return null;
}
async function preparationFailed(pool: Pool, claim: Claim, code: string): Promise<void> {
  await transaction(pool, claim.endpoint.workspace_id, async sql => {
    const d = (await sql.query<WebhookDeliveryRow>('SELECT * FROM webhook_deliveries WHERE id=$1 AND lease_id=$2 AND lease_expires_at>clock_timestamp() FOR UPDATE', [claim.delivery.id, claim.leaseId])).rows[0];
    if (!d) return;
    const block = ['webhook_dns_denied','webhook_configuration_error','webhook_target_changed','webhook_target_not_allowed','webhook_secret_unavailable','webhook_authorization_revoked','webhook_restore_alignment_required'].includes(code);
    const retries = Math.min(d.safe_retry_count + 1, 3);
    const state = claim.kind === 'reconcile' ? 'unknown' : block ? 'blocked' : retries >= 3 ? 'failed_safe' : 'retry_wait';
    if (block && claim.kind === 'dispatch') await blockEndpoint(sql, claim.endpoint, code);
    await sql.query(`UPDATE webhook_deliveries SET state=$3,safe_failure_code=$4,safe_retry_count=$5,next_attempt_at=clock_timestamp()+$6*interval '1 second',lease_id=NULL,lease_kind=NULL,lease_expires_at=NULL,version=version+1 WHERE id=$1 AND lease_id=$2`, [d.id, claim.leaseId, state, code, retries, [1,5,30][retries - 1]]);
  });
}
async function beginAttempt(pool: Pool, config: WebhookConfig, claim: Claim, path: string): Promise<{ request: WebhookRequestIdentity; body: Buffer; key: Buffer } | null> {
  return transaction(pool, claim.endpoint.workspace_id, async sql => {
    const d = (await sql.query<WebhookDeliveryRow>('SELECT * FROM webhook_deliveries WHERE id=$1 AND lease_id=$2 AND lease_expires_at>clock_timestamp() FOR UPDATE', [claim.delivery.id, claim.leaseId])).rows[0];
    const e = (await sql.query<WebhookEndpointRow>('SELECT * FROM webhook_endpoints WHERE id=$1 FOR UPDATE', [claim.endpoint.id])).rows[0];
    if (!d || !e) return null;
    if (e.version !== claim.endpoint.version || claim.kind === 'dispatch' && (e.state !== 'enabled' || d.state !== 'preparing')) {
      await sql.query("UPDATE webhook_deliveries SET state=CASE WHEN state='preparing' THEN 'ready' ELSE state END,lease_id=NULL,lease_kind=NULL,lease_expires_at=NULL,version=version+1 WHERE id=$1 AND lease_id=$2", [d.id, claim.leaseId]); return null;
    }
    if (claim.kind === 'dispatch') await assertWebhookNewDispatchAllowed(sql, e.workspace_id);
    const fact = (await sql.query<WebhookFact>('SELECT * FROM service_fact_events WHERE workspace_id=$1 AND fact_id=$2', [e.workspace_id, d.fact_id])).rows[0];
    if (!fact) throw new DomainError('webhook_fact_filtered');
    const target = await authorizeWebhookHistoryDispatch(sql, e, fact, config);
    if (d.target_digest !== target.targetDigest || sha256(d.payload_bytes) !== d.payload_sha256) throw new DomainError('webhook_payload_invalid');
    const persisted = webhookBodySchema.safeParse(JSON.parse(d.payload_bytes.toString('utf8')));
    const projection = projectWebhookFact(fact, d.id);
    if (!persisted.success || !projection || projection.sha256 !== d.payload_sha256 || !e.event_types.includes(projection.eventType)) throw new DomainError('webhook_payload_invalid');
    const key = readWebhookSigningKey(target, e.active_key_id, e.id);
    const attemptId = randomUUID(); const attemptNo = d.attempt_no + 1;
    const receiptQuery = claim.kind === 'reconcile' && d.safe_failure_code !== 'webhook_receipt_checked';
    const body = claim.kind === 'dispatch' ? d.payload_bytes : receiptQuery ? Buffer.alloc(0) : Buffer.from(JSON.stringify({ schemaVersion: 1, endpointId: e.id, deliveryId: d.id, eventId: d.fact_id, payloadSha256: d.payload_sha256, closedThroughAttemptNo: attemptNo }));
    const request: WebhookRequestIdentity = { method: receiptQuery ? 'GET' : 'POST', path, endpointId: e.id, deliveryId: d.id, eventId: d.fact_id, attemptId, attemptNo, timestamp: Math.floor(Date.now() / 1000), keyId: e.active_key_id, bodySha256: sha256(body) };
    const marker = await sql.query(`UPDATE webhook_deliveries SET state=$3,attempt_no=$4,key_id=$5,version=version+1 WHERE id=$1 AND lease_id=$2 AND lease_expires_at>clock_timestamp()`, [d.id, claim.leaseId, claim.kind === 'dispatch' ? 'sending' : 'unknown', attemptNo, request.keyId]);
    if (!marker.rowCount) { key.fill(0); throw new DomainError('webhook_lease_expired', 'Preparation lease expired', 409); }
    await sql.query(`INSERT INTO webhook_delivery_attempts(delivery_id,attempt_no,attempt_id,kind,lease_id,key_id,request_body_sha256,phase) VALUES($1,$2,$3,$4,$5,$6,$7,'sending')`, [d.id, attemptNo, attemptId, claim.kind, claim.leaseId, request.keyId, request.bodySha256]);
    return { request, body, key };
  });
}
async function finishAttempt(pool: Pool, claim: Claim, identity: WebhookRequestIdentity, outcome: WebhookTransportResult): Promise<'accepted' | 'unknown' | 'safe'> {
  return transaction(pool, claim.endpoint.workspace_id, async sql => {
    const d = (await sql.query<WebhookDeliveryRow>('SELECT * FROM webhook_deliveries WHERE id=$1 AND lease_id=$2 AND lease_expires_at>clock_timestamp() FOR UPDATE', [claim.delivery.id, claim.leaseId])).rows[0];
    // Lost leases never authorize late results to overwrite a successor. Receiver evidence can be requested again.
    if (!d || claim.kind === 'dispatch' && d.state !== 'sending' || claim.kind === 'reconcile' && d.state !== 'unknown') return 'unknown';
    const receipt = outcome.receipt;
    if (receipt && outcome.responseSha256) {
      await sql.query(`INSERT INTO webhook_delivery_receipts(id,delivery_id,attempt_id,receiver_receipt_id,status,payload_sha256,closed_through_attempt_no,verified_key_id,response_sha256,receiver_recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [randomUUID(), d.id, identity.attemptId, receipt.receiverReceiptId, receipt.status, receipt.payloadSha256, receipt.closedThroughAttemptNo ?? null, identity.keyId, outcome.responseSha256, receipt.recordedAt]);
    }
    const safe = !outcome.requestMayHaveBeenSent && claim.kind === 'dispatch';
    const retries = safe ? Math.min(d.safe_retry_count + 1, 3) : d.safe_retry_count;
    const state = receipt?.status === 'accepted' ? 'accepted' : safe ? retries >= 3 ? 'failed_safe' : 'retry_wait' : 'unknown';
    await sql.query('UPDATE webhook_delivery_attempts SET phase=$3,finished_at=now(),safe_outcome_code=$4,http_status=$5 WHERE delivery_id=$1 AND attempt_id=$2 AND finished_at IS NULL', [d.id, identity.attemptId, receipt?.status ?? (safe ? 'failed_safe' : 'unknown'), outcome.safeCode, outcome.httpStatus]);
    const continueReconciliation = claim.kind === 'reconcile' && identity.method === 'GET' && state !== 'accepted';
    await sql.query(`UPDATE webhook_deliveries SET state=$3,accepted_at=CASE WHEN $3='accepted' THEN now() ELSE NULL END,safe_failure_code=$4,safe_retry_count=$5,next_attempt_at=clock_timestamp()+$6*interval '1 second',lease_id=NULL,lease_kind=NULL,lease_expires_at=NULL,reconcile_requested=$7,version=version+1 WHERE id=$1 AND lease_id=$2`, [d.id, claim.leaseId, state, receipt?.status === 'accepted' ? null : continueReconciliation ? 'webhook_receipt_checked' : outcome.safeCode, retries, [1,5,30][Math.max(0, retries - 1)], continueReconciliation]);
    return state === 'accepted' ? 'accepted' : safe ? 'safe' : 'unknown';
  });
}
export async function deliverWebhookBatch(pool: Pool, config?: WebhookConfig, options: { batchSize?: number; signal?: AbortSignal; transport?: WebhookTransport } = {}): Promise<WebhookBatch> {
  const size = options.batchSize ?? 1;
  if (!Number.isInteger(size) || size < 1 || size > 20) throw new Error('Webhook batch size must be between 1 and 20');
  const result: WebhookBatch = { enqueued: 0, filtered: 0, attempted: 0, accepted: 0, unknown: 0, expiredLeases: await recoverLeases(pool) };
  if (!config || config.status !== 'configured' || options.signal?.aborted) return result;
  await consumeFacts(pool, config, result, Math.max(size, 10));
  const transport = options.transport ?? webhookTransport;
  for (let i = 0; i < size && !options.signal?.aborted; i++) {
    const claim = await claimDelivery(pool);
    if (!claim) break;
    let prepared;
    let attempt;
    try {
      const target = requireWebhookTarget(config, claim.endpoint);
      const wireKind = claim.kind === 'dispatch' ? 'dispatch' : claim.delivery.safe_failure_code === 'webhook_receipt_checked' ? 'reconcile' : 'receipt';
      prepared = await transport.prepare(target, wireKind, claim.delivery.id, options.signal);
      attempt = await beginAttempt(pool, config, claim, prepared.url.pathname);
    } catch (error) {
      const code = error instanceof DomainError ? error.code : error instanceof WebhookNetworkError ? error.safeCode : error instanceof Error && error.message === 'webhook_secret_unavailable' ? error.message : 'webhook_prepare_failed';
      await preparationFailed(pool, claim, code); continue;
    }
    if (!attempt) continue;
    result.attempted++;
    let outcome: WebhookTransportResult;
    try { outcome = await transport.send(prepared, attempt.request, attempt.body, attempt.key, claim.delivery.payload_sha256, options.signal); }
    catch { outcome = { receipt: null, responseSha256: null, httpStatus: null, safeCode: 'webhook_transport_failed', requestMayHaveBeenSent: true }; }
    finally { attempt.key.fill(0); }
    const state = await finishAttempt(pool, claim, attempt.request, outcome);
    if (state === 'accepted') result.accepted++; else if (state === 'unknown') result.unknown++;
  }
  return result;
}
export async function runWebhookLoop(pool: Pool, config: WebhookConfig | undefined, signal: AbortSignal, options: { intervalMs?: number; workerId?: string; transport?: WebhookTransport } = {}): Promise<void> {
  const workerId = options.workerId ?? `webhook-${randomUUID()}`;
  let failures = 0;
  while (!signal.aborted) {
    try {
      const endpoints = await pool.query<WebhookEndpointRow>(`SELECT e.* FROM webhook_endpoints e LEFT JOIN webhook_key_health k ON k.endpoint_id=e.id AND k.worker_id=$1 WHERE e.state<>'retired' OR EXISTS(SELECT 1 FROM webhook_deliveries d WHERE d.endpoint_id=e.id AND d.state='unknown') ORDER BY k.checked_at NULLS FIRST,e.created_at,e.id LIMIT 20`, [workerId]);
      for (const endpoint of endpoints.rows) {
        const target = config?.targets.find(t => t.targetKey === endpoint.target_key && t.workspaceId === endpoint.workspace_id);
        const readyKeys: string[] = [];
        for (const meta of target?.keyring ?? []) { try { const key = readWebhookSigningKey(target!, meta.keyId, endpoint.id); key.fill(0); readyKeys.push(meta.keyId); } catch { /* Missing endpoint-specific keys remain unavailable; no fallback key is shared. */ } }
        await pool.query(`INSERT INTO webhook_key_health(worker_id,endpoint_id,config_digest,ready_key_ids) VALUES($1,$2,$3,$4) ON CONFLICT(worker_id,endpoint_id) DO UPDATE SET config_digest=excluded.config_digest,ready_key_ids=excluded.ready_key_ids,checked_at=now()`, [workerId, endpoint.id, config?.digest ?? null, readyKeys]);
      }
      await deliverWebhookBatch(pool, config, { signal, ...(options.transport ? { transport: options.transport } : {}) });
      failures = 0;
      await pool.query(`INSERT INTO webhook_loop_health(worker_id,config_digest,state) VALUES($1,$2,$3) ON CONFLICT(worker_id) DO UPDATE SET config_digest=excluded.config_digest,state=excluded.state,cycle_at=now()`, [workerId, config?.digest ?? null, config?.status === 'configured' ? 'running' : config?.status === 'configuration_error' ? 'degraded' : 'disabled']);
    } catch {
      failures++;
      await pool.query(`INSERT INTO webhook_loop_health(worker_id,config_digest,state) VALUES($1,$2,'degraded') ON CONFLICT(worker_id) DO UPDATE SET state='degraded',cycle_at=now()`, [workerId, config?.digest ?? null]).catch(() => {});
    }
    await delay(Math.min((options.intervalMs ?? 500) * 2 ** Math.min(failures, 6), 10000), undefined, { signal }).catch(() => {});
  }
  await pool.query("UPDATE webhook_loop_health SET state='stopped',cycle_at=now() WHERE worker_id=$1", [workerId]).catch(() => {});
}
