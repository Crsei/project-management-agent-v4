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
    "提及通知不可用：当前没有个人、团队或工作区提及识别与通知路由合同，也没有偏好读写接口。文本中出现 @ 不代表已识别或已通知任何人；团队成员身份也不会由此授予访问权限。",
    "Mention notifications are unavailable: there is no contract for personal, team, or workspace mention detection or routing, and no preferences API. An @ in text does not mean anyone was detected or notified. Team membership does not grant access permissions.",
  ],
  options: [
    { id: "personal", label: ["个人提及", "Personal mentions"], description: ["评论和描述中直接 @提及我时提醒；当前不解析或投递提及。", "Alert me about direct @mentions in comments and descriptions; mentions are not currently parsed or delivered."], previewEnabled: true },
    { id: "team", label: ["团队提及", "Team mentions"], description: ["我所在团队被 @提及时提醒；不创建团队广播或改变团队权限。", "Alert me when my team is @mentioned; this does not create team broadcasts or change team permissions."], previewEnabled: true },
    { id: "workspace", label: ["工作区提及", "Workspace mentions"], description: ["面向工作区所有人的提及或公告提醒；当前没有全员广播服务。", "Alert me about workspace-wide mentions or announcements; there is no workspace broadcast service."], previewEnabled: false },
  ],
}

const assignmentsPage: EventPage = {
  id: "notif-assign",
  title: ["任务分配通知", "Task assignment notifications"],
  unavailable: [
    "任务分配通知不可用：已有任务分配和状态事实不等于已实现提醒投递。没有通知偏好读写、个人事件订阅或逾期提醒投递合同，因此无法读取或保存这些选项。",
    "Task assignment notifications are unavailable: real assignment and status data does not imply alert delivery. There is no notification-preferences API, personal event subscription, or overdue-alert delivery contract, so these options cannot be read or saved.",
  ],
  options: [
    { id: "assigned", label: ["任务分配给我", "When I am assigned a task"], description: ["任务的受派人变为我时提醒。", "Alert me when I become the assignee of a task."], previewEnabled: true },
    { id: "status", label: ["我的任务状态变化", "When my task changes status"], description: ["分配给我的任务发生工作流状态变化时提醒。", "Alert me when a task assigned to me changes workflow status."], previewEnabled: true },
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
      <p className="mt-2">{t("真实活动是服务变更记录，不是通知收件箱；没有已读或归档状态。", "Real activity contains service change records, not a notification inbox; read and archive states are unavailable.")}</p>
      <Link to={`/pm/${encodeURIComponent(workspaceSlug)}/notifications`} className="mt-2 inline-flex min-h-11 items-center rounded-control font-medium text-foreground hover:text-primary outline-none focus-visible:ring-2 focus-visible:ring-ring">{t("查看真实工作区活动", "View real workspace activity")}</Link>
    </>}
  </SettingsNotice>
}

function ServiceNotificationEvents({ page }: { page: EventPage }) {
  const t = useText()
  const id = useId()

  return <div className="space-y-6">
    <SettingsNotice><p id={`${id}-unavailable`}>{t(...page.unavailable)}</p></SettingsNotice>
    <NotificationEventFields page={page} value={null} reasonId={`${id}-unavailable`} />
    <Button type="button" disabled aria-describedby={`${id}-unavailable`}>{t("保存通知偏好（不可用）", "Save notification preferences (unavailable)")}</Button>
    <NotificationEventContext mode="service" />
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
