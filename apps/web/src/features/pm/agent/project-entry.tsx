import { Bot } from "lucide-react"
import { useLocation, useNavigate } from "react-router"
import { Button } from "@/components/ui/button"
import { allowed, useText } from "../service/pm-ui"
import { usePmService } from "../service/pm-service"

/**
 * Secondary project-level entry. It only carries UI context into the existing
 * Agent chat; it does not send a model request, read extra sources or write.
 */
export function ProjectAgentAction({ projectId, projectTitle }: { projectId: string; projectTitle: string }) {
  const { workspace } = usePmService()
  const navigate = useNavigate()
  const location = useLocation()
  const t = useText()
  if (!workspace || !allowed(workspace, "domain.read", projectId)) return null
  const open = () => {
    const query = new URLSearchParams({
      workspace: workspace.id,
      project: projectId,
      returnTo: `${location.pathname}${location.search}${location.hash}`,
    })
    navigate(`/agent/workspace?${query}`)
  }
  return <Button
    type="button"
    variant="ghost"
    size="icon"
    data-testid={`project-agent-${projectId}`}
    aria-label={t(`打开 ${projectTitle} 的 Agent 助手`, `Open the Agent assistant for ${projectTitle}`)}
    title={t("Agent 助手 · 携带当前项目上下文", "Agent assistant · current project context")}
    onClick={open}
  >
    <Bot aria-hidden="true" />
  </Button>
}
