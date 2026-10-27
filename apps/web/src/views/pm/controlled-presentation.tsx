import { useLayoutEffect, useRef, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { WorkItemMutationNotice } from "@/components/blocks/work-item"
import { useI18n } from "@/lib/i18n-provider"
import type { MutationState } from "@/lib/work-items-model"
import type { AvailableCount, PmActivityRecord, PmAttachmentRecord, PmControlledSurface } from "./controlled-contracts"
import styles from "./dashboards-views.module.css"

export function ControlledFocus({ surface, children }: { surface: PmControlledSurface; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!surface.focusId) return
    const element = Array.from(root.current?.querySelectorAll<HTMLElement>("[id]") ?? []).find((entry) => entry.id === surface.focusId)
    if (element && document.activeElement !== element) element.focus({ preventScroll: true })
  }, [surface.focusId])
  return <div ref={root} className="contents" onFocusCapture={(event) => { if (event.target.id) surface.onFocusIdChange?.(event.target.id) }}>{children}</div>
}
export function ControlledFeedback({ surface }: { surface: PmControlledSurface }) {
  const { locale } = useI18n()
  return <>
    {surface.securityNotice && <p role="status" className="mb-3 shrink-0 border-l-2 border-warning pl-3 text-sm break-words whitespace-normal">{surface.securityNotice}</p>}
    {surface.pendingRequestId && <p role="status" className="mb-3 shrink-0 text-xs text-muted-foreground">{locale === "en" ? "Request" : "请求"}: <code className="break-all">{surface.pendingRequestId}</code></p>}
    {surface.feedback}
  </>
}
export function ControlledMutation({ mutation, reconcile }: { mutation?: MutationState; reconcile: (operationId: string) => void }) {
  return <><WorkItemMutationNotice mutation={mutation} onReconcile={mutation?.status === "unknown" ? () => reconcile(mutation.operationId) : undefined} />{mutation && (mutation.status === "pending" || mutation.status === "unknown") && <code className="block break-all text-xs text-muted-foreground" data-pm-request-id={mutation.operationId}>{mutation.operationId}</code>}</>
}
export function AvailableMetric({ label, count, onOpen, showDescription = true }: { label: string; count: AvailableCount; onOpen?: () => void; showDescription?: boolean }) {
  const content = <><span className="text-xs text-muted-foreground">{label}</span><strong className="text-xl font-semibold tabular-nums">{count.value === null ? "—" : count.value}</strong>{showDescription && <span className="text-xs text-muted-foreground">{count.description}</span>}</>
  return onOpen ? <Button variant="outline" className={styles.availableMetric} onClick={onOpen}>{content}</Button> : <div className={styles.availableMetric}>{content}</div>
}
export function ControlledActivity({ entries }: { entries: readonly PmActivityRecord[] }) {
  const { locale } = useI18n()
  return entries.length ? <ol className="space-y-4" data-pm-activity>{entries.map((entry) => <li key={entry.id} className="border-b pb-4"><div className="flex items-baseline justify-between gap-4 text-xs text-muted-foreground"><strong className="font-medium text-foreground">{entry.actor}</strong><time dateTime={entry.at}>{entry.at}</time></div><p className="mt-2 whitespace-pre-wrap break-words text-sm">{entry.description}</p></li>)}</ol> : <p className="text-sm text-muted-foreground">{locale === "en" ? "No recorded activity." : "暂无已记录的动态。"}</p>
}
export function ControlledAttachments({ entries, onOpen }: { entries: readonly PmAttachmentRecord[]; onOpen: (id: string) => void }) {
  const { locale } = useI18n()
  return entries.length ? <ul className="space-y-2" data-pm-attachment-list>{entries.map((entry) => <li key={entry.id} className="min-w-0 border-b py-2"><Button variant="ghost" className="max-w-full justify-start" title={entry.name} onClick={() => onOpen(entry.id)}><span className="truncate">{entry.name}</span></Button>{entry.description && <p className="text-xs break-words text-muted-foreground">{entry.description}</p>}{entry.sizeLabel && <p className="text-xs text-muted-foreground">{entry.sizeLabel}</p>}</li>)}</ul> : <p className="text-sm text-muted-foreground">{locale === "en" ? "No stored attachments." : "暂无已存储的附件。"}</p>
}
