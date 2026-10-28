"use client"
import type { ReactNode } from "react"
import { MetricSummary } from "../metric-summary"
import { Button } from "../../ui/button"
import { useI18n } from "../../../lib/i18n-provider"
import { formatChartValue, formatMetricComparison } from "../../../lib/chart-format"
export type WorkflowMetricProps = {
  id: string
  label: ReactNode
  value: number | null
  unit?: string
  definition: ReactNode
  baseline?: { value: number | null; label: string }
  partial?: boolean
  onDrilldown?: () => void
}
export function WorkflowMetric(props: WorkflowMetricProps) {
  const { t, locale } = useI18n()
  const comparison = props.baseline
    ? formatMetricComparison(props.value, props.baseline.value)
    : null
  return (
    <div>
      <MetricSummary
        className="py-2"
        items={[
          {
            id: props.id,
            label: props.label,
            value:
              props.value === null
                ? t("analytics.notApplicable")
                : formatChartValue(props.value, locale),
            unit: props.unit,
            description: (
              <>
                {props.definition}
                {props.partial && <span> · {t("analytics.partial")}</span>}
                {props.baseline && (
                  <span>
                    {" "}
                    · {t("analytics.comparison")} ({props.baseline.label}):{" "}
                    {comparison?.kind === "new"
                      ? t("analytics.new")
                      : comparison?.kind === "ratio"
                        ? new Intl.NumberFormat(locale, {
                            style: "percent",
                            maximumFractionDigits: 1,
                          }).format(comparison.value!)
                        : t("analytics.notApplicable")}
                  </span>
                )}
              </>
            ),
          },
        ]}
      />
      {props.onDrilldown && (
        <Button variant="ghost" size="sm" onClick={props.onDrilldown}>
          {t("analytics.open")}
        </Button>
      )}
    </div>
  )
}
