import { useEffect, useReducer, useRef } from "react";
import { useAui } from "@assistant-ui/react";
import type { QueuedChatMessage } from "@agent-workspace/contracts/chat";
import { Button } from "@agent/components/ui/button";
import { useAgentText } from "../i18n";
import { EDIT_QUEUED_IN_COMPOSER_EVENT, updateQueuedDraft } from "./message-actions";
import {
  composerOperationError, composerQueueEditCandidate, reduceComposerQueueEdit,
  type ComposerOperationLock, type ComposerQueueEditState,
} from "./composer-actions-model";
import "./composer-queue-edit-ui.css";

export function useComposerQueueEdit(remoteId: string | undefined, operation: ComposerOperationLock) {
  const aui = useAui();
  const [stored, dispatch] = useReducer(reduceComposerQueueEdit, { status: "idle" });
  const state: ComposerQueueEditState = stored.status !== "idle" && stored.threadId !== remoteId ? { status: "idle" } : stored;
  const current = useRef(state);
  current.current = state;
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { dispatch({ type: "reset" }); }, [remoteId]);
  useEffect(() => {
    const edit = (event: Event) => {
      if (operation.current) return;
      const candidate = composerQueueEditCandidate(remoteId, (event as CustomEvent<{ threadId: string; row: QueuedChatMessage }>).detail);
      if (!candidate) return;
      const next = { status: "editing" as const, threadId: candidate.threadId, row: candidate.row };
      current.current = next;
      dispatch({ type: "begin", threadId: candidate.threadId, row: candidate.row });
      aui.composer.setText(candidate.text);
      requestAnimationFrame(() => document.querySelector<HTMLElement>(".rich-composer-editor")?.focus());
    };
    window.addEventListener(EDIT_QUEUED_IN_COMPOSER_EVENT, edit);
    return () => window.removeEventListener(EDIT_QUEUED_IN_COMPOSER_EVENT, edit);
  }, [aui, operation, remoteId]);

  const save = async (allowed: boolean) => {
    const editing = current.current;
    if (!allowed || !remoteId || editing.status !== "editing" || editing.threadId !== remoteId || operation.current) return;
    const text = aui.composer.getState().text;
    const token = { threadId: remoteId, kind: "queue-update" as const };
    operation.current = token;
    dispatch({ type: "save" });
    try {
      await updateQueuedDraft(remoteId, editing.row, text);
      if (!mounted.current || aui.threads.item("main").getState().remoteId !== remoteId) return;
      // The row is saved, not sent. Do not erase text typed during the request.
      if (aui.composer.getState().text === text) aui.composer.setText("");
      current.current = { status: "idle" };
      dispatch({ type: "saved" });
    } catch (cause) {
      if (mounted.current && aui.threads.item("main").getState().remoteId === remoteId)
        dispatch({ type: "failed", error: composerOperationError(cause) });
    } finally {
      if (operation.current === token) operation.current = null;
    }
  };
  const cancel = () => {
    if (operation.current || current.current.status === "updating") return;
    current.current = { status: "idle" };
    dispatch({ type: "cancel" });
  };
  return { state, active: state.status !== "idle", pending: state.status === "updating", save, cancel };
}

export function ComposerQueueEditStatus({ state, onCancel }: { state: ComposerQueueEditState; onCancel: () => void }) {
  const t = useAgentText();
  if (state.status === "idle") return null;
  return <section className="composer-queue-edit-status" aria-label={t("正在编辑队列消息", "Editing queued message")}>
    <div className="composer-queue-edit-heading">
      <p role="status">{state.status === "updating" ? t("正在更新队列…", "Updating queued message…") : t("正在编辑队列消息", "Editing queued message")}</p>
      <Button type="button" size="sm" variant="ghost" disabled={state.status === "updating"} onClick={onCancel}>{t("取消编辑", "Cancel editing")}</Button>
    </div>
    <p className="composer-queue-edit-note">{t("更新只保存原队列条目，不立即发送。取消保留当前文字，不恢复之前的草稿。", "Updating saves the original queue entry without sending it now. Cancel keeps the current text; it does not restore the previous draft.")}</p>
    {state.error && <p role="alert" className="composer-queue-edit-error">{state.error}</p>}
  </section>;
}
