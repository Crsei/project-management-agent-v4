"use client"

import type { ReactNode } from "react"

import type { WorkbenchTool } from "../../lib/agent-workbench-model"
import type { ToolSearchResult } from "../../lib/agent-elements-model"
import { routeToolCall } from "../../lib/agent-tool-model"
import { ToolCall, type ToolCallProps } from "./tool-call"
import {
  BashTool,
  EditTool,
  SearchTool,
  TodoTool,
  PlanTool,
  McpTool,
} from "./agent-tools"

export { routeToolCall }

type Operation = () => void | Promise<void>

export type ToolRendererProps = {
  call: WorkbenchTool
  /** Explicit per-call override keyed by `call.id`, then `call.name`, then routed kind. An explicit renderer replaces the built-in body. */
  renderers?: Record<string, (call: WorkbenchTool) => ReactNode>
  /** Specialized relationship body (SubagentTool / ThinkingTool) supplied by the host for subagent / thinking kinds. */
  children?: ReactNode
  permission?: ToolCallProps["permission"]
  /** Caller-owned actions remain in ToolCall alongside its execution controls. */
  actions?: ToolCallProps["actions"]
  onCancel?: Operation
  onRetry?: Operation
  onReconcile?: Operation
  onDownload?: (redactedOutput: string) => void
  /** Plan approval scoped to the object revision; wired through the existing ToolCall permission flow. */
  onApprovePlan?: (id: string, revision: string) => void | Promise<void>
  onRejectPlan?: (id: string, revision: string) => void | Promise<void>
  onOpenSearchResult?: (result: ToolSearchResult) => void
  presentation?: ToolCallProps["presentation"]
  defaultExpanded?: boolean
  data?: ToolCallProps["data"]
}

/**
 * Routes one tool call to its specialized content while keeping `ToolCall` as
 * the single owner of execution state, permission, cancel/retry, copy/download
 * and unknown-outcome reconciliation. An explicit renderer keyed by id / name /
 * kind wins; otherwise the known kind uses its built-in body; unknown kinds fall
 * back to the generic `ToolCall` with the raw name and status preserved. Where a
 * specialized body already represents the result, the raw output section is
 * suppressed to avoid rendering the same data twice.
 */
export function ToolRenderer({
  call,
  renderers,
  children,
  permission,
  actions,
  onCancel,
  onRetry,
  onReconcile,
  onDownload,
  onApprovePlan,
  onRejectPlan,
  onOpenSearchResult,
  presentation,
  defaultExpanded,
  data,
}: ToolRendererProps) {
  const kind = routeToolCall(call)
  const custom =
    renderers?.[call.id] ?? renderers?.[call.name] ?? renderers?.[kind]

  let content: ReactNode
  let renderOutput: ToolCallProps["renderOutput"]

  if (custom) {
    content = custom(call)
    renderOutput = () => null
  } else {
    switch (kind) {
      case "bash":
        content = <BashTool call={call} />
        // Bash keeps the raw stdout output section alongside its command summary.
        break
      case "edit":
        content = <EditTool call={call} />
        renderOutput = () => null
        break
      case "search":
        content = (
          <SearchTool call={call} onOpenSearchResult={onOpenSearchResult} />
        )
        renderOutput = () => null
        break
      case "todo":
        content = <TodoTool call={call} />
        renderOutput = () => null
        break
      case "plan":
        content = <PlanTool call={call} />
        renderOutput = () => null
        break
      case "mcp":
        content = <McpTool call={call} />
        renderOutput = () => null
        break
      case "subagent":
      case "thinking":
        content = children
        // Suppress the generic output only when a relationship body is present.
        renderOutput = children ? () => null : undefined
        break
      default:
        content = undefined
        renderOutput = undefined
    }
  }

  const planRevision =
    call.display?.kind === "plan"
      ? call.display.revision
      : (call.revision ?? "")
  const resolvedPermission =
    permission ??
    (kind === "plan" && (onApprovePlan || onRejectPlan)
      ? {
          scope: call.display?.kind === "plan" ? call.display.title : call.name,
          risk: planRevision,
          onApprove: onApprovePlan
            ? () => onApprovePlan(call.id, planRevision)
            : undefined,
          onReject: onRejectPlan
            ? () => onRejectPlan(call.id, planRevision)
            : undefined,
        }
      : undefined)

  return (
    <ToolCall
      call={call}
      content={content}
      renderOutput={renderOutput}
      permission={resolvedPermission}
      actions={actions}
      onCancel={onCancel}
      onRetry={onRetry}
      onReconcile={onReconcile}
      onDownload={onDownload}
      presentation={presentation}
      defaultExpanded={defaultExpanded}
      data={data}
    />
  )
}
