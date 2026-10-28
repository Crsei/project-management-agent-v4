"use client"
import { useState, type ReactNode } from "react"
import {
  DashboardGrid,
  DashboardWidget,
  WidgetActions,
  WidgetInspector,
} from "./dashboard"
import { WorkflowMetric } from "../analytics/workflow-metric"
import {
  StatusDistribution,
  CompletionTrend,
  WorkItemAging,
  BlockerDistribution,
} from "../analytics/workflow-charts"
import { RiskEvidenceList } from "../analytics/risk-evidence-list"
import type { RiskEvidence } from "../../../lib/analytics-metrics"
import type {
  AnalyticsQuery,
  AnalyticsResult,
  DrilldownSelection,
  AnalyticsEntityRef,
} from "../../../lib/analytics-model"
import type { ChartSelection } from "../../../lib/chart-model"
import type { ChartFrameProps } from "../../ui/chart"
import { analyticsQueryKey } from "../../../lib/analytics-query"
import { useI18n } from "../../../lib/i18n-provider"
export type ProjectOverviewWidget = {
  id:
    | "status-distribution"
    | "completion-trend"
    | "work-item-aging"
    | "blocker-distribution"
  query: AnalyticsQuery
  result: AnalyticsResult | null
  data?: ChartFrameProps["data"]
}
export type ProjectOverviewDashboardProps = {
  widgets: readonly ProjectOverviewWidget[]
  riskEvidence: readonly RiskEvidence[]
  access?: "allowed" | "denied"
  selection?: ChartSelection
  onSelectionChange?: (selection: ChartSelection) => void
  onDrilldown?: (selection: DrilldownSelection) => void
  onOpenEntity?: (ref: AnalyticsEntityRef) => void
  onExport?: (widget: ProjectOverviewWidget) => void
  children?: ReactNode
}
const templates = {
  "status-distribution": StatusDistribution,
  "completion-trend": CompletionTrend,
  "work-item-aging": WorkItemAging,
  "blocker-distribution": BlockerDistribution,
}
const definitions = {
  "status-distribution": "analytics.statusDefinition",
  "completion-trend": "analytics.trendDefinition",
  "work-item-aging": "analytics.ageDefinition",
  "blocker-distribution": "analytics.blockerDefinition",
} as const
export function ProjectOverviewDashboard(props: ProjectOverviewDashboardProps) {
  const { t } = useI18n()
  const [inspectedId, setInspectedId] = useState<string | null>(null)
  const inspected = props.widgets.find((w) => w.id === inspectedId)
  const status = props.widgets.find((w) => w.id === "status-distribution")
  const current =
    status?.result &&
    status.result.queryKey === analyticsQueryKey(status.query) &&
    props.access !== "denied"
      ? status.result
      : null
  const completed = current?.series[0]?.points.find(
    (p) => p.bucketId === "completed",
  )?.value
  const rate =
    current?.total && completed !== null && completed !== undefined
      ? (completed / current.total) * 100
      : null
  return (
    <>
      <DashboardGrid>
        {current && (
          <DashboardWidget id="summary" title={t("analytics.total")} width={12}>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <WorkflowMetric
                id="scope"
                label={t("analytics.total")}
                value={current.total}
                unit={t("analytics.items")}
                definition={t("analytics.statusDefinition")}
                partial={current.completeness !== "complete"}
              />
              <WorkflowMetric
                id="rate"
                label={t("analytics.completionRate")}
                value={rate}
                unit="%"
                definition={t("analytics.statusDefinition")}
                partial={current.completeness !== "complete"}
                onDrilldown={
                  props.onDrilldown &&
                  current.series[0]?.points.find(
                    (p) => p.bucketId === "completed",
                  )?.drilldown
                    ? () =>
                        props.onDrilldown!({
                          ...current.series[0].points.find(
                            (p) => p.bucketId === "completed",
                          )!.drilldown!,
                          widgetId: "summary",
                        })
                    : undefined
                }
              />
            </div>
          </DashboardWidget>
        )}
        {props.widgets.map((widget) => {
          const Component = templates[widget.id]
          const available =
            props.access !== "denied" &&
            widget.result?.queryKey === analyticsQueryKey(widget.query)
          return (
            <DashboardWidget
              key={widget.id}
              id={widget.id}
              title={t(`analytics.${widget.id}`)}
            >
              <WidgetActions
                onInspect={() => setInspectedId(widget.id)}
                onExport={
                  available && props.onExport
                    ? () => props.onExport?.(widget)
                    : undefined
                }
              />
              <Component
                {...widget}
                access={props.access}
                widgetId={widget.id}
                selection={props.selection}
                onSelectionChange={props.onSelectionChange}
                onDrilldown={props.onDrilldown}
              />
            </DashboardWidget>
          )
        })}
        {props.access !== "denied" && (
          <DashboardWidget id="risks" title={t("analytics.risks")} width={12}>
            <RiskEvidenceList
              evidence={props.riskEvidence}
              onOpenEntity={props.onOpenEntity}
            />
          </DashboardWidget>
        )}
        {props.children}
      </DashboardGrid>
      {inspected && props.access !== "denied" && (
        <WidgetInspector
          open
          onClose={() => setInspectedId(null)}
          query={inspected.query}
          result={
            inspected.result?.queryKey === analyticsQueryKey(inspected.query)
              ? inspected.result
              : null
          }
          definition={t(definitions[inspected.id])}
        />
      )}
    </>
  )
}
