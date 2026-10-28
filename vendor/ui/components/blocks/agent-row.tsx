"use client"
import { useI18n } from "../../lib/i18n-provider"

import { Bot } from "lucide-react"
import { Item } from "../ui/item"
import { Button } from "../ui/button"
import { RuntimeStatusBadge } from "../ui/runtime-status-badge"
import styles from "./entity-row.module.css"

export type AgentRecord = {
  id: string
  name: string
  status: string
  model?: string
  provider?: string
  stage?: string
  elapsed?: string
  activeSessionCount?: number
  aggregate?: boolean
  offline?: boolean
  updatedAt?: string
}
export type AgentRowProps = {
  agent: AgentRecord
  compact?: boolean
  selected?: boolean
  disabled?: boolean
  onSelect?: () => void
  action?: {
    label: string
    onAction: () => void
    busy?: boolean
    disabledReason?: string
  }
}
export function AgentRow({
  agent,
  compact,
  selected,
  disabled,
  onSelect,
  action,
}: AgentRowProps) {
  const { t } = useI18n()

  const name = agent.name.trim() || t("agentRow.unnamedAgent")
  const description = [
    agent.id,
    agent.model ?? t("agentRow.modelNotConfigured"),
    agent.provider,
    agent.stage,
    agent.elapsed,
    agent.offline
      ? t("common.offlineLastUpdatedValue", {
          value0: agent.updatedAt ?? t("common.unknown"),
        })
      : undefined,
  ]
    .filter(Boolean)
    .join(" · ")
  return (
    <div className={styles.row} data-entity-id={agent.id}>
      <Item
        title={name}
        description={compact ? undefined : description}
        leading={
          <span className={styles.identity}>
            <Bot />
          </span>
        }
        selected={selected}
        disabled={disabled}
        onSelect={onSelect}
        ariaLabel={`${name} ${agent.id}`}
        trailing={
          <>
            {agent.aggregate && (
              <span className={styles.aggregate}>
                {t("agentRow.aggregate")}
              </span>
            )}
            <RuntimeStatusBadge status={agent.status} />
            <span
              className={styles.load}
              aria-label={t("agentRow.activeSessions")}
            >
              {agent.activeSessionCount ?? "—"}
            </span>
            {action && (
              <Button
                variant="ghost"
                size="sm"
                onClick={action.onAction}
                disabled={Boolean(action.disabledReason)}
                loading={action.busy}
              >
                {action.label}
              </Button>
            )}
          </>
        }
      />
      {compact && !agent.model && (
        <p className={styles.reason}>{t("agentRow.modelNotConfigured")}</p>
      )}
      {compact && agent.offline && (
        <p className={styles.reason}>
          {t("agentRow.offlineLastUpdated")}
          {agent.updatedAt ?? t("agentRow.unknown")}
        </p>
      )}
      {action?.disabledReason && (
        <p className={styles.reason}>
          {action.label}
          {t("agentRow.unavailable")}
          {action.disabledReason}
        </p>
      )}
    </div>
  )
}
