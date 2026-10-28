"use client"
import { useId, useMemo, useState } from "react"
import { DataRegion, type DataRegionProps } from "../ui/data-region"
import { Segmented, SegmentedItem } from "../ui/segmented"
import { DataTable } from "./data-table"
import { useI18n } from "../../lib/i18n-provider"
import { prepareAgentUsageHistory, historySegments } from "../../lib/agent-board-p2"
import type {
  AgentUsageHistoryPoint,
  AgentUsageMetric,
} from "../../lib/agent-board-model"
import styles from "./agent-board-p2.module.css"
export type AgentUsageHistoryProps = {
  points: readonly AgentUsageHistoryPoint[]
  scopeLabel: string
  scopeRunIds?: readonly string[]
  metric?: AgentUsageMetric
  onMetricChange?: (metric: AgentUsageMetric) => void
  data?: Omit<DataRegionProps, "children" | "hasContent">
}
/** Timestamped source intervals only. Runs/currencies stay separate; absent observations break lines. */
export function AgentUsageHistory({
  points,
  scopeLabel,
  scopeRunIds,
  metric,
  onMetricChange,
  data,
}: AgentUsageHistoryProps) {
  const { t, number } = useI18n()
  const [localMetric, setMetric] = useState<AgentUsageMetric>("tokens")
  const current = metric ?? localMetric
  const id = useId()
  const model = useMemo(
    () => prepareAgentUsageHistory(points, current, scopeRunIds),
    [points, current, scopeRunIds],
  )
  return (
    <section className={styles.section} data-agent-history>
      <h2 className={styles.heading}>{t("agentBoardP2.history")}</h2>
      <p className={styles.meta}>{scopeLabel}</p>
      <p className={styles.meta}>
        {t("agentBoardP2.historyScope", { count: model.count })}
      </p>
      <Segmented
        aria-label={t("agentBoardP2.metric")}
        value={current}
        onValueChange={(value) => {
          const next = value as AgentUsageMetric
          if (metric === undefined) setMetric(next)
          onMetricChange?.(next)
        }}
      >
        {(["tokens", "cost", "durationMs"] as const).map((value) => (
          <SegmentedItem
            key={value}
            value={value}
            disabled={metric !== undefined && !onMetricChange}
          >
            {t(`agentBoardP2.${value}`)}
          </SegmentedItem>
        ))}
      </Segmented>
      <DataRegion
        {...data}
        state={data?.state ?? (model.count ? "success" : "empty")}
        hasContent={model.count > 0}
        emptyTitle={t("agentBoardP2.noHistory")}
      >
        <div className={styles.charts}>
          {model.series.map((series, index) => {
            const finiteTimes = series.points
              .filter((point) => Number.isFinite(point.time))
              .map((point) => point.time)
            const from = Math.min(...finiteTimes),
              to = Math.max(...finiteTimes)
            const known = series.points.filter((point) => point.valid)
            const max = Math.max(0, ...known.map((point) => point.value!)) || 1
            const x = (time: number) =>
              40 + (to === from ? 120 : ((time - from) / (to - from)) * 280)
            const y = (value: number) => 120 - (value / max) * 96
            const segments = historySegments(series.points)
            const unit =
              current === "cost"
                ? (series.currency ?? "—")
                : t(`agentBoardP2.${current}`)
            return (
              <figure
                className={styles.chart}
                key={JSON.stringify([series.runId, series.currency])}
              >
                <figcaption>
                  {series.runId} · {unit}
                </figcaption>
                {known.length ? (
                  <svg
                    viewBox="0 0 340 148"
                    role="img"
                    aria-labelledby={`${id}-${index}`}
                  >
                    <title id={`${id}-${index}`}>
                      {t("agentBoardP2.chartDescription", {
                        run: series.runId,
                        count: known.length,
                        unit,
                      })}
                    </title>
                    <path
                      d="M40 24V120H320"
                      fill="none"
                      stroke="var(--border)"
                    />
                    <text x="4" y="28">
                      {number(max, { maximumFractionDigits: 3 })}
                    </text>
                    <text x="20" y="124">
                      0
                    </text>
                    {segments.map((segment, i) => (
                      <polyline
                        key={i}
                        data-history-segment
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        points={segment
                          .map((point) => `${x(point.time)},${y(point.value!)}`)
                          .join(" ")}
                      />
                    ))}
                    {known.map((point) => (
                      <circle
                        key={point.pointId}
                        cx={x(point.time)}
                        cy={y(point.value!)}
                        r="3"
                        fill="currentColor"
                      >
                        <title>
                          {point.timestamp} · {number(point.value!)} {unit}
                        </title>
                      </circle>
                    ))}
                    <text x="40" y="144">
                      {new Date(from).toISOString().slice(5, 16)}
                    </text>
                    <text x="320" y="144" textAnchor="end">
                      {new Date(to).toISOString().slice(5, 16)}
                    </text>
                  </svg>
                ) : (
                  <p className={styles.warning}>
                    {t("agentBoardP2.noKnownPoints")}
                  </p>
                )}
                <p className={styles.meta}>
                  {t("agentBoardP2.seriesCoverage", {
                    known: known.length,
                    total: series.points.length,
                  })}
                </p>
              </figure>
            )
          })}
        </div>
        <div className={styles.historyTable}>
          <DataTable
            caption={t("agentBoardP2.historyTable")}
            rows={model.series.flatMap((series) => series.points)}
            getRowId={(point) => point.pointId}
            getRowLabel={(point) => point.pointId}
            columns={[
              { id: "run", header: "Run", cell: (point) => point.runId },
              {
                id: "interval",
                header: t("agentBoardP2.interval"),
                cell: (point) => `${point.intervalStart} → ${point.timestamp}`,
              },
              {
                id: "value",
                header: t("agentBoardP2.value"),
                cell: (point) =>
                  point.valid
                    ? `${number(point.value!, { maximumFractionDigits: 4 })} ${current === "cost" ? point.currency : t(`agentBoardP2.${current}`)}`
                    : "—",
              },
              {
                id: "source",
                header: t("agentBoardP2.source"),
                cell: (point) =>
                  point.estimated
                    ? t("agentBoard.estimated")
                    : t("agentBoard.observed"),
              },
            ]}
          />
        </div>
      </DataRegion>
    </section>
  )
}
