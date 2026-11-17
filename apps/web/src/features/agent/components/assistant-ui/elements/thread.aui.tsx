import {
  ComposerAddAttachment,
  UserMessageAttachments,
} from "@agent/components/assistant-ui/elements/attachment.aui";
import { MarkdownText } from "@agent/components/assistant-ui/elements/markdown-text";
import {
  QuoteBlock,
  SelectionToolbar,
} from "@agent/components/assistant-ui/elements/quote.aui";
import { ToolFallback } from "@agent/components/assistant-ui/elements/tool-fallback.aui";
import { ComposerModelPicker, type ComposerModelPickerCatalog } from "@agent/components/assistant-ui/elements/composer-model-picker.aui";
import { ComposerTraitsPicker } from "@agent/components/assistant-ui/elements/composer-traits-picker.aui";
import { TooltipIconButton } from "@agent/components/assistant-ui/elements/tooltip-icon-button";
import { Button } from "@agent/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@agent/components/ui/collapsible";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { ProviderOptionSelection } from "@agent-workspace/contracts/provider";
import { resolveProviderModelSelection } from "@agent-workspace/client-runtime/providers";
import { cn } from "@agent/lib/utils";
import { useChatBrowserPreferences } from "@agent/src/settings/browser-preferences";
import { useAgentText } from "@agent/src/i18n";
import { CancelGeneration } from "@agent/src/chat/cancel-generation";
import { ContextMeter } from "@agent/src/chat/context-meter";
import { useGenerationRecords, useMessageTimes } from "@agent/src/chat/generation-times";
import { useGenerationOutput } from "@agent/src/chat/output-stream";
import { nativeContextSourceAnchor } from "@agent/src/chat/context-source-navigation";
import { COMPOSER_PROMPT_LIMIT, composerPromptTooLong } from "@agent/src/chat/composer-limit";
import { ThreadFind } from "@agent/src/chat/thread-find";
import "@agent/src/chat/composer-shell.css";
import { ThreadMinimap } from "@agent/src/chat/thread-minimap";
import { ThreadStatusLine } from "@agent/src/chat/thread-status-line";
import { OutputTimeline } from "@agent/src/chat/output-timeline";
import { useHistoryLoadOutcome } from "@agent/src/chat/remote-adapter";
import { PmMessageContext } from "@agent/src/pm/pm-composer-references";
import { ComposerUsage } from "@agent/src/usage/ComposerUsage";
import { consumeUsageLimitsCommand } from "@agent/src/usage/ComposerUsageModel";
import { useComposerSuggestions } from "@agent/src/chat/composer-suggestions";
import { RichComposerInput } from "@agent/src/chat/rich-composer";
import { ComposerDraftActions } from "@agent/src/chat/composer-draft-actions";
import { QueuedMessages, ThreadMessageActions } from "@agent/src/chat/message-actions";
import { ComposerPendingRequests } from "@agent/src/chat/composer-pending-requests";
import { ThreadHistoryMessage, ThreadHistoryNavigation } from "@agent/src/chat/history-navigation";
import { MessageContextEditProvider, useMessageContextDraft } from "@agent/src/chat/message-context";
import { turnContextSchema, type TurnContext } from "@agent-workspace/contracts/pm-references";
import { workspaceClient } from "@agent/src/network";
import { MessageContextDraftStatus } from "@agent/src/chat/context-presentation";
import { usePmIssueWorkspace } from "@agent/src/pm/pm-issue-workspace";
import { UserContextText } from "@agent/src/chat/user-context-text";
import { getEditedContextReferences, getMessageContextItems, prepareMessageContextDraftSubmission, prepareMessageContextEditSubmission, subscribeMessageContext } from "@agent/src/chat/message-context-store";
import { getExternalStoreMessages } from "@assistant-ui/core";
import type { UIMessage } from "ai";
import { canonicalContextAttachments, readContextAttachmentBindings } from "@agent/src/chat/context-attachments";
import {
  ActionBarMorePrimitive,
  ActionBarPrimitive,
  AuiIf,
  BranchPickerPrimitive,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  SuggestionPrimitive,
  ThreadPrimitive,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import {
  ArrowDownIcon,
  ArrowLeftRightIcon,
  ArrowUpIcon,
  AudioLinesIcon,
  BrainIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  MicIcon,
  MoreHorizontalIcon,
  PencilIcon,
  CircleAlertIcon,
  RefreshCwIcon,
  RouteIcon,
  SquareIcon,
  MessageSquareReplyIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type FC, type ReactElement, type ReactNode } from "react";
import { useI18n } from "@/lib/i18n-provider";
import styles from "./composer-layout.module.css";
import "@agent/src/chat/thread-message.css";


const ThreadHistorySkeleton: FC = () => (
  <div
    data-slot="aui_thread-history-skeleton"
    role="status"
    className="animate-in fade-in fill-mode-both flex flex-col [animation-delay:150ms] [animation-duration:200ms]"
  >
    <span className="sr-only">Loading conversation</span>
    <div className="flex animate-pulse flex-col gap-y-6 motion-reduce:animate-none">
      <div className="bg-muted ml-auto h-9 w-2/5 rounded-xl" />
      <div className="flex flex-col gap-y-2">
        <div className="bg-muted h-4 w-11/12 rounded-md" />
        <div className="bg-muted h-4 w-4/5 rounded-md" />
        <div className="bg-muted h-4 w-3/5 rounded-md" />
      </div>
      <div className="bg-muted ml-auto h-9 w-1/3 rounded-xl" />
      <div className="flex flex-col gap-y-2">
        <div className="bg-muted h-4 w-10/12 rounded-md" />
        <div className="bg-muted h-4 w-2/3 rounded-md" />
      </div>
    </div>
  </div>
);

export type ThreadProps = {
  providerInstanceId: string;
  model: string;
  onModelChange: (providerInstanceId: string, model: string) => void | Promise<void>;
  modelOptions?: ProviderOptionSelection[];
  interactionMode?: "default" | "plan";
  onSettingsChange?: (settings: { modelOptions?: ProviderOptionSelection[]; interactionMode?: "default" | "plan" }) => Promise<void>;
  catalog: ComposerModelPickerCatalog;
  disabled?: boolean;
  saving?: boolean;
  saveError?: string;
  onRetry?: () => void | Promise<void>;
  composerLeading?: ReactNode;
  composerActions?: ReactNode;
  welcome?: { title: string; alternateLabel?: string; onAlternate?: () => void; freshlyCreated?: boolean };
  sendUnavailable?: boolean;
  sendIssue?: string;
  onOpenSessionSettings?: () => void;
};

const PlanReadyBanner: FC<{ generationId: string }> = ({ generationId }) => {
  const t = useAgentText();
  const { snapshot } = useGenerationOutput(generationId);
  const plan = snapshot?.items.find(item => item.type === "proposed_plan" && item.visibility !== "redacted" && item.visibility !== "unavailable");
  if (!plan || snapshot?.status !== "completed") return null;
  return <div className="plan-ready-banner" role="status">
    <RouteIcon aria-hidden="true" />
    <span>{t("计划已就绪", "Plan ready")}</span>
    {plan.title && <span className="plan-ready-title" title={plan.title}>{plan.title}</span>}
    <button type="button" onClick={() => document.getElementById(nativeContextSourceAnchor(generationId, plan.id))?.scrollIntoView({ block: "center", behavior: "smooth" })}>{t("查看计划", "View plan")}</button>
  </div>;
};

export const Thread: FC<ThreadProps> = (props) => {
  const t = useAgentText();
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const isDraft = useAuiState((s) => s.threads.threadItems.find((item) => item.id === s.threads.mainThreadId)?.status === "new");
  const remoteId = useAuiState((s) => s.threads.threadItems.find((item) => item.id === s.threads.mainThreadId)?.remoteId);
  const messagesEmpty = useAuiState((s) => s.thread.messages.length === 0);
  const latestGenerationId = useAuiState((state) => {
    for (let index = state.thread.messages.length - 1; index >= 0; index--) {
      const message = state.thread.messages[index]!;
      if (message.role !== "assistant") continue;
      const durable = (message.metadata as { custom?: { durable?: { nativeOutput?: unknown; generationId?: unknown } } } | undefined)?.custom?.durable;
      if (durable?.nativeOutput === true && typeof durable.generationId === "string") return durable.generationId;
    }
    return undefined;
  });
  const threadLoading = useAuiState((s) => s.thread.isLoading);
  const threadRunning = useAuiState((s) => s.thread.isRunning);
  const history = useHistoryLoadOutcome(threadId);
  const historyError = useAuiState((s) => s.threads.loadError !== undefined || s.threads.switchError !== undefined);
  // Saving settings can initialize a new thread before its first message. Keep
  // its welcome until it is left or a remote history reload begins.
  const draft = useRef({ id: threadId, startedNew: isDraft });
  if (draft.current.id !== threadId) draft.current = { id: threadId, startedNew: isDraft };
  else if (isDraft) draft.current.startedNew = true;
  else if (threadLoading) draft.current.startedNew = false;
  const emptyRemoteHistory = !!remoteId && history.status === "loaded" && history.messageCount === 0;
  const isEmpty = (draft.current.startedNew || props.welcome?.freshlyCreated === true || emptyRemoteHistory) &&
    messagesEmpty && !historyError && history.status !== "error" &&
    (!threadLoading || isDraft);
  const historyMissing = history.status === "loaded" && history.messageCount > 0 && messagesEmpty && !threadLoading && !threadRunning;
  const composerText = useAuiState((state) => state.composer.text);
  const composerAttachmentCount = useAuiState((state) => state.composer.attachments.length);
  const [composerFocused, setComposerFocused] = useState(false);
  const [nearBottom, setNearBottom] = useState(true);
  const [resting, setResting] = useState(false);
  useEffect(() => {
    const viewport = document.querySelector<HTMLElement>('[data-slot="aui_thread-viewport"]');
    if (!viewport) return;
    const update = () => setNearBottom(viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 320);
    update();
    viewport.addEventListener("scroll", update, { passive: true });
    const resize = new ResizeObserver(update);
    resize.observe(viewport);
    return () => { viewport.removeEventListener("scroll", update); resize.disconnect(); };
  }, []);
  const canRest = !messagesEmpty && !composerFocused && composerText.length === 0 && composerAttachmentCount === 0 && !nearBottom;
  useEffect(() => { setResting(canRest); }, [canRest]);
  const [announcement, setAnnouncement] = useState("");
  const previousRunning = useRef(threadRunning);
  useEffect(() => {
    const wasRunning = previousRunning.current;
    previousRunning.current = threadRunning;
    if (threadRunning && !wasRunning) setAnnouncement(t("助手正在工作。", "The assistant is working."));
    else if (!threadRunning && wasRunning) setAnnouncement(t("助手已停止工作。", "The assistant stopped working."));
  }, [threadRunning, t]);
  useEffect(() => {
    if (threadLoading) setAnnouncement(t("正在读取会话历史。", "Loading session history."));
  }, [threadLoading, t]);

  return (
    <ThreadPrimitive.Root
      className="aui-root aui-thread-root bg-surface @container relative flex h-full flex-col"
      style={{
        // Reading width follows the browser's chat appearance preference.
        ["--thread-max-width" as string]: "var(--agent-chat-content-width, 720px)",
        ["--bubble-max-width" as string]: "560px",
        ["--composer-bg" as string]: "color-mix(in oklab, var(--color-card) 92%, transparent)",
        ["--composer-radius" as string]: "var(--radius-composer)",
        ["--bubble-radius" as string]: "var(--radius-bubble)",
        ["--composer-padding" as string]: "10px",
        // 略抬升表面 + 一层轻阴影，顶边微光；不透明，避免在任意背景上失去可读性
        ["--composer-shadow" as string]: "var(--shadow-composer)",
      }}
    >
      <div className="sr-only" role="status" aria-live="polite">{announcement}</div>
      <ThreadHistoryNavigation />
      {(props.saveError || props.catalog.error || (remoteId && props.sendUnavailable)) && <div className="thread-notice-lane" role="alert">
        <CircleAlertIcon aria-hidden="true" />
        <span>{props.saveError || props.catalog.error || props.sendIssue || t("当前会话还不能发送；检查 Provider、模型与执行环境。", "This session cannot send yet; check the Provider, model and execution environment.")}</span>
        {props.saveError ? <button type="button" onClick={() => void props.onRetry?.()}>{t("重试保存", "Retry save")}</button>
          : props.catalog.error ? <button type="button" onClick={() => void props.catalog.refresh()}>{t("刷新模型目录", "Refresh models")}</button>
            : props.onOpenSessionSettings ? <button type="button" onClick={props.onOpenSessionSettings}>{t("检查会话参数", "Check session settings")}</button> : null}
      </div>}
      <ThreadPrimitive.Viewport
        autoScroll
        turnAnchor="top"
        data-slot="aui_thread-viewport"
        className="relative flex flex-1 flex-col overflow-x-auto overflow-y-scroll scroll-smooth"
      >
        <div
          className={cn(
            "mx-auto flex w-full max-w-(--thread-max-width) flex-1 flex-col px-6 pt-6",
            isEmpty && "justify-center",
          )}
        >
          {isEmpty && <ThreadWelcome welcome={props.welcome} />}
          {!isEmpty && messagesEmpty && threadLoading && !isDraft && <ThreadHistorySkeleton />}
          {(history.status === "error" || historyMissing) && <div role="alert" className={styles.historyError}>
            <span>
              {history.status === "error"
                ? t(`会话历史读取失败：${history.message}。发送已暂停。`, `Failed to load session history: ${history.message}. Sending is paused.`)
                : t("服务端返回了历史消息，但界面未能恢复。发送已暂停。", "The server returned history messages, but the interface could not restore them. Sending is paused.")}
            </span>
            <span>
              {t("刷新将重新读取历史。未发送文字草稿遵循现有恢复机制，附件和引用可能丢失；有未发送文字、附件或选中文字引用时浏览器会提示。", "Refreshing reloads history. Unsent text drafts follow the existing recovery mechanism; attachments and quotes may be lost, and the browser will warn when there is unsent text, an attachment, or a selected-text quote.")}
            </span>
            <button type="button" onClick={() => window.location.reload()}>{t("刷新重试", "Refresh and retry")}</button>
          </div>}

          {!isEmpty && <ThreadStatusLine />}
          <div data-slot="aui_message-group" className="mb-16 flex flex-col gap-y-7 empty:hidden">
            <ThreadPrimitive.Messages>{() => <ThreadHistoryMessage><ThreadMessage
              providerInstanceId={props.providerInstanceId}
              actionsDisabled={!!props.disabled || !!props.saving || !!props.saveError || !!props.sendUnavailable || history.status === "error" || historyMissing}
            /></ThreadHistoryMessage>}</ThreadPrimitive.Messages>
          </div>

          <ThreadPrimitive.ViewportFooter
            data-resting={resting || undefined}
            onFocusCapture={() => setComposerFocused(true)}
            onBlurCapture={() => setComposerFocused(false)}
            className={cn(
              "aui-thread-viewport-footer bg-surface flex flex-col gap-4 overflow-visible pb-4 md:pb-6",
              !isEmpty && "sticky bottom-0 mt-auto rounded-t-(--composer-radius)",
            )}
          >
            <ThreadScrollToBottom />
            <div className={styles.contextPanels}>
              {latestGenerationId && <PlanReadyBanner key={latestGenerationId} generationId={latestGenerationId} />}
              <ComposerPendingRequests />
              {remoteId && <QueuedMessages key={remoteId} threadId={remoteId} />}
            </div>
            {resting && <button type="button" className="thread-resting-composer" onClick={() => {
              setResting(false);
              requestAnimationFrame(() => document.querySelector<HTMLElement>(".rich-composer-editor")?.focus());
            }}><PencilIcon aria-hidden="true" /><span>{t("继续输入…", "Reply…")}</span></button>}
            <Composer {...props} historyBlocked={history.status === "error" || historyMissing} />
            {isEmpty && <AuiIf condition={(s) => s.composer.isEmpty}>
              <ThreadSuggestions />
            </AuiIf>}
          </ThreadPrimitive.ViewportFooter>
        </div>
      </ThreadPrimitive.Viewport>
      <ThreadMinimap />
      <SelectionToolbar />
      <ThreadFind />
    </ThreadPrimitive.Root>
  );
};

const ThreadMessage: FC<{ providerInstanceId: string; actionsDisabled: boolean }> = ({ providerInstanceId, actionsDisabled }) => {
  const role = useAuiState((s) => s.message.role);
  const isEditing = useAuiState((s) => s.message.composer.isEditing);
  const runtimeBlocked = useAuiState((s) => s.thread.isRunning || s.thread.isLoading || s.thread.isDisabled || s.thread.isSendDisabled || s.thread.voice !== undefined);
  const disabled = actionsDisabled || runtimeBlocked;

  if (isEditing) return <EditMessageContextBoundary><EditComposer providerInstanceId={providerInstanceId} disabled={disabled} /></EditMessageContextBoundary>;
  if (role === "user") return <UserMessage actionsDisabled={disabled} />;
  return <AssistantMessage actionsDisabled={disabled} />;
};

const EditMessageContextBoundary: FC<{ children: ReactNode }> = ({ children }) => {
  const t = useAgentText();
  const threadId = useAuiState(state => state.threadListItem.remoteId);
  const messageId = useAuiState(state => state.message.id);
  const [binding, setBinding] = useState<{ key: string; context?: TurnContext; error?: string }>();
  const key = JSON.stringify([threadId, messageId]);
  useEffect(() => {
    if (!threadId) return;
    const controller = new AbortController();
    void workspaceClient.fetch(`/api/chat/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}/context`, { signal: controller.signal }).then(async response => {
      if (response.status === 404) { if (!controller.signal.aborted) setBinding({ key }); return; }
      if (!response.ok) throw new Error("Message context cannot be authorized.");
      const body = await response.json() as { turnContext?: unknown; visibility?: string };
      if (body.visibility !== "visible") throw new Error("Message context is missing or no longer accessible. The original draft is unchanged.");
      const context = body.turnContext === undefined ? undefined : turnContextSchema.parse(body.turnContext);
      if (context && (context.threadId !== threadId || context.messageId !== messageId || context.contextItems?.some(item => item.visibility !== "available"))) throw new Error("Message context is unavailable; editing cannot silently drop it.");
      if (!controller.signal.aborted) setBinding({ key, context });
    }).catch(cause => { if (!controller.signal.aborted) setBinding({ key, error: String(cause) }); });
    return () => controller.abort();
  }, [threadId, messageId, key]);
  if (!threadId || binding?.key !== key) return <p role="status">{t("核验原消息上下文…", "Checking original message context…")}</p>;
  if (binding.error) return <div role="alert" className="text-sm text-destructive">{binding.error}<ComposerPrimitive.Cancel asChild><Button variant="ghost">{t("取消编辑", "Cancel edit")}</Button></ComposerPrimitive.Cancel></div>;
  return <MessageContextEditProvider threadId={threadId} messageId={messageId} items={binding.context?.contextItems ?? []} references={binding.context?.pmReferences ?? []}>{children}</MessageContextEditProvider>;
};

const ResponseReferenceAction: FC = () => {
  const draft = useMessageContextDraft();
  const threadId = useAuiState(state => state.threadListItem.remoteId);
  const messageId = useAuiState(state => state.message.id);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  return <><TooltipIconButton type="button" tooltip="Reply to this response" disabled={!draft.available || !threadId || pending} onClick={() => {
    if (!threadId) return;
    setPending(true); setError(undefined);
    void draft.add({ contextId: crypto.randomUUID(), kind: "response", source: { type: "response", threadId, messageId } }).catch(cause => { if (draft.isCurrent()) setError(String(cause)); }).finally(() => { if (draft.isCurrent()) setPending(false); });
  }}><MessageSquareReplyIcon /></TooltipIconButton>{error && <span role="alert" className="text-xs text-destructive">{error}</span>}</>;
};


const ThreadScrollToBottom: FC = () => {
  const t = useAgentText();
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <button
        type="button"
        data-slot="aui_thread-new-content"
        className="aui-thread-scroll-to-bottom border-border bg-card text-foreground hover:bg-accent absolute -top-12 z-10 inline-flex items-center gap-1.5 self-center rounded-full border px-3 py-1.5 text-xs shadow-[0_1px_2px_rgb(0_0_0/6%)] transition-colors duration-[var(--motion-button)] ease-out disabled:invisible motion-reduce:transition-none"
      >
        <ArrowDownIcon className="size-3.5" />
        <AuiIf condition={(s) => s.thread.isRunning}>
          <span>{t("有新内容", "New content")}</span>
        </AuiIf>
        <span className="sr-only">{t("滚动到底部", "Scroll to bottom")}</span>
      </button>
    </ThreadPrimitive.ScrollToBottom>
  );
};

const ThreadWelcome: FC<{ welcome?: ThreadProps["welcome"] }> = ({ welcome }) => {
  const t = useAgentText();
  return (
    <div className={cn("aui-thread-welcome-root", styles.welcome)}>
      <p className={cn("aui-thread-welcome-message-inner fade-in slide-in-from-bottom-1 animate-in fill-mode-both text-2xl font-medium tracking-tight duration-200", styles.welcomeTitle)}>
        {welcome?.title ?? t("今天想一起完成什么？", "What would you like to get done together today?")}
      </p>
      {welcome?.alternateLabel && welcome.onAlternate && <button type="button" className={styles.alternate} onClick={welcome.onAlternate}>
        {welcome.alternateLabel}
      </button>}
    </div>
  );
};

const ThreadSuggestions: FC = () => {
  return (
    <div className="aui-thread-welcome-suggestions flex w-full flex-col">
      <ThreadPrimitive.Suggestions>{() => <ThreadSuggestionItem />}</ThreadPrimitive.Suggestions>
    </div>
  );
};

const ThreadSuggestionItem: FC = () => {
  return (
    <div className="aui-thread-welcome-suggestion-display fade-in slide-in-from-bottom-2 animate-in fill-mode-both duration-200">
      <SuggestionPrimitive.Trigger send asChild>
        <button
          type="button"
          className="aui-thread-welcome-suggestion group hover:bg-foreground/[0.03] flex w-full items-baseline gap-2.5 rounded-md px-2 py-2 text-start text-sm transition-colors outline-none motion-reduce:transition-none"
        >
          <span
            aria-hidden
            className="text-muted-foreground/60 group-hover:text-foreground font-mono text-xs transition-colors motion-reduce:transition-none"
          >
            {">"}
          </span>
          <span className="min-w-0 flex-1 truncate">
            <SuggestionPrimitive.Title className="aui-thread-welcome-suggestion-text-1 text-foreground" />{" "}
            <SuggestionPrimitive.Description className="aui-thread-welcome-suggestion-text-2 text-muted-foreground empty:hidden" />
          </span>
        </button>
      </SuggestionPrimitive.Trigger>
    </div>
  );
};

const Composer: FC<ThreadProps & { historyBlocked: boolean }> = (props) => {
  const t = useAgentText();
  const { preferences } = useChatBrowserPreferences();
  const aui = useAui();
  const threadId = useAuiState((state) => state.threads.mainThreadId);
  const threadRunning = useAuiState((state) => state.thread.isRunning);
  const quotePending = useAuiState(state => !!state.composer.quote);
  const submitting = useAuiState(state => state.composer.submission !== undefined);
  const contextDraft = useMessageContextDraft();
  const pmWorkspace = usePmIssueWorkspace();
  const [limitsRequest, setLimitsRequest] = useState(0);
  const suggestions = useComposerSuggestions(props.providerInstanceId, !!props.disabled || props.historyBlocked);
  const handleUsageCommand = () => consumeUsageLimitsCommand(aui.composer, () => setLimitsRequest((request) => request + 1));
  const handleSendCommand = () => {
    const composer = aui.composer.getState();
    const thread = aui.thread.getState();
    if (composer.submission !== undefined || thread.isRunning || thread.isDisabled || thread.isLoading || thread.isSendDisabled) return true;
    if (handleUsageCommand() || !suggestions.beforeSend()) return true;
    prepareMessageContextDraftSubmission(threadId, composer.attachments);
    return false;
  };
  const actionsBlocked = !!props.disabled || !!props.saving || !!props.saveError || !!props.sendUnavailable || props.historyBlocked || suggestions.blocked || quotePending || contextDraft.blocked || submitting;
  return (
    <ComposerPrimitive.Root className="aui-composer-root relative flex w-full flex-col" onSubmit={(event) => {
      if (composerPromptTooLong(aui.composer.getState().text)) { event.preventDefault(); return; }
      if (actionsBlocked || threadRunning || handleSendCommand()) { event.preventDefault(); return; }
      const composer = aui.composer.getState();
      if (!composer.text.trim() && !composer.attachments.length && (contextDraft.items.length || pmWorkspace.references.length)) {
        event.preventDefault();
        const thread = aui.thread.getState();
        if (!thread.isDisabled && !thread.isLoading && !thread.isSendDisabled) aui.thread.append({ role: "user", content: [{ type: "text", text: composer.text }] });
      }
    }}>
      <ComposerPrimitive.AttachmentDropzone asChild>
        <div
          data-slot="aui_composer-shell"
          style={{ backdropFilter: "blur(12px) saturate(1.08)", WebkitBackdropFilter: "blur(12px) saturate(1.08)" }}
          className="aui-composer-surface border-border data-[dragging=true]:border-ring flex w-full cursor-text flex-col gap-2 rounded-(--composer-radius) border bg-(--composer-bg) p-(--composer-padding) shadow-[var(--composer-shadow)] transition-[border-color] duration-[var(--motion-hover)] data-[dragging=true]:border-dashed data-[dragging=true]:bg-[color-mix(in_oklab,var(--color-accent)_50%,var(--color-background))]"
        >
          {props.composerLeading}
          {suggestions.surface}
          <RichComposerInput
            suggestions={suggestions}
            placeholder={t("输入消息… 使用 @ 引用文件、$ 引用 Skill、/ 调用命令", "Type a message… use @ for files, $ for skills, / for commands")}
            label={t("消息输入", "Message input")}
            submitMode={preferences.sendShortcut}
            disabled={!!props.disabled}
            beforeSend={() => actionsBlocked || threadRunning || handleSendCommand()}
          />
          <ComposerDraftActions key={threadId} disabled={actionsBlocked} />
          <ComposerAction {...props} historyBlocked={actionsBlocked || threadRunning} onUsageCommand={handleSendCommand} />
          <ComposerUsage providerInstanceId={props.providerInstanceId} limitsRequest={limitsRequest} onCloseLimits={() => setLimitsRequest(0)} />
        </div>
      </ComposerPrimitive.AttachmentDropzone>
    </ComposerPrimitive.Root>
  );
};

const ComposerAction: FC<ThreadProps & { historyBlocked: boolean; onUsageCommand: () => boolean }> = ({ providerInstanceId, model, modelOptions, interactionMode, onSettingsChange, onModelChange, catalog, disabled, saving, saveError, onRetry, composerActions, historyBlocked, onUsageCommand }) => {
  const t = useAgentText();
  const aui = useAui();
  const prompt = useAuiState((state) => state.composer.text);
  const { preferences } = useChatBrowserPreferences();
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const threadBusy = useAuiState((s) => s.thread.isRunning || s.thread.isLoading || s.threads.isLoading);
  const contextDraft = useMessageContextDraft();
  const pmWorkspace = usePmIssueWorkspace();
  const emptyComposer = useAuiState(state => !state.composer.text.trim() && !state.composer.attachments.length && !state.composer.quote);
  const contextOnly = emptyComposer && (contextDraft.items.length > 0 || pmWorkspace.references.length > 0);
  const selection = resolveProviderModelSelection(catalog.providers, providerInstanceId, model);
  const provider = "provider" in selection ? selection.provider : undefined;
  const activeModel = "model" in selection ? selection.model : undefined;
  const effectiveOptions = modelOptions ?? provider?.modelPreferences?.options[model];
  const tooLong = composerPromptTooLong(prompt);
  const sendBlockedReason = historyBlocked
    ? t("会话历史未恢复，发送已暂停。", "Session history is not restored; sending is paused.")
    : tooLong
      ? t(`消息超过 ${COMPOSER_PROMPT_LIMIT.toLocaleString()} 字符，请缩短后发送。`, `Message exceeds ${COMPOSER_PROMPT_LIMIT.toLocaleString()} characters; shorten it before sending.`)
      : saveError
      ? t("会话参数保存失败，先重试保存。", "Saving session settings failed; retry the save first.")
      : saving
        ? t("正在保存会话参数…", "Saving session settings…")
        : disabled
          ? t("当前会话不可发送。", "This session cannot send right now.")
          : undefined;

  return (
    <div className={cn("aui-composer-action-wrapper", styles.controls)}>
      <div className={styles.leftControls}>
        <ComposerModelPicker
          key={threadId}
          providerInstanceId={providerInstanceId}
          model={model}
          onChange={onModelChange}
          catalog={catalog}
          disabled={disabled || threadBusy}
          saving={saving}
          saveError={saveError}
          onRetry={onRetry}
        />
        {onSettingsChange && <ComposerTraitsPicker
          key={`${threadId}:${providerInstanceId}:${model}`}
          driver={provider?.driver}
          prompt={prompt}
          onPromptEdit={(edit) => aui.composer.setText(edit(aui.composer.getState().text))}
          model={activeModel}
          selections={effectiveOptions}
          interactionMode={interactionMode}
          onSettingsChange={onSettingsChange}
          disabled={disabled || threadBusy}
          saving={saving}
          saveError={saveError}
          catalogLoading={catalog.loading}
          catalogError={catalog.error}
          onRetry={onRetry}
        />}
      </div>
      <div className={styles.rightControls}>
        {composerActions}
        <ContextMeter />
        <ComposerAddAttachment />
        <AuiIf condition={(s) => s.thread.capabilities.dictation}>
          <AuiIf condition={(s) => s.composer.dictation == null}>
            <ComposerPrimitive.Dictate asChild>
              <TooltipIconButton
                tooltip={t("语音输入", "Voice input")}
                side="bottom"
                type="button"
                variant="ghost"
                size="icon"
                className="aui-composer-dictate text-muted-foreground hover:text-foreground size-7 rounded-full"
                aria-label={t("开始语音输入", "Start voice input")}
              >
                <MicIcon className="aui-composer-dictate-icon size-4" />
              </TooltipIconButton>
            </ComposerPrimitive.Dictate>
          </AuiIf>
          <AuiIf condition={(s) => s.composer.dictation != null}>
            <ComposerPrimitive.StopDictation asChild>
              <TooltipIconButton
                tooltip={t("停止听写", "Stop dictation")}
                side="bottom"
                type="button"
                variant="ghost"
                size="icon"
                className="aui-composer-stop-dictation text-destructive size-7 rounded-full"
                aria-label={t("停止听写", "Stop dictation")}
              >
                <SquareIcon className="aui-composer-stop-dictation-icon size-3.5 animate-pulse fill-current" />
              </TooltipIconButton>
            </ComposerPrimitive.StopDictation>
          </AuiIf>
        </AuiIf>
        <AuiIf
          condition={(s) =>
            !s.composer.canCancel ||
            (s.thread.voice !== undefined && s.composer.submission === undefined)
          }
        >
          {contextOnly ? <TooltipIconButton type="button" tooltip={sendBlockedReason ?? t("发送已选上下文", "Send selected context")} aria-label={t("发送已选上下文", "Send selected context")} disabled={historyBlocked || threadBusy} variant="default" className="aui-composer-send size-7 rounded-full" onClick={() => {
            const thread = aui.thread.getState();
            if (historyBlocked || thread.isRunning || thread.isDisabled || thread.isLoading || thread.isSendDisabled || onUsageCommand()) return;
            aui.thread.append({ role: "user", content: [{ type: "text", text: aui.composer.getState().text }] });
          }}><ArrowUpIcon className="size-4" /></TooltipIconButton> : <ComposerPrimitive.Send asChild onClick={(event) => { if (historyBlocked || onUsageCommand()) event.preventDefault(); }}>
            <TooltipIconButton
              tooltip={sendBlockedReason ?? t(
                preferences.sendShortcut === "enter" ? "发送消息 · Enter" : "发送消息 · Ctrl / ⌘ + Enter",
                preferences.sendShortcut === "enter" ? "Send message · Enter" : "Send message · Ctrl / ⌘ + Enter",
              )}
              side="bottom"
              type="button"
              variant="default"
              size="icon"
              className="aui-composer-send size-7 rounded-full"
              disabled={historyBlocked || !!sendBlockedReason}
              aria-label={t("发送消息", "Send message")}
            >
              <ArrowUpIcon className="aui-composer-send-icon size-4" />
            </TooltipIconButton>
          </ComposerPrimitive.Send>}
        </AuiIf>
        <AuiIf
          condition={(s) =>
            s.composer.canCancel &&
            (s.thread.voice === undefined || s.composer.submission !== undefined)
          }
        >
          <CancelGeneration />
        </AuiIf>
      </div>
    </div>
  );
};

const MessageError: FC = () => {
  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root className="aui-message-error-root border-destructive bg-destructive/10 text-destructive dark:bg-destructive/5 mt-2 rounded-md border p-3 text-sm dark:text-red-200">
        <ErrorPrimitive.Message className="aui-message-error-message line-clamp-2" />
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  );
};

const MessageTime: FC<{ at?: string; label: string; className?: string }> = ({ at, label, className }) => {
  const { locale } = useI18n();
  if (!at) return null;
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return null;
  const short = new Intl.DateTimeFormat(locale === "en" ? "en" : "zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date);
  return <time dateTime={at} title={`${label} ${date.toLocaleString()}`} className={cn("text-[11px] text-muted-foreground tabular-nums", className)}>{short}</time>;
};

/** Collapse only when the real content exceeds the reading height; never truncate silently. */
const UserMessageFold: FC<{ children: ReactNode }> = ({ children }) => {
  const t = useAgentText();
  const ref = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setOverflow(element.scrollHeight > 324);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return <>
    <div ref={ref} className="aui-user-message-fold" data-collapsed={overflow && !expanded ? true : undefined}>{children}</div>
    {overflow && <button type="button" data-thread-find-ignore className="aui-user-message-fold-toggle" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? t("收起", "Show less") : t("展开全文", "Show more")}</button>}
  </>;
};

const AssistantMessage: FC<{ actionsDisabled: boolean }> = ({ actionsDisabled }) => {
  const t = useAgentText();
  const ACTION_BAR_PT = "pt-1.5";
  const ACTION_BAR_HEIGHT = `min-h-7.5 ${ACTION_BAR_PT}`;
  const durable = useAuiState((s) => s.message.metadata.custom.durable) as { generationId?: unknown; nativeOutput?: unknown } | undefined;
  const generationId = durable?.nativeOutput === true && typeof durable.generationId === "string" ? durable.generationId : undefined;
  const messageId = useAuiState((state) => state.message.id);
  const threadId = useAuiState((state) => state.threadListItem.remoteId);
  const times = useMessageTimes(threadId);
  const record = useGenerationRecords(threadId).get(messageId);

  return (
    <MessageContextMenu actionsDisabled={actionsDisabled} role="assistant">
    <MessagePrimitive.Root
      data-slot="aui_assistant-message-root"
      data-role="assistant"
      tabIndex={0}
      className="fade-in slide-in-from-bottom-1 animate-in relative -mb-7.5 pb-7.5 duration-150 [contain-intrinsic-size:auto_200px] [content-visibility:auto]"
    >
      <div
        data-slot="aui_assistant-message-content"
        className="aui-assistant-message-content-body text-foreground px-2 text-sm leading-6 wrap-break-word"
      >
        {record?.handoff && <div className="native-lifecycle-row" data-kind="handoff" title={record.handoff.reason}>
          <ArrowLeftRightIcon aria-hidden="true" />
          <span>{t(`交接 · ${record.handoff.mode}`, `Handoff · ${record.handoff.mode}`)}</span>
          {record.handoff.reason && <span className="native-lifecycle-detail">{record.handoff.reason}</span>}
        </div>}
        {record?.continuationOf && <div className="native-lifecycle-row" data-kind="continuation" title={record.continuationOf}>
          <ArrowLeftRightIcon aria-hidden="true" />
          <span>{t("续接上一轮执行", "Continued from a previous turn")}</span>
        </div>}
        {generationId ? <OutputTimeline key={generationId} generationId={generationId} /> : <MessagePrimitive.Parts>
          {({ part }) => {
            if (part.type === "text") return <MarkdownText />;
            if (part.type === "reasoning")
              return (
                <Collapsible
                  data-slot="aui_assistant-reasoning-root"
                  className="aui-assistant-reasoning-root border-border bg-secondary text-muted-foreground mb-2 rounded-xl border px-2.5 py-1.5 text-xs"
                >
                  <CollapsibleTrigger className="group flex w-full items-center gap-1.5 text-left font-medium">
                    <BrainIcon className="size-3.5 shrink-0" />
                    {t("推理", "Reasoning")}
                    <ChevronDownIcon className="ms-auto size-3.5 shrink-0 transition-transform group-data-[panel-open]:rotate-180" />
                  </CollapsibleTrigger>
                  <CollapsibleContent className="overflow-hidden">
                    <div className="border-border mt-1.5 border-t pt-1.5 leading-5">
                      <MarkdownText />
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              );
            if (part.type === "tool-call") return part.toolUI ?? <ToolFallback {...part} />;
            return null;
          }}
        </MessagePrimitive.Parts>}
        <AuiIf
          condition={(s) => !generationId && s.message.status?.type === "running" && s.message.parts.length === 0}
        >
          <span
            data-slot="aui_assistant-message-indicator"
            className="animate-pulse font-sans"
            aria-label={t("助手正在工作", "Assistant is working")}
          >
            {"●"}
          </span>
        </AuiIf>
        <MessageError />
      </div>

      <div
        data-slot="aui_assistant-message-footer"
        className={cn("ms-2 flex items-center gap-2", ACTION_BAR_HEIGHT)}
      >
        <MessageTime at={times.get(messageId)} label={t("生成开始于", "Generation started")} />
        <BranchPicker />
        <AssistantActionBar actionsDisabled={actionsDisabled} />
      </div>
    </MessagePrimitive.Root>
    </MessageContextMenu>
  );
};

const messageMenuItemClassName = "aui-action-bar-more-item hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:opacity-50 flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none";

/** Both entry points keep the message runtime's capability and text guards. */
const MessageMenuActions: FC<{
  variant: "context" | "dropdown";
  role: "assistant" | "user";
  actionsDisabled: boolean;
  onEdit?: () => void;
}> = ({ variant, role, actionsDisabled, onEdit }) => {
  const t = useAgentText();
  const Item = variant === "context" ? ContextMenuItem : ActionBarMorePrimitive.Item;
  return <>
    <ActionBarPrimitive.Copy asChild>
      <Item className={messageMenuItemClassName}><CopyIcon className="size-4" />{t("复制", "Copy")}</Item>
    </ActionBarPrimitive.Copy>
    <ActionBarPrimitive.ExportMarkdown asChild>
      <Item className={messageMenuItemClassName}><DownloadIcon className="size-4" />{t("导出为 Markdown", "Export as Markdown")}</Item>
    </ActionBarPrimitive.ExportMarkdown>
    {role === "assistant" ? <>
      <AuiIf condition={(s) => s.thread.capabilities.speech && s.message.speech == null}>
        <ActionBarPrimitive.Speak asChild>
          <Item className={messageMenuItemClassName}><AudioLinesIcon className="size-4" />{t("朗读", "Read aloud")}</Item>
        </ActionBarPrimitive.Speak>
      </AuiIf>
      <AuiIf condition={(s) => s.message.speech != null}>
        <ActionBarPrimitive.StopSpeaking asChild>
          <Item className={messageMenuItemClassName}><SquareIcon className="size-4" />{t("停止朗读", "Stop reading")}</Item>
        </ActionBarPrimitive.StopSpeaking>
      </AuiIf>
      <ActionBarPrimitive.Reload asChild disabled={actionsDisabled} onClick={(event) => { if (actionsDisabled) event.preventDefault(); }}>
        <Item className={messageMenuItemClassName} title={actionsDisabled ? t("会话正在运行、读取或尚未就绪，暂时不能重新生成。", "The session is running, loading, or not ready; regeneration is unavailable.") : undefined}><RefreshCwIcon className="size-4" />{t("重新生成", "Regenerate")}</Item>
      </ActionBarPrimitive.Reload>
    </> : <ActionBarPrimitive.Edit asChild disabled={actionsDisabled} onClick={(event) => { if (actionsDisabled) event.preventDefault(); }}>
      <Item className={messageMenuItemClassName} title={actionsDisabled ? t("会话正在运行、读取或尚未就绪，暂时不能编辑。", "The session is running, loading, or not ready; editing is unavailable.") : undefined} onSelect={onEdit}><PencilIcon className="size-4" />{t("编辑", "Edit")}</Item>
    </ActionBarPrimitive.Edit>}
  </>;
};

const MessageContextMenu: FC<{
  children: ReactElement;
  role: "assistant" | "user";
  actionsDisabled: boolean;
}> = ({ children, role, actionsDisabled }) => {
  const t = useAgentText();
  const editing = useRef(false);
  return <ContextMenu onOpenChange={(open) => { if (open) editing.current = false; }}>
    <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
    <ContextMenuContent
      aria-label={role === "assistant" ? t("助手消息操作", "Assistant message actions") : t("用户消息操作", "User message actions")}
      onCloseAutoFocus={(event) => { if (editing.current) event.preventDefault(); }}
    >
      <MessageMenuActions variant="context" role={role} actionsDisabled={actionsDisabled} onEdit={() => { editing.current = true; }} />
    </ContextMenuContent>
  </ContextMenu>;
};

const AssistantActionBar: FC<{ actionsDisabled: boolean }> = ({ actionsDisabled }) => {
  const t = useAgentText();
  const threadId = useAuiState((state) => state.threads.threadItems.find((item) => item.id === state.threads.mainThreadId)?.remoteId);
  const messageId = useAuiState((state) => state.message.id);
  const [threadActionsOpen, setThreadActionsOpen] = useState(false);
  useEffect(() => { setThreadActionsOpen(false); }, [actionsDisabled, threadId, messageId]);
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide={threadActionsOpen ? "never" : "not-last"}
      className="aui-assistant-action-bar-root text-muted-foreground animate-in fade-in col-start-3 row-start-2 -ms-1 flex min-w-0 flex-wrap items-start gap-1 duration-200"
    >
      <ActionBarPrimitive.Copy asChild>
        <TooltipIconButton tooltip={t("复制", "Copy")}>
          <AuiIf condition={(s) => s.message.isCopied}>
            <CheckIcon className="animate-in zoom-in-50 fade-in duration-200 ease-out" />
          </AuiIf>
          <AuiIf condition={(s) => !s.message.isCopied}>
            <CopyIcon className="animate-in zoom-in-75 fade-in duration-150" />
          </AuiIf>
        </TooltipIconButton>
      </ActionBarPrimitive.Copy>
      {!actionsDisabled && <ResponseReferenceAction />}
      <AuiIf condition={(s) => s.thread.capabilities.speech && s.message.speech == null}>
        <ActionBarPrimitive.Speak asChild>
          <TooltipIconButton tooltip={t("朗读", "Read aloud")}><AudioLinesIcon /></TooltipIconButton>
        </ActionBarPrimitive.Speak>
      </AuiIf>
      <AuiIf condition={(s) => s.message.speech != null}>
        <ActionBarPrimitive.StopSpeaking asChild>
          <TooltipIconButton tooltip={t("停止朗读", "Stop reading")}><SquareIcon className="size-3.5 fill-current" /></TooltipIconButton>
        </ActionBarPrimitive.StopSpeaking>
      </AuiIf>
      <ActionBarPrimitive.Reload asChild disabled={actionsDisabled}>
        <TooltipIconButton tooltip={t("重新生成", "Regenerate")}>
          <RefreshCwIcon />
        </TooltipIconButton>
      </ActionBarPrimitive.Reload>
      <ActionBarMorePrimitive.Root>
        <ActionBarMorePrimitive.Trigger asChild>
          <TooltipIconButton tooltip={t("更多操作", "More actions")} className="data-[state=open]:bg-accent">
            <MoreHorizontalIcon />
          </TooltipIconButton>
        </ActionBarMorePrimitive.Trigger>
        <ActionBarMorePrimitive.Content
          side="bottom"
          align="start"
          sideOffset={6}
          className="aui-action-bar-more-content bg-popover/95 text-popover-foreground data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:animate-out data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-[8rem] overflow-hidden rounded-xl border p-1.5 shadow-lg backdrop-blur-sm"
        >
          <MessageMenuActions variant="dropdown" role="assistant" actionsDisabled={actionsDisabled} />
        </ActionBarMorePrimitive.Content>
      </ActionBarMorePrimitive.Root>
      {threadId && !actionsDisabled && <ThreadMessageActions threadId={threadId} messageId={messageId} open={threadActionsOpen} onOpenChange={setThreadActionsOpen} />}
    </ActionBarPrimitive.Root>
  );
};

const UserMessage: FC<{ actionsDisabled: boolean }> = ({ actionsDisabled }) => {
  const t = useAgentText();
  const messageId = useAuiState((state) => state.message.id);
  const threadId = useAuiState((state) => state.threadListItem.remoteId);
  const times = useMessageTimes(threadId);
  const record = useGenerationRecords(threadId).get(messageId);
  return (
    <MessageContextMenu actionsDisabled={actionsDisabled} role="user">
    <MessagePrimitive.Root
      data-slot="aui_user-message-root"
      className="fade-in slide-in-from-bottom-1 animate-in grid auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 duration-150 [contain-intrinsic-size:auto_200px] [content-visibility:auto] [&:where(>*)]:col-start-2"
      data-role="user"
      tabIndex={0}
    >
      <UserMessageAttachments />

      <div className="aui-user-message-content-wrapper relative col-start-2 min-w-0 max-w-(--bubble-max-width)">
        <div className="aui-user-message-content peer bg-secondary text-foreground rounded-(--bubble-radius) px-4 py-2 text-sm leading-6 wrap-break-word empty:hidden">
          <UserMessageFold><MessagePrimitive.Parts components={{ Text: UserContextText }} /></UserMessageFold>
        </div>
        <div className="mt-1 flex justify-end"><MessageTime at={times.get(messageId)} label={t("发送于", "Sent")} /></div>
        <PmMessageContext />
        <MessagePrimitive.Quote>
          {quote => <QuoteBlock {...quote} />}
        </MessagePrimitive.Quote>
        <div className="aui-user-action-bar-wrapper absolute start-0 top-1/2 -translate-x-full -translate-y-1/2 pe-2 peer-empty:hidden rtl:translate-x-full">
          <UserActionBar actionsDisabled={actionsDisabled} />
        </div>
      </div>

      <BranchPicker
        data-slot="aui_user-branch-picker"
        className="col-span-full col-start-1 -me-1 justify-end"
      />
    </MessagePrimitive.Root>
    </MessageContextMenu>
  );
};

const UserActionBar: FC<{ actionsDisabled: boolean }> = ({ actionsDisabled }) => {
  const t = useAgentText();
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="aui-user-action-bar-root flex flex-col items-end"
    >
      <ActionBarPrimitive.Edit asChild disabled={actionsDisabled}>
        <TooltipIconButton tooltip={t("编辑", "Edit")} className="aui-user-action-edit">
          <PencilIcon />
        </TooltipIconButton>
      </ActionBarPrimitive.Edit>
    </ActionBarPrimitive.Root>
  );
};

const EditComposer: FC<{ providerInstanceId: string; disabled: boolean }> = ({ providerInstanceId, disabled }) => {
  const t = useAgentText();
  const { preferences } = useChatBrowserPreferences();
  const aui = useAui();
  const [limitsRequest, setLimitsRequest] = useState(0);
  const suggestions = useComposerSuggestions(providerInstanceId, disabled);
  const handleUsageCommand = () => consumeUsageLimitsCommand(aui.composer, () => setLimitsRequest((request) => request + 1));
  const handleSendCommand = () => handleUsageCommand() || !suggestions.beforeSend();
  const quotePending = useAuiState(state => !!state.composer.quote);
  const submitting = useAuiState(state => state.composer.submission !== undefined);
  const contextDraft = useMessageContextDraft();
  const references = useSyncExternalStore(subscribeMessageContext, () => getEditedContextReferences(contextDraft.targetKey), () => getEditedContextReferences(contextDraft.targetKey));
  const emptyComposer = useAuiState(state => !state.composer.text.trim() && !state.composer.attachments.length && !state.composer.quote);
  const contextOnly = emptyComposer && (contextDraft.items.length > 0 || references.length > 0);
  const manuallySubmitted = useRef(false);
  const [submissionError, setSubmissionError] = useState<string>();
  const blocked = disabled || suggestions.blocked || quotePending || contextDraft.blocked || submitting;
  const threadId = useAuiState(state => state.threadListItem.remoteId);
  const originalMessage = useAuiState(state => state.message);
  const prepareSend = () => {
    const thread = aui.thread.getState();
    if (manuallySubmitted.current || aui.composer.getState().submission !== undefined || thread.isRunning || thread.isDisabled || thread.isLoading || thread.isSendDisabled) return true;
    if (blocked || handleSendCommand()) return true;
    if (threadId) {
      const original = (getExternalStoreMessages(originalMessage) as UIMessage[]).at(-1);
      const attachments = canonicalContextAttachments(aui.composer.getState().attachments, original?.parts ?? [], readContextAttachmentBindings(originalMessage.metadata.custom.contextAttachments));
      prepareMessageContextEditSubmission(threadId, attachments);
    }
    return false;
  };
  const handleSubmit = () => {
    if (prepareSend()) return true;
    const composer = aui.composer.getState();
    if (composer.text.trim() || composer.attachments.length || !(getMessageContextItems(contextDraft.targetKey).length || getEditedContextReferences(contextDraft.targetKey).length)) return false;
    // The store projection omits edit IDs; require the actual runtime before appending context-only input.
    const runtime = aui.composer.__internal_getRuntime?.();
    const edit = runtime?.getState();
    if (!runtime || edit?.type !== "edit" || edit.sourceId !== originalMessage.id || originalMessage.role !== "user") {
      setSubmissionError(t("无法确认原消息编辑身份；消息未提交。", "The original edit identity is unavailable. The message was not submitted."));
      return true;
    }
    manuallySubmitted.current = true;
    try {
      aui.thread.append({ parentId: edit.parentId, sourceId: edit.sourceId, role: edit.role, content: [{ type: "text", text: composer.text }], attachments: [], runConfig: composer.runConfig, metadata: { custom: {} } });
      runtime.cancel();
    } catch (cause) {
      manuallySubmitted.current = false;
      setSubmissionError(cause instanceof Error ? cause.message : String(cause));
    }
    return true;
  };
  return (
    <MessagePrimitive.Root
      data-slot="aui_edit-composer-wrapper"
      className="flex flex-col px-2 [contain-intrinsic-size:auto_200px] [content-visibility:auto]"
    >
      <ComposerPrimitive.Root className="aui-edit-composer-root border-border ms-auto flex w-full max-w-[85%] cursor-text flex-col rounded-(--bubble-radius) border bg-(--composer-bg) shadow-[0_4px_16px_-8px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.04)] transition-[border-color] duration-[var(--motion-hover)] dark:shadow-none" onSubmit={(event) => { if (handleSubmit()) event.preventDefault(); }}>
        <MessageContextDraftStatus />
        {submissionError && <p role="alert" className="px-3 py-1 text-sm text-destructive">{submissionError}</p>}
        {suggestions.surface}
        <RichComposerInput editing suggestions={suggestions} disabled={disabled}
          placeholder={t("编辑消息…", "Edit message…")} label={t("编辑消息", "Edit message")}
          submitMode={preferences.sendShortcut} beforeSend={handleSubmit} />
        <div className="aui-edit-composer-footer mx-2.5 mb-2.5 flex items-center gap-1.5 self-end">
          <ComposerPrimitive.Cancel asChild>
            <Button variant="ghost" size="sm" className="h-8 px-3">{t("取消", "Cancel")}</Button>
          </ComposerPrimitive.Cancel>
          {contextOnly ? <Button type="submit" size="sm" className="h-8 px-3" disabled={blocked}>{t("更新消息", "Update message")}</Button> : <ComposerPrimitive.Send asChild disabled={blocked} onClick={(event) => { if (handleSubmit()) event.preventDefault(); }}>
            <Button type="button" size="sm" className="h-8 px-3">{t("更新消息", "Update message")}</Button>
          </ComposerPrimitive.Send>}
        </div>
        {limitsRequest > 0 && <ComposerUsage providerInstanceId={providerInstanceId} limitsRequest={limitsRequest} onCloseLimits={() => setLimitsRequest(0)} />}
      </ComposerPrimitive.Root>
    </MessagePrimitive.Root>
  );
};

const BranchPicker: FC<BranchPickerPrimitive.Root.Props> = ({ className, ...rest }) => {
  const t = useAgentText();
  return (
    <BranchPickerPrimitive.Root
      hideWhenSingleBranch
      className={cn(
        "aui-branch-picker-root text-muted-foreground -ms-2 me-2 inline-flex items-center text-xs",
        className,
      )}
      {...rest}
    >
      <BranchPickerPrimitive.Previous asChild>
        <TooltipIconButton tooltip={t("上一分支", "Previous branch")}>
          <ChevronLeftIcon />
        </TooltipIconButton>
      </BranchPickerPrimitive.Previous>
      <span className="aui-branch-picker-state font-medium">
        <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
      </span>
      <BranchPickerPrimitive.Next asChild>
        <TooltipIconButton tooltip={t("下一分支", "Next branch")}>
          <ChevronRightIcon />
        </TooltipIconButton>
      </BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  );
};
