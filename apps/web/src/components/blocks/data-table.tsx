import {
  configuredColumns,
  columnWidth,
  type DataTableColumnConfig,
} from "../../lib/data-table-model"
import type { ReactNode } from "react"
import styles from "./data-table.module.css"
import { Button } from "../ui/button"
import { Checkbox } from "../ui/checkbox"
import { DataRegion, type DataRegionProps } from "../ui/data-region"
import {
  Table,
  TableContainer,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  TableCaption,
} from "../ui/table"
import { useI18n } from "../../lib/i18n-provider"
export type DataTableColumn<T> = {
  id: string
  minWidth?: number
  maxWidth?: number
  hideable?: boolean
  header: ReactNode
  cell: (row: T) => ReactNode
  align?: "left" | "center" | "right"
  sortable?: boolean
  primary?: boolean
  className?: string
}
export type DataTableSort = {
  columnId: string
  direction: "asc" | "desc"
} | null
export type DataTableProps<T> = {
  rows: readonly T[]
  columns: readonly DataTableColumn<T>[]
  columnConfig?: DataTableColumnConfig
  activationMode?: "primary-cell" | "separate"
  getRowId: (row: T) => string
  getRowLabel: (row: T) => string
  caption: string
  selectedIds?: readonly string[]
  onSelectionChange?: (ids: string[]) => void
  isRowSelectable?: (row: T) => boolean
  activeRowId?: string | null
  onActivateRow?: (row: T) => void
  sort?: DataTableSort
  onSortChange?: (sort: DataTableSort) => void
  data?: Omit<DataRegionProps, "children" | "hasContent">
  footer?: ReactNode
  stickyHeader?: boolean
  maxHeight?: number
  className?: string
}
export function DataTable<T>({
  rows,
  columns: sourceColumns,
  columnConfig,
  activationMode = "primary-cell",
  getRowId,
  getRowLabel,
  caption,
  selectedIds = [],
  onSelectionChange,
  isRowSelectable = () => true,
  activeRowId,
  onActivateRow,
  sort,
  onSortChange,
  data,
  footer,
  stickyHeader = false,
  maxHeight,
  className,
}: DataTableProps<T>) {
  const { t } = useI18n()
  const columns = configuredColumns(sourceColumns, columnConfig)
  const selected = new Set(selectedIds)
  const selectable = rows.filter(isRowSelectable).map(getRowId)
  const chosen = selectable.filter((id) => selected.has(id)).length
  function toggle(ids: string[], checked: boolean) {
    const next = new Set(selectedIds)
    for (const id of ids) {
      if (checked) next.add(id)
      else next.delete(id)
    }
    onSelectionChange?.([...next])
  }
  return (
    <div className={className}>
      <DataRegion
        {...data}
        state={data?.state ?? (rows.length ? "success" : "empty")}
        hasContent={rows.length > 0}
      >
        <TableContainer role="region" aria-label={caption} style={{ maxHeight }}>
          <Table
            style={
              Object.keys(columnConfig?.widths ?? {}).length
                ? {
                    tableLayout: "fixed",
                    width: columns.reduce(
                      (sum, c) => sum + (columnWidth(c, columnConfig) ?? 160),
                      (onSelectionChange ? 48 : 0) +
                        (onActivateRow && activationMode === "separate"
                          ? 80
                          : 0),
                    ),
                  }
                : undefined
            }
          >
            <TableCaption>{caption}</TableCaption>
            <colgroup>
              {onSelectionChange && <col style={{ width: 48 }} />}
              {onActivateRow && activationMode === "separate" && (
                <col style={{ width: 80 }} />
              )}
              {columns.map((column) => (
                <col
                  key={column.id}
                  style={{ width: columnWidth(column, columnConfig) }}
                />
              ))}
            </colgroup>
            <TableHeader
              className={stickyHeader ? "sticky top-0 z-10" : undefined}
            >
              <TableRow>
                {onSelectionChange && (
                  <TableHead className="w-12">
                    <Checkbox
                      aria-label={t("commonComponents.selectAll")}
                      checked={
                        selectable.length > 0 && chosen === selectable.length
                      }
                      indeterminate={chosen > 0 && chosen < selectable.length}
                      disabled={!selectable.length}
                      onCheckedChange={(checked) => toggle(selectable, checked)}
                    />
                  </TableHead>
                )}
                {onActivateRow && activationMode === "separate" && (
                  <TableHead>{t("tableControls.open")}</TableHead>
                )}
                {columns.map((column) => (
                  <TableHead
                    key={column.id}
                    style={{ textAlign: column.align }}
                    aria-sort={
                      sort?.columnId === column.id
                        ? sort.direction === "asc"
                          ? "ascending"
                          : "descending"
                        : undefined
                    }
                  >
                    {column.sortable && onSortChange ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          onSortChange(
                            sort?.columnId !== column.id
                              ? { columnId: column.id, direction: "asc" }
                              : sort.direction === "asc"
                                ? { columnId: column.id, direction: "desc" }
                                : null,
                          )
                        }
                      >
                        {column.header}
                        {sort?.columnId === column.id && (
                          <span aria-hidden="true">
                            {sort.direction === "asc" ? " ↑" : " ↓"}
                          </span>
                        )}
                      </Button>
                    ) : (
                      column.header
                    )}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const id = getRowId(row)
                return (
                  <TableRow
                    key={id}
                    data-row-id={id}
                    data-selected={selected.has(id)}
                    data-active={activeRowId === id}
                  >
                    {onSelectionChange && (
                      <TableCell>
                        <Checkbox
                          aria-label={t("commonComponents.selectRow", {
                            name: getRowLabel(row),
                          })}
                          checked={selected.has(id)}
                          disabled={!isRowSelectable(row)}
                          onCheckedChange={(checked) => toggle([id], checked)}
                        />
                      </TableCell>
                    )}
                    {onActivateRow && activationMode === "separate" && (
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={t("commonComponents.viewRow", {
                            name: getRowLabel(row),
                          })}
                          onClick={() => onActivateRow(row)}
                        >
                          {t("tableControls.open")}
                        </Button>
                      </TableCell>
                    )}
                    {columns.map((column, index) => (
                      <TableCell
                        key={column.id}
                        className={column.className}
                        style={{ textAlign: column.align }}
                      >
                        {onActivateRow &&
                        activationMode === "primary-cell" &&
                        (column.primary ?? index === 0) ? (
                          <Button
                            variant="ghost"
                            className={styles.activation}
                            aria-label={t("commonComponents.viewRow", {
                              name: getRowLabel(row),
                            })}
                            aria-current={
                              activeRowId === id ? "true" : undefined
                            }
                            onClick={() => onActivateRow(row)}
                          >
                            {column.cell(row)}
                          </Button>
                        ) : (
                          column.cell(row)
                        )}
                      </TableCell>
                    ))}
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </TableContainer>
      </DataRegion>
      {footer && (
        <div className="border-t px-3 py-2 text-xs text-muted-foreground">
          {footer}
        </div>
      )}
    </div>
  )
}
