import { useLayoutEffect, useRef, type CSSProperties } from "react"
import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DataRegion } from "@/components/ui/data-region"
import {
  WorkItemList,
  WorkItemBoard,
} from "@/components/blocks/work-items-views"
import {
  WorkItemRow,
  WorkItemMutationNotice,
} from "@/components/blocks/work-item"
import {
  WorkItemProperties,
  WorkItemAssigneePicker,
} from "@/components/blocks/work-item-properties"
import { WorkItemsToolbar } from "@/components/blocks/work-items-toolbar"
import {
  GroupBody,
  GroupHeader,
} from "@/components/blocks/grouped-list"
import { WorkItemCalendar } from "@/components/blocks/work-item-calendar"
import { Timeline } from "@/components/blocks/timeline"
import { ScheduleViewControls } from "@/components/blocks/schedule-view-controls"
import {
  DataTable,
  type DataTableColumn,
} from "@/components/blocks/data-table"
import { DataTableControls } from "@/components/blocks/data-table-controls"
import {
  isMutationLocked,
  type WorkItemRecord,
  type WorkItemPatch,
} from "@/lib/work-items-model"
import {
  addScheduleDays,
  startOfScheduleWeek,
} from "@/lib/schedule-date-utils"
import { timelineViewport } from "@/lib/schedule-view-model"
import { useI18n } from "@/lib/i18n-provider"
import { PmPage } from "./presentation-page"
import {
  ControlledFeedback,
  ControlledFocus,
  ControlledMutation,
} from "./controlled-presentation"
import { IssueRelationFields } from "./issue-relations"
import type {
  ControlledIssueRecord,
  IssueCollectionViewProps,
} from "./controlled-contracts"
import listStyles from "./issues-views.module.css"
import compactStyles from "./issue-list-2.module.css"
import boardStyles from "./boards-views.module.css"
import scheduleStyles from "./schedule-views.module.css"

/** All variants consume one authoritative projection and the same host actions. */
export function IssueCollectionView(props: IssueCollectionViewProps) {
  const {
    variant,
    readModel: model,
    interaction,
    capabilities,
    actions,
  } = props
  const { locale } = useI18n()
  const text = (zh: string, en: string) => (locale === "en" ? en : zh)
  const board = variant.startsWith("board")
  const scheduled = variant === "calendar1" || variant === "gantt1"
  const loading = model.data.state === "loading" && model.items.length === 0
  const writable = capabilities.canCreate && !loading
  const records = new Map(model.items.map((item) => [item.id, item]))
  const viewportRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const node = viewportRef.current
    if (node && node.scrollLeft !== interaction.scroll.left)
      node.scrollLeft = interaction.scroll.left
    if (node && node.scrollTop !== interaction.scroll.top)
      node.scrollTop = interaction.scroll.top
  }, [interaction.scroll.left, interaction.scroll.top])
  const open = (item: WorkItemRecord) => {
    const record = records.get(item.id)
    if (record)
      actions.open(
        record,
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null,
      )
  }
  const patch = (item: WorkItemRecord, change: WorkItemPatch) => {
    const record = records.get(item.id)
    if (!record || loading || isMutationLocked(model.mutations[item.id])) return
    actions.patch(record, change)
  }
  const toggleGroup = (key: string) =>
    actions.setInteraction((previous) => ({
      ...previous,
      collapsedGroupIds: previous.collapsedGroupIds.includes(key)
        ? previous.collapsedGroupIds.filter((id) => id !== key)
        : [...previous.collapsedGroupIds, key],
    }))
  const presentation = (item: WorkItemRecord) => {
    const record = records.get(item.id)!
    const mutation = model.mutations[item.id]
    const catalog = model.getCatalog?.(record) ?? model.catalog
    return {
      catalog,
      capabilities,
      mutation,
      today: model.today,
      visibleProperties:
        variant === "list2"
          ? (["priority", "state"] as const)
          : interaction.view.visibleProperties,
      onPatchItem: patch,
      onOpen: open,
      onReconcile:
        mutation?.status === "unknown"
          ? () => actions.reconcile(item.id, mutation.operationId)
          : undefined,
      actions:
        variant === "list2" ? (
          <span className={compactStyles.rowMeta}>
            <span
              className={compactStyles.module}
              title={record.moduleIds
                .map(
                  (id) =>
                    model.catalog.modules.find((entry) => entry.id === id)
                      ?.label ?? id,
                )
                .join(", ")}
            >
              {record.moduleIds
                .map(
                  (id) =>
                    model.catalog.modules.find((entry) => entry.id === id)
                      ?.label ?? id,
                )
                .join(", ") || "—"}
            </span>
            <span className={compactStyles.chip}>
              {model.catalog.estimatePoints.find(
                (entry) => entry.id === record.estimatePointId,
              )?.label ??
                record.estimatePointId ??
                "—"}
            </span>
            <span className={compactStyles.dueDate}>
              {record.dueDate ?? "—"}
            </span>
            <WorkItemAssigneePicker
              value={record.assigneeIds}
              options={catalog.assignees}
              disabled={
                loading ||
                isMutationLocked(mutation) ||
                !capabilities.canEditField(record, "assigneeIds")
              }
              label={text(
                `负责人 ${record.identifier}`,
                `Assignees ${record.identifier}`,
              )}
              onChange={(assigneeIds) => patch(record, { assigneeIds })}
            />
          </span>
        ) : undefined,
    }
  }
  const shared = {
    items: model.items,
    groups: model.groups,
    interaction,
    getPresentation: presentation,
    onSelectionChange: (selectedIds: string[]) =>
      actions.setInteraction((previous) => ({ ...previous, selectedIds })),
    onToggleGroup: toggleGroup,
    onCreateInGroup: writable
      ? (groupKey: string) =>
          actions.create(
            { groupKey },
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null,
          )
      : undefined,
    onLoadMore: actions.loadGroup,
    onRetryGroup: actions.retryGroup,
  }
  const columns: DataTableColumn<ControlledIssueRecord>[] = [
    {
      id: "title",
      header: text("任务", "Issue"),
      primary: true,
      minWidth: 280,
      sortable: true,
      cell: (item) => (
        <span
          title={`${item.identifier} · ${item.title}`}
          className="block max-w-96 truncate"
        >
          <code className="mr-2 text-xs text-muted-foreground">
            {item.identifier}
          </code>
          {item.title}
        </span>
      ),
    },
    ...(
      [
        "state",
        "priority",
        "assignees",
        "labels",
        "startDate",
        "dueDate",
      ] as const
    ).map((property) => ({
      id: property,
      header: {
        state: text("状态", "State"),
        priority: text("优先级", "Priority"),
        assignees: text("负责人", "Assignees"),
        labels: text("标签", "Labels"),
        startDate: text("开始日期", "Start date"),
        dueDate: text("截止日期", "Due date"),
      }[property],
      sortable: property === "dueDate",
      minWidth: 140,
      cell: (item: ControlledIssueRecord) => (
        <WorkItemProperties
          item={item}
          {...presentation(item)}
          visibleProperties={[property]}
        />
      ),
    })),
    ...(["projectId", "moduleIds", "cycleId", "estimatePointId"] as const).map(
      (field) => ({
        id: field,
        header: {
          projectId: text("项目", "Project"),
          moduleIds: text("模块", "Modules"),
          cycleId: text("周期", "Cycle"),
          estimatePointId: text("估点", "Estimate"),
        }[field],
        minWidth: 140,
        cell: (item: ControlledIssueRecord) => (
          <IssueRelationFields
            item={item}
            catalog={model.catalog}
            capabilities={capabilities}
            mutation={model.mutations[item.id]}
            fields={[field]}
            onPatch={actions.patch}
          />
        ),
      }),
    ),
    {
      id: "request",
      header: text("请求", "Request"),
      cell: (item) => (
        <WorkItemMutationNotice
          mutation={model.mutations[item.id]}
          onReconcile={
            model.mutations[item.id]?.status === "unknown"
              ? () =>
                  actions.reconcile(
                    item.id,
                    model.mutations[item.id]!.operationId,
                  )
              : undefined
          }
        />
      ),
    },
  ]
  const normalViewport = timelineViewport(interaction.timeline)
  const timelineStart = startOfScheduleWeek(
    addScheduleDays(
      interaction.timeline.anchorDate,
      interaction.timeline.scale === "week" ? -7 : -28,
    ),
    interaction.timeline.weekStartsOn,
  )
  const ganttViewport = model.timelineViewport ?? {
    ...normalViewport,
    rangeStart:
      interaction.timeline.scale === "quarter"
        ? `${interaction.timeline.anchorDate.slice(0, 4)}-01-01`
        : timelineStart,
    rangeEnd:
      interaction.timeline.scale === "quarter"
        ? `${interaction.timeline.anchorDate.slice(0, 4)}-12-31`
        : addScheduleDays(
            timelineStart,
            interaction.timeline.scale === "week" ? 41 : 83,
          ),
  }
  const timelineItems = model.items.map((item) => {
    const unlocked = !loading && !isMutationLocked(model.mutations[item.id])
    const start = unlocked && capabilities.canEditField(item, "startDate")
    const end = unlocked && capabilities.canEditField(item, "dueDate")
    return {
      ...item,
      label: item.title,
      startDate: item.startDate ?? null,
      canShift: start && end && !!item.startDate && !!item.dueDate,
      canResizeStart: start,
      canResizeEnd: end,
    }
  })
  let distributionTotal: number | null = model.stateDistribution ? 0 : null
  for (const state of model.stateDistribution ?? []) {
    if (state.count.value === null) {
      distributionTotal = null
      break
    }
    distributionTotal = distributionTotal! + state.count.value
  }
  const scheduleControls = scheduled ? (
    <div className="flex flex-wrap items-center gap-2 py-2">
      {variant === "calendar1" ? (
        <ScheduleViewControls
          kind="calendar"
          value={interaction.calendar}
          today={model.today}
          onChange={(calendar) =>
            actions.setInteraction((previous) => ({ ...previous, calendar }))
          }
        />
      ) : (
        <ScheduleViewControls
          kind="timeline"
          value={interaction.timeline}
          today={model.today}
          onChange={(timeline) =>
            actions.setInteraction((previous) => ({ ...previous, timeline }))
          }
        />
      )}
    </div>
  ) : null
  return (
    <ControlledFocus surface={props}>
      <PmPage interactive={props.interactive} pageId={props.pageId ?? `pm-controlled-${variant}`}
      titleSuffix={props.titleSuffix}
      title={model.title}
      description={model.description}
      className={
        variant === "list2"
          ? `${listStyles.listPage} ${compactStyles.page}`
          : board
            ? boardStyles.root
            : variant === "calendar1"
              ? `${scheduleStyles.referencePage} ${scheduleStyles.calendarPage}`
              : variant === "gantt1"
                ? `${scheduleStyles.referencePage} ${scheduleStyles.ganttPage}`
                : variant === "spreadsheet1"
                  ? scheduleStyles.referencePage
                  : listStyles.listPage
      }
      readingPosition={props.readingPosition}
      onReadingPositionChange={props.onReadingPositionChange}
      actions={
        <Button
          data-pm-add-issue
          id={`pm-${variant}-create`}
          disabled={!writable}
          title={capabilities.reason}
          onClick={(event) => actions.create({}, event.currentTarget)}
        >
          <Plus aria-hidden="true" />
          {text("新建任务", "Add issue")}
        </Button>
      }
      toolbar={
        <>
          <WorkItemsToolbar
            catalog={model.catalog}
            view={interaction.view}
            onViewChange={(view) =>
              actions.setInteraction((previous) => ({ ...previous, view }))
            }
            extensions={props.toolbarExtension}
            enhancements={{
              swimlanes: board,
              subItems: variant === "list1",
              offscreen: !scheduled,
            }}
          />
          {scheduleControls}
          {variant === "spreadsheet1" && (
            <DataTableControls
              columns={columns.map((column) => ({
                ...column,
                label: String(column.header),
              }))}
              value={interaction.columnConfig}
              onValueChange={(columnConfig) =>
                actions.setInteraction((previous) => ({
                  ...previous,
                  columnConfig,
                }))
              }
            />
          )}
        </>
      }>
        <ControlledFeedback surface={props} />
        {variant === "board2" && (
          <section
            className={boardStyles.band}
            aria-label={text(
              "筛选任务队列指标",
              "Filtered issue cohort metrics",
            )}
            data-boards-metrics
          >
            <dl className={boardStyles.metrics}>
              {(
                [
                  ["open", text("未关闭任务", "Open issues")],
                  ["active", text("活跃任务", "Active issues")],
                  ["attention", text("需关注任务", "Needs attention")],
                  ["completion", text("完成率", "Completion rate")],
                ] as const
              ).map(([key, label]) => {
                const metric = model.cohort?.[key]
                return (
                  <div
                    key={key}
                    className="flex min-w-0 flex-col gap-2 rounded-module border p-4"
                  >
                    <dt className="text-xs text-muted-foreground">{label}</dt>
                    <dd className="text-xl font-semibold tabular-nums">
                      {metric?.value === null || metric?.value === undefined
                        ? "—"
                        : key === "completion"
                          ? `${Math.round(metric.value)}%`
                          : metric.value}
                    </dd>
                    <dd className="text-xs text-muted-foreground whitespace-normal break-words">
                      {metric?.description ??
                        text(
                          "完整队列指标不可用",
                          "Complete cohort facts unavailable",
                        )}
                    </dd>
                  </div>
                )
              })}
            </dl>
          </section>
        )}
        {variant === "board3" && (
          <section
            className={`${boardStyles.band} ${boardStyles.distribution}`}
            aria-label={text(
              "筛选任务状态分布",
              "Filtered issue state distribution",
            )}
          >
            <h2 className={boardStyles.distributionTitle}>
              {text("状态分布", "State distribution")}
            </h2>
            {model.stateDistribution ? (
              <>
                <div className={boardStyles.track} aria-hidden="true">
                  {distributionTotal !== null &&
                    distributionTotal > 0 &&
                    model.stateDistribution
                      .filter(
                        (state) =>
                          !interaction.excludedStateIds?.includes(
                            state.stateId,
                          ),
                      )
                      .map((state) => (
                        <span
                          key={state.stateId}
                          className={boardStyles.segment}
                          data-status-segment={state.stateId}
                          style={{
                            background: state.color ?? "var(--status-neutral)",
                            width: `${(state.count.value! / distributionTotal!) * 100}%`,
                          }}
                        />
                      ))}
                </div>
                <div className={boardStyles.legend}>
                  {model.stateDistribution.map((state) => (
                    <Button
                      key={state.stateId}
                      variant="ghost"
                      className={boardStyles.legendItem}
                      data-legend-status={state.stateId}
                      aria-pressed={
                        !interaction.excludedStateIds?.includes(state.stateId)
                      }
                      onClick={() =>
                        actions.setInteraction((previous) => ({
                          ...previous,
                          excludedStateIds: previous.excludedStateIds?.includes(
                            state.stateId,
                          )
                            ? previous.excludedStateIds.filter(
                                (id) => id !== state.stateId,
                              )
                            : [
                                ...(previous.excludedStateIds ?? []),
                                state.stateId,
                              ],
                        }))
                      }
                    >
                      <span
                        className={boardStyles.dot}
                        style={{
                          background: state.color ?? "var(--status-neutral)",
                        }}
                      />
                      {state.label}
                      <strong className={boardStyles.legendCount}>
                        {state.count.value ?? "—"}
                      </strong>
                    </Button>
                  ))}
                </div>
              </>
            ) : (
              <p className={boardStyles.distributionHint}>
                {text(
                  "完整状态分布不可用",
                  "Complete state distribution unavailable",
                )}
              </p>
            )}
          </section>
        )}
        <DataRegion {...model.data} hasContent={model.items.length > 0}>
          {variant === "list1" && (
            <WorkItemList
              {...shared}
              hierarchy={props.hierarchy}
              deferOffscreen={interaction.view.deferOffscreen}
            />
          )}
          {variant === "list2" && (
            <div className={compactStyles.groups}>
              {model.groups.map((group) => (
                <section
                  key={group.key}
                  className={compactStyles.group}
                  style={
                    {
                      "--group-tint":
                        model.catalog.states.find(
                          (state) => state.id === group.key,
                        )?.color ?? "var(--surface)",
                    } as CSSProperties
                  }
                >
                  <GroupHeader
                    group={group}
                    collapsed={interaction.collapsedGroupIds.includes(
                      group.key,
                    )}
                    onToggle={() => toggleGroup(group.key)}
                    onCreate={
                      shared.onCreateInGroup
                        ? () => shared.onCreateInGroup!(group.key)
                        : undefined
                    }
                  />
                  {!interaction.collapsedGroupIds.includes(group.key) && (
                    <GroupBody
                      group={group}
                      onLoadMore={
                        actions.loadGroup
                          ? () => actions.loadGroup!(group)
                          : undefined
                      }
                      onRetry={
                        actions.retryGroup
                          ? () => actions.retryGroup!(group)
                          : undefined
                      }
                    >
                      <ul>
                        {group.itemIds.map((id) => {
                          const item = records.get(id)
                          return item ? (
                            <li key={id}>
                              <WorkItemRow
                                item={item}
                                {...presentation(item)}
                                selected={interaction.selectedIds.includes(id)}
                                active={interaction.activeItemId === id}
                                onSelect={(checked) =>
                                  actions.setInteraction((previous) => ({
                                    ...previous,
                                    selectedIds: checked
                                      ? [
                                          ...new Set([
                                            ...previous.selectedIds,
                                            id,
                                          ]),
                                        ]
                                      : previous.selectedIds.filter(
                                          (entry) => entry !== id,
                                        ),
                                  }))
                                }
                              />
                            </li>
                          ) : null
                        })}
                      </ul>
                    </GroupBody>
                  )}
                </section>
              ))}
            </div>
          )}
          {board && (
            <div className={boardStyles.workArea}>
              <div
                ref={viewportRef}
                className={boardStyles.viewport}
                onScroll={(event) => {
                  const scroll = {
                    left: event.currentTarget.scrollLeft,
                    top: event.currentTarget.scrollTop,
                  }
                  actions.setInteraction((previous) => ({
                    ...previous,
                    scroll,
                  }))
                }}
              >
                <WorkItemBoard
                  {...shared}
                  className={boardStyles.board}
                  queryKey={model.queryKey}
                  manualOrder={interaction.view.sort === "manual"}
                  allowAppend
                  lanes={model.lanes}
                  onCreateInLane={
                    writable
                      ? (laneKey, groupKey) =>
                          actions.create(
                            { laneKey, groupKey },
                            document.activeElement instanceof HTMLElement
                              ? document.activeElement
                              : null,
                          )
                      : undefined
                  }
                  onLoadMoreInLane={
                    actions.loadLaneGroup ??
                    (actions.loadGroup
                      ? (_lane, group) => actions.loadGroup!(group)
                      : undefined)
                  }
                  onRetryInLane={
                    actions.retryLaneGroup ??
                    (actions.retryGroup
                      ? (_lane, group) => actions.retryGroup!(group)
                      : undefined)
                  }
                  announcement={model.announcement}
                  canMove={(item, _source, target) =>
                    !loading &&
                    !isMutationLocked(model.mutations[item.id]) &&
                    capabilities.canMove(item, target)
                  }
                  onMove={actions.move}
                  deferOffscreen={interaction.view.deferOffscreen}
                />
              </div>
              {props.inspector && (
                <aside className={boardStyles.inspector}>
                  {props.inspector}
                </aside>
              )}
            </div>
          )}
          {variant === "calendar1" && (
            <WorkItemCalendar
              {...shared}
              settings={interaction.calendar}
              onSettingsChange={(calendar) =>
                actions.setInteraction((previous) => ({
                  ...previous,
                  calendar,
                }))
              }
              today={model.today}
              queryKey={model.queryKey}
              buckets={model.buckets}
              unscheduled={model.unscheduled}
              onLoadDate={actions.loadDate}
              onRetryDate={actions.retryDate}
              onLoadUnscheduled={actions.loadUnscheduled}
              onRetryUnscheduled={actions.retryUnscheduled}
              onCreateOnDate={
                writable
                  ? (date) =>
                      actions.create(
                        { date },
                        document.activeElement instanceof HTMLElement
                          ? document.activeElement
                          : null,
                      )
                  : undefined
              }
              proposedDates={model.dateDrafts}
              onDateDraftChange={(item, dates) => {
                const record = records.get(item.id)
                if (record) actions.dateDraftChange?.(record, dates)
              }}
              onScheduleChange={actions.schedule}
            />
          )}
          {variant === "gantt1" && (
            <Timeline
              items={timelineItems}
              viewport={ganttViewport}
              scale={interaction.timeline.scale}
              today={model.today}
              queryKey={model.queryKey}
              dayWidth={
                interaction.timeline.scale === "week"
                  ? 56
                  : interaction.timeline.scale === "month"
                    ? 20
                    : 6
              }
              sidebarHeader={text("任务", "Issue")}
              renderSidebar={(item) => (
                <div className="flex min-w-0 items-center gap-2">
                  <Button
                    variant="ghost"
                    className="min-w-0 flex-1 justify-start truncate"
                    title={item.title}
                    onClick={() => open(item)}
                  >
                    {item.identifier} · {item.title}
                  </Button>
                  <WorkItemProperties
                    item={item}
                    {...presentation(item)}
                    visibleProperties={["priority", "state"]}
                  />
                </div>
              )}
              onEdit={open}
              selectedIds={interaction.selectedIds}
              activeId={interaction.activeItemId}
              getScrollPosition={() => interaction.scroll}
              onScrollPosition={(scroll) =>
                actions.setInteraction((previous) => ({ ...previous, scroll }))
              }
              onDateChange={(change) => {
                const item = records.get(change.id)
                if (
                  item &&
                  !loading &&
                  !isMutationLocked(model.mutations[item.id])
                )
                  actions.schedule({
                    ...change,
                    itemId: item.id,
                    operationId: crypto.randomUUID(),
                    baseRevision: item.revision,
                    queryKey: model.queryKey,
                  })
              }}
            />
          )}
          {variant === "spreadsheet1" && (
            <DataTable
              rows={model.items}
              columns={columns}
              columnConfig={interaction.columnConfig}
              getRowId={(item) => item.id}
              getRowLabel={(item) => item.identifier}
              caption={model.title}
              selectedIds={interaction.selectedIds}
              onSelectionChange={shared.onSelectionChange}
              activeRowId={interaction.activeItemId}
              onActivateRow={open}
              sort={interaction.tableSort}
              onSortChange={(tableSort) =>
                actions.setInteraction((previous) => ({
                  ...previous,
                  tableSort,
                }))
              }
              stickyHeader
            />
          )}
        </DataRegion>
        {Object.values(model.mutations)
          .filter(
            (mutation) =>
              mutation?.status === "pending" || mutation?.status === "unknown",
          )
          .map(
            (mutation) =>
              mutation && (
                <section
                  key={mutation.operationId}
                  className="mt-3 border-t pt-3"
                  aria-label={text("待确认请求", "Pending request")}
                >
                  <p className="text-xs">
                    {records.get(mutation.itemId)?.identifier ??
                      mutation.itemId}
                  </p>
                  <ControlledMutation
                    mutation={mutation}
                    reconcile={(operationId) =>
                      actions.reconcile(mutation.itemId, operationId)
                    }
                  />
                </section>
              ),
          )}
        {!board && props.inspector}
        {props.createDialog}
      </PmPage>
    </ControlledFocus>
  )
}
