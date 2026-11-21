import { useId, type ReactNode } from "react"
import { Link, useParams } from "react-router"
import { Monitor, Moon, Sun } from "lucide-react"
import { Field } from "@/components/ui/field"
import { useWorkspaceStore } from "@/providers/app-providers"
import { formatPreferenceDate, formatPreferenceTime } from "@/features/workspace/preference-format"
import type { DisplayPreferences } from "@/features/workspace/store"
import { usePersonalDashboard } from "../pm-service"
import { useText } from "../pm-ui"
import { SettingsSection, type SettingsPageProps } from "./settings-shared"
import { RadixSelect } from "@/components/ui/radix-select"
import { FontPreferenceControl } from "./settings-font-preference"

const selectClass = "min-h-10 w-full rounded-control border bg-surface px-3 text-sm focus-visible:ring-2 focus-visible:ring-ring"
const accentColors = { indigo: "#4b5bd6", blue: "#2563c5", violet: "#7348cc", teal: "#087b72", rose: "#b93663", graphite: "#525762" }

function BrowserScope() {
  const t = useText()
  const storage = useWorkspaceStore(state => state.preferenceStorage)
  return <div className="space-y-2 text-sm leading-6 text-muted-foreground">
    <p>{t("立即生效，仅保存在此浏览器；不写入账号或工作区数据。", "Applied immediately and saved in this browser only; nothing is written to your account or workspace.")}</p>
    {storage === "unavailable" && <p role="alert" className="text-destructive">{t("浏览器存储不可用；当前修改仅在本次会话有效。", "Browser storage is unavailable; changes last for this session only.")}</p>}
    {storage === "recovered" && <p role="status">{t("已忽略损坏的偏好值并使用安全默认值。", "Damaged preference values were replaced with safe defaults.")}</p>}
  </div>
}

function PreferenceSelect({ label, description, value, onChange, children }: { label: string; description?: string; value: string | number; onChange: (value: string) => void; children: ReactNode }) {
  return <Field className="max-w-2xl" label={label} description={description}>{control => <RadixSelect {...control} className={selectClass} value={value} onChange={event => onChange(event.target.value)}>{children}</RadixSelect>}</Field>
}

export function SettingsAppearance() {
  const t = useText()
  const id = useId()
  const { theme, accent, sidebarDensity, taskDensity, motion, setPreferences } = useWorkspaceStore(state => state)
  return <SettingsSection title={t("外观", "Appearance")}>
    <BrowserScope />
    <fieldset><legend className="mb-3 text-sm font-medium">{t("主题", "Theme")}</legend><div className="grid gap-3 sm:grid-cols-3">
      {([['light', t("浅色", "Light"), Sun], ['dark', t("深色", "Dark"), Moon], ['system', t("跟随系统", "System"), Monitor]] as const).map(([value, label, Icon]) => <label key={value} className={`min-w-0 cursor-pointer rounded-module border p-3 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring ${theme === value ? "border-ring bg-selection" : "bg-surface"}`}>
        <div aria-hidden="true" className={`mb-3 grid h-24 grid-cols-[28%_1fr] overflow-hidden rounded-control border ${value === "dark" ? "border-zinc-700 bg-zinc-900" : value === "system" ? "bg-gradient-to-r from-white via-white to-zinc-900" : "bg-white"}`}><div className={`space-y-2 border-r p-2 ${value === "dark" ? "border-zinc-700 bg-zinc-800" : "border-zinc-200 bg-zinc-100"}`}><span className="block h-2 rounded bg-accent" /><span className="block h-2 rounded bg-zinc-400" /><span className="block h-2 rounded bg-zinc-400" /></div><div className="space-y-3 p-3"><span className="block h-2 w-2/3 rounded bg-zinc-400" /><span className="block h-2 rounded bg-zinc-400/50" /><span className="block h-5 w-1/2 rounded bg-accent" /></div></div>
        <span className="flex items-center gap-2 text-sm"><input className="size-4 accent-[var(--accent)]" type="radio" name={`${id}-theme`} value={value} checked={theme === value} onChange={() => setPreferences({ theme: value })} /><Icon className="size-4" aria-hidden="true" />{label}</span>
      </label>)}
    </div><p className="mt-2 text-xs text-muted-foreground">{t("跟随系统会实时响应操作系统的深浅色变化。", "System responds live to operating-system light and dark mode changes.")}</p></fieldset>
    <Field className="max-w-2xl" label={t("界面字体", "Interface font")} description={t("与常规页共用同一浏览器偏好。", "Uses the same browser preference as General.")}>{control => <FontPreferenceControl id={control.id} describedBy={control["aria-describedby"]} />}</Field>
    <fieldset><legend className="mb-2 text-sm font-medium">{t("强调色", "Accent color")}</legend><p className="mb-3 text-xs text-muted-foreground">{t("应用于主要按钮、键盘焦点与选中状态；不改变工作流状态颜色。", "Used for primary buttons, keyboard focus and selection, not workflow status colors.")}</p><div className="flex flex-wrap gap-3">{(Object.keys(accentColors) as DisplayPreferences["accent"][]).map(value => <label key={value} className={`flex cursor-pointer items-center gap-2 rounded-control border px-3 py-2 text-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring ${accent === value ? "border-ring bg-selection" : ""}`}><input type="radio" name={`${id}-accent`} checked={accent === value} onChange={() => setPreferences({ accent: value })} className="size-4 accent-[var(--accent)]" /><span aria-hidden="true" className="size-4 rounded-full" style={{ background: accentColors[value] }} />{({ indigo: t("靛蓝", "Indigo"), blue: t("蓝色", "Blue"), violet: t("紫罗兰", "Violet"), teal: t("青绿", "Teal"), rose: t("玫红", "Rose"), graphite: t("石墨", "Graphite") })[value]}</label>)}</div></fieldset>
    <div className="grid max-w-2xl gap-6 sm:grid-cols-2">
      <PreferenceSelect label={t("侧栏密度", "Sidebar density")} description={t("仅调整工作区导航。", "Workspace navigation only.")} value={sidebarDensity} onChange={value => setPreferences({ sidebarDensity: value as DisplayPreferences["sidebarDensity"] })}><option value="comfortable">{t("舒适", "Comfortable")}</option><option value="compact">{t("紧凑", "Compact")}</option></PreferenceSelect>
      <PreferenceSelect label={t("任务密度", "Task density")} description={t("调整任务列表与卡片；不影响表单和源码。", "Task lists and cards only; forms and source are unchanged.")} value={taskDensity} onChange={value => setPreferences({ taskDensity: value as DisplayPreferences["taskDensity"] })}><option value="comfortable">{t("舒适", "Comfortable")}</option><option value="compact">{t("紧凑", "Compact")}</option></PreferenceSelect>
      <PreferenceSelect label={t("动效", "Motion")} description={t("系统已要求减少动效时始终遵守。", "The operating system’s reduced-motion request is always respected.")} value={motion} onChange={value => setPreferences({ motion: value as DisplayPreferences["motion"] })}><option value="system">{t("跟随系统", "Follow system")}</option><option value="reduce">{t("减少动效", "Reduce motion")}</option></PreferenceSelect>
    </div>
  </SettingsSection>
}

export function SettingsLanguage() {
  const t = useText()
  const { locale, spellcheck, setLocale, setPreferences } = useWorkspaceStore(state => state)
  return <SettingsSection title={t("语言", "Language")}>
    <BrowserScope />
    <PreferenceSelect label={t("界面语言", "Interface language")} description={t("支持简体中文与英文；部分源码与诊断信息保持原文。", "Simplified Chinese and English are supported; some source and diagnostic text remains untranslated.")} value={locale} onChange={value => { if (value === "zh-CN" || value === "en") setLocale(value) }}><option value="zh-CN">简体中文</option><option value="en">English</option>{["Deutsch", "Español", "Français", "日本語", "English (UK)"].map(language => <option key={language} value={language} disabled>{language} — {t("尚未翻译", "not translated")}</option>)}</PreferenceSelect>
    <label className="flex items-start gap-3 rounded-module border p-4"><input type="checkbox" className="mt-1 size-4 shrink-0 accent-[var(--accent)]" checked={spellcheck} onChange={event => setPreferences({ spellcheck: event.target.checked })} /><span className="space-y-1"><span className="block text-sm font-medium">{t("拼写检查", "Spellcheck")}</span><span className="block text-sm leading-6 text-muted-foreground">{t("用于富文本与纯文字评论；由浏览器词典提供，代码编辑器不启用。", "Used in rich-text and plain-text comments via the browser dictionary; source editors are excluded.")}</span></span></label>
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
  return <SettingsSection title={t("日期与时间", "Date & time")} description={t("调整显示格式，不改变任务日期或服务器时间。", "Change display formats without changing task dates or server time.")}>
    <BrowserScope />
    <div className="space-y-3 rounded-module border p-4"><h3 className="text-sm font-medium">{t("时区", "Time zone")}</h3>{mode === "service" ? <ProfileTimeZone /> : <p className="text-sm text-muted-foreground">{t("Lab 不读取正式个人时区。", "Lab does not read a service profile time zone.")}</p>}<p className="text-sm leading-6 text-muted-foreground">{t("个人工作台使用资料中的时区；未指定时区的时间戳按浏览器时区显示。", "The personal dashboard uses your profile time zone; timestamps without a zone use the browser zone.")}</p><Link className="inline-block rounded-control text-sm text-primary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring" to={`${mode === "lab" ? "/lab/pm" : "/pm"}/${encodeURIComponent(workspaceSlug)}/settings/profile`}>{t("在个人资料中管理时区", "Manage time zone in Profile")}</Link></div>
    <PreferenceSelect label={t("日期格式", "Date format")} value={dateFormat} onChange={value => setPreferences({ dateFormat: value as DisplayPreferences["dateFormat"] })}>{(["MMM d", "d/M", "M/d", "yyyy-MM-dd"] as const).map(value => <option key={value} value={value}>{value} · {formatPreferenceDate("2026-10-21", value, locale)}</option>)}</PreferenceSelect>
    <PreferenceSelect label={t("每周开始于", "Week starts on")} description={t("用于任务日历与周视图；不改变服务端汇总。", "Used in task calendars and weekly views; server totals are unchanged.")} value={weekStartsOn} onChange={value => setPreferences({ weekStartsOn: Number(value) as DisplayPreferences["weekStartsOn"] })}><option value="1">{t("星期一", "Monday")}</option><option value="0">{t("星期日", "Sunday")}</option><option value="6">{t("星期六", "Saturday")}</option></PreferenceSelect>
    <PreferenceSelect label={t("时间格式", "Time format")} value={timeFormat} onChange={value => setPreferences({ timeFormat: value as DisplayPreferences["timeFormat"] })}><option value="12">{t("12 小时制", "12-hour")}</option><option value="24">{t("24 小时制", "24-hour")}</option></PreferenceSelect>
    <p className="rounded-control border bg-surface-raised p-3 text-sm" aria-live="polite">{t("格式预览（UTC 示例）", "Format preview (UTC example)")}: {formatPreferenceDate("2026-10-21", dateFormat, locale)} · {formatPreferenceTime(sample, timeFormat, locale, "UTC")}</p>
  </SettingsSection>
}

export function SettingsPreferences() {
  const t = useText()
  const { startPage, taskOpenMode, setPreferences } = useWorkspaceStore(state => state)
  return <SettingsSection title={t("个人偏好", "Preferences")} description={t("设置默认入口与任务打开方式。", "Choose default entry points and how tasks open.")}>
    <BrowserScope />
    <PreferenceSelect label={t("启动页", "Start page")} description={t("用于选择工作区或打开工作区根地址时。", "Used when selecting a workspace or opening a workspace root URL.")} value={startPage} onChange={value => setPreferences({ startPage: value as DisplayPreferences["startPage"] })}><option value="home">{t("首页", "Home")}</option><option value="dashboard">{t("工作区概览", "Dashboard")}</option><option value="issues">{t("任务", "Issues")}</option><option value="projects">{t("项目", "Projects")}</option><option value="notifications">{t("活动通知", "Activity notifications")}</option><option value="members?tab=members">{t("成员与团队 · 成员", "Members & teams · Members")}</option><option value="members?tab=teams">{t("成员与团队 · 团队", "Members & teams · Teams")}</option><option value="members?tab=workload">{t("成员与团队 · 工作量", "Members & teams · Workload")}</option></PreferenceSelect>
    <PreferenceSelect label={t("默认打开任务", "Open tasks by default")} description={t("用于任务集合、项目任务与工作台入口；深链接不受影响。", "Used in issue collections, project tasks and dashboard links; deep links are unaffected.")} value={taskOpenMode} onChange={value => setPreferences({ taskOpenMode: value as DisplayPreferences["taskOpenMode"] })}><option value="panel">{t("侧栏面板", "Side panel")}</option><option value="page">{t("完整对象页", "Full entity page")}</option></PreferenceSelect>
  </SettingsSection>
}
