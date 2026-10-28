"use client"
import type { ArtifactRecord, ReviewSnapshot } from "../../lib/agent-board-model"
import { safeArtifactHref } from "../../lib/agent-board-view"
import { useI18n } from "../../lib/i18n-provider"
import { Item } from "../ui/item"
import { DataRegion } from "../ui/data-region"
import styles from "./agent-board.module.css"
export function ReviewSummary({ review }: { review?: ReviewSnapshot }) {
  const { t } = useI18n()
  const href = safeArtifactHref(review?.pr?.href)
  return (
    <div className={styles.stage}>
      <span>
        {t("agentBoard.review")}:{" "}
        {t(`agentBoard.${review?.state ?? "unknown"}`)}
      </span>
      <span>
        {t("agentBoard.acceptance")}:{" "}
        {t(`agentBoard.${review?.acceptance ?? "unknown"}`)}
      </span>
      {review?.evidence && <p>{review.evidence}</p>}
      {review?.pr &&
        (href ? (
          <a href={href} target="_blank" rel="noreferrer">
            {t(`agentBoard.${review.pr.state}`)}
          </a>
        ) : (
          <span>{t(`agentBoard.${review.pr.state}`)}</span>
        ))}
    </div>
  )
}
export function ArtifactList({
  records,
}: {
  records: readonly ArtifactRecord[]
}) {
  const { t } = useI18n()
  return (
    <DataRegion
      state={records.length ? "success" : "empty"}
      hasContent={records.length > 0}
      emptyTitle={t("agentBoard.noArtifacts")}
    >
      {records.map((record) => {
        const href =
          record.availability === "available"
            ? safeArtifactHref(record.href)
            : undefined
        return (
          <section key={record.artifactId} className={styles.row}>
            <Item
              title={record.name}
              description={`${record.kind} · ${record.runId} · ${record.createdAt ?? "—"}`}
              trailing={
                href ? (
                  <a href={href} target="_blank" rel="noreferrer">
                    {t("agentBoard.open", { name: record.name })}
                  </a>
                ) : (
                  <span>{t(`agentBoard.${record.availability}`)}</span>
                )
              }
            />
            <ReviewSummary review={record.review} />
          </section>
        )
      })}
    </DataRegion>
  )
}
