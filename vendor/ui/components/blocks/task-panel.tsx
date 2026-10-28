"use client"
import { useI18n } from "../../lib/i18n-provider"
import { localizeStaticData } from "../../lib/i18n-core"

import { Button } from "../ui/button"
import { cn } from "../../lib/utils"

export type TaskStatus = "pending" | "running" | "completed" | "failed"
export type Task = {
  id: string
  title: string
  description?: string
  status: TaskStatus
}
export type TaskPanelProps = {
  tasks: Task[]
  title?: string
  onRetry?: (id: string) => void
  className?: string
}

const statusLabels: Record<TaskStatus, string> = {
  pending: "待开始",
  running: "进行中",
  completed: "已完成",
  failed: "失败",
}

export function TaskPanel({
  tasks,
  title: providedTitle,
  onRetry,
  className,
}: TaskPanelProps) {
  const { t, locale } = useI18n()
  const title = providedTitle ?? t("taskPanel.taskProgress")
  const localizedStatusLabels = localizeStaticData(statusLabels, locale)

  const completed = tasks.filter((task) => task.status === "completed").length
  const progress = tasks.length
    ? Math.round((completed / tasks.length) * 100)
    : 0

  return (
    <section
      aria-label={title}
      className={cn("rounded-xl border bg-background p-5 shadow-sm", className)}
    >
      <div className="flex items-center justify-between gap-4">
        <h3 className="text-sm font-semibold">{title}</h3>
        <span className="font-mono text-xs text-muted-foreground">
          {completed} / {tasks.length}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={t("taskPanel.taskCompletionProgress")}
        aria-valuenow={progress}
        aria-valuemin={0}
        aria-valuemax={100}
        className="my-5 h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-300"
          style={{ width: `${progress}%` }}
        />
      </div>
      {tasks.length === 0 ? (
        <p className="py-5 text-center text-sm text-muted-foreground">
          {t("taskPanel.noTasksYetStartWhenReady")}
        </p>
      ) : (
        <ol className="space-y-5">
          {tasks.map((task) => (
            <li key={task.id} className="flex items-start gap-3">
              <span
                aria-hidden="true"
                className={cn(
                  "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-xs",
                  task.status === "completed" && "bg-success/10 text-success",
                  task.status === "failed" &&
                    "bg-destructive/10 text-destructive",
                  task.status === "pending" && "border text-muted-foreground",
                  task.status === "running" &&
                    "border-2 border-primary/20 border-t-primary animate-spin",
                )}
              >
                {task.status === "completed"
                  ? "✓"
                  : task.status === "failed"
                    ? "!"
                    : ""}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{task.title}</p>
                {task.description && (
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {task.description}
                  </p>
                )}
              </div>
              {task.status === "failed" && onRetry ? (
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={t("common.retryValue", { value0: task.title })}
                  onClick={() => onRetry(task.id)}
                >
                  {t("taskPanel.retry")}
                </Button>
              ) : (
                <span className="pt-0.5 text-xs whitespace-nowrap text-muted-foreground">
                  {localizedStatusLabels[task.status]}
                </span>
              )}
              <span className="sr-only">
                {task.status === "failed" && onRetry
                  ? localizedStatusLabels[task.status]
                  : ""}
              </span>
            </li>
          ))}
        </ol>
      )}
      <p role="status" className="sr-only">
        {t("taskPanel.completionSummary", { completed, total: tasks.length })}
      </p>
    </section>
  )
}
