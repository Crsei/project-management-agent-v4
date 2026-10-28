"use client"
import { TimelineRow } from "../timeline"
import { RuntimeStatusBadge } from "../../ui/runtime-status-badge"
import { Button } from "../../ui/button"
import { DataTable } from "../data-table"
import {
  executionGeometry,
  type ExecutionInterval,
} from "../../../lib/analytics-resource-model"
import { useI18n } from "../../../lib/i18n-provider"
import styles from "./agent-execution-timeline.module.css"
export function AgentExecutionTimeline({
  intervals,
  range,
  onOpenRun,
}: {
  intervals: readonly ExecutionInterval[]
  range: { from: string; to: string }
  onOpenRun?: (run: ExecutionInterval) => void
}) {
  const { t, locale } = useI18n(),
    geometry = executionGeometry(intervals, range)
  const timestamp = (v: string | null) =>
    v
      ? new Intl.DateTimeFormat(locale, {
          dateStyle: "short",
          timeStyle: "medium",
          timeZone: "UTC",
        }).format(new Date(v))
      : t("analytics.missing")
  return (
    <section>
      <h2>{t("analytics.execution")}</h2>
      <p>
        {t("analytics.executionDefinition")} · UTC · {range.from} → {range.to}
      </p>
      <div className={styles.viewport}>
        {geometry.map((g) => (
          <TimelineRow
            key={g.record.id}
            id={g.record.id}
            sidebar={
              <div>
                <Button
                  variant="ghost"
                  disabled={!onOpenRun}
                  onClick={() => onOpenRun?.(g.record)}
                >
                  {g.record.label}
                </Button>
                <RuntimeStatusBadge status={g.record.runtimeStatus} />
              </div>
            }
          >
            <div className={styles.track}>
              {g.visible && (
                <div
                  className={styles.bar}
                  style={{
                    left: `${g.left}%`,
                    width: `${Math.max(g.width ?? 0, 0.5)}%`,
                  }}
                  data-ongoing={g.ongoing}
                />
              )}
            </div>
          </TimelineRow>
        ))}
      </div>
      <DataTable
        rows={intervals}
        caption={t("analytics.execution")}
        getRowId={(r) => r.id}
        getRowLabel={(r) => r.label}
        onActivateRow={onOpenRun}
        columns={[
          { id: "run", header: "Run", cell: (r) => r.label },
          {
            id: "start",
            header: t("analytics.actualStart"),
            cell: (r) => timestamp(r.startedAt),
          },
          {
            id: "end",
            header: t("analytics.actualEnd"),
            cell: (r) =>
              r.endedAt
                ? timestamp(r.endedAt)
                : `${t("analytics.unfinished")} · ${r.asOf}`,
          },
          {
            id: "status",
            header: t("analytics.execution"),
            cell: (r) => <RuntimeStatusBadge status={r.runtimeStatus} />,
          },
          {
            id: "acceptance",
            header: t("analytics.acceptance"),
            cell: (r) => t(`analytics.acceptance.${r.acceptance}`),
          },
          {
            id: "wait",
            header: t("analytics.waitingReason"),
            cell: (r) => r.waitingReason ?? "—",
          },
        ]}
      />
    </section>
  )
}
