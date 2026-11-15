import { ClipboardList } from "lucide-react";
import { useEffect, useState } from "react";
import { TooltipIconButton } from "@agent/components/assistant-ui/elements/tooltip-icon-button";
import { useAuiState } from "@assistant-ui/react";
import { turnContextSchema, type TurnContext } from "@agent-workspace/contracts/pm-references";

import { useAgentText } from "../i18n";
import { usePmIssueWorkspace } from "./pm-issue-workspace";
import { PmContextChip } from "./pm-reference-tray";
import { AcceptedMessageContexts } from "../chat/context-presentation";
import { useMessageContextDraft } from "../chat/message-context";
import { workspaceClient } from "../network";

/**
 * Structured PM references for the next message. The composer renders only the
 * chips for references the transport already sends as `pmReferences`; no
 * explanatory context copy is displayed above the input.
 */
export function PmComposerReferences() {
  const workspace = usePmIssueWorkspace();
  const t = useAgentText();
  const draft = useMessageContextDraft();
  if (!workspace.referenceError && !draft.error) return null;
  return <section aria-label={t("消息上下文错误", "Message context errors")} className="space-y-1 px-2 py-1 text-xs">
    {workspace.referenceError && <p role="alert" className="text-destructive">{workspace.referenceError}</p>}
    {draft.error && <p role="alert" className="text-destructive">{draft.error}</p>}
  </section>;
}

export function PmMessageContext() {
  const raw = useAuiState(state => state.message.metadata.custom.turnContext);
  const rawVisibility = useAuiState(state => state.message.metadata.custom.pmVisibility);
  const threadId = useAuiState(state => state.threadListItem.remoteId);
  const messageId = useAuiState(state => state.message.id);
  const t = useAgentText();
  const workspace = usePmIssueWorkspace();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<{ key: string; context?: TurnContext; visibility?: "visible" | "redacted" | "unavailable" }>({ key: "" });
  const key = JSON.stringify([threadId, messageId]);
  useEffect(() => {
    setView(previous => rawVisibility === "redacted" || rawVisibility === "unavailable" ? { key, visibility: rawVisibility } : previous.key === key ? previous : { key });
    if (!threadId) return;
    const controller = new AbortController();
    let running = false;
    let dirty = false;
    const refresh = async () => {
      if (running) { dirty = true; return; }
      running = true;
      try {
        const response = await workspaceClient.fetch(`/api/chat/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}/context`, { signal: controller.signal });
        if (response.status === 404 && raw === undefined) {
          if (!controller.signal.aborted) setView({ key });
          return;
        }
        if (!response.ok) throw new Error("Context unavailable");
        const body = await response.json() as { turnContext?: unknown; visibility?: unknown };
        const context = body.turnContext === undefined ? undefined : turnContextSchema.parse(body.turnContext);
        if (context && (context.threadId !== threadId || context.messageId !== messageId)) throw new Error("Context identity mismatch");
        if (body.visibility !== "visible" && body.visibility !== "redacted" && body.visibility !== "unavailable") throw new Error("Context visibility missing");
        if (!controller.signal.aborted) setView({ key, context, visibility: body.visibility });
      } catch {
        if (!controller.signal.aborted) setView({ key, visibility: "unavailable" });
      } finally {
        running = false;
        if (dirty && !controller.signal.aborted) { dirty = false; void refresh(); }
      }
    };
    const accepted = (event: Event) => {
      const detail = (event as CustomEvent<{ threadId: string; messageId: string }>).detail;
      if (detail.threadId === threadId && detail.messageId === messageId) void refresh();
    };
    const focus = () => { setView({ key }); void refresh(); };
    void refresh();
    window.addEventListener("pm-turn-accepted", accepted);
    window.addEventListener("focus", focus);
    const interval = open ? window.setInterval(() => void refresh(), 10_000) : undefined;
    return () => {
      controller.abort(); window.removeEventListener("pm-turn-accepted", accepted); window.removeEventListener("focus", focus);
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, [key, threadId, messageId, raw, rawVisibility, open]);
  const references = view.key === key ? view.context?.pmReferences ?? [] : [];
  const contextItems = view.key === key ? view.context?.contextItems ?? [] : [];
  const visibility = view.key === key ? view.visibility : undefined;
  if (!references.length && !contextItems.length && visibility !== "redacted" && visibility !== "unavailable") return null;
  return <section className="mt-2 space-y-1 text-xs" aria-label={t("本条消息的上下文", "Context of this message")}>
    {visibility === "redacted" && <p role="status">{t("部分或全部引用内容已不可访问。", "Some or all referenced content is no longer accessible.")}</p>}
    {visibility === "unavailable" && <p role="status">{t("暂时无法核验引用，请稍后重试。", "References cannot be verified right now. Try again later.")}</p>}
    {visibility === "visible" && <><div className="flex flex-wrap items-start gap-2">{references.map(reference => <PmContextChip key={`${reference.workspaceId}:${reference.projectId}:${reference.kind}:${reference.id}`} reference={reference} />)}</div><AcceptedMessageContexts items={contextItems} /></>}
    {visibility !== "visible" && <AcceptedMessageContexts items={contextItems.filter(item => item.visibility === "unavailable")} />}
    <button type="button" className="text-muted-foreground underline" aria-expanded={open} onClick={() => setOpen(!open)}>{t("上下文来源", "Context provenance")}</button>
    {open && <div className="space-y-1 text-muted-foreground"><p>{t("发送时冻结的引用；不是当前操作授权。PM 引用仅保存来源与版本，不伪造历史正文。", "References frozen at acceptance; not current operation authority. PM references retain source and revision, not a fabricated historical body.")}</p><p>{view.context?.acceptedAt}</p></div>}
    {!!references.length && visibility === "visible" && <button type="button" className="ml-2 underline" onClick={() => workspace.reuseReferences(references)}>{t("复用到下一条消息", "Reuse in the next message")}</button>}
  </section>;
}

/** Opens the same issue picker used by the rest of the PM workspace. */
export function PmComposerReferenceAction() {
  const t = useAgentText();
  const workspace = usePmIssueWorkspace();
  return <TooltipIconButton
    type="button"
    tooltip={t("引用任务", "Reference tasks")}
    aria-label={t("引用任务", "Reference tasks")}
    aria-haspopup="dialog"
    aria-expanded={workspace.pickerOpen}
    onClick={workspace.openPicker}
    className="size-7 rounded-full text-muted-foreground hover:text-foreground"
  >
    <ClipboardList aria-hidden="true" className="size-4" />
  </TooltipIconButton>;
}
