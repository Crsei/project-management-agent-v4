"use client"
import {
  StatisticalChart,
  type StatisticalChartProps,
} from "./statistical-chart"
import { nearestRank } from "../../../lib/analytics-history-metrics"
import { useI18n } from "../../../lib/i18n-provider"
export type HistoryChartProps = Omit<
  StatisticalChartProps,
  "title" | "description" | "kind" | "xType" | "stacked"
>
function HistoryChart({
  metric,
  kind,
  ...props
}: HistoryChartProps & {
  metric:
    | "burndown"
    | "burnup"
    | "velocity"
    | "cumulative-flow"
    | "cycle-time"
    | "state-residence"
    | "workload"
    | "agent-cost"
  kind: StatisticalChartProps["kind"]
}) {
  const { t, number } = useI18n()
  const values =
    props.result?.series.flatMap((s) =>
      s.points.flatMap((p) => (p.value === null ? [] : [p.value])),
    ) ?? []
  return (
    <>
      <StatisticalChart
        {...props}
        title={t(`analytics.${metric}`)}
        description={t(`analytics.${metric}Definition`)}
        kind={kind}
        xType={
          metric === "cycle-time" ||
          ["burndown", "burnup", "cumulative-flow"].includes(metric)
            ? "time"
            : "category"
        }
        stacked={metric === "cumulative-flow"}
        result={
          props.result
            ? {
                ...props.result,
                series: props.result.series.map((s) => ({
                  ...s,
                  label: [
                    "scope",
                    "remaining",
                    "ideal",
                    "committed",
                    "delivered",
                    "added",
                    "backlog",
                    "active",
                    "completed",
                  ].includes(s.id)
                    ? t(
                        `analytics.series.${s.id as "scope" | "remaining" | "ideal" | "committed" | "delivered" | "added" | "backlog" | "active" | "completed"}`,
                      )
                    : s.label,
                })),
              }
            : null
        }
      />
      {metric === "cycle-time" && (
        <p>
          {t("analytics.quantileDefinition")} ·{" "}
          {[0.5, 0.85, 0.95]
            .map(
              (p) =>
                `P${p * 100} ${nearestRank(values, p) === null ? "—" : number(nearestRank(values, p)!, { maximumFractionDigits: 2 })}`,
            )
            .join(" · ")}{" "}
          · {t("analytics.coverage")}:{" "}
          {props.result?.sampleCoverage?.observed ?? values.length}/
          {props.result?.sampleCoverage?.total ?? props.result?.total ?? "—"}
        </p>
      )}
    </>
  )
}
export const BurndownChart = (props: HistoryChartProps) => (
  <HistoryChart {...props} metric="burndown" kind="line" />
)
export const BurnupChart = (props: HistoryChartProps) => (
  <HistoryChart {...props} metric="burnup" kind="line" />
)
export const VelocityChart = (props: HistoryChartProps) => (
  <HistoryChart {...props} metric="velocity" kind="bar" />
)
export const CumulativeFlowChart = (props: HistoryChartProps) => (
  <HistoryChart {...props} metric="cumulative-flow" kind="area" />
)
export const CycleTimeChart = (props: HistoryChartProps) => (
  <HistoryChart {...props} metric="cycle-time" kind="scatter" />
)
export const StateResidenceChart = (props: HistoryChartProps) => (
  <HistoryChart {...props} metric="state-residence" kind="bar" />
)
export const WorkloadChart = (props: HistoryChartProps) => (
  <HistoryChart {...props} metric="workload" kind="bar" />
)
export const AgentCostTrend = (props: HistoryChartProps) => (
  <HistoryChart {...props} metric="agent-cost" kind="line" />
)
