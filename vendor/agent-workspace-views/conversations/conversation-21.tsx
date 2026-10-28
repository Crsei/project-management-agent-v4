"use client"
import { GitBranch, MessageSquare, Plus, RotateCcw, X } from "lucide-react"
import { Button, Badge, Progress } from "./ui"
import { ConversationInput } from "./input"
import { ThreadMessage, ThreadStatus, ThreadView } from "./shared"
import type { ComposerHost } from "../composer-workspace-view"
import type { Conversation21Controller } from "./conversation-21-controller"
import styles from "./conversation-21.module.css"

export function Conversation21View({
  controller,
  host,
}: {
  controller: Conversation21Controller
  host: ComposerHost
}) {
  const { label, copy, child, selectedTask, history: historyRef } = controller
  const { history: childHistoryRef } = child
  const completed = controller.tasks.filter(
    (task) => task.status === "completed",
  ).length
  const queued = controller.queues[child.selectedId] ?? []
  const original = controller.selectedId === "parent-child-conversations"
  const statusLabel = (status: string) =>
    status === "completed"
      ? label("已完成", "Completed")
      : status === "running"
        ? label("工作中", "Working")
        : status === "failed"
          ? label("失败", "Failed")
          : status === "unknown"
            ? label("结果未知", "Outcome unknown")
            : label("待处理", "Queued")
  const taskList = (
    <section
      className={styles.tasks}
      aria-label={label("委派任务", "Delegated tasks")}
    >
      <header>
        <GitBranch size={16} aria-hidden="true" />
        <strong>{label("委派任务", "Delegated tasks")}</strong>
        <span>
          {completed}/{controller.tasks.length} {label("已完成", "complete")}
        </span>
      </header>
      {controller.tasks.length ? (
        controller.tasks.map((task) => (
          <Button
            key={task.id}
            variant="outline"
            className={styles.task}
            aria-pressed={controller.panelOpen && child.selectedId === task.id}
            data-delegated-task={task.id}
            onClick={() => {
              const session = child.sessions.find((item) => item.id === task.id)
              if (session) {
                child.selectSession(session)
                controller.setPanelOpen(true)
              }
            }}
          >
            <span className={styles.taskHeading}>
              <MessageSquare size={16} aria-hidden="true" />
              <strong>{copy(task.title)}</strong>
              <ThreadStatus
                status={
                  controller.unknownTaskIds.includes(task.id)
                    ? "unknown"
                    : task.status
                }
                label={statusLabel(
                  controller.unknownTaskIds.includes(task.id)
                    ? "unknown"
                    : task.status,
                )}
              />
            </span>
            <span className={styles.scope}>
              {copy(task.scope)} · {task.stage}/{task.steps.length}
            </span>
            <span className={styles.assignment}>{copy(task.assignment)}</span>
          </Button>
        ))
      ) : (
        <p>
          {label(
            "还没有子任务。委派一个本地任务后查看独立的子会话。",
            "No child tasks yet. Delegate a local task to inspect its independent conversation.",
          )}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={controller.delegate}>
          <Plus />
          {label("委派本地子任务", "Delegate local child task")}
        </Button>
        <Button
          variant="outline"
          disabled={!completed}
          onClick={controller.collectResults}
        >
          {label("汇总完成结果", "Collect completed findings")}
        </Button>
        <Button
          size="icon"
          variant="ghost"
          disabled={controller.unknownTaskIds.length > 0}
          aria-label={label(
            "重置本地子任务，保留草稿",
            "Reset local child tasks, preserving drafts",
          )}
          onClick={controller.resetDemo}
        >
          <RotateCcw />
        </Button>
      </div>
    </section>
  )
  const body = (
    <div className={styles.workspace}>
      <section
        className={styles.parent}
        aria-label={label("父会话", "Parent conversation")}
      >
        <div
          ref={historyRef}
          className={styles.history}
          onScroll={controller.rememberPosition}
          data-composer-region="history"
          aria-label={label("父会话消息历史", "Parent message history")}
          role="region"
        >
          <div className={styles.parentThread}>
            {controller.selected.messages.map((message) => (
              <ThreadMessage
                key={message.id}
                message={message}
                controller={controller}
                agentRole={
                  message.role === "assistant"
                    ? label("协调者", "Coordinator")
                    : undefined
                }
              >
                {message.id === "parent-child-conversations-answer" && taskList}
              </ThreadMessage>
            ))}
            {!controller.hasMessages && taskList}
          </div>
        </div>
        <div className={styles.parentInput}>
          {controller.notice && (
            <p role="status" className="mb-2 text-xs text-muted-foreground">
              {controller.notice}
            </p>
          )}
          <ConversationInput
            controller={controller}
            options={{
              hideSuggestion: true,
              showBlocksControl: false,
              inputLabel: {
                "zh-CN": "父会话消息输入",
                en: "Parent message input",
              },
            }}
          />
        </div>
      </section>
      <section
        hidden={!controller.panelOpen || !selectedTask}
        className={styles.child}
        data-child-conversation-panel
        aria-label={label("子会话工作区", "Child conversation workspace")}
      >
        <header className={styles.childHeader}>
          <div>
            <strong>
              {selectedTask
                ? copy(selectedTask.title)
                : label("子会话", "Child conversation")}
            </strong>
            <small>{selectedTask ? copy(selectedTask.scope) : ""}</small>
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label={label(
              "关闭子会话面板",
              "Close child conversation panel",
            )}
            onClick={() => {
              controller.setPanelOpen(false)
              controller.focusComposer()
            }}
          >
            <X />
          </Button>
        </header>
        {selectedTask && (
          <div className={styles.childState}>
            <ThreadStatus
              status={controller.unknown ? "unknown" : selectedTask.status}
              label={statusLabel(
                controller.unknown ? "unknown" : selectedTask.status,
              )}
            />
            <span>
              {selectedTask.stage}/{selectedTask.steps.length}{" "}
              {label("步骤", "steps")}
            </span>
            <Progress
              value={
                selectedTask.steps.length
                  ? (selectedTask.stage / selectedTask.steps.length) * 100
                  : 0
              }
              aria-label={label("子任务进度", "Child task progress")}
            />
            {controller.unknown ? (
              <>
                <p role="alert">
                  {label(
                    "结果未知。先检查，不会自动重试或视为成功。",
                    "Outcome unknown. Check first; no automatic retry or success.",
                  )}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={controller.reconcileChild}
                >
                  {label(
                    "检查子任务示例状态",
                    "Check child task example status",
                  )}
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={selectedTask.status === "completed"}
                onClick={controller.advanceChild}
              >
                {selectedTask.status === "failed"
                  ? label("明确重试本地任务", "Explicitly retry local task")
                  : label(
                      "推进所选子任务示例",
                      "Advance selected child example",
                    )}
              </Button>
            )}
          </div>
        )}
        <div
          ref={childHistoryRef}
          className={styles.history}
          onScroll={child.rememberPosition}
          role="region"
          aria-label={label("子会话消息历史", "Child message history")}
        >
          {child.selected.messages.map((message) => (
            <ThreadMessage
              key={message.id}
              message={message}
              controller={child}
              author={selectedTask ? copy(selectedTask.title) : undefined}
            />
          ))}
        </div>
        <div className={styles.childInput}>
          <div
            role="group"
            aria-label={label("子任务指令方式", "Child instruction mode")}
            className="mb-2 flex items-center gap-2"
          >
            <Button
              size="sm"
              variant={
                controller.commandMode === "steer" ? "secondary" : "ghost"
              }
              aria-pressed={controller.commandMode === "steer"}
              onClick={() => controller.setCommandMode("steer")}
            >
              {label("调整方向", "Steer")}
            </Button>
            <Button
              size="sm"
              variant={
                controller.commandMode === "queue" ? "secondary" : "ghost"
              }
              aria-pressed={controller.commandMode === "queue"}
              onClick={() => controller.setCommandMode("queue")}
            >
              {label("排队后续指令", "Queue")}
            </Button>
            <Badge variant="outline">
              {label("仅本地子会话", "Local child only")}
            </Badge>
          </div>
          {!!queued.length && (
            <section
              className={styles.queue}
              aria-label={label(
                "所选子任务的后续队列",
                "Selected child's follow-up queue",
              )}
            >
              <ol>
                {queued.map((instruction) => (
                  <li key={instruction.id}>{instruction.text}</li>
                ))}
              </ol>
              <Button
                size="sm"
                variant="outline"
                disabled={controller.unknown || !controller.canSend}
                onClick={controller.deliverQueued}
              >
                {label("投递第一条本地指令", "Deliver first local instruction")}
              </Button>
            </section>
          )}
          <ConversationInput
            controller={child}
            options={{
              hideSuggestion: true,
              showBlocksControl: false,
              formLabel: {
                "zh-CN": "子会话消息编辑器",
                en: "Child message composer",
              },
              inputLabel: {
                "zh-CN": "子会话消息输入",
                en: "Child message input",
              },
              placeholder:
                controller.commandMode === "queue"
                  ? {
                      "zh-CN": "排队一条后续指令…",
                      en: "Queue a follow-up instruction…",
                    }
                  : {
                      "zh-CN": "调整所选专家的方向…",
                      en: "Steer the selected specialist…",
                    },
            }}
          />
        </div>
      </section>
    </div>
  )
  return (
    <ThreadView
      page="parent-child-conversations"
      controller={controller}
      host={host}
      showSessionNavigation={false}
      layout="delegated"
      headerActions={
        original && (
          <Button
            variant="ghost"
            aria-pressed={controller.panelOpen}
            onClick={() => controller.setPanelOpen((value) => !value)}
          >
            {label("子会话", "Child conversations")}
          </Button>
        )
      }
      body={body}
      renderMessage={(message) => (
        <ThreadMessage message={message} controller={controller} />
      )}
    />
  )
}
