import { AutomationApiError } from './automation-client.ts';
import type { AutomationEventEndpoint, AutomationEventReceipt, AutomationIntegrationConnection, AutomationIntegrationList, AutomationIntegrationReceipt, AutomationIntegrationOperation, AutomationMcpDefinitionList, automationEventSaveSchema, automationIntegrationSaveSchema } from './automation-integrations.ts';
import type { z } from 'zod';

/** No automatic retries: query receipt with the original requestId after an uncertain mutation. */
export function createAutomationIntegrationsClient(options: { baseUrl?: string; fetch?: typeof fetch } = {}) {
  const send = async <T>(workspaceId: string, method: string, path: string, body?: unknown): Promise<T> => {
    const response = await (options.fetch ?? fetch)(`${options.baseUrl ?? ''}/api/v1/workspaces/${encodeURIComponent(workspaceId)}/automations${path}`, { method, credentials: 'same-origin', cache: 'no-store', ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
    let value: unknown;
    try { value = await response.json(); } catch { throw new AutomationApiError(response.status, 'invalid_response', 'Non-JSON response; reconcile the original receipt before another write'); }
    if (!response.ok) {
      const error = value && typeof value === 'object' && 'error' in value ? value.error : null;
      throw new AutomationApiError(response.status, error && typeof error === 'object' && 'code' in error ? String(error.code) : 'request_failed', error && typeof error === 'object' && 'message' in error ? String(error.message) : `Integration request failed (${response.status})`);
    }
    return value as T;
  };
  return {
    list: (workspaceId: string, projectId?: string) => send<AutomationIntegrationList>(workspaceId, 'GET', '/integrations' + (projectId ? '?projectId=' + encodeURIComponent(projectId) : '')),
    definitions: (workspaceId: string, projectId: string) => send<AutomationMcpDefinitionList>(workspaceId, 'GET', '/integrations/definitions?projectId=' + encodeURIComponent(projectId)),
    save: (workspaceId: string, id: string, input: z.infer<typeof automationIntegrationSaveSchema>) => send<AutomationIntegrationConnection>(workspaceId, 'PUT', '/integrations/' + encodeURIComponent(id), input),
    verify: (workspaceId: string, id: string, requestId: string, expectedRevision: number) => send<AutomationIntegrationConnection>(workspaceId, 'POST', `/integrations/${encodeURIComponent(id)}/verify`, { requestId, expectedRevision }),
    revoke: (workspaceId: string, id: string, requestId: string, expectedRevision: number) => send<AutomationIntegrationConnection>(workspaceId, 'POST', `/integrations/${encodeURIComponent(id)}/revoke`, { requestId, expectedRevision }),
    endpoints: (workspaceId: string, projectId?: string) => send<{ items: AutomationEventEndpoint[] }>(workspaceId, 'GET', '/event-endpoints' + (projectId ? '?projectId=' + encodeURIComponent(projectId) : '')),
    saveEndpoint: (workspaceId: string, id: string, input: z.infer<typeof automationEventSaveSchema>) => send<AutomationEventEndpoint>(workspaceId, 'PUT', '/event-endpoints/' + encodeURIComponent(id), input),
    revokeEndpoint: (workspaceId: string, id: string, requestId: string, expectedRevision: number) => send<AutomationEventEndpoint>(workspaceId, 'POST', `/event-endpoints/${encodeURIComponent(id)}/revoke`, { requestId, expectedRevision }),
    events: (workspaceId: string, id: string, cursor?: string) => send<{ items: AutomationEventReceipt[]; nextCursor: string | null }>(workspaceId, 'GET', `/event-endpoints/${encodeURIComponent(id)}/events` + (cursor ? '?cursor=' + encodeURIComponent(cursor) : '')),
    receipt: (workspaceId: string, requestId: string) => send<AutomationIntegrationReceipt>(workspaceId, 'GET', '/integration-receipts/' + encodeURIComponent(requestId)),
    operation: (workspaceId: string, id: string) => send<AutomationIntegrationOperation>(workspaceId, 'GET', '/integrations/operations/' + encodeURIComponent(id)),
  };
}
