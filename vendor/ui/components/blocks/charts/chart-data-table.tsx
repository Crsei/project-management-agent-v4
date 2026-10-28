"use client"
import { useState } from "react"
import { DataTable } from "../data-table"
import { Button } from "../../ui/button"
import { useI18n } from "../../../lib/i18n-provider"
import { formatChartValue } from "../../../lib/chart-format"
import {
  chartData,
  type ChartDatum,
  type ChartSelection,
} from "../../../lib/chart-model"
import type { AnalyticsResult } from "../../../lib/analytics-model"
export function ChartDataTable({
  result,
  selection,
  onSelect,
}: {
  result: AnalyticsResult
  selection?: ChartSelection
  onSelect?: (datum: ChartDatum) => void
}) {
  const { t, locale } = useI18n()
  const data = chartData(result),
    identity = JSON.stringify([result.queryKey, result.snapshotId, selection]),
    [paging, setPaging] = useState({ identity: "", page: 0 }),
    selectedIndex = data.findIndex(
      (d) =>
        d.series.id === selection?.seriesId &&
        d.point.bucketId === selection?.bucketId,
    ),
    pages = Math.max(1, Math.ceil(data.length / 50)),
    page = Math.min(
      paging.identity === identity
        ? paging.page
        : Math.max(0, Math.floor(selectedIndex / 50)),
      pages - 1,
    )

  return (
    <DataTable
      rows={data.slice(page * 50, (page + 1) * 50)}
      footer={
        data.length > 50 ? (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Button
              variant="ghost"
              size="sm"
              disabled={page === 0}
              onClick={() => setPaging({ identity, page: page - 1 })}
            >
              {t("analytics.previousPage")}
            </Button>
            <span>
              {t("analytics.aggregatePage", {
                from: page * 50 + 1,
                to: Math.min((page + 1) * 50, data.length),
                total: data.length,
              })}
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={page === pages - 1}
              onClick={() => setPaging({ identity, page: page + 1 })}
            >
              {t("analytics.nextPage")}
            </Button>
          </div>
        ) : undefined
      }
      caption={`${t("analytics.table")} · ${result.snapshotId}`}
      getRowId={(row) => row.key}
      getRowLabel={(row) => `${row.series.label} ${row.point.label}`}
      activeRowId={
        selection
          ? JSON.stringify([selection.seriesId, selection.bucketId])
          : null
      }
      columns={[
        {
          id: "series",
          header: t("analytics.series"),
          cell: (row) => row.series.label,
        },
        {
          id: "bucket",
          header: t("analytics.bucket"),
          cell: (row) => (
            <>
              {row.point.label}
              {row.point.unfinished && ` · ${t("analytics.unfinished")}`}
            </>
          ),
        },
        {
          id: "value",
          header: t("analytics.value"),
          align: "right",
          cell: (row) => formatChartValue(row.point.value, locale, result.unit),
        },
        {
          id: "source",
          header: t("analytics.source"),
          cell: (row) =>
            onSelect && row.point.drilldown ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onSelect(row)}
                aria-label={`${t("analytics.open")} ${row.point.label}`}
              >
                {t("analytics.open")}
              </Button>
            ) : (
              t("analytics.noDrilldown")
            ),
        },
      ]}
    />
  )
}
