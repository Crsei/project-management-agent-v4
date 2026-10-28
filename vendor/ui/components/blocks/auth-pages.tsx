"use client"

import {
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import {
  ArrowRight,
  Eye,
  EyeOff,
  KeyRound,
  Layers,
  LockKeyhole,
  Mail,
  PanelsTopLeft,
  SearchX,
  ServerCrash,
  ShieldCheck,
  ShieldX,
  Wrench,
} from "lucide-react"
import { useI18n } from "../../lib/i18n-provider"
import { cn } from "../../lib/utils"
import { Button, buttonVariants } from "../ui/button"
import { Field } from "../ui/field"
import { Input } from "../ui/input"
import { Checkbox } from "../ui/checkbox"
import { Alert } from "../ui/alert"
import styles from "./auth-pages.module.css"

export type AuthMode = "login" | "register" | "forgot-password"
export type AuthFormValue = {
  name: string
  email: string
  password: string
  confirmPassword: string
  remember: boolean
  acceptTerms: boolean
}
export type AuthFeedback = {
  state: "idle" | "submitting" | "success" | "error" | "unknown"
  message?: ReactNode
  actions?: ReactNode
}
export type AuthPageAction = { href: string; label: ReactNode }
export type AuthFormProps = {
  mode: AuthMode
  value: AuthFormValue
  onChange: (value: AuthFormValue) => void
  onSubmit?: (value: AuthFormValue) => void
  feedback?: AuthFeedback
  links?: Partial<Record<AuthMode, string>>
  terms?: ReactNode
  headingLevel?: "h1" | "h2"
}
type ErrorKey =
  | "auth.nameRequired"
  | "auth.emailInvalid"
  | "auth.passwordRequired"
  | "auth.passwordShort"
  | "auth.passwordMismatch"
  | "auth.termsRequired"
type FieldName =
  "name" | "email" | "password" | "confirmPassword" | "acceptTerms"
const subscribeHydration = () => () => {}
const clientHydrated = () => true
const serverHydrated = () => false
function validate(mode: AuthMode, value: AuthFormValue) {
  const errors: Partial<Record<FieldName, ErrorKey>> = {}
  if (mode === "register" && !value.name.trim())
    errors.name = "auth.nameRequired"
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email.trim()))
    errors.email = "auth.emailInvalid"
  if (mode !== "forgot-password" && !value.password)
    errors.password = "auth.passwordRequired"
  if (mode === "register") {
    if (value.password && value.password.length < 8)
      errors.password = "auth.passwordShort"
    if (!value.confirmPassword || value.confirmPassword !== value.password)
      errors.confirmPassword = "auth.passwordMismatch"
    if (!value.acceptTerms) errors.acceptTerms = "auth.termsRequired"
  }
  return errors
}

/** Presentation and input validation only. The caller owns credentials, requests and receipts. */
export function AuthForm({
  mode,
  value,
  onChange,
  onSubmit,
  feedback = { state: "idle" },
  links,
  terms,
  headingLevel: Heading = "h1",
}: AuthFormProps) {
  const { t } = useI18n()
  const id = useId()
  const hydrated = useSyncExternalStore(
    subscribeHydration,
    clientHydrated,
    serverHydrated,
  )
  const form = useRef<HTMLFormElement>(null)
  const [attempted, setAttempted] = useState(false)
  const [visible, setVisible] = useState(false)
  const [confirmVisible, setConfirmVisible] = useState(false)
  const errors =
    attempted && feedback.state !== "success" ? validate(mode, value) : {}
  const busy = feedback.state === "submitting"
  const locked =
    busy || feedback.state === "unknown" || feedback.state === "success"
  const change = <K extends keyof AuthFormValue>(
    key: K,
    next: AuthFormValue[K],
  ) => onChange({ ...value, [key]: next })
  const titles = {
    login: "auth.loginTitle",
    register: "auth.registerTitle",
    "forgot-password": "auth.forgotTitle",
  } as const
  const descriptions = {
    login: "auth.loginDescription",
    register: "auth.registerDescription",
    "forgot-password": "auth.forgotDescription",
  } as const
  const submits = {
    login: "auth.loginSubmit",
    register: "auth.registerSubmit",
    "forgot-password": "auth.forgotSubmit",
  } as const
  const Icon =
    mode === "forgot-password"
      ? Mail
      : mode === "register"
        ? ShieldCheck
        : KeyRound
  return (
    <div className={styles.authForm} data-auth-mode={mode}>
      <div className={styles.symbol}>
        <Icon size={20} aria-hidden="true" />
      </div>
      <Heading className={styles.title}>{t(titles[mode])}</Heading>
      <p className={styles.description}>{t(descriptions[mode])}</p>
      <form
        ref={form}
        noValidate
        aria-label={t(titles[mode])}
        onSubmit={(event) => {
          event.preventDefault()
          if (!hydrated || locked || !onSubmit) return
          setAttempted(true)
          if (Object.keys(validate(mode, value)).length) {
            requestAnimationFrame(() =>
              form.current
                ?.querySelector<HTMLElement>('[aria-invalid="true"]')
                ?.focus(),
            )
            return
          }
          onSubmit({
            ...value,
            name: value.name.trim(),
            email: value.email.trim(),
          })
        }}
      >
        <fieldset disabled={!hydrated || locked} className={styles.fields}>
          {mode === "register" && (
            <Field
              label={t("auth.name")}
              required
              error={errors.name && t(errors.name)}
            >
              {(props) => (
                <Input
                  {...props}
                  name="name"
                  autoComplete="name"
                  maxLength={120}
                  value={value.name}
                  onChange={(event) => change("name", event.target.value)}
                  placeholder={t("auth.namePlaceholder")}
                />
              )}
            </Field>
          )}
          <Field
            label={t("auth.email")}
            required
            error={errors.email && t(errors.email)}
          >
            {(props) => (
              <Input
                {...props}
                type="email"
                name="email"
                autoComplete={mode === "forgot-password" ? "email" : "username"}
                maxLength={254}
                value={value.email}
                onChange={(event) => change("email", event.target.value)}
                placeholder="you@example.com"
              />
            )}
          </Field>
          {mode !== "forgot-password" && (
            <Field
              label={t("auth.password")}
              required
              error={errors.password && t(errors.password)}
              description={
                mode === "register" ? t("auth.passwordHint") : undefined
              }
            >
              {(props) => (
                <div className={styles.password}>
                  <Input
                    {...props}
                    type={visible ? "text" : "password"}
                    name="password"
                    autoComplete={
                      mode === "login" ? "current-password" : "new-password"
                    }
                    maxLength={256}
                    value={value.password}
                    onChange={(event) => change("password", event.target.value)}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t(
                      visible ? "auth.hidePassword" : "auth.showPassword",
                    )}
                    aria-pressed={visible}
                    onClick={() => setVisible(!visible)}
                  >
                    {visible ? <EyeOff /> : <Eye />}
                  </Button>
                </div>
              )}
            </Field>
          )}
          {mode === "register" && (
            <Field
              label={t("auth.confirmPassword")}
              required
              error={errors.confirmPassword && t(errors.confirmPassword)}
            >
              {(props) => (
                <div className={styles.password}>
                  <Input
                    {...props}
                    type={confirmVisible ? "text" : "password"}
                    name="confirmPassword"
                    autoComplete="new-password"
                    maxLength={256}
                    value={value.confirmPassword}
                    onChange={(event) =>
                      change("confirmPassword", event.target.value)
                    }
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t(
                      confirmVisible
                        ? "auth.hideConfirmPassword"
                        : "auth.showConfirmPassword",
                    )}
                    aria-pressed={confirmVisible}
                    onClick={() => setConfirmVisible(!confirmVisible)}
                  >
                    {confirmVisible ? <EyeOff /> : <Eye />}
                  </Button>
                </div>
              )}
            </Field>
          )}
          {mode === "login" && (
            <div className={styles.options}>
              <label className={styles.checkLabel}>
                <Checkbox
                  disabled={!hydrated || locked}
                  checked={value.remember}
                  onCheckedChange={(checked) => change("remember", checked)}
                />
                {t("auth.remember")}
              </label>
              {links?.["forgot-password"] && (
                <a className={styles.textLink} href={links["forgot-password"]}>
                  {t("auth.forgotLink")}
                </a>
              )}
            </div>
          )}
          {mode === "register" && (
            <div>
              <label className={styles.checkLabel}>
                <Checkbox
                  id={`${id}-terms`}
                  disabled={!hydrated || locked}
                  checked={value.acceptTerms}
                  onCheckedChange={(checked) => change("acceptTerms", checked)}
                  aria-invalid={errors.acceptTerms ? true : undefined}
                  aria-describedby={
                    errors.acceptTerms ? `${id}-terms-error` : undefined
                  }
                />
                {t("auth.acceptTerms")}
              </label>
              {terms && <div className={styles.terms}>{terms}</div>}
              {errors.acceptTerms && (
                <p id={`${id}-terms-error`} className={styles.fieldError}>
                  {t(errors.acceptTerms)}
                </p>
              )}
            </div>
          )}
          <Button
            type="submit"
            className={styles.submit}
            loading={busy}
            disabled={!hydrated || locked || !onSubmit}
          >
            {t(busy ? "auth.submitting" : submits[mode])}
            {!busy && <ArrowRight aria-hidden="true" />}
          </Button>
        </fieldset>
        <div className={styles.feedback} aria-live="polite">
          {!hydrated && <p className={styles.hint}>{t("auth.preparing")}</p>}
          {feedback.message && (
            <Alert
              urgent={feedback.state === "error"}
              tone={
                feedback.state === "error"
                  ? "error"
                  : feedback.state === "unknown"
                    ? "warning"
                    : feedback.state === "success"
                      ? "success"
                      : "info"
              }
            >
              {feedback.message}
              {feedback.actions}
            </Alert>
          )}
          {feedback.state === "unknown" && (
            <p className={styles.hint}>{t("auth.unknownHint")}</p>
          )}
          {!onSubmit && <p className={styles.hint}>{t("auth.noSubmit")}</p>}
        </div>
      </form>
      <div className={styles.alternate}>
        {mode === "login" && links?.register && (
          <>
            {t("auth.noAccount")}{" "}
            <a href={links.register} className={styles.textLink}>
              {t("auth.registerLink")}
            </a>
          </>
        )}
        {mode === "register" && links?.login && (
          <>
            {t("auth.hasAccount")}{" "}
            <a href={links.login} className={styles.textLink}>
              {t("auth.loginLink")}
            </a>
          </>
        )}
        {mode === "forgot-password" && links?.login && (
          <a href={links.login} className={styles.textLink}>
            {t("auth.backLogin")}
          </a>
        )}
      </div>
    </div>
  )
}

export type HttpErrorCode = 401 | 403 | 404 | 500 | 503
export type ErrorPageProps = {
  code: HttpErrorCode
  actions?: readonly AuthPageAction[]
  onRetry?: () => void
  retrying?: boolean
  feedback?: ReactNode
  requestId?: string
  detail?: ReactNode
  headingLevel?: "h1" | "h2"
  compact?: boolean
}
const errorIcons = {
  401: LockKeyhole,
  403: ShieldX,
  404: SearchX,
  500: ServerCrash,
  503: Wrench,
}
export function ErrorPage({
  code,
  actions = [],
  onRetry,
  retrying,
  feedback,
  requestId,
  detail,
  headingLevel: Heading = "h1",
  compact,
}: ErrorPageProps) {
  const { t } = useI18n()
  const Icon = errorIcons[code]
  return (
    <div
      className={cn(styles.errorPage, compact && styles.compact)}
      data-error-code={code}
    >
      <div className={styles.errorArt} aria-hidden="true">
        <span>{code}</span>
        <div className={styles.errorSymbol}>
          <Icon size={28} />
        </div>
      </div>
      <p className={styles.eyebrow}>HTTP {code}</p>
      <Heading className={styles.title}>{t(`auth.error${code}Title`)}</Heading>
      <p className={styles.errorDescription}>
        {t(`auth.error${code}Description`)}
      </p>
      {detail && <p className={styles.hint}>{detail}</p>}
      <div className={styles.errorActions}>
        {onRetry && (
          <Button onClick={onRetry} loading={retrying}>
            {t(retrying ? "auth.retrying" : "auth.retry")}
          </Button>
        )}
        {actions.map((action, index) => (
          <a
            key={action.href}
            href={action.href}
            className={buttonVariants({
              variant: !onRetry && index === 0 ? "primary" : "secondary",
            })}
          >
            {action.label}
          </a>
        ))}
      </div>
      {feedback && <Alert className={styles.retryFeedback}>{feedback}</Alert>}
      {requestId && (
        <p className={styles.requestId}>
          {t("auth.reference")} <code>{requestId}</code>
        </p>
      )}
    </div>
  )
}

export function AuthPageShell({
  children,
  toolbar,
  footer,
  variant = "auth",
  brand = "EasyuseUI",
  brandHref = "/",
}: {
  children: ReactNode
  toolbar?: ReactNode
  footer?: ReactNode
  variant?: "auth" | "error" | "gallery"
  brand?: string
  brandHref?: string
}) {
  const { t } = useI18n()
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <a className={styles.brand} href={brandHref}>
          <PanelsTopLeft size={22} aria-hidden="true" />
          {brand}
          <span className={styles.brandSection}>Auth & errors</span>
        </a>
        <div className={styles.toolbar}>{toolbar}</div>
      </header>
      <main
        id="main-content"
        className={cn(
          styles.main,
          variant === "auth" && styles.split,
          variant === "gallery" && styles.galleryMain,
        )}
      >
        {variant === "auth" && (
          <aside className={styles.story}>
            <div>
              <p className={styles.eyebrow}>{t("auth.shellEyebrow")}</p>
              <h2 className={styles.storyTitle}>{t("auth.shellTitle")}</h2>
              <p className={styles.storyDescription}>
                {t("auth.shellDescription")}
              </p>
              <div className={styles.storyDiagram} aria-hidden="true">
                <div>
                  <PanelsTopLeft size={28} />
                </div>
                <span />
                <div>
                  <Layers size={28} />
                </div>
                <span />
                <div>
                  <ShieldCheck size={28} />
                </div>
              </div>
            </div>
            <p className={styles.storyNote}>
              <ShieldCheck size={16} aria-hidden="true" />
              {t("auth.shellNote")}
            </p>
          </aside>
        )}
        <div
          className={cn(
            styles.content,
            variant === "gallery" && styles.galleryContent,
          )}
        >
          {children}
        </div>
      </main>
      <footer className={styles.footer}>
        <span>© {brand}</span>
        <div>{footer}</div>
      </footer>
    </div>
  )
}

export function AuthPageGallery({
  title,
  description,
  children,
  details,
  headingLevel: Heading = "h1",
}: {
  title: ReactNode
  description: ReactNode
  children: ReactNode
  details?: ReactNode
  headingLevel?: "h1" | "h2"
}) {
  return (
    <div className={styles.gallery}>
      <div className={styles.galleryHeading}>
        <p className={styles.eyebrow}>PAGE COLLECTION / 08</p>
        <Heading className={styles.galleryTitle}>{title}</Heading>
        <p className={styles.description}>{description}</p>
      </div>
      {details}
      <div className={styles.previewGrid}>{children}</div>
    </div>
  )
}
export function AuthPagePreview({
  title,
  href,
  children,
  controls,
}: {
  title: ReactNode
  href?: string
  children: ReactNode
  controls?: ReactNode
}) {
  const { t } = useI18n()
  return (
    <section className={styles.preview}>
      <header className={styles.previewHeader}>
        <h2>{title}</h2>
        {href && (
          <a className={styles.textLink} href={href}>
            {t("auth.openPage")}
            <ArrowRight size={14} aria-hidden="true" />
          </a>
        )}
      </header>
      {controls && <div className={styles.previewControls}>{controls}</div>}
      <div className={styles.previewBody}>{children}</div>
    </section>
  )
}
