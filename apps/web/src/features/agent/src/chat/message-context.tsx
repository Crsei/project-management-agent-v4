import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useAui, useAuiState } from "@assistant-ui/react";
import { serializeComposerFileLink } from "@agent-workspace/client-runtime";
import { chatContextInputSchema, chatContextResolveResponseSchema, type AcceptedChatContext, type ChatContextInput } from "@agent-workspace/contracts/message-context";
import { workspaceClient } from "../network";
import { inspectUrl } from "../workspace/inspector/api";
import { agentText } from "../i18n-text";
import { beginMessageContextEdit, bindMessageContextThread, endMessageContextEdit, getMessageContextBlocker, getMessageContextItems, setMessageContextItems, subscribeMessageContext, type MessageContextDraftItem } from "./message-context-store";
import type { PmReference } from "../pm/pm-types";

export interface MessageContextDraft {
  available: boolean;
  blocked: boolean;
  targetKey: string;
  items: readonly MessageContextDraftItem[];
  error: string | undefined;
  isCurrent(): boolean;
  add(input: ChatContextInput): Promise<void>;
  resolveInputs(inputs: readonly ChatContextInput[]): Promise<MessageContextDraftItem[]>;
  restore(inputs: readonly ChatContextInput[]): Promise<void>;
  addAttachment(file: File, attachmentId?: string): Promise<string>;
  addFileMention(path: string): Promise<void>;
  remove(contextId: string): void;
  clear(): void;
  replaceItems(items: readonly MessageContextDraftItem[]): void;
}

const Owner = createContext<string | undefined>(undefined);
const Available = createContext(false);
export function MessageContextDraftProvider({ children }: { children: ReactNode }) {
  const localId = useAuiState(s => s.threads.mainThreadId);
  const remoteId = useAuiState(s => s.threads.threadItems.find(item => item.id === s.threads.mainThreadId)?.remoteId);
  useLayoutEffect(() => { bindMessageContextThread(localId, remoteId); }, [localId, remoteId]);
  return <Available.Provider value><Owner.Provider value={localId}>{children}</Owner.Provider></Available.Provider>;
}

/** Editing has a separate owner: cancel or send cannot replace the new-message draft. */
export function MessageContextEditProvider({ threadId, messageId, items, references, children }: { threadId: string; messageId: string; items: readonly AcceptedChatContext[]; references: readonly PmReference[]; children: ReactNode }) {
  const owner = `edit:${threadId}:${messageId}`;
  useLayoutEffect(() => { beginMessageContextEdit(threadId, messageId, items, references); return () => endMessageContextEdit(threadId, owner); }, [threadId, messageId, owner]);
  return <Owner.Provider value={owner}>{children}</Owner.Provider>;
}

export function useMessageContextDraft(): MessageContextDraft {
  const aui = useAui();
  const provided = useContext(Available);
  const owner = useContext(Owner);
  const localId = useAuiState(s => s.threads.mainThreadId);
  const remoteId = useAuiState(s => s.threads.threadItems.find(item => item.id === s.threads.mainThreadId)?.remoteId);
  const disabled = useAuiState(s => s.thread.isDisabled || s.thread.isLoading || s.threads.isLoading);
  const targetKey = owner ?? localId;
  const getSnapshot = useCallback(() => getMessageContextItems(targetKey), [targetKey]);
  const items = useSyncExternalStore(subscribeMessageContext, getSnapshot, getSnapshot);
  const getBlocker = useCallback(() => getMessageContextBlocker(targetKey), [targetKey]);
  const blocker = useSyncExternalStore(subscribeMessageContext, getBlocker, getBlocker);
  const [error, setError] = useState<string>();
  const live = useRef({ localId, owner });
  const mounted = useRef(true);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, [localId, targetKey]);
  live.current = { localId, owner };
  const isCurrent = useCallback(() => mounted.current && provided && aui.threads.getState().mainThreadId === localId && live.current.owner === owner, [aui, localId, owner, provided]);
  const requireCurrent = useCallback(() => {
    if (!isCurrent()) throw new Error(agentText("会话已切换，上下文未添加。", "The session changed; context was not added."));
  }, [isCurrent]);
  const resolve = useCallback(async (inputs: readonly ChatContextInput[]) => {
    requireCurrent();
    const id = remoteId ?? (await aui.threads.item({ id: localId }).initialize()).remoteId;
    requireCurrent();
    bindMessageContextThread(localId, id);
    const result = chatContextResolveResponseSchema.parse(await workspaceClient.json(`/api/chat/threads/${encodeURIComponent(id)}/context/resolve`, { method: "POST", body: JSON.stringify({ contextItems: inputs.map(input => chatContextInputSchema.parse(input)) }) }));
    requireCurrent();
    if (result.contextItems.length !== inputs.length || result.contextItems.some((accepted, index) => accepted.contextId !== inputs[index]?.contextId || accepted.visibility !== "available")) throw new Error("Context resolution returned an unavailable or mismatched record.");
    return result.contextItems.map(item => { if (item.visibility !== "available") throw new Error(item.reason || "Context is unavailable."); return item; });
  }, [aui, localId, remoteId, requireCurrent]);
  const resolveInputs = useCallback(async (inputs: readonly ChatContextInput[]): Promise<MessageContextDraftItem[]> => inputs.length ? (await resolve(inputs)).map(accepted => ({ input: accepted.input, accepted })) : [], [resolve]);
  const add = useCallback(async (input: ChatContextInput): Promise<void> => {
    try {
      const previous = getMessageContextItems(targetKey).find(item => item.input.contextId === input.contextId);
      const [accepted] = await resolve([input]);
      if (!accepted) throw new Error("Context resolution returned no record.");
      const current = getMessageContextItems(targetKey);
      if (previous && !current.some(item => item.input.contextId === input.contextId && JSON.stringify(item.input) === JSON.stringify(previous.input))) throw new Error("The context was removed or changed during resolution. The new draft is unchanged.");
      setMessageContextItems(targetKey, [...current.filter(item => item.input.contextId !== input.contextId), { input: accepted.input, accepted }]);
      setError(undefined);
    } catch (cause) { if (isCurrent()) setError(cause instanceof Error ? cause.message : String(cause)); throw cause; }
  }, [resolve, targetKey, isCurrent]);
  const restore = useCallback(async (inputs: readonly ChatContextInput[]) => {
    const accepted = await resolve(inputs);
    if (getMessageContextItems(targetKey).length) throw new Error("Clear or stash the current context before restoring another draft.");
    setMessageContextItems(targetKey, accepted.map(item => ({ input: item.input, accepted: item })));
  }, [resolve, targetKey]);
  const addAttachment = useCallback(async (file: File, attachmentId = crypto.randomUUID()): Promise<string> => {
    requireCurrent();
    const { promise, resolve: resolveFile, reject } = Promise.withResolvers<string>();
    const reader = new FileReader(); reader.onload = () => typeof reader.result === "string" ? resolveFile(reader.result) : reject(new Error("Cannot read attachment."));
    reader.onerror = () => reject(reader.error ?? new Error("Cannot read attachment.")); reader.onabort = () => reject(new Error("Attachment read cancelled.")); reader.readAsDataURL(file);
    const dataUrl = await promise;
    requireCurrent();
    await aui.composer.addAttachment({ id: attachmentId, name: file.name, type: file.type.startsWith("image/") ? "image" : "file", contentType: file.type || "application/octet-stream", content: [file.type.startsWith("image/") ? { type: "image", image: dataUrl } : { type: "file", data: dataUrl, mimeType: file.type || "application/octet-stream", filename: file.name }] });
    requireCurrent();
    if (!aui.composer.getState().attachments.some(attachment => attachment.id === attachmentId)) throw new Error("The attachment was not added. The annotation remains without a screenshot.");
    return attachmentId;
  }, [aui, requireCurrent]);
  const addFileMention = useCallback(async (path: string) => {
    requireCurrent();
    const id = remoteId ?? (await aui.threads.item({ id: localId }).initialize()).remoteId;
    requireCurrent();
    await workspaceClient.json(inspectUrl("/api/inspector/file", { threadId: id, path }));
    requireCurrent();
    const text = aui.composer.getState().text;
    aui.composer.setText(`${text}${text && !/\s$/.test(text) ? " " : ""}${serializeComposerFileLink(path)} `);
  }, [aui, localId, remoteId, requireCurrent]);
  return useMemo(() => ({ available: provided && !disabled, blocked: !!blocker, targetKey, items, error: blocker || error, isCurrent, add, resolveInputs, restore, addAttachment, addFileMention,
    remove(contextId: string) { requireCurrent(); setMessageContextItems(targetKey, getMessageContextItems(targetKey).filter(item => item.input.contextId !== contextId)); },
    clear() { requireCurrent(); setMessageContextItems(targetKey, []); },
    replaceItems(next: readonly MessageContextDraftItem[]) { requireCurrent(); setMessageContextItems(targetKey, next); },
  }), [provided, disabled, blocker, targetKey, items, error, isCurrent, add, resolveInputs, restore, addAttachment, addFileMention, requireCurrent]);
}
