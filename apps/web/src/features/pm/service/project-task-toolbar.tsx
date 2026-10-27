import { ArrowUpDown, ListFilter, Plus, Search, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import styles from "./service-project-detail.module.css"

export type ProjectTaskSort = "default" | "title" | "due" | "priority"

type ProjectTaskToolbarProps = {
  query: string
  status: string
  sort: ProjectTaskSort
  states: readonly { id: string; label: string }[]
  canCreate: boolean
  t: (zh: string, en: string) => string
  onQueryChange: (value: string) => void
  onStatusChange: (value: string) => void
  onSortChange: (value: ProjectTaskSort) => void
  onCreate: () => void
}

const sortLabels: Record<ProjectTaskSort, [string, string]> = {
  default: ["默认排序", "Default"],
  title: ["按标题", "Title"],
  due: ["按截止日期", "Due date"],
  priority: ["按优先级", "Priority"],
}

/** Shared toolbar under the project view tabs, used by every task-oriented view. */
export function ProjectTaskToolbar({ query, status, sort, states, canCreate, t, onQueryChange, onStatusChange, onSortChange, onCreate }: ProjectTaskToolbarProps) {
  const filtered = status !== "all"
  const statusLabel = states.find(state => state.id === status)?.label ?? status
  const sortLabel = t(...sortLabels[sort])
  return <div className={styles.taskToolbar} data-pm-task-toolbar>
    <div className={styles.projectToolbar} role="toolbar" aria-label={t("项目任务工具栏", "Project task toolbar")}>
      <div className={styles.toolbarSearch}>
        <Search size={13} className={styles.toolbarSearchIcon} aria-hidden="true" />
        <input className={styles.toolbarInput} type="search" value={query} onChange={event => onQueryChange(event.target.value)} placeholder={t("搜索任务", "Search tasks")} aria-label={t("搜索项目任务", "Search project tasks")} />
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger type="button" className={styles.toolbarButton} data-active={filtered || undefined} aria-label={t("按状态筛选任务", "Filter tasks by status")}>
          <ListFilter size={14} aria-hidden="true" />
          <span>{t("筛选", "Filter")}</span>
          {filtered && <span className={styles.toolbarCount} aria-hidden="true">1</span>}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>{t("按状态筛选", "Filter by status")}</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={status} onValueChange={onStatusChange}>
            <DropdownMenuRadioItem value="all" closeOnClick>{t("全部状态", "All statuses")}</DropdownMenuRadioItem>
            {states.map(state => <DropdownMenuRadioItem key={state.id} value={state.id} closeOnClick>{state.label}</DropdownMenuRadioItem>)}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger type="button" className={styles.toolbarButton} aria-label={`${t("排序", "Sort")}: ${sortLabel}`} title={`${t("排序", "Sort")}: ${sortLabel}`}>
          <ArrowUpDown size={14} aria-hidden="true" />
          <span className={styles.toolbarLabel}>{t("排序", "Sort")}: </span>{sortLabel}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>{t("排序方式", "Sort by")}</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={sort} onValueChange={value => onSortChange(value as ProjectTaskSort)}>
            {(Object.keys(sortLabels) as ProjectTaskSort[]).map(value => <DropdownMenuRadioItem key={value} value={value} closeOnClick>{t(...sortLabels[value])}</DropdownMenuRadioItem>)}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <span className={styles.toolbarSpacer} />
      <Button size="sm" disabled={!canCreate} onClick={onCreate}><Plus size={14} aria-hidden="true" />{t("新建任务", "Add issue")}</Button>
    </div>
    {filtered && <div className={styles.filterChips} aria-label={t("当前任务筛选", "Active task filters")}>
      <ListFilter size={13} aria-hidden="true" />
      <span className={styles.filterChip}>
        <b>{t("状态", "Status")}</b> {t("是", "is")} <span>{statusLabel}</span>
        <button type="button" className={styles.filterChipRemove} aria-label={t("清除状态筛选", "Clear status filter")} onClick={() => onStatusChange("all")}><X size={12} aria-hidden="true" /></button>
      </span>
      <button type="button" className={styles.filterClear} onClick={() => onStatusChange("all")}>{t("清除全部", "Clear all")}</button>
    </div>}
  </div>
}
