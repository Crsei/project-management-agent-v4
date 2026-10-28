import { applyCanvasCommand } from "@easyuse-ui/ui/lib/canvas-commands"
import { parseCanvasDocument, validateCanvasDocument } from "@easyuse-ui/ui/lib/canvas-validation"
import type { CanvasCommand, CanvasDocument, CanvasSelection } from "@easyuse-ui/ui/lib/canvas-model"
import { canvasFixture, definitions } from "./fixtures"

export type CanvasState = {
  document: CanvasDocument
  selection: CanvasSelection
  past: CanvasDocument[]
  future: CanvasDocument[]
  savedRevision: number
  nextBranch: number
  readState: "ready" | "loading" | "error"
  feedback: "saved" | "edited" | "playing" | "stopped" | "imported" | "copied" | null
  error: string | null
  playing: string[]
  inspectorId: string | null
}
export function createCanvasState(scenario: string): CanvasState {
  return { document: canvasFixture(scenario), selection: { nodeIds: [], edgeIds: [] }, past: [], future: [], savedRevision: 0, nextBranch: 4, readState: scenario === "loading" ? "loading" : scenario === "refresh-error" ? "error" : "ready", feedback: null, error: null, playing: [], inspectorId: null }
}
export function commitCanvas(state: CanvasState, command: CanvasCommand, readonly = false): CanvasState {
  const result = applyCanvasCommand(state.document, command, definitions, { readOnly: readonly || state.readState === "loading" })
  if (!result.ok) return { ...state, error: result.message }
  return { ...state, document: result.document, selection: command.type === "move" || command.type === "configure" ? state.selection : result.selection, past: [...state.past.slice(-49), state.document], future: [], feedback: "edited", error: null, playing: [] }
}
export function editObject(state: CanvasState, id: string, values: { title?: string; text?: string; movement?: string; image?: string }, readonly = false): CanvasState {
  const node = state.document.nodes.find(n => n.id === id)
  if (!node) return { ...state, error: "Object no longer exists" }
  if (values.title !== undefined && !values.title.trim()) return { ...state, error: "Name is required" }
  return commitCanvas(state, { type: "configure", nodeId: id, title: values.title ?? node.title, config: { ...node.config, ...(values.text === undefined ? {} : { text: values.text }), ...(values.movement === undefined ? {} : { movement: values.movement }), ...(values.image === undefined ? {} : { image: values.image }) } }, readonly)
}
export function addBranch(state: CanvasState, readonly = false): CanvasState {
  if (readonly || state.readState === "loading") return state
  const n = state.nextBranch
  const existingSource = state.document.nodes.find(node => node.id === state.selection.nodeIds[0] && (node.type === "source" || node.type === "clip")) ?? state.document.nodes.find(node => node.type === "source")
  let document = state.document
  if (!existingSource) document = { ...document, nodes: [canvasFixture("default").nodes[0], ...document.nodes] }
  const source = existingSource?.id ?? "source"
  const y = Math.max(-385, ...document.nodes.filter(node => node.type === "prompt" && node.id !== "refine").map(node => node.position.y)) + 385
  const promptId = "prompt-" + n, clipId = "clip-" + n
  const command: CanvasCommand = { type: "replace", document: { ...document, nodes: [...document.nodes, { id: promptId, type: "prompt", title: String(n).padStart(2, "0") + " / New direction", position: { x: 415, y }, config: { text: "", duration: 6, movement: "push" } }, { id: clipId, type: "clip", title: String(n).padStart(2, "0") + " / Motion preview", position: { x: 865, y }, config: { duration: 6, movement: "push" } }], edges: [...document.edges, { id: source + "-" + promptId, source, sourcePort: "out", target: promptId, targetPort: "in" }, { id: promptId + "-" + clipId, source: promptId, sourcePort: "out", target: clipId, targetPort: "in" }, { id: source + "-" + clipId, source, sourcePort: "out", target: clipId, targetPort: "in" }] } }
  const result = commitCanvas(state, command)
  return result.error ? result : { ...result, nextBranch: n + 1, selection: { nodeIds: [promptId], edgeIds: [] }, inspectorId: promptId }
}
export function undoCanvas(state: CanvasState): CanvasState {
  if (!state.past.length) return state
  const document = { ...state.past[state.past.length - 1], revision: state.document.revision + 1, viewport: state.document.viewport }
  return { ...state, document, past: state.past.slice(0, -1), future: [state.document, ...state.future], playing: [], error: null, feedback: "edited", selection: { nodeIds: state.selection.nodeIds.filter(id => document.nodes.some(node => node.id === id)), edgeIds: [] }, inspectorId: document.nodes.some(node => node.id === state.inspectorId) ? state.inspectorId : null }
}
export function redoCanvas(state: CanvasState): CanvasState {
  if (!state.future.length) return state
  return { ...state, document: { ...state.future[0], revision: state.document.revision + 1, viewport: state.document.viewport }, past: [...state.past, state.document], future: state.future.slice(1), playing: [], error: null, feedback: "edited" }
}
export function importCanvas(state: CanvasState, text: string, readonly = false): CanvasState {
  if (readonly) return state
  try {
    const document = parseCanvasDocument(text, definitions)
    if (document.nodes.some(node => !definitions.some(def => def.type === node.type))) return { ...state, error: "Only source, prompt and motion preview objects are supported" }
    if (document.nodes.some(node => typeof node.config.image === "string" && node.config.image !== "studio" && !/^data:image\/(png|jpeg|webp);base64,/.test(node.config.image))) return { ...state, error: "Imported media must be an embedded PNG, JPEG or WebP image" }
    const issues = validateCanvasDocument(document, definitions)
    if (issues.some(issue => issue.severity === "error")) return { ...state, error: issues.filter(issue => issue.severity === "error").map(issue => issue.message).join("; ") }
    const next = commitCanvas(state, { type: "replace", document })
    const branchNumbers = next.document.nodes.flatMap(node => /^prompt-(\d+)$/.test(node.id) ? [Number(node.id.slice(7))] : [])
    return { ...next, nextBranch: Math.max(3, ...branchNumbers) + 1, inspectorId: null, feedback: "imported" }
  } catch (error) { return { ...state, error: error instanceof Error ? error.message : "Invalid canvas JSON" } }
}
export function togglePlayback(state: CanvasState, id?: string): CanvasState {
  const ids = id ? [id] : state.document.nodes.filter(node => node.type === "clip").map(node => node.id)
  if (!ids.length || ids.some(key => !state.document.nodes.some(node => node.id === key && node.type === "clip"))) return state
  const stop = ids.every(key => state.playing.includes(key))
  return { ...state, playing: stop ? state.playing.filter(key => !ids.includes(key)) : [...new Set([...state.playing, ...ids])], feedback: stop ? "stopped" : "playing" }
}
