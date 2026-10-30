import { ArrowUpDown, ListFilter, Plus, Search, X } from "lucide-react"
import type { ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { FilterCard, type FilterCondition, type FilterField } from "@/components/blocks/filter-card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import styles from "./service-project-detail.module.css"

export type ProjectTaskSort = "default" | "title" | "due" | "priority"

type ProjectTaskToolbarProps = {
  query: string
  conditions: readonly FilterCondition[]
  fields: readonly FilterField[]
  sort: ProjectTaskSort
  canCreate: boolean
  t: (zh: string, en: string) => string
  agent?: ReactNode
  onQueryChange: (value: string) => void
  onConditionsChange: (conditions: FilterCondition[]) => void
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
export function ProjectTaskToolbar({ query, conditions, fields, sort, canCreate, t, agent, onQueryChange, onConditionsChange, onSortChange, onCreate }: ProjectTaskToolbarProps) {
  const active = conditions.filter(condition => condition.values.length)
  const sortLabel = t(...sortLabels[sort])
  return <div className={styles.taskToolbar} data-pm-task-toolbar>
    <div className={styles.projectToolbar} role="toolbar" aria-label={t("项目任务工具栏", "Project task toolbar")}>
      <div className={styles.toolbarSearch}>
        <Search size={13} className={styles.toolbarSearchIcon} aria-hidden="true" />
        <input className={styles.toolbarInput} type="search" value={query} onChange={event => onQueryChange(event.target.value)} placeholder={t("搜索任务", "Search tasks")} aria-label={t("搜索项目任务", "Search project tasks")} />
      </div>
      <Popover>
        <PopoverTrigger type="button" className={styles.toolbarButton} data-active={active.length > 0 || undefined} aria-label={t("筛选项目任务", "Filter project tasks")}>
          <ListFilter size={14} aria-hidden="true" />
          <span>{t("筛选", "Filter")}</span>
          {active.length > 0 && <span className={styles.toolbarCount} aria-hidden="true">{active.length}</span>}
        </PopoverTrigger>
        <PopoverContent align="start" className={styles.filterPopover} aria-label={t("任务筛选", "Task filters")}>
          <FilterCard title={t("任务筛选", "Task filters")} fields={fields} conditions={conditions} onChange={onConditionsChange}
            emptyHint={t("尚无条件，当前显示全部任务。", "No conditions yet; every task is shown.")}
            addLabel={t("添加条件", "Add")} clearLabel={t("清除全部", "Clear all")}
            whereLabel={t("筛选", "Where")} andLabel={t("并且", "and")} anyLabel={t("任意", "Any")} removeLabel={t("移除筛选条件", "Remove filter")}
            summary={(field, condition) => !condition.values.length ? t("任意", "Any") : condition.values.length > 2 ? t(`已选 ${condition.values.length} 项`, `${condition.values.length} selected`) : condition.values.map(value => field.options.find(option => option.value === value)?.label ?? value).join(", ")} />
        </PopoverContent>
      </Popover>
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
      {agent}
      <Button size="sm" disabled={!canCreate} onClick={onCreate}><Plus size={14} aria-hidden="true" />{t("新建任务", "Add issue")}</Button>
    </div>
    {active.length > 0 && <div className={styles.filterChips} aria-label={t("当前任务筛选", "Active task filters")}>
      <ListFilter size={13} aria-hidden="true" />
      {conditions.map((condition, index) => {
        if (!condition.values.length) return null
        const field = fields.find(candidate => candidate.id === condition.field)
        const labels = condition.values.map(value => field?.options.find(option => option.value === value)?.label ?? value)
        return <span className={styles.filterChip} key={`${condition.field}:${index}`}>
          <b>{field?.label ?? condition.field}</b> {condition.operator === "is" ? t("是", "is") : t("不是", "is not")} <span>{labels.join(", ")}</span>
          <button type="button" className={styles.filterChipRemove} aria-label={t("移除该筛选条件", "Remove this filter")} onClick={() => onConditionsChange(conditions.filter((_, current) => current !== index))}><X size={12} aria-hidden="true" /></button>
        </span>
      })}
      <button type="button" className={styles.filterClear} onClick={() => onConditionsChange([])}>{t("清除全部", "Clear all")}</button>
    </div>}
  </div>
}
