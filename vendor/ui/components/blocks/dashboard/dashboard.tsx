"use client"
import type { ReactNode } from "react"
import { WorkspaceShell } from "../workspace-shell"
import {
  FilterToolbar,
  type FilterToolbarProps,
} from "../filter-toolbar"
import { Button } from "../../ui/button"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../../ui/sheet"
import { DataRegion, type DataRegionProps } from "../../ui/data-region"
import type { AnalyticsQuery, AnalyticsResult } from "../../../lib/analytics-model"
import { useI18n } from "../../../lib/i18n-provider"
import styles from "./dashboard.module.css"
export function DashboardHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className={styles.header}>
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions}
    </div>
  )
}
export function DashboardFilterBar(props: FilterToolbarProps) {
  return <FilterToolbar {...props} />
}
export function DashboardShell({
  header,
  toolbar,
  sidebar,
  children,
}: {
  header: ReactNode
  toolbar?: ReactNode
  sidebar?: ReactNode
  children: ReactNode
}) {
  return (
    <div className={styles.shell}>
      <WorkspaceShell
        className={
          sidebar
            ? styles.workspace
            : `${styles.workspace} ${styles.withoutSidebar}`
        }
        title={header}
        toolbar={toolbar}
        sidebar={sidebar}
        defaultSidebarCollapsed={!sidebar}
      >
        <div className={styles.body}>{children}</div>
      </WorkspaceShell>
    </div>
  )
}
export function DashboardGrid({ children }: { children: ReactNode }) {
  return <div className={styles.grid}>{children}</div>
}
export function DashboardWidget({
  id,
  title,
  width = 6,
  children,
  data,
}: {
  id: string
  title: string
  width?: 4 | 6 | 8 | 12
  children: ReactNode
  data?: Omit<DataRegionProps, "children">
}) {
  return (
    <section
      className={styles.widget}
      data-width={width}
      data-widget={id}
      id={id}
      aria-label={title}
    >
      {data ? <DataRegion {...data}>{children}</DataRegion> : children}
    </section>
  )
}
export function WidgetActions({
  onInspect,
  onExport,
}: {
  onInspect?: () => void
  onExport?: () => void
}) {
  const { t } = useI18n()
  return (
    <div className={styles.actions}>
      {onInspect && (
        <Button variant="ghost" size="sm" onClick={onInspect}>
          {t("analytics.definition")}
        </Button>
      )}
      {onExport && (
        <Button variant="ghost" size="sm" onClick={onExport}>
          {t("analytics.export")}
        </Button>
      )}
    </div>
  )
}
export function WidgetInspector({
  open,
  onClose,
  query,
  result,
  definition,
}: {
  open: boolean
  onClose: () => void
  query: AnalyticsQuery
  result: AnalyticsResult | null
  definition: ReactNode
}) {
  const { t } = useI18n()
  return (
    <Sheet
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose()
      }}
    >
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{t("analytics.definition")}</SheetTitle>
          <SheetDescription>
            {query.measureId}@{query.measureVersion}
          </SheetDescription>
        </SheetHeader>
        <SheetBody>
          <p>{definition}</p>
          <p>
            {t("analytics.snapshot")}: {result?.snapshotId ?? "—"}
          </p>
          <p>
            {t("analytics.coverage")}:{" "}
            {result?.coverage
              ? `${result.coverage.from} → ${result.coverage.to} · ${result.coverage.complete}`
              : "—"}
          </p>
          <pre className={styles.query}>{JSON.stringify(query, null, 2)}</pre>
        </SheetBody>
      </SheetContent>
    </Sheet>
  )
}
