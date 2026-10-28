"use client"

import { useId, useRef, useState } from "react"
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnSizingState,
  type OnChangeFn,
  type RowSelectionState,
  type SortingState,
  type VisibilityState,
} from "@tanstack/react-table"
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react"
import { Button } from "./ui/button"
import { Checkbox } from "./ui/checkbox"
import styles from "./data-table.module.css"

export interface ConversationDataTableProps<T> {
  data: T[]
  columns: ColumnDef<T, unknown>[]
  /** Domain identity, never the filtered row index. */
  getRowId: (row: T) => string
  getRowLabel: (row: T) => string
  caption: string
  locale?: "zh-CN" | "en"
  rowSelection?: RowSelectionState
  onRowSelectionChange?: OnChangeFn<RowSelectionState>
  sorting?: SortingState
  onSortingChange?: OnChangeFn<SortingState>
  columnSizing?: ColumnSizingState
  onColumnSizingChange?: OnChangeFn<ColumnSizingState>
  columnVisibility?: VisibilityState
  onColumnVisibilityChange?: OnChangeFn<VisibilityState>
  columnLabels?: Record<string, string>
  rowHeaderColumnId?: string
  activeRowId?: string
  onActivateRow?: (row: T) => void
  selectable?: boolean
  resizeColumns?: boolean
  stickyHeader?: boolean
  emptyMessage?: string
  className?: string
}

/** Native table semantics with caller-owned, stable-ID TanStack state. */
export function ConversationDataTable<T>({
  data,
  columns,
  getRowId,
  getRowLabel,
  caption,
  locale = "en",
  rowSelection,
  onRowSelectionChange,
  sorting,
  onSortingChange,
  columnSizing,
  onColumnSizingChange,
  columnVisibility,
  onColumnVisibilityChange,
  columnLabels,
  rowHeaderColumnId,
  activeRowId,
  onActivateRow,
  selectable = false,
  resizeColumns = false,
  stickyHeader = false,
  emptyMessage,
  className,
}: ConversationDataTableProps<T>) {
  const captionId = useId()
  const rowElements = useRef(new Map<string, HTMLTableRowElement>())
  const [localSelection, setLocalSelection] = useState<RowSelectionState>({})
  const [localSorting, setLocalSorting] = useState<SortingState>([])
  const [localSizing, setLocalSizing] = useState<ColumnSizingState>({})
  const [localVisibility, setLocalVisibility] = useState<VisibilityState>({})
  const selectionEnabled =
    selectable ||
    rowSelection !== undefined ||
    onRowSelectionChange !== undefined
  const table = useReactTable({
    data,
    columns,
    getRowId,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    enableRowSelection: selectionEnabled,
    enableColumnResizing: resizeColumns,
    columnResizeMode: "onChange",
    defaultColumn: { minSize: 72, maxSize: 720, size: 180 },
    state: {
      rowSelection: rowSelection ?? localSelection,
      sorting: sorting ?? localSorting,
      columnSizing: columnSizing ?? localSizing,
      columnVisibility: columnVisibility ?? localVisibility,
    },
    onRowSelectionChange: onRowSelectionChange ?? setLocalSelection,
    onSortingChange: onSortingChange ?? setLocalSorting,
    onColumnSizingChange: onColumnSizingChange ?? setLocalSizing,
    onColumnVisibilityChange: onColumnVisibilityChange ?? setLocalVisibility,
  })
  const rows = table.getRowModel().rows
  const visibleColumns = table.getVisibleLeafColumns()
  const rowHeaderId = rowHeaderColumnId ?? visibleColumns[0]?.id
  const chinese = locale === "zh-CN"
  const rowInteractive = selectionEnabled || onActivateRow !== undefined

  return (
    <div
      className={[styles.viewport, className].filter(Boolean).join(" ")}
      tabIndex={0}
      role="region"
      aria-labelledby={captionId}
    >
      <table
        className={styles.table}
        style={{ width: table.getTotalSize() + (selectionEnabled ? 44 : 0) }}
      >
        <caption id={captionId}>{caption}</caption>
        <thead className={stickyHeader ? styles.sticky : undefined}>
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id}>
              {selectionEnabled && (
                <th scope="col" className={styles.selection}>
                  <Checkbox
                    aria-label={
                      chinese
                        ? "选择所有当前显示的记录"
                        : "Select all visible records"
                    }
                    disabled={rows.length === 0}
                    checked={
                      table.getIsAllRowsSelected() && rows.length > 0
                        ? true
                        : table.getIsSomeRowsSelected()
                          ? "indeterminate"
                          : false
                    }
                    onCheckedChange={(checked) =>
                      table.toggleAllRowsSelected(checked === true)
                    }
                  />
                </th>
              )}
              {group.headers.map((header) => {
                const column = header.column
                const label =
                  columnLabels?.[column.id] ??
                  (typeof column.columnDef.header === "string"
                    ? column.columnDef.header
                    : column.id)
                const direction = column.getIsSorted()
                const sortPosition = column.getSortIndex()
                const min = column.columnDef.minSize ?? 72
                const max = column.columnDef.maxSize ?? 720
                return (
                  <th
                    key={header.id}
                    scope={header.colSpan > 1 ? "colgroup" : "col"}
                    colSpan={header.colSpan}
                    style={{ width: header.getSize() }}
                    aria-sort={
                      direction
                        ? direction === "asc"
                          ? "ascending"
                          : "descending"
                        : undefined
                    }
                  >
                    <div className={styles.header}>
                      {!header.isPlaceholder && (
                        <span>
                          {flexRender(
                            column.columnDef.header,
                            header.getContext(),
                          )}
                        </span>
                      )}
                      {!header.isPlaceholder && column.getCanSort() && (
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`${chinese ? "排序" : "Sort"}: ${label}${direction ? ` · ${direction === "asc" ? (chinese ? "升序" : "ascending") : chinese ? "降序" : "descending"}${table.getState().sorting.length > 1 ? ` · ${sortPosition + 1}` : ""}` : ""}`}
                          onClick={column.getToggleSortingHandler()}
                        >
                          {direction === "asc" ? (
                            <ArrowUp aria-hidden="true" />
                          ) : direction === "desc" ? (
                            <ArrowDown aria-hidden="true" />
                          ) : (
                            <ArrowUpDown aria-hidden="true" />
                          )}
                        </Button>
                      )}
                    </div>
                    {!header.isPlaceholder && column.getCanResize() && (
                      <div
                        role="separator"
                        tabIndex={0}
                        aria-orientation="vertical"
                        aria-label={`${chinese ? "调整列宽" : "Resize column"}: ${label}`}
                        aria-valuemin={min}
                        aria-valuemax={max}
                        aria-valuenow={column.getSize()}
                        className={styles.resizer}
                        data-resizing={column.getIsResizing() || undefined}
                        onMouseDown={header.getResizeHandler()}
                        onTouchStart={header.getResizeHandler()}
                        onDoubleClick={() => column.resetSize()}
                        onKeyDown={(event) => {
                          if (event.key === "Home") {
                            event.preventDefault()
                            column.resetSize()
                            return
                          }
                          if (
                            event.key !== "ArrowLeft" &&
                            event.key !== "ArrowRight"
                          )
                            return
                          event.preventDefault()
                          const size = Math.max(
                            min,
                            Math.min(
                              max,
                              column.getSize() +
                                (event.key === "ArrowLeft" ? -16 : 16),
                            ),
                          )
                          table.setColumnSizing((previous) => ({
                            ...previous,
                            [column.id]: size,
                          }))
                        }}
                      />
                    )}
                  </th>
                )
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const label = getRowLabel(row.original)
            return (
              <tr
                key={row.id}
                ref={(element) => {
                  if (element) rowElements.current.set(row.id, element)
                  else rowElements.current.delete(row.id)
                }}
                aria-label={label}
                aria-selected={
                  selectionEnabled ? row.getIsSelected() : undefined
                }
                data-active={row.id === activeRowId || undefined}
                data-selected={row.getIsSelected() || undefined}
                tabIndex={rowInteractive ? 0 : undefined}
                onClick={
                  onActivateRow
                    ? (event) => {
                        if (
                          (event.target as HTMLElement).closest(
                            "button,a,input,select,textarea,[role=checkbox],[role=separator]",
                          )
                        )
                          return
                        onActivateRow(row.original)
                      }
                    : undefined
                }
                onKeyDown={
                  rowInteractive
                    ? (event) => {
                        if (event.target !== event.currentTarget) return
                        if (
                          event.key === "ArrowDown" ||
                          event.key === "ArrowUp" ||
                          event.key === "Home" ||
                          event.key === "End"
                        ) {
                          event.preventDefault()
                          const target =
                            event.key === "Home"
                              ? rows[0]
                              : event.key === "End"
                                ? rows.at(-1)
                                : rows[
                                    index + (event.key === "ArrowDown" ? 1 : -1)
                                  ]
                          if (target)
                            rowElements.current.get(target.id)?.focus()
                        } else if (event.key === "Enter" && onActivateRow) {
                          event.preventDefault()
                          onActivateRow(row.original)
                        } else if (event.key === " ") {
                          event.preventDefault()
                          if (selectionEnabled) row.toggleSelected()
                          else onActivateRow?.(row.original)
                        }
                      }
                    : undefined
                }
              >
                {selectionEnabled && (
                  <td className={styles.selection}>
                    <Checkbox
                      checked={row.getIsSelected()}
                      aria-label={`${chinese ? "选择记录" : "Select record"}: ${label}`}
                      onCheckedChange={(checked) =>
                        row.toggleSelected(checked === true)
                      }
                    />
                  </td>
                )}
                {row.getVisibleCells().map((cell) =>
                  cell.column.id === rowHeaderId ? (
                    <th
                      key={cell.id}
                      scope="row"
                      style={{ width: cell.column.getSize() }}
                    >
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext(),
                      )}
                    </th>
                  ) : (
                    <td key={cell.id} style={{ width: cell.column.getSize() }}>
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext(),
                      )}
                    </td>
                  ),
                )}
              </tr>
            )
          })}
          {rows.length === 0 && (
            <tr>
              <td
                colSpan={Math.max(
                  1,
                  visibleColumns.length + (selectionEnabled ? 1 : 0),
                )}
                className={styles.empty}
              >
                <span role="status">
                  {emptyMessage ??
                    (chinese ? "没有匹配的记录。" : "No matching records.")}
                </span>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
