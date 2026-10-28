"use client"

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import {
  ArrowDown,
  ArrowRight,
  Bot,
  Check,
  CheckCircle2,
  Circle,
  Code2,
  Download,
  FileInput,
  GitBranch,
  LockKeyhole,
  Maximize2,
  Minimize2,
  Monitor,
  MoreHorizontal,
  PanelLeftClose,
  Plus,
  Share2,
  Trash2,
  UserRound,
  X,
  Pencil,
  Copy,
  Play,
} from "lucide-react"
import { useI18n } from "@easyuse-ui/ui/lib/i18n-provider"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { Input } from "@easyuse-ui/ui/components/ui/input"
import { Textarea } from "@easyuse-ui/ui/components/ui/textarea"
import { Field } from "@easyuse-ui/ui/components/ui/field"
import { ResizableHandle } from "@easyuse-ui/ui/components/ui/resizable"
import { ChatMessage } from "@easyuse-ui/ui/components/blocks/chat-message"
import { WorkflowCanvas } from "@easyuse-ui/ui/components/blocks/workflow-canvas"
import { CanvasPort } from "@easyuse-ui/ui/components/ui/canvas-port"
import { CanvasConnectionForm } from "@easyuse-ui/ui/components/blocks/canvas-connection-form"
import type { CanvasNodeProps } from "@easyuse-ui/ui/components/ui/canvas-node"
import { RuntimeStatusBadge } from "@easyuse-ui/ui/components/ui/runtime-status-badge"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@easyuse-ui/ui/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@easyuse-ui/ui/components/ui/dropdown-menu"
import { exportCanvasDocument } from "@easyuse-ui/ui/lib/canvas-validation"
import type {
  CanvasCommand,
  CanvasDocument,
  CanvasNodeRecord,
  CanvasSelection,
} from "@easyuse-ui/ui/lib/canvas-model"
import { ComposerInput } from "../../composer-input"
import { useComposerDemoController } from "../../demo-controller"
import type { ComposerDemoSource } from "../../demo-source"
import type { Copy as LocalCopy } from "../../model"
import {
  RemainingPageStateProvider,
  useRemainingPageState,
} from "../../showcase/state"
import { remainingPageScenarios } from "../../showcase/model"
import type { RemainingPageProps } from "../../showcase/model"
import {
  addStep,
  changeWorkflow,
  createWorkflowState,
  duplicateStep,
  inspectWorkflow,
  redoWorkflow,
  undoWorkflow,
  workflowIntent,
} from "./controller"
import { composerSource, definitions, kindLabels, stepCopy } from "./fixtures"
import type { StepKind } from "./fixtures"
import styles from "./view.module.css"

export const pageScenarios = remainingPageScenarios
const icons = {
  input: FileInput,
  agent: UserRound,
  decision: GitBranch,
  approval: LockKeyhole,
  code: Code2,
  quality: CheckCircle2,
}
const palette: { kind: StepKind; label: LocalCopy }[] = [
  { kind: "input", label: { "zh-CN": "输入", en: "Input" } },
  { kind: "agent", label: { "zh-CN": "代理任务", en: "Agent task" } },
  { kind: "decision", label: { "zh-CN": "决策", en: "Decision" } },
  { kind: "approval", label: { "zh-CN": "审批", en: "Approval" } },
]
function translated(
  node: CanvasNodeRecord,
  key: "title" | "description" | "owner",
  locale: "en" | "zh-CN",
) {
  const value = key === "title" ? node.title : String(node.config[key] ?? "")
  const fixture = stepCopy[node.id]?.[key]
  return fixture && value === fixture.en ? fixture[locale] : value
}
export function RemainingPageView(props: RemainingPageProps) {
  return (
    <RemainingPageStateProvider cache={props.cache}>
      <WorkflowView key={props.scenario} {...props} />
    </RemainingPageStateProvider>
  )
}
function WorkflowView({ scenario, active, host, cache }: RemainingPageProps) {
  const { locale, resolve } = useI18n()
  const label = (zh: string, en: string) => (locale === "en" ? en : zh)
  const [state, setState] = useRemainingPageState("workflow-1:state", () =>
    createWorkflowState(scenario),
  )
  const [source] = useState(
    () =>
      (cache.get("workflow-1:composer") as ComposerDemoSource | undefined) ??
      composerSource(scenario),
  )
  const composer = useComposerDemoController(source, active, false)
  const [dialog, setDialog] = useState<
    "share" | "edit" | "delete" | "connect" | null
  >(null)
  const [editorError, setEditorError] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const historyRef = useRef<HTMLDivElement>(null)
  const [availableWidth, setAvailableWidth] = useState(1451)
  const panelId = useId()
  const helpId = useId()
  const readonly = scenario === "readonly"
  const locked = readonly || state.readState === "loading"
  const selectedNode = state.document.nodes.find(
    (node) => node.id === state.selection.nodeIds[0],
  )
  const selectedEdge = state.document.edges.find(
    (edge) => edge.id === state.selection.edgeIds[0],
  )
  const panelWidth = Math.min(
    Math.max(600, availableWidth - 280),
    state.panelWidth ?? availableWidth * 0.72,
  )
  const command = useCallback(
    (action: CanvasCommand) =>
      setState((previous) => changeWorkflow(previous, action, locked)),
    [setState, locked],
  )
  const select = useCallback(
    (selection: CanvasSelection) =>
      setState((previous) => ({ ...previous, selection })),
    [setState],
  )
  const viewportChange = useCallback(
    (viewport: NonNullable<CanvasDocument["viewport"]>) =>
      setState((previous) => ({
        ...previous,
        document: { ...previous.document, viewport },
      })),
    [setState],
  )
  useEffect(() => {
    cache.set("workflow-1:composer", {
      ...source,
      sessions: composer.sessions,
      drafts: composer.drafts,
    })
  }, [cache, source, composer.sessions, composer.drafts])
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (!body) return
    const observer = new ResizeObserver(([entry]) =>
      setAvailableWidth(entry.contentRect.width),
    )
    observer.observe(body)
    return () => observer.disconnect()
  }, [])
  useLayoutEffect(() => {
    if (active && historyRef.current)
      historyRef.current.scrollTop = Number(
        cache.get("workflow-1:reading") ?? 0,
      )
  }, [active, cache, historyRef])
  useEffect(() => {
    if (!active) return
    const onKey = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat ||
        !(event.target instanceof Element) ||
        event.target.closest(
          "input,textarea,select,[contenteditable=true],[role=dialog]",
        )
      )
        return
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "z" &&
        !locked
      ) {
        event.preventDefault()
        setState((previous) =>
          event.shiftKey ? redoWorkflow(previous) : undoWorkflow(previous),
        )
      }
      if (event.key === "Escape") {
        setState((previous) => ({
          ...previous,
          selection: { nodeIds: [], edgeIds: [] },
        }))
        composer.focusComposer()
      }
      if (
        event.key === "Delete" &&
        !locked &&
        event.target.closest("[data-canvas-editor-context]") &&
        (state.selection.nodeIds.length || state.selection.edgeIds.length)
      ) {
        event.preventDefault()
        setDialog("delete")
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [active, locked, setState, state.selection, composer])
  function validate() {
    setState((previous) => ({
      ...previous,
      issues: inspectWorkflow(previous.document),
      validatedRevision: previous.document.revision,
      feedback: null,
    }))
  }
  const openEditor = useCallback(
    (node: CanvasNodeRecord | undefined) => {
      if (!node) return
      setState((previous) => ({
        ...previous,
        selection: { nodeIds: [node.id], edgeIds: [] },
        editorDrafts: {
          ...previous.editorDrafts,
          [node.id]: previous.editorDrafts[node.id] ?? {
            title: node.title,
            description: String(node.config.description ?? ""),
            owner: String(node.config.owner ?? ""),
            condition: String(node.config.condition ?? "risk == high"),
          },
        },
      }))
      setEditorError(false)
      setDialog("edit")
    },
    [setState],
  )
  function sendMessage() {
    if (locked || !composer.draft.text.trim()) return
    const text = composer.draft.text.trim()
    const intent = workflowIntent(text)
    let reply: LocalCopy = {
      "zh-CN":
        "已记录为本地流程讨论。可使用“添加审批”“添加代理任务”或“验证流程”修改草稿。没有调用外部模型或运行流程。",
      en: "Recorded in the local workflow discussion. Use “add approval”, “add agent task”, or “validate flow” to change the draft. No external model was called and no workflow was run.",
    }
    if (intent.type === "add") {
      setState((previous) =>
        addStep(previous, intent.kind, kindLabels[intent.kind][locale], locked),
      )
      reply = {
        "zh-CN":
          "已向本地草稿添加步骤。请检查指令与负责人，并连接到现有路径。没有运行流程。",
        en: "Added a step to the local draft. Configure its instructions and owner, then connect it to the existing route. No workflow was run.",
      }
    }
    if (intent.type === "validate") {
      validate()
      reply = {
        "zh-CN":
          "已检查当前本地图结构。请查看画布上的校验结果；这不是执行结果。",
        en: "Checked the current local graph. Review the validation result on the canvas; this is not an execution result.",
      }
    }
    composer.setSessions((previous) =>
      previous.map((session) =>
        session.id === composer.selectedId
          ? {
              ...session,
              messages: [
                ...session.messages,
                {
                  id: `request-${state.document.revision}-${session.messages.length}`,
                  role: "user",
                  text,
                },
                {
                  id: `reply-${state.document.revision}-${session.messages.length}`,
                  role: "assistant",
                  text: reply,
                },
              ],
            }
          : session,
      ),
    )
    composer.updateDraft({ text: "" })
    requestAnimationFrame(() => {
      composer.focusComposer()
      historyRef.current?.scrollTo({
        top: historyRef.current.scrollHeight,
        behavior: "auto",
      })
    })
  }
  function download() {
    const blob = new Blob([exportCanvasDocument(state.document)], {
      type: "application/json",
    })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = "guarded-release-workflow.json"
    anchor.click()
    URL.revokeObjectURL(url)
  }
  const closePanel = () => {
    setState((previous) => ({ ...previous, panelOpen: false, expanded: false }))
    composer.focusComposer()
  }
  const renderNode = useCallback(
    (props: CanvasNodeProps) => {
      const { node, definition, selected, readOnly } = props
      const kind = node.type as StepKind
      const Icon = icons[kind] ?? GitBranch
      const completed = node.id === "brief"
      const tasks = Array.isArray(node.config.tasks)
        ? node.config.tasks.map(String)
        : []
      return (
        <div
          className={styles.step}
          data-canvas-node={node.id}
          data-selected={selected || undefined}
        >
          <div className={styles.stepHeading}>
            <div className={styles.stepTop}>
              <span className={styles.stepIcon}>
                <Icon size={16} />
              </span>
              <div className={styles.stepTitle}>
                <small>{kindLabels[kind]?.[locale]}</small>
                <strong title={translated(node, "title", locale)}>
                  {translated(node, "title", locale)}
                </strong>
              </div>
              <RuntimeStatusBadge
                status={completed ? "completed" : "waiting"}
              />
            </div>
            <p className={styles.stepDescription}>
              {translated(node, "description", locale) ||
                (locale === "en"
                  ? "Configure this step before connecting it."
                  : "连接前请先配置此步骤。")}
            </p>
          </div>
          <div className={styles.stepTasks}>
            {tasks.length ? (
              tasks.map((task, index) => (
                <div key={index}>
                  {completed ? <Check size={12} /> : <Circle size={12} />}
                  <span>
                    {stepCopy[node.id]?.tasks[index]?.en === task
                      ? stepCopy[node.id].tasks[index][locale]
                      : task}
                  </span>
                </div>
              ))
            ) : (
              <p>
                {locale === "en"
                  ? "Select the node to inspect its configuration and dependencies."
                  : "选择节点以检查其配置和依赖。"}
              </p>
            )}
          </div>
          <footer className={styles.stepFooter}>
            <span>
              <UserRound size={12} />
              {translated(node, "owner", locale) ||
                (locale === "en" ? "Unassigned" : "未分配")}
            </span>
            <span className={styles.stepPercent} data-completed={completed}>
              {completed ? "100%" : "0%"}
              <i />
            </span>
          </footer>
          <div className={styles.ports}>
            {definition?.ports.map((port) => (
              <CanvasPort key={port.id} port={port} readOnly={readOnly} />
            ))}
          </div>
          {selected && (
            <div className={`${styles.nodeActions} nodrag nopan`}>
              <Button
                variant="ghost"
                size="icon"
                title={locale === "en" ? "Edit step" : "编辑步骤"}
                aria-label={`${locale === "en" ? "Edit" : "编辑"} ${translated(node, "title", locale)}`}
                disabled={locked}
                onClick={() => openEditor(node)}
              >
                <Pencil />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                title={locale === "en" ? "Duplicate step" : "复制步骤"}
                aria-label={`${locale === "en" ? "Duplicate" : "复制"} ${translated(node, "title", locale)}`}
                disabled={locked}
                onClick={() =>
                  setState((previous) => duplicateStep(previous, locked))
                }
              >
                <Copy />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                title={locale === "en" ? "Delete step" : "删除步骤"}
                aria-label={`${locale === "en" ? "Delete" : "删除"} ${translated(node, "title", locale)}`}
                disabled={locked}
                onClick={() => setDialog("delete")}
              >
                <Trash2 />
              </Button>
            </div>
          )}
        </div>
      )
    },
    [locale, locked, setState, openEditor],
  )
  const editing = selectedNode ? state.editorDrafts[selectedNode.id] : undefined
  return (
    <div className={styles.root} data-remaining-page="workflow-1">
      <section className={styles.main}
      id={host.mainContentId ?? "workflow-content"}><header className={styles.header}>
        <h1>
          {label("流程 1 · 搭建与配置", "Workflow 1 · Build and configure")}
        </h1>
        <div className={styles.headerActions}>
          <Button variant="ghost" onClick={() => setDialog("share")}>
            <Share2 />
            {label("分享", "Share")}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={label("更多操作", "More actions")}
                  title={label("更多操作", "More actions")}
                />
              }
            >
              <MoreHorizontal />
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem
                disabled={locked || !state.past.length}
                onClick={() => setState(undoWorkflow)}
              >
                {label("撤销", "Undo")}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={locked || !state.future.length}
                onClick={() => setState(redoWorkflow)}
              >
                {label("重做", "Redo")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => setDialog("connect")}
                disabled={!state.document.nodes.length}
              >
                {label("连接步骤", "Connect steps")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={download}>
                {label("导出流程 JSON", "Export workflow JSON")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="ghost"
            size="icon"
            title={label("切换主题", "Toggle theme")}
            aria-label={label("切换主题", "Toggle theme")}
            onClick={() =>
              host.setTheme(host.resolvedTheme === "dark" ? "light" : "dark")
            }
          >
            <Monitor />
          </Button>
        </div>
      </header>
      <div className={styles.body} ref={bodyRef}>
        <section
          className={styles.thread}
          hidden={state.expanded}
          aria-label={label("流程对话", "Workflow thread")}
        >
          <header className={styles.threadHeader}>
            <span>{label("流程对话", "Workflow thread")}</span>
            <Button
              variant="ghost"
              size="icon"
              aria-pressed={state.panelOpen}
              title={
                state.panelOpen
                  ? label("关闭流程", "Close workflow")
                  : label("打开流程", "Open workflow")
              }
              aria-label={
                state.panelOpen
                  ? label("关闭流程", "Close workflow")
                  : label("打开流程", "Open workflow")
              }
              onClick={() =>
                setState((previous) => ({
                  ...previous,
                  panelOpen: !previous.panelOpen,
                }))
              }
            >
              <PanelLeftClose />
            </Button>
          </header>
          <div
            className={styles.messages}
            role="region"
            aria-label={label("对话消息", "Conversation messages")}
            ref={historyRef}
            onScroll={(event) =>
              cache.set("workflow-1:reading", event.currentTarget.scrollTop)
            }
          >
            <div role="log" aria-live="polite">
              {composer.selected.messages.map((message) => (
                <ChatMessage
                  key={message.id}
                  id={message.id}
                  role={message.role === "user" ? "user" : "agent"}
                  author={
                    message.role === "assistant"
                      ? label(
                          "EasyuseUI AI · 流程代理",
                          "EasyuseUI AI · Workflow agent",
                        )
                      : undefined
                  }
                  content={composer.copy(message.text)}
                >
                  {message.id === "workspace" && (
                    <div className={styles.artifact}>
                      <div className={styles.artifactHeading}>
                        <GitBranch />
                        <div>
                          <strong>
                            {label(
                              "受保护发布流程",
                              "Guarded release workflow",
                            )}
                          </strong>
                          <small>
                            {label(
                              "交互式流程工作区",
                              "Interactive workflow workspace",
                            )}
                          </small>
                        </div>
                        <span>{label("草稿", "Draft")}</span>
                      </div>
                      <div className={styles.artifactBody}>
                        <div className={styles.route}>
                          <FileInput />
                          {label("输入", "Input")}
                          <ArrowRight />
                          <GitBranch />
                          {label("决策", "Decision")}
                          <ArrowRight />
                          <LockKeyhole />
                          {label("审批", "Approval")}
                        </div>
                        <div className={styles.metrics}>
                          {[
                            [
                              state.document.nodes.length,
                              label("步骤", "Steps"),
                            ],
                            [
                              state.document.nodes.filter(
                                (node) => node.type === "decision",
                              ).length,
                              label("分支", "Branches"),
                            ],
                            [
                              state.document.nodes.filter(
                                (node) => node.type === "approval",
                              ).length,
                              label("检查点", "Checkpoints"),
                            ],
                          ].map(([number, text]) => (
                            <div key={text}>
                              <strong>{number}</strong>
                              <small>{text}</small>
                            </div>
                          ))}
                        </div>
                      </div>
                      <footer>
                        <span>{label("工作区就绪", "Workspace ready")}</span>
                        <Button
                          variant="secondary"
                          onClick={() =>
                            setState((previous) => ({
                              ...previous,
                              panelOpen: true,
                            }))
                          }
                        >
                          <GitBranch />
                          {label("打开流程", "Open workflow")}
                        </Button>
                      </footer>
                    </div>
                  )}
                </ChatMessage>
              ))}
              {!composer.hasMessages && (
                <div className={styles.emptyThread}>
                  <Bot />
                  <h2>
                    {label("搭建一个发布流程", "Build a release workflow")}
                  </h2>
                  <p>
                    {label(
                      "从添加输入开始，或发送“添加代理任务”。",
                      "Start with an input step, or send “add agent task”.",
                    )}
                  </p>
                </div>
              )}
            </div>
          </div>
          <Button
            variant="secondary"
            size="icon"
            className={styles.latest}
            title={label("滚动到最新消息", "Scroll to latest message")}
            aria-label={label("滚动到最新消息", "Scroll to latest message")}
            onClick={() =>
              historyRef.current?.scrollTo({
                top: historyRef.current.scrollHeight,
                behavior: "auto",
              })
            }
          >
            <ArrowDown />
          </Button>
          <div className={styles.composer}>
            <ComposerInput
              controller={{ ...composer, canSend: !locked, sendMessage }}
              helpId={helpId}
              options={{
                showBlocksControl: false,
                hideSuggestion: true,
                readOnly: locked,
                placeholder: {
                  "zh-CN": "请求修改流程…",
                  en: "Ask for a workflow change…",
                },
                inputLabel: { "zh-CN": "消息", en: "Message" },
                tools: (
                  <Button
                    variant="ghost"
                    aria-pressed={state.panelOpen}
                    onClick={() =>
                      setState((previous) => ({
                        ...previous,
                        panelOpen: !previous.panelOpen,
                      }))
                    }
                  >
                    <GitBranch />
                    {label("画布", "Canvas")}
                  </Button>
                ),
              }}
            />
            {locked && (
              <p className={styles.permission}>
                {readonly
                  ? label(
                      "只读：可以查看流程与配置，但不能修改或发送。",
                      "Read only: inspect the graph and configuration; editing and sending are disabled.",
                    )
                  : label(
                      "正在加载本地草稿，暂时无法编辑。",
                      "Loading the local draft; editing is temporarily unavailable.",
                    )}
              </p>
            )}
          </div>
        </section>
        {state.panelOpen && (
          <>
            <ResizableHandle
              label={label("调整流程工作区宽度", "Resize workflow workspace")}
              controls={panelId}
              value={panelWidth}
              min={600}
              max={Math.max(600, availableWidth - 280)}
              reverse
              disabled={state.expanded}
              onValueChange={(panelWidth) =>
                setState((previous) => ({ ...previous, panelWidth }))
              }
              className={styles.resize}
            />
            <section
              className={styles.workspace}
              id={panelId}
              style={{ width: state.expanded ? "100%" : panelWidth }}
              aria-label={label("发布流程搭建器", "Release workflow builder")}
            >
              <header className={styles.workspaceHeader}>
                <GitBranch />
                <div className={styles.workspaceTitle}>
                  <strong>
                    {label("发布流程搭建器", "Release workflow builder")}
                  </strong>
                  <small>
                    {label(
                      "可编辑流程 · 受保护发布",
                      "Editable workflow · guarded release",
                    )}
                  </small>
                </div>
                <span className={styles.draft}>
                  <i />
                  {readonly
                    ? label("只读", "Read only")
                    : label("草稿变更", "Draft changes")}
                </span>
                <Button
                  variant="secondary"
                  onClick={validate}
                  disabled={state.readState === "loading"}
                >
                  <Play />
                  {label("验证流程", "Validate flow")}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={
                    state.expanded
                      ? label("还原流程工作区", "Restore workflow workspace")
                      : label("展开流程工作区", "Expand workflow workspace")
                  }
                  title={label("展开或还原", "Expand or restore")}
                  onClick={() =>
                    setState((previous) => ({
                      ...previous,
                      expanded: !previous.expanded,
                    }))
                  }
                >
                  {state.expanded ? <Minimize2 /> : <Maximize2 />}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={label(
                    "关闭流程工作区",
                    "Close workflow workspace",
                  )}
                  title={label("关闭流程工作区", "Close workflow workspace")}
                  onClick={closePanel}
                >
                  <X />
                </Button>
              </header>
              {(state.readState === "error" ||
                state.readState === "loading") && (
                <div className={styles.recovery} role="status">
                  <span>
                    {state.readState === "error"
                      ? label(
                          "刷新失败，保留当前草稿。",
                          "Refresh failed. The current draft is preserved.",
                        )
                      : label(
                          "正在读取本地流程快照…",
                          "Reading the local workflow snapshot…",
                        )}
                  </span>
                  <Button
                    variant="secondary"
                    onClick={() =>
                      setState((previous) => ({
                        ...previous,
                        readState: "ready",
                      }))
                    }
                  >
                    {state.readState === "error"
                      ? label("重试本地读取", "Retry local read")
                      : label("显示本地快照", "Show local snapshot")}
                  </Button>
                </div>
              )}
              <div className={styles.canvasBody}>
                <div className={styles.canvasRegion}>
                  <div
                    className={styles.palette}
                    aria-label={label("添加流程步骤", "Add workflow steps")}
                  >
                    {palette.map((item) => {
                      const Icon = icons[item.kind]
                      return (
                        <Button
                          variant="secondary"
                          key={item.kind}
                          disabled={locked}
                          onClick={() =>
                            setState((previous) =>
                              addStep(
                                previous,
                                item.kind,
                                item.label[locale],
                                locked,
                              ),
                            )
                          }
                        >
                          <Icon />
                          {item.label[locale]}
                          <Plus />
                        </Button>
                      )
                    })}
                  </div>
                  <WorkflowCanvas
                    className={styles.canvas}
                    document={state.document}
                    definitions={definitions}
                    selection={state.selection}
                    onSelectionChange={select}
                    onCommand={command}
                    readOnly={locked}
                    issues={state.issues}
                    viewport={state.document.viewport}
                    onViewportChange={viewportChange}
                    onOpenNode={(id) =>
                      openEditor(
                        state.document.nodes.find((node) => node.id === id),
                      )
                    }
                    focusRequest={state.focusRequest}
                    renderNode={renderNode}
                    showBackground={false}
                    showMiniMap={false}
                    controlsVariant="minimal-vertical"
                  />
                  {!state.document.nodes.length && (
                    <div className={styles.emptyCanvas}>
                      <GitBranch />
                      <h2>
                        {label("流程还没有步骤", "No steps in this workflow")}
                      </h2>
                      <p>
                        {label(
                          "使用上方工具栏添加输入、代理任务、决策或审批。",
                          "Add an input, agent task, decision, or approval from the toolbar.",
                        )}
                      </p>
                    </div>
                  )}
                  <div className={styles.legend}>
                    <span>
                      <i data-status="running" />
                      {label("运行中", "running")}
                    </span>
                    <span>
                      <i data-status="completed" />
                      {label("已完成", "completed")}
                    </span>
                    <span>
                      <i />
                      {label("等待中", "waiting")}
                    </span>
                    <span>
                      <i data-status="blocked" />
                      {label("已阻塞", "blocked")}
                    </span>
                  </div>
                  {state.validatedRevision === state.document.revision && (
                    <div className={styles.validation} role="status">
                      <strong>
                        {state.issues.length
                          ? label(
                              `发现 ${state.issues.length} 项配置问题`,
                              `${state.issues.length} configuration issues`,
                            )
                          : label(
                              "本地图结构有效 · 未执行",
                              "Local graph is valid · not executed",
                            )}
                      </strong>
                      {state.issues.map((issue, index) => {
                        const message =
                          issue.code === "empty"
                            ? label(
                                "请先添加输入和验证步骤。",
                                "Add an input and a verification step before validating.",
                              )
                            : issue.code === "unconnected"
                              ? label(
                                  "此步骤尚未连接到流程。",
                                  "This step is not connected to the workflow.",
                                )
                              : resolve(issue.messageI18n, issue.message)
                        return issue.nodeId ? (
                          <Button
                            key={index}
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              select({
                                nodeIds: [issue.nodeId!],
                                edgeIds: [],
                              })
                            }
                          >
                            {issue.nodeId}: {message}
                          </Button>
                        ) : (
                          <p key={index}>{message}</p>
                        )
                      })}
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={label(
                          "关闭校验结果",
                          "Dismiss validation",
                        )}
                        title={label("关闭校验结果", "Dismiss validation")}
                        onClick={() =>
                          setState((previous) => ({
                            ...previous,
                            validatedRevision: null,
                          }))
                        }
                      >
                        <X />
                      </Button>
                    </div>
                  )}
                </div>
                {selectedNode && (
                  <aside
                    className={styles.inspector}
                    aria-label={label("步骤检查器", "Step inspector")}
                  >
                    <header>
                      <span>
                        <small>
                          {
                            kindLabels[selectedNode.type as StepKind]?.[
                              locale
                            ]
                          }
                        </small>
                        <h2>{translated(selectedNode, "title", locale)}</h2>
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        title={label("关闭检查器", "Close inspector")}
                        aria-label={label("关闭检查器", "Close inspector")}
                        onClick={() => select({ nodeIds: [], edgeIds: [] })}
                      >
                        <X />
                      </Button>
                    </header>
                    <div className={styles.inspectorScroll}>
                      <section>
                        <div className={styles.statusRow}>
                          <small>{label("状态", "Status")}</small>
                          <RuntimeStatusBadge
                            status={
                              selectedNode.id === "brief"
                                ? "completed"
                                : "waiting"
                            }
                          />
                        </div>
                        <p>
                          {translated(selectedNode, "description", locale)}
                        </p>
                      </section>
                      <section className={styles.progress}>
                        <div>
                          <small>{label("进度", "Progress")}</small>
                          <strong>
                            {selectedNode.id === "brief" ? "100%" : "0%"}
                          </strong>
                        </div>
                        <div>
                          <small>{label("耗时", "Duration")}</small>
                          <strong>—</strong>
                        </div>
                      </section>
                      <section>
                        <small>{label("负责人", "Ownership")}</small>
                        <div className={styles.owner}>
                          <UserRound />
                          <div>
                            <strong>
                              {translated(selectedNode, "owner", locale) ||
                                label("未分配", "Unassigned")}
                            </strong>
                            <small>
                              {label(
                                "负责此步骤",
                                "Responsible for this step",
                              )}
                            </small>
                          </div>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={label("编辑负责人", "Edit owner")}
                            title={label("编辑负责人", "Edit owner")}
                            disabled={locked}
                            onClick={() => openEditor(selectedNode)}
                          >
                            <MoreHorizontal />
                          </Button>
                        </div>
                      </section>
                      <section>
                        <h3>
                          {label(
                            "配置与依赖",
                            "Configuration and dependencies",
                          )}
                        </h3>
                        {selectedNode.type === "decision" && (
                          <p>
                            <code>
                              {String(selectedNode.config.condition)}
                            </code>
                          </p>
                        )}
                        {selectedNode.type === "approval" && (
                          <p>
                            {label(
                              "需要明确的人工审批；本地草稿不会批准执行。",
                              "Explicit human approval required; the local draft does not authorize execution.",
                            )}
                          </p>
                        )}
                        <ul>
                          {state.document.edges
                            .filter((edge) => edge.target === selectedNode.id)
                            .map((edge) => (
                              <li key={edge.id}>
                                {translated(
                                  state.document.nodes.find(
                                    (node) => node.id === edge.source,
                                  )!,
                                  "title",
                                  locale,
                                )}
                              </li>
                            ))}
                        </ul>
                        <Button
                          variant="secondary"
                          disabled={locked}
                          onClick={() => openEditor(selectedNode)}
                        >
                          <Pencil />
                          {label("编辑配置", "Edit configuration")}
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => setDialog("connect")}
                          disabled={locked}
                        >
                          {label("连接步骤", "Connect steps")}
                        </Button>
                      </section>
                      <p className={styles.fixtureNote}>
                        {label(
                          "状态为演示快照，不表示真实运行。",
                          "Statuses are fixture snapshots, not a live execution.",
                        )}
                      </p>
                    </div>
                  </aside>
                )}
                {selectedEdge && !selectedNode && (
                  <aside className={styles.inspector}>
                    <header>
                      <h2>{label("连接配置", "Connection settings")}</h2>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={label(
                          "关闭连接检查器",
                          "Close connection inspector",
                        )}
                        onClick={() => select({ nodeIds: [], edgeIds: [] })}
                      >
                        <X />
                      </Button>
                    </header>
                    <div className={styles.inspectorScroll}>
                      <CanvasConnectionForm
                        document={state.document}
                        definitions={definitions}
                        edge={selectedEdge}
                        onCommand={command}
                        readOnly={locked}
                      />
                    </div>
                  </aside>
                )}
              </div>
            </section>
          </>
        )}
      </div>
      {state.feedback && (
        <p role="status" className={styles.feedback}>
          {state.feedback[locale]}
        </p>
      )}</section>
      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) setDialog(null)
        }}
      >
        <DialogContent className={styles.dialog}>
          <DialogTitle>
            {dialog === "edit"
              ? label("编辑步骤配置", "Edit step configuration")
              : dialog === "delete"
                ? label(
                    "删除所选步骤或连接",
                    "Delete selected steps or connections",
                  )
                : dialog === "connect"
                  ? label("连接流程步骤", "Connect workflow steps")
                  : label("分享流程草稿", "Share workflow draft")}
          </DialogTitle>
          <DialogDescription>
            {dialog === "delete"
              ? label(
                  "仅修改本地草稿，关联连接也会移除。可撤销此操作。",
                  "Only the local draft changes. Related connections are removed. This action can be undone.",
                )
              : label(
                  "仅本地内存草稿；不会调用 Provider、发布或运行流程。",
                  "Local in-memory draft only; this does not call a provider, publish, or run the workflow.",
                )}
          </DialogDescription>
          {dialog === "share" && (
            <>
              <Textarea
                aria-label={label("流程 JSON", "Workflow JSON")}
                value={exportCanvasDocument(state.document)}
                readOnly
                rows={12}
              />
              <Button variant="secondary" onClick={download}>
                <Download />
                {label("下载 JSON", "Download JSON")}
              </Button>
            </>
          )}
          {dialog === "connect" && (
            <CanvasConnectionForm
              document={state.document}
              definitions={definitions}
              onCommand={(action) => {
                command(action)
                setDialog(null)
              }}
              readOnly={locked}
            />
          )}
          {dialog === "delete" && (
            <div className={styles.dialogActions}>
              <Button variant="secondary" onClick={() => setDialog(null)}>
                {label("取消", "Cancel")}
              </Button>
              <Button
                variant="destructive"
                disabled={locked}
                onClick={() => {
                  command({ type: "delete", selection: state.selection })
                  setDialog(null)
                  composer.focusComposer()
                }}
              >
                {label("删除本地选择", "Delete local selection")}
              </Button>
            </div>
          )}
          {dialog === "edit" && selectedNode && editing && (
            <form
              className={styles.editor}
              onSubmit={(event) => {
                event.preventDefault()
                if (
                  !editing.title.trim() ||
                  !editing.description.trim() ||
                  !editing.owner.trim()
                ) {
                  setEditorError(true)
                  return
                }
                command({
                  type: "configure",
                  nodeId: selectedNode.id,
                  title: editing.title.trim(),
                  config: {
                    ...selectedNode.config,
                    description: editing.description.trim(),
                    owner: editing.owner.trim(),
                    condition: editing.condition,
                  },
                })
                setState((previous) => {
                  const editorDrafts = { ...previous.editorDrafts }
                  delete editorDrafts[selectedNode.id]
                  return { ...previous, editorDrafts }
                })
                setDialog(null)
              }}
            >
              {(
                [
                  ["title", label("步骤名称", "Step title")],
                  ["description", label("指令", "Instructions")],
                  ["owner", label("负责人", "Owner")],
                  ...(selectedNode.type === "decision"
                    ? [["condition", label("分支条件", "Branch condition")]]
                    : []),
                ] as [keyof typeof editing, string][]
              ).map(([key, title]) => (
                <Field
                  key={key}
                  label={title}
                  required
                  error={
                    editorError && !editing[key].trim()
                      ? label("此字段不能为空。", "This field is required.")
                      : undefined
                  }
                >
                  {(field) =>
                    key === "description" ? (
                      <Textarea
                        {...field}
                        rows={3}
                        value={editing[key]}
                        disabled={locked}
                        onChange={(event) =>
                          setState((previous) => ({
                            ...previous,
                            editorDrafts: {
                              ...previous.editorDrafts,
                              [selectedNode.id]: {
                                ...editing,
                                [key]: event.target.value,
                              },
                            },
                          }))
                        }
                      />
                    ) : (
                      <Input
                        {...field}
                        value={editing[key]}
                        disabled={locked}
                        onChange={(event) =>
                          setState((previous) => ({
                            ...previous,
                            editorDrafts: {
                              ...previous.editorDrafts,
                              [selectedNode.id]: {
                                ...editing,
                                [key]: event.target.value,
                              },
                            },
                          }))
                        }
                      />
                    )
                  }
                </Field>
              ))}
              <div className={styles.dialogActions}>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setDialog(null)}
                >
                  {label("取消", "Cancel")}
                </Button>
                <Button type="submit" disabled={locked}>
                  {label("保存配置", "Save configuration")}
                </Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
