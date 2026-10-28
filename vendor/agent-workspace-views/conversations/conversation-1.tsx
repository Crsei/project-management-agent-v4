"use client"
import { useState, useSyncExternalStore } from "react"
import { Check, FileText, Folder, Globe } from "lucide-react"
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "./ui"
import { approvalSources } from "./conversation-1-fixtures"
import type { ComposerHost } from "../composer-workspace-view"
import {
  ThreadActivity,
  ThreadMessage,
  ThreadPanel,
  ThreadView,
} from "./shared"
import type { Conversation1Controller } from "./conversation-1-controller"
const subscribeHydration = () => () => {}
const clientHydrated = () => true
const serverHydrated = () => false
export function Conversation1View({
  controller,
  host,
}: {
  controller: Conversation1Controller
  host: ComposerHost
}) {
  const { label, decision } = controller
  const hydrated = useSyncExternalStore(
    subscribeHydration,
    clientHydrated,
    serverHydrated,
  )
  const [sourcesOpen, setSourcesOpen] = useState(false)
  return (
    <ThreadView
      page="conversation-1"
      controller={controller}
      host={host}
      inputOptions={{ showContextReferences: true }}
      afterInput={
        controller.selectedId === "conversation-1" && (
          <div
            className="flex flex-wrap gap-4 text-xs text-text-secondary"
            aria-label={label(
              "工作区与文档引用",
              "Workspace and document references",
            )}
          >
            <details>
              <summary className="flex cursor-pointer items-center gap-2">
                <Folder size={14} />
                {label("AI 管理界面", "AI admin screens")}
              </summary>
              <p className="py-2">
                {label(
                  "本地工作区：40 页管理界面规范草稿。",
                  "Local workspace: specification drafts for 40 admin screens.",
                )}
              </p>
            </details>
            <details>
              <summary className="flex cursor-pointer items-center gap-2">
                <FileText size={14} />
                {label("审批状态清单", "Approval state inventory")}
              </summary>
              <p className="py-2">
                {label(
                  "请求 → 决定 → 执行 → 结果。未知结果先查询，不自动重放。",
                  "Request → decision → execution → outcome. Query unknown outcomes; never replay automatically.",
                )}
              </p>
            </details>
          </div>
        )
      }
      renderMessage={(message) => {
        const answer = message.id === "conversation-1-answer"
        return (
          <ThreadMessage
            message={message}
            controller={controller}
            author={answer ? "EasyuseUI AI" : undefined}
            agentRole={answer ? label("UI Agent", "UI agent") : undefined}
            activity={
              answer && (
                <ThreadActivity
                  title={label("已审阅审批界面", "Reviewed approval surfaces")}
                >
                  <div>
                    <strong className="font-medium">
                      <Check size={14} className="mr-2 inline" />
                      {label(
                        "盘点 Agent 可以操作的所有位置",
                        "Inventoried every place an agent can act",
                      )}
                    </strong>
                    <p>
                      {label(
                        "比较聊天工具调用、工作流执行和后台任务。",
                        "Compared chat tool calls, workflow runs and background jobs.",
                      )}
                    </p>
                    <div className="flex gap-2">
                      <Badge variant="secondary">{label("聊天", "Chat")}</Badge>
                      <Badge variant="secondary">
                        {label("工作流", "Workflows")}
                      </Badge>
                      <Badge variant="secondary">
                        {label("后台运行", "Runs")}
                      </Badge>
                    </div>
                  </div>
                  <div>
                    <strong className="font-medium">
                      <Check size={14} className="mr-2 inline" />
                      {label("统一生命周期", "Normalized the lifecycle")}
                    </strong>
                    <p>
                      {label(
                        "把请求、决定、执行与结果映射为同一状态模型。",
                        "Mapped request, decision, execution and resolution into one state model.",
                      )}
                    </p>
                  </div>
                  <div>
                    <strong className="font-medium">
                      <Check size={14} className="mr-2 inline" />
                      {label(
                        "核对审计与安全要求",
                        "Checked audit and safety requirements",
                      )}
                    </strong>
                    <p>
                      {label(
                        "每个动作保留操作者、范围、时间与最终结果。",
                        "Kept actor, scope, timestamp and final outcome attached to every action.",
                      )}
                    </p>
                  </div>
                </ThreadActivity>
              )
            }
          >
            {answer && (
              <>
                <ThreadPanel
                  title={label(
                    "将此规范应用到管理界面草稿？",
                    "Apply this contract to the admin screen specifications?",
                  )}
                >
                  <p>
                    {label(
                      "统一聊天、工作流与后台任务的审批文案和状态名称。仅为本地演示，不会授予真实权限或执行生产操作。",
                      "Standardize approval copy and state names across chat, workflows and background runs. Local demonstration only; no real permission is granted and no production action runs.",
                    )}
                  </p>
                  <div className="my-3 flex flex-wrap gap-2">
                    <Badge variant="secondary">
                      {label("40 页界面", "40 screens")}
                    </Badge>
                    <Badge variant="secondary">
                      {label("UI 文案", "UI copy")}
                    </Badge>
                    <Badge variant="secondary">
                      {label("状态映射", "State mapping")}
                    </Badge>
                  </div>
                  {decision ? (
                    <p role="status">
                      {decision === "rejected"
                        ? label(
                            "本地请求已拒绝；未应用规范。",
                            "Local request rejected; contract was not applied.",
                          )
                        : decision === "always-allowed"
                          ? label(
                              "已记录此本地工作区的持续允许选择；没有授予真实权限。",
                              "Always-allow choice recorded for this local workspace; no real permission was granted.",
                            )
                          : label(
                              "已记录单次批准；不代表真实执行完成。",
                              "One-time approval recorded; it does not confirm real execution.",
                            )}
                    </p>
                  ) : (
                    <div className="flex flex-wrap justify-end gap-2">
                      <Button
                        variant="ghost"
                        disabled={!hydrated || !controller.active}
                        onClick={() => controller.decide("rejected")}
                      >
                        {label("拒绝", "Reject")}
                      </Button>
                      <Button
                        variant="outline"
                        disabled={!hydrated || !controller.active}
                        onClick={() => controller.decide("always-allowed")}
                      >
                        {label("始终允许", "Always allow")}
                      </Button>
                      <Button
                        disabled={!hydrated || !controller.active}
                        onClick={() => controller.decide("accepted")}
                      >
                        {label("批准一次", "Approve once")}
                      </Button>
                    </div>
                  )}
                </ThreadPanel>
                <Dialog
                  open={sourcesOpen && controller.active}
                  onOpenChange={setSourcesOpen}
                >
                  <DialogTrigger asChild>
                    <Button
                      variant="ghost"
                      className="my-3"
                      disabled={!hydrated || !controller.active}
                    >
                      <Globe size={16} aria-hidden="true" />
                      {label("已搜索 3 个网站", "Searched 3 websites")}
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogTitle>
                      {label("已搜索 3 个网站", "Searched 3 websites")}
                    </DialogTitle>
                    <DialogDescription>
                      {label(
                        "用于准备本次回答的固定来源。查看仅为本地演示，不会运行搜索或 Agent。",
                        "Fixed sources used to prepare this response. Viewing is a local demonstration; no search or Agent runs.",
                      )}
                    </DialogDescription>
                    <ul className="mt-4 space-y-3">
                      {approvalSources.map((source) => (
                        <li
                          key={source.href}
                          className="border-b pb-3 last:border-0"
                        >
                          <p className="text-sm font-medium">
                            {controller.copy(source.title)}
                          </p>
                          <p className="mt-1 text-xs text-text-secondary">
                            github.com
                          </p>
                          <p className="mt-1 break-all text-xs text-text-muted">
                            {source.href}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </DialogContent>
                </Dialog>
              </>
            )}
          </ThreadMessage>
        )
      }}
    />
  )
}
