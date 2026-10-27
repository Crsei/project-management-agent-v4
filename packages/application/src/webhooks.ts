import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { DomainError, type Actor } from '../../domain/src/core.ts';
import { projectWebhookFact, type WebhookFact, type WebhookOverview, type WebhookEndpointDto, type WebhookDeliveryDto, type WebhookDeliveryDetail, type WebhookDeliveryPage } from '../../domain/src/webhooks.ts';
import { createWebhookEndpointSchema, setWebhookEndpointStateSchema, setWebhookEndpointSigningKeySchema, emptyWebhookPayloadSchema, resumeWebhookDeliverySchema, webhookPageQuerySchema } from '../../contracts/src/webhook-schemas.ts';
import { webhookKeyMetadata, type WebhookConfig, type WebhookTarget } from '../../infrastructure/src/webhook-config.ts';
import { getMembership, requireCapability } from './access.ts';
import type { CommandContext, CommandRegistry, SqlExecutor } from './ports.ts';
import type { WebhookDeliveryRow, WebhookEndpointRow, WebhookHealthRow } from './webhook-store.ts';

export async function assertWebhookReceiptReadable(sql: SqlExecutor, actor: Actor, workspaceId: string, projectIds: string[]): Promise<void> {
  await requireCapability(sql, actor, workspaceId, 'access.manage');
  // access.manage is expressly not a substitute for either historical metadata permission.
  if (projectIds.length === 0) {
    await requireCapability(sql, actor, workspaceId, 'domain.read');
    await requireCapability(sql, actor, workspaceId, 'audit.read');
  }
  for (const projectId of projectIds) {
    await requireCapability(sql, actor, workspaceId, 'domain.read', projectId);
    await requireCapability(sql, actor, workspaceId, 'audit.read', projectId);
  }
}
export async function assertWebhookNewDispatchAllowed(sql: SqlExecutor, workspaceId: string): Promise<void> {
  const fence = await sql.query('SELECT workspace_id FROM webhook_restore_fences WHERE workspace_id=$1', [workspaceId]);
  if (fence.rowCount) throw new DomainError('webhook_restore_alignment_required', 'Restored webhook history requires operator receiver-ledger alignment before new dispatch', 409);
}
async function emitWebhookAdministration(ctx: CommandContext, id: string, kind: 'webhook_endpoint' | 'webhook_delivery', version: number): Promise<void> {
  // Administrative identifiers are actor-private invalidations, never public project activity or outbound facts.
  await ctx.sql.query(`INSERT INTO outbox(event_id,workspace_id,project_id,aggregate_id,aggregate_kind,aggregate_version,aggregate_sequence,event_type,payload,actor_id,command_id,audience_actor_id)
    SELECT $1,$2,NULL,$3,$4,$5,coalesce(max(aggregate_sequence),0)+1,'WebhookAdministrationChanged',$6::jsonb,$7,$8,$7 FROM outbox WHERE workspace_id=$2 AND aggregate_id=$3`,
  [randomUUID(), ctx.workspaceId, id, kind, version, JSON.stringify({ id, kind, version }), ctx.actor.id, ctx.command.commandId]);
}
export function requireWebhookTarget(config: WebhookConfig | undefined, endpoint: Pick<WebhookEndpointRow, 'workspace_id' | 'target_key' | 'target_digest' | 'project_ids' | 'event_types'>): WebhookTarget {
  if (!config || config.status === 'disabled') throw new DomainError('webhook_not_configured', 'Webhook deployment is not configured', 409);
  if (config.status === 'configuration_error') throw new DomainError('webhook_configuration_error', 'Webhook deployment configuration is invalid', 503);
  const target = config.targets.find(t => t.targetKey === endpoint.target_key && t.workspaceId === endpoint.workspace_id);
  if (!target || endpoint.project_ids.some(p => !target.projectIds.includes(p)) || endpoint.event_types.some(e => !target.eventTypes.includes(e))) throw new DomainError('webhook_target_not_allowed', 'Target or fixed scope is not approved', 409);
  if (target.targetDigest !== endpoint.target_digest) throw new DomainError('webhook_target_changed', 'Approved target identity changed; retire this endpoint and create a newly approved target', 409);
  return target;
}
/** Narrow historical authorization, not a claim about the current core entity or its content. Caller holds workspace lock. */
export async function authorizeWebhookHistoryDispatch(sql: SqlExecutor, endpoint: WebhookEndpointRow, fact: WebhookFact, config?: WebhookConfig): Promise<WebhookTarget> {
  const actor = { id: endpoint.authorizer_user_id, email: '', name: '' };
  // Pin current authorization through the sending commit, including account disable operations that do not take a workspace lock.
  await sql.query('SELECT id FROM users WHERE id=$1 FOR SHARE', [endpoint.authorizer_user_id]);
  await sql.query('SELECT user_id FROM memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE', [endpoint.workspace_id, endpoint.authorizer_user_id]);
  try { await assertWebhookReceiptReadable(sql, actor, endpoint.workspace_id, endpoint.project_ids); }
  catch { throw new DomainError('webhook_authorization_revoked', 'Endpoint authorizer no longer has current historical metadata permission', 409); }
  const target = requireWebhookTarget(config, endpoint);
  const projection = projectWebhookFact(fact, '00000000-0000-4000-8000-000000000000');
  if (fact.workspace_id !== endpoint.workspace_id || !fact.project_id || !endpoint.project_ids.includes(fact.project_id) || !projection || !endpoint.event_types.includes(projection.eventType)) throw new DomainError('webhook_fact_filtered', 'Fact is outside the safe historical scope', 409);
  return target;
}
async function endpointForCommand(ctx: CommandContext, delivery = false): Promise<{ endpoint: WebhookEndpointRow; delivery?: WebhookDeliveryRow }> {
  // Mark workspace and every scope through ctx so original command receipts retain exact authorization requirements.
  await ctx.require('access.manage');
  await ctx.require('domain.read');
  await ctx.require('audit.read');
  if (!ctx.command.targetId || !z.uuid().safeParse(ctx.command.targetId).success || ctx.command.projectId) throw new DomainError('validation_failed', 'A webhook target UUID and workspace scope are required');
  let row: WebhookDeliveryRow | undefined;
  if (delivery) {
    row = (await ctx.sql.query<WebhookDeliveryRow>('SELECT * FROM webhook_deliveries WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [ctx.workspaceId, ctx.command.targetId])).rows[0];
    if (!row) throw new DomainError('not_found_or_forbidden', 'Webhook delivery is not accessible', 404);
  }
  const endpoint = (await ctx.sql.query<WebhookEndpointRow>('SELECT * FROM webhook_endpoints WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [ctx.workspaceId, row?.endpoint_id ?? ctx.command.targetId])).rows[0];
  if (!endpoint) throw new DomainError('not_found_or_forbidden', 'Webhook endpoint is not accessible', 404);
  for (const projectId of endpoint.project_ids) { await ctx.require('domain.read', projectId); await ctx.require('audit.read', projectId); }
  const version = row?.version ?? endpoint.version;
  if (ctx.command.expectedVersions?.[ctx.command.targetId] !== version) throw new DomainError('version_conflict', 'Webhook version changed; explicitly reread before another command', 409, { id: ctx.command.targetId, currentVersion: version });
  return { endpoint, ...(row ? { delivery: row } : {}) };
}
async function readyLoop(sql: SqlExecutor, config: WebhookConfig, target: WebhookTarget, keyId: string, endpointId: string): Promise<void> {
  if (!webhookKeyMetadata(target, keyId)) throw new DomainError('webhook_receiver_contract_missing', 'No active receiver-prepared signing key is approved', 409);
  const health = await sql.query(`SELECT 1 FROM webhook_loop_health h JOIN webhook_key_health k ON k.worker_id=h.worker_id AND k.config_digest=h.config_digest WHERE h.config_digest=$1 AND h.state='running' AND h.cycle_at>now()-interval '30 seconds' AND k.endpoint_id=$2 AND k.checked_at>now()-interval '30 seconds' AND $3=ANY(k.ready_key_ids) LIMIT 1`, [config.digest, endpointId, keyId]);
  if (!health.rowCount) throw new DomainError('webhook_secret_unavailable', 'A current matching Worker and available endpoint-specific signing key are required', 409);
}
export function createWebhookCommands(config?: WebhookConfig, validateProjects?: (sql: SqlExecutor, actor: Actor, workspaceId: string, projectIds: string[]) => Promise<void>): CommandRegistry {
  return {
    CreateWebhookEndpoint: { payload: createWebhookEndpointSchema, async handler(ctx) {
      await ctx.require('access.manage'); await ctx.require('domain.read'); await ctx.require('audit.read');
      await assertWebhookNewDispatchAllowed(ctx.sql, ctx.workspaceId);
      if (ctx.command.targetId || ctx.command.projectId) throw new DomainError('scope_mismatch', 'Create endpoint targets the workspace');
      const payload = createWebhookEndpointSchema.parse(ctx.command.payload);
      const target = config?.targets.find(t => t.targetKey === payload.targetKey && t.workspaceId === ctx.workspaceId);
      const identity = { workspace_id: ctx.workspaceId, target_key: payload.targetKey, target_digest: target?.targetDigest ?? '', project_ids: payload.projectIds, event_types: payload.eventTypes };
      requireWebhookTarget(config, identity);
      for (const projectId of payload.projectIds) { await ctx.require('domain.read', projectId); await ctx.require('audit.read', projectId); }
      await ctx.core?.refresh?.();
      if (validateProjects) await validateProjects(ctx.sql, ctx.actor, ctx.workspaceId, payload.projectIds);
      else if (ctx.core) {
        for (const projectId of payload.projectIds) { const project = await ctx.core.get(projectId, 'project'); if (project.data.archived || project.data.archivedAt) throw new DomainError('scope_mismatch', 'Project is unavailable'); }
      } else throw new DomainError('backend_not_initialized', 'Authoritative project validation is unavailable', 503);
      const activeKey = target!.keyring.find(key => webhookKeyMetadata(target!, key.keyId));
      if (!activeKey) throw new DomainError('webhook_receiver_contract_missing', 'No receiver-prepared signing key is approved', 409);
      const water = (await ctx.sql.query<{ sequence: string }>('SELECT coalesce(max(fact_sequence),0)::text AS sequence FROM service_fact_events WHERE workspace_id=$1', [ctx.workspaceId])).rows[0]!.sequence;
      const endpointId = randomUUID();
      await ctx.sql.query(`INSERT INTO webhook_endpoints(id,workspace_id,target_key,target_digest,project_ids,event_types,authorizer_user_id,active_key_id,activation_sequence) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [endpointId, ctx.workspaceId, payload.targetKey, target!.targetDigest, payload.projectIds, payload.eventTypes, ctx.actor.id, activeKey.keyId, water]);
      await emitWebhookAdministration(ctx, endpointId, 'webhook_endpoint', 1);
      return { endpointId, version: 1, state: 'paused', activationSequence: water };
    } },
    SetWebhookEndpointState: { payload: setWebhookEndpointStateSchema, async handler(ctx) {
      const { endpoint } = await endpointForCommand(ctx);
      const { state } = setWebhookEndpointStateSchema.parse(ctx.command.payload);
      if (endpoint.state === 'retired') throw new DomainError('webhook_endpoint_retired', 'A retired endpoint cannot change state', 409);
      if (state === 'enabled') {
        await assertWebhookNewDispatchAllowed(ctx.sql, ctx.workspaceId);
        if (endpoint.state === 'blocked') throw new DomainError('webhook_authorization_revoked', 'Explicit reauthorization is required before enablement', 409);
        await assertWebhookReceiptReadable(ctx.sql, { id: endpoint.authorizer_user_id, email: '', name: '' }, ctx.workspaceId, endpoint.project_ids);
        const target = requireWebhookTarget(config, endpoint);
        await readyLoop(ctx.sql, config!, target, endpoint.active_key_id, endpoint.id);
      }
      const result = await ctx.sql.query<WebhookEndpointRow>('UPDATE webhook_endpoints SET state=$3,safe_block_code=NULL,version=version+1 WHERE workspace_id=$1 AND id=$2 AND version=$4 RETURNING *', [ctx.workspaceId, endpoint.id, state, endpoint.version]);
      if (state === 'retired') await ctx.sql.query("UPDATE webhook_deliveries SET state='suppressed',version=version+1,safe_failure_code='endpoint_retired',lease_id=NULL,lease_kind=NULL,lease_expires_at=NULL WHERE endpoint_id=$1 AND state IN ('ready','retry_wait','preparing','blocked','failed_safe')", [endpoint.id]);
      if (state === 'enabled') await ctx.sql.query("UPDATE webhook_deliveries SET state='ready',safe_failure_code=NULL,version=version+1 WHERE endpoint_id=$1 AND state='blocked'", [endpoint.id]);
      await emitWebhookAdministration(ctx, endpoint.id, 'webhook_endpoint', result.rows[0]!.version);
      return { endpointId: endpoint.id, state, version: result.rows[0]!.version };
    } },
    ReauthorizeWebhookEndpoint: { payload: emptyWebhookPayloadSchema, async handler(ctx) {
      const { endpoint } = await endpointForCommand(ctx);
      requireWebhookTarget(config, endpoint);
      const state = endpoint.state === 'retired' ? 'retired' : 'paused';
      const updated = await ctx.sql.query<{ version: number }>('UPDATE webhook_endpoints SET authorizer_user_id=$3,state=$5,safe_block_code=NULL,version=version+1 WHERE workspace_id=$1 AND id=$2 AND version=$4 RETURNING version', [ctx.workspaceId, endpoint.id, ctx.actor.id, endpoint.version, state]);
      await emitWebhookAdministration(ctx, endpoint.id, 'webhook_endpoint', updated.rows[0]!.version);
      return { endpointId: endpoint.id, state, version: updated.rows[0]!.version };
    } },
    SetWebhookEndpointSigningKey: { payload: setWebhookEndpointSigningKeySchema, async handler(ctx) {
      const { endpoint } = await endpointForCommand(ctx);
      const { keyId } = setWebhookEndpointSigningKeySchema.parse(ctx.command.payload);
      const target = requireWebhookTarget(config, endpoint); await readyLoop(ctx.sql, config!, target, keyId, endpoint.id);
      const updated = await ctx.sql.query<{ version: number }>('UPDATE webhook_endpoints SET active_key_id=$3,version=version+1 WHERE workspace_id=$1 AND id=$2 AND version=$4 RETURNING version', [ctx.workspaceId, endpoint.id, keyId, endpoint.version]);
      await emitWebhookAdministration(ctx, endpoint.id, 'webhook_endpoint', updated.rows[0]!.version);
      return { endpointId: endpoint.id, activeKeyId: keyId, version: updated.rows[0]!.version };
    } },
    ReconcileWebhookDelivery: { payload: emptyWebhookPayloadSchema, async handler(ctx) {
      const { delivery } = await endpointForCommand(ctx, true);
      if (delivery!.state !== 'unknown') throw new DomainError('webhook_outcome_unknown', 'Only unknown deliveries can be reconciled', 409);
      await ctx.sql.query('UPDATE webhook_deliveries SET reconcile_requested=true,version=version+1 WHERE id=$1 AND version=$2', [delivery!.id, delivery!.version]);
      await emitWebhookAdministration(ctx, delivery!.id, 'webhook_delivery', delivery!.version + 1);
      return { deliveryId: delivery!.id, reconciliationRequested: true, version: delivery!.version + 1 };
    } },
    ResumeWebhookDelivery: { payload: resumeWebhookDeliverySchema, async handler(ctx) {
      const { endpoint, delivery } = await endpointForCommand(ctx, true);
      await assertWebhookNewDispatchAllowed(ctx.sql, ctx.workspaceId);
      const { receiptId } = resumeWebhookDeliverySchema.parse(ctx.command.payload);
      requireWebhookTarget(config, endpoint);
      if (endpoint.state !== 'enabled' || delivery!.state !== 'unknown' || delivery!.lease_id) throw new DomainError('webhook_outcome_unknown', 'Unknown delivery must be quiescent and endpoint enabled', 409);
      const evidence = await ctx.sql.query(`SELECT id FROM webhook_delivery_receipts WHERE id=$1 AND delivery_id=$2 AND status='not_accepted' AND payload_sha256=$3 AND closed_through_attempt_no >= $4`, [receiptId, delivery!.id, delivery!.payload_sha256, delivery!.attempt_no]);
      if (!evidence.rowCount) throw new DomainError('webhook_outcome_unknown', 'Authenticated receiver evidence closing every prior attempt is required', 409);
      await assertWebhookReceiptReadable(ctx.sql, { id: endpoint.authorizer_user_id, email: '', name: '' }, ctx.workspaceId, endpoint.project_ids);
      await ctx.sql.query("UPDATE webhook_deliveries SET state='ready',safe_failure_code=NULL,reconcile_requested=false,next_attempt_at=now(),version=version+1 WHERE id=$1 AND version=$2", [delivery!.id, delivery!.version]);
      await emitWebhookAdministration(ctx, delivery!.id, 'webhook_delivery', delivery!.version + 1);
      return { deliveryId: delivery!.id, state: 'ready', version: delivery!.version + 1 };
    } },
  };
}
export async function readWebhooks(pool: Pool, actor: Actor, workspaceId: string, config?: WebhookConfig): Promise<WebhookOverview> {
  await assertWebhookReceiptReadable(pool, actor, workspaceId, []);
  const rows = await pool.query<WebhookEndpointRow>('SELECT * FROM webhook_endpoints WHERE workspace_id=$1 ORDER BY created_at,id', [workspaceId]);
  for (const row of rows.rows) await assertWebhookReceiptReadable(pool, actor, workspaceId, row.project_ids);
  const restoreFence = await pool.query('SELECT workspace_id FROM webhook_restore_fences WHERE workspace_id=$1', [workspaceId]);
  const counts = await pool.query<{ endpoint_id: string; state: WebhookDeliveryRow['state']; count: string }>('SELECT endpoint_id,state,count(*)::text FROM webhook_deliveries WHERE workspace_id=$1 GROUP BY endpoint_id,state', [workspaceId]);
  const health = await pool.query<WebhookHealthRow>("SELECT * FROM webhook_loop_health WHERE config_digest=$1 AND state='running' AND cycle_at>now()-interval '30 seconds' ORDER BY cycle_at DESC LIMIT 1", [config?.digest ?? null]);
  const keyHealth = await pool.query<{ endpoint_id: string; ready_key_ids: string[] }>(`SELECT DISTINCT ON(k.endpoint_id) k.endpoint_id,k.ready_key_ids FROM webhook_key_health k JOIN webhook_loop_health h ON h.worker_id=k.worker_id AND h.config_digest=k.config_digest JOIN webhook_endpoints e ON e.id=k.endpoint_id WHERE e.workspace_id=$1 AND h.config_digest=$2 AND h.state='running' AND h.cycle_at>now()-interval '30 seconds' AND k.checked_at>now()-interval '30 seconds' ORDER BY k.endpoint_id,k.checked_at DESC`, [workspaceId, config?.digest ?? null]);
  const endpoints: WebhookEndpointDto[] = [];
  for (const row of rows.rows) {
    let safeBlockCode = row.safe_block_code;
    try {
      const target = requireWebhookTarget(config, row);
      await assertWebhookReceiptReadable(pool, { id: row.authorizer_user_id, email: '', name: '' }, workspaceId, row.project_ids);
      if (!webhookKeyMetadata(target, row.active_key_id) || !keyHealth.rows.find(k => k.endpoint_id === row.id)?.ready_key_ids.includes(row.active_key_id)) safeBlockCode = 'webhook_secret_unavailable';
    } catch (error) { safeBlockCode = error instanceof DomainError && error.code.startsWith('webhook_') ? error.code : 'webhook_authorization_revoked'; }
    endpoints.push({ endpointId: row.id, targetKey: row.target_key, hostname: config?.targets.find(t => t.targetKey === row.target_key && t.workspaceId === workspaceId)?.hostname ?? null, projectIds: row.project_ids, eventTypes: row.event_types, state: row.state, version: row.version, activeKeyId: row.active_key_id, activationSequence: row.activation_sequence, safeBlockCode, createdAt: row.created_at.toISOString(), counts: Object.fromEntries(counts.rows.filter(c => c.endpoint_id === row.id).map(c => [c.state, Number(c.count)])) });
  }
  return { configuration: config?.status ?? 'disabled', configurationDigest: config?.digest ?? null, restoreFenced: !!restoreFence.rowCount, loopHealthy: !!health.rows[0], loopCycleAt: health.rows[0]?.cycle_at.toISOString() ?? null, targets: config?.targets.filter(t => t.workspaceId === workspaceId).map(t => ({ targetKey: t.targetKey, hostname: t.hostname, projectIds: t.projectIds, eventTypes: t.eventTypes, keyIds: t.keyring.filter(k => webhookKeyMetadata(t, k.keyId)).map(k => k.keyId) })) ?? [], endpoints };
}
async function authorizeDeliveryRead(sql: SqlExecutor, actor: Actor, workspaceId: string, endpointId: string): Promise<void> {
  await assertWebhookReceiptReadable(sql, actor, workspaceId, []);
  const endpoint = (await sql.query<WebhookEndpointRow>('SELECT * FROM webhook_endpoints WHERE workspace_id=$1 AND id=$2', [workspaceId, endpointId])).rows[0];
  if (!endpoint) throw new DomainError('not_found_or_forbidden', 'Webhook endpoint is not accessible', 404);
  await assertWebhookReceiptReadable(sql, actor, workspaceId, endpoint.project_ids);
}
async function deliveryDto(sql: SqlExecutor, row: WebhookDeliveryRow): Promise<WebhookDeliveryDto> {
  const evidence = row.state === 'unknown' && !row.lease_id ? (await sql.query<{ id: string }>("SELECT r.id FROM webhook_delivery_receipts r WHERE r.delivery_id=$1 AND r.status='not_accepted' AND r.closed_through_attempt_no >= $2 AND r.payload_sha256=$3 AND EXISTS(SELECT 1 FROM webhook_endpoints e WHERE e.id=$4 AND e.state='enabled') AND NOT EXISTS(SELECT 1 FROM webhook_restore_fences f WHERE f.workspace_id=$5) ORDER BY r.recorded_at DESC LIMIT 1", [row.id, row.attempt_no, row.payload_sha256, row.endpoint_id, row.workspace_id])).rows[0]?.id ?? null : null;
  return { deliveryId: row.id, endpointId: row.endpoint_id, eventId: row.fact_id, state: row.state, version: row.version, attemptNo: row.attempt_no, safeFailureCode: row.safe_failure_code, acceptedAt: row.accepted_at?.toISOString() ?? null, createdAt: row.created_at.toISOString(), resumeReceiptId: evidence, reconciliationRequested: row.reconcile_requested };
}
export async function readWebhookDeliveries(pool: Pool, actor: Actor, workspaceId: string, endpointId: string, input: unknown): Promise<WebhookDeliveryPage> {
  await authorizeDeliveryRead(pool, actor, workspaceId, endpointId);
  const query = webhookPageQuerySchema.parse(input);
  let afterId: string | null = null;
  if (query.cursor) {
    try { const c = z.strictObject({ actor: z.uuid(), workspace: z.uuid(), endpoint: z.uuid(), id: z.uuid() }).parse(JSON.parse(Buffer.from(query.cursor, 'base64url').toString())); if (c.actor !== actor.id || c.workspace !== workspaceId || c.endpoint !== endpointId) throw new Error('scope'); afterId = c.id; }
    catch { throw new DomainError('validation_failed', 'Invalid webhook pagination cursor'); }
  }
  if (afterId && !(await pool.query('SELECT id FROM webhook_deliveries WHERE workspace_id=$1 AND endpoint_id=$2 AND id=$3', [workspaceId, endpointId, afterId])).rowCount) throw new DomainError('validation_failed', 'Invalid webhook pagination cursor');
  // Resolve the immutable seek row in SQL: JavaScript Date would truncate PostgreSQL microseconds and skip tied rows.
  const rows = await pool.query<WebhookDeliveryRow>('SELECT d.* FROM webhook_deliveries d WHERE d.workspace_id=$1 AND d.endpoint_id=$2 AND ($3::uuid IS NULL OR (d.created_at,d.id)<(SELECT c.created_at,c.id FROM webhook_deliveries c WHERE c.workspace_id=$1 AND c.endpoint_id=$2 AND c.id=$3)) ORDER BY d.created_at DESC,d.id DESC LIMIT $4', [workspaceId, endpointId, afterId, query.limit + 1]);
  const page = rows.rows.slice(0, query.limit); const last = page.at(-1);
  return { items: await Promise.all(page.map(row => deliveryDto(pool, row))), nextCursor: rows.rows.length > query.limit && last ? Buffer.from(JSON.stringify({ actor: actor.id, workspace: workspaceId, endpoint: endpointId, id: last.id })).toString('base64url') : null };
}
export async function readWebhookDelivery(pool: Pool, actor: Actor, workspaceId: string, deliveryId: string): Promise<WebhookDeliveryDetail> {
  await getMembership(pool, actor, workspaceId);
  await assertWebhookReceiptReadable(pool, actor, workspaceId, []);
  const row = (await pool.query<WebhookDeliveryRow>('SELECT * FROM webhook_deliveries WHERE workspace_id=$1 AND id=$2', [workspaceId, deliveryId])).rows[0];
  if (!row) throw new DomainError('not_found_or_forbidden', 'Webhook delivery is not accessible', 404);
  await authorizeDeliveryRead(pool, actor, workspaceId, row.endpoint_id);
  const attempts = await pool.query<{ attempt_id: string; attempt_no: number; kind: 'dispatch' | 'reconcile'; phase: string; key_id: string; started_at: Date; finished_at: Date | null; safe_outcome_code: string | null; http_status: number | null }>('SELECT attempt_id,attempt_no,kind,phase,key_id,started_at,finished_at,safe_outcome_code,http_status FROM webhook_delivery_attempts WHERE delivery_id=$1 ORDER BY attempt_no DESC', [deliveryId]);
  const receipts = await pool.query<{ id: string; receiver_receipt_id: string; status: string; closed_through_attempt_no: number | null; recorded_at: Date }>('SELECT id,receiver_receipt_id,status,closed_through_attempt_no,recorded_at FROM webhook_delivery_receipts WHERE delivery_id=$1 ORDER BY recorded_at DESC', [deliveryId]);
  return { ...await deliveryDto(pool, row), attempts: attempts.rows.map(a => ({ attemptId: a.attempt_id, attemptNo: a.attempt_no, kind: a.kind, phase: a.phase, keyId: a.key_id, startedAt: a.started_at.toISOString(), finishedAt: a.finished_at?.toISOString() ?? null, safeOutcomeCode: a.safe_outcome_code, httpStatus: a.http_status })), receipts: receipts.rows.map(r => ({ receiptId: r.id, receiverReceiptId: r.receiver_receipt_id, status: r.status, closedThroughAttemptNo: r.closed_through_attempt_no, recordedAt: r.recorded_at.toISOString() })) };
}
