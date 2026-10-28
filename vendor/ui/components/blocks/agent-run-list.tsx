"use client"
import type { AgentRunSnapshot } from "../../lib/agent-board-model"
import { runGroup, runGroups } from "../../lib/agent-board-view"
import { useI18n } from "../../lib/i18n-provider"
import { AgentRunRow } from "./agent-run-row"
import styles from "./agent-board.module.css"
export type AgentRunCollectionProps = {
  records: readonly AgentRunSnapshot[]
  selectedRunId?: string | null
  onOpen?: (runId: string) => void
}
export function AgentRunList({
  records,
  selectedRunId,
  onOpen,
}: AgentRunCollectionProps) {
  const { t } = useI18n()
  return (
    <div>
      {runGroups.map((id) => {
        const runs = records.filter((run) => runGroup(run.runtimeStatus) === id)
        return runs.length ? (
          <section key={id} aria-label={t(`agentBoard.${id}`)}>
            <h2 className={styles.groupTitle}>
              {t(`agentBoard.${id}`)} · {runs.length}
            </h2>
            {runs.map((run) => (
              <AgentRunRow
                key={run.runId}
                run={run}
                selected={selectedRunId === run.runId}
                onOpen={onOpen}
              />
            ))}
          </section>
        ) : null
      })}
    </div>
  )
}
