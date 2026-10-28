import type {
  AgentRunDependency,
  AgentRunSnapshot,
  AgentUsageHistoryPoint,
  AgentUsageMetric,
} from "./agent-board-model"
import { mergeRunSnapshots } from "./agent-board-view"

function latest<T extends { revision: number }>(
  records: readonly T[],
  id: (record: T) => string,
) {
  const result = new Map<string, T>()
  for (const record of records)
    if ((result.get(id(record))?.revision ?? -1) < record.revision)
      result.set(id(record), record)
  return [...result.values()]
}
/** Deterministic presentation ranks only; cycles, absent endpoints and hidden context stay explicit. */
export function prepareAgentDependencies(
  records: readonly AgentRunSnapshot[],
  dependencies: readonly AgentRunDependency[],
  scopeRunIds?: readonly string[],
  maxNodes = 200,
) {
  const runs = mergeRunSnapshots([], records)
  const byId = new Map(runs.map((run) => [run.runId, run]))
  const scope = new Set(scopeRunIds ?? runs.map((run) => run.runId))
  const relevant = latest(dependencies, (edge) => edge.dependencyId).filter(
    (edge) =>
      !scopeRunIds ||
      scope.has(edge.prerequisiteRunId) ||
      scope.has(edge.dependentRunId),
  )
  const limit = Math.max(
    1,
    Math.min(500, Math.floor(Number.isFinite(maxNodes) ? maxNodes : 200)),
  )
  const visible = runs.filter((run) => scope.has(run.runId)).slice(0, limit)
  const shown = new Set(visible.map((run) => run.runId))
  const drawable = relevant.filter(
    (edge) =>
      shown.has(edge.prerequisiteRunId) && shown.has(edge.dependentRunId),
  )
  const adjacent = new Map(visible.map((run) => [run.runId, [] as string[]]))
  const indegree = new Map(visible.map((run) => [run.runId, 0]))
  for (const edge of drawable) {
    adjacent.get(edge.prerequisiteRunId)!.push(edge.dependentRunId)
    indegree.set(edge.dependentRunId, indegree.get(edge.dependentRunId)! + 1)
  }
  const queue = visible
    .filter((run) => indegree.get(run.runId) === 0)
    .map((run) => run.runId)
  const ranks = new Map(visible.map((run) => [run.runId, 0]))
  for (let i = 0; i < queue.length; i++)
    for (const target of adjacent.get(queue[i])!) {
      ranks.set(target, Math.max(ranks.get(target)!, ranks.get(queue[i])! + 1))
      indegree.set(target, indegree.get(target)! - 1)
      if (indegree.get(target) === 0) queue.push(target)
    }
  // Kahn leftovers include cyclic nodes and their downstream dependents. Do not call all of them a cycle.
  const unresolved = new Set(
    visible
      .filter((run) => indegree.get(run.runId)! > 0)
      .map((run) => run.runId),
  )
  const columns = new Map<number, number>()
  const positions = new Map<string, { x: number; y: number }>()
  const connected = new Set(
    drawable.flatMap((edge) => [edge.prerequisiteRunId, edge.dependentRunId]),
  )
  for (const run of visible.filter((run) => connected.has(run.runId))) {
    const rank = unresolved.has(run.runId) ? 0 : ranks.get(run.runId)!
    const row = columns.get(rank) ?? 0
    columns.set(rank, row + 1)
    positions.set(run.runId, { x: rank * 360, y: row * 180 })
  }
  // Keep unrelated runs in a compact secondary grid instead of shrinking a dependency chain to fit one tall column.
  const gridColumns = Math.max(
    3,
    Math.min(5, Math.max(0, ...columns.keys()) + 1),
  )
  const gridStart = Math.max(0, ...columns.values())
  visible
    .filter((run) => !connected.has(run.runId))
    .forEach((run, index) => {
      positions.set(run.runId, {
        x: (index % gridColumns) * 360,
        y: (gridStart + Math.floor(index / gridColumns)) * 180,
      })
    })
  return {
    visible,
    relevant,
    drawable,
    positions,
    unresolved,
    omitted: runs.filter((run) => scope.has(run.runId)).length - visible.length,
    missing: relevant.filter(
      (edge) =>
        !byId.has(edge.prerequisiteRunId) || !byId.has(edge.dependentRunId),
    ),
    outsideScope: relevant.filter(
      (edge) =>
        byId.has(edge.prerequisiteRunId) &&
        byId.has(edge.dependentRunId) &&
        (!scope.has(edge.prerequisiteRunId) || !scope.has(edge.dependentRunId)),
    ),
    byId,
  }
}
function sourceTime(value: string) {
  return /T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ? Date.parse(value) : NaN
}
export type PreparedHistoryPoint = AgentUsageHistoryPoint & {
  time: number
  valid: boolean
}
export function prepareAgentUsageHistory(
  points: readonly AgentUsageHistoryPoint[],
  metric: AgentUsageMetric,
  scopeRunIds?: readonly string[],
) {
  const scope = scopeRunIds && new Set(scopeRunIds)
  const selected = latest(points, (point) => point.pointId).filter(
    (point) => point.metric === metric && (!scope || scope.has(point.runId)),
  )
  const series = new Map<
    string,
    { runId: string; currency?: string; points: PreparedHistoryPoint[] }
  >()
  for (const point of selected) {
    const time = sourceTime(point.timestamp),
      start = sourceTime(point.intervalStart)
    const valid =
      Number.isFinite(time) &&
      Number.isFinite(start) &&
      start <= time &&
      point.value !== undefined &&
      Number.isFinite(point.value) &&
      point.value >= 0 &&
      (metric !== "cost" || Boolean(point.currency))
    const key = JSON.stringify([
      point.runId,
      metric === "cost" ? point.currency : null,
    ])
    if (!series.has(key))
      series.set(key, {
        runId: point.runId,
        currency: point.currency,
        points: [],
      })
    series.get(key)!.points.push({ ...point, time, valid })
  }
  for (const item of series.values())
    item.points.sort(
      (a, b) =>
        (Number.isFinite(a.time) ? a.time : Infinity) -
          (Number.isFinite(b.time) ? b.time : Infinity) ||
        a.pointId.localeCompare(b.pointId),
    )
  return {
    series: [...series.values()],
    count: selected.length,
    invalid: selected.filter(
      (point) => !Number.isFinite(sourceTime(point.timestamp)),
    ).length,
  }
}
/** Gaps and overlapping intervals are separate segments, never interpolated into confirmed usage. */
export function historySegments(points: readonly PreparedHistoryPoint[]) {
  const segments: PreparedHistoryPoint[][] = []
  let segment: PreparedHistoryPoint[] = []
  let previous: PreparedHistoryPoint | undefined
  for (const point of points) {
    if (
      !point.valid ||
      (previous && sourceTime(point.intervalStart) !== previous.time)
    ) {
      if (segment.length) segments.push(segment)
      segment = []
    }
    if (point.valid) segment.push(point)
    else {
      if (segment.length) segments.push(segment)
      segment = []
    }
    previous = point
  }
  if (segment.length) segments.push(segment)
  return segments
}
export function virtualWindow(
  offsets: readonly number[],
  scrollTop: number,
  viewportHeight: number,
  overscan: number,
) {
  const count = Math.max(0, offsets.length - 1)
  function find(y: number) {
    let left = 0,
      right = count
    while (left < right) {
      const mid = (left + right) >>> 1
      if (offsets[mid + 1] <= y) left = mid + 1
      else right = mid
    }
    return left
  }
  return {
    start: Math.max(0, find(scrollTop) - overscan),
    end: Math.min(count, find(scrollTop + viewportHeight) + overscan + 1),
  }
}
