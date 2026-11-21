import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { z } from 'zod';
import { DomainError, type Actor, type Command, type CommandReceipt } from '../../../../../packages/domain/src/core.ts';
import { IntegrationsToolInputSchemas, type IntegrationsToolName } from '../../../../../packages/application/src/agent-tool-integrations.ts';
import { assertAgentToolNotAborted, assertAgentToolProject, type AgentChatToolContext, type AgentChatToolName } from '../../../../../packages/application/src/agent-chat-tools.ts';
import { getMembership } from '../../../../../packages/application/src/access.ts';
import { requestHash } from '../../../../../packages/application/src/kernel.ts';
import type { AutomationIntegrationsService } from '../../../../../packages/application/src/automation-integrations.ts';
import type { AutomationEventsService } from '../../../../../packages/application/src/automation-events.ts';
import type { AutomationIntegrationReceiptProof } from '../../../../../packages/application/src/automation-integrations-store.ts';
import { readWebhooks, readWebhookDeliveries, readWebhookDelivery } from '../../../../../packages/application/src/webhooks.ts';
import { listImBindings, revokeImBinding, setImNotification } from '../../../../../packages/application/src/im-gateway.ts';
import type { WebhookConfig } from '../../../../../packages/infrastructure/src/webhook-config.ts';
import type { ImConnectivity } from '../../../../../packages/contracts/src/im-gateway.ts';
import type { AutomationIntegrationReceipt } from '../../../../../packages/contracts/src/automation-integrations.ts';
import { IntegrationsToolResultSchema, integrationConnectionMetadataSchema, integrationEventEndpointMetadataSchema, integrationsToolRecoveryIdentitySchema, integrationWebhookActionResultSchema, type IntegrationsToolResult, type IntegrationsToolRecoveryIdentity } from '../../../../../packages/agent-contracts/src/pm-tool-integrations.ts';
import type { AgentChatToolReceipt } from '../../../../../packages/agent-contracts/src/pm-tool-shared.ts';
import type { AgentChatToolFamily, AgentToolRecoveryIdentity } from './agent-chat-tools.ts';

export type IntegrationsToolDependencies = {
  database: () => Pool;
  integrations: Pick<AutomationIntegrationsService, 'list' | 'definitions' | 'verify' | 'revoke' | 'receipt' | 'operation'>;
  events: Pick<AutomationEventsService, 'list' | 'events' | 'revoke'>;
  inspectIntegrationReceipt: (actorId: string, workspaceId: string, requestId: string) => Promise<AutomationIntegrationReceiptProof | null>;
  webhookConfig?: WebhookConfig;
  imConfiguration: () => 'configured' | 'disabled';
  imConnectivity: () => ImConnectivity;
  executeCommand: (actor: Actor, workspaceId: string, command: Command, checkAuthorization?: AgentChatToolContext['checkAuthorization']) => Promise<CommandReceipt>;
  readCommandReceipt: (actor: Actor, workspaceId: string, command: Command) => Promise<CommandReceipt | null>;
};
const integrationActions = { pm_verify_integration: 'connection-verify', pm_revoke_integration: 'connection-revoke', pm_revoke_event_endpoint: 'event-revoke' } as const;
const webhookActions = { pm_create_webhook_endpoint: 'CreateWebhookEndpoint', pm_set_webhook_endpoint_state: 'SetWebhookEndpointState', pm_reauthorize_webhook_endpoint: 'ReauthorizeWebhookEndpoint', pm_set_webhook_endpoint_signing_key: 'SetWebhookEndpointSigningKey', pm_reconcile_webhook_delivery: 'ReconcileWebhookDelivery', pm_resume_webhook_delivery: 'ResumeWebhookDelivery' } as const;
type IntegrationMutationName = keyof typeof integrationActions;
type WebhookMutationName = keyof typeof webhookActions;
function parse<Name extends IntegrationsToolName>(name: Name, input: unknown): z.infer<typeof IntegrationsToolInputSchemas[Name]> {
  const result = IntegrationsToolInputSchemas[name].safeParse(input);
  if (!result.success) throw new DomainError('agent_tool_invalid_input', 'Arguments must match the strict registered integration schema', 400);
  return result.data as z.infer<typeof IntegrationsToolInputSchemas[Name]>;
}
/** Stable original UUID, not a newly generated retry key. Bound to PM actor/workspace/tool operation. */
function originalRequestId(context: AgentChatToolContext, action: string): string {
  const hash = createHash('sha256').update(JSON.stringify(['pm-integrations-tool-v1', context.workspaceId, context.actor.id, context.operationId, action])).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
function page<T>(items: T[], after: string | null, limit: number, key: (value: T) => string): { items: T[]; nextCursor: string | null } {
  const position = after === null ? -1 : items.findIndex(item => key(item) === after);
  if (after !== null && position < 0) throw new DomainError('invalid_cursor', 'The cursor is not in the current authorized resource list', 400);
  const values = items.slice(position + 1, position + 1 + limit);
  return { items: values, nextCursor: position + 1 + values.length < items.length ? key(values.at(-1)!) : null };
}
const fields = { nextCursor: null, truncated: false, sources: [] } as const;
function integrationIdentity(name: IntegrationMutationName, input: unknown, context: AgentChatToolContext): IntegrationsToolRecoveryIdentity {
  const args = parse(name, input), action = integrationActions[name];
  const commandId = originalRequestId(context, action);
  return { kind: 'integration', commandId, action, targetId: args.id, projectId: args.projectId,
    hash: requestHash({ requestId: commandId, expectedRevision: args.expectedRevision, id: args.id, kind: action }) };
}
function webhookCommand(name: WebhookMutationName, input: unknown, context: AgentChatToolContext): Command {
  const commandType = webhookActions[name], commandId = originalRequestId(context, commandType);
  if (name === 'pm_create_webhook_endpoint') return { commandId, commandType, payload: parse(name, input) };
  if (name === 'pm_set_webhook_endpoint_state') {
    const args = parse(name, input); return { commandId, commandType, targetId: args.id, expectedVersions: { [args.id]: args.expectedVersion }, payload: { state: args.state } };
  }
  if (name === 'pm_set_webhook_endpoint_signing_key') {
    const args = parse(name, input); return { commandId, commandType, targetId: args.id, expectedVersions: { [args.id]: args.expectedVersion }, payload: { keyId: args.keyId } };
  }
  if (name === 'pm_resume_webhook_delivery') {
    const args = parse(name, input); return { commandId, commandType, targetId: args.id, expectedVersions: { [args.id]: args.expectedVersion }, payload: { receiptId: args.receiptId } };
  }
  const args = parse(name, input);
  return { commandId, commandType, targetId: args.id, expectedVersions: { [args.id]: args.expectedVersion }, payload: {} };
}
function applicationReceipt(context: AgentChatToolContext, identity: IntegrationsToolRecoveryIdentity, revision: string | null): AgentChatToolReceipt {
  return { kind: 'application', operationId: context.operationId, commandId: identity.commandId, action: identity.action, targetId: identity.targetId, revision, ...(context.linkage ? { linkage: context.linkage } : {}) };
}
function receiptProjection(receipt: AutomationIntegrationReceipt, projectId: string): IntegrationsToolResult {
  const connection = integrationConnectionMetadataSchema.strip().safeParse(receipt.result);
  const endpoint = integrationEventEndpointMetadataSchema.strip().safeParse(receipt.result);
  if (connection.success || endpoint.success) {
    const resource = connection.success ? connection.data : endpoint.success ? endpoint.data : null;
    if (!resource || resource.projectId !== projectId) throw new DomainError('not_found_or_forbidden', 'Original receipt is outside the authorized project', 404);
    return { kind: 'integration_receipt', requestId: receipt.requestId, httpStatus: receipt.httpStatus, outcome: 'succeeded', connection: connection.success ? connection.data : null, endpoint: endpoint.success ? endpoint.data : null, errorCode: null, ...fields, sources: [] };
  }
  const record = receipt.result && typeof receipt.result === 'object' ? receipt.result as { error?: { code?: unknown } } : null;
  if (!record?.error || typeof record.error.code !== 'string' || record.error.code.length > 500) throw new DomainError('integration_outcome_unknown', 'Original receipt has no supported authoritative result', 503);
  return { kind: 'integration_receipt', requestId: receipt.requestId, httpStatus: receipt.httpStatus, outcome: 'rejected', connection: null, endpoint: null, errorCode: record.error.code, ...fields, sources: [] };
}
function webhookResult(receipt: CommandReceipt, context: AgentChatToolContext, command: Command, recovering = false): IntegrationsToolResult {
  if (receipt.commandId !== command.commandId) throw new DomainError('command_outcome_unknown', 'Original command identity does not match', 503);
  if (receipt.status !== 'committed') {
    if (/unknown|pending|unavailable/i.test(receipt.error?.code ?? '')) throw new DomainError('command_outcome_unknown', 'The original native command remains unresolved', 503);
    throw new DomainError(recovering ? 'agent_tool_recovered_rejection' : receipt.error?.code ?? 'agent_tool_rejected', 'The original native webhook command was rejected', recovering ? 409 : receipt.httpStatus);
  }
  const result = integrationWebhookActionResultSchema.parse(receipt.result);
  const targetId = 'endpointId' in result ? result.endpointId : result.deliveryId;
  return { kind: 'webhook_action', action: command.commandType as typeof webhookActions[WebhookMutationName], result, ...fields, sources: [], receipt: {
    kind: 'command', operationId: context.operationId, commandId: command.commandId, action: command.commandType, targetId, revision: String(result.version), ...(context.linkage ? { linkage: context.linkage } : {}),
  } };
}
export function createIntegrationsToolFamily(options: IntegrationsToolDependencies): AgentChatToolFamily {
  async function authorize(context: AgentChatToolContext, workspace = false, administrator = false): Promise<void> {
    assertAgentToolNotAborted(context);
    await context.checkAuthorization?.(options.database());
    if (workspace && context.scope.kind !== 'workspace') throw new DomainError('permission_denied', 'An explicit workspace target is required', 403);
    const member = await getMembership(options.database(), context.actor, context.workspaceId);
    if (!member.capabilities.includes('domain.read') || administrator && (member.projectIds !== null || !member.capabilities.includes('access.manage') || !member.capabilities.includes('audit.read'))) throw new DomainError('permission_denied', 'Current native workspace capabilities and unrestricted membership are required', 403);
  }
  async function scopedConnection(context: AgentChatToolContext, projectId: string, id: string): Promise<void> {
    assertAgentToolProject(context.scope, projectId);
    const list = await options.integrations.list(context.actor, context.workspaceId, projectId);
    if (!list.connections.some(item => item.id === id && item.projectId === projectId)) throw new DomainError('not_found_or_forbidden', 'Connection is outside the current authorized project', 404);
  }
  async function scopedEndpoint(context: AgentChatToolContext, projectId: string, id: string): Promise<void> {
    assertAgentToolProject(context.scope, projectId);
    const list = await options.events.list(context.actor, context.workspaceId, projectId);
    if (!list.items.some(item => item.id === id && item.projectId === projectId)) throw new DomainError('not_found_or_forbidden', 'Endpoint is outside the current authorized project', 404);
  }
  async function execute(name: AgentChatToolName, input: unknown, context: AgentChatToolContext): Promise<IntegrationsToolResult> {
    if (!Object.hasOwn(IntegrationsToolInputSchemas, name)) throw new DomainError('agent_tool_not_available', 'Integration tool is not registered', 403);
    await authorize(context);
    if (Object.hasOwn(webhookActions, name)) {
      await authorize(context, true, true);
      const command = webhookCommand(name as WebhookMutationName, input, context);
      return webhookResult(await options.executeCommand(context.actor, context.workspaceId, command, context.checkAuthorization), context, command);
    }
    if (Object.hasOwn(integrationActions, name)) {
      const tool = name as IntegrationMutationName, args = parse(tool, input), identity = integrationIdentity(tool, input, context);
      if (tool === 'pm_revoke_event_endpoint') await scopedEndpoint(context, args.projectId, args.id); else await scopedConnection(context, args.projectId, args.id);
      const mutation = { requestId: identity.commandId, expectedRevision: args.expectedRevision };
      const result = tool === 'pm_verify_integration' ? await options.integrations.verify(context.actor, context.workspaceId, args.id, mutation, context.checkAuthorization)
        : tool === 'pm_revoke_integration' ? await options.integrations.revoke(context.actor, context.workspaceId, args.id, mutation, context.checkAuthorization)
          : await options.events.revoke(context.actor, context.workspaceId, args.id, mutation, context.checkAuthorization);
      await authorize(context);
      const projected = receiptProjection({ requestId: identity.commandId, result, httpStatus: 200 }, args.projectId);
      return { ...projected, receipt: applicationReceipt(context, identity, String(result.revision)) };
    }
    if (name === 'pm_list_integrations') {
      const args = parse(name, input); assertAgentToolProject(context.scope, args.projectId);
      const list = await options.integrations.list(context.actor, context.workspaceId, args.projectId);
      const values = page(list.connections.filter(item => item.projectId === args.projectId), args.after, args.limit, item => item.id);
      return { kind: 'integration_connections', privateStorageAvailable: list.privateStorageAvailable, ...fields, ...values, items: values.items.map(item => integrationConnectionMetadataSchema.strip().parse(item)), sources: [] };
    }
    if (name === 'pm_list_integration_definitions') {
      const args = parse(name, input); assertAgentToolProject(context.scope, args.projectId);
      const list = await options.integrations.definitions(context.actor, context.workspaceId, args.projectId);
      const values = page(list.definitions, args.after, args.limit, item => item.serverId);
      return { kind: 'integration_definitions', contextId: list.contextId, ...fields, ...values, sources: [] };
    }
    if (name === 'pm_read_integration_receipt') {
      const args = parse(name, input); assertAgentToolProject(context.scope, args.projectId);
      return receiptProjection(await options.integrations.receipt(context.actor, context.workspaceId, args.requestId), args.projectId);
    }
    if (name === 'pm_read_integration_operation') {
      const args = parse(name, input); assertAgentToolProject(context.scope, args.projectId);
      const operation = await options.integrations.operation(context.actor, context.workspaceId, args.id);
      await scopedConnection(context, args.projectId, operation.connectionId);
      const { result, ...metadata } = operation;
      return { kind: 'integration_operation', operation: { ...metadata, resultAvailable: result !== null && result !== undefined }, ...fields, sources: [] };
    }
    if (name === 'pm_list_event_endpoints') {
      const args = parse(name, input); assertAgentToolProject(context.scope, args.projectId);
      const list = await options.events.list(context.actor, context.workspaceId, args.projectId);
      const values = page(list.items.filter(item => item.projectId === args.projectId), args.after, args.limit, item => item.id);
      return { kind: 'event_endpoints', ...fields, ...values, sources: [] };
    }
    if (name === 'pm_list_endpoint_events') {
      const args = parse(name, input); await scopedEndpoint(context, args.projectId, args.id);
      const values = await options.events.events(context.actor, context.workspaceId, args.id, args.cursor ?? undefined);
      return { kind: 'event_receipts', ...fields, ...values, sources: [] };
    }
    if (name === 'pm_read_webhooks') {
      const args = parse(name, input); await authorize(context, true, true);
      const overview = await readWebhooks(options.database(), context.actor, context.workspaceId, options.webhookConfig);
      const endpoints = page(overview.endpoints, args.after, args.limit, item => item.endpointId), targets = page(overview.targets, args.afterTargetKey, args.limit, item => item.targetKey);
      return { kind: 'webhook_overview', ...overview, endpoints: endpoints.items, targets: targets.items, ...fields, sources: [], nextCursor: endpoints.nextCursor, nextTargetKey: targets.nextCursor };
    }
    if (name === 'pm_list_webhook_deliveries') {
      const args = parse(name, input); await authorize(context, true, true);
      const values = await readWebhookDeliveries(options.database(), context.actor, context.workspaceId, args.endpointId, { cursor: args.cursor ?? undefined, limit: args.limit });
      return { kind: 'webhook_deliveries', ...fields, ...values, sources: [] };
    }
    if (name === 'pm_read_webhook_delivery') {
      const args = parse(name, input); await authorize(context, true, true);
      const delivery = await readWebhookDelivery(options.database(), context.actor, context.workspaceId, args.id);
      const attempts = page(delivery.attempts, args.afterAttemptNo === null ? null : String(args.afterAttemptNo), args.limit, item => String(item.attemptNo));
      const receipts = page(delivery.receipts, args.afterReceiptId, args.limit, item => item.receiptId);
      return { kind: 'webhook_delivery', delivery: { ...delivery, attempts: attempts.items, receipts: receipts.items }, nextAttemptNo: attempts.nextCursor === null ? null : Number(attempts.nextCursor), nextReceiptId: receipts.nextCursor, ...fields, sources: [] };
    }
    if (name === 'pm_read_im_settings') {
      const args = parse(name, input); await authorize(context, true);
      const values = page(await listImBindings(options.database(), context.actor, context.workspaceId), args.after, args.limit, item => item.id);
      const current = options.imConnectivity();
      return { kind: 'im_settings', configuration: options.imConfiguration(), connectivity: { satori: current.satori, bots: current.bots.map(({ url: _url, ...bot }) => bot) }, bindings: values.items, ...fields, nextCursor: values.nextCursor, sources: [] };
    }
    if (name === 'pm_set_im_notifications') {
      const args = parse(name, input); await authorize(context, true);
      const binding = await setImNotification(options.database(), context.actor, context.workspaceId, args.bindingId, args.notifyEnabled, context.checkAuthorization);
      await authorize(context, true);
      return { kind: 'im_binding', binding, revoked: false, ...fields, sources: [] };
    }
    if (name === 'pm_revoke_im_binding') {
      const args = parse(name, input); await authorize(context, true);
      await revokeImBinding(options.database(), context.actor, context.workspaceId, args.bindingId, context.checkAuthorization);
      await authorize(context, true);
      return { kind: 'im_binding', binding: null, revoked: true, ...fields, sources: [] };
    }
    throw new DomainError('agent_tool_not_available', 'Integration tool is not registered', 403);
  }
  return {
    names: Object.keys(IntegrationsToolInputSchemas) as AgentChatToolName[],
    execute: async (name, input, context) => IntegrationsToolResultSchema.parse(await execute(name, input, context)),
    recoveryIdentity(name, input, context): AgentToolRecoveryIdentity | null {
      if (Object.hasOwn(integrationActions, name)) return integrationIdentity(name as IntegrationMutationName, input, context);
      if (Object.hasOwn(webhookActions, name)) {
        const command = webhookCommand(name as WebhookMutationName, input, context);
        return { kind: 'command', commandId: command.commandId, action: command.commandType, hash: requestHash(command as unknown as Record<string, unknown>) };
      }
      return null;
    },
    async recover(name, input, context) {
      await authorize(context);
      if (Object.hasOwn(webhookActions, name)) {
        await authorize(context, true, true);
        const command = webhookCommand(name as WebhookMutationName, input, context);
        const receipt = await options.readCommandReceipt(context.actor, context.workspaceId, command);
        return receipt ? webhookResult(receipt, context, command, true) : null;
      }
      if (!Object.hasOwn(integrationActions, name)) return null;
      const tool = name as IntegrationMutationName, identity = integrationIdentity(tool, input, context);
      if (tool === 'pm_revoke_event_endpoint') await scopedEndpoint(context, identity.projectId, identity.targetId); else await scopedConnection(context, identity.projectId, identity.targetId);
      const proof = await options.inspectIntegrationReceipt(context.actor.id, context.workspaceId, identity.commandId);
      if (!proof || proof.hash !== identity.hash || !proof.projectIds.includes(identity.projectId) || proof.outcome === 'unknown') return null;
      const receipt = await options.integrations.receipt(context.actor, context.workspaceId, identity.commandId);
      const result = receiptProjection(receipt, identity.projectId);
      await authorize(context);
      if (proof.outcome === 'rejected') throw new DomainError('agent_tool_recovered_rejection', 'The original integration mutation has a durable native rejection', 409);
      const revision = result.kind === 'integration_receipt' ? result.connection?.revision ?? result.endpoint?.revision : undefined;
      return { ...result, receipt: applicationReceipt(context, identity, revision === undefined ? null : String(revision)) };
    },
    async authorizeResult(name, input, result, context) {
      if (!Object.hasOwn(IntegrationsToolInputSchemas, name)) throw new DomainError('agent_tool_not_available', 'Integration result is not registered', 403);
      const args = parse(name as IntegrationsToolName, input);
      const saved = IntegrationsToolResultSchema.parse(result);
      await authorize(context);
      if (name.startsWith('pm_read_webhook') || name === 'pm_list_webhook_deliveries' || Object.hasOwn(webhookActions, name)) {
        await authorize(context, true, true);
        if (Object.hasOwn(webhookActions, name)) {
          const command = webhookCommand(name as WebhookMutationName, input, context);
          if (!await options.readCommandReceipt(context.actor, context.workspaceId, command)) throw new DomainError('not_found_or_forbidden', 'Original webhook receipt is not currently accessible', 404);
        } else if (saved.kind === 'webhook_delivery') {
          await readWebhookDelivery(options.database(), context.actor, context.workspaceId, saved.delivery.deliveryId);
        } else if (saved.kind === 'webhook_deliveries') {
          const pageArgs = parse('pm_list_webhook_deliveries', input);
          await readWebhookDeliveries(options.database(), context.actor, context.workspaceId, pageArgs.endpointId, { limit: 1 });
          for (const item of saved.items) await readWebhookDelivery(options.database(), context.actor, context.workspaceId, item.deliveryId);
        } else if (saved.kind === 'webhook_overview') {
          await readWebhooks(options.database(), context.actor, context.workspaceId, options.webhookConfig);
        } else throw new DomainError('not_found_or_forbidden', 'Stored webhook result has an incompatible identity', 404);
        return;
      }
      if (name === 'pm_read_im_settings' || name === 'pm_set_im_notifications' || name === 'pm_revoke_im_binding') {
        await authorize(context, true);
        const bindings = await listImBindings(options.database(), context.actor, context.workspaceId);
        const visible = new Set(bindings.map(item => item.id));
        if (saved.kind === 'im_settings') {
          if (saved.bindings.some(item => !visible.has(item.id))) throw new DomainError('not_found_or_forbidden', 'An original private IM binding is no longer accessible', 404);
        } else if (saved.kind === 'im_binding') {
          if (saved.binding && !visible.has(saved.binding.id)) throw new DomainError('not_found_or_forbidden', 'Original private IM binding is no longer accessible', 404);
        } else throw new DomainError('not_found_or_forbidden', 'Stored IM result has an incompatible identity', 404);
        return;
      }
      if (!('projectId' in args)) throw new DomainError('not_found_or_forbidden', 'Stored integration result has no authorized project identity', 404);
      const projectId = args.projectId;
      assertAgentToolProject(context.scope, projectId);
      if (saved.kind === 'integration_connections') {
        const current = await options.integrations.list(context.actor, context.workspaceId, projectId);
        if (saved.items.some(item => item.projectId !== projectId || !current.connections.some(value => value.id === item.id))) throw new DomainError('not_found_or_forbidden', 'An original private connection is no longer accessible', 404);
      } else if (saved.kind === 'integration_definitions') {
        const current = await options.integrations.definitions(context.actor, context.workspaceId, projectId);
        if (current.contextId !== saved.contextId || saved.items.some(item => !current.definitions.some(value => value.contextId === item.contextId && value.serverId === item.serverId))) throw new DomainError('not_found_or_forbidden', 'An original managed definition is no longer accessible', 404);
      } else if (saved.kind === 'integration_receipt') {
        const requestId = name === 'pm_read_integration_receipt' ? parse('pm_read_integration_receipt', input).requestId : integrationIdentity(name as IntegrationMutationName, input, context).commandId;
        if (requestId !== saved.requestId) throw new DomainError('not_found_or_forbidden', 'Original integration request identity does not match', 404);
        receiptProjection(await options.integrations.receipt(context.actor, context.workspaceId, requestId), projectId);
      } else if (saved.kind === 'integration_operation') {
        const current = await options.integrations.operation(context.actor, context.workspaceId, parse('pm_read_integration_operation', input).id);
        if (current.id !== saved.operation.id || current.connectionId !== saved.operation.connectionId || current.executionId !== saved.operation.executionId) throw new DomainError('not_found_or_forbidden', 'Original provider operation identity does not match', 404);
        await scopedConnection(context, projectId, current.connectionId);
      } else if (saved.kind === 'event_endpoints') {
        const current = await options.events.list(context.actor, context.workspaceId, projectId);
        if (saved.items.some(item => item.projectId !== projectId || !current.items.some(value => value.id === item.id))) throw new DomainError('not_found_or_forbidden', 'An original private endpoint is no longer accessible', 404);
      } else if (saved.kind === 'event_receipts') {
        const eventArgs = parse('pm_list_endpoint_events', input);
        await scopedEndpoint(context, projectId, eventArgs.id);
        await options.events.events(context.actor, context.workspaceId, eventArgs.id);
      } else throw new DomainError('not_found_or_forbidden', 'Stored integration result has an incompatible family identity', 404);
    },
    async inspectOutcome(value, actorId, workspaceId) {
      const parsed = integrationsToolRecoveryIdentitySchema.safeParse(value);
      if (!parsed.success) return { status: 'unknown', evidence: 'unresolved' };
      const proof = await options.inspectIntegrationReceipt(actorId, workspaceId, parsed.data.commandId);
      if (!proof || proof.hash !== parsed.data.hash || !proof.projectIds.includes(parsed.data.projectId) || proof.outcome === 'unknown') return { status: 'unknown', evidence: 'unresolved' };
      return { status: proof.outcome === 'committed' ? 'succeeded' : 'failed', evidence: 'application_receipt' };
    },
  };
}
