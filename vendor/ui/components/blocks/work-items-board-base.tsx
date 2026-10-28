"use client"
import { useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { GripVertical } from "lucide-react"
import { Button } from "../ui/button"
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "../ui/popover"
import { GroupHeader, GroupBody, type GroupedListProps } from "./grouped-list"
import type { BoardMove, GroupSnapshot } from "../../lib/grouped-items-model"
import { useI18n } from "../../lib/i18n-provider"
import styles from "./work-items-board-base.module.css"
export type BoardProps<T> = GroupedListProps<T> & {
  queryKey: string
  manualOrder?: boolean
  allowAppend?: boolean
  canMove?: (item: T, sourceGroup: string, targetGroup: string) => boolean
  onMove?: (intent: BoardMove) => void
  getItemRevision?: (item: T) => number
  getItemLabel: (item: T) => string
  announcement?: string
}
export function BoardColumn({
  children,
  group,
  collapsed,
  header,
}: {
  children: ReactNode
  group: GroupSnapshot
  collapsed: boolean
  header: ReactNode
}) {
  return (
    <section
      className={styles.column}
      data-board-group={group.key}
      data-collapsed={collapsed}
      aria-label={group.label}
    >
      {header}
      {!collapsed && children}
    </section>
  )
}
export function BoardItem({
  children,
  id,
  dragging,
  controls,
}: {
  children: ReactNode
  id: string
  dragging?: boolean
  controls?: ReactNode
}) {
  return (
    <li
      className={styles.item}
      data-board-item={id}
      data-dragging={dragging || undefined}
    >
      {children}
      {controls}
    </li>
  )
}
/** Business-independent controlled board. Only the caller can confirm a write. */
export function Board<T>({
  groups,
  items,
  getItemId,
  getItemLabel,
  getItemRevision,
  renderItem,
  collapsedGroupIds = [],
  onToggleGroup,
  onCreateInGroup,
  onLoadMore,
  onRetryGroup,
  queryKey,
  manualOrder = true,
  allowAppend = false,
  canMove,
  onMove,
  announcement,
  className,
}: BoardProps<T>) {
  const { t } = useI18n()
  const root = useRef<HTMLDivElement>(null)
  const drag = useRef<{ id: string; key: string; revision?: number } | null>(
    null,
  )
  const focusItem = useRef<{ id: string; target: string } | null>(null)
  useLayoutEffect(() => {
    if (!focusItem.current || document.activeElement !== document.body) return
    const card = root.current?.querySelector<HTMLElement>(
      `[data-board-item="${CSS.escape(focusItem.current.id)}"]`,
    )
    const button = card?.querySelector<HTMLElement>(
      "[data-move-handle], a, button",
    )
    button?.focus()
    if (
      card?.closest<HTMLElement>("[data-board-group]")?.dataset.boardGroup ===
      focusItem.current.target
    )
      focusItem.current = null
  })
  const [dragging, setDragging] = useState<string | null>(null)
  const [target, setTarget] = useState<string | null>(null)
  const byId = new Map(items.map((item) => [getItemId(item), item]))
  function cancel() {
    drag.current = null
    setDragging(null)
    setTarget(null)
  }
  function send(
    item: T,
    source: GroupSnapshot,
    destination: GroupSnapshot,
    placement: Pick<BoardMove, "beforeId" | "afterId" | "append"> = {},
    baseRevision = getItemRevision?.(item),
  ) {
    if (
      !onMove ||
      !canMove?.(item, source.key, destination.key) ||
      collapsedGroupIds.includes(destination.key) ||
      (!manualOrder && source.key === destination.key)
    )
      return
    if (
      manualOrder &&
      !placement.beforeId &&
      !placement.afterId &&
      destination.hasMore &&
      !allowAppend
    )
      return
    focusItem.current = { id: getItemId(item), target: destination.key }
    onMove({
      itemId: getItemId(item),
      baseRevision,
      sourceGroup: source.key,
      targetGroup: destination.key,
      queryKey,
      ...placement,
      ...(!placement.beforeId &&
      !placement.afterId &&
      destination.hasMore &&
      allowAppend
        ? { append: true }
        : {}),
    })
  }
  return (
    <div
      ref={root}
      className={`${styles.board} ${className ?? ""}`}
      onKeyDown={(e) => {
        if (e.key === "Escape") cancel()
      }}
    >
      <p className="sr-only" role="status">
        {announcement}
      </p>
      {groups.map((group) => {
        const collapsed = collapsedGroupIds.includes(group.key)
        return (
          <div
            key={group.key}
            data-drop-target={target === group.key || undefined}
          >
            <BoardColumn
              group={group}
              collapsed={collapsed}
              header={
                <GroupHeader
                  group={group}
                  collapsed={collapsed}
                  onToggle={
                    onToggleGroup ? () => onToggleGroup(group.key) : undefined
                  }
                  onCreate={
                    onCreateInGroup
                      ? () => onCreateInGroup(group.key)
                      : undefined
                  }
                />
              }
            >
              <GroupBody
                group={group}
                onLoadMore={onLoadMore ? () => onLoadMore(group) : undefined}
                onRetry={onRetryGroup ? () => onRetryGroup(group) : undefined}
              >
                <ul className={styles.items}>
                  {[...new Set(group.itemIds)].map((id, index) => {
                    const item = byId.get(id)
                    if (!item) return null
                    const destinations = groups.filter(
                      (g) =>
                        g.key !== group.key &&
                        !collapsedGroupIds.includes(g.key) &&
                        canMove?.(item, group.key, g.key) &&
                        (!manualOrder || !g.hasMore || allowAppend),
                    )
                    const reorder =
                      manualOrder && canMove?.(item, group.key, group.key)
                    const movable =
                      !!onMove && (destinations.length > 0 || reorder)
                    return (
                      <BoardItem
                        key={id}
                        id={id}
                        dragging={dragging === id}
                        controls={
                          movable && (
                            <div className={styles.controls}>
                              <Button
                                className={styles.handle}
                                data-move-handle
                                variant="ghost"
                                size="icon"
                                aria-label={t("workItems.drag", {
                                  name: getItemLabel(item),
                                })}
                                onPointerDown={(e) => {
                                  if (e.button !== 0) return
                                  e.preventDefault()
                                  e.currentTarget.focus()
                                  e.currentTarget.setPointerCapture(e.pointerId)
                                  drag.current = {
                                    id,
                                    key: queryKey,
                                    revision: getItemRevision?.(item),
                                  }
                                  setDragging(id)
                                }}
                                onPointerCancel={cancel}
                                onPointerMove={(e) => {
                                  if (!drag.current) return
                                  const column = document
                                    .elementFromPoint(e.clientX, e.clientY)
                                    ?.closest<HTMLElement>("[data-board-group]")
                                  setTarget(
                                    column && root.current?.contains(column)
                                      ? (column.dataset.boardGroup ?? null)
                                      : null,
                                  )
                                }}
                                onPointerUp={(e) => {
                                  if (
                                    drag.current?.id === id &&
                                    drag.current.key === queryKey
                                  ) {
                                    const element = document.elementFromPoint(
                                      e.clientX,
                                      e.clientY,
                                    )
                                    const column =
                                      element?.closest<HTMLElement>(
                                        "[data-board-group]",
                                      )
                                    const destination = groups.find(
                                      (g) =>
                                        g.key === column?.dataset.boardGroup,
                                    )
                                    if (
                                      destination &&
                                      column &&
                                      root.current?.contains(column)
                                    ) {
                                      const card =
                                        element?.closest<HTMLElement>(
                                          "[data-board-item]",
                                        )
                                      const neighbor = card?.dataset.boardItem
                                      send(
                                        item,
                                        group,
                                        destination,
                                        manualOrder &&
                                          neighbor &&
                                          neighbor !== id
                                          ? e.clientY <
                                            card!.getBoundingClientRect().top +
                                              card!.getBoundingClientRect()
                                                .height /
                                                2
                                            ? { beforeId: neighbor }
                                            : { afterId: neighbor }
                                          : {},
                                        drag.current.revision,
                                      )
                                    }
                                  }
                                  cancel()
                                }}
                              >
                                <GripVertical size={14} />
                              </Button>
                              <Popover>
                                <PopoverTrigger
                                  render={
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      aria-label={t("workItems.moveNamed", {
                                        name: getItemLabel(item),
                                      })}
                                    />
                                  }
                                >
                                  {t("workItems.move")}
                                </PopoverTrigger>
                                <PopoverContent>
                                  <div className={styles.commands}>
                                    {destinations.map((g) => (
                                      <Button
                                        key={g.key}
                                        variant="ghost"
                                        onClick={() => send(item, group, g)}
                                      >
                                        {t("workItems.moveTo", {
                                          group: g.label,
                                        })}
                                      </Button>
                                    ))}
                                    {reorder && (
                                      <>
                                        <Button
                                          variant="ghost"
                                          disabled={index === 0}
                                          onClick={() =>
                                            send(item, group, group, {
                                              beforeId:
                                                group.itemIds[index - 1],
                                            })
                                          }
                                        >
                                          {t("workItems.moveUp")}
                                        </Button>
                                        <Button
                                          variant="ghost"
                                          disabled={
                                            index === group.itemIds.length - 1
                                          }
                                          onClick={() =>
                                            send(item, group, group, {
                                              afterId: group.itemIds[index + 1],
                                            })
                                          }
                                        >
                                          {t("workItems.moveDown")}
                                        </Button>
                                      </>
                                    )}
                                  </div>
                                </PopoverContent>
                              </Popover>
                            </div>
                          )
                        }
                      >
                        {renderItem(item, group)}
                      </BoardItem>
                    )
                  })}
                </ul>
              </GroupBody>
            </BoardColumn>
          </div>
        )
      })}
    </div>
  )
}
