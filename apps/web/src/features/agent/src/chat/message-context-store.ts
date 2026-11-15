import type { AcceptedChatContext, ChatContextInput } from "@agent-workspace/contracts/message-context";
import type { PmReference } from "../pm/pm-types";
import type { Attachment } from "@assistant-ui/react";
import { capturePmReferences, type PmReferenceSnapshot } from "../pm/pm-chat-bridge.ts";

export type MessageContextDraftItem = { input: ChatContextInput; accepted?: AcceptedChatContext; error?: string };
type Entry = MessageContextDraftItem & { selectionId: number };
export type MessageContextSnapshot = { owner: string; items: readonly MessageContextDraftItem[]; selectionIds: readonly number[]; pmReferences?: readonly PmReference[]; attachments?: readonly Attachment[]; pmDraft?: PmReferenceSnapshot };
const EMPTY: readonly Entry[] = [];
const drafts = new Map<string, readonly Entry[]>();
const aliases = new Map<string, string>();
const listeners = new Set<() => void>();
const editing = new Map<string, string>();
const editReferences = new Map<string, readonly PmReference[]>();
const EMPTY_REFERENCES: readonly PmReference[] = [];
export function getEditedContextReferences(owner: string) { return editReferences.get(owner) ?? EMPTY_REFERENCES; }
export function setEditedContextReferences(owner: string, references: readonly PmReference[]) { editReferences.set(owner, references.map(reference => ({ ...reference, availability: "unverified" }))); publish(); }
const preparedSubmissions = new Map<string, MessageContextSnapshot>();
const blockers = new Map<string, Map<string, string>>();
export function getMessageContextBlocker(owner: string): string | undefined { return blockers.get(ownerOf(owner))?.values().next().value; }
export function setMessageContextBlocker(owner: string, key: string, message: string | undefined) {
  owner = ownerOf(owner);
  const current = blockers.get(owner) ?? new Map<string, string>();
  if (message === undefined) current.delete(key); else current.set(key, message);
  if (current.size) blockers.set(owner, current); else blockers.delete(owner);
  publish();
}
let sequence = 0;
const ownerOf = (id: string) => aliases.get(id) ?? id;
const publish = () => { for (const listener of listeners) listener(); };
export function bindMessageContextThread(localId: string, remoteId: string | undefined) { if (remoteId) aliases.set(remoteId, localId); }
export function subscribeMessageContext(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function getMessageContextItems(owner: string): readonly MessageContextDraftItem[] { return drafts.get(ownerOf(owner)) ?? EMPTY; }
export function setMessageContextItems(owner: string, items: readonly MessageContextDraftItem[]) {
  if (items.length > 20) throw new Error("At most 20 context items can be selected.");
  if (new Set(items.map(item => item.input.contextId)).size !== items.length) throw new Error("Duplicate context identity.");
  owner = ownerOf(owner);
  const previous = drafts.get(owner) ?? EMPTY;
  const next = items.map(item => {
    const existing = previous.find(entry => JSON.stringify(entry.input) === JSON.stringify(item.input));
    if (!existing) return { ...item, selectionId: ++sequence };
    return existing.accepted === item.accepted && existing.error === item.error ? existing : { ...item, selectionId: existing.selectionId };
  });
  if (next.length === previous.length && next.every((entry, index) => entry === previous[index])) return;
  drafts.set(owner, next); publish();
}
export function captureMessageContext(threadId: string, includeEdit = true): MessageContextSnapshot {
  const owner = includeEdit ? editing.get(threadId) ?? ownerOf(threadId) : ownerOf(threadId);
  const entries = drafts.get(owner) ?? EMPTY;
  return { owner, items: entries.map(({ input, accepted, error }) => ({ input: structuredClone(input), ...(accepted ? { accepted: structuredClone(accepted) } : {}), ...(error ? { error } : {}) })), selectionIds: entries.map(item => item.selectionId), ...(editReferences.has(owner) ? { pmReferences: editReferences.get(owner) } : {}) };
}
/** Freeze before assistant-ui exits edit mode or clears its attachment draft. */
export function prepareMessageContextEditSubmission(threadId: string, attachments: readonly Attachment[] = []) {
  if (editing.has(threadId)) preparedSubmissions.set(ownerOf(threadId), { ...captureMessageContext(threadId), attachments: [...attachments] });
}
export function prepareMessageContextDraftSubmission(threadId: string, attachments: readonly Attachment[]) {
  preparedSubmissions.set(ownerOf(threadId), { ...captureMessageContext(threadId, false), attachments: [...attachments], pmDraft: capturePmReferences(ownerOf(threadId)) });
}
export function takeMessageContextSubmission(threadId: string) {
  const snapshot = preparedSubmissions.get(ownerOf(threadId));
  preparedSubmissions.delete(ownerOf(threadId));
  return snapshot ?? captureMessageContext(threadId, false);
}
/** Accepting an old input never consumes a later addition, edit, or re-selection. */
export function consumeMessageContext(snapshot: MessageContextSnapshot) {
  const consumed = new Set(snapshot.selectionIds);
  const current = drafts.get(snapshot.owner) ?? EMPTY;
  const next = current.filter(item => !consumed.has(item.selectionId));
  if (current.length !== next.length) { drafts.set(snapshot.owner, next); publish(); }
}
export function beginMessageContextEdit(threadId: string, messageId: string, items: readonly AcceptedChatContext[], references: readonly PmReference[] = []) {
  const owner = `edit:${threadId}:${messageId}`;
  setMessageContextItems(owner, items.map(accepted => {
    if (accepted.visibility !== "available") throw new Error("Unavailable context cannot be silently restored for editing.");
    return { input: accepted.input, accepted };
  }));
  editReferences.set(owner, references);
  editing.set(threadId, owner);
  return owner;
}
export function endMessageContextEdit(threadId: string, owner: string) { if (editing.get(threadId) === owner) editing.delete(threadId); drafts.delete(owner); editReferences.delete(owner); blockers.delete(owner); publish(); }
export function hasMessageContextDraft(threadId: string): boolean { return getMessageContextItems(threadId).length > 0 || getMessageContextBlocker(threadId) !== undefined; }
