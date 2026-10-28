"use client"
import {
  useId,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react"
import {
  Box,
  Check,
  ChevronDown,
  Copy as CopyIcon,
  LoaderCircle,
  MoreHorizontal,
  PanelLeft,
  Share2,
} from "lucide-react"
import type { ComposerDemoController } from "../demo-controller"
import type { ComposerDemoSource } from "../demo-source"
import type { ChatEntry, Copy } from "../model"

import type { ComposerHost } from "../composer-workspace-view"
import {
  Button,
  Badge,
  UIProvider,
  Progress,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui"
import { useConversationController } from "./locale"
import { Markdown } from "./markdown"
import { ConversationFrame } from "./frame"
import { ConversationInput, type ConversationInputOptions } from "./input"
import { threadTitles, type ThreadPage } from "./fixtures"
import {
  ThreadResourceLayout,
  type ResourcePanelController,
} from "./resource-layout"
import styles from "./reference.module.css"
import frameStyles from "./frame.module.css"

export interface ThreadController extends ComposerDemoController {
  readState: "ready" | "loading" | "error"
  setReadState: Dispatch<SetStateAction<ThreadController["readState"]>>
}
export function useThreadController(
  source: ComposerDemoSource,
  scenario: string,
  active: boolean,
  capabilities: { canSend?: boolean } = {},
): ThreadController {
  const [readState, setReadState] = useState<ThreadController["readState"]>(
    scenario === "loading"
      ? "loading"
      : scenario === "error"
        ? "error"
        : "ready",
  )
  const controller = useConversationController(
    { ...source, canSend: readState !== "loading" },
    active,
  )
  const canSend =
    controller.canSend &&
    (controller.selectedId !== source.selectedId ||
      capabilities.canSend !== false)
  return {
    ...controller,
    canSend,
    sendMessage: () => {
      if (canSend) controller.sendMessage()
    },
    readState,
    setReadState,
  }
}
export function MessageContexts({
  message,
  controller,
}: {
  message: ChatEntry
  controller: Pick<ThreadController, "label">
}) {
  if (!message.contexts?.length) return null
  return (
    <div
      className={styles.contexts}
      role="group"
      aria-label={controller.label("上下文引用", "Context references")}
    >
      {message.contexts.map((name) => (
        <Badge variant="secondary" key={name}>
          {name}
        </Badge>
      ))}
    </div>
  )
}
export type ThreadMessageState =
  | "idle"
  | "pending"
  | "loading"
  | "streaming"
  | "complete"
  | "success"
  | "error"
  | "failed"
  | "cancelled"
  | "unknown"
export function ThreadMessage({
  message,
  controller,
  children,
  messageState,
  reason,
  onRetry,
  activity,
  author,
  agentRole,
  actions,
  hideContent = false,
}: {
  message: ChatEntry
  controller: ThreadController
  children?: ReactNode
  messageState?: ThreadMessageState
  reason?: string
  onRetry?: () => void
  activity?: ReactNode
  author?: string
  agentRole?: string
  actions?: ReactNode
  hideContent?: boolean
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
    "idle",
  )
  const role =
    message.role === "assistant"
      ? "agent"
      : message.role === "user"
        ? "user"
        : "system"
  const isError = messageState === "error" || messageState === "failed"
  const unknown = messageState === "unknown" || message.state === "unknown"
  return (
    <article
      className={styles.message}
      data-thread-role={role}
      data-message-role={role}
      data-message-id={message.id}
      aria-label={
        role === "user"
          ? controller.label("用户消息", "User message")
          : controller.label(
              "本地 Agent 示例回复",
              "Local Agent example response",
            )
      }
      aria-busy={messageState === "streaming" || messageState === "loading"}
    >
      {role !== "user" && (
        <header className={styles.messageHeader}>
          <Box size={16} aria-hidden="true" />
          <strong>
            {author ??
              controller.label(
                "EasyuseUI · 示例回复",
                "EasyuseUI · Example response",
              )}
          </strong>
          {agentRole && <small>{agentRole}</small>}
        </header>
      )}
      <div className={styles.messageBody}>
        {activity}
        {!hideContent && (
          <Markdown
            content={controller.copy(message.text)}
            locale={controller.locale}
            streaming={messageState === "streaming"}
          />
        )}
        <MessageContexts message={message} controller={controller} />
        {children}
      </div>
      {(isError || unknown || messageState === "cancelled" || reason) && (
        <div
          role={isError || unknown ? "alert" : "status"}
          className={styles.notice}
        >
          {reason ??
            (unknown
              ? controller.label(
                  "结果未知；请明确查询，不会自动重放。",
                  "Outcome unknown; explicitly check it. No automatic replay.",
                )
              : isError
                ? controller.label("本地示例失败。", "Local example failed.")
                : controller.label(
                    "已停止本地示例。",
                    "Local example stopped.",
                  ))}
          {onRetry && !unknown && (
            <Button variant="outline" size="sm" onClick={onRetry}>
              {controller.label("重试本地示例", "Retry local example")}
            </Button>
          )}
        </div>
      )}
      {(actions || (role === "agent" && !hideContent)) && (
        <footer className={styles.messageActions}>
          {actions ?? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={controller.label(
                "复制原始回复",
                "Copy original response",
              )}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(
                    controller.copy(message.text),
                  )
                  setCopyState("copied")
                } catch {
                  setCopyState("error")
                }
              }}
            >
              {copyState === "copied" ? <Check /> : <CopyIcon />}
            </Button>
          )}
          {copyState !== "idle" && (
            <span role={copyState === "error" ? "alert" : "status"}>
              {copyState === "copied"
                ? controller.label("已复制", "Copied")
                : controller.label(
                    "复制失败，请手动选择文本。",
                    "Copy failed; select the text manually.",
                  )}
            </span>
          )}
        </footer>
      )}
    </article>
  )
}
export function ThreadActivity({
  title,
  children,
  elapsed,
  defaultOpen = true,
}: {
  title: string
  children: ReactNode
  elapsed?: string
  defaultOpen?: boolean
}) {
  return (
    <Collapsible defaultOpen={defaultOpen} className={styles.activity}>
      <CollapsibleTrigger asChild>
        <Button variant="ghost" className={styles.activityTitle}>
          <Box aria-hidden="true" />
          <span>{title}</span>
          {elapsed && <span>{elapsed}</span>}
          <ChevronDown aria-hidden="true" />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent forceMount>
        <div className={styles.activitySteps}>{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}
export function ThreadPanel({
  title,
  actions,
  children,
  className = "",
}: {
  title?: string
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={`${styles.panel} ${className}`} aria-label={title}>
      {(title || actions) && (
        <header className={styles.panelHeader}>
          {title && <h3 className={styles.panelTitle}>{title}</h3>}
          {actions && <div className={styles.panelActions}>{actions}</div>}
        </header>
      )}
      <div className={styles.panelBody}>{children}</div>
    </section>
  )
}
export function ThreadStatus({
  status,
  label,
}: {
  status: string
  label: string
}) {
  return (
    <Badge
      variant={
        status === "failed" || status === "error" || status === "unknown"
          ? "destructive"
          : "outline"
      }
    >
      {status === "running" && (
        <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" />
      )}
      {label}
    </Badge>
  )
}
export interface ThreadTask {
  id: string
  title: string
  status: "pending" | "running" | "completed" | "failed" | "unknown"
}
export function ThreadTasks({
  title,
  steps,
  open,
  onOpenChange,
}: {
  title: string
  steps: ThreadTask[]
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const completed = steps.filter((step) => step.status === "completed").length
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} defaultOpen>
      <CollapsibleTrigger asChild>
        <Button variant="ghost" className="w-full justify-between">
          <span>{title}</span>
          <span>
            {completed}/{steps.length}
          </span>
          <ChevronDown />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent forceMount>
        <Progress
          value={steps.length ? (completed / steps.length) * 100 : 0}
          aria-label={title}
        />
        <ol className="grid gap-2 py-3">
          {steps.map((step) => (
            <li key={step.id} className="flex items-center gap-2">
              {step.status === "completed" ? (
                <Check size={14} aria-hidden="true" />
              ) : step.status === "running" ? (
                <LoaderCircle
                  size={14}
                  className="motion-safe:animate-spin"
                  aria-hidden="true"
                />
              ) : (
                <span
                  className="size-3.5 rounded-full border"
                  aria-hidden="true"
                />
              )}
              <span>{step.title}</span>
              <span className="sr-only">{step.status}</span>
            </li>
          ))}
        </ol>
      </CollapsibleContent>
    </Collapsible>
  )
}
function ThreadHeader({
  controller,
  title,
  showSessionNavigation,
  actions,
}: {
  controller: ThreadController
  title: string
  showSessionNavigation: boolean
  actions?: ReactNode
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
    "idle",
  )
  const menuTrigger = useRef<HTMLButtonElement>(null)
  return (
    <header className={styles.header} data-composer-region="page-header">
      {showSessionNavigation && (
        <Button
          variant="ghost"
          size="icon"
          aria-label={controller.label(
            "切换会话导航",
            "Toggle session navigation",
          )}
          aria-expanded={controller.sessionsVisible}
          onClick={() => controller.setSessionsVisible((value) => !value)}
        >
          <PanelLeft />
        </Button>
      )}
      <span className={styles.headerTitle} title={title}>
        {title}
      </span>
      <div className={styles.headerActions}>
        {actions}
        {copyState !== "idle" && (
          <span role={copyState === "error" ? "alert" : "status"}>
            {copyState === "copied"
              ? controller.label("已复制本地会话", "Local conversation copied")
              : controller.label(
                  "复制失败，请使用导出。",
                  "Copy failed; use export.",
                )}
          </span>
        )}
        <Button
          variant="ghost"
          aria-label={controller.label(
            "分享本地会话副本",
            "Share local conversation copy",
          )}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(
                controller.selected.messages
                  .map(
                    (message) =>
                      `${message.role}: ${controller.copy(message.text)}`,
                  )
                  .join("\n\n"),
              )
              setCopyState("copied")
            } catch {
              setCopyState("error")
            }
          }}
        >
          <Share2 />
          {controller.label("分享", "Share")}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              ref={menuTrigger}
              variant="ghost"
              size="icon"
              aria-label={controller.label("会话操作", "Session actions")}
            >
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={controller.exportConversation}>
              {controller.label("导出对话", "Export conversation")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                menuTrigger.current?.focus()
                controller.setRenameValue(
                  controller.copy(controller.selected.title),
                )
                controller.setDialog("rename")
              }}
            >
              {controller.label("重命名会话", "Rename session")}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!controller.clearSession}
              onSelect={() => {
                menuTrigger.current?.focus()
                controller.setDialog("clear")
              }}
            >
              {controller.label("清空对话", "Clear conversation")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                menuTrigger.current?.focus()
                controller.openSettings()
              }}
            >
              {controller.label("设置", "Settings")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
export function ThreadView({
  page,
  controller,
  host,
  renderMessage,
  resource,
  mainView,
  beforeInput,
  inputOptions,
  showSessionNavigation = true,
  workspaceNavigation,
  pageHeader,
  headerActions,
  afterInput,
  title,
  layout = "conversation",
  body,
}: {
  page: ThreadPage
  controller: ThreadController
  host: ComposerHost
  renderMessage: (message: ChatEntry) => ReactNode
  resource?: {
    title: string
    content: ReactNode
    controller: ThreadController & ResourcePanelController
    header?: ReactNode
    side?: "left" | "right"
  }
  mainView?: { open: boolean; content: ReactNode; className?: string }
  beforeInput?: ReactNode
  inputOptions?: ConversationInputOptions
  showSessionNavigation?: boolean
  workspaceNavigation?: ReactNode
  pageHeader?: ReactNode
  headerActions?: ReactNode
  afterInput?: ReactNode
  title?: Copy
  layout?: "conversation" | "workbench" | "document" | "delegated"
  body?: ReactNode
}) {
  const [portalContainer, setPortalContainer] = useState<HTMLDivElement | null>(
    null,
  )
  const hydrated = portalContainer !== null
  const { history: historyRef } = controller
  const helpId = useId()

  const headerTitle =
    controller.selectedId === page
      ? controller.copy(title ?? threadTitles[page])
      : controller.copy(controller.selected.title)
  const readNotice = controller.readState !== "ready" && (
    <div
      className={frameStyles.readNotice}
      role={controller.readState === "error" ? "alert" : "status"}
    >
      <span>
        {controller.readState === "error"
          ? controller.label(
              "刷新失败，已有消息和草稿保留。",
              "Refresh failed; existing messages and drafts are preserved.",
            )
          : controller.label(
              "正在刷新，已有内容保留 · 本地场景",
              "Refreshing; existing content is preserved · Local fixture",
            )}
      </span>
      <Button
        variant="outline"
        size="sm"
        onClick={() => controller.setReadState("ready")}
      >
        {controller.readState === "error"
          ? controller.label("重试读取示例", "Retry example read")
          : controller.label("完成加载示例", "Finish example load")}
      </Button>
    </div>
  )
  const canvas = (
    <div className={frameStyles.canvas} data-composer-region="canvas">
      <div
        ref={historyRef}
        className={frameStyles.history}
        data-composer-region="history"
        onScroll={controller.rememberPosition}
        role="region"
        aria-label={controller.label("消息历史", "Message history")}
      >
        <div className={frameStyles.thread}>
          {controller.selected.messages.length ? (
            controller.selected.messages.map((message) => (
              <div key={message.id}>{renderMessage(message)}</div>
            ))
          ) : (
            <div className={frameStyles.welcome}>
              <h2>{controller.copy(title ?? threadTitles[page])}</h2>
              <p>
                {controller.label(
                  "输入消息开始本地对话示例。",
                  "Enter a message to start a local conversation example.",
                )}
              </p>
            </div>
          )}
        </div>
      </div>
      <div className={frameStyles.composerFooter}>
        {beforeInput}
        <ConversationInput
          controller={controller}
          helpId={helpId}
          options={{
            hideSuggestion: true,
            showBlocksControl: false,
            ...inputOptions,
          }}
        />
        {afterInput}
        {controller.feedback && (
          <p role="status" className="mt-2 text-xs text-muted-foreground">
            {controller.feedback}
          </p>
        )}
      </div>
    </div>
  )
  const history = mainView ? (
    <div className={styles.mainViews}>
      <div
        hidden={mainView.open && controller.selectedId === page}
        className={styles.mainViews}
      >
        {canvas}
      </div>
      <div
        hidden={!mainView.open || controller.selectedId !== page}
        className={`${styles.mainView} ${mainView.className ?? ""}`}
      >
        {mainView.content}
      </div>
    </div>
  ) : (
    canvas
  )
  const content =
    body !== undefined && controller.selectedId === page ? (
      <div className={styles.mainViews}>{body}</div>
    ) : resource ? (
      <ThreadResourceLayout
        canvas={history}
        title={resource.title}
        controller={resource.controller}
        header={resource.header}
        side={resource.side}
      >
        <div
          hidden={controller.selectedId !== page}
          className={styles.resourceContent}
          data-resource-scroll
          tabIndex={0}
          aria-label={controller.label("资源内容", "Resource content")}
        >
          {resource.content}
        </div>
        {controller.selectedId !== page && (
          <p role="status">
            {controller.label(
              "此会话没有该页资源；切回原会话可恢复选择与阅读位置。",
              "This conversation has no page resources; return to the original to restore selection and reading position.",
            )}
          </p>
        )}
      </ThreadResourceLayout>
    ) : (
      history
    )
  return (
    <UIProvider portalContainer={portalContainer}>
      <div
        ref={setPortalContainer}
        className={`${frameStyles.frame} ${styles.root}`}
        data-thread-page={page}
        data-thread-layout={layout}
        data-conversation-hydrated={hydrated ? "true" : "false"}
      >
        <ConversationFrame
          controller={controller}
          host={host}
          showSessionNavigation={showSessionNavigation}
          workspaceNavigation={workspaceNavigation}
          header={
            pageHeader ?? (
              <ThreadHeader
                controller={controller}
                title={headerTitle}
                showSessionNavigation={showSessionNavigation}
                actions={
                  <>
                    {headerActions}
                    {resource && (
                      <Button
                        variant="ghost"
                        aria-pressed={resource.controller.panelOpen}
                        onClick={() =>
                          resource.controller.setPanelOpen((value) => !value)
                        }
                      >
                        {controller.label("资源面板", "Resource panel")}
                      </Button>
                    )}
                  </>
                }
              />
            )
          }
        >
          <div className={styles.mainViews}>
            {readNotice}
            {content}
          </div>
        </ConversationFrame>
      </div>
    </UIProvider>
  )
}
