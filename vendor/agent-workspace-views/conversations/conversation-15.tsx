"use client"
import { ChevronLeft, ChevronRight } from "lucide-react"
import {
  Area,
  AreaChart,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import { useMemo } from "react"
import type {
  ColumnDef,
  OnChangeFn,
  RowSelectionState,
} from "@tanstack/react-table"
import { ConversationDataTable } from "./data-table"
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui"
import type { SupportTicket } from "./conversation-15-fixtures"
import { ThreadMessage, ThreadView, ThreadPanel } from "./shared"
import type { ComposerHost } from "../composer-workspace-view"
import type { Conversation15Controller } from "./conversation-15-controller"
export function Conversation15View({
  controller,
  host,
}: {
  controller: Conversation15Controller
  host: ComposerHost
}) {
  const { label, copy } = controller
  const selectedCases = controller.tickets.filter((ticket) =>
    controller.selectedTickets.includes(ticket.id),
  )
  const criticalCount = selectedCases.reduce(
    (count, ticket) => count + (ticket.risk >= 85 ? 1 : 0),
    0,
  )
  const targetLabel = (value: string) =>
    value === "today-17"
      ? label("今天 17:00", "Today, 5:00 PM")
      : value === "today-18"
        ? label("今天 18:00", "Today, 6:00 PM")
        : label("明天 09:00", "Tomorrow, 9:00 AM")
  const rowSelection = useMemo<RowSelectionState>(
    () =>
      Object.fromEntries(controller.selectedTickets.map((id) => [id, true])),
    [controller.selectedTickets],
  )
  const onRowSelectionChange: OnChangeFn<RowSelectionState> = (update) =>
    controller.setSelectedTickets((previous) => {
      const current: RowSelectionState = Object.fromEntries(
        previous.map((id) => [id, true]),
      )
      const next = typeof update === "function" ? update(current) : update
      return Object.keys(next).filter((id) => next[id])
    })
  const columns: ColumnDef<SupportTicket, unknown>[] = [
    {
      id: "account",
      accessorKey: "account",
      header: label("账户 / 工单", "Account / Case"),
      cell: ({ row }) => (
        <span className="whitespace-normal">
          {row.original.account}
          <br />
          <span className="text-xs text-muted-foreground">
            {row.original.id} · {copy(row.original.subject)}
          </span>
        </span>
      ),
    },
    {
      id: "risk",
      accessorKey: "risk",
      header: label("风险", "Risk"),
      cell: ({ row }) => row.original.risk,
    },
    {
      id: "owner",
      accessorKey: "owner",
      header: label("负责人 / 目标", "Owner / Target"),
      cell: ({ row }) => (
        <span>
          {row.original.owner ?? label("未分派", "Unassigned")}
          {row.original.responseTarget && (
            <>
              <br />
              {targetLabel(row.original.responseTarget)}
            </>
          )}
        </span>
      ),
    },
  ]
  return (
    <ThreadView
      page="conversation-15"
      controller={controller}
      host={host}
      afterInput={
        controller.selectedId === "conversation-15" ? (
          <p className="mt-2 text-xs text-muted-foreground">
            {label(
              "支持工作区 · 积压快照 184 个工单 · 本地演示",
              "Support workspace · Backlog snapshot 184 cases · Local demo",
            )}
          </p>
        ) : undefined
      }
      inputOptions={{
        placeholder: {
          "zh-CN": "请求其他视图或调整分派…",
          en: "Ask for another view or change the assignment…",
        },
      }}
      renderMessage={(message) => (
        <ThreadMessage
          message={message}
          controller={controller}
          agentRole={
            message.role === "assistant"
              ? label("运营分析员", "Operations analyst")
              : undefined
          }
        >
          {message.id === "conversation-15-answer" && (
            <>
              <ThreadPanel
                title={label("洞察", "Insights") + " · 3"}
                actions={
                  <>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={label("上一洞察", "Previous insight")}
                      disabled={controller.insight === 0}
                      onClick={() =>
                        controller.setInsight((value) => value - 1)
                      }
                    >
                      <ChevronLeft />
                    </Button>
                    <span className="text-xs">{controller.insight + 1}/3</span>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={label("下一洞察", "Next insight")}
                      disabled={controller.insight === 2}
                      onClick={() =>
                        controller.setInsight((value) => value + 1)
                      }
                    >
                      <ChevronRight />
                    </Button>
                  </>
                }
              >
                <section
                  hidden={controller.insight !== 0}
                  aria-label={label("账户 SLA 风险", "Account SLA risk")}
                >
                  <p>
                    <strong>Helio Freight</strong>{" "}
                    {label(
                      "本周风险持续上升，以 92 分位列第一。",
                      "now ranks first at 92 after pressure rose all week.",
                    )}
                  </p>
                  <div className="my-4 grid grid-cols-2 gap-3">
                    {controller.tickets.slice(0, 2).map((ticket) => (
                      <div
                        key={ticket.id}
                        className="rounded-control border p-3"
                      >
                        <div className="flex justify-between">
                          <strong>{ticket.account}</strong>
                          <strong>{ticket.risk}</strong>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {ticket.id} · {label("严重", "Critical")}
                        </p>
                      </div>
                    ))}
                  </div>
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>{label("风险压力", "Risk pressure")}</span>
                    <span>{label("过去 7 天", "Last 7 days")}</span>
                  </div>
                  <div
                    className="mt-2 h-36"
                    role="img"
                    aria-label={label(
                      "七天风险趋势：Helio 66→92，Northline 71→87",
                      "Seven-day risk: Helio 66 to 92; Northline 71 to 87",
                    )}
                  >
                    {controller.active && controller.insight === 0 && (
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={controller.trend}>
                          <YAxis domain={[50, 100]} hide />
                          <XAxis
                            dataKey="day"
                            axisLine={false}
                            tickLine={false}
                            tick={{
                              fill: "var(--muted-foreground)",
                              fontSize: 12,
                            }}
                          />
                          <Tooltip
                            contentStyle={{
                              background: "var(--background)",
                              borderColor: "var(--border)",
                              color: "var(--foreground)",
                            }}
                          />
                          <Legend wrapperStyle={{ fontSize: 12 }} />
                          <Line
                            type="monotone"
                            dataKey="helio"
                            name="Helio Freight"
                            stroke="var(--destructive)"
                            strokeWidth={2}
                            dot={false}
                            isAnimationActive={false}
                          />
                          <Line
                            type="monotone"
                            dataKey="northline"
                            name="Northline Labs"
                            stroke="var(--warning)"
                            strokeWidth={2}
                            dot={false}
                            isAnimationActive={false}
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    )}
                  </div>
                  <Button
                    variant="outline"
                    className="mt-2"
                    onClick={() => controller.setInsight(1)}
                  >
                    {label("积压如何变化？", "How did the backlog change?")}
                  </Button>
                </section>
                <section
                  hidden={controller.insight !== 1}
                  aria-label={label("积压变化", "Backlog change")}
                >
                  <p>
                    {label("积压在周一达到", "The backlog peaked at")}{" "}
                    <strong>{label("193 的峰值", "193 on Monday")}</strong>
                    {label("，目前恢复至 184。", " and has recovered to 184.")}
                  </p>
                  <div className="mt-4 rounded-control border p-3">
                    <p className="font-medium">
                      {label("周一新增高峰", "Monday intake spike")}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {label(
                        "积压正在恢复，尚未清零",
                        "Backlog is recovering, not cleared",
                      )}
                    </p>
                    <p className="mt-2 text-xl font-semibold">
                      193{" "}
                      <span className="text-xs font-normal text-muted-foreground">
                        {label("峰值 · 七天恢复", "peak · 7-day recovery")}
                      </span>
                    </p>
                    <div
                      className="h-36"
                      role="img"
                      aria-label={label(
                        "七天积压：193、191、190、188、189、188、184",
                        "Seven-day backlog: 193, 191, 190, 188, 189, 188, 184",
                      )}
                    >
                      {controller.active && controller.insight === 1 && (
                        <ResponsiveContainer width="100%" height="100%">
                          <AreaChart data={controller.trend}>
                            <YAxis domain={[160, 200]} hide />
                            <XAxis
                              dataKey="day"
                              axisLine={false}
                              tickLine={false}
                              tick={{
                                fill: "var(--muted-foreground)",
                                fontSize: 12,
                              }}
                            />
                            <Tooltip
                              contentStyle={{
                                background: "var(--surface)",
                                borderColor: "var(--border)",
                                color: "var(--foreground)",
                              }}
                            />
                            <Area
                              dataKey="backlog"
                              name={label("未结工单", "Open cases")}
                              type="monotone"
                              stroke="var(--primary)"
                              fill="var(--selection)"
                              strokeWidth={2}
                              isAnimationActive={false}
                            />
                          </AreaChart>
                        </ResponsiveContainer>
                      )}
                    </div>
                    <div className="flex justify-between text-sm">
                      <span>{label("184 个未结工单", "184 open")}</span>
                      <span>{label("今日 −4", "−4 today")}</span>
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    className="mt-3"
                    onClick={() => controller.setInsight(2)}
                  >
                    {label(
                      "谁负责紧急工单？",
                      "Who should own the urgent cases?",
                    )}
                  </Button>
                </section>
                <section
                  hidden={controller.insight !== 2}
                  aria-label={label("紧急工单负责人", "Urgent ownership")}
                >
                  <p>
                    {label(
                      "三个紧急工单需要明确负责人和响应目标。",
                      "Three urgent cases still need one accountable owner and a response target.",
                    )}
                  </p>
                  <div className="my-3 flex items-center justify-between">
                    <strong>{label("紧急工单归属", "Urgent ownership")}</strong>
                    <span className="text-xs">
                      {controller.selectedTickets.length}{" "}
                      {label("已选", "selected")} · {criticalCount}{" "}
                      {label("严重", "critical")} /{" "}
                      {selectedCases.length - criticalCount}{" "}
                      {label("高", "high")}
                    </span>
                  </div>
                  <Input
                    aria-label={label("筛选支持工单", "Filter support tickets")}
                    value={controller.filterText}
                    onChange={(event) =>
                      controller.setFilterText(event.target.value)
                    }
                  />
                  <ConversationDataTable
                    data={controller.filtered}
                    columns={columns}
                    locale={controller.locale}
                    getRowId={(ticket) => ticket.id}
                    getRowLabel={(ticket) => ticket.id + " " + ticket.account}
                    rowSelection={rowSelection}
                    onRowSelectionChange={onRowSelectionChange}
                    activeRowId={controller.ticketId}
                    onActivateRow={(ticket) =>
                      controller.setTicketId(ticket.id)
                    }
                    caption={label("本地工单", "Local cases")}
                    rowHeaderColumnId="account"
                  />
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Select
                      value={controller.owner}
                      onValueChange={controller.setOwner}
                    >
                      <SelectTrigger
                        aria-label={label("选择负责人", "Choose owner")}
                      >
                        <SelectValue
                          placeholder={label("选择负责人", "Choose owner")}
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {["Maya Chen", "Jordan Lee", "Support"].map((owner) => (
                          <SelectItem key={owner} value={owner}>
                            {owner}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select
                      value={controller.responseTarget}
                      onValueChange={(value) => {
                        if (value) controller.setResponseTarget(value)
                      }}
                    >
                      <SelectTrigger
                        aria-label={label("响应目标", "Response target")}
                      >
                        <SelectValue>
                          {targetLabel(controller.responseTarget)}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {["today-17", "today-18", "tomorrow-09"].map(
                          (value) => (
                            <SelectItem key={value} value={value}>
                              {targetLabel(value)}
                            </SelectItem>
                          ),
                        )}
                      </SelectContent>
                    </Select>
                    <Button
                      disabled={
                        controller.unknown ||
                        !controller.owner ||
                        !controller.selectedTickets.length
                      }
                      onClick={controller.assign}
                    >
                      {label("分派", "Assign")}{" "}
                      {controller.selectedTickets.length}{" "}
                      {label("个工单 · 本地", "cases · Local")}
                    </Button>
                  </div>
                  {controller.unknown && (
                    <div role="alert" className="mt-3">
                      <p>
                        {label(
                          "分派结果未知，先对账；不会自动重放。",
                          "Assignment unknown; reconcile first. No automatic replay.",
                        )}
                      </p>
                      <Button variant="outline" onClick={controller.reconcile}>
                        {label(
                          "检查分派示例状态",
                          "Check assignment example status",
                        )}
                      </Button>
                    </div>
                  )}
                  {controller.notice && (
                    <p role="status" className="mt-3 text-xs">
                      {label(
                        "所选工单的本地分派已更新；真实支持系统未写入。",
                        "Local assignment updated; the real support system was not changed.",
                      )}
                    </p>
                  )}
                </section>
              </ThreadPanel>
              <p className="mt-3 text-sm text-muted-foreground">
                {label(
                  "查看风险比较与积压变化，然后在最后一页分派紧急工单。",
                  "Move through the risk comparison and backlog change, then assign urgent cases from the final view.",
                )}
              </p>
            </>
          )}
        </ThreadMessage>
      )}
    />
  )
}
