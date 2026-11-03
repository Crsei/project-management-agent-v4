import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { LoaderCircle, Settings2 } from 'lucide-react';
import type { DocumentSource, DocumentSourceFiles } from '../../../../../../packages/contracts/src/document-sources';
import { useCoreSession } from './session';
import { DocumentSourceSettings } from './DocumentSourceSettings';
import { documentSourceAccessLost, documentSourceError, DocumentSourceRequestError, readAllDocumentSourceFiles, readDocumentSources } from './document-sources-api';
import { documentSourceCatalogReducer, documentSourcesForProject, pendingDocumentSources, scopedDocumentSources, type DocumentSourceCatalog } from './document-source-state';
import type { DocumentTarget } from './document-workbench-state';
import { ExternalOperationNotices, useExternalDocumentLeaveProtection, useExternalDocumentSession } from './ExternalDocumentEditor';
import type { ExternalManagementIntent } from './external-document-state';
import './document-sources.css';
import './preview.css';

type Selection = Extract<DocumentTarget, { kind: 'external' }>;
export type DocumentSourceCatalogState = DocumentSourceCatalog & {
  workspaceId: string;
  projectId: string | null;
  collectionSources: DocumentSource[];
  reload: () => void;
};

/** Component-local catalog: no source paths or plaintext enter browser storage
 * or the native PM query/draft cache. The route, never the first result, is scope. */
export function useDocumentSourceCatalog(enabled: boolean, projectId: string | undefined, en: boolean): DocumentSourceCatalogState {
  const session = useCoreSession();
  const { store } = useExternalDocumentSession();
  const workspaceId = session.queryKey[3];
  const key = `${session.scope}:${projectId || 'workspace'}`;
  const [catalog, dispatch] = useReducer(documentSourceCatalogReducer, pendingDocumentSources(key));
  const [generation, setGeneration] = useState(0);
  const sequence = useRef(0);
  const request = useRef<AbortController | null>(null);
  const reload = useCallback(() => {
    request.current?.abort();
    dispatch({ type: 'read', key, request: ++sequence.current });
    setGeneration(value => value + 1);
  }, [key]);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    request.current = controller;
    const attempt = ++sequence.current;
    dispatch({ type: 'read', key, request: attempt });
    void readDocumentSources(workspaceId, controller.signal).then(result => {
      if (!controller.signal.aborted) { store.authorize(result.sources); dispatch({ type: 'loaded', key, request: attempt, sources: result.sources, scopes: result.scopes }); }
    }).catch(cause => {
      if (!controller.signal.aborted) {
        if (cause instanceof DocumentSourceRequestError && [401, 403, 404].includes(cause.status)) store.clearSource();
        dispatch({ type: 'failed', key, request: attempt, error: documentSourceError(cause, en) });
      }
    });
    return () => controller.abort();
  }, [enabled, workspaceId, key, generation, en, store]);
  useEffect(() => {
    if (!enabled) return;
    const onFocus = () => { if (document.visibilityState === 'visible') reload(); };
    window.addEventListener('focus', onFocus);
    window.addEventListener('external-documents-changed', onFocus);
    return () => { window.removeEventListener('focus', onFocus); window.removeEventListener('external-documents-changed', onFocus); };
  }, [enabled, reload]);
  const current = scopedDocumentSources(catalog, key);
  const collectionSources = useMemo(() => documentSourcesForProject(current, projectId), [current, projectId]);
  return { ...current, workspaceId, projectId: projectId || null, collectionSources, reload };
}

export type DocumentSourceRead = { status: 'loading' | 'ready' | 'error'; page?: DocumentSourceFiles; error?: string };
/** Each traversal owns its cursor history and shares at most three active source scans. */
export function useDocumentSourceFiles(workspaceId: string, sources: readonly DocumentSource[], enabled: boolean, readKey: string, en: boolean) {
  const { store } = useExternalDocumentSession();
  const [reads, setReads] = useState<{ key: string; sources: Record<string, DocumentSourceRead> }>({ key: readKey, sources: {} });
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const available = sources.filter(source => source.status === 'available');
    setReads({ key: readKey, sources: Object.fromEntries(available.map(source => [source.sourceId, { status: 'loading' as const }])) });
    let nextIndex = 0;
    const update = (sourceId: string, next: DocumentSourceRead) => {
      if (!controller.signal.aborted) setReads(previous => previous.key === readKey ? { key: readKey, sources: { ...previous.sources, [sourceId]: next } } : previous);
    };
    const worker = async () => {
      while (!controller.signal.aborted && nextIndex < available.length) {
        const source = available[nextIndex++];
        try {
          const page = await readAllDocumentSourceFiles(workspaceId, source, controller.signal, partial => update(source.sourceId, { status: 'loading', page: partial }));
          update(source.sourceId, { status: 'ready', page });
        } catch (cause) {
          // A failed traversal never retains a formerly authorized or partial snapshot.
          if (!controller.signal.aborted && documentSourceAccessLost(cause)) store.clearSource(source.sourceId);
          update(source.sourceId, { status: 'error', error: documentSourceError(cause, en) });
        }
      }
    };
    for (let index = 0; index < Math.min(3, available.length); index++) void worker();
    return () => controller.abort();
  }, [workspaceId, sources, enabled, readKey, en, store]);
  return enabled && reads.key === readKey ? reads.sources : {};
}

type Props = {
  projectId?: string;
  filterProjectId?: string;
  catalog: DocumentSourceCatalogState;
  settingsOpen: boolean;
  en: boolean;
  onScope: (projectId?: string) => void;
  onSettingsOpen: () => void;
  onSettingsClose: () => void;
  onManage: (intent: ExternalManagementIntent) => void;
  onOpen?: (target: Selection) => void;
};

export function DocumentSources({ projectId, filterProjectId, catalog, settingsOpen, en, onScope, onSettingsOpen, onSettingsClose, onManage, onOpen }: Props) {
  const { workspaceId, sources, scopes, collectionSources, error, reload } = catalog;
  const loading = catalog.status === 'pending';
  const selectedProjectId = projectId || filterProjectId || null;
  const { store, snapshot } = useExternalDocumentSession();
  useExternalDocumentLeaveProtection(store, en);
  useEffect(() => { if (catalog.status === 'ready') store.authorize(sources); }, [catalog.status, sources, store]);
  useEffect(() => {
    if (!snapshot.completions.length) return;
    const completions = snapshot.completions;
    store.acknowledge();
    reload();
    for (const { sourceId: originalSourceId, receipt } of completions) {
      if (receipt.status !== 'succeeded' || receipt.action === 'save') continue;
      if (receipt.action === 'delete' || !receipt.content) continue;
      onOpen?.({ kind: 'external', sourceId: receipt.targetSourceId || originalSourceId, revision: receipt.content.sourceRevision, path: receipt.targetPath || receipt.content.path });
    }
  }, [snapshot.completions, store, reload, onOpen]);
  useEffect(() => { if (settingsOpen) reload(); }, [settingsOpen, reload]);
  return <>
    <section className="document-sources document-sources-summary" aria-label={en ? 'External directory documents' : '外部目录文档'}>
      <ExternalOperationNotices en={en} onOpen={onOpen} onManage={onManage} />
      {loading ? <p className="document-source-state" role="status"><LoaderCircle size={17} className="spin" />{en ? 'Reading this scope’s source and permissions…' : '正在读取此范围的来源及权限…'}</p>
        : error ? <div className="document-source-state document-source-error" role="alert"><p>{en ? 'The source catalog could not be read. This is not an empty document collection.' : '来源目录读取失败，不代表文档集合为空。'} {error}</p><button type="button" className="secondary-button" onClick={reload}>{en ? 'Read sources again' : '重新读取来源'}</button></div>
          : !collectionSources.length ? <div className="document-source-state" role="status">
            <p>{en ? 'No external folders are associated with this collection. PM documents remain available below.' : '此集合尚未关联外部文件夹，PM文档仍在下方显示。'}</p>
            {scopes.some(item => item.canManage && (!projectId || item.projectId === projectId)) && <button type="button" className="secondary-button" onClick={onSettingsOpen}><Settings2 size={14} />{en ? 'Associate folders' : '关联文件夹'}</button>}
            {projectId && sources.some(item => item.projectId !== projectId) && <button type="button" className="secondary-button" onClick={() => onScope()}>{en ? 'Go to workspace documents' : '前往工作区文档'}</button>}
          </div> : null}
    </section>
    {settingsOpen && <DocumentSourceSettings key={selectedProjectId || 'workspace'} workspaceId={workspaceId} sources={sources} scopes={scopes} selectedProjectId={selectedProjectId} fixedProject={!!projectId} loading={loading} error={error} en={en} onClose={onSettingsClose} onReload={reload} onSaved={() => {
      reload();
      onSettingsClose();
    }} />}
  </>;
}
