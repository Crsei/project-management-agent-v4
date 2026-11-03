import type { ReactNode } from "react"
import { Link } from "react-router"
import {
  LockKeyhole,
  SearchX,
  ServerCrash,
  ShieldX,
  Wrench,
} from "lucide-react"
import { DovspaceWordmark } from "@/components/dovspace-brand"
import { Alert } from "@/components/ui/alert"
import { Button, buttonVariants } from "@/components/ui/button"
import { useI18n } from "@/lib/i18n-provider"
import { cn } from "@/lib/utils"

export const httpErrorCodes = [401, 403, 404, 500, 503] as const
export type HttpErrorCode = (typeof httpErrorCodes)[number]

export function isHttpErrorCode(value: number): value is HttpErrorCode {
  return (httpErrorCodes as readonly number[]).includes(value)
}

export type ErrorPageAction = {
  label: ReactNode
  to: string
}

export type ErrorPageProps = {
  code: HttpErrorCode
  actions?: readonly ErrorPageAction[]
  onRetry?: () => void
  retrying?: boolean
  feedback?: ReactNode
  requestId?: string
  detail?: ReactNode
  headingLevel?: "h1" | "h2"
  compact?: boolean
  className?: string
}

const errorIcons = {
  401: LockKeyhole,
  403: ShieldX,
  404: SearchX,
  500: ServerCrash,
  503: Wrench,
} satisfies Record<HttpErrorCode, typeof LockKeyhole>

/**
 * HTTP error surface ported from the EasyuseUI auth-pages block. It renders
 * only caller-provided state: no permission, retry or success is inferred.
 */
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
  className,
}: ErrorPageProps) {
  const { t } = useI18n()
  const Icon = errorIcons[code]
  const titleKey = `auth.error${code}Title` as const
  const descriptionKey = `auth.error${code}Description` as const
  return (
    <div
      data-error-code={code}
      className={cn("w-full max-w-[480px] text-center", className)}
    >
      <div aria-hidden="true" className="relative mx-auto w-fit pb-8">
        <span className="block text-[96px] leading-none font-semibold tracking-[-0.06em] text-muted-foreground tabular-nums">
          {code}
        </span>
        <div
          className={cn(
            "absolute bottom-4 left-1/2 grid size-14 -translate-x-1/2 place-items-center rounded-xl border bg-background",
            compact && "size-12",
          )}
        >
          <Icon size={28} />
        </div>
      </div>
      <p className="mb-2 text-xs leading-5 tracking-[0.06em] text-muted-foreground">
        HTTP {code}
      </p>
      <Heading
        className={cn(
          "m-0 text-2xl leading-8 font-semibold tracking-[-0.02em] text-balance",
          compact && "text-xl leading-7",
        )}
      >
        {t(titleKey)}
      </Heading>
      <p className="mt-3 text-sm leading-6 text-muted-foreground text-pretty">
        {t(descriptionKey)}
      </p>
      {detail && (
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {detail}
        </p>
      )}
      {(onRetry || actions.length > 0) && (
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          {onRetry && (
            <Button onClick={onRetry} loading={retrying}>
              {t(retrying ? "auth.retrying" : "auth.retry")}
            </Button>
          )}
          {actions.map((action, index) => (
            <Link
              key={action.to}
              to={action.to}
              className={buttonVariants({
                variant: !onRetry && index === 0 ? "primary" : "secondary",
              })}
            >
              {action.label}
            </Link>
          ))}
        </div>
      )}
      {feedback && (
        <Alert tone="error" className="mt-6 text-left">
          {feedback}
        </Alert>
      )}
      {requestId && (
        <p className="mt-8 text-xs leading-5 text-muted-foreground break-words">
          {t("auth.reference")} <code className="text-[11px]">{requestId}</code>
        </p>
      )}
    </div>
  )
}

export type ErrorPageScreenProps = Omit<ErrorPageProps, "code"> & {
  code: HttpErrorCode
  toolbar?: ReactNode
}

/**
 * Full-window wrapper for the standalone error routes and for failures that
 * replace the product shell. Actions default to the application entry point.
 */
export function ErrorPageScreen({
  code,
  actions,
  toolbar,
  ...props
}: ErrorPageScreenProps) {
  const { t } = useI18n()
  const resolvedActions = actions ?? [
    {
      to: "/pm",
      label: code === 401 ? t("auth.backLogin") : t("auth.errorBackHome"),
    },
  ]
  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <header className="flex min-h-16 items-center justify-between gap-4 border-b px-8 py-4 max-sm:px-4">
        <Link
          to="/pm"
          className="inline-flex items-center gap-2 text-base font-semibold focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
        >
          <DovspaceWordmark />
        </Link>
        {toolbar}
      </header>
      <main
        id="main-content"
        className="flex flex-1 items-center justify-center px-8 py-12 max-sm:px-4"
      >
        <ErrorPage code={code} actions={resolvedActions} {...props} />
      </main>
      <footer className="flex min-h-12 items-center border-t px-8 py-3 text-xs leading-5 text-muted-foreground max-sm:px-4">
        <span>© Dovspace</span>
      </footer>
    </div>
  )
}
