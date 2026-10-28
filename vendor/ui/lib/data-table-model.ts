export type DataTableColumnConfig = {
  order?: readonly string[]
  hiddenIds?: readonly string[]
  widths?: Readonly<Record<string, number>>
}
export type ConfigurableColumn = {
  id: string
  minWidth?: number
  maxWidth?: number
  hideable?: boolean
}
export function configuredColumns<T extends ConfigurableColumn>(
  columns: readonly T[],
  config?: DataTableColumnConfig,
): T[] {
  const byId = new Map(columns.map((column) => [column.id, column]))
  if (byId.size !== columns.length)
    throw new Error("Duplicate data table column ID")
  const order = [
    ...new Set([...(config?.order ?? []), ...columns.map((c) => c.id)]),
  ]
  const hidden = new Set(config?.hiddenIds ?? [])
  return order.flatMap((id) => {
    const column = byId.get(id)
    return column && (!hidden.has(id) || column.hideable === false)
      ? [column]
      : []
  })
}
export function columnWidth(
  column: ConfigurableColumn,
  config?: DataTableColumnConfig,
) {
  const value = config?.widths?.[column.id]
  if (value === undefined || !Number.isFinite(value)) return undefined
  const min = Number.isFinite(column.minWidth)
    ? Math.max(44, column.minWidth!)
    : 80
  const max = Number.isFinite(column.maxWidth)
    ? Math.max(min, column.maxWidth!)
    : 640
  return Math.max(min, Math.min(max, value))
}
export type DataTableQuery = {
  scope: string
  filter: string
  sort: { columnId: string; direction: "asc" | "desc" } | null
  page: number
  pageSize: number
  cursor?: string | null
}
export function dataTableQueryKey(query: DataTableQuery) {
  if (
    !Number.isInteger(query.page) ||
    query.page < 1 ||
    !Number.isInteger(query.pageSize) ||
    query.pageSize < 1
  )
    throw new Error("Invalid table page")
  return JSON.stringify([
    query.scope,
    query.filter,
    query.sort?.columnId ?? null,
    query.sort?.direction ?? null,
    query.page,
    query.pageSize,
    query.cursor ?? null,
  ])
}
export type DataTablePage<T> = {
  queryKey: string
  rows: readonly T[]
  total?: number
  hasNext: boolean
  nextCursor?: string | null
}
export type DataTableQuerySnapshot<T> = Partial<DataTablePage<T>> & {
  queryKey: string
  rows: readonly T[]
  state: "loading" | "empty" | "partial" | "error" | "success"
  refreshing: boolean
  error?: string
}
/** Optional read-only adapter; it owns no service, authorization or persistence.
 * Responses must echo their complete query key. A newer request supersedes older
 * promises even if their transport ignores AbortSignal.
 */
export function createDataTableQuerySession<T>({
  errorMessage,
}: {
  errorMessage: string
}) {
  let snapshot: DataTableQuerySnapshot<T> = {
    queryKey: "",
    rows: [],
    state: "empty",
    refreshing: false,
  }
  let generation = 0,
    controller: AbortController | undefined
  const listeners = new Set<() => void>()
  const publish = (next: DataTableQuerySnapshot<T>) => {
    snapshot = next
    listeners.forEach((listener) => listener())
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    async request(
      query: DataTableQuery,
      load: (
        query: DataTableQuery,
        context: { queryKey: string; signal: AbortSignal },
      ) => Promise<DataTablePage<T>>,
    ) {
      const queryKey = dataTableQueryKey(query),
        request = ++generation
      controller?.abort()
      controller = new AbortController()
      const previous =
        snapshot.queryKey === queryKey
          ? snapshot
          : {
              queryKey,
              rows: [] as readonly T[],
              state: "empty" as const,
              refreshing: false,
            }
      publish({
        ...previous,
        state: previous.rows.length ? previous.state : "loading",
        refreshing: !!previous.rows.length,
        error: undefined,
      })
      try {
        const result = await load(query, {
          queryKey,
          signal: controller.signal,
        })
        if (request !== generation) return false
        if (
          result.queryKey !== queryKey ||
          (result.total !== undefined &&
            (!Number.isInteger(result.total) || result.total < 0))
        )
          throw new Error("Invalid table response identity or total")
        publish({
          ...result,
          state: !result.rows.length
            ? "empty"
            : result.hasNext
              ? "partial"
              : "success",
          refreshing: false,
        })
        return true
      } catch {
        if (request !== generation) return false
        publish({
          ...previous,
          state: "error",
          refreshing: false,
          error: errorMessage,
        })
        return false
      }
    },
    dispose() {
      generation++
      controller?.abort()
      listeners.clear()
    },
  }
}
