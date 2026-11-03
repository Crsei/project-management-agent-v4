import { useState } from "react"
import { ChevronDown, ListFilter, Plus, Trash2, X } from "lucide-react"
import { Button } from "../ui/button"
import { Checkbox } from "../ui/checkbox"
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover"
import { useI18n } from "../../lib/i18n-provider"
import {
  workItemsFilterFields,
  type WorkItemCatalog,
  type WorkItemOption,
  type WorkItemsFilterCondition,
  type WorkItemsFilterField,
  type WorkItemsFilters,
  type WorkItemsViewState,
} from "../../lib/work-items-model"
import styles from "./work-items.module.css"
import { RadixSelect } from "@/components/ui/radix-select"

type FilterProps = {
  view: WorkItemsViewState
  onViewChange: (view: WorkItemsViewState) => void
  catalog: WorkItemCatalog
  disabled?: boolean
}

function filterOptions(catalog: WorkItemCatalog, field: WorkItemsFilterField) {
  return field === "state"
    ? catalog.states
    : field === "priority"
      ? catalog.priorities
      : catalog[field]
}

function useFilterText() {
  const { t } = useI18n()
  return {
    field: (field: WorkItemsFilterField) =>
      t(`workItems.${field}` as "workItems.state"),
    summary: (
      options: readonly WorkItemOption[],
      condition: WorkItemsFilterCondition,
    ) => {
      if (!condition.values.length) return t("workItems.filterAny")
      if (condition.values.length > 2)
        return t("workItems.filterSelected", {
          count: condition.values.length,
        })
      return condition.values
        .map((id) => options.find((option) => option.id === id)?.label ?? id)
        .join(", ")
    },
  }
}

function FilterValueList({
  options,
  condition,
  disabled,
  onChange,
}: {
  options: readonly WorkItemOption[]
  condition: WorkItemsFilterCondition
  disabled?: boolean
  onChange: (values: string[]) => void
}) {
  const { t } = useI18n()
  if (!options.length)
    return <p className={styles.filterEmpty}>{t("workItems.noMatches")}</p>
  return (
    <div className={styles.filterValues} role="group">
      {options.map((option) => (
        <label key={option.id} className={styles.filterOption}>
          <Checkbox
            checked={condition.values.includes(option.id)}
            disabled={disabled}
            onCheckedChange={(next) =>
              onChange(
                next
                  ? [...condition.values, option.id]
                  : condition.values.filter((id) => id !== option.id),
              )
            }
          />
          {option.color && (
            <span
              className={styles.filterOptionDot}
              style={{ background: option.color }}
              aria-hidden="true"
            />
          )}
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  )
}

export function WorkItemsFilterMenu({
  view,
  onViewChange,
  catalog,
  disabled,
}: FilterProps) {
  const { t } = useI18n()
  const text = useFilterText()
  const [editing, setEditing] = useState<number | null>(null)
  const conditions = view.filters
  const update = (filters: WorkItemsFilters) =>
    onViewChange({ ...view, filters })

  const addCondition = (field: WorkItemsFilterField) => {
    update([...conditions, { field, operator: "is", values: [] }])
    setEditing(conditions.length)
  }
  const patchCondition = (
    index: number,
    change: Partial<WorkItemsFilterCondition>,
  ) => {
    update(
      conditions.map((condition, current) =>
        current === index ? { ...condition, ...change } : condition,
      ),
    )
  }
  const removeCondition = (index: number) => {
    update(conditions.filter((_, current) => current !== index))
    setEditing((current) =>
      current === null
        ? null
        : current === index
          ? null
          : current > index
            ? current - 1
            : current,
    )
  }

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            disabled={disabled}
            data-active={conditions.length > 0 || undefined}
          />
        }
      >
        <ListFilter aria-hidden="true" />
        {t("commonComponents.filters")}
        {conditions.length > 0 && (
          <span className={styles.filterCount}>{conditions.length}</span>
        )}
      </PopoverTrigger>
      <PopoverContent className={styles.filterPopover} align="start">
        <div className={styles.filterHeader}>
          <span>{t("workItems.filterBy")}</span>
          {conditions.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => {
                setEditing(null)
                update([])
              }}
            >
              {t("workItems.clearFilters")}
            </Button>
          )}
        </div>
        {conditions.length ? (
          <div className={styles.filterRows}>
            {conditions.map((condition, index) => {
              const options = filterOptions(catalog, condition.field)
              const open = editing === index
              return (
                <div key={index} className={styles.filterCondition}>
                  <div className={styles.filterRow}>
                    <span className={styles.filterConjunction}>
                      {index ? t("workItems.and") : t("workItems.where")}
                    </span>
                    <RadixSelect
                      className={styles.filterSelect}
                      aria-label={t("workItems.filterField")}
                      value={condition.field}
                      disabled={disabled}
                      onChange={(event) =>
                        patchCondition(index, {
                          field: event.target.value as WorkItemsFilterField,
                          values: [],
                        })
                      }
                    >
                      {workItemsFilterFields.map((field) => (
                        <option key={field} value={field}>
                          {text.field(field)}
                        </option>
                      ))}
                    </RadixSelect>
                    <RadixSelect
                      className={styles.filterSelect}
                      aria-label={t("workItems.filterOperator")}
                      value={condition.operator}
                      disabled={disabled}
                      onChange={(event) =>
                        patchCondition(index, {
                          operator: event.target
                            .value as WorkItemsFilterCondition["operator"],
                        })
                      }
                    >
                      <option value="is">{t("workItems.filterIs")}</option>
                      <option value="isNot">{t("workItems.filterIsNot")}</option>
                    </RadixSelect>
                    <Button
                      variant="secondary"
                      size="sm"
                      className={styles.filterValue}
                      aria-expanded={open}
                      disabled={disabled}
                      onClick={() => setEditing(open ? null : index)}
                    >
                      <span className="min-w-0 truncate">
                        {text.summary(options, condition)}
                      </span>
                      <ChevronDown className="size-3.5" aria-hidden="true" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t("workItems.removeFilter", {
                        name: `${text.field(condition.field)} ${text.summary(options, condition)}`,
                      })}
                      disabled={disabled}
                      onClick={() => removeCondition(index)}
                    >
                      <Trash2 aria-hidden="true" />
                    </Button>
                  </div>
                  {open && (
                    <FilterValueList
                      options={options}
                      condition={condition}
                      disabled={disabled}
                      onChange={(values) => patchCondition(index, { values })}
                    />
                  )}
                </div>
              )
            })}
          </div>
        ) : (
          <p className={styles.filterEmpty}>{t("workItems.filterEmptyHint")}</p>
        )}
        <div className={styles.filterAdd}>
          <span className={styles.filterAddLabel}>
            {t("workItems.addFilter")}
          </span>
          {workItemsFilterFields.map((field) => (
            <Button
              key={field}
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => addCondition(field)}
            >
              <Plus className="size-3.5" aria-hidden="true" />
              {text.field(field)}
            </Button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

export function WorkItemsFilterChips({
  view,
  onViewChange,
  catalog,
  disabled,
}: FilterProps) {
  const { t } = useI18n()
  const text = useFilterText()
  if (!view.filters.length && !view.query) return null
  const update = (filters: WorkItemsFilters) =>
    onViewChange({ ...view, filters })
  return (
    <div className={styles.chips}>
      {view.filters.length > 0 && (
        <span className={styles.chipsLabel}>{t("workItems.where")}</span>
      )}
      {view.filters.map((condition, index) => {
        const options = filterOptions(catalog, condition.field)
        return (
          <span key={index} className={styles.chip}>
            {index > 0 && (
              <span className={styles.chipConjunction}>
                {t("workItems.and")}
              </span>
            )}
            <Popover>
              <PopoverTrigger
                render={
                  <Button
                    variant="secondary"
                    size="sm"
                    className={styles.chipValue}
                    disabled={disabled}
                  />
                }
              >
                <span>{text.field(condition.field)}</span>
                <span className={styles.chipOperator}>
                  {condition.operator === "isNot"
                    ? t("workItems.filterIsNot")
                    : t("workItems.filterIs")}
                </span>
                <span>{text.summary(options, condition)}</span>
              </PopoverTrigger>
              <PopoverContent className={styles.chipPopover} align="start">
                <p className={styles.chipPopoverTitle}>
                  {text.field(condition.field)}{" "}
                  {condition.operator === "isNot"
                    ? t("workItems.filterIsNot")
                    : t("workItems.filterIs")}
                </p>
                <FilterValueList
                  options={options}
                  condition={condition}
                  disabled={disabled}
                  onChange={(values) =>
                    update(
                      view.filters.map((current, at) =>
                        at === index ? { ...current, values } : current,
                      ),
                    )
                  }
                />
              </PopoverContent>
            </Popover>
            <Button
              variant="ghost"
              size="icon"
              className={styles.chipRemove}
              aria-label={t("workItems.removeFilter", {
                name: `${text.field(condition.field)} ${text.summary(options, condition)}`,
              })}
              disabled={disabled}
              onClick={() =>
                update(view.filters.filter((_, at) => at !== index))
              }
            >
              <X aria-hidden="true" />
            </Button>
          </span>
        )
      })}
      <Button
        variant="ghost"
        size="sm"
        disabled={disabled}
        onClick={() => onViewChange({ ...view, query: "", filters: [] })}
      >
        {t("workItems.clearFilters")}
      </Button>
    </div>
  )
}
