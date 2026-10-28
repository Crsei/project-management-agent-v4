"use client"
import { Item } from "../ui/item"
import type { AgentRunCardProps } from "./agent-run-card"
import { AgentRunProperties } from "./agent-run-properties"
import { RunStageSummary } from "./run-stage-summary"
import styles from "./agent-board.module.css"
export function AgentRunRow({
  run,
  selected,
  onOpen,
  actions,
}: AgentRunCardProps) {
  return (
    <div className={styles.row} data-run-id={run.runId}>
      <Item
        title={run.workItemRef?.title ?? run.title}
        description={
          <>
            <span>{run.runId}</span>
            <AgentRunProperties run={run} />
            <RunStageSummary stage={run.stage} status={run.runtimeStatus} />
            {run.error && <span className={styles.warning}>{run.error}</span>}
          </>
        }
        selected={selected}
        onSelect={onOpen ? () => onOpen(run.runId) : undefined}
        ariaLabel={run.title}
        trailing={actions}
      />
    </div>
  )
}
