"use client"
import type { ReactNode } from "react"
import { ChevronDown, ChevronRight, Plus } from "lucide-react"
import { Button } from "../ui/button"
import { DataRegion } from "../ui/data-region"
import { useI18n } from "../../lib/i18n-provider"
import type { GroupSnapshot } from "../../lib/grouped-items-model"
import styles from "./grouped-list.module.css"
export type GroupHeaderProps = {
  group: GroupSnapshot
  collapsed?: boolean
  onToggle?: () => void
  onCreate?: () => void
}
export function GroupHeader({
  group,
  collapsed,
  onToggle,
  onCreate,
}: GroupHeaderProps) {
  const { t } = useI18n()
  return (
    <header className={styles.header}>
      {onToggle ? (
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={!collapsed}
          onClick={onToggle}
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}{" "}
          {group.label}
        </Button>
      ) : (
        <h3>{group.label}</h3>
      )}
      <span className={styles.count}>
        {group.totalCount == null
          ? t("workItems.loaded", { count: group.loadedCount })
          : t("workItems.count", {
              loaded: group.loadedCount,
              total: group.totalCount,
            })}
      </span>
      {onCreate && (
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("workItems.createIn", { group: group.label })}
          onClick={onCreate}
        >
          <Plus size={14} />
        </Button>
      )}
    </header>
  )
}
export type GroupedListProps<T> = {
  groups: readonly GroupSnapshot[]
  items: readonly T[]
  getItemId: (item: T) => string
  renderItem: (item: T, group: GroupSnapshot) => ReactNode
  collapsedGroupIds?: readonly string[]
  onToggleGroup?: (key: string) => void
  onCreateInGroup?: (key: string) => void
  onLoadMore?: (group: GroupSnapshot) => void
  onRetryGroup?: (group: GroupSnapshot) => void
  className?: string
}
export function GroupBody({
  group,
  children,
  onLoadMore,
  onRetry,
}: {
  group: GroupSnapshot
  children: ReactNode
  onLoadMore?: () => void
  onRetry?: () => void
}) {
  const { t } = useI18n()
  return (
    <DataRegion
      state={group.dataState}
      hasContent={group.loadedCount > 0}
      emptyTitle={t("workItems.emptyGroup")}
      emptyDescription={t("workItems.emptyGroupHint")}
      partialDescription={t("workItems.partial")}
      error={
        group.error
          ? {
              category: "request",
              message: group.error,
              reason: t("workItems.retained"),
            }
          : undefined
      }
      onRetry={onRetry}
    >
      {children}
      {group.hasMore && onLoadMore && (
        <Button variant="ghost" size="sm" onClick={onLoadMore}>
          {t("dataRegion.loadMore")}
        </Button>
      )}
    </DataRegion>
  )
}
export function GroupedList<T>({
  groups,
  items,
  getItemId,
  renderItem,
  collapsedGroupIds = [],
  onToggleGroup,
  onCreateInGroup,
  onLoadMore,
  onRetryGroup,
  className,
}: GroupedListProps<T>) {
  const byId = new Map(items.map((item) => [getItemId(item), item]))
  return (
    <div className={className}>
      {groups.map((group) => (
        <section
          key={group.key}
          className={styles.group}
          aria-label={group.label}
        >
          <GroupHeader
            group={group}
            collapsed={collapsedGroupIds.includes(group.key)}
            onToggle={
              onToggleGroup ? () => onToggleGroup(group.key) : undefined
            }
            onCreate={
              onCreateInGroup ? () => onCreateInGroup(group.key) : undefined
            }
          />
          {!collapsedGroupIds.includes(group.key) && (
            <GroupBody
              group={group}
              onLoadMore={onLoadMore ? () => onLoadMore(group) : undefined}
              onRetry={onRetryGroup ? () => onRetryGroup(group) : undefined}
            >
              <ul className={styles.list}>
                {[...new Set(group.itemIds)].map((id) => {
                  const item = byId.get(id)
                  return item ? (
                    <li key={id}>{renderItem(item, group)}</li>
                  ) : null
                })}
              </ul>
            </GroupBody>
          )}
        </section>
      ))}
    </div>
  )
}
