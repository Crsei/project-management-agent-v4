import { useEffect, useRef } from "react"
import type { AgentWorkspace, ExecutionEnvironment } from "@agent-workspace/contracts/chat"
import { X } from "lucide-react"
import { useAgentText } from "../i18n"
import { ExecutionTerminals, useExecutionTerminals } from "./execution-terminals"
import "../../styles/pm-chat.css"
import styles from "./run-board-terminal.module.css"

/** Mount only after an explicit terminal action; reading and creating a PTY stay server-owned. */
export function RunBoardTerminal({ workspace, threadId, environment, onClose }: {
  workspace: AgentWorkspace
  threadId: string
  environment: ExecutionEnvironment
  onClose: () => void
}) {
  const t = useAgentText()
  const controller = useExecutionTerminals({ workspace, threadId, environment, onShow: () => {}, enabled: true })
  const openSession = useRef(controller.openSession)
  openSession.current = controller.openSession
  const target = executionTerminalTarget(threadId, environment)
  useEffect(() => {
    if (target) void openSession.current(target).catch(() => {})
  }, [])
  return <div className={styles.root}>
    <div className={styles.header}>
      <strong>{t("面板终端", "Panel terminal")}</strong>
      <span>{t("只读观察与手动命令；不替代模型输出或业务完成。", "Read-only observation and manual commands; not model output or business completion.")}</span>
      <button type="button" className={styles.close} aria-label={t("隐藏面板终端", "Hide panel terminal")} title={t("隐藏面板终端", "Hide panel terminal")} onClick={onClose}><X aria-hidden="true" /></button>
    </div>
    <ExecutionTerminals controller={controller} />
  </div>
}

function executionTerminalTarget(threadId: string, environment: ExecutionEnvironment) {
  if (environment.version !== 2 || !environment.agentWorkspaceId || environment.agentWorkspaceRevision === null || !environment.executionPath) return null
  return { threadId, agentWorkspaceId: environment.agentWorkspaceId, agentWorkspaceRevision: environment.agentWorkspaceRevision }
}
