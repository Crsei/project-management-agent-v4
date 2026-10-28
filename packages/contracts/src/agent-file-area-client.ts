import type { AgentCatalog, AgentFileArea, AgentFileAreaUpdate, AgentScope, AgentStorageSettings, AgentStorageSettingsUpdate, ResolvedAgentContext } from './agent-file-areas.ts';
import type { LocalProjectTransport } from './local-project-client.ts';

/** Uses the original authenticated PM transport. Writes never retry on an unknown response. */
export function createAgentContextClient(send: LocalProjectTransport) {
  return {
    catalog: (signal?: AbortSignal) => send<AgentCatalog>('GET', '/api/v1/agent-contexts', undefined, undefined, signal),
    storageSettings: (workspaceId: string, signal?: AbortSignal) => send<AgentStorageSettings>('GET', `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/agent-storage-settings`, undefined, undefined, signal),
    saveStorageSettings: (workspaceId: string, input: AgentStorageSettingsUpdate, signal?: AbortSignal) => send<AgentStorageSettings>('PUT', `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/agent-storage-settings`, input, undefined, signal),
    saveWorkspace: (workspaceId: string, input: AgentFileAreaUpdate, signal?: AbortSignal) => send<{ fileArea: AgentFileArea }>('PUT', `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/agent-file-area`, input, undefined, signal),
    saveProject: (workspaceId: string, projectId: string, input: AgentFileAreaUpdate, signal?: AbortSignal) => send<{ fileArea: AgentFileArea }>('PUT', `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}/agent-file-area`, input, undefined, signal),
    resolve: (scope: AgentScope, signal?: AbortSignal) => send<ResolvedAgentContext>('POST', '/api/v1/agent-contexts/resolve', scope, undefined, signal),
  };
}
