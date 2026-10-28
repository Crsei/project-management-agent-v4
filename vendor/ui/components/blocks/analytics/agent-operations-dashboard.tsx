"use client"
import type { ReactNode } from "react"
import { AgentExecutionTimeline } from "./agent-execution-timeline"
import { AgentUsageSummary } from "../agent-usage-summary"
import type { ExecutionInterval } from "../../../lib/analytics-resource-model"
import type {
  AgentRunSnapshot,
  UsageObservation,
} from "../../../lib/agent-board-model"
import { useI18n } from "../../../lib/i18n-provider"
export function AgentOperationsDashboard({
  intervals,
  range,
  runs,
  observations,
  onOpenRun,
  children,
}: {
  intervals: readonly ExecutionInterval[]
  range: { from: string; to: string }
  runs: readonly AgentRunSnapshot[]
  observations: readonly UsageObservation[]
  onOpenRun?: (run: ExecutionInterval) => void
  children?: ReactNode
}) {
  const { t } = useI18n()
  return (
    <>
      <AgentExecutionTimeline
        intervals={intervals}
        range={range}
        onOpenRun={onOpenRun}
      />
      <p>{t("analytics.usageDefinition")}</p>
      <AgentUsageSummary
        observations={observations}
        runs={runs}
        scopeLabel={t("analytics.local")}
      />
      {children}
    </>
  )
}
