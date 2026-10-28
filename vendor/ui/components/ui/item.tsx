"use client"
import { useI18n } from "../../lib/i18n-provider"

import { useId, type ReactNode } from "react"
import { cn } from "../../lib/utils"
import styles from "./item.module.css"
export type ItemProps = {
  title: ReactNode
  description?: ReactNode
  leading?: ReactNode
  trailing?: ReactNode
  density?: "compact" | "default"
  selected?: boolean
  disabled?: boolean
  loading?: boolean
  error?: string
  onSelect?: () => void
  className?: string
  ariaLabel?: string
}
export function Item({
  title,
  description,
  leading,
  trailing,
  density = "default",
  selected,
  disabled = false,
  loading = false,
  error,
  onSelect,
  className,
  ariaLabel,
}: ItemProps) {
  const { t } = useI18n()

  const errorId = useId()
  const content = (
    <>
      {leading && <span className={styles.leading}>{leading}</span>}
      <span className={styles.content}>
        <span className={styles.title}>{title}</span>
        {description && (
          <span className={styles.description}>{description}</span>
        )}
      </span>
    </>
  )
  return (
    <div
      className={cn(styles.item, className)}
      data-density={density}
      data-double={Boolean(description)}
      data-interactive={Boolean(onSelect)}
      data-selected={Boolean(onSelect && selected)}
      data-disabled={disabled || loading}
      data-loading={loading}
      data-error={Boolean(error)}
      aria-busy={loading || undefined}
    >
      {onSelect ? (
        <button
          type="button"
          className={styles.main}
          onClick={onSelect}
          disabled={disabled || loading}
          aria-describedby={error ? errorId : undefined}
          aria-pressed={selected}
          aria-label={ariaLabel}
        >
          {content}
        </button>
      ) : (
        <div className={styles.main}>{content}</div>
      )}
      {(trailing || error) && (
        <div className={styles.trailing}>
          {trailing}
          {error && (
            <details className={styles.error}>
              <summary>{t("item.viewError")}</summary>
              <p id={errorId} role="alert">
                {error}
              </p>
            </details>
          )}
        </div>
      )}
    </div>
  )
}
