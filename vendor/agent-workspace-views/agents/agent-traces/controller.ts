import { createTraceRecords, type TraceRecord, type TraceSpan } from "./fixtures.ts"

export type StatusFilter = "all" | "success" | "errors"
export type TraceColumn = "id" | "task" | "request" | "outcome" | "started"
export type TraceContext = {
  query: string
  selectedSpan: string
  expanded: string[]
  treeExpanded: string[]
  presentation: "transcript" | "tree"
}
export type TraceState = {
  records: TraceRecord[]
  query: string
  filter: StatusFilter
  range: "14-days" | "today"
  columns: TraceColumn[]
  selectedId: string | null
  inspectorOpen: boolean
  inspectorWidth: number
  maximized: boolean
  contexts: Record<string, TraceContext>
  dataState: "ready" | "empty" | "loading" | "refresh-error"
  readonly: boolean
  realtime: boolean
  readRevision: number
}
export const defaultContext = (): TraceContext => ({ query: "", selectedSpan: "plan", expanded: ["plan"], treeExpanded: ["agent", "step-0", "step-1"], presentation: "transcript" })

export function createTraceState(scenario: string): TraceState {
  const records = scenario === "empty" || scenario === "loading" ? [] : createTraceRecords(scenario === "long-content")
  return {
    records, query: "", filter: "all", range: "14-days", columns: ["id", "task", "request", "outcome", "started"],
    selectedId: records[0]?.id ?? null, inspectorOpen: records.length > 0, inspectorWidth: 460, maximized: false, contexts: {},
    dataState: scenario === "loading" ? "loading" : scenario === "empty" ? "empty" : scenario === "refresh-error" ? "refresh-error" : "ready",
    readonly: scenario === "readonly", realtime: false, readRevision: 0,
  }
}
export function visibleTraces(state: TraceState): TraceRecord[] {
  const query = state.query.trim().toLocaleLowerCase()
  return state.records.filter(record =>
    (state.range !== "today" || record.day === 18) &&
    (state.filter === "all" || (state.filter === "errors" ? record.status === "failed" : record.status === "completed")) &&
    (!query || [record.id, ...Object.values(record.task), ...Object.values(record.agent), ...Object.values(record.request), ...Object.values(record.outcome)].join(" ").toLocaleLowerCase().includes(query)),
  )
}
export function traceContext(state: TraceState, id = state.selectedId): TraceContext {
  return id ? state.contexts[id] ?? defaultContext() : defaultContext()
}
export function updateContext(state: TraceState, update: Partial<TraceContext>): TraceState {
  if (!state.selectedId) return state
  return { ...state, contexts: { ...state.contexts, [state.selectedId]: { ...traceContext(state), ...update } } }
}
export function selectTrace(state: TraceState, id: string): TraceState {
  if (!state.records.some(record => record.id === id)) return state
  return { ...state, selectedId: id, inspectorOpen: true }
}
export function selectSpan(state: TraceState, id: string): TraceState {
  const record = state.records.find(record => record.id === state.selectedId)
  if (!record?.spans.some(span => span.id === id)) return state
  const context = traceContext(state)
  return updateContext(state, { selectedSpan: id, expanded: [...new Set([...context.expanded, id])] })
}
export function visibleSpans(record: TraceRecord, query: string): TraceSpan[] {
  const search = query.trim().toLocaleLowerCase()
  return record.spans.filter(span => !search || [...Object.values(span.name), ...Object.values(span.input), ...Object.values(span.output)].join(" ").toLocaleLowerCase().includes(search))
}
export function toggleColumn(state: TraceState, column: TraceColumn): TraceState {
  if (column === "task") return state
  const columns = state.columns.includes(column) ? state.columns.filter(value => value !== column) : ["id", "task", "request", "outcome", "started"].filter(value => state.columns.includes(value as TraceColumn) || value === column) as TraceColumn[]
  return { ...state, columns }
}
export function refreshTraces(state: TraceState): TraceState {
  // Reading a fixture cannot approve a paused execution or replay a failed tool.
  const records = state.records.length ? state.records : createTraceRecords()
  return { ...state, records, dataState: "ready", selectedId: state.selectedId ?? records[0].id, inspectorOpen: state.selectedId ? state.inspectorOpen : true, readRevision: state.readRevision + 1 }
}
export function toggleRealtime(state: TraceState): TraceState {
  return state.readonly || state.dataState === "loading" ? state : { ...state, realtime: !state.realtime }
}
export function resizeInspector(state: TraceState, width: number, availableWidth: number): TraceState {
  const max = Math.max(280, availableWidth - 320)
  return { ...state, maximized: false, inspectorWidth: Math.round(Math.min(max, Math.max(280, width))) }
}
export function exportTrace(record: TraceRecord, locale: "zh-CN" | "en") {
  return JSON.stringify({ source: "local-fixture", runId: record.id, task: record.task[locale], agent: record.agent[locale], status: record.status, request: record.request[locale], outcome: record.outcome[locale], started: `2026-09-${record.day}T${record.time}:00`, durationSeconds: record.elapsed, tokens: record.tokens, spans: record.spans.map(span => ({ id: span.id, parentId: span.parentId, name: span.name[locale], status: span.status, startSeconds: span.start, durationSeconds: span.duration, input: span.input[locale], output: span.output[locale] })) }, null, 2)
}
