import type { ComponentProps } from "react"
import * as ProgressPrimitive from "@radix-ui/react-progress"
import { cn } from "../lib/utils"
export type ProgressProps = Omit<
  React.ComponentProps<typeof ProgressPrimitive.Root>,
  "className"
> & {
  className?: string
  label?: string
  /** Base UI clamped from `min`; Radix always starts at 0, so it is accepted. */
  min?: number
  /** Base UI formatted the label; Radix has no such prop, so it is dropped. */
  locale?: string
}
export function Progress({
  value,
  min = 0,
  max = 100,
  label,
  className,
  locale: _providedLocale,
  ...props
}: ProgressProps) {
  void _providedLocale
  const lo = Number.isFinite(min) ? min : 0
  const hi = Number.isFinite(max) && max > lo ? max : lo + 100
  const current =
    value !== null && value !== undefined && Number.isFinite(value)
      ? Math.max(lo, Math.min(hi, value))
      : null
  // Radix Progress starts at 0, so a non-zero `min` shifts the ratio instead.
  const ratio =
    current === null
      ? null
      : ((current - lo) / (hi - lo || 1)) * 100
  return (
    <ProgressPrimitive.Root
      {...props}
      max={hi}
      value={ratio === null ? undefined : ratio}
      className={cn("grid gap-2", className)}
    >
      {label && (
        <span className="text-xs" aria-hidden="true">
          {label}
        </span>
      )}
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-raised">
        <ProgressPrimitive.ProgressIndicator
          className={cn(
            "h-full rounded-full bg-primary",
            current === null && "w-1/3",
          )}
        />
      </div>
    </ProgressPrimitive.Root>
  )
}
/** A measurement is a meter, not task completion. */
export function Meter({ className, ...props }: ComponentProps<"meter">) {
  return (
    <meter {...props} className={cn("h-2 w-full accent-primary", className)} />
  )
}
