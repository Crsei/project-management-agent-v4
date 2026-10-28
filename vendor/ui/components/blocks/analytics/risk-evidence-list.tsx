"use client"
import { DataTable } from "../data-table"
import { Button } from "../../ui/button"
import type { RiskEvidence } from "../../../lib/analytics-metrics"
import type { AnalyticsEntityRef } from "../../../lib/analytics-model"
import { useI18n } from "../../../lib/i18n-provider"
export function RiskEvidenceList({
  evidence,
  onOpenEntity,
}: {
  evidence: readonly RiskEvidence[]
  onOpenEntity?: (ref: AnalyticsEntityRef) => void
}) {
  const { t } = useI18n()
  return (
    <DataTable
      rows={evidence}
      caption={t("analytics.risks")}
      getRowId={(row) => row.id}
      getRowLabel={(row) => row.title}
      data={{ emptyTitle: t("analytics.noRisk") }}
      columns={[
        {
          id: "item",
          header: t("analytics.source"),
          cell: (row) =>
            onOpenEntity ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onOpenEntity(row.entityRef)}
              >
                {row.title}
              </Button>
            ) : (
              row.title
            ),
        },
        {
          id: "rule",
          header: t("analytics.definition"),
          cell: (row) => t(`analytics.${row.rule}`),
        },
        {
          id: "threshold",
          header: t("analytics.threshold"),
          cell: (row) => row.threshold,
        },
        { id: "asOf", header: t("analytics.updated"), cell: (row) => row.asOf },
        {
          id: "source",
          header: t("analytics.source"),
          cell: (row) => row.source,
        },
      ]}
    />
  )
}
