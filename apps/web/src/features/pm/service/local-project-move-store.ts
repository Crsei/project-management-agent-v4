import { z } from 'zod';
import { localDirectorySchema, type LocalDirectory, type LocalProjectAttempt } from '../../../../../../packages/contracts/src/local-projects.ts';

export interface LocalMoveAttempt {
  key: string;
  projectId: string;
  mode: 'move' | 'rebind';
  operation: 'migrate' | 'relocate';
  directory: LocalDirectory;
  writersStopped: true;
  phase: 'sending' | 'unknown' | 'rejected' | 'ready';
  message: string;
}
export interface LocalMoveDraft { directory?: LocalDirectory; mode?: 'move' | 'rebind'; writersStopped: boolean; attempt?: LocalMoveAttempt }
export interface LocalMoveStorage { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void }
export interface LocalMoveStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => LocalMoveDraft;
  persistenceError: () => boolean;
  update: (change: (current: LocalMoveDraft) => LocalMoveDraft, durable?: boolean) => boolean;
  refresh: () => void;
}
const draftSchema = z.object({
  directory: z.discriminatedUnion('mode', [z.object({ mode: z.literal('existing'), path: z.string() }), z.object({ mode: z.literal('new'), parentPath: z.string(), folderName: z.string() })]).optional(),
  writersStopped: z.boolean(),
  mode: z.enum(['move', 'rebind']).optional(),
  attempt: z.object({ key: z.string().min(1), projectId: z.string().min(1), mode: z.enum(['move', 'rebind']), operation: z.enum(['migrate', 'relocate']), directory: localDirectorySchema, writersStopped: z.literal(true), phase: z.enum(['sending', 'unknown', 'rejected', 'ready']), message: z.string() }).optional(),
});

export function applyLocalMoveResult(attempt: LocalMoveAttempt, result: LocalProjectAttempt): LocalMoveAttempt {
  if (attempt.phase === 'ready') return attempt;
  if (result.status !== 'not_found' && (result.key !== attempt.key || result.operation !== attempt.operation || result.status === 'ready' && result.record.id !== attempt.projectId)) return { ...attempt, phase: 'unknown', message: 'storage_operation_identity_mismatch' };
  if (result.status === 'ready' && result.location.status === 'available') return { ...attempt, phase: 'ready', message: '' };
  if (result.status === 'rejected') return { ...attempt, phase: 'rejected', message: result.code };
  return { ...attempt, phase: 'unknown', message: result.status === 'pending' ? result.reason : result.status === 'ready' ? 'storage_unavailable' : 'not_found_does_not_prove_not_received' };
}

/** Separate from native creation journals and PM command receipts. No unsafe storage fallback. */
export function createLocalMoveStore(key: string, storage: LocalMoveStorage): LocalMoveStore {
  let value: LocalMoveDraft = { writersStopped: false };
  let serialized: string | null = null;
  let failed = false;
  let corrupt = false;
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  function refresh() {
    try {
      const text = storage.getItem(key);
      if (text === serialized && !corrupt) return;
      const next: LocalMoveDraft = text === null ? { writersStopped: false } : draftSchema.parse(JSON.parse(text));
      if (next.attempt?.phase === 'sending') next.attempt.phase = 'unknown';
      if (!(failed && !corrupt && !value.attempt && !next.attempt)) value = next;
      serialized = text; failed = false; corrupt = false; notify();
    } catch { failed = true; corrupt = true; notify(); }
  }
  refresh();
  return {
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => value,
    persistenceError: () => failed,
    refresh,
    update: (change, durable = false) => {
      refresh();
      if (corrupt) return false;
      const next = change(value);
      try {
        const text = JSON.stringify(next);
        storage.setItem(key, text);
        serialized = text; value = next; failed = false; notify(); return true;
      } catch {
        if (!durable) value = next;
        failed = true; notify(); return false;
      }
    },
  };
}
