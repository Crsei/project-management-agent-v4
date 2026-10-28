"use client"

import { useId, useState, type ReactNode } from "react"
import {
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  Clock3,
  Loader2,
  PauseCircle,
  XCircle,
} from "lucide-react"
import { Button } from "./ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible"
import styles from "./tool-activity.module.css"

/** Publicly displayable JSON only; never credentials, opaque handles or private reasoning. */
export type ToolValue =
  string | number | boolean | null | ToolValue[] | { [key: string]: ToolValue }
export type ToolStatus =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown"
export type ToolOutcome = "known" | "unknown"

/** A local demonstration record, not a command or receipt from a real execution service. */
export interface ToolRecord {
  id: string
  name: string
  source: "local-demo"
  status: ToolStatus
  outcome?: ToolOutcome
  target?: string
  duration?: string
  arguments?: ToolValue
  output?: ToolValue
  error?: string
}

export interface ToolActivityProps {
  record: ToolRecord
  locale?: "zh-CN" | "en"
  /** Caller-owned, explicitly labelled local state transitions. Nothing is executed here. */
  actions?: ReactNode
  defaultOpen?: boolean
  className?: string
}

const statusLabels: Record<ToolStatus, { "zh-CN": string; en: string }> = {
  queued: { "zh-CN": "排队中", en: "Queued" },
  running: { "zh-CN": "进行中", en: "Running" },
  waiting: { "zh-CN": "等待中", en: "Waiting" },
  completed: { "zh-CN": "已完成", en: "Completed" },
  failed: { "zh-CN": "失败", en: "Failed" },
  cancelled: { "zh-CN": "已取消", en: "Cancelled" },
  unknown: { "zh-CN": "结果未知", en: "Outcome unknown" },
}
const statusIcons: Record<ToolStatus, typeof Clock3> = {
  queued: Clock3,
  running: Loader2,
  waiting: PauseCircle,
  completed: CheckCircle2,
  failed: XCircle,
  cancelled: XCircle,
  unknown: CircleHelp,
}

/** Radix expansion of supplied public inputs/outputs; no execution, replay or inferred result. */
export function ToolActivity({
  record,
  locale = "en",
  actions,
  defaultOpen,
  className,
}: ToolActivityProps) {
  const headingId = useId()
  const status = record.outcome === "unknown" ? "unknown" : record.status
  const [open, setOpen] = useState(
    defaultOpen ?? (status === "failed" || status === "unknown"),
  )
  const chinese = locale === "zh-CN"
  const Icon = statusIcons[status]
  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <article
        className={[styles.activity, className].filter(Boolean).join(" ")}
        aria-labelledby={headingId}
        data-status={status}
        data-record-id={record.id}
      >
        <div className={styles.summary}>
          <div className={styles.identity}>
            <h3 id={headingId}>{record.name}</h3>
            {record.target && <p>{record.target}</p>}
          </div>
          <span className={styles.status} role="status">
            <Icon size={14} aria-hidden="true" />
            {statusLabels[status][locale]}
          </span>
          {record.duration && (
            <span className={styles.duration}>
              <span className={styles.srOnly}>
                {chinese ? "耗时：" : "Duration: "}
              </span>
              {record.duration}
            </span>
          )}
          <CollapsibleTrigger asChild>
            <Button
              variant="ghost"
              size="xs"
              aria-label={`${open ? (chinese ? "收起工具记录" : "Collapse tool record") : chinese ? "展开工具记录" : "Expand tool record"}: ${record.name} · ${chinese ? "详情" : "Details"}`}
            >
              {chinese ? "详情" : "Details"}
              <ChevronDown
                size={14}
                aria-hidden="true"
                className={open ? styles.expanded : undefined}
              />
            </Button>
          </CollapsibleTrigger>
        </div>
        <p className={styles.boundary}>
          {chinese
            ? "本地演示记录 · 未调用或执行真实工具。"
            : "Local demonstration record · No real tool was called or executed."}
        </p>
        {status === "unknown" && (
          <p className={styles.notice}>
            {chinese
              ? "结果未确认；没有将未知状态视为成功，也不会自动重放。"
              : "The outcome is unconfirmed; unknown is not success and is never automatically replayed."}
          </p>
        )}
        {record.error && (
          <p className={styles.error} role="status">
            {record.error}
          </p>
        )}
        <CollapsibleContent className={styles.details}>
          <dl>
            <div>
              <dt>{chinese ? "公开输入参数" : "Public input arguments"}</dt>
              <dd>
                {record.arguments !== undefined ? (
                  <pre tabIndex={0}>
                    {typeof record.arguments === "string"
                      ? record.arguments
                      : JSON.stringify(record.arguments, null, 2)}
                  </pre>
                ) : (
                  <p>
                    {chinese
                      ? "该记录没有提供输入参数。"
                      : "No input arguments were supplied in this record."}
                  </p>
                )}
              </dd>
            </div>
            <div>
              <dt>{chinese ? "公开输出" : "Public output"}</dt>
              <dd>
                {record.output !== undefined ? (
                  <pre tabIndex={0}>
                    {typeof record.output === "string"
                      ? record.output
                      : JSON.stringify(record.output, null, 2)}
                  </pre>
                ) : (
                  <p>
                    {status === "unknown"
                      ? chinese
                        ? "尚无已确认的输出。"
                        : "No confirmed output is available."
                      : chinese
                        ? "该记录没有提供输出。"
                        : "No output was supplied in this record."}
                  </p>
                )}
              </dd>
            </div>
          </dl>
        </CollapsibleContent>
        {actions && (
          <div
            className={styles.actions}
            role="group"
            aria-label={
              chinese
                ? "本地演示状态操作（不执行真实工具）"
                : "Local demo state actions (no real tool execution)"
            }
          >
            {actions}
          </div>
        )}
      </article>
    </Collapsible>
  )
}
