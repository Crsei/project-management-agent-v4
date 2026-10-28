"use client"
import { useId, useRef } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Progress,
  Button,
  Field,
  FieldLabel,
  FieldError,
  Textarea,
} from "./ui"
import { Markdown } from "./markdown"
import { ThreadMessage, ThreadView, ThreadPanel } from "./shared"
import type { ComposerHost } from "../composer-workspace-view"
import type { Conversation20Controller } from "./conversation-20-controller"
export function Conversation20View({
  controller,
  host,
}: {
  controller: Conversation20Controller
  host: ComposerHost
}) {
  const { label, copy } = controller
  const summaryId = useId()
  const errorId = useId()
  const dialogReturnFocus = useRef<HTMLElement | null>(null)
  const restoreDialogFocus = (event: Event) => {
    event.preventDefault()
    if (
      !controller.active ||
      controller.previewOpen ||
      controller.usageOpen ||
      controller.archiveOpen
    )
      return
    if (dialogReturnFocus.current?.isConnected)
      dialogReturnFocus.current.focus()
    else controller.focusComposer()
  }
  const number = (value: number) =>
    value === 0 ? "0" : (value / 1000).toFixed(1).replace(/\.0$/, "") + "k"
  const usage = number(controller.used) + " / " + number(controller.limit)
  const remaining = number(controller.limit - controller.used)
  const percent = Math.round((controller.used / controller.limit) * 100)
  const warning =
    controller.phase === "warning" || controller.phase === "unknown"
  return (
    <>
      <ThreadView
        page="conversation-20"
        title={{
          "zh-CN": "上下文压缩与续接",
          en: "Context compaction and continuation",
        }}
        controller={controller}
        host={host}
        headerActions={
          <Button
            variant="ghost"
            aria-label={`${usage} · ${percent}% · ${label("查看上下文用量详情", "View context usage details")}`}
            aria-expanded={controller.usageOpen}
            onClick={(event) => {
              dialogReturnFocus.current = event.currentTarget
              controller.setUsageOpen(true)
            }}
          >
            {usage} · {percent}%
          </Button>
        }
        inputOptions={{
          placeholder: { "zh-CN": "添加上下文", en: "Add context" },
          trailingTools: (
            <Button
              variant="ghost"
              size="sm"
              onClick={(event) => {
                dialogReturnFocus.current = event.currentTarget
                controller.setUsageOpen(true)
              }}
            >
              {number(controller.used)}{" "}
              {label("Token · 固定快照", "tokens · fixture")}
            </Button>
          ),
        }}
        beforeInput={
          controller.selectedId === "conversation-20" &&
          controller.phase === "compacted" && (
            <div role="status" className="mb-2 flex flex-wrap gap-2 text-xs">
              <span>
                {label(
                  "本地摘要已应用，原历史已归档，可以续接。",
                  "Local summary applied; original history archived. Continue here.",
                )}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={(event) => {
                  dialogReturnFocus.current = event.currentTarget
                  controller.setArchiveOpen(true)
                }}
              >
                {label("读取原始归档", "Read original archive")}
              </Button>
            </div>
          )
        }
        renderMessage={(message) => (
          <ThreadMessage
            message={message}
            controller={controller}
            author={message.role === "assistant" ? "EasyuseUI AI" : undefined}
            agentRole={
              message.role === "assistant"
                ? label("迁移 Agent", "Migration agent")
                : undefined
            }
          >
            {message.id === "conversation-20-answer" && warning && (
              <ThreadPanel
                title={label(
                  "上下文窗口接近上限",
                  "Context window nearly full",
                )}
              >
                <div className="flex justify-between text-sm">
                  <span>{usage}</span>
                  <span>
                    {remaining} {label("Token 剩余", "tokens remaining")}
                  </span>
                </div>
                <Progress
                  value={controller.used}
                  max={controller.limit}
                  aria-label={label("固定上下文用量", "Fixed context usage")}
                />
                <p className="my-2 text-xs text-muted-foreground">
                  {label("自动压缩阈值", "Auto-compact at")}{" "}
                  {controller.usage.threshold}% ·{" "}
                  {label(
                    "仅提示，不自动执行",
                    "informational, never automatically applied",
                  )}
                </p>
                <p className="mb-3 text-sm">
                  {label(
                    "准确审阅哪些内容会保留",
                    "Review exactly what will remain",
                  )}
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    onClick={(event) => {
                      dialogReturnFocus.current = event.currentTarget
                      controller.setUsageOpen(true)
                    }}
                  >
                    {label("审阅上下文", "Review context")}
                  </Button>
                  <Button
                    onClick={controller.openPreview}
                    disabled={controller.phase === "unknown"}
                  >
                    {label("现在压缩", "Compact now")}
                  </Button>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  {label(
                    "数字均为固定 fixture，并非实时 Token 计算或模型调用。",
                    "All numbers are fixed fixtures, not live token calculation or model calls.",
                  )}
                </p>
                {controller.phase === "unknown" && (
                  <div role="alert" className="mt-2">
                    <p>
                      {label(
                        "结果未知；保留历史与草稿，检查后再应用，不自动重试。",
                        "Outcome unknown; history and draft retained. Check before applying, no automatic retry.",
                      )}
                    </p>
                    <Button variant="outline" onClick={controller.reconcile}>
                      {label("检查压缩状态", "Check compaction status")}
                    </Button>
                  </div>
                )}
              </ThreadPanel>
            )}
          </ThreadMessage>
        )}
      />
      <Dialog
        open={controller.usageOpen && controller.active}
        onOpenChange={controller.setUsageOpen}
      >
        <DialogContent onCloseAutoFocus={restoreDialogFocus}>
          <DialogTitle>{label("上下文用量", "Context usage")}</DialogTitle>
          <DialogDescription>
            5.6 Sol · {number(controller.limit)}{" "}
            {label("上限 · 固定快照", "limit · fixed snapshot")}
          </DialogDescription>
          <Progress
            value={controller.used}
            max={controller.limit}
            aria-label={label("固定上下文用量", "Fixed context usage")}
            aria-valuetext={percent + "%"}
          />
          {controller.phase !== "compacted" &&
            controller.usage.roles.map((role) => (
              <div
                key={role.name.en}
                className="flex justify-between border-b py-2 text-sm"
              >
                <span>{copy(role.name)}</span>
                <span>
                  {number(role.tokens)} ·{" "}
                  {((role.tokens / controller.usage.before) * 100).toFixed(1)}%
                </span>
              </div>
            ))}
          <p className="my-3 text-sm">
            {remaining}{" "}
            {label("剩余 · 自动压缩阈值", "remaining · auto-compact threshold")}{" "}
            {controller.usage.threshold}%
          </p>
          <h3 className="font-medium">
            {label("压缩后保留", "Keep through compaction")}
          </h3>
          {controller.retained.map((item) => (
            <div className="border-b py-2" key={item.title.en}>
              <strong className="text-sm font-medium">
                {copy(item.title)}
              </strong>
              <p className="text-sm text-muted-foreground">
                {copy(item.detail)}
              </p>
            </div>
          ))}
          <div className="mt-4 flex gap-2">
            <Button
              variant="outline"
              onClick={() => controller.setUsageOpen(false)}
            >
              {label("关闭", "Close")}
            </Button>
            <Button
              disabled={controller.phase !== "warning"}
              onClick={controller.openPreview}
            >
              {label("现在压缩", "Compact now")}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                controller.setUsageOpen(false)
                controller.setArchiveOpen(true)
              }}
            >
              {label("读取原始归档", "Read original archive")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={controller.previewOpen && controller.active}
        onOpenChange={controller.setPreviewOpen}
      >
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            if (!controller.active) return
            const target = controller.finalFocus.current
            if (controller.phase !== "compacted" && target?.isConnected)
              target.focus()
            else controller.focusComposer()
          }}
        >
          <DialogTitle>
            {label("压缩交接摘要", "Compaction handoff summary")}
          </DialogTitle>
          <DialogDescription>
            {label(
              "核对决定、活动文件、约束和待办。编辑后明确应用本地摘要，保留最近消息、原始归档和草稿；不调用模型、服务或 Shell。",
              "Review decisions, active files, constraints, and open tasks. Edit and explicitly apply the local summary; recent turns, original archive, and draft remain. No model, service, or shell call.",
            )}
          </DialogDescription>
          <form
            className="mt-4 space-y-3"
            onSubmit={(event) => {
              event.preventDefault()
              controller.apply()
            }}
          >
            <Field data-invalid={!!controller.error}>
              <FieldLabel htmlFor={summaryId}>
                {label("交接摘要", "Handoff summary")}
              </FieldLabel>
              <Textarea
                id={summaryId}
                required
                rows={10}
                aria-invalid={!!controller.error}
                aria-describedby={controller.error ? errorId : undefined}
                value={controller.summaryText}
                onChange={(event) =>
                  controller.setSummaryText(event.target.value)
                }
              />
              {controller.error && (
                <FieldError id={errorId}>{copy(controller.error)}</FieldError>
              )}
            </Field>
            <div className="flex gap-2">
              <Button
                type="submit"
                disabled={
                  controller.phase !== "warning" ||
                  !controller.summaryText.trim()
                }
              >
                {label("应用本地压缩示例", "Apply local compaction example")}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => controller.setPreviewOpen(false)}
              >
                {label("取消", "Cancel")}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={controller.archiveOpen && controller.active}
        onOpenChange={controller.setArchiveOpen}
      >
        <DialogContent onCloseAutoFocus={restoreDialogFocus}>
          <DialogTitle>
            {label("原始上下文归档", "Original context archive")}
          </DialogTitle>
          <DialogDescription>
            {label(
              "本地固定历史完整保留；归档只读，不恢复或重放操作。",
              "Local fixture history retained in full; read-only archive, no restoration or replay.",
            )}
          </DialogDescription>
          <div className="mt-4 max-h-[55vh] space-y-4 overflow-auto">
            {controller.original.map((message) => (
              <section key={message.id} className="border-b pb-3">
                <span className="text-xs text-muted-foreground">
                  {message.role}
                </span>
                <Markdown
                  content={copy(message.text)}
                  locale={controller.locale}
                />
              </section>
            ))}
          </div>
          <Button
            variant="outline"
            onClick={() => controller.setArchiveOpen(false)}
          >
            {label("关闭", "Close")}
          </Button>
        </DialogContent>
      </Dialog>
    </>
  )
}
