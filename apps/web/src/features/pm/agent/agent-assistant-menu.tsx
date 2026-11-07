import { useCallback, useMemo, useState } from "react"
import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { useLocation } from "react-router"
import { Bot, ChevronDown, ExternalLink, History, MessageSquare, Play, Settings2 } from "lucide-react"
import { StudioApiError, StudioClient } from "../../../../../../packages/contracts/src/automation-studio-client"
import { studioCanRunWithoutConfirmation, studioCapabilitiesSchema, studioDefinitionSchema, studioPageSchema, type StudioDefinition } from "../../../../../../packages/contracts/src/automation-studio"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { useStudioActions } from "../../agent/src/pm/automation/studio-actions"
import { studioExecutionEnvironmentIssue, studioProviderToolReadiness } from "../../agent/src/pm/automation/studio-setup"
import { studioStatusLabel } from "../../agent/src/pm/automation/studio-view"
import { usePmEntity, usePmService, type Workspace } from "../service/pm-service"
import { allowed, useText } from "../service/pm-ui"
import styles from "./agent-shortcuts.module.css"

type Props = { projectId?: string; disabledReason?: string; className?: string }

/** One menu for saved project automations and scoped Agent Chat navigation. */
export function AgentAssistantMenu(props: Props) {
  const { actor, actorEpoch, workspace } = usePmService()
  if (!actor || !workspace || (props.projectId && !allowed(workspace, "domain.read", props.projectId))) return null
  return <ScopedAssistantShortcuts key={`${actor.id}:${actorEpoch}:${workspace.id}:${workspace.version}:${props.projectId ?? "none"}`} {...props} actorId={actor.id} workspace={workspace} />
}

function ScopedAssistantShortcuts({ projectId, disabledReason, className, actorId, workspace }: Props & { actorId: string; workspace: Workspace }) {
  const t = useText()
  const location = useLocation()
  const service = usePmService()
  const [open, setOpen] = useState(false)
  const [revoked, setRevoked] = useState(false)
  const [confirmation, setConfirmation] = useState<StudioDefinition | null>(null)
  const api = useMemo(() => new StudioClient(workspace.id), [workspace.id])
  const readable = !!projectId && allowed(workspace, "domain.read", projectId) && !revoked
  const revoke = useCallback(() => {
    setRevoked(true); setOpen(false); setConfirmation(null)
    void service.refresh().catch(() => { /* Existing service surfaces the access failure. */ })
  }, [service.refresh])
  const accessFailure = (cause: unknown) => {
    if (cause instanceof StudioApiError && [401, 403].includes(cause.status)) revoke()
  }
  const actions = useStudioActions(api, actorId, workspace.id, () => { setConfirmation(null) }, revoke, `${workspace.version}:${service.actorEpoch}`)
  const project = usePmEntity(projectId ?? "", readable)
  const scopeKey = ["pm-automation-shortcuts", actorId, service.actorEpoch, workspace.id, workspace.version, projectId]
  const capabilities = useQuery({
    queryKey: [...scopeKey, "capabilities"], enabled: readable && (open || !!confirmation), retry: false, gcTime: 0, refetchOnWindowFocus: false,
    queryFn: async ({ signal }) => {
      try { return studioCapabilitiesSchema.parse(await api.capabilities(projectId!, { signal })) }
      catch (cause) { accessFailure(cause); throw cause }
    },
  })
  const definitions = useInfiniteQuery({
    queryKey: [...scopeKey, "definitions"], enabled: readable && open, initialPageParam: undefined as string | undefined,
    retry: false, gcTime: 0, refetchOnWindowFocus: false,
    queryFn: async ({ signal, pageParam }) => {
      try {
        const page = studioPageSchema(studioDefinitionSchema).parse(await api.definitions(pageParam, { signal, projectId: projectId!, quickAccess: true }))
        if (page.items.some(item => item.config.projectId !== projectId || item.config.quickAccess !== true) || (page.nextCursor !== null && page.nextCursor === pageParam)) throw new Error("invalid_shortcut_page")
        return page
      } catch (cause) { accessFailure(cause); throw cause }
    },
    getNextPageParam: page => page.nextCursor ?? undefined,
  })
  const items = readable ? [...new Map(definitions.data?.pages.flatMap(page => page.items).map(item => [item.id, item]) ?? []).values()] : []
  const nextCursor = definitions.data?.pages.at(-1)?.nextCursor
  const paginationInvalid = !!nextCursor && definitions.data?.pageParams.includes(nextCursor) === true
  const returnTo = `${location.pathname}${location.search}${location.hash}`
  const baseQuery = new URLSearchParams({ workspace: workspace.id, returnTo })
  if (projectId) baseQuery.set("project", projectId)
  const manageUrl = `/agent/automations?${baseQuery}`
  const historyUrl = `/agent/automations/history?${baseQuery}`
  const chatUrl = `/agent/workspace?${baseQuery}`
  const settledExecution = actions.settled?.execution
  const accepted = readable && settledExecution && settledExecution.configSnapshot.projectId === projectId ? settledExecution : null
  const exactQuery = new URLSearchParams(baseQuery)
  if (accepted) exactQuery.set("run", accepted.id)
  const exactUrl = accepted ? `/agent/automations/detail/${encodeURIComponent(accepted.definitionId)}?${exactQuery}` : ""
  const scopeReason = !projectId ? t("请先选择项目以使用自动化快捷入口。", "Select a project to use automation shortcuts.")
    : !readable ? t("当前项目不可访问；请重新核对成员授权。", "This project is unavailable. Recheck membership access.")
    : disabledReason || (!allowed(workspace, "planning.edit", projectId) ? t("当前项目为只读，不能派发自动化。", "This project is read only; automations cannot be dispatched.")
      : project.error ? t("无法核对项目状态；请重新读取。", "Project status could not be checked. Read it again.")
      : !project.data || project.isFetching ? t("正在核对项目状态…", "Checking project status…")
      : project.data.data.archivedAt || ["completed", "cancelled", "closed", "archived"].includes(String(project.data.data.status ?? "")) ? t("项目已关闭或归档，不能派发自动化。", "Closed or archived projects cannot dispatch automations.") : "")
  const loading = definitions.isFetching || capabilities.isFetching
  const stateReason = actions.storageError ? t("恢复存储不可用；所有新派发暂停。", "Recovery storage is unavailable; new dispatches are paused.")
    : actions.pending || actions.busy ? t("请先核对正在处理的原请求；不会覆盖它。", "Resolve the original pending request first; it will not be overwritten.")
    : loading ? t("正在读取已保存配置与执行能力…", "Reading saved configurations and execution capabilities…")
    : definitions.error || capabilities.error || paginationInvalid ? t("读取失败；请刷新后再运行。", "Reading failed. Refresh before running.")
    : !capabilities.data || !definitions.data ? t("打开菜单以读取已保存自动化。", "Open the menu to load saved automations.")
    : !capabilities.data.canWrite ? t("当前授权或运行环境不允许派发。", "Current authorization or runtime does not allow dispatch.") : ""
  function reasonFor(item: StudioDefinition) {
    if (scopeReason || stateReason) return scopeReason || stateReason
    if (item.config.projectId !== projectId || item.config.quickAccess !== true) return t("配置不属于当前项目快捷入口。", "This configuration is not a shortcut for the current project.")
    if (item.status === "draft") return t("草稿不能直接运行；请先完成配置并启用。", "Drafts cannot run directly. Complete configuration and enable first.")
    if (studioExecutionEnvironmentIssue(item.config.action, !!item.executionUnavailableReason)) return t("请在自动化编辑器明确选择独立 Agent Workspace 文件夹；旧目录配置不会自动转换，也不会回退对话临时目录或 PM 文档目录。", "Explicitly choose an independent Agent Workspace folder in the automation editor. Old directory settings are never converted automatically and chat scratch or PM document folders are never substituted.")
    const action = capabilities.data?.actions.find(action => action.id === item.config.action.kind)
    if (!action?.available) return action?.reason ?? t("此动作的执行环境尚未就绪。", "The runtime for this action is not ready.")
    const tools = studioProviderToolReadiness(item.config, capabilities.data ?? null)
    return tools.available ? "" : tools.reason ?? t("所选 Provider 尚未就绪。", "The selected Provider is not ready.")
  }
  function run(item: StudioDefinition) {
    if (reasonFor(item)) return
    const frozen = structuredClone(item)
    if (studioCanRunWithoutConfirmation(frozen.config)) {
      void actions.execute({ kind: "run", id: frozen.id, expectedRevision: frozen.revision })
    } else setConfirmation(frozen)
  }
  function confirmRun() {
    if (!confirmation || reasonFor(confirmation)) return
    void actions.execute({ kind: "run", id: confirmation.id, expectedRevision: confirmation.revision })
    setConfirmation(null)
  }
  return <span className={styles.entry}>
      <DropdownMenu open={open && !revoked} onOpenChange={value => { if (!revoked) setOpen(value) }}>
        <DropdownMenuTrigger render={<Button type="button" variant="outline" size="sm" className={[styles.trigger, className].filter(Boolean).join(" ")} disabled={revoked} data-testid="agent-automation-shortcuts" aria-label={t("Agent 助手", "Agent assistant")} title={revoked ? t("项目授权已失效，请重新核对。", "Project access expired. Recheck access.") : t("自动化任务与 Agent Chat", "Automations and Agent Chat")} />}><Bot size={14} aria-hidden="true" /><span>{t("Agent 助手", "Agent assistant")}</span><ChevronDown size={14} aria-hidden="true" /></DropdownMenuTrigger>
        <DropdownMenuContent align="end" className={styles.menu} aria-label={t("项目自动化快捷入口", "Project automation shortcuts")}>
          <DropdownMenuLabel className={styles.label}>{t("自动化快捷入口", "Automation shortcuts")}</DropdownMenuLabel>
          <p className={styles.hint}>{t("仅运行已保存版本，不包含未保存的 PM 草稿；可能产生模型费用。分析候选仍需另外确认应用。", "Runs only the saved revision, excluding unsaved PM drafts; model costs may apply. Analysis candidates still require separate approval to apply.")}</p>
          {scopeReason && <p role="status" className={styles.hint}>{scopeReason}</p>}
          {readable && <>
            {loading && <p role="status" className={styles.hint}>{t("正在读取快捷入口…", "Loading shortcuts…")}</p>}
            {(definitions.error || capabilities.error || paginationInvalid || project.error) && <div role="alert" className={styles.hint}><p>{t("无法完整读取快捷入口；未运行任何自动化。", "Shortcuts could not be loaded fully. No automation was run.")}</p><Button variant="outline" size="sm" disabled={loading} onClick={() => { void project.refetch(); void definitions.refetch(); void capabilities.refetch() }}>{t("重新读取", "Read again")}</Button></div>}
            {stateReason && !loading && <p role="status" className={styles.hint}>{stateReason}</p>}
            {definitions.data && !definitions.error && !loading && !items.length && <p role="status" data-testid="automation-shortcuts-empty" className={styles.hint}>{t("此项目尚未设置快捷入口。请在自动化配置中勾选“Agent 助手快捷入口”。", "No shortcuts are configured for this project. Check “Agent assistant shortcut” in an automation's configuration.")}</p>}
            {items.map(item => {
              const reason = reasonFor(item)
              const safe = studioCanRunWithoutConfirmation(item.config)
              return <DropdownMenuItem key={item.id} data-testid={`automation-shortcut-${item.id}`} disabled={!!reason} title={reason || item.config.description} onSelect={() => run(item)} className={styles.item}>
                <Play size={14} aria-hidden="true" /><span><strong>{item.config.name}</strong><small>v{item.revision} · {studioStatusLabel(item.status, t)} · {safe ? t("原生 PM 分析", "Native PM analysis") : t("运行前需确认", "Confirmation required")}</small>{reason && <small>{reason}</small>}</span>
              </DropdownMenuItem>
            })}
            {definitions.hasNextPage && !paginationInvalid && <DropdownMenuItem closeOnClick={false} disabled={loading} data-testid="automation-shortcuts-load-more" onSelect={() => { void definitions.fetchNextPage() }}>{t("加载更多", "Load more")}</DropdownMenuItem>}
          </>}
          <DropdownMenuSeparator className={styles.separator} />
          <DropdownMenuItem render={<a href={manageUrl} data-testid="automation-shortcuts-manage" />}><Settings2 size={14} aria-hidden="true" />{t("管理自动化", "Manage automations")}</DropdownMenuItem>
          <DropdownMenuItem render={<a href={historyUrl} data-testid="automation-shortcuts-history" />}><History size={14} aria-hidden="true" />{t("运行历史", "Execution history")}</DropdownMenuItem>
          <DropdownMenuSeparator className={styles.separator} />
          <DropdownMenuItem render={<a href={chatUrl} data-testid="agent-shortcuts-chat" />}><MessageSquare size={14} aria-hidden="true" />{t("前往 Agent Chat", "Go to Agent Chat")}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    {!revoked && (actions.pending || actions.storageError || actions.error || accepted) && <span className={styles.feedback} data-testid="automation-shortcut-feedback">
      {actions.pending && <span role="status">{actions.busy ? t("原请求正在受理 / 核对…", "Original request being accepted / reconciled…") : t("原请求结果待核对；不会重复派发。", "Original outcome awaits reconciliation; it will not be redispatched.")} <code>{actions.pending.requestId}</code> <Button variant="outline" size="sm" disabled={actions.busy} onClick={() => void actions.reconcile()}>{t("核对原收据", "Check original receipt")}</Button></span>}
      {actions.storageError && <span role="alert">{t("恢复存储不可用，未确认的原请求不会被覆盖。", "Recovery storage is unavailable. The unconfirmed original request will not be overwritten.")} <Button variant="outline" size="sm" disabled={actions.busy} onClick={actions.retryStorage}>{t("重试恢复存储", "Retry recovery storage")}</Button></span>}
      {actions.error && <span role="alert">{actions.error}</span>}
      {accepted && <span role="status">{t("已受理，返回状态：", "Accepted, returned status: ")}{studioStatusLabel(accepted.status, t)} · v{accepted.definitionRevision}{accepted.error ? ` · ${accepted.error}` : ""} <code>{accepted.requestId}</code> <a href={exactUrl} data-testid="automation-shortcut-view-run">{accepted.status === "outcome_unknown" || accepted.status === "failed" ? t("查看原运行并核对结果", "Review the original execution and reconcile its outcome") : t("查看此次运行", "View this execution")}<ExternalLink size={12} aria-hidden="true" /></a></span>}
    </span>}
    <Dialog open={!!confirmation} onOpenChange={value => { if (!value) setConfirmation(null) }}>
      <DialogContent><DialogHeader><DialogTitle>{t("确认实际运行自动化", "Confirm actual automation execution")}</DialogTitle><DialogDescription>{t("运行已保存的冻结版本，可能调用模型、计费、执行脚本或产生外部写入；不是只读验证。不会自动采用更新版本或应用 PM 候选。", "Runs the frozen saved revision and may invoke a model, incur cost, run scripts, or write externally. This is not read-only validation. Newer revisions and PM candidates are never adopted or applied automatically.")}</DialogDescription></DialogHeader>
        {confirmation && <p>{confirmation.config.name} · v{confirmation.revision}</p>}
        {confirmation && reasonFor(confirmation) && <p role="status">{reasonFor(confirmation)}</p>}
        <DialogFooter><Button variant="outline" onClick={() => setConfirmation(null)}>{t("取消", "Cancel")}</Button><Button data-testid="automation-shortcut-confirm-run" disabled={!confirmation || !!reasonFor(confirmation)} onClick={confirmRun}>{t("确认运行已保存版本", "Run saved revision")}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </span>
}
