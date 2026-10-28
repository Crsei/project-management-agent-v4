"use client"
import { Button, Checkbox } from "./ui"
import {
  ThreadMessage,
  ThreadView,
  ThreadActivity,
  ThreadPanel,
} from "./shared"
import type { ComposerHost } from "../composer-workspace-view"
import type { Conversation17Controller } from "./conversation-17-controller"
export function Conversation17View({
  controller,
  host,
}: {
  controller: Conversation17Controller
  host: ComposerHost
}) {
  const { label, copy, phase } = controller
  const status =
    phase === "completed"
      ? label("完成", "Complete")
      : phase === "streaming"
        ? label("运行中", "Working")
        : phase === "stopped"
          ? label("已中断", "Interrupted")
          : phase === "unknown"
            ? label("结果未知", "Unknown outcome")
            : label("未完成", "Incomplete")
  return (
    <ThreadView
      page="conversation-17"
      title={{ "zh-CN": "回复生命周期", en: "Response lifecycle" }}
      controller={controller}
      host={host}
      inputOptions={{
        placeholder: { "zh-CN": "添加审阅上下文", en: "Add review context" },
        stopAction:
          phase === "streaming" && controller.selectedId === "conversation-17"
            ? {
                label: { "zh-CN": "停止生成", en: "Stop generating" },
                onStop: controller.stop,
              }
            : undefined,
      }}
      beforeInput={
        controller.selectedId === "conversation-17" &&
        phase !== "completed" && (
          <div
            className="mb-2 flex flex-wrap items-center gap-2 text-sm"
            role={phase === "unknown" ? "alert" : "status"}
          >
            <span>
              {status} · {controller.chunkCount}/4 ·{" "}
              {label("手动推进固定示例", "Manually advanced fixed example")}
            </span>
            {phase === "streaming" && (
              <Button variant="outline" onClick={controller.advance}>
                {label("推进下一段回复", "Advance next response segment")}
              </Button>
            )}
            {(phase === "stopped" || phase === "failed") && (
              <Button variant="outline" onClick={controller.resume}>
                {label("继续本地示例", "Continue local example")}
              </Button>
            )}
            {phase === "unknown" && (
              <>
                <span>
                  {label(
                    "先检查，不自动重放。",
                    "Check first; no automatic replay.",
                  )}
                </span>
                <Button onClick={controller.reconcile}>
                  {label("检查示例状态", "Check example status")}
                </Button>
              </>
            )}
          </div>
        )
      }
      renderMessage={(message) => (
        <ThreadMessage
          message={message}
          controller={controller}
          author={
            message.role === "assistant"
              ? label("发布审阅员", "Release reviewer")
              : undefined
          }
          agentRole={
            message.id === "conversation-17-answer" ? status : undefined
          }
          activity={
            message.id === "conversation-17-answer" && (
              <ThreadActivity
                defaultOpen={false}
                title={
                  phase === "completed"
                    ? label("已审阅 4 个步骤", "Reviewed 4 steps")
                    : label("审阅发布证据", "Reviewing release evidence")
                }
                elapsed={
                  phase === "completed" ? "4.1s" : controller.chunkCount + ".0s"
                }
              >
                {controller.steps
                  .slice(0, phase === "completed" ? 4 : controller.chunkCount)
                  .map((step) => (
                    <div
                      key={step.title.en}
                      className="flex justify-between gap-3"
                    >
                      <span>{copy(step.title)}</span>
                      <span className="text-muted-foreground">
                        {copy(step.count)}
                      </span>
                    </div>
                  ))}
              </ThreadActivity>
            )
          }
        >
          {message.id === "conversation-17-answer" && phase === "completed" && (
            <ThreadPanel
              title={label("发布审阅", "Release review")}
              actions={
                <span className="text-xs">
                  {controller.reviewed.length}/3 {label("已审阅", "reviewed")}
                </span>
              }
            >
              <p className="mb-3 text-sm text-muted-foreground">
                {label(
                  "发布前解决或分配每个阻碍。",
                  "Resolve or assign each blocker before publishing.",
                )}
              </p>
              {controller.blockers.map((blocker) => (
                <div
                  key={blocker.id}
                  className="flex items-start gap-3 border-t py-3"
                >
                  <Checkbox
                    checked={controller.reviewed.includes(blocker.id)}
                    onCheckedChange={(value) =>
                      controller.toggleReviewed(blocker.id, value === true)
                    }
                    aria-label={copy(blocker.title)}
                  />
                  <span className="flex-1">
                    <strong className="block text-sm font-medium">
                      {copy(blocker.title)}
                    </strong>
                    <span className="text-sm text-muted-foreground">
                      {copy(blocker.task)}
                    </span>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {copy(blocker.owner)}
                  </span>
                </div>
              ))}
              <div className="mt-2 flex gap-2">
                <Button variant="outline" onClick={controller.replay}>
                  {label("重播序列", "Replay sequence")}
                </Button>
                <Button variant="outline" onClick={controller.interrupt}>
                  {label("测试中断运行", "Test interrupted run")}
                </Button>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                {label(
                  "本地生命周期演示 · 计数与耗时均为固定数据",
                  "Local lifecycle demo · counts and timing are fixtures",
                )}
              </p>
            </ThreadPanel>
          )}
        </ThreadMessage>
      )}
    />
  )
}
