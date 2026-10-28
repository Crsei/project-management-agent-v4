import {
  validateDashboardDefinition,
  type DashboardDefinition,
  type DashboardWidgetDefinition,
} from "./dashboard-model"
export type DashboardEditCommand =
  | { kind: "add"; widget: DashboardWidgetDefinition }
  | { kind: "remove"; id: string }
  | { kind: "move"; id: string; to: number }
  | { kind: "resize"; id: string; width: 6 | 12; height: 240 | 320 | 400 }
export function editDashboard(
  definition: DashboardDefinition,
  command: DashboardEditCommand,
): DashboardDefinition {
  const widgets = [...definition.widgets],
    index =
      command.kind === "add"
        ? -1
        : widgets.findIndex((w) => w.id === command.id)
  if (command.kind === "add") {
    if (widgets.some((w) => w.id === command.widget.id))
      throw new Error("Duplicate widget")
    widgets.push(command.widget)
  } else if (index < 0) throw new Error("Unknown widget")
  else if (command.kind === "remove") widgets.splice(index, 1)
  else if (command.kind === "move") {
    if (
      !Number.isInteger(command.to) ||
      command.to < 0 ||
      command.to >= widgets.length
    )
      throw new Error("Invalid widget position")
    const [item] = widgets.splice(index, 1)
    widgets.splice(command.to, 0, item)
  } else
    widgets[index] = {
      ...widgets[index],
      width: command.width,
      height: command.height,
    }
  const next = { ...definition, widgets }
  if (!validateDashboardDefinition(next))
    throw new Error("Invalid dashboard definition")
  return next
}
export type DashboardSaveIntent = {
  dashboardId: string
  baseRevision: number
  operationId: string
  definition: DashboardDefinition
}
export type DashboardSaveReceipt = {
  operationId: string
  outcome: "confirmed" | "rejected" | "unknown"
  definition?: DashboardDefinition
  message?: string
}
export type DashboardPersistenceCapabilities = {
  save?: (intent: DashboardSaveIntent) => Promise<DashboardSaveReceipt>
  reconcile?: (intent: DashboardSaveIntent) => Promise<DashboardSaveReceipt>
}
export type DashboardEditSnapshot = {
  base: DashboardDefinition
  draft: DashboardDefinition
  status: "idle" | "saving" | "confirmed" | "rejected" | "unknown"
  dirty: boolean
  pending: DashboardSaveIntent | null
  message: string | null
}
/** Retain one session outside component lifetimes. Unknown operations cannot be edited, cancelled or replayed. */
export class DashboardEditSession {
  private state: DashboardEditSnapshot
  private listeners = new Set<() => void>()
  private reconciling = false
  constructor(
    definition: DashboardDefinition,
    readonly capabilities: DashboardPersistenceCapabilities,
    private operationId: () => string,
  ) {
    if (!validateDashboardDefinition(definition))
      throw new Error("Invalid dashboard")
    this.state = {
      base: structuredClone(definition),
      draft: structuredClone(definition),
      status: "idle",
      dirty: false,
      pending: null,
      message: null,
    }
  }
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private emit(patch: Partial<DashboardEditSnapshot>) {
    this.state = { ...this.state, ...patch }
    this.listeners.forEach((fn) => fn())
  }
  edit(command: DashboardEditCommand) {
    if (["saving", "unknown"].includes(this.state.status)) return false
    this.emit({
      draft: editDashboard(this.state.draft, command),
      dirty: true,
      status: "idle",
      message: null,
    })
    return true
  }
  reset() {
    if (["saving", "unknown"].includes(this.state.status)) return false
    this.emit({
      draft: structuredClone(this.state.base),
      dirty: false,
      status: "idle",
      pending: null,
      message: null,
    })
    return true
  }
  private accept(receipt: DashboardSaveReceipt, intent: DashboardSaveIntent) {
    if (this.state.pending?.operationId !== intent.operationId) return
    if (receipt.operationId !== intent.operationId) {
      this.emit({ status: "unknown", message: "analytics.saveMismatch" })
      return
    }
    const definition = receipt.definition
    if (
      receipt.outcome === "confirmed" &&
      definition &&
      definition.id === intent.dashboardId &&
      definition.revision > intent.baseRevision &&
      validateDashboardDefinition(definition)
    ) {
      this.emit({
        base: structuredClone(definition),
        draft: structuredClone(definition),
        dirty: false,
        status: "confirmed",
        pending: null,
        message: receipt.message ?? null,
      })
    } else if (receipt.outcome === "rejected")
      this.emit({
        status: "rejected",
        pending: null,
        message: receipt.message ?? "analytics.saveRejected",
      })
    else
      this.emit({
        status: "unknown",
        message: receipt.message ?? "analytics.saveUnknown",
      })
  }
  async save() {
    if (
      !this.capabilities.save ||
      !this.state.dirty ||
      ["saving", "unknown"].includes(this.state.status)
    )
      return
    const id = this.operationId()
    if (!id) throw new Error("Missing operation identity")
    const intent = {
      dashboardId: this.state.base.id,
      baseRevision: this.state.base.revision,
      operationId: id,
      definition: structuredClone(this.state.draft),
    }
    this.emit({ status: "saving", pending: intent, message: null })
    try {
      this.accept(await this.capabilities.save(intent), intent)
    } catch {
      this.emit({ status: "unknown", message: "analytics.saveUnknown" })
    }
  }
  async reconcile() {
    const intent = this.state.pending
    if (
      this.state.status !== "unknown" ||
      !intent ||
      !this.capabilities.reconcile ||
      this.reconciling
    )
      return
    this.reconciling = true
    try {
      this.accept(await this.capabilities.reconcile(intent), intent)
    } catch {
      this.emit({ status: "unknown", message: "analytics.saveUnknown" })
    } finally {
      this.reconciling = false
    }
  }
}
/** V0 migration is explicit and strips unknown top-level properties. Sources and credentials are never stored here. */
export function migrateDashboardDefinition(
  value: unknown,
): DashboardDefinition {
  if (!value || typeof value !== "object")
    throw new Error("Invalid dashboard configuration")
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== 0 && record.schemaVersion !== 1)
    throw new Error("Unsupported dashboard schema")
  const next = {
    schemaVersion: 1,
    id: record.id,
    revision: record.revision,
    templateId: record.templateId,
    widgets: record.widgets,
    globalFilters: record.globalFilters ?? [],
  } as DashboardDefinition
  if (!validateDashboardDefinition(next))
    throw new Error("Invalid migrated dashboard")
  const filters = (value: DashboardDefinition["globalFilters"]) =>
    value.map((f) => ({ field: f.field, values: [...f.values] }))
  return {
    ...next,
    globalFilters: filters(next.globalFilters),
    widgets: next.widgets.map((w) => {
      const q = w.query
      return {
        id: w.id,
        templateId: w.templateId,
        width: w.width,
        height: w.height,
        query: {
          source: q.source,
          scope: {
            id: q.scope.id,
            permissionVersion: q.scope.permissionVersion,
            projectIds: [...q.scope.projectIds],
          },
          measureId: q.measureId,
          measureVersion: q.measureVersion,
          dimension: q.dimension,
          segment: q.segment,
          timeField: q.timeField,
          range: { from: q.range.from, to: q.range.to },
          bucket: q.bucket,
          timeZone: q.timeZone,
          filters: filters(q.filters),
        },
      }
    }),
  }
}
