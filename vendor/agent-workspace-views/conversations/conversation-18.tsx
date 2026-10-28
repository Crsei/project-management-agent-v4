"use client"
import type {
  ColumnDef,
  RowSelectionState,
  SortingState,
} from "@tanstack/react-table"
import { TableProperties, RefreshCw } from "lucide-react"
import { ConversationDataTable } from "./data-table"
import { Button, Input, Checkbox } from "./ui"
import { ThreadMessage, ThreadView, ThreadPanel } from "./shared"
import type { ComposerHost } from "../composer-workspace-view"
import type { Conversation18Controller } from "./conversation-18-controller"
import type { ComponentRecord } from "./conversation-18-fixtures"
export function Conversation18View({
  controller,
  host,
}: {
  controller: Conversation18Controller
  host: ComposerHost
}) {
  const { label, copy } = controller
  const definitions = [
    {
      id: "name",
      title: label("组件", "Component"),
      cell: (row: ComponentRecord) => copy(row.name),
    },
    {
      id: "surfaces",
      title: label("界面", "Surfaces"),
      cell: (row: ComponentRecord) => row.surfaces,
    },
    {
      id: "changed",
      title: label("最后变更", "Last changed"),
      cell: (row: ComponentRecord) => copy(row.changed),
    },
    {
      id: "confidence",
      title: label("发布信心", "Release confidence"),
      cell: (row: ComponentRecord) =>
        label(
          {
            Ready: "就绪",
            "In review": "审阅中",
            "Needs owner": "需负责人",
            Blocked: "阻塞",
          }[row.confidence],
          row.confidence,
        ),
    },
    {
      id: "source",
      title: label("来源", "Source"),
      cell: (row: ComponentRecord) => row.source,
    },
    ...(controller.notesAdded
      ? [
          {
            id: "notes",
            title: label("发布说明", "Release notes"),
            cell: (row: ComponentRecord) => copy(row.notes),
          },
        ]
      : []),
  ]
  const columns: ColumnDef<ComponentRecord, unknown>[] = definitions.map(
    (column) => ({
      id: column.id,
      header: column.title,
      accessorFn: column.cell,
      cell: ({ row }) => column.cell(row.original),
      sortingFn: (left, right, id) =>
        String(left.getValue(id)).localeCompare(String(right.getValue(id))),
      sortDescFirst: false,
      enableMultiSort: false,
      minSize: 100,
      maxSize: 480,
    }),
  )
  const sorting: SortingState = controller.sort
    ? [
        {
          id: controller.sort.columnId,
          desc: controller.sort.direction === "desc",
        },
      ]
    : []
  const rowSelection: RowSelectionState = Object.fromEntries(
    controller.selectedRecords.map((id) => [id, true]),
  )
  const content = (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <p className="text-sm">
        {label("24 条记录 · 发布准备度", "24 records · release readiness")}
      </p>
      <div className="flex flex-wrap gap-2">
        <Input
          aria-label={label("筛选组件", "Filter components")}
          value={controller.filterText}
          onChange={(event) => controller.setFilterText(event.target.value)}
          placeholder={label("筛选组件", "Filter components")}
        />
        <Button
          variant="outline"
          onClick={() => controller.setPropertiesOpen((value) => !value)}
          aria-expanded={controller.propertiesOpen}
        >
          <TableProperties aria-hidden="true" />
          {label("配置属性", "Configure properties")}
        </Button>
        <Button variant="outline" onClick={controller.refresh}>
          <RefreshCw aria-hidden="true" />
          {label("刷新生成值", "Refresh generated values")}
        </Button>
        <Button
          variant="outline"
          disabled={controller.notesAdded}
          onClick={controller.addNotes}
        >
          {label("添加发布说明列", "Add release-notes column")}
        </Button>
      </div>
      {controller.propertiesOpen && (
        <fieldset className="flex flex-wrap gap-3 rounded-control border p-3">
          <legend className="text-sm">
            {label("可见属性", "Visible properties")}
          </legend>
          {definitions.map((column) => (
            <label key={column.id} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={!controller.hiddenColumns.includes(column.id)}
                onCheckedChange={(value) =>
                  controller.setHiddenColumns((previous) =>
                    value === true
                      ? previous.filter((id) => id !== column.id)
                      : [...previous, column.id],
                  )
                }
              />
              {column.title}
            </label>
          ))}
        </fieldset>
      )}
      <ConversationDataTable
        className="min-h-0 flex-1"
        data={controller.rows}
        columns={columns}
        locale={controller.locale}
        columnLabels={Object.fromEntries(
          definitions.map((column) => [column.id, column.title]),
        )}
        columnVisibility={Object.fromEntries(
          definitions.map((column) => [
            column.id,
            !controller.hiddenColumns.includes(column.id),
          ]),
        )}
        columnSizing={controller.widths}
        onColumnSizingChange={(update) => {
          const next =
            typeof update === "function" ? update(controller.widths) : update
          for (const [id, width] of Object.entries(next)) {
            if (width !== controller.widths[id])
              controller.setColumnWidth(id, width)
          }
        }}
        getRowId={(row) => row.id}
        getRowLabel={(row) => copy(row.name)}
        caption={label(
          "组件清单 · 本地固定记录",
          "Component inventory · local fixed records",
        )}
        sorting={sorting}
        onSortingChange={(update) =>
          controller.setSort((previous) => {
            const current: SortingState = previous
              ? [{ id: previous.columnId, desc: previous.direction === "desc" }]
              : []
            const next = typeof update === "function" ? update(current) : update
            return next[0]
              ? {
                  columnId: next[0].id,
                  direction: next[0].desc ? "desc" : "asc",
                }
              : null
          })
        }
        rowSelection={rowSelection}
        onRowSelectionChange={(update) =>
          controller.setSelectedRecords((previous) => {
            const current: RowSelectionState = Object.fromEntries(
              previous.map((id) => [id, true]),
            )
            const next = typeof update === "function" ? update(current) : update
            return Object.keys(next).filter((id) => next[id])
          })
        }
        selectable
        resizeColumns
        stickyHeader
        emptyMessage={label("没有匹配的组件", "No matching components")}
      />
      <p role="status" className="text-xs text-muted-foreground">
        {label(
          "固定数据，不连接组件库服务 · 刷新版本",
          "Fixed data, no component service · refresh revision",
        )}{" "}
        {controller.generation}
      </p>
    </div>
  )
  return (
    <ThreadView
      page="conversation-18"
      controller={controller}
      host={host}
      title={{
        "zh-CN": "自适应组件工作区",
        en: "Adaptive component workspace",
      }}
      layout={controller.panelOpen ? "workbench" : "conversation"}
      resource={{
        title: label("组件清单", "Component inventory"),
        content,
        controller,
        side: "left",
      }}
      inputOptions={{
        placeholder: { "zh-CN": "添加清单上下文", en: "Add inventory context" },
      }}
      renderMessage={(message) => (
        <ThreadMessage
          message={message}
          controller={controller}
          author={
            message.role === "assistant"
              ? label("组件审阅员", "Component reviewer")
              : undefined
          }
          agentRole={
            message.id === "conversation-18-answer"
              ? label("清单", "Inventory")
              : undefined
          }
        >
          {message.id === "conversation-18-answer" && (
            <ThreadPanel>
              <p className="font-medium">
                {controller.panelOpen
                  ? label("组件清单已打开", "Component inventory is open")
                  : label("找到 24 条组件记录", "24 component records found")}
              </p>
              <p className="my-2 text-sm text-muted-foreground">
                {label(
                  "5 项需负责人 · 6 项审阅中 · 2 项阻塞",
                  "5 need an owner · 6 in review · 2 blocked",
                )}
              </p>
              <Button
                variant="outline"
                onClick={() => controller.setPanelOpen((value) => !value)}
              >
                {controller.panelOpen
                  ? label("关闭工作区", "Close workspace")
                  : label("打开工作区", "Open workspace")}
              </Button>
            </ThreadPanel>
          )}
        </ThreadMessage>
      )}
    />
  )
}
