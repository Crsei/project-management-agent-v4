import { activityFixtures, copy, type ActivityRun, type Copy, type RunStatus } from "./fixtures.ts"

export type StatusFilter = RunStatus | "all" | "attention"
export type Period = "hour" | "day" | "week"
export type ActivityState = {
  records: ActivityRun[]; query: string; period: Period; status: StatusFilter; expanded: string[]
  panel: "review" | "rule" | "output" | null; panelRunId: string | null
  reviewNote: string; discount: string; error: "reason" | "discount" | null
  readonly: boolean; dataState: "ready" | "loading" | "error"; scrollTop: number; panelScrollTop: number
  notice: Copy | null; events: { id: number; runId: string; action: Copy }[]
}
export function createActivityState(scenario: string): ActivityState {
  const records = scenario === "empty" || scenario === "loading" ? [] : activityFixtures()
  if (scenario === "long-content") {
    records[1] = { ...records[1], title: copy("准备跨区域客户收入、留存与账户健康综合报告及季度续约分析", "Prepare a cross-region customer revenue, retention, and account health report with quarterly renewal analysis"), steps: records[1].steps.map(step => ({ ...step, detail: copy(`${step.detail["zh-CN"]} · 按地区、套餐与续约窗口分类，保留所有原始审核限制和导出字段。`, `${step.detail.en} · Grouped by region, plan, and renewal window, retaining all original review limits and export fields.`) })) }
  }
  return { records, query: "", period: "day", status: "all", expanded: ["run_84f2", "run_78de"], panel: null, panelRunId: null, reviewNote: "", discount: "20", error: null, readonly: scenario === "readonly", dataState: scenario === "loading" ? "loading" : scenario === "refresh-error" ? "error" : "ready", scrollTop: 0, panelScrollTop: 0, notice: null, events: [] }
}
export function isAttention(status: RunStatus) { return status === "review" || status === "blocked" || status === "failed" }
export function visibleRuns(state: ActivityState): ActivityRun[] {
  const query = state.query.trim().toLocaleLowerCase()
  const minutes = state.period === "hour" ? 60 : state.period === "day" ? 1440 : 10080
  return state.records.filter(run => run.ageMinutes <= minutes && (state.status === "all" || (state.status === "attention" ? isAttention(run.status) : run.status === state.status)) && (!query || [run.id, run.title.en, run.title["zh-CN"], run.agent.en, run.agent["zh-CN"], run.integrations].some(value => value.toLocaleLowerCase().includes(query))))
}
export function setFilter(state: ActivityState, field: "query" | "period" | "status", value: string): ActivityState {
  return { ...state, [field]: value, scrollTop: 0 }
}
export function toggleRun(state: ActivityState, id: string): ActivityState {
  if (!state.records.some(run => run.id === id)) return state
  return { ...state, expanded: state.expanded.includes(id) ? state.expanded.filter(value => value !== id) : [...state.expanded, id] }
}
export function openPanel(state: ActivityState, panel: ActivityState["panel"], runId: string | null): ActivityState {
  if (!panel) return { ...state, panel: null, panelRunId: null, error: null }
  const run = state.records.find(record => record.id === runId)
  if (!run || (panel === "review" && run.status !== "review") || (panel === "rule" && run.status !== "blocked") || (panel === "output" && !run.output)) return state
  return { ...state, panel, panelRunId: runId, panelScrollTop: 0, error: null }
}
function event(state: ActivityState, runId: string, action: Copy): ActivityState {
  return { ...state, events: [...state.events, { id: state.events.length + 1, runId, action }], notice: action }
}
export function decideReview(state: ActivityState, decision: "approve" | "reject"): ActivityState {
  const run = state.records.find(record => record.id === state.panelRunId)
  if (state.readonly || state.panel !== "review" || run?.status !== "review") return state
  if (decision === "reject" && !state.reviewNote.trim()) return { ...state, error: "reason" }
  const records = state.records.map(record => record.id === run.id ? { ...record, status: decision === "approve" ? "running" as const : "cancelled" as const, steps: record.steps.map(step => step.status === "completed" ? step : { ...step, status: decision === "approve" ? (step.status === "review" ? "running" as const : "waiting" as const) : "cancelled" as const, action: undefined }) } : record)
  return event({ ...state, records, panel: null, panelRunId: null, error: null }, run.id, decision === "approve" ? copy("本地演示已批准此运行；点击继续推进导出步骤。", "Local demo approved this run; Resume advances the export step.") : copy("本地演示已拒绝此请求，未开始的步骤已取消。", "Local demo rejected the request and cancelled unstarted steps."))
}
export function reviseDiscount(state: ActivityState): ActivityState {
  const run = state.records.find(record => record.id === state.panelRunId)
  if (state.readonly || state.panel !== "rule" || run?.status !== "blocked") return state
  const discount = Number(state.discount)
  if (!state.discount.trim() || !Number.isFinite(discount) || discount < 0 || discount > 20) return { ...state, error: "discount" }
  const records = state.records.map(record => record.id === run.id ? { ...record, status: "running" as const, steps: record.steps.map(step => step.status === "blocked" ? { ...step, status: "running" as const, title: copy(`应用 ${discount}% 折扣`, `Apply ${discount}% discount`), detail: copy(`请求已修订为 ${discount}% · 策略上限仍为 20%`, `Request revised to ${discount}% · policy limit remains 20%`), action: undefined } : step) } : record)
  return event({ ...state, records, panel: null, panelRunId: null, error: null }, run.id, copy("本地演示已修订此交易请求；策略未改变。", "Local demo revised this deal request; policy is unchanged."))
}
export function retryStep(state: ActivityState, id: string): ActivityState {
  const run = state.records.find(record => record.id === id)
  if (state.readonly || run?.status !== "failed") return state
  return event({ ...state, records: state.records.map(record => record.id === id ? { ...record, status: "running", steps: record.steps.map(step => step.status === "failed" ? { ...step, status: "running", action: undefined, detail: copy("本地演示正在重试供应商同步", "Local demo retrying vendor synchronization") } : step) } : record), expanded: state.expanded.includes(id) ? state.expanded : [...state.expanded, id] }, id, copy("仅在本地重试失败步骤；已完成步骤未重放。", "Retrying the failed step locally; completed steps were not replayed."))
}
export function advanceRuns(state: ActivityState): ActivityState {
  if (state.readonly || !state.records.some(run => run.status === "running")) return state
  let next = state
  const records = state.records.map(run => {
    if (run.status !== "running") return run
    const index = run.steps.findIndex(step => step.status === "running")
    if (index < 0) return run
    const steps = run.steps.map((step, i) => i === index ? { ...step, status: "completed" as const } : i === index + 1 && step.status === "waiting" ? { ...step, status: "running" as const } : step)
    const status = steps.every(step => step.status === "completed") ? "completed" as const : "running" as const
    next = event(next, run.id, copy(`本地演示：${run.steps[index].title["zh-CN"]}已完成。`, `Local demo: ${run.steps[index].title.en} completed.`))
    return { ...run, steps, status }
  })
  return { ...next, records }
}
export function loadDemo(state: ActivityState): ActivityState {
  if (state.readonly) return state
  return { ...state, records: state.records.length ? state.records : activityFixtures(), dataState: "ready", notice: copy("本地固定活动数据已载入；未调用外部服务。", "Local fixed activity data loaded; no external service was called.") }
}
