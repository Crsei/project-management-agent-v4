import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const WEBHOOK_EVENT_TYPES = ['pm.project.changed.v1', 'pm.task.changed.v1', 'pm.milestone.changed.v1'] as const;
export const WEBHOOK_CHANGE_KINDS = ['created', 'metadata_changed', 'content_changed', 'lifecycle_changed'] as const;
export const WEBHOOK_COMMANDS = ['CreateWebhookEndpoint', 'SetWebhookEndpointState', 'ReauthorizeWebhookEndpoint', 'SetWebhookEndpointSigningKey', 'ReconcileWebhookDelivery', 'ResumeWebhookDelivery'] as const;
export type WebhookEventType = typeof WEBHOOK_EVENT_TYPES[number];
export type WebhookEndpointState = 'paused' | 'enabled' | 'retired' | 'blocked';
export type WebhookDeliveryState = 'ready' | 'preparing' | 'sending' | 'retry_wait' | 'failed_safe' | 'blocked' | 'suppressed' | 'unknown' | 'accepted';
const eventTypeByEntity: Readonly<Record<string, WebhookEventType | undefined>> = { project: WEBHOOK_EVENT_TYPES[0], work_item: WEBHOOK_EVENT_TYPES[1], milestone: WEBHOOK_EVENT_TYPES[2] };
const id = z.uuid().toLowerCase();
const coreId = z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/).max(80);
const revision = z.string().regex(/^[a-zA-Z0-9:_-]{1,128}$/).nullable();
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const webhookBodySchema = z.strictObject({
  schemaVersion: z.literal(1), eventId: id, deliveryId: id, eventType: z.enum(WEBHOOK_EVENT_TYPES), workspaceId: id, projectId: coreId,
  entity: z.strictObject({ id: coreId, kind: z.enum(['project', 'work_item', 'milestone']), beforeRevision: revision, afterRevision: revision }),
  changeKinds: z.array(z.enum(WEBHOOK_CHANGE_KINDS)).min(1).max(4).refine(xs => new Set(xs).size === xs.length),
  sourceKind: z.enum(['command', 'core_http', 'core_observation']), occurredAt: z.iso.datetime().nullable(), observedAt: z.iso.datetime(),
}).superRefine((body, ctx) => {
  const expected = eventTypeByEntity[body.entity.kind];
  if (body.eventType !== expected || body.entity.kind === 'project' && body.entity.id !== body.projectId || body.sourceKind === 'core_observation' && body.occurredAt !== null) ctx.addIssue({ code: 'custom', message: 'Fact identity mismatch' });
});
export type WebhookBody = z.infer<typeof webhookBodySchema>;
export type WebhookFact = {
  fact_id: string; workspace_id: string; fact_sequence: string; schema_version: number; source_kind: string; project_id: string | null;
  entity_kind: string; entity_id: string; before_revision: string | null; after_revision: string | null; change_kinds: string[];
  occurred_at: Date | null; observed_at: Date | null; safety_class: string;
};
/** Explicit construction, never spread a source row or a core/audit payload into an outbound body. */
export function projectWebhookFact(fact: WebhookFact, deliveryId: string): { body: Buffer; sha256: string; eventType: WebhookEventType } | null {
  if (fact.schema_version !== 1 || fact.safety_class !== 'project_fact' || fact.after_revision === null) return null;
  const eventType = eventTypeByEntity[fact.entity_kind];
  if (!eventType) return null;
  const parsed = webhookBodySchema.safeParse({ schemaVersion: 1, eventId: fact.fact_id, deliveryId, eventType, workspaceId: fact.workspace_id, projectId: fact.project_id,
    entity: { id: fact.entity_id, kind: fact.entity_kind, beforeRevision: fact.before_revision, afterRevision: fact.after_revision }, changeKinds: fact.change_kinds,
    sourceKind: fact.source_kind, occurredAt: fact.occurred_at?.toISOString() ?? null, observedAt: fact.observed_at?.toISOString() });
  if (!parsed.success) return null;
  const body = Buffer.from(JSON.stringify(parsed.data));
  if (body.length > 4096) return null;
  return { body, sha256: sha256(body), eventType };
}
export function sha256(bytes: Uint8Array | string): string { return createHash('sha256').update(bytes).digest('hex'); }
export type WebhookRequestIdentity = { method: 'POST' | 'GET'; path: string; endpointId: string; deliveryId: string; eventId: string; attemptId: string; attemptNo: number; timestamp: number; keyId: string; bodySha256: string };
export function webhookRequestCanonical(r: WebhookRequestIdentity): string {
  return ['pm-webhook-request-v1', r.method, r.path, r.endpointId, r.deliveryId, r.eventId, r.attemptId, r.attemptNo, r.timestamp, r.keyId, r.bodySha256].join('\n');
}
export function signWebhookRequest(key: Uint8Array, request: WebhookRequestIdentity): string { return `v1=${createHmac('sha256', key).update(webhookRequestCanonical(request)).digest('hex')}`; }
export function constantSignatureEqual(expected: string, actual: string): boolean {
  return /^v1=[a-f0-9]{64}$/.test(actual) && expected.length === actual.length && timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}
export const webhookReceiptSchema = z.strictObject({ schemaVersion: z.literal(1), receiverReceiptId: id, endpointId: id, deliveryId: id, eventId: id, attemptId: id,
  payloadSha256: sha, status: z.enum(['accepted', 'pending', 'unknown', 'not_accepted']), closedThroughAttemptNo: z.number().int().nonnegative().optional(), recordedAt: z.iso.datetime() });
export type WebhookReceiverReceipt = z.infer<typeof webhookReceiptSchema>;
export function signWebhookReceipt(key: Uint8Array, request: WebhookRequestIdentity, status: number, bytes: Uint8Array): string {
  return `v1=${createHmac('sha256', key).update(['pm-webhook-receipt-v1', request.attemptId, status, sha256(bytes), request.keyId].join('\n')).digest('hex')}`;
}
export function verifyWebhookReceipt(key: Uint8Array, request: WebhookRequestIdentity, httpStatus: number, bytes: Uint8Array, signature: string, payloadSha256: string): WebhookReceiverReceipt | null {
  if (bytes.length > 8192 || !constantSignatureEqual(signWebhookReceipt(key, request, httpStatus, bytes), signature)) return null;
  let value: unknown;
  try { value = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { return null; }
  const result = webhookReceiptSchema.safeParse(value);
  if (!result.success) return null;
  const r = result.data;
  if (r.endpointId !== request.endpointId || r.deliveryId !== request.deliveryId || r.eventId !== request.eventId || r.attemptId !== request.attemptId || r.payloadSha256 !== payloadSha256) return null;
  if (r.status === 'not_accepted' && (r.closedThroughAttemptNo === undefined || r.closedThroughAttemptNo < request.attemptNo)) return null;
  return r;
}

export type WebhookTargetDto = { targetKey: string; hostname: string; projectIds: string[]; eventTypes: WebhookEventType[]; keyIds: string[] };
export type WebhookEndpointDto = { endpointId: string; targetKey: string; hostname: string | null; projectIds: string[]; eventTypes: WebhookEventType[]; state: WebhookEndpointState; version: number; activeKeyId: string; activationSequence: string; safeBlockCode: string | null; createdAt: string; counts: Partial<Record<WebhookDeliveryState, number>> };
export type WebhookOverview = { configuration: 'disabled' | 'configured' | 'configuration_error'; configurationDigest: string | null; restoreFenced: boolean; loopHealthy: boolean; loopCycleAt: string | null; targets: WebhookTargetDto[]; endpoints: WebhookEndpointDto[] };
export type WebhookDeliveryDto = { deliveryId: string; endpointId: string; eventId: string; state: WebhookDeliveryState; version: number; attemptNo: number; safeFailureCode: string | null; acceptedAt: string | null; createdAt: string; resumeReceiptId: string | null; reconciliationRequested: boolean };
export type WebhookDeliveryPage = { items: WebhookDeliveryDto[]; nextCursor: string | null };
export type WebhookDeliveryDetail = WebhookDeliveryDto & { attempts: { attemptId: string; attemptNo: number; kind: 'dispatch' | 'reconcile'; phase: string; keyId: string; startedAt: string; finishedAt: string | null; safeOutcomeCode: string | null; httpStatus: number | null }[]; receipts: { receiptId: string; receiverReceiptId: string; status: string; closedThroughAttemptNo: number | null; recordedAt: string }[] };
