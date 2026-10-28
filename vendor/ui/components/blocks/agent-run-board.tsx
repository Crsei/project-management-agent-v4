"use client"
import styles from "./agent-board.module.css"
import { Board } from "./item-board"
import { AgentRunCard } from "./agent-run-card"
import type { AgentRunCollectionProps } from "./agent-run-list"
import { runGroups, runGroup } from "../../lib/agent-board-view"
import { useI18n } from "../../lib/i18n-provider"
/** Runtime grouping is read only. No move callback is exposed. */
export function AgentRunBoard({
  records,
  selectedRunId,
  onOpen,
}: AgentRunCollectionProps) {
  const { t } = useI18n()
  return (
    <div className={styles.boardViewport}>
      <Board
        items={records}
        queryKey="agent-runs"
        getItemLabel={(run) => run.title}
        groups={runGroups
          .filter(
            (id) =>
              id !== "other" ||
              records.some((run) => runGroup(run.runtimeStatus) === "other"),
          )
          .map((id) => ({
            key: id,
            queryKey: "agent-runs",
            dataState: records.some((run) => runGroup(run.runtimeStatus) === id)
              ? "success"
              : "empty",
            loadedCount: records.filter(
              (run) => runGroup(run.runtimeStatus) === id,
            ).length,
            label: t(`agentBoard.${id}`),
            itemIds: records
              .filter((run) => runGroup(run.runtimeStatus) === id)
              .map((run) => run.runId),
          }))}
        getItemId={(run) => run.runId}
        renderItem={(run) => (
          <AgentRunCard
            run={run}
            selected={run.runId === selectedRunId}
            onOpen={onOpen}
          />
        )}
      />
    </div>
  )
}
