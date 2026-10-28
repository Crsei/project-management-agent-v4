import { analyticsEntityKey, type AnalyticsEntityRef } from "./analytics-model"
export type ResourceAllocation = {
  id: string
  entityRef: AnalyticsEntityRef
  title: string
  bucketId: string
  resourceId: string
  amount: number | null
  unit: string
  share: number
  rule: string
}
export type ResourceCapacity = {
  resourceId: string
  bucketId: string
  available: number | null
  unit: string
  calendarVersion: string
}
export type WorkloadCell = {
  id: string
  resourceId: string
  bucketId: string
  unit: string
  allocated: number | null
  capacity: number | null
  utilization: number | null
  state: "known" | "unknown" | "unavailable"
  unknownCount: number
  allocations: readonly ResourceAllocation[]
  calendarVersion: string | null
}
/** Explicit allocation shares, never an inferred division by assignee count. */
export function computeWorkload(
  allocations: readonly ResourceAllocation[],
  capacities: readonly ResourceCapacity[],
  unit: string,
): WorkloadCell[] {
  const seen = new Set<string>(),
    shares = new Map<string, number>(),
    groups = new Map<string, ResourceAllocation[]>()
  for (const a of allocations) {
    if (seen.has(a.id)) throw new Error("Duplicate allocation identity")
    seen.add(a.id)
    if (
      a.unit !== unit ||
      !a.rule ||
      !Number.isFinite(a.share) ||
      a.share < 0 ||
      a.share > 1 ||
      (a.amount !== null && (!Number.isFinite(a.amount) || a.amount < 0))
    )
      throw new Error("Invalid allocation unit, share or amount")
    const task = JSON.stringify([analyticsEntityKey(a.entityRef), a.bucketId])
    shares.set(task, (shares.get(task) ?? 0) + a.share)
    if (shares.get(task)! > 1 + 1e-9)
      throw new Error("Allocation shares exceed one")
    const key = JSON.stringify([a.resourceId, a.bucketId])
    groups.set(key, [...(groups.get(key) ?? []), a])
  }
  const capacityMap = new Map<string, ResourceCapacity>()
  for (const c of capacities) {
    const key = JSON.stringify([c.resourceId, c.bucketId])
    if (
      capacityMap.has(key) ||
      c.unit !== unit ||
      (c.available !== null &&
        (!Number.isFinite(c.available) || c.available < 0))
    )
      throw new Error("Invalid capacity snapshot")
    capacityMap.set(key, c)
    if (!groups.has(key)) groups.set(key, [])
  }
  return [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, items]) => {
      const [resourceId, bucketId] = JSON.parse(id) as [string, string],
        c = capacityMap.get(id),
        unknownCount = items.filter((a) => a.amount === null).length
      const allocated = unknownCount
          ? null
          : items.reduce((s, a) => s + a.amount! * a.share, 0),
        capacity = c?.available ?? null
      return {
        id,
        resourceId,
        bucketId,
        unit,
        allocated,
        capacity,
        utilization:
          allocated !== null && capacity !== null && capacity > 0
            ? allocated / capacity
            : null,
        state:
          capacity === 0
            ? "unavailable"
            : allocated === null || capacity === null
              ? "unknown"
              : "known",
        unknownCount,
        allocations: items,
        calendarVersion: c?.calendarVersion ?? null,
      }
    })
}
export type ExecutionInterval = {
  id: string
  entityRef: AnalyticsEntityRef
  agentId: string
  label: string
  startedAt: string | null
  endedAt: string | null
  asOf: string
  runtimeStatus: string
  waitingReason?: string
  acceptance: "pending" | "accepted" | "rejected" | "unknown"
}
export function executionGeometry(
  records: readonly ExecutionInterval[],
  range: { from: string; to: string },
) {
  const from = Date.parse(range.from),
    to = Date.parse(range.to)
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to)
    throw new Error("Invalid execution range")
  const seen = new Set<string>()
  return records.map((record) => {
    const key = analyticsEntityKey(record.entityRef)
    if (seen.has(key)) throw new Error("Duplicate execution identity")
    seen.add(key)
    const start =
        record.startedAt === null ? NaN : Date.parse(record.startedAt),
      end = Date.parse(record.endedAt ?? record.asOf)
    const valid = Number.isFinite(start) && Number.isFinite(end) && start <= end
    return {
      record,
      valid,
      visible: valid && end >= from && start < to,
      left: valid ? Math.max(0, (start - from) / (to - from)) * 100 : 0,
      width: valid
        ? Math.max(
            0,
            (Math.min(end, to) - Math.max(start, from)) / (to - from),
          ) * 100
        : 0,
      durationMs: valid ? end - start : null,
      ongoing: record.endedAt === null,
    }
  })
}
