import { useCallback, useSyncExternalStore } from "react"

/**
 * Browser-local display preferences for the real project-management service.
 *
 * These values choose which presentation a page renders. They are not business
 * data: nothing here is written to the backend, and every value is validated
 * against the canonical showcase keys before it is used.
 */

export const dashboardViews = [
  "dashboard1",
  "dashboard2",
  "dashboard3",
  "dashboard4",
] as const
export type DashboardView = (typeof dashboardViews)[number]

export const projectListViews = ["list1", "list2", "list3", "list4"] as const
export type ProjectListView = (typeof projectListViews)[number]

export const projectDetailViews = ["detail1", "detail2"] as const
export type ProjectDetailView = (typeof projectDetailViews)[number]

export const issueShowcaseViews = [
  "list1",
  "list2",
  "board1",
  "board2",
  "board3",
  "calendar1",
  "calendar2",
  "gantt1",
  "spreadsheet1",
] as const
export type IssueShowcaseView = (typeof issueShowcaseViews)[number]

/** Views backed by service-only data that has no showcase counterpart. */
export const issueServiceViews = ["dependencies", "tree"] as const
export type IssueServiceView = (typeof issueServiceViews)[number]

export const issueViews = [
  ...issueShowcaseViews,
  ...issueServiceViews,
] as const
export type IssueView = (typeof issueViews)[number]

export const memberViews = ["member1", "member2", "member3"] as const
export type MemberView = (typeof memberViews)[number]

/** Lab-only team fixtures; formal people tabs are not layout preferences. */
export const teamViews = ["team1", "team2", "team3"] as const

export const notificationViews = ["inbox3", "inbox4"] as const
export type NotificationView = (typeof notificationViews)[number]

/** Collection presentation names used by project-list query selection. */
export const projectListViewAliases = {
  cover: "list1",
  browse: "list2",
  table: "list3",
  compact: "list4",
} as const satisfies Record<string, ProjectListView>

/** Which project collection the canonical project-list views map to. */
export const projectListToCollection = {
  list1: "cover",
  list2: "browse",
  list3: "table",
  list4: "compact",
} as const

export type ProjectListCollection =
  (typeof projectListToCollection)[ProjectListView]

export type PmDisplaySettings = {
  dashboardView: DashboardView
  projectListView: ProjectListView
  projectDetailView: ProjectDetailView
  issueView: IssueView
  memberView: MemberView
  notificationView: NotificationView
}

export const pmDisplayDefaults: PmDisplaySettings = {
  dashboardView: "dashboard1",
  projectListView: "list1",
  projectDetailView: "detail1",
  issueView: "list1",
  memberView: "member1",
  notificationView: "inbox3",
}

export type PmDisplaySettingKey = keyof PmDisplaySettings

export const pmDisplaySettingKeys = [
  "dashboardView",
  "projectListView",
  "projectDetailView",
  "issueView",
  "memberView",
  "notificationView",
] as const satisfies readonly PmDisplaySettingKey[]

/**
 * Resolve a requested presentation against the configured preference.
 * A requested value (or one of its aliases) wins only when it is allowed;
 * otherwise the configured value is used unchanged.
 */
export function resolveVariant<T extends string>(
  requested: string | null | undefined,
  configured: T,
  allowed: readonly T[],
  aliases?: Readonly<Record<string, T>>,
): T {
  if (typeof requested === "string" && requested.length > 0) {
    if (allowed.includes(requested as T)) return requested as T
    const aliased = aliases?.[requested]
    if (aliased && allowed.includes(aliased)) return aliased
  }
  return configured
}

const storagePrefix = "pm.display-settings.v1"

function storageKey(workspaceId?: string | null) {
  return `${storagePrefix}:${workspaceId ?? "default"}`
}

function getStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage
  } catch {
    return null
  }
}

function pick<T extends string>(
  candidate: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof candidate === "string" &&
    (allowed as readonly string[]).includes(candidate)
    ? (candidate as T)
    : fallback
}

/** Validate one stored settings record, falling back field by field. */
function normalizeSettings(value: unknown): PmDisplaySettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return pmDisplayDefaults
  }
  const stored = value as Record<string, unknown>
  return {
    dashboardView: pick(stored.dashboardView, dashboardViews, pmDisplayDefaults.dashboardView),
    projectListView: pick(stored.projectListView, projectListViews, pmDisplayDefaults.projectListView),
    projectDetailView: pick(stored.projectDetailView, projectDetailViews, pmDisplayDefaults.projectDetailView),
    issueView: pick(stored.issueView, issueViews, pmDisplayDefaults.issueView),
    memberView: pick(stored.memberView, memberViews, pmDisplayDefaults.memberView),
    notificationView: pick(stored.notificationView, notificationViews, pmDisplayDefaults.notificationView),
  }
}

function parseStored(raw: string | null): PmDisplaySettings {
  if (!raw) return pmDisplayDefaults
  try {
    return normalizeSettings(JSON.parse(raw))
  } catch {
    return pmDisplayDefaults
  }
}

type Listener = () => void

/** Cached snapshots keep `useSyncExternalStore` from looping on every read. */
const snapshots = new Map<string, PmDisplaySettings>()
const listeners = new Map<string, Set<Listener>>()
let storageListening = false

function emit(key: string) {
  const set = listeners.get(key)
  if (!set) return
  for (const listener of set) listener()
}

function ensureStorageListener() {
  if (storageListening || typeof window === "undefined") return
  storageListening = true
  window.addEventListener("storage", (event) => {
    if (event.key === null) {
      snapshots.clear()
      for (const key of listeners.keys()) emit(key)
      return
    }
    if (!event.key.startsWith(storagePrefix)) return
    snapshots.delete(event.key)
    emit(event.key)
  })
}

function snapshotFor(workspaceId?: string | null): PmDisplaySettings {
  const key = storageKey(workspaceId)
  const cached = snapshots.get(key)
  if (cached) return cached
  const next = parseStored(getStorage()?.getItem(key) ?? null)
  snapshots.set(key, next)
  return next
}

/** Read and validate the stored preferences for a workspace. */
export function readPmDisplaySettings(
  workspaceId?: string | null,
): PmDisplaySettings {
  return parseStored(getStorage()?.getItem(storageKey(workspaceId)) ?? null)
}

/** Persist validated preferences for a workspace and update mounted consumers. */
export function writePmDisplaySettings(
  workspaceId: string | null | undefined,
  settings: PmDisplaySettings,
): void {
  const key = storageKey(workspaceId)
  const next = normalizeSettings(settings)
  try {
    getStorage()?.setItem(key, JSON.stringify(next))
  } catch {
    // Storage can be unavailable (private mode/quota); the in-memory snapshot
    // still keeps the current session consistent.
  }
  snapshots.set(key, next)
  emit(key)
}

/** Remove stored preferences for a workspace and restore showcase defaults. */
export function resetPmDisplaySettings(workspaceId?: string | null): void {
  const key = storageKey(workspaceId)
  try {
    getStorage()?.removeItem(key)
  } catch {
    // Ignore unavailable storage; the in-memory snapshot is still reset.
  }
  snapshots.set(key, pmDisplayDefaults)
  emit(key)
}

/** Subscribe to same-tab writes and cross-tab storage updates. */
export function subscribePmDisplaySettings(
  workspaceId: string | null | undefined,
  listener: Listener,
): () => void {
  ensureStorageListener()
  const key = storageKey(workspaceId)
  let set = listeners.get(key)
  if (!set) {
    set = new Set()
    listeners.set(key, set)
  }
  set.add(listener)
  return () => {
    set.delete(listener)
    if (set.size === 0) listeners.delete(key)
  }
}

const getServerSnapshot = () => pmDisplayDefaults

/** All display preferences for a workspace, reactive and cached. */
export function usePmDisplaySettings(
  workspaceId?: string | null,
): PmDisplaySettings {
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      subscribePmDisplaySettings(workspaceId, onStoreChange),
    [workspaceId],
  )
  const getSnapshot = useCallback(() => snapshotFor(workspaceId), [workspaceId])
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

/** One display preference for a workspace, reactive and cached. */
export function usePmDisplaySetting<K extends PmDisplaySettingKey>(
  workspaceId: string | null | undefined,
  key: K,
): PmDisplaySettings[K] {
  return usePmDisplaySettings(workspaceId)[key]
}
