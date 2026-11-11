import { useEffect, useRef, useState, type FormEvent } from "react"
import { useNavigate } from "react-router"
import { ApiError, type InstanceSetupStatus, type SetupRequest } from "@contracts"
import { ArrowRight, Eye, EyeOff, LoaderCircle, RefreshCw } from "lucide-react"
import { DovspaceWordmark } from "@/components/dovspace-brand"
import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Field } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { useI18n } from "@/lib/i18n-provider"
import { PmLoginPage } from "./pm-auth-page"
import { parseSetupResponse, parseSetupStatus, setupEntryState, setupWorkspaceId } from "./pm-first-use-model"
import { pmErrorMessage, PmServiceError, usePmService } from "./pm-service"
import { useText } from "./pm-ui"
import { PmWorkspacePicker } from "./pm-workspace-picker"
import styles from "./pm-auth-page.module.css"

type Phase = "loading" | "idle" | "submitting" | "checking" | "unknown"
const isAnonymous = (error: unknown) => error instanceof ApiError && error.status === 401

type DesktopSetupBridge = { token: () => Promise<string | null> }
/** Electron local workspaces expose this narrow bridge; browsers and remote
 * workspaces fall back to entering the deployment-provided token manually. */
async function desktopSetupToken(): Promise<string | null> {
  if (typeof window === "undefined") return null
  const bridge = (window as Window & { desktopWorkspace?: { setup?: DesktopSetupBridge } }).desktopWorkspace?.setup
  if (!bridge || typeof bridge.token !== "function") return null
  try {
    const token = await bridge.token()
    return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null
  } catch { return null }
}

/** Setup uses the ordinary PM client and session refresh. No setup inputs enter
 * query caches, route state, persistent drafts, or the command journal. */
export function PmFirstUsePage() {
  const service = usePmService()
  const { client, refresh, actor, workspaces, loading, error } = service
  const navigate = useNavigate()
  const t = useText()
  const { locale } = useI18n()
  const [status, setStatus] = useState<InstanceSetupStatus | null>(null)
  const [statusFailure, setStatusFailure] = useState<unknown>(null)
  const [submissionFailure, setSubmissionFailure] = useState<unknown>(null)
  const [phase, setPhase] = useState<Phase>("loading")
  const [submitted, setSubmitted] = useState(false)
  const [expectedWorkspaceId, setExpectedWorkspaceId] = useState<string | null>(null)
  const completed = useRef(false)
  const mounted = useRef(false)
  const requestPending = useRef(false)

  useEffect(() => {
    mounted.current = true
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)])
    void client.setupStatus({ signal }).then(value => {
      let current: InstanceSetupStatus
      try { current = parseSetupStatus(value) }
      catch { throw new PmServiceError("invalid_response") }
      if (!controller.signal.aborted) { setStatus(current); setPhase("idle") }
    }).catch(cause => {
      if (!controller.signal.aborted) { setStatusFailure(cause); setPhase("idle") }
    })
    return () => { mounted.current = false; controller.abort() }
  }, [client])

  useEffect(() => {
    if (!submitted || phase !== "idle" || !status?.initialized || !actor || loading || error) return
    const id = setupWorkspaceId(workspaces, expectedWorkspaceId)
    if (id) navigate(`/pm/${encodeURIComponent(id)}/home`, { replace: true })
  }, [submitted, phase, status?.initialized, actor, loading, error, workspaces, expectedWorkspaceId, navigate])

  async function readStatusAndSession() {
    setPhase("checking")
    setStatusFailure(null)
    // Even a rejected setup can have raced a successful request in another tab.
    // Always read both authorities; neither a network error nor a 5xx is empty.
    const [setup, session] = await Promise.allSettled([
      client.setupStatus({ signal: AbortSignal.timeout(20_000) }).then(value => {
        try { return parseSetupStatus(value) }
        catch { throw new PmServiceError("invalid_response") }
      }),
      refresh(),
    ])
    if (!mounted.current) return
    if (setup.status === "rejected") {
      setStatusFailure(setup.reason)
      setPhase("unknown")
      return
    }
    setStatus(setup.value)
    const sessionState = session.status === "fulfilled" ? "authenticated" : isAnonymous(session.reason) ? "anonymous" : "unknown"
    setPhase(setupEntryState(setup.value, sessionState, completed.current) === "unknown" ? "unknown" : "idle")
  }

  async function check() {
    if (requestPending.current) return
    requestPending.current = true
    try { await readStatusAndSession() }
    finally { requestPending.current = false }
  }

  async function submit(request: SetupRequest) {
    if (requestPending.current || phase !== "idle" || !status?.setupAllowed || status.initialized || actor || loading || error && !isAnonymous(error)) {
      request.password = ""
      request.setupToken = ""
      return
    }
    requestPending.current = true
    setSubmitted(true)
    setPhase("submitting")
    setSubmissionFailure(null)
    try {
      try {
        const response = await client.setup(request, { signal: AbortSignal.timeout(20_000) })
        let result
        try { result = parseSetupResponse(response) }
        catch { throw new PmServiceError("invalid_response") }
        completed.current = true
        if (mounted.current) setExpectedWorkspaceId(result.workspaceId)
      } catch (cause) {
        if (mounted.current) setSubmissionFailure(cause)
      } finally {
        // Drop request-held secrets before recovery reads. They are never replayed.
        request.password = ""
        request.setupToken = ""
      }
      if (mounted.current) await readStatusAndSession()
    } finally {
      requestPending.current = false
    }
  }

  if (actor) return <PmWorkspacePicker />

  if (status?.initialized) return <>
    {submitted && <Alert tone="info" className="w-full max-w-md">
      <p>{t("此实例已完成设置。请使用账号邮箱和密码正常登录，不要重复提交首次设置。", "This instance is already set up. Sign in with your account email and password; do not submit setup again.")}</p>
    </Alert>}
    <PmLoginPage />
  </>

  const busy = phase === "submitting" || phase === "checking"
  const sessionFailure = error && !isAnonymous(error) ? error : null
  const entry = status ? setupEntryState(status, phase === "unknown" || sessionFailure || loading ? "unknown" : "anonymous", completed.current) : null
  const failure = statusFailure ?? sessionFailure
  const pending = phase === "loading" || loading && !busy && !failure

  if (failure || !status || entry === "unprepared" || entry === "unknown" && !busy || pending) return (
    <section className={styles.authForm} aria-labelledby="pm-first-use-title" aria-busy={pending || busy}>
      <div className="mb-6 flex justify-center"><DovspaceWordmark height={30} /></div>
      <h1 id="pm-first-use-title" className={styles.title}>{pending || busy
        ? t("正在检查实例状态", "Checking instance status")
        : failure ? t("无法确认实例状态", "Instance status is unavailable")
          : entry === "unprepared" ? t("首次设置尚未开放", "First-time setup is not prepared")
            : t("设置结果尚待核对", "Setup outcome is not confirmed")}</h1>
      <div className={styles.feedback}>
        {pending || busy ? <p role="status" className={styles.description}><LoaderCircle size={18} className="mr-2 inline animate-spin motion-reduce:animate-none" aria-hidden="true" />{t("正在读取服务状态和当前会话，请稍候。", "Reading the service status and current session. Please wait.")}</p>
          : failure ? <Alert tone="error" className={styles.feedbackAlert}>
            <p>{pmErrorMessage(failure, locale === "en" ? "en" : "zh")}</p>
            <p>{t("读取失败不代表实例为空或尚未初始化。请重新核对，不要重新创建账号或工作区。", "A failed read does not mean this instance is empty or uninitialized. Recheck its state rather than creating another account or workspace.")}</p>
          </Alert>
            : entry === "unprepared" ? <p className={styles.description}>{t("请联系部署管理员先运行 pnpm bootstrap，准备一次性设置令牌，再重新检查。请通过安全渠道取得令牌；浏览器不会读取服务器上的令牌文件。", "Ask the deployment administrator to run pnpm bootstrap to prepare a one-time setup token, then check again. Obtain the token through a secure channel; the browser does not read the server's token file.")}</p>
              : <Alert tone="warning" className={styles.feedbackAlert}><p>{t("暂时无法确认原设置请求或当前会话。密码和令牌已清除；只核对状态，不会自动重新提交。若实例已完成设置，请使用普通登录。", "The original setup or current session is not confirmed. The password and token were cleared. This action only checks state and never resubmits setup. If the instance is initialized, use ordinary sign-in.")}</p></Alert>}
        {!pending && <Button type="button" variant="secondary" className={styles.recovery} disabled={busy} loading={busy} onClick={() => { void check() }}>
          {!busy && <RefreshCw size={16} aria-hidden="true" />}{t("重新核对状态", "Check status again")}
        </Button>}
      </div>
      <div className={styles.accountGuidance}><p>{t("此实例仅限邀请加入，不提供公开注册。已有账号、工作区及业务数据不会在此重建。", "This instance is invitation-only, with no public signup. Existing accounts, workspaces, and business data are never recreated here.")}</p></div>
    </section>
  )

  return <PmSetupForm busy={busy} checking={phase === "checking"} failure={submissionFailure} submitted={submitted} onSubmit={submit} />
}

function PmSetupForm({ busy, checking, failure, submitted, onSubmit }: {
  busy: boolean
  checking: boolean
  failure: unknown
  submitted: boolean
  onSubmit: (request: SetupRequest) => Promise<void>
}) {
  const t = useText()
  const { locale } = useI18n()
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [workspaceName, setWorkspaceName] = useState("")
  const [setupToken, setSetupToken] = useState("")
  const [desktopToken, setDesktopToken] = useState(false)
  const [visible, setVisible] = useState(false)
  const [attempted, setAttempted] = useState(false)
  const nameInput = useRef<HTMLInputElement>(null)
  const emailInput = useRef<HTMLInputElement>(null)
  const passwordInput = useRef<HTMLInputElement>(null)
  const workspaceInput = useRef<HTMLInputElement>(null)
  const tokenInput = useRef<HTMLInputElement>(null)
  useEffect(() => {
    let active = true
    void desktopSetupToken().then(token => {
      if (!active || !token) return
      setSetupToken(current => current || token)
      setDesktopToken(true)
    })
    return () => { active = false }
  }, [])
  const nameError = !name.trim() || name.trim().length > 200 ? t("请输入姓名（最多 200 个字符）。", "Enter your name (up to 200 characters).") : null
  const emailError = email.trim().length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ? t("请输入有效的邮箱地址（最多 254 个字符）。", "Enter a valid email address (up to 254 characters).") : null
  const passwordError = password.length < 12 || password.length > 256 ? t("密码须为 12–256 个字符。", "Use a password of 12–256 characters.") : null
  const workspaceError = !workspaceName.trim() || workspaceName.trim().length > 200 ? t("请输入工作区名称（最多 200 个字符）。", "Enter a workspace name (up to 200 characters).") : null
  const tokenError = !/^[A-Za-z0-9_-]{43}$/.test(setupToken) ? t("请输入部署管理员提供的完整一次性设置令牌（43 位）。", "Enter the complete one-time setup token from your deployment administrator (43 characters).") : null

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setAttempted(true)
    const invalid = [[nameError, nameInput], [emailError, emailInput], [passwordError, passwordInput], [workspaceError, workspaceInput], [tokenError, tokenInput]] as const
    const first = invalid.find(([issue]) => issue)
    if (first) { first[1].current?.focus(); return }
    const request = { name: name.trim(), email: email.trim(), password, workspaceName: workspaceName.trim(), setupToken }
    setPassword("")
    if (!desktopToken) setSetupToken("")
    setVisible(false)
    setAttempted(false)
    void onSubmit(request)
  }

  return <section className={styles.authForm} aria-labelledby="pm-setup-title" aria-busy={busy}>
    <div className="mb-6 flex justify-center"><DovspaceWordmark height={30} /></div>
    <h1 id="pm-setup-title" className={styles.title}>{t("欢迎使用 Dovspace", "Welcome to Dovspace")}</h1>
    <p className={styles.description}>{t("创建你的账号和第一个工作区。仅准备好的一次性令牌可完成设置。", "Create your account and first workspace. A prepared one-time token is required to complete setup.")}</p>
    <form noValidate onSubmit={submit} aria-labelledby="pm-setup-title">
      <fieldset disabled={busy} className={styles.fields}>
        <Field label={t("姓名", "Name")} required error={attempted ? nameError : null}>{props => <Input {...props} ref={nameInput} name="name" autoComplete="name" maxLength={200} value={name} onChange={event => setName(event.target.value)} />}</Field>
        <Field label={t("邮箱", "Email")} required error={attempted ? emailError : null}>{props => <Input {...props} ref={emailInput} name="email" type="email" autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={254} placeholder="you@example.com" value={email} onChange={event => setEmail(event.target.value)} />}</Field>
        <Field label={t("密码", "Password")} required description={t("至少 12 个字符。请妥善保存，应用不会生成明文密码文件。", "At least 12 characters. Keep it safe; the app does not create a plaintext password file.")} error={attempted ? passwordError : null}>{props => <div className={styles.password}>
          <Input {...props} ref={passwordInput} name="password" type={visible ? "text" : "password"} autoComplete="new-password" minLength={12} maxLength={256} value={password} onChange={event => setPassword(event.target.value)} />
          <Button type="button" variant="ghost" size="icon" aria-label={visible ? t("隐藏密码", "Hide password") : t("显示密码", "Show password")} aria-pressed={visible} aria-controls={props.id} onClick={() => setVisible(value => !value)}>{visible ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}</Button>
        </div>}</Field>
        <Field label={t("工作区名称", "Workspace name")} required error={attempted ? workspaceError : null}>{props => <Input {...props} ref={workspaceInput} name="workspaceName" autoComplete="organization" maxLength={200} value={workspaceName} onChange={event => setWorkspaceName(event.target.value)} />}</Field>
        <Field label={t("一次性设置令牌", "One-time setup token")} required description={t("由部署管理员提供，请勿放入网址或分享给其他人。", "Provided by your deployment administrator. Never place it in a URL or share it.")} error={attempted ? tokenError : null}>{props => <Input {...props} ref={tokenInput} name="setupToken" type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={43} value={setupToken} onChange={event => { setDesktopToken(false); setSetupToken(event.target.value) }} />}</Field>
        {desktopToken && <p className={styles.hint} role="status">{t("桌面端已自动填入本机一次性设置令牌；令牌不会进入网址、历史记录或本地存储。", "The desktop app filled in this machine's one-time setup token; it is never placed in a URL, history, or local storage.")}</p>}
        <Button type="submit" className={styles.submit} loading={busy} disabled={busy}>{checking ? t("正在核对设置和会话…", "Checking setup and session…") : busy ? t("正在设置…", "Setting up…") : t("创建账号与工作区", "Create account and workspace")}{!busy && <ArrowRight size={16} aria-hidden="true" />}</Button>
      </fieldset>
    </form>
    <div className={styles.feedback}>
      {failure != null && <Alert tone="warning" className={styles.feedbackAlert}><p>{pmErrorMessage(failure, locale === "en" ? "en" : "zh")}</p></Alert>}
      {submitted && !busy && <p role="status" className={styles.hint}>{t("已核对：实例仍未完成设置，当前没有登录会话。可修正输入并重新填写密码和令牌后显式提交；应用不会自动重试。", "Checked: this instance is still uninitialized and no session is active. Correct the fields and re-enter the password and token before explicitly submitting. The app never retries automatically.")}</p>}
      {checking && <p role="status" className={styles.hint}>{t("正在查询设置状态和当前会话；不会再次发送设置请求。", "Checking setup status and the current session; setup is not being submitted again.")}</p>}
    </div>
    <div className={styles.accountGuidance}>
      <p>{t("设置后直接进入工作区；不需要先配置 Provider 或填写额外问卷。", "Enter your workspace after setup; no Provider configuration or extra questionnaire is required.")}</p>
      <p>{t("此实例仅限邀请加入。后续成员通过现有邀请加入；本人密码、恢复邮箱和会话在账号安全中管理。设置或邀请不代表恢复邮箱已验证。", "This instance is invitation-only. Add future members with existing invitations. Manage your password, recovery email, and sessions in account security. Setup or an invitation does not verify a recovery email.")}</p>
    </div>
  </section>
}
