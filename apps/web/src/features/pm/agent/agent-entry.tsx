import { Bot } from "lucide-react"
import { useLocation } from "react-router"
import { Button } from "@/components/ui/button"
import { usePmService } from "../service/pm-service"
import { useText } from "../service/pm-ui"
import { useOptionalPmAgentPanel } from "./agent-panel-context"

function useOpenAgentPanel() {
  const panel = useOptionalPmAgentPanel()
  const { workspace } = usePmService()
  const location = useLocation()
  return (context: { projectId?: string; entityId?: string; taskId?: string; title?: string; hasDraft?: boolean }) => {
    if (!panel || !workspace) return false
    panel.openPanel({ workspaceId: workspace.id, ...context, returnTo: `${location.pathname}${location.search}${location.hash}` })
    return true
  }
}

export function ProjectAgentPanelAction({ projectId, title, hasDraft = false, compact = false }: { projectId: string; title?: string; hasDraft?: boolean; compact?: boolean }) {
  const t = useText()
  const open = useOpenAgentPanel()
  return <Button type="button" variant="ghost" size={compact ? "icon" : "sm"} data-testid={`project-agent-panel-${projectId}`} aria-label={t("打开 Agent 助手", "Open Agent assistant")} title={t("Agent 助手 · 当前项目", "Agent assistant · current project")} onClick={() => open({ projectId, title, hasDraft })}>
    <Bot size={14} aria-hidden="true" />{!compact && t("Agent 助手", "Agent assistant")}
  </Button>
}

export function EntityAgentPanelAction({ entityId, projectId, taskId, title, hasDraft = false }: { entityId: string; projectId?: string; taskId?: string; title?: string; hasDraft?: boolean }) {
  const t = useText()
  const open = useOpenAgentPanel()
  return <Button type="button" variant="ghost" size="sm" data-testid={`entity-agent-panel-${entityId}`} aria-label={t("打开 Agent 助手", "Open Agent assistant")} title={t("Agent 助手 · 当前对象", "Agent assistant · current entity")} onClick={() => open({ projectId, entityId, taskId, title, hasDraft })}>
    <Bot size={14} aria-hidden="true" />{t("Agent 助手", "Agent assistant")}
  </Button>
}
