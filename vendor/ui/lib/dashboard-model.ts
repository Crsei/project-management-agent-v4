import { validateAnalyticsQuery } from "./analytics-query"
import type { AnalyticsFilter, AnalyticsQuery } from "./analytics-model"
export type DashboardWidgetDefinition = {
  id: string
  templateId: string
  query: AnalyticsQuery
  width: 6 | 12
  height: 240 | 320 | 400
}
export type DashboardDefinition = {
  schemaVersion: 1
  id: string
  revision: number
  templateId: string
  widgets: readonly DashboardWidgetDefinition[]
  globalFilters: readonly AnalyticsFilter[]
}
/** Configuration only. Fixed templates do not offer unsaved layout editing. */
export function validateDashboardDefinition(
  value: DashboardDefinition,
): boolean {
  try {
    if (
      !value ||
      value.schemaVersion !== 1 ||
      typeof value.id !== "string" ||
      !value.id ||
      typeof value.templateId !== "string" ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 0 ||
      !Array.isArray(value.widgets) ||
      value.widgets.length > 32 ||
      !Array.isArray(value.globalFilters)
    )
      return false
    if (new Set(value.widgets.map((w) => w.id)).size !== value.widgets.length)
      return false
    for (const w of value.widgets) {
      if (
        !w ||
        typeof w.id !== "string" ||
        !w.id ||
        typeof w.templateId !== "string" ||
        !w.templateId ||
        ![6, 12].includes(w.width) ||
        ![240, 320, 400].includes(w.height)
      )
        return false
      validateAnalyticsQuery(w.query)
    }
    return value.globalFilters.every(
      (f) =>
        [
          "entityId",
          "projectId",
          "stateId",
          "category",
          "assigneeIds",
          "blockerId",
        ].includes(f.field) &&
        Array.isArray(f.values) &&
        f.values.every((v: unknown) => typeof v === "string"),
    )
  } catch {
    return false
  }
}
