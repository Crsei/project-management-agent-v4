import type { NotificationInboxItem } from "../../../../../../packages/domain/src/notifications.ts"
import type { FilterCondition } from "../../../lib/filter-model.ts"

export type NotificationInboxFilters = {
  query: string; folder: "inbox" | "archive"; unreadOnly: boolean; ordering: "newest" | "oldest"; unreadFirst: boolean
  conditions?: readonly FilterCondition[] | undefined
}

function notificationTitle(item: NotificationInboxItem) {
  const type = item.event.eventType
  if (type === 'TaskCommentChanged') return '任务评论有更新 / Task comment updated'
  if (item.event.completion === true) return '任务已完成 / Task completed'
  if (type.startsWith('WorkItem:')) {
    const labels: Record<string, string> = { created: '创建 / created', metadata_changed: '属性 / properties', content_changed: '正文 / content', lifecycle_changed: '状态 / lifecycle' }
    const changes = type.slice('WorkItem:'.length).split('+').map(kind => labels[kind] ?? kind).filter(Boolean)
    return `任务变更 / Task changed${changes.length ? ` · ${changes.join('、')}` : ''}`
  }
  return `活动更新 / Activity update · ${type}`
}

export function notificationItem(item: NotificationInboxItem) {
  return {
    id: item.event.eventId, title: notificationTitle(item),
    entityName: `${item.origin === "legacy_activity" ? "历史活动 / Legacy" : "定向通知 / Routed"} · ${item.event.entityKind} ${item.event.entityId} · ${item.reasons.map(reason => ({ watch: "关注 / watching", mention: "提及 / mention", assignee: "负责人 / assignee", requester: "发起人 / requester", completion: "完成 / completion", legacy_activity_state: "历史状态 / legacy state" })[reason] ?? reason).join(" + ")}${item.event.changedFields?.length ? ` · ${item.event.changedFields.join(", ")}` : ""} · ${item.event.origin ?? "来源未知 / source unknown"}`, entityId: item.target?.taskId ?? item.event.entityId,
    readAt: item.state.readAt, archivedAt: item.state.archivedAt, createdAt: item.event.occurredAt ?? item.event.observedAt ?? item.event.recordedAt, version: String(item.state.version),
  }
}

/** Unknown fields and empty value lists never narrow the list; conditions combine with AND, values with OR. */
function matchesNotificationConditions(item: NotificationInboxItem, conditions: readonly FilterCondition[] | undefined) {
  return (conditions ?? []).every(condition => {
    if (!condition.values.length) return true
    if (condition.field !== "category" && condition.field !== "read") return true
    const matched = condition.values.some(value => {
      if (condition.field === "category") return (item.reasons as readonly string[]).includes(value)
      return value === "unread" ? item.state.readAt === null : item.state.readAt !== null
    })
    return condition.operator === "is" ? matched : !matched
  })
}

export function visibleNotifications(items: readonly NotificationInboxItem[], interaction: NotificationInboxFilters) {
  const needle = interaction.query.trim().toLowerCase()
  return items.filter(item => {
    if (interaction.folder === "archive" ? item.state.archivedAt === null : item.state.archivedAt !== null) return false
    if (interaction.unreadOnly && item.state.readAt !== null) return false
    if (!matchesNotificationConditions(item, interaction.conditions)) return false
    return `${item.event.eventType} ${item.event.entityKind} ${item.event.entityId} ${item.reasons.join(" ")}`.toLowerCase().includes(needle)
  }).sort((left, right) => {
    if (interaction.unreadFirst && (left.state.readAt === null) !== (right.state.readAt === null)) return left.state.readAt === null ? -1 : 1
    const time = Date.parse(left.event.occurredAt ?? left.event.observedAt ?? left.event.recordedAt) - Date.parse(right.event.occurredAt ?? right.event.observedAt ?? right.event.recordedAt)
    const order = time || (BigInt(left.cursor) < BigInt(right.cursor) ? -1 : BigInt(left.cursor) > BigInt(right.cursor) ? 1 : 0)
    return interaction.ordering === "oldest" ? order : -order
  }).map(notificationItem)
}
