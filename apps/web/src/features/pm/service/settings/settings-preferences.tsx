import { useId, type ReactNode } from "react"
import { Link, useParams } from "react-router"
import { Monitor, Moon, Sun } from "lucide-react"
import { Field } from "@/components/ui/field"
import { useWorkspaceStore } from "@/providers/app-providers"
import { formatPreferenceDate, formatPreferenceTime } from "@/features/workspace/preference-format"
import type { DisplayPreferences } from "@/features/workspace/store"
import { usePersonalDashboard } from "../pm-service"
import { useText } from "../pm-ui"
import { SettingsNotice, SettingsSection, type SettingsPageProps } from "./settings-shared"
import { RadixSelect } from "@/components/ui/radix-select"

const selectClass = "min-h-10 w-full rounded-control border bg-surface px-3 text-sm focus-visible:ring-2 focus-visible:ring-ring"
const accentColors = { indigo: "#4b5bd6", blue: "#2563c5", violet: "#7348cc", teal: "#087b72", rose: "#b93663", graphite: "#525762" }

function BrowserScope({ mode }: SettingsPageProps) {
  const t = useText()
  const storage = useWorkspaceStore(state => state.preferenceStorage)
  return <SettingsNotice>
    <p>{t("立即生效，仅保存在当前浏览器的此网站中；不随账号跨设备同步，也不修改工作区业务数据。正式页面与 Lab 共用这些显示偏好。", "Applied immediately in this browser for this site only. Not synced across accounts or devices, and no workspace business data is changed. Service and Lab share these display preferences.")}</p>
    {mode === "lab" && <p className="mt-2">{t("Lab 中的偏好同样会影响正式页面；这不是后端写入演示。", "Changes made in Lab also affect service pages; these are real browser preferences, not simulated backend writes.")}</p>}
    {storage === "unavailable" && <p role="alert" className="mt-2 text-destructive">{t("浏览器存储不可用或写入失败。当前修改仅在本次应用会话中有效，刷新后可能丢失。", "Browser storage is unavailable or a write failed. Changes work for this app session only and may be lost on reload.")}</p>}
    {storage === "recovered" && <p role="status" className="mt-2">{t("已忽略损坏或不支持的偏好值并使用安全默认值；下一次修改会保存有效设置。", "Damaged or unsupported values were ignored in favor of safe defaults. Your next change will save valid settings.")}</p>}
  </SettingsNotice>
}

function PreferenceSelect({ label, description, value, onChange, children }: { label: string; description?: string; value: string | number; onChange: (value: string) => void; children: ReactNode }) {
  return <Field label={label} description={description}>{control => <RadixSelect {...control} className={selectClass} value={value} onChange={event => onChange(event.target.value)}>{children}</RadixSelect>}</Field>
}

export function SettingsAppearance({ mode }: SettingsPageProps) {
  const t = useText()
  const id = useId()
  const { theme, accent, sidebarDensity, taskDensity, motion, setPreferences } = useWorkspaceStore(state => state)
  return <SettingsSection title={t("外观", "Appearance")} wide>
    <BrowserScope mode={mode} />
    <fieldset><legend className="mb-3 text-sm font-medium">{t("主题", "Theme")}</legend><div className="grid gap-3 sm:grid-cols-3">
      {([['light', t("浅色", "Light"), Sun], ['dark', t("深色", "Dark"), Moon], ['system', t("跟随系统", "System"), Monitor]] as const).map(([value, label, Icon]) => <label key={value} className={`min-w-0 cursor-pointer rounded-module border p-3 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring ${theme === value ? "border-ring bg-selection" : "bg-surface"}`}>
        <div aria-hidden="true" className={`mb-3 grid h-24 grid-cols-[28%_1fr] overflow-hidden rounded-control border ${value === "dark" ? "border-zinc-700 bg-zinc-900" : value === "system" ? "bg-gradient-to-r from-white via-white to-zinc-900" : "bg-white"}`}><div className={`space-y-2 border-r p-2 ${value === "dark" ? "border-zinc-700 bg-zinc-800" : "border-zinc-200 bg-zinc-100"}`}><span className="block h-2 rounded bg-accent" /><span className="block h-2 rounded bg-zinc-400" /><span className="block h-2 rounded bg-zinc-400" /></div><div className="space-y-3 p-3"><span className="block h-2 w-2/3 rounded bg-zinc-400" /><span className="block h-2 rounded bg-zinc-400/50" /><span className="block h-5 w-1/2 rounded bg-accent" /></div></div>
        <span className="flex items-center gap-2 text-sm"><input className="size-4 accent-[var(--accent)]" type="radio" name={`${id}-theme`} value={value} checked={theme === value} onChange={() => setPreferences({ theme: value })} /><Icon className="size-4" aria-hidden="true" />{label}</span>
      </label>)}
    </div><p className="mt-2 text-xs text-muted-foreground">{t("跟随系统会实时响应操作系统的深浅色变化。", "System responds live to operating-system light and dark mode changes.")}</p></fieldset>
    <fieldset><legend className="mb-2 text-sm font-medium">{t("强调色", "Accent color")}</legend><p className="mb-3 text-xs text-muted-foreground">{t("应用于主要按钮、键盘焦点与选中状态；不改变工作流状态颜色。", "Used for primary buttons, keyboard focus and selection, not workflow status colors.")}</p><div className="flex flex-wrap gap-3">{(Object.keys(accentColors) as DisplayPreferences["accent"][]).map(value => <label key={value} className={`flex cursor-pointer items-center gap-2 rounded-control border px-3 py-2 text-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring ${accent === value ? "border-ring bg-selection" : ""}`}><input type="radio" name={`${id}-accent`} checked={accent === value} onChange={() => setPreferences({ accent: value })} className="size-4 accent-[var(--accent)]" /><span aria-hidden="true" className="size-4 rounded-full" style={{ background: accentColors[value] }} />{({ indigo: t("靛蓝", "Indigo"), blue: t("蓝色", "Blue"), violet: t("紫罗兰", "Violet"), teal: t("青绿", "Teal"), rose: t("玫红", "Rose"), graphite: t("石墨", "Graphite") })[value]}</label>)}</div></fieldset>
    <div className="grid max-w-2xl gap-6 sm:grid-cols-2">
      <PreferenceSelect label={t("侧栏密度", "Sidebar density")} description={t("只调整工作区导航；触屏保留较大点击区域。", "Workspace navigation only; touch targets stay large.")} value={sidebarDensity} onChange={value => setPreferences({ sidebarDensity: value as DisplayPreferences["sidebarDensity"] })}><option value="comfortable">{t("舒适", "Comfortable")}</option><option value="compact">{t("紧凑", "Compact")}</option></PreferenceSelect>
      <PreferenceSelect label={t("任务密度", "Task density")} description={t("调整任务集合及项目任务行/卡片；不压缩表单和源码。", "Task collections and project issue rows/cards only, not forms or source editors.")} value={taskDensity} onChange={value => setPreferences({ taskDensity: value as DisplayPreferences["taskDensity"] })}><option value="comfortable">{t("舒适", "Comfortable")}</option><option value="compact">{t("紧凑", "Compact")}</option></PreferenceSelect>
      <PreferenceSelect label={t("动效", "Motion")} description={t("系统已要求减少动效时始终遵守。", "The operating system’s reduced-motion request is always respected.")} value={motion} onChange={value => setPreferences({ motion: value as DisplayPreferences["motion"] })}><option value="system">{t("跟随系统", "Follow system")}</option><option value="reduce">{t("减少动效", "Reduce motion")}</option></PreferenceSelect>
    </div>
  </SettingsSection>
}

export function SettingsLanguage({ mode }: SettingsPageProps) {
  const t = useText()
  const { locale, spellcheck, setLocale, setPreferences } = useWorkspaceStore(state => state)
  return <SettingsSection title={t("语言", "Language")}>
    <BrowserScope mode={mode} />
    <PreferenceSelect label={t("界面语言", "Interface language")} description={t("目前真实提供简体中文与英文；部分领域源码及服务诊断保持原文。", "Simplified Chinese and English are supported; domain source and some service diagnostics retain their original text.")} value={locale} onChange={value => { if (value === "zh-CN" || value === "en") setLocale(value) }}><option value="zh-CN">简体中文</option><option value="en">English</option>{["Deutsch", "Español", "Français", "日本語", "English (UK)"].map(language => <option key={language} value={language} disabled>{language} — {t("尚未翻译", "not translated")}</option>)}</PreferenceSelect>
    <label className="flex items-start gap-3 rounded-module border p-4"><input type="checkbox" className="mt-1 size-4 shrink-0 accent-[var(--accent)]" checked={spellcheck} onChange={event => setPreferences({ spellcheck: event.target.checked })} /><span className="space-y-1"><span className="block text-sm font-medium">{t("拼写检查", "Spellcheck")}</span><span className="block text-sm leading-6 text-muted-foreground">{t("应用于富文本描述与纯文字评论输入。由浏览器及已安装词典提供；Markdown/YAML/代码编辑器和代码块不启用。", "Used in rich-text descriptions and plain-text comments. Provided by your browser and installed dictionaries; disabled for Markdown/YAML/source editors and code blocks.")}</span></span></label>
  </SettingsSection>
}

function ProfileTimeZone() {
  const t = useText()
  const personal = usePersonalDashboard()
  return <div className="text-sm">{personal.isPending ? <p role="status">{t("正在读取个人时区…", "Reading your profile time zone…")}</p> : personal.error ? <p role="alert">{personal.error.message}</p> : <p>{t("个人资料时区", "Profile time zone")}: <strong>{personal.data?.profile.timeZone ?? t("未提供", "Not provided")}</strong></p>}</div>
}

export function SettingsDateTime({ mode }: SettingsPageProps) {
  const t = useText()
  const { workspaceSlug = "" } = useParams()
  const { dateFormat, weekStartsOn, timeFormat, locale, setPreferences } = useWorkspaceStore(state => state)
  const sample = "2026-10-21T15:05:00Z"
  return <SettingsSection title={t("日期与时间", "Date & time")} description={t("调整日期与时间的显示，不改变工作项的全天日期或服务器时间。", "Change date and time presentation without changing all-day task dates or server timestamps.")}>
    <BrowserScope mode={mode} />
    <div className="space-y-3 rounded-module border p-4"><h3 className="text-sm font-medium">{t("时区", "Time zone")}</h3>{mode === "service" ? <ProfileTimeZone /> : <p className="text-sm text-muted-foreground">{t("Lab 不读取或创建正式个人时区。", "Lab does not read or create a service profile time zone.")}</p>}<p className="text-sm leading-6 text-muted-foreground">{t("个人工作台的会议与工时使用个人资料中的真实时区。其他未指定时区的时间戳按浏览器时区显示；任务全天日期不做时区转换。", "Personal meetings and time logs use your actual profile time zone. Timestamps without an explicit zone use the browser zone; all-day task dates are never shifted.")}</p><Link className="inline-block rounded-control text-sm text-primary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring" to={`${mode === "lab" ? "/lab/pm" : "/pm"}/${encodeURIComponent(workspaceSlug)}/settings/profile`}>{t("在个人资料中管理时区", "Manage time zone in Profile")}</Link></div>
    <PreferenceSelect label={t("日期格式", "Date format")} value={dateFormat} onChange={value => setPreferences({ dateFormat: value as DisplayPreferences["dateFormat"] })}>{(["MMM d", "d/M", "M/d", "yyyy-MM-dd"] as const).map(value => <option key={value} value={value}>{value} · {formatPreferenceDate("2026-10-21", value, locale)}</option>)}</PreferenceSelect>
    <PreferenceSelect label={t("每周开始于", "Week starts on")} description={t("用于任务日历与甘特周视图，不改变服务端工时汇总规则。", "Used in task calendars and weekly Gantt views; server time-total rules are unchanged.")} value={weekStartsOn} onChange={value => setPreferences({ weekStartsOn: Number(value) as DisplayPreferences["weekStartsOn"] })}><option value="1">{t("星期一", "Monday")}</option><option value="0">{t("星期日", "Sunday")}</option><option value="6">{t("星期六", "Saturday")}</option></PreferenceSelect>
    <PreferenceSelect label={t("时间格式", "Time format")} value={timeFormat} onChange={value => setPreferences({ timeFormat: value as DisplayPreferences["timeFormat"] })}><option value="12">{t("12 小时制", "12-hour")}</option><option value="24">{t("24 小时制", "24-hour")}</option></PreferenceSelect>
    <p className="rounded-control border bg-surface-raised p-3 text-sm" aria-live="polite">{t("格式预览（UTC 示例）", "Format preview (UTC example)")}: {formatPreferenceDate("2026-10-21", dateFormat, locale)} · {formatPreferenceTime(sample, timeFormat, locale, "UTC")}</p>
  </SettingsSection>
}

export function SettingsPreferences({ mode }: SettingsPageProps) {
  const t = useText()
  const { startPage, taskOpenMode, setPreferences } = useWorkspaceStore(state => state)
  return <SettingsSection title={t("个人偏好", "Preferences")} description={t("设置默认入口和任务打开方式；显式链接与现有安全规则优先。", "Choose default entry points and task opening behavior. Explicit links and existing safety rules take precedence.")}>
    <BrowserScope mode={mode} />
    <PreferenceSelect label={t("启动页", "Start page")} description={t("选择或切换工作区、打开工作区根地址时使用。新浏览器默认首页，已保存的选择保持不变；不会重定向已有深链接。", "Used when choosing or switching workspaces and opening a workspace root URL. New browsers default to Home; saved choices are kept and existing deep links are not redirected.")} value={startPage} onChange={value => setPreferences({ startPage: value as DisplayPreferences["startPage"] })}><option value="home">{t("首页", "Home")}</option><option value="dashboard">{t("工作区概览", "Dashboard")}</option><option value="issues">{t("任务", "Issues")}</option><option value="projects">{t("项目", "Projects")}</option><option value="notifications">{t("活动通知", "Activity notifications")}</option><option value="members?tab=members">{t("成员与团队 · 成员", "Members & teams · Members")}</option><option value="members?tab=teams">{t("成员与团队 · 团队", "Members & teams · Teams")}</option><option value="members?tab=workload">{t("成员与团队 · 工作量", "Members & teams · Workload")}</option></PreferenceSelect>
    <PreferenceSelect label={t("默认打开任务", "Open tasks by default")} description={t("用于任务集合、项目任务与工作台任务入口。完整对象深链接和“展开”操作始终保留。", "Used in issue collections, project tasks and dashboard task links. Full-entity deep links and explicit Expand actions remain available.")} value={taskOpenMode} onChange={value => setPreferences({ taskOpenMode: value as DisplayPreferences["taskOpenMode"] })}><option value="panel">{t("侧栏面板", "Side panel")}</option><option value="page">{t("完整对象页", "Full entity page")}</option></PreferenceSelect>
    <SettingsNotice><p className="font-medium text-foreground">{t("删除前始终确认", "Always confirm deletion")}</p><p>{t("不可关闭。删除、归档与恢复继续使用现有权限、受保护状态及确认流程；这里没有绕过安全确认的开关。", "Cannot be disabled. Deletion, archival and recovery retain their existing permissions, protected states and confirmation flows; no bypass is provided here.")}</p></SettingsNotice>
  </SettingsSection>
}
