"use client"
import type { ReactNode } from "react"
import type { AgentRunSnapshot } from "../../lib/agent-board-model"
import { useI18n } from "../../lib/i18n-provider"
import { AgentRunProperties } from "./agent-run-properties"
import { RunStageSummary } from "./run-stage-summary"
import styles from "./agent-board.module.css"
export type AgentRunCardProps = {
  run: AgentRunSnapshot
  selected?: boolean
  onOpen?: (runId: string) => void
  actions?: ReactNode
}
export function AgentRunCard({
  run,
  selected,
  onOpen,
  actions,
}: AgentRunCardProps) {
  const { t } = useI18n()
  const content = (
    <>
      <span
        className={styles.runTitle}
        title={run.workItemRef?.title ?? run.title}
      >
        {run.workItemRef?.title ?? run.title}
      </span>
      <span className={styles.meta}>{run.runId}</span>
      <AgentRunProperties run={run} />
      <RunStageSummary stage={run.stage} status={run.runtimeStatus} />
      {run.error && <span className={styles.warning}>{run.error}</span>}
      <span className={styles.meta}>
        {t("agentBoard.artifacts")}: {run.artifactCount ?? "—"} ·{" "}
        {t("agentBoard.tools")}: {run.toolCount ?? "—"}
      </span>
      <span className={styles.meta}>
        {t("agentBoard.updated")}: {run.updatedAt}
      </span>
      {run.review && (
        <span className={styles.warning}>
          {t(`agentBoard.${run.review.state}`)} ·{" "}
          {t(`agentBoard.${run.review.acceptance}`)}
        </span>
      )}
    </>
  )
  return (
    <article
      className={styles.card}
      data-run-id={run.runId}
      data-selected={Boolean(selected)}
    >
      {onOpen ? (
        <button
          type="button"
          className={styles.cardMain}
          aria-label={t("agentBoard.open", { name: run.title })}
          aria-pressed={selected}
          onClick={() => onOpen(run.runId)}
        >
          {content}
        </button>
      ) : (
        <div className={styles.cardMain}>{content}</div>
      )}
      {actions && <div className={styles.actions}>{actions}</div>}
    </article>
  )
}
