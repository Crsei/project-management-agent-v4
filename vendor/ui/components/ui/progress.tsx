"use client"
import type { ComponentProps } from "react"
import { Progress as Base } from "@base-ui/react/progress"
import { useI18n } from "../../lib/i18n-provider"
import { cn } from "../../lib/utils"
export type ProgressProps = Omit<Base.Root.Props, "className"> & {
  className?: string
  label?: string
}
export function Progress({
  value,
  min = 0,
  max = 100,
  label,
  className,
  locale: providedLocale,
  ...props
}: ProgressProps) {
  const { locale } = useI18n()
  const lo = Number.isFinite(min) ? min : 0
  const hi = Number.isFinite(max) && max > lo ? max : lo + 100
  const current =
    value !== null && Number.isFinite(value)
      ? Math.max(lo, Math.min(hi, value))
      : null
  return (
    <Base.Root
      {...props}
      min={lo}
      max={hi}
      value={current}
      locale={providedLocale ?? locale}
      className={cn("grid gap-2", className)}
    >
      {label && <Base.Label className="text-xs">{label}</Base.Label>}
      <Base.Track className="h-1.5 overflow-hidden rounded-full bg-surface-raised">
        <Base.Indicator
          className={cn(
            "h-full rounded-full bg-primary",
            current === null && "w-1/3",
          )}
        />
      </Base.Track>
    </Base.Root>
  )
}
/** A measurement is a meter, not task completion. */
export function Meter({ className, ...props }: ComponentProps<"meter">) {
  return (
    <meter {...props} className={cn("h-2 w-full accent-primary", className)} />
  )
}
