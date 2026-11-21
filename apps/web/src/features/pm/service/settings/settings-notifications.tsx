import { useId, useState, type FormEvent } from "react"
import { Link, useParams } from "react-router"
import { ChevronDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Switch } from "@/components/ui/switch"
import { useText } from "../pm-ui"
import { SettingsSection, type SettingsPageProps } from "./settings-shared"
import { RadixSelect } from "@/components/ui/radix-select"

type MessagePreference = "all" | "mentions" | "none"
type MobileContent = "full" | "sender" | "hidden"
type NotificationPreferences = {
  messages: MessagePreference
  communication: boolean
  marketing: boolean
  social: boolean
  mobileOverride: boolean
  mobileMessages: MessagePreference
  mobileContent: MobileContent
}

const initialPreferences: NotificationPreferences = {
  messages: "all",
  communication: false,
  marketing: false,
  social: true,
  mobileOverride: false,
  mobileMessages: "mentions",
  mobileContent: "sender",
}

function MessageChoices({ value, onChange, disabled, label, descriptionId }: {
  value: MessagePreference | null
  onChange?: (value: MessagePreference) => void
  disabled: boolean
  label: string
  descriptionId?: string
}) {
  const t = useText()
  const id = useId()
  const options: { value: MessagePreference; label: string }[] = [
    { value: "all", label: t("所有新消息", "All new messages") },
    { value: "mentions", label: t("私信和提及我的消息", "Direct messages and mentions") },
    { value: "none", label: t("不接收消息通知", "Nothing") },
  ]

  return <fieldset className="min-w-0 space-y-2" disabled={disabled}>
    <legend id={`${id}-label`} className="text-sm font-medium">{label}</legend>
    <RadioGroup<MessagePreference>
      value={value}
      onValueChange={onChange}
      disabled={disabled}
      aria-labelledby={`${id}-label`}
      aria-describedby={descriptionId}
      className="gap-1"
    >
      {options.map(option => <div key={option.value} className="flex min-w-0 items-center gap-1">
        <RadioGroupItem value={option.value} id={`${id}-${option.value}`} />
        <label htmlFor={`${id}-${option.value}`} className={`min-w-0 py-2 text-sm ${disabled ? "text-muted-foreground" : "cursor-pointer"}`}>
          {option.label}
        </label>
      </div>)}
    </RadioGroup>
  </fieldset>
}

function NotificationPreview({ preferences }: { preferences: NotificationPreferences }) {
  const t = useText()
  const messageLabel = (value: MessagePreference) => value === "all"
    ? t("所有新消息", "All new messages")
    : value === "mentions"
      ? t("私信和提及我的消息", "Direct messages and mentions")
      : t("不接收消息通知", "Nothing")
  const mobileMessages = preferences.mobileOverride ? preferences.mobileMessages : preferences.messages
  const emailCategories = [
    ...(preferences.communication ? [t("账号动态", "Communication")] : []),
    ...(preferences.marketing ? [t("营销", "Marketing")] : []),
    ...(preferences.social ? [t("社交", "Social")] : []),
    t("安全（演示中必选）", "Security (required in the preview)"),
  ]

  return <section className="space-y-3 rounded-module border bg-surface p-4" aria-label={t("已应用的通知预览", "Applied notification preview")}>
    <h4 className="text-sm font-medium">{t("已应用的预览", "Applied preview")}</h4>
    <dl className="grid gap-3 text-sm">
      <div className="space-y-1">
        <dt className="text-muted-foreground">{t("桌面消息", "Desktop messages")}</dt>
        <dd>{messageLabel(preferences.messages)}</dd>
      </div>
      <div className="space-y-1">
        <dt className="text-muted-foreground">{t("邮件类别（仅演示）", "Email categories (preview only)")}</dt>
        <dd>{emailCategories.join(t("、", ", "))}</dd>
      </div>
      <div className="space-y-1">
        <dt className="text-muted-foreground">{t("移动端消息", "Mobile messages")}</dt>
        <dd>{preferences.mobileOverride
          ? messageLabel(mobileMessages)
          : t(`沿用桌面设置：${messageLabel(mobileMessages)}`, `Same as desktop: ${messageLabel(mobileMessages)}`)}</dd>
      </div>
    </dl>
    <div className="space-y-1 rounded-control border bg-surface-raised p-3 text-sm">
      <p className="text-xs text-muted-foreground">{t("移动端示意 · 不是真实消息", "Mobile illustration · not a real message")}</p>
      {mobileMessages === "none"
        ? <p>{t("当前预览不会显示移动端消息提醒。", "This preview shows no mobile message alerts.")}</p>
        : <>
          <p className="font-medium">{preferences.mobileOverride && preferences.mobileContent === "hidden"
            ? t("项目管理通知", "Project Management notification")
            : mobileMessages === "mentions"
              ? t("一位协作者提及了你", "A teammate mentioned you")
              : t("有一条新项目消息", "New project message")}</p>
          <p className="text-muted-foreground">{!preferences.mobileOverride || preferences.mobileContent === "full"
            ? t("协作者：项目讨论中有一条进展更新。", "Teammate: There is a progress update in the project conversation.")
            : preferences.mobileContent === "sender"
              ? t("协作者 · 消息正文已隐藏", "Teammate · message body hidden")
              : t("通知内容已隐藏", "Notification content hidden")}</p>
        </>}
    </div>
    <p className="text-xs leading-5 text-muted-foreground">{t(
      "只有点击“更新通知”后，这个预览才会应用新选择。不会发送邮件或推送。",
      "This preview applies new choices only after Update notifications. No email or push notification is sent.",
    )}</p>
  </section>
}

function NotificationFields({ value, onChange, applied }: {
  value: NotificationPreferences | null
  onChange?: (value: NotificationPreferences) => void
  applied?: NotificationPreferences
}) {
  const t = useText()
  const id = useId()
  const [expanded, setExpanded] = useState(false)
  const disabled = value === null
  const update = <K extends keyof NotificationPreferences>(key: K, next: NotificationPreferences[K]) => {
    if (value && onChange) onChange({ ...value, [key]: next })
  }
  const emailOptions = [
    {
      key: "communication" as const,
      title: t("账号动态邮件", "Communication emails"),
      description: t("接收有关账号活动的邮件。", "Receive emails about your account activity."),
    },
    {
      key: "marketing" as const,
      title: t("营销邮件", "Marketing emails"),
      description: t("接收有关新产品、功能等内容的邮件。", "Receive emails about new products, features, and more."),
    },
    {
      key: "social" as const,
      title: t("社交邮件", "Social emails"),
      description: t("接收好友请求、关注等社交动态邮件。", "Receive emails for friend requests, follows, and more."),
    },
  ]

  return <>
    <div className="space-y-2">
      <MessageChoices
        label={t("通知我的内容…", "Notify me about...")}
        value={value?.messages ?? null}
        onChange={disabled ? undefined : next => update("messages", next)}
        disabled={disabled}
        descriptionId={disabled ? `${id}-message-reason` : undefined}
      />
      {disabled && <p id={`${id}-message-reason`} className="text-sm leading-6 text-muted-foreground">{t(
        "这些消息订阅选项尚无偏好读写接口，当前值未知；未选中不代表“不接收”。站内个人提及、显式关注和任务完成定向通知已有独立规则，不由此处开关配置；私信尚未提供。",
        "These message subscription options have no preferences read/write API, so their values are unknown; an unselected option does not mean “Nothing”. In-app personal mentions, explicit task watches, and completion notifications follow existing rules, not these controls. Direct messages are not available.",
      )}</p>}
    </div>

    <section className="space-y-3" aria-labelledby={`${id}-email-heading`}>
      <h3 id={`${id}-email-heading`} className="text-sm font-medium">{t("邮件通知", "Email Notifications")}</h3>
      {disabled && <p id={`${id}-email-reason`} className="text-sm leading-6 text-muted-foreground">{t(
        "当前值未知。任务通知邮件与订阅管理尚未接入；下列所有邮件类别（包括安全邮件）均不可配置，而非已启用或已关闭。成员邀请的 SMTP 能力不等于这些通知投递能力。",
        "Current values are unknown. Task notification emails and subscription management are not connected. Every category below, including security emails, is unconfigurable, not on or off. SMTP support for member invitations does not provide these notification deliveries.",
      )}</p>}
      <div className="space-y-3">
        {emailOptions.map(option => <div key={option.key} className="flex min-w-0 items-center justify-between gap-4 rounded-module border bg-surface p-4">
          <div className="min-w-0 space-y-1">
            <label htmlFor={`${id}-${option.key}`} className="text-sm font-medium">{option.title}</label>
            <p id={`${id}-${option.key}-description`} className="text-sm leading-6 text-muted-foreground">{option.description}</p>
            {disabled && <p className="text-xs leading-5 text-muted-foreground">{t("订阅状态未知", "Subscription state unknown")}</p>}
          </div>
          {disabled ? <Checkbox
            id={`${id}-${option.key}`}
            indeterminate
            disabled
            aria-describedby={`${id}-${option.key}-description ${id}-email-reason`}
          /> : <Switch
            id={`${id}-${option.key}`}
            checked={value[option.key]}
            onCheckedChange={checked => update(option.key, checked)}
            aria-describedby={`${id}-${option.key}-description`}
          />}
        </div>)}
        <div className="flex min-w-0 items-center justify-between gap-4 rounded-module border bg-surface p-4">
          <div className="min-w-0 space-y-1">
            <label htmlFor={`${id}-security`} className="text-sm font-medium">{t("安全邮件", "Security emails")}</label>
            <p id={`${id}-security-description`} className="text-sm leading-6 text-muted-foreground">{t(
              "接收有关账号活动与安全的邮件。",
              "Receive emails about your account activity and security.",
            )}</p>
            <p id={`${id}-security-reason`} className="text-xs leading-5 text-muted-foreground">{disabled
              ? t("安全邮件投递不可用，订阅状态未知；此控件不代表已开启或已关闭。", "Security email delivery is unavailable and subscription state is unknown; this control does not mean on or off.")
              : t("演示中的必选项，始终开启且不可修改；不会发送真实安全邮件。", "Required in this demo: always on and not editable. No real security email is sent.")}</p>
          </div>
          {disabled ? <Checkbox
            id={`${id}-security`}
            indeterminate
            disabled
            aria-describedby={`${id}-security-description ${id}-security-reason`}
          /> : <Switch
            id={`${id}-security`}
            checked
            disabled
            aria-describedby={`${id}-security-description ${id}-security-reason`}
          />}
        </div>
      </div>
    </section>

    <div className="space-y-3">
      <div className="flex min-w-0 items-start gap-2">
        <Checkbox
          id={`${id}-mobile-override`}
          checked={value?.mobileOverride ?? false}
          disabled={disabled}
          indeterminate={disabled}
          aria-describedby={`${id}-mobile-description`}
          aria-controls={`${id}-mobile-settings`}
          onCheckedChange={disabled ? undefined : checked => {
            update("mobileOverride", checked)
            if (checked) setExpanded(true)
          }}
        />
        <div className="min-w-0 pt-1">
          <label htmlFor={`${id}-mobile-override`} className="text-sm font-medium">{t("为我的移动设备使用不同设置", "Use different settings for my mobile devices")}</label>
          <p id={`${id}-mobile-description`} className="mt-1 text-sm leading-6 text-muted-foreground">{disabled
            ? t("当前值未知。移动设备偏好和推送通道尚未接入，无法配置或投递推送。", "Current value unknown. Mobile device preferences and push channels are not connected; push notifications cannot be configured or delivered.")
            : t("在下方展开移动端预览设置。未勾选时，移动端沿用桌面消息设置。", "Expand the mobile preview settings below. When unchecked, mobile uses the desktop message settings.")}</p>
        </div>
      </div>
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <CollapsibleTrigger className="inline-flex min-h-11 items-center gap-2 rounded-control px-2 text-sm font-medium outline-none hover:bg-selection focus-visible:ring-2 focus-visible:ring-ring">
          {t("移动端设置与通知预览", "Mobile settings and notification preview")}
          <ChevronDown aria-hidden="true" className={`size-4 transition-transform motion-reduce:transition-none ${expanded ? "rotate-180" : ""}`} />
        </CollapsibleTrigger>
        <CollapsibleContent id={`${id}-mobile-settings`} className="space-y-4 pt-3">
          <p id={`${id}-mobile-fields-description`} className="text-sm leading-6 text-muted-foreground">{disabled
            ? t("预览配置不可用于真实服务；后端没有移动推送或设备级通知偏好接口。", "Preview configuration cannot be applied to the real service: the backend has no mobile push or per-device notification-preferences API.")
            : value.mobileOverride
              ? t("这些选项只控制下方的移动端示意，不会注册设备或请求推送权限。", "These options control only the illustration below. They do not register a device or request push permission.")
              : t("勾选“为我的移动设备使用不同设置”后可编辑。当前沿用桌面设置。", "Enable different settings for mobile to edit these options. The current preview inherits desktop settings.")}</p>
          <MessageChoices
            value={disabled ? null : value.mobileMessages}
            onChange={disabled ? undefined : next => update("mobileMessages", next)}
            disabled={disabled || !value.mobileOverride}
            label={t("移动端通知内容", "Notify me on mobile about...")}
            descriptionId={`${id}-mobile-fields-description`}
          />
          <label className="grid min-w-0 gap-2 text-sm">
            <span className="font-medium">{t("移动端锁屏内容", "Mobile lock-screen content")}</span>
            <RadixSelect
              className="min-h-11 w-full min-w-0 rounded-control border bg-surface px-3 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              value={disabled ? "" : value.mobileContent}
              disabled={disabled || !value.mobileOverride}
              aria-describedby={`${id}-mobile-fields-description`}
              onChange={event => {
                const next = event.target.value
                if (next === "full" || next === "sender" || next === "hidden") update("mobileContent", next)
              }}
            >
              {disabled && <option value="">{t("未知 · 不可用", "Unknown · unavailable")}</option>}
              <option value="full">{t("显示发送者和消息正文", "Show sender and message")}</option>
              <option value="sender">{t("只显示发送者", "Show sender only")}</option>
              <option value="hidden">{t("隐藏通知内容", "Hide notification content")}</option>
            </RadixSelect>
          </label>
          {applied && <NotificationPreview preferences={applied} />}
        </CollapsibleContent>
      </Collapsible>
    </div>
  </>
}

function ServiceNotificationSettings() {
  const t = useText()
  const { workspaceSlug } = useParams()
  const id = useId()

  return <div className="space-y-6">
    <div className="space-y-2">
      <p id={`${id}-unavailable`} className="text-sm leading-6 text-muted-foreground">{t("已有站内个人通知；邮件、推送与订阅偏好尚无接口，订阅值未知。", "In-app personal notifications exist; email, push and subscription preferences have no API, so values are unknown.")}</p>
      {workspaceSlug && <nav aria-label={t("通知与活动入口", "Notification and activity navigation")} className="flex flex-wrap gap-x-6">
        <Link
          to={`/pm/${encodeURIComponent(workspaceSlug)}/notifications?section=notifications`}
          className="inline-flex min-h-11 items-center rounded-control font-medium text-primary hover:text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >{t("打开个人通知收件箱", "Open personal notification inbox")}</Link>
        <Link
          to={`/pm/${encodeURIComponent(workspaceSlug)}/notifications`}
          className="inline-flex min-h-11 items-center rounded-control font-medium text-foreground hover:text-primary outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >{t("查看工作区活动", "View workspace activity")}</Link>
      </nav>}
    </div>
    <NotificationFields value={null} />
    <Button disabled aria-describedby={`${id}-unavailable`}>{t("更新通知", "Update notifications")}</Button>
  </div>
}

function LabNotificationSettings() {
  const t = useText()
  const [draft, setDraft] = useState(initialPreferences)
  const [applied, setApplied] = useState(initialPreferences)
  const [feedback, setFeedback] = useState<"saved" | "reset" | null>(null)
  const dirty = draft.messages !== applied.messages
    || draft.communication !== applied.communication
    || draft.marketing !== applied.marketing
    || draft.social !== applied.social
    || draft.mobileOverride !== applied.mobileOverride
    || draft.mobileMessages !== applied.mobileMessages
    || draft.mobileContent !== applied.mobileContent
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!dirty) return
    setApplied(draft)
    setFeedback("saved")
  }

  return <form onSubmit={submit} className="space-y-6">
    <NotificationFields
      value={draft}
      applied={applied}
      onChange={next => {
        setDraft(next)
        setFeedback(null)
      }}
    />
    <div className="flex flex-wrap gap-3">
      <Button type="submit" disabled={!dirty}>{t("更新通知", "Update notifications")}</Button>
      <Button type="button" variant="outline" disabled={!dirty} onClick={() => {
        setDraft(applied)
        setFeedback("reset")
      }}>{t("重置更改", "Reset changes")}</Button>
    </div>
    <p role="status" aria-live="polite" className="text-sm leading-6 text-muted-foreground">{feedback === "saved"
      ? t("通知预览已在当前页面内存中更新。未向真实服务保存任何偏好，也未发送任何通知。", "Notification preview updated in this page’s memory. No preferences were saved to the real service and no notifications were sent.")
      : feedback === "reset"
        ? t("未应用的更改已重置为上次应用的内存预览。", "Unapplied changes were reset to the last applied in-memory preview.")
        : dirty
          ? t("预览有未应用的更改。点击“更新通知”以应用。", "The preview has unapplied changes. Select Update notifications to apply them.")
          : t("当前显示上次应用的内存预览。", "Showing the last applied in-memory preview.")}</p>
  </form>
}

function NotificationCategoryLinks({ mode }: SettingsPageProps) {
  const t = useText()
  const { workspaceSlug = "" } = useParams()
  const id = useId()
  const root = `${mode === "lab" ? "/lab/pm" : "/pm"}/${encodeURIComponent(workspaceSlug)}/settings`
  const categories = [
    { slug: "notif-email", title: t("邮件通知", "Email notifications"), description: t("提及、分配、评论与工作日每日摘要", "Mentions, assignments, comments, and weekday digests") },
    { slug: "notif-push", title: t("推送通知", "Push notifications"), description: t("提及、分配、评论与到期前一天提醒", "Mentions, assignments, comments, and one-day-before due reminders") },
    { slug: "notif-mentions", title: t("提及通知", "Mention notifications"), description: t("个人、团队与工作区提及", "Personal, team, and workspace mentions") },
    { slug: "notif-assign", title: t("任务分配通知", "Task assignment notifications"), description: t("分配给我、状态变化与任务逾期", "Assigned to me, status changes, and overdue tasks") },
  ]

  return <nav aria-labelledby={`${id}-heading`} className="space-y-3">
    <h3 id={`${id}-heading`} className="text-sm font-medium">{t("按事件查看通知选项", "Notification options by event")}</h3>
    <p className="text-sm leading-6 text-muted-foreground">{mode === "service"
      ? t("四类事件共 14 个订阅选项，均未提供偏好接口。", "Four event categories contain 14 subscription options without a preferences API.")
      : t("四类事件共 14 个演示选项；离页后重置。", "Four event categories contain 14 demo options; they reset when you leave.")}</p>
    <div className="grid min-w-0 gap-3 sm:grid-cols-2">
      {categories.map(category => <Link key={category.slug} to={`${root}/${category.slug}`} className="min-w-0 space-y-1 rounded-module border bg-surface p-4 outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring">
        <span className="block text-sm font-medium">{category.title}</span>
        <span className="block text-sm leading-6 text-muted-foreground">{category.description}</span>
      </Link>)}
    </div>
  </nav>
}

export function SettingsNotifications({ mode }: SettingsPageProps) {
  const t = useText()

  return <SettingsSection
    title={t("通知总览", "Notification overview")}
    description={mode === "service"
      ? t("查看已有的站内通知入口与尚未提供的订阅选项。", "Review the existing in-app inbox and unavailable subscription options.")
      : t("预览事件通知与桌面、移动端提醒。", "Preview event notifications and desktop or mobile alerts.")}
  >
    <NotificationCategoryLinks mode={mode} />
    {mode === "service" ? <ServiceNotificationSettings /> : <LabNotificationSettings />}
  </SettingsSection>
}
