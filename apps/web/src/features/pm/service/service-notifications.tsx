import { useState } from "react"
import { useLocation, useNavigate, useParams } from "react-router"
import { NotificationInboxView } from "@/views/pm/notification-inbox"
import type { ControlledNotification, NotificationInboxInteraction } from "@/views/pm/people-controlled-contracts"
import { useNotificationInbox, useNotificationStateCommands } from "./pm-notification-hooks"
import { visibleNotifications } from "./notification-inbox-model"
import type { NotificationOrigin } from "../../../../../../packages/domain/src/notifications.ts"
import { CommandNotice, queryData, ServiceGuard, useText } from "./pm-ui"

const defaultInteraction: NotificationInboxInteraction = {
  selectedId: null,
  query: "",
  folder: "inbox",
  unreadOnly: false,
  ordering: "newest",
  unreadFirst: false,
  showId: true,
  showStatusIcon: true,
  listScroll: 0,
  detailScroll: {},
}


export function ServiceNotifications({ variant }: { variant: "inbox3" | "inbox4" }) {
  const { workspaceSlug } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const t = useText()
  const [origin, setOrigin] = useState<NotificationOrigin>("routed")
  const query = useNotificationInbox(origin)
  const stateCommands = useNotificationStateCommands()
  const [interaction, setInteraction] = useState<NotificationInboxInteraction>(defaultInteraction)
  const items = query.data ?? []
  const itemsById = new Map(items.map(item => [item.event.eventId, item]))
  const notifications = visibleNotifications(items, interaction)
  const canChange = (notification: ControlledNotification) => !query.error && !stateCommands.locked && itemsById.has(notification.id)
  const canOpen = (notification: ControlledNotification) => !!itemsById.get(notification.id)?.target
  const openEntity = (notification: ControlledNotification) => {
    const item = itemsById.get(notification.id)
    if (!item?.target || !workspaceSlug) return
    const root = `/pm/${encodeURIComponent(workspaceSlug)}`
    const returnTo = `${location.pathname}${location.search}`
    const project = item.event.projectId ? `/projects/${encodeURIComponent(item.event.projectId)}` : ""
    navigate(`${root}${project}/entities/${encodeURIComponent(item.target.taskId)}?${new URLSearchParams({ returnTo })}${item.target.commentId ? `#comment-${item.target.commentId}` : ""}`, { state: { returnTo } })
  }
  const securityNotice = t(
    "定向通知只含已保存任务的显式关注与本次个人提及；不自动关注、不赋权，不是邮件或完整历史。外部变更仅记录真实观测差异，不补造离线中间版本或作者。",
    "Routed notifications cover explicit task watches and new personal mentions in saved changes. They never subscribe or grant access, are not email or complete history. External changes are observed differences, not reconstructed offline edits or authors.",
  ) + (origin === "legacy_activity" ? t(
    " 旧版只迁入仍保留且曾保存个人状态的活动；从未操作的旧未读及已过期事件不可重建。",
    " Legacy includes only retained activities with previously saved personal state; untouched implicit unread and expired events cannot be reconstructed.",
  ) : "") + (query.processing?.status !== "current" ? t(" 通知采集或路由尚未追平，当前列表不代表完整处理结果。", " Capture or routing is pending or unavailable; this list is not a claim of fully caught-up processing.") : "")
  return (
    <ServiceGuard>
      <NotificationInboxView
        variant={variant}
        interactive
        securityNotice={securityNotice}
        feedback={<><nav aria-label={t("通知来源", "Notification source")} className="flex flex-wrap gap-2"><button type="button" aria-pressed={origin === "routed"} onClick={() => { setOrigin("routed"); setInteraction(defaultInteraction) }}>{t("定向通知", "Routed notifications")}</button><button type="button" aria-pressed={origin === "legacy_activity"} onClick={() => { setOrigin("legacy_activity"); setInteraction(defaultInteraction) }}>{t("历史活动状态", "Legacy activity state")}</button></nav><CommandNotice /></>}
        readModel={{
          notifications,
          data: queryData(query, notifications.length),
          sourceDescription: t(
            "真实本人通知；关注与提及合并为一条。已读/归档独立、显式保存，不改变任务；打开目标不会自动标已读。",
            "Actual personal notifications; watch and mention reasons share one item. Read/archive are independent explicit writes, never task changes. Opening does not mark read.",
          ),
        }}
        interaction={interaction}
        capabilities={{
          read: canChange,
          archive: canChange,
          openEntity: canOpen,
        }}
        actions={{
          setInteraction,
          read: notification => {
            const item = itemsById.get(notification.id)
            if (item && canChange(notification)) stateCommands.enqueue(item, { read: item.state.readAt === null })
          },
          archive: (notification, archived) => {
            const item = itemsById.get(notification.id)
            if (item && canChange(notification)) stateCommands.enqueue(item, { archived })
          },
          openEntity,
        }}
      />
    </ServiceGuard>
  )
}
