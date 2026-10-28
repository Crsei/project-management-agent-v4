import { isRuntimeStatus } from "./runtime-status"
import type {
  AgentBoardViewState,
  AgentRunSnapshot,
  AttentionRecord,
  UsageObservation,
} from "./agent-board-model"
export const runGroups = [
  "queued",
  "active",
  "waiting",
  "ended",
  "other",
] as const
export type RunGroup = (typeof runGroups)[number]
export function runGroup(status: string): RunGroup {
  if (status === "queued") return "queued"
  if (["starting", "running", "thinking"].includes(status)) return "active"
  if (["waiting", "paused"].includes(status)) return "waiting"
  if (["completed", "failed", "cancelled"].includes(status)) return "ended"
  return "other"
}
export function filterAgentRuns(
  records: readonly AgentRunSnapshot[],
  view: AgentBoardViewState,
) {
  const query = view.query.trim().toLocaleLowerCase()
  return records.filter(
    (run) =>
      (!query ||
        [run.runId, run.title, run.agentName, run.workItemRef?.title].some(
          (value) => value?.toLocaleLowerCase().includes(query),
        )) &&
      (!view.agentId || run.agentId === view.agentId) &&
      (!view.model || run.model === view.model) &&
      (!view.status || run.runtimeStatus === view.status) &&
      (!view.workItemId || run.workItemRef?.id === view.workItemId),
  )
}
export function dedupeAttention(records: readonly AttentionRecord[]) {
  const byId = new Map<string, AttentionRecord>()
  for (const record of records)
    if ((byId.get(record.attentionId)?.revision ?? -1) < record.revision)
      byId.set(record.attentionId, record)
  return [...byId.values()]
}
export function mergeRunSnapshots(
  current: readonly AgentRunSnapshot[],
  incoming: readonly AgentRunSnapshot[],
) {
  const byId = new Map(current.map((run) => [run.runId, run]))
  for (const run of incoming)
    if ((byId.get(run.runId)?.revision ?? -1) < run.revision)
      byId.set(run.runId, run)
  return [...byId.values()]
}
/** Inclusive observations suppress known descendants. Unknown inclusion stays separate. */
export function summarizeUsage(
  observations: readonly UsageObservation[],
  runs: readonly AgentRunSnapshot[],
) {
  const ids = new Set(runs.map((run) => run.runId))
  const unique = [
    ...new Map(
      observations
        .filter((item) => ids.has(item.runId))
        .map((item) => [item.observationId, item]),
    ).values(),
  ]
  const included = new Set(
    unique
      .filter((item) => item.inclusion === "inclusive")
      .flatMap((item) => item.includesRunIds ?? []),
  )
  const accepted = unique.filter(
    (item) => item.inclusion !== "unknown" && !included.has(item.runId),
  )
  const excluded = unique.filter((item) => !accepted.includes(item))
  const currencies = new Map<string, number>()
  for (const item of accepted)
    if (item.cost !== undefined && Number.isFinite(item.cost) && item.currency)
      currencies.set(
        item.currency,
        (currencies.get(item.currency) ?? 0) + item.cost,
      )
  const tokens = accepted.filter(
    (item) => item.tokens !== undefined && Number.isFinite(item.tokens),
  )
  const durations = accepted.filter(
    (item) => item.durationMs !== undefined && Number.isFinite(item.durationMs),
  )
  return {
    accepted,
    excluded,
    currencies,
    tokens: tokens.length
      ? tokens.reduce((sum, item) => sum + item.tokens!, 0)
      : undefined,
    durationMs: durations.length
      ? durations.reduce((sum, item) => sum + item.durationMs!, 0)
      : undefined,
    coveredRuns: new Set(unique.map((item) => item.runId)).size,
    tokenRuns: new Set(tokens.map((item) => item.runId)).size,
    estimated: accepted.some((item) => item.estimated),
    timestamps: unique.map((item) => item.timestamp).sort(),
  }
}
export function parseAgentBoardQuery(
  params: URLSearchParams,
  allowedStatuses: readonly string[] = [],
): {
  viewState: AgentBoardViewState
  selectedRunId: string | null
} {
  const view = params.get("view")
  return {
    viewState: {
      view: ["board", "list", "inbox", "insights", "dependencies"].includes(
        view ?? "",
      )
        ? (view as AgentBoardViewState["view"])
        : "board",
      query: params.get("q") ?? "",
      agentId: params.get("agent") ?? "",
      model: params.get("model") ?? "",
      status:
        isRuntimeStatus(params.get("status") ?? "") ||
        allowedStatuses.includes(params.get("status") ?? "")
          ? params.get("status")!
          : "",
      workItemId: params.get("task") ?? "",
      inboxKind: [
        "approval",
        "input",
        "failure",
        "unknown",
        "disconnect",
      ].includes(params.get("kind") ?? "")
        ? params.get("kind")!
        : "",
    },
    selectedRunId: params.get("run") || null,
  }
}
export function serializeAgentBoardQuery(
  view: AgentBoardViewState,
  runId: string | null,
) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries({
    view: view.view,
    run: runId,
    q: view.query,
    agent: view.agentId,
    model: view.model,
    status: view.status,
    task: view.workItemId,
    kind: view.inboxKind,
  }))
    if (value) params.set(key, value)
  return params.toString()
}
export function safeArtifactHref(href?: string) {
  if (!href || href.startsWith("//") || /[\\\x00-\x20]/.test(href))
    return undefined
  if (href.startsWith("/") || /^https?:\/\//i.test(href)) return href
  return undefined
}
export function durationLabel(ms?: number) {
  return ms === undefined || !Number.isFinite(ms) || ms < 0
    ? "—"
    : `${Math.round(ms / 1000)}s`
}
