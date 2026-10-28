"use client"
import type { RunStage } from "../../lib/agent-board-model"
import { useI18n } from "../../lib/i18n-provider"
import styles from "./agent-board.module.css"
export function RunStageSummary({
  stage,
  status,
}: {
  stage?: RunStage
  status?: string
}) {
  const { t } = useI18n()
  const valid =
    stage?.totalSteps !== undefined &&
    stage.totalSteps > 0 &&
    stage.completedSteps !== undefined &&
    stage.completedSteps >= 0 &&
    stage.completedSteps <= stage.totalSteps
  return (
    <span className={styles.stage}>
      <span>
        {t("agentBoard.stage")}: {stage?.name ?? "—"}
      </span>
      {valid && (
        <span>
          {t("agentBoard.steps", {
            completed: stage!.completedSteps!,
            total: stage!.totalSteps!,
          })}
        </span>
      )}
      {stage?.planVersion && (
        <span>{t("agentBoard.plan", { version: stage.planVersion })}</span>
      )}
      {(stage?.waitingReason ||
        status === "waiting" ||
        status === "paused") && (
        <span className={styles.warning}>
          {stage?.waitingReason ?? t("agentBoard.reasonUnknown")}
        </span>
      )}
    </span>
  )
}
