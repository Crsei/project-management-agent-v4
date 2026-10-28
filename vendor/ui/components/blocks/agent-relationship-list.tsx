"use client"
import type { RunRelationship } from "../../lib/agent-board-model"
import { Item } from "../ui/item"
import { DataRegion } from "../ui/data-region"
import { useI18n } from "../../lib/i18n-provider"
export function AgentRelationshipList({
  records,
  runId,
  onOpen,
}: {
  records: readonly RunRelationship[]
  runId: string
  onOpen?: (runId: string) => void
}) {
  const { t } = useI18n()
  const items = records.filter(
    (item) => item.sourceRunId === runId || item.targetRunId === runId,
  )
  return (
    <DataRegion
      state={items.length ? "success" : "empty"}
      hasContent={items.length > 0}
      emptyTitle={t("agentBoard.noRelationships")}
    >
      {items.map((item) => {
        const target =
          item.sourceRunId === runId ? item.targetRunId : item.sourceRunId
        return (
          <Item
            key={item.id}
            title={item.label}
            description={`${item.kind} · ${target}`}
            onSelect={onOpen ? () => onOpen(target) : undefined}
          />
        )
      })}
    </DataRegion>
  )
}
