import {
  ComposerAddAttachment,
  ComposerAttachments,
  UserMessageAttachments,
} from "@agent/components/assistant-ui/elements/attachment.aui";
import { MarkdownText } from "@agent/components/assistant-ui/elements/markdown-text";
import {
  ComposerQuotePreview,
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { OutputTimeline } from "@agent/src/chat/output-timeline";
import { useHistoryLoadOutcome } from "@agent/src/chat/remote-adapter";
import { setResponseStreamingMode, useResponseStreamingMode } from "@agent/src/chat/response-streaming";
import { ComposerUsage } from "@agent/src/usage/ComposerUsage";
import { consumeUsageLimitsCommand } from "@agent/src/usage/ComposerUsageModel";
import { useComposerSuggestions } from "@agent/src/chat/composer-suggestions";
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
  RefreshCwIcon,
  SquareIcon,
} from "lucide-react";
import { useRef, useState, type FC, type ReactElement, type ReactNode } from "react";
import styles from "./composer-layout.module.css";


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
  sendUnavailableReason?: string;
};

export const Thread: FC<ThreadProps> = (props) => {
  const t = useAgentText();
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const isDraft = useAuiState((s) => s.threads.threadItems.find((item) => item.id === s.threads.mainThreadId)?.status === "new");
  const remoteId = useAuiState((s) => s.threads.threadItems.find((item) => item.id === s.threads.mainThreadId)?.remoteId);
  const messagesEmpty = useAuiState((s) => s.thread.messages.length === 0);
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

  return (
    <ThreadPrimitive.Root
      className="aui-root aui-thread-root bg-surface @container flex h-full flex-col"
      style={{
        // Reading width follows the browser's chat appearance preference.
        ["--thread-max-width" as string]: "var(--agent-chat-content-width, 720px)",
        ["--bubble-max-width" as string]: "560px",
        ["--composer-bg" as string]: "var(--color-card)",
        ["--composer-radius" as string]: "var(--radius-composer)",
        ["--bubble-radius" as string]: "var(--radius-bubble)",
        ["--composer-padding" as string]: "10px",
        // 略抬升表面 + 一层轻阴影，顶边微光；不透明，避免在任意背景上失去可读性
        ["--composer-shadow" as string]: "var(--shadow-composer)",
      }}
    >
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

          <div data-slot="aui_message-group" className="mb-16 flex flex-col gap-y-7 empty:hidden">
            <ThreadPrimitive.Messages>{() => <ThreadMessage
              providerInstanceId={props.providerInstanceId}
              actionsDisabled={!!props.disabled || !!props.saving || !!props.saveError || !!props.sendUnavailableReason || history.status === "error" || historyMissing}
            />}</ThreadPrimitive.Messages>
          </div>

          <ThreadPrimitive.ViewportFooter
            className={cn(
              "aui-thread-viewport-footer bg-surface flex flex-col gap-4 overflow-visible pb-4 md:pb-6",
              !isEmpty && "sticky bottom-0 mt-auto rounded-t-(--composer-radius)",
            )}
          >
            <ThreadScrollToBottom />
            <Composer {...props} historyBlocked={history.status === "error" || historyMissing} />
            {isEmpty && <AuiIf condition={(s) => s.composer.isEmpty}>
              <ThreadSuggestions />
            </AuiIf>}
          </ThreadPrimitive.ViewportFooter>
        </div>
      </ThreadPrimitive.Viewport>
      <SelectionToolbar />
    </ThreadPrimitive.Root>
  );
};

const ThreadMessage: FC<{ providerInstanceId: string; actionsDisabled: boolean }> = ({ providerInstanceId, actionsDisabled }) => {
  const role = useAuiState((s) => s.message.role);
  const isEditing = useAuiState((s) => s.message.composer.isEditing);
  const runtimeBlocked = useAuiState((s) => s.thread.isRunning || s.thread.isLoading || s.thread.isDisabled || s.thread.isSendDisabled || s.thread.voice !== undefined);
  const disabled = actionsDisabled || runtimeBlocked;

  if (isEditing) return <EditComposer providerInstanceId={providerInstanceId} disabled={disabled} />;
  if (role === "user") return <UserMessage actionsDisabled={disabled} />;
  return <AssistantMessage actionsDisabled={disabled} />;
};

const ThreadScrollToBottom: FC = () => {
  // DESIGN-PATTERNS「对话阅读」：新输出不把阅读位置拉回底部，改为显式入口。
  // 该按钮仅在已上滚时可见（到底即 disabled:invisible），运行中额外显示 “New content” 文字（与界面其余英文串一致）。
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <button
        type="button"
        data-slot="aui_thread-new-content"
        className="aui-thread-scroll-to-bottom border-border bg-card text-foreground hover:bg-accent absolute -top-12 z-10 inline-flex items-center gap-1.5 self-center rounded-full border px-3 py-1.5 text-xs shadow-[0_1px_2px_rgb(0_0_0/6%)] transition-colors duration-[var(--motion-button)] ease-out disabled:invisible motion-reduce:transition-none"
      >
        <ArrowDownIcon className="size-3.5" />
        <AuiIf condition={(s) => s.thread.isRunning}>
          <span>New content</span>
        </AuiIf>
        <span className="sr-only">Scroll to bottom</span>
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
  const [limitsRequest, setLimitsRequest] = useState(0);
  const suggestions = useComposerSuggestions(props.providerInstanceId, !!props.disabled || props.historyBlocked);
  const unavailableReason = useAuiState((s) => {
    if (s.composer.isEmpty || s.composer.canSend || s.thread.isRunning) return undefined;
    if (s.thread.isDisabled) return "restoring" as const;
    if (s.thread.isSendDisabled) return "send-disabled" as const;
    if (s.composer.submission) return "preparing" as const;
    return "blocked" as const;
  });
  const unavailable =
    unavailableReason === "restoring"
      ? t("会话正在恢复或不可用。", "This session is restoring or unavailable.")
      : unavailableReason === "send-disabled"
        ? props.sendUnavailableReason ?? t("发送暂不可用，请重新读取会话设置和作用域。", "Sending is unavailable; reload the session settings and scope.")
        : unavailableReason === "preparing"
          ? t("正在准备消息附件。", "Preparing message attachments.")
          : unavailableReason === "blocked"
            ? t("消息暂时无法发送，请检查附件或语音状态。", "Messages cannot be sent right now; check attachment or voice status.")
            : undefined;
  const handleUsageCommand = () => consumeUsageLimitsCommand(aui.composer, () => setLimitsRequest((request) => request + 1));
  const handleSendCommand = () => handleUsageCommand() || !suggestions.beforeSend();
  return (
    <ComposerPrimitive.Root className="aui-composer-root relative flex w-full flex-col" onSubmit={(event) => {
      if (handleSendCommand() || props.historyBlocked || suggestions.blocked) event.preventDefault();
    }}>
      <ComposerPrimitive.AttachmentDropzone asChild>
        <div
          data-slot="aui_composer-shell"
          className="aui-composer-surface border-border data-[dragging=true]:border-ring flex w-full cursor-text flex-col gap-2 rounded-(--composer-radius) border bg-(--composer-bg) p-(--composer-padding) shadow-[var(--composer-shadow)] transition-[border-color] duration-[var(--motion-hover)] data-[dragging=true]:border-dashed data-[dragging=true]:bg-[color-mix(in_oklab,var(--color-accent)_50%,var(--color-background))]"
        >
          <ComposerQuotePreview />
          <ComposerAttachments />
          {props.composerLeading}
          {suggestions.surface}
          <ComposerPrimitive.Input
            ref={suggestions.inputRef}
            role="combobox"
            {...suggestions.inputAria}
            onChange={(event) => suggestions.onInput(event.currentTarget)}
            onSelect={(event) => suggestions.onInput(event.currentTarget)}
            onCompositionStart={suggestions.onCompositionStart}
            onCompositionEnd={(event) => suggestions.onCompositionEnd(event.currentTarget)}
            placeholder={t("输入消息… 使用 @ 引用文件、$ 引用 Skill、/ 调用命令", "Type a message… use @ for files, $ for skills, / for commands")}
            className="aui-composer-input placeholder:text-muted-foreground/60 max-h-[240px] min-h-[68px] w-full resize-none bg-transparent px-2.5 py-2 text-sm leading-5 outline-none"
            rows={1}
            autoFocus
            aria-label={t("消息输入", "Message input")}
            submitMode={preferences.sendShortcut}
            onKeyDown={(event) => {
              if (suggestions.onKeyDown(event)) return;
              // assistant-ui's steer shortcut sends directly instead of submitting the form.
              if (event.key === "Enter" && event.shiftKey && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229 && (handleSendCommand() || props.historyBlocked || suggestions.blocked)) event.preventDefault();
            }}
            cancelOnEscape={false}
          />
          <ComposerAction {...props} historyBlocked={props.historyBlocked || suggestions.blocked} onUsageCommand={handleSendCommand} />
          {unavailable && <p role="status" className="px-2 text-xs text-muted-foreground">{unavailable}</p>}
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
  const responseMode = useResponseStreamingMode();
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const threadBusy = useAuiState((s) => s.thread.isRunning || s.thread.isLoading || s.threads.isLoading);
  const selection = resolveProviderModelSelection(catalog.providers, providerInstanceId, model);
  const provider = "provider" in selection ? selection.provider : undefined;
  const activeModel = "model" in selection ? selection.model : undefined;
  const effectiveOptions = modelOptions ?? provider?.modelPreferences?.options[model];

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
        <DropdownMenu>
          <DropdownMenuTrigger render={<button type="button" aria-label={t("更多输入选项", "More input options")} title={t("更多输入选项", "More input options")} className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-foreground/[0.04] hover:text-foreground" />}>
            <MoreHorizontalIcon aria-hidden="true" className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" aria-label={t("更多输入选项", "More input options")} onKeyDown={(event) => event.stopPropagation()}>
            <DropdownMenuLabel className="px-3 py-1.5 text-xs text-muted-foreground">{t("回复显示方式", "Response display")}</DropdownMenuLabel>
            <DropdownMenuRadioGroup aria-label={t("回复显示方式", "Response display")} value={responseMode}>
              <DropdownMenuRadioItem value="paragraph" closeOnClick onSelect={() => setResponseStreamingMode("paragraph")}>{t("逐段显示", "Stream by paragraph")}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="turn" closeOnClick onSelect={() => setResponseStreamingMode("turn")}>{t("整轮显示", "Show full turn")}</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className={styles.rightControls}>
        {composerActions}
        <ComposerAddAttachment />
        <AuiIf condition={(s) => s.thread.capabilities.dictation}>
          <AuiIf condition={(s) => s.composer.dictation == null}>
            <ComposerPrimitive.Dictate asChild>
              <TooltipIconButton
                tooltip="Voice input"
                side="bottom"
                type="button"
                variant="ghost"
                size="icon"
                className="aui-composer-dictate text-muted-foreground hover:text-foreground size-7 rounded-full"
                aria-label="Start voice input"
              >
                <MicIcon className="aui-composer-dictate-icon size-4" />
              </TooltipIconButton>
            </ComposerPrimitive.Dictate>
          </AuiIf>
          <AuiIf condition={(s) => s.composer.dictation != null}>
            <ComposerPrimitive.StopDictation asChild>
              <TooltipIconButton
                tooltip="Stop dictation"
                side="bottom"
                type="button"
                variant="ghost"
                size="icon"
                className="aui-composer-stop-dictation text-destructive size-7 rounded-full"
                aria-label="Stop voice input"
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
          <ComposerPrimitive.Send asChild onClick={(event) => { if (historyBlocked || onUsageCommand()) event.preventDefault(); }}>
            <TooltipIconButton
              tooltip={t(
                preferences.sendShortcut === "enter" ? "发送消息 · Enter" : "发送消息 · Ctrl / ⌘ + Enter",
                preferences.sendShortcut === "enter" ? "Send message · Enter" : "Send message · Ctrl / ⌘ + Enter",
              )}
              side="bottom"
              type="button"
              variant="default"
              size="icon"
              className="aui-composer-send size-7 rounded-full"
              disabled={historyBlocked}
              aria-label={t("发送消息", "Send message")}
            >
              <ArrowUpIcon className="aui-composer-send-icon size-4" />
            </TooltipIconButton>
          </ComposerPrimitive.Send>
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

const AssistantMessage: FC<{ actionsDisabled: boolean }> = ({ actionsDisabled }) => {
  const ACTION_BAR_PT = "pt-1.5";
  const ACTION_BAR_HEIGHT = `min-h-7.5 ${ACTION_BAR_PT}`;
  const durable = useAuiState((s) => s.message.metadata.custom.durable) as { generationId?: unknown; nativeOutput?: unknown } | undefined;
  const generationId = durable?.nativeOutput === true && typeof durable.generationId === "string" ? durable.generationId : undefined;

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
                    Reasoning
                    <ChevronDownIcon className="ms-auto size-3.5 shrink-0 transition-transform group-data-[panel-open]:rotate-180" />
                  </CollapsibleTrigger>
                  <CollapsibleContent className="overflow-hidden">
                    <div className="border-border mt-1.5 border-t pt-1.5 leading-5 whitespace-pre-wrap">
                      {part.text}
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
            aria-label="Assistant is working"
          >
            {"●"}
          </span>
        </AuiIf>
        <MessageError />
      </div>

      <div
        data-slot="aui_assistant-message-footer"
        className={cn("ms-2 flex items-center", ACTION_BAR_HEIGHT)}
      >
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
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="aui-assistant-action-bar-root text-muted-foreground animate-in fade-in col-start-3 row-start-2 -ms-1 flex gap-1 duration-200"
    >
      <ActionBarPrimitive.Copy asChild>
        <TooltipIconButton tooltip="Copy">
          <AuiIf condition={(s) => s.message.isCopied}>
            <CheckIcon className="animate-in zoom-in-50 fade-in duration-200 ease-out" />
          </AuiIf>
          <AuiIf condition={(s) => !s.message.isCopied}>
            <CopyIcon className="animate-in zoom-in-75 fade-in duration-150" />
          </AuiIf>
        </TooltipIconButton>
      </ActionBarPrimitive.Copy>
      <ActionBarPrimitive.Speak asChild>
        <TooltipIconButton tooltip="Read aloud">
          <AudioLinesIcon />
        </TooltipIconButton>
      </ActionBarPrimitive.Speak>
      <ActionBarPrimitive.StopSpeaking asChild>
        <TooltipIconButton tooltip="Stop reading">
          <SquareIcon className="size-3.5 fill-current" />
        </TooltipIconButton>
      </ActionBarPrimitive.StopSpeaking>
      <ActionBarPrimitive.Reload asChild disabled={actionsDisabled}>
        <TooltipIconButton tooltip="Refresh">
          <RefreshCwIcon />
        </TooltipIconButton>
      </ActionBarPrimitive.Reload>
      <ActionBarMorePrimitive.Root>
        <ActionBarMorePrimitive.Trigger asChild>
          <TooltipIconButton tooltip="More" className="data-[state=open]:bg-accent">
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
    </ActionBarPrimitive.Root>
  );
};

const UserMessage: FC<{ actionsDisabled: boolean }> = ({ actionsDisabled }) => {
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
          <MessagePrimitive.Parts />
        </div>
        <MessagePrimitive.Quote>
          {({ text }) => (
            <QuoteBlock.Root className="mt-1 ms-1 max-w-[min(100%,42rem)]">
              <QuoteBlock.Icon />
              <QuoteBlock.Text>{text}</QuoteBlock.Text>
            </QuoteBlock.Root>
          )}
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
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="aui-user-action-bar-root flex flex-col items-end"
    >
      <ActionBarPrimitive.Edit asChild disabled={actionsDisabled}>
        <TooltipIconButton tooltip="Edit" className="aui-user-action-edit">
          <PencilIcon />
        </TooltipIconButton>
      </ActionBarPrimitive.Edit>
    </ActionBarPrimitive.Root>
  );
};

const EditComposer: FC<{ providerInstanceId: string; disabled: boolean }> = ({ providerInstanceId, disabled }) => {
  const { preferences } = useChatBrowserPreferences();
  const aui = useAui();
  const [limitsRequest, setLimitsRequest] = useState(0);
  const handleUsageCommand = () => consumeUsageLimitsCommand(aui.composer, () => setLimitsRequest((request) => request + 1));
  return (
    <MessagePrimitive.Root
      data-slot="aui_edit-composer-wrapper"
      className="flex flex-col px-2 [contain-intrinsic-size:auto_200px] [content-visibility:auto]"
    >
      <ComposerPrimitive.Root className="aui-edit-composer-root border-border ms-auto flex w-full max-w-[85%] cursor-text flex-col rounded-(--bubble-radius) border bg-(--composer-bg) shadow-[0_4px_16px_-8px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.04)] transition-[border-color] duration-[var(--motion-hover)] dark:shadow-none" onSubmit={(event) => { if (disabled || handleUsageCommand()) event.preventDefault(); }}>
        <ComposerPrimitive.Input
          className="aui-edit-composer-input text-foreground min-h-14 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-base outline-none"
          autoFocus
          submitMode={preferences.sendShortcut}
          onKeyDown={(event) => {
            if (event.key === "Enter" && event.shiftKey && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229 && handleUsageCommand()) event.preventDefault();
          }}
        />
        <div className="aui-edit-composer-footer mx-2.5 mb-2.5 flex items-center gap-1.5 self-end">
          <ComposerPrimitive.Cancel asChild>
            <Button variant="ghost" size="sm" className="h-8 px-3">
              Cancel
            </Button>
          </ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send asChild disabled={disabled} onClick={(event) => { if (disabled || handleUsageCommand()) event.preventDefault(); }}>
            <Button size="sm" className="h-8 px-3">
              Update
            </Button>
          </ComposerPrimitive.Send>
        </div>
        {limitsRequest > 0 && <ComposerUsage providerInstanceId={providerInstanceId} limitsRequest={limitsRequest} onCloseLimits={() => setLimitsRequest(0)} />}
      </ComposerPrimitive.Root>
    </MessagePrimitive.Root>
  );
};

const BranchPicker: FC<BranchPickerPrimitive.Root.Props> = ({ className, ...rest }) => {
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
        <TooltipIconButton tooltip="Previous">
          <ChevronLeftIcon />
        </TooltipIconButton>
      </BranchPickerPrimitive.Previous>
      <span className="aui-branch-picker-state font-medium">
        <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
      </span>
      <BranchPickerPrimitive.Next asChild>
        <TooltipIconButton tooltip="Next">
          <ChevronRightIcon />
        </TooltipIconButton>
      </BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  );
};
