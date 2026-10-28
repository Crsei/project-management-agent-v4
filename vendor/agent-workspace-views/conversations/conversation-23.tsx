"use client"
import { useId } from "react"
import { ChevronDown, RotateCcw } from "lucide-react"
import {
  Button,
  Field,
  FieldLabel,
  FieldDescription,
  Textarea,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./ui"
import { ToolActivity } from "./tool-activity"
import { ThreadMessage, ThreadTasks, ThreadView } from "./shared"
import type { ComposerHost } from "../composer-workspace-view"
import type { Conversation23Controller } from "./conversation-23-controller"

export function Conversation23View({
  controller,
  host,
}: {
  controller: Conversation23Controller
  host: ComposerHost
}) {
  const { label, copy, phase, stage } = controller
  const contextId = useId()
  const original =
    controller.selectedId === "conversation-23" && controller.hasMessages
  const operations = (
    <>
      {phase === "running" && (
        <Button variant="ghost" onClick={controller.advance}>
          {label("推进任务示例", "Advance task")}
        </Button>
      )}
      {(phase === "stopped" || phase === "failed") && (
        <Button
          variant="outline"
          onClick={phase === "failed" ? controller.reset : controller.resume}
        >
          {label("继续本地任务", "Continue local task")}
        </Button>
      )}
      {phase === "unknown" && (
        <Button variant="outline" onClick={controller.reconcile}>
          {label("检查任务示例状态", "Check task example status")}
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon"
        aria-label={label("重置本地任务", "Reset task demo")}
        disabled={phase === "unknown"}
        onClick={controller.reset}
      >
        <RotateCcw />
      </Button>
      <Button
        variant="ghost"
        onClick={() => controller.setContextOpen((value) => !value)}
        aria-pressed={controller.contextOpen}
        aria-controls={contextId}
      >
        {label("任务上下文", "Task context")}
      </Button>
    </>
  )
  const beforeInput = original && (
    <section
      className="mb-3 rounded-xl border p-3"
      data-task-dock
      aria-label={label("任务待办", "Task todos")}
    >
      <ThreadTasks
        title={`${stage} / ${controller.steps.length} ${label("待办已完成", "todos completed")}`}
        open={controller.planOpen}
        onOpenChange={controller.setPlanOpen}
        steps={controller.steps.map((step, index) => ({
          id: step.id,
          title: copy(step.title),
          status:
            index < stage
              ? "completed"
              : index === stage && phase === "running"
                ? "running"
                : index === stage && phase === "failed"
                  ? "failed"
                  : index === stage && phase === "unknown"
                    ? "unknown"
                    : "pending",
        }))}
      />
    </section>
  )
  const reasoning = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          aria-label={label("推理等级", "Reasoning effort")}
        >
          {controller.reasoning === "high"
            ? label("高", "High")
            : controller.reasoning === "medium"
              ? label("中", "Medium")
              : label("低", "Low")}
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          value={controller.reasoning}
          onValueChange={(value) => {
            if (value === "low" || value === "medium" || value === "high")
              controller.setReasoning(value)
          }}
        >
          <DropdownMenuRadioItem value="low">
            {label("低", "Low")}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="medium">
            {label("中", "Medium")}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="high">
            {label("高", "High")}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
  return (
    <ThreadView
      page="conversation-23"
      controller={controller}
      host={host}
      title={{
        "zh-CN": "报价功能 staging 交接",
        en: "Quotation feature staging",
      }}
      headerActions={original ? operations : undefined}
      beforeInput={beforeInput}
      inputOptions={{
        trailingTools: reasoning,
        stopAction:
          original && phase === "running"
            ? {
                label: { "zh-CN": "停止任务示例", en: "Stop task example" },
                onStop: controller.stop,
              }
            : undefined,
      }}
      renderMessage={(message) => (
        <ThreadMessage
          message={message}
          controller={controller}
          agentRole={
            message.role === "assistant"
              ? label("代码 Agent", "Code agent")
              : undefined
          }
          messageState={
            message.id === "conversation-23-answer"
              ? phase === "running"
                ? "streaming"
                : phase === "stopped"
                  ? "cancelled"
                  : phase === "failed"
                    ? "failed"
                    : phase === "unknown"
                      ? "unknown"
                      : "success"
              : undefined
          }
          reason={
            message.id === "conversation-23-answer" && phase === "unknown"
              ? label(
                  "保留现有上下文，执行结果待查询。",
                  "Existing context is preserved; the outcome needs reconciliation.",
                )
              : undefined
          }
        >
          {message.id === "conversation-23-answer" && (
            <>
              <section
                aria-label={label(
                  "工具轨迹 · 固定记录",
                  "Tool trace · Fixed records",
                )}
                className="my-3 grid gap-2"
              >
                {controller.steps.slice(0, 3).map((step, index) => (
                  <ToolActivity
                    key={step.id}
                    locale={controller.locale}
                    record={{
                      id: step.id,
                      name:
                        index === 0
                          ? "Shell"
                          : index === 1
                            ? label("已探索", "Explored")
                            : label("已读取", "Read"),
                      target: step.tool,
                      source: "local-demo",
                      status:
                        index < stage
                          ? "completed"
                          : index === stage
                            ? phase === "running"
                              ? "running"
                              : phase === "unknown"
                                ? "unknown"
                                : phase === "failed"
                                  ? "failed"
                                  : phase === "stopped"
                                    ? "cancelled"
                                    : "queued"
                            : "queued",
                      outcome:
                        phase === "unknown" && index === stage
                          ? "unknown"
                          : "known",
                      output: step.output,
                      duration: `${((index + 1) * 0.8).toFixed(1)}s`,
                    }}
                  />
                ))}
              </section>
              <div
                id={contextId}
                className={controller.contextOpen ? "mt-3" : "hidden"}
              >
                <Field>
                  <FieldLabel htmlFor={`${contextId}-text`}>
                    {label("本地上下文摘要", "Local context summary")}
                  </FieldLabel>
                  <Textarea
                    id={`${contextId}-text`}
                    rows={4}
                    value={controller.contextText}
                    onChange={(event) =>
                      controller.setContextText(event.target.value)
                    }
                  />
                  <FieldDescription>
                    {label(
                      "仅编辑本地摘要；不会执行命令。",
                      "Edits only the local summary; no commands are executed.",
                    )}
                  </FieldDescription>
                </Field>
              </div>
            </>
          )}
        </ThreadMessage>
      )}
    />
  )
}
