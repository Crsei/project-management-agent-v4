"use client"
import { Check, ChevronDown } from "lucide-react"
import { useId } from "react"
import { ChangeReviewPanel } from "./resources"
import {
  Button,
  Field,
  FieldLabel,
  Textarea,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui"
import { ThreadMessage, ThreadView, ThreadPanel } from "./shared"
import type { ComposerHost } from "../composer-workspace-view"
import type { Conversation14Controller } from "./conversation-14-controller"
export function Conversation14View({
  controller,
  host,
}: {
  controller: Conversation14Controller
  host: ComposerHost
}) {
  const { label } = controller
  const commitId = useId()
  return (
    <ThreadView
      page="conversation-14"
      controller={controller}
      host={host}
      inputOptions={{
        placeholder: {
          "zh-CN": "提交前提出修改意见…",
          en: "Request a revision before committing…",
        },
        helpText: {
          "zh-CN": "本地演示 · 审阅模式",
          en: "Local demo · Review mode",
        },
      }}
      renderMessage={(message) => (
        <ThreadMessage
          message={message}
          controller={controller}
          agentRole={
            message.role === "assistant"
              ? label("变更审阅员", "Change reviewer")
              : undefined
          }
        >
          {message.id === "conversation-14-answer" && (
            <ThreadPanel
              title={label("5 个文件准备提交", "5 files ready to commit")}
              actions={
                <span className="text-xs">
                  <code>Working tree</code> ·{" "}
                  <span className="text-success">+813</span>
                </span>
              }
            >
              <Collapsible defaultOpen>
                <CollapsibleTrigger
                  asChild
                >
                  <Button variant="ghost" className="w-full justify-between">
                    {label(
                      "变更文件 · 参考快照",
                      "Changed files · Reference snapshot",
                    )}
                    <ChevronDown size={16} />
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent forceMount>
                  <ul>
                    {controller.summaries.map((file) => (
                      <li
                        key={file.fileId}
                        className="flex items-start gap-2 border-t py-2 text-xs"
                      >
                        <span className="text-success">
                          {file.kind === "added" ? "A" : "M"}
                        </span>
                        <code className="min-w-0 flex-1 break-all">
                          {file.path}
                        </code>
                        <span className="text-success">+{file.additions}</span>
                      </li>
                    ))}
                  </ul>
                </CollapsibleContent>
              </Collapsible>
              <div className="mt-3">
                <Field>
                  <FieldLabel htmlFor={commitId}>
                    {label("提交说明", "Commit message")}
                  </FieldLabel>
                  <Textarea
                    id={commitId}
                    required
                    value={controller.commitMessage}
                    onChange={(event) =>
                      controller.setCommitMessage(event.target.value)
                    }
                    rows={2}
                  />
                </Field>
              </div>
              <Collapsible className="mt-2">
                <CollapsibleTrigger asChild>
                  <Button variant="ghost">
                    <Check size={16} />
                    {label(
                      "3 项检查通过 · 固定参考数据",
                      "3 checks passed · Fixed reference data",
                    )}
                    <ChevronDown size={16} />
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent forceMount>
                  <ul className="space-y-1 text-xs text-muted-foreground">
                    <li>
                      {label(
                        "交互检查与溢出审计",
                        "Interaction checks and overflow audit",
                      )}
                    </li>
                    <li>TypeScript</li>
                    <li>{label("生产构建", "Production build")}</li>
                  </ul>
                </CollapsibleContent>
              </Collapsible>
              {controller.phase === "unknown" && (
                <div role="alert" className="my-2 text-sm">
                  <p>
                    {label(
                      "记录结果未知；先对账，不重复创建。",
                      "Record outcome unknown; reconcile before creating again.",
                    )}
                  </p>
                  <Button variant="outline" onClick={controller.reconcile}>
                    {label("检查交接示例状态", "Check example handoff status")}
                  </Button>
                </div>
              )}
              <div className="mt-3 flex justify-end gap-2">
                <Button variant="outline" onClick={controller.requestChanges}>
                  {label("请求修改", "Request changes")}
                </Button>
                <Button
                  disabled={
                    controller.phase !== "ready" ||
                    !controller.commitMessage.trim()
                  }
                  onClick={controller.prepare}
                >
                  {controller.phase === "prepared"
                    ? label("本地记录已创建", "Local record created")
                    : label(
                        "创建提交 · 本地演示",
                        "Create commit · Local demo",
                      )}
                </Button>
              </div>
              {controller.handoff && (
                <p role="status" className="mt-3 whitespace-pre-wrap text-xs">
                  {controller.handoff}
                </p>
              )}
              <Collapsible
                open={controller.reviewOpen}
                onOpenChange={controller.setReviewOpen}
                className="mt-3 border-t pt-2"
              >
                <CollapsibleTrigger asChild>
                  <Button variant="ghost">
                    <ChevronDown size={16} />
                    {label("展开完整本地 Diff", "Expand full local diff")}
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent forceMount>
                  <p className="my-2 text-xs text-muted-foreground">
                    {label(
                      "下方为五文件本地源码示例的完整 Diff；上方 +813 是原站摘要，不代表本地源码行数。原站未公开源码。",
                      "Full diff of five local source examples below. +813 above is the reference summary, not the line count of these local sources. Upstream source is not public.",
                    )}
                  </p>
                  <ChangeReviewPanel
                    scopeId="conversation-14"
                    changes={controller.changes}
                    selectedFileId={controller.fileId}
                    onSelectFile={controller.setFileId}
                    comments={controller.comments}
                    onCommentsChange={controller.setComments}
                    onFeedback={controller.addFeedbackToDraft}
                  />
                  <Button
                    variant="outline"
                    disabled={controller.reviewed.includes(controller.fileId)}
                    onClick={controller.markReviewed}
                  >
                    {label("标记所选文件已审阅", "Mark selected file reviewed")}{" "}
                    · {controller.reviewed.length}/5
                  </Button>
                </CollapsibleContent>
              </Collapsible>
            </ThreadPanel>
          )}
        </ThreadMessage>
      )}
    />
  )
}
