import type { DocumentSourceConfigurationInput, DocumentSourceConfigurationResponse, DocumentSourceContent, DocumentSourceFiles, DocumentSourceFilesQuery, DocumentSourceMutation, DocumentSourceMutationReceipt, DocumentSources } from './document-sources.ts';
import type { LocalProjectDirectoryListing } from './local-projects.ts';
import type { LocalProjectTransport } from './local-project-client.ts';

/** Uses the existing PM transport. Unknown writes are never retried automatically. */
export function createDocumentSourceClient(send: LocalProjectTransport) {
  const base = (workspaceId: string) => `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/document-sources`;
  return {
    list: (workspaceId: string, signal?: AbortSignal) => send<DocumentSources>('GET', base(workspaceId), undefined, undefined, signal),
    configure: (workspaceId: string, input: DocumentSourceConfigurationInput, signal?: AbortSignal) => send<DocumentSourceConfigurationResponse>('PUT', `${base(workspaceId)}/configuration`, input, undefined, signal),
    directories: (workspaceId: string, projectId: string | null, path?: string, signal?: AbortSignal) => {
      const query = new URLSearchParams();
      if (projectId !== null) query.set('projectId', projectId);
      if (path !== undefined) query.set('path', path);
      return send<LocalProjectDirectoryListing>('GET', `${base(workspaceId)}/directories${query.size ? '?' + query.toString() : ''}`, undefined, undefined, signal);
    },
    files: (workspaceId: string, sourceId: string, query: DocumentSourceFilesQuery = {}, signal?: AbortSignal) => {
      const parameters = new URLSearchParams();
      if (query.cursor !== undefined) parameters.set('cursor', query.cursor);
      if (query.limit !== undefined) parameters.set('limit', String(query.limit));
      return send<DocumentSourceFiles>('GET', `${base(workspaceId)}/${encodeURIComponent(sourceId)}/files${parameters.size ? '?' + parameters.toString() : ''}`, undefined, undefined, signal);
    },
    content: (workspaceId: string, sourceId: string, relative: string, signal?: AbortSignal) => send<DocumentSourceContent>('GET', `${base(workspaceId)}/${encodeURIComponent(sourceId)}/content?${new URLSearchParams({ path: relative })}`, undefined, undefined, signal),
    mutate: (workspaceId: string, sourceId: string, input: DocumentSourceMutation, signal?: AbortSignal) => send<DocumentSourceMutationReceipt>('POST', `${base(workspaceId)}/${encodeURIComponent(sourceId)}/operations`, input, undefined, signal),
    mutation: (workspaceId: string, sourceId: string, operationId: string, signal?: AbortSignal) => send<DocumentSourceMutationReceipt>('GET', `${base(workspaceId)}/${encodeURIComponent(sourceId)}/operations/${encodeURIComponent(operationId)}`, undefined, undefined, signal),
  };
}
