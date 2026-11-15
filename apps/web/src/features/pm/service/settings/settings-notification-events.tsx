import { useId, useState, type FormEvent } from "react"
import { Link, useParams } from "react-router"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Switch } from "@/components/ui/switch"
import { useText } from "../pm-ui"
import { SettingsNotice, SettingsSection, type SettingsPageProps } from "./settings-shared"

type LocalizedText = readonly [zh: string, en: string]
type EventOption = {
  id: string
  label: LocalizedText
  description: LocalizedText
  previewEnabled: boolean
}
type EventPage = {
  id: string
  title: LocalizedText
  description?: LocalizedText
  unavailable: LocalizedText
  options: readonly EventOption[]
}

const emailPage: EventPage = {
  id: "notif-email",
  title: ["邮件通知", "Email notifications"],
  unavailable: [
    "邮件通知不可用：没有通知偏好的读取或保存接口，也没有这些事件的邮件投递合同。当前订阅值未知，不代表已开启或已关闭。成员邀请的 SMTP 能力不等于任务通知或摘要投递能力。",
    "Email notifications are unavailable: there is no notification-preferences read/save API or email-delivery contract for these events. Subscription values are unknown, not on or off. SMTP support for member invitations does not provide task alerts or digest delivery.",
  ],
  options: [
    { id: "mentions", label: ["提及我的邮件", "Mentions"], description: ["有人在评论或描述中提及我时接收邮件。", "Email me when someone mentions me in a comment or description."], previewEnabled: true },
    { id: "assignments", label: ["任务分配邮件", "Assignments"], description: ["有任务分配给我时接收邮件。", "Email me when a task is assigned to me."], previewEnabled: true },
    { id: "comments", label: ["任务评论邮件", "Comments"], description: ["我创建或受派的任务有新评论时接收邮件。", "Email me about new comments on tasks I created or am assigned."], previewEnabled: true },
    { id: "digest", label: ["工作日每日摘要", "Weekday daily digest"], description: ["每个工作日汇总项目与任务变更；当前没有摘要生成、时区排程或投递服务。", "A summary of project and task changes each weekday; digest generation, time-zone scheduling, and delivery are not connected."], previewEnabled: false },
  ],
}

const pushPage: EventPage = {
  id: "notif-push",
  title: ["推送通知", "Push notifications"],
  description: ["查看桌面和移动端的事件提醒选项；当前未接入推送通道。", "Review desktop and mobile event alerts; push channels are not connected."],
  unavailable: [
    "推送通知不可用：没有设备注册、系统通知权限接入、推送投递或通知偏好接口。设备授权和订阅状态均未知；本页不会请求浏览器权限、注册设备或发送测试推送。",
    "Push notifications are unavailable: device registration, system notification permissions, push delivery, and notification-preferences APIs are not connected. Device permission and subscription states are unknown. This page never requests browser permission, registers a device, or sends test pushes.",
  ],
  options: [
    { id: "mentions", label: ["提及我的推送", "Mentions"], description: ["有人提及我时在桌面或移动设备上提醒。", "Alert me on desktop or mobile when someone mentions me."], previewEnabled: true },
    { id: "assignments", label: ["任务分配推送", "Assignments"], description: ["有任务分配给我时提醒。", "Alert me when a task is assigned to me."], previewEnabled: true },
    { id: "comments", label: ["任务评论推送", "Comments"], description: ["我创建或受派的任务有新评论时提醒。", "Alert me about new comments on tasks I created or am assigned."], previewEnabled: false },
    { id: "due", label: ["到期前一天提醒", "One-day-before due reminder"], description: ["在任务截止日期前一天提醒；可靠排程与提醒投递尚未接入，不修改任务日期。", "Alert me one day before a task is due; reliable scheduling and reminder delivery are not connected, and task dates are not changed."], previewEnabled: true },
  ],
}

const mentionsPage: EventPage = {
  id: "notif-mentions",
  title: ["提及通知", "Mention notifications"],
  unavailable: [
    "站内个人提及通知已提供，但本页的接收偏好尚无读写接口，订阅值未知且不可配置。团队／工作区提及广播尚未提供。普通 @ 文字不等于有效个人提及，提及与团队成员身份均不授予访问权限。",
    "In-app personal mention notifications are available, but this page has no preferences read/write API; subscription values are unknown and cannot be configured. Team/workspace mention broadcasts are not available. Plain @ text is not a valid personal mention, and neither mentions nor team membership grant access.",
  ],
  options: [
    { id: "personal", label: ["个人提及", "Personal mentions"], description: ["任务描述或评论中新增的有效个人提及可进入个人通知；此处尚不能配置接收偏好。", "New valid personal mentions in task descriptions or comments can reach the personal inbox; receiving preferences cannot be configured here."], previewEnabled: true },
    { id: "team", label: ["团队提及", "Team mentions"], description: ["团队提及广播尚未提供；此处不会创建广播或改变团队权限。", "Team mention broadcasts are not available; this does not create broadcasts or change team permissions."], previewEnabled: true },
    { id: "workspace", label: ["工作区提及", "Workspace mentions"], description: ["工作区全员提及或公告广播尚未提供。", "Workspace-wide mention or announcement broadcasts are not available."], previewEnabled: false },
  ],
}

const assignmentsPage: EventPage = {
  id: "notif-assign",
  title: ["任务分配通知", "Task assignment notifications"],
  unavailable: [
    "任务分配、一般状态变化和逾期提醒的订阅偏好尚无读写接口，无法读取或保存这些选项；任务分配和日期事实本身不等于提醒投递。任务真正进入已完成类别时，已有规则会定向通知仍有权限的负责人及可信 Agent／自动化发起人，这不代表下列通用订阅已启用。",
    "Assignment, general status-change, and overdue-alert subscription preferences have no read/write API, so these options cannot be read or saved. Assignment and date facts alone do not imply alert delivery. When a task truly enters the completed category, existing rules notify its still-authorized assignee and trusted Agent/automation requester; this does not mean the general subscriptions below are enabled.",
  ],
  options: [
    { id: "assigned", label: ["任务分配给我", "When I am assigned a task"], description: ["任务的受派人变为我时提醒。", "Alert me when I become the assignee of a task."], previewEnabled: true },
    { id: "status", label: ["我的任务状态变化", "When my task changes status"], description: ["通用状态提醒偏好尚未提供；真正进入已完成类别的定向通知已有独立规则。", "General status-alert preferences are not available; routed notifications for a real transition to the completed category follow existing rules."], previewEnabled: true },
    { id: "overdue", label: ["我的任务逾期", "When my task is overdue"], description: ["分配给我的任务超过截止日期时提醒；不自动改变任务状态。", "Alert me when a task assigned to me passes its due date; task status is not changed automatically."], previewEnabled: true },
  ],
}

function NotificationEventFields({ page, value, onChange, reasonId }: {
  page: EventPage
  value: readonly boolean[] | null
  onChange?: (index: number, enabled: boolean) => void
  reasonId: string
}) {
  const t = useText()
  const id = useId()

  return <div className="space-y-3">
    {page.options.map((option, index) => <div key={option.id} className="flex min-w-0 items-center justify-between gap-4 rounded-module border bg-surface p-4">
      <div className="min-w-0 space-y-1">
        <label id={`${id}-${option.id}-label`} htmlFor={`${id}-${option.id}`} className="text-sm font-medium">{t(...option.label)}</label>
        <p id={`${id}-${option.id}-description`} className="text-sm leading-6 text-muted-foreground">{t(...option.description)}</p>
        <p id={`${id}-${option.id}-state`} className="text-xs leading-5 text-muted-foreground">{value === null
          ? t("当前值未知 · 服务未提供，不代表关闭", "Current value unknown · not provided by the service, not switched off")
          : t("仅演示草稿，不是实际订阅状态", "Preview draft only, not a real subscription state")}</p>
      </div>
      {value === null
        ? <Checkbox
          id={`${id}-${option.id}`}
          indeterminate
          disabled
          aria-labelledby={`${id}-${option.id}-label`}
          aria-describedby={`${id}-${option.id}-description ${id}-${option.id}-state ${reasonId}`}
        />
        : <Switch
          id={`${id}-${option.id}`}
          checked={value[index]}
          onCheckedChange={enabled => onChange?.(index, enabled)}
          aria-labelledby={`${id}-${option.id}-label`}
          aria-describedby={`${id}-${option.id}-description ${id}-${option.id}-state ${reasonId}`}
        />}
    </div>)}
  </div>
}

function NotificationEventContext({ mode }: SettingsPageProps) {
  const t = useText()
  const { workspaceSlug } = useParams()

  return <SettingsNotice>
    <p>{t(
      "这些提醒选项与工作区数据同步独立。服务器发送事件（SSE）继续按原有权限同步真实数据；本页不创建订阅、不修改事件流，也不修改任务或成员。",
      "These alert options are separate from workspace data synchronization. Server-sent events (SSE) continue synchronizing real data under existing permissions. This page creates no subscriptions and changes no streams, tasks, or members.",
    )}</p>
    {mode === "service" && workspaceSlug && <>
      <p className="mt-2">{t(
        "个人收件箱已有新增有效个人提及、显式关注任务变更和真正完成后的定向通知，不由这些禁用选项配置；私信、团队／工作区广播、任务通知邮件、推送、每日摘要及分配／逾期订阅提醒尚未提供。",
        "The personal inbox already receives newly added valid personal mentions, changes to explicitly watched tasks, and routed notifications for real completion; these disabled options do not configure them. Direct messages, team/workspace broadcasts, task notification email, push, daily digests, and assignment/overdue subscription alerts are not available.",
      )}</p>
      <nav aria-label={t("通知与活动入口", "Notification and activity navigation")} className="mt-2 flex flex-wrap gap-x-6">
        <Link to={`/pm/${encodeURIComponent(workspaceSlug)}/notifications?section=notifications`} className="inline-flex min-h-11 items-center rounded-control font-medium text-primary hover:text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">{t("打开个人通知收件箱", "Open personal notification inbox")}</Link>
        <Link to={`/pm/${encodeURIComponent(workspaceSlug)}/notifications`} className="inline-flex min-h-11 items-center rounded-control font-medium text-foreground hover:text-primary outline-none focus-visible:ring-2 focus-visible:ring-ring">{t("查看工作区活动", "View workspace activity")}</Link>
      </nav>
      <p className="mt-2">{t(
        "个人通知可显式标记已读、未读或归档，打开通知或目标不会自动标已读。工作区活动是独立的只读变更时间线，不是个人收件箱。",
        "Personal notifications can be explicitly marked read, unread, or archived; opening a notification or its target never marks it read. Workspace activity is a separate read-only change timeline, not the personal inbox.",
      )}</p>
      <p className="mt-2">{t(
        "任务与文档已有“变更记录”；“已阅这些变更”只保存本人的所示变更水位。通知已读、变更已阅、配置工作流中的任务完成和人工验收相互独立；打开页面或 Agent 执行成功不会替代这些操作。",
        "Tasks and documents already provide Change history. Mark these changes reviewed saves only your own watermark for the changes shown. Notification read state, reviewed changes, task completion in the configured workflow, and manual acceptance are independent; opening a page or a successful Agent run never substitutes for these actions.",
      )}</p>
    </>}
  </SettingsNotice>
}

function ServiceNotificationEvents({ page }: { page: EventPage }) {
  const t = useText()
  const id = useId()

  return <div className="space-y-6">
    <SettingsNotice><p id={`${id}-unavailable`}>{t(...page.unavailable)}</p></SettingsNotice>
    <NotificationEventContext mode="service" />
    <NotificationEventFields page={page} value={null} reasonId={`${id}-unavailable`} />
    <Button type="button" disabled aria-describedby={`${id}-unavailable`}>{t("保存通知偏好（不可用）", "Save notification preferences (unavailable)")}</Button>
  </div>
}

function LabNotificationEvents({ page }: { page: EventPage }) {
  const t = useText()
  const id = useId()
  const [draft, setDraft] = useState(() => page.options.map(option => option.previewEnabled))
  const [applied, setApplied] = useState(() => page.options.map(option => option.previewEnabled))
  const [feedback, setFeedback] = useState<"applied" | "reset" | null>(null)
  const dirty = draft.some((enabled, index) => enabled !== applied[index])
  const apply = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!dirty) return
    setApplied(draft)
    setFeedback("applied")
  }

  return <form onSubmit={apply} className="space-y-6">
    <SettingsNotice><p id={`${id}-preview`}>{t(
      "Lab 内存演示：下面的初始值都是样例，不从真实账号读取。修改只更新草稿；“应用预览”更新本页已应用的示意，“重置更改”恢复到上次应用。离开此页或刷新后，草稿和已应用值均恢复初始样例。不会保存真实偏好、请求权限、发送通知或发起网络请求。",
      "Lab in-memory demo: initial values are examples, not data from a real account. Changes edit the draft; Apply preview updates this page’s applied illustration, and Reset changes restores the last applied values. Leaving this page or refreshing resets both draft and applied values to the initial examples. No real preferences are saved, permissions requested, notifications sent, or network requests made.",
    )}</p></SettingsNotice>
    <NotificationEventFields
      page={page}
      value={draft}
      reasonId={`${id}-preview`}
      onChange={(index, enabled) => {
        setDraft(current => current.map((value, currentIndex) => currentIndex === index ? enabled : value))
        setFeedback(null)
      }}
    />
    <div className="flex flex-wrap gap-3">
      <Button type="submit" disabled={!dirty}>{t("应用预览", "Apply preview")}</Button>
      <Button type="button" variant="outline" disabled={!dirty} onClick={() => {
        setDraft(applied)
        setFeedback("reset")
      }}>{t("重置更改", "Reset changes")}</Button>
    </div>
    <p role="status" aria-live="polite" className="text-sm leading-6 text-muted-foreground">{feedback === "applied"
      ? t("预览已应用到本页内存；未保存到服务，也未发送通知。", "Preview applied in this page’s memory; nothing was saved to the service and no notifications were sent.")
      : feedback === "reset"
        ? t("草稿已恢复为上次应用的内存预览。", "Draft restored to the last applied in-memory preview.")
        : dirty
          ? t("有未应用的更改；下方仍显示上次应用的预览。", "There are unapplied changes; the illustration below still shows the last applied preview.")
          : t("当前显示已应用的内存样例，无未应用更改。", "Showing applied in-memory examples with no unapplied changes.")}</p>
    <section aria-labelledby={`${id}-applied-heading`} className="space-y-3 rounded-module border bg-surface p-4">
      <h3 id={`${id}-applied-heading`} className="text-sm font-medium">{t("已应用预览 · 不会实际投递", "Applied preview · no actual delivery")}</h3>
      <dl className="space-y-3 text-sm">
        {page.options.map((option, index) => <div key={option.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <dt className="text-muted-foreground">{t(...option.label)}</dt>
          <dd>{applied[index] ? t("演示已开启", "On in preview") : t("演示已关闭", "Off in preview")}</dd>
        </div>)}
      </dl>
    </section>
    <NotificationEventContext mode="lab" />
  </form>
}

function NotificationEventPage({ mode, page }: SettingsPageProps & { page: EventPage }) {
  const t = useText()
  const { workspaceSlug = "" } = useParams()
  const root = `${mode === "lab" ? "/lab/pm" : "/pm"}/${encodeURIComponent(workspaceSlug)}/settings`

  return <SettingsSection title={t(...page.title)} description={page.description ? t(...page.description) : undefined}>
    <Link to={`${root}/notifications`} className="inline-flex min-h-11 items-center rounded-control text-sm font-medium text-primary hover:text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">{t("返回通知总览", "Back to notification overview")}</Link>
    {mode === "service" ? <ServiceNotificationEvents key={page.id} page={page} /> : <LabNotificationEvents key={page.id} page={page} />}
  </SettingsSection>
}

export function SettingsEmailNotifications({ mode }: SettingsPageProps) {
  return <NotificationEventPage mode={mode} page={emailPage} />
}

export function SettingsPushNotifications({ mode }: SettingsPageProps) {
  return <NotificationEventPage mode={mode} page={pushPage} />
}

export function SettingsMentionNotifications({ mode }: SettingsPageProps) {
  return <NotificationEventPage mode={mode} page={mentionsPage} />
}

export function SettingsAssignmentNotifications({ mode }: SettingsPageProps) {
  return <NotificationEventPage mode={mode} page={assignmentsPage} />
}
