import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react"
import { Link, Navigate } from "react-router"
import { z } from "zod"
import { ApiError, type InstanceSetupStatus } from "@contracts"
import { ArrowRight } from "lucide-react"
import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Field } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { PmAuthPageShell } from "./pm-auth-page"
import { parseSetupStatus } from "./pm-first-use-model"
import { usePmService } from "./pm-service"
import { useText } from "./pm-ui"
import styles from "./pm-auth-page.module.css"

const registrationResponse = z.object({
  actor: z.object({ id: z.string().uuid(), email: z.email(), name: z.string().min(1).max(200) }).strict(),
  expiresAt: z.string().datetime({ offset: true }),
}).strict()

type Phase = "ready" | "submitting" | "checking" | "unknown" | "login" | "signing-in"

export function PmRegisterPage() {
  const service = usePmService()
  const { client, refresh } = service
  const t = useText()
  const [status, setStatus] = useState<InstanceSetupStatus | null>(null)
  const [statusError, setStatusError] = useState(false)
  const [revision, setRevision] = useState(0)
  const [step, setStep] = useState<0 | 1 | 2>(0)
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [attempted, setAttempted] = useState(false)
  const [phase, setPhase] = useState<Phase>("ready")
  const [message, setMessage] = useState<string | null>(null)
  const mounted = useRef(false)
  const pending = useRef(false)
  const current = useRef({ actor: service.actor, epoch: service.actorEpoch })
  current.current = { actor: service.actor, epoch: service.actorEpoch }

  useLayoutEffect(() => {
    window.history.replaceState(window.history.state, "", window.location.pathname)
  }, [])
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    setStatus(null)
    setStatusError(false)
    void client.setupStatus({ signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]) })
      .then(value => { const parsed = parseSetupStatus(value); if (!controller.signal.aborted) setStatus(parsed) })
      .catch(() => { if (!controller.signal.aborted) setStatusError(true) })
    return () => controller.abort()
  }, [client, revision])

  const nameError = !name.trim() || name.trim().length > 200 ? t("请输入不超过 200 个字符的姓名。", "Enter a name of at most 200 characters.") : null
  const emailError = email.trim().length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ? t("请输入有效的邮箱地址（最多 254 个字符）。", "Enter a valid email address of at most 254 characters.") : null
  const passwordError = password.length < 12 || password.length > 256 ? t("密码须为 12 至 256 个字符。", "Use 12 to 256 characters for your password.") : null
  const sessionError = service.error && !(service.error instanceof ApiError && service.error.status === 401)
  const busy = phase === "submitting" || phase === "checking" || phase === "signing-in"

  async function checkSession() {
    if (pending.current || current.current.actor) return
    pending.current = true
    setPhase("checking")
    try {
      await refresh()
      if (mounted.current && !current.current.actor) setPhase("unknown")
    } catch (error) {
      if (!mounted.current || current.current.actor) return
      if (error instanceof ApiError && error.status === 401) {
        setPhase("login")
        setMessage(t("当前没有登录会话，但这不能证明账号未创建。请使用相同邮箱普通登录；不要再次注册。", "No active session was found, but this does not prove the account was not created. Sign in normally with the same email; do not register again."))
      } else {
        setPhase("unknown")
        setMessage(t("仍无法确认当前会话。请再次检查；不会重新提交注册。", "The current session could not be confirmed. Check again; registration will not be resubmitted."))
      }
    } finally { pending.current = false }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending.current || phase !== "ready" || service.loading || sessionError || current.current.actor || !status?.initialized || status.registrationMode !== "open") return
    setAttempted(true)
    if (nameError || emailError) { setStep(0); return }
    if (step === 0) { setAttempted(false); setStep(1); return }
    if (passwordError) { setStep(1); return }
    if (step === 1) { setAttempted(false); setStep(2); return }
    const epoch = current.current.epoch
    pending.current = true
    setPhase("submitting")
    setMessage(null)
    try {
      const result = registrationResponse.parse(await client.register({ name: name.trim(), email: email.trim().toLowerCase(), password }, { signal: AbortSignal.timeout(20_000) }))
      if (result.actor.email.toLowerCase() !== email.trim().toLowerCase()) throw new Error("Invalid registration response")
      if (!mounted.current || current.current.epoch !== epoch || current.current.actor) return
      setPassword("")
      pending.current = false
      await checkSession()
    } catch (error) {
      if (!mounted.current || current.current.epoch !== epoch || current.current.actor) return
      setPassword("")
      if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.code !== "invalid_response") {
        if (error.code === "account_conflict") {
          setPhase("login")
          setMessage(t("该邮箱无法注册。请使用原账号普通登录；现有密码未被更改。", "This email cannot be registered. Sign in with the existing account; its password was not changed."))
        } else if (error.code === "already_authenticated") {
          pending.current = false
          await checkSession()
        } else {
          setPhase("ready")
          setStep(1)
          setMessage(t("注册请求被拒绝。请检查输入或稍后重试。", "Registration was rejected. Check your input or try again later."))
        }
      } else {
        setMessage(t("注册结果未知。密码已清除；先检查会话，不会再次发送注册请求。", "The registration outcome is unknown. The password was cleared; check the session without submitting registration again."))
        pending.current = false
        await checkSession()
      }
    } finally { pending.current = false; if (mounted.current) setPassword("") }
  }

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending.current || !password || password.length > 256 || current.current.actor) return
    pending.current = true
    setPhase("signing-in")
    try { await service.login(email.trim().toLowerCase(), password) }
    catch (error) {
      if (!mounted.current || current.current.actor) return
      setPassword("")
      if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.code !== "invalid_response") {
        setPhase("login")
        setMessage(t("登录未成功，请检查密码或使用账号恢复。", "Sign-in failed. Check your password or use account recovery."))
      } else {
        pending.current = false
        await checkSession()
      }
    } finally { pending.current = false; if (mounted.current) setPassword("") }
  }

  if (service.actor) return <Navigate to="/pm" replace />
  return <PmAuthPageShell><section className={styles.authForm} aria-labelledby="pm-register-title">
    <h1 id="pm-register-title" className={styles.title}>{t("注册账号", "Create an account")}</h1>
    <p className={styles.description}>{t("注册后选择或创建工作区，再完成首次使用引导。", "After signup, select or create a workspace and continue to onboarding.")}</p>
    {(!status || service.loading) && !statusError && !sessionError && <p role="status" className={styles.hint}>{t("正在检查实例和会话…", "Checking instance and session…")}</p>}
    {status && !status.initialized && <p className={styles.hint}>{t("此实例尚未初始化，请先完成一次性设置。", "This instance is not initialized. Complete one-time setup first.")} <Link to="/pm" className={styles.registerLink}>{t("前往设置", "Go to setup")}</Link></p>}
    {status?.initialized && status.registrationMode !== "open" && <p className={styles.hint}>{t("此实例当前未开放注册。", "Signup is not currently open on this instance.")}</p>}
    {(statusError || sessionError) && phase === "ready" && <Alert tone="warning"><p>{t("无法确认实例或会话状态，暂不能注册。", "Instance or session status could not be confirmed; signup is unavailable.")}</p><Button type="button" variant="secondary" onClick={() => { setRevision(value => value + 1); void refresh().catch(() => {}) }}>{t("重新检查", "Check again")}</Button></Alert>}
    {status?.initialized && status.registrationMode === "open" && phase === "ready" && <>
      <p className={styles.hint} aria-live="polite">{t(`第 ${step + 1} 步，共 3 步`, `Step ${step + 1} of 3`)}</p>
      <form noValidate onSubmit={event => { void submit(event) }}><fieldset disabled={busy || service.loading || !!sessionError} className={styles.fields}>
        {step === 0 && <><Field label={t("姓名", "Name")} required error={attempted ? nameError : null}>{props => <Input {...props} autoComplete="name" maxLength={200} value={name} onChange={event => setName(event.target.value)} />}</Field><Field label={t("邮箱", "Email")} required error={attempted ? emailError : null}>{props => <Input {...props} type="email" autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={254} value={email} onChange={event => setEmail(event.target.value)} />}</Field></>}
        {step === 1 && <Field label={t("密码", "Password")} required description={t("至少 12 个字符。", "At least 12 characters.")} error={attempted ? passwordError : null}>{props => <Input {...props} type="password" autoComplete="new-password" minLength={12} maxLength={256} value={password} onChange={event => setPassword(event.target.value)} />}</Field>}
        {step === 2 && <p className={styles.hint}>{t("确认创建账号", "Confirm account creation")}: {name.trim()} · {email.trim().toLowerCase()}</p>}
        <Button type="submit" className={styles.submit}>{step < 2 ? t("继续", "Continue") : t("创建账号", "Create account")}<ArrowRight size={16} aria-hidden="true" /></Button>
        {step > 0 && <Button type="button" variant="outline" onClick={() => { setAttempted(false); setStep(step === 2 ? 1 : 0) }}>{t("返回", "Back")}</Button>}
      </fieldset></form>
    </>}
    {message && <Alert tone="warning" className={styles.feedbackAlert}><p>{message}</p></Alert>}
    {busy && <p role="status" className={styles.hint}>{phase === "submitting" ? t("正在注册…", "Creating account…") : phase === "signing-in" ? t("正在登录…", "Signing in…") : t("正在检查会话…", "Checking session…")}</p>}
    {phase === "unknown" && <Button type="button" variant="secondary" onClick={() => { void checkSession() }}>{t("检查登录状态", "Check sign-in status")}</Button>}
    {phase === "login" && <form onSubmit={event => { void signIn(event) }}><fieldset className={styles.fields} disabled={busy}><p className={styles.hint}>{email.trim().toLowerCase()}</p><Field label={t("账号密码", "Account password")} required>{props => <Input {...props} type="password" autoComplete="current-password" maxLength={256} value={password} onChange={event => setPassword(event.target.value)} />}</Field><Button type="submit">{t("普通登录", "Sign in normally")}</Button></fieldset></form>}
    <div className={styles.accountGuidance}><Link to="/pm" className={styles.registerLink}>{t("返回登录或设置", "Back to sign-in or setup")}</Link>{" · "}<Link to="/pm/account/recovery" className={styles.registerLink}>{t("账号恢复", "Account recovery")}</Link></div>
  </section></PmAuthPageShell>
}
