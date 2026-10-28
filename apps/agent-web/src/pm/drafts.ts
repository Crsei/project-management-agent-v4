import { useEffect, useRef, useState } from "react";
import { useAuiState, type AssistantRuntime } from "@assistant-ui/react";
import type { AgentScope } from "@agent-workspace/contracts/chat";
import { scopeKey } from "./state";

const PREFIX = "pm-v3:agent-draft:";
export function useChatDrafts(runtime: AssistantRuntime, scope?: AgentScope) {
  const localId = useAuiState((s) => s.threads.mainThreadId);
  const remoteId = useAuiState((s) => s.threads.threadItems.find((item) => item.id === s.threads.mainThreadId)?.remoteId);
  const [storageError, setStorageError] = useState<string>();
  const previous = useRef<{ localId: string; key: string } | null>(null);
  const key = remoteId ? `thread:${remoteId}` : scope ? `new:${scopeKey(scope)}` : `unscoped:${localId}`;
  useEffect(() => {
    const composer = runtime.threads.getById(localId).composer;
    try {
      if (previous.current?.localId === localId && previous.current.key !== key)
        sessionStorage.removeItem(PREFIX + previous.current.key);
      previous.current = { localId, key };
      const saved = sessionStorage.getItem(PREFIX + key);
      if (saved && !composer.getState().text) {
        const draft = JSON.parse(saved) as { text: string };
        if (typeof draft.text === "string") composer.setText(draft.text);
      }
    } catch {
      setStorageError("浏览器无法恢复草稿。请在离页前复制未发送内容。");
    }
    const save = () => {
      const draft = composer.getState();
      try {
        if (draft.text) sessionStorage.setItem(PREFIX + key, JSON.stringify({ text: draft.text }));
        else sessionStorage.removeItem(PREFIX + key);
      } catch {
        setStorageError("浏览器无法备份草稿。请在离页前复制未发送内容。");
      }
    };
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
      unsubscribe();
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [runtime, localId, key]);
  const protect = () => {
    const draft = runtime.thread.composer.getState();
    if (!draft.text.trim() && !draft.attachments.length && !draft.quote) return true;
    return window.confirm("当前会话有未发送草稿。文字会在此标签页保留；附件和引用请先发送或复制。仍要切换吗？后台生成不会取消。");
  };
  return { protect, storageError };
}
