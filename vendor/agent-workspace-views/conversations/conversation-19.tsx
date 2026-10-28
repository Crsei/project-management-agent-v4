"use client"
import { useRef, useState } from "react"
import { GitBranch, Redo2, Undo2 } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  Button,
} from "./ui"
import { CodePreview } from "./resources"
import { Markdown } from "./markdown"
import { ThreadMessage, ThreadView } from "./shared"
import type { ComposerHost } from "../composer-workspace-view"
import type { Conversation19Controller } from "./conversation-19-controller"
export function Conversation19View({
  controller,
  host,
}: {
  controller: Conversation19Controller
  host: ComposerHost
}) {
  const { label, copy } = controller
  const [unknownNoticeOpen, setUnknownNoticeOpen] = useState(true)
  const dialogReturnFocus = useRef<HTMLElement | null>(null)
  const restoreDialogFocus = (event: Event) => {
    event.preventDefault()
    if (!controller.active) return
    if (dialogReturnFocus.current?.isConnected)
      dialogReturnFocus.current.focus()
    else controller.focusComposer()
  }
  const point = controller.pending
  const readBranch = controller.branches.find(
    (branch) => branch.id === controller.branchReader,
  )
  return (
    <>
      <ThreadView
        page="conversation-19"
        title={{
          "zh-CN": "发票重试会话恢复",
          en: "Invoice retry session recovery",
        }}
        controller={controller}
        host={host}
        headerActions={
          <>
            <Button
              variant="ghost"
              disabled={controller.unknown || controller.cursor === 0}
              onClick={controller.undo}
            >
              <Undo2 aria-hidden="true" />
              {label("撤销", "Undo")}
            </Button>
            <Button
              variant="ghost"
              disabled={
                controller.unknown ||
                controller.cursor === controller.timeline.length - 1
              }
              onClick={controller.redo}
            >
              <Redo2 aria-hidden="true" />
              {label("重做", "Redo")}
            </Button>
            <Button
              variant="ghost"
              onClick={(event) => {
                dialogReturnFocus.current = event.currentTarget
                controller.setBranchReader(controller.activeBranchId)
              }}
            >
              <GitBranch aria-hidden="true" />
              {controller.activeBranchId} · 2{" "}
              {label("检查点 · 当前", "checkpoints · Current")}
            </Button>
          </>
        }
        beforeInput={
          <>
            {controller.unknown && (
              <div role="alert" className="mb-2 text-sm">
                <p>
                  {label(
                    "恢复结果未知；检查后再操作，快照和草稿保留。",
                    "Restore outcome unknown; check first. Snapshot and draft retained.",
                  )}
                </p>
                <Button variant="outline" onClick={controller.reconcile}>
                  {label("检查恢复示例状态", "Check restore example status")}
                </Button>
              </div>
            )}
            {controller.selectedId === "conversation-19" &&
              controller.branches.length > 1 && (
                <div className="mb-2 flex flex-wrap gap-2 text-xs">
                  <span>
                    {label(
                      "保留的分支（后续消息发送至当前分支）",
                      "Retained branches (new turns go to current branch)",
                    )}
                  </span>
                  {controller.branches.map((branch) => (
                    <span key={branch.id} className="flex items-center">
                      <Button
                        size="sm"
                        variant="outline"
                        aria-pressed={branch.id === controller.activeBranchId}
                        disabled={controller.unknown}
                        onClick={() => controller.switchBranch(branch.id)}
                      >
                        {branch.name}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={(event) => {
                          dialogReturnFocus.current = event.currentTarget
                          controller.setBranchReader(branch.id)
                        }}
                        aria-label={
                          label("读取分支 ", "Read branch ") + branch.name
                        }
                      >
                        {label("快照", "Snapshot")}
                      </Button>
                    </span>
                  ))}
                </div>
              )}
          </>
        }
        inputOptions={{
          placeholder: { "zh-CN": "添加上下文", en: "Add context" },
          trailingTools: (
            <span className="text-xs text-muted-foreground">
              {controller.activeBranchId}
            </span>
          ),
        }}
        renderMessage={(message) => (
          <ThreadMessage
            message={message}
            controller={controller}
            author={message.role === "assistant" ? "EasyuseUI AI" : undefined}
            agentRole={
              message.role === "assistant"
                ? label("恢复 Agent", "Recovery agent")
                : undefined
            }
          >
            {controller.checkpoints
              .filter(
                (checkpoint) => checkpoint.messages.at(-1)?.id === message.id,
              )
              .map((checkpoint) => (
                <div key={checkpoint.id} className="my-3 border-y py-2">
                  <Button
                    variant="ghost"
                    disabled={controller.unknown}
                    onClick={(event) => {
                      dialogReturnFocus.current = event.currentTarget
                      controller.requestRestore(checkpoint.id)
                    }}
                  >
                    {copy(checkpoint.title)} · {checkpoint.timestamp}
                  </Button>
                </div>
              ))}
          </ThreadMessage>
        )}
      />
      {controller.unknown && (
        <Dialog
          open={controller.active && unknownNoticeOpen}
          onOpenChange={setUnknownNoticeOpen}
        >
          <DialogContent onCloseAutoFocus={restoreDialogFocus}>
            <DialogTitle>
              {label("恢复结果未知", "Restore outcome unknown")}
            </DialogTitle>
            <DialogDescription>
              {label(
                "当前快照和草稿保留。先检查本地状态，不自动重放或重新执行账单请求。",
                "Snapshot and draft retained. Check local state without replaying or running billing requests.",
              )}
            </DialogDescription>
            <Button onClick={controller.reconcile}>
              {label("检查恢复示例状态", "Check restore example status")}
            </Button>
          </DialogContent>
        </Dialog>
      )}
      <Dialog
        open={!!point && controller.active}
        onOpenChange={(open) => {
          if (!open) controller.setPending(null)
        }}
      >
        <DialogContent onCloseAutoFocus={restoreDialogFocus}>
          <DialogTitle>
            {label("恢复 ", "Restore ")}
            {point && copy(point.title)}?
          </DialogTitle>
          <DialogDescription>
            {controller.laterTurns}{" "}
            {label(
              "条后续消息离开活动分支。没有内容被删除。Restore 保留完整后续分支；Fork 创建新分支并保留原分支。后续输入发送至当前分支，未发送草稿保持。仅本地快照，不执行 Git、Shell 或账单请求。",
              "later turns leave the active branch. Nothing is deleted. Restore retains the complete later branch; Fork creates a new branch and preserves the original. New turns go to the current branch; unsent drafts remain. Local snapshots only: no Git, shell, or billing request.",
            )}
          </DialogDescription>
          <div className="mt-4 flex gap-2">
            <Button
              variant="outline"
              onClick={() => controller.setPending(null)}
            >
              {label("取消", "Cancel")}
            </Button>
            <Button
              variant="outline"
              onClick={() => controller.confirmRestore(true)}
            >
              {label("派生", "Fork")}
            </Button>
            <Button onClick={() => controller.confirmRestore(false)}>
              {label("恢复", "Restore")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!readBranch && controller.active}
        onOpenChange={(open) => {
          if (!open) controller.setBranchReader(null)
        }}
      >
        <DialogContent onCloseAutoFocus={restoreDialogFocus}>
          <DialogTitle>
            {label("本地分支快照 · ", "Local branch snapshot · ")}
            {readBranch?.name}
          </DialogTitle>
          <DialogDescription>
            {label(
              "完整保留的消息可读，切换不重放任何请求。",
              "All retained turns are readable; switching never replays requests.",
            )}
          </DialogDescription>
          <div className="mt-4 max-h-[55vh] space-y-3 overflow-auto">
            {readBranch?.messages.map((message) => (
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
            {readBranch?.checkpointId && (
              <CodePreview
                identity={"conversation-19:" + readBranch.id}
                revision={readBranch.checkpointId}
                code={
                  controller.checkpoints.find(
                    (checkpoint) => checkpoint.id === readBranch.checkpointId,
                  )!.code
                }
                path="invoice-retry.ts"
                language="typescript"
              />
            )}
          </div>
          <Button
            variant="outline"
            onClick={() => controller.setBranchReader(null)}
          >
            {label("关闭", "Close")}
          </Button>
        </DialogContent>
      </Dialog>
    </>
  )
}
