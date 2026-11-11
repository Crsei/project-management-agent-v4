import type { PmReferenceInput } from "@agent-workspace/contracts/pm-references";

// Draft references are isolated per Composer thread, never Session business ownership.
type Entry = { value: PmReferenceInput; selectionId: number };
export type PmReferenceSnapshot = {
  threadId: string;
  references: readonly PmReferenceInput[];
  selectionIds: readonly number[];
};
const drafts = new Map<string, Entry[]>();
const consumers = new Map<string, Set<(consumed: readonly PmReferenceInput[]) => void>>();
let nextSelectionId = 0;
export const pmReferenceKey = (value: PmReferenceInput): string =>
  JSON.stringify([value.workspaceId, value.projectId, value.kind, value.id, value.revision]);

export function setPmReferences(localThreadId: string, next: readonly PmReferenceInput[]): void {
  const previous = new Map((drafts.get(localThreadId) ?? []).map(entry => [pmReferenceKey(entry.value), entry]));
  drafts.set(localThreadId, next.slice(0, 50).map(value =>
    previous.get(pmReferenceKey(value)) ?? { value: { ...value }, selectionId: ++nextSelectionId }));
}
export function clearPmReferences(localThreadId: string): void {
  drafts.delete(localThreadId);
}
export function getPmReferences(localThreadId: string): readonly PmReferenceInput[] {
  return (drafts.get(localThreadId) ?? []).map(entry => entry.value);
}
export function capturePmReferences(threadId: string): PmReferenceSnapshot {
  const entries = drafts.get(threadId) ?? [];
  return { threadId, references: entries.map(entry => ({ ...entry.value })), selectionIds: entries.map(entry => entry.selectionId) };
}
/** Only durable acceptance consumes a selection; later additions/re-selections survive. */
export function consumePmReferences(snapshot: PmReferenceSnapshot): void {
  const ids = new Set(snapshot.selectionIds);
  const current = drafts.get(snapshot.threadId) ?? [];
  const consumed = current.filter(entry => ids.has(entry.selectionId)).map(entry => entry.value);
  if (!consumed.length) return;
  drafts.set(snapshot.threadId, current.filter(entry => !ids.has(entry.selectionId)));
  for (const listener of consumers.get(snapshot.threadId) ?? []) listener(consumed);
}
export function subscribePmReferenceConsumption(threadId: string, listener: (consumed: readonly PmReferenceInput[]) => void): () => void {
  const bucket = consumers.get(threadId) ?? new Set();
  bucket.add(listener);
  consumers.set(threadId, bucket);
  return () => { bucket.delete(listener); if (!bucket.size) consumers.delete(threadId); };
}
