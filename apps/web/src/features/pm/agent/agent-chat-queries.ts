import { useCallback } from "react"
import { ApiError } from "@contracts"
import { pmKeys } from "../service/pm-data"
import { usePmService, usePrivateQuery } from "../service/pm-service"

export function agentErrorText(error: unknown, en: boolean): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`
  if (error instanceof Error) return error.message
  return en ? "The request failed." : "请求失败。"
}

export function useAgentChatQueries() {
  const { actor, workspace } = usePmService()
  const key = useCallback((suffix: string[]) => [...pmKeys.agentChat(window.location.origin, actor?.id ?? "anonymous", workspace?.id ?? "none"), ...suffix], [actor?.id, workspace?.id])
  const status = usePrivateQuery(key(["status"]), "domain.read", undefined, (client, workspaceId, signal) => client.getAgentChatStatus(workspaceId, { signal }))
  const threads = usePrivateQuery(key(["threads"]), "domain.read", undefined, (client, workspaceId, signal) => client.listAgentThreads(workspaceId, { signal }))
  return { key, status, threads }
}
