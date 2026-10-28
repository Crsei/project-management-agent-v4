import type {
  GroupSnapshot,
  MoveIntent,
  MutationState,
  WorkItemCapabilities,
  WorkItemCatalog,
  WorkItemRecord,
  WorkItemsViewState,
} from "./work-items-model"
import { normalizeTimeline, normalizeCalendar } from "./schedule-view-model"
import { isMutationLocked } from "./work-items-model"

/** Optional local helper. Never use a loaded page to infer remote totals. */
export function selectWorkItems(
  items: readonly WorkItemRecord[],
  view: WorkItemsViewState,
) {
  const q = view.query.trim().toLocaleLowerCase()
  const f = view.filters
  const matches = (wanted: readonly string[], actual: readonly string[]) =>
    !wanted.length || wanted.some((id) => actual.includes(id))
  const result = items.filter(
    (item) =>
      (!q ||
        `${item.identifier} ${item.title}`.toLocaleLowerCase().includes(q)) &&
      matches(f.state, [item.stateId]) &&
      matches(f.priority, [item.priorityId]) &&
      matches(f.assignees, item.assigneeIds) &&
      matches(f.labels, item.labelIds),
  )
  if (view.sort === "manual") return result
  const key = (item: WorkItemRecord) =>
    view.sort === "dueDate"
      ? (item.dueDate ?? "9999-99-99")
      : view.sort === "priority"
        ? item.priorityId
        : item.title
  return result.sort(
    (a, b) =>
      (key(a).localeCompare(key(b)) || a.id.localeCompare(b.id)) *
      (view.sortDirection === "desc" ? -1 : 1),
  )
}
export function groupWorkItems(
  items: readonly WorkItemRecord[],
  catalog: WorkItemCatalog,
  view: WorkItemsViewState,
  queryKey: string,
): GroupSnapshot[] {
  const options = view.groupBy === "state" ? catalog.states : catalog.priorities
  const buckets = new Map<string, string[]>()
  const seen = new Set<string>()
  for (const item of items) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    const key = view.groupBy === "state" ? item.stateId : item.priorityId
    const bucket = buckets.get(key) ?? []
    bucket.push(item.id)
    buckets.set(key, bucket)
  }
  return options
    .map((option) => {
      const itemIds = buckets.get(option.id) ?? []
      return {
        key: option.id,
        label: option.label,
        itemIds,
        loadedCount: itemIds.length,
        totalCount: itemIds.length,
        dataState: itemIds.length ? ("success" as const) : ("empty" as const),
        queryKey,
      }
    })
    .filter((group) => view.showEmptyGroups || group.itemIds.length)
}
/** Keeps authority order, deduplicates IDs, and discards late pages. */
export function mergeGroupPage(current: GroupSnapshot, page: GroupSnapshot) {
  if (current.queryKey !== page.queryKey || current.key !== page.key)
    return current
  const itemIds = [...new Set([...current.itemIds, ...page.itemIds])]
  return { ...page, itemIds, loadedCount: itemIds.length }
}
export type MoveContext = {
  items: readonly WorkItemRecord[]
  groups: readonly GroupSnapshot[]
  groupBy: WorkItemsViewState["groupBy"]
  sort: WorkItemsViewState["sort"]
  queryKey: string
  capabilities: WorkItemCapabilities
  mutations?: Readonly<Record<string, MutationState | undefined>>
  allowAppend?: boolean
}
export function validateMove(
  intent: MoveIntent,
  context: MoveContext,
): string | null {
  const item = context.items.find((item) => item.id === intent.itemId)
  const source = context.groups.find(
    (group) => group.key === intent.sourceGroup,
  )
  const target = context.groups.find(
    (group) => group.key === intent.targetGroup,
  )
  if (
    !item ||
    !source ||
    !target ||
    intent.queryKey !== context.queryKey ||
    source.queryKey !== intent.queryKey ||
    target.queryKey !== intent.queryKey
  )
    return "stale"
  if (
    item.revision !== intent.baseRevision ||
    (context.groupBy === "state" ? item.stateId : item.priorityId) !==
      intent.sourceGroup
  )
    return "conflict"
  if (
    !context.capabilities.canMove(item, intent.targetGroup) ||
    isMutationLocked(context.mutations?.[item.id])
  )
    return "locked"
  if (context.sort !== "manual" && intent.sourceGroup === intent.targetGroup)
    return "automatic"
  if (intent.beforeId === item.id || intent.afterId === item.id)
    return "boundary"
  if (intent.beforeId && !target.itemIds.includes(intent.beforeId))
    return "boundary"
  if (intent.afterId && !target.itemIds.includes(intent.afterId))
    return "boundary"
  if (intent.beforeId && intent.afterId) {
    const ids = target.itemIds.filter((id) => id !== item.id)
    if (ids.indexOf(intent.beforeId) !== ids.indexOf(intent.afterId) + 1)
      return "boundary"
  }
  if (intent.append && !context.allowAppend) return "boundary"
  if (
    context.sort === "manual" &&
    !intent.beforeId &&
    !intent.afterId &&
    target.hasMore &&
    !intent.append
  )
    return "boundary"
  return null
}
/** Local fixture command only. Services must use their own ordering and revisions. */
export function applyLocalMove(
  items: readonly WorkItemRecord[],
  intent: MoveIntent,
  groupBy: WorkItemsViewState["groupBy"],
) {
  const item = items.find((item) => item.id === intent.itemId)
  if (!item) return [...items]
  const next = items.filter((item) => item.id !== intent.itemId)
  const moved = {
    ...item,
    [groupBy === "state" ? "stateId" : "priorityId"]: intent.targetGroup,
    revision: item.revision + 1,
  }
  const before = intent.beforeId
    ? next.findIndex((item) => item.id === intent.beforeId)
    : -1
  const after = intent.afterId
    ? next.findIndex((item) => item.id === intent.afterId)
    : -1
  next.splice(
    before >= 0 ? before : after >= 0 ? after + 1 : next.length,
    0,
    moved,
  )
  return next
}

/** Local complete-fixture helper, not a remote grouping/pagination implementation. */
export function groupWorkItemLanes(
  items: readonly WorkItemRecord[],
  catalog: WorkItemCatalog,
  view: WorkItemsViewState,
  queryKey: string,
): import("./work-items-model").WorkItemsLaneSnapshot[] {
  const axis = view.subGroupBy
  if (!axis || axis === "none" || axis === view.groupBy) return []
  const options = axis === "state" ? catalog.states : catalog.priorities
  const buckets = new Map<string, WorkItemRecord[]>()
  for (const item of items) {
    const key = axis === "state" ? item.stateId : item.priorityId
    const bucket = buckets.get(key) ?? []
    bucket.push(item)
    buckets.set(key, bucket)
  }
  return options
    .map((option) => ({
      key: option.id,
      label: option.label,
      groups: groupWorkItems(
        buckets.get(option.id) ?? [],
        catalog,
        view,
        queryKey,
      ),
    }))
    .filter(
      (lane) =>
        view.showEmptyGroups || lane.groups.some((g) => g.itemIds.length),
    )
}
/** Linear index; malformed cycles/orphans become accessible roots, never infinite recursion. */
export function indexWorkItemHierarchy(items: readonly WorkItemRecord[]) {
  const byId = new Map(items.map((item) => [item.id, item]))
  const parentById = new Map<string, string>()
  for (const item of byId.values()) {
    const parent = item.parentId ? byId.get(item.parentId) : undefined
    if (parent && parent.id !== item.id && parent.projectId === item.projectId)
      parentById.set(item.id, parent.id)
  }
  const visited = new Set<string>()
  for (const id of byId.keys()) {
    const path = new Set<string>()
    let current: string | undefined = id
    while (current && !visited.has(current)) {
      if (path.has(current)) {
        parentById.delete(current)
        break
      }
      path.add(current)
      current = parentById.get(current)
    }
    for (const step of path) visited.add(step)
  }
  const childrenById = new Map<string, WorkItemRecord[]>()
  for (const item of byId.values()) {
    const parent = parentById.get(item.id)
    if (!parent) continue
    const children = childrenById.get(parent) ?? []
    children.push(item)
    childrenById.set(parent, children)
  }
  return { byId, parentById, childrenById }
}
export function hierarchyVisibleIds(
  rootIds: readonly string[],
  items: readonly WorkItemRecord[],
  expandedIds: readonly string[],
) {
  const index = indexWorkItemHierarchy(items)
  const expanded = new Set(expandedIds)
  const result = new Set<string>()
  const pending = [...rootIds]
    .filter((id) => !index.parentById.has(id))
    .reverse()
  while (pending.length) {
    const id = pending.pop()!
    if (result.has(id)) continue
    result.add(id)
    if (expanded.has(id))
      for (const child of [...(index.childrenById.get(id) ?? [])].reverse())
        pending.push(child.id)
  }
  return result
}

/** Migrate pre-schedule saved configurations without changing their group preferences. */
export function normalizeWorkItemsView(
  view: WorkItemsViewState,
): WorkItemsViewState {
  return {
    ...view,
    layout: ["list", "board", "table", "timeline", "calendar"].includes(
      view.layout,
    )
      ? view.layout
      : "list",
    timeline: normalizeTimeline(view.timeline),
    calendar: normalizeCalendar(view.calendar),
  }
}
