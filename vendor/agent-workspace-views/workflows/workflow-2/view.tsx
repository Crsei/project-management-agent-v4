"use client"

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import { Box, Check, Circle, FileCode2, GitBranch, Maximize2, Minimize2, MoreHorizontal, PanelLeftClose, PanelRightOpen, Play, RotateCcw, Share2, Sun, Wrench, X } from "lucide-react"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { Item } from "@easyuse-ui/ui/components/ui/item"
import { RuntimeStatusBadge } from "@easyuse-ui/ui/components/ui/runtime-status-badge"
import { ResizableHandle } from "@easyuse-ui/ui/components/ui/resizable"
import { CanvasPort } from "@easyuse-ui/ui/components/ui/canvas-port"
import type { CanvasNodeProps } from "@easyuse-ui/ui/components/ui/canvas-node"
import { WorkflowCanvas } from "@easyuse-ui/ui/components/blocks/workflow-canvas"
import { ChatMessage } from "@easyuse-ui/ui/components/blocks/chat-message"
import { ToolCall } from "@easyuse-ui/ui/components/blocks/tool-call"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@easyuse-ui/ui/components/ui/dropdown-menu"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@easyuse-ui/ui/components/ui/dialog"
import { useI18n } from "@easyuse-ui/ui/lib/i18n-provider"
import { applyCanvasCommand } from "@easyuse-ui/ui/lib/canvas-commands"
import { ComposerInput } from "../../composer-input"
import { useComposerDemoController } from "../../demo-controller"
import type { ComposerDemoSource } from "../../demo-source"
import { remainingPageScenarios, type RemainingPageProps } from "../../showcase/model"
import { RemainingPageStateProvider, useRemainingPageState } from "../../showcase/state"
import { createWorkflowSource, observedActivities, workflowDefinitions, workflowSteps } from "./fixtures"
import { advanceWorkflow, createWorkflowState, executionSnapshot, followWorkflow, inspectWorkflowEvent, reconcileWorkflow, restartWorkflow, stepStatus } from "./controller"
import styles from "./workflow-2.module.css"

export const pageScenarios = [...remainingPageScenarios,
  { id: "completed", name: { "zh-CN": "执行完成", en: "Completed run" } },
  { id: "blocked", name: { "zh-CN": "步骤阻塞", en: "Blocked step" } },
  { id: "unknown", name: { "zh-CN": "结果未知", en: "Unknown outcome" } },
] as const

export function RemainingPageView(props: RemainingPageProps) {
  return <RemainingPageStateProvider cache={props.cache}><WorkflowView key={props.scenario} {...props} /></RemainingPageStateProvider>
}

function ExecutionNode({ node, definition, status, selected, outcome }: CanvasNodeProps) {
  const { locale } = useI18n()
  const step = workflowSteps.find(item => item.id === node.id)!
  const index = workflowSteps.indexOf(step)
  const progress = status === "completed" ? 100 : status === "running" ? 58 : 0
  const l = (zh: string, en: string) => locale === "en" ? en : zh
  return <div className={styles.node} data-workflow-node={node.id} data-selected={selected || undefined} data-status={status}>
    <div className={styles.nodeTop}>
      <span className={styles.nodeIcon}><GitBranch size={16} /></span>
      <div className={styles.nodeIdentity}><span>{step.category[locale]}</span><strong title={step.title[locale]}>{step.title[locale]}</strong></div>
      <RuntimeStatusBadge status={status ?? "waiting"} />
    </div>
    <p className={styles.nodeDescription} title={step.description[locale]}>{step.description[locale]}</p>
    {step.tool ? <div className={styles.nodeEvidence}><div><Wrench /><span>{l("工具", "Tool")}</span><code>{step.tool}</code></div><div><FileCode2 /><span>{l("文件", "File")}</span><code title={step.file}>{step.file}</code></div></div> : "checklist" in step && step.checklist ? <div className={styles.checklist}>{step.checklist.map(item => <span key={item.en}><>{status === "completed" ? <Check size={12} /> : <Circle size={12} />}</>{item[locale]}</span>)}</div> : <p className={styles.nodeHint}>{l("选择节点查看配置与依赖。", "Select the node to inspect its configuration and dependencies.")}</p>}
    <footer><span><i />{step.owner}</span><span>{outcome === "unknown" ? l("未知", "Unknown") : `${progress}%`}<b style={{ "--progress": `${progress}%` } as CSSProperties} /></span></footer>
    <div className={styles.ports}>{definition?.ports.filter(port => port.direction === "input" ? index > 0 : index < 5).map(port => <CanvasPort key={port.id} port={port} readOnly />)}</div>
  </div>
}
function renderExecutionNode(props: CanvasNodeProps) {
  return <ExecutionNode {...props} />
}


function WorkflowView({ scenario, active, cache, host }: RemainingPageProps) {
  const { locale } = useI18n()
  const l = (zh: string, en: string) => locale === "en" ? en : zh
  const [state, setState] = useRemainingPageState(`workflow-2:${scenario}:workspace`, () => createWorkflowState(scenario))
  const source = useMemo(() => (cache.get(`workflow-2:${scenario}:chat`) as ComposerDemoSource | undefined) ?? createWorkflowSource(scenario), [cache, scenario])
  const { history: historyRef, textarea: textareaRef, ...chat } = useComposerDemoController({ ...source, canSend: scenario !== "readonly" && state.readState !== "loading" }, active, false)
  const readOnly = scenario === "readonly"
  const [shareOpen, setShareOpen] = useState(false)
  const [feedback, setFeedback] = useState("")
  const workspace = useRef<HTMLDivElement>(null)
  const historyPosition = useRef<number>((cache.get(`workflow-2:${scenario}:scroll`) as number | undefined) ?? 0)
  const fieldSelection = useRef<{ start: number; end: number } | null>((cache.get(`workflow-2:${scenario}:selection`) as { start: number; end: number } | undefined) ?? null)
  const [width, setWidth] = useState(1451)
  const threadWidth = Math.min(Math.max(state.threadWidth, 320), Math.max(320, width - 600))
  const steps = scenario === "empty" ? [] : workflowSteps
  const selected = workflowSteps.find(step => step.id === state.selectedEvent) ?? workflowSteps[2]
  const activity = observedActivities[selected.id] ?? { tool: "", file: "" }
  const activeAgents = workflowSteps.filter(step => stepStatus(state.run, step.id) === "running").length
  const status = stepStatus(state.run, selected.id)
  const completed = state.run.completed
  const snapshot = useMemo(() => executionSnapshot(state), [state])
  const phaseStatus = state.run.phase === "blocked" ? "failed" : state.run.phase === "unknown" ? "waiting" : state.run.phase

  useEffect(() => { cache.set(`workflow-2:${scenario}:chat`, { ...source, sessions: chat.sessions, drafts: chat.drafts }) }, [cache, scenario, source, chat.sessions, chat.drafts])
  useLayoutEffect(() => {
    if (!active) return
    historyRef.current?.scrollTo({ top: historyPosition.current })
    if (fieldSelection.current) textareaRef.current?.setSelectionRange(fieldSelection.current.start, fieldSelection.current.end)
  }, [active, locale, historyRef, textareaRef])
  useEffect(() => {
    const element = workspace.current
    if (!element) return
    const observer = new ResizeObserver(entries => setWidth(entries[0].contentRect.width))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!active || !state.run.playing || state.run.phase !== "running" || readOnly || state.readState !== "ready") return
    const runId = state.run.id
    const timer = setTimeout(() => setState(previous => advanceWorkflow(previous, runId)), 1600)
    return () => clearTimeout(timer)
  }, [active, state.run, state.readState, readOnly, setState])

  function remember() {
    if (historyRef.current) {
      historyPosition.current = historyRef.current.scrollTop
      cache.set(`workflow-2:${scenario}:scroll`, historyPosition.current)
    }
    if (textareaRef.current) {
      fieldSelection.current = { start: textareaRef.current.selectionStart, end: textareaRef.current.selectionEnd }
      cache.set(`workflow-2:${scenario}:selection`, fieldSelection.current)
    }
    chat.rememberPosition()
  }
  function changeWorkspace(open: boolean) {
    remember()
    setState(previous => ({ ...previous, workspaceOpen: open, expanded: false }))
    if (!open) requestAnimationFrame(() => chat.focusComposer())
  }
  function exportRun() {
    const blob = new Blob([JSON.stringify({ source: "local fixture", document: state.document, run: state.run, evidence: snapshot }, null, 2)], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url; link.download = "workflow-2-local-run.json"; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  function loadFixture() {
    if (readOnly || state.run.phase === "unknown") return
    const messages = createWorkflowSource("default").sessions[0].messages
    chat.setSessions(previous => previous.map(session => session.id === chat.selectedId ? { ...session, messages } : session))
    setState(previous => ({ ...restartWorkflow(previous), readState: "ready" }))
  }
  const sendMessage = () => {
    const text = chat.draft.text.trim()
    if (!text || readOnly || state.readState === "loading") return
    remember()
    const user = { id: crypto.randomUUID(), role: "user" as const, text, contexts: chat.activeContexts.map(item => item.name) }
    const reply = { id: crypto.randomUUID(), role: "assistant" as const, text: source.reply }
    chat.setSessions(previous => previous.map(session => session.id === chat.selectedId ? { ...session, messages: [...session.messages, user, reply] } : session))
    chat.updateDraft({ text: "", contextIds: [], blocks: false })
    requestAnimationFrame(() => { chat.focusComposer(); historyRef.current?.scrollTo({ top: historyRef.current.scrollHeight }) })
  }
  const inputController = { ...chat, history: historyRef, textarea: textareaRef, canSend: !readOnly && state.readState !== "loading", rememberPosition: remember, sendMessage }
  const openButton = <Button size="icon-sm" variant="ghost" aria-label={state.workspaceOpen ? l("关闭工作流", "Close workflow") : l("打开工作流", "Open workflow")} aria-pressed={state.workspaceOpen} onClick={() => changeWorkspace(!state.workspaceOpen)}><PanelLeftClose /></Button>

  return <div className={styles.page} data-page="workflow-2">
    <header className={styles.pageHeader}><h1>{l("Workflow 2 · 实时执行", "Workflow 2 · Live execution")}</h1><div>
      <Button variant="ghost" onClick={() => setShareOpen(true)}><Share2 />{l("分享", "Share")}</Button>
      <DropdownMenu><DropdownMenuTrigger render={<Button size="icon" variant="ghost" aria-label={l("更多操作", "More actions")} />}><MoreHorizontal /></DropdownMenuTrigger><DropdownMenuContent>
        <DropdownMenuItem onClick={exportRun}>{l("导出本地执行证据", "Export local run evidence")}</DropdownMenuItem>
        <DropdownMenuItem disabled={readOnly || state.run.phase !== "running"} onClick={() => setState(previous => advanceWorkflow(previous))}>{l("推进本地下一步", "Advance next fixture step")}</DropdownMenuItem>
        <DropdownMenuItem disabled={readOnly || !["running", "paused"].includes(state.run.phase)} onClick={() => setState(previous => ({ ...previous, run: { ...previous.run, playing: !previous.run.playing, phase: previous.run.playing ? "paused" : "running" } }))}>{state.run.playing ? l("暂停本地播放", "Pause fixture playback") : l("播放本地执行", "Play fixture execution")}</DropdownMenuItem>
      </DropdownMenuContent></DropdownMenu>
      <Button size="icon" variant="ghost" aria-label={l("切换主题", "Toggle theme")} onClick={() => host.setTheme(host.resolvedTheme === "dark" ? "light" : "dark")}><Sun /></Button>
    </div></header>
    {state.readState !== "ready" && <div className={styles.notice} role={state.readState === "error" ? "alert" : "status"}><span>{state.readState === "loading" ? l("正在加载本地执行快照…", "Loading local execution snapshot…") : l("刷新失败，已保留上一次执行记录与草稿。", "Refresh failed; the previous run and draft are preserved.")}</span><Button variant="outline" onClick={() => setState(previous => ({ ...previous, readState: "ready" }))}>{state.readState === "loading" ? l("载入本地快照", "Load fixture snapshot") : l("重新读取", "Retry read")}</Button></div>}
    <div className={styles.workspace} ref={workspace}>
      <section className={styles.thread} hidden={state.expanded} style={{ width: state.workspaceOpen ? threadWidth : "100%" }} aria-label={l("工作流线程", "Workflow thread")}>
        <header className={styles.threadHeader}><span>{l("工作流线程", "Workflow thread")}</span>{openButton}</header>
        <div className={styles.history} ref={historyRef} onScroll={remember} role="region" aria-label={l("对话消息", "Conversation messages")} tabIndex={0}><div role="log">
          {!chat.selected.messages.length && <div className={styles.empty}><GitBranch /><h2>{l("开始工作流讨论", "Start a workflow conversation")}</h2><p>{l("描述请求，或播放本地执行示例查看工具与文件活动。", "Describe your request, or play the local execution fixture to inspect tool and file activity.")}</p><Button disabled={readOnly} onClick={loadFixture}>{l("载入执行示例", "Load execution fixture")}</Button></div>}
          {chat.selected.messages.map(message => <ChatMessage key={message.id} id={message.id} role={message.role === "assistant" ? "agent" : "user"} author={message.role === "assistant" ? l("EasyuseUI AI · 工作流 Agent", "EasyuseUI AI · Workflow agent") : l("你", "You")} content={chat.copy(message.text)}>
            {message.id === "workflow-2-answer" && <div className={styles.runCard}>
              <header><span className={styles.cardIcon}><GitBranch /></span><div><strong title={l("工作流实现执行", "Workflow implementation run")}>{l("工作流实现执行", "Workflow implementation run")}</strong><small>{l("交互式工作流工作区", "Interactive workflow workspace")}</small></div><RuntimeStatusBadge status={phaseStatus} /></header>
              <div className={styles.cardBody}><div className={styles.executionSummary}><span><i />{l("执行进行中", "Execution in progress")}</span><code>00:18</code><div className={styles.segments}>{workflowSteps.map((step, index) => <span key={step.id} data-state={index < completed ? "completed" : index === completed ? "running" : "waiting"} />)}</div></div>
                <div className={styles.stats}><div><strong>{completed}/6</strong><span>{l("已完成", "Completed")}</span></div><div><strong>{activeAgents}</strong><span>{l("活动 Agent", "Active agents")}</span></div><div><strong>{completed === 6 ? "1m 08s" : "00:18"}</strong><span>{l("已用时间", "Elapsed")}</span></div></div></div>
              <footer><span><i />{l("工作区就绪", "Workspace ready")}</span><Button variant="outline" size="sm" onClick={() => changeWorkspace(true)}><Maximize2 />{l("打开工作流", "Open workflow")}</Button></footer>
            </div>}
          </ChatMessage>)}
        </div></div>
        <div className={styles.composer}><ComposerInput controller={inputController} helpId={`workflow-2-${scenario}-help`} options={{ hideSuggestion: true, showBlocksControl: false, placeholder: { "zh-CN": "请求工作流变更…", en: "Ask for a workflow change…" }, formLabel: { "zh-CN": "继续工作流", en: "Continue workflow" }, inputLabel: { "zh-CN": "消息", en: "Message" }, tools: <Button variant="ghost" aria-pressed={state.workspaceOpen} onClick={() => changeWorkspace(!state.workspaceOpen)}><GitBranch />{l("画布", "Canvas")}</Button> }} /></div>
      </section>
      {state.workspaceOpen && !state.expanded && <ResizableHandle unstyled className={styles.resizer} value={threadWidth} min={320} max={Math.max(320, width - 600)} onValueChange={threadWidth => setState(previous => ({ ...previous, threadWidth }))} label={l("调整工作流工作区", "Resize workflow workspace")} />}
      <section className={styles.execution} hidden={!state.workspaceOpen} aria-label={l("实时 Agent 执行图", "Live agent execution map")}>
        <header className={styles.executionHeader}><div><strong>{l("实时 Agent 执行图", "Live agent execution map")}</strong><small>{l("观察到的活动 · 本地执行示例", "Observed activity · local execution fixture")}</small></div><RuntimeStatusBadge status={phaseStatus} />
          <Button variant="outline" size="sm" disabled={readOnly || state.run.phase === "unknown" || state.readState === "loading"} onClick={() => setState(previous => restartWorkflow(previous))}>{state.run.phase === "completed" ? <Play /> : <RotateCcw />}{state.run.phase === "completed" ? l("再次运行", "Run again") : l("重新运行", "Restart run")}</Button>
          <Button size="icon-sm" variant="ghost" aria-label={state.expanded ? l("收起工作流工作区", "Collapse workflow workspace") : l("展开工作流工作区", "Expand workflow workspace")} onClick={() => { remember(); setState(previous => ({ ...previous, expanded: !previous.expanded })) }}>{state.expanded ? <Minimize2 /> : <Maximize2 />}</Button>
          {!state.traceOpen && <Button size="icon-sm" variant="ghost" aria-label={l("打开检查器", "Open inspector")} onClick={() => setState(previous => ({ ...previous, traceOpen: true }))}><PanelRightOpen /></Button>}
          <Button size="icon-sm" variant="ghost" aria-label={l("关闭工作流工作区", "Close workflow workspace")} onClick={() => changeWorkspace(false)}><X /></Button>
        </header>
        <div className={styles.executionBody}><div className={styles.map}>
          {steps.length || completed > 0 || state.run.phase === "running" ? <WorkflowCanvas document={state.document} definitions={workflowDefinitions} selection={state.selection} execution={snapshot} readOnly={readOnly} viewport={state.document.viewport} renderNode={renderExecutionNode} showMiniMap={false} controlsVariant="minimal-vertical" onSelectionChange={selection => setState(previous => selection.nodeIds[0] ? inspectWorkflowEvent(previous, selection.nodeIds[0]) : { ...previous, selection })} onCommand={command => { if (command.type !== "move" || readOnly) return; setState(previous => { const result = applyCanvasCommand(previous.document, command, workflowDefinitions); return result.ok ? { ...previous, document: result.document } : previous }) }} onViewportChange={viewport => setState(previous => ({ ...previous, document: { ...previous.document, viewport } }))} className={styles.canvas} /> : <div className={styles.empty}><Box /><p>{l("没有执行记录", "No execution records")}</p><Button onClick={loadFixture}>{l("载入执行示例", "Load execution fixture")}</Button></div>}
          <div className={styles.legend}><span data-tone="running">{l("运行中", "Running")}</span><span data-tone="completed">{l("已完成", "Completed")}</span><span data-tone="waiting">{l("等待中", "Waiting")}</span><span data-tone="blocked">{l("已阻塞", "Blocked")}</span></div>
        </div>
        <aside className={styles.trace} hidden={!state.traceOpen} aria-label={l("实时追踪", "Live trace")}>
          <header><div><strong>{l("实时追踪", "Live trace")}</strong><small>{state.following ? l("跟随活动步骤", "Following active step") : l("检查执行历史", "Inspecting run history")}</small></div>{!state.following && <Button variant="ghost" size="sm" onClick={() => setState(previous => followWorkflow(previous))}>{l("跟随实时", "Follow live")}</Button>}<Button size="icon-sm" variant="ghost" aria-label={l("关闭实时追踪", "Close live trace")} onClick={() => setState(previous => ({ ...previous, traceOpen: false }))}><X /></Button></header>
          <div className={styles.traceScroll}>
            <section className={styles.progressSection}><small>{l("执行进度", "Run progress")}</small><div><strong>{completed} {l("/ 6 步", "of 6 steps")}</strong><span>{Math.round(completed / 6 * 100)}%</span></div><div className={styles.progressTrack} role="progressbar" aria-label={l("工作流进度", "Workflow progress")} aria-valuemin={0} aria-valuemax={6} aria-valuenow={completed}><span style={{ width: `${completed / 6 * 100}%` }} /></div></section>
            <section className={styles.eventSection}><div className={styles.eyebrow}><span>{state.following && state.run.phase === "running" ? l("正在执行", "Now executing") : l("选中事件", "Selected event")}</span><code>{selected.duration}</code></div><h2>{selected.title[locale]}</h2><p>{selected.description[locale]}</p>
              {activity.tool && <div className={styles.eventEvidence}><div><Wrench /><span>{l("工具", "Tool")}</span><code>{activity.tool}</code></div><div><FileCode2 /><span>{l("文件", "File")}</span><code title={activity.file}>{activity.file}</code></div></div>}
              {state.run.phase === "blocked" && <div className={styles.recovery} role="alert"><p>{l("本地示例：该步骤被阻塞，先前事件与文件证据已保留。", "Local fixture: this step is blocked; previous events and file evidence are retained.")}</p><Button disabled={readOnly} variant="outline" onClick={() => setState(previous => ({ ...previous, run: { ...previous.run, phase: "running", playing: false } }))}>{l("解除本地阻塞", "Resolve fixture block")}</Button></div>}
              {state.run.phase === "unknown" && <div className={styles.recovery} role="alert"><p>{l("执行结果未知。先查询事件记录，不自动重放。", "Execution outcome unknown. Query the event ledger before any replay.")}</p><Button variant="outline" onClick={() => setState(previous => reconcileWorkflow(previous))}>{l("查询本地执行状态", "Query local run status")}</Button></div>}
              {!state.following && activity.tool && <ToolCall call={{ id: `${state.run.id}-${selected.id}`, name: activity.tool, target: activity.file, status, arguments: { path: activity.file }, output: l("本地执行证据，仅展示，不执行工具。", "Local execution evidence; displayed only, no tool is executed."), outcome: snapshot.nodes[selected.id]?.outcome ?? "known" }} />}
            </section>
            <section className={styles.activity}><h2>{l("活动", "Activity")}</h2><div>{workflowSteps.filter((step, index) => index <= completed || stepStatus(state.run, step.id) === "running").map(step => <Item key={step.id} density="compact" selected={state.selectedEvent === step.id} ariaLabel={`${step.title[locale]} · ${stepStatus(state.run, step.id)}`} title={step.title[locale]} leading={<RuntimeStatusBadge iconOnly status={stepStatus(state.run, step.id)} />} trailing={<code>{step.duration}</code>} onSelect={() => setState(previous => inspectWorkflowEvent(previous, step.id))} />)}</div></section>
          </div>
        </aside></div>
      </section>
    </div>
    <Dialog open={shareOpen && active} onOpenChange={setShareOpen}><DialogContent><DialogTitle>{l("分享工作流", "Share workflow")}</DialogTitle><DialogDescription>{l("此工作区只保存在本地内存。复制本地展示链接，或导出示例执行证据；不会发布到远程服务。", "This workspace exists only in local memory. Copy its local showcase link or export fixture evidence; nothing is published to a remote service.")}</DialogDescription><div className={styles.shareActions}><Button onClick={async () => { try { await navigator.clipboard.writeText(`${location.origin}/showcase/workflow-2`); setFeedback(l("本地链接已复制", "Local link copied")) } catch { setFeedback(l("剪贴板不可用，请复制地址栏链接", "Clipboard unavailable; copy the address bar link")) } }}><Share2 />{l("复制本地链接", "Copy local link")}</Button><Button variant="outline" onClick={exportRun}>{l("导出证据", "Export evidence")}</Button></div><p role="status">{feedback}</p></DialogContent></Dialog>
    {readOnly && <span className="sr-only">{l("只读场景：允许检查与编辑草稿，禁止发送和运行。", "Read-only scenario: inspection and draft editing are available; sending and execution are disabled.")}</span>}
  </div>
}
