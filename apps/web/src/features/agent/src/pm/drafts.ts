import { useEffect, useRef, useState } from "react";
import { useAuiState, type AssistantRuntime } from "@assistant-ui/react";
import type { AgentScope } from "@agent-workspace/contracts/chat";
import { scopeKey } from "./state";
import { agentText } from "../i18n-text.ts";

const PREFIX = "pm-v3:agent-draft:";
type ComposerDraft = ReturnType<AssistantRuntime["thread"]["composer"]["getState"]>;
const memoryDrafts = new Map<string, Pick<ComposerDraft, "text" | "quote" | "attachments">>();
export function useChatDrafts(runtime: AssistantRuntime, scope?: AgentScope) {
  const localId = useAuiState((s) => s.threads.mainThreadId);
  const remoteId = useAuiState((s) => s.threads.threadItems.find((item) => item.id === s.threads.mainThreadId)?.remoteId);
  const [storageError, setStorageError] = useState<string>();
  const previous = useRef<{ localId: string; key: string } | null>(null);
  const key = remoteId ? `thread:${remoteId}` : scope ? `new:${scopeKey(scope)}` : `unscoped:${localId}`;
  useEffect(() => {
    const composer = runtime.threads.getById(localId).composer;
    const previousOwner = previous.current;
    const sameThread = previousOwner?.localId === localId;
    let restoring = false;
    let cancelled = false;
    if (sameThread && previousOwner.key !== key) {
      memoryDrafts.delete(previousOwner.key);
      try { sessionStorage.removeItem(PREFIX + previousOwner.key); } catch { setStorageError(agentText("浏览器无法备份草稿。", "The browser could not back up the draft.")); }
    }
    previous.current = { localId, key };
    const memory = !sameThread ? memoryDrafts.get(key) : undefined;
    let saved: string | null = null;
    try { saved = sessionStorage.getItem(PREFIX + key); } catch { setStorageError(agentText("浏览器无法恢复持久文字草稿。", "The browser could not restore the saved draft text.")); }
    try {
      if (memory && !composer.getState().text && !composer.getState().attachments.length && !composer.getState().quote) {
        restoring = true;
        composer.setText(memory.text);
        composer.setQuote(memory.quote);
        void (async () => {
          try {
            for (const attachment of memory.attachments) {
              if (cancelled) return;
              if (attachment.content !== undefined) await composer.addAttachment({ ...attachment, content: attachment.content });
              else if (attachment.file) await composer.addAttachment(attachment.file);
            }
          } catch (error) {
            if (!cancelled) setStorageError(agentText(`无法恢复附件：${error instanceof Error ? error.message : String(error)}`, `Could not restore attachments: ${error instanceof Error ? error.message : String(error)}`));
          } finally {
            if (!cancelled) { restoring = false; save(); }
          }
        })();
      } else if (saved && !composer.getState().text) {
        const draft = JSON.parse(saved) as { text: string };
        if (typeof draft.text === "string") composer.setText(draft.text);
      }
    } catch {
      setStorageError(agentText("浏览器无法恢复草稿。请在离页前复制未发送内容。", "The browser could not restore the draft. Copy unsent content before leaving."));
    }
    function save() {
      if (restoring) return;
      const draft = composer.getState();
      if (draft.text || draft.quote || draft.attachments.length) memoryDrafts.set(key, { text: draft.text, quote: draft.quote, attachments: [...draft.attachments] });
      else memoryDrafts.delete(key);
      try {
        if (draft.text) sessionStorage.setItem(PREFIX + key, JSON.stringify({ text: draft.text }));
        else sessionStorage.removeItem(PREFIX + key);
      } catch {
        setStorageError(agentText("浏览器无法备份草稿。请在离页前复制未发送内容。", "The browser could not back up the draft. Copy unsent content before leaving."));
      }
    }
    const unsubscribe = composer.subscribe(save);
    save();
    const beforeUnload = (event: BeforeUnloadEvent) => {
      const draft = composer.getState();
      save();
      if (draft.text.trim() || draft.attachments.length || draft.quote) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      if (!restoring) save();
      cancelled = true;
      unsubscribe();
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [runtime, localId, key]);
  const protect = () => {
    const draft = runtime.thread.composer.getState();
    if (!draft.text.trim() && !draft.attachments.length && !draft.quote) return true;
    return window.confirm(agentText("当前会话有未发送草稿。文字可在此标签页恢复；附件和引用仅在同一页面会话中保留，刷新浏览器会丢失。仍要切换吗？后台生成不会取消。", "This session has an unsent draft. Text can be restored in this tab; attachments and references last only for this page session and are lost on reload. Switch anyway? Background generation continues."));
  };
  return { protect, storageError };
}
