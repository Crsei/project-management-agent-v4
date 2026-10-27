import { decodeCreationDrafts, type CreationDrafts } from './creation-model.ts';

export interface CreationStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => CreationDrafts;
  persistenceError: () => boolean;
  update: (change: (current: CreationDrafts) => CreationDrafts) => boolean;
  commit: (change: (current: CreationDrafts) => CreationDrafts) => boolean;
  refresh: () => void;
}
export interface CreationStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }

/** A failed durable commit never authorizes dispatch. Editing can remain in memory. */
export function createCreationStore(key: string, storage: CreationStorage, listen?: (changed: () => void) => void): CreationStore {
  let value: CreationDrafts = {};
  let failed = false;
  let corrupt = false;
  let serialized: string | null = null;
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  function refresh() {
    try {
      const text = storage.getItem(key);
      if (text === serialized && !corrupt) return;
      const latest = decodeCreationDrafts(text);
      // Keep unsaved text after a quota failure, but a durable frozen attempt wins.
      if (failed && !corrupt) for (const [id, local] of Object.entries(value)) if (!local.attempt && !latest[id]?.attempt) latest[id] = local;
      value = latest;
      serialized = text;
      corrupt = false;
      failed = false;
      notify();
    } catch { failed = true; corrupt = true; notify(); }
  }
  function save(change: (current: CreationDrafts) => CreationDrafts, durable: boolean): boolean {
    refresh();
    if (corrupt) return false;
    const next = change(value);
    try {
      const text = JSON.stringify(next);
      storage.setItem(key, text);
      serialized = text;
      value = next;
      failed = false;
      notify();
      return true;
    } catch {
      if (!durable) value = next;
      failed = true;
      notify();
      return false;
    }
  }
  refresh();
  listen?.(refresh);
  return {
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => value,
    persistenceError: () => failed,
    update: change => save(change, false),
    commit: change => save(change, true),
    refresh,
  };
}

/** Cross-tab preparation and sends share a scope lock; no unsafe fallback. */
export async function withCreationLock<T>(namespace: string, action: () => Promise<T>): Promise<T> {
  if (!globalThis.navigator?.locks) throw new Error('Safe cross-tab creation requires browser Web Locks. No write was sent. / 当前浏览器无法安全协调多标签页，未发送写入。');
  return navigator.locks.request(`pm-core-creation:${namespace}`, { mode: 'exclusive' }, action);
}
