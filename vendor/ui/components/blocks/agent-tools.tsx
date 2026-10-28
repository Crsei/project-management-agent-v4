"use client"

import { useMemo } from "react"
import {
  ArrowRight,
  Check,
  Circle,
  FileDiff,
  ListTodo,
  Search,
} from "lucide-react"

import { useI18n } from "../../lib/i18n-provider"
import { redact } from "../../lib/redact"
import type { WorkbenchTool } from "../../lib/agent-workbench-model"
import type { ToolSearchResult } from "../../lib/agent-elements-model"
import {
  buildEditDiff,
  diffTodos,
  unwrapMcpContent,
} from "../../lib/agent-tool-model"
import { Button } from "../ui/button"
import { DiffViewer } from "./agent-workbench/review"
import { MessageContent } from "./message-content"
import styles from "./agent-tools.module.css"

/**
 * Specialized tool bodies. Each renders a single concern for its tool kind and
 * is mounted inside the one `ToolCall` owner via the `content` slot, so
 * execution, approval, cancel, retry, copy and unknown-outcome handling are
 * never duplicated here. Every source-supplied string is redacted before
 * display; nothing is inferred beyond what the source provided.
 */

type ToolBodyProps = { call: WorkbenchTool }

export function BashTool({ call }: ToolBodyProps) {
  const { t } = useI18n()
  const display = call.display?.kind === "bash" ? call.display : undefined
  const args =
    call.arguments && typeof call.arguments === "object"
      ? (call.arguments as Record<string, unknown>)
      : undefined
  const command =
    display?.command ??
    (typeof args?.command === "string" ? args.command : undefined)
  const cwd =
    display?.cwd ?? (typeof args?.cwd === "string" ? args.cwd : undefined)
  if (command === undefined && cwd === undefined) return null
  return (
    <div className={styles.meta}>
      {command !== undefined && (
        <pre className={styles.command}>{redact(command)}</pre>
      )}
      <div className={styles.row}>
        {cwd !== undefined && (
          <span>
            {t("agentElements.directory")} <code>{redact(cwd)}</code>
          </span>
        )}
        {call.exitCode !== undefined && (
          <span>
            {t("resource.exitCode")} <code>{call.exitCode}</code>
          </span>
        )}
      </div>
      {call.outputTruncated && (
        <p className={styles.partial}>
          {t("toolCall.theSourceSuppliedOnlyPartialOutput")}
        </p>
      )}
    </div>
  )
}

export function EditTool({ call }: ToolBodyProps) {
  const { t } = useI18n()
  const display = call.display?.kind === "edit" ? call.display : undefined
  const file = useMemo(() => {
    if (!display) return undefined
    if (!display.before && !display.after) return undefined
    return buildEditDiff(
      display.path,
      display.before,
      display.after,
      call.revision,
    )
  }, [display, call.revision])
  if (!display) return null
  return (
    <div className={styles.diff}>
      <div className={styles.row}>
        <FileDiff size={14} aria-hidden="true" />
        <code>{redact(display.path)}</code>
        {file?.truncated && <span>{t("workbench.truncated")}</span>}
      </div>
      {file ? (
        <DiffViewer file={file} />
      ) : (
        <p className={styles.missing}>{t("toolCall.argumentsNotProvided")}</p>
      )}
    </div>
  )
}

export function SearchTool({
  call,
  onOpenSearchResult,
}: ToolBodyProps & {
  onOpenSearchResult?: (result: ToolSearchResult) => void
}) {
  const { t } = useI18n()
  const display = call.display?.kind === "search" ? call.display : undefined
  const results = useMemo(() => display?.results ?? [], [display])
  if (!display) return null
  return (
    <div className={styles.meta}>
      <div className={styles.row}>
        <Search size={14} aria-hidden="true" />
        <span>
          {t("agentElements.searchQuery", { query: redact(display.query) })}
        </span>
        <span>{t("agentElements.resultCount", { count: results.length })}</span>
      </div>
      {display.partial && (
        <p className={styles.partial}>{t("agentElements.partialResults")}</p>
      )}
      {results.length === 0 ? (
        <p className={styles.missing}>{t("agentElements.noSearchResults")}</p>
      ) : (
        <ul className={styles.results}>
          {results.map((result, index) => (
            <li
              key={result.id || `${result.title}-${index}`}
              className={styles.result}
            >
              <span className={styles.resultSource}>
                {redact(result.source)}
              </span>
              <span className={styles.resultTitle}>{redact(result.title)}</span>
              {result.date && (
                <span className={styles.resultDate}>{redact(result.date)}</span>
              )}
              {onOpenSearchResult && (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t("agentElements.openResult", {
                    title: result.title,
                  })}
                  onClick={() => onOpenSearchResult(result)}
                >
                  <ArrowRight size={14} aria-hidden="true" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const todoStatusLabels: Record<string, string> = {
  pending: "○",
  in_progress: "◐",
  completed: "●",
}

export function TodoTool({ call }: ToolBodyProps) {
  const { t } = useI18n()
  const display = call.display?.kind === "todo" ? call.display : undefined
  const delta = useMemo(
    () => (display ? diffTodos(display.previous, display.items) : undefined),
    [display],
  )
  if (!display || !delta) return null
  const rows = [
    ...delta.created.map((task) => ({
      key: `c-${task.id}`,
      change: "created" as const,
      badge: t("agentElements.taskAdded"),
      title: task.title,
      status: task.status,
    })),
    ...delta.removed.map((task) => ({
      key: `r-${task.id}`,
      change: "removed" as const,
      badge: t("agentElements.taskRemoved"),
      title: task.title,
      status: task.status,
    })),
    ...delta.changed.map((change) => ({
      key: `s-${change.id}`,
      change: "status" as const,
      badge: `${change.from} → ${change.to}`,
      title: change.title,
      status: change.to,
    })),
  ]
  return (
    <div className={styles.meta}>
      <div className={styles.row}>
        <ListTodo size={14} aria-hidden="true" />
        <span>{t("agentElements.todoChanges")}</span>
      </div>
      {rows.length === 0 ? (
        <p className={styles.missing}>{t("agentElements.noTaskChanges")}</p>
      ) : (
        <ul className={styles.todos}>
          {rows.map((row) => (
            <li key={row.key} className={styles.todo} data-change={row.change}>
              <span className={styles.todoBadge}>{row.badge}</span>
              <span className={styles.todoTitle}>{redact(row.title)}</span>
              <span aria-hidden="true">
                {todoStatusLabels[row.status] ?? "○"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function PlanTool({ call }: ToolBodyProps) {
  const { t } = useI18n()
  const display = call.display?.kind === "plan" ? call.display : undefined
  if (!display) return null
  return (
    <div className={styles.plan}>
      <p className={styles.planTitle}>{redact(display.title)}</p>
      {display.summary && <MessageContent content={redact(display.summary)} />}
      <div className={styles.row}>
        <span>
          {t("agentElements.planRevision", { revision: display.revision })}
        </span>
      </div>
      {display.steps.length > 0 && (
        <ul className={styles.planSteps}>
          {display.steps.map((step) => (
            <li key={step.id} className={styles.planStep}>
              {step.status === "completed" ? (
                <Check size={14} aria-hidden="true" />
              ) : (
                <Circle size={14} aria-hidden="true" />
              )}
              <span className={styles.planStepTitle}>{redact(step.title)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function McpTool({ call }: ToolBodyProps) {
  const { t } = useI18n()
  const display = call.display?.kind === "mcp" ? call.display : undefined
  const unwrapped = useMemo(
    () =>
      unwrapMcpContent(
        display?.content !== undefined ? display.content : call.output,
      ),
    [display, call.output],
  )
  if (!display) return null
  return (
    <div className={styles.meta}>
      <div className={styles.row}>
        <span>
          {t("agentElements.tools")}{" "}
          <code className={styles.mcpToolName}>
            {redact(display.serverName)} / {redact(display.toolName)}
          </code>
        </span>
      </div>
      {unwrapped.recognized ? (
        <MessageContent
          content={
            unwrapped.text !== undefined
              ? redact(unwrapped.text)
              : unwrapped.json === undefined
                ? ""
                : redact(unwrapped.json)
          }
        />
      ) : (
        <p className={styles.missing}>
          {t("toolCall.theToolReturnedNoTextOutput")}
        </p>
      )}
    </div>
  )
}
