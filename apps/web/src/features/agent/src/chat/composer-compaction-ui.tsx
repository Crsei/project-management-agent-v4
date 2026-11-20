import { useEffect, useRef, useState } from "react";
import { useAui } from "@assistant-ui/react";
import { Minimize2Icon } from "lucide-react";
import { Button } from "@agent/components/ui/button";
import { useAgentText } from "../i18n";
import { compactThread, readThreadCompaction } from "./compaction-client";
import {
  composerOperationError, executeComposerCompaction, reduceComposerCompaction,
  type ComposerCompactionControlsState, type ComposerCompactionEvent, type ComposerCompactionState, type ComposerOperationLock,
} from "./composer-actions-model";
import "./composer-compaction-ui.css";

const initialState: ComposerCompactionState = { phase: "idle", available: false };

export function useComposerCompaction(options: {
  remoteId: string | undefined;
  operation: ComposerOperationLock;
  running: boolean;
  latestGenerationId: string | undefined;
  blocked: boolean;
  sendBlocked: boolean;
  beforeSend: () => boolean;
}) {
  const aui = useAui();
  const t = useAgentText();
  const { remoteId, operation, running, latestGenerationId } = options;
  const [stored, setStored] = useState<{ threadId: string | undefined; state: ComposerCompactionState }>({ threadId: remoteId, state: initialState });
  const state = stored.threadId === remoteId ? stored.state : initialState;
  const live = useRef(options);
  live.current = options;
  const mounted = useRef(false);
  const availabilityRequest = useRef(0);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    setStored({ threadId: remoteId, state: initialState });
  }, [remoteId]);
  useEffect(() => {
    const request = ++availabilityRequest.current;
    if (!remoteId) return;
    void readThreadCompaction(remoteId).then(result => {
      if (!mounted.current || request !== availabilityRequest.current) return;
      setStored(previous => ({ threadId: remoteId, state: reduceComposerCompaction(previous.threadId === remoteId ? previous.state : initialState, { type: "availability", available: result.available }) }));
    }, () => {
      // An unreadable capability is not evidence for a guessed policy reason.
      if (mounted.current && request === availabilityRequest.current)
        setStored(previous => ({ threadId: remoteId, state: { ...(previous.threadId === remoteId ? previous.state : initialState), available: false } }));
    });
    return () => { ++availabilityRequest.current; };
  }, [remoteId, running, latestGenerationId, refresh]);

  const start = async (send: boolean) => {
    if (!remoteId || operation.current || !state.available || live.current.blocked || live.current.running || (send && live.current.sendBlocked)) return;
    const draft = aui.composer.getState();
    if (send && !draft.text.trim()) return;
    const token = { threadId: remoteId, kind: "compaction" as const };
    operation.current = token;
    ++availabilityRequest.current;
    const update = (event: ComposerCompactionEvent) => setStored(previous => ({ threadId: remoteId, state: reduceComposerCompaction(previous.threadId === remoteId ? previous.state : initialState, event) }));
    const isCurrent = () => mounted.current && aui.threads.item("main").getState().remoteId === remoteId;
    update({ type: "start" });
    try {
      const completed = await executeComposerCompaction({
        compact: () => compactThread(remoteId),
        isCurrent,
        onPhase: phase => update({ type: phase }),
        reload: async () => {
          try { await aui.threads.reloadMainThread(); }
          finally {
            // The existing reload mechanism replaces the runtime; restore the
            // preserved draft before any optional send, including on failure.
            if (isCurrent()) {
              aui.composer.setText(draft.text);
              aui.composer.setQuote(draft.quote);
              for (const attachment of draft.attachments) {
                if (aui.composer.getState().attachments.some(item => item.id === attachment.id)) continue;
                if (attachment.content !== undefined) await aui.composer.addAttachment({ ...attachment, content: attachment.content });
                else if (attachment.file) await aui.composer.addAttachment(attachment.file);
              }
            }
          }
        },
        ...(send ? { send: () => {
          const thread = aui.thread.getState();
          if (live.current.sendBlocked || thread.isRunning || thread.isLoading || thread.isDisabled || thread.isSendDisabled || live.current.beforeSend())
            throw new Error(t("上下文已压缩，但发送条件已变化；输入已保留，请核对后发送。", "Context was compacted, but sending conditions changed; the draft is kept for review and send."));
          aui.composer.send();
        } } : {}),
      });
      if (completed && isCurrent()) update({ type: "complete" });
    } catch (cause) {
      if (isCurrent()) {
        aui.composer.setText(draft.text);
        update({ type: "failed", error: composerOperationError(cause) });
      }
    } finally {
      if (operation.current === token) operation.current = null;
      if (isCurrent()) setRefresh(value => value + 1);
    }
  };
  return { state, pending: state.phase !== "idle", start };
}

export function ComposerCompactionControls({ controls, onCompact, onCompactAndSend }: {
  controls: ComposerCompactionControlsState;
  onCompact: () => void;
  onCompactAndSend: () => void;
}) {
  const t = useAgentText();
  if (!controls.visible) return null;
  return <div className="composer-compaction-controls" role="group" aria-label={t("上下文压缩", "Context compaction")}>
    <Button type="button" size="sm" variant="ghost" disabled={controls.disabled} onClick={onCompact}>
      <Minimize2Icon aria-hidden="true" />{t("压缩上下文", "Compact context")}
    </Button>
    {controls.showSend && <Button type="button" size="sm" variant="outline" disabled={controls.sendDisabled} onClick={onCompactAndSend}>{t("压缩并发送", "Compact and send")}</Button>}
  </div>;
}

export function ComposerCompactionStatus({ state }: { state: ComposerCompactionState }) {
  const t = useAgentText();
  if (state.error) return <p role="alert" className="composer-compaction-error">{state.error}</p>;
  const message = state.phase === "compacting" ? t("正在压缩上下文，等待原生回合完成…", "Compacting context; waiting for the native turn to finish…")
    : state.phase === "reloading" ? t("压缩已完成，正在重新读取会话…", "Compaction finished; reloading the session…")
      : state.phase === "sending" ? t("正在发送保留的输入…", "Sending the preserved draft…")
        : state.completed ? t("上下文已压缩；原生压缩回合已重新载入。", "Context compacted; the native compaction turn has been reloaded.") : undefined;
  return message ? <p role="status" className="composer-compaction-status">{message}</p> : null;
}
