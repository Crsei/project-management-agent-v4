import { createRunFixtures, type AutomationId, type AutomationRun, type RunOutcome } from "./fixtures.ts"

export type HistoryTab = "response" | "event"
export type RunHistoryState = {
  records: AutomationRun[]
  automation: AutomationId | "all"
  outcome: RunOutcome | "all"
  expandedIds: string[]
  tabs: Record<string, HistoryTab>
  outputId: string | null
  scrollTop: number
  dataState: "loading" | "ready" | "refresh-error"
  readonly: boolean
  replayedFrom: string | null

}

export function createRunHistoryState(scenario: string): RunHistoryState {
  return {
    records: scenario === "empty" || scenario === "loading" ? [] : createRunFixtures(scenario === "long-content"),
    automation: "all", outcome: "all", expandedIds: ["exec-204"], tabs: {},
    outputId: null, scrollTop: 0,
    dataState: scenario === "loading" ? "loading" : scenario === "refresh-error" ? "refresh-error" : "ready",
    readonly: scenario === "readonly", replayedFrom: null,
  }
}

export function visibleRuns(state: RunHistoryState): AutomationRun[] {
  return state.records.filter(run =>
    (state.automation === "all" || run.automationId === state.automation) &&
    (state.outcome === "all" || run.outcome === state.outcome),
  )
}

export function setRunFilter(state: RunHistoryState, filter: "automation", value: AutomationId | "all"): RunHistoryState
export function setRunFilter(state: RunHistoryState, filter: "outcome", value: RunOutcome | "all"): RunHistoryState
export function setRunFilter(state: RunHistoryState, filter: "automation" | "outcome", value: AutomationId | RunOutcome | "all"): RunHistoryState {
  return { ...state, [filter]: value }
}

export function clearRunFilters(state: RunHistoryState): RunHistoryState {
  return { ...state, automation: "all", outcome: "all" }
}

export function expandRun(state: RunHistoryState, id: string, open: boolean): RunHistoryState {
  if (!state.records.some(run => run.id === id)) return state
  return {
    ...state,
    expandedIds: open
      ? [...new Set([...state.expandedIds, id])]
      : state.expandedIds.filter(expandedId => expandedId !== id),
  }
}

export function selectRunTab(state: RunHistoryState, id: string, tab: HistoryTab): RunHistoryState {
  if (!state.records.some(run => run.id === id)) return state
  return { ...state, tabs: { ...state.tabs, [id]: tab } }
}

/** Explicit local read; retry keeps all existing records, filters and inspection context. */
export function loadRunHistory(state: RunHistoryState): RunHistoryState {
  return { ...state, dataState: "ready", records: state.records.length ? state.records : createRunFixtures() }
}

/** Deterministic fixture replay. Never changes the original outcome or sends a webhook. */
export function replayDemoEvent(state: RunHistoryState, id: string): RunHistoryState {
  const original = state.records.find(run => run.id === id)
  if (state.readonly || state.dataState === "loading" || !original || original.outcome !== "error") return state
  const nextId = `exec-${Math.max(205, ...state.records.map(run => Number(run.id.slice(5)))) + 1}`
  const successfulFixture = createRunFixtures().find(run => run.automationId === original.automationId && run.outcome === "success")!
  const replay: AutomationRun = {
    ...successfulFixture,
    id: nextId,
    time: "09:05",
    title: original.title,
    capturedEvent: { ...original.capturedEvent },
    replayOf: original.id,
    message: {
      "zh-CN": "已在本地重放捕获的演示事件，支持主题已汇总。",
      en: "Captured demo event replayed locally. Support themes summarized in the workspace.",
    },
  }
  return {
    ...state, records: [replay, ...state.records],
    automation: original.automationId, outcome: "all",
    expandedIds: [...new Set([nextId, ...state.expandedIds])],
    tabs: { ...state.tabs, [nextId]: "response" }, replayedFrom: original.id,
  }
}

export function inspectSavedOutput(state: RunHistoryState, id: string | null): RunHistoryState {
  if (id !== null && !state.records.some(run => run.id === id && run.outcome === "success" && run.output)) return state
  return { ...state, outputId: id }
}

export function runResponse(run: AutomationRun, locale: "zh-CN" | "en") {
  return { status: run.statusCode, message: run.message[locale], duration: run.duration }
}

export function savedOutput(state: RunHistoryState, id: string, locale: "zh-CN" | "en"): string | null {
  const run = state.records.find(record => record.id === id)
  return run?.outcome === "success" && run.output ? run.output[locale] : null
}
