"use client"
import { DataTable } from "../data-table"
import { Button } from "../../ui/button"
import { useI18n } from "../../../lib/i18n-provider"
import type { ForecastResult } from "../../../lib/analytics-forecast-model"
import type { AnalyticsEntityRef } from "../../../lib/analytics-model"
export function ForecastChart({
  result,
  onOpenHistorical,
  onOpenRemaining,
}: {
  result: ForecastResult
  onOpenHistorical?: (members: readonly AnalyticsEntityRef[]) => void
  onOpenRemaining?: (members: readonly AnalyticsEntityRef[]) => void
}) {
  const { t, number } = useI18n()
  return (
    <section aria-label={t("analytics.forecast")}>
      <h2>{t("analytics.forecast")}</h2>
      <p>{t("analytics.forecastAssumptions")}</p>
      <p>
        {result.method.id}@{result.method.version} · {t("analytics.snapshot")}:{" "}
        {result.snapshotId} · {t("analytics.updated")}: {result.generatedAt}
      </p>
      <p>
        {result.historicalWindow.from} → {result.historicalWindow.to} ·{" "}
        {result.timeZone} · {result.calendarVersion} · {result.scopeId}
      </p>
      <p>
        {t("analytics.samples")}: {result.samples} · {t("analytics.backtest")}:{" "}
        {result.calibration.origins}, P85{" "}
        {result.calibration.p85Coverage === null
          ? "—"
          : number(result.calibration.p85Coverage, { style: "percent" })}{" "}
        · {result.calibration.method}
      </p>
      {result.status !== "available" ? (
        <p role="status">{t(`analytics.forecast.${result.status}`)}</p>
      ) : (
        <>
          <DataTable
            rows={result.quantiles}
            caption={t("analytics.forecast")}
            getRowId={(r) => String(r.probability)}
            getRowLabel={(r) => `P${r.probability * 100}`}
            columns={[
              {
                id: "p",
                header: t("analytics.quantile"),
                cell: (r) => `P${r.probability * 100}`,
              },
              {
                id: "days",
                header: t("analytics.days"),
                cell: (r) =>
                  r.days === null
                    ? t("analytics.horizonExceeded")
                    : number(r.days),
              },
              {
                id: "date",
                header: t("analytics.conditionalDate"),
                cell: (r) => r.date ?? t("analytics.horizonExceeded"),
              },
            ]}
          />
          <div
            role="img"
            aria-label={t("analytics.forecastBand")}
            style={{ display: "flex", gap: 4, margin: "12px 0" }}
          >
            {result.quantiles.map((q) => (
              <div
                key={q.probability}
                style={{
                  flex: q.days ?? 1,
                  minHeight: 44,
                  border: "1px solid var(--border)",
                  borderLeft: "4px solid var(--chart-2)",
                  padding: 8,
                }}
              >
                P{q.probability * 100} · {q.days ?? "—"} {t("analytics.days")}
              </div>
            ))}
          </div>
        </>
      )}
      {onOpenHistorical && (
        <Button
          variant="secondary"
          onClick={() => onOpenHistorical(result.historicalMembers)}
        >
          {t("analytics.historicalSamples")}
        </Button>
      )}
      {onOpenRemaining && (
        <Button
          variant="ghost"
          onClick={() => onOpenRemaining(result.remaining)}
        >
          {t("analytics.remainingItems")}
        </Button>
      )}
    </section>
  )
}
