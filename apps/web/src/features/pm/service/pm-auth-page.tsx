import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react"
import { Link } from "react-router"
import { ApiError } from "@contracts"
import { ArrowRight, Eye, EyeOff, FolderKanban, KeyRound, MessageSquare, PanelsTopLeft, Users } from "lucide-react"
import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Field } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { useI18n } from "@/lib/i18n-provider"
import { pmErrorMessage, usePmService } from "./pm-service"
import { useText } from "./pm-ui"
import styles from "./pm-auth-page.module.css"

type LoginPhase = "idle" | "signing-in" | "unknown" | "checking"

export function PmAuthPageShell({ children, toolbar, split = true }: {
  children: ReactNode
  toolbar?: ReactNode
  split?: boolean
}) {
  const t = useText()
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <Link to="/pm" className={styles.brand}>
          <PanelsTopLeft size={22} aria-hidden="true" />
          <span>Project Management</span>
        </Link>
        {toolbar && <div className={styles.toolbar}>{toolbar}</div>}
      </header>
      <main id="main-content" className={`${styles.main} ${split ? styles.split : ""}`} data-pm-route-page>
        {split && (
          <aside className={styles.story} aria-label={t("关于项目协作", "About project collaboration")}>
            <div>
              <p className={styles.eyebrow}>{t("为共同的目标，携手推进", "A shared place for your team's work")}</p>
              <h2 className={styles.storyTitle}>{t("让每个人，\n看见项目的下一步。", "Bring people together.\nMove projects forward.")}</h2>
              <p className={styles.storyDescription}>{t("整理任务、分享上下文、一起做出决定。让团队的日常协作回到一个清晰的工作空间。", "Organize tasks, share context, and make decisions together. Give everyday collaboration a clear home.")}</p>
              <div className={styles.storyDiagram} aria-hidden="true">
                <div><Users size={24} /></div><span />
                <div><MessageSquare size={24} /></div><span />
                <div><FolderKanban size={24} /></div>
              </div>
            </div>
            <p className={styles.storyNote}>{t("由团队成员协作推进，由工作区权限保护。", "Driven by your team. Protected by workspace permissions.")}</p>
          </aside>
        )}
        <div className={styles.content}>{children}</div>
      </main>
      <footer className={styles.footer}>
        <span>© Project Management</span>
        <span>{t("为团队协作而建", "Built for working together")}</span>
      </footer>
    </div>
  )
}

export function PmLoginPage() {
  const service = usePmService()
  const { locale } = useI18n()
  const t = useText()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [visible, setVisible] = useState(false)
  const [attempted, setAttempted] = useState(false)
  const [phase, setPhase] = useState<LoginPhase>("idle")
  const [failure, setFailure] = useState<unknown>(null)
  const [handledServiceError, setHandledServiceError] = useState<unknown>(null)
  const [confirmedAnonymous, setConfirmedAnonymous] = useState(false)
  const emailInput = useRef<HTMLInputElement>(null)
  const passwordInput = useRef<HTMLInputElement>(null)
  const mounted = useRef(false)
  const requestPending = useRef(false)
  const currentActor = useRef(service.actor)
  currentActor.current = service.actor

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const initialFailure = service.error !== handledServiceError ? service.error : null
  const needsSessionCheck = phase === "unknown" || (!!initialFailure && !(initialFailure instanceof ApiError && initialFailure.status === 401))
  const busy = phase === "signing-in" || phase === "checking"
  const locked = service.loading || busy || needsSessionCheck || !!service.actor
  const shownFailure = failure ?? initialFailure
  const emailError = !email.trim()
    ? t("请输入邮箱。", "Enter your email address.")
    : email.trim().length > 254
      ? t("邮箱不能超过 254 个字符。", "Use no more than 254 characters for your email.")
      : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
        ? t("请输入有效的邮箱地址。", "Enter a valid email address.")
        : null
  const passwordError = !password
    ? t("请输入密码。", "Enter your password.")
    : password.length > 256
      ? t("密码不能超过 256 个字符。", "Use no more than 256 characters for your password.")
      : null

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (locked || requestPending.current) return
    setAttempted(true)
    if (emailError || passwordError) {
      if (emailError) emailInput.current?.focus()
      else passwordInput.current?.focus()
      return
    }
    requestPending.current = true
    setPhase("signing-in")
    setFailure(null)
    setConfirmedAnonymous(false)
    setVisible(false)
    try {
      await service.login(email.trim(), password)
      // The parent switches to the workspace picker as soon as an actor exists.
    } catch (error) {
      // Workspace reads may fail after authentication has already succeeded.
      if (!mounted.current || currentActor.current) return
      setHandledServiceError(error)
      setFailure(error)
      setAttempted(false)
      setPhase(error instanceof ApiError && error.code !== "invalid_response" && error.status >= 400 && error.status < 500 ? "idle" : "unknown")
    } finally {
      requestPending.current = false
      if (mounted.current) setPassword("")
    }
  }

  async function checkSession() {
    if (requestPending.current || service.loading || service.actor) return
    requestPending.current = true
    setPhase("checking")
    setConfirmedAnonymous(false)
    try {
      await service.refresh()
      // A successful refresh supplies the actor; do not infer an anonymous session.
      if (mounted.current && !currentActor.current) setPhase("unknown")
    } catch (error) {
      if (!mounted.current || currentActor.current) return
      setHandledServiceError(error)
      if (error instanceof ApiError && error.status === 401) {
        setFailure(null)
        setPhase("idle")
        setConfirmedAnonymous(true)
        setPassword("")
        setVisible(false)
      } else {
        setFailure(error)
        setPhase("unknown")
      }
    } finally {
      requestPending.current = false
    }
  }

  return (
    <section className={styles.authForm} aria-labelledby="pm-login-title">
      <div className={styles.symbol}><KeyRound size={20} aria-hidden="true" /></div>
      <h1 id="pm-login-title" className={styles.title}>{t("欢迎回来", "Welcome back")}</h1>
      <p className={styles.description}>{t("登录，继续与团队一起推进项目。", "Sign in to continue working with your team.")}</p>
      <form noValidate aria-labelledby="pm-login-title" onSubmit={(event) => { void submit(event) }}>
        <fieldset disabled={locked} className={styles.fields}>
          <Field label={t("邮箱", "Email")} required error={attempted ? emailError : null}>
            {(props) => (
              <Input {...props} ref={emailInput} name="email" type="email" autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={254} placeholder="you@example.com" value={email} onChange={(event) => { setEmail(event.target.value); setFailure(null) }} />
            )}
          </Field>
          <Field label={t("密码", "Password")} required error={attempted ? passwordError : null}>
            {(props) => (
              <div className={styles.password}>
                <Input {...props} ref={passwordInput} name="password" type={visible ? "text" : "password"} autoComplete="current-password" maxLength={256} value={password} onChange={(event) => { setPassword(event.target.value); setFailure(null) }} />
                <Button type="button" variant="ghost" size="icon" aria-label={visible ? t("隐藏密码", "Hide password") : t("显示密码", "Show password")} aria-pressed={visible} aria-controls={props.id} onClick={() => setVisible((value) => !value)}>
                  {visible ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
                </Button>
              </div>
            )}
          </Field>
          <Button type="submit" className={styles.submit} loading={busy || service.loading} disabled={locked}>
            {phase === "signing-in" ? t("正在登录…", "Signing in…") : phase === "checking" || service.loading ? t("正在检查会话…", "Checking session…") : t("登录", "Sign in")}
            {!busy && !service.loading && <ArrowRight size={16} aria-hidden="true" />}
          </Button>
        </fieldset>
      </form>
      <div className={styles.feedback}>
        {shownFailure != null && (
          <Alert tone={needsSessionCheck ? "warning" : "error"}>
            <p>{pmErrorMessage(shownFailure, locale === "en" ? "en" : "zh")}</p>
          </Alert>
        )}
        {(needsSessionCheck || phase === "checking") && (
          <Alert tone="info">
            <p className={styles.feedbackTitle}>{t("暂时无法确认登录状态", "Your sign-in status is not confirmed")}</p>
            <p>{t("请先检查当前会话，避免重复提交登录。如果检查确认尚未登录，你可以重新输入密码。", "Check the current session before submitting again. If the check confirms you are signed out, you can enter your password again.")}</p>
            <Button type="button" variant="secondary" className={styles.recovery} loading={phase === "checking"} disabled={busy || service.loading} onClick={() => { void checkSession() }}>
              {phase === "checking" ? t("正在检查…", "Checking…") : t("检查登录状态", "Check sign-in status")}
            </Button>
          </Alert>
        )}
        {confirmedAnonymous && <p role="status" className={styles.hint}>{t("已确认当前没有登录会话。现在可以登录。", "No active session was found. You can now sign in.")}</p>}
        {service.loading && !busy && <p role="status" className={styles.hint}>{t("正在读取当前会话，请稍候。", "Reading your current session. Please wait.")}</p>}
      </div>
      <div className={styles.accountGuidance}>
        <p>{t("使用管理员创建的账号，或通过有效邀请创建的账号登录。", "Sign in with an administrator-provisioned account or an account created through a valid invitation.")}</p>
        <p>{t("公开注册未开放。邮件找回只面向本人已独立验证的恢复邮箱；历史登录邮箱或邀请不是验证证明。", "Public signup is unavailable. Email recovery requires an independently verified recovery email; a historical sign-in email or invitation is not verification.")}</p>
        <Link to="/pm/account/recovery" className="text-sm underline">{t("忘记密码 / 查看邮件找回状态", "Forgot password / email recovery availability")}</Link>
      </div>
    </section>
  )
}
