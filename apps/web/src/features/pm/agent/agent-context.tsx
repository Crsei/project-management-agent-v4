import { useId, useState, type ReactNode } from "react"
import { Link } from "react-router"
import { Bot, ChevronDown, FolderKanban, ShieldCheck } from "lucide-react"
import type { AgentChatContextSource, AgentChatScope, AgentChatStatus } from "@contracts"
import { useI18n } from "@/lib/i18n-provider"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { usePmEntities, usePmService } from "../service/pm-service"
import { string, useText } from "../service/pm-ui"
import type { AgentAccessController } from "./agent-access"
import { agentErrorText } from "./agent-chat-queries"
import { agentObjectHref } from "./agent-tool-results"
import styles from "./agent-chat.module.css"

export function AgentContextSources({ sources, root }: { sources: AgentChatContextSource[]; root: string }) {
  const t = useText()
  const unique = [...new Map(sources.map(source => [`${source.kind}:${source.entityId}:${source.revision}`, source])).values()]
  if (!unique.length) return <p className={styles.runtimeMuted}>{t("尚无实际发送给模型的 PM 数据来源。选择范围不等于已发送数据。", "No PM data sources have been sent to the model. Selecting a scope does not send its data.")}</p>
  return <ul>{unique.map(source => <li key={`${source.kind}:${source.entityId}:${source.revision}`}>
    {source.kind === "comment" ? <span>{source.title || t("评论", "Comment")} <code>{source.entityId}</code></span> : <Link to={agentObjectHref(root, source.kind, source.entityId, source.projectId)}>{source.title || source.entityId}</Link>}
    {" · "}<span>{source.kind}</span>{" · "}<code>{source.revision}</code>
    {source.truncated && <strong> · {t("部分内容 / 已截断", "Partial / truncated")}</strong>}
  </li>)}</ul>
}

export function AgentRuntimeContextBar({ access: controller, sources, root, model, sourcesLoading = false, sourcesUnavailable = false, entryProjectId = null }: { access: AgentAccessController; sources: AgentChatContextSource[]; root: string; model: AgentChatStatus | null; sourcesLoading?: boolean; sourcesUnavailable?: boolean; entryProjectId?: string | null }) {
  const t = useText()
  const { locale } = useI18n()
  const access = controller.access
  const enabled = !!access?.enabled && (!access.expiresAt || Date.parse(access.expiresAt) > Date.now()) && !access.revokedAt
  const allowed = enabled ? access?.tools.filter(tool => tool.available && tool.allowed) ?? [] : []
  const settingsParams = controller.threadId ? `?${new URLSearchParams({ thread: controller.threadId })}` : ""
  return <section className={styles.runtimeBar} aria-label={t("真实上下文与有效能力", "Actual context and effective capabilities")}>
    <div className={styles.runtimeSummary}>
      <Bot size={14} aria-hidden="true" />
      <strong>Full access</strong>
      <span className={styles.accessBadge} data-enabled={enabled}>{controller.loading ? t("读取授权…", "Loading access…") : access ? enabled ? t("已启用", "Enabled") : t("已停用或到期", "Disabled or expired") : controller.threadId ? t("授权状态未知", "Access unknown") : t("尚未授权", "Not authorized")}</span>
      <span>{access?.scope.kind === "workspace" ? t("显式工作区范围", "Explicit workspace scope") : access?.scope.projectIds.length ? access.scope.projectIds.join(", ") : t("未绑定项目", "No projects bound")}</span>
      {entryProjectId && !access?.scope.projectIds.includes(entryProjectId) && <span className={styles.runtimeMuted} data-entry-project={entryProjectId}>{t(`入口项目 ${entryProjectId}`, `Entry project ${entryProjectId}`)}</span>}
      <Link to={`${root}/settings/agent${settingsParams}`}>{t("Agent 设置", "Agent settings")}</Link>
    </div>
    {!!controller.error && <div role="alert" className={styles.accessError}>{agentErrorText(controller.error, locale === "en")} <button type="button" className={styles.stopButton} disabled={controller.saving} onClick={() => void controller.refresh()}>{t("重新读取授权", "Reload access")}</button></div>}
    <details className={styles.runtimeDetails}>
      <summary>{t(`能力与实际来源 · ${allowed.length} 项有效工具`, `Capabilities and actual sources · ${allowed.length} effective tools`)}</summary>
      <p>{t("批准方式：Auto approve。已允许的普通读写动作会直接落地，不逐次确认。停止生成不撤销已提交的修改。", "Approval: Auto approve. Permitted ordinary reads and writes execute directly, without per-action confirmation. Stopping generation does not undo committed changes.")}</p>
      <p className={styles.runtimeMuted}>{t("模型配置", "Model configuration")}: {model?.enabled ? model.model ?? t("已配置", "Configured") : t("不可用", "Unavailable")} · {t("供应商工具调用", "Provider tool calling")}: {access?.toolSupport === "verified" ? t("已由实际调用验证", "Verified by an actual call") : t("尚未验证；已配置不代表工具已验证", "Unverified; configured does not mean verified")}</p>
      {access && <>
        <p>{t("范围冻结为", "Frozen scope")}: {access.scope.projectIds.join(", ") || t("无项目", "No projects")} · {t("版本", "Revision")} {access.revision} · {t("工具版本", "Tool version")} {access.toolsVersion}</p>
        {access.expiresAt && <p>{t("到期时间", "Expires")}: <time dateTime={access.expiresAt}>{new Date(access.expiresAt).toLocaleString(locale)}</time></p>}
        <p>{t("每次请求上限", "Per-request limits")}: {access.limits.maxToolCalls} {t("次调用", "calls")} / {access.limits.maxRounds} {t("轮", "rounds")} / {access.limits.maxOutputChars} {t("输出字符", "output characters")}</p>
        <ul>{access.tools.map(tool => <li key={tool.name}><code>{tool.name}</code>{" · "}{tool.write ? t("写入", "Write") : t("读取", "Read")}{" · "}{tool.available && tool.allowed && enabled ? t("可用", "Allowed") : tool.denyReason || t("当前不可用", "Not currently available")}<div className={styles.runtimeMuted}>{tool.description}</div></li>)}</ul>
      </>}
      <p className={styles.runtimeMuted}>{t("禁止自动完成 / 生命周期 / 删除归档 / 跨项目移动、ACL、秘密、Shell 和任意文件访问。原生权限与业务守卫始终生效。", "No automatic completion, lifecycle, deletion/archive, cross-project moves, ACL, secrets, shell or arbitrary file access. Native permissions and domain guards always apply.")}</p>
      <strong>{t("本线程实际提供给模型的来源（历史版本）", "Sources actually supplied to the model in this thread (historical revisions)")}</strong>
      {sourcesLoading ? <p role="status">{t("读取实际来源…", "Loading actual sources…")}</p> : sourcesUnavailable ? <p className={styles.accessError}>{t("实际来源尚未核对，不能视为没有来源。", "Actual sources have not been reconciled; this does not mean there are none.")}</p> : <AgentContextSources sources={sources} root={root} />}
    </details>
  </section>
}

function AgentControlSurface({ label, icon, expanded, children, open, onOpenChange, compact = false }: { label: string; icon: ReactNode; expanded: boolean; children: ReactNode; open?: boolean; onOpenChange?: (open: boolean) => void; compact?: boolean }) {
  if (expanded) return <section className={styles.scopePanel} aria-label={label}><h3 className={styles.controlHeading}>{icon}{label}</h3>{children}</section>
  return <Popover open={open} onOpenChange={onOpenChange}>
    <PopoverTrigger asChild>
      <button type="button" className={styles.permissionTrigger} aria-label={label} title={label}>
        {icon}<span className={styles.controlLabel}>{label}</span><ChevronDown size={12} aria-hidden="true" />
      </button>
    </PopoverTrigger>
    <PopoverContent side="top" align="start" collisionPadding={12} className={`${styles.permissionPopover} ${compact ? styles.permissionMenu : ""}`} aria-label={label}>{children}</PopoverContent>
  </Popover>
}

type AgentPickerProps = {
  access: AgentAccessController
  ensureThread: () => Promise<string>
  busy?: boolean
  expanded?: boolean
}

/** Selecting a mode is the authorization action; no second confirmation. */
export function AgentPermissionPicker({ access: controller, ensureThread, initialScope = null, busy = false, expanded = false }: AgentPickerProps & { initialScope?: AgentChatScope | null }) {
  const t = useText()
  const { locale } = useI18n()
  const { workspace } = usePmService()
  const id = useId()
  const [open, setOpen] = useState(false)
  const [localError, setLocalError] = useState<unknown>(null)
  const [submitting, setSubmitting] = useState(false)
  const access = controller.access
  const scope = access?.scope ?? (!controller.threadId ? initialScope : null)
  const unknown = !!controller.threadId && !access
  const enabled = !!access?.enabled
  const saving = submitting || controller.saving
  const blocked = saving || controller.loading || unknown
  const validScope = !!scope && (scope.kind === "workspace" ? workspace?.projectIds === null : scope.projectIds.length > 0)
  const selectMode = async (enable: boolean) => {
    if (blocked || enable === enabled || (enable && (busy || !scope || !validScope))) return
    setSubmitting(true)
    setLocalError(null)
    try {
      if (enable && scope) {
        const threadId = await ensureThread()
        await controller.enable({ kind: scope.kind, projectIds: scope.kind === "workspace" ? [] : scope.projectIds }, threadId)
      } else await controller.disable()
      setOpen(false)
    } catch (error) { setLocalError(error) }
    finally { setSubmitting(false) }
  }
  const label = unknown ? t("权限未知", "Access unknown") : enabled ? "Full access" : t("普通聊天", "Chat only")
  return <AgentControlSurface label={label} icon={<ShieldCheck size={14} aria-hidden="true" />} expanded={expanded} open={open} onOpenChange={setOpen} compact>
    <div className={styles.scopeForm}>
      <fieldset aria-busy={saving}>
        <legend className="sr-only">{t("权限模式", "Permission mode")}</legend>
        <label className={styles.permissionOption}>
          <input type="radio" name={`${id}-mode`} checked={!unknown && !enabled} disabled={blocked} onChange={() => void selectMode(false)} />
          <span><strong>{t("普通聊天", "Chat only")}</strong><small>{t("不使用 PM 工具", "No PM tools")}</small></span>
        </label>
        <label className={styles.permissionOption}>
          <input type="radio" name={`${id}-mode`} checked={!unknown && enabled} disabled={blocked || busy || !validScope} onChange={() => void selectMode(true)} />
          <span><strong>Full access</strong><small>{t("在所选范围内自动执行 PM 操作", "Automatically execute PM actions in the selected scope")}</small></span>
        </label>
      </fieldset>
      {saving ? <p role="status">{t("保存中…", "Saving…")}</p> : controller.loading ? <p role="status">{t("读取权限…", "Loading access…")}</p> : unknown ? <p role="alert">{t("权限状态未知，请重新读取。", "Access is unknown. Reload it before selecting a mode.")}</p> : access?.grantId && !enabled && !access.revokedAt ? <p role="status">{t("Full access 已失效，重新选择即可启用。", "Full access has expired or changed. Select it again to enable it.")}</p> : null}
      {!validScope && !unknown && <p className={styles.runtimeMuted}>{t("请先选择工作区或项目范围。", "Choose a workspace or project scope first.")}</p>}
      {!!(localError || controller.error) && <p role="alert" className={styles.accessError}>{agentErrorText(localError ?? controller.error, locale === "en")}</p>}
      {(unknown || !!localError || !!controller.error) && <button type="button" className={styles.stopButton} disabled={saving || controller.loading} onClick={() => { setLocalError(null); void controller.refresh() }}>{t("重新读取权限", "Reload access")}</button>}
      {expanded && <details className={styles.runtimeDetails}>
        <summary>{t("详情", "Details")}</summary>
        <p>{t("Full access 使用 Auto approve，授权有效期60分钟。所选范围内允许的动作直接落地，原生权限和业务校验仍生效；停止或切回普通聊天不会撤销已提交的修改。", "Full access uses Auto approve for 60 minutes. Permitted actions execute directly within the selected scope; native permissions and business guards still apply. Stopping or switching to chat only does not undo committed changes.")}</p>
        <p>{t("不开放自动完成、审核、删除归档、ACL、秘密、Shell 或任意文件访问。", "No automatic completion, approval, deletion/archive, ACL, secrets, shell or arbitrary file access.")}</p>
        {access?.expiresAt && <p>{t("到期时间", "Expires")}: <time dateTime={access.expiresAt}>{new Date(access.expiresAt).toLocaleString(locale)}</time></p>}
        {workspace && <Link to={`/pm/${encodeURIComponent(workspace.id)}/settings/agent${controller.threadId ? `?${new URLSearchParams({ thread: controller.threadId })}` : ""}`}>{t("查看能力与来源", "View capabilities and sources")}</Link>}
      </details>}
    </div>
  </AgentControlSurface>
}

/** Scope selection saves immediately without carrying a draft across threads. */
export function AgentContextPicker({ access: controller, ensureThread, initialProjectId = null, busy = false, expanded = false, hasComposerDraft = false }: AgentPickerProps & { initialProjectId?: string | null; hasComposerDraft?: boolean }) {
  const t = useText()
  const { locale } = useI18n()
  const service = usePmService()
  const { workspace, workspaces } = service
  const projects = usePmEntities("project")
  const [localError, setLocalError] = useState<unknown>(null)
  const [submitting, setSubmitting] = useState(false)
  const access = controller.access
  const available = projects.data ?? []
  const entry = available.find(project => project.id === initialProjectId)
  const initialScope: AgentChatScope = entry ? { kind: "projects", projectIds: [entry.id] } : workspace?.projectIds === null ? { kind: "workspace", projectIds: [] } : { kind: "projects", projectIds: [] }
  const scope = access?.scope ?? (!controller.threadId ? initialScope : { kind: "projects" as const, projectIds: [] })
  const selectedIds = scope.kind === "projects" ? scope.projectIds.filter(projectId => available.some(project => project.id === projectId)) : []
  const blocked = busy || submitting || controller.saving || controller.loading || service.loading || (!!controller.threadId && !access)
  const projectBlocked = blocked || !!service.error || projects.isPending || projects.isFetching || !!projects.error
  const save = async (nextScope: AgentChatScope) => {
    if (projectBlocked) return
    if (nextScope.kind === "workspace" ? workspace?.projectIds !== null : !nextScope.projectIds.length || nextScope.projectIds.some(projectId => !available.some(project => project.id === projectId))) return
    const enabled = !!access?.enabled
    setSubmitting(true)
    setLocalError(null)
    try {
      const threadId = await ensureThread()
      if (enabled) await controller.enable(nextScope, threadId)
      else await controller.saveScope(nextScope, threadId)
    } catch (error) { setLocalError(error) }
    finally { setSubmitting(false) }
  }
  const projectName = (projectId: string) => {
    const project = available.find(item => item.id === projectId)
    return project ? string(project.data.title) || string(project.data.name) || projectId : projectId
  }
  const rangeLabel = controller.threadId && !access ? t("上下文未知", "Context unknown") : scope.kind === "workspace" ? t("全部项目", "All projects") : scope.projectIds.length ? scope.projectIds.map(projectName).join(", ") : t("选择项目", "Choose projects")
  const label = `${workspace?.name ?? t("工作区", "Workspace")} / ${rangeLabel}`
  return <AgentControlSurface label={label} icon={<FolderKanban size={14} aria-hidden="true" />} expanded={expanded}>
    <div className={styles.contextColumns} aria-busy={submitting || controller.saving}>
      <section className={styles.contextColumn} aria-label={t("工作区", "Workspace")}>
        <h4>{t("工作区", "Workspace")}</h4>
        <div className={styles.contextOptions}>
          {workspaces.filter(candidate => candidate.capabilities.includes("domain.read")).map(candidate => candidate.id === workspace?.id
            ? <span key={candidate.id} className={styles.workspaceCurrent} aria-current="location">{candidate.name}</span>
            : <a key={candidate.id} className={styles.workspaceChoice} href={`/pm/${encodeURIComponent(candidate.id)}/agent?new=1`} aria-disabled={blocked || !!service.error} onClick={event => {
              if (blocked || service.error || (hasComposerDraft && !window.confirm(t("切换工作区将离开未发送的消息，打开新对话。继续？", "Switching workspaces leaves your unsent message and opens a new chat. Continue?")))) event.preventDefault()
            }}>{candidate.name}</a>)}
        </div>
        {!!service.error && <p role="alert" className={styles.accessError}>{agentErrorText(service.error, locale === "en")} <button type="button" className={styles.stopButton} disabled={busy || submitting || service.loading} onClick={() => { setLocalError(null); void service.refresh().catch(setLocalError) }}>{t("重试", "Retry")}</button></p>}
      </section>
      <section className={styles.contextColumn} aria-label={t("项目", "Projects")}>
        <h4>{t("项目", "Projects")}</h4>
        <div className={styles.contextOptions}>
          {workspace?.projectIds === null && <button type="button" className={styles.contextProject} aria-pressed={scope.kind === "workspace"} disabled={projectBlocked} onClick={() => { if (scope.kind !== "workspace" || !controller.threadId) void save({ kind: "workspace", projectIds: [] }) }}>{t("全部项目", "All projects")}</button>}
          {available.map(project => {
            const selected = scope.kind === "projects" && scope.projectIds.includes(project.id)
            return <label key={project.id} className={styles.contextProject}>
              <input type="checkbox" checked={selected} disabled={projectBlocked || (selected && selectedIds.length === 1)} onChange={event => void save({ kind: "projects", projectIds: event.target.checked ? [...selectedIds, project.id] : selectedIds.filter(value => value !== project.id) })} />
              <span>{projectName(project.id)}</span>
            </label>
          })}
          {!projects.isPending && !projects.error && !available.length && <p className={styles.runtimeMuted}>{t("暂无项目", "No projects")}</p>}
          {scope.kind === "projects" && scope.projectIds.filter(projectId => !available.some(project => project.id === projectId)).map(projectId => <p key={projectId} className={styles.accessError}>{t("项目不可用", "Project unavailable")}: {projectId}</p>)}
        </div>
        {(projects.isPending || projects.isFetching || controller.loading || submitting || controller.saving) && <span role="status" className="sr-only">{t("正在更新项目范围…", "Updating project scope…")}</span>}
        {!!projects.error && <p role="alert" className={styles.accessError}>{agentErrorText(projects.error, locale === "en")} <button type="button" className={styles.stopButton} disabled={blocked} onClick={() => void projects.refetch()}>{t("重试", "Retry")}</button></p>}
        {!!(localError || controller.error) && <p role="alert" className={styles.accessError}>{agentErrorText(localError ?? controller.error, locale === "en")}{controller.threadId && <button type="button" className={styles.stopButton} disabled={busy || submitting || controller.saving || controller.loading} onClick={() => { setLocalError(null); void controller.refresh() }}>{t("重新读取", "Reload")}</button>}</p>}
      </section>
    </div>
  </AgentControlSurface>
}
