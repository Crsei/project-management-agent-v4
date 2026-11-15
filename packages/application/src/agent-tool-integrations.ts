import { z } from 'zod';
import type { Capability } from '../../domain/src/core.ts';
import { createWebhookEndpointSchema } from '../../contracts/src/webhook-schemas.ts';

const uuid = z.uuid().toLowerCase();
const projectId = z.string().regex(/^PRJ-\d+$/);
const limit = z.number().int().min(1).max(20);
const page = { after: uuid.nullable(), limit };
const mutation = { projectId, id: uuid, expectedRevision: z.number().int().positive() };
const webhookMutation = { id: uuid, expectedVersion: z.number().int().positive() };
export const IntegrationsToolInputSchemas = {
  pm_list_integrations: z.strictObject({ projectId, ...page }),
  pm_list_integration_definitions: z.strictObject({ projectId, after: z.string().max(300).nullable(), limit }),
  pm_verify_integration: z.strictObject(mutation),
  pm_revoke_integration: z.strictObject(mutation),
  pm_read_integration_receipt: z.strictObject({ projectId, requestId: uuid }),
  pm_read_integration_operation: z.strictObject({ projectId, id: uuid }),
  pm_list_event_endpoints: z.strictObject({ projectId, ...page }),
  pm_revoke_event_endpoint: z.strictObject(mutation),
  pm_list_endpoint_events: z.strictObject({ projectId, id: uuid, cursor: uuid.nullable() }),
  pm_read_webhooks: z.strictObject({ after: uuid.nullable(), afterTargetKey: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/).nullable(), limit }),
  pm_list_webhook_deliveries: z.strictObject({ endpointId: uuid, cursor: z.string().min(1).max(2048).nullable(), limit }),
  pm_read_webhook_delivery: z.strictObject({ id: uuid, afterAttemptNo: z.number().int().positive().nullable(), afterReceiptId: uuid.nullable(), limit }),
  pm_create_webhook_endpoint: createWebhookEndpointSchema,
  pm_set_webhook_endpoint_state: z.strictObject({ ...webhookMutation, state: z.enum(['enabled', 'paused', 'retired']) }),
  pm_reauthorize_webhook_endpoint: z.strictObject(webhookMutation),
  pm_set_webhook_endpoint_signing_key: z.strictObject({ ...webhookMutation, keyId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/) }),
  pm_reconcile_webhook_delivery: z.strictObject(webhookMutation),
  pm_resume_webhook_delivery: z.strictObject({ ...webhookMutation, receiptId: uuid }),
  pm_read_im_settings: z.strictObject(page),
  pm_set_im_notifications: z.strictObject({ bindingId: uuid, notifyEnabled: z.boolean() }),
  pm_revoke_im_binding: z.strictObject({ bindingId: uuid }),
} as const;
export type IntegrationsToolName = keyof typeof IntegrationsToolInputSchemas;
type Metadata = { description: string; write: boolean; capabilities: Capability[]; scope: 'project' | 'workspace' | 'workspace-admin' };
const projectRead = (description: string): Metadata => ({ description, write: false, capabilities: ['domain.read'], scope: 'project' });
const projectWrite = (description: string): Metadata => ({ description, write: true, capabilities: ['domain.read', 'planning.edit'], scope: 'project' });
const webhook = (description: string, write = false): Metadata => ({ description, write, capabilities: ['access.manage', 'domain.read', 'audit.read'], scope: 'workspace-admin' });
const im = (description: string, write = false): Metadata => ({ description, write, capabilities: ['domain.read'], scope: 'workspace' });
export const IntegrationsToolMetadata = {
  pm_list_integrations: projectRead('List bounded actor-private integration connection metadata in one authorized project. Configured, explicitly verified and executed are separate facts; no credentials or private configuration are returned.'),
  pm_list_integration_definitions: projectRead('List bounded managed MCP definition metadata for this actor/project, not credentials or configuration. Does not install, authenticate or verify a connection.'),
  pm_verify_integration: projectWrite('Explicitly probe the existing authorized connection at its exact revision. May contact its approved provider; returns separate MCP/native verification, never claims a business operation was sent. Original request receipt is recoverable without another probe.'),
  pm_revoke_integration: projectWrite('Revoke the actor-private connection at its exact revision and clear stored native credentials. No arbitrary provider call or reauthentication.'),
  pm_read_integration_receipt: projectRead('Read a typed original integration/event mutation receipt under current project authorization. Never retries or reconstructs a request.'),
  pm_read_integration_operation: projectRead('Read the exact original connection operation status and original execution/connection identities. External provider payloads are not model context; unknown never causes redispatch.'),
  pm_list_event_endpoints: projectRead('List bounded actor-private inbound event endpoint metadata, verification protocol and current revision. Never returns signing material.'),
  pm_revoke_event_endpoint: projectWrite('Revoke the exact actor-private inbound endpoint revision and remove its signing material. Future ingress uses native signature/current authorization checks.'),
  pm_list_endpoint_events: projectRead('Read one native bounded page of original authenticated event receipts, preserving accepted/filtered/rejected and execution identity. Does not receive, synthesize or replay events.'),
  pm_read_webhooks: webhook('Read bounded approved outbound target/endpoint metadata, real worker readiness and restore fences. No key files or target configuration editing. Workspace-wide native permissions are required.'),
  pm_list_webhook_deliveries: webhook('Read one bounded native page of original outbound delivery metadata. Accepted is authenticated receiver acceptance, not task completion.'),
  pm_read_webhook_delivery: webhook('Read the original delivery plus bounded attempt/receiver-receipt pages. Continue nextAttemptNo and nextReceiptId independently. No dispatch or retry.'),
  pm_create_webhook_endpoint: webhook('Create a paused outbound endpoint using an operator-approved target and scope. Does not create secrets, send events or enable dispatch.', true),
  pm_set_webhook_endpoint_state: webhook('Set exact-version outbound endpoint state. Enablement enforces approved target, current scope, receiver-prepared key, worker readiness and restore fence; retirement suppresses eligible backlog.', true),
  pm_reauthorize_webhook_endpoint: webhook('Reauthorize this exact endpoint version as the current actor, retaining native fixed target/scope. Remains paused unless already retired.', true),
  pm_set_webhook_endpoint_signing_key: webhook('Select an existing operator-approved receiver-prepared key ID at the exact endpoint version. No signing secret input or output.', true),
  pm_reconcile_webhook_delivery: webhook('Request native reconciliation for the exact unknown delivery version. It preserves original delivery/hash and does not mean receiver rejection or resend.', true),
  pm_resume_webhook_delivery: webhook('Explicitly resume the exact unknown delivery only with an authenticated native not_accepted receipt closing every prior attempt. Keeps original delivery identity.', true),
  pm_read_im_settings: im('Read actor-private IM bindings/preferences and live Satori/bot connectivity. Configuration/connection is not platform delivery acceptance. Link codes and gateway secrets are operator-only.'),
  pm_set_im_notifications: im('Set notification opt-in on the current actor’s binding. Enabling starts at the current notification head, never replays historical notifications. No durable mutation receipt exists; an ambiguous write remains unknown.', true),
  pm_revoke_im_binding: im('Revoke the current actor’s binding and suppress pending/sending jobs. No durable mutation receipt exists; an ambiguous write remains unknown, not automatically replayed.', true),
} satisfies Record<IntegrationsToolName, Metadata>;
