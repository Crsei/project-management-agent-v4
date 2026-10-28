"use client"

import { useId, type ReactNode } from "react"
import { ButtonTooltip } from "../ui/button-tooltip"
import { cn } from "../../lib/utils"
import { useI18n } from "../../lib/i18n-provider"

export type SuggestionItem = {
  id: string
  label: string
  prompt: string
  icon?: ReactNode
  disabled?: boolean
  disabledReason?: string
}

export type SuggestionsProps = {
  items: readonly SuggestionItem[]
  onSelect: (item: SuggestionItem) => void
  disabled?: boolean
  className?: string
}

const chipClass =
  "inline-flex h-control items-center gap-1.5 rounded-control border border-border bg-surface px-3 text-[13px] font-medium leading-5 text-text-secondary outline-none transition-colors duration-[var(--motion-hover)] ease-out hover:border-border-hover hover:bg-surface-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:cursor-not-allowed disabled:border-border disabled:bg-surface disabled:text-text-muted disabled:opacity-70 motion-reduce:transition-none"

/**
 * Suggestion chips only report the chosen prompt to the host. Refilling the
 * draft, moving the caret and sending stay with the composer, so selecting a
 * chip here never submits anything.
 */
export function Suggestions({
  items,
  onSelect,
  disabled = false,
  className,
}: SuggestionsProps) {
  const { t } = useI18n()
  const baseId = useId()
  if (items.length === 0) return null
  return (
    <ul
      role="list"
      aria-label={t("agentElements.suggestions")}
      className={cn("flex flex-wrap items-center gap-2", className)}
    >
      {items.map((item) => {
        const blocked = disabled || Boolean(item.disabled)
        const reason = item.disabledReason ?? t("workbench.unavailable")
        const reasonId = `${baseId}-suggestion-${item.id}`
        const control = (
          <button
            type="button"
            disabled={blocked}
            aria-describedby={blocked ? reasonId : undefined}
            aria-label={t("agentElements.useSuggestion", { label: item.label })}
            className={chipClass}
            onClick={() => onSelect(item)}
          >
            {item.icon && (
              <span aria-hidden="true" className="shrink-0 [&_svg]:size-4">
                {item.icon}
              </span>
            )}
            <span className="min-w-0 truncate">{item.label}</span>
          </button>
        )
        return (
          <li key={item.id}>
            {blocked && (
              <span id={reasonId} className="sr-only">
                {reason}
              </span>
            )}
            {blocked ? (
              <ButtonTooltip label={reason}>
                <span className="inline-flex">{control}</span>
              </ButtonTooltip>
            ) : (
              control
            )}
          </li>
        )
      })}
    </ul>
  )
}
