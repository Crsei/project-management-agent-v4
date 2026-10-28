"use client"
import type { AgentRunSnapshot } from "../../lib/agent-board-model"
import { durationLabel } from "../../lib/agent-board-view"
import { useI18n } from "../../lib/i18n-provider"
import { RuntimeStatusBadge } from "../ui/runtime-status-badge"
import styles from "./agent-board.module.css"
export function AgentRunProperties({ run }: { run: AgentRunSnapshot }) {
  const { t } = useI18n()
  const elapsed =
    run.stage?.durationMs ??
    (run.startedAt && run.endedAt
      ? Date.parse(run.endedAt) - Date.parse(run.startedAt)
      : undefined)
  return (
    <span className={styles.properties}>
      <span>
        {run.agentName} · {run.model ?? "—"}
      </span>
      <RuntimeStatusBadge status={run.runtimeStatus} />
      <span>
        {t("agentBoard.duration")}: {durationLabel(elapsed)}
      </span>
      <span>
        {t("agentBoard.attempt")}: {run.attempt ?? "—"}
      </span>
    </span>
  )
}
