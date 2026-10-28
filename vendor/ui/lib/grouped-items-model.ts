import type { DataState } from "./runtime-status"
export type GroupSnapshot = {
  key: string
  label: string
  itemIds: readonly string[]
  loadedCount: number
  totalCount?: number | null
  hasMore?: boolean
  cursor?: string | null
  dataState: DataState
  error?: string
  queryKey: string
}
export type BoardMove = {
  baseRevision?: number
  itemId: string
  sourceGroup: string
  targetGroup: string
  queryKey: string
  beforeId?: string
  afterId?: string
  append?: boolean
}
