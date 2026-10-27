import { useI18n } from "@/lib/i18n-provider"
import { usePmControlsReady, usePmNavigation } from "./domain-session"
import { usePmScenarioState } from "./shared"
import { useInboxDomain } from "./inbox-views"
import { useIssueDomain } from "./use-issue-domain"
import { pmClock, type PmPageProps } from "./model"
import { NotificationInboxView } from "./notification-inbox"
import type { ControlledNotification, NotificationInboxInteraction } from "./people-controlled-contracts"
import type { PmControlledData } from "./controlled-contracts"

/** Explicit Showcase source; it is not imported by NotificationInboxView. */
export function NotificationInboxFixture({ scenario }: PmPageProps) {
  const interactive = usePmControlsReady()
  const { locale } = useI18n()
  const { navigate } = usePmNavigation()
  const [domain, setDomain] = useInboxDomain(scenario)
  const [issueDomain] = useIssueDomain(scenario)
  const [state, setState] = usePmScenarioState<NotificationInboxInteraction>("inbox3:controlled", () => ({ selectedId: null, query: "", folder: "inbox", unreadOnly: false, ordering: "newest", unreadFirst: false, showId: true, showStatusIcon: true, listScroll: 0, detailScroll: {} }))
  const [archives, setArchives] = usePmScenarioState<Record<string, string | null>>("inbox3:archives", () => ({}))
  const canWrite = scenario !== "readonly" && scenario !== "loading"
  const all: ControlledNotification[] = domain.notifications.map((notification) => ({ id: notification.id, title: notification.summary[locale], entityName: issueDomain.items.find((issue) => issue.id === notification.issueId)?.titleCopy[locale] ?? null, entityId: notification.issueId, readAt: notification.read ? pmClock : null, archivedAt: archives[notification.id] ?? null, createdAt: notification.at, version: `fixture:${Number(notification.read)}` }))
  const notifications = all.filter((notification) => (state.folder === "archive" ? notification.archivedAt !== null : notification.archivedAt === null) && (!state.unreadOnly || notification.readAt === null) && `${notification.title} ${notification.entityName ?? ""} ${notification.entityId ?? ""}`.toLowerCase().includes(state.query.trim().toLowerCase())).sort((a, b) => state.unreadFirst && (a.readAt === null) !== (b.readAt === null) ? Number(a.readAt !== null) - Number(b.readAt !== null) : a.createdAt.localeCompare(b.createdAt) * (state.ordering === "oldest" ? 1 : -1))
  const data: PmControlledData = { state: scenario === "loading" ? "loading" : scenario === "refresh-error" ? "error" : notifications.length ? "success" : "empty", updatedAt: pmClock, error: scenario === "refresh-error" ? { category: "network", message: locale === "en" ? "Fixture refresh failed" : "Fixture 刷新失败", reason: locale === "en" ? "Existing local notifications remain available." : "保留已有本地通知。" } : undefined }
  return <NotificationInboxView variant="inbox3" interactive={interactive} readModel={{ notifications, selectedNotification: all.find((notification) => notification.id === state.selectedId), data }} interaction={state} capabilities={{ read: () => canWrite, archive: () => canWrite, openEntity: (notification) => !!notification.entityId && scenario !== "loading" }} actions={{ setInteraction: setState, read: (notification) => { if (!canWrite) return; setDomain((previous) => ({ ...previous, notifications: previous.notifications.map((entry) => entry.id === notification.id ? { ...entry, read: !entry.read } : entry) })) }, archive: (notification, archived) => { if (canWrite) setArchives((previous) => ({ ...previous, [notification.id]: archived ? pmClock : null })) }, openEntity: (notification) => { if (notification.entityId) navigate("issue-detail-1", notification.entityId) } }} />
}
