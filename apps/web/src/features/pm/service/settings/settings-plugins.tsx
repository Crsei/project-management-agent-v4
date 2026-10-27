import { useId, useRef, useState } from "react"
import { ChevronRight, Search } from "lucide-react"
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
import { NativeSelect } from "@/components/ui/native-select"
import { useText } from "../pm-ui"
import { pluginCatalog, pluginCategories, type PluginCategory, type PluginDefinition } from "./plugin-catalog"
import { PluginSmtpStatus } from "./plugin-smtp-status"
import { PluginWebhookStatus } from "./plugin-webhook-status"
import { SettingsNotice, SettingsSection, type SettingsPageProps } from "./settings-shared"

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

export function SettingsPlugins({ mode }: SettingsPageProps) {
  const t = useText()
  const id = useId()
  const [search, setSearch] = useState("")
  const [category, setCategory] = useState<PluginCategory | "all">("all")
  const [selectedPlugin, setSelectedPlugin] = useState<PluginDefinition | null>(null)
  const searchInput = useRef<HTMLInputElement | null>(null)
  const detailsTrigger = useRef<HTMLButtonElement | null>(null)
  const detailsHeading = useRef<HTMLDivElement | null>(null)
  const searchTerms = search.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const filteredPlugins = pluginCatalog.filter(plugin => {
    if (category !== "all" && plugin.category !== category) return false
    const searchableText = [
      plugin.id,
      ...plugin.name,
      ...plugin.summary,
      ...plugin.description,
      ...(plugin.searchTerms ?? []),
    ].join(" ").toLowerCase()
    return searchTerms.every(term => searchableText.includes(term))
  })
  const filtersActive = search !== "" || category !== "all"
  const selectedCategory = selectedPlugin && pluginCategories.find(entry => entry.id === selectedPlugin.category)
  const clearFilters = () => {
    setSearch("")
    setCategory("all")
    searchInput.current?.focus()
  }

  return <SettingsSection
    wide
    title={t("插件", "Plugins")}
    description={t("浏览内置适配器目录、预期访问范围与接入要求。管理项目和生成报告不需要连接外部应用。", "Browse the built-in adapter catalog, intended access, and integration requirements. No external connection is required to manage projects or generate reports.")}
  >
    <SettingsNotice>
      <div className="space-y-2">
        <p>{t(
          "这是随应用发布的产品目录，不是你的安装或账号连接状态，也不支持上传、下载或动态执行插件代码。SMTP 和安全出站 Webhook 有内置实现，真实配置及权限状态单独读取；其余连接器仍未实现、不可用。本页不提供 OAuth 或凭据表单。",
          "This is a shipped product catalog, not installation or connection status; dynamic plugin code is unsupported. SMTP and safe outbound Webhooks have built-in adapters, with real configuration and permission read separately. Other connectors remain unimplemented and unavailable. There are no OAuth or credential forms.",
        )}</p>
        {mode === "lab" && <p>{t(
          "Lab · 仅浏览同一份目录与静态接入说明，不读取真实配置或账号，不模拟已连接，也不请求业务服务。",
          "Lab · Browse the same catalog and static integration information only. No real configuration or accounts are read, no connected states are simulated, and no business-service requests are made.",
        )}</p>}
      </div>
    </SettingsNotice>

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
          <NativeSelect
            id={`${id}-category`}
            value={category}
            onChange={event => setCategory(event.target.value as PluginCategory | "all")}
            aria-controls={`${id}-results`}
          >
            <option value="all">{t("全部分类", "All categories")}</option>
            {pluginCategories.map(entry => <option key={entry.id} value={entry.id}>{t(entry.label[0], entry.label[1])}</option>)}
          </NativeSelect>
        </div>
      </div>
      <p id={`${id}-search-hint`} className="text-xs leading-5 text-muted-foreground">{t("同时匹配中英文名称和说明；分类与搜索共同生效。", "Matches Chinese and English names and descriptions; category and search filters apply together.")}</p>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <p role="status" aria-live="polite" aria-atomic="true" className="text-sm text-muted-foreground">
          {t(`显示 ${filteredPlugins.length} / ${pluginCatalog.length} 项产品信息`, `Showing ${filteredPlugins.length} of ${pluginCatalog.length} catalog entries`)}
        </p>
        <Button variant="ghost" size="sm" disabled={!filtersActive} onClick={clearFilters}>{t("清除筛选", "Clear filters")}</Button>
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
              {plugin.id === "smtp-invitations" && <PluginSmtpStatus mode={mode} />}
              {plugin.id === "webhook" && <PluginWebhookStatus mode={mode} />}
            </div>
            <div className="border-t p-3">
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-between"
                aria-haspopup="dialog"
                aria-label={t(`查看 ${name} 的详情`, `View details for ${name}`)}
                onClick={event => {
                  detailsTrigger.current = event.currentTarget
                  setSelectedPlugin(plugin)
                }}
              >
                {t("查看详情与接入要求", "Details & requirements")}
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
          <SettingsNotice>{selectedPlugin.implementation === "builtin" ? t(
            "这里仅展示静态产品说明，不再次查询或推断部署状态。请在对应目录卡片查看真实配置与授权结果；内置实现、配置启用、网络连通及接收器接受是不同事实。",
            "These are static product details, not another deployment-state inference. See the corresponding catalog card for actual configuration and permission results; adapter implementation, configuration enablement, connectivity and receiver acceptance are distinct facts.",
          ) : t(
            "以上仅为未来适配的范围与权限评审方向，不是服务商当前提供的实际授权范围，也不是已完成的功能。当前无可执行适配器，不会授权、读取、发送或同步外部数据；无需输入真实凭据。",
            "These are directions for future scope and permission reviews, not actual authorization scopes currently offered by a provider or completed features. No executable adapter is available. No external data is authorized, read, sent, or synchronized, and no real credentials are needed.",
          )}</SettingsNotice>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => setSelectedPlugin(null)}>{t("关闭详情", "Close details")}</Button>
        </DialogFooter>
      </DialogContent>}
    </Dialog>
  </SettingsSection>
}
