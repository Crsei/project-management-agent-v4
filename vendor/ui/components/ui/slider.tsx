"use client"
import { Slider as Base } from "@base-ui/react/slider"
export type SliderProps = {
  label: string
  value?: number
  defaultValue?: number
  onChange?: (value: number) => void
  onCommit?: (value: number) => void
  min?: number
  max?: number
  step?: number
  disabled?: boolean
  name?: string
  valueText?: (value: number) => string
  className?: string
  id?: string
  "aria-describedby"?: string
}
export function Slider({
  label,
  value,
  defaultValue,
  min: providedMin = 0,
  max: providedMax = 100,
  step = 1,
  onChange,
  onCommit,
  disabled,
  name,
  valueText,
  className,
  id,
  "aria-describedby": described,
}: SliderProps) {
  const min = Number.isFinite(providedMin) ? providedMin : 0
  const max =
    Number.isFinite(providedMax) && providedMax > min ? providedMax : min + 100
  const bound = (v: number) =>
    Math.max(min, Math.min(max, Number.isFinite(v) ? v : min))
  return (
    <Base.Root<number>
      value={value === undefined ? undefined : bound(value)}
      defaultValue={bound(defaultValue ?? min)}
      onValueChange={(v) => onChange?.(v)}
      onValueCommitted={(v) => onCommit?.(v)}
      min={min}
      max={max}
      step={Number.isFinite(step) && step > 0 ? step : 1}
      disabled={disabled}
      name={name}
      className={className}
    >
      <Base.Control className="flex min-h-8 w-full min-w-24 touch-none items-center px-2 data-disabled:opacity-50 [@media(pointer:coarse)]:min-h-11">
        <Base.Track className="relative h-1 w-full rounded-full bg-muted">
          <Base.Indicator className="rounded-full bg-primary" />
          <Base.Thumb
            id={id}
            aria-label={label}
            aria-describedby={described}
            getAriaValueText={
              valueText ? (_formatted, v) => valueText(v) : undefined
            }
            className="size-4 rounded-full border border-primary bg-background outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:size-11"
          />
        </Base.Track>
      </Base.Control>
    </Base.Root>
  )
}
