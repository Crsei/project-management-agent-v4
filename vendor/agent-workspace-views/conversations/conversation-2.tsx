"use client"
import { useSyncExternalStore } from "react"
import { Check, Circle, FileText, Folder } from "lucide-react"
import { ToolActivity } from "./tool-activity"
import { Badge, Button } from "./ui"
import { Markdown } from "./markdown"
import type { ComposerHost } from "../composer-workspace-view"
import { ThreadActivity, ThreadMessage, ThreadView } from "./shared"
import type { Conversation2Controller } from "./conversation-2-controller"
const subscribeHydration = () => () => {}
const clientHydrated = () => true
const serverHydrated = () => false
export function Conversation2View({
  controller,
  host,
}: {
  controller: Conversation2Controller
  host: ComposerHost
}) {
  const { label, calls } = controller
  const hydrated = useSyncExternalStore(
    subscribeHydration,
    clientHydrated,
    serverHydrated,
  )
  const audit = calls.find((call) => call.id === "density-audit")
  const completed = audit?.status === "completed"
  const steps = [
    label(
      "比较商品、订单、库存和客户表格",
      "Compared catalog, orders, inventory and customer tables",
    ),
    label(
      "测量行高、列数和操作密度",
      "Measured row heights, column count and action density",
    ),
    label(
      "检查桌面与平板宽度下的扫描路径",
      "Checked scan paths at desktop and tablet widths",
    ),
    label(
      "审阅键盘焦点与选择行为",
      "Reviewed keyboard focus and selection behavior",
    ),
    completed
      ? label("完成密度审阅", "Finished density audit")
      : audit?.outcome === "unknown"
        ? label(
            "审阅结果未知 · 先查询，不重放",
            "Audit outcome unknown · Query first, never replay",
          )
        : audit?.status === "failed"
          ? label(
              "密度审阅失败 · 本地场景",
              "Density audit failed · Local scenario",
            )
          : audit?.status === "cancelled"
            ? label(
                "密度审阅已取消 · 本地场景",
                "Density audit cancelled · Local scenario",
              )
            : audit?.status === "running"
              ? label(
                  "密度审阅进行中 · 本地场景",
                  "Density audit running · Local scenario",
                )
              : label(
                  "等待审阅结果 · 本地场景",
                  "Awaiting audit outcome · Local scenario",
                ),
  ]
  const toolRecords = (
    <fieldset
      disabled={!hydrated || !controller.active}
      className="min-w-0 space-y-3"
    >
      <legend className="sr-only">
        {label("本地工具活动", "Local tool activity")}
      </legend>
      {calls.map((call) => (
        <ToolActivity
          key={call.id}
          record={call}
          locale={controller.locale}
          actions={
            <>
              {call.status === "running" && (
                <>
                  <Button
                    variant="outline"
                    onClick={() => controller.cancel(call.id)}
                  >
                    {label("取消本地示例", "Cancel local example")}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => controller.advance(call.id)}
                  >
                    {label("推进完成示例", "Advance example to completion")}
                  </Button>
                </>
              )}
              {call.status === "failed" && call.outcome !== "unknown" && (
                <Button
                  variant="outline"
                  onClick={() => controller.retry(call.id)}
                >
                  {label("重试本地示例", "Retry local example")}
                </Button>
              )}
              {call.outcome === "unknown" && (
                <Button
                  variant="outline"
                  onClick={() => controller.reconcile(call.id)}
                >
                  {label("查询本地结果", "Query local outcome")}
                </Button>
              )}
            </>
          }
        />
      ))}
    </fieldset>
  )
  return (
    <ThreadView
      page="conversation-2"
      controller={controller}
      host={host}
      inputOptions={{ showContextReferences: true }}
      afterInput={
        controller.selectedId === "conversation-2" && (
          <div className="flex gap-4 text-xs text-text-secondary">
            <span className="flex items-center gap-2">
              <Folder size={14} />
              {label("商务工作区", "Commerce workspace")}
            </span>
            <span className="flex items-center gap-2">
              <FileText size={14} />
              {label("商品表格", "Product tables")}
            </span>
          </div>
        )
      }
      renderMessage={(message) => {
        const answer = message.id === "conversation-2-answer"
        return (
          <ThreadMessage
            message={message}
            controller={controller}
            author={answer ? "EasyuseUI AI" : undefined}
            agentRole={answer ? label("UI Agent", "UI agent") : undefined}
            hideContent={answer && !completed}
            activity={
              answer && (
                <>
                  <Markdown
                    locale={controller.locale}
                    content={label(
                      "我先审阅访问最频繁的表格模式，再比较筛选、选择和行操作同时出现时，各种密度的表现。",
                      "I audited the highest-traffic table patterns first, then compared how each density behaves when filters, selection and row actions are present.",
                    )}
                  />
                  <ThreadActivity
                    title={label("工作耗时", "Worked for")}
                    elapsed="3m 38s"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span>{label("已搜索", "Searched")}</span>
                      {[
                        label("商品目录", "Product catalog"),
                        label("订单", "Orders"),
                        label("库存", "Inventory"),
                        label("客户", "Customers"),
                      ].map((table) => (
                        <Badge variant="secondary" key={table}>
                          {table}
                        </Badge>
                      ))}
                    </div>
                    <ol className="space-y-3 border-l pl-4">
                      {steps.map((step, index) => (
                        <li key={step} className="flex items-center gap-2">
                          {completed || index < 2 ? (
                            <Check size={14} aria-hidden="true" />
                          ) : (
                            <Circle size={14} aria-hidden="true" />
                          )}
                          <span>{step}</span>
                        </li>
                      ))}
                    </ol>
                    <p className="text-xs text-text-muted">
                      {label(
                        "固定本地审阅记录；没有执行真实搜索或测量。",
                        "Fixed local audit records; no real search or measurement was executed.",
                      )}
                    </p>
                  </ThreadActivity>
                  {!completed && toolRecords}
                </>
              )
            }
          >
            {answer && completed && (
              <details className="my-4 text-xs text-text-secondary">
                <summary className="cursor-pointer">
                  {label("本地工具记录详情", "Local tool record details")}
                </summary>
                <div className="mt-3">{toolRecords}</div>
              </details>
            )}
          </ThreadMessage>
        )
      }}
    />
  )
}
