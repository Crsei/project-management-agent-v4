import { applyCanvasCommand } from "@easyuse-ui/ui/lib/canvas-commands"
import type { CanvasCommand, CanvasDocument, CanvasSelection } from "@easyuse-ui/ui/lib/canvas-model"
import type { Copy } from "../../model"
import { resolveUiMessage } from "@easyuse-ui/ui/lib/i18n-core"
import { createDocument, definitions, logs, outputs, sharedBrief, tasks, type Role, type Task } from "./fixtures"

type Layout = { document: CanvasDocument; tasks: Record<string, Task>; brief: Copy | string }
export type Playback = { status: string; visible: number; version: number; output?: Copy; followups: { id: string; text: string; response: Copy }[] }
export type Run = { id: string; status: string; outputs: { id: string; title: Copy | string; output: Copy }[] }
export type MixedCanvasState = Layout & {
  scenario: string
  selection: CanvasSelection
  playback: Record<string, Playback>
  playing: boolean
  run: number
  runs: Run[]
  undo: Layout[]
  redo: Layout[]
  drafts: Record<string, string>
  scroll: Record<string, number>
  panel: "brief" | "history" | "task" | null
  selectedTask: string | null
  saved?: Layout
  notice: Copy | null
  error: Copy | null
  dataReady: boolean
}
const c = (en: string, zh: string): Copy => ({ en, "zh-CN": zh })
const snapshot = (state: Layout): Layout => ({ document: state.document, tasks: state.tasks, brief: state.brief })
export function createMixedCanvasState(scenario: string): MixedCanvasState {
  const document = createDocument()
  const taskMap = Object.fromEntries(tasks.map(task => [task.id, { ...task }]))
  if (scenario === "empty") { document.nodes = []; document.edges = [] }
  if (scenario === "long-content") {
    taskMap.design = { ...taskMap.design, title: c("Build the usage overview across organizations, projects, billing periods, and invoice states", "构建跨组织、项目、账期与发票状态的用量概览") }
  }
  const playback: Record<string, Playback> = Object.fromEntries(document.nodes.map(node => [node.id, { status: "completed", visible: logs[node.id]?.length ?? 0, version: 0, output: outputs[node.id], followups: [] }]))
  if (scenario === "running") {
    for (const node of document.nodes) playback[node.id] = { status: node.id === "research" ? "running" : "queued", visible: 0, version: 0, followups: [] }
  }
  if (scenario === "unknown-outcome") playback.review = { ...playback.review, status: "unknown", output: undefined }
  return { scenario, document, tasks: taskMap, brief: sharedBrief, selection: { nodeIds: [], edgeIds: [] }, playback, playing: scenario === "running", run: 1, runs: [], undo: [], redo: [], drafts: {}, scroll: {}, panel: null, selectedTask: null, notice: null, error: scenario === "refresh-error" ? c("Refresh failed. The last known layout and outputs are preserved.", "刷新失败。保留最后已知的布局与输出。") : null, dataReady: scenario !== "loading" }
}
export const isLocked = (state: MixedCanvasState) => state.scenario === "readonly" || !state.dataReady
function commit(state: MixedCanvasState, layout: Layout): MixedCanvasState {
  return { ...state, ...layout, undo: [...state.undo.slice(-49), snapshot(state)], redo: [], notice: null, error: null }
}
export function executeCanvasCommand(state: MixedCanvasState, command: CanvasCommand): MixedCanvasState {
  if (isLocked(state)) return state
  const result = applyCanvasCommand(state.document, command, definitions)
  if (!result.ok) return { ...state, error: { en: resolveUiMessage("en", result.messageI18n, result.message), "zh-CN": resolveUiMessage("zh-CN", result.messageI18n, result.message) } }
  const remaining = new Set(result.document.nodes.map(node => node.id))
  const remainingTasks = Object.fromEntries(Object.entries(state.tasks).filter(([id]) => remaining.has(id)))
  const previousEdges = new Map(state.document.edges.map(edge => [edge.id, edge]))
  const nextEdges = new Map(result.document.edges.map(edge => [edge.id, edge]))
  const changedTargets: string[] = []
  for (const edge of state.document.edges) if (!nextEdges.has(edge.id) || nextEdges.get(edge.id)?.source !== edge.source || nextEdges.get(edge.id)?.target !== edge.target) changedTargets.push(edge.target)
  for (const edge of result.document.edges) if (!previousEdges.has(edge.id) || previousEdges.get(edge.id)?.source !== edge.source || previousEdges.get(edge.id)?.target !== edge.target) changedTargets.push(edge.target)
  const nextTasks = invalidateTasks(remainingTasks, result.document, changedTargets)
  return { ...commit(state, { ...snapshot(state), document: result.document, tasks: nextTasks }), selection: command.type === "move" ? state.selection : result.selection, playing: false }
}
export function updateTask(state: MixedCanvasState, id: string, patch: Partial<Pick<Task, "title" | "assignment" | "role">>): MixedCanvasState {
  const task = state.tasks[id]
  if (isLocked(state) || !task) return state
  const assignmentChanged = patch.assignment !== undefined && patch.assignment !== task.assignment || patch.role !== undefined && patch.role !== task.role
  const nextTasks = assignmentChanged ? invalidateTasks(state.tasks, state.document, [id]) : state.tasks
  const next = { ...nextTasks[id], ...patch }
  const document = { ...state.document, revision: state.document.revision + 1, nodes: state.document.nodes.map(node => node.id === id ? { ...node, type: next.role, title: typeof next.title === "string" ? next.title : next.title.en } : node) }
  return { ...commit(state, { ...snapshot(state), document, tasks: { ...nextTasks, [id]: next } }), playing: false }
}
export function updateBrief(state: MixedCanvasState, brief: string): MixedCanvasState {
  if (isLocked(state) || brief === state.brief) return state
  const tasks = Object.fromEntries(Object.entries(state.tasks).map(([id, task]) => [id, { ...task, version: task.version + 1 }]))
  return { ...commit(state, { ...snapshot(state), brief, tasks }), playing: false }
}
export function addTask(state: MixedCanvasState, input: { title: string; assignment: string; role: Role; dependencies: string[] }): MixedCanvasState {
  if (isLocked(state)) return state
  if (!input.title.trim() || !input.assignment.trim()) return { ...state, error: c("Task title and assignment are required.", "请填写任务标题与指派内容。") }
  const id = `task-${state.document.revision + 1}`
  const task: Task = { id, title: input.title.trim(), assignment: input.assignment.trim(), role: input.role, agent: "Codex", version: 1 }
  let document = { ...state.document, revision: state.document.revision + 1, nodes: [...state.document.nodes, { id, title: input.title.trim(), type: input.role, config: {}, position: { x: 1280, y: 80 + state.document.nodes.length * 40 } }] }
  for (const source of input.dependencies) {
    const result = applyCanvasCommand(document, { type: "connect", edge: { id: `${source}-${id}`, source, sourcePort: "out", target: id, targetPort: "in" } }, definitions)
    if (!result.ok) return { ...state, error: c("The selected dependency no longer exists.", "选择的依赖已不存在。") }
    document = result.document
  }
  return { ...commit(state, { ...snapshot(state), document, tasks: { ...state.tasks, [id]: task } }), playback: { ...state.playback, [id]: { status: "idle", visible: 0, version: 1, followups: [] } }, selectedTask: id, panel: "task", selection: { nodeIds: [id], edgeIds: [] }, playing: false }
}
export function changeDependency(state: MixedCanvasState, source: string, target: string, checked: boolean): MixedCanvasState {
  const edge = state.document.edges.find(edge => edge.source === source && edge.target === target)
  if (checked && !edge) return executeCanvasCommand(state, { type: "connect", edge: { id: `${source}-${target}`, source, sourcePort: "out", target, targetPort: "in" } })
  if (!checked && edge) return executeCanvasCommand(state, { type: "delete", selection: { nodeIds: [], edgeIds: [edge.id] } })
  return state
}
export function undoEdit(state: MixedCanvasState): MixedCanvasState {
  if (isLocked(state) || !state.undo.length) return state
  const layout = state.undo[state.undo.length - 1]
  return { ...state, ...layout, undo: state.undo.slice(0, -1), redo: [snapshot(state), ...state.redo], playing: false, error: null }
}
export function redoEdit(state: MixedCanvasState): MixedCanvasState {
  if (isLocked(state) || !state.redo.length) return state
  return { ...state, ...state.redo[0], undo: [...state.undo, snapshot(state)], redo: state.redo.slice(1), playing: false, error: null }
}
export function startPlayback(state: MixedCanvasState): MixedCanvasState {
  if (isLocked(state) || !state.document.nodes.length) return state
  const archived = collectOutputs(state)
  return { ...state, playing: true, run: state.run + 1, runs: [{ id: `demo-${state.run}`, status: teamStatus(state), outputs: archived }, ...state.runs].slice(0, 10), playback: Object.fromEntries(state.document.nodes.map(node => [node.id, { status: "queued", visible: 0, version: state.tasks[node.id].version, followups: [] }])), notice: c("Playing authored examples locally. No repository commands or model calls are executed.", "正在本地播放编写的样例。不会执行仓库命令或调用模型。") }
}
export function advancePlayback(state: MixedCanvasState): MixedCanvasState {
  if (!state.playing || isLocked(state)) return state
  const playback = { ...state.playback }
  let progressing = false
  for (const node of state.document.nodes) {
    const current = state.playback[node.id]
    if (!current || current.status === "completed" || current.status === "waiting") continue
    const dependencies = state.document.edges.filter(edge => edge.target === node.id).map(edge => edge.source)
    if (dependencies.some(id => state.playback[id]?.status !== "completed" || state.playback[id]?.version !== state.tasks[id]?.version)) continue
    const task = state.tasks[node.id]
    if (!logs[node.id] || task.version !== 0) {
      playback[node.id] = { ...current, status: "waiting" }
      continue
    }
    progressing = true
    if (current.status === "queued") playback[node.id] = { ...current, status: "running" }
    else {
      const visible = current.visible + 1
      const completed = visible >= logs[node.id].length
      playback[node.id] = { ...current, visible, status: completed ? "completed" : "running", output: completed ? outputs[node.id] : undefined }
    }
  }
  return { ...state, playback, playing: progressing, notice: progressing ? state.notice : null }
}
export function sendFollowup(state: MixedCanvasState, id: string): MixedCanvasState {
  if (isLocked(state) || !state.drafts[id]?.trim() || !state.tasks[id]) return state
  const current = state.playback[id] ?? { status: "idle", visible: 0, version: state.tasks[id].version, followups: [] }
  const response = c("Authored follow-up example: keep the Estimate label adjacent to the amount and recheck the narrow layout. This is a scripted response, not a change to a repository or a model answer to your message.", "编写的后续样例：将预估标签保留在金额旁，并复查窄布局。这是脚本响应，不会修改仓库，也不是模型对你消息的回答。")
  return { ...state, drafts: { ...state.drafts, [id]: "" }, playback: { ...state.playback, [id]: { ...current, followups: [...current.followups, { id: `${id}-followup-${current.followups.length + 1}`, text: state.drafts[id].trim(), response }] } } }
}
export function collectOutputs(state: MixedCanvasState) {
  return state.document.nodes.flatMap(node => {
    const result = state.playback[node.id]
    return result?.output && result.version === state.tasks[node.id]?.version ? [{ id: node.id, title: state.tasks[node.id].title, output: result.output }] : []
  })
}

function invalidateTasks(tasks: Record<string, Task>, document: CanvasDocument, initial: string[]) {
  const invalid = new Set(initial)
  const queue = [...initial]
  for (let index = 0; index < queue.length; index++) {
    for (const edge of document.edges) if (edge.source === queue[index] && !invalid.has(edge.target)) { invalid.add(edge.target); queue.push(edge.target) }
  }
  return Object.fromEntries(Object.entries(tasks).map(([id, task]) => [id, invalid.has(id) ? { ...task, version: task.version + 1 } : task]))
}

export function teamStatus(state: MixedCanvasState): string {
  if (!state.document.nodes.length) return "idle"
  if (state.playing) return "running"
  if (state.document.nodes.some(node => state.playback[node.id]?.status === "unknown")) return "unknown"
  if (state.document.nodes.every(node => state.playback[node.id]?.status === "completed" && state.playback[node.id]?.version === state.tasks[node.id]?.version)) return "completed"
  if (state.document.nodes.some(node => state.playback[node.id]?.status === "running")) return "paused"
  return "waiting"
}
