import type { Command, CommandReceipt } from '../../../../../../packages/contracts/src/client.ts';

export type CommentDraft = { content: string; baseVersion: number | null; original: string; attempt: Command | null; confirmed: boolean };
export type CommentDrafts = Record<string, CommentDraft>;
export const emptyCommentDraft = (): CommentDraft => ({ content: '', baseVersion: null, original: '', attempt: null, confirmed: false });
export type CommentDraftStorage = { getItem(key: string): string | null; setItem(key: string, value: string): void };
export type CommentDraftStore = {
  getSnapshot: () => CommentDrafts;
  subscribe: (listener: () => void) => () => void;
  persistenceError: () => boolean;
  commit: (change: (current: CommentDrafts) => CommentDrafts) => boolean;
  flush: () => boolean;
};

export function settleCommentDraft(draft: CommentDraft, receipt: CommandReceipt): CommentDraft {
  if (!draft.attempt || draft.attempt.commandId !== receipt.commandId) return draft;
  return receipt.status === 'committed' ? { ...draft, confirmed: true } : { ...draft, attempt: null, confirmed: false };
}
function decode(text: string | null): CommentDrafts {
  if (!text) return {};
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid comment drafts');
  for (const draft of Object.values(value)) {
    if (!draft || typeof draft !== 'object' || typeof draft.content !== 'string' || typeof draft.original !== 'string' || typeof draft.confirmed !== 'boolean' || !(draft.baseVersion === null || Number.isInteger(draft.baseVersion) && draft.baseVersion > 0)
      || !(draft.attempt === null || typeof draft.attempt === 'object' && typeof draft.attempt.commandId === 'string' && typeof draft.attempt.commandType === 'string' && typeof draft.attempt.payload === 'object')) throw new Error('Invalid comment draft');
  }
  return value as CommentDrafts;
}
/** Per-tab session storage preserves refresh recovery without merging competing tabs' edits. */
export function createCommentDraftStore(key: string, storage: CommentDraftStorage): CommentDraftStore {
  let value: CommentDrafts = {};
  let failed = false;
  let unreadable = false;
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  try { value = decode(storage.getItem(key)); } catch { failed = true; unreadable = true; }
  function persist() {
    if (unreadable) { notify(); return false; }
    try { storage.setItem(key, JSON.stringify(value)); failed = false; } catch { failed = true; }
    notify();
    return !failed;
  }
  return {
    getSnapshot: () => value,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    persistenceError: () => failed,
    commit: (change: (current: CommentDrafts) => CommentDrafts) => { value = change(value); return persist(); },
    flush: () => { if (unreadable) { try { value = { ...decode(storage.getItem(key)), ...value }; unreadable = false; } catch { return false; } } return persist(); },
  };
}
