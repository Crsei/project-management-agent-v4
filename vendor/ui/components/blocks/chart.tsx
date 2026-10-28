"use client"
import { useId } from "react"
import { useI18n } from "../../lib/i18n-provider"
import type { DataState } from "../../lib/runtime-status"
import { cn } from "../../lib/utils"
import { DataRegion, type RegionError } from "../ui/data-region"
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  TableCaption,
} from "../ui/table"
export type ChartDatum = {
  id: string
  label: string
  value: number | null
  missingReason?: "unknown" | "not-collected" | "permission" | "gap"
}
export type ChartProps = {
  label: string
  description?: string
  data: ChartDatum[]
  type?: "bar" | "line"
  state?: DataState
  error?: RegionError
  onRetry?: () => void
  className?: string
}
/** Dependency-free bounded chart with a matching, visible text table. */
export function Chart({
  label,
  description,
  data,
  type = "bar",
  state,
  error,
  onRetry,
  className,
}: ChartProps) {
  const { t, locale } = useI18n()
  const id = useId()
  const points = data.slice(-120).map((d) => ({
    ...d,
    value: d.value !== null && Number.isFinite(d.value) ? d.value : null,
  }))
  const values = points.flatMap((d) => (d.value === null ? [] : [d.value]))
  const lo = Math.min(0, ...values)
  const hi = Math.max(0, ...values)
  const unit = Math.max(1, ...values.map((v) => Math.abs(v)))
  const lower = lo / unit
  const span = hi / unit - lower || 1
  const y = (v: number) => 172 - ((v / unit - lower) / span) * 152
  const x = (i: number) => 32 + (i + 0.5) * (536 / Math.max(1, points.length))
  const baseline = y(0)
  const lines: string[] = []
  let segment: string[] = []
  for (const [i, p] of points.entries()) {
    if (p.value === null) {
      if (segment.length) lines.push(segment.join(" "))
      segment = []
    } else segment.push(`${segment.length ? "L" : "M"}${x(i)},${y(p.value)}`)
  }
  if (segment.length) lines.push(segment.join(" "))
  const effectiveState =
    state ??
    (!data.length
      ? "empty"
      : points.some((p) => p.value === null)
        ? "partial"
        : "success")
  return (
    <DataRegion
      state={effectiveState}
      hasContent={!!data.length}
      error={error}
      onRetry={onRetry}
    >
      <figure
        aria-labelledby={id}
        className={cn("grid min-w-0 gap-3", className)}
      >
        <figcaption id={id} className="text-sm font-medium">
          {label}
          {description && (
            <span className="mt-1 block text-xs font-normal text-muted-foreground">
              {description}
            </span>
          )}
        </figcaption>
        <svg
          aria-hidden="true"
          viewBox="0 0 600 200"
          className="w-full text-primary"
        >
          <line
            x1="24"
            x2="576"
            y1={baseline}
            y2={baseline}
            stroke="currentColor"
            opacity=".25"
          />
          {type === "bar" ? (
            points.map((p, i) =>
              p.value === null ? null : (
                <rect
                  key={`${p.id}-${i}`}
                  x={x(i) - Math.max(1, 400 / Math.max(1, points.length)) / 2}
                  width={Math.max(1, 400 / Math.max(1, points.length))}
                  y={Math.min(baseline, y(p.value))}
                  height={Math.max(1, Math.abs(baseline - y(p.value)))}
                  fill="currentColor"
                />
              ),
            )
          ) : (
            <>
              {lines.map((d, i) => (
                <path
                  key={i}
                  d={d}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                />
              ))}
              {points.map((p, i) =>
                p.value === null ? null : (
                  <circle
                    key={`${p.id}-${i}`}
                    cx={x(i)}
                    cy={y(p.value)}
                    r="2"
                    fill="currentColor"
                  />
                ),
              )}
            </>
          )}
        </svg>
        {data.length > 120 && (
          <p className="text-xs text-muted-foreground">
            {t("chart.bounded", { count: 120, total: data.length })}
          </p>
        )}
        <Table>
          <TableCaption>{t("chart.table", { label })}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{t("chart.label")}</TableHead>
              <TableHead scope="col">{t("chart.value")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {points.map((p, i) => (
              <TableRow key={`${p.id}-${i}`}>
                <TableCell>{p.label}</TableCell>
                <TableCell>
                  {p.value === null
                    ? t(
                        p.missingReason === "unknown"
                          ? "chart.unknown"
                          : p.missingReason === "not-collected"
                            ? "chart.notCollected"
                            : p.missingReason === "permission"
                              ? "chart.noPermission"
                              : "chart.missing",
                      )
                    : new Intl.NumberFormat(locale, {
                        maximumFractionDigits: 4,
                      }).format(p.value)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </figure>
    </DataRegion>
  )
}
