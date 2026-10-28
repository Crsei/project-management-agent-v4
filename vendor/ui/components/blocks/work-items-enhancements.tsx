"use client"
import { useId, useRef, useState } from "react"
import { Button } from "../ui/button"
import { DataRegion, type DataRegionProps } from "../ui/data-region"
import { Input } from "../ui/input"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "../ui/dialog"
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "../ui/popover"
import {
  WorkItemStatePicker,
  WorkItemPriorityPicker,
} from "./work-item-properties"
import { WorkItemMutationNotice } from "./work-item"
import { useI18n } from "../../lib/i18n-provider"
import {
  isMutationLocked,
  type WorkItemRecord,
  type WorkItemCatalog,
  type WorkItemCapabilities,
  type MutationState,
  type WorkItemsBatchIntent,
  type WorkItemsSavedView,
  type WorkItemsSaveViewIntent,
  type WorkItemsViewState,
  type CreateResult,
} from "../../lib/work-items-model"
import styles from "./work-items.module.css"

export type WorkItemsBatchActionsProps = {
  /** Complete selected snapshots, including hidden selected entities; missing IDs are skipped. */
  items: readonly WorkItemRecord[]
  selectedIds: readonly string[]
  catalog: WorkItemCatalog
  capabilities: WorkItemCapabilities
  mutations?: Readonly<Record<string, MutationState | undefined>>
  onApply: (intent: WorkItemsBatchIntent) => void
  onReconcile?: (ids: string[]) => void
}
/** State and priority only. No all-query selection or implied transactional success. */
export function WorkItemsBatchActions(props: WorkItemsBatchActionsProps) {
  const { t } = useI18n()
  const [field, setField] = useState<"stateId" | "priorityId">("stateId")
  const [values, setValues] = useState({
    stateId: props.catalog.states[0]?.id ?? "",
    priorityId: props.catalog.priorities[0]?.id ?? "",
  })
  const [open, setOpen] = useState(false)
  const sent = useRef(false)
  const byId = new Map(props.items.map((item) => [item.id, item]))
  const ids = [...new Set(props.selectedIds)]
  const eligible = ids.filter((id) => {
    const item = byId.get(id)
    return (
      item &&
      props.capabilities.canEditField(item, field) &&
      !isMutationLocked(props.mutations?.[id])
    )
  })
  const unknown = ids.filter(
    (id) => props.mutations?.[id]?.status === "unknown",
  )
  const confirmed = ids.filter(
    (id) => props.mutations?.[id]?.status === "confirmed",
  ).length
  const rejected = ids.filter(
    (id) => props.mutations?.[id]?.status === "rejected",
  ).length
  const pending = ids.filter(
    (id) => props.mutations?.[id]?.status === "pending",
  ).length
  if (!ids.length) return null
  const Picker =
    field === "stateId" ? WorkItemStatePicker : WorkItemPriorityPicker
  const options =
    field === "stateId" ? props.catalog.states : props.catalog.priorities
  const valid = options.some((option) => option.id === values[field])
  return (
    <div className={styles.batch} aria-label={t("workItems.batch")}>
      <label>
        {t("workItems.batchField")}
        <select
          aria-label={t("workItems.batchField")}
          value={field}
          onChange={(e) => setField(e.target.value as typeof field)}
        >
          <option value="stateId">{t("workItems.state")}</option>
          <option value="priorityId">{t("workItems.priority")}</option>
        </select>
      </label>
      <Picker
        value={values[field]}
        options={options}
        onChange={(value) =>
          setValues((before) => ({ ...before, [field]: value }))
        }
      />
      <Button
        size="sm"
        variant="secondary"
        disabled={!eligible.length || !valid}
        onClick={() => {
          sent.current = false
          setOpen(true)
        }}
      >
        {t("workItems.batchPreview")}
      </Button>
      <span role="status">
        {t("workItems.batchResults", {
          confirmed,
          rejected,
          pending,
          unknown: unknown.length,
        })}
      </span>
      {!!unknown.length && props.onReconcile && (
        <Button
          size="sm"
          variant="secondary"
          onClick={() => props.onReconcile?.(unknown)}
        >
          {t("workItems.reconcile")}
        </Button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>{t("workItems.batchPreview")}</DialogTitle>
          <DialogDescription>
            {t("workItems.batchScope", {
              count: eligible.length,
              skipped: ids.length - eligible.length,
            })}
          </DialogDescription>
          <p className="text-sm">
            {t(field === "stateId" ? "workItems.state" : "workItems.priority")}{" "}
            → {options.find((option) => option.id === values[field])?.label}
          </p>
          <ul className={styles.batchPreview}>
            {ids.map((id) => (
              <li key={id}>
                {byId.get(id)?.identifier ?? id} ·{" "}
                {eligible.includes(id)
                  ? t("workItems.batchEligible")
                  : !byId.has(id)
                    ? t("workItems.batchMissing")
                    : isMutationLocked(props.mutations?.[id])
                      ? t("workItems.batchLocked")
                      : (props.capabilities.reason ??
                        t("workItems.batchDenied"))}
              </li>
            ))}
          </ul>
          <Button
            disabled={!eligible.length || !valid}
            onClick={() => {
              if (sent.current) return
              sent.current = true
              props.onApply({
                operationId: crypto.randomUUID(),
                entries: eligible.map((itemId) => ({
                  itemId,
                  baseRevision: byId.get(itemId)!.revision,
                })),
                patch: { [field]: values[field] },
              })
              setOpen(false)
            }}
          >
            {t("workItems.batchConfirm", { count: eligible.length })}
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export type WorkItemsSavedViewsProps = {
  views: readonly WorkItemsSavedView[]
  data?: Omit<DataRegionProps, "children" | "hasContent">
  view: WorkItemsViewState
  activeId?: string | null
  mutation?: MutationState
  canSave?: boolean
  canDelete?: boolean
  reason?: string
  onApply: (saved: WorkItemsSavedView) => void
  onSave: (intent: WorkItemsSaveViewIntent) => Promise<CreateResult>
  onDelete?: (saved: WorkItemsSavedView) => Promise<CreateResult>
  /** Caller retains an unknown result across unmounts before allowing another write. */
  onUnknown: () => void
  onReconcile?: () => void
}
export function WorkItemsSavedViews(props: WorkItemsSavedViewsProps) {
  const { t } = useI18n()
  const errorId = useId()
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [deleting, setDeleting] = useState<WorkItemsSavedView | null>(null)
  const inFlight = useRef(false)
  const active = props.views.find((view) => view.id === props.activeId)
  const locked = busy || isMutationLocked(props.mutation)
  async function write(action: () => Promise<CreateResult>) {
    if (inFlight.current || isMutationLocked(props.mutation)) return
    inFlight.current = true
    setBusy(true)
    setError("")
    try {
      const result = await action()
      if (result.status === "unknown") props.onUnknown()
      else if (result.status === "rejected")
        setError(result.error ?? t("workItems.rejected"))
      else {
        setName("")
        setDeleting(null)
      }
    } catch {
      props.onUnknown()
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }
  return (
    <>
      <Popover>
        <PopoverTrigger render={<Button variant="ghost" />}>
          {t("workItems.savedViews")}
        </PopoverTrigger>
        <PopoverContent>
          <div className={styles.display}>
            {props.reason && <p className="text-xs">{props.reason}</p>}
            <DataRegion
              {...props.data}
              state={
                props.data?.state ?? (props.views.length ? "success" : "empty")
              }
              hasContent={props.views.length > 0}
              emptyTitle={t("workItems.noSavedViews")}
              emptyDescription=""
            >
              {props.views.length ? (
                props.views.map((saved) => (
                  <div key={saved.id} className={styles.savedRow}>
                    <Button
                      variant="ghost"
                      aria-pressed={saved.id === props.activeId}
                      onClick={() => props.onApply(saved)}
                    >
                      {saved.name}
                    </Button>
                    {props.onDelete && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!props.canDelete || locked}
                        aria-label={t("workItems.deleteViewNamed", {
                          name: saved.name,
                        })}
                        onClick={() => setDeleting(saved)}
                      >
                        {t("workItems.deleteView")}
                      </Button>
                    )}
                  </div>
                ))
              ) : (
                <p>{t("workItems.noSavedViews")}</p>
              )}
            </DataRegion>
            <label>
              {t("workItems.viewName")}
              <Input
                aria-label={t("workItems.viewName")}
                value={name}
                maxLength={80}
                aria-invalid={!!error}
                aria-describedby={error ? errorId : undefined}
                disabled={locked}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <Button
              disabled={!props.canSave || locked || !name.trim()}
              onClick={() =>
                void write(() =>
                  props.onSave({
                    name: name.trim(),
                    view: structuredClone(props.view),
                  }),
                )
              }
            >
              {t("workItems.saveView")}
            </Button>
            {active && (
              <Button
                variant="secondary"
                disabled={!props.canSave || locked}
                onClick={() =>
                  void write(() =>
                    props.onSave({
                      id: active.id,
                      baseRevision: active.revision,
                      name: name.trim() || active.name,
                      view: structuredClone(props.view),
                    }),
                  )
                }
              >
                {t("workItems.updateView")}
              </Button>
            )}
            {error && (
              <p id={errorId} role="alert">
                {error}
              </p>
            )}
            <WorkItemMutationNotice
              mutation={props.mutation}
              onReconcile={props.onReconcile}
            />
          </div>
        </PopoverContent>
      </Popover>
      <Dialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(null)
        }}
      >
        <DialogContent>
          <DialogTitle>{t("workItems.deleteView")}</DialogTitle>
          <DialogDescription>{deleting?.name}</DialogDescription>
          <Button
            variant="destructive"
            disabled={
              !props.canDelete ||
              locked ||
              !props.views.some(
                (view) =>
                  view.id === deleting?.id &&
                  view.revision === deleting.revision,
              )
            }
            onClick={() => {
              if (deleting && props.onDelete)
                void write(() => props.onDelete!(deleting))
            }}
          >
            {t("workItems.deleteView")}
          </Button>
          {error && <p role="alert">{error}</p>}
          <WorkItemMutationNotice
            mutation={props.mutation}
            onReconcile={props.onReconcile}
          />
        </DialogContent>
      </Dialog>
    </>
  )
}
