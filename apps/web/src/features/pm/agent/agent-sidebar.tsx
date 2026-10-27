import { Bot, FileCheck2, MessagesSquare, PlayCircle, Sparkles, X, Zap } from "lucide-react"
import { Link } from "react-router"
import { usePmService } from "../service/pm-service"
import { useText } from "../service/pm-ui"
import { AgentThreadList } from "./agent-thread-list"
import styles from "./agent-chat.module.css"

export function AgentSidebar({ open, onClose, model, modelReady, statusPending, error, onRetry, busy = false }: {
  open: boolean
  onClose: () => void
  model: string | null
  modelReady: boolean
  statusPending: boolean
  error: string | null
  onRetry: () => void
  busy?: boolean
}) {
  const t = useText()
  const { workspace } = usePmService()
  const disabled = (label: string, Icon: typeof MessagesSquare) => <button type="button" className={`${styles.navButton} ${styles.navDisabled}`} disabled title={t("尚未接入", "Not connected yet")}>
    <Icon size={15} aria-hidden="true" />
    <span>{label}</span>
    <span className={styles.navBadge}>{t("未接入", "Soon")}</span>
  </button>
  return <aside className={styles.sidebar} data-open={open} aria-label={t("Agent 工作区侧栏", "Agent workspace sidebar")}>
    <div className={styles.sidebarHeader}>
      <div className={styles.brandIcon}><Bot size={17} aria-hidden="true" /></div>
      <div className={styles.brandText}>
        <span className={styles.brandTitle}>{t("Agent 工作区", "Agent workspace")}</span>
        <span className={styles.brandMeta}>{t("持久会话 · PM 服务", "Persistent sessions · PM service")}</span>
      </div>
      <button type="button" className={`${styles.iconButton} ${styles.closeSidebar}`} onClick={onClose} aria-label={t("收起侧栏", "Close sidebar")}>
        <X size={15} aria-hidden="true" />
      </button>
    </div>
    <div className={styles.sidebarBody}>
      <div className={styles.groupLabel}>{t("会话工作区", "Session workspace")}</div>
      <button type="button" className={`${styles.navButton} ${styles.navActive}`} aria-current="page">
        <MessagesSquare size={15} aria-hidden="true" />
        <span>{t("对话", "Chat")}</span>
      </button>
      {disabled(t("运行记录", "Runs"), PlayCircle)}
      {disabled(t("待审建议", "Proposals"), FileCheck2)}
      {workspace && <Link className={styles.navButton} to={`/pm/${encodeURIComponent(workspace.id)}/automations`}>
        <Zap size={15} aria-hidden="true" />
        <span>{t("自动化", "Automations")}</span>
      </Link>}
      <div className={styles.separator} />
      {error && <div className={styles.noticeError} role="alert">
        <span>{error}</span>
        <div className={styles.noticeActions}>
          <button type="button" className={styles.stopButton} onClick={onRetry}>{t("重试读取", "Retry")}</button>
        </div>
      </div>}
      <fieldset className={styles.threadControls} disabled={busy} aria-label={t("聊天线程", "Chat threads")}><AgentThreadList /></fieldset>
    </div>
    <div className={styles.sidebarFooter}>
      <span className={`${styles.modelDot}${modelReady ? ` ${styles.modelDotReady}` : ""}`} aria-hidden="true" />
      <Sparkles size={12} aria-hidden="true" />
      <span>{statusPending ? t("读取模型状态…", "Reading model status…") : modelReady ? model ?? t("模型已配置", "Model configured") : t("模型未配置", "Model not configured")}</span>
    </div>
  </aside>
}
