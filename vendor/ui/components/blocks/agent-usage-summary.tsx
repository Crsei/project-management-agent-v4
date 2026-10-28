"use client"
import type {
  AgentRunSnapshot,
  UsageObservation,
} from "../../lib/agent-board-model"
import { summarizeUsage, durationLabel } from "../../lib/agent-board-view"
import { useI18n } from "../../lib/i18n-provider"
import { RuntimeStatusBadge } from "../ui/runtime-status-badge"
import { MetricSummary } from "./metric-summary"
import { DataTable } from "./data-table"
import styles from "./agent-board.module.css"
export function AgentUsageSummary({
  observations,
  runs,
  scopeLabel,
}: {
  observations: readonly UsageObservation[]
  runs: readonly AgentRunSnapshot[]
  scopeLabel: string
}) {
  const { t, number } = useI18n()
  const summary = summarizeUsage(observations, runs)
  return (
    <section className={styles.section}>
      <h2>{t("agentBoard.insights")}</h2>
      <p>{scopeLabel}</p>
      <p>
        {t("agentBoard.range")}: {summary.timestamps[0] ?? "—"} —{" "}
        {summary.timestamps.at(-1) ?? "—"}
      </p>
      <p>
        {t("agentBoard.coverageDetail", {
          covered: summary.coveredRuns,
          runs: runs.length,
          tokens: summary.tokenRuns,
        })}
      </p>
      <p>
        {summary.estimated
          ? t("agentBoard.estimated")
          : t("agentBoard.observed")}
      </p>
      <MetricSummary
        items={[
          {
            id: "tokens",
            label: t("agentBoard.tokens"),
            value: summary.tokens === undefined ? "—" : number(summary.tokens),
          },
          {
            id: "cost",
            label: t("agentBoard.cost"),
            value:
              [...summary.currencies]
                .map(
                  ([currency, cost]) =>
                    `${currency} ${number(cost, { maximumFractionDigits: 4 })}`,
                )
                .join(" · ") || "—",
          },
          {
            id: "duration",
            label: t("agentBoard.duration"),
            value: durationLabel(summary.durationMs),
          },
          {
            id: "coverage",
            label: t("agentBoard.coverage"),
            value: `${summary.coveredRuns}/${runs.length}`,
          },
        ]}
      />
      <DataTable
        caption={t("agentBoard.insights")}
        rows={summary.accepted}
        getRowId={(row) => row.observationId}
        getRowLabel={(row) => row.runId}
        columns={[
          { id: "run", header: "Run", cell: (row) => row.runId },
          {
            id: "tokens",
            header: t("agentBoard.tokens"),
            cell: (row) =>
              row.tokens === undefined ? "—" : number(row.tokens),
          },
          {
            id: "cost",
            header: t("agentBoard.cost"),
            cell: (row) =>
              row.cost === undefined
                ? "—"
                : `${row.currency ?? "—"} ${row.cost}`,
          },
          {
            id: "source",
            header: t("agentBoard.status"),
            cell: (row) =>
              row.estimated
                ? t("agentBoard.estimated")
                : t("agentBoard.observed"),
          },
        ]}
        data={{
          state: summary.accepted.length ? "success" : "empty",
          emptyTitle: t("agentBoard.noUsage"),
        }}
      />
      {summary.excluded.length > 0 && (
        <div className={styles.notice}>
          <p>{t("agentBoard.excluded")}</p>
          {summary.excluded.map((item) => (
            <p key={item.observationId}>
              {item.observationId} · {item.runId} · {item.tokens ?? "—"} Tokens
              · {item.inclusion}
            </p>
          ))}
        </div>
      )}
      <h3>{t("agentBoard.status")}</h3>
      <dl>
        {[...new Set(runs.map((run) => run.runtimeStatus))].map((status) => (
          <div key={status} className={styles.properties}>
            <dt>
              <RuntimeStatusBadge status={status} />
            </dt>
            <dd>{runs.filter((run) => run.runtimeStatus === status).length}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
