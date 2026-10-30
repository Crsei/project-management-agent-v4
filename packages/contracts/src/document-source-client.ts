import type { DocumentSource, DocumentSourceContent, DocumentSourceFiles, DocumentSourceFilesQuery, DocumentSourcePreviewInput, DocumentSourceUpdate } from './document-sources.ts';
import type { LocalProjectTransport } from './local-project-client.ts';

/** Uses the existing PM transport. Unknown writes are never retried automatically. */
export function createDocumentSourceClient(send: LocalProjectTransport) {
  const base = (workspaceId: string) => `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/document-sources`;
  return {
    list: (workspaceId: string, signal?: AbortSignal) => send<{ sources: DocumentSource[] }>('GET', base(workspaceId), undefined, undefined, signal),
    preview: (workspaceId: string, input: DocumentSourcePreviewInput, signal?: AbortSignal) => send<{ path: string; readable: true }>('POST', `${base(workspaceId)}/preview`, input, undefined, signal),
    save: (workspaceId: string, scopeKey: string, input: DocumentSourceUpdate, signal?: AbortSignal) => send<{ source: DocumentSource }>('PUT', `${base(workspaceId)}/${encodeURIComponent(scopeKey)}`, input, undefined, signal),
    files: (workspaceId: string, scopeKey: string, query: DocumentSourceFilesQuery = {}, signal?: AbortSignal) => {
      const parameters = new URLSearchParams();
      if (query.cursor !== undefined) parameters.set('cursor', query.cursor);
      if (query.limit !== undefined) parameters.set('limit', String(query.limit));
      return send<DocumentSourceFiles>('GET', `${base(workspaceId)}/${encodeURIComponent(scopeKey)}/files${parameters.size ? '?' + parameters.toString() : ''}`, undefined, undefined, signal);
    },
    content: (workspaceId: string, scopeKey: string, relative: string, signal?: AbortSignal) => send<DocumentSourceContent>('GET', `${base(workspaceId)}/${encodeURIComponent(scopeKey)}/content?${new URLSearchParams({ path: relative })}`, undefined, undefined, signal),
  };
}
