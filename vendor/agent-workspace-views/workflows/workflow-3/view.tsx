"use client"

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react"
import { ReactFlow, ReactFlowProvider, Handle, Position, Panel, useReactFlow, useNodesInitialized, type Node, type NodeChange, type NodeProps, type Viewport } from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import { ArrowDown, CheckCircle2, ChevronRight, Code2, FileText, GitBranch, GitPullRequest, ListChecks, Maximize2, Minimize2, MoreHorizontal, PanelRightClose, Pause, Play, Plus, RotateCcw, Scan, Search, Share2, ShieldCheck, Terminal, UserRound, Workflow, X, ZoomIn, ZoomOut } from "lucide-react"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { Input } from "@easyuse-ui/ui/components/ui/input"
import { Textarea } from "@easyuse-ui/ui/components/ui/textarea"
import { RuntimeStatusBadge } from "@easyuse-ui/ui/components/ui/runtime-status-badge"
import { ResizableHandle } from "@easyuse-ui/ui/components/ui/resizable"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@easyuse-ui/ui/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@easyuse-ui/ui/components/ui/dropdown-menu"
import { ChatMessage } from "@easyuse-ui/ui/components/blocks/chat-message"
import { CanvasEdge } from "@easyuse-ui/ui/components/ui/canvas-edge"
import { useI18n } from "@easyuse-ui/ui/lib/i18n-provider"
import { ComposerInput } from "../../composer-input"
import { ComposerWorkspaceView } from "../../composer-workspace-view"
import { useComposerDemoController } from "../../demo-controller"
import { newTitle, type ComposerSession } from "../../model"
import type { ComposerController } from "../../controller"
import { remainingPageScenarios, type RemainingPageProps } from "../../showcase/model"
import { RemainingPageStateProvider, useRemainingPageState } from "../../showcase/state"
import { createComposerSource, handoffs, reviewNodes, stages, text, workflowTitle, type ReviewNode } from "./fixtures"
import { addReviewNote, advanceReview, approveReview, createReviewState, loadReviewFixture, nodeStatus, reconcileReview, replayReview, requestRevision, resolveRevision, reviewExport, type ReviewState } from "./controller"
import styles from "./workflow-3.module.css"

export const pageScenarios = [
  ...remainingPageScenarios,
  { id: "revision", name: text("返工待处理", "Revision required") },
  { id: "approval", name: text("证据汇合待审批", "Awaiting approval") },
  { id: "unknown-outcome", name: text("结果未知", "Unknown outcome") },
]
const icons = { planner: GitBranch, researcher: Search, implementer: Code2, tester: ListChecks, reviewer: GitPullRequest, approval: ShieldCheck, published: FileText }
type AgentFlowNode = Node<{ record: ReviewNode; state: ReviewState; locale: "en" | "zh-CN" }, "review">
function ReviewNodeStatus({ state, id }: { state: ReviewState; id: ReviewNode["id"] }) {
  const { locale } = useI18n()
  return id === "implementer" && state.revisionResolved
    ? <span className={styles.revised} data-review-status="revised"><RotateCcw size={12} />{locale === "en" ? "Revised" : "已修订"}</span>
    : <RuntimeStatusBadge status={nodeStatus(state, id)} />
}
function AgentReviewNode({ data, selected }: NodeProps<AgentFlowNode>) {
  const { record: node, state, locale } = data
  const Icon = icons[node.id]
  const revised = node.id === "implementer" && state.revisionResolved
  const status = nodeStatus(state, node.id)
  const progress = status === "completed" ? 100 : status === "queued" ? 0 : null
  return <article className={styles.node} data-selected={selected} data-revised={revised}>
    <Handle type="target" position={Position.Left} isConnectable={false} />
    <div className={styles.nodeHeading}>
      <header><span className={styles.nodeIcon}><Icon size={16} /></span><div className={styles.nodeTitle}><small>{node.kind[locale]}</small><strong title={node.title[locale]}>{node.title[locale]}</strong></div>
        <ReviewNodeStatus state={state} id={node.id} />
      </header>
      <p>{node.description[locale]}</p>
    </div>
    <div className={styles.nodeBody}><div className={styles.nodeContext} data-empty={!node.tool && node.id !== "planner"}>
      {node.id === "planner" ? node.tasks.map(task => <span key={task.en}><CheckCircle2 size={13} />{task[locale]}</span>) : <>
        {node.tool && <span><Terminal size={12} /><span>{locale === "en" ? "Tool" : "工具"}</span><code>{node.tool}</code></span>}
        {node.file && <span><FileText size={12} /><span>{locale === "en" ? "File" : "文件"}</span><code title={node.file}>{node.file}</code></span>}
        {!node.tool && <p>{locale === "en" ? "Select the node to inspect its configuration and dependencies." : "选择节点以检查配置与依赖。"}</p>}
      </>}
    </div></div>
    <footer><span><i />{state.owners[node.id] ?? node.owner}</span><span>{progress === null ? "—" : `${progress}%`} <b><i style={{ width: `${progress ?? 0}%` }} /></b></span></footer>
    <Handle type="source" position={Position.Right} isConnectable={false} />
  </article>
}
const nodeTypes = { review: AgentReviewNode }
const edgeTypes = { handoff: CanvasEdge }
function FlowControls() {
  const flow = useReactFlow()
  const { locale } = useI18n()
  const label = (zh: string, en: string) => locale === "en" ? en : zh
  return <Panel position="bottom-left" className={styles.flowControls}>
    <Button variant="ghost" size="icon" aria-label={label("放大", "Zoom In")} onClick={() => flow.zoomIn()}><ZoomIn /></Button>
    <Button variant="ghost" size="icon" aria-label={label("缩小", "Zoom Out")} onClick={() => flow.zoomOut()}><ZoomOut /></Button>
    <Button variant="ghost" size="icon" aria-label={label("适应画布", "Fit View")} onClick={() => flow.fitView({ padding: .06, minZoom: .35, maxZoom: .65 })}><Scan /></Button>
  </Panel>
}
function InitialReviewViewport({ active, ready: readyRef, onReady, focusNode, scopeRef, onFocused }: { active: boolean; ready: RefObject<boolean>; onReady: (viewport: Viewport) => void; focusNode: string | null; scopeRef: RefObject<HTMLDivElement | null>; onFocused: () => void }) {
  const flow = useReactFlow()
  const initialized = useNodesInitialized()
  useEffect(() => {
    if (!active || !initialized || !flow.viewportInitialized || readyRef.current) return
    readyRef.current = true
    void flow.fitView({ padding: .06, minZoom: .35, maxZoom: .65, duration: 0 }).then(fitted => {
      if (fitted) onReady(flow.getViewport())
      else readyRef.current = false
    })
  }, [active, initialized, flow, readyRef, onReady])
  useEffect(() => {
    if (!focusNode) return
    if (!active) { onFocused(); return }
    if (!initialized) return
    const element = scopeRef.current?.querySelector<HTMLDivElement>(`.react-flow__node[data-id="${focusNode}"]`)
    // Selection changes temporarily hide nodes while React Flow remeasures them.
    if (!element || getComputedStyle(element).visibility === "hidden") return
    element.focus({ preventScroll: true })
    onFocused()
  }, [active, initialized, focusNode, scopeRef, onFocused])
  return null
}
export function RemainingPageView(props: RemainingPageProps) {
  return <RemainingPageStateProvider cache={props.cache}><WorkflowReview {...props} /></RemainingPageStateProvider>
}
function WorkflowReview({ scenario, active, host }: RemainingPageProps) {
  const { locale } = useI18n()
  const label = (zh: string, en: string) => locale === "en" ? en : zh
  const [state, setState] = useRemainingPageState(`workflow-3:${scenario}`, () => createReviewState(scenario))
  const [shareOpen, setShareOpen] = useRemainingPageState(`workflow-3:${scenario}:share`, () => false)
  const source = useMemo(() => createComposerSource(), [])
  const base = useComposerDemoController(source, active, false)
  const history = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const inspector = useRef<HTMLDivElement>(null)
  // The engine's initial identity transform is not a user-authored cached viewport.
  const viewportReady = useRef(Boolean(state.viewport))
  const recordViewport = useCallback((viewport: Viewport) => setState(current => ({ ...current, viewport })), [setState])
  const [focusNode, setFocusNode] = useState<string | null>(null)
  const finishNodeFocus = useCallback(() => setFocusNode(null), [])
  const [nodeMeasurements, setNodeMeasurements] = useState<Record<string, { width: number; height: number }>>({})
  const measureNodes = useCallback((changes: NodeChange<AgentFlowNode>[]) => {
    setNodeMeasurements(current => {
      let next = current
      for (const change of changes) {
        if (change.type !== "dimensions" || !change.dimensions || change.dimensions.width <= 0 || change.dimensions.height <= 0) continue
        const before = current[change.id]
        if (before?.width === change.dimensions.width && before.height === change.dimensions.height) continue
        if (next === current) next = { ...current }
        next[change.id] = change.dimensions
      }
      return next
    })
  }, [])
  const selected = reviewNodes.find(node => node.id === state.selectedId)
  const copy = (value: string | { "zh-CN": string; en: string }) => typeof value === "string" ? value : value[locale]
  const readonly = state.readonly
  const update = (patch: Partial<ReviewState>) => setState(current => ({ ...current, ...patch }))
  const closePanel = () => { update({ panelOpen: false, expanded: false }); base.focusComposer() }
  const closeInspector = () => {
    setFocusNode(state.selectedId)
    update({ selectedId: null, inspector: "node" })
  }
  const session: ComposerSession = { ...source.sessions[0], title: state.title, messages: state.messages }
  const controller: ComposerController = {
    ...base, history, selected: session, sessions: [session], selectedId: session.id,
    sessionsVisible: false, setSessionsVisible: () => base.setGlobalCollapsed(value => !value),
    hasMessages: state.messages.length > 0, draft: state.draft,
    activeContexts: source.contextItems.filter(item => state.draft.contextIds.includes(item.id)),
    updateDraft: (patch: Partial<ReviewState["draft"]>) => setState(current => ({ ...current, draft: { ...current.draft, ...patch } })),
    toggleContext: (id: string) => setState(current => ({ ...current, draft: { ...current.draft, contextIds: current.draft.contextIds.includes(id) ? current.draft.contextIds.filter(value => value !== id) : [...current.draft.contextIds, id] } })),
    removeContext: (id: string) => setState(current => ({ ...current, draft: { ...current.draft, contextIds: current.draft.contextIds.filter(value => value !== id) } })),
    sendMessage: () => { setState(addReviewNote); base.focusComposer(); requestAnimationFrame(() => history.current?.scrollTo({ top: history.current.scrollHeight })) },
    renameSession: (id, title) => { if (id === session.id && title.trim()) update({ title: title.trim() }) },
    clearSession: (id) => { if (id === session.id) update({ title: newTitle, messages: [], readingPosition: 0 }) },
    scrollToLatest: () => {
      if (history.current) {
        history.current.scrollTop = history.current.scrollHeight
        update({ readingPosition: history.current.scrollTop })
      }
    },
    exportConversation: () => {
      const content = state.messages.map(message => `${message.role}: ${copy(message.text)}`).join("\n\n")
      const url = URL.createObjectURL(new Blob([content], { type: "text/plain" }))
      const link = document.createElement("a"); link.href = url; link.download = "workflow-3-conversation.txt"; link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    },
    canSend: !readonly && state.readState !== "loading", suggestionsVisible: false,
  }
  useLayoutEffect(() => {
    if (!active || state.threadWidth || !body.current) return
    setState(current => ({ ...current, threadWidth: Math.max(280, body.current!.clientWidth * .28) }))
  }, [active, state.threadWidth, setState])
  useLayoutEffect(() => {
    if (!active) return
    if (history.current) history.current.scrollTop = state.readingPosition
    if (inspector.current) inspector.current.scrollTop = state.inspectorPosition
  }, [active, locale, state.expanded, state.panelOpen, state.readingPosition, state.inspectorPosition])
  useEffect(() => {
    if (!active || !state.replaying || state.paused || state.stage >= 3) return
    const timer = setTimeout(() => setState(advanceReview), 1100)
    return () => clearTimeout(timer)
  }, [active, state.replaying, state.paused, state.stage, setState])
  useEffect(() => {
    if (!active) return
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || (event.target instanceof HTMLElement && event.target.closest('input,textarea,[contenteditable="true"],[role="dialog"],[role="menu"],[role="listbox"]'))) return
      if (event.key === "Escape" && state.selectedId) {
        // Own dismissal before React Flow blurs the focused node on Escape.
        event.preventDefault()
        event.stopPropagation()
        closeInspector()
      }
    }
    window.addEventListener("keydown", key, true)
    return () => window.removeEventListener("keydown", key, true)
  })
  const nodes = useMemo<AgentFlowNode[]>(() => reviewNodes.map(record => ({ id: record.id, type: "review", position: record.position, measured: nodeMeasurements[record.id], data: { record: scenario === "long-content" ? { ...record, description: text(record.description["zh-CN"] + " 保留完整任务上下文、依赖检查、修订理由与审阅证据，确保每个工作流都有清晰归属。", record.description.en + " Preserve complete task context, dependency checks, revision rationale, and review evidence so that every workstream has explicit ownership.") } : record, state, locale }, selected: state.selectedId === record.id, ariaLabel: `${record.kind[locale]}: ${record.title[locale]}` })), [locale, scenario, state, nodeMeasurements])
  const edges = useMemo(() => handoffs.map((edge, index) => ({ id: `handoff-${index}`, type: "handoff", source: edge.source, target: edge.target, ariaLabel: `${edge.revision ? (locale === "en" ? "Revision" : "返工") : (locale === "en" ? "Handoff" : "交接")}: ${edge.source} → ${edge.target}`, style: edge.revision ? { strokeDasharray: "5 5" } : undefined, data: { executionVisuals: { edgeEffect: "none", paused: true }, ...(edge.revision && state.stage === 3 ? { status: "running" } : {}) } })), [locale, state.stage])
  function downloadEvidence() {
    const url = URL.createObjectURL(new Blob([reviewExport(state)], { type: "application/json" }))
    const link = document.createElement("a"); link.href = url; link.download = "release-migration-fixture.json"; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const evidenceCount = state.revisionResolved ? 6 : 4
  const openEvidence = () => update({ inspector: "evidence", selectedId: "approval", panelOpen: true })
  const workflow = <div ref={body} className={styles.body} data-workflow-review>
    <h1 className="sr-only">{copy(workflowTitle)}</h1>
    {!state.expanded && <section className={styles.thread} style={{ width: state.panelOpen ? state.threadWidth || "28%" : "100%" }} aria-label={label("工作流对话", "Workflow thread")}>
      <div className={styles.threadHeader}><span>{label("工作流对话", "Workflow thread")}</span><Button size="icon" variant="ghost" aria-label={state.panelOpen ? label("关闭工作流", "Close workflow") : label("打开工作流", "Open workflow")} aria-pressed={state.panelOpen} onClick={() => update({ panelOpen: !state.panelOpen })}><PanelRightClose /></Button></div>
      <div className={styles.history} role="region" aria-label={label("对话消息", "Conversation messages")} ref={history} onScroll={event => update({ readingPosition: event.currentTarget.scrollTop })}>
        <div role="log">
          {state.messages.map(message => <ChatMessage key={message.id} id={message.id} role={message.role === "assistant" ? "agent" : "user"} author={message.role === "assistant" ? label("EasyuseUI AI · 工作流 Agent", "EasyuseUI AI · Workflow agent") : undefined} content={copy(message.text)}>
            {message.id === "summary" && <div className={styles.summary}>
              <header><Workflow size={18} /><div><strong>{label("发布迁移 · 运行审阅", "Release migration · run review")}</strong><small>{label("交互式工作流工作区", "Interactive workflow workspace")}</small></div><span>{label("已审阅", "Reviewed")}</span></header>
              <div className={styles.summaryContent}><div><GitBranch size={15} /><span>{label("已审阅交接", "Reviewed handoffs")}</span><span className={styles.revised}>{state.revisionCount} {label("次返工", "revision")}</span></div><div className={styles.metrics}>{[["5",label("Agents", "Agents")],[String(state.revisionCount),label("返工", "Revisions")],["3m 39s",label("总耗时", "Total time")]].map(([value,name]) => <div key={name}><strong>{value}</strong><small>{name}</small></div>)}</div></div>
              <footer><span>{label("工作区就绪", "Workspace ready")}</span><Button variant="outline" size="sm" onClick={() => update({ panelOpen: true })}><Workflow size={14} />{label("打开工作流", "Open workflow")}</Button></footer>
            </div>}
          </ChatMessage>)}
          {!state.messages.length && <p className={styles.emptyText}>{label("尚无运行审阅。载入本地示例或添加一条审阅笔记。", "No run review yet. Load a local sample or add a review note.")}</p>}
        </div>
      </div>
      <Button variant="ghost" size="icon" className={styles.latest} aria-label={label("滚动到最新消息", "Scroll to latest message")} onClick={() => history.current?.scrollTo({ top: history.current.scrollHeight })}><ArrowDown /></Button>
      <div className={styles.composer}><ComposerInput controller={controller} helpId="workflow-3-help" options={{ hideSuggestion: true, showBlocksControl: false, leadingAction: <Button variant="ghost" size="icon" aria-label={label("添加工作流上下文", "Add workflow context")} aria-pressed={!!state.draft.contextIds.length} disabled={readonly} onClick={() => controller.toggleContext("run")}><Plus /></Button>, tools: <Button variant="ghost" size="sm" onClick={() => update({ panelOpen: true })}><GitBranch size={14} />{label("画布", "Canvas")}</Button>, placeholder: text("询问工作流更改…", "Ask for a workflow change…"), inputLabel: text("消息", "Message"), formLabel: text("继续工作流审阅", "Continue workflow review"), helpText: text("本地示例 · Enter 添加审阅笔记", "Local fixture · Enter adds a review note") }} /></div>
    </section>}
    {state.panelOpen && <>
      {!state.expanded && <ResizableHandle value={state.threadWidth || 400} min={280} max={640} step={8} label={label("调整工作流工作区", "Resize workflow workspace")} className={styles.resize} onValueChange={threadWidth => update({ threadWidth })} />}
      <section className={styles.workspace} aria-label={label("多 Agent 发布审阅", "Multi-agent release review")}>
        <header className={styles.workflowHeader}><span className={styles.workspaceIcon}><Workflow size={18} /></span><div className={styles.workspaceTitle}><strong>{label("多 Agent 发布审阅", "Multi-agent release review")}</strong><small>{label("运行审阅 · 计划和实际交接", "Run review · planned and observed handoffs")}</small></div>
          <span className={styles.complete} data-outcome={state.approval}>{state.readState === "empty" ? label("未载入运行", "No run loaded") : state.readState === "loading" ? label("正在读取", "Reading record") : state.approval === "approved" ? label("证据完整", "Evidence complete") : state.approval === "unknown" ? label("结果未知", "Outcome unknown") : label("等待审阅", "Review pending")}</span>
          <Button variant="outline" size="sm" disabled={state.readState === "loading" || state.readState === "empty" || state.approval === "unknown"} onClick={() => setState(replayReview)}><Play size={14} />{label("回放运行", "Replay run")}</Button>
          <Button variant="ghost" size="icon" aria-label={state.expanded ? label("还原工作流工作区", "Restore workflow workspace") : label("展开工作流工作区", "Expand workflow workspace")} onClick={() => update({ expanded: !state.expanded })}>{state.expanded ? <Minimize2 /> : <Maximize2 />}</Button>
          <Button variant="ghost" size="icon" aria-label={label("关闭工作流工作区", "Close workflow workspace")} onClick={closePanel}><X /></Button>
        </header>
        <div className={styles.stages} aria-label={label("运行阶段", "Run stages")}>{stages.map((stage,index) => <div key={stage.en} data-done={index < state.stage || state.approval === "approved"} data-current={state.stage === index && state.approval !== "approved"}><span>{index === 3 ? <RotateCcw size={14} /> : <CheckCircle2 size={14} />}</span>{stage[locale]}{index < 5 && <ChevronRight size={12} />}</div>)}</div>
        {state.readonly && <div className={styles.notice}>{label("只读：可检查和回放，不能修改审阅记录或审批。", "Read only: inspect and replay; review records and approvals cannot be changed.")}</div>}
        {state.readState === "error" && <div className={styles.notice} role="alert">{label("刷新失败；保留上一次运行和所有草稿。", "Refresh failed; the previous run and all drafts are retained.")}<Button variant="outline" size="sm" onClick={() => update({ readState: "ready" })}>{label("重试读取", "Retry read")}</Button></div>}
        {(state.replaying || state.stage < 5) && <div className={styles.notice} role="status"><span>{label("本地路径回放", "Local route replay")} · {stages[state.stage][locale]}</span>{state.replaying && state.stage < 3 && <Button variant="outline" size="sm" onClick={() => update({ paused: !state.paused })}>{state.paused ? <Play size={13} /> : <Pause size={13} />}{state.paused ? label("继续", "Resume") : label("暂停", "Pause")}</Button>}{state.stage < 3 && <Button variant="outline" size="sm" onClick={() => setState(advanceReview)}>{label("下一步", "Next step")}</Button>}</div>}
        <div className={styles.canvasRow}>
          <div className={styles.canvas}>
            {state.readState === "loading" || state.readState === "empty" ? <div className={styles.dataState} role="status"><Workflow size={32} /><h2>{state.readState === "loading" ? label("正在读取运行记录", "Reading run record") : label("暂无工作流", "No workflow yet")}</h2><p>{label("此页面使用本地 fixture，不连接真实 Agent。", "This page uses local fixtures, not real agents.")}</p><Button onClick={() => setState(loadReviewFixture)}>{label("载入示例运行", "Load sample run")}</Button></div> : <ReactFlowProvider><ReactFlow<AgentFlowNode> nodes={nodes} onNodesChange={measureNodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} nodesDraggable={false} nodesConnectable={false} edgesReconnectable={false} deleteKeyCode={null} selectionKeyCode={null} multiSelectionKeyCode={null} panActivationKeyCode={null} zoomActivationKeyCode={null} nodesFocusable={active} edgesFocusable={active} minZoom={.25} maxZoom={1.5} fitViewOptions={{ padding: .06, minZoom: .35, maxZoom: .65 }} defaultViewport={state.viewport} onMoveEnd={(_,viewport: Viewport) => { if (active && viewportReady.current && body.current?.clientWidth && body.current.clientHeight) update({ viewport }) }} onNodeClick={(_,node) => { update({ selectedId: node.id as ReviewNode["id"], inspector: "node", inspectorPosition: 0 }) }} onPaneClick={() => { if(state.selectedId) closeInspector() }} proOptions={{ hideAttribution: true }} aria-label={label("多 Agent 发布审阅", "Multi-agent release review")}><><InitialReviewViewport active={active} ready={viewportReady} onReady={recordViewport} focusNode={focusNode} scopeRef={body} onFocused={finishNodeFocus} /><FlowControls /></><Panel position="bottom-right" className={styles.legend}>{["running","completed","waiting","failed"].map(status => <RuntimeStatusBadge status={status} key={status} />)}</Panel></ReactFlow></ReactFlowProvider>}
          </div>
          {selected && <aside className={styles.inspector} aria-label={state.inspector === "evidence" ? label("运行证据", "Run evidence") : copy(selected.title)}>
            <header><span className={styles.nodeIcon}>{(() => { const Icon = icons[selected.id]; return <Icon size={18} /> })()}</span><div><small>{copy(selected.kind)}</small><h2>{state.inspector === "evidence" ? label("运行证据", "Run evidence") : copy(selected.title)}</h2></div><Button variant="ghost" size="icon" aria-label={label("关闭检查器", "Close inspector")} onClick={closeInspector}><X /></Button></header>
            <div className={styles.inspectorScroll} ref={inspector} onScroll={event => update({ inspectorPosition: event.currentTarget.scrollTop })}>
              {state.replaying && <p className={styles.notice}>{label("历史审计保留", "Historical audit retained")}: {state.historicalAudit.approval} · {state.historicalAudit.revisionCount} {label("次返工", "revision")}</p>}
              {state.inspector === "evidence" ? <><p className={styles.notice}>{label("历史示例证据，不是本仓库验证结果。", "Historical fixture evidence, not verification results for this repository.")}</p>{reviewNodes.filter(node => node.id !== "published").map(node => <section key={node.id}><h3>{copy(node.kind)}</h3><p>{copy(node.evidence)}</p><Button variant="outline" size="sm" onClick={() => update({ selectedId: node.id, inspector: "node" })}>{label("检查交接", "Inspect handoff")}</Button></section>)}<Button variant="outline" onClick={downloadEvidence}>{label("导出示例证据", "Export fixture evidence")}</Button></> : <>
                <section><div className={styles.statusRow}><h3>{label("状态", "Status")}</h3><ReviewNodeStatus state={state} id={selected.id} /></div><p>{copy(selected.description)}</p></section>
                <section className={styles.detailsMetrics}><div><h3>{label("进度", "Progress")}</h3><strong>{nodeStatus(state, selected.id) === "completed" ? "100%" : "—"}</strong></div><div><h3>{label("耗时", "Duration")}</h3><strong>{selected.duration}</strong></div></section>
                {(selected.tool || selected.file) && <section><h3>{label("执行上下文", "Execution context")}</h3><div className={styles.contextTable}>{selected.tool && <div><Terminal size={14} /><span>{label("工具", "Tool")}</span><code>{selected.tool}</code></div>}{selected.file && <div><FileText size={14} /><span>{label("文件", "File")}</span><code>{selected.file}</code></div>}</div></section>}
                <section><h3>{label("任务", "Tasks")}</h3><div className={styles.taskList}>{selected.tasks.map(task => <div key={task.en}><CheckCircle2 size={14} /><span>{copy(task)}</span><RuntimeStatusBadge status={nodeStatus(state,selected.id)} /></div>)}</div></section>
                <section><h3>{label("职责", "Ownership")}</h3><div className={styles.owner}><UserRound size={18} /><div><strong>{state.owners[selected.id] ?? selected.owner}</strong><small>{label("负责此步骤", "Responsible for this step")}</small></div><DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label={label("更多职责操作", "More ownership actions")} disabled={readonly} />}><MoreHorizontal /></DropdownMenuTrigger><DropdownMenuContent>{["Planner","Researcher","Implementer","Tester","Reviewer","Rakesh"].map(owner => <DropdownMenuItem key={owner} onClick={() => update({ owners: { ...state.owners, [selected.id]: owner } })}>{owner}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu></div></section>
                <section><h3>{label("依赖与交接", "Dependencies and handoffs")}</h3>{handoffs.filter(edge => edge.source === selected.id || edge.target === selected.id).map(edge => <Button key={`${edge.source}-${edge.target}`} variant="ghost" className={styles.handoff} onClick={() => update({ selectedId: edge.source === selected.id ? edge.target : edge.source })}>{edge.revision ? <RotateCcw size={14} /> : <GitBranch size={14} />}<span>{edge.source} → {edge.target}</span></Button>)}</section>
                <section><h3>{label("审阅证据", "Review evidence")}</h3><p>{copy(selected.evidence)}</p>{state.revisionNotes.map((note,index) => <p key={index} className={styles.reviewNote}>{note}</p>)}</section>
                {selected.id === "implementer" && state.stage === 3 && <section><h3>{label("返工检查点", "Revision checkpoint")}</h3><p>{label("补齐未知结果语义，然后将修订证据交回审阅和审批。", "Correct unknown-outcome semantics, then return revised evidence to review and approval.")}</p><Button disabled={readonly} onClick={() => setState(resolveRevision)}>{label("记录示例修订并复查", "Record fixture revision and recheck")}</Button></section>}
                {selected.id === "approval" && <section><h3>{label("审批检查点", "Approval checkpoint")}</h3><p>{state.approval === "unknown" ? label("结果未知：先读取历史记录确认，不重复发布。", "Outcome unknown: reconcile the historical record first; do not repeat a release.") : label("只有返工已解决且验证与审阅证据齐全时可批准本地示例。", "Approve this local fixture only after revision is resolved and verification and review evidence are complete.")}</p><Button variant="outline" onClick={openEvidence}>{label("检查全部证据", "Inspect all evidence")}</Button>{state.approval === "unknown" ? <Button disabled={readonly} onClick={() => setState(reconcileReview)}>{label("读取示例历史确认结果", "Reconcile fixture history")}</Button> : state.approval !== "approved" && <Button disabled={readonly || !state.revisionResolved || state.stage !== 4} onClick={() => setState(approveReview)}>{label("批准本地示例", "Approve local fixture")}</Button>}</section>}
                {(selected.id === "reviewer" || selected.id === "implementer") && <section><h3>{label("请求返工", "Request revision")}</h3><Textarea aria-label={label("返工理由", "Revision reason")} placeholder={label("描述需要更改的范围…", "Describe the scope to revise…")} value={state.revisionDraft} disabled={readonly || state.approval === "unknown"} onChange={event => update({ revisionDraft: event.target.value })} /><Button variant="outline" disabled={readonly || !state.revisionDraft.trim() || state.approval === "unknown"} onClick={() => setState(requestRevision)}>{label("交回实现 Agent", "Return to implementer")}</Button></section>}
              </>}
            </div>
          </aside>}
        </div>
        <footer className={styles.evidenceFooter}><Button variant="ghost" size="sm" onClick={openEvidence} disabled={state.readState === "empty" || state.readState === "loading"}><ShieldCheck size={14} />{label("运行证据", "Run evidence")}</Button>{state.readState !== "empty" && state.readState !== "loading" ? <><span>5 {label("Agents", "agents")}</span><span>{state.revisionCount} {label("次返工", "revision")}</span><span>{evidenceCount} {label("项证据", "evidence items")}</span><span className={styles.approved} data-outcome={state.approval}><ShieldCheck size={14} />{state.approval === "approved" ? label("人工已批准", "Human approved") : label("待人工审阅", "Awaiting review")}</span></> : <span>{label("尚未载入运行证据", "Run evidence is not loaded yet")}</span>}</footer>
      </section>
    </>}
  </div>
  return <div className={styles.root} data-workflow-scenario={scenario} onKeyDown={event => {
    if ((event.key !== "Enter" && event.key !== " ") || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return
    const node = (event.target as HTMLElement).closest<HTMLElement>(".react-flow__node")
    if (!node || !reviewNodes.some(record => record.id === node.dataset.id)) return
    event.preventDefault()
    update({ selectedId: node.dataset.id as ReviewNode["id"], inspector: "node", inspectorPosition: 0 })
  }}>
    <ComposerWorkspaceView controller={controller} host={host} presentation={{ id: "workflow-3", title: workflowTitle, welcome: { title: workflowTitle, description: text("多 Agent 分工、返工与汇合审阅", "Parallel ownership, revisions, and converged review") }, headerActions: <Button variant="ghost" size="sm" disabled={state.readState === "empty" || state.readState === "loading"} onClick={() => setShareOpen(true)}><Share2 size={14} />{label("分享", "Share")}</Button>, renderBody: () => workflow }} />
    <Dialog open={shareOpen && active} onOpenChange={setShareOpen}><DialogContent><DialogTitle>{label("分享本地运行审阅", "Share local run review")}</DialogTitle><DialogDescription>{label("导出仅包含本地 fixture 的职责、返工与证据；不会创建公开链接或执行发布。", "Export contains local fixture ownership, revisions, and evidence. It does not create a public link or execute a release.")}</DialogDescription><Input readOnly value="release-migration-003 · local fixture" aria-label={label("运行标识", "Run identity")} /><Button onClick={downloadEvidence}>{label("下载证据 JSON", "Download evidence JSON")}</Button></DialogContent></Dialog>
  </div>
}
