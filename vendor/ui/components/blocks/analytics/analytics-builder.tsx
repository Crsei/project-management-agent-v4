"use client"
import { Button } from "../../ui/button"
import { StatisticalChart } from "../charts/statistical-chart"
import {
  validateAnalyticsBuilder,
  analyticsBuilderKey,
  type AnalyticsBuilderDraft,
  type AnalyticsBuilderMetric,
} from "../../../lib/analytics-builder-model"
import type {
  AnalyticsQuery,
  AnalyticsResult,
  DrilldownSelection,
} from "../../../lib/analytics-model"
import { analyticsQueryKey } from "../../../lib/analytics-query"
import type { ChartKind } from "../../../lib/chart-model"
import { useI18n } from "../../../lib/i18n-provider"
import type { MessageKey } from "../../../lib/i18n-core"
export function AnalyticsBuilder({
  draft,
  metrics,
  authority,
  onDraftChange,
  onPreview,
  onApply,
  onCancel,
  preview,
  busy,
  onDrilldown,
}: {
  draft: AnalyticsBuilderDraft
  metrics: readonly AnalyticsBuilderMetric[]
  authority: AnalyticsQuery
  onDraftChange: (draft: AnalyticsBuilderDraft) => void
  onPreview: (draft: AnalyticsBuilderDraft) => void
  onApply: (draft: AnalyticsBuilderDraft, result: AnalyticsResult) => void
  onCancel: () => void
  preview?: { configurationKey: string; result: AnalyticsResult }
  busy?: boolean
  onDrilldown?: (selection: DrilldownSelection) => void
}) {
  const { t } = useI18n(),
    reason = validateAnalyticsBuilder(draft, metrics, authority),
    metric = metrics.find(
      (m) =>
        m.id === draft.query.measureId &&
        m.version === draft.query.measureVersion,
    )
  // The configuration key includes presentation; the result retains the pure query key.
  const matching =
    !reason &&
    preview?.configurationKey === analyticsBuilderKey(draft) &&
    preview.result.queryKey === analyticsQueryKey(draft.query) &&
    preview.result.unit === draft.unit
  const select = (
    label: string,
    value: string,
    options: readonly string[],
    change: (v: string) => void,
  ) => (
    <label>
      {label}
      <select
        aria-label={label}
        value={value}
        onChange={(e) => change(e.target.value)}
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o || t("analytics.none")}
          </option>
        ))}
      </select>
    </label>
  )
  return (
    <section aria-label={t("analytics.builder")}>
      <h2>{t("analytics.builder")}</h2>
      <p>{t("analytics.builderDefinition")}</p>
      <div
        style={{ display: "flex", gap: 12, flexWrap: "wrap", margin: "12px 0" }}
      >
        {select(
          t("analytics.measure"),
          draft.query.measureId,
          metrics.map((m) => m.id),
          (id) => {
            const m = metrics.find((m) => m.id === id)!
            onDraftChange({
              ...draft,
              query: {
                ...draft.query,
                measureId: m.id,
                measureVersion: m.version,
                timeField: m.timeField,
              },
            })
          },
        )}
        {select(
          t("analytics.dimension"),
          draft.query.dimension,
          metric?.dimensions ?? [],
          (dimension) =>
            onDraftChange({ ...draft, query: { ...draft.query, dimension } }),
        )}
        {select(
          t("analytics.segment"),
          draft.query.segment ?? "",
          ["", ...(metric?.segments ?? [])],
          (segment) =>
            onDraftChange({
              ...draft,
              query: { ...draft.query, segment: segment || undefined },
            }),
        )}
        {select(
          t("analytics.unit"),
          draft.unit,
          [...new Set([...(metric?.units ?? []), "USD"])],
          (unit) => onDraftChange({ ...draft, unit }),
        )}
        {select(
          t("analytics.chart"),
          draft.chart,
          ["bar", "line", "area", "donut", "scatter"],
          (chart) => onDraftChange({ ...draft, chart: chart as ChartKind }),
        )}
        <label>
          <input
            type="checkbox"
            checked={draft.stacked}
            onChange={(e) =>
              onDraftChange({ ...draft, stacked: e.target.checked })
            }
          />
          {t("analytics.stacked")}
        </label>
      </div>
      {reason && <p role="alert">{t(reason as MessageKey)}</p>}
      <div style={{ display: "flex", gap: 4 }}>
        <Button disabled={!!reason || busy} onClick={() => onPreview(draft)}>
          {t("analytics.preview")}
        </Button>
        <Button
          disabled={!matching || busy}
          onClick={() => {
            if (matching && preview) onApply(draft, preview.result)
          }}
        >
          {t("analytics.apply")}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {t("analytics.cancel")}
        </Button>
      </div>
      {matching && preview && (
        <StatisticalChart
          widgetId="builder-preview"
          query={draft.query}
          result={preview.result}
          title={t("analytics.preview")}
          description={t("analytics.builderAttribution")}
          kind={draft.chart}
          stacked={draft.stacked}
          composition={draft.chart === "donut" ? "exclusive" : undefined}
          onDrilldown={onDrilldown}
        />
      )}
    </section>
  )
}
