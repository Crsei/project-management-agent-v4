"use client"
import { DataTable } from "../data-table"
import { Button } from "../../ui/button"
import {
  analyticsEntityKey,
  type AnalyticsEntityRef,
  type AnalyticsRelation,
} from "../../../lib/analytics-model"
import type { DataRegionProps } from "../../ui/data-region"
import { useI18n } from "../../../lib/i18n-provider"
export function analyticsRelationsFor(
  relations: readonly AnalyticsRelation[],
  ref: AnalyticsEntityRef,
  kind?: AnalyticsRelation["kind"],
) {
  const key = analyticsEntityKey(ref)
  return relations.filter(
    (relation) =>
      (!kind || relation.kind === kind) &&
      (analyticsEntityKey(relation.from) === key ||
        analyticsEntityKey(relation.to) === key),
  )
}
export function WorkTraceabilityView({
  relations,
  onSelectEntity,
  data,
}: {
  relations: readonly AnalyticsRelation[]
  onSelectEntity?: (ref: AnalyticsEntityRef) => void
  data?: Omit<DataRegionProps, "children" | "hasContent">
}) {
  const { t } = useI18n()
  const cell = (ref: AnalyticsEntityRef) =>
    onSelectEntity ? (
      <Button variant="ghost" size="sm" onClick={() => onSelectEntity(ref)}>
        {ref.kind}: {ref.entityId}
      </Button>
    ) : (
      `${ref.kind}: ${ref.entityId}`
    )
  return (
    <DataTable
      rows={relations}
      caption={t("analytics.trace")}
      getRowId={(relation) => relation.id}
      getRowLabel={(relation) => relation.label}
      data={data}
      columns={[
        {
          id: "from",
          header: t("analytics.source"),
          cell: (relation) => cell(relation.from),
        },
        {
          id: "kind",
          header: t("analytics.relation"),
          cell: (relation) => `${relation.kind} · ${relation.label}`,
        },
        {
          id: "to",
          header: t("analytics.target"),
          cell: (relation) => cell(relation.to),
        },
      ]}
    />
  )
}
