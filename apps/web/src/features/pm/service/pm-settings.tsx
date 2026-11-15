import { Link } from "react-router"
import { RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useWorkspaceStore } from "@/providers/app-providers"
import { Choice, Panel, ServiceGuard, useText } from "./pm-ui"
import { usePmService } from "./pm-service"
import {
  dashboardViews,
  issueServiceViews,
  issueShowcaseViews,
  notificationViews,
  projectListViews,
  projectDetailViews,
  resetPmDisplaySettings,
  usePmDisplaySettings,
  usePmDisplayStorage,
  writePmDisplaySettings,
  type PmDisplaySettings,
} from "./pm-display-settings"

const dashboardLabels: Record<string, readonly [string, string]> = {
  dashboard1: ["个人工作概览", "Personal overview"],
  dashboard2: ["项目指标", "Project metrics"],
  dashboard3: ["交付指挥台", "Delivery console"],
  dashboard4: ["依赖地图", "Dependency map"],
}

const projectListLabels: Record<string, readonly [string, string]> = {
  list1: ["封面", "Cover"],
  list2: ["浏览", "Browse"],
  list3: ["表格", "Table"],
  list4: ["紧凑", "Compact"],
}

const projectDetailLabels: Record<string, readonly [string, string]> = {
  detail1: ["项目简报", "Project brief"],
  detail2: ["项目工作区", "Project workspace"],
}

const issueLabels: Record<string, readonly [string, string]> = {
  list1: ["列表", "List"],
  list2: ["分组列表", "Grouped list"],
  board1: ["看板", "Board"],
  board2: ["看板 · 列", "Board · columns"],
  board3: ["看板 · 紧凑", "Board · compact"],
  calendar1: ["日历", "Calendar"],
  calendar2: ["小时日历", "Hourly calendar"],
  gantt1: ["甘特图", "Gantt"],
  spreadsheet1: ["电子表格", "Spreadsheet"],
  dependencies: ["依赖关系", "Dependencies"],
  tree: ["项目树", "Project tree"],
}



const notificationLabels: Record<string, readonly [string, string]> = {
  inbox3: ["通知收件箱", "Notification inbox"],
  inbox4: ["通知集合", "Notification collection"],
}

function options(
  values: readonly string[],
  labels: Record<string, readonly [string, string]>,
  translate: (zh: string, en: string) => string,
) {
  return values.map((value) => {
    const label = labels[value]
    return { value, label: label ? translate(label[0], label[1]) : value }
  })
}

export function ServiceSettings() {
  return (
    <ServiceGuard>
      <ServiceSettingsContent />
    </ServiceGuard>
  )
}

function ServiceSettingsContent() {
  const { workspace } = usePmService()
  const t = useText()
  const theme = useWorkspaceStore((state) => state.theme)
  const setTheme = useWorkspaceStore((state) => state.setTheme)
  const locale = useWorkspaceStore((state) => state.locale)
  const setLocale = useWorkspaceStore((state) => state.setLocale)
  const preferenceStorage = useWorkspaceStore((state) => state.preferenceStorage)
  const settings = usePmDisplaySettings(workspace?.id)
  const layoutStorage = usePmDisplayStorage(workspace?.id)

  if (!workspace) return null

  const update = <K extends keyof PmDisplaySettings>(
    key: K,
    value: PmDisplaySettings[K],
  ) => {
    const next: PmDisplaySettings = { ...settings }
    next[key] = value
    writePmDisplaySettings(workspace.id, next)
  }

  const showcaseIssue = issueShowcaseViews.includes(
    settings.issueView as (typeof issueShowcaseViews)[number],
  )
  const serviceIssue = issueServiceViews.includes(
    settings.issueView as (typeof issueServiceViews)[number],
  )
  const notSelected = { value: "", label: t("未使用", "Not selected") }

  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 overflow-auto p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">{t("设置", "Settings")}</h1>
        <p className="text-sm text-muted-foreground">
          {t(
            "页面布局按工作区保存在当前浏览器；在此浏览器访问同一工作区的账号共用。主题与语言由此网站的浏览器偏好共享。均不修改业务数据或跨设备同步。",
            "Page layouts are saved per workspace in this browser and shared by accounts using that workspace here. Theme and language are shared browser preferences for this site. Neither changes business data or syncs across devices.",
          )}
        </p>
      </header>

      <Panel title={t("外观（此网站的浏览器偏好）", "Appearance (site-wide browser preferences)")}>
        {preferenceStorage === "unavailable" && <p role="alert" className="mb-4 text-sm text-destructive">{t("主题 / 语言的浏览器存储不可用或写入失败。当前选择仅在本次应用会话生效，刷新后可能丢失。", "Browser storage for theme / language is unavailable or a write failed. Current choices apply only to this app session and may be lost on reload.")}</p>}
        {preferenceStorage === "recovered" && <p role="status" className="mb-4 text-sm text-muted-foreground">{t("主题 / 语言等网站偏好中损坏或不支持的值已使用安全默认值；下次修改会保存有效设置。", "Damaged or unsupported site preferences, including theme / language, use safe defaults. Your next change saves valid settings.")}</p>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Choice
            label={t("主题", "Theme")}
            value={theme}
            onChange={(value) => {
              if (value === "light" || value === "dark" || value === "system") setTheme(value)
            }}
            options={[
              { value: "light", label: t("浅色", "Light") },
              { value: "dark", label: t("深色", "Dark") },
              { value: "system", label: t("跟随系统", "System") },
            ]}
          />
          <Choice
            label={t("界面语言", "Interface language")}
            value={locale}
            onChange={(value) => {
              if (value === "zh-CN" || value === "en") setLocale(value)
            }}
            options={[
              { value: "zh-CN", label: t("中文（简体）", "Chinese (Simplified)") },
              { value: "en", label: t("英文", "English") },
            ]}
          />
        </div>
      </Panel>

      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-medium">
              {t("页面布局（当前工作区 / 浏览器）", "Page layouts (this workspace / browser)")}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t(
                "选择真实服务页面使用的展示方式；只影响此浏览器中当前工作区的显示，不是团队共享默认值。",
                "Choose presentations for real-service pages. Only this browser’s display of the current workspace changes, not shared team defaults.",
              )}
            </p>
          </div>
          <Button
            variant="outline"
            onClick={() => resetPmDisplaySettings(workspace.id)}
          >
            <RotateCcw aria-hidden="true" />
            {t("恢复布局默认值", "Reset layout defaults")}
          </Button>
        </div>
        {layoutStorage === "unavailable" && <div role="alert" className="space-y-2 rounded-module border border-destructive/30 p-3 text-sm"><p>{t("当前工作区的布局存储不可用或写入失败。选择仍在内存中生效，刷新后可能丢失；不会用旧浏览器值覆盖本次修改。主题 / 语言的存储状态在上方单独显示。", "Layout storage for this workspace is unavailable or a write failed. Choices remain active in memory and may be lost on reload; older browser values will not replace this session’s edits. Theme / language storage status is shown separately above.")}</p><Button variant="outline" onClick={() => writePmDisplaySettings(workspace.id, settings)}>{t("重试保存当前布局", "Retry saving current layouts")}</Button></div>}
        {layoutStorage === "recovered" && <p role="status" className="text-sm text-muted-foreground">{t("已忽略损坏或不支持的布局值并采用安全默认值；下次选择或重置将保存有效布局。", "Damaged or unsupported layout values were replaced with safe defaults. Your next selection or reset saves valid layouts.")}</p>}
        <div className="grid gap-4 md:grid-cols-2">
          <Panel title={t("工作区概览", "Dashboard")}>
            <Choice
              label={t("概览布局", "Dashboard layout")}
              value={settings.dashboardView}
              onChange={(value) =>
                update("dashboardView", value as PmDisplaySettings["dashboardView"])
              }
              options={options(dashboardViews, dashboardLabels, t)}
            />
          </Panel>

          <Panel title={t("项目列表", "Projects")}>
            <Choice
              label={t("项目布局", "Project layout")}
              value={settings.projectListView}
              onChange={(value) =>
                update("projectListView", value as PmDisplaySettings["projectListView"])
              }
              options={options(projectListViews, projectListLabels, t)}
            />
          </Panel>

          <Panel title={t("项目详情", "Project details")}>
            <Choice
              label={t("详情布局", "Detail layout")}
              value={settings.projectDetailView}
              onChange={(value) =>
                update("projectDetailView", value as PmDisplaySettings["projectDetailView"])
              }
              options={options(projectDetailViews, projectDetailLabels, t)}
            />
          </Panel>

          <Panel title={t("任务列表", "Tasks")}>
            <fieldset className="space-y-3">
              <legend className="mb-2 text-sm font-medium">
                {t("展示视图", "Showcase views")}
              </legend>
              <Choice
                label={t("展示布局", "Showcase layout")}
                value={showcaseIssue ? settings.issueView : ""}
                onChange={(value) => {
                  if (value) {
                    update("issueView", value as PmDisplaySettings["issueView"])
                  }
                }}
                options={[
                  notSelected,
                  ...options(issueShowcaseViews, issueLabels, t),
                ]}
              />
              <Choice
                label={t("仅服务视图", "Service-only views")}
                value={serviceIssue ? settings.issueView : ""}
                onChange={(value) => {
                  if (value) {
                    update("issueView", value as PmDisplaySettings["issueView"])
                  }
                }}
                options={[
                  notSelected,
                  ...options(issueServiceViews, issueLabels, t),
                ]}
              />
              <p className="text-xs text-muted-foreground">
                {t(
                  "依赖关系和项目树使用真实服务数据，没有对应的组件展示页面。",
                  "Dependencies and the project tree use real-service data and have no component-showcase page.",
                )}
              </p>
            </fieldset>
          </Panel>


          <Panel title={t("成员与团队", "Members & teams")}>
            <p className="text-sm text-muted-foreground">
              {t("成员、团队和工作量通过功能页签切换；成员布局在成员页签内选择。", "Members, teams and workload use functional tabs. Choose member layouts inside the Members tab.")}
            </p>
            <Link className="inline-block rounded-control text-sm text-primary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring" to={`/pm/${encodeURIComponent(workspace.id)}/members?tab=members`}>
              {t("打开成员与团队", "Open members & teams")}
            </Link>
          </Panel>

          <Panel title={t("通知", "Notifications")}>
            <div className="space-y-3">
              <Choice
                label={t("通知布局", "Notification layout")}
                value={settings.notificationView}
                onChange={(value) =>
                  update("notificationView", value as PmDisplaySettings["notificationView"])
                }
                options={options(notificationViews, notificationLabels, t)}
              />
              <p className="text-xs text-muted-foreground">
                {t(
                  "inbox1、inbox2 和 inbox-email-1 仅在组件展示中提供：真实服务没有邮件或会话线程数据，因此不会伪造收件箱状态。",
                  "inbox1, inbox2 and inbox-email-1 exist only in the component showcase: the real service has no email or thread data, so inbox state is never fabricated.",
                )}
              </p>
            </div>
          </Panel>
        </div>
      </section>

      <Panel title={t("组件展示", "Component showcase")}>
        <p className="text-sm text-muted-foreground">
          {t(
            "浏览同一批页面的示例数据版本。组件展示与真实服务完全隔离，不写入后端。",
            "Browse example-data versions of the same pages. The component showcase is isolated from the real service and never writes to the backend.",
          )}
        </p>
        <Link className="text-sm text-primary hover:text-foreground" to="/lab/pm/execra-ai/projects">
          {t(
            "打开组件展示（示例数据）",
            "Open the component showcase (example data)",
          )}
        </Link>
      </Panel>
    </main>
  )
}
