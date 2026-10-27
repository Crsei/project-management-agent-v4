import { useCallback, useEffect, useMemo } from "react"
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router"
import { usePmService } from "../service/pm-service"
import { AgentConversation, type AgentConversationHandoff } from "./agent-conversation"
import { agentConversationParams, type AgentConversationLocation } from "./agent-conversation-state"

export function AgentChatPage() {
  const { workspace, actor, actorEpoch } = usePmService()
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>()
  const [params, setParams] = useSearchParams()
  const route = useLocation()
  const navigate = useNavigate()
  const location = useMemo<AgentConversationLocation>(() => ({
    threadId: params.get("thread"),
    projectId: params.get("project"),
    taskId: params.get("task"),
    returnTo: params.get("returnTo"),
    newChat: params.get("new") === "1",
  }), [params])
  const onNavigate = useCallback((next: AgentConversationLocation) => setParams(agentConversationParams(next), { replace: true, state: null }), [setParams])
  const handoff = (route.state as { agentConversation?: AgentConversationHandoff } | null)?.agentConversation
  useEffect(() => {
    if (!workspace || !actor || !handoff || handoff.identity !== `${actor.id}:${actorEpoch}:${workspace.id}:${workspace.version}`) return
    // Consume the transfer once; reload/back must not resurrect an old draft.
    navigate({ pathname: route.pathname, search: route.search, hash: route.hash }, { replace: true, state: null })
  }, [actor, actorEpoch, handoff, navigate, route.hash, route.pathname, route.search, workspace])
  return <AgentConversation
    location={location}
    onNavigate={onNavigate}
    root={`/pm/${encodeURIComponent(workspaceSlug || workspace?.id || "")}`}
    initialHandoff={handoff}
  />
}
