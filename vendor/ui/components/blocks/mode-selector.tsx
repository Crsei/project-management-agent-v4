"use client"

import { Check } from "lucide-react"
import { cn } from "../../lib/utils"
import { useI18n } from "../../lib/i18n-provider"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectItemText,
  SelectTrigger,
  SelectValue,
} from "../ui/select"
import type { WorkbenchChoice } from "../../lib/agent-workbench-model"

export type ModeSelectorProps = {
  modes: readonly WorkbenchChoice[]
  value: string
  onChange: (id: string) => void
  disabled?: boolean
  className?: string
}

const triggerClass = "flex min-w-0 items-center gap-1.5"

const optionClass = "items-start gap-2 py-1.5 data-selected:bg-selection"

/**
 * Host-provided behavior options, kept apart from delivery and permission
 * choices. The library never supplies provider or mode names itself.
 */
export function ModeSelector({
  modes,
  value,
  onChange,
  disabled = false,
  className,
}: ModeSelectorProps) {
  const { t } = useI18n()
  if (modes.length === 0) return null
  const available = modes.filter((mode) => !mode.disabledReason)
  const readonly = disabled || available.length <= 1

  if (readonly) {
    return (
      <div
        role="group"
        aria-label={t("agentElements.behaviorMode")}
        aria-disabled={disabled || undefined}
        className={cn("flex flex-col gap-1", className)}
      >
        {modes.map((mode) => {
          const selected = mode.id === value
          return (
            <div
              key={mode.id}
              aria-current={selected || undefined}
              data-selected={selected || undefined}
              className="flex items-start gap-1.5 rounded-control px-2 py-1.5 data-selected:bg-selection"
            >
              <span
                aria-hidden="true"
                className="mt-0.5 flex size-4 shrink-0 items-center justify-center"
              >
                {selected && (
                  <Check aria-hidden="true" size={14} strokeWidth={2.75} />
                )}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span
                  className={cn(
                    "text-[13px] font-medium leading-5",
                    mode.disabledReason
                      ? "text-text-muted"
                      : selected
                        ? "text-foreground"
                        : "text-text-secondary",
                  )}
                >
                  {mode.label}
                </span>
                {mode.description && (
                  <span className="text-xs leading-4 text-text-muted">
                    {mode.description}
                  </span>
                )}
                {mode.disabledReason && (
                  <span className="text-xs leading-4 text-text-muted">
                    {mode.disabledReason}
                  </span>
                )}
              </span>
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (next) onChange(next)
      }}
    >
      <SelectTrigger
        aria-label={t("agentElements.behaviorMode")}
        className={cn(triggerClass, className)}
      >
        <SelectValue className="min-w-0 flex-1 truncate">
          {(current) => modes.find((mode) => mode.id === current)?.label ?? "—"}
        </SelectValue>
      </SelectTrigger>
      <SelectContent className="min-w-64">
        {modes.map((mode) => (
          <SelectItem
            key={mode.id}
            value={mode.id}
            disabled={Boolean(mode.disabledReason)}
            className={optionClass}
          >
            <SelectItemText className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span
                className={cn(
                  "text-[13px] font-medium leading-5",
                  mode.disabledReason
                    ? "text-text-muted"
                    : mode.id === value
                      ? "text-foreground"
                      : "text-text-secondary",
                )}
              >
                {mode.label}
              </span>
              {mode.description && (
                <span className="text-xs leading-4 text-text-muted">
                  {mode.description}
                </span>
              )}
              {mode.disabledReason && (
                <span className="text-xs leading-4 text-text-muted">
                  {mode.disabledReason}
                </span>
              )}
            </SelectItemText>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
