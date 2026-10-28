"use client"
import { Item } from "../ui/item"
import { DataRegion } from "../ui/data-region"
import { useI18n } from "../../lib/i18n-provider"
import { dedupeAttention } from "../../lib/agent-board-view"
import { redact } from "../../lib/redact"
import type { AttentionRecord } from "../../lib/agent-board-model"
import styles from "./agent-board.module.css"
export function AttentionItem({
  record,
  onOpen,
}: {
  record: AttentionRecord
  onOpen?: (runId: string) => void
}) {
  const { t } = useI18n()
  return (
    <div className={styles.row} data-attention-id={record.attentionId}>
      <Item
        title={redact(record.title)}
        description={`${record.runId} · ${redact(record.reason)}`}
        onSelect={onOpen ? () => onOpen(record.runId) : undefined}
        trailing={
          <span className={styles.warning}>
            {record.operation?.state === "unknown"
              ? t("agentBoard.unknownOutcome")
              : t(`agentBoard.${record.kind}`)}
          </span>
        }
      />
    </div>
  )
}
export function AttentionQueue({
  records,
  onOpen,
  kind = "",
}: {
  records: readonly AttentionRecord[]
  onOpen?: (runId: string) => void
  kind?: string
}) {
  const { t } = useI18n()
  const items = dedupeAttention(records).filter(
    (item) =>
      item.operation?.state !== "confirmed" && (!kind || item.kind === kind),
  )
  return (
    <DataRegion
      state={items.length ? "success" : "empty"}
      hasContent={items.length > 0}
      emptyTitle={t("agentBoard.noAttention")}
    >
      <p className={styles.notice}>
        {t("agentBoard.attentionSummary", {
          count: items.length,
          runs: new Set(items.map((item) => item.runId)).size,
        })}
      </p>
      {items.map((item) => (
        <AttentionItem key={item.attentionId} record={item} onOpen={onOpen} />
      ))}
    </DataRegion>
  )
}
