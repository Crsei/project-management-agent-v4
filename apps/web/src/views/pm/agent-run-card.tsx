import { Activity, CircleAlert, CircleHelp, CircleMinus, CirclePause, Clock3 } from "lucide-react"
import { Avatar } from "@/components/ui/avatar"
import presentation from "@/components/blocks/work-items.module.css"
import styles from "./agent-run-card.module.css"

type AgentRunCardProps = {
  id: string
  title: string
  agent?: string
  provider: string
  model: string
  folder: string
  branch?: string
  status: "queued" | "running" | "waiting" | "attention" | "ended" | "idle" | "unknown"
  statusLabel: string
  metadata: string
  metadataLabel: string
  metadataDateTime?: string
  step: string
  previewLabel: string
  onOpen: (trigger: HTMLButtonElement) => void
}

const statusIcons = {
  queued: Clock3,
  running: Activity,
  waiting: CirclePause,
  attention: CircleAlert,
  ended: CircleMinus,
  idle: CircleMinus,
  unknown: CircleHelp,
}

export function AgentRunCard({
  id,
  title,
  agent,
  provider,
  model,
  folder,
  branch,
  status,
  statusLabel,
  metadata,
  metadataLabel,
  metadataDateTime,
  step,
  previewLabel,
  onOpen,
}: AgentRunCardProps) {
  const StatusIcon = statusIcons[status]

  return (
    <button
      type="button"
      className={`${presentation.card} ${styles.card}`}
      data-agent-run={id}
      aria-label={previewLabel}
      title={previewLabel}
      onClick={(event) => onOpen(event.currentTarget)}
    >
      <span className={presentation.cardLabels}>
        <span
          className={`${presentation.cardLabel} ${styles.provider}`}
          title={`${provider} · ${model}`}
        >
          <i aria-hidden="true" />
          <span className={styles.truncate}>{provider}</span>
        </span>
        <span
          className={`${presentation.cardLabel} ${styles.folder}`}
          title={[folder, branch].filter(Boolean).join(" · ")}
        >
          <i aria-hidden="true" />
          <span className={styles.truncate}>{folder}</span>
        </span>
      </span>
      <span className={presentation.cardIdentity}>
        <span className={`${presentation.cardTitle} ${styles.title}`} title={title}>{title}</span>
      </span>
      <span className={presentation.cardProgress} title={step}>
        <span className={styles.truncate}>{step}</span>
      </span>
      <span className={presentation.cardMeta}>
        <span className={`${presentation.cardKey} ${styles.key}`} title={id}>{id}</span>
        <span className={`${presentation.cardMetaItem} ${styles.metadata}`} title={metadataLabel} aria-label={metadataLabel}>
          <Clock3 size={12} aria-hidden="true" />
          {metadataDateTime ? <time dateTime={metadataDateTime}>{metadata}</time> : <span>{metadata}</span>}
        </span>
        <span className={presentation.cardMetaSpacer} />
        <span
          className={`${presentation.cardMetaItem} ${styles.status}`}
          data-status={status}
          title={statusLabel}
          role="img"
          aria-label={statusLabel}
        >
          <StatusIcon size={14} aria-hidden="true" />
        </span>
        {agent && <span className={presentation.cardAvatars} title={agent}>
          <Avatar name={agent} size={20} />
        </span>}
      </span>
    </button>
  )
}
