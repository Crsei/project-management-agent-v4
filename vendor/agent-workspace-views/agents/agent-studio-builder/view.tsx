"use client"

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type Dispatch,
} from "react"
import {
  ArrowUp,
  Bot,
  CalendarClock,
  Check,
  ChevronDown,
  Database,
  GitBranch,
  Layers,
  Minus,
  Moon,
  Sun,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Plus,
  Square,
  Trash2,
  Webhook,
  Wrench,
  MessageSquare,
} from "lucide-react"
import { useI18n } from "@easyuse-ui/ui/lib/i18n-provider"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { Input } from "@easyuse-ui/ui/components/ui/input"
import { Textarea } from "@easyuse-ui/ui/components/ui/textarea"
import { Field } from "@easyuse-ui/ui/components/ui/field"
import { Checkbox } from "@easyuse-ui/ui/components/ui/checkbox"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@easyuse-ui/ui/components/ui/select"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@easyuse-ui/ui/components/ui/sheet"
import {
  ChatComposer,
  ChatMessage,
} from "@easyuse-ui/ui/components/blocks/chat-message"
import { RuntimeStatusBadge } from "@easyuse-ui/ui/components/ui/runtime-status-badge"
import {
  RemainingPageStateProvider,
  useRemainingPageState,
} from "../../showcase/state"
import {
  remainingPageScenarios,
  type RemainingPageProps,
} from "../../showcase/model"
import {
  builderTransition,
  createBuilderState,
  type BuilderAction,
  type BuilderState,
} from "./controller"
import { choices, displayText, nodes, type NodeId } from "./fixtures"
import styles from "./view.module.css"

export const pageScenarios = remainingPageScenarios
const icons = {
  schedule: CalendarClock,
  event: Webhook,
  channels: MessageSquare,
  memory: Database,
  agent: Bot,
  tools: Wrench,
  skills: Layers,
  subagents: GitBranch,
}
const connectors = [
  "M224 130 C250 130,247 325,274 325",
  "M224 275 C250 275,247 325,274 325",
  "M224 424 C250 424,247 325,274 325",
  "M224 603 C250 603,247 325,274 325",
  "M522 325 C545 325,545 145,572 145",
  "M522 325 C545 325,545 358,572 358",
  "M522 325 C545 325,545 566,572 566",
]

export function RemainingPageView(props: RemainingPageProps) {
  return (
    <RemainingPageStateProvider cache={props.cache}>
      <BuilderView key={props.scenario} {...props} />
    </RemainingPageStateProvider>
  )
}
function BuilderView({ scenario, active, host }: RemainingPageProps) {
  const { locale } = useI18n()
  const label = (zh: string, en: string) => (locale === "en" ? en : zh)
  const [state, setState] = useRemainingPageState(
    `agent-studio-builder:${scenario}`,
    () => createBuilderState(scenario),
  )
  const change = useCallback(
    (action: BuilderAction) =>
      setState((previous) => builderTransition(previous, action)),
    [setState],
  )
  const canvas = useRef<HTMLDivElement>(null)
  const conversation = useRef<HTMLDivElement>(null)
  const returnFocus = useRef<HTMLButtonElement | null>(null)
  const locked = state.readonly || state.readState === "loading"
  const dirty = JSON.stringify(state.saved) !== JSON.stringify(state.config)
  const config = state.config
  const choiceLabel = (key: keyof typeof choices, id: string) =>
    choices[key].find((choice) => choice.id === id)?.label[locale] ?? id
  const run = state.run
  const snapshot = run?.snapshot ?? config
  useEffect(() => {
    if (!active || run?.status !== "running") return
    const timeout = setTimeout(
      () => change({ type: "advance", runId: run.id }),
      650,
    )
    return () => clearTimeout(timeout)
  }, [active, change, run?.id, run?.status, run?.stage])
  useLayoutEffect(() => {
    if (!active) return
    if (canvas.current) {
      canvas.current.scrollLeft = state.reading.canvasX
      canvas.current.scrollTop = state.reading.canvasY
    }
    if (conversation.current)
      conversation.current.scrollTop = state.reading.conversationY
    // Reading positions are restored only when the scene or hidden panel reopens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, state.panelOpen])
  const nodeBody = (id: NodeId) => {
    switch (id) {
      case "schedule":
        return (
          <>
            <p>{choiceLabel("repeat", config.repeat)}</p>
            <small>
              {config.time} UTC · {label("客户简报", "Customer brief")}
            </small>
          </>
        )
      case "event":
        return (
          <>
            <p>{choiceLabel("event", config.event)}</p>
            <code>
              {config.condition || label("未设置条件", "No condition")}
            </code>
          </>
        )
      case "channels":
        return (
          <>
            <p className={styles.channelName}>
              {choiceLabel("channel", config.channel)}
              <i />
            </p>
            <small>{config.destination}</small>
            <small className={styles.approval}>
              {config.approval
                ? label("交付前需审核", "Approval before delivery")
                : label("本地模拟交付", "Local simulated delivery")}
            </small>
          </>
        )
      case "memory":
        return config.memory.length ? (
          <div className={styles.nodeList}>
            {config.memory.map((memory) => (
              <p key={memory.id}>
                ·{" "}
                <span title={displayText(memory.name, locale)}>
                  {displayText(memory.name, locale)}
                </span>
              </p>
            ))}
          </div>
        ) : (
          <small>{label("尚未附加记忆", "No memory attached")}</small>
        )
      case "agent":
        return (
          <>
            <div className={styles.identity}>
              <span>N</span>
              <strong title={displayText(config.name, locale)}>
                {displayText(config.name, locale) ||
                  label("未命名代理", "Untitled agent")}
              </strong>
            </div>
            <small className={styles.purpose}>
              {displayText(config.purpose, locale) ||
                label("定义代理目标", "Define the agent’s purpose")}
            </small>
            <div className={styles.instructions}>
              <span>{label("指令", "Instructions")}</span>
              <p>
                {displayText(config.instructions, locale) ||
                  label(
                    "添加工作指令以开始测试。",
                    "Add working instructions to begin a test.",
                  )}
              </p>
            </div>
            <footer>
              <span>{config.model}</span>
              <span>{label("编辑代理 →", "Edit agent →")}</span>
            </footer>
          </>
        )
      case "tools":
      case "skills":
      case "subagents":
        return config[id].length ? (
          <div className={styles.nodeList}>
            {config[id].map((value) => (
              <p key={value}>
                {id === "subagents" && <i />}
                <span>{choiceLabel(id, value)}</span>
              </p>
            ))}
          </div>
        ) : (
          <small>{label("尚未选择", "Nothing selected")}</small>
        )
    }
  }
  return (
    <div className={styles.root} data-remaining-page="agent-studio-builder">
      <section className={styles.main} aria-busy={state.readState === "loading"}><header className={styles.workspaceHeader}>
        <span>{label("代理构建器", "Agent builder")}</span>
        <div>
          <span>{label("演示工作区", "Demo workspace")}</span>
          <Button
            variant="ghost"
            size="icon"
            aria-label={label("切换主题", "Toggle theme")}
            onClick={() =>
              host.setTheme(host.resolvedTheme === "dark" ? "light" : "dark")
            }
          >
            {host.resolvedTheme === "dark" ? <Sun /> : <Moon />}
          </Button>
        </div>
      </header>
      <header className={styles.pageHeader} data-agent-summary>
        <div>
          <div className={styles.titleLine}>
            <h1 title={displayText(config.name, locale)}>
              {displayText(config.name, locale) ||
                label("未命名代理", "Untitled agent")}
            </h1>
            <span>v{state.version}</span>
          </div>
          <p>
            {label(
              "构建上下文，让代理完成工作。",
              "Build the context. Let the agent do the work.",
            )}
          </p>
        </div>
        <div className={styles.pageActions}>
          <span role="status">
            {locked
              ? label(
                  state.readonly ? "只读配置" : "正在加载",
                  state.readonly ? "Read-only configuration" : "Loading",
                )
              : dirty
                ? label("未保存的更改", "Unsaved changes")
                : label("所有更改已保存", "All changes saved")}
          </span>
          <Button
            variant="ghost"
            disabled={locked || !dirty}
            onClick={() => change({ type: "save" })}
          >
            {label("保存代理", "Save agent")}
          </Button>
          <Button
            disabled={locked}
            onClick={() =>
              change({ type: run?.status === "running" ? "stop" : "run" })
            }
          >
            {run?.status === "running" ? <Square /> : <Play />}
            {run?.status === "running"
              ? label("停止测试", "Stop test")
              : label("测试运行", "Test run")}
          </Button>
        </div>
      </header>
      {state.readState !== "ready" && (
        <div
          className={styles.notice}
          role={state.readState === "error" ? "alert" : "status"}
        >
          <span>
            {state.readState === "error"
              ? label(
                  "配置刷新失败。已保留上次配置和本地草稿。",
                  "Configuration refresh failed. Previous configuration and local drafts are retained.",
                )
              : label("正在加载演示配置…", "Loading demo configuration…")}
          </span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => change({ type: "recover" })}
          >
            {state.readState === "error"
              ? label("重试本地读取", "Retry local read")
              : label("加载本地配置", "Load local configuration")}
          </Button>
        </div>
      )}
      <div className={styles.workbench}>
        <section
          className={styles.canvasRegion}
          aria-label={label("代理配置画布", "Agent configuration canvas")}
        >
          <Button
            className={styles.panelToggle}
            variant="outline"
            size="icon-sm"
            aria-label={
              state.panelOpen
                ? label("隐藏测试会话", "Hide test conversation")
                : label("显示测试会话", "Show test conversation")
            }
            onClick={() => change({ type: "panel", open: !state.panelOpen })}
          >
            {state.panelOpen ? <PanelRightClose /> : <PanelRightOpen />}
          </Button>
          <div
            ref={canvas}
            className={styles.canvasScroll}
            onScroll={(event) =>
              change({
                type: "reading",
                patch: {
                  canvasX: event.currentTarget.scrollLeft,
                  canvasY: event.currentTarget.scrollTop,
                },
              })
            }
          >
            <div
              className={styles.diagramBounds}
              style={{ width: 800 * state.zoom, height: 780 * state.zoom }}
            >
              <div
                className={styles.diagram}
                style={{ transform: `scale(${state.zoom})` }}
              >
                <div className={styles.columnLabels}>
                  <span>{label("输入与上下文", "INPUTS & CONTEXT")}</span>
                  <span>{label("你的代理", "YOUR AGENT")}</span>
                  <span>{label("能力", "CAPABILITIES")}</span>
                </div>
                <svg className={styles.connectors} aria-hidden="true">
                  {connectors.map((path) => (
                    <path
                      key={path}
                      d={path}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                    />
                  ))}
                </svg>
                {nodes.map((node) => {
                  const Icon = icons[node.id]
                  const count =
                    node.id === "memory"
                      ? config.memory.length
                      : node.id === "tools" ||
                          node.id === "skills" ||
                          node.id === "subagents"
                        ? config[node.id].length
                        : undefined
                  return (
                    <Button
                      key={node.id}
                      variant="ghost"
                      className={styles.node}
                      data-node={node.id}
                      aria-label={label(
                        `配置${node.title["zh-CN"]}`,
                        `Configure ${node.id === "agent" ? "agent instructions" : node.id === "subagents" ? "sub-agents" : node.id === "event" ? "event trigger" : node.id}`,
                      )}
                      style={{ left: node.x, top: node.y, width: node.width }}
                      onClick={(event) => {
                        returnFocus.current = event.currentTarget
                        change({ type: "open", node: node.id })
                      }}
                    >
                      <div className={styles.nodeHeader}>
                        <Icon />
                        <span>
                          {node.id === "agent"
                            ? label("代理", "Agent")
                            : node.title[locale]}
                        </span>
                        {count !== undefined && <small>{count}</small>}
                        {node.id === "event" && (
                          <small>{label("事件", "Event")}</small>
                        )}
                        <ChevronDown />
                      </div>
                      <div className={styles.nodeBody}>
                        {nodeBody(node.id)}
                      </div>
                    </Button>
                  )
                })}
              </div>
            </div>
          </div>
          <div className={styles.zoom}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={label("缩小", "Zoom out")}
              disabled={state.zoom <= 0.6}
              onClick={() =>
                change({ type: "zoom", value: state.zoom - 0.1 })
              }
            >
              <Minus />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label={label("重置缩放", "Reset zoom")}
              onClick={() => change({ type: "zoom", value: 0.9 })}
            >
              {Math.round(state.zoom * 100)}%
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={label("放大", "Zoom in")}
              disabled={state.zoom >= 1.4}
              onClick={() =>
                change({ type: "zoom", value: state.zoom + 0.1 })
              }
            >
              <Plus />
            </Button>
          </div>
        </section>
        <aside
          className={styles.testPanel}
          aria-label={label("测试会话", "Test conversation")}
          hidden={!state.panelOpen}
        >
          <header>
            <h2>{label("测试会话", "Test conversation")}</h2>
            <span>{label("示例运行", "Sample run")}</span>
          </header>
          <div
            ref={conversation}
            className={styles.testScroll}
            tabIndex={0}
            onScroll={(event) =>
              change({
                type: "reading",
                patch: { conversationY: event.currentTarget.scrollTop },
              })
            }
          >
            {!run ? (
              <div className={styles.empty}>
                <Bot />
                <h3>
                  {label("准备测试你的代理", "Ready to test your agent")}
                </h3>
                <p>
                  {label(
                    "配置目标、指令与读取工具，然后进行本地示例测试。不会调用外部模型。",
                    "Configure a purpose, instructions, and reading tools, then start a local sample test. No external model is called.",
                  )}
                </p>
              </div>
            ) : (
              <>
                <div className={styles.prompt}>
                  {label(
                    "回顾过去七天的客户反馈。",
                    "Review customer signals from the past seven days.",
                  )}
                </div>
                <div
                  className={styles.runStatus}
                  role="status"
                  data-status={run.status}
                >
                  {run.status === "complete" ? (
                    <>
                      <RuntimeStatusBadge status="completed" iconOnly />
                      {label("运行完成", "Run complete")}
                    </>
                  ) : (
                    <RuntimeStatusBadge
                      status={
                        run.status === "running"
                          ? "running"
                          : run.status === "failed"
                            ? "failed"
                            : "cancelled"
                      }
                    />
                  )}
                </div>
                {run.status === "failed" ? (
                  <div className={styles.runError} role="alert">
                    <p>
                      {run.error === "tools"
                        ? label(
                            "至少选择一个读取工具后再测试。",
                            "Select at least one reading tool before testing.",
                          )
                        : label(
                            "请填写代理名称、目标与指令后再测试。",
                            "Add an agent name, purpose, and instructions before testing.",
                          )}
                    </p>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={locked}
                      onClick={() =>
                        change({
                          type: "open",
                          node: run.error === "tools" ? "tools" : "agent",
                        })
                      }
                    >
                      {label("检查配置", "Review configuration")}
                    </Button>
                  </div>
                ) : (
                  <>
                    <p className={styles.introduction}>
                      {label(
                        "我将回顾最新反馈，对照产品优先事项，并准备带有证据链接的简报。",
                        "I’ll review the latest feedback, check it against our product priorities, and prepare a brief with links to the evidence.",
                      )}
                    </p>
                    {(run.stage >= 1 || run.status === "complete") && (
                      <section className={styles.testSection}>
                        <h3>{label("上下文", "CONTEXT")}</h3>
                        {snapshot.memory.length ? (
                          snapshot.memory.map((memory) => (
                            <div
                              className={styles.contextRow}
                              key={memory.id}
                            >
                              <Database />
                              <span
                                title={displayText(memory.content, locale)}
                              >
                                {displayText(memory.name, locale)}
                              </span>
                              <Check />
                            </div>
                          ))
                        ) : (
                          <p className={styles.muted}>
                            {label("没有附加记忆", "No memory attached")}
                          </p>
                        )}
                      </section>
                    )}
                    {(run.stage >= 2 || run.status === "complete") && (
                      <section className={styles.testSection}>
                        <h3>{label("读取来源", "READING SOURCES")}</h3>
                        {snapshot.tools.map((tool) => (
                          <div className={styles.sourceRow} key={tool}>
                            <Check />
                            <span>{choiceLabel("tools", tool)}</span>
                          </div>
                        ))}
                      </section>
                    )}
                    {(run.stage >= 3 || run.status === "complete") && (
                      <div className={styles.specialists}>
                        {snapshot.subagents.map((id) => (
                          <span key={id}>{choiceLabel("subagents", id)}</span>
                        ))}
                      </div>
                    )}
                    {run.status === "complete" && (
                      <section className={styles.output}>
                        <h3>
                          {label(
                            "三个值得深入关注的主题",
                            "Three themes worth a closer look",
                          )}
                        </h3>
                        {[
                          label(
                            "邀请流程需要更清楚的角色说明。",
                            "Invite flows need clearer role descriptions.",
                          ),
                          label(
                            "团队需要一个统一记录交接决策的位置。",
                            "Teams want a single place for handoff decisions.",
                          ),
                          label(
                            "导出状态需要更容易找到。",
                            "Export status needs to be easier to find.",
                          ),
                        ].map((theme, index) => (
                          <p key={theme}>
                            <span>{index + 1}.</span>
                            {theme}
                          </p>
                        ))}
                        <footer>
                          <strong>
                            {snapshot.approval
                              ? label(
                                  "准备好供你审核",
                                  "Ready for your review",
                                )
                              : label(
                                  "本地交付预览",
                                  "Local delivery preview",
                                )}
                          </strong>
                          <p>
                            {choiceLabel("channel", snapshot.channel)} ·{" "}
                            {snapshot.destination}
                          </p>
                          <small>
                            {label(
                              "仅为示例输出，未发送任何内容。",
                              "Sample output only. Nothing has been sent.",
                            )}
                          </small>
                        </footer>
                      </section>
                    )}
                    {run.status === "running" && (
                      <p className={styles.muted}>
                        {label(
                          "正在推进本地示例；未读取真实资源。",
                          "Advancing the local sample; no live resources are read.",
                        )}
                      </p>
                    )}
                    {run.status === "stopped" && (
                      <p className={styles.muted}>
                        {label(
                          "测试已停止。保留当前示例与审核备注。",
                          "Test stopped. Current sample and review notes are retained.",
                        )}
                      </p>
                    )}
                  </>
                )}
                {state.notes
                  .filter((note) => note.runId === run.id)
                  .map((note) => (
                    <div className={styles.reviewNote} key={note.id}>
                      <ChatMessage
                        id={"review-" + note.id}
                        role="user"
                        author={label(
                          "审核备注 · 本地",
                          "Review note · local",
                        )}
                        content={note.text}
                      />
                    </div>
                  ))}
              </>
            )}
          </div>
          <footer className={styles.testFooter}>
            <div className={styles.testMeta}>
              <span>{snapshot.model}</span>
              <span>{label("演示 · 1.8k tokens", "Demo · 1.8k tokens")}</span>
            </div>
            <div className={styles.noteComposer}>
              <ChatComposer
                inputLabel={label("后续备注", "Follow-up notes")}
                formLabel={label("审核备注编辑器", "Review note composer")}
                placeholder={label("添加审核备注…", "Add a review note…")}
                value={state.reviewDraft}
                onChange={(value) => change({ type: "note-draft", value })}
                onSend={() => {
                  change({ type: "note-add" })
                  requestAnimationFrame(() =>
                    conversation.current?.scrollTo({
                      top: conversation.current.scrollHeight,
                    }),
                  )
                }}
                sendLabel={label("添加审核备注", "Add review note")}
                sendContent={<ArrowUp />}
                controls={<span />}
                disabled={locked}
                sendDisabled={!run}
              />
            </div>
          </footer>
        </aside>
      </div></section>
      <ConfigurationSheet
        state={state}
        change={change}
        locale={locale}
        active={active}
        finalFocus={() => returnFocus.current ?? true}
      />
    </div>
  )
}

function ConfigurationSheet({
  state,
  change,
  locale,
  active,
  finalFocus,
}: {
  state: BuilderState
  change: Dispatch<BuilderAction>
  locale: "en" | "zh-CN"
  active: boolean
  finalFocus: () => HTMLElement | true
}) {
  const editor = state.editor
  const label = (zh: string, en: string) => (locale === "en" ? en : zh)
  const locked = state.readonly || state.readState === "loading"
  const node = nodes.find((node) => node.id === editor?.node)
  const draft = editor?.draft
  const sheetBody = useRef<HTMLDivElement>(null)
  function apply() {
    change({ type: "apply" })
    requestAnimationFrame(() =>
      sheetBody.current
        ?.querySelector<HTMLElement>('[aria-invalid="true"]')
        ?.focus(),
    )
  }
  const field = (
    key:
      | "name"
      | "purpose"
      | "instructions"
      | "time"
      | "condition"
      | "destination",
    title: string,
    multiline = false,
  ) => (
    <Field
      label={title}
      error={
        editor?.errors[key]
          ? editor.errors[key] === "time"
            ? label(
                "请输入有效的 UTC 时间（HH:MM）。",
                "Enter a valid UTC time (HH:MM).",
              )
            : label("此项不能为空。", "This field is required.")
          : undefined
      }
    >
      {(props) =>
        multiline ? (
          <Textarea
            {...props}
            disabled={locked}
            className={
              key === "instructions" ? styles.instructionsInput : undefined
            }
            value={displayText(draft?.[key] ?? "", locale)}
            onChange={(event) =>
              change({ type: "edit", patch: { [key]: event.target.value } })
            }
          />
        ) : (
          <Input
            {...props}
            type={key === "time" ? "time" : "text"}
            disabled={locked}
            value={displayText(draft?.[key] ?? "", locale)}
            onChange={(event) =>
              change({ type: "edit", patch: { [key]: event.target.value } })
            }
          />
        )
      }
    </Field>
  )
  const select = (
    key: "repeat" | "event" | "channel" | "model",
    title: string,
  ) => (
    <Field label={title}>
      {(props) => (
        <Select
          items={choices[key].map((choice) => ({
            value: choice.id,
            label: choice.label[locale],
          }))}
          value={draft?.[key]}
          onValueChange={(value) =>
            value && change({ type: "edit", patch: { [key]: value } })
          }
          disabled={locked}
        >
          <SelectTrigger {...props}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {choices[key].map((choice) => (
              <SelectItem key={choice.id} value={choice.id}>
                {choice.label[locale]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </Field>
  )
  return (
    <Sheet
      open={!!editor && active}
      onOpenChange={(open) => {
        if (!open) change({ type: "dismiss" })
      }}
    >
      <SheetContent
        size={460}
        className={styles.sheet}
        finalFocus={finalFocus ?? undefined}
      >
        <SheetHeader className={styles.sheetHeader}>
          <SheetTitle>{node?.title[locale]}</SheetTitle>
          <SheetDescription>{node?.description[locale]}</SheetDescription>
        </SheetHeader>
        <SheetBody ref={sheetBody} className={styles.sheetBody}>
          {draft && editor && (
            <>
              {editor.node === "agent" && (
                <>
                  {field("name", label("代理名称", "Agent name"))}
                  {field("purpose", label("目标", "Purpose"))}
                  {select("model", label("模型", "Model"))}
                  {field("instructions", label("指令", "Instructions"), true)}
                </>
              )}
              {editor.node === "schedule" && (
                <>
                  {select("repeat", label("重复", "Repeat"))}
                  {field("time", label("时间（UTC）", "Time (UTC)"))}
                  <p>
                    {label(
                      "此计划仅配置本地演示，不会创建后台任务。",
                      "This schedule configures the demo. No background job will be created.",
                    )}
                  </p>
                </>
              )}
              {editor.node === "event" && (
                <>
                  {select("event", label("事件", "Event"))}
                  {field("condition", label("仅当", "Only when"))}
                  <p>
                    {label(
                      "条件仅保存在代理配置中，不会注册实时 webhook。",
                      "Example condition stored with the agent; no live webhook is registered.",
                    )}
                  </p>
                </>
              )}
              {editor.node === "channels" && (
                <>
                  {select("channel", label("交付渠道", "Delivery channel"))}
                  {field("destination", label("目的地", "Destination"))}
                  <label className={styles.checkRow}>
                    <Checkbox
                      checked={draft.approval}
                      disabled={locked}
                      onCheckedChange={(approval) =>
                        change({ type: "edit", patch: { approval } })
                      }
                    />
                    <span>
                      <strong>{label("需要审核", "Require approval")}</strong>
                      <small>
                        {label(
                          "内容离开工作区之前先审核。",
                          "Review the output before it leaves the workspace.",
                        )}
                      </small>
                    </span>
                  </label>
                  <div className={styles.deliveryHint}>
                    <Bot />
                    <span>
                      {label("代理身份", "Agent identity")}:{" "}
                      {displayText(draft.name, locale)}
                    </span>
                    <p>
                      {label(
                        "交付仅为模拟，不会发送任何消息。",
                        "Delivery is simulated. No messages are sent.",
                      )}
                    </p>
                  </div>
                </>
              )}
              {editor.node === "memory" && (
                <>
                  <p>
                    {label(
                      "附加的上下文在每次任务开始时可用。请保持事实简洁并明确来源。",
                      "Attached context is available at the beginning of each run. Keep facts concise and attributable.",
                    )}
                  </p>
                  {draft.memory.map((memory, index) => (
                    <section className={styles.memoryForm} key={memory.id}>
                      <header>
                        <strong>
                          {label("记忆", "Memory")} {index + 1}
                        </strong>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          disabled={locked}
                          aria-label={label(
                            `移除记忆 ${index + 1}`,
                            `Remove memory ${index + 1}`,
                          )}
                          onClick={() =>
                            change({ type: "memory-remove", id: memory.id })
                          }
                        >
                          <Trash2 />
                        </Button>
                      </header>
                      {(["name", "content"] as const).map((key) => (
                        <Field
                          key={key}
                          label={label(
                            `记忆 ${index + 1} ${key === "name" ? "名称" : "内容"}`,
                            `Memory ${index + 1} ${key}`,
                          )}
                          error={
                            editor.errors[memory.id + ":" + key]
                              ? label(
                                  "此项不能为空。",
                                  "This field is required.",
                                )
                              : undefined
                          }
                        >
                          {(props) =>
                            key === "name" ? (
                              <Input
                                {...props}
                                disabled={locked}
                                value={displayText(memory.name, locale)}
                                onChange={(event) =>
                                  change({
                                    type: "memory-edit",
                                    id: memory.id,
                                    patch: { name: event.target.value },
                                  })
                                }
                              />
                            ) : (
                              <Textarea
                                {...props}
                                disabled={locked}
                                value={displayText(memory.content, locale)}
                                onChange={(event) =>
                                  change({
                                    type: "memory-edit",
                                    id: memory.id,
                                    patch: { content: event.target.value },
                                  })
                                }
                              />
                            )
                          }
                        </Field>
                      ))}
                      <p>
                        {label(
                          "来源：工作区笔记 · 此代理可见",
                          "Source: workspace note · Visible to this agent",
                        )}
                      </p>
                    </section>
                  ))}
                  <Button
                    variant="secondary"
                    disabled={locked}
                    onClick={() => change({ type: "memory-add" })}
                  >
                    <Plus />
                    {label("添加记忆", "Add memory")}
                  </Button>
                </>
              )}
              {(editor.node === "tools" ||
                editor.node === "skills" ||
                editor.node === "subagents") && (
                <div className={styles.choiceList}>
                  {choices[editor.node].map((choice) => (
                    <label className={styles.checkRow} key={choice.id}>
                      <Checkbox
                        checked={draft[
                          editor.node as "tools" | "skills" | "subagents"
                        ].includes(choice.id)}
                        disabled={locked}
                        onCheckedChange={(checked) =>
                          change({
                            type: "toggle",
                            group: editor.node as
                              "tools" | "skills" | "subagents",
                            id: choice.id,
                            checked,
                          })
                        }
                      />
                      <span>{choice.label[locale]}</span>
                    </label>
                  ))}
                </div>
              )}
            </>
          )}
        </SheetBody>
        <SheetFooter className={styles.sheetFooter}>
          <Button disabled={locked} onClick={apply}>
            {label("应用更改", "Apply changes")}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
