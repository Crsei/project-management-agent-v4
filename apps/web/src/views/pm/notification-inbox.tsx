import { useLayoutEffect, useRef, type ReactNode } from "react"
import { Archive, Bell, Check, CheckCheck, Circle, Inbox, ListFilter, MoreHorizontal, SlidersHorizontal } from "lucide-react"
import { Avatar } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { DataRegion } from "@/components/ui/data-region"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu"
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { FilterCard } from "@/components/blocks/filter-card"
import type { FilterCondition, FilterField } from "@/lib/filter-model"
import { useI18n } from "@/lib/i18n-provider"
import { PmPage, PmSearch } from "./presentation-page"
import { ControlledFeedback, ControlledFocus } from "./controlled-presentation"
import type { ControlledNotification, NotificationInboxViewProps } from "./people-controlled-contracts"
import { InboxCollectionBody } from "./inbox-collection-body"
import styles from "./inbox.module.css"

/** Controlled pane scrolling is independent of fixture session caches. */
function NotificationScroll({ position, onPositionChange, children, className, label }: { position: number; onPositionChange: (position: number) => void; children: ReactNode; className?: string; label: string }) {
  const element = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => { if (element.current && Math.abs(element.current.scrollTop - position) > 1) element.current.scrollTop = position }, [position])
  return <div ref={element} className={`${styles.paneBody} ${styles.paneBodyList} ${className ?? ""}`} tabIndex={0} aria-label={label} onScroll={(event) => onPositionChange(event.currentTarget.scrollTop)}>{children}</div>
}

function notificationActions(notification: ControlledNotification, { capabilities, actions }: NotificationInboxViewProps, text: (zh: string, en: string) => string) {
  const canOpen = !!notification.entityId && capabilities.openEntity(notification)
  const canRead = capabilities.read(notification)
  const canArchive = capabilities.archive(notification)
  const lockedReason = text("通知读取失败，或有待完成、待核对的状态请求。", "Notification reading failed, or a state request is pending or awaiting reconciliation.")
  return {
    open: {
      id: "open", label: text("打开关联对象", "Open linked entity"), disabled: !canOpen,
      reason: !canOpen ? text("未提供可定位且可访问的关联对象。", "No locatable, accessible linked entity is available.") : undefined,
      run: () => { if (notification.entityId && capabilities.openEntity(notification)) actions.openEntity(notification) },
    },
    read: {
      id: "read", label: notification.readAt === null ? text("标为已读", "Mark as read") : text("标为未读", "Mark as unread"), disabled: !canRead,
      reason: !canRead ? lockedReason : undefined,
      run: () => { if (capabilities.read(notification)) actions.read(notification) },
    },
    archive: {
      id: "archive", label: notification.archivedAt === null ? text("归档通知", "Archive notification") : text("移回收件箱", "Return to inbox"), disabled: !canArchive,
      reason: !canArchive ? lockedReason : undefined,
      run: () => { if (capabilities.archive(notification)) actions.archive(notification, notification.archivedAt === null) },
    },
  }
}

function NotificationRow({ notification, surface, onDetail }: { notification: ControlledNotification; surface: NotificationInboxViewProps; onDetail: (trigger: HTMLElement) => void }) {
  const { locale } = useI18n()
  const text = (zh: string, en: string) => locale === "en" ? en : zh
  const { interaction: state, variant } = surface
  const rowActions = notificationActions(notification, surface, text)
  const items = Object.values(rowActions)
  return <ContextMenu>
    <ContextMenuTrigger asChild>
      <div role="listitem" tabIndex={0} aria-label={`${notification.title} · ${notification.entityName ?? ""}`} className={styles.notificationRow} data-inline-actions={variant === "inbox4"}>
        <button id={`pm-notification-${notification.id}`} type="button" data-notification-id={notification.id} className={styles.listButton} data-selected={state.selectedId === notification.id} data-unread={notification.readAt === null} aria-pressed={state.selectedId === notification.id} aria-label={`${notification.title} · ${notification.entityName ?? ""} · ${notification.createdAt}`} onClick={event => onDetail(event.currentTarget)}>
          <Avatar name={notification.entityName ?? notification.title} size={32} />
          <span className="min-w-0 flex-1">
            <span className={styles.rowTop}><span className={styles.subject} title={notification.title}>{notification.readAt === null && <span className={styles.notificationUnreadDot} role="img" aria-label={text("未读", "Unread")} />}{notification.title}</span><time className={styles.time} dateTime={notification.createdAt}>{new Date(notification.createdAt).toLocaleDateString(locale)}</time></span>
            <span className={styles.preview}>{notification.entityName ?? text("关联对象未提供", "Linked entity unavailable")}{state.showId && notification.entityId ? ` · ${notification.entityId}` : ""}</span>
          </span>
          {state.showStatusIcon && <span role="img" aria-label={notification.readAt !== null ? text("通知已读", "Notification read") : text("通知未读", "Notification unread")}>{notification.readAt !== null ? <Check size={14} aria-hidden="true" /> : <Circle size={14} aria-hidden="true" />}</span>}
        </button>
        <span className={styles.rowActions}>
          {variant === "inbox4" && <>
            <Button variant="ghost" size="icon" aria-label={`${rowActions.read.label}：${notification.title}`} title={rowActions.read.reason} disabled={rowActions.read.disabled} onClick={rowActions.read.run}><Check size={16} aria-hidden="true" /></Button>
            <Button variant="ghost" size="icon" aria-label={`${rowActions.archive.label}：${notification.title}`} title={rowActions.archive.reason} disabled={rowActions.archive.disabled} onClick={rowActions.archive.run}><Archive size={16} aria-hidden="true" /></Button>
          </>}
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label={text(`通知操作：${notification.title}`, `Notification actions: ${notification.title}`)} />}><MoreHorizontal size={16} aria-hidden="true" /></DropdownMenuTrigger>
            <DropdownMenuContent align="end">{items.map(action => <DropdownMenuItem key={action.id} disabled={action.disabled} title={action.reason} onSelect={action.run}>{action.label}</DropdownMenuItem>)}</DropdownMenuContent>
          </DropdownMenu>
        </span>
      </div>
    </ContextMenuTrigger>
    <ContextMenuContent>{items.map(action => <ContextMenuItem key={action.id} disabled={action.disabled} title={action.reason} onSelect={action.run}>{action.label}</ContextMenuItem>)}</ContextMenuContent>
  </ContextMenu>
}
export function NotificationInboxView(props: NotificationInboxViewProps) {
  const { locale } = useI18n()
  const text = (zh: string, en: string) => locale === "en" ? en : zh
  const { variant, readModel: model, interaction: state, capabilities, actions } = props
  const hasSnapshot = model.notifications.length > 0 || !!model.data.updatedAt || model.data.state === "success" || model.data.state === "empty" || model.data.state === "partial"
  const countUnavailable = model.data.state === "loading" ? text("正在读取通知…", "Loading notifications…") : text("通知数量不可用", "Notification count unavailable")
  const data: typeof model.data = { ...model.data, state: (model.data.state ?? "success") === "success" && !model.notifications.length ? "empty" : model.data.state }
  const selected = model.selectedNotification ?? model.notifications.find((notification) => notification.id === state.selectedId)
  const unread = model.notifications.filter((notification) => notification.readAt === null)
  const detailTrigger = useRef<HTMLElement | null>(null)
  const display = <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label={text("显示选项", "Display options")} />}><SlidersHorizontal aria-hidden="true" size={16} /></DropdownMenuTrigger><DropdownMenuContent align="end" className="w-64"><DropdownMenuGroup><DropdownMenuLabel>{text("排序", "Ordering")}</DropdownMenuLabel>{(["newest", "oldest"] as const).map((ordering) => <DropdownMenuCheckboxItem key={ordering} checked={state.ordering === ordering} closeOnClick={false} onCheckedChange={() => actions.setInteraction((previous) => ({ ...previous, ordering }))}>{ordering === "newest" ? text("最新", "Newest") : text("最早", "Oldest")}</DropdownMenuCheckboxItem>)}</DropdownMenuGroup><DropdownMenuSeparator /><DropdownMenuCheckboxItem checked={state.unreadFirst} closeOnClick={false} onCheckedChange={(unreadFirst) => actions.setInteraction((previous) => ({ ...previous, unreadFirst }))}>{text("未读优先", "Unread first")}</DropdownMenuCheckboxItem><DropdownMenuSeparator /><DropdownMenuCheckboxItem checked={state.folder === "archive"} closeOnClick={false} onCheckedChange={(archived) => actions.setInteraction((previous) => ({ ...previous, folder: archived ? "archive" : "inbox", selectedId: null }))}>{text("显示归档", "Show archived")}</DropdownMenuCheckboxItem><DropdownMenuCheckboxItem checked={state.showId} closeOnClick={false} onCheckedChange={(showId) => actions.setInteraction((previous) => ({ ...previous, showId }))}>{text("对象 ID", "Entity ID")}</DropdownMenuCheckboxItem><DropdownMenuCheckboxItem checked={state.showStatusIcon} closeOnClick={false} onCheckedChange={(showStatusIcon) => actions.setInteraction((previous) => ({ ...previous, showStatusIcon }))}>{text("已读状态图标（非任务状态）", "Read-status icon (not task state)")}</DropdownMenuCheckboxItem></DropdownMenuContent></DropdownMenu>
  const conditions: readonly FilterCondition[] = state.conditions ?? []
  const activeConditions = conditions.filter((condition) => condition.values.length > 0).length
  const filterFields: readonly FilterField[] = [
    { id: "category", label: text("分类", "Category"), options: [
      { value: "watch", label: text("任务关注", "Task watch") },
      { value: "mention", label: text("个人提及", "Personal mention") },
      { value: "assignee", label: text("任务负责人", "Task assignee") },
      { value: "requester", label: text("任务发起人", "Task requester") },
      { value: "completion", label: text("任务完成", "Task completion") },
      { value: "legacy_activity_state", label: text("历史活动", "Legacy activity") },
    ] },
    { id: "read", label: text("阅读状态", "Read state"), options: [
      { value: "unread", label: text("未读", "Unread") },
      { value: "read", label: text("已读", "Read") },
    ] },
  ]
  const filterControl = <Popover><PopoverTrigger render={<Button variant="ghost" size="icon" className="relative" aria-label={text(`筛选通知，已启用 ${activeConditions} 个条件`, `Filter notifications, ${activeConditions} active`)} aria-pressed={activeConditions > 0} />}><ListFilter size={16} aria-hidden="true" />{activeConditions > 0 && <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-foreground px-1 text-center text-[10px] font-medium leading-4 text-background">{activeConditions}</span>}</PopoverTrigger><PopoverContent align="end" className="w-80 max-w-[calc(100vw-2rem)]" aria-label={text("通知筛选", "Notification filters")}><FilterCard title={text("筛选通知", "Filter notifications")} fields={filterFields} conditions={conditions} onChange={(next) => actions.setInteraction((previous) => ({ ...previous, conditions: next }))} emptyHint={text("尚未添加条件；列表显示全部匹配搜索的通知。", "No conditions yet; every notification matching search is listed.")} addLabel={text("添加条件", "Add condition")} clearLabel={text("清除", "Clear")} whereLabel={text("条件", "Where")} andLabel={text("且", "and")} anyLabel={text("任意", "Any")} removeLabel={text("删除条件", "Remove condition")} /></PopoverContent></Popover>
  const detail = (notification: ControlledNotification) => {
    const detailActions = notificationActions(notification, props, text)
    return <section className={styles.detailFill} data-inbox-detail aria-label={text("通知详情", "Notification detail")}>
      <div className={styles.paneHeader}>
        <span className="min-w-0 truncate text-sm font-medium" title={notification.entityName ?? undefined}>{notification.entityName ?? text("通知", "Notification")}</span>
        <Button variant="outline" size="sm" title={detailActions.read.reason} disabled={detailActions.read.disabled} onClick={detailActions.read.run}>{detailActions.read.label}</Button>
        <Button variant="ghost" size="icon" aria-label={detailActions.archive.label} title={detailActions.archive.reason} disabled={detailActions.archive.disabled} onClick={detailActions.archive.run}><Archive size={16} aria-hidden="true" /></Button>
      </div>
      <NotificationScroll key={notification.id} position={state.detailScroll[notification.id] ?? 0} onPositionChange={(position) => actions.setInteraction((previous) => ({ ...previous, detailScroll: { ...previous.detailScroll, [notification.id]: position } }))} className={styles.detailBody} label={text("通知详情阅读区域", "Notification reading area")}>
        <p className="text-xs text-muted-foreground"><time dateTime={notification.createdAt}>{notification.createdAt}</time></p>
        <h2 className="break-words font-semibold" data-inbox-issue-title>{notification.title}</h2>
        <dl className="mt-6 grid gap-4 text-sm">
          <div><dt className="text-xs text-muted-foreground">{text("关联对象", "Linked entity")}</dt><dd className="break-words">{notification.entityName ?? "—"}</dd></div>
          {state.showId && <div><dt className="text-xs text-muted-foreground">{text("对象 ID", "Entity ID")}</dt><dd className="break-all">{notification.entityId ?? "—"}</dd></div>}
          <div><dt className="text-xs text-muted-foreground">{text("已读时间", "Read at")}</dt><dd>{notification.readAt ?? text("未读", "Unread")}</dd></div>
          <div><dt className="text-xs text-muted-foreground">{text("归档时间", "Archived at")}</dt><dd>{notification.archivedAt ?? text("未归档", "Not archived")}</dd></div>
        </dl>
        <p className="mt-6 text-xs text-muted-foreground">{text("通知状态独立于任务状态。此处不是邮件或客服会话。", "Notification state is independent of task workflow. This is not an email or support thread.")}</p>
        <Button className="mt-4" variant="outline" title={detailActions.open.reason} disabled={detailActions.open.disabled} onClick={detailActions.open.run}>{detailActions.open.label}</Button>
        {detailActions.open.disabled && <p className="mt-2 text-xs text-muted-foreground">{text("宿主未提供可定位且可访问的关联对象，不能打开；通知本身仍可阅读。", "The host has not provided a locatable, accessible linked entity; this notification remains readable.")}</p>}
      </NotificationScroll>
    </section>
  }
  const notificationRows = <NotificationScroll position={state.listScroll} onPositionChange={(listScroll) => actions.setInteraction((previous) => ({ ...previous, listScroll }))} label={text("通知列表滚动区域", "Notification list scroll area")}>
    <DataRegion {...data} hasContent={model.notifications.length > 0} state={data.state} emptyDescription={model.data.emptyDescription ?? text("当前筛选没有通知。", "No notifications match the current filters.")}>
      <div role="list" aria-label={text("通知", "Notifications")}>{model.notifications.map(notification => <NotificationRow key={notification.id} notification={notification} surface={props} onDetail={trigger => { detailTrigger.current = trigger; actions.setInteraction(previous => ({ ...previous, selectedId: notification.id })) }} />)}</div>
    </DataRegion>
  </NotificationScroll>
  const list = <section className={styles.paneFill} data-inbox-list aria-label={text("通知列表", "Notification list")}><div className={styles.paneHeader} data-inbox-owned-header><h2 className="text-sm font-medium" data-inbox-owned-title>{state.folder === "archive" ? text("归档", "Archive") : text("收件箱", "Inbox")}</h2><span className="text-xs text-muted-foreground">{hasSnapshot ? text(`${unread.length} 条本页未读`, `${unread.length} unread on this page`) : countUnavailable}</span><Button variant="ghost" size="icon-sm" aria-label={text("本页可操作通知标为已读", "Mark actionable notifications on this page as read")} disabled={!unread.some(capabilities.read)} onClick={() => { for (const notification of unread) if (capabilities.read(notification)) actions.read(notification) }}><CheckCheck aria-hidden="true" size={16} /></Button>{filterControl}{display}</div><div className="shrink-0 border-b p-2"><PmSearch value={state.query} onChange={(query) => actions.setInteraction((previous) => ({ ...previous, query }))} label={text("搜索通知", "Search notifications")} /></div>{notificationRows}</section>
  const folders = <nav className={styles.projectFolders} aria-label={text("通知文件夹", "Notification folders")}><div className={styles.projectBrand}><span className={styles.projectBrandIcon}><Bell size={20} aria-hidden="true" /></span><span>{text("通知", "Notifications")}<small>{text("非外部邮件", "Not external email")}</small></span></div><div className={styles.folderList}>{(["inbox", "archive"] as const).map((folder) => <button type="button" key={folder} className={styles.folderButton} data-active={state.folder === folder} aria-pressed={state.folder === folder} onClick={() => actions.setInteraction((previous) => ({ ...previous, folder, selectedId: null }))}><span className="inline-flex items-center gap-2">{folder === "inbox" ? <Inbox size={16} aria-hidden="true" /> : <Archive size={16} aria-hidden="true" />}{folder === "inbox" ? text("收件箱", "Inbox") : text("归档", "Archive")}</span></button>)}</div></nav>
  return <ControlledFocus surface={props}><PmPage interactive={props.interactive} pageId={`pm-${variant === "inbox3" ? "inbox-3" : "inbox-4"}`} className={styles.inboxPage} headerMode="hidden" title={text("通知", "Notifications")} sidebar={variant === "inbox3" ? list : folders}>{(props.securityNotice || props.pendingRequestId || props.feedback) && <div className={styles.notificationFeedback} data-pm-inbox-feedback><ControlledFeedback surface={props} /></div>}{variant === "inbox3" ? selected ? detail(selected) : <div className="p-6 text-sm text-muted-foreground">{text("选择通知以查看详情。", "Select a notification to view its details.")}</div> : <InboxCollectionBody title={state.folder === "archive" ? text("归档通知", "Archived notifications") : text("通知收件箱", "Notification inbox")} description={hasSnapshot ? text(`${model.notifications.length} 条本页通知`, `${model.notifications.length} notifications on this page`) : countUnavailable} actions={<div className="flex items-center gap-1">{filterControl}{display}</div>} search={<PmSearch value={state.query} onChange={(query) => actions.setInteraction((previous) => ({ ...previous, query }))} label={text("搜索通知", "Search notifications")} />}>{notificationRows}<Dialog open={!!selected} onOpenChange={(open) => { if (!open) actions.setInteraction((previous) => ({ ...previous, selectedId: null })) }}><DialogContent className="max-w-2xl" finalFocus={() => detailTrigger.current ?? (props.focusId ? document.getElementById(props.focusId) : null)}><DialogTitle>{text("通知详情", "Notification detail")}</DialogTitle><DialogDescription>{model.sourceDescription ?? text("通知不是邮件或客服会话。", "Notifications are not email or support threads.")}</DialogDescription><DialogBody className="h-[min(65dvh,640px)] p-0">{selected && detail(selected)}</DialogBody></DialogContent></Dialog></InboxCollectionBody>}</PmPage></ControlledFocus>
}
