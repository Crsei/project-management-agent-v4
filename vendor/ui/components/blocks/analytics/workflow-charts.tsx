"use client"
import {
  StatisticalChart,
  type StatisticalChartProps,
} from "../charts/statistical-chart"
import { useI18n } from "../../../lib/i18n-provider"
export type WorkflowChartProps = Omit<
  StatisticalChartProps,
  "title" | "description" | "kind" | "composition" | "xType"
>
export function StatusDistribution(props: WorkflowChartProps) {
  const { t } = useI18n()
  const result = props.result
    ? {
        ...props.result,
        series: props.result.series.map((series) => ({
          ...series,
          label: t("analytics.status-distribution"),
          points: series.points.map((point) => ({
            ...point,
            label: ["backlog", "active", "completed", "cancelled"].includes(
              point.bucketId,
            )
              ? t(
                  `analytics.${point.bucketId as "backlog" | "active" | "completed" | "cancelled"}`,
                )
              : point.label,
          })),
        })),
      }
    : null
  return (
    <StatisticalChart
      {...props}
      result={result}
      title={t("analytics.status-distribution")}
      description={t("analytics.statusDefinition")}
      kind="donut"
      composition="exclusive"
    />
  )
}
export function CompletionTrend(props: WorkflowChartProps) {
  const { t } = useI18n()
  return (
    <StatisticalChart
      {...props}
      result={
        props.result
          ? {
              ...props.result,
              series: props.result.series.map((series) => ({
                ...series,
                label:
                  series.id === props.query.measureId
                    ? t("analytics.completion-trend")
                    : series.label,
              })),
            }
          : null
      }
      title={t("analytics.completion-trend")}
      description={t("analytics.trendDefinition")}
      kind="line"
      xType="time"
    />
  )
}
export function WorkItemAging(props: WorkflowChartProps) {
  const { t } = useI18n()
  return (
    <StatisticalChart
      {...props}
      result={
        props.result
          ? {
              ...props.result,
              series: props.result.series.map((series) => ({
                ...series,
                label:
                  series.id === props.query.measureId
                    ? t("analytics.work-item-aging")
                    : series.label,
              })),
            }
          : null
      }
      title={t("analytics.work-item-aging")}
      description={t("analytics.ageDefinition")}
      kind="scatter"
      xType="time"
    />
  )
}
export function BlockerDistribution(props: WorkflowChartProps) {
  const { t } = useI18n()
  return (
    <StatisticalChart
      {...props}
      result={
        props.result
          ? {
              ...props.result,
              series: props.result.series.map((series) => ({
                ...series,
                label:
                  series.id === props.query.measureId
                    ? t("analytics.blocker-distribution")
                    : series.label,
              })),
            }
          : null
      }
      title={t("analytics.blocker-distribution")}
      description={t("analytics.blockerDefinition")}
      kind="bar"
    />
  )
}
