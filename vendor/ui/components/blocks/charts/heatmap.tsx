"use client"
import { useState } from "react"
import { Button } from "../../ui/button"
import { DataTable } from "../data-table"
import { useI18n } from "../../../lib/i18n-provider"
import type { WorkloadCell } from "../../../lib/analytics-resource-model"
import styles from "./heatmap.module.css"
export function HeatmapLegend() {
  const { t } = useI18n()
  return <p className={styles.legend}>{t("analytics.heatmapLegend")}</p>
}
export function Heatmap({
  cells,
  resourceLabel = (id) => id,
  onSelect,
  selectedId,
}: {
  cells: readonly WorkloadCell[]
  resourceLabel?: (id: string) => string
  onSelect?: (cell: WorkloadCell) => void
  selectedId?: string
}) {
  const { t, number } = useI18n(),
    [table, setTable] = useState(false),
    [cursor, setCursor] = useState(0)
  const value = (c: WorkloadCell) =>
    `${c.allocated === null ? t("analytics.missing") : number(c.allocated)} / ${c.capacity === null ? t("analytics.missing") : number(c.capacity)} ${c.unit}`
  return (
    <section aria-label={t("analytics.heatmap")}>
      <h2>{t("analytics.heatmap")}</h2>
      <HeatmapLegend />
      <Button variant="ghost" onClick={() => setTable(!table)}>
        {t(table ? "analytics.chart" : "analytics.table")}
      </Button>
      {table ? (
        <DataTable
          rows={cells}
          caption={t("analytics.heatmap")}
          getRowId={(c) => c.id}
          getRowLabel={(c) => `${resourceLabel(c.resourceId)} ${c.bucketId}`}
          onActivateRow={onSelect}
          columns={[
            {
              id: "resource",
              header: t("analytics.resource"),
              cell: (c) => resourceLabel(c.resourceId),
            },
            {
              id: "bucket",
              header: t("analytics.bucket"),
              cell: (c) => c.bucketId,
            },
            { id: "value", header: t("analytics.capacity"), cell: value },
            {
              id: "source",
              header: t("analytics.definition"),
              cell: (c) =>
                `${c.calendarVersion ?? t("analytics.missing")} · ${c.allocations.map((a) => a.rule).join("; ")}`,
            },
          ]}
        />
      ) : (
        <div
          className={styles.grid}
          role="group"
          aria-label={t("analytics.keyboard")}
          onKeyDown={(e) => {
            if (!cells.length) return
            const delta =
              e.key === "ArrowRight" || e.key === "ArrowDown"
                ? 1
                : e.key === "ArrowLeft" || e.key === "ArrowUp"
                  ? -1
                  : 0
            if (delta) {
              e.preventDefault()
              const next = (cursor + delta + cells.length) % cells.length
              setCursor(next)
              e.currentTarget
                .querySelectorAll<HTMLButtonElement>("button")
                [next]?.focus()
            }
          }}
        >
          {cells.map((c, i) => (
            <button
              key={c.id}
              type="button"
              tabIndex={i === Math.min(cursor, cells.length - 1) ? 0 : -1}
              disabled={!onSelect}
              onFocus={() => setCursor(i)}
              onClick={() => onSelect?.(c)}
              aria-pressed={c.id === selectedId}
              className={styles.cell}
              data-level={
                c.state !== "known"
                  ? c.state
                  : c.utilization !== null && c.utilization > 1
                    ? "over"
                    : c.allocated === 0
                      ? "zero"
                      : "normal"
              }
            >
              <span>
                {resourceLabel(c.resourceId)} · {c.bucketId}
              </span>
              <strong>{value(c)}</strong>
              <span>
                {c.state === "unavailable"
                  ? t("analytics.unavailableCapacity")
                  : c.utilization === null
                    ? t("analytics.unknownCapacity")
                    : number(c.utilization, {
                        style: "percent",
                        maximumFractionDigits: 0,
                      })}
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  )
}
