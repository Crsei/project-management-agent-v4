import type { CSSProperties, MouseEvent, ReactNode } from "react"
import { CalendarDays, ListChecks, UserRound } from "lucide-react"
import { Avatar } from "../ui/avatar"
import { Checkbox } from "../ui/checkbox"
import { Button } from "../ui/button"
import {
  WorkItemProperties,
  type WorkItemPropertiesProps,
} from "./work-item-properties"
import { useI18n } from "../../lib/i18n-provider"
import {
  isOverdue,
  type MutationState,
  type WorkItemCatalog,
  type WorkItemOption,
  type WorkItemRecord,
} from "../../lib/work-items-model"
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
/** Status glyphs stay independent of the workflow definition; only the category drives shape. */
export function WorkItemStateGlyph({
  state,
  size = 14,
}: {
  state?: (WorkItemOption & { category?: string }) | null
  size?: number
}) {
  const color = state?.color ?? "var(--text-muted)"
  const id = state?.id ?? ""
  const completed = state?.category === "completed" || id === "done"
  const canceled = state?.category === "canceled" || id === "cancelled"
  const started = state?.category === "started" || id === "in_progress" || id === "progress"
  const review = id === "in_review" || id === "review"
  const backlog = state?.category === "backlog" || id === "backlog" || id === "draft"
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      {completed ? (
        <>
          <circle cx="7" cy="7" r="6.2" fill={color} />
          <path
            d="M4.4 7.2 6.2 9 9.7 5.3"
            fill="none"
            stroke="var(--surface)"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : (
        <>
          <circle
            cx="7"
            cy="7"
            r="5.4"
            fill="none"
            stroke={color}
            strokeWidth="1.5"
            strokeDasharray={backlog ? "1.9 2.1" : undefined}
          />
          {started && !review && (
            <path d="M7 3.4A3.6 3.6 0 0 1 7 10.6Z" fill={color} />
          )}
          {review && (
            <path d="M7 3.4A3.6 3.6 0 1 1 3.4 7L7 7Z" fill={color} />
          )}
          {canceled && (
            <path
              d="M5.1 5.1 8.9 8.9M8.9 5.1 5.1 8.9"
              fill="none"
              stroke={color}
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          )}
        </>
      )}
    </svg>
  )
}
/** Three-bar priority glyph; the host supplies the only colour that matters. */
export function WorkItemPriorityGlyph({
  priority,
  size = 14,
}: {
  priority?: WorkItemOption | null
  size?: number
}) {
  const color = priority?.color ?? "var(--text-secondary)"
  const level =
    priority?.id === "urgent" || priority?.id === "high"
      ? 3
      : priority?.id === "normal" || priority?.id === "medium"
        ? 2
        : priority?.id === "low"
          ? 1
          : 0
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      {[1.8, 5.7, 9.6].map((x, index) => (
        <rect
          key={x}
          x={x}
          y={12 - (4.5 + index * 3)}
          width="2.6"
          height={4.5 + index * 3}
          rx="1"
          fill={index < level ? color : "var(--border)"}
        />
      ))}
    </svg>
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
function WorkItemTitle({
  item,
  href,
  onOpen,
  active,
  className,
}: {
  item: WorkItemRecord
  href?: string
  onOpen?: (item: WorkItemRecord) => void
  active?: boolean
  className: string
}) {
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
  if (href)
    return (
      <a
        className={className}
        href={href}
        onClick={open}
        aria-current={active ? "true" : undefined}
        title={item.title}
      >
        {item.title}
      </a>
    )
  if (onOpen)
    return (
      <Button
        variant="ghost"
        className={className}
        onClick={() => onOpen(item)}
      >
        {item.title}
      </Button>
    )
  return (
    <span className={className} title={item.title}>
      {item.title}
    </span>
  )
}
function WorkItemCardLabels({
  item,
  catalog,
}: {
  item: WorkItemRecord
  catalog: WorkItemCatalog
}) {
  const { t } = useI18n()
  const labels = item.labelIds.map(
    (id) => catalog.labels.find((label) => label.id === id) ?? { id, label: id },
  )
  return (
    <div
      className={styles.cardLabels}
      aria-label={labels.length ? t("workItems.labels") : undefined}
      aria-hidden={labels.length ? undefined : true}
    >
      {labels.slice(0, 3).map((label) => (
        <span
          key={label.id}
          className={styles.cardLabel}
          title={label.label}
          style={
            {
              "--label-color": label.color ?? "var(--text-muted)",
            } as CSSProperties
          }
        >
          <i />
          {label.label}
        </span>
      ))}
      {labels.length > 3 && (
        <span className={styles.cardLabelMore}>+{labels.length - 3}</span>
      )}
    </div>
  )
}
function WorkItemCardProgress({ item }: { item: WorkItemRecord }) {
  const { t } = useI18n()
  const subtasks = item.subtasks
  return (
    <div
      className={styles.cardProgress}
      aria-label={
        subtasks?.total
          ? `${t("workItems.checklist")} ${subtasks.completed}/${subtasks.total}`
          : undefined
      }
    >
      {subtasks?.total ? (
        <>
          <ListChecks size={12} aria-hidden="true" />
          <span>
            {subtasks.completed}/{subtasks.total}
          </span>
          <span className={styles.cardProgressTrack} aria-hidden="true">
            <i
              data-complete={
                subtasks.completed === subtasks.total || undefined
              }
              style={{
                width: `${Math.round((subtasks.completed / subtasks.total) * 100)}%`,
              }}
            />
          </span>
        </>
      ) : null}
    </div>
  )
}
function WorkItemCardAssignees({
  item,
  catalog,
}: {
  item: WorkItemRecord
  catalog: WorkItemCatalog
}) {
  const { t } = useI18n()
  const people = item.assigneeIds.map(
    (id) =>
      catalog.assignees.find((person) => person.id === id) ?? { id, label: id },
  )
  if (!people.length)
    return (
      <span className={styles.cardUnassigned} title={t("workItems.none")}>
        <UserRound size={14} aria-hidden="true" />
      </span>
    )
  return (
    <span className={styles.cardAvatars}>
      {people.slice(0, 2).map((person) => (
        <Avatar key={person.id} name={person.label} size={20} />
      ))}
      {people.length > 2 && (
        <span className={styles.cardAvatarMore}>+{people.length - 2}</span>
      )}
    </span>
  )
}
function WorkItemCardMeta({
  item,
  catalog,
  visibleProperties,
  today,
  actions,
}: {
  item: WorkItemRecord
  catalog: WorkItemCatalog
  visibleProperties: WorkItemPresentationProps["visibleProperties"]
  today?: string
  actions?: ReactNode
}) {
  const { t } = useI18n()
  const priority = catalog.priorities.find(
    (candidate) => candidate.id === item.priorityId,
  )
  return (
    <div className={styles.cardMeta}>
      <span className={styles.cardKey}>{item.identifier}</span>
      {visibleProperties.includes("priority") && item.priorityId && (
        <span
          className={styles.cardMetaItem}
          title={priority?.label ?? item.priorityId}
        >
          <WorkItemPriorityGlyph priority={priority} />
        </span>
      )}
      {visibleProperties.includes("dueDate") && item.dueDate && (
        <span
          className={styles.cardMetaItem}
          data-overdue={isOverdue(item.dueDate, today) || undefined}
          title={t("workItems.dueDate")}
        >
          <CalendarDays size={12} aria-hidden="true" />
          {item.dueDate}
        </span>
      )}
      <span className={styles.cardMetaSpacer} />
      {visibleProperties.includes("assignees") && (
        <WorkItemCardAssignees item={item} catalog={catalog} />
      )}
      {actions}
    </div>
  )
}
function WorkItemCardContent({
  item,
  catalog,
  visibleProperties,
  today,
  selected,
  active,
  onSelect,
  href,
  onOpen,
  actions,
  mutation,
  onReconcile,
}: WorkItemPresentationProps) {
  const { t } = useI18n()
  const state = catalog.states.find((candidate) => candidate.id === item.stateId)
  const completed = state?.category === "completed" || item.stateId === "done"
  return (
    <article
      className={styles.card}
      data-work-item={item.id}
      data-selected={selected || undefined}
      data-active={active || undefined}
      data-completed={completed || undefined}
    >
      <WorkItemCardLabels item={item} catalog={catalog} />
      <div className={styles.cardIdentity}>
        {onSelect && (
          <Checkbox
            aria-label={t("commonComponents.selectRow", {
              name: item.identifier,
            })}
            checked={selected ?? false}
            onCheckedChange={onSelect}
          />
        )}
        <WorkItemTitle
          item={item}
          href={href}
          onOpen={onOpen}
          active={active}
          className={styles.cardTitle}
        />
      </div>
      <WorkItemCardProgress item={item} />
      <WorkItemCardMeta
        item={item}
        catalog={catalog}
        visibleProperties={visibleProperties}
        today={today}
        actions={actions}
      />
      <WorkItemMutationNotice mutation={mutation} onReconcile={onReconcile} />
    </article>
  )
}
function WorkItemRowContent({
  item,
  selected,
  active,
  onSelect,
  href,
  onOpen,
  actions,
  onReconcile,
  ...props
}: WorkItemPresentationProps) {
  const { t } = useI18n()
  return (
    <article
      className={styles.row}
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
        <WorkItemTitle
          item={item}
          href={href}
          onOpen={onOpen}
          active={active}
          className={styles.title}
        />
        {actions}
      </div>
      <WorkItemProperties {...props} item={item} layout="row" />
      <WorkItemMutationNotice
        mutation={props.mutation}
        onReconcile={onReconcile}
      />
    </article>
  )
}
function WorkItemContent({
  card,
  ...props
}: WorkItemPresentationProps & { card: boolean }) {
  return card ? <WorkItemCardContent {...props} /> : <WorkItemRowContent {...props} />
}
export function WorkItemRow(props: WorkItemPresentationProps) {
  return <WorkItemContent {...props} card={false} />
}
export function WorkItemCard(props: WorkItemPresentationProps) {
  return <WorkItemContent {...props} card />
}
