"use client"
import { useI18n } from "../../lib/i18n-provider"

import { memo, useCallback, useId, useState, type ReactNode } from "react"
import { Activity, ChevronRight } from "lucide-react"
import { RuntimeStatusBadge } from "../ui/runtime-status-badge"
import { Button } from "../ui/button"
import { DataRegion, type DataRegionProps } from "../ui/data-region"
import { useFollowTail } from "../../lib/use-follow-tail"
import { cn } from "../../lib/utils"
import styles from "./activity-timeline.module.css"

export type ActivityEvent = {
  id: string
  time: string
  agent?: string
  type: string
  action: string
  target?: string
  status: string
  duration?: string
  tokens?: number
  details?: ReactNode
}
export type ActivityTimelineProps = {
  /** Opt-in browser offscreen layout deferral; records remain in the DOM. */
  deferOffscreen?: boolean
  /** Advance on every append, history edit, deletion, reorder or state change. */
  revision?: string | number
  events: ActivityEvent[]
  selectedId?: string
  onSelect?: (event: ActivityEvent) => void
  compact?: boolean
  data?: Omit<DataRegionProps, "children" | "hasContent">
  className?: string
}
export function ActivityTimeline({
  deferOffscreen = false,
  events,
  revision,
  selectedId,
  onSelect,
  compact,
  data,
  className,
}: ActivityTimelineProps) {
  const { t } = useI18n()

  const id = useId()
  const [expanded, setExpanded] = useState<string[]>([])
  const toggleExpanded = useCallback(
    (id: string) =>
      setExpanded((current) =>
        current.includes(id)
          ? current.filter((value) => value !== id)
          : [...current, id],
      ),
    [],
  )
  const expandedIds = new Set(expanded)
  // Map keeps the first source position and the latest payload for each ID.
  const unique = [...new Map(events.map((event) => [event.id, event])).values()]
  const {
    ref: scrollRef,
    unread,
    onScroll,
    jumpToLatest,
  } = useFollowTail(
    unique.map((event) => event.id),
    revision ??
      JSON.stringify(
        unique.map((event) => [
          event.id,
          event.time,
          event.agent,
          event.type,
          event.action,
          event.target,
          event.status,
          event.duration,
          event.tokens,
        ]),
      ),
    false,
  )
  return (
    <div
      className={cn(styles.timeline, className)}
      data-compact={Boolean(compact)}
    >
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className={styles.scroll}
        aria-label={t("activityTimeline.activityTimeline")}
        tabIndex={0}
      >
        <DataRegion
          state={unique.length ? "success" : "empty"}
          emptyTitle={t("activityTimeline.noEventsInThisRange")}
          emptyDescription={t(
            "activityTimeline.adjustTheTimeRangeOrFiltersToView",
          )}
          rowHeight={compact ? 40 : 56}
          {...data}
          hasContent={unique.length > 0}
        >
          <ol
            className={styles.list}
            data-defer-offscreen={deferOffscreen || undefined}
            data-follow-tail-list
          >
            {unique.map((event) => (
              <ActivityRow
                key={event.id}
                event={event}
                open={expandedIds.has(event.id)}
                selected={selectedId === event.id}
                onSelect={onSelect}
                onToggle={toggleExpanded}
                id={id}
              />
            ))}
          </ol>
        </DataRegion>
      </div>
      {unread > 0 && (
        <Button size="sm" variant="secondary" onClick={jumpToLatest}>
          {unread} {t("activityTimeline.newEventsJumpToLatest")}
        </Button>
      )}
    </div>
  )
}

const ActivityRow = memo(function ActivityRow({
  event,
  open,
  selected,
  onSelect,
  onToggle,
  id,
}: {
  event: ActivityEvent
  open: boolean
  selected: boolean
  onSelect?: ActivityTimelineProps["onSelect"]
  onToggle: (id: string) => void
  id: string
}) {
  const { t } = useI18n()
  const content = (
    <>
      <time className={styles.time}>{event.time}</time>
      <span className={styles.agent}>{event.agent ?? "—"}</span>
      <span className={styles.action}>
        <Activity size={16} aria-hidden="true" />
        <span>
          <span>{event.action}</span>
          <small>
            {event.type}
            {event.target && ` · ${event.target}`}
          </small>
        </span>
      </span>
      <span className={styles.status}>
        <RuntimeStatusBadge status={event.status} />
      </span>
      <span className={styles.duration}>{event.duration ?? "—"}</span>
      <span className={styles.tokens}>{event.tokens ?? "—"}</span>
    </>
  )
  return (
    <li
      data-event-id={event.id}
      data-follow-tail-id={event.id}
      data-selected={selected}
    >
      <div className={styles.row}>
        {onSelect ? (
          <button
            type="button"
            className={styles.main}
            aria-label={`${event.action} ${event.id}`}
            aria-pressed={selected}
            onClick={() => onSelect(event)}
          >
            {content}
          </button>
        ) : (
          <div className={styles.main}>{content}</div>
        )}
        {event.details !== undefined && (
          <Button
            className={styles.expand}
            variant="ghost"
            size="icon-sm"
            aria-label={t("common.valueEventValue", {
              value0: open ? t("common.hide") : t("common.expand"),
              value1: event.action,
            })}
            aria-expanded={open}
            aria-controls={`${id}-${event.id}`}
            onClick={() => onToggle(event.id)}
          >
            <ChevronRight size={16} data-open={open} />
          </Button>
        )}
      </div>
      {open && (
        <div id={`${id}-${event.id}`} className={styles.details}>
          <dl>
            <div>
              <dt>Agent</dt>
              <dd>{event.agent ?? "—"}</dd>
            </div>
            <div>
              <dt>Target</dt>
              <dd>{event.target ?? "—"}</dd>
            </div>
            <div>
              <dt>Duration</dt>
              <dd>{event.duration ?? "—"}</dd>
            </div>
            <div>
              <dt>Tokens</dt>
              <dd>{event.tokens ?? "—"}</dd>
            </div>
          </dl>
          {event.details}
        </div>
      )}
    </li>
  )
})
