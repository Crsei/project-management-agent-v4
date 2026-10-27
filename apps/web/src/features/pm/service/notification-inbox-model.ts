import type { NotificationInboxItem } from "../../../../../../packages/domain/src/notifications.ts"

export type NotificationInboxFilters = {
  query: string; folder: "inbox" | "archive"; unreadOnly: boolean; ordering: "newest" | "oldest"; unreadFirst: boolean
}

export function notificationItem(item: NotificationInboxItem) {
  return {
    id: item.event.eventId, title: `${item.event.eventType} · ${item.reasons.join(" + ")}`,
    entityName: `${item.origin === "legacy_activity" ? "历史活动 / Legacy" : "定向通知 / Routed"} · ${item.event.entityKind} ${item.event.entityId}`, entityId: item.target?.taskId ?? item.event.entityId,
    readAt: item.state.readAt, archivedAt: item.state.archivedAt, createdAt: item.event.occurredAt ?? item.event.observedAt ?? item.event.recordedAt, version: String(item.state.version),
  }
}

export function visibleNotifications(items: readonly NotificationInboxItem[], interaction: NotificationInboxFilters) {
  const needle = interaction.query.trim().toLowerCase()
  return items.filter(item => {
    if (interaction.folder === "archive" ? item.state.archivedAt === null : item.state.archivedAt !== null) return false
    if (interaction.unreadOnly && item.state.readAt !== null) return false
    return `${item.event.eventType} ${item.event.entityKind} ${item.event.entityId} ${item.reasons.join(" ")}`.toLowerCase().includes(needle)
  }).sort((left, right) => {
    if (interaction.unreadFirst && (left.state.readAt === null) !== (right.state.readAt === null)) return left.state.readAt === null ? -1 : 1
    const time = Date.parse(left.event.occurredAt ?? left.event.observedAt ?? left.event.recordedAt) - Date.parse(right.event.occurredAt ?? right.event.observedAt ?? right.event.recordedAt)
    const order = time || (BigInt(left.cursor) < BigInt(right.cursor) ? -1 : BigInt(left.cursor) > BigInt(right.cursor) ? 1 : 0)
    return interaction.ordering === "oldest" ? order : -order
  }).map(notificationItem)
}
