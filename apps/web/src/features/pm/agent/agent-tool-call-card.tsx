import { useEffect, useRef, useState, type ReactNode } from "react"
import { useParams } from "react-router"
import {
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Eye,
  FileText,
  GitBranch,
  Link2,
  LoaderCircle,
  MessageSquare,
  Pencil,
  Plus,
  Search,
  Terminal,
  Wrench,
} from "lucide-react"
import type { AgentChatMessage, AgentChatToolCall, AgentChatToolEntity } from "@contracts"
import { useText } from "../service/pm-ui"
import { AgentContextSources } from "./agent-context"
import { AgentToolResult } from "./agent-tool-results"
import {
  formatToolValue,
  redactToolArguments,
  toolChanges,
  toolEffectLabel,
  toolLabel,
  toolPresentation,
  toolSummary,
  toolTarget,
  type ToolIconKey,
  type ToolTone,
} from "./agent-tool-presentation"
import styles from "./agent-chat.module.css"

const icons: Record<ToolIconKey, typeof Eye> = {
  read: Eye,
  search: Search,
  create: Plus,
  edit: Pencil,
  comment: MessageSquare,
  relation: Link2,
  file: FileText,
  terminal: Terminal,
  git: GitBranch,
  tool: Wrench,
}

function StateIcon({ status }: { status: AgentChatToolCall["status"] }) {
  if (status === "running") return <LoaderCircle size={12} className="animate-spin" aria-hidden="true" />
  if (status === "succeeded") return <CircleCheck size={12} aria-hidden="true" />
  return <CircleAlert size={12} aria-hidden="true" />
}

function GroupIcon({ tone }: { tone: ToolTone }) {
  if (tone === "running") return <LoaderCircle size={12} className="animate-spin" aria-hidden="true" />
  if (tone === "success") return <CircleCheck size={12} aria-hidden="true" />
  return <CircleAlert size={12} aria-hidden="true" />
}

/** Consecutive calls form one timeline. Completed runs collapse to a 28px summary. */
export function AgentActivityGroup({ calls, children }: { calls: AgentChatToolCall[]; children: ReactNode }) {
  const t = useText()
  const running = calls.some(call => call.status === "running")
  const failed = calls.filter(call => call.status === "failed").length
  const unknown = calls.some(call => call.status === "unknown")
  const needsAttention = failed > 0 || unknown
  const [open, setOpen] = useState(running || needsAttention)
  const wasRunning = useRef(running)
  const userToggled = useRef(false)
  useEffect(() => {
    if (running || needsAttention) setOpen(true)
    else if (wasRunning.current && !userToggled.current) setOpen(false)
    wasRunning.current = running
  }, [running, needsAttention])
  if (calls.length === 1) return <div className={styles.activityGroup}><div className={styles.activityList}>{children}</div></div>
  const tone: ToolTone = failed > 0 ? "danger" : running ? "running" : unknown ? "warning" : "success"
  const label = failed > 0
    ? t(`${calls.length} 项操作 · ${failed} 项失败`, `${calls.length} operations · ${failed} failed`)
    : running
      ? t(`执行中 · ${calls.length} 项操作`, `Running · ${calls.length} operations`)
      : unknown
        ? t(`结果待核对 · ${calls.length} 项操作`, `Outcome unknown · ${calls.length} operations`)
        : t(`已完成 ${calls.length} 项操作`, `Completed ${calls.length} operation${calls.length === 1 ? "" : "s"}`)
  return <details className={styles.activityGroup} open={open} onToggle={event => {
    if (event.nativeEvent.isTrusted) userToggled.current = true
    setOpen(event.currentTarget.open)
  }}>
    <summary className={styles.activityGroupHeader}>
      <span className={styles.activityGroupIcon} data-tone={tone}><GroupIcon tone={tone} /></span>
      <span className={styles.activityGroupTitle}>{label}</span>
      <ChevronDown size={13} aria-hidden="true" className={styles.activityGroupChevron} />
    </summary>
    <div className={styles.activityList}>{children}</div>
  </details>
}

function durationText(call: AgentChatToolCall): string | null {
  if (!call.finishedAt) return null
  const elapsed = new Date(call.finishedAt).getTime() - new Date(call.startedAt).getTime()
  if (!Number.isFinite(elapsed) || elapsed < 0) return null
  return elapsed >= 1000 ? `${(elapsed / 1000).toFixed(1)}s` : `${elapsed}ms`
}

export function AgentActivityItem({ call, previousRead, onReconcile, reconciling = false }: {
  call: AgentChatToolCall
  previousRead?: AgentChatToolEntity
  onReconcile?: () => Promise<void>
  reconciling?: boolean
}) {
  const t = useText()
  const { workspaceSlug = "" } = useParams<{ workspaceSlug: string }>()
  const root = `/pm/${encodeURIComponent(workspaceSlug)}`
  const presentation = toolPresentation(call.name)
  const target = toolTarget(call)
  const changes = toolChanges(call, previousRead)
  const status = toolEffectLabel(call, changes, t)
  const Icon = icons[presentation.icon]
  const label = toolLabel(call, target, t)
  const summary = toolSummary(call, changes, t)
  const attention = call.status === "failed" || call.status === "unknown"
  const [open, setOpen] = useState(attention)
  useEffect(() => {
    if (attention) setOpen(true)
  }, [attention])
  const elapsed = durationText(call)
  const title = target.title && target.title !== target.id ? target.title : null
  return <details className={styles.activityItem} data-state={call.status} open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className={styles.activityRow}>
      <Icon size={14} aria-hidden="true" className={styles.activityIcon} />
      <span className={styles.activityLabel}>
        {label}
        {target.id && <span className={styles.activityTarget}> {target.id}</span>}
        {title && <span className={styles.activityTitleText}> · {title}</span>}
      </span>
      <span className={styles.activityMeta}>{summary}</span>
      <span className={styles.activityState} data-tone={status.tone} aria-label={status.label}>
        <StateIcon status={call.status} />
        {status.tone !== "success" && <span>{status.label}</span>}
      </span>
      <ChevronDown size={12} aria-hidden="true" className={styles.activityChevron} />
    </summary>
    <div className={styles.activityDetails}>
      {changes.length > 0 && <div className={styles.changeList} aria-label={t("字段变更", "Field changes")}>
        {changes.map(change => <div key={change.field} className={styles.changeRow}>
          <span className={styles.changeField}>{t(change.zh, change.en)}</span>
          <div className={styles.changeValues}>
            <div className={styles.changePair} data-kind="before">
              <span className={styles.changeTag}>{t("修改前", "Before")}</span>
              {change.knownBefore
                ? <span className={styles.changeBefore}>{formatToolValue(change.before, t)}</span>
                : <span className={styles.changeUnknown}>{t("原始值未知", "Original value unknown")}</span>}
            </div>
            <div className={styles.changePair} data-kind="after">
              <span className={styles.changeTag}>{t("修改后", "After")}</span>
              <span className={styles.changeAfter}>{formatToolValue(change.after, t)}</span>
              {!change.verified && <span className={styles.changeUnverified}>{t("待核对", "Unverified")}</span>}
            </div>
          </div>
        </div>)}
      </div>}
      {call.status === "unknown" && <p role="status" className={styles.toolError}>{t("业务效果尚未确认。应按原操作身份核对，不能自动重试或视为失败回滚。", "The business effect is not confirmed. Reconcile the original operation; do not retry automatically or assume a rollback.")}</p>}
      {call.status === "unknown" && onReconcile && <button type="button" className={styles.stopButton} disabled={reconciling} onClick={() => void onReconcile()}>{reconciling ? t("核对中…", "Reconciling…") : t("核对原操作收据", "Reconcile original operation receipt")}</button>}
      {call.error && <p role="alert" className={styles.toolError}><code>{call.error.code}</code>: {call.error.message}</p>}
      {call.status === "running" && <p className={styles.runtimeMuted}>{t("等待真实工具结果；取消生成不会回滚已提交动作。", "Waiting for the actual tool result. Cancelling generation does not roll back committed actions.")}</p>}
      {call.result && <div className={styles.resultBlock}>
        <AgentToolResult result={call.result} root={root} compact={presentation.write} />
      </div>}
      <details className={styles.technicalDetails}>
        <summary>{t("技术详情", "Technical details")}</summary>
        <dl>
          <div><dt>{t("工具", "Tool")}</dt><dd><code>{call.name}</code></dd></div>
          <div><dt>{t("操作 ID", "Operation ID")}</dt><dd><code>{call.operationId}</code></dd></div>
          {elapsed && <div><dt>{t("耗时", "Duration")}</dt><dd>{elapsed}</dd></div>}
        </dl>
        <pre>{JSON.stringify(redactToolArguments(call.arguments), null, 2)}</pre>
      </details>
    </div>
  </details>
}

export function AgentMessageSources({ message }: { message: AgentChatMessage }) {
  const t = useText()
  const { workspaceSlug = "" } = useParams<{ workspaceSlug: string }>()
  const root = `/pm/${encodeURIComponent(workspaceSlug)}`
  if (!message.contextSources?.length) return null
  return <details className={styles.toolDetails}>
    <summary>{t("此回复使用的数据来源", "Data sources used for this response")}</summary>
    <AgentContextSources sources={message.contextSources} root={root} />
  </details>
}
