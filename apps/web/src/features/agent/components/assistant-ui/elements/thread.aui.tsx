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
import type { ComposerModelPickerCatalog } from "@agent/components/assistant-ui/elements/composer-model-picker.aui";
import { ModelFanoutPicker } from "@agent/src/chat/model-fanout-picker";
import { ModelFanoutBanner } from "@agent/src/chat/model-fanout-banner";
import {
  forgetFanoutOperation,
  readFanoutOperation,
  rememberFanoutOperation,
  submitFanout,
} from "@agent/src/chat/model-fanout-client";
import type { FanoutModelSelection, FanoutOutcome } from "@agent/src/chat/model-fanout";
import {
  buildFanoutUserMessage,
  composerFanoutBlockerCopy,
  composerFanoutGate,
  fanoutReceiptSucceeded,
  fanoutSelectionsAvailable,
  firstFanoutChildThread,
  resolveFanoutOperationId,
  type ComposerFanoutCopy,
  type FanoutAttempt,
} from "@agent/src/chat/composer-fanout";
import { ComposerFanoutStatus, FanoutSendButton } from "@agent/src/chat/composer-fanout-ui";
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
import { ComposerBannerStack } from "@agent/src/chat/composer-banner";
import { DraftHero } from "@agent/src/chat/draft-hero";
import {
  collapsedComposerControls,
  isPlainTextDraft,
  resolveComposerDensity,
  resolveComposerPrimaryAction,
  resolveComposerCompactionControls,
  resolveComposerSubmissionRoute,
  type ComposerOperationLock,
  type ComposerDensity,
} from "@agent/src/chat/composer-actions-model";
import { getThreadActionCapabilities } from "@agent/src/chat/thread-actions";
import { flushThreadSettings } from "@agent/hooks/use-chat-settings";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import type { GenerationOutputStatus } from "@agent-workspace/contracts/output";
import { composerPromptTooLong } from "@agent/src/chat/composer-limit";
import { ThreadFind } from "@agent/src/chat/thread-find";
import { ComposerCompactionControls, ComposerCompactionStatus, useComposerCompaction } from "@agent/src/chat/composer-compaction-ui";
import { ComposerQueueEditStatus, useComposerQueueEdit } from "@agent/src/chat/composer-queue-edit-ui";
import "@agent/src/chat/composer-shell.css";
import { ThreadStatusLine } from "@agent/src/chat/thread-status-line";
import { ThreadLifecycleRows, type ThreadLifecycleParent } from "@agent/src/chat/thread-lifecycle-rows";
import { OutputTimeline } from "@agent/src/chat/output-timeline";
import { useHistoryLoadOutcome } from "@agent/src/chat/remote-adapter";
import { PmMessageContext } from "@agent/src/pm/pm-composer-references";
import { ComposerUsage } from "@agent/src/usage/ComposerUsage";
import { consumeUsageLimitsCommand } from "@agent/src/usage/ComposerUsageModel";
import { useComposerSuggestions } from "@agent/src/chat/composer-suggestions";
import { RichComposerInput } from "@agent/src/chat/rich-composer";
import { QueuedMessages, ThreadMessageActions } from "@agent/src/chat/message-actions";
import { ComposerPendingRequests } from "@agent/src/chat/composer-pending-requests";
import { ThreadHistoryMessage, ThreadHistoryNavigation } from "@agent/src/chat/history-navigation";
import { MessageContextEditProvider, useMessageContextDraft } from "@agent/src/chat/message-context";
import { turnContextSchema, type TurnContext } from "@agent-workspace/contracts/pm-references";
import { workspaceClient } from "@agent/src/network";
import { MessageContextDraftStatus } from "@agent/src/chat/context-presentation";
import { usePmIssueWorkspace } from "@agent/src/pm/pm-issue-workspace";
import { UserContextText } from "@agent/src/chat/user-context-text";
import { AssistantQuoteCitation } from "@agent/src/chat/markdown-citation-chip";
import { formatMessageAuthorLabel } from "@agent/src/chat/message-accessibility";
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
  ListTodoIcon,
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
  /** Model selection only needs loaded settings and the catalog, not conversation history or an execution environment. */
  modelPickerDisabled?: boolean;
  saving?: boolean;
  saveError?: string;
  onRetry?: () => void | Promise<void>;
  composerLeading?: ReactNode;
  composerActions?: ReactNode;
  welcome?: { title: string; alternateLabel?: string; onAlternate?: () => void; freshlyCreated?: boolean };
  sendUnavailable?: boolean;
  /** Persisted session metadata for t3code-style lifecycle dividers. */
  createdAt?: string;
  parentSession?: ThreadLifecycleParent;
  onOpenParentSession?: (threadId: string) => void;
};

/** Multi-model state owned by the Thread so the picker, send path and result banner agree. */
type ComposerFanoutProps = {
  fanoutSelections: FanoutModelSelection[] | null;
  fanoutActive: boolean;
  fanoutPending: boolean;
  /** Remount token: bumps when stacked selections are cleared after a successful receipt. */
  fanoutEpoch: number;
  fanoutBlocker?: ComposerFanoutCopy;
  onFanoutChange: (selections: FanoutModelSelection[] | null) => void;
  onFanoutSend: () => void;
};

/**
 * Reads one generation's status for controls that need it. Rendered only when
 * a generation id exists, so the output stream never attaches to a placeholder.
 */
const GenerationSlot: FC<{ generationId: string; render: (data: { status?: GenerationOutputStatus }) => ReactNode }> = ({ generationId, render }) => {
  const { snapshot } = useGenerationOutput(generationId);
  return <>{render({ status: snapshot?.status })}</>;
};

/**
 * Hero exit when a session starts from the empty state. A view transition can
 * capture this synchronous attribute change; without support the same CSS
 * transition runs unchanged. The composer's own descent uses a FLIP animation
 * below because sending is asynchronous and cannot be wrapped.
 */
function markDraftHeroSending(): void {
  const hero = document.querySelector<HTMLElement>("[data-draft-hero]");
  if (!hero) return;
  const apply = () => {
    hero.setAttribute("data-sending", "");
    // A send that never leaves the empty state must not leave the hero hidden.
    window.setTimeout(() => hero.removeAttribute("data-sending"), 600);
  };
  const transition = (document as Document & { startViewTransition?: unknown }).startViewTransition;
  if (typeof transition === "function" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches)
    (transition as (callback: () => void) => unknown).call(document, apply);
  else apply();
}

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
  const quotePending = useAuiState((state) => !!state.composer.quote);
  const [composerFocused, setComposerFocused] = useState(false);
  const [nearBottom, setNearBottom] = useState(true);
  const [resting, setResting] = useState(false);
  // Multi-model stacking lives with the Thread: the picker, the send path and
  // the receipt banner all read the same selections. A thread change resets it.
  const aui = useAui();
  const contextDraft = useMessageContextDraft();
  const pmWorkspace = usePmIssueWorkspace();
  const [fanoutSelections, setFanoutSelections] = useState<FanoutModelSelection[] | null>(null);
  const [fanoutEpoch, setFanoutEpoch] = useState(0);
  const [fanoutOutcome, setFanoutOutcome] = useState<FanoutOutcome>();
  const [fanoutNotice, setFanoutNotice] = useState<string>();
  const [fanoutPending, setFanoutPending] = useState(false);
  const [fanoutRetry, setFanoutRetry] = useState<FanoutAttempt>();
  // State is async; this ref makes Enter/click double-fire impossible before re-render.
  const fanoutInFlight = useRef(false);
  const fanoutThread = useRef(threadId);
  fanoutThread.current = threadId;
  useEffect(() => {
    fanoutInFlight.current = false;
    setFanoutSelections(null);
    setFanoutOutcome(undefined);
    setFanoutNotice(undefined);
    setFanoutPending(false);
    setFanoutRetry(undefined);
  }, [threadId]);
  const fanoutGate = composerFanoutGate({
    selections: fanoutSelections,
    hasText: composerText.trim().length > 0,
    attachmentCount: composerAttachmentCount,
    quote: quotePending,
    contextItemCount: contextDraft.items.length,
    pmReferenceCount: pmWorkspace.references.length,
    running: threadRunning,
    historyBlocked: history.status === "error" || historyMissing,
    providerAvailable: fanoutSelectionsAvailable(props.catalog.providers, fanoutSelections ?? []),
    remoteId,
    composerUnavailable: !!props.disabled || !!props.saving || !!props.saveError || !!props.sendUnavailable,
  });
  const fanoutBlocker = fanoutGate.blocker ? composerFanoutBlockerCopy(fanoutGate.blocker) : undefined;

  const dispatchFanout = async (attempt: FanoutAttempt) => {
    const sourceThreadId = remoteId;
    const ownerThread = threadId;
    if (!sourceThreadId) {
      const copy = composerFanoutBlockerCopy("fanout_requires_remote_session");
      setFanoutNotice(t(copy.zh, copy.en));
      return;
    }
    if (fanoutInFlight.current) return;
    fanoutInFlight.current = true;
    rememberFanoutOperation(threadId, attempt.operationId);
    setFanoutPending(true);
    setFanoutNotice(undefined);
    try {
      const outcome = await submitFanout({
        operationId: attempt.operationId,
        sourceThreadId,
        message: attempt.message,
        selections: attempt.selections,
      });
      if (fanoutThread.current !== ownerThread) return;
      setFanoutOutcome(outcome);
      if (!fanoutReceiptSucceeded(outcome)) {
        // The server receipt is final but empty. Keep the same operation id so a
        // re-check re-posts it instead of creating another operation.
        setFanoutRetry(attempt);
        setFanoutNotice(t("服务端没有创建任何子会话；操作编号已保留。", "The server created no child sessions; the operation id is kept."));
        return;
      }
      forgetFanoutOperation(threadId);
      setFanoutRetry(undefined);
      setFanoutSelections(null);
      setFanoutEpoch((epoch) => epoch + 1);
      aui.composer.setText("");
      // Only a fully created receipt auto-opens; a partial one stays on the
      // source so every failed child remains visible in the result banner.
      const target = outcome.status === "created" ? firstFanoutChildThread(outcome) : undefined;
      if (target) openFanoutThread(target);
    } catch (cause) {
      if (fanoutThread.current !== ownerThread) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      setFanoutRetry(attempt);
      setFanoutNotice(t(`多模型发送失败：${message}。可重新核对同一操作。`, `Multi-model send failed: ${message}. You can re-check the same operation.`));
    } finally {
      fanoutInFlight.current = false;
      if (fanoutThread.current === ownerThread) setFanoutPending(false);
    }
  };

  const startFanout = () => {
    if (fanoutInFlight.current || fanoutPending || !fanoutSelections) return;
    if (fanoutGate.blocker) {
      const copy = composerFanoutBlockerCopy(fanoutGate.blocker);
      setFanoutNotice(t(copy.zh, copy.en));
      return;
    }
    const resolved = resolveFanoutOperationId({
      pending: fanoutRetry?.operationId,
      stored: readFanoutOperation(threadId),
      generate: () => crypto.randomUUID(),
    });
    const attempt: FanoutAttempt = {
      operationId: resolved.operationId,
      message: buildFanoutUserMessage({ id: crypto.randomUUID(), text: composerText }),
      selections: [...fanoutSelections],
    };
    setFanoutOutcome(undefined);
    void dispatchFanout(attempt);
  };

  const retryFanout = () => {
    if (!fanoutRetry || fanoutPending || fanoutInFlight.current) return;
    void dispatchFanout(fanoutRetry);
  };

  const openFanoutThread = (target: string) => {
    // Fanout children are new remote sessions, so refresh the list first: the
    // runtime can only switch to a remote id it has registered. Failures stay
    // visible through the notice/banner while the source session is unchanged.
    void (async () => {
      try {
        await aui.threads.reload();
        await aui.threads.getLoadThreadsPromise();
        aui.threads.switchToThread(target, { unarchive: false });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        setFanoutNotice(t(`无法打开多模型会话：${message}`, `Could not open the multi-model session: ${message}`));
      }
    })();
  };
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
  // Remember the centered hero composer so the first send can animate it down
  // into the conversation position instead of jumping.
  const draftComposerRect = useRef<DOMRect | null>(null);
  useLayoutEffect(() => {
    if (isEmpty) {
      draftComposerRect.current = document.querySelector<HTMLElement>('[data-slot="aui_composer-shell"]')?.getBoundingClientRect() ?? null;
      return;
    }
    const from = draftComposerRect.current;
    draftComposerRect.current = null;
    const element = document.querySelector<HTMLElement>('[data-slot="aui_composer-shell"]');
    if (!from || !element || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const to = element.getBoundingClientRect();
    const scaleX = to.width > 0 ? from.width / to.width : 1;
    if (Math.abs(from.top - to.top) < 2 && Math.abs(scaleX - 1) < 0.02) return;
    element.animate([
      { transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scaleX(${scaleX})`, transformOrigin: "top left" },
      { transform: "none" },
    ], { duration: 260, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
  }, [isEmpty, threadId]);
  const [limitsRequest, setLimitsRequest] = useState(0);
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
      data-draft-empty={isEmpty || undefined}
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
          {!isEmpty && <ThreadLifecycleRows threadCreatedAt={props.createdAt} parent={props.parentSession} onOpenParent={props.onOpenParentSession} />}
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
              <ComposerPendingRequests />
              {remoteId && <QueuedMessages key={remoteId} threadId={remoteId} />}
            </div>
            <ComposerBannerStack
              scopeKey={remoteId ?? threadId}
              threadId={remoteId}
              providerInstanceId={props.providerInstanceId}
              saveError={props.saveError}
              onRetrySave={props.onRetry}
              onOpenLimits={() => setLimitsRequest((request) => request || 1)}
              latestGenerationId={latestGenerationId}
            />
            {/* Fanout receipts and failures sit in their own row above the
                composer, after the shared banner stack, so nothing overlaps. */}
            {fanoutOutcome && <ModelFanoutBanner
              outcome={fanoutOutcome}
              onOpenThread={openFanoutThread}
              onDismiss={() => setFanoutOutcome(undefined)}
            />}
            {fanoutNotice && <ComposerFanoutStatus
              message={fanoutNotice}
              pending={fanoutPending}
              canRetry={!!fanoutRetry}
              onRetry={retryFanout}
              onDismiss={() => setFanoutNotice(undefined)}
            />}
            {resting && <button type="button" className="thread-resting-composer" onClick={() => {
              setResting(false);
              requestAnimationFrame(() => document.querySelector<HTMLElement>(".rich-composer-editor")?.focus());
            }}><PencilIcon aria-hidden="true" /><span>{t("继续输入…", "Reply…")}</span></button>}
            <Composer
              {...props}
              key={threadId}
              historyBlocked={history.status === "error" || historyMissing}
              latestGenerationId={latestGenerationId}
              draftEmpty={isEmpty}
              limitsRequest={limitsRequest}
              onOpenLimits={() => setLimitsRequest((request) => request + 1)}
              onCloseLimits={() => setLimitsRequest(0)}
              fanoutSelections={fanoutSelections}
              fanoutActive={fanoutGate.active}
              fanoutPending={fanoutPending}
              fanoutEpoch={fanoutEpoch}
              fanoutBlocker={fanoutBlocker}
              onFanoutChange={(selections) => {
                setFanoutSelections(selections);
                setFanoutNotice(undefined);
              }}
              onFanoutSend={startFanout}
            />
          </ThreadPrimitive.ViewportFooter>
        </div>
      </ThreadPrimitive.Viewport>
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
  return <DraftHero
    title={welcome?.title ?? t("今天想一起完成什么？", "What would you like to get done together today?")}
    alternateLabel={welcome?.alternateLabel}
    onAlternate={welcome?.onAlternate}
  />;
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

const Composer: FC<ThreadProps & ComposerFanoutProps & {
  historyBlocked: boolean;
  latestGenerationId?: string;
  draftEmpty?: boolean;
  limitsRequest: number;
  onOpenLimits: () => void;
  onCloseLimits: () => void;
}> = (props) => {
  const t = useAgentText();
  const { preferences } = useChatBrowserPreferences();
  const aui = useAui();
  const threadId = useAuiState((state) => state.threads.mainThreadId);
  const remoteId = useAuiState((state) => state.threads.threadItems.find((item) => item.id === state.threads.mainThreadId)?.remoteId);
  const prompt = useAuiState((state) => state.composer.text);
  const attachmentCount = useAuiState((state) => state.composer.attachments.length);
  const threadRunning = useAuiState((state) => state.thread.isRunning);
  const threadBusy = useAuiState((state) => state.thread.isLoading || state.threads.isLoading);
  const quotePending = useAuiState(state => !!state.composer.quote);
  const submitting = useAuiState(state => state.composer.submission !== undefined);
  const contextDraft = useMessageContextDraft();
  const pmWorkspace = usePmIssueWorkspace();
  const suggestions = useComposerSuggestions(props.providerInstanceId, !!props.disabled || props.historyBlocked);
  const operation = useRef<ComposerOperationLock["current"]>(null);
  const queueEdit = useComposerQueueEdit(remoteId, operation);
  const handleUsageCommand = () => consumeUsageLimitsCommand(aui.composer, props.onOpenLimits);
  const handleSendCommand = (allowCompaction = false) => {
    if (queueEdit.active || (operation.current && !(allowCompaction && operation.current.kind === "compaction"))) return true;
    const composer = aui.composer.getState();
    const thread = aui.thread.getState();
    if (composer.submission !== undefined || thread.isRunning || thread.isDisabled || thread.isLoading || thread.isSendDisabled) return true;
    if (handleUsageCommand() || !suggestions.beforeSend()) return true;
    prepareMessageContextDraftSubmission(threadId, composer.attachments);
    return false;
  };
  const sendBlocked = !!props.disabled || !!props.saving || !!props.saveError || !!props.sendUnavailable || props.historyBlocked || suggestions.blocked || quotePending || contextDraft.blocked || submitting;
  const compaction = useComposerCompaction({
    remoteId,
    operation,
    running: threadRunning,
    latestGenerationId: props.latestGenerationId,
    blocked: !!props.disabled || !!props.saving || !!props.saveError || !!props.sendUnavailable || props.historyBlocked || submitting || threadBusy || queueEdit.active || props.fanoutActive,
    sendBlocked: sendBlocked || composerPromptTooLong(prompt),
    beforeSend: () => handleSendCommand(true),
  });
  const actionsBlocked = sendBlocked || compaction.pending || queueEdit.pending;
  const canUpdateQueued = !actionsBlocked && !composerPromptTooLong(prompt) && isPlainTextDraft({
    hasText: !!prompt.trim(), attachmentCount, hasQuote: quotePending,
    selectionCount: contextDraft.items.length + pmWorkspace.references.length,
  });
  const updateQueued = () => { void queueEdit.save(canUpdateQueued); };
  const interceptAlternateSubmit = () => {
    const route = resolveComposerSubmissionRoute({ editingQueue: queueEdit.active, operationPending: !!operation.current, fanoutActive: props.fanoutActive });
    if (route === "send") return false;
    if (route === "update-queued") updateQueued();
    else if (route === "fanout") props.onFanoutSend();
    return true;
  };
  const compactionControls = resolveComposerCompactionControls({
    available: compaction.state.available,
    phase: compaction.state.phase,
    hasText: !!prompt.trim(),
    running: threadRunning,
    editingQueue: queueEdit.active,
    fanoutActive: props.fanoutActive,
    blocked: !!props.disabled || !!props.saving || !!props.saveError || !!props.sendUnavailable || props.historyBlocked || submitting || threadBusy,
    sendBlocked: sendBlocked || composerPromptTooLong(prompt),
  });
  return (
    <>
    <ComposerPrimitive.Root className="aui-composer-root relative flex w-full flex-col" onSubmit={(event) => {
      // Enter and form submission share the same exclusive queue/fanout owner.
      if (interceptAlternateSubmit()) { event.preventDefault(); return; }
      if (composerPromptTooLong(aui.composer.getState().text)) { event.preventDefault(); return; }
      if (actionsBlocked || threadRunning || handleSendCommand()) { event.preventDefault(); return; }
      if (props.draftEmpty) markDraftHeroSending();
      const composer = aui.composer.getState();
      if (!composer.text.trim() && !composer.attachments.length && (contextDraft.items.length || pmWorkspace.references.length)) {
        event.preventDefault();
        const thread = aui.thread.getState();
        if (!thread.isDisabled && !thread.isLoading && !thread.isSendDisabled) aui.thread.append({ role: "user", content: [{ type: "text", text: composer.text }] });
      }
    }}>
      <ComposerQueueEditStatus state={queueEdit.state} onCancel={queueEdit.cancel} />
      <ComposerCompactionStatus state={compaction.state} />
      <ComposerPrimitive.AttachmentDropzone asChild disabled={compaction.pending || queueEdit.pending}>
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
            disabled={!!props.disabled || compaction.pending || queueEdit.pending}
            beforeSend={() => {
              if (interceptAlternateSubmit()) return true;
              return actionsBlocked || threadRunning || handleSendCommand();
            }}
            interactionMode={props.interactionMode}
            onInteractionModeChange={(mode) => props.onSettingsChange?.({ interactionMode: mode })}
          />
          <ComposerCompactionControls controls={compactionControls} onCompact={() => void compaction.start(false)} onCompactAndSend={() => void compaction.start(true)} />
          <ComposerAction
            {...props}
            editingQueue={queueEdit.active}
            queueUpdatePending={queueEdit.pending}
            compactionPending={compaction.pending}
            onUpdateQueued={updateQueued}
            latestGenerationId={props.latestGenerationId}
            historyBlocked={props.historyBlocked}
            draftBlocked={quotePending || submitting || suggestions.blocked || contextDraft.blocked || compaction.pending || queueEdit.pending}
            onUsageCommand={handleSendCommand}
          />
          <ComposerUsage providerInstanceId={props.providerInstanceId} limitsRequest={props.limitsRequest} onCloseLimits={props.onCloseLimits} />
        </div>
      </ComposerPrimitive.AttachmentDropzone>
    </ComposerPrimitive.Root>
    {props.draftEmpty && !props.fanoutActive && !queueEdit.active && !compaction.pending && <AuiIf condition={(s) => s.composer.isEmpty}>
      <ThreadSuggestions />
    </AuiIf>}
    </>
  );
};

type ComposerSessionActionProps = {
  editingQueue: boolean;
  queueUpdatePending: boolean;
  compactionPending: boolean;
  onUpdateQueued: () => void;
};

const ComposerAction: FC<ThreadProps & ComposerFanoutProps & ComposerSessionActionProps & { historyBlocked: boolean; draftBlocked?: boolean; onUsageCommand: () => boolean; latestGenerationId?: string }> = (props) => {
  if (!props.latestGenerationId) return <ComposerActionBody {...props} />;
  return <GenerationSlot
    generationId={props.latestGenerationId}
    render={(generation) => <ComposerActionBody {...props} generation={generation} />}
  />;
};

const ComposerActionBody: FC<ThreadProps & ComposerFanoutProps & ComposerSessionActionProps & { historyBlocked: boolean; draftBlocked?: boolean; onUsageCommand: () => boolean; latestGenerationId?: string; generation?: { status?: GenerationOutputStatus } }> = (props) => {
  const { providerInstanceId, model, modelOptions, interactionMode, onSettingsChange, onModelChange, catalog, disabled, modelPickerDisabled, saving, saveError, onRetry, composerActions, historyBlocked, draftBlocked, onUsageCommand, sendUnavailable, generation, latestGenerationId,
    fanoutActive, fanoutPending, fanoutEpoch, fanoutBlocker, onFanoutChange, onFanoutSend } = props;
  const t = useAgentText();
  const aui = useAui();
  const prompt = useAuiState((state) => state.composer.text);
  const attachmentCount = useAuiState((state) => state.composer.attachments.length);
  const hasQuote = useAuiState((state) => !!state.composer.quote);
  const threadRunning = useAuiState((state) => state.thread.isRunning);
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const remoteId = useAuiState((s) => s.threads.threadItems.find((item) => item.id === s.threads.mainThreadId)?.remoteId);
  const { preferences } = useChatBrowserPreferences();
  const contextDraft = useMessageContextDraft();
  const pmWorkspace = usePmIssueWorkspace();
  const selection = resolveProviderModelSelection(catalog.providers, providerInstanceId, model);
  const provider = "provider" in selection ? selection.provider : undefined;
  const activeModel = "model" in selection ? selection.model : undefined;
  const tooLong = composerPromptTooLong(prompt);
  const [steer, setSteer] = useState<{ supported: boolean; interruptsTools: boolean; generationId?: string }>({ supported: false, interruptsTools: false });
  const [pending, setPending] = useState<"steer" | "queue" | "resume">();
  const [actionError, setActionError] = useState<string>();
  const [resumeOpen, setResumeOpen] = useState(false);
  const [resumeConfirmed, setResumeConfirmed] = useState(false);
  const steerAttempt = useRef<{ id: string; generationId: string } | null>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const [density, setDensity] = useState<ComposerDensity>("wide");

  // A different session or generation invalidates any in-flight follow-up review.
  useEffect(() => {
    steerAttempt.current = null;
    setResumeOpen(false);
    setResumeConfirmed(false);
    setActionError(undefined);
  }, [remoteId, latestGenerationId]);

  // Steer/queue/continue only exist when the thread contracts say so.
  useEffect(() => {
    setSteer({ supported: false, interruptsTools: false });
    if (!remoteId) return;
    let alive = true;
    void getThreadActionCapabilities(remoteId).then((capabilities) => {
      if (alive) setSteer({ supported: capabilities.steer.supported, interruptsTools: !!capabilities.steer.interruptsTools, generationId: capabilities.steer.generationId });
    }, () => { /* An unreadable capability map simply hides steer. */ });
    return () => { alive = false; };
  }, [remoteId, threadRunning, generation?.status]);

  // The action bar measures itself; a narrow container folds secondary controls
  // into a popover without deleting any of them.
  useLayoutEffect(() => {
    const element = wrapper.current;
    if (!element) return;
    const measure = () => setDensity(resolveComposerDensity(element.getBoundingClientRect().width));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const collapsed = new Set(collapsedComposerControls(density));

  const action = resolveComposerPrimaryAction({
    running: threadRunning,
    draftBlocked: !!draftBlocked,
    remoteThread: !!remoteId,
    hasText: prompt.trim().length > 0,
    attachmentCount,
    hasQuote,
    selectionCount: contextDraft.items.length + pmWorkspace.references.length,
    historyBlocked,
    tooLong,
    saveError: !!saveError,
    saving: !!saving,
    sessionDisabled: !!disabled,
    sendUnavailable: !!sendUnavailable,
    steer: { supported: steer.supported, interruptsTools: steer.interruptsTools },
    resumable: generation?.status === "failed" || generation?.status === "cancelled" || generation?.status === "interrupted",
    editingQueue: props.editingQueue,
    queueUpdatePending: props.queueUpdatePending,
  });

  const sendSteer = async () => {
    if (!remoteId || !prompt.trim() || pending) return;
    const generationId = steer.generationId ?? latestGenerationId;
    if (!generationId) { setActionError(t("当前没有可引导的活动轮次。", "There is no active turn to steer.")); return; }
    const attempt = steerAttempt.current ?? { id: crypto.randomUUID(), generationId };
    steerAttempt.current = attempt;
    setPending("steer");
    setActionError(undefined);
    try {
      const result = await workspaceClient.json<{ status: "accepted" | "unknown" }>(`/api/chat/threads/${encodeURIComponent(remoteId)}/steer`, {
        method: "POST",
        body: JSON.stringify({ generationId: attempt.generationId, idempotencyKey: attempt.id, text: prompt, confirmToolInterruption: false }),
      });
      steerAttempt.current = null;
      if (result.status === "unknown") {
        setActionError(t("引导结果未明；不会重发。请核对原生输出。", "Steering result is unknown; it will not be resent. Inspect native output."));
        return;
      }
      aui.composer.setText("");
    } catch (cause) {
      // Keep the idempotency key: a retry must not duplicate the same steer.
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(undefined);
    }
  };

  const queueMessage = async () => {
    if (!remoteId || !prompt.trim() || pending) return;
    if (!isPlainTextDraft({ hasText: true, attachmentCount, hasQuote, selectionCount: contextDraft.items.length + pmWorkspace.references.length })) {
      setActionError(t("队列只接管纯文字；附件或引用会保留在当前草稿中，执行结束后再发送。", "The queue takes plain text only; attachments or references stay in the current draft for sending after the turn ends."));
      return;
    }
    setPending("queue");
    setActionError(undefined);
    try {
      const settings = await flushThreadSettings(remoteId);
      const id = crypto.randomUUID();
      const draft = { message: { id: crypto.randomUUID(), role: "user" as const, parts: [{ type: "text" as const, text: prompt }] } };
      await workspaceClient.json(`/api/chat/threads/${encodeURIComponent(remoteId)}/queue`, {
        method: "POST",
        body: JSON.stringify({ id, draft, threadSettingsRevision: settings.revision }),
      });
      aui.composer.setText("");
      window.dispatchEvent(new CustomEvent("agent-message-actions-changed", { detail: { threadId: remoteId, armQueueId: id } }));
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(undefined);
    }
  };

  const continueGeneration = async () => {
    if (!remoteId || !latestGenerationId || !resumeConfirmed || pending) return;
    setPending("resume");
    setActionError(undefined);
    try {
      await workspaceClient.json(`/api/chat/generations/${encodeURIComponent(latestGenerationId)}/continue`, {
        method: "POST",
        body: JSON.stringify({ confirmSideEffects: true }),
      });
      window.dispatchEvent(new CustomEvent("agent-thread-action", { detail: { threadId: remoteId, generationId: latestGenerationId, reload: true } }));
      setResumeOpen(false);
      setResumeConfirmed(false);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(undefined);
    }
  };

  const dictation = <AuiIf condition={(s) => s.thread.capabilities.dictation}>
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
  </AuiIf>;

  const label = t(action.label.zh, action.label.en);
  const reason = action.reason ? t(action.reason.zh, action.reason.en) : undefined;
  const sendShortcut = t(
    preferences.sendShortcut === "enter" ? "发送消息 · Enter" : "发送消息 · Ctrl / ⌘ + Enter",
    preferences.sendShortcut === "enter" ? "Send message · Enter" : "Send message · Ctrl / ⌘ + Enter",
  );
  const primary = action.kind === "hidden" ? null
    : action.kind === "update-queued" ? (
      <Button type="button" size="sm" disabled={action.disabled} title={reason ?? label} onClick={props.onUpdateQueued}>
        {props.queueUpdatePending ? t("正在更新…", "Updating…") : label}
      </Button>
    ) : action.kind === "submit" ? (
      <ComposerPrimitive.Send asChild onClick={(event) => { if (historyBlocked || onUsageCommand()) event.preventDefault(); }}>
        <TooltipIconButton
          tooltip={reason ?? sendShortcut}
          side="bottom"
          type="button"
          variant="default"
          size="icon"
          className="aui-composer-send size-7 rounded-full"
          disabled={action.disabled}
          aria-label={label}
        >
          <ArrowUpIcon className="aui-composer-send-icon size-4" />
        </TooltipIconButton>
      </ComposerPrimitive.Send>
    ) : action.kind === "send-context" ? (
      <TooltipIconButton type="button" tooltip={reason ?? label} aria-label={label} disabled={action.disabled} variant="default" className="aui-composer-send size-7 rounded-full" onClick={() => {
        const thread = aui.thread.getState();
        if (historyBlocked || thread.isRunning || thread.isDisabled || thread.isLoading || thread.isSendDisabled || onUsageCommand()) return;
        aui.thread.append({ role: "user", content: [{ type: "text", text: aui.composer.getState().text }] });
      }}><ArrowUpIcon className="size-4" /></TooltipIconButton>
    ) : (
      <TooltipIconButton
        type="button"
        tooltip={reason ?? label}
        aria-label={label}
        disabled={action.disabled || !!pending}
        variant="default"
        size="icon"
        className="aui-composer-send size-7 rounded-full"
        onClick={() => {
          if (action.kind === "steer") void sendSteer();
          else if (action.kind === "queue") void queueMessage();
          else if (action.kind === "resume") setResumeOpen(true);
        }}
      >
        {action.kind === "steer" ? <RouteIcon className="size-4" />
          : action.kind === "queue" ? <ListTodoIcon className="size-4" />
            : <RefreshCwIcon className="size-4" />}
      </TooltipIconButton>
    );

  return <>
    <div ref={wrapper} className={cn("aui-composer-action-wrapper", styles.controls)} data-density={density}>
      <div className={styles.leftControls}>
        <ModelFanoutPicker
          key={`${threadId}:${fanoutEpoch}`}
          providerInstanceId={providerInstanceId}
          model={model}
          onChange={onModelChange}
          catalog={catalog}
          disabled={(modelPickerDisabled ?? disabled) || threadRunning || fanoutPending || props.editingQueue || props.compactionPending}
          saving={saving}
          saveError={saveError}
          onRetry={onRetry}
          modelOptions={modelOptions}
          onFanoutChange={onFanoutChange}
          showStackControl={false}
        />
        {onSettingsChange && <ComposerTraitsPicker
          key={`effort:${threadId}:${providerInstanceId}:${model}`}
          reasoningOnly
          showInteractionMode={false}
          driver={provider?.driver}
          prompt={prompt}
          onPromptEdit={(edit) => aui.composer.setText(edit(aui.composer.getState().text))}
          model={activeModel}
          selections={modelOptions}
          interactionMode={interactionMode}
          onSettingsChange={onSettingsChange}
          disabled={(modelPickerDisabled ?? disabled) || threadRunning || props.queueUpdatePending || props.compactionPending}
          saving={saving}
          saveError={saveError}
          catalogLoading={catalog.loading}
          catalogError={catalog.error}
          onRetry={onRetry}
        />}
      </div>
      <div className={styles.rightControls}>
        {!collapsed.has("contextActions") && composerActions}
        {!collapsed.has("contextMeter") && <ContextMeter />}
        {!collapsed.has("attachment") && <ComposerAddAttachment />}
        {!collapsed.has("dictation") && dictation}
        {collapsed.size > 0 && <Popover>
          <PopoverTrigger render={<TooltipIconButton
            tooltip={t("更多控件", "More controls")}
            aria-label={t("更多控件", "More controls")}
            type="button"
            variant="ghost"
            size="icon"
            className="aui-composer-more text-muted-foreground hover:text-foreground size-7 rounded-full"
          />}>
            <MoreHorizontalIcon className="size-4" />
          </PopoverTrigger>
          <PopoverContent side="top" align="end" className="composer-more-menu w-60 space-y-2 p-2 text-xs">
            <PopoverTitle className="text-xs font-medium text-muted-foreground">{t("更多控件", "More controls")}</PopoverTitle>
            {collapsed.has("contextActions") && composerActions && <div className="composer-more-row">{composerActions}</div>}
            {collapsed.has("contextMeter") && <div className="composer-more-row"><ContextMeter /></div>}
            {collapsed.has("attachment") && <div className="composer-more-row"><ComposerAddAttachment /></div>}
            {collapsed.has("dictation") && <div className="composer-more-row">{dictation}</div>}
          </PopoverContent>
        </Popover>}
        {/* A running turn hides plain submit behind its cancel control, but a
            real follow-up capability (steer/queue) stays reachable. Stacked
            models own the primary slot so no single-session send path leaks. */}
        {fanoutActive && !props.editingQueue
          ? <FanoutSendButton pending={fanoutPending} blocker={fanoutBlocker} onClick={onFanoutSend} />
          : action.kind === "submit" || action.kind === "send-context"
            ? <AuiIf
              condition={(s) =>
                !s.composer.canCancel ||
                (s.thread.voice !== undefined && s.composer.submission === undefined)
              }
            >
              {primary}
            </AuiIf>
            : primary}
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
    {resumeOpen && action.kind === "resume" && !props.editingQueue && !props.compactionPending && <div className="composer-resume-confirm" role="group" aria-label={t("继续未完成部分前的核对", "Review before continuing")}>
      <label className="composer-resume-confirm-label">
        <input type="checkbox" checked={resumeConfirmed} onChange={(event) => setResumeConfirmed(event.target.checked)} />
        {t("已核对可能发生的外部副作用，授权仅继续未完成部分。", "I reviewed possible external side effects and authorize continuing only the unfinished part.")}
      </label>
      <div className="composer-resume-confirm-actions">
        <Button type="button" size="sm" variant="outline" disabled={!resumeConfirmed || !!pending} onClick={() => void continueGeneration()}>
          {pending === "resume" ? t("正在继续…", "Continuing…") : t("继续未完成部分", "Continue unfinished part")}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={!!pending} onClick={() => { setResumeOpen(false); setResumeConfirmed(false); }}>
          {t("取消", "Cancel")}
        </Button>
      </div>
    </div>}
    {actionError && <p role="alert" className="composer-action-error">{actionError}</p>}
  </>;
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
  const { locale } = useI18n();
  const messageLocale = locale === "en" ? "en" : "zh-CN";
  const authorLabel = formatMessageAuthorLabel("assistant", times.get(messageId), messageLocale);

  return (
    <MessageContextMenu actionsDisabled={actionsDisabled} role="assistant">
    <MessagePrimitive.Root
      data-slot="aui_assistant-message-root"
      data-role="assistant"
      role="article"
      aria-label={authorLabel}
      tabIndex={0}
      className="fade-in slide-in-from-bottom-1 animate-in relative -mb-7.5 pb-7.5 duration-150 [contain-intrinsic-size:auto_200px] [content-visibility:auto]"
    >
      <div
        data-slot="aui_assistant-message-content"
        className="aui-assistant-message-content-body text-foreground px-2 text-sm leading-6 wrap-break-word"
      >
        <h2 className="sr-only">{authorLabel}</h2>
        <MessagePrimitive.Quote>
          {quote => <AssistantQuoteCitation quote={quote} locale={messageLocale} />}
        </MessagePrimitive.Quote>
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
  const { locale } = useI18n();
  const messageLocale = locale === "en" ? "en" : "zh-CN";
  const authorLabel = formatMessageAuthorLabel("user", times.get(messageId), messageLocale);
  return (
    <MessageContextMenu actionsDisabled={actionsDisabled} role="user">
    <MessagePrimitive.Root
      data-slot="aui_user-message-root"
      className="fade-in slide-in-from-bottom-1 animate-in grid auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 duration-150 [contain-intrinsic-size:auto_200px] [content-visibility:auto] [&:where(>*)]:col-start-2"
      data-role="user"
      role="article"
      aria-label={authorLabel}
      tabIndex={0}
    >
      <h2 className="sr-only">{authorLabel}</h2>
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
  const suggestions = useComposerSuggestions(providerInstanceId, disabled);
  const [limitsRequest, setLimitsRequest] = useState(0);
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
      role="article"
      aria-label={t("编辑用户消息", "Editing user message")}
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
