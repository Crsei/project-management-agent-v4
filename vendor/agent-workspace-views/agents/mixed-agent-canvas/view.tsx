"use client"

import { useCallback, useEffect, useRef, type ReactNode } from "react"
import { Download, FileText, GripVertical, History, Monitor, Moon, MoreHorizontal, Pause, Play, Plus, Redo2, RotateCcw, Save, Sun, Trash2, Undo2 } from "lucide-react"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { Input } from "@easyuse-ui/ui/components/ui/input"
import { Textarea } from "@easyuse-ui/ui/components/ui/textarea"
import { Checkbox } from "@easyuse-ui/ui/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@easyuse-ui/ui/components/ui/dialog"
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@easyuse-ui/ui/components/ui/sheet"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@easyuse-ui/ui/components/ui/dropdown-menu"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@easyuse-ui/ui/components/ui/select"
import { RuntimeStatusBadge } from "@easyuse-ui/ui/components/ui/runtime-status-badge"
import { WorkflowCanvas } from "@easyuse-ui/ui/components/blocks/workflow-canvas"
import { CodePreview } from "@easyuse-ui/ui/components/blocks/code-preview"
import { useI18n } from "@easyuse-ui/ui/lib/i18n-provider"
import { redactText } from "@easyuse-ui/ui/lib/redact"
import type { Copy } from "../../model"
import { remainingPageScenarios, type RemainingPageProps } from "../../showcase/model"
import { useRemainingPageState } from "../../showcase/state"
import { TerminalTaskNode } from "../canvas-workbench/terminal"
import { definitions, logs, roleNames, type Role } from "./fixtures"
import { addTask, advancePlayback, changeDependency, collectOutputs, createMixedCanvasState, executeCanvasCommand, isLocked, redoEdit, sendFollowup, startPlayback, teamStatus, undoEdit, updateBrief, updateTask, type MixedCanvasState } from "./controller"
import styles from "./view.module.css"

export const pageScenarios = [...remainingPageScenarios,
  { id: "running", name: { "zh-CN": "运行中的脚本", en: "Scripted playback" } },
  { id: "unknown-outcome", name: { "zh-CN": "结果未知", en: "Unknown outcome" } },
] as const

type NewTask = { title: string; assignment: string; role: Role; dependencies: string[] }
export function RemainingPageView({ scenario, active, host }: RemainingPageProps) {
  const { locale } = useI18n()
  const [state, setState] = useRemainingPageState<MixedCanvasState>(`mixed-agent-canvas:${scenario}`, () => createMixedCanvasState(scenario))
  const [newTask, setNewTask] = useRemainingPageState<NewTask>(`mixed-agent-canvas:${scenario}:task-draft`, () => ({ title: "", assignment: "", role: "research", dependencies: [] }))
  const [addOpen, setAddOpen] = useRemainingPageState(`mixed-agent-canvas:${scenario}:add-open`, () => false)
  const [confirm, setConfirm] = useRemainingPageState<"reset" | "remove" | null>(`mixed-agent-canvas:${scenario}:confirm`, () => null)
  const [previewCode, setPreviewCode] = useRemainingPageState(`mixed-agent-canvas:${scenario}:preview-code`, () => false)
  const root = useRef<HTMLDivElement>(null)
  const l = (zh: string, en: string) => locale === "en" ? en : zh
  const text = (value: string | Copy | undefined) => typeof value === "string" ? value : value?.[locale] ?? ""
  const locked = isLocked(state)
  const selectedTask = state.selectedTask ? state.tasks[state.selectedTask] : undefined
  const selectedPlayback = selectedTask ? state.playback[selectedTask.id] : undefined
  const visibleOutputs = collectOutputs(state)
  const openTask = useCallback((id: string) => setState(previous => ({ ...previous, panel: "task", selectedTask: id, selection: { nodeIds: [id], edgeIds: [] }, error: null })), [setState])
  useEffect(() => {
    if (!active || !state.playing) return
    const timer = window.setInterval(() => setState(advancePlayback), 900)
    return () => window.clearInterval(timer)
  }, [active, state.playing, setState])
  useEffect(() => {
    if (!active) return
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || event.target instanceof HTMLElement && event.target.closest("input,textarea,select,[contenteditable=true],[role=dialog],[role=menu]")) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault(); setState(event.shiftKey ? redoEdit : undoEdit)
      }
      if ((event.key === "Delete" || event.key === "Backspace") && !locked && state.selection.nodeIds.length) {
        event.preventDefault(); setState(previous => ({ ...previous, selectedTask: previous.selection.nodeIds[0] })); setConfirm("remove")
      }
    }
    window.addEventListener("keydown", keydown)
    return () => window.removeEventListener("keydown", keydown)
  }, [active, locked, state.selection.nodeIds, setState, setConfirm])
  function download(name: string, content: string) {
    const url = URL.createObjectURL(new Blob([redactText(content)], { type: "text/markdown;charset=utf-8" }))
    const anchor = document.createElement("a")
    anchor.href = url; anchor.download = name; anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  function exportOutputs() {
    download("mixed-agent-outputs.md", "# " + l("混合 Agent 产物", "Mixed agent outputs") + "\n\n" + l("本地编写的样例；未执行命令或模型调用。", "Authored local examples; no commands or model calls were executed.") + "\n\n" + visibleOutputs.map(result => "## " + text(result.title) + "\n\n" + text(result.output)).join("\n\n"))
  }
  const replay = () => setState(startPlayback)
  const panelTitle = state.panel === "brief" ? l("共享任务说明", "Shared brief") : state.panel === "history" ? l("运行历史", "Run history") : text(selectedTask?.title)
  const roleSelect = (value: Role, onChange: (value: Role) => void, id: string): ReactNode => <Select value={value} onValueChange={next => { if (next === "research" || next === "design" || next === "review") onChange(next) }} disabled={locked}><SelectTrigger id={id} aria-label={l("Agent 角色", "Agent role")} className={styles.select}><SelectValue>{text(roleNames[value])}</SelectValue></SelectTrigger><SelectContent>{Object.entries(roleNames).map(([id, name]) => <SelectItem value={id} key={id}>{text(name)}</SelectItem>)}</SelectContent></Select>
  return <div ref={root} className={styles.page} data-page-id="mixed-agent-canvas">
    <header className={styles.header}>
      <div className={styles.heading}><h1>{l("混合 Agent 画布", "Mixed agent canvas")}</h1><p>{l("用量与账单", "Usage & billing")} · {state.document.nodes.length} {l("终端", "terminals")}</p></div>
      <Button variant="ghost" onClick={() => setState(previous => ({ ...previous, panel: "brief" }))}><FileText size={16} />{l("共享任务说明", "Shared brief")}</Button>
      <div className={styles.actionGroup}>
        <Button variant="ghost" size="icon" aria-label={l("保存布局", "Save layout")} disabled={locked} onClick={() => setState(previous => ({ ...previous, saved: { document: previous.document, tasks: previous.tasks, brief: previous.brief }, notice: { "zh-CN": "布局已保存到本次会话内存。刷新后不会保留。", en: "Layout saved in this session’s memory. It will not survive a reload." } }))}><Save size={16} /></Button>
        <Button variant="ghost" size="icon" aria-label={l("撤销编辑", "Undo edit")} disabled={locked || !state.undo.length} onClick={() => setState(undoEdit)}><Undo2 size={16} /></Button>
        <Button variant="ghost" size="icon" aria-label={l("重做编辑", "Redo edit")} disabled={locked || !state.redo.length} onClick={() => setState(redoEdit)}><Redo2 size={16} /></Button>
        <Button variant="ghost" size="icon" aria-label={l("运行历史", "Run history")} onClick={() => setState(previous => ({ ...previous, panel: "history" }))}><History size={16} /></Button>
        <Button variant="ghost" size="icon" aria-label={l("导出产物", "Export outputs")} disabled={!visibleOutputs.length} onClick={exportOutputs}><Download size={16} /></Button>
        <Button variant="ghost" size="icon" aria-label={l("重置示例", "Reset example")} disabled={locked} onClick={() => setConfirm("reset")}><RotateCcw size={16} /></Button>
      </div>
      <Button variant="outline" disabled={locked} onClick={() => setAddOpen(true)}><Plus size={16} />{l("添加任务", "Add task")}</Button>
      <Button disabled={locked || !state.document.nodes.length} onClick={() => state.playing ? setState(previous => ({ ...previous, playing: false })) : teamStatus(state) === "paused" ? setState(previous => ({ ...previous, playing: true })) : replay()}>{state.playing ? <Pause size={16} /> : <Play size={16} />}{state.playing ? l("暂停脚本", "Pause playback") : teamStatus(state) === "paused" ? l("继续播放", "Resume playback") : l("重播团队", "Replay team")}</Button>
      <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label={l("画布操作", "Canvas actions")} />}><MoreHorizontal size={16} /></DropdownMenuTrigger><DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => setState(previous => ({ ...previous, panel: "brief" }))}>{l("共享说明与场景", "Shared brief & scenario")}</DropdownMenuItem>
        <DropdownMenuItem disabled={locked} onClick={() => setAddOpen(true)}>{l("添加任务", "Add task")}</DropdownMenuItem>
        <DropdownMenuItem disabled={locked || !state.undo.length} onClick={() => setState(undoEdit)}>{l("撤销编辑", "Undo edit")}</DropdownMenuItem>
        <DropdownMenuItem disabled={!visibleOutputs.length} onClick={exportOutputs}>{l("导出团队产物", "Export team outputs")}</DropdownMenuItem>
        <DropdownMenuItem disabled={!state.saved || locked} onClick={() => setState(previous => previous.saved ? { ...previous, ...previous.saved, playing: false } : previous)}>{l("恢复保存的布局", "Restore saved layout")}</DropdownMenuItem>
        <DropdownMenuItem disabled={locked} onClick={replay}>{l("重新加载播放", "Reload playback")}</DropdownMenuItem>
      </DropdownMenuContent></DropdownMenu>
      <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label={l("切换主题", "Toggle theme")} />}><Monitor size={16} /></DropdownMenuTrigger><DropdownMenuContent align="end">{(["light", "dark", "system"] as const).map(theme => <DropdownMenuItem key={theme} onClick={() => host.setTheme(theme)}>{theme === "light" ? <Sun size={16} /> : theme === "dark" ? <Moon size={16} /> : <Monitor size={16} />}{theme === "light" ? l("浅色", "Light") : theme === "dark" ? l("深色", "Dark") : l("系统", "System")}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu>
    </header>
    {state.error && <div className={styles.alert} role="alert">{text(state.error)}{scenario === "refresh-error" && <Button variant="ghost" size="sm" onClick={() => setState(previous => ({ ...previous, error: null, notice: { "zh-CN": "已重新读取本地固定数据。没有请求外部服务。", en: "Local fixtures reloaded. No external service was requested." } }))}>{l("重试读取", "Retry refresh")}</Button>}</div>}
    <div className={styles.canvasRegion}>
      {!state.dataReady ? <div className={styles.empty} aria-busy="true"><h2>{l("正在等待本地任务快照", "Waiting for local task snapshot")}</h2><p>{l("加载场景不会自动声称数据已就绪。", "This loading scenario does not imply that a service has responded.")}</p><Button onClick={() => setState(previous => ({ ...previous, dataReady: true }))}>{l("载入样例快照", "Load fixture snapshot")}</Button></div> : !state.document.nodes.length ? <div className={styles.empty}><h2>{l("暂无 Agent 任务", "No agent tasks yet")}</h2><p>{l("添加任务并选择交付物依赖，在画布中组织团队。", "Add a focused task and choose its deliverable dependencies to organize the team.")}</p><Button onClick={() => setAddOpen(true)}><Plus size={16} />{l("添加任务", "Add task")}</Button></div> : <WorkflowCanvas document={state.document} definitions={definitions} selection={state.selection} readOnly={locked} showBackground={false} showMiniMap={false} defaultInteractionMode="select" controlsVariant="minimal-horizontal" nodeDragHandle=".terminal-task-drag" className={styles.canvas} viewport={state.document.viewport} onViewportChange={viewport => setState(previous => ({ ...previous, document: { ...previous.document, viewport } }))} onSelectionChange={selection => setState(previous => ({ ...previous, selection }))} onCommand={command => setState(previous => executeCanvasCommand(previous, command))} onOpenNode={openTask} renderNode={({ node, selected }) => {
        const task = state.tasks[node.id]
        if (!task) return null
        const playback = state.playback[node.id]
        const entries = (logs[node.id] ?? []).slice(0, playback?.visible ?? 0).map(entry => ({ id: entry.id, kind: entry.kind === "text" ? "text" as const : "command" as const, text: text(entry.text), output: entry.output ? text(entry.output) : undefined }))
        if (task.version !== 0) entries.push({ id: node.id + "-unavailable", kind: "text", text: l("此指派没有编写的播放内容。等待真实执行能力；不会伪造任务完成。", "No authored playback is available for this assignment. A real execution capability is required; completion is not fabricated."), output: undefined })
        if (scenario === "long-content") entries.push(...entries.map(entry => ({ ...entry, id: entry.id + "-long" })))
        for (const message of playback?.followups ?? []) entries.push({ id: message.id, kind: "text", text: "> " + message.text + "\n\n" + text(message.response), output: undefined })
        const stale = playback?.version !== task.version
        return <TerminalTaskNode
          id={node.id} title={text(task.title)} roleLabel={text(roleNames[task.role])}
          titleBarLabel={task.agent + " · " + (locale === "en" ? task.role : text(roleNames[task.role])) + " — " + text(task.title)}
          agentName={task.agent === "Codex" ? "OpenAI Codex" : task.agent === "Grok" ? "Grok Build" : "Claude Code"}
          version={task.agent === "Grok" ? "0.2.93" : task.agent === "Codex" ? "v0.153.4" : "v2.1.206"}
          model={task.agent === "Codex" ? "gpt-5.6-sol high" : task.agent === "Grok" ? "Grok · review" : "Research · plan mode"}
          introContent={task.agent === "Codex" ? undefined : <div className={styles.agentIntro} data-agent={task.agent}><div className={styles.agentBrand}>{task.agent === "Grok" ? "Grok Build 0.2.93" : "Claude Code v2.1.206"}</div><p>{task.agent === "Grok" ? "shadcnblocks-admin" : l("研究 · 计划模式", "Research · plan mode")}</p>{task.agent !== "Grok" && <small>shadcnblocks-admin</small>}</div>}
          footerLabel={task.agent === "Codex" ? undefined : task.agent === "Grok" ? "Grok · review" : <span className={styles.planMode}><Pause size={12} />{l("计划模式开启", "plan mode on")}</span>}
          directory="shadcnblocks-admin" width={node.id === "design" ? 600 : 500} height={node.id === "design" ? 1010 : 480}
          inputSide={node.id === "research" || node.id === "design" ? "right" : "left"} outputSide={node.id === "research" ? "left" : "right"}
          inputOffset={node.id === "design" ? 24 : 50} outputOffset={node.id === "design" ? 76 : 50}
          assignment={text(task.assignment)} events={entries} deliverable={!stale ? text(playback?.output) : ""} showDeliverableInline={false} draftDisabled={locked}
          status={stale ? "waiting" : playback?.status ?? "idle"} selected={selected} draft={state.drafts[node.id] ?? ""}
          onDraftChange={draft => { if (!locked) setState(previous => ({ ...previous, drafts: { ...previous.drafts, [node.id]: draft } })) }}
          onSend={() => setState(previous => sendFollowup(previous, node.id))} onOpen={() => openTask(node.id)} onOutput={() => openTask(node.id)}
          readOnly={locked} sendDisabled={state.playing} scrollTop={state.scroll[node.id]}
          onScroll={top => setState(previous => ({ ...previous, scroll: { ...previous.scroll, [node.id]: top } }))}
        />
      }} />}
      {!!state.document.nodes.length && state.dataReady && <div className={styles.hint}><GripVertical size={14} /><span>{l("拖动标题栏移动", "Drag the title bar to move")}</span><span>{l("拖动 OUT → IN 连接", "Drag OUT → IN to connect")}</span></div>}
    </div>
    <footer className={styles.footer}><Button variant="ghost" size="sm" onClick={() => setState(previous => ({ ...previous, panel: "brief" }))}>{l("脚本示例", "Scripted demo")}</Button><span>· {l("模拟活动 · 无模型调用", "Mock activity · No model calls")}</span><span className={styles.footerStatus} role="status">{state.notice ? text(state.notice) : locked ? l("只读快照", "Read-only snapshot") : <RuntimeStatusBadge status={teamStatus(state)} />}</span></footer>
    <Sheet open={state.panel !== null && !(state.panel === "task" && !selectedTask)} onOpenChange={open => { if (!open) { setState(previous => ({ ...previous, panel: null })); setPreviewCode(false) } }}><SheetContent size={state.panel === "brief" ? 448 : 576} className={styles.sheet}><SheetHeader><SheetTitle>{panelTitle}</SheetTitle><SheetDescription>{state.panel === "history" ? l("本次会话中的最近脚本运行，仅保存在内存中。", "Recent scripted runs for this session, saved in memory only.") : state.panel === "brief" ? l("Claude 研究账单仪表盘，Codex 构建，Grok 审查交接。", "Claude researches a billing dashboard, Codex builds it, and Grok reviews the handoff.") : l("为此 Agent 指定专注任务并选择输入。", "Give this agent a focused assignment and choose its inputs.")}</SheetDescription></SheetHeader><SheetBody>{state.error && <div className={styles.alert} role="alert">{text(state.error)}</div>}{state.panel === "brief" && <div className={styles.form}><label htmlFor="mixed-shared-brief">{l("团队应该完成什么？", "What should the team accomplish?")}</label><Textarea id="mixed-shared-brief" value={text(state.brief)} readOnly={locked} onChange={event => setState(previous => updateBrief(previous, event.target.value))} rows={7} /><section className={styles.playbackNote}><h3>{l("脚本展示", "Scripted showcase")}</h3><p>shadcnblocks-admin</p><p>{l("此展示使用编写的对话、命令输出与审查结果。播放完全在浏览器中运行。不会使用账户、仓库连接或模型请求。编辑指派不会生成新产物。", "This showcase uses authored dialogue, command output, and review results. Playback runs entirely in your browser. No account, repository connection, or model request is used. Editing assignments does not generate new outputs.")}</p><Button variant="outline" disabled={locked} onClick={replay}><RotateCcw size={16} />{l("重新加载播放", "Reload playback")}</Button></section></div>}
{state.panel === "history" && <div className={styles.history}>{[{ id: `demo-${state.run}`, status: teamStatus(state), outputs: visibleOutputs }, ...state.runs].map(run => <details open={run.id === `demo-${state.run}`} key={run.id}><summary>{run.id} · <RuntimeStatusBadge status={run.status} /></summary>{run.outputs.length ? run.outputs.map(output => <section key={output.id}><h3>{text(output.title)}</h3><p>{text(output.output)}</p></section>) : <p>{l("尚无此运行的已确认样例产物。", "No confirmed authored outputs for this run yet.")}</p>}</details>)}</div>}
{state.panel === "task" && selectedTask && <div className={styles.form}><label htmlFor="mixed-task-title">{l("任务标题", "Task title")}</label><Input id="mixed-task-title" value={text(selectedTask.title)} readOnly={locked} onChange={event => setState(previous => updateTask(previous, selectedTask.id, { title: event.target.value }))} /><label htmlFor="mixed-task-role">{l("角色", "Role")} · {selectedTask.agent}</label>{roleSelect(selectedTask.role, role => setState(previous => updateTask(previous, selectedTask.id, { role })), "mixed-task-role")}<label htmlFor="mixed-task-assignment">{l("指派", "Assignment")}</label><Textarea id="mixed-task-assignment" rows={5} value={text(selectedTask.assignment)} readOnly={locked} onChange={event => setState(previous => updateTask(previous, selectedTask.id, { assignment: event.target.value }))} /><fieldset><legend>{l("等待这些交付物", "Wait for these deliverables")}</legend>{state.document.nodes.filter(node => node.id !== selectedTask.id).map(node => <label className={styles.check} key={node.id}><Checkbox disabled={locked} checked={state.document.edges.some(edge => edge.source === node.id && edge.target === selectedTask.id)} onCheckedChange={checked => setState(previous => changeDependency(previous, node.id, selectedTask.id, checked))} />{text(state.tasks[node.id]?.title)}</label>)}</fieldset>
  <section className={styles.deliverable}><div className={styles.deliverableTitle}><h3>{l("交付物", "Deliverable")}</h3><RuntimeStatusBadge status={selectedPlayback?.version !== selectedTask.version ? "waiting" : selectedPlayback?.status ?? "idle"} /></div><small>{l("会话", "Session")} demo-{selectedTask.id} · {l("编写的样例", "Authored fixture")}</small>{selectedPlayback?.version !== selectedTask.version && <p role="status">{l("此输出属于之前的指派。新指派没有编写的执行结果。", "This output belongs to the previous assignment. No execution result is authored for the new assignment.")}</p>}<p>{text(selectedPlayback?.output) || l("暂无已确认输出。", "No confirmed output yet.")}</p><div className={styles.outputActions}><Button variant="outline" disabled={!selectedPlayback?.output || selectedPlayback.version !== selectedTask.version} onClick={() => download(selectedTask.id + "-output.md", text(selectedPlayback?.output))}><Download size={16} />{l("下载产物", "Download output")}</Button>{selectedTask.id === "design" && <Button variant="ghost" onClick={() => setPreviewCode(previous => !previous)}>{previewCode ? l("隐藏代码", "Hide code") : l("检查代码样例", "Inspect code sample")}</Button>}</div>{previewCode && selectedTask.id === "design" && <div className={styles.code}><CodePreview identity="mixed-agent-usage-overview" revision="authored-1" language="tsx" path="src/features/billing/usage-overview.tsx" code={'<UsageSummary period={period} />\n<InvoiceEstimate label="Estimated next invoice" />\n<OverageNotice usage={usage} limit={plan.limit} />'} /></div>}</section><Button variant="ghost" disabled={locked} onClick={() => setConfirm("remove")}><Trash2 size={16} />{l("移除任务", "Remove task")}</Button></div>}</SheetBody></SheetContent></Sheet>
    <Dialog open={addOpen} onOpenChange={setAddOpen}><DialogContent><DialogTitle>{l("新任务", "New task")}</DialogTitle><DialogDescription>{l("创建本地任务并选择交付物依赖；不会触发模型执行。", "Create a local task and choose deliverable dependencies; no model execution is triggered.")}</DialogDescription><form className={styles.form} onSubmit={event => { event.preventDefault(); if (!newTask.title.trim() || !newTask.assignment.trim()) return; setState(previous => addTask(previous, newTask)); setAddOpen(false); setNewTask({ title: "", assignment: "", role: "research", dependencies: [] }) }}><label htmlFor="mixed-new-title">{l("任务标题", "Task title")}</label><Input id="mixed-new-title" required value={newTask.title} onChange={event => setNewTask(previous => ({ ...previous, title: event.target.value }))} /><label htmlFor="mixed-new-role">{l("Agent 角色", "Agent role")}</label>{roleSelect(newTask.role, role => setNewTask(previous => ({ ...previous, role })), "mixed-new-role")}<label htmlFor="mixed-new-assignment">{l("指派", "Assignment")}</label><Textarea id="mixed-new-assignment" rows={4} required value={newTask.assignment} onChange={event => setNewTask(previous => ({ ...previous, assignment: event.target.value }))} /><fieldset><legend>{l("等待这些交付物", "Wait for these deliverables")}</legend>{state.document.nodes.map(node => <label className={styles.check} key={node.id}><Checkbox checked={newTask.dependencies.includes(node.id)} onCheckedChange={checked => setNewTask(previous => ({ ...previous, dependencies: checked ? [...previous.dependencies, node.id] : previous.dependencies.filter(id => id !== node.id) }))} />{text(state.tasks[node.id].title)}</label>)}</fieldset><div className={styles.outputActions}><Button variant="outline" onClick={() => setAddOpen(false)}>{l("取消", "Cancel")}</Button><Button type="submit" disabled={locked}>{l("添加任务", "Add task")}</Button></div></form></DialogContent></Dialog>
    <Dialog open={confirm !== null} onOpenChange={open => { if (!open) setConfirm(null) }}><DialogContent>
      <DialogTitle>{confirm === "reset" ? l("重置本地示例？", "Reset the local example?") : l("移除此任务？", "Remove this task?")}</DialogTitle>
      <DialogDescription>{confirm === "reset" ? l("仅重置此页面当前场景的任务、草稿、布局和脚本历史。", "Only this page’s current scenario tasks, drafts, layout, and playback history will be reset.") : l("移除选中任务及关联连线。可通过撤销恢复。", "Remove the selected task and its incident edges. Undo can restore them.")}</DialogDescription>
      <div className={styles.outputActions}><Button variant="outline" onClick={() => setConfirm(null)}>{l("取消", "Cancel")}</Button>
        <Button variant="destructive" disabled={locked} onClick={() => {
          if (confirm === "reset") {
            setState(createMixedCanvasState(scenario)); setNewTask({ title: "", assignment: "", role: "research", dependencies: [] }); setAddOpen(false); setPreviewCode(false)
          } else if (state.selectedTask) setState(previous => {
            if (!previous.selectedTask) return previous
            return { ...executeCanvasCommand(previous, { type: "delete", selection: { nodeIds: [previous.selectedTask], edgeIds: [] } }), panel: null, selectedTask: null }
          })
          setConfirm(null)
        }}>{confirm === "reset" ? l("重置示例", "Reset example") : l("移除任务", "Remove task")}</Button>
      </div>
    </DialogContent></Dialog>
  </div>
}
