"use client"
import type { ReactNode } from "react"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetBody,
  SheetFooter,
  SheetTitle,
  SheetDescription,
} from "../../ui/sheet"
import { Button } from "../../ui/button"
import { DataTable } from "../data-table"
import type {
  AnalyticsEntityRef,
  DrilldownSelection,
} from "../../../lib/analytics-model"
import { analyticsEntityKey } from "../../../lib/analytics-model"
import { useI18n } from "../../../lib/i18n-provider"
import type { DataRegionProps } from "../../ui/data-region"
export type DrilldownRecord = {
  entityRef: AnalyticsEntityRef
  title: string
  currentState?: string
}
export type ChartDrilldownPanelProps = {
  selection: DrilldownSelection | null
  onClose: () => void
  /** Response identity is mandatory, including for empty pages. */
  response?: {
    queryKey: string
    snapshotId: string
    bucketId: string
    seriesId: string
    records: readonly DrilldownRecord[]
    totalCount: number | null
  }
  access?: "allowed" | "denied"
  data?: Omit<DataRegionProps, "children" | "hasContent">
  definition: ReactNode
  onOpenEntity?: (ref: AnalyticsEntityRef) => void
  onOpenView?: (selection: DrilldownSelection) => void
  onApplyFilter?: (selection: DrilldownSelection) => void
  onLoadMore?: () => void
}
export function ChartDrilldownPanel(props: ChartDrilldownPanelProps) {
  const { t } = useI18n()
  const selection = props.selection
  const response = props.response
  const matches =
    !!selection &&
    !!response &&
    selection.queryKey === response.queryKey &&
    selection.snapshotId === response.snapshotId &&
    selection.bucketId === response.bucketId &&
    selection.seriesId === response.seriesId
  const allowed = props.access !== "denied"
  const records = matches && allowed ? response!.records : []
  return (
    <Sheet
      open={!!selection}
      onOpenChange={(open) => {
        if (!open) props.onClose()
      }}
    >
      <SheetContent size={560}>
        <SheetHeader>
          <SheetTitle>{t("analytics.drilldown")}</SheetTitle>
          <SheetDescription>
            {selection?.snapshotId} · {selection?.bucketId}
          </SheetDescription>
        </SheetHeader>
        <SheetBody>
          {!allowed ? (
            <p role="status">{t("analytics.noAccess")}</p>
          ) : (
            <>
              <p className="mb-3 text-xs">{props.definition}</p>
              {selection?.membership === "historical" && (
                <p className="mb-3 text-xs">{t("analytics.historical")}</p>
              )}
              {response && !matches && (
                <p role="status">{t("analytics.mismatch")}</p>
              )}
              <DataTable
                rows={records}
                caption={t("analytics.loaded", {
                  loaded: records.length,
                  total: matches
                    ? (response?.totalCount ?? "—")
                    : (selection?.totalCount ?? "—"),
                })}
                getRowId={(row) => analyticsEntityKey(row.entityRef)}
                getRowLabel={(row) => row.title}
                data={{
                  ...props.data,
                  state: !matches
                    ? "loading"
                    : (props.data?.state ??
                      (records.length ? "success" : "empty")),
                }}
                columns={[
                  {
                    id: "title",
                    header: t("analytics.source"),
                    cell: (row) =>
                      props.onOpenEntity ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => props.onOpenEntity?.(row.entityRef)}
                        >
                          {row.title}
                        </Button>
                      ) : (
                        row.title
                      ),
                  },
                  {
                    id: "state",
                    header: t("analytics.currentState"),
                    cell: (row) => row.currentState ?? "—",
                  },
                ]}
                footer={
                  matches &&
                  props.onLoadMore &&
                  records.length < (response?.totalCount ?? Infinity) ? (
                    <Button variant="secondary" onClick={props.onLoadMore}>
                      {t("dataRegion.loadMore")}
                    </Button>
                  ) : undefined
                }
              />
            </>
          )}
        </SheetBody>
        {allowed && selection && (
          <SheetFooter>
            {props.onApplyFilter && (
              <Button
                variant="secondary"
                onClick={() => props.onApplyFilter?.(selection)}
              >
                {t("analytics.applyFilter")}
              </Button>
            )}
            {props.onOpenView && (
              <Button onClick={() => props.onOpenView?.(selection)}>
                {t("analytics.fullView")}
              </Button>
            )}
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  )
}
