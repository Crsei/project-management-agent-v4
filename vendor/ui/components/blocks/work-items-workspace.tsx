"use client"
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { WorkItemTimeline } from "./work-item-timeline"
import { WorkItemCalendar } from "./work-item-calendar"
import { ScheduleViewControls } from "./schedule-view-controls"
import type { WorkItemsScheduleProps } from "./work-items-schedule"
import { normalizeTimeline, normalizeCalendar } from "../../lib/schedule-view-model"
import { WorkspaceShell } from "./workspace-shell"
import { WorkItemsToolbar } from "./work-items-toolbar"
import {
  WorkItemList,
  WorkItemBoard,
  WorkItemTable,
  type WorkItemsViewProps,
  type WorkItemBoardProps,
} from "./work-items-views"
import { WorkItemDetail } from "./work-item-detail"
import { DataRegion, type DataRegionProps } from "../ui/data-region"
import { Button } from "../ui/button"
import { Checkbox } from "../ui/checkbox"
import type {
  WorkItemCatalog,
  WorkItemRecord,
  WorkItemsViewState,
} from "../../lib/work-items-model"
import { hierarchyVisibleIds } from "../../lib/work-items-view"
import {
  WorkItemsBatchActions,
  WorkItemsSavedViews,
  type WorkItemsBatchActionsProps,
  type WorkItemsSavedViewsProps,
} from "./work-items-enhancements"
import { useI18n } from "../../lib/i18n-provider"
import styles from "./work-items.module.css"
export type WorkItemsWorkspaceProps = WorkItemsViewProps & {
  catalog: WorkItemCatalog
  view: WorkItemsViewState
  onViewChange: (view: WorkItemsViewState) => void
  title: ReactNode
  sidebar: ReactNode
  headerAction?: ReactNode
  notes?: ReactNode
  queryKey: string
  activeItem?: WorkItemRecord | null
  onCloseItem: () => void
  data?: Omit<DataRegionProps, "children" | "hasContent">
  onMove?: WorkItemBoardProps["onMove"]
  lanes?: WorkItemBoardProps["lanes"]
  onCreateInLane?: WorkItemBoardProps["onCreateInLane"]
  onLoadMoreInLane?: WorkItemBoardProps["onLoadMoreInLane"]
  onRetryInLane?: WorkItemBoardProps["onRetryInLane"]
  batchActions?: Omit<WorkItemsBatchActionsProps, "selectedIds" | "catalog">
  savedViews?: Omit<WorkItemsSavedViewsProps, "view">
  canMove?: (item: WorkItemRecord, source: string, target: string) => boolean
  schedule?: Omit<WorkItemsScheduleProps, "queryKey"> & { today: string }
  announcement?: string
}
export function WorkItemsWorkspace(props: WorkItemsWorkspaceProps) {
  const { t } = useI18n()
  const container = useRef<HTMLDivElement>(null)
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    if (!container.current) return
    const observer = new ResizeObserver(([entry]) =>
      setNarrow(entry.contentRect.width < 1280),
    )
    observer.observe(container.current)
    return () => observer.disconnect()
  }, [])
  const scheduleScroll = useRef({ top: 0, left: 0 })
  const scroll = useRef<HTMLDivElement>(null)
  const positions = useRef<Record<string, { top: number; left: number }>>({})
  const returnFocus = useRef<string | null>(null)
  const previousLayout = useRef(props.view.layout)
  useLayoutEffect(() => {
    if (props.interaction.activeItemId || !returnFocus.current) return
    const id = CSS.escape(returnFocus.current)
    const target =
      container.current?.querySelector<HTMLElement>(
        `[data-work-item="${id}"] a, [data-work-item="${id}"] button, [data-row-id="${id}"] a`,
      ) ??
      container.current?.querySelector<HTMLElement>(
        "[role=radio][data-checked]",
      )
    target?.focus()
    returnFocus.current = null
  })
  function closeItem() {
    returnFocus.current = props.interaction.activeItemId
    props.onCloseItem()
  }
  useLayoutEffect(() => {
    const position = positions.current[props.view.layout] ?? { top: 0, left: 0 }
    scroll.current?.scrollTo(position.left, position.top)
    if (previousLayout.current !== props.view.layout) {
      document
        .querySelector<HTMLElement>(`[role="radio"][data-checked]`)
        ?.focus()
      previousLayout.current = props.view.layout
    }
  }, [props.view.layout])
  function changeView(view: WorkItemsViewState) {
    if (scroll.current)
      positions.current[props.view.layout] = {
        top: scroll.current.scrollTop,
        left: scroll.current.scrollLeft,
      }
    props.onViewChange(view)
  }
  const groupIds =
    props.view.layout === "board" && props.lanes?.length
      ? props.lanes.flatMap((lane) =>
          lane.groups
            .filter(
              (g) =>
                !props.interaction.collapsedGroupIds.includes(
                  `${lane.key}:${g.key}`,
                ),
            )
            .flatMap((g) => g.itemIds),
        )
      : props.groups
          .filter((g) => !props.interaction.collapsedGroupIds.includes(g.key))
          .flatMap((g) => g.itemIds)
  const loadedGroupIds = new Set(props.groups.flatMap((group) => group.itemIds))
  const visibleIds =
    props.view.layout === "timeline"
      ? new Set(
          props.schedule?.range?.queryKey === props.queryKey
            ? props.schedule.range.itemIds
            : props.items.map((item) => item.id),
        )
      : props.view.layout === "calendar"
        ? new Set(
            (props.schedule?.buckets ?? [])
              .filter((b) => b.queryKey === props.queryKey)
              .flatMap((b) => b.itemIds),
          )
        : props.view.layout === "table"
          ? new Set(props.items.map((item) => item.id))
          : props.view.layout === "list" &&
              props.view.showSubItems &&
              props.hierarchy
            ? hierarchyVisibleIds(
                groupIds,
                props.items.filter((item) => loadedGroupIds.has(item.id)),
                props.hierarchy.expandedIds,
              )
            : new Set(groupIds)
  const selected = new Set(props.interaction.selectedIds)
  const chosen = [...visibleIds].filter((id) => selected.has(id)).length
  const hidden = props.interaction.selectedIds.filter(
    (id) => !visibleIds.has(id),
  ).length
  const catalog = props.catalog
  const detail = props.activeItem ? (
    <WorkItemDetail
      {...props.getPresentation(props.activeItem)}
      item={props.activeItem}
    />
  ) : (
    <p className="p-4">{t("workItems.notFound")}</p>
  )
  return (
    <div ref={container} className={styles.workspace}>
      <WorkspaceShell
        className={styles.workspace}
        title={
          <div className={styles.head}>
            <h1>{props.title}</h1>
            {props.headerAction}
          </div>
        }
        sidebar={props.sidebar}
        defaultSidebarCollapsed={false}
        inspector={props.interaction.activeItemId ? detail : undefined}
        inspectorTitle={props.activeItem?.identifier ?? t("workItems.notFound")}
        inspectorOpen={!!props.interaction.activeItemId}
        onInspectorOpenChange={(open) => {
          if (!open) closeItem()
        }}
        inspectorOverlayOpen={narrow && !!props.interaction.activeItemId}
        onInspectorOverlayOpenChange={(open) => {
          if (!open) closeItem()
        }}
        toolbar={
          catalog && (
            <WorkItemsToolbar
              view={props.view}
              onViewChange={changeView}
              catalog={catalog}
              enhancements={{
                swimlanes: props.lanes !== undefined,
                subItems: !!props.hierarchy,
                offscreen: true,
              }}
              extensions={
                props.savedViews ? (
                  <WorkItemsSavedViews
                    {...props.savedViews}
                    view={props.view}
                  />
                ) : undefined
              }
            />
          )
        }
        bottomPanel={props.notes}
        defaultBottomPanelOpen={false}
      >
        <div className={styles.view}>
          <div className={styles.summary}>
            {props.onSelectionChange && (
              <Checkbox
                aria-label={t("workItems.selectVisible")}
                checked={visibleIds.size > 0 && chosen === visibleIds.size}
                indeterminate={chosen > 0 && chosen < visibleIds.size}
                disabled={!visibleIds.size}
                onCheckedChange={(checked) => {
                  const ids = new Set(props.interaction.selectedIds)
                  for (const id of visibleIds) {
                    if (checked) ids.add(id)
                    else ids.delete(id)
                  }
                  props.onSelectionChange?.([...ids])
                }}
              />
            )}
            <span>
              {t("workItems.selection", {
                selected: props.interaction.selectedIds.length,
                hidden,
              })}
            </span>
            {!!props.interaction.selectedIds.length && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => props.onSelectionChange?.([])}
              >
                {t("workItems.clearSelection")}
              </Button>
            )}
            <span role="status">{props.announcement}</span>
          </div>
          {props.batchActions && (
            <WorkItemsBatchActions
              {...props.batchActions}
              selectedIds={props.interaction.selectedIds}
              catalog={catalog}
            />
          )}
          {props.view.layout === "board" &&
            props.view.subGroupBy &&
            props.view.subGroupBy !== "none" &&
            !props.lanes?.length && (
              <p className={styles.enhancementHint}>
                {t("workItems.lanesUnavailable")}
              </p>
            )}
          {props.view.showSubItems && props.view.layout !== "list" && (
            <p className={styles.enhancementHint}>
              {t("workItems.flatViewHint")}
            </p>
          )}
          {(props.view.layout === "timeline" ||
            props.view.layout === "calendar") && (
            <>
              <p className={styles.enhancementHint}>
                {t("schedule.groupHint")}
              </p>
              {props.view.layout === "timeline" ? (
                <ScheduleViewControls
                  kind="timeline"
                  value={normalizeTimeline(props.view.timeline)}
                  today={props.schedule?.today ?? "2026-10-09"}
                  onChange={(timeline) =>
                    changeView({ ...props.view, timeline })
                  }
                />
              ) : (
                <ScheduleViewControls
                  kind="calendar"
                  value={normalizeCalendar(props.view.calendar)}
                  today={props.schedule?.today ?? "2026-10-09"}
                  onChange={(calendar) =>
                    changeView({ ...props.view, calendar })
                  }
                />
              )}
            </>
          )}
          <div
            className={styles.scroll}
            ref={scroll}
            data-work-items-scroll={props.view.layout}
          >
            <DataRegion
              {...props.data}
              state={
                props.data?.state ?? (props.items.length ? "success" : "empty")
              }
              hasContent={props.items.length > 0}
              emptyTitle={props.data?.emptyTitle ?? t("workItems.noItems")}
              emptyDescription={
                props.data?.emptyDescription ?? t("workItems.noItemsHint")
              }
            >
              {props.view.layout === "list" ? (
                <WorkItemList
                  {...props}
                  hierarchy={
                    props.view.showSubItems ? props.hierarchy : undefined
                  }
                  deferOffscreen={props.view.deferOffscreen}
                />
              ) : props.view.layout === "board" ? (
                <WorkItemBoard
                  {...props}
                  manualOrder={props.view.sort === "manual"}
                  deferOffscreen={props.view.deferOffscreen}
                />
              ) : props.view.layout === "timeline" ? (
                <WorkItemTimeline
                  getScrollPosition={() => scheduleScroll.current}
                  onScrollPosition={(position) => {
                    scheduleScroll.current = position
                  }}
                  {...props}
                  {...props.schedule}
                  onReorder={
                    props.view.sort === "manual"
                      ? props.schedule?.onReorder
                      : undefined
                  }
                  settings={normalizeTimeline(props.view.timeline)}
                  today={props.schedule?.today ?? "2026-10-09"}
                />
              ) : props.view.layout === "calendar" ? (
                <WorkItemCalendar
                  {...props}
                  {...props.schedule}
                  settings={normalizeCalendar(props.view.calendar)}
                  onSettingsChange={(calendar) =>
                    changeView({ ...props.view, calendar })
                  }
                  today={props.schedule?.today ?? "2026-10-09"}
                />
              ) : (
                <WorkItemTable
                  {...props}
                  sort={
                    props.view.sort === "manual"
                      ? null
                      : {
                          columnId: props.view.sort,
                          direction: props.view.sortDirection,
                        }
                  }
                  onSortChange={(sort) =>
                    changeView({
                      ...props.view,
                      sort:
                        sort?.columnId === "title" ||
                        sort?.columnId === "dueDate" ||
                        sort?.columnId === "priority"
                          ? sort.columnId
                          : "manual",
                      sortDirection: sort?.direction ?? "asc",
                    })
                  }
                />
              )}
            </DataRegion>
          </div>
        </div>
      </WorkspaceShell>
    </div>
  )
}
