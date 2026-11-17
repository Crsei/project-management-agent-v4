export type FilterOperator = "is" | "isNot"
export type FilterCondition = { field: string; operator: FilterOperator; values: string[] }
