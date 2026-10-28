"use client"
import { Tree, type TreeNode } from "../ui/tree"
import { ToolCall } from "./tool-call"
import { DataRegion } from "../ui/data-region"
import { useI18n } from "../../lib/i18n-provider"
import { redact, previewText } from "../../lib/redact"
import type { TraceStep } from "../../lib/agent-board-model"
import styles from "./agent-board.module.css"
export type ExecutionTraceTreeProps = {
  steps: readonly TraceStep[]
  selectedStepId?: string
  onSelect?: (stepId: string) => void
  expandedIds?: string[]
  onExpandedChange?: (ids: string[]) => void
}
/** Malformed/cyclic parent links are retained as roots rather than silently lost. */
export function ExecutionTraceTree({
  steps,
  selectedStepId,
  onSelect,
  expandedIds,
  onExpandedChange,
}: ExecutionTraceTreeProps) {
  const { t } = useI18n()
  const records = [
    ...new Map(steps.map((step) => [step.stepId, step])).values(),
  ]
  const nodes = new Map(
    records.map((step) => [
      step.stepId,
      {
        id: step.stepId,
        label: redact(step.name),
        status: step.status,
        children: [],
      } as TreeNode,
    ]),
  )
  const roots: TreeNode[] = []
  for (const step of records) {
    let parent = step.parentStepId
    const visited = new Set([step.stepId])
    let cyclic = false
    while (parent && nodes.has(parent)) {
      if (visited.has(parent)) {
        cyclic = true
        break
      }
      visited.add(parent)
      parent = records.find((item) => item.stepId === parent)?.parentStepId
    }
    if (!cyclic && step.parentStepId && nodes.has(step.parentStepId))
      nodes.get(step.parentStepId)!.children!.push(nodes.get(step.stepId)!)
    else roots.push(nodes.get(step.stepId)!)
  }
  const selected = records.find((step) => step.stepId === selectedStepId)
  return (
    <DataRegion
      state={steps.length ? "success" : "empty"}
      hasContent={steps.length > 0}
      emptyTitle={t("agentBoard.noTrace")}
    >
      <Tree
        nodes={roots}
        label={t("agentBoard.trace")}
        selectedId={selectedStepId}
        onSelect={onSelect ? (node) => onSelect(node.id) : undefined}
        expandedIds={expandedIds}
        onExpandedChange={onExpandedChange}
      />
      {selected && (
        <div className={styles.section}>
          {selected.tool ? (
            <ToolCall
              key={selected.stepId}
              call={{ ...selected.tool, status: selected.status }}
              defaultExpanded
            />
          ) : (
            <pre className={styles.pre}>
              {previewText(redact(selected.summary ?? selected.name)).text}
            </pre>
          )}
        </div>
      )}
    </DataRegion>
  )
}
