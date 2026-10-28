"use client"
import { useId, type ReactNode } from "react"
import { Button } from "./button"
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "./popover"
import { DataRegion, type DataRegionProps } from "./data-region"
import { componentMessages } from "../../lib/i18n-messages"
import type { MessageKey } from "../../lib/i18n-core"
import { useI18n } from "../../lib/i18n-provider"
import type {
  AnalyticsQuery,
  AnalyticsResult,
  AnalyticsSeries,
} from "../../lib/analytics-model"
import { chartSeriesColor, type ChartDatum } from "../../lib/chart-model"
import { formatChartValue } from "../../lib/chart-format"
import { analyticsQueryKey } from "../../lib/analytics-query"
import styles from "./chart.module.css"

export type ChartFrameProps = {
  title: ReactNode
  description: ReactNode
  query: AnalyticsQuery
  result?: AnalyticsResult | null
  access?: "allowed" | "denied"
  data?: Omit<DataRegionProps, "children" | "hasContent">
  actions?: ReactNode
  presentation?: "standalone" | "embedded"
  /** Additional controls and explanations inside the embedded details disclosure. */
  details?: ReactNode
  children: ReactNode
}
export function ChartHeader({
  title,
  description,
  query,
  result,
  actions,
  presentation = "standalone",
  details,
  headingId,
}: Omit<ChartFrameProps, "children" | "access" | "data"> & { headingId?: string }) {
  const { t } = useI18n()
  if (presentation === "embedded") {
    return (
      <header className={styles.embeddedHeader}>
        <h3 id={headingId} className="sr-only">{title}</h3>
        <Popover>
          <PopoverTrigger render={<Button size="sm" variant="outline" />}>
            {t("analytics.details")}
          </PopoverTrigger>
          <PopoverContent className={styles.details}>
            <PopoverTitle className={styles.detailsTitle}>{title}</PopoverTitle>
            {actions}
            <div className={styles.metadata}>
              <ChartMetadata description={description} query={query} result={result} embedded />
            </div>
            {details}
          </PopoverContent>
        </Popover>
      </header>
    )
  }
  return (
    <header className={styles.header}>
      <div className={styles.heading}>
        <h3 id={headingId}>{title}</h3>
        {actions}
      </div>
      <ChartMetadata description={description} query={query} result={result} />
    </header>
  )
}
function ChartMetadata({
  description,
  query,
  result,
  embedded = false,
}: Pick<ChartFrameProps, "description" | "query" | "result"> & { embedded?: boolean }) {
  const { t } = useI18n()
  return (
    <>
      <p>{description}</p>
      {embedded && (
        <>
          <p>{t("analytics.source")}: {query.source}</p>
          <p>{t("analytics.scope")}: {query.scope.id} · {query.scope.permissionVersion}</p>
        </>
      )}
      <p>
        {embedded && t("analytics.definition") + ": "}
        {query.measureId}@{query.measureVersion} · {query.timeField} ·{" "}
        {query.timeZone}
      </p>
      <p>{t("analytics.range")}: {query.range.from} → {query.range.to}</p>
      {embedded && <p>{t("analytics.timeZone")}: {query.timeZone}</p>}
      {result && (
        <p>
          {t("analytics.snapshot")}: {result.snapshotId} ·{" "}
          {t("analytics.updated")}: <time dateTime={result.asOf}>{result.asOf}</time> ·{" "}
          {t("analytics.unit")}: {result.unit}
        </p>
      )}
      {embedded && result && (
        <p>
          {result.completeness === "complete"
            ? t("analytics.historyComplete")
            : result.completeness === "partial"
              ? t("analytics.partial")
              : t("analytics.noHistory")}
        </p>
      )}
      {result?.coverage ? (
        <p>
          {t("analytics.coverage")}: {result.coverage.from} → {result.coverage.to} ·{" "}
          {result.coverage.complete ? t("analytics.historyComplete") : t("analytics.historyPartial")}
        </p>
      ) : embedded && result ? (
        <p>{t("analytics.coverage")}: {t("analytics.missing")}</p>
      ) : null}
      {embedded && result?.coverage?.missingIntervals.map((interval, index) => (
        <p key={index}>{t("analytics.historyPartial")}: {interval.from} → {interval.to}</p>
      ))}
      {embedded && result?.sampleCoverage && (
        <p>{t("analytics.sampleCoverage", { observed: result.sampleCoverage.observed, total: result.sampleCoverage.total })}</p>
      )}
      {embedded && !!result?.limitations.length && <strong>{t("analytics.limitations")}</strong>}
      {result?.limitations.map((limitation, index) => (
        <p key={index}>
          {limitation.startsWith("missing-createdAt:")
            ? t("analytics.missingCreatedAt", { count: limitation.split(":")[1] })
            : limitation === "history-unavailable"
              ? t("analytics.noHistory")
              : Object.hasOwn(componentMessages["zh-CN"], limitation)
                ? t(limitation as MessageKey)
                : limitation}
        </p>
      ))}
    </>
  )
}
export function ChartDataState({
  result,
  data,
  children,
}: {
  result?: AnalyticsResult | null
  data?: ChartFrameProps["data"]
  children: ReactNode
}) {
  const { t } = useI18n()
  const hasContent = !!result?.series.some((series) => series.points.length)
  return (
    <DataRegion
      {...data}
      state={
        data?.state ??
        (!result
          ? "loading"
          : result.completeness === "unavailable"
            ? "empty"
            : result.completeness === "partial"
              ? "partial"
              : hasContent
                ? "success"
                : "empty")
      }
      hasContent={hasContent}
      updatedAt={result?.asOf}
      emptyTitle={
        result?.completeness === "unavailable"
          ? t("analytics.noHistory")
          : data?.emptyTitle
      }
      partialDescription={data?.partialDescription ?? t("analytics.partial")}
    >
      {children}
    </DataRegion>
  )
}
export function ChartFrame(props: ChartFrameProps) {
  const { t } = useI18n()
  const id = useId()
  const matches = props.result?.queryKey === analyticsQueryKey(props.query)
  const result = matches && props.access !== "denied" ? props.result : null
  return (
    <section
      className={props.presentation === "embedded" ? styles.frame + " " + styles.embeddedFrame : styles.frame}
      aria-labelledby={id}
      data-chart-frame
      data-chart-presentation={props.presentation ?? "standalone"}
    >
      <div>
        <ChartHeader
          {...props}
          headingId={id}
          result={result}
          details={props.access === "denied" || !matches ? undefined : props.details}
          actions={
            props.access === "denied" || !matches ? undefined : props.actions
          }
        />
      </div>
      {props.access === "denied" ? (
        <p role="status">{t("analytics.noAccess")}</p>
      ) : !matches && props.result ? (
        <p role="status">{t("analytics.pending")}</p>
      ) : (
        <ChartDataState result={result} data={props.data}>
          {props.children}
        </ChartDataState>
      )}
    </section>
  )
}
export function ChartLegend({
  series,
  hiddenIds,
  onHiddenIdsChange,
}: {
  series: readonly AnalyticsSeries[]
  hiddenIds: readonly string[]
  onHiddenIdsChange: (ids: string[]) => void
}) {
  const { t } = useI18n()
  return (
    <div
      className={styles.legend}
      role="group"
      aria-label={t("analytics.legend")}
    >
      {series.map((item) => (
        <Button
          key={item.id}
          size="sm"
          variant="ghost"
          aria-pressed={!hiddenIds.includes(item.id)}
          onClick={() =>
            onHiddenIdsChange(
              hiddenIds.includes(item.id)
                ? hiddenIds.filter((id) => id !== item.id)
                : [...hiddenIds, item.id],
            )
          }
        >
          <span
            aria-hidden
            className={styles.swatch}
            style={{ background: chartSeriesColor(item.color) }}
          />
          {item.label}
        </Button>
      ))}
    </div>
  )
}
export function ChartTooltip({
  datum,
  unit,
}: {
  datum?: ChartDatum
  unit: string
}) {
  const { t, locale } = useI18n()
  if (!datum) return null
  return (
    <div className={styles.tooltip} data-chart-tooltip>
      <strong>{datum.point.label}</strong> · {datum.series.label}:{" "}
      {formatChartValue(datum.point.value, locale, unit)}
      {datum.point.unfinished && ` · ${t("analytics.unfinished")}`}
      {datum.point.estimated && ` · ${t("analytics.estimated")}`}
    </div>
  )
}
export function ChartAxis({
  unit,
  domain,
  xUnit,
}: {
  unit: string
  domain?: readonly [number, number]
  xUnit?: string
}) {
  const { t } = useI18n()
  return (
    <p className={styles.meta}>
      {t("analytics.unit")}: {unit}
      {domain && ` · [${domain[0]}, ${domain[1]}]`}
      {xUnit && ` · x: ${xUnit}`}
    </p>
  )
}
