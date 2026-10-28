"use client"
import type { MouseEvent, ReactNode } from "react"
import { Checkbox } from "../ui/checkbox"
import { Button } from "../ui/button"
import {
  WorkItemProperties,
  type WorkItemPropertiesProps,
} from "./work-item-properties"
import { useI18n } from "../../lib/i18n-provider"
import type { MutationState, WorkItemRecord } from "../../lib/work-items-model"
import styles from "./work-items.module.css"
export function WorkItemIdentifier({
  identifier,
  href,
}: {
  identifier: string
  href?: string
}) {
  return href ? (
    <a className={styles.identifier} href={href}>
      {identifier}
    </a>
  ) : (
    <span className={styles.identifier}>{identifier}</span>
  )
}
export function WorkItemMutationNotice({
  mutation,
  onReconcile,
}: {
  mutation?: MutationState
  onReconcile?: () => void
}) {
  const { t } = useI18n()
  if (
    !mutation ||
    (mutation.status === "confirmed" &&
      !Object.keys(mutation.fieldErrors ?? {}).length)
  )
    return null
  return (
    <div
      className={styles.mutation}
      data-mutation={
        mutation.status === "confirmed" ? "rejected" : mutation.status
      }
      role={mutation.status === "rejected" ? "alert" : "status"}
    >
      {mutation.status === "pending"
        ? t("workItems.pending")
        : mutation.status === "unknown"
          ? t("workItems.unknown")
          : t("workItems.rejected")}
      {mutation.error && <span>{mutation.error}</span>}
      {Object.entries(mutation.fieldErrors ?? {}).map(([field, error]) => (
        <span key={field}>{error}</span>
      ))}
      {mutation.status === "unknown" && onReconcile && (
        <Button variant="secondary" size="sm" onClick={onReconcile}>
          {t("workItems.reconcile")}
        </Button>
      )}
    </div>
  )
}
export type WorkItemPresentationProps = WorkItemPropertiesProps & {
  selected?: boolean
  active?: boolean
  onSelect?: (selected: boolean) => void
  href?: string
  onOpen?: (item: WorkItemRecord) => void
  actions?: ReactNode
  onReconcile?: () => void
}
function WorkItemContent({
  item,
  selected,
  active,
  onSelect,
  href,
  onOpen,
  actions,
  onReconcile,
  card,
  ...props
}: WorkItemPresentationProps & { card: boolean }) {
  const { t } = useI18n()
  function open(event: MouseEvent<HTMLAnchorElement>) {
    if (
      onOpen &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.shiftKey &&
      !event.altKey &&
      event.button === 0
    ) {
      event.preventDefault()
      onOpen(item)
    }
  }
  return (
    <article
      className={card ? styles.card : styles.row}
      data-work-item={item.id}
      data-selected={selected || undefined}
      data-active={active || undefined}
    >
      <div className={styles.identity}>
        {onSelect && (
          <Checkbox
            aria-label={t("commonComponents.selectRow", {
              name: item.identifier,
            })}
            checked={selected ?? false}
            onCheckedChange={onSelect}
          />
        )}
        <WorkItemIdentifier identifier={item.identifier} />
        {href ? (
          <a
            className={styles.title}
            href={href}
            onClick={open}
            aria-current={active ? "true" : undefined}
            title={item.title}
          >
            {item.title}
          </a>
        ) : onOpen ? (
          <Button
            variant="ghost"
            className={styles.title}
            onClick={() => onOpen(item)}
          >
            {item.title}
          </Button>
        ) : (
          <span className={styles.title} title={item.title}>
            {item.title}
          </span>
        )}
        {actions}
      </div>
      <WorkItemProperties
        {...props}
        item={item}
        layout={card ? "card" : "row"}
      />
      <WorkItemMutationNotice
        mutation={props.mutation}
        onReconcile={onReconcile}
      />
    </article>
  )
}
export function WorkItemRow(props: WorkItemPresentationProps) {
  return <WorkItemContent {...props} card={false} />
}
export function WorkItemCard(props: WorkItemPresentationProps) {
  return <WorkItemContent {...props} card />
}
