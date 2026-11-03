import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { CoreSession } from './session';
import { stored, useCoreSession, useSessionDrafts } from './session';
import type { WorkspaceController } from './controller';
import { documentSaveRecovery } from './document-save-model';
import { restoreExternalDocumentTarget, type ExternalTarget } from './external-document-state';

export type DocumentTarget = { kind: 'native'; id: string } | ExternalTarget;
export function documentTargetKey(target: DocumentTarget): string {
  return target.kind === 'native' ? JSON.stringify(['native', target.id]) : JSON.stringify(['external', target.sourceId, target.revision, target.path]);
}
export interface DocumentTabStatus { dirty: boolean; saving: boolean; error?: string; unknown?: boolean }
export interface DocumentEditorPosition { anchor: number; head: number; scrollTop: number; scrollLeft: number; previewScrollTop?: number; layout?: 'edit' | 'split' | 'preview' }
interface WorkbenchSnapshot { tabs: DocumentTarget[]; active: DocumentTarget | null }
interface WorkbenchStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): WorkbenchSnapshot;
  update(change: (previous: WorkbenchSnapshot) => WorkbenchSnapshot): void;
  positions: Map<string, DocumentEditorPosition>;
}
const workbenches = new Map<string, WorkbenchStore>();
export function restoreDocumentTabs(value: unknown): DocumentTarget[] {
  if (!Array.isArray(value)) return [];
  const keys = new Set<string>();
  return value.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const target: DocumentTarget | undefined = item.kind === 'native' && typeof item.id === 'string' && item.id ? { kind: 'native', id: item.id } : restoreExternalDocumentTarget(item);
    if (!target || keys.has(documentTargetKey(target))) return [];
    keys.add(documentTargetKey(target));
    return [target];
  });
}
function workbenchStore(session: CoreSession): WorkbenchStore {
  const existing = workbenches.get(session.scope);
  if (existing) return existing;
  // Membership/actor epochs never reuse external identities or editor positions.
  for (const key of workbenches.keys()) if (key.startsWith(`${session.namespace}:`)) workbenches.delete(key);
  let snapshot: WorkbenchSnapshot = { tabs: restoreDocumentTabs(stored<unknown>(session.storageKey('document-tabs'), [])), active: null };
  // Migrate old external tab identities into memory, then remove their paths
  // from persistence. Opening one still requires current source authorization.
  try { localStorage.setItem(session.storageKey('document-tabs'), JSON.stringify(snapshot.tabs.filter(target => target.kind === 'native'))); } catch { /* Optional tab persistence must not discard operation recovery. */ }
  const listeners = new Set<() => void>();
  const result: WorkbenchStore = {
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => snapshot,
    positions: new Map(),
    update: change => {
      const next = change(snapshot);
      if (next === snapshot) return;
      snapshot = next;
      // External identities, labels and content never enter browser persistence.
      try { localStorage.setItem(session.storageKey('document-tabs'), JSON.stringify(snapshot.tabs.filter(target => target.kind === 'native'))); } catch { /* Tabs are optional; document drafts have their own protected store. */ }
      listeners.forEach(listener => listener());
    },
  };
  workbenches.set(session.scope, result);
  return result;
}
export function getDocumentEditorPosition(session: CoreSession, id: string, mode: 'body' | 'source' | 'detail'): DocumentEditorPosition | undefined {
  return workbenchStore(session).positions.get(JSON.stringify([id, mode]));
}
export function retainDocumentEditorPosition(session: CoreSession, id: string, mode: 'body' | 'source' | 'detail', position: DocumentEditorPosition): void {
  workbenchStore(session).positions.set(JSON.stringify([id, mode]), position);
}
export function useDocumentWorkbenchState(activeFromUrl?: DocumentTarget | null) {
  const session = useCoreSession();
  const store = useMemo(() => workbenchStore(session), [session]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const syncFromUrl = useCallback((target: DocumentTarget | null) => store.update(previous => {
    const key = target && documentTargetKey(target);
    const activeKey = previous.active && documentTargetKey(previous.active);
    if (key === activeKey) return previous;
    return { active: target, tabs: target && !previous.tabs.some(tab => documentTargetKey(tab) === key) ? [...previous.tabs, target] : previous.tabs };
  }), [store]);
  useEffect(() => { if (activeFromUrl !== undefined) syncFromUrl(activeFromUrl); }, [activeFromUrl, syncFromUrl]);
  const open = useCallback((target: DocumentTarget) => syncFromUrl(target), [syncFromUrl]);
  const close = useCallback((key: string) => store.update(previous => {
    const index = previous.tabs.findIndex(target => documentTargetKey(target) === key);
    if (index < 0) return previous;
    const tabs = previous.tabs.filter(target => documentTargetKey(target) !== key);
    return { tabs, active: previous.active && documentTargetKey(previous.active) === key ? tabs[Math.min(index, tabs.length - 1)] ?? null : previous.active };
  }), [store]);
  const retarget = useCallback((from: DocumentTarget, to: DocumentTarget | null) => store.update(previous => {
    const key = documentTargetKey(from);
    const seen = new Set<string>();
    const tabs = previous.tabs.flatMap(tab => {
      const next = documentTargetKey(tab) === key ? to : tab;
      if (!next || seen.has(documentTargetKey(next))) return [];
      seen.add(documentTargetKey(next));
      return [next];
    });
    return { tabs, active: previous.active && documentTargetKey(previous.active) === key ? to : previous.active };
  }), [store]);
  // On the first render of a deep link, the route wins over restored in-memory active state.
  const active = activeFromUrl === undefined ? snapshot.active : activeFromUrl;
  const tabs = active && !snapshot.tabs.some(target => documentTargetKey(target) === documentTargetKey(active)) ? [...snapshot.tabs, active] : snapshot.tabs;
  return { tabs, active, open, activate: open, close, retarget, syncFromUrl };
}
export interface DocumentClosePrompt { target: DocumentTarget; busy: boolean; error: string }
export interface DocumentWorkbenchLifecycle {
  statuses: Record<string, DocumentTabStatus>;
  beforeTransition(): Promise<boolean>;
  requestClose(target: DocumentTarget): Promise<boolean>;
  closePrompt: DocumentClosePrompt | null;
  resolveClose(choice: 'save' | 'keep' | 'cancel'): Promise<void>;
  recovery: { id: string; phase: 'unknown' | 'observed'; message: string; observedRevision?: string; saving: boolean }[];
  reconcile(id: string): Promise<void>;
  adopt(id: string): void;
}
export function useDocumentWorkbenchLifecycle(controller: WorkspaceController, en: boolean): DocumentWorkbenchLifecycle {
  const session = useCoreSession();
  const [drafts] = useSessionDrafts();
  const writes = useSyncExternalStore(session.documentWrites.subscribe, session.documentWrites.getSnapshot, session.documentWrites.getSnapshot);
  const latest = useRef(controller); latest.current = controller;
  const [closePrompt, setClosePrompt] = useState<DocumentClosePrompt | null>(null);
  const closeResolver = useRef<((closed: boolean) => void) | null>(null);
  const statuses: Record<string, DocumentTabStatus> = {};
  for (const id of new Set([...Object.keys(drafts), ...Object.keys(writes)])) {
    const recovery = documentSaveRecovery(drafts[id]);
    statuses[documentTargetKey({ kind: 'native', id })] = { dirty: !!drafts[id], saving: writes[id]?.phase === 'saving', unknown: !!recovery && writes[id]?.phase !== 'saving', error: writes[id]?.phase === 'saving' || writes[id]?.phase === 'paused' ? undefined : recovery?.message || writes[id]?.message };
  }
  const beforeTransition = useCallback(async () => {
    const current = latest.current;
    if (current.selected?.entity.entity !== 'document' || !session.drafts.getSnapshot()[current.selectedId]) return true;
    return current.saveDocument(current.selectedId);
  }, [session]);
  const requestClose = useCallback((target: DocumentTarget): Promise<boolean> => {
    if (closeResolver.current) return Promise.resolve(false);
    if (target.kind === 'external' || !session.drafts.getSnapshot()[target.id]) return Promise.resolve(true);
    setClosePrompt({ target, busy: false, error: '' });
    const { promise, resolve } = Promise.withResolvers<boolean>();
    closeResolver.current = resolve;
    return promise;
  }, [session]);
  const resolveClose = useCallback(async (choice: 'save' | 'keep' | 'cancel') => {
    if (!closePrompt || closePrompt.busy) return;
    let closed = false;
    if (choice === 'keep' && session.drafts.persistenceError()) {
      setClosePrompt(previous => previous && { ...previous, error: en ? 'The local draft could not be backed up. Keep this page open until backup or saving succeeds.' : '本地草稿备份失败，请保持页面打开，直到备份或保存成功。' }); return;
    }
    if (choice === 'save' && closePrompt.target.kind === 'native') {
      setClosePrompt(previous => previous && { ...previous, busy: true, error: '' });
      closed = await latest.current.saveDocument(closePrompt.target.id);
      if (!closed) { setClosePrompt(previous => previous && { ...previous, busy: false, error: en ? 'Saving was not confirmed. The tab and draft are retained. Resolve its save notice, keep the draft, or cancel.' : '保存尚未确认，标签和草稿已保留。请处理保存提示、保留草稿或取消关闭。' }); return; }
    } else closed = choice === 'keep';
    if (choice === 'keep' && closePrompt.target.kind === 'native') {
      const id = closePrompt.target.id;
      if (!documentSaveRecovery(session.drafts.getSnapshot()[id]) && session.documentWrites.getSnapshot()[id]?.phase !== 'saving') session.documentWrites.update(previous => ({ ...previous, [id]: { phase: 'paused', message: 'The local draft was deliberately kept. Use Save or edit it to resume automatic saving.' } }));
    }
    setClosePrompt(null);
    const resolve = closeResolver.current; closeResolver.current = null; resolve?.(closed);
  }, [closePrompt, session, en]);
  useEffect(() => () => { closeResolver.current?.(false); closeResolver.current = null; }, [session.scope]);
  const recovery = Object.entries(drafts).flatMap(([id, draft]) => { const retained = documentSaveRecovery(draft); return retained ? [{ id, ...retained, saving: writes[id]?.phase === 'saving' }] : []; });
  return { statuses, beforeTransition, requestClose, closePrompt, resolveClose, recovery, reconcile: (id: string) => latest.current.reconcileDocument(id), adopt: (id: string) => latest.current.adoptDocumentRevision(id) };
}
