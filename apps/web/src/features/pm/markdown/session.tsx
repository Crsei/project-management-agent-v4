import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { createCoreClient, type CoreClient } from './api';
import { createCreationStore, type CreationStore } from './creation-store';
import { creationComplete, type CreationDrafts } from './creation-model';

export interface Draft { raw: string; revision: string }
export type Drafts = Record<string, Draft>;
export type DetailTab = 'content' | 'source' | 'properties' | 'relations' | 'graph' | 'business' | 'context';
export interface DetailState { tab: DetailTab; entityId?: string }
interface SessionStore<T> {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => T;
  update: Dispatch<SetStateAction<T>>;
  persistenceError: () => boolean;
}
export interface CoreSession {
  namespace: string;
  scope: string;
  api: CoreClient;
  queryKey: readonly ['pm', string, string, string, 'core', number, number];
  onAccessFailure: () => Promise<void>;
  storageKey: (name: string) => string;
  drafts: SessionStore<Drafts>;
  creationDrafts: CreationStore;
  detail: SessionStore<DetailState>;
}
const Context = createContext<CoreSession | null>(null);
const sessions = new Map<string, Omit<CoreSession, 'onAccessFailure'>>();

/** The host keeps draft protection mounted across pages, but never across identities. */
export function useCoreDraftProtection(hostNamespace: string, actorId: string | undefined, actorEpoch: number) {
  useEffect(() => {
    if (!actorId) return;
    function protect(event: BeforeUnloadEvent) {
      for (const session of sessions.values()) {
        if (session.queryKey[1] !== hostNamespace || session.queryKey[2] !== actorId || session.queryKey[6] !== actorEpoch) continue;
        const unsaved = Object.keys(session.drafts.getSnapshot()).length > 0 || Object.values(session.creationDrafts.getSnapshot()).some(draft => !creationComplete(draft));
        if (!unsaved && !session.drafts.persistenceError() && !session.creationDrafts.persistenceError()) continue;
        event.preventDefault();
        event.returnValue = '';
        return;
      }
    }
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [hostNamespace, actorId, actorEpoch]);
}

export function stored<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; } catch { return fallback; }
}
function store<T>(initial: T, key?: string): SessionStore<T> {
  let value = initial;
  let failed = false;
  const listeners = new Set<() => void>();
  return {
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => value,
    persistenceError: () => failed,
    update: next => {
      value = typeof next === 'function' ? (next as (previous: T) => T)(value) : next;
      if (key) { try { localStorage.setItem(key, JSON.stringify(value)); failed = false; } catch { failed = true; } }
      listeners.forEach(listener => listener());
    },
  };
}
function scopedSession(hostNamespace: string, workspaceId: string, actorId: string, membershipVersion: number, actorEpoch: number): Omit<CoreSession, 'onAccessFailure'> {
  const namespace = `${hostNamespace}:${workspaceId}:${actorId}`;
  const scope = `${namespace}:${membershipVersion}:${actorEpoch}`;
  const existing = sessions.get(scope);
  if (existing) return existing;
  for (const [key, value] of sessions) if (value.namespace === namespace) sessions.delete(key);
  const storageKey = (name: string) => `pm-core:${namespace}:${name}`;
  // Carry forward the host's existing safe draft backups without changing their CAS baseline.
  const drafts = stored<Drafts>(storageKey('drafts'), stored<Drafts>(`pm-markdown:${workspaceId}:${actorId}:drafts`, {}));
  const session: Omit<CoreSession, 'onAccessFailure'> = {
    namespace, scope, storageKey, api: createCoreClient(workspaceId),
    queryKey: ['pm', hostNamespace, actorId, workspaceId, 'core', membershipVersion, actorEpoch],
    drafts: store(drafts, storageKey('drafts')),
    creationDrafts: createCreationStore(storageKey('creation-drafts'), {
      getItem: key => localStorage.getItem(key),
      setItem: (key, value) => localStorage.setItem(key, value),
    }, changed => window.addEventListener('storage', event => { if (event.key === storageKey('creation-drafts') || event.key === null) changed(); })),
    detail: store<DetailState>({ tab: 'content' }),
  };
  sessions.set(scope, session);
  return session;
}
export function CoreSessionProvider({ hostNamespace, workspaceId, actorId, membershipVersion, actorEpoch, onAccessFailure, children }: { hostNamespace: string; workspaceId: string; actorId: string; membershipVersion: number; actorEpoch: number; onAccessFailure: () => Promise<void>; children: ReactNode }) {
  const session = useMemo(() => ({ ...scopedSession(hostNamespace, workspaceId, actorId, membershipVersion, actorEpoch), onAccessFailure }), [hostNamespace, workspaceId, actorId, membershipVersion, actorEpoch, onAccessFailure]);
  return <Context.Provider key={session.scope} value={session}>{children}</Context.Provider>;
}
export function useCoreSession(): CoreSession {
  const session = useContext(Context);
  if (!session) throw new Error('A scoped CoreSessionProvider is required.');
  return session;
}
export function useSessionDrafts(): [Drafts, Dispatch<SetStateAction<Drafts>>] {
  const { drafts } = useCoreSession();
  return [useSyncExternalStore(drafts.subscribe, drafts.getSnapshot, drafts.getSnapshot), drafts.update];
}
export function useDetailState(): [DetailState, (changes: Partial<DetailState>) => void] {
  const { detail } = useCoreSession();
  const update = useCallback((changes: Partial<DetailState>) => detail.update(current => ({ ...current, ...changes })), [detail]);
  return [useSyncExternalStore(detail.subscribe, detail.getSnapshot, detail.getSnapshot), update];
}
export function useCreationDrafts(): [CreationDrafts, CreationStore['update']] {
  const { creationDrafts } = useCoreSession();
  return [useSyncExternalStore(creationDrafts.subscribe, creationDrafts.getSnapshot, creationDrafts.getSnapshot), creationDrafts.update];
}
