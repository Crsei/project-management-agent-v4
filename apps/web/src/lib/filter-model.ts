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
