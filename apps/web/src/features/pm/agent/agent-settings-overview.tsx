import { Link, useParams, useSearchParams } from "react-router"
import { useI18n } from "@/lib/i18n-provider"
import { pmKeys } from "../service/pm-data"
import { usePmService, usePrivateQuery } from "../service/pm-service"
import { useText } from "../service/pm-ui"
import { SettingsNotice, SettingsSection, type SettingsPageProps } from "../service/settings/settings-shared"
import { useAgentThreadAccess } from "./agent-access"
import { agentErrorText, useAgentChatQueries } from "./agent-chat-queries"
import { AgentContextPicker, AgentPermissionPicker, AgentRuntimeContextBar } from "./agent-context"
import styles from "./agent-chat.module.css"

export function SettingsAgent({ mode }: SettingsPageProps) {
  const t = useText()
  return <SettingsSection title={t("Agent", "Agent")} description={t("当前私有聊天的 Full access、真实范围与已接通能力；不改变手工 PM 权限。", "Full access, actual scope and connected capabilities for the current private chat. Manual PM permissions are unchanged.")} wide>
    {mode === "service" ? <ScopedAgentSettings /> : <SettingsNotice>{t("Agent 授权仅适用于登录后的真实工作区聊天；此处不提供模拟启用。", "Agent authorization is available only for real signed-in workspace chats. No simulated enablement is offered here.")}</SettingsNotice>}
  </SettingsSection>
}

function ScopedAgentSettings() {
  const { actor, actorEpoch, workspace } = usePmService()
  const t = useText()
  if (!actor || !workspace) return <p role="alert">{t("请先登录并选择工作区。", "Sign in and select a workspace first.")}</p>
  return <AgentSettingsOverview key={`${actor.id}:${actorEpoch}:${workspace.id}:${workspace.version}`} />
}

export function AgentSettingsOverview() {
  const t = useText()
  const { locale } = useI18n()
  const { actor, workspace } = usePmService()
  const { workspaceSlug = "" } = useParams<{ workspaceSlug: string }>()
  const root = `/pm/${encodeURIComponent(workspaceSlug)}`
  const [params, setParams] = useSearchParams()
  const threadId = params.get("thread")
  const access = useAgentThreadAccess(threadId)
  const { status, threads } = useAgentChatQueries()
  const history = usePrivateQuery([...pmKeys.agentChat(window.location.origin, actor?.id ?? "anonymous", workspace?.id ?? "none"), "settings-history", threadId ?? "none"], "domain.read", undefined, (client, workspaceId, signal) => client.getAgentThread(workspaceId, threadId!, { signal }), !!threadId)
  const historyBusy = history.isPending || history.isFetching || !!history.error || !!history.data?.messages.some(message => message.status === "streaming" || message.toolCalls?.some(call => call.status === "running" || call.status === "unknown"))
  return <div className="space-y-5">
    <label className="grid max-w-xl gap-2 text-sm"><span>{t("关联当前私有聊天线程", "Link to the current private chat thread")}</span>
      <select className="min-h-10 rounded-control border bg-surface px-3 focus-visible:ring-2 focus-visible:ring-ring" value={threadId ?? ""} disabled={access.saving || (!!threadId && historyBusy)} onChange={event => {
        const next = new URLSearchParams(params)
        if (event.target.value) next.set("thread", event.target.value)
        else next.delete("thread")
        setParams(next, { replace: true })
      }}>
        <option value="">{t("明确选择聊天线程", "Explicitly choose a chat thread")}</option>
        {threadId && !threads.data?.items.some(thread => thread.id === threadId) && <option value={threadId}>{threadId}</option>}
        {threads.data?.items.map(thread => <option key={thread.id} value={thread.id}>{thread.title}</option>)}
      </select>
    </label>
    {threads.error && <p role="alert" className={styles.accessError}>{agentErrorText(threads.error, locale === "en")} <button type="button" className={styles.stopButton} onClick={() => void threads.refetch()}>{t("重新读取线程", "Reload threads")}</button></p>}
    {status.error && <p role="alert" className={styles.accessError}>{agentErrorText(status.error, locale === "en")} <button type="button" className={styles.stopButton} onClick={() => void status.refetch()}>{t("重新读取模型状态", "Reload model status")}</button></p>}
    {!threadId ? <SettingsNotice>{t("授权绑定当前用户、工作区和指定线程，不是全局开关。请明确选择一个已有线程，或回到 Agent 新建聊天；不会默认授权第一个项目或其他线程。", "Authorization is bound to the current user, workspace and chosen thread, not a global toggle. Explicitly select an existing thread or create a chat in Agent. No first project or other thread is authorized automatically.")}</SettingsNotice> : <>
      <AgentRuntimeContextBar access={access} sources={history.error ? [] : history.data?.messages.flatMap(message => message.contextSources ?? []) ?? []} root={root} model={status.data ?? null} sourcesLoading={history.isPending} sourcesUnavailable={!!history.error} />
      {history.error && <p role="alert" className={styles.accessError}>{t("无法核对该线程的实际上下文来源。", "Could not reconcile actual sources for this thread.")} {agentErrorText(history.error, locale === "en")}</p>}
      <div className={styles.settingsControls}>
        <AgentPermissionPicker key={`permissions:${threadId}`} access={access} ensureThread={async () => threadId} busy={historyBusy} expanded />
        <AgentContextPicker key={`context:${threadId}`} access={access} ensureThread={async () => threadId} busy={historyBusy} expanded />
      </div>
      <button type="button" className={styles.stopButton} disabled={access.saving || history.isFetching} onClick={() => void history.refetch()}>{t("核对当前线程与工具状态", "Reconcile current thread and tool state")}</button>
    </>}
    <Link className="inline-flex min-h-9 items-center text-sm underline underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring" to={`${root}/agent${threadId ? `?${new URLSearchParams({ thread: threadId })}` : ""}`}>{threadId ? t("返回此聊天线程", "Return to this chat thread") : t("打开 Agent 对话", "Open Agent chat")}</Link>
    <SettingsNotice>{t("Full access 不是系统 root：没有 shell、任意文件、秘密或 ACL 访问。到期或停用会阻止新工具动作；真实收据与已提交业务修改仍保留，原生编辑器不受影响。模型配置、工具支持和业务授权分别报告，不以配置成功冒充执行就绪。", "Full access is not system root: no shell, arbitrary files, secrets or ACL access. Expiry or disabling blocks new tool actions; real receipts and committed business changes remain, and native editors are unaffected. Model configuration, tool support and business authorization are reported separately; configuration alone is not execution readiness.")}</SettingsNotice>
  </div>
}
