export const runtimeStatuses = [
  "idle",
  "queued",
  "starting",
  "running",
  "thinking",
  "waiting",
  "paused",
  "completed",
  "failed",
  "cancelled",
] as const
export type RuntimeStatus = (typeof runtimeStatuses)[number]
export type DataState = "loading" | "empty" | "partial" | "error" | "success"
export type ErrorCategory =
  "validation" | "request" | "runtime" | "agent" | "permission" | "network"
export const runtimeStatusMeta: Record<
  RuntimeStatus,
  { label: string; token: string }
> = {
  idle: { label: "待命", token: "status-neutral" },
  queued: { label: "排队中", token: "status-queued" },
  starting: { label: "启动中", token: "status-info" },
  running: { label: "执行中", token: "status-info" },
  thinking: { label: "思考中", token: "status-thinking" },
  waiting: { label: "等待中", token: "status-waiting" },
  paused: { label: "已暂停", token: "status-waiting" },
  completed: { label: "已完成", token: "status-success" },
  failed: { label: "失败", token: "status-error" },
  cancelled: { label: "已取消", token: "status-neutral" },
}
export function isRuntimeStatus(status: string): status is RuntimeStatus {
  return Object.hasOwn(runtimeStatusMeta, status)
}
