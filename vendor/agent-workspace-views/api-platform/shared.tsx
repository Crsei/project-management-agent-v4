"use client"
import {
  useLayoutEffect,
  useRef,
  type ReactNode,
  type CSSProperties,
} from "react"
import { Search } from "lucide-react"
import { Avatar } from "@easyuse-ui/ui/components/ui/avatar"
import { Badge } from "@easyuse-ui/ui/components/ui/badge"
import { Input } from "@easyuse-ui/ui/components/ui/input"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@easyuse-ui/ui/components/ui/select"
import { useI18n } from "@easyuse-ui/ui/lib/i18n-provider"
import { useApCache } from "./state"
import {
  formatApPrice,
  modalityCopy,
  type ApModel,
  type ApPrice,
  type ApTokenPriceUnit,
} from "./model"
import styles from "./shared.module.css"
export function ApPage({
  pageId,
  title,
  description,
  actions,
  toolbar,
  children,
  variant = "compact",
  contentWidth,
}: {
  pageId: string
  title: string
  description: string
  actions?: ReactNode
  toolbar?: ReactNode
  children: ReactNode
  variant?: "compact" | "reference" | "analytics" | "full-width"
  contentWidth?: number
}) {
  const cache = useApCache(),
    body = useRef<HTMLDivElement>(null)
  const reference = variant !== "compact"
  const saveReadingPosition = (event: { currentTarget: HTMLElement }) =>
    cache?.set("reading-position", event.currentTarget.scrollTop)
  useLayoutEffect(() => {
    if (body.current)
      body.current.scrollTop = Number(cache?.get("reading-position") ?? 0)
  }, [cache, variant])
  return (
    <main
      ref={reference ? body : undefined}
      className={`${styles.page} ${reference ? styles.reference : ""} ${variant === "analytics" ? styles.analytics : ""} ${variant === "full-width" ? styles.fullWidth : ""}`}
      data-ap-page={pageId}
      data-ap-variant={variant}
      data-ap-scroll={reference ? true : undefined}
      onScroll={reference ? saveReadingPosition : undefined}
    >
      <div
        className={styles.canvas}
        style={
          contentWidth === undefined
            ? undefined
            : ({ "--ap-content-width": `${contentWidth}px` } as CSSProperties)
        }
      >
        <header className={styles.header} data-ap-header>
          <div className="min-w-0 flex-1">
            <h1 title={title}>{title}</h1>
            <p>{description}</p>
          </div>
          {actions}
        </header>
        {toolbar && (
          <div className={styles.toolbar} data-ap-toolbar>
            {toolbar}
          </div>
        )}
        <div
          ref={reference ? undefined : body}
          className={styles.body}
          data-ap-scroll={reference ? undefined : true}
          onScroll={reference ? undefined : saveReadingPosition}
        >
          {children}
        </div>
      </div>
    </main>
  )
}
export function ApSelect({
  label,
  value,
  onChange,
  options,
  disabled = false,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: readonly { value: string; label: string }[]
  disabled?: boolean
}) {
  return (
    <Select
      value={value}
      onValueChange={(v) => {
        if (v !== null) onChange(v)
      }}
      disabled={disabled}
      items={options}
    >
      <SelectTrigger
        aria-label={label}
        className="inline-flex min-w-32 items-center justify-between gap-2"
      >
        <SelectValue />
        <span aria-hidden="true">⌄</span>
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
export function ApSearch({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
}) {
  return (
    <div className="relative w-64">
      <Search
        className="pointer-events-none absolute left-2 top-2 size-4 text-muted-foreground"
        aria-hidden="true"
      />
      <Input
        type="search"
        className="pl-8"
        aria-label={label}
        placeholder={placeholder ?? label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  )
}
export function ApModelIdentity({
  model,
  detail = false,
}: {
  model: ApModel
  detail?: boolean
}) {
  const { locale } = useI18n()
  return (
    <span
      className={`${styles.identity} ${detail ? styles.identityDetail : ""}`}
      data-ap-model={model.modelId}
    >
      <Avatar name={model.provider} size={24} />
      <span className="min-w-0">
        <span className={styles.name} title={model.name}>
          {model.name}
        </span>
        <span className="block text-xs text-muted-foreground">
          {model.provider} · {modalityCopy[model.modality][locale]}
        </span>
      </span>
      {model.status === "unavailable" && (
        <Badge tone="warning">
          {locale === "en" ? "Unavailable" : "不可用"}
        </Badge>
      )}
    </span>
  )
}
export function ApPriceText({
  price,
  tokenUnit,
}: {
  price: ApPrice
  tokenUnit?: ApTokenPriceUnit
}) {
  const { locale } = useI18n()
  return (
    <span
      className="whitespace-nowrap text-xs tabular-nums"
      data-ap-price={price.kind}
    >
      {formatApPrice(price, locale, tokenUnit)}
    </span>
  )
}
