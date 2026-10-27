import { z } from 'zod';
import { WEBHOOK_EVENT_TYPES } from '../../domain/src/webhooks.ts';
import type { WebhookOverview, WebhookDeliveryPage, WebhookDeliveryDetail } from '../../domain/src/webhooks.ts';
const token = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
export const createWebhookEndpointSchema = z.strictObject({ targetKey: token, projectIds: z.array(z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/).max(80)).min(1).max(1000).refine(xs => new Set(xs).size === xs.length), eventTypes: z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1).max(3).refine(xs => new Set(xs).size === xs.length) });
export const setWebhookEndpointStateSchema = z.strictObject({ state: z.enum(['enabled', 'paused', 'retired']) });
export const setWebhookEndpointSigningKeySchema = z.strictObject({ keyId: token });
export const emptyWebhookPayloadSchema = z.strictObject({});
export const resumeWebhookDeliverySchema = z.strictObject({ receiptId: z.uuid().toLowerCase() });
export const webhookParamsSchema = z.strictObject({ workspaceId: z.uuid().toLowerCase(), endpointId: z.uuid().toLowerCase().optional(), deliveryId: z.uuid().toLowerCase().optional() });
export const webhookPageQuerySchema = z.strictObject({ cursor: z.string().min(1).max(2048).optional(), limit: z.coerce.number().int().min(1).max(100).default(30) });
export type { WebhookOverview, WebhookTargetDto, WebhookEndpointDto, WebhookDeliveryDto, WebhookDeliveryPage, WebhookDeliveryDetail } from '../../domain/src/webhooks.ts';

const responseUuid = z.uuid();
const responseDate = z.iso.datetime();
const deliveryState = z.enum(['ready', 'preparing', 'sending', 'retry_wait', 'failed_safe', 'blocked', 'suppressed', 'unknown', 'accepted']);
const webhookTargetResponseSchema = z.strictObject({ targetKey: token, hostname: z.string(), projectIds: z.array(z.string()), eventTypes: z.array(z.enum(WEBHOOK_EVENT_TYPES)), keyIds: z.array(token) });
const webhookEndpointResponseSchema = z.strictObject({
  endpointId: responseUuid, targetKey: token, hostname: z.string().nullable(), projectIds: z.array(z.string()), eventTypes: z.array(z.enum(WEBHOOK_EVENT_TYPES)),
  state: z.enum(['paused', 'enabled', 'retired', 'blocked']), version: z.number().int().positive(), activeKeyId: token, activationSequence: z.string().regex(/^\d+$/),
  safeBlockCode: z.string().nullable(), createdAt: responseDate, counts: z.partialRecord(deliveryState, z.number().int().nonnegative()),
});
const webhookDeliveryResponseSchema = z.strictObject({
  deliveryId: responseUuid, endpointId: responseUuid, eventId: responseUuid, state: deliveryState, version: z.number().int().positive(), attemptNo: z.number().int().nonnegative(),
  safeFailureCode: z.string().nullable(), acceptedAt: responseDate.nullable(), createdAt: responseDate, resumeReceiptId: responseUuid.nullable(), reconciliationRequested: z.boolean(),
});
const webhookAttemptResponseSchema = z.strictObject({ attemptId: responseUuid, attemptNo: z.number().int().positive(), kind: z.enum(['dispatch', 'reconcile']), phase: z.string(), keyId: token, startedAt: responseDate, finishedAt: responseDate.nullable(), safeOutcomeCode: z.string().nullable(), httpStatus: z.number().int().min(100).max(599).nullable() });
const webhookReceiptResponseSchema = z.strictObject({ receiptId: responseUuid, receiverReceiptId: responseUuid, status: z.string(), closedThroughAttemptNo: z.number().int().nonnegative().nullable(), recordedAt: responseDate });
const webhookOverviewResponseSchema = z.strictObject({
  configuration: z.enum(['disabled', 'configured', 'configuration_error']), configurationDigest: z.string().nullable(), restoreFenced: z.boolean(), loopHealthy: z.boolean(), loopCycleAt: responseDate.nullable(),
  targets: z.array(webhookTargetResponseSchema), endpoints: z.array(webhookEndpointResponseSchema),
}) satisfies z.ZodType<WebhookOverview>;
const webhookDeliveryPageResponseSchema = z.strictObject({ items: z.array(webhookDeliveryResponseSchema), nextCursor: z.string().nullable() }) satisfies z.ZodType<WebhookDeliveryPage>;
const webhookDeliveryDetailResponseSchema = webhookDeliveryResponseSchema.extend({ attempts: z.array(webhookAttemptResponseSchema), receipts: z.array(webhookReceiptResponseSchema) }) satisfies z.ZodType<WebhookDeliveryDetail>;
export const webhookResponseSchemas = {
  WebhookOverview: webhookOverviewResponseSchema,
  WebhookDeliveryPage: webhookDeliveryPageResponseSchema,
  WebhookDeliveryDetail: webhookDeliveryDetailResponseSchema,
  WebhookTarget: webhookTargetResponseSchema,
  WebhookEndpoint: webhookEndpointResponseSchema,
  WebhookDelivery: webhookDeliveryResponseSchema,
  WebhookAttempt: webhookAttemptResponseSchema,
  WebhookReceipt: webhookReceiptResponseSchema,
};
