"use client"
import { Heatmap } from "../charts/heatmap"
import { DataTable } from "../data-table"
import { Button } from "../../ui/button"
import { useI18n } from "../../../lib/i18n-provider"
import type {
  WorkloadCell,
  ResourceAllocation,
} from "../../../lib/analytics-resource-model"
export function ResourceAllocationView({
  cells,
  selection,
  onSelectionChange,
  resourceLabel,
  onOpenTimeline,
  onOpenEntity,
}: {
  cells: readonly WorkloadCell[]
  selection: WorkloadCell | null
  onSelectionChange: (cell: WorkloadCell) => void
  resourceLabel?: (id: string) => string
  onOpenTimeline?: (cell: WorkloadCell) => void
  onOpenEntity?: (allocation: ResourceAllocation) => void
}) {
  const { t } = useI18n()
  const selected = cells.find((c) => c.id === selection?.id)
  return (
    <>
      <Heatmap
        cells={cells}
        resourceLabel={resourceLabel}
        selectedId={selected?.id}
        onSelect={onSelectionChange}
      />
      {selected && (
        <section>
          <h3>
            {selected.resourceId} · {selected.bucketId}
          </h3>
          <p>
            {selected.calendarVersion ?? t("analytics.unknownCapacity")} ·{" "}
            {t("analytics.allocationDefinition")}
          </p>
          {onOpenTimeline && (
            <Button onClick={() => onOpenTimeline(selected)}>
              {t("analytics.openTimeline")}
            </Button>
          )}
          <DataTable
            rows={selected.allocations}
            getRowId={(a) => a.id}
            getRowLabel={(a) => a.title}
            caption={t("analytics.allocations")}
            onActivateRow={onOpenEntity}
            columns={[
              {
                id: "title",
                header: t("analytics.source"),
                cell: (a) => a.title,
              },
              {
                id: "amount",
                header: t("analytics.value"),
                cell: (a) =>
                  a.amount === null
                    ? t("analytics.missing")
                    : `${a.amount} × ${a.share} ${a.unit}`,
              },
              {
                id: "rule",
                header: t("analytics.definition"),
                cell: (a) => a.rule,
              },
            ]}
          />
        </section>
      )}
    </>
  )
}
