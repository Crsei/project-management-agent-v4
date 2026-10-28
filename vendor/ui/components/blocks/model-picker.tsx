"use client"

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

export type ModelPickerProps = {
  models: readonly WorkbenchChoice[]
  value: string
  onChange: (id: string) => void
  disabled?: boolean
  className?: string
}

export type ModelBadgeProps = {
  models: readonly WorkbenchChoice[]
  value: string
  className?: string
}

const labelClass =
  "inline-flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-[13px] leading-5 text-text-secondary"

const triggerClass = "flex min-w-0 items-center gap-1.5"

const optionClass = "items-start gap-2 py-1.5 data-selected:bg-selection"

/** Shared name + version + reason markup for badge, readonly picker and trigger. */
function ModelLabel({
  model,
  reason,
  className,
}: {
  model?: WorkbenchChoice
  reason?: string
  className?: string
}) {
  return (
    <span className={cn(labelClass, className)}>
      <span
        className={cn(
          "min-w-0 truncate font-medium",
          model ? "text-foreground" : "text-text-muted",
        )}
      >
        {model?.label ?? "—"}
      </span>
      {model?.version && (
        <span className="shrink-0 text-xs leading-4 text-text-muted">
          {model.version}
        </span>
      )}
      {reason && (
        <span className="text-xs leading-4 text-text-muted">{reason}</span>
      )}
    </span>
  )
}

/** Read-only model name plus version; never renders a button. */
export function ModelBadge({ models, value, className }: ModelBadgeProps) {
  const active = models.find((model) => model.id === value)
  return (
    <ModelLabel
      model={active}
      reason={active?.disabledReason}
      className={className}
    />
  )
}

/**
 * Single-choice model selector. With one model, or while disabled, it renders a
 * plain label instead of an entry that could not change anything; a disabled
 * reason stays visible either way.
 */
export function ModelPicker({
  models,
  value,
  onChange,
  disabled = false,
  className,
}: ModelPickerProps) {
  const { t } = useI18n()
  const active = models.find((model) => model.id === value)
  const readonly = disabled || models.length <= 1

  if (readonly) {
    const reason =
      active?.disabledReason ??
      (disabled ? t("agentElements.modelUnavailable") : undefined)
    return <ModelLabel model={active} reason={reason} className={className} />
  }

  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (next) onChange(next)
      }}
    >
      <SelectTrigger
        aria-label={t("agentElements.selectModel")}
        className={cn(triggerClass, className)}
      >
        <SelectValue className="flex min-w-0 flex-1">
          {(current) => (
            <ModelLabel
              model={models.find((entry) => entry.id === current)}
              className="flex-nowrap"
            />
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent className="min-w-56">
        {models.map((model) => (
          <SelectItem
            key={model.id}
            value={model.id}
            disabled={Boolean(model.disabledReason)}
            className={optionClass}
          >
            <SelectItemText className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex min-w-0 items-baseline gap-1 text-[13px] font-medium leading-5">
                <span className="truncate">{model.label}</span>
                {model.version && (
                  <span className="shrink-0 text-xs font-normal text-text-muted">
                    {model.version}
                  </span>
                )}
              </span>
              {model.disabledReason && (
                <span className="text-xs leading-4 text-text-muted">
                  {model.disabledReason}
                </span>
              )}
            </SelectItemText>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
