import { useCallback, useSyncExternalStore } from "react"
import type { PreferenceStorage } from "@/features/workspace/store"

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

type Listener = () => void
type DisplaySnapshot = { settings: PmDisplaySettings; storage: PreferenceStorage; dirty: boolean }

/** Cached snapshots keep `useSyncExternalStore` from looping on every read. */
const snapshots = new Map<string, DisplaySnapshot>()
const listeners = new Map<string, Set<Listener>>()
let storageListening = false

function emit(key: string) {
  const set = listeners.get(key)
  if (!set) return
  for (const listener of set) listener()
}

function loadSnapshot(key: string, previous?: DisplaySnapshot): DisplaySnapshot {
  try {
    const storage = getStorage()
    if (!storage) throw new Error("Browser storage unavailable")
    const raw = storage.getItem(key)
    if (!raw) return { settings: pmDisplayDefaults, storage: "available", dirty: false }
    const parsed: unknown = JSON.parse(raw)
    const settings = normalizeSettings(parsed)
    const recovered = typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
      || pmDisplaySettingKeys.some(field => (parsed as Record<string, unknown>)[field] !== settings[field])
    return { settings, storage: recovered ? "recovered" : "available", dirty: false }
  } catch (error) {
    return error instanceof SyntaxError
      ? { settings: pmDisplayDefaults, storage: "recovered", dirty: false }
      : { settings: previous?.settings ?? pmDisplayDefaults, storage: "unavailable", dirty: false }
  }
}

function refreshStoredSnapshot(key: string) {
  const previous = snapshots.get(key)
  // A failed local write remains authoritative in this tab until explicitly
  // saved again. Another tab must not replace it with an older persisted value.
  if (previous?.dirty) return
  snapshots.set(key, loadSnapshot(key, previous))
  emit(key)
}

function ensureStorageListener() {
  if (storageListening || typeof window === "undefined") return
  storageListening = true
  window.addEventListener("storage", (event) => {
    if (event.storageArea && event.storageArea !== getStorage()) return
    if (event.key === null) {
      for (const key of snapshots.keys()) refreshStoredSnapshot(key)
      return
    }
    if (!event.key.startsWith(`${storagePrefix}:`)) return
    refreshStoredSnapshot(event.key)
  })
}

function snapshotFor(workspaceId?: string | null): DisplaySnapshot {
  const key = storageKey(workspaceId)
  const cached = snapshots.get(key)
  if (cached) return cached
  const next = loadSnapshot(key)
  snapshots.set(key, next)
  return next
}

/** Read the current browser-local snapshot, including unpersisted session edits. */
export function readPmDisplaySettings(
  workspaceId?: string | null,
): PmDisplaySettings {
  return snapshotFor(workspaceId).settings
}

/** Persist validated preferences for a workspace and update mounted consumers. */
export function writePmDisplaySettings(
  workspaceId: string | null | undefined,
  settings: PmDisplaySettings,
): void {
  const key = storageKey(workspaceId)
  const next = normalizeSettings(settings)
  let storageStatus: PreferenceStorage = "available"
  try {
    const storage = getStorage()
    if (!storage) throw new Error("Browser storage unavailable")
    storage.setItem(key, JSON.stringify(next))
  } catch {
    storageStatus = "unavailable"
  }
  snapshots.set(key, { settings: next, storage: storageStatus, dirty: storageStatus === "unavailable" })
  emit(key)
}

/** Remove stored preferences for a workspace and restore layout defaults. */
export function resetPmDisplaySettings(workspaceId?: string | null): void {
  const key = storageKey(workspaceId)
  let storageStatus: PreferenceStorage = "available"
  try {
    const storage = getStorage()
    if (!storage) throw new Error("Browser storage unavailable")
    storage.removeItem(key)
  } catch {
    storageStatus = "unavailable"
  }
  snapshots.set(key, { settings: pmDisplayDefaults, storage: storageStatus, dirty: storageStatus === "unavailable" })
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
  const getSnapshot = useCallback(() => snapshotFor(workspaceId).settings, [workspaceId])
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

const getServerStorageSnapshot = (): PreferenceStorage => "unavailable"

/** Read this workspace's persistence status without rereading older storage. */
export function readPmDisplayStorage(workspaceId?: string | null): PreferenceStorage {
  return snapshotFor(workspaceId).storage
}

/** Persistence status for this workspace's layouts, separate from site preferences. */
export function usePmDisplayStorage(workspaceId?: string | null): PreferenceStorage {
  const subscribe = useCallback(
    (onStoreChange: () => void) => subscribePmDisplaySettings(workspaceId, onStoreChange),
    [workspaceId],
  )
  const getSnapshot = useCallback(() => readPmDisplayStorage(workspaceId), [workspaceId])
  return useSyncExternalStore(subscribe, getSnapshot, getServerStorageSnapshot)
}

/** One display preference for a workspace, reactive and cached. */
export function usePmDisplaySetting<K extends PmDisplaySettingKey>(
  workspaceId: string | null | undefined,
  key: K,
): PmDisplaySettings[K] {
  return usePmDisplaySettings(workspaceId)[key]
}
