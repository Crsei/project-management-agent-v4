import type { ApOperationResult, ApScenario } from "../model"
import {
  createIncidents,
  incidentPeriod,
  incidentSeverities,
  type ApIncident,
  type IncidentSeverity,
} from "./fixtures.ts"

import {
  createServiceIncidents,
  serviceIncidentPeriod,
  type ServiceIncident,
  type IncidentRecord,
  type IncidentPeriod,
} from "./service-fixtures.ts"

export type IncidentNote = {
  noteId: string
  text: string
  copy?: { en: string; "zh-CN": string }
}
export type NoteReceipt = {
  operationId: string
  targetId: string
  kind: "add" | "delete"
  payload: IncidentNote
  result: ApOperationResult
  requestedOutcome: "confirmed" | "rejected" | "unknown"
}
export type IncidentState<T extends IncidentRecord = ApIncident> = {
  incidents: T[]
  source: "ledger" | "reference"
  period: IncidentPeriod
  listDimension: "endpoint" | "region" | null
  listPage: number
  tab: "overview" | "endpoints" | "regions"
  severities: IncidentSeverity[]
  endpoint: string | null
  region: string | null
  selectedId: string | null
  listOpen: boolean
  runbookOpen: boolean
  recovered: boolean
  readonly: boolean
  drafts: Record<string, string>
  notes: Record<string, IncidentNote[]>
  receipt: NoteReceipt | null
  nextOperation: number
  noteOutcome: "confirmed" | "rejected" | "unknown"
}
export function createIncidentState(
  scenario: ApScenario,
): IncidentState<ApIncident>
export function createIncidentState(
  scenario: ApScenario,
  source: "reference",
): IncidentState<ServiceIncident>
export function createIncidentState(
  scenario: ApScenario,
  source: "ledger" | "reference",
): IncidentState<IncidentRecord>
export function createIncidentState(
  scenario: ApScenario,
  source: "ledger" | "reference" = "ledger",
): IncidentState<IncidentRecord> {
  return {
    incidents:
      source === "reference"
        ? createServiceIncidents(scenario)
        : createIncidents(scenario),
    source,
    period: source === "reference" ? serviceIncidentPeriod : incidentPeriod,
    listDimension: null,
    listPage: 1,
    tab: "overview",
    severities: [...incidentSeverities],
    endpoint: null,
    region: null,
    selectedId: null,
    listOpen: false,
    runbookOpen: false,
    recovered: false,
    readonly: scenario === "readonly",
    drafts: {},
    notes: {
      platform: [
        {
          noteId: "note-fixture-1",
          text:
            source === "reference"
              ? "Aug 17 spike traced to unbounded retries — read the outage postmortem before touching limits."
              : "September rate limits are fixed local samples — inspect the request history before touching limits.",
          copy:
            source === "reference"
              ? {
                  en: "Aug 17 spike traced to unbounded retries — read the outage postmortem before touching limits.",
                  "zh-CN":
                    "8 月 17 日的峰值源于无界重试——调整限额前请先阅读故障复盘。",
                }
              : undefined,
        },
      ],
    },
    receipt: null,
    nextOperation: 1,
    noteOutcome: "confirmed",
  }
}
export function incidentSelection<T extends IncidentRecord>(
  state: IncidentState<T>,
): T[] {
  const periodFrom = Date.parse(state.period.from)
  const periodTo = Date.parse(state.period.to)
  return state.incidents.filter(
    (row) =>
      Date.parse(row.startedAt) >= periodFrom &&
      Date.parse(row.startedAt) < periodTo &&
      state.severities.includes(row.severity) &&
      (state.endpoint === null ||
        (row.endpoint ?? "unknown") === state.endpoint) &&
      (state.region === null || (row.region ?? "unknown") === state.region),
  )
}
export function setIncidentSeverity<T extends IncidentRecord>(
  state: IncidentState<T>,
  severity: IncidentSeverity,
): IncidentState<T> {
  const next = {
    ...state,
    severities: state.severities.includes(severity)
      ? state.severities.filter((s) => s !== severity)
      : [...state.severities, severity],
  }
  return retainIncidentSelection(next)
}
export function retainIncidentSelection<T extends IncidentRecord>(
  state: IncidentState<T>,
): IncidentState<T> {
  return state.selectedId &&
    !incidentSelection(state).some((r) => r.incidentId === state.selectedId)
    ? { ...state, selectedId: null }
    : state
}
export function incidentDailyRows(
  rows: readonly IncidentRecord[],
  period: IncidentPeriod = incidentPeriod,
) {
  const periodFrom = Date.parse(period.from)
  const periodTo = Date.parse(period.to)
  const days = (periodTo - periodFrom) / 86400000
  const buckets = Array.from({ length: days }, (_, index) => ({
    date: new Date(periodFrom + index * 86400000).toISOString().slice(0, 10),
    total: 0,
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  }))
  for (const row of rows) {
    const index = Math.floor(
      (Date.parse(row.startedAt) - periodFrom) / 86400000,
    )
    const bucket = buckets[index]
    if (!bucket) continue
    bucket.total += 1
    bucket[row.severity] += 1
  }
  return buckets
}
export function incidentGroups(
  rows: readonly IncidentRecord[],
  key: "endpoint" | "region",
) {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const id = row[key] ?? "unknown"
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return [...counts]
    .map(([id, value]) => ({ id, value }))
    .sort((a, b) => b.value - a.value || a.id.localeCompare(b.id))
}
export function submitIncidentNote<T extends IncidentRecord>(
  state: IncidentState<T>,
  targetId: string,
  note?: IncidentNote,
): IncidentState<T> {
  if (
    state.readonly ||
    state.receipt?.result === "pending" ||
    state.receipt?.result === "unknown"
  )
    return state
  const text = state.drafts[targetId] ?? ""
  if (!note && !text.trim()) return state
  if (note && !state.notes[targetId]?.some((n) => n.noteId === note.noteId))
    return state
  if (
    targetId !== "platform" &&
    !state.incidents.some((i) => i.incidentId === targetId)
  )
    return state
  return {
    ...state,
    nextOperation: state.nextOperation + 1,
    receipt: {
      operationId: `inc-note-op-${state.nextOperation}`,
      targetId,
      kind: note ? "delete" : "add",
      payload: note ?? { noteId: `inc-note-${state.nextOperation}`, text },
      result: "pending",
      requestedOutcome: state.noteOutcome,
    },
  }
}
function confirmReceipt<T extends IncidentRecord>(
  state: IncidentState<T>,
): IncidentState<T> {
  const receipt = state.receipt
  if (!receipt) return state
  const current = state.notes[receipt.targetId] ?? []
  const notes =
    receipt.kind === "add"
      ? current.some((n) => n.noteId === receipt.payload.noteId)
        ? current
        : [...current, receipt.payload]
      : current.filter((n) => n.noteId !== receipt.payload.noteId)
  const sameDraft =
    (state.drafts[receipt.targetId] ?? "") === receipt.payload.text
  return {
    ...state,
    notes: { ...state.notes, [receipt.targetId]: notes },
    drafts:
      receipt.kind === "add" && sameDraft
        ? { ...state.drafts, [receipt.targetId]: "" }
        : state.drafts,
    receipt: { ...receipt, result: "confirmed" },
  }
}
export function settleIncidentNote<T extends IncidentRecord>(
  state: IncidentState<T>,
  query = false,
): IncidentState<T> {
  if (state.readonly || !state.receipt) return state
  if (query)
    return state.receipt.result === "unknown" ? confirmReceipt(state) : state
  if (state.receipt.result !== "pending") return state
  return state.receipt.requestedOutcome === "confirmed"
    ? confirmReceipt(state)
    : {
        ...state,
        receipt: { ...state.receipt, result: state.receipt.requestedOutcome },
      }
}
export function incidentExport<T extends IncidentRecord>(
  state: IncidentState<T>,
) {
  return JSON.stringify(
    {
      source: "fixture",
      period: state.period,
      population: state.source,
      filters: {
        severities: state.severities,
        endpoint: state.endpoint,
        region: state.region,
      },
      incidentCount: incidentSelection(state).length,
      incidents: incidentSelection(state),
    },
    null,
    2,
  )
}
