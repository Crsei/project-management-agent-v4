"use client"
import { useI18n } from "../../lib/i18n-provider"

import { useId } from "react"
import { Check, X } from "lucide-react"
import { cn } from "../../lib/utils"
import { Button } from "./button"
import styles from "./chip.module.css"

export type ChipProps = {
  label: string
  selected?: boolean
  disabled?: boolean
  busy?: boolean
  onSelectedChange?: (selected: boolean) => void
  onRemove?: () => void
  removeLabel?: string
  className?: string
}

/** Controlled value: selection and removal are sibling targets. */
export function Chip({
  label,
  selected = false,
  disabled = false,
  busy = false,
  onSelectedChange,
  onRemove,
  removeLabel: providedRemoveLabel,
  className,
}: ChipProps) {
  const { t } = useI18n()
  const removeLabel =
    providedRemoveLabel ?? t("common.removeValue", { value0: label })

  const id = useId()
  const unavailable = disabled || busy
  return (
    <span
      className={cn(styles.chip, className)}
      data-selected={selected}
      data-disabled={disabled}
      aria-busy={busy || undefined}
      role={onSelectedChange && onRemove ? "group" : undefined}
      aria-label={onSelectedChange && onRemove ? label : undefined}
    >
      {onSelectedChange ? (
        <button
          type="button"
          className={styles.main}
          aria-pressed={selected}
          aria-describedby={busy ? id : undefined}
          disabled={unavailable}
          onClick={() => onSelectedChange(!selected)}
        >
          {selected && (
            <Check
              aria-hidden="true"
              size={12}
              strokeWidth={2.625}
              className="shrink-0"
            />
          )}
          {label}
        </button>
      ) : (
        <span className={styles.label}>{label}</span>
      )}
      {onRemove && (
        <Button
          size="icon"
          variant="ghost"
          className={styles.remove}
          aria-label={removeLabel}
          aria-describedby={busy ? id : undefined}
          disabled={unavailable}
          onClick={onRemove}
        >
          <X
            aria-hidden="true"
            size={12}
            strokeWidth={2.625}
            className="size-3! stroke-[2.625]!"
          />
        </Button>
      )}
      {busy && (
        <span id={id} className={styles.busyHint}>
          {t("chip.processing")}
        </span>
      )}
    </span>
  )
}
