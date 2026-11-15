import { z } from 'zod';
import { agentChatToolResultFields } from './pm-tool-shared.ts';

const uuid = z.uuid().toLowerCase();
const project = z.string().regex(/^PRJ-\d+$/);
const date = z.iso.datetime({ offset: true });
const token = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const boundedText = z.string().max(500);
const provider = z.enum(['github', 'slack', 'linear', 'gitlab', 'bitbucket', 'atlassian-rovo', 'tavily', 'notion']);
export const integrationConnectionMetadataSchema = z.strictObject({
  id: uuid, projectId: project, provider, label: z.string().max(160), revision: z.number().int().positive(),
  status: z.enum(['configured', 'verified', 'error', 'revoked']), verification: z.strictObject({ mcp: z.boolean(), nativeApi: z.boolean() }),
  hasCredentials: z.boolean(), mcpConfigFingerprint: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  lastCheckedAt: date.nullable(), lastError: boundedText.nullable(), createdAt: date, updatedAt: date,
});
export const integrationEventEndpointMetadataSchema = z.strictObject({
  id: uuid, projectId: project, definitionId: uuid, source: z.string().max(100), key: z.string().max(200),
  verification: z.enum(['key', 'hmac_sha256_hex', 'standard_webhooks', 'slack_v0']), payloadPointer: z.string().max(500),
  revision: z.number().int().positive(), status: z.enum(['active', 'revoked']), url: z.string().max(4096),
  hasSecret: z.boolean(), createdAt: date, updatedAt: date,
});
const eventReceipt = z.strictObject({ eventId: uuid, status: z.enum(['accepted', 'filtered', 'rejected']), executionId: uuid.nullable(), reason: boundedText.nullable(), receivedAt: date });
const eventType = z.enum(['pm.project.changed.v1', 'pm.task.changed.v1', 'pm.milestone.changed.v1']);
const deliveryState = z.enum(['ready', 'preparing', 'sending', 'retry_wait', 'failed_safe', 'blocked', 'suppressed', 'unknown', 'accepted']);
const webhookEndpoint = z.strictObject({
  endpointId: uuid, targetKey: token, hostname: z.string().max(253).nullable(), projectIds: z.array(project).max(1000), eventTypes: z.array(eventType).max(3),
  state: z.enum(['paused', 'enabled', 'retired', 'blocked']), version: z.number().int().positive(), activeKeyId: token, activationSequence: z.string().regex(/^\d+$/),
  safeBlockCode: boundedText.nullable(), createdAt: date, counts: z.partialRecord(deliveryState, z.number().int().nonnegative()),
});
const webhookTarget = z.strictObject({ targetKey: token, hostname: z.string().max(253), projectIds: z.array(project).max(1000), eventTypes: z.array(eventType).max(3), keyIds: z.array(token).max(100) });
const webhookDelivery = z.strictObject({
  deliveryId: uuid, endpointId: uuid, eventId: uuid, state: deliveryState, version: z.number().int().positive(), attemptNo: z.number().int().nonnegative(),
  safeFailureCode: boundedText.nullable(), acceptedAt: date.nullable(), createdAt: date, resumeReceiptId: uuid.nullable(), reconciliationRequested: z.boolean(),
});
const webhookAttempt = z.strictObject({ attemptId: uuid, attemptNo: z.number().int().positive(), kind: z.enum(['dispatch', 'reconcile']), phase: boundedText, keyId: token, startedAt: date, finishedAt: date.nullable(), safeOutcomeCode: boundedText.nullable(), httpStatus: z.number().int().min(100).max(599).nullable() });
const webhookReceipt = z.strictObject({ receiptId: uuid, receiverReceiptId: uuid, status: boundedText, closedThroughAttemptNo: z.number().int().nonnegative().nullable(), recordedAt: date });
const imBinding = z.strictObject({ id: uuid, platform: z.string().max(40), accountLabel: z.string().max(300), notifyEnabled: z.boolean(), defaultProjectId: project.nullable(), verifiedAt: date, lastSeenAt: date, revokedAt: date.nullable(), revision: z.number().int().positive() });
const connectivity = z.strictObject({
  satori: z.strictObject({ state: z.enum(['disconnected', 'connecting', 'ready', 'auth_failed', 'error']), readyAt: date.nullable(), lastEventAt: date.nullable(), lastErrorCode: z.string().max(100).nullable() }),
  bots: z.array(z.strictObject({ platform: z.string().max(40), selfId: z.string().max(200), name: z.string().max(200).nullable(), status: z.enum(['online', 'offline', 'connecting', 'unknown']), username: z.string().max(100).nullable() })).max(20),
});
export const integrationsToolRecoveryIdentitySchema = z.strictObject({
  kind: z.literal('integration'), commandId: uuid, hash: z.string().regex(/^[a-f0-9]{64}$/),
  action: z.enum(['connection-verify', 'connection-revoke', 'event-revoke']), targetId: uuid, projectId: project,
});
export type IntegrationsToolRecoveryIdentity = z.infer<typeof integrationsToolRecoveryIdentitySchema>;
export const integrationWebhookActionResultSchema = z.union([
  z.strictObject({ endpointId: uuid, version: z.number().int().positive(), state: z.enum(['paused', 'enabled', 'retired']), activationSequence: z.string().regex(/^\d+$/).optional() }),
  z.strictObject({ endpointId: uuid, version: z.number().int().positive(), activeKeyId: token }),
  z.strictObject({ deliveryId: uuid, version: z.number().int().positive(), reconciliationRequested: z.literal(true) }),
  z.strictObject({ deliveryId: uuid, version: z.number().int().positive(), state: z.literal('ready') }),
]);
export const IntegrationsToolResultSchema = z.union([
  z.strictObject({ kind: z.literal('integration_connections'), items: z.array(integrationConnectionMetadataSchema).max(20), privateStorageAvailable: z.boolean(), ...agentChatToolResultFields }),
  z.strictObject({ kind: z.literal('integration_definitions'), contextId: z.string().max(100), items: z.array(z.strictObject({ contextId: z.string().max(100), serverId: z.string().max(300), name: z.string().max(500), configFingerprint: z.string().regex(/^[a-f0-9]{64}$/), transport: z.literal('streamable-http') })).max(20), ...agentChatToolResultFields }),
  z.strictObject({ kind: z.literal('integration_receipt'), requestId: uuid, httpStatus: z.number().int().min(100).max(599), outcome: z.enum(['succeeded', 'rejected']), connection: integrationConnectionMetadataSchema.nullable(), endpoint: integrationEventEndpointMetadataSchema.nullable(), errorCode: boundedText.nullable(), ...agentChatToolResultFields }),
  z.strictObject({ kind: z.literal('integration_operation'), operation: z.strictObject({ id: uuid, executionId: uuid, connectionId: uuid, connectionRevision: z.number().int().positive(), status: z.enum(['dispatching', 'completed', 'outcome_unknown']), resultAvailable: z.boolean(), createdAt: date, finishedAt: date.nullable() }), ...agentChatToolResultFields }),
  z.strictObject({ kind: z.literal('event_endpoints'), items: z.array(integrationEventEndpointMetadataSchema).max(20), ...agentChatToolResultFields }),
  z.strictObject({ kind: z.literal('event_receipts'), items: z.array(eventReceipt).max(50), ...agentChatToolResultFields }),
  z.strictObject({ kind: z.literal('webhook_overview'), configuration: z.enum(['disabled', 'configured', 'configuration_error']), configurationDigest: z.string().nullable(), restoreFenced: z.boolean(), loopHealthy: z.boolean(), loopCycleAt: date.nullable(), targets: z.array(webhookTarget).max(20), endpoints: z.array(webhookEndpoint).max(20), nextTargetKey: token.nullable(), ...agentChatToolResultFields }),
  z.strictObject({ kind: z.literal('webhook_deliveries'), items: z.array(webhookDelivery).max(20), ...agentChatToolResultFields }),
  z.strictObject({ kind: z.literal('webhook_delivery'), delivery: webhookDelivery.extend({ attempts: z.array(webhookAttempt).max(20), receipts: z.array(webhookReceipt).max(20) }), nextAttemptNo: z.number().int().positive().nullable(), nextReceiptId: uuid.nullable(), ...agentChatToolResultFields }),
  z.strictObject({ kind: z.literal('webhook_action'), action: z.enum(['CreateWebhookEndpoint', 'SetWebhookEndpointState', 'ReauthorizeWebhookEndpoint', 'SetWebhookEndpointSigningKey', 'ReconcileWebhookDelivery', 'ResumeWebhookDelivery']), result: integrationWebhookActionResultSchema, ...agentChatToolResultFields }),
  z.strictObject({ kind: z.literal('im_settings'), configuration: z.enum(['disabled', 'configured']), connectivity, bindings: z.array(imBinding).max(20), ...agentChatToolResultFields }),
  z.strictObject({ kind: z.literal('im_binding'), binding: imBinding.nullable(), revoked: z.boolean(), ...agentChatToolResultFields }),
]);
export type IntegrationsToolResult = z.infer<typeof IntegrationsToolResultSchema>;
