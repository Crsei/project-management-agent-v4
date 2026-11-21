import { Link, useLocation } from "react-router"
import { UsageNavigationLink } from "../../agent/src/usage/navigation"
import { usePmService } from "../service/pm-service"
import { useText } from "../service/pm-ui"
import { SettingsSection, type SettingsPageProps } from "../service/settings/settings-shared"
import { AgentSettingsStatus } from "./agent-settings-status"

const linkClass = "block min-w-0 space-y-1 rounded-module border bg-surface p-4 text-sm hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
const localEntrypoints = [
  { path: "/agent/settings/general", name: ["Agent 通用设置", "Agent general settings"], detail: ["对话行为、输入与会话偏好", "Chat behavior, input, and session preferences"] },
  { path: "/agent/settings/providers", name: ["Provider", "Providers"], detail: ["本机模型与原生执行器配置；不等于模型或余额验收", "Local models and native executors; configuration is not proof of model access or balance"] },
  { path: "/agent/settings/mcp-servers", name: ["MCP Servers", "MCP servers"], detail: ["原有统一 MCP 管理，不是 PM 连接器安装", "Existing unified MCP management, not PM connector installation"] },
  { path: "/agent/settings/skills", name: ["Skills", "Skills"], detail: ["原生能力安装与配置；不授予 PM 业务权限", "Native capability installation and configuration; no PM business access granted"] },
  { path: "/agent/settings/history", name: ["Agent 数据与历史", "Agent data & history"], detail: ["现有备份、恢复与历史管理，不是 PM 业务审计", "Existing backup, restore, and history management, not PM business audit"] },
  { path: "/agent/workspace", name: ["Agent Chat", "Agent Chat"], detail: ["独立文件夹与会话；PM 工作区不是执行目录", "Independent folders and sessions; a PM workspace is not an execution folder"] },
] as const

export function SettingsAgent({ mode }: SettingsPageProps) {
  const t = useText()
  return <SettingsSection title={t("Agent 能力与入口", "Agent capabilities & entrypoints")} description={t("本机 Agent 配置与 PM 协作入口。", "Local Agent settings and PM collaboration entrypoints.")}>
    <nav aria-label={t("本机 Agent 设置与数据", "Local Agent settings & data")} className="grid min-w-0 gap-3 sm:grid-cols-2">
      {localEntrypoints.map(item => <Link key={item.path} className={linkClass} to={item.path}><span className="font-medium text-primary">{t(item.name[0], item.name[1])}</span><p className="text-xs leading-5 text-muted-foreground">{t(item.detail[0], item.detail[1])}</p></Link>)}
      <UsageNavigationLink className={linkClass}><span className="font-medium text-primary">{t("Agent Usage", "Agent Usage")}</span><p className="text-xs leading-5 text-muted-foreground">{t("本机已记录的调用与 Token；不是实时余额、订阅、真人席位或云存储账单。缺失计量仍未知。", "Locally recorded calls and tokens, not a live balance, subscription, human-seat, or cloud-storage bill. Missing measurements remain unknown.")}</p></UsageNavigationLink>
    </nav>
    {mode === "service" ? <ServiceAgentEntrypoints /> : <div className="space-y-2 text-sm text-muted-foreground"><p>{t("Lab 仅展示导航，不调用 PM / Agent 状态接口。", "Lab shows navigation only and makes no PM / Agent status calls.")}</p><Link className="text-primary underline-offset-4 hover:underline" to="/pm">{t("打开真实工作区", "Open a real workspace")}</Link></div>}
  </SettingsSection>
}

function ServiceAgentEntrypoints() {
  const t = useText()
  const service = usePmService()
  const location = useLocation()
  const workspace = service.workspace
  const collaborationScope = new URLSearchParams(workspace ? { workspaceId: workspace.id } : {})
  const automationScope = new URLSearchParams(workspace ? { workspace: workspace.id, returnTo: `${location.pathname}${location.search}${location.hash}` } : {})
  const scopedEntrypoints = [
    { path: `/agent/agents?${collaborationScope}`, name: ["Agents · 可复用执行身份", "Agents · Reusable execution identities"] },
    { path: `/agent/teams?${collaborationScope}`, name: ["AI Teams · 固定版本协作", "AI Teams · Fixed-version collaboration"] },
    { path: `/agent/runs?view=business${collaborationScope.size ? `&${collaborationScope}` : ""}`, name: ["Runs · 业务运行面板", "Runs · Business run board"] },
    { path: `/agent/inbox?${collaborationScope}`, name: ["Inbox · 原审批与待处理", "Inbox · Original approvals & attention"] },
    { path: `/agent/automations?${automationScope}`, name: ["自动化控制台", "Automation dashboard"] },
    { path: `/agent/automations/history?${automationScope}`, name: ["自动化运行历史", "Automation execution history"] },
    { path: `/agent/automations/git-sync?${automationScope}`, name: ["自动化 Git Sync", "Automation Git Sync"] },
    { path: `/agent/automations/integrations?${automationScope}`, name: ["自动化专用连接与事件", "Automation connections & events"] },
  ] as const
  return <>
    <AgentSettingsStatus />
    <section className="min-w-0 space-y-3">
      <h3 className="font-semibold">{t("PM 授权范围内的协作与自动化", "Collaboration & automations within PM authorization")}</h3>
      <p className="text-sm leading-6 text-muted-foreground">{t("这些是当前工作区入口，未自动选择项目。Agents / AI Teams 配置管理要求原有全工作区权限；业务 Runs 需明确选择项目、Issue 与版本；Inbox 按当前授权显示。Git Sync、连接与事件在目标页必须先选项目。导航不新建配置、不运行模型或自动化，也不扩大权限。", "These entrypoints use the current workspace without automatically choosing a project. Agents / AI Teams management requires existing workspace-wide access; business Runs require explicit project, Issue, and version selection; Inbox follows current authorization. Git Sync, connections, and events require project selection on the destination page. Navigation creates no configuration, runs no models or automations, and grants no access.")}</p>
      {service.actor && workspace && !service.error ? <nav aria-label={t("协作与自动化入口", "Collaboration & automation entrypoints")} className="grid min-w-0 gap-3 sm:grid-cols-2">{scopedEntrypoints.map(item => <Link key={item.path} className={linkClass} to={item.path}><span className="font-medium text-primary">{t(item.name[0], item.name[1])}</span></Link>)}</nav> : <p role="status" className="text-sm text-muted-foreground">{t("当前 PM 会话或工作区不可用；不生成带示例范围的业务入口。", "The current PM session or workspace is unavailable; no business entrypoints with sample scope are generated.")}</p>}
      {service.actor && workspace && !service.error && <Link className="text-sm text-primary underline-offset-4 hover:underline" to={`/pm/${encodeURIComponent(workspace.id)}/members?tab=members`}>{t("真人成员与团队 · 非 AI Teams", "Human members & teams · Not AI Teams")}</Link>}
    </section>
  </>
}
