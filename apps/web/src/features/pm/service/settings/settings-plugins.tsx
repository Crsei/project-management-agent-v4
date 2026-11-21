import { useId, useRef, useState } from "react"
import { ChevronRight, Search } from "lucide-react"
import { Link, useLocation, useParams } from "react-router"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { allowed, useText } from "../pm-ui"
import { useMemberInvitations } from "../pm-member-hooks"
import { pmErrorMessage, usePmService, usePrivateQuery } from "../pm-service"
import { pmKeys } from "../pm-data"
import { useWebhooks } from "./use-webhooks"
import { pluginCatalog, pluginCategories, type PluginCategory, type PluginDefinition } from "./plugin-catalog"
import { SettingsSection, type SettingsPageProps } from "./settings-shared"
import { RadixSelect } from "@/components/ui/radix-select"

function PluginImplementation({ plugin }: { plugin: PluginDefinition }) {
  const t = useText()
  return <div className="flex min-w-0 flex-wrap gap-2 text-xs leading-5">
    <span className={`rounded-full border px-2 py-0.5 ${plugin.implementation === "builtin" ? "bg-primary/10 text-primary" : "bg-surface-raised text-muted-foreground"}`}>
      {plugin.implementation === "builtin"
        ? t("已有内置实现", "Built-in implementation")
        : t("未实现 · 不可用", "Not implemented · Unavailable")}
    </span>
    {plugin.retired && <span className="rounded-full border bg-surface-raised px-2 py-0.5 text-muted-foreground">{t("服务已退役", "Service retired")}</span>}
  </div>
}

type CatalogFilter = "all" | "supported" | "unconfigured" | "planned"
const DEFAULT_FILTER: CatalogFilter = "supported"

type PluginState = "configured" | "unconfigured" | "configuration_error" | "fetch_error" | "forbidden" | "unauthenticated" | "loading" | "unknown" | "lab"
type PluginStatus = { state: PluginState; stale?: boolean; error?: string; accountBindings?: number }

export function SettingsPlugins({ mode }: SettingsPageProps) {
  return mode === "service" ? <ServicePluginCatalog /> : <PluginCatalogSurface mode="lab" />
}

function ServicePluginCatalog() {
  const t = useText()
  const service = usePmService()
  const readable = !!service.actor && !!service.workspace && !service.error
  const canManage = readable && allowed(service.workspace, "access.manage")
  const canReadIm = readable && !!service.workspace?.capabilities.includes("domain.read")
  const canReadWebhooks = canManage && ["domain.read", "audit.read"].every(capability => allowed(service.workspace, capability))
  const imQuery = usePrivateQuery(
    [...pmKeys.workspace(window.location.origin, service.actor?.id ?? "anonymous", service.workspace?.id ?? "none"), "im-catalog"],
    "domain.read",
    undefined,
    (client, workspaceId, signal) => client.getImSettings(workspaceId, { signal }),
    canReadIm,
  )
  const invitations = useMemberInvitations()
  const webhooks = useWebhooks(canReadWebhooks)
  const status = (permitted: boolean, query: { data: unknown; error: Error | null; isPending: boolean; isPaused: boolean }, configuration?: boolean | "configured" | "disabled" | "configuration_error"): PluginStatus => {
    if (service.loading) return { state: "loading" }
    if (service.error) return { state: "fetch_error", error: t(pmErrorMessage(service.error, "zh"), pmErrorMessage(service.error, "en")) }
    if (!service.actor) return { state: "unauthenticated" }
    if (!permitted) return { state: "forbidden" }
    if (query.error) return { state: "fetch_error", stale: !!query.data, error: t(pmErrorMessage(query.error, "zh"), pmErrorMessage(query.error, "en")) }
    if (query.isPaused) return { state: "unknown", stale: !!query.data }
    if (!query.data) return { state: query.isPending ? "loading" : "unknown" }
    return { state: configuration === "configuration_error" ? "configuration_error" : configuration === true || configuration === "configured" ? "configured" : configuration === false || configuration === "disabled" ? "unconfigured" : "unknown" }
  }
  const imStatus = status(canReadIm, imQuery, imQuery.data?.configuration)
  const statuses: Record<string, PluginStatus> = {
    "koishi-satori": { ...imStatus, ...(imQuery.data && (imStatus.state === "configured" || imStatus.state === "unconfigured") ? { accountBindings: imQuery.data.bindings.length } : {}) },
    "smtp-invitations": status(canManage, invitations, invitations.data?.enabled),
    webhook: status(canReadWebhooks, webhooks, webhooks.data?.configuration),
  }
  return <PluginCatalogSurface mode="service" statuses={statuses} {...(readable && service.workspace ? { workspaceId: service.workspace.id } : {})} />
}

function PluginCatalogSurface({ mode, statuses = {}, workspaceId }: SettingsPageProps & { statuses?: Record<string, PluginStatus>; workspaceId?: string }) {
  const t = useText()
  const id = useId()
  const { workspaceSlug = "" } = useParams()
  const location = useLocation()
  const [search, setSearch] = useState("")
  const [category, setCategory] = useState<PluginCategory | "all">("all")
  const [filter, setFilter] = useState<CatalogFilter>(DEFAULT_FILTER)
  const [selectedPlugin, setSelectedPlugin] = useState<PluginDefinition | null>(null)
  const searchInput = useRef<HTMLInputElement | null>(null)
  const detailsTrigger = useRef<HTMLButtonElement | null>(null)
  const detailsHeading = useRef<HTMLDivElement | null>(null)
  const serviceState = (plugin: PluginDefinition): PluginState => mode === "lab" ? "lab" : statuses[plugin.id]?.state ?? "unknown"
  const serviceLabel = (plugin: PluginDefinition) => {
    if (plugin.implementation !== "builtin") return t("PM 通用连接器未实现", "General PM connector not implemented")
    switch (serviceState(plugin)) {
      case "configured": return t("服务已配置 · 不代表送达", "Service configured · Delivery unverified")
      case "unconfigured": return t("服务未配置", "Service not configured")
      case "configuration_error": return t("部署配置错误 · 不可启用", "Deployment configuration error · Cannot enable")
      case "fetch_error": return statuses[plugin.id]?.stale ? t("状态读取失败 · 旧快照已过期", "Status read failed · Previous snapshot is stale") : t("状态读取失败 · 当前配置未知", "Status read failed · Current configuration unknown")
      case "forbidden": return t("无权读取配置 · 不是未配置", "Configuration access denied · Not an unconfigured state")
      case "unauthenticated": return t("PM 未登录 · 未读取配置", "Not signed in to PM · Configuration not read")
      case "loading": return t("正在读取状态", "Reading status")
      case "lab": return t("Lab · 不读取真实状态", "Lab · Live status not queried")
      default: return statuses[plugin.id]?.stale ? t("读取暂停 · 旧快照已过期", "Read paused · Previous snapshot is stale") : t("状态未知", "Status unknown")
    }
  }
  const searchTerms = search.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const orderedCatalog = [...pluginCatalog].sort((left, right) => Number(right.implementation === "builtin") - Number(left.implementation === "builtin") || left.id.localeCompare(right.id))
  const filteredPlugins = orderedCatalog.filter(plugin => {
    if (category !== "all" && plugin.category !== category) return false
    if (filter === "supported" && plugin.implementation !== "builtin") return false
    if (filter === "planned" && plugin.implementation !== "unimplemented") return false
    if (filter === "unconfigured" && (plugin.implementation !== "builtin" || serviceState(plugin) !== "unconfigured")) return false
    const searchableText = [
      plugin.id,
      ...plugin.name,
      ...plugin.summary,
      ...plugin.description,
      ...(plugin.searchTerms ?? []),
    ].join(" ").toLowerCase()
    return searchTerms.every(term => searchableText.includes(term))
  })
  const filtersActive = search !== "" || category !== "all" || filter !== DEFAULT_FILTER
  const settingsRoot = mode === "service" ? `/pm/${encodeURIComponent(workspaceSlug)}/settings` : ""
  const detailPath = (plugin: PluginDefinition) => plugin.id === "koishi-satori" ? `${settingsRoot}/im`
    : plugin.id === "smtp-invitations" ? `${settingsRoot}/integration-email`
      : plugin.id === "webhook" ? `${settingsRoot}/integration-webhook` : null
  const automationIntegrationPath = mode === "service" && workspaceId ? `/agent/automations/integrations?${new URLSearchParams({ workspace: workspaceId, returnTo: `${location.pathname}${location.search}${location.hash}` })}` : null
  const hasAutomationIntegration = (plugin: PluginDefinition) => plugin.id === "github" || plugin.id === "gitlab"
  const accountSummary = (plugin: PluginDefinition) => {
    const count = statuses[plugin.id]?.accountBindings
    return count === undefined ? null : count ? t(`我的账号：${count} 个绑定`, `My accounts: ${count} binding(s)`) : t("我的账号：暂无绑定", "My accounts: no bindings")
  }
  const selectedCategory = selectedPlugin && pluginCategories.find(entry => entry.id === selectedPlugin.category)
  const clearFilters = () => {
    setSearch("")
    setCategory("all")
    setFilter(DEFAULT_FILTER)
    searchInput.current?.focus()
  }

  return <SettingsSection
    title={t("集成目录", "Integration catalog")}
    description={t("连接第三方系统与服务；这里是集成目录，不扩大项目权限。", "Connect third-party systems and services; this catalog does not expand project access.")}
  >
    <div className="min-w-0 space-y-4">
      <div className="grid min-w-0 gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,13rem)]">
        <div className="min-w-0 space-y-2">
          <label htmlFor={`${id}-search`} className="text-sm font-medium">{t("搜索插件", "Search plugins")}</label>
          <div className="relative min-w-0">
            <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchInput}
              id={`${id}-search`}
              type="search"
              value={search}
              onChange={event => setSearch(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder={t("名称或说明，如邮箱、GitHub…", "Name or description, e.g. email, GitHub…")}
              aria-describedby={`${id}-search-hint`}
              aria-controls={`${id}-results`}
              className="pl-9"
            />
          </div>
        </div>
        <div className="min-w-0 space-y-2">
          <label htmlFor={`${id}-category`} className="text-sm font-medium">{t("分类", "Category")}</label>
          <RadixSelect
            id={`${id}-category`}
            value={category}
            onChange={event => setCategory(event.target.value as PluginCategory | "all")}
            aria-controls={`${id}-results`}
          >
            <option value="all">{t("全部分类", "All categories")}</option>
            {pluginCategories.map(entry => <option key={entry.id} value={entry.id}>{t(entry.label[0], entry.label[1])}</option>)}
          </RadixSelect>
        </div>
      </div>
      <p id={`${id}-search-hint`} className="text-xs leading-5 text-muted-foreground">{t("同时匹配中英文名称和说明；分类与搜索共同生效。", "Matches Chinese and English names and descriptions; category and search filters apply together.")}</p>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <div role="group" aria-label={t("集成状态筛选", "Integration state filter")} className="flex flex-wrap gap-1">
          {([['all', t("全部", "All")], ['supported', t("已支持", "Supported")], ['unconfigured', t("未配置", "Unconfigured")], ['planned', t("计划中", "Planned")]] as const).map(([value, label]) => <Button key={value} variant={filter === value ? "secondary" : "ghost"} size="sm" aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</Button>)}
        </div>
        <p role="status" aria-live="polite" aria-atomic="true" className="text-sm text-muted-foreground">
          {t(`显示 ${filteredPlugins.length} / ${pluginCatalog.length} 项`, `Showing ${filteredPlugins.length} of ${pluginCatalog.length}`)}
        </p>
        <Button variant="ghost" size="sm" disabled={!filtersActive} onClick={clearFilters}>{t("重置筛选", "Reset filters")}</Button>
      </div>
    </div>

    <div id={`${id}-results`} className="min-w-0">
      {filteredPlugins.length > 0 ? <ul className="grid min-w-0 gap-4 xl:grid-cols-2" aria-label={t("内置适配器目录", "Built-in adapter catalog")}>
        {filteredPlugins.map(plugin => {
          const Icon = plugin.icon
          const pluginCategory = pluginCategories.find(entry => entry.id === plugin.category)
          const name = t(...plugin.name)
          return <li key={plugin.id} className="flex min-w-0 flex-col rounded-module border bg-surface" aria-labelledby={`${id}-${plugin.id}-title`}>
            <div className="flex min-w-0 flex-1 flex-col gap-4 p-4">
              <div className="flex min-w-0 items-start gap-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border bg-surface-raised">
                  <Icon aria-hidden="true" className="size-5" strokeWidth={1.7} />
                </span>
                <div className="min-w-0 space-y-1 py-0.5">
                  <h3 id={`${id}-${plugin.id}-title`} className="break-words text-sm font-semibold">{name}</h3>
                  {pluginCategory && <p className="text-xs leading-5 text-muted-foreground">{t(pluginCategory.label[0], pluginCategory.label[1])}</p>}
                </div>
              </div>
              <PluginImplementation plugin={plugin} />
              <p className="break-words text-sm leading-6 text-muted-foreground">{t(...plugin.summary)}</p>
              <p className="text-xs leading-5"><span className="text-muted-foreground">{t("服务状态：", "Service status: ")}</span>{serviceLabel(plugin)}</p>
              {accountSummary(plugin) && <p className="text-xs leading-5 text-muted-foreground">{accountSummary(plugin)}</p>}
              {statuses[plugin.id]?.error && <p role="alert" className="break-words text-xs leading-5 text-destructive">{statuses[plugin.id]?.error}</p>}
              {hasAutomationIntegration(plugin) && <p className="text-xs leading-5 text-muted-foreground">{t("已有独立的自动化原生 API / MCP 连接，不等于此 PM 通用连接器；进入后须明确选择项目。", "Separate native API / MCP automation connections exist; they are not this general PM connector. Choose an explicit project after opening.")}</p>}
            </div>
            <div className="flex flex-wrap gap-2 border-t p-3">
              {mode === "service" && detailPath(plugin) && <Button variant="outline" size="sm" className="min-w-0 flex-1" render={<Link to={detailPath(plugin)!} />}>{t("打开设置", "Open settings")}</Button>}
              {automationIntegrationPath && hasAutomationIntegration(plugin) && <Button variant="outline" size="sm" className="min-w-0 flex-1" render={<Link to={automationIntegrationPath} />}>{t("自动化专用连接", "Automation connections")}</Button>}
              <Button
                variant="ghost"
                size="sm"
                className="min-w-0 flex-1 justify-between"
                aria-haspopup="dialog"
                aria-label={t(`查看 ${name} 的详情`, `View details for ${name}`)}
                onClick={event => {
                  detailsTrigger.current = event.currentTarget
                  setSelectedPlugin(plugin)
                }}
              >
                {t("详情", "Details")}
                <ChevronRight aria-hidden="true" className="size-4 shrink-0" />
              </Button>
            </div>
          </li>
        })}
      </ul> : <div className="space-y-3 rounded-module border border-dashed bg-surface-raised px-4 py-8 text-center">
        <Search aria-hidden="true" className="mx-auto size-6 text-muted-foreground" />
        <h3 className="text-sm font-semibold">{t("没有匹配的插件", "No matching plugins")}</h3>
        <p className="text-sm leading-6 text-muted-foreground">{t("试试其他中英文关键词，或清除搜索和分类重新浏览目录。", "Try another Chinese or English keyword, or clear search and category filters to browse the catalog again.")}</p>
        <Button variant="outline" onClick={clearFilters}>{t("清除搜索与分类", "Clear search & category")}</Button>
      </div>}
    </div>

    <Dialog open={selectedPlugin !== null} onOpenChange={open => { if (!open) setSelectedPlugin(null) }}>
      {selectedPlugin && <DialogContent
        className="max-w-xl"
        initialFocus={detailsHeading}
        finalFocus={() => detailsTrigger.current?.isConnected ? detailsTrigger.current : searchInput.current}
      >
        <div ref={detailsHeading} tabIndex={-1} className="min-w-0 break-words outline-none">
          <DialogTitle>{t(...selectedPlugin.name)} · {t("插件详情", "Plugin details")}</DialogTitle>
          <DialogDescription>{t(...selectedPlugin.description)}</DialogDescription>
        </div>
        <DialogBody className="space-y-4 break-words">
          <PluginImplementation plugin={selectedPlugin} />
          <dl className="space-y-4 text-sm leading-6">
            {selectedCategory && <div className="space-y-1">
              <dt className="font-medium">{t("分类", "Category")}</dt>
              <dd className="text-muted-foreground">{t(selectedCategory.label[0], selectedCategory.label[1])}</dd>
            </div>}
            <div className="space-y-1">
              <dt className="font-medium">{selectedPlugin.implementation === "builtin" ? t("现有实现范围", "Existing implementation scope") : t("预期范围 · 尚未开放", "Intended scope · Not available")}</dt>
              <dd className="text-muted-foreground">{t(...selectedPlugin.scope)}</dd>
            </div>
            <div className="space-y-1">
              <dt className="font-medium">{selectedPlugin.implementation === "builtin" ? t("现有权限边界", "Existing permission boundaries") : t("预期权限评审 · 不会授予权限", "Intended permission review · No access granted")}</dt>
              <dd className="text-muted-foreground">{t(...selectedPlugin.access)}</dd>
            </div>
            <div className="space-y-1">
              <dt className="font-medium">{selectedPlugin.implementation === "builtin" ? t("实现边界与接入要求", "Implementation boundaries & requirements") : t("缺失适配器与接入要求", "Missing adapter & requirements")}</dt>
              <dd className="text-muted-foreground">{t(...selectedPlugin.requirements)}</dd>
            </div>
          </dl>
          {hasAutomationIntegration(selectedPlugin) && <div className="space-y-2 text-sm text-muted-foreground"><p>{t("自动化控制台已有 GitHub / GitLab 原生连接，按其独立授权管理，不提供此目录规划的通用同步。", "The automation console has native GitHub / GitLab connections under separate authorization; it does not provide the general sync planned here.")}</p>{automationIntegrationPath && <Link className="text-primary underline-offset-4 hover:underline" to={automationIntegrationPath}>{t("进入自动化连接 · 先选择项目", "Open automation connections · Choose a project first")}</Link>}</div>}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => setSelectedPlugin(null)}>{t("关闭详情", "Close details")}</Button>
        </DialogFooter>
      </DialogContent>}
    </Dialog>
  </SettingsSection>
}
