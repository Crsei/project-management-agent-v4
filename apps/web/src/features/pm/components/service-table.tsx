import { useMemo, useRef, useState } from "react"
import { flexRender, getCoreRowModel, getFilteredRowModel, getSortedRowModel, useReactTable, type ColumnDef, type ColumnFiltersState, type SortingState, type VisibilityState } from "@tanstack/react-table"
import { useVirtualizer } from "@tanstack/react-virtual"
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react"
import type { Entity } from "@contracts"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { NativeSelect } from "@/components/ui/native-select"
import { useI18n } from "@/lib/i18n-provider"
import { itemDates, itemStatus, itemText, itemTitle, statusLabel, workItemStatuses } from "./service-collection-shared"
import styles from "./service-collections.module.css"

export function ServiceTable({ items, onOpen }: { items: Entity[]; onOpen: (item: Entity) => void }) {
  const { locale } = useI18n()
  const en = locale === "en"
  const scroll = useRef<HTMLDivElement>(null)
  const [sorting, setSorting] = useState<SortingState>([])
  const [filter, setFilter] = useState("")
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [visibility, setVisibility] = useState<VisibilityState>({ id: false })
  const [selectedId, setSelectedId] = useState("")
  const columns = useMemo<ColumnDef<Entity>[]>(() => [
    { id: "title", accessorFn: itemTitle, header: en ? "Work item" : "工作项", enableHiding: false, size: 330,
      cell: ({ row }) => <button type="button" className={styles.itemLink} aria-pressed={selectedId === row.original.id} onClick={() => { setSelectedId(row.original.id); onOpen(row.original) }}>{itemTitle(row.original)}</button> },
    { id: "status", accessorFn: itemStatus, header: en ? "Status" : "状态", size: 140, filterFn: "equalsString", cell: ({ getValue }) => statusLabel(getValue<string>(), locale) },
    { id: "priority", accessorFn: (item) => itemText(item, "priority"), header: en ? "Priority" : "优先级", size: 100, cell: ({ getValue }) => getValue<string>() || "—" },
    { id: "start", accessorFn: (item) => itemDates(item).start ?? "", header: en ? "Start date" : "开始日期", size: 140, cell: ({ getValue }) => getValue<string>() || "—" },
    { id: "due", accessorFn: (item) => itemDates(item).due ?? "", header: en ? "Due date" : "截止日期", size: 140, cell: ({ getValue }) => getValue<string>() || "—" },
    { id: "id", accessorKey: "id", header: "ID", size: 300 },
  ], [en, locale, onOpen, selectedId])
  const table = useReactTable({ data: items, columns, state: { sorting, globalFilter: filter, columnFilters, columnVisibility: visibility }, onSortingChange: setSorting, onGlobalFilterChange: setFilter, onColumnFiltersChange: setColumnFilters, onColumnVisibilityChange: setVisibility, getRowId: (item) => item.id, getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel(), getFilteredRowModel: getFilteredRowModel(), globalFilterFn: "includesString" })
  const rows = table.getRowModel().rows
  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => scroll.current, estimateSize: () => 44, overscan: 8, getItemKey: (index) => rows[index]!.id })
  const virtualRows = virtualizer.getVirtualItems()
  const first = virtualRows[0]
  const last = virtualRows[virtualRows.length - 1]
  const visibleCount = table.getVisibleLeafColumns().length
  const states = useMemo(() => [...new Set<string>([...workItemStatuses, ...items.map(itemStatus)])], [items])
  return <div className={styles.root}>
    <div className={styles.toolbar}>
      <label className={styles.selector}>{en ? "Filter work items" : "筛选工作项"}<Input type="search" value={filter} placeholder={en ? "Search title, ID, status, dates…" : "搜索标题、ID、状态、日期…"} onChange={(event) => { setFilter(event.target.value); scroll.current?.scrollTo({ top: 0 }) }} /></label>
      <label className={styles.statusFilter}>{en ? "Status" : "状态"}<NativeSelect value={(table.getColumn("status")?.getFilterValue() as string) ?? ""} onChange={(event) => { table.getColumn("status")?.setFilterValue(event.target.value || undefined); scroll.current?.scrollTo({ top: 0 }) }}>
        <option value="">{en ? "All statuses" : "全部状态"}</option>
        {states.map((state) => <option key={state} value={state}>{statusLabel(state, locale)}</option>)}
      </NativeSelect></label>
      <details className={styles.columnMenu}><summary>{en ? "Columns" : "列显示"}</summary><div>{table.getAllLeafColumns().filter((column) => column.getCanHide()).map((column) => <label key={column.id}><input type="checkbox" checked={column.getIsVisible()} onChange={column.getToggleVisibilityHandler()} />{String(column.columnDef.header)}</label>)}</div></details>
      {(filter || columnFilters.length > 0 || sorting.length > 0) && <Button variant="ghost" onClick={() => { setFilter(""); setColumnFilters([]); setSorting([]); scroll.current?.scrollTo({ top: 0 }) }}>{en ? "Reset filters & sorting" : "重置筛选和排序"}</Button>}
      <span className={styles.hint} role="status">{en ? `${rows.length} of ${items.length} items` : `${rows.length} / ${items.length} 项`}</span>
    </div>
    <div ref={scroll} className={styles.tableViewport} tabIndex={0} role="region" aria-label={en ? "Work item table; scroll to view more rows" : "工作项表格；滚动查看更多行"}>
      <table className={styles.table} aria-rowcount={rows.length + 1} style={{ minWidth: table.getTotalSize() }}>
        <caption className="sr-only">{en ? "Work items. Sort using column headers. Shift-click to sort multiple columns." : "工作项。使用列标题排序，按住 Shift 点击可按多列排序。"}</caption>
        <thead>{table.getHeaderGroups().map((group) => <tr key={group.id} aria-rowindex={1}>{group.headers.map((header) => <th key={header.id} style={{ width: header.getSize() }} scope="col" aria-sort={header.column.getIsSorted() === "asc" ? "ascending" : header.column.getIsSorted() === "desc" ? "descending" : "none"}>
          {header.isPlaceholder ? null : <Button variant="ghost" size="sm" onClick={header.column.getToggleSortingHandler()} aria-label={`${String(header.column.columnDef.header)}: ${en ? "toggle sorting" : "切换排序"}`}>{flexRender(header.column.columnDef.header, header.getContext())}{header.column.getIsSorted() === "asc" ? <ArrowUp size={14} aria-hidden="true" /> : header.column.getIsSorted() === "desc" ? <ArrowDown size={14} aria-hidden="true" /> : <ArrowUpDown size={14} aria-hidden="true" />}</Button>}
        </th>)}</tr>)}</thead>
        <tbody>
          {first && first.start > 0 && <tr aria-hidden="true"><td colSpan={visibleCount} style={{ height: first.start, padding: 0, border: 0 }} /></tr>}
          {virtualRows.map((virtualRow) => { const row = rows[virtualRow.index]!; return <tr key={row.id} aria-rowindex={virtualRow.index + 2} data-selected={selectedId === row.original.id || undefined}>{row.getVisibleCells().map((cell) => <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>)}</tr> })}
          {last && virtualizer.getTotalSize() - last.end > 0 && <tr aria-hidden="true"><td colSpan={visibleCount} style={{ height: virtualizer.getTotalSize() - last.end, padding: 0, border: 0 }} /></tr>}
          {!rows.length && <tr><td colSpan={visibleCount} className={styles.empty}>{items.length ? (en ? "No matching work items. Clear the filters to see all items." : "没有匹配的工作项。清除筛选以查看所有工作项。") : (en ? "No work items in this collection." : "此集合中暂无工作项。")}</td></tr>}
        </tbody>
      </table>
    </div>
  </div>
}
