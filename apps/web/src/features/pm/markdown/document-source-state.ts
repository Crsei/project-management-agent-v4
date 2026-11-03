import type { DocumentSource, DocumentSourceAssociationScope } from '../../../../../../packages/contracts/src/document-sources';

export type DocumentSourceCatalog = {
  key: string;
  request: number;
  status: 'pending' | 'ready' | 'error';
  sources: DocumentSource[];
  scopes: DocumentSourceAssociationScope[];
  error: string;
};
export type DocumentSourceCatalogEvent =
  | { type: 'read'; key: string; request: number }
  | { type: 'loaded'; key: string; request: number; sources: DocumentSource[]; scopes: DocumentSourceAssociationScope[] }
  | { type: 'failed'; key: string; request: number; error: string };

export function pendingDocumentSources(key: string, request = 0): DocumentSourceCatalog {
  return { key, request, status: 'pending', sources: [], scopes: [], error: '' };
}

/** Pending reads discard the old snapshot; a late response cannot restore it. */
export function documentSourceCatalogReducer(state: DocumentSourceCatalog, event: DocumentSourceCatalogEvent): DocumentSourceCatalog {
  if (event.type === 'read') return pendingDocumentSources(event.key, event.request);
  if (state.key !== event.key || state.request !== event.request) return state;
  return event.type === 'loaded'
    ? { ...state, status: 'ready', sources: event.sources, scopes: event.scopes, error: '' }
    : { ...state, status: 'error', sources: [], scopes: [], error: event.error };
}

/** Gate during render, before the effect for a new route scope has run. */
export function scopedDocumentSources(catalog: DocumentSourceCatalog, key: string): DocumentSourceCatalog {
  return catalog.key === key ? catalog : pendingDocumentSources(key);
}

/** Workspace collections include every authorized association; project routes are exact. */
export function documentSourcesForProject(catalog: DocumentSourceCatalog, projectId?: string): DocumentSource[] {
  if (catalog.status !== 'ready') return [];
  return projectId ? catalog.sources.filter(source => source.projectId === projectId) : catalog.sources;
}
