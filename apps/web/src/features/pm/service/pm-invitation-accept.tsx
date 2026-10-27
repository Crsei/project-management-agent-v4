import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react"
import { Link, useNavigate } from "react-router"
import { z } from "zod"
import { ApiError, ProjectManagementClient, type InvitationAcceptDto, type InvitationAcceptPayload, type InvitationInspectDto } from "@contracts"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useI18n } from "@/lib/i18n-provider"

type AcceptancePhase = "ready" | "submitting" | "unknown" | "checking" | "retry-ready" | "accepted"
const acceptanceOutcome = z.object({ workspaceId: z.string().uuid(), userId: z.string().uuid(), email: z.email(), alreadyAccepted: z.boolean() })
const acceptanceReceipt = z.object({ outcome: acceptanceOutcome.nullable() })
const invitationInspection = z.object({
  workspaceId: z.string().uuid(), workspaceName: z.string(), email: z.email(), role: z.enum(["admin", "member", "guest"]),
  projectIds: z.array(z.string()).nullable(), expiresAt: z.string().datetime(), accountExists: z.boolean(),
})

/** Public bearer-link flow: secret input never enters a route query, query cache,
 * command journal, persistent browser storage, or rendered error text. */
export function PmInvitationAcceptPage() {
  const navigate = useNavigate()
  const { locale } = useI18n()
  const t = useCallback((zh: string, en: string) => locale === "en" ? en : zh, [locale])
  const [client] = useState(() => new ProjectManagementClient({ baseUrl: window.location.origin, auth: { type: "cookie", credentials: "same-origin" } }))
  // Keep this initializer pure: React StrictMode can call it twice before effects.
  const [token, setToken] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "")
  const [inspection, setInspection] = useState<InvitationInspectDto | null>(null)
  const [inspecting, setInspecting] = useState(false)
  const [inspectionRevision, setInspectionRevision] = useState(0)
  const [phase, setPhase] = useState<AcceptancePhase>("ready")
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState("")
  const [password, setPassword] = useState("")
  const [outcome, setOutcome] = useState<InvitationAcceptDto | null>(null)
  const [loginBusy, setLoginBusy] = useState(false)
  const attempt = useRef<InvitationAcceptPayload | null>(null)
  const requestInFlight = useRef(false)
  const mounted = useRef(true)
  useLayoutEffect(() => {
    // Fragments are never sent to the server. Reopening a link on this same
    // route is a hash navigation, not a component remount.
    const consumeLink = () => {
      const nextToken = new URLSearchParams(window.location.hash.slice(1)).get("token")
      window.history.replaceState(window.history.state, "", window.location.pathname)
      if (!nextToken || requestInFlight.current || attempt.current) return
      setToken(nextToken)
      setInspection(null)
      setOutcome(null)
      setName("")
      setPassword("")
      setPhase("ready")
      setError(null)
    }
    window.history.replaceState(window.history.state, "", window.location.pathname)
    window.addEventListener("hashchange", consumeLink)
    return () => window.removeEventListener("hashchange", consumeLink)
  }, [])
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; attempt.current = null }
  }, [])
  useEffect(() => {
    if (!token) return
    const controller = new AbortController()
    setInspecting(true)
    setError(null)
    void client.inspectMemberInvitation({ token }, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setInspection(invitationInspection.parse(result))
    }).catch((cause: unknown) => {
      if (controller.signal.aborted) return
      setInspection(null)
      const code = cause instanceof ApiError ? cause.code : "unavailable"
      if (code === "invitation_expired") setError(t("邀请已过期，请管理员显式重发新的链接。", "This invitation expired. Ask an administrator to resend a new link."))
      else if (code === "invitation_already_accepted") setError(t("邀请已接受，请通过普通登录进入工作区。", "This invitation has already been accepted. Use normal sign-in to enter the workspace."))
      else if (code === "invitation_authority_revoked") setError(t("邀请人的管理权限已撤销；不能接受此邀请。", "The inviter no longer has management authority; this invitation cannot be accepted."))
      else if (code === "invitation_invalid") setError(t("邀请链接已撤销、被重发替换或无效。请使用最新邮件。", "This invitation was revoked, replaced by a resend, or is invalid. Use the latest email."))
      else if (code === "rate_limited") setError(t("请求过多，请稍后再检查邀请。", "Too many requests. Check this invitation again later."))
      else setError(t("无法检查邀请。不会提交接受操作；请稍后重试读取。", "The invitation could not be inspected. No acceptance was submitted; retry the read later."))
    }).finally(() => { if (!controller.signal.aborted) setInspecting(false) })
    return () => controller.abort()
  }, [client, token, inspectionRevision, t])

  const complete = (result: InvitationAcceptDto) => {
    if (!mounted.current) return
    setOutcome(result)
    setPhase("accepted")
    setToken("")
    attempt.current = null
    setError(null)
  }
  const accept = async (request: InvitationAcceptPayload, retry: boolean) => {
    if (requestInFlight.current) return
    requestInFlight.current = true
    setPhase("submitting")
    setError(null)
    try {
      const result = await client.acceptMemberInvitation(request)
      complete(acceptanceOutcome.parse(result))
    } catch (cause) {
      if (!mounted.current) return
      // A received 4xx on the initial request is a definite rejection. Transport,
      // parsing and server failures may follow a commit and must be reconciled.
      if (!retry && cause instanceof ApiError && cause.status >= 400 && cause.status < 500 && cause.code !== "idempotency_conflict") {
        attempt.current = null
        setPhase("ready")
        setError(cause.code === "invalid_credentials"
          ? t("必须使用受邀邮箱现有账号的原密码；邀请不能修改已有账号密码。若账号状态有变化，请重新检查邀请。", "Use the existing password for the invited email. An invitation cannot reset an existing account password. Reinspect if the account state changed.")
          : t("服务已拒绝接受操作。链接可能已过期、撤销，或邀请人的权限已变化；请重新检查邀请。", "The service rejected acceptance. The link may have expired or been revoked, or the inviter's access may have changed. Reinspect the invitation."))
      } else {
        setPhase("unknown")
        setError(t("接受结果未知。已保留本次请求和命令 ID；先查询原收据，不要重新注册或创建新请求。", "Acceptance outcome is unknown. The original request and command ID are retained. Check its receipt before registering again or making another request."))
      }
    } finally { requestInFlight.current = false }
  }
  const inspectReceipt = async () => {
    const original = attempt.current
    if (!original || requestInFlight.current) return
    requestInFlight.current = true
    setPhase("checking")
    setError(null)
    try {
      const result = acceptanceReceipt.parse(await client.getMemberInvitationAcceptance({ token: original.token, commandId: original.commandId, password: original.password }))
      if (!mounted.current) return
      if (result.outcome) complete(result.outcome)
      else {
        setPhase("retry-ready")
        setError(t("原收据尚不存在。只有下方显式重试会重放同一个命令 ID 和原始参数，不会创建新接受请求。", "No original receipt exists yet. The explicit retry below replays the same command ID and original parameters; it does not create a new acceptance request."))
      }
    } catch {
      if (!mounted.current) return
      setPhase("unknown")
      setError(t("仍无法核对原接受结果。原请求保留；请重试收据查询。若链接失效，请联系管理员核对成员状态，不能盲目重新接受。", "The original acceptance still cannot be reconciled. Its request is retained; retry the receipt lookup. If the link is unavailable, ask an administrator to check membership rather than accepting blindly again."))
    } finally { requestInFlight.current = false }
  }
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (phase !== "ready" || !inspection || !token || inspecting || requestInFlight.current) return
    const request: InvitationAcceptPayload = { commandId: crypto.randomUUID(), token, password, ...(!inspection.accountExists ? { name: name.trim() } : {}) }
    attempt.current = request
    void accept(request, false)
  }
  const unknown = phase === "unknown" || phase === "checking" || phase === "retry-ready"
  const busy = inspecting || phase === "submitting" || phase === "checking"
  return <main className="mx-auto min-h-dvh w-full max-w-xl space-y-6 px-4 py-10">
    <header className="space-y-2"><h1 className="text-2xl font-semibold">{t("接受工作区邀请", "Accept workspace invitation")}</h1><p className="text-sm text-muted-foreground">{t("邀请只适用于邮件中的邮箱。链接令牌只在本页内存中使用，刷新后请从原邮件重新打开。", "This invitation applies only to its email address. The link token stays only in this page's memory; reopen the email link after refreshing.")}</p></header>
    {!token && !outcome && <p role="alert">{t("缺少邀请令牌。请从最新邀请邮件打开完整链接；不要将令牌放到查询参数中。", "The invitation token is missing. Open the complete link from the latest email; do not put the token in query parameters.")}</p>}
    {inspecting && <p role="status">{t("正在检查邀请…", "Inspecting invitation…")}</p>}
    {error && <p role="alert" className="rounded border p-3 text-sm">{error}</p>}
    {inspection && !outcome && <section className="space-y-4 rounded-lg border p-5">
      <h2 className="font-semibold">{inspection.workspaceName}</h2><dl className="grid gap-2 text-sm"><div><dt>{t("受邀邮箱", "Invited email")}</dt><dd className="break-all">{inspection.email}</dd></div><div><dt>{t("角色与范围", "Role and scope")}</dt><dd>{inspection.role} · {inspection.projectIds?.join(", ") ?? t("整个工作区", "Whole workspace")}</dd></div><div><dt>{t("到期时间", "Expires")}</dt><dd><time dateTime={inspection.expiresAt}>{inspection.expiresAt}</time></dd></div></dl>
      <p className="text-sm">{inspection.accountExists ? t("该邮箱已有账号。请验证原密码；邀请不会更改该账号的密码。", "An account already exists for this email. Confirm its original password; the invitation does not change it.") : t("该邮箱尚未注册。仅凭本邀请可创建账号，姓名与密码将在接受时原子保存。", "This email has no account. This invitation permits account creation; name and password are saved atomically on acceptance.")}</p>
      <form onSubmit={submit} className="space-y-3"><fieldset disabled={busy || unknown} className="space-y-3">
        {!inspection.accountExists && <label className="grid gap-1 text-sm"><span>{t("姓名", "Name")}</span><Input autoComplete="name" value={name} required maxLength={200} onChange={event => setName(event.target.value)} /></label>}
        <label className="grid gap-1 text-sm"><span>{inspection.accountExists ? t("现有账号原密码", "Existing account password") : t("新账号密码（至少 12 位）", "New account password (at least 12 characters)")}</span><Input type="password" autoComplete={inspection.accountExists ? "current-password" : "new-password"} value={password} required minLength={inspection.accountExists ? 1 : 12} maxLength={256} onChange={event => setPassword(event.target.value)} /></label>
        <Button type="submit">{phase === "submitting" ? t("正在接受…", "Accepting…") : inspection.accountExists ? t("验证密码并接受", "Confirm password and accept") : t("创建受邀账号并接受", "Create invited account and accept")}</Button>
      </fieldset></form>
    </section>}
    {unknown && <section className="space-y-3 rounded border p-4" aria-label={t("核对原接受请求", "Reconcile original acceptance")}><p className="break-all text-sm">{t("原命令 ID：", "Original command ID: ")}{attempt.current?.commandId}</p><div className="flex flex-wrap gap-2"><Button disabled={busy} onClick={() => { void inspectReceipt() }}>{t("查询原接受收据", "Check original acceptance receipt")}</Button>{phase === "retry-ready" && <Button variant="outline" disabled={busy} onClick={() => { if (attempt.current) void accept(attempt.current, true) }}>{t("显式重试同一请求", "Explicitly retry the same request")}</Button>}</div></section>}
    {token && !unknown && phase === "ready" && <Button variant="outline" disabled={inspecting} onClick={() => setInspectionRevision(value => value + 1)}>{t("重新检查邀请", "Reinspect invitation")}</Button>}
    {outcome && <section className="space-y-4 rounded-lg border p-5"><h2 className="font-semibold">{t("邀请已确认接受", "Invitation acceptance confirmed")}</h2><p className="text-sm">{t("接受邀请不会自动创建登录会话。请使用相同邮箱及账号密码通过普通登录进入工作区。", "Accepting an invitation does not create a login session. Use the same email and account password to sign in normally.")}</p><form className="space-y-3" onSubmit={event => {
      event.preventDefault()
      if (loginBusy) return
      setLoginBusy(true)
      setError(null)
      void client.login({ email: outcome.email, password }).then(() => {
        setPassword("")
        navigate(`/pm/${encodeURIComponent(outcome.workspaceId)}/members`, { replace: true })
      }).catch(() => { if (mounted.current) setError(t("普通登录未成功，请确认密码或使用登录入口重试。邀请接受结果不受影响。", "Normal sign-in failed. Check the password or use the sign-in page. Your confirmed acceptance is unchanged.")) }).finally(() => { if (mounted.current) setLoginBusy(false) })
    }}><label className="grid gap-1 text-sm"><span>{t("邮箱", "Email")}</span><Input type="email" autoComplete="username" value={outcome.email} readOnly /></label><label className="grid gap-1 text-sm"><span>{t("账号密码", "Account password")}</span><Input type="password" autoComplete="current-password" required value={password} disabled={loginBusy} onChange={event => setPassword(event.target.value)} /></label><Button type="submit" disabled={loginBusy}>{loginBusy ? t("登录中…", "Signing in…") : t("普通登录并进入工作区", "Sign in normally and enter workspace")}</Button></form></section>}
    {outcome && <p className="text-sm">{t("接受邀请不代表恢复邮箱已验证。普通登录后，请在本人账号安全中以当前密码发起独立邮件挑战。", "Accepting an invitation does not verify a recovery email. After normal sign-in, start a separate mail challenge with your current password in account security.")} <Link to="/pm/account/security" className="underline">{t("本人账号安全", "Account security")}</Link></p>}
    <Link to="/pm" className="text-sm underline">{t("前往普通登录", "Go to normal sign-in")}</Link>
  </main>
}
