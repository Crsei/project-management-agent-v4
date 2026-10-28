"use client"
import { useId } from "react"
import { useI18n } from "../../lib/i18n-provider"
export type SparklineProps = {
  label: string
  values: readonly (number | null | undefined)[]
  summary?: string
  color?: string | ((value: number, index: number) => string)
  className?: string
}
export function Sparkline({
  label,
  values,
  summary,
  color = "var(--primary)",
  className,
}: SparklineProps) {
  const id = useId()
  const { t, number } = useI18n()
  const points = values.slice(-120)
  const finite = points.filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v),
  )
  const low = Math.min(0, ...finite),
    high = Math.max(0, ...finite),
    range = high - low || 1
  const y = (v: number) => 28 - ((v - low) / range) * 24
  const text =
    summary ??
    (finite.length
      ? points
          .map((v) =>
            typeof v === "number" && Number.isFinite(v)
              ? number(v)
              : t("commonComponents.unknown"),
          )
          .join(", ")
      : t("commonComponents.noValues"))
  const width = Math.max(1, points.length) * 8
  return (
    <svg
      role="img"
      aria-labelledby={`${id}-title ${id}-description`}
      viewBox={`0 0 ${width} 32`}
      className={className}
      width={Math.max(64, Math.min(160, width))}
      height={32}
    >
      <title id={`${id}-title`}>{label}</title>
      <desc id={`${id}-description`}>{text}</desc>
      <line x1={0} x2={width} y1={y(0)} y2={y(0)} stroke="var(--border)" />
      {points.map((v, index) =>
        typeof v === "number" && Number.isFinite(v) ? (
          <rect
            key={index}
            x={index * 8 + 1}
            y={v >= 0 ? y(v) - (v === 0 ? 1 : 0) : y(0)}
            width={6}
            height={Math.max(2, Math.abs(y(v) - y(0)))}
            rx={1}
            fill={
              typeof color === "function"
                ? color(v, index + values.length - points.length)
                : color
            }
          />
        ) : null,
      )}
    </svg>
  )
}
