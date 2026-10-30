import { Navigate, useParams, useSearchParams } from "react-router"
import { usePmService } from "../service/pm-service"

/** Old PM thread IDs are not Chat IDs and must never be mapped to new history. */
export function AgentChatPage() {
  const { workspace } = usePmService()
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>()
  const [old] = useSearchParams()
  const next = new URLSearchParams(old)
  if (next.has("thread")) { next.delete("thread"); next.set("legacy", "1") }
  next.delete("new")
  next.set("workspace", workspace?.id || workspaceSlug || "")
  return <Navigate to={`/agent/workspace?${next}`} replace />
}
