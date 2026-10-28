import {
  ComposerAddAttachment,
  ComposerAttachments,
  UserMessageAttachments,
} from "@/components/assistant-ui/elements/attachment.aui";
import { MarkdownText } from "@/components/assistant-ui/elements/markdown-text";
import {
  ComposerQuotePreview,
  QuoteBlock,
  SelectionToolbar,
} from "@/components/assistant-ui/elements/quote.aui";
import { ToolFallback } from "@/components/assistant-ui/elements/tool-fallback.aui";
import { ComposerModelPicker, type ComposerModelPickerCatalog } from "@/components/assistant-ui/elements/composer-model-picker.aui";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { useChatBrowserPreferences } from "@/src/settings/browser-preferences";
import { CancelGeneration } from "@/src/chat/cancel-generation";
import { OutputTimeline } from "@/src/chat/output-timeline";
import { setResponseStreamingMode, useResponseStreamingMode } from "@/src/chat/response-streaming";
import { ComposerUsage } from "@/src/usage/ComposerUsage";
import { consumeUsageLimitsCommand } from "@/src/usage/ComposerUsageModel";
import {
  ActionBarMorePrimitive,
  ActionBarPrimitive,
  AuiIf,
  type AssistantState,
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
import { useState, type FC } from "react";

// Startup exposes a loading placeholder thread; treat it as a new chat so
// the composer mounts centered. Loads after startup keep the docked layout.
const isNewChatView = (s: AssistantState) =>
  s.thread.messages.length === 0 && (!s.thread.isLoading || s.threads.isLoading);

// A switched thread that is still fetching its history: skeleton, not welcome.
const isHistoryLoadingView = (s: AssistantState) =>
  s.thread.messages.length === 0 &&
  s.thread.isLoading &&
  !s.thread.isDisabled &&
  !s.threads.isLoading;

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
  catalog: ComposerModelPickerCatalog;
  disabled?: boolean;
  saving?: boolean;
  saveError?: string;
  onRetry?: () => void | Promise<void>;
};

export const Thread: FC<ThreadProps> = (props) => {
  const isEmpty = useAuiState(isNewChatView);

  return (
    <ThreadPrimitive.Root
      className="aui-root aui-thread-root bg-background @container flex h-full flex-col"
      style={{
        // Reading width follows the browser's chat appearance preference.
        ["--thread-max-width" as string]: "var(--agent-chat-content-width, 720px)",
        ["--bubble-max-width" as string]: "560px",
        ["--composer-bg" as string]: "var(--color-card)",
        ["--composer-radius" as string]: "var(--radius-composer)",
        ["--bubble-radius" as string]: "var(--radius-bubble)",
        ["--composer-padding" as string]: "10px",
        // 略抬升表面 + 一层轻阴影，顶边微光；不透明，避免在任意背景上失去可读性
        ["--composer-shadow" as string]:
          "0 1px 2px rgb(0 0 0 / 6%), 0 8px 24px -16px rgb(0 0 0 / 24%)",
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
          <AuiIf condition={isNewChatView}>
            <ThreadWelcome />
          </AuiIf>
          <AuiIf condition={isHistoryLoadingView}>
            <ThreadHistorySkeleton />
          </AuiIf>

          <div data-slot="aui_message-group" className="mb-16 flex flex-col gap-y-7 empty:hidden">
            <ThreadPrimitive.Messages>{() => <ThreadMessage providerInstanceId={props.providerInstanceId} />}</ThreadPrimitive.Messages>
          </div>

          <ThreadPrimitive.ViewportFooter
            className={cn(
              "aui-thread-viewport-footer bg-background flex flex-col gap-4 overflow-visible pb-4 md:pb-6",
              !isEmpty && "sticky bottom-0 mt-auto rounded-t-(--composer-radius)",
            )}
          >
            <ThreadScrollToBottom />
            <Composer {...props} />
            <AuiIf condition={(s) => isNewChatView(s) && s.composer.isEmpty}>
              <ThreadSuggestions />
            </AuiIf>
          </ThreadPrimitive.ViewportFooter>
        </div>
      </ThreadPrimitive.Viewport>
      <SelectionToolbar />
    </ThreadPrimitive.Root>
  );
};

const ThreadMessage: FC<{ providerInstanceId: string }> = ({ providerInstanceId }) => {
  const role = useAuiState((s) => s.message.role);
  const isEditing = useAuiState((s) => s.message.composer.isEditing);

  if (isEditing) return <EditComposer providerInstanceId={providerInstanceId} />;
  if (role === "user") return <UserMessage />;
  return <AssistantMessage />;
};

const ThreadScrollToBottom: FC = () => {
  // DESIGN-PATTERNS「对话阅读」：新输出不把阅读位置拉回底部，改为显式入口。
  // 该按钮仅在已上滚时可见（到底即 disabled:invisible），运行中额外显示 “New content” 文字（与界面其余英文串一致）。
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <button
        type="button"
        data-slot="aui_thread-new-content"
        className="aui-thread-scroll-to-bottom border-border bg-card text-foreground hover:bg-accent absolute -top-12 z-10 inline-flex items-center gap-1.5 self-center rounded-full border px-3 py-1.5 text-xs shadow-[0_1px_2px_rgb(0_0_0/6%)] transition-colors duration-150 ease-out disabled:invisible motion-reduce:transition-none"
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

const ThreadWelcome: FC = () => {
  return (
    <div className="aui-thread-welcome-root mb-6 flex flex-col px-2">
      <p className="aui-thread-welcome-message-inner fade-in slide-in-from-bottom-1 animate-in fill-mode-both text-2xl font-medium tracking-tight duration-200">
        今天想一起完成什么？
      </p>
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
          className="aui-thread-welcome-suggestion group hover:bg-foreground/[0.03] focus-visible:ring-ring/50 flex w-full items-baseline gap-2.5 rounded-md px-2 py-2 text-start text-sm transition-colors outline-none focus-visible:ring-1 motion-reduce:transition-none"
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

const Composer: FC<ThreadProps> = (props) => {
  const { preferences } = useChatBrowserPreferences();
  const aui = useAui();
  const [limitsRequest, setLimitsRequest] = useState(0);
  const handleUsageCommand = () => consumeUsageLimitsCommand(aui.composer, () => setLimitsRequest((request) => request + 1));
  return (
    <ComposerPrimitive.Root className="aui-composer-root relative flex w-full flex-col" onSubmit={(event) => {
      if (handleUsageCommand()) event.preventDefault();
    }}>
      <ComposerPrimitive.AttachmentDropzone asChild>
        <div
          data-slot="aui_composer-shell"
          className="aui-composer-surface border-border focus-within:border-ring/60 data-[dragging=true]:border-ring flex w-full cursor-text flex-col gap-2 rounded-(--composer-radius) border bg-(--composer-bg) p-(--composer-padding) shadow-[var(--composer-shadow)] transition-[border-color] data-[dragging=true]:border-dashed data-[dragging=true]:bg-[color-mix(in_oklab,var(--color-accent)_50%,var(--color-background))]"
        >
          <ComposerQuotePreview />
          <ComposerAttachments />
          <ComposerPrimitive.Input
            placeholder="输入消息…"
            className="aui-composer-input placeholder:text-muted-foreground/60 max-h-[240px] min-h-[68px] w-full resize-none bg-transparent px-2.5 py-2 text-sm leading-5 outline-none"
            rows={1}
            autoFocus
            aria-label="消息输入"
            submitMode={preferences.sendShortcut}
            onKeyDown={(event) => {
              // assistant-ui's steer shortcut sends directly instead of submitting the form.
              if (event.key === "Enter" && event.shiftKey && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing && handleUsageCommand()) event.preventDefault();
            }}
            cancelOnEscape={false}
          />
          <ComposerAction {...props} onUsageCommand={handleUsageCommand} />
          <ComposerUsage providerInstanceId={props.providerInstanceId} limitsRequest={limitsRequest} onCloseLimits={() => setLimitsRequest(0)} />
        </div>
      </ComposerPrimitive.AttachmentDropzone>
    </ComposerPrimitive.Root>
  );
};

const ComposerAction: FC<ThreadProps & { onUsageCommand: () => boolean }> = ({ providerInstanceId, model, onModelChange, catalog, disabled, saving, saveError, onRetry, onUsageCommand }) => {
  const { preferences } = useChatBrowserPreferences();
  const responseMode = useResponseStreamingMode();
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const threadBusy = useAuiState((s) => s.thread.isRunning || s.thread.isLoading || s.threads.isLoading);

  return (
    <div className="aui-composer-action-wrapper relative flex items-center justify-between">
      <div className="flex min-w-0 items-center gap-1">
        <ComposerAddAttachment />
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
        <select aria-label="回复显示方式" title="选择按段落或整轮显示回复" value={responseMode} onChange={(event) => setResponseStreamingMode(event.target.value === "turn" ? "turn" : "paragraph")} className="max-w-20 rounded border border-border bg-transparent px-1 py-1 text-xs">
          <option value="paragraph">逐段</option>
          <option value="turn">整轮</option>
        </select>
      </div>
      <div className="flex items-center gap-1.5">
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
          <ComposerPrimitive.Send asChild onClick={(event) => { if (onUsageCommand()) event.preventDefault(); }}>
            <TooltipIconButton
              tooltip={preferences.sendShortcut === "enter" ? "发送消息 · Enter" : "发送消息 · Ctrl / ⌘ + Enter"}
              side="bottom"
              type="button"
              variant="default"
              size="icon"
              className="aui-composer-send size-7 rounded-full"
              aria-label="发送消息"
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

const AssistantMessage: FC = () => {
  const ACTION_BAR_PT = "pt-1.5";
  const ACTION_BAR_HEIGHT = `min-h-7.5 ${ACTION_BAR_PT}`;
  const durable = useAuiState((s) => s.message.metadata.custom.durable) as { generationId?: unknown; nativeOutput?: unknown } | undefined;
  const generationId = durable?.nativeOutput === true && typeof durable.generationId === "string" ? durable.generationId : undefined;

  return (
    <MessagePrimitive.Root
      data-slot="aui_assistant-message-root"
      data-role="assistant"
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
        <AssistantActionBar />
      </div>
    </MessagePrimitive.Root>
  );
};

const AssistantActionBar: FC = () => {
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
      <ActionBarPrimitive.Reload asChild>
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
          <ActionBarPrimitive.ExportMarkdown asChild>
            <ActionBarMorePrimitive.Item className="aui-action-bar-more-item hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none">
              <DownloadIcon className="size-4" />
              Export as Markdown
            </ActionBarMorePrimitive.Item>
          </ActionBarPrimitive.ExportMarkdown>
        </ActionBarMorePrimitive.Content>
      </ActionBarMorePrimitive.Root>
    </ActionBarPrimitive.Root>
  );
};

const UserMessage: FC = () => {
  return (
    <MessagePrimitive.Root
      data-slot="aui_user-message-root"
      className="fade-in slide-in-from-bottom-1 animate-in grid auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 duration-150 [contain-intrinsic-size:auto_200px] [content-visibility:auto] [&:where(>*)]:col-start-2"
      data-role="user"
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
          <UserActionBar />
        </div>
      </div>

      <BranchPicker
        data-slot="aui_user-branch-picker"
        className="col-span-full col-start-1 -me-1 justify-end"
      />
    </MessagePrimitive.Root>
  );
};

const UserActionBar: FC = () => {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="aui-user-action-bar-root flex flex-col items-end"
    >
      <ActionBarPrimitive.Edit asChild>
        <TooltipIconButton tooltip="Edit" className="aui-user-action-edit">
          <PencilIcon />
        </TooltipIconButton>
      </ActionBarPrimitive.Edit>
    </ActionBarPrimitive.Root>
  );
};

const EditComposer: FC<{ providerInstanceId: string }> = ({ providerInstanceId }) => {
  const { preferences } = useChatBrowserPreferences();
  const aui = useAui();
  const [limitsRequest, setLimitsRequest] = useState(0);
  const handleUsageCommand = () => consumeUsageLimitsCommand(aui.composer, () => setLimitsRequest((request) => request + 1));
  return (
    <MessagePrimitive.Root
      data-slot="aui_edit-composer-wrapper"
      className="flex flex-col px-2 [contain-intrinsic-size:auto_200px] [content-visibility:auto]"
    >
      <ComposerPrimitive.Root className="aui-edit-composer-root border-border focus-within:border-ring/60 ms-auto flex w-full max-w-[85%] cursor-text flex-col rounded-(--bubble-radius) border bg-(--composer-bg) shadow-[0_4px_16px_-8px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.04)] transition-[border-color] dark:shadow-none" onSubmit={(event) => { if (handleUsageCommand()) event.preventDefault(); }}>
        <ComposerPrimitive.Input
          className="aui-edit-composer-input text-foreground min-h-14 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-base outline-none"
          autoFocus
          submitMode={preferences.sendShortcut}
          onKeyDown={(event) => {
            if (event.key === "Enter" && event.shiftKey && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing && handleUsageCommand()) event.preventDefault();
          }}
        />
        <div className="aui-edit-composer-footer mx-2.5 mb-2.5 flex items-center gap-1.5 self-end">
          <ComposerPrimitive.Cancel asChild>
            <Button variant="ghost" size="sm" className="h-8 px-3">
              Cancel
            </Button>
          </ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send asChild onClick={(event) => { if (handleUsageCommand()) event.preventDefault(); }}>
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
