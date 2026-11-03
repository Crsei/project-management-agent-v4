export interface DocumentSaveRecovery {
  phase: 'unknown' | 'observed';
  message: string;
  observedRevision?: string;
}
export interface DocumentDraftValue { raw: string; revision: string; documentSave?: DocumentSaveRecovery }
export interface DocumentWriteStatus { phase: 'saving' | 'error' | 'conflict' | 'paused'; message: string }

export function documentSaveRecovery(value: unknown): DocumentSaveRecovery | undefined {
  if (!value || typeof value !== 'object' || !('documentSave' in value)) return;
  const recovery = value.documentSave as Partial<DocumentSaveRecovery> | undefined;
  if (!recovery || !['unknown', 'observed'].includes(recovery.phase ?? '') || typeof recovery.message !== 'string') return;
  return recovery as DocumentSaveRecovery;
}
export function hasUncertainDocumentSave(values: Readonly<Record<string, unknown>>, savingId?: string): boolean {
  return Object.entries(values).some(([id, value]) => id !== savingId && !!documentSaveRecovery(value));
}
/** Ordinary source/draft actions cannot erase an unresolved native write. */
export function preserveDocumentSaveRecovery<T extends DocumentDraftValue>(previous: Readonly<Record<string, T>>, next: Record<string, T>): Record<string, T> {
  let retained = next;
  for (const [id, value] of Object.entries(previous)) {
    const recovery = documentSaveRecovery(value);
    if (!recovery || next[id] === value) continue;
    if (retained === next) retained = { ...next };
    retained[id] = next[id] ? { ...next[id], revision: value.revision, documentSave: recovery } : value;
  }
  return retained;
}
/** Never clear edits made after dispatch; advance their CAS baseline instead. */
export function completeDocumentSave<T extends DocumentDraftValue>(draft: T | undefined, saving: string, revision: string): T | undefined {
  if (!draft || draft.raw === saving) return;
  const { documentSave: _recovery, ...rest } = draft;
  return { ...rest, revision } as T;
}
/** Reconciliation is an observation, not proof of the original write's outcome. */
export function observeDocumentSave<T extends DocumentDraftValue>(draft: T, current: { raw: string; revision: string }): T {
  if (!draft.documentSave) throw new Error('Only an unresolved document save can be reconciled.');
  return { ...draft, documentSave: { phase: 'observed', observedRevision: current.revision, message: current.raw === draft.raw
    ? 'The authoritative source contains this draft. This is an observation, not a write receipt. Explicitly adopt the source to resolve the unknown result.'
    : 'The authoritative source differs from this draft. Nothing was retried. Compare the retained draft and explicitly adopt the observed revision before saving again.' } };
}
export function adoptDocumentSave<T extends DocumentDraftValue>(draft: T, current: { raw: string; revision: string }): T | undefined {
  if (draft.documentSave?.phase !== 'observed' || draft.documentSave.observedRevision !== current.revision) throw new Error('Read the authoritative source again before adopting its revision.');
  if (draft.raw === current.raw) return;
  const { documentSave: _recovery, ...rest } = draft;
  return { ...rest, revision: current.revision } as T;
}
