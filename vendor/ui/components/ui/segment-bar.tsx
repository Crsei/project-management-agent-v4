"use client"
import { useI18n } from "../../lib/i18n-provider"
export type SegmentBarProps = {
  label: string
  value?: number | null
  min?: number
  max?: number
  segments?: number
  valueText?: string
  color?: string
  className?: string
}
export function SegmentBar({
  label,
  value,
  min = 0,
  max = 100,
  segments = 10,
  valueText,
  color = "var(--primary)",
  className,
}: SegmentBarProps) {
  const { t, number } = useI18n()
  const valid =
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isFinite(min) &&
    Number.isFinite(max) &&
    max > min
  const current = valid ? Math.max(min, Math.min(max, value)) : undefined
  const count = Number.isFinite(segments)
    ? Math.max(1, Math.min(50, Math.round(segments)))
    : 10
  const ratio = current === undefined ? 0 : (current - min) / (max - min)
  const text =
    valueText ??
    (current === undefined ? t("commonComponents.unknown") : number(current))
  return (
    <div
      className={className}
      role={valid ? "meter" : "img"}
      aria-label={valid ? label : `${label}: ${text}`}
      aria-valuemin={valid ? min : undefined}
      aria-valuemax={valid ? max : undefined}
      aria-valuenow={current}
      aria-valuetext={valid ? text : undefined}
    >
      <div aria-hidden="true" className="flex min-w-20 gap-1">
        {Array.from({ length: count }, (_, index) => (
          <span
            key={index}
            className="h-2 flex-1 overflow-hidden rounded-sm bg-muted"
          >
            <span
              className="block h-full"
              style={{
                background: color,
                width: `${Math.max(0, Math.min(1, ratio * count - index)) * 100}%`,
              }}
            />
          </span>
        ))}
      </div>
      <span className="mt-1 block text-xs text-muted-foreground tabular-nums">
        {text}
      </span>
    </div>
  )
}
