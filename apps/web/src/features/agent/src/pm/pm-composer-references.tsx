import { ClipboardList } from "lucide-react";
import { useEffect, useState } from "react";
import { TooltipIconButton } from "@agent/components/assistant-ui/elements/tooltip-icon-button";
import { useAuiState } from "@assistant-ui/react";
import { turnContextSchema, type ExecutionPolicy, type TurnContext } from "@agent-workspace/contracts/pm-references";

import { useAgentText } from "../i18n";
import { PM_REFERENCE_LIMIT, usePmIssueWorkspace } from "./pm-issue-workspace";
import { PmReferenceTray } from "./pm-reference-tray";
import { workspaceClient } from "../network";

/**
 * Structured PM references for the next message. The tray only chips what the
 * transport already sends as `pmReferences`; nothing is injected as text.
 */
export function PmComposerReferences({ executionPath, chatOnly, executionPolicy }: {
  executionPath?: string; chatOnly?: boolean; executionPolicy?: ExecutionPolicy;
}) {
  const workspace = usePmIssueWorkspace();
  const t = useAgentText();
  return <section aria-label={t("本次消息的 PM 上下文", "PM context for this message")} className="space-y-1 px-2 py-1 text-xs">
    <div className="flex flex-wrap items-baseline justify-between gap-1"><strong>{t("本次消息的 PM 上下文", "PM context for this message")}</strong><span className="text-muted-foreground">{t("仅作用于当前消息", "This message only")}</span></div>
    <PmReferenceTray references={workspace.references} onRemove={workspace.removeReference} onClear={workspace.clearReferences} max={PM_REFERENCE_LIMIT} />
    {!workspace.references.length && <p className="text-muted-foreground">{t("未引用 PM 对象；会话不归属于任何 PM 项目。", "No PM references; this session does not belong to a PM project.")}</p>}
    <p className="break-all">{t("工作目录：", "Working directory: ")}<code>{chatOnly ? t("仅对话 · 无代码目录", "Chat only · no code directory") : executionPath ?? t("待服务端核验", "Awaiting server verification")}</code></p>
    <p role="status" className="text-muted-foreground">{executionPolicy
      ? t("新增许可：Full access · 仅记录和提醒，无需逐次放行。", "New policy: Full access · audit and notices only, no per-operation permission prompt.")
      : t("新增许可默认 Full access；执行受理后记录策略。", "New permissions default to Full access; policy is recorded at execution admission.")}</p>
    <p className="text-muted-foreground">{t("引用和目录不授予权限；实际 PM 操作仍由服务端核验既有身份与目标权限。", "References and directories grant no authority; the server still checks existing identity and target access.")}</p>
    {workspace.referenceError && <p role="alert" className="text-destructive">{workspace.referenceError}</p>}
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
  const visibility = view.key === key ? view.visibility : undefined;
  if (!references.length && visibility !== "redacted" && visibility !== "unavailable") return null;
  return <details className="mt-2 rounded-md border px-2 py-1 text-xs" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{t("本条消息的 PM 上下文", "PM context of this message")}</summary>
    {visibility === "redacted" && <p role="status">{t("部分或全部引用内容已不可访问。", "Some or all referenced content is no longer accessible.")}</p>}
    {visibility === "unavailable" && <p role="status">{t("暂时无法核验引用，请稍后重试。", "References cannot be verified right now. Try again later.")}</p>}
    <ul className="space-y-1 py-1">{references.map(reference => <li key={`${reference.workspaceId}:${reference.projectId}:${reference.kind}:${reference.id}`} className="break-all">
      <strong>{reference.title || reference.id}</strong> · <code>{reference.id}</code> · <code>{reference.revision ?? t("版本未知", "Unknown revision")}</code>
    </li>)}</ul>
    <p className="text-muted-foreground">{t("发送时冻结的引用；不是当前操作授权。", "References frozen at send time; not current operation authority.")}</p>
    {!!references.length && <button type="button" className="underline" onClick={() => workspace.reuseReferences(references)}>{t("复用到下一条消息", "Reuse in the next message")}</button>}
  </details>;
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
