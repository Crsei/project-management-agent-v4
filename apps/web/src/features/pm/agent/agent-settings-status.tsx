import { useEffect, useMemo } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { z } from "zod"
import { agentsResponseSchema } from "@agent-workspace/contracts/collaboration"
import { pmToolCapabilitiesSchema } from "@agent-workspace/contracts/pm-capabilities"
import { Button } from "@/components/ui/button"
import { workspaceClient } from "../../agent/src/network"
import { collaborationJson, collaborationPath } from "../../agent/src/collaboration/data"
import { pmJson } from "../../agent/src/pm/state"
import { pmKeys } from "../service/pm-data"
import { usePmService } from "../service/pm-service"
import { useText } from "../service/pm-ui"

const accessSchema = z.object({ authorized: z.boolean(), configured: z.boolean() })
const declaredCapabilitySchema = z.object({ enabled: z.boolean() })
const declarationSchema = z.object({ business: declaredCapabilitySchema, markdownCore: declaredCapabilitySchema, storage: declaredCapabilitySchema, worker: declaredCapabilitySchema })
const readOptions = { retry: false, gcTime: 0, refetchOnWindowFocus: false } as const

function readFailure(cause: unknown, t: (zh: string, en: string) => string, authority: "PM" | "Agent" | "PM / Agent") {
  const status = cause instanceof Error && "status" in cause && typeof cause.status === "number" ? cause.status : null
  if (status === 401) return t(`${authority} 访问验证失效 · 未读取配置`, `${authority} authentication unavailable · Configuration not read`)
  if (status === 403) return t("当前范围无权读取 · 不是未配置", "No access in the current scope · Not an unconfigured state")
  if (cause instanceof z.ZodError) return t("响应合同不兼容 · 当前能力未知", "Response contract incompatible · Current capability unknown")
  if (status === 404 || status === 405) return t("状态接口不可用 · 不推断整体部署版本", "Status endpoint unavailable · Overall deployment version is not inferred") + ` (HTTP ${status})`
  if (status === 412) return t("能力前提不兼容 · 未证明可执行", "Capability prerequisites incompatible · Execution unverified") + " (HTTP 412)"
  if (status === 400) return t("状态请求被拒绝 · 不能据此判断部署版本", "Status request rejected · Deployment version cannot be inferred") + " (HTTP 400)"
  return t("读取失败 · 当前状态未知", "Read failed · Current status unknown") + (status ? ` (HTTP ${status})` : "")
}

/** PM-hosted, read-only facts. Mount only inside PmServiceProvider, never in Lab. */
export function AgentSettingsStatus({ projectId }: { projectId?: string }) {
  const t = useText()
  const service = usePmService()
  const queryClient = useQueryClient()
  const { actor, workspace } = service
  const pmReadable = !service.loading && !service.error && !!actor && !!workspace && workspace.capabilities.includes("domain.read") && (!projectId || workspace.projectIds === null || workspace.projectIds.includes(projectId))
  const key = useMemo(() => [...pmKeys.workspace(window.location.origin, actor?.id ?? "anonymous", workspace?.id ?? "none"), "agent-settings-status", service.actorEpoch, workspace?.version ?? null, projectId ?? "workspace"], [actor?.id, workspace?.id, service.actorEpoch, workspace?.version, projectId])
  const access = useQuery({
    ...readOptions,
    queryKey: [...key, "access"],
    queryFn: async ({ signal }) => accessSchema.parse(await workspaceClient.json<unknown>("/api/access", { signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]), cache: "no-store" })),
  })
  const pmCapabilities = useQuery({
    ...readOptions,
    queryKey: [...key, "pm-capabilities"],
    enabled: pmReadable,
    queryFn: async ({ signal }) => {
      const query = new URLSearchParams(projectId ? { projectId } : {})
      const path = `/api/v1/workspaces/${encodeURIComponent(workspace!.id)}/agent-capabilities${query.size ? `?${query}` : ""}`
      const result = pmToolCapabilitiesSchema.parse(await pmJson<unknown>(path, { signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]), cache: "no-store" }))
      return { scope: result.scope.kind, allowed: result.tools.filter(tool => tool.allowed).length, total: result.tools.length }
    },
  })
  const agentAuthorized = !access.error && !access.isPaused && access.data?.configured === true && access.data.authorized === true
  const pmScopeRejected = pmCapabilities.error instanceof Error && "status" in pmCapabilities.error && (pmCapabilities.error.status === 401 || pmCapabilities.error.status === 403)
  const canReadDefinitions = pmReadable && !pmScopeRejected && workspace?.projectIds === null && agentAuthorized
  const definitions = useQuery({
    ...readOptions,
    queryKey: [...key, "collaboration-definitions"],
    enabled: canReadDefinitions,
    queryFn: async ({ signal }) => {
      const result = agentsResponseSchema.parse(await collaborationJson<unknown>(collaborationPath("agents", workspace!.id)!, { signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]), cache: "no-store" }))
      return { active: result.agents.filter(agent => agent.state === "active").length }
    },
  })
  useEffect(() => {
    if (!pmReadable) {
      void queryClient.cancelQueries({ queryKey: [...key, "pm-capabilities"], exact: true })
      queryClient.removeQueries({ queryKey: [...key, "pm-capabilities"], exact: true })
    }
    if (!canReadDefinitions) {
      void queryClient.cancelQueries({ queryKey: [...key, "collaboration-definitions"], exact: true })
      queryClient.removeQueries({ queryKey: [...key, "collaboration-definitions"], exact: true })
    }
  }, [pmReadable, canReadDefinitions, key, queryClient])
  const declaration = useMemo(() => declarationSchema.safeParse(service.capabilities), [service.capabilities])
  const pmDeclaration = service.loading ? t("正在读取现有 PM 能力声明", "Reading the existing PM capability declaration")
    : service.error ? readFailure(service.error, t, "PM")
      : !service.capabilities ? t("能力声明未知 · 不推断已启用或已就绪", "Capability declaration unknown · Enablement and readiness are not inferred")
        : !declaration.success ? t("PM 能力声明合同不兼容 · 启用状态未知", "PM capability declaration contract incompatible · Enablement unknown")
          : [
            [t("业务", "Business"), declaration.data.business.enabled],
            [t("Markdown 核心", "Markdown core"), declaration.data.markdownCore.enabled],
            [t("附件存储", "Attachment storage"), declaration.data.storage.enabled],
            [t("Worker", "Worker"), declaration.data.worker.enabled],
          ].map(([label, enabled]) => `${label}: ${enabled ? t("声明启用", "declared enabled") : t("声明未启用", "declared disabled")}`).join(" · ")
  const pmAuthorization = service.loading ? t("正在读取 PM 会话", "Reading PM session")
    : service.error ? readFailure(service.error, t, "PM")
      : pmScopeRejected ? readFailure(pmCapabilities.error, t, "PM")
      : !actor ? t("无 PM 登录 · 业务能力未读取", "No PM authentication · Business capabilities not read")
        : !workspace ? t("工作区不可访问 · 请重新选择范围", "Workspace unavailable · Select an accessible scope")
          : !pmReadable ? t("当前范围无业务读取权限", "No business read permission in the current scope")
            : t("当前 PM 会话与工作区已读取 · 不授予新权限", "Current PM session and workspace read · No new access granted")
  const agentAccess = access.error ? readFailure(access.error, t, "Agent")
    : access.isPaused ? t("读取暂停 · 当前 Agent 验证状态未知", "Read paused · Current Agent authentication unknown")
      : !access.data ? t("正在读取独立 Agent 访问验证", "Reading separate Agent access verification")
        : !access.data.configured ? t("Agent 访问验证未配置 · 不是 PM 未登录", "Agent access verification not configured · Separate from PM sign-in")
          : !access.data.authorized ? t("无 Agent 访问验证 · PM 登录不能替代", "No Agent authentication · PM sign-in does not replace it")
            : t("Agent 访问验证已通过 · 未检查模型可执行性", "Agent access verified · Model execution not checked")
  const pmTools = !pmReadable ? t("未读取 · 先核对 PM 登录、权限与范围", "Not read · Check PM authentication, permissions, and scope")
    : pmCapabilities.error ? readFailure(pmCapabilities.error, t, "PM")
      : pmCapabilities.isPaused ? t("读取暂停 · 旧能力快照不可作为授权", "Read paused · Previous capability snapshot is not authorization")
        : !pmCapabilities.data ? t("正在读取现有 PM 工具能力合同", "Reading the existing PM tool capability contract")
          : t(`当前授权允许 ${pmCapabilities.data.allowed} / ${pmCapabilities.data.total} 个工具；范围：${pmCapabilities.data.scope === "workspace" ? "工作区" : "项目"}`, `Current authorization allows ${pmCapabilities.data.allowed} / ${pmCapabilities.data.total} tools; scope: ${pmCapabilities.data.scope}`)
  const collaboration = !pmReadable || pmScopeRejected ? t("未读取 · PM 业务授权不可用", "Not read · PM business authorization unavailable")
    : workspace?.projectIds !== null ? t("未读取 · 配置管理要求现有全工作区权限", "Not read · Configuration management requires existing workspace-wide access")
      : !agentAuthorized ? t("未读取 · 先核对独立 Agent 访问验证", "Not read · Check separate Agent access verification first")
        : definitions.error ? readFailure(definitions.error, t, "PM / Agent")
          : definitions.isPaused ? t("读取暂停 · 配置状态未知", "Read paused · Configuration state unknown")
            : !definitions.data ? t("正在读取协作配置合同", "Reading collaboration configuration contract")
              : definitions.data.active === 0 ? t("接口可读 · 尚无活动 Agent 配置（含未配置或仅停用/归档）", "Endpoint readable · No active Agent definitions (unconfigured or only disabled / archived)")
                : t(`接口可读 · ${definitions.data.active} 个活动配置；不代表运行就绪`, `Endpoint readable · ${definitions.data.active} active definitions; runtime readiness unverified`)
  const busy = access.isFetching || pmCapabilities.isFetching || definitions.isFetching
  const facts = [
    [t("PM 能力声明 · 非运行就绪证明", "PM declarations · Not runtime readiness"), pmDeclaration],
    [t("PM 访问与范围", "PM access & scope"), pmAuthorization],
    [t("Agent 独立访问", "Separate Agent access"), agentAccess],
    [t("现有 PM 工具能力", "Existing PM tool capabilities"), pmTools],
    [t("协作配置接口", "Collaboration configuration API"), collaboration],
  ]
  return <section className="min-w-0 space-y-3 rounded-module border bg-surface p-4" aria-label={t("只读服务与能力状态", "Read-only service & capability status")}>
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">{t("只读服务与能力状态", "Read-only service & capability status")}</h3><Button variant="outline" size="sm" disabled={busy} onClick={() => { void access.refetch(); if (pmReadable) void pmCapabilities.refetch(); if (canReadDefinitions) void definitions.refetch() }}>{t("重新读取状态", "Reread status")}</Button></div>
    <dl className="grid min-w-0 gap-3 sm:grid-cols-2" aria-live="polite" aria-busy={busy}>{facts.map(([label, value]) => <div key={label} className="min-w-0 space-y-1 rounded-control bg-surface-raised p-3"><dt className="text-xs font-medium text-muted-foreground">{label}</dt><dd className="break-words text-sm leading-6">{value}</dd></div>)}</dl>
    {((access.error && access.data) || (pmCapabilities.error && pmCapabilities.data) || (definitions.error && definitions.data)) && <p role="alert" className="text-xs leading-5 text-destructive">{t("重新读取失败；保留的旧快照已过期，不作为当前可用或授权依据。", "Reread failed; retained snapshots are stale, not evidence of current availability or authorization.")}</p>}
    <p className="text-xs leading-5 text-muted-foreground">{t("只读取现有会话、访问验证、PM 能力与协作配置合同，不检查付费 Provider、不发现/启动 MCP、不创建或运行执行、不发送外部消息。配置接口可读不证明模型、Worker、远端连接或执行环境就绪；这些状态仍待各自明确核对。没有版本探测或自动升级。", "Only existing session, access, PM capability, and collaboration configuration contracts are read. No paid Provider checks, MCP discovery / startup, execution creation / dispatch, or external messages occur. A readable configuration API does not prove model, Worker, remote connection, or execution-environment readiness; those remain separately unverified. No version probing or automatic upgrades.")}</p>
  </section>
}
