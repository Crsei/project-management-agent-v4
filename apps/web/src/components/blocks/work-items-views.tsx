import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"
import { GroupedList, type GroupedListProps } from "./grouped-list"
import { Board } from "./work-items-board-base"
import {
  WorkItemRow,
  WorkItemCard,
  WorkItemMutationNotice,
  type WorkItemPresentationProps,
} from "./work-item"
import { WorkItemProperties } from "./work-item-properties"
import { DataTable, type DataTableSort } from "./data-table"
import { Button } from "../ui/button"
import type { BoardMove } from "../../lib/grouped-items-model"
import type {
  WorkItemRecord,
  WorkItemsInteraction,
  WorkItemsHierarchy,
  WorkItemsLaneSnapshot,
} from "../../lib/work-items-model"
import { indexWorkItemHierarchy } from "../../lib/work-items-view"
import { DataRegion } from "../ui/data-region"
import styles from "./work-items.module.css"
import { useI18n } from "../../lib/i18n-provider"
export type WorkItemsViewProps = Omit<
  GroupedListProps<WorkItemRecord>,
  "getItemId" | "renderItem"
> & {
  interaction: WorkItemsInteraction
  hierarchy?: WorkItemsHierarchy
  deferOffscreen?: boolean
  onSelectionChange?: (ids: string[]) => void
  getPresentation: (
    item: WorkItemRecord,
  ) => Omit<
    WorkItemPresentationProps,
    "item" | "selected" | "active" | "onSelect"
  >
}
function presentation(
  props: WorkItemsViewProps,
  item: WorkItemRecord,
  selected?: ReadonlySet<string>,
): WorkItemPresentationProps {
  return {
    ...props.getPresentation(item),
    item,
    selected: selected
      ? selected.has(item.id)
      : props.interaction.selectedIds.includes(item.id),
    active: props.interaction.activeItemId === item.id,
    onSelect: props.onSelectionChange
      ? (selected) => {
          const ids = new Set(props.interaction.selectedIds)
          if (selected) ids.add(item.id)
          else ids.delete(item.id)
          props.onSelectionChange?.([...ids])
        }
      : undefined,
  }
}
/** Keep the record and its controls readable; mount field editors on reveal or focus.
 * Once revealed, editors stay mounted so scrolling cannot discard an open picker.
 */
function DeferredWorkItem({
  value,
  enabled,
  card = false,
  depth = 0,
}: {
  value: WorkItemPresentationProps
  enabled?: boolean
  card?: boolean
  depth?: number
}) {
  const root = useRef<HTMLDivElement>(null)
  const [revealed, setRevealed] = useState(false)
  const ready = !enabled || revealed
  useEffect(() => {
    if (ready || !root.current) return
    if (typeof IntersectionObserver === "undefined") {
      const frame = requestAnimationFrame(() => setRevealed(true))
      return () => cancelAnimationFrame(frame)
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setRevealed(true)
          observer.disconnect()
        }
      },
      { rootMargin: "200px" },
    )
    observer.observe(root.current)
    return () => observer.disconnect()
  }, [ready])
  const Component = card ? WorkItemCard : WorkItemRow
  return (
    <div
      ref={root}
      role={
        !ready &&
        value.onPatchItem &&
        !value.onSelect &&
        !value.onOpen &&
        !value.href
          ? "group"
          : undefined
      }
      tabIndex={
        !ready &&
        value.onPatchItem &&
        !value.onSelect &&
        !value.onOpen &&
        !value.href
          ? 0
          : undefined
      }
      aria-label={
        !ready &&
        value.onPatchItem &&
        !value.onSelect &&
        !value.onOpen &&
        !value.href
          ? value.item.identifier
          : undefined
      }
      data-work-item-depth={depth}
      data-work-item-editors={ready ? "ready" : "deferred"}
      className={
        enabled ? (card ? styles.deferredCard : styles.deferred) : undefined
      }
      style={card ? undefined : { paddingInlineStart: Math.min(depth, 8) * 16 }}
      onFocusCapture={() => setRevealed(true)}
    >
      <Component
        {...value}
        onPatchItem={ready ? value.onPatchItem : undefined}
      />
    </div>
  )
}
export function WorkItemList(props: WorkItemsViewProps) {
  const { t } = useI18n()
  const hasHierarchy = !!props.hierarchy
  const { index, groupedIds } = useMemo(() => {
    const ids = new Set(props.groups.flatMap((group) => group.itemIds))
    return {
      index: indexWorkItemHierarchy(hasHierarchy ? props.items : props.items.filter((item) => ids.has(item.id))),
      groupedIds: ids,
    }
  }, [props.items, props.groups, hasHierarchy])
  const expanded = new Set(props.hierarchy?.expandedIds)
  const selected = new Set(props.interaction.selectedIds)
  const groups = props.hierarchy
    ? props.groups.map((group) => ({
        ...group,
        itemIds: group.itemIds.filter((id) => {
          let parent = index.parentById.get(id)
          while (parent) {
            if (groupedIds.has(parent)) return false
            parent = index.parentById.get(parent)
          }
          return true
        }),
      }))
    : props.groups
  return (
    <GroupedList
      {...props}
      groups={groups}
      getItemId={(item) => item.id}
      collapsedGroupIds={props.interaction.collapsedGroupIds}
      renderItem={(root) => {
        const rows: { item: WorkItemRecord; depth: number }[] = []
        const stack = [{ item: root, depth: 0 }]
        while (stack.length) {
          const row = stack.pop()!
          rows.push(row)
          if (props.hierarchy && expanded.has(row.item.id)) {
            const children = index.childrenById.get(row.item.id) ?? []
            for (let i = children.length - 1; i >= 0; i--)
              stack.push({ item: children[i], depth: row.depth + 1 })
          }
        }
        return rows.map(({ item, depth }) => {
          const p = presentation(props, item, selected)
          const children = index.childrenById.get(item.id) ?? []
          const snapshot = props.hierarchy?.children?.[item.id]
          const expandable =
            !!props.hierarchy &&
            (children.length > 0 ||
              (snapshot?.totalCount ?? 0) > 0 ||
              !!snapshot?.hasMore)
          return (
            <div key={item.id}>
              <DeferredWorkItem
                enabled={props.deferOffscreen}
                depth={depth}
                value={{
                  ...p,
                  actions: expandable ? (
                    <>
                      {p.actions}
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={t("workItems.toggleChildren", {
                          name: item.identifier,
                        })}
                        aria-expanded={expanded.has(item.id)}
                        onClick={() => {
                          const next = new Set(expanded)
                          if (next.has(item.id)) next.delete(item.id)
                          else next.add(item.id)
                          props.hierarchy?.onExpandedChange([...next])
                        }}
                      >
                        {expanded.has(item.id) ? (
                          <ChevronDown size={14} />
                        ) : (
                          <ChevronRight size={14} />
                        )}
                        {snapshot?.totalCount == null
                          ? t("workItems.loaded", { count: children.length })
                          : t("workItems.count", {
                              loaded: children.length,
                              total: snapshot.totalCount,
                            })}
                      </Button>
                    </>
                  ) : (
                    p.actions
                  ),
                }}
              />
              {expandable &&
                expanded.has(item.id) &&
                snapshot &&
                (snapshot.state !== "success" || snapshot.hasMore) && (
                  <DataRegion
                    state={snapshot.state}
                    hasContent={children.length > 0}
                    partialDescription={t("workItems.partial")}
                    emptyTitle={t("workItems.emptyGroup")}
                    error={
                      snapshot.error
                        ? {
                            category: "request",
                            message: snapshot.error,
                            reason: t("workItems.retained"),
                          }
                        : undefined
                    }
                    onRetry={
                      props.hierarchy?.onRetry
                        ? () => props.hierarchy?.onRetry?.(item)
                        : undefined
                    }
                  >
                    {snapshot.hasMore && props.hierarchy?.onLoadMore && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={snapshot.state === "loading"}
                        onClick={() => props.hierarchy?.onLoadMore?.(item)}
                      >
                        {t("dataRegion.loadMore")}
                      </Button>
                    )}
                  </DataRegion>
                )}
            </div>
          )
        })
      }}
    />
  )
}
export type WorkItemsBoardMove = BoardMove & { laneKey?: string }
export type WorkItemBoardProps = WorkItemsViewProps & {
  queryKey: string
  manualOrder?: boolean
  allowAppend?: boolean
  getGroupIcon?: (key: string) => ReactNode
  lanes?: readonly WorkItemsLaneSnapshot[]
  canMove?: (item: WorkItemRecord, source: string, target: string) => boolean
  onMove?: (intent: WorkItemsBoardMove) => void
  onCreateInLane?: (laneKey: string, groupKey: string) => void
  onLoadMoreInLane?: (
    lane: WorkItemsLaneSnapshot,
    group: WorkItemsLaneSnapshot["groups"][number],
  ) => void
  onRetryInLane?: (
    lane: WorkItemsLaneSnapshot,
    group: WorkItemsLaneSnapshot["groups"][number],
  ) => void
  announcement?: string
}
export function WorkItemBoard(props: WorkItemBoardProps) {
  const { t } = useI18n()
  const selected = new Set(props.interaction.selectedIds)
  const board = (lane?: WorkItemsLaneSnapshot) => (
    <Board
      {...props}
      groups={lane?.groups ?? props.groups}
      getItemId={(item) => item.id}
      getItemLabel={(item) => item.identifier}
      getItemRevision={(item) => item.revision}
      collapsedGroupIds={
        lane
          ? props.interaction.collapsedGroupIds
              .filter((id) => id.startsWith(`${lane.key}:`))
              .map((id) => id.slice(lane.key.length + 1))
          : props.interaction.collapsedGroupIds
      }
      onToggleGroup={
        props.onToggleGroup
          ? (key) => props.onToggleGroup?.(lane ? `${lane.key}:${key}` : key)
          : undefined
      }
      onCreateInGroup={
        lane
          ? props.onCreateInLane
            ? (key) => props.onCreateInLane?.(lane.key, key)
            : undefined
          : props.onCreateInGroup
      }
      onLoadMore={
        lane
          ? props.onLoadMoreInLane
            ? (group) => props.onLoadMoreInLane?.(lane, group)
            : undefined
          : props.onLoadMore
      }
      onRetryGroup={
        lane
          ? props.onRetryInLane
            ? (group) => props.onRetryInLane?.(lane, group)
            : undefined
          : props.onRetryGroup
      }
      onMove={
        props.onMove
          ? (intent) =>
              props.onMove?.({
                ...intent,
                ...(lane ? { laneKey: lane.key } : {}),
              })
          : undefined
      }
      renderItem={(item) => (
        <DeferredWorkItem
          enabled={props.deferOffscreen}
          card
          value={presentation(props, item, selected)}
        />
      )}
    />
  )
  return props.lanes?.length ? (
    <div>
      <p className={styles.enhancementHint}>{t("workItems.laneHint")}</p>
      {props.lanes.map((lane) => (
        <section
          key={lane.key}
          data-work-items-lane={lane.key}
          aria-label={lane.label}
        >
          <h2 className={styles.laneTitle}>{lane.label}</h2>
          {board(lane)}
        </section>
      ))}
    </div>
  ) : (
    board()
  )
}
export function WorkItemTable(
  props: WorkItemsViewProps & {
    sort?: DataTableSort
    onSortChange?: (sort: DataTableSort) => void
  },
) {
  const { t } = useI18n()
  const properties = props.items[0]
    ? props.getPresentation(props.items[0]).visibleProperties
    : []
  const labels = {
    state: t("workItems.state"),
    priority: t("workItems.priority"),
    assignees: t("workItems.assignees"),
    labels: t("workItems.labels"),
    startDate: t("workItems.startDate"),
    dueDate: t("workItems.dueDate"),
    counts: t("workItems.counts"),
  }
  return (
    <DataTable
      rows={props.items}
      caption={t("workItems.items")}
      getRowId={(item) => item.id}
      getRowLabel={(item) => item.identifier}
      selectedIds={props.interaction.selectedIds}
      onSelectionChange={props.onSelectionChange}
      activeRowId={props.interaction.activeItemId}
      sort={props.sort}
      onSortChange={props.onSortChange}
      columns={[
        {
          id: "title",
          header: t("workItems.title"),
          sortable: true,
          primary: false,
          cell: (item) => {
            const p = props.getPresentation(item)
            return (
              <>
                {p.href ? (
                  <a
                    href={p.href}
                    onClick={(event) => {
                      if (
                        p.onOpen &&
                        event.button === 0 &&
                        !event.ctrlKey &&
                        !event.metaKey &&
                        !event.shiftKey &&
                        !event.altKey
                      ) {
                        event.preventDefault()
                        p.onOpen(item)
                      }
                    }}
                  >
                    {item.identifier} · {item.title}
                  </a>
                ) : p.onOpen ? (
                  <Button variant="ghost" onClick={() => p.onOpen?.(item)}>
                    {item.identifier} · {item.title}
                  </Button>
                ) : (
                  <span>
                    {item.identifier} · {item.title}
                  </span>
                )}
                <WorkItemMutationNotice
                  mutation={p.mutation}
                  onReconcile={p.onReconcile}
                />
              </>
            )
          },
        },
        ...properties.map((property) => ({
          id: property,
          header: labels[property],
          primary: false,
          sortable: property === "priority" || property === "dueDate",
          cell: (item: WorkItemRecord) => (
            <WorkItemProperties
              {...props.getPresentation(item)}
              item={item}
              visibleProperties={[property]}
              layout="table"
            />
          ),
        })),
      ]}
    />
  )
}
