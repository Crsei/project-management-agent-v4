"use client"
import { Star } from "lucide-react"
import { useI18n } from "../../lib/i18n-provider"
export type RatingDisplayProps = {
  label: string
  value?: number | null
  max?: number
  className?: string
}
export function RatingDisplay({
  label,
  value,
  max = 5,
  className,
}: RatingDisplayProps) {
  const { t, number } = useI18n()
  const count = Number.isFinite(max)
    ? Math.max(1, Math.min(10, Math.round(max)))
    : 5
  const rating =
    typeof value === "number" && Number.isFinite(value)
      ? Math.round(Math.max(0, Math.min(count, value)) * 2) / 2
      : null
  return (
    <span
      role="img"
      aria-label={`${label}: ${rating === null ? t("commonComponents.unknown") : t("commonComponents.rating", { value: number(rating), max: count })}`}
      className={className}
    >
      <span aria-hidden="true" className="inline-flex items-center gap-1">
        {Array.from({ length: count }, (_, index) => (
          <span key={index} className="relative size-4 text-muted-foreground">
            <Star size={16} />
            <span
              className="absolute inset-0 overflow-hidden text-primary"
              style={{
                width: `${rating === null ? 0 : Math.min(1, Math.max(0, rating - index)) * 100}%`,
              }}
            >
              <Star size={16} fill="currentColor" />
            </span>
          </span>
        ))}
        <span className="ml-1 text-xs tabular-nums">
          {rating === null ? "—" : `${number(rating)}/${count}`}
        </span>
      </span>
    </span>
  )
}
