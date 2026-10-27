import { useId, useState, type FormEvent } from "react"
import { useNavigate } from "react-router"
import { KeyRound, LockKeyhole, LogOut, MonitorSmartphone, ShieldAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useWorkspaceStore } from "@/providers/app-providers"
import { useText } from "../pm-ui"
import { pmErrorMessage, usePmService } from "../pm-service"
import { SettingsNotice, SettingsSection, type SettingsPageProps } from "./settings-shared"
import { useAccountSecurity, type AccountSecurityState } from "./use-account-security"
import { RecoveryEmailPanel } from "./recovery-email-panel"

function SecurityPreviewNotice() {
  const t = useText()
  return <SettingsNotice>{t(
    "Lab · 仅非安全的界面预览。不读取真实账号或会话，不收集密码或验证码，也不会修改认证状态。此处的禁用控件不会模拟安全操作成功。",
    "Lab · Non-security visual preview only. No real account or session is read, no passwords or verification codes are collected, and authentication is not changed. Disabled controls do not simulate successful security operations.",
  )}</SettingsNotice>
}

function DisabledSecurityField({ id, label, reasonId, type = "password", numeric = false }: {
  id: string
  label: string
  reasonId: string
  type?: "password" | "text"
  numeric?: boolean
}) {
  const t = useText()
  return <div className="min-w-0 space-y-2">
    <label htmlFor={id} className="text-sm font-medium">{label}</label>
    <Input
      id={id}
      type={type}
      disabled
      readOnly
      value=""
      autoComplete="off"
      inputMode={numeric ? "numeric" : undefined}
      maxLength={numeric ? 6 : undefined}
      spellCheck={false}
      aria-describedby={reasonId}
      placeholder={t("暂不可用 · 请勿输入真实凭据", "Unavailable · do not enter real credentials")}
    />
  </div>
}

export function SecurityActionStatus({ security }: { security: AccountSecurityState }) {
  const t = useText()
  const locale = useWorkspaceStore((state) => state.locale)
  const { pending, busy, error, outcome, storageError } = security
  const rejection = outcome?.errorCode === "current_password_invalid" ? t("当前密码不正确。密码未修改；请重新输入，不要连续猜测。", "The current password is incorrect. Nothing changed; re-enter it rather than guessing repeatedly.")
    : outcome?.errorCode === "credential_version_conflict" ? t("密码版本已变化，操作未执行。已重新读取；请核实当前登录和密码后重新填写。", "The credential version changed. This action was not applied. The latest state was read; verify your sign-in and password before entering them again.")
      : outcome?.errorCode === "password_unchanged" ? t("新密码不能与当前密码相同。密码未修改。", "The new password must differ from the current password. Nothing changed.")
        : outcome?.errorCode === "current_session_protected" ? t("不能从其他会话操作中撤销当前会话，请使用退出当前会话。", "Use Sign out of current session to end this session.")
          : outcome?.errorCode?.startsWith("recovery_") ? t(`恢复邮箱操作被拒绝：${outcome.errorCode}。请重读真实状态；候选冲突须先显式取消，sending 需等待租约结束，旧链接不可重放。`, `Recovery email action rejected: ${outcome.errorCode}. Reload current state. Explicitly cancel an existing candidate; wait for a sending lease; never replay an old link.`)
            : t("会话不存在或不属于本人，未执行撤销。", "The session is unavailable or does not belong to you. It was not revoked.")
  return <div className="space-y-3" aria-live="polite">
    {storageError && <SettingsNotice>{t("安全恢复记录不可读取或保存；为避免丢失结果，本页禁止提交。请恢复浏览器会话存储权限后重新加载。本页没有发送或持久保存密码。", "The security recovery marker cannot be read or saved, so writes are blocked to avoid losing an outcome. Restore browser session-storage access and reload. This page has not sent or persisted a password.")}</SettingsNotice>}
    {pending && <SettingsNotice><div className="space-y-3">
      <p>{busy ? t("正在处理安全操作；请勿重复提交。", "Processing the security action. Do not submit it again.") : t("原安全操作结果尚待核对，已禁止新的安全写入。密码输入已清空且不会重发。点击核对原操作：若尚未提交，服务端会先阻止延迟请求再取消；若已提交，会读取真实结果。", "The original security action still needs reconciliation; new security writes are blocked. Password fields were cleared and will never be resent. Reconcile the original action: the server reads a committed result, or fences a delayed request before cancelling an uncommitted one.")}</p>
      <p className="break-all font-mono text-xs">{pending.actionId}</p>
      <Button variant="outline" disabled={busy} loading={busy} onClick={() => { void security.recover() }}>{t("核对原安全操作", "Reconcile original security action")}</Button>
      <p className="text-xs">{t("若当前会话已失效，请从登录入口使用新密码核实；不要再次发送原改密请求。", "If this session is invalid, verify sign-in with the new password at the sign-in page; do not resend the original password change.")}</p>
    </div></SettingsNotice>}
    {error !== null && <p role="alert" className="text-sm leading-6 text-destructive">{pmErrorMessage(error, locale === "en" ? "en" : "zh")}{t(" 如果收到速率限制，请等待后再核对，改密每 15 分钟最多尝试 5 次。", " If rate-limited, wait before reconciling; password changes allow five attempts per 15 minutes.")}</p>}
    {outcome && <p role="status" className={`text-sm leading-6 ${outcome.status === "rejected" ? "text-destructive" : "text-muted-foreground"}`}>
      {outcome.status === "cancelled" ? t("原操作未提交，服务端已阻止其延迟执行；现在可以重新填写并显式发起新操作。", "The original action did not commit and is fenced against delayed execution. You can now enter credentials again and explicitly start a new action.")
        : outcome.status === "rejected" ? rejection
          : outcome.kind === "password_change" ? t(`密码已更新，已撤销 ${outcome.revokedCount} 个其他会话；当前会话保留且不延长有效期。`, `Password updated; ${outcome.revokedCount} other sessions were revoked. This session is retained without extending its expiry.`)
            : outcome.kind === "revoke_sessions" ? t(`已撤销 ${outcome.revokedCount} 个其他会话。`, `Revoked ${outcome.revokedCount} other sessions.`)
              : outcome.kind === "recovery_email_begin" ? t("验证挑战已排队，尚未验证，也不代表邮件已送达。", "Verification challenge queued. The address is not yet verified and delivery is not asserted.")
                : outcome.kind === "recovery_email_confirm" ? t("恢复邮箱已通过新挑战验证；旧链接已失效。", "Recovery email verified through the new challenge; previous links are invalid.")
                  : outcome.kind === "recovery_email_cancel" ? t("候选已取消，旧可信邮箱保持不变。", "Pending challenge cancelled; the previous verified address is unchanged.")
                    : t("可信恢复邮箱已解绑，现有恢复链接失效。", "Recovery email unbound; existing recovery links are invalid.")}
    </p>}
  </div>
}

function ServicePassword() {
  const t = useText()
  const id = useId()
  const security = useAccountSecurity()
  const [currentPassword, setCurrentPassword] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [confirmation, setConfirmation] = useState("")
  const [validation, setValidation] = useState<string | null>(null)
  const disabled = security.loading || security.busy || security.pending !== null || security.storageError || !security.data
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (disabled) return
    if (!currentPassword || newPassword.length < 12 || newPassword.length > 256 || confirmation !== newPassword || currentPassword === newPassword) {
      setValidation(t("请输入当前密码；新密码须为 12–256 个字符、不同于当前密码，且两次输入一致。", "Enter the current password. The new password must be 12–256 characters, differ from the current password, and match its confirmation."))
      return
    }
    setValidation(null)
    const current = currentPassword, next = newPassword
    setCurrentPassword(""); setNewPassword(""); setConfirmation("")
    void security.changePassword(current, next)
  }
  return <SettingsSection title={t("密码", "Password")} description={t("验证本人当前密码后更新登录密码，并撤销所有其他会话。", "Verify your current password to change it and revoke every other session.")}>
    <SettingsNotice>{t("服务端规则：12–256 个字符；须验证当前密码，每账号 15 分钟最多尝试 5 次。保存后所有其他会话立即撤销，当前安全会话保留且不延长到期时间。密码不会进入浏览器恢复存储、业务收据或事件。恢复邮箱须独立验证；MFA 和 SSO 尚未提供。", "Server policy: 12–256 characters; current password required, at most five attempts per account per 15 minutes. All other sessions are revoked; the current session is retained without extending expiry. Passwords never enter browser recovery storage, business receipts or events. Recovery email requires independent verification; MFA and SSO remain unavailable.")}</SettingsNotice>
    <SecurityActionStatus security={security} />
    {security.loading && <p role="status" className="text-sm text-muted-foreground">{t("正在读取安全状态…", "Reading security state…")}</p>}
    <form onSubmit={submit} className="space-y-5">
      <div className="space-y-2"><label htmlFor={`${id}-current`} className="text-sm font-medium">{t("当前密码", "Current password")}</label><Input id={`${id}-current`} type="password" autoComplete="current-password" required maxLength={256} disabled={disabled} value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} /></div>
      <div className="space-y-2"><label htmlFor={`${id}-new`} className="text-sm font-medium">{t("新密码", "New password")}</label><Input id={`${id}-new`} type="password" autoComplete="new-password" required minLength={12} maxLength={256} disabled={disabled} value={newPassword} onChange={event => setNewPassword(event.target.value)} aria-describedby={`${id}-rules`} /></div>
      <p id={`${id}-rules`} className="text-sm leading-6 text-muted-foreground">{t("请使用独立的长密码或密码短语，建议由密码管理器生成。长度校验不代表密码强度评分；本服务不假称已检查泄露密码库。", "Use a unique long password or passphrase, preferably generated by a password manager. Length validation is not a strength score; this service does not claim to check a breached-password database.")}</p>
      <div className="space-y-2"><label htmlFor={`${id}-confirm`} className="text-sm font-medium">{t("确认新密码", "Confirm new password")}</label><Input id={`${id}-confirm`} type="password" autoComplete="new-password" required minLength={12} maxLength={256} disabled={disabled} value={confirmation} onChange={event => setConfirmation(event.target.value)} /></div>
      {validation && <p role="alert" className="text-sm text-destructive">{validation}</p>}
      <div className="flex flex-wrap gap-2"><Button type="submit" disabled={disabled} loading={security.busy}><KeyRound aria-hidden="true" className="size-4" />{t("更新密码并退出其他会话", "Update password and revoke other sessions")}</Button><Button type="button" variant="outline" disabled={security.loading || security.busy} onClick={() => { void security.refresh() }}>{t("重新读取", "Reload state")}</Button></div>
    </form>
    <RecoveryEmailPanel security={security} />
  </SettingsSection>
}

function ServicePasswordRoute() {
  const { actor, actorEpoch } = usePmService()
  return <ServicePassword key={`${actor?.id}:${actorEpoch}`} />
}

export function SettingsPassword({ mode }: SettingsPageProps) {
  const t = useText()
  const id = useId()
  if (mode === "service") return <ServicePasswordRoute />
  return <SettingsSection title={t("密码", "Password")} description={t("Lab 不接入真实认证。", "Lab is not connected to real authentication.")}>
    <SecurityPreviewNotice />
    <span id={`${id}-reason`} className="text-sm text-muted-foreground">{t("请在正式应用管理本人密码；此处不接收密码。", "Manage your password in the service application. No password is accepted here.")}</span>
    <DisabledSecurityField id={`${id}-current`} label={t("当前密码", "Current password")} reasonId={`${id}-reason`} />
    <DisabledSecurityField id={`${id}-new`} label={t("新密码", "New password")} reasonId={`${id}-reason`} />
    <DisabledSecurityField id={`${id}-confirm`} label={t("确认新密码", "Confirm new password")} reasonId={`${id}-reason`} />
    <Button disabled>{t("更新密码", "Update password")}</Button>
  </SettingsSection>
}

function ServiceSessions() {
  const t = useText()
  const service = usePmService()
  const security = useAccountSecurity()
  const navigate = useNavigate()
  const locale = useWorkspaceStore((state) => state.locale)
  const [signingOut, setSigningOut] = useState(false)
  const [logoutError, setLogoutError] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<string | null>(null)
  const disabled = security.loading || security.busy || security.pending !== null || security.storageError || !security.data
  const signOut = async () => {
    if (!service.actor || signingOut) return
    setSigningOut(true); setLogoutError(null)
    try { await service.logout(); navigate("/pm") }
    catch (cause) { setLogoutError(pmErrorMessage(cause, locale === "en" ? "en" : "zh")) }
    finally { setSigningOut(false) }
  }
  const time = (value: string) => new Date(value).toLocaleString(locale === "en" ? "en-US" : "zh-CN")
  const others = security.data?.sessions.filter(session => !session.current) ?? []
  return <SettingsSection wide title={t("会话与设备", "Sessions & devices")} description={t("仅查看和管理本人有效登录会话。", "View and manage only your own active sign-in sessions.")}>
    <SettingsNotice>{t("会话时间来自服务端。设备、浏览器、IP、地点与最近活动没有可信来源，明确标为未知，不推测设备身份；会话数量不是设备数量。其他会话撤销后，其后续受保护请求将被拒绝。", "Session timestamps come from the server. Device, browser, IP, location and recent activity have no trusted source and are explicitly unknown; a session count is not a device count. Revoked sessions cannot make subsequent protected requests.")}</SettingsNotice>
    <SecurityActionStatus security={security} />
    {security.loading && <p role="status" className="text-sm text-muted-foreground">{t("正在读取会话…", "Reading sessions…")}</p>}
    <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={security.loading || security.busy} onClick={() => { void security.refresh() }}>{t("刷新会话", "Refresh sessions")}</Button><Button variant="outline" disabled={disabled || !others.length} onClick={() => setConfirmation("others")}>{t("退出所有其他会话", "Sign out all other sessions")}</Button></div>
    {confirmation && <section className="space-y-3 rounded-module border border-destructive/30 p-4" aria-label={t("确认撤销会话", "Confirm session revocation")}>
      <p className="text-sm">{confirmation === "others" ? t("确认撤销此刻的所有其他登录会话？当前会话保留。", "Revoke all other sign-in sessions present when this action commits? This session will remain signed in.") : t("确认撤销所选其他会话？该会话需要重新登录。", "Revoke the selected other session? It will need to sign in again.")}</p>
      <div className="flex flex-wrap gap-2"><Button variant="destructive" disabled={disabled} onClick={() => { const target = confirmation; setConfirmation(null); void security.revoke(target) }}>{t("确认退出其他会话", "Confirm revocation")}</Button><Button variant="outline" onClick={() => setConfirmation(null)}>{t("取消", "Cancel")}</Button></div>
    </section>}
    {security.data && <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t(`本人有效会话 ${security.data.sessions.length} 个，其中其他会话 ${others.length} 个。`, `${security.data.sessions.length} active sessions belong to you; ${others.length} are other sessions.`)}</p>
      {security.data.sessions.map(session => <section key={session.id} className="min-w-0 space-y-4 rounded-module border bg-surface p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-3"><MonitorSmartphone aria-hidden="true" className="size-5 text-muted-foreground" /><h3 className="text-sm font-semibold">{session.current ? t("当前会话", "Current session") : t("其他会话", "Other session")}</h3></div>
        <dl className="grid min-w-0 gap-4 text-sm sm:grid-cols-2">
          <div className="min-w-0"><dt className="text-muted-foreground">{t("会话标识", "Session ID")}</dt><dd className="break-all font-mono text-xs leading-6">{session.id}</dd></div>
          <div><dt className="text-muted-foreground">{t("账号", "Account")}</dt><dd className="break-all">{service.actor?.email}</dd></div>
          <div><dt className="text-muted-foreground">{t("会话创建时间", "Session created")}</dt><dd>{time(session.createdAt)}</dd></div>
          <div><dt className="text-muted-foreground">{t("会话到期时间", "Session expiry")}</dt><dd>{time(session.expiresAt)}</dd></div>
          <div><dt className="text-muted-foreground">{t("设备 / 浏览器 / IP / 地点", "Device / browser / IP / location")}</dt><dd>{t("未知（未采集）", "Unknown (not collected)")}</dd></div>
          <div><dt className="text-muted-foreground">{t("最近活动时间", "Last activity")}</dt><dd>{t("未知（无可信来源）", "Unknown (no trusted source)")}</dd></div>
        </dl>
        {!session.current && <Button variant="outline" disabled={disabled} onClick={() => setConfirmation(session.id)}>{t("退出此其他会话", "Sign out this other session")}</Button>}
      </section>)}
    </div>}
    <section className="space-y-3 rounded-module border p-4">
      <p className="text-sm text-muted-foreground">{t("退出当前会话使用独立退出接口；网络失败不代表撤销成功，请重新验证登录状态。", "Current-session sign-out uses the separate logout endpoint. A network failure does not prove revocation; re-check your sign-in state.")}</p>
      {logoutError && <p role="alert" className="text-sm text-destructive">{logoutError}</p>}
      <Button variant="outline" disabled={!service.actor || signingOut} loading={signingOut} onClick={() => { void signOut() }}><LogOut aria-hidden="true" className="size-4" />{t("退出当前会话", "Sign out of current session")}</Button>
    </section>
  </SettingsSection>
}

function ServiceSessionsRoute() {
  const { actor, actorEpoch } = usePmService()
  return <ServiceSessions key={`${actor?.id}:${actorEpoch}`} />
}

export function SettingsSessions({ mode }: SettingsPageProps) {
  const t = useText()
  if (mode === "service") return <ServiceSessionsRoute />
  return <SettingsSection wide title={t("会话与设备", "Sessions & devices")} description={t("Lab 不读取真实会话。", "Lab does not read real sessions.")}><SecurityPreviewNotice /><SettingsNotice>{t("设备来源、时间和会话数量未知。请在正式应用查看、撤销本人其他会话或退出当前会话。", "Device sources, timestamps and session counts are unknown. Use the service application to inspect or revoke your own sessions.")}</SettingsNotice><Button disabled>{t("退出所有其他会话", "Sign out all other sessions")}</Button></SettingsSection>
}

export function SettingsTwoFactor({ mode }: SettingsPageProps) {
  const t = useText()
  const id = useId()
  return <SettingsSection wide title={t("双重认证", "Two-factor authentication")} description={t("了解认证器注册、验证码与恢复码的支持范围。", "Review authenticator enrollment, verification-code, and recovery-code availability.")}>
    {mode === "lab" && <SecurityPreviewNotice />}
    <SettingsNotice><span id={`${id}-unavailable`}>{t(
      "当前服务未提供可信的账号双重认证状态，也没有注册、验证、恢复码或停用接口。状态保持未知，而不是“已关闭”或“已启用”。本页不生成二维码、注册密钥或恢复码，不接收验证码，也不会改变账号的安全保护。",
      "This service provides no trusted account-level two-factor status and no enrollment, verification, recovery-code, or disable API. Status remains unknown, not “off” or “on.” This page generates no QR codes, enrollment secrets, or recovery codes, accepts no verification codes, and cannot change account protection.",
    )}</span></SettingsNotice>
    <div className="flex min-w-0 items-start gap-3 rounded-module border bg-surface p-4 sm:p-5">
      <ShieldAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 space-y-2">
        <h3 className="text-sm font-semibold">{t("双重认证状态：未知", "Two-factor status: unknown")}</h3>
        <p className="text-sm leading-6 text-muted-foreground">{t("查看此页面并不会启用额外登录保护。工作区角色、成员在线状态和普通登录成功都不是 MFA 已启用的证据。", "Viewing this page does not enable additional sign-in protection. Workspace roles, member presence, and a successful ordinary sign-in are not evidence that MFA is enabled.")}</p>
      </div>
    </div>
    <section aria-labelledby={`${id}-enrollment-title`} className="min-w-0 space-y-5 rounded-module border bg-surface p-4 sm:p-5">
      <div className="space-y-1">
        <h3 id={`${id}-enrollment-title`} className="text-sm font-semibold">{t("认证器注册流程", "Authenticator enrollment")}</h3>
        <p id={`${id}-enrollment-reason`} className="text-sm leading-6 text-muted-foreground">{t("以下仅说明完整注册所需步骤；当前缺少真实认证服务，所有操作均不可用。", "The steps below explain a complete enrollment flow. All actions are unavailable without a real authentication service.")}</p>
      </div>
      <ol className="space-y-6">
        <li className="space-y-3">
          <h4 className="text-sm font-medium">{t("1. 开始安全注册", "1. Start secure enrollment")}</h4>
          <p className="text-sm leading-6 text-muted-foreground">{t("服务端需要先确认当前账号身份，并创建受保护的注册请求。不能用本地开关代替账号注册。", "The server must confirm the current account identity and create a protected enrollment request. A local toggle cannot enroll an account.")}</p>
          <Button disabled aria-describedby={`${id}-unavailable ${id}-enrollment-reason`} className="w-full sm:w-auto">{t("开始注册认证器", "Set up an authenticator")}</Button>
        </li>
        <li className="space-y-3 border-t pt-5">
          <h4 className="text-sm font-medium">{t("2. 添加到认证器应用", "2. Add to an authenticator app")}</h4>
          <p className="text-sm leading-6 text-muted-foreground">{t("使用兼容的认证器扫描真实服务提供的二维码，或手动输入同一注册密钥。当前没有可供扫描或复制的注册资料。", "Use a compatible authenticator to scan a QR code supplied by the real service, or enter the same enrollment secret manually. No enrollment data is available to scan or copy here.")}</p>
          <div className="grid min-w-0 gap-4 sm:grid-cols-[9rem_minmax(0,1fr)] sm:items-center">
            <div className="flex min-h-32 flex-col items-center justify-center gap-2 rounded-module border border-dashed bg-surface-raised p-4 text-center text-sm text-muted-foreground"><LockKeyhole aria-hidden="true" className="size-6" /><span>{t("无二维码", "No QR code")}</span></div>
            <DisabledSecurityField id={`${id}-secret`} label={t("手动注册密钥", "Manual enrollment secret")} reasonId={`${id}-unavailable ${id}-enrollment-reason`} type="text" />
          </div>
        </li>
        <li className="space-y-3 border-t pt-5">
          <h4 className="text-sm font-medium">{t("3. 验证认证器并启用", "3. Verify the authenticator and enable")}</h4>
          <p id={`${id}-verify-reason`} className="text-sm leading-6 text-muted-foreground">{t("需要服务端校验真实注册请求的动态验证码，并返回启用结果。输入任意六位数字不能代表认证成功；当前不接受任何验证码。", "The server must validate a one-time code for the real enrollment request and confirm activation. Any arbitrary six digits are not proof of authentication; no code is accepted here.")}</p>
          <div className="max-w-xl"><DisabledSecurityField id={`${id}-code`} label={t("认证器六位验证码", "Six-digit authenticator code")} reasonId={`${id}-unavailable ${id}-verify-reason`} type="text" numeric /></div>
          <div className="flex flex-wrap gap-2">
            <Button disabled aria-describedby={`${id}-unavailable ${id}-verify-reason`} className="w-full sm:w-auto">{t("验证并启用", "Verify & enable")}</Button>
            <Button variant="outline" disabled aria-describedby={`${id}-enrollment-reason`} className="w-full sm:w-auto">{t("取消注册", "Cancel enrollment")}</Button>
          </div>
        </li>
      </ol>
    </section>
    <section aria-labelledby={`${id}-recovery-title`} className="min-w-0 space-y-4 rounded-module border bg-surface p-4 sm:p-5">
      <div className="space-y-1">
        <h3 id={`${id}-recovery-title`} className="text-sm font-semibold">{t("恢复码", "Recovery codes")}</h3>
        <p id={`${id}-recovery-reason`} className="text-sm leading-6 text-muted-foreground">{t("服务未提供恢复码的生成、读取、重新生成或验证接口；剩余数量未知。此处不会展示示例恢复码，复制和下载也不可用。", "The service has no recovery-code generation, retrieval, regeneration, or verification API; the remaining count is unknown. No sample recovery codes are displayed, and copy and download are unavailable.")}</p>
      </div>
      <div className="rounded-module border border-dashed bg-surface-raised p-4 text-sm leading-6 text-muted-foreground">{t("没有可展示的恢复码。正式支持后，应在可信流程中离线安全保存，切勿放入项目描述、评论或共享文档。", "No recovery codes are available to display. Once officially supported, store them safely offline through the trusted flow, never in project descriptions, comments, or shared documents.")}</div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled aria-describedby={`${id}-recovery-reason`} className="w-full sm:w-auto">{t("生成 / 重新生成", "Generate / regenerate")}</Button>
        <Button variant="outline" disabled aria-describedby={`${id}-recovery-reason`} className="w-full sm:w-auto">{t("复制恢复码", "Copy recovery codes")}</Button>
        <Button variant="outline" disabled aria-describedby={`${id}-recovery-reason`} className="w-full sm:w-auto">{t("下载恢复码", "Download recovery codes")}</Button>
      </div>
    </section>
    <section aria-labelledby={`${id}-disable-title`} className="flex min-w-0 flex-col gap-4 rounded-module border border-destructive/25 bg-surface p-4 sm:p-5 lg:flex-row lg:items-center lg:justify-between">
      <div className="min-w-0 space-y-1">
        <h3 id={`${id}-disable-title`} className="text-sm font-semibold">{t("停用双重认证", "Disable two-factor authentication")}</h3>
        <p id={`${id}-disable-reason`} className="text-sm leading-6 text-muted-foreground">{t("当前状态未知且没有停用接口，无法执行此操作。正式停用必须先重新验证身份，并确认会降低账号的登录保护；本页不会假称已停用。", "The current status is unknown and there is no disable API, so this action cannot run. A real disable flow must re-verify identity and confirm reduced sign-in protection; this page never claims MFA was disabled.")}</p>
      </div>
      <Button variant="destructive" disabled aria-describedby={`${id}-disable-reason`} className="w-full lg:w-auto">{t("停用双重认证", "Disable two-factor authentication")}</Button>
    </section>
  </SettingsSection>
}
