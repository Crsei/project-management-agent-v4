import { useState } from "react"
import { Link } from "react-router"
import { ArrowUpRight, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useMemberInvitations } from "../pm-member-hooks"
import { pmErrorMessage, usePmService } from "../pm-service"
import { allowed, useText } from "../pm-ui"
import { SettingsNotice, type SettingsPageProps } from "./settings-shared"

function InvitationServiceStatus({ membersHref }: { membersHref: string }) {
  const t = useText()
  const query = useMemberInvitations()
  const busy = query.isPending || query.isFetching || query.isPaused
  const data = query.error || busy ? undefined : query.data

  return <div className="min-w-0 space-y-3">
    <div aria-live="polite" aria-busy={busy} className="min-w-0 space-y-2 text-sm leading-6">
      {query.error ? <div role="alert" className="space-y-2 rounded-module border border-destructive/30 p-3">
        <p className="font-medium text-destructive">{t("读取失败 · 配置状态未知", "Read failed · Configuration unknown")}</p>
        <p>{t(pmErrorMessage(query.error, "zh"), pmErrorMessage(query.error, "en"))}</p>
        <p className="text-muted-foreground">{t("无法确认当前邀请服务状态；旧快照不作为可用依据。读取或配置错误不等于未配置。", "The current invitation service status cannot be confirmed; an old snapshot is not evidence of availability. A read or configuration error does not mean the service is unconfigured.")}</p>
      </div> : query.isPaused ? <p role="status">{t("读取已暂停，等待网络恢复；当前配置状态尚未确认。", "The read is paused until the network recovers; the current configuration is not confirmed.")}</p> : busy ? <p role="status">{query.data ? t("正在刷新邀请服务状态…旧快照暂不作为可用依据。", "Refreshing invitation service status… The previous snapshot is not evidence of current availability.") : t("正在读取邀请服务状态…", "Loading invitation service status…")}</p> : data ? <>
        <p className="font-medium">{data.enabled ? t("邀请服务已配置 / 启用", "Invitation service configured / enabled") : t("邀请服务未配置 / 未启用", "Invitation service unconfigured / disabled")}</p>
        <p className="text-muted-foreground">{data.enabled ? t("状态来自现有管理员邀请接口的 enabled 字段，仅表示邀请服务已配置 / 启用，不证明 SMTP 可达、Worker 健康或公网送达。", "This status comes from the existing administrator invitation API's enabled field. It only indicates invitation service configuration / enablement, not SMTP reachability, Worker health, or public email delivery.") : t("不能新建或重发邮件邀请。仍可到成员页面查看原有邀请记录并按权限撤销；给已有账号授权不依赖 SMTP。", "New email invitations and resends are unavailable. Existing invitation records remain accessible on the members page, with revocation subject to permission. Granting access to an existing account does not require SMTP.")}</p>
      </> : <p role="alert">{t("未取得邀请服务状态，不能判定为已配置或未配置。请重试读取。", "No invitation service status is available; it cannot be classified as configured or unconfigured. Retry the read.")}</p>}
    </div>
    <div className="flex min-w-0 flex-wrap gap-2">
      <Button variant="outline" size="sm" loading={query.isFetching} disabled={busy} onClick={() => { void query.refetch() }} className="h-auto min-h-9 w-full whitespace-normal py-2 sm:w-auto">
        {!query.isFetching && <RefreshCw aria-hidden="true" className="size-3.5 shrink-0" />}
        {query.error || !query.data ? t("重试读取", "Retry read") : t("刷新状态", "Refresh status")}
      </Button>
      <Button variant="outline" size="sm" render={<Link to={membersHref} />} className="h-auto min-h-9 w-full whitespace-normal py-2 sm:w-auto">
        {t("管理邀请记录", "Manage invitation records")}<ArrowUpRight aria-hidden="true" className="size-3.5 shrink-0" />
      </Button>
    </div>
    <p className="text-xs leading-5 text-muted-foreground">{t("此入口不发送邮件。查看记录不要求已配置 SMTP；新建、撤销或重发仍由原成员页面执行，并重新检查权限与服务状态。", "This entry sends no email. Viewing records does not require SMTP configuration; creation, revocation, and resending remain on the existing members page, which rechecks permission and service status.")}</p>
  </div>
}

function ServiceSmtpStatus() {
  const service = usePmService()
  const t = useText()
  const [retrying, setRetrying] = useState(false)
  const [retryError, setRetryError] = useState<unknown>(null)

  async function refreshSession() {
    setRetrying(true)
    setRetryError(null)
    try {
      await service.refresh()
    } catch (error) {
      setRetryError(error)
    } finally {
      setRetrying(false)
    }
  }

  if (service.loading || retrying) return <p role="status" className="text-sm leading-6">{t("正在读取会话与工作区…", "Loading session and workspace…")}</p>
  if (service.error || retryError || !service.actor || !service.workspace) return <div role="alert" className="min-w-0 space-y-3 text-sm leading-6">
    <p>{service.error || retryError ? t(pmErrorMessage(service.error ?? retryError, "zh"), pmErrorMessage(service.error ?? retryError, "en")) : t("请先登录并选择有权访问的工作区。", "Sign in and choose an authorized workspace first.")}</p>
    <div className="flex min-w-0 flex-wrap gap-2">
      <Button variant="outline" size="sm" onClick={() => { void refreshSession() }} className="h-auto min-h-9 w-full whitespace-normal py-2 sm:w-auto"><RefreshCw aria-hidden="true" className="size-3.5 shrink-0" />{t("重新读取会话", "Reload session")}</Button>
      <Button variant="outline" size="sm" render={<Link to="/pm?pick=1" />} className="h-auto min-h-9 w-full whitespace-normal py-2 sm:w-auto">{t("登录 / 选择工作区", "Sign in / choose workspace")}</Button>
    </div>
  </div>
  if (!allowed(service.workspace, "access.manage")) return <SettingsNotice>{t("无权查看：仅具有当前工作区 access.manage 的工作区管理员可读取邀请服务配置状态与邀请记录。本区域不会请求邀请列表，也不展示旧的私有快照。", "No access: only workspace administrators with access.manage for the current workspace may read invitation service configuration status and invitation records. This area does not request the invitation list or display old private snapshots.")}</SettingsNotice>

  return <InvitationServiceStatus membersHref={`/pm/${encodeURIComponent(service.workspace.id)}/members?tab=members&panel=invitations`} />
}

function SmtpDeploymentGuide() {
  const t = useText()
  return <details className="min-w-0 rounded-module border bg-surface-raised p-3 text-sm leading-6">
    <summary className="cursor-pointer rounded-control font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">{t("安全部署配置说明（只读）", "Secure deployment configuration (read-only)")}</summary>
    <div className="min-w-0 space-y-3 pt-3">
      <p className="text-muted-foreground">{t("由部署管理员配置，API 与 Worker 必须使用同一组配置。部署配置不通过本页保存；本页不收集、读取或显示任何密码、令牌或配置值。以下仅列变量名与要求。", "A deployment administrator manages these settings. API and Worker must use the same configuration. Deployment configuration cannot be saved through this page; no passwords, tokens, or configuration values are collected, read, or displayed here. Only variable names and requirements follow.")}</p>
      <dl className="min-w-0 space-y-3">
        <div className="min-w-0"><dt className="break-all font-mono text-xs">SMTP_HOST / SMTP_PORT</dt><dd className="text-muted-foreground">{t("邮件服务器与端口，默认端口 587。", "Mail server and port; the default port is 587.")}</dd></div>
        <div className="min-w-0"><dt className="break-all font-mono text-xs">SMTP_SECURE / SMTP_REQUIRE_TLS</dt><dd className="text-muted-foreground">{t("默认 false / true，要求 STARTTLS；465 通常使用 secure=true。仅可信 loopback 测试接收端可关闭 REQUIRE_TLS。", "Defaults are false / true, requiring STARTTLS; port 465 typically uses secure=true. REQUIRE_TLS may only be disabled for a trusted loopback test receiver.")}</dd></div>
        <div className="min-w-0"><dt className="break-all font-mono text-xs">SMTP_USER / SMTP_PASSWORD</dt><dd className="text-muted-foreground">{t("需要认证时成对配置，秘密不得进入仓库、浏览器表单或日志。", "Configure both when authentication is required. Secrets must not enter the repository, browser forms, or logs.")}</dd></div>
        <div className="min-w-0"><dt className="break-all font-mono text-xs">SMTP_FROM</dt><dd className="text-muted-foreground">{t("合法发件邮箱。", "A valid sender email address.")}</dd></div>
        <div className="min-w-0"><dt className="break-all font-mono text-xs">INVITATION_WEB_ORIGIN</dt><dd className="text-muted-foreground">{t("实际前端 origin，不含路径、查询或凭据。公网必须 HTTPS，仅 loopback 允许 HTTP。", "The actual frontend origin, without a path, query, or credentials. Public origins require HTTPS; HTTP is only allowed on loopback.")}</dd></div>
        <div className="min-w-0"><dt className="break-all font-mono text-xs">INVITATION_TOKEN_KEY</dt><dd className="text-muted-foreground">{t("安全随机 32 bytes 的 canonical base64 密钥，用于加密未发送队列令牌。API / Worker 必须一致并秘密备份；轮换前先处理旧队列。", "A cryptographically random 32-byte key in canonical base64, used to encrypt queued invitation tokens. API / Worker must share it, and it needs a secure backup. Process existing queues before rotating it.")}</dd></div>
        <div className="min-w-0"><dt className="break-all font-mono text-xs">INVITATION_TTL_SECONDS / SMTP_TIMEOUT_MS</dt><dd className="text-muted-foreground">{t("邀请有效期默认 604800 秒（范围 300–2592000）；SMTP 超时默认 15000 毫秒（范围 1000–120000）。", "Invitation lifetime defaults to 604800 seconds (range 300–2592000); SMTP timeout defaults to 15000 milliseconds (range 1000–120000).")}</dd></div>
      </dl>
      <p className="text-muted-foreground">{t("配置不完整属于部署错误，不应当作未配置或发送成功。发送结果未知时先核对原记录与邮件服务日志，不自动重发；显式重发可能产生重复邮件，并会使旧链接失效。", "Incomplete configuration is a deployment error, not an unconfigured state or a successful send. For unknown sending outcomes, check the original record and mail service logs first; do not resend automatically. Explicit resends can produce duplicate mail and invalidate the old link.")}</p>
    </div>
  </details>
}

export function PluginSmtpStatus({ mode }: SettingsPageProps) {
  const t = useText()
  return <div className="min-w-0 space-y-4 border-t pt-4">
    {mode === "service" ? <ServiceSmtpStatus /> : <SettingsNotice>{t("Lab · 仅只读能力说明。不调用真实会话或邀请 hooks，不查询部署状态，不模拟已配置，也不能发送邀请。请在正式工作区由管理员读取实际状态。", "Lab · Read-only capability information. No real session or invitation hooks are called, deployment status is not queried, configuration is not simulated, and invitations cannot be sent. An administrator can read the actual status in a real workspace.")}</SettingsNotice>}
    <p className="text-xs leading-5 text-muted-foreground">{t("仅成员邀请，不含收信 / 任务通知。SMTP 接收 ≠ 送达；SMTP 接收邮件不代表收件人收到，服务启用也不证明 SMTP 可达或公网送达。", "Member invitations only; no incoming mail or task notifications. SMTP acceptance ≠ delivery: server acceptance does not mean the recipient received the message, and service enablement does not prove SMTP reachability or public delivery.")}</p>
    <SmtpDeploymentGuide />
  </div>
}
