import { useEffect, useRef, type ComponentType } from "react"
import { Link, useNavigate, useParams } from "react-router"
import { Bell, Blocks, ChevronRight, CreditCard, Settings2, ShieldCheck, UserRound, UsersRound } from "lucide-react"
import { ServiceGuard, useText } from "../pm-ui"
import { SettingsGeneral } from "./settings-general"
import { SettingsProfile } from "./settings-profile"
import { SettingsBilling } from "./settings-billing"
import { SettingsPlans } from "./settings-plans"
import { SettingsPlugins } from "./settings-plugins"
import { SettingsNotifications } from "./settings-notifications"
import { SettingsAppearance, SettingsLanguage, SettingsDateTime, SettingsPreferences } from "./settings-preferences"
import { SettingsWorkspace, SettingsMembers, SettingsTeams, SettingsProjects, SettingsPermissions } from "./settings-workspace"
import { SettingsPassword, SettingsSessions, SettingsTwoFactor } from "./settings-security"
import { SettingsEmailNotifications, SettingsPushNotifications, SettingsMentionNotifications, SettingsAssignmentNotifications } from "./settings-notification-events"
import { SettingsInvoices } from "./settings-invoices"
import { SettingsShortcuts } from "./settings-shortcuts"
import { settingsGroups, settingsPages, workspaceSettingsPages, type SettingsPageSlug } from "./settings-catalog"
import type { SettingsPageProps } from "./settings-shared"
import { SettingsAgent } from "../../agent/agent-settings-overview"
import { SettingsDesignSystem } from "./settings-design-system"

const components: Record<SettingsPageSlug, ComponentType<SettingsPageProps>> = {
  general: SettingsGeneral,
  workspace: SettingsWorkspace,
  appearance: SettingsAppearance,
  "design-system": SettingsDesignSystem,
  language: SettingsLanguage,
  datetime: SettingsDateTime,
  members: SettingsMembers,
  teams: SettingsTeams,
  projects: SettingsProjects,
  permissions: SettingsPermissions,
  notifications: SettingsNotifications,
  "notif-email": SettingsEmailNotifications,
  "notif-push": SettingsPushNotifications,
  "notif-mentions": SettingsMentionNotifications,
  "notif-assign": SettingsAssignmentNotifications,
  profile: SettingsProfile,
  preferences: SettingsPreferences,
  shortcuts: SettingsShortcuts,
  password: SettingsPassword,
  sessions: SettingsSessions,
  "two-factor": SettingsTwoFactor,
  plans: SettingsPlans,
  billing: SettingsBilling,
  invoices: SettingsInvoices,
  plugins: SettingsPlugins,
  agent: SettingsAgent,
}

const groupIcons = { general: Settings2, workspace: UsersRound, notifications: Bell, personal: UserRound, security: ShieldCheck, billing: CreditCard, integrations: Blocks }

export function SettingsRoute({ mode }: SettingsPageProps) {
  return mode === "service" ? <ServiceGuard><SettingsLayout mode={mode} /></ServiceGuard> : <SettingsLayout mode={mode} />
}

function SettingsLayout({ mode }: SettingsPageProps) {
  const t = useText()
  const { workspaceSlug = "", settingsPage = "general" } = useParams()
  const navigate = useNavigate()
  const scroller = useRef<HTMLDivElement>(null)
  const page = settingsPages.find(item => item.slug === settingsPage)
  const Page = page ? components[page.slug] : null
  const root = `${mode === "lab" ? "/lab/pm" : "/pm"}/${encodeURIComponent(workspaceSlug)}/settings`
  useEffect(() => { scroller.current?.scrollTo({ top: 0 }) }, [settingsPage])
  return <div ref={scroller} data-settings-mode={mode} data-pm-route-page className="relative min-h-0 min-w-0 flex-1 overflow-y-auto bg-surface">
    <div className="w-full px-4 pb-12 pt-5 sm:px-6 lg:px-8">
      <nav aria-label={t("面包屑", "Breadcrumb")} className="mb-6 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Link to={mode === "lab" ? "/lab/pm" : "/pm"} className="rounded-control hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">{t("项目管理", "Project Management")}</Link>
        <ChevronRight aria-hidden="true" className="size-3" />
        <Link to={`${root}/general`} className="rounded-control hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">{t("设置", "Settings")}</Link>
        <ChevronRight aria-hidden="true" className="size-3" />
        <span aria-current="page">{page ? t(page.zh, page.en) : t("页面不存在", "Page not found")}</span>
      </nav>
      <header className="mb-7 space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("设置", "Settings")}</h1>
        <p className="text-sm leading-6 text-muted-foreground">{t("管理浏览器偏好、账号安全、工作区与应用连接。各页会标明保存范围及服务可用性。", "Manage browser preferences, account security, your workspace and integrations. Each page identifies its storage scope and service availability.")}</p>
      </header>
      {mode === "lab" && <p role="note" className="mb-6 rounded-control border border-dashed px-3 py-2 text-xs leading-5 text-muted-foreground">{t("组件演示 · 业务表单只在当前页面预览，离开后重置，不写业务服务。浏览器外观与操作偏好会真实生效并尝试保存在本机；不会付款、投递通知或启用认证。", "Component showcase · Business forms preview only this page and reset when you leave, without service writes. Browser appearance and interaction preferences really apply and attempt to persist on this device. No payments, notification delivery or authentication setup occurs.")}</p>}
      <div className="grid min-w-0 gap-8 md:grid-cols-[180px_minmax(0,1fr)] lg:grid-cols-[190px_minmax(0,1fr)] lg:gap-12">
        <aside className="min-w-0">
          <label className="grid gap-2 text-sm md:hidden">
            <span className="sr-only">{t("设置页面", "Settings page")}</span>
            <select aria-label={t("设置页面", "Settings page")} value={page?.slug ?? ""} onChange={event => navigate(`${root}/${event.target.value}`)} className="h-11 w-full rounded-control border bg-surface px-3 focus-visible:ring-2 focus-visible:ring-ring">
              {!page && <option value="" disabled>{t("选择页面", "Choose page")}</option>}
              {settingsGroups.map(group => <optgroup key={group.id} label={t(group.zh, group.en)}>
                {settingsPages.filter(item => item.group === group.id).map(item => <option key={item.slug} value={item.slug}>{t(item.zh, item.en)}</option>)}
              </optgroup>)}
            </select>
          </label>
          <div className="md:sticky md:top-0 md:max-h-[calc(100dvh-7rem)] md:overflow-y-auto md:pr-2">
            <nav aria-label={t("设置导航", "Settings navigation")} className="hidden space-y-5 md:block">
              {settingsGroups.map(group => {
                const Icon = groupIcons[group.id]
                return <section key={group.id} aria-labelledby={`settings-group-${group.id}`}>
                  <h2 id={`settings-group-${group.id}`} className="mb-1 flex items-center gap-2 px-3 text-xs font-medium text-muted-foreground"><Icon aria-hidden="true" className="size-3.5" />{t(group.zh, group.en)}</h2>
                  <div className="space-y-0.5">{settingsPages.filter(item => item.group === group.id).map(({ slug, zh, en }) => <Link key={slug} to={`${root}/${slug}`} aria-current={slug === settingsPage ? "page" : undefined} className={`flex min-h-9 items-center rounded-control px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-ring ${slug === settingsPage ? "bg-selection font-medium text-foreground" : "text-muted-foreground hover:bg-surface-hover hover:text-foreground"}`}>{t(zh, en)}</Link>)}</div>
                </section>
              })}
            </nav>
            <nav aria-label={t("项目管理设置", "Project management settings")} className="mt-5 flex flex-wrap gap-3 border-t pt-4 text-xs text-muted-foreground md:flex-col md:gap-2">
              <h2 className="w-full font-medium">{t("项目管理设置", "Project management settings")}</h2>
              {workspaceSettingsPages.map(({ section, zh, en }) => mode === "service"
                ? <Link key={section} to={`${root}?section=${section}`} className="rounded-control py-1 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">{t(zh, en)}</Link>
                : <span key={section} aria-disabled="true" className="py-1">{t(zh, en)}</span>)}
              {mode === "lab" && <p className="w-full leading-5">{t("以上管理编辑器需要登录真实工作区；Lab 不提供模拟迁移或备份。", "These administration editors require a real workspace session. Lab does not simulate migrations or backups.")}</p>}
            </nav>
          </div>
        </aside>
        <main className="w-full min-w-0 max-w-[1160px]" key={`${mode}:${workspaceSlug}:${settingsPage}`}>
          {Page ? <Page mode={mode} /> : <div role="alert" className="space-y-3"><h2 className="text-lg font-semibold">{t("设置页面不存在", "Settings page not found")}</h2><Link to={`${root}/general`} className="underline">{t("返回设置概览", "Return to settings overview")}</Link></div>}
        </main>
      </div>
    </div>
  </div>
}
