import { useState, type ReactNode } from "react"
import { ChevronDown, Plus, Trash2 } from "lucide-react"
import { useI18n } from "@/lib/i18n-provider"
import styles from "./filter-card.module.css"

export type FilterOperator = "is" | "isNot"
export type FilterCondition = { field: string; operator: FilterOperator; values: string[] }
export type FilterOption = { value: string; label: string }
export type FilterField = {
  id: string
  label: string
  options: readonly FilterOption[]
  /** Render a single-select value instead of a checkbox list. */
  single?: boolean
}

export type FilterCardProps = {
  title: string
  fields: readonly FilterField[]
  conditions: readonly FilterCondition[]
  onChange: (conditions: FilterCondition[]) => void
  emptyHint: string
  addLabel: string
  clearLabel: string
  whereLabel?: string
  andLabel?: string
  anyLabel?: string
  removeLabel?: string
  summary?: (field: FilterField, condition: FilterCondition) => string
  headerActions?: ReactNode
  footer?: ReactNode
  disabled?: boolean
}

function defaultSummary(field: FilterField, condition: FilterCondition, anyLabel: string, selectedLabel: (count: number) => string) {
  if (!condition.values.length) return anyLabel
  if (condition.values.length > 2) return selectedLabel(condition.values.length)
  return condition.values
    .map(value => field.options.find(option => option.value === value)?.label ?? value)
    .join(", ")
}

/** Shared gr8r-style filter builder card. Filtering stays owned by the caller. */
export function FilterCard({
  title,
  fields,
  conditions,
  onChange,
  emptyHint,
  addLabel,
  clearLabel,
  whereLabel = "Where",
  andLabel = "and",
  anyLabel = "Any",
  removeLabel = "Remove filter",
  summary,
  headerActions,
  footer,
  disabled,
}: FilterCardProps) {
  const { locale } = useI18n()
  const english = locale === "en"
  const isLabel = english ? "is" : "是"
  const isNotLabel = english ? "is not" : "不是"
  const selectedLabel = (count: number) => english ? `${count} selected` : `已选 ${count} 项`
  const [expanded, setExpanded] = useState<number | null>(null)
  const fieldFor = (id: string): FilterField =>
    fields.find(field => field.id === id) ?? { id, label: id, options: [] }
  const canAdd = (field: FilterField) => !field.single || !conditions.some(condition => condition.field === field.id)
  const patch = (index: number, change: Partial<FilterCondition>) =>
    onChange(conditions.map((condition, current) => current === index ? { ...condition, ...change } : condition))
  const add = (id: string) => {
    onChange([...conditions, { field: id, operator: "is", values: [] }])
    setExpanded(conditions.length)
  }
  const remove = (index: number) => {
    onChange(conditions.filter((_, current) => current !== index))
    setExpanded(current => current === null ? null : current === index ? null : current > index ? current - 1 : current)
  }
  const toggle = (index: number, value: string) => {
    const condition = conditions[index]
    patch(index, { values: condition.values.includes(value) ? condition.values.filter(entry => entry !== value) : [...condition.values, value] })
  }

  return (
    <div className={styles.card} aria-label={title}>
      <div className={styles.header}>
        <strong>{title}</strong>
        <div className={styles.headerActions}>
          {headerActions}
          <button type="button" className={styles.textButton} onClick={() => { onChange([]); setExpanded(null) }} disabled={disabled}>{clearLabel}</button>
        </div>
      </div>
      <div className={styles.rows}>
        {!conditions.length && <p className={styles.empty}>{emptyHint}</p>}
        {conditions.map((condition, index) => {
          const field = fieldFor(condition.field)
          const value = summary ? summary(field, condition) : defaultSummary(field, condition, anyLabel, selectedLabel)
          return <div className={styles.condition} key={index}>
            <div className={styles.row} data-condition>
              <span className={styles.conjunction}>{index === 0 ? whereLabel : andLabel}</span>
              <label className={styles.controlGroup}>
                <select className={styles.select} aria-label={english ? "Field" : "字段"} value={condition.field} disabled={disabled} onChange={event => patch(index, { field: event.target.value, values: [] })}>
                  {!fields.some(option => option.id === condition.field) && <option value={condition.field}>{condition.field}</option>}
                  {fields.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
                </select>
                <select className={styles.select} aria-label={english ? "Operator" : "操作符"} value={condition.operator} disabled={disabled} onChange={event => patch(index, { operator: event.target.value as FilterOperator })}>
                  <option value="is">{isLabel}</option>
                  <option value="isNot">{isNotLabel}</option>
                </select>
                {field.single
                  ? <select className={styles.select} aria-label={`${field.label} value`} value={condition.values[0] ?? ""} disabled={disabled} onChange={event => patch(index, { values: event.target.value ? [event.target.value] : [] })}>
                      <option value="">{anyLabel}</option>
                      {field.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                  : <button type="button" className={styles.value} aria-expanded={expanded === index} disabled={disabled} onClick={() => setExpanded(expanded === index ? null : index)}>
                      <span>{value}</span>
                      <ChevronDown size={12} aria-hidden="true" />
                    </button>}
              </label>
              <button type="button" className={styles.remove} aria-label={removeLabel} disabled={disabled} onClick={() => remove(index)}><Trash2 size={14} aria-hidden="true" /></button>
            </div>
            {!field.single && expanded === index && <div className={styles.values}>
              {field.options.length
                ? field.options.map(option => <label key={option.value} className={styles.option}>
                    <input type="checkbox" checked={condition.values.includes(option.value)} disabled={disabled} onChange={() => toggle(index, option.value)} />
                    <span>{option.label}</span>
                  </label>)
                : <p className={styles.empty}>{anyLabel}</p>}
            </div>}
          </div>
        })}
        <div className={styles.add}>
          <span>{addLabel}</span>
          {fields.map(field => <button key={field.id} type="button" className={styles.addButton} disabled={disabled || !canAdd(field)} onClick={() => add(field.id)}>
            <Plus size={12} aria-hidden="true" />{field.label}
          </button>)}
        </div>
      </div>
      {footer && <div className={styles.footer}>{footer}</div>}
    </div>
  )
}
