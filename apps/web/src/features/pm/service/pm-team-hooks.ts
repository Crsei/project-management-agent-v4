import type { TeamDirectory, TeamWorkload } from "@contracts"
import { pmKeys } from "./pm-data"
import { usePmService, usePrivateQuery } from "./pm-service"
import { allowed } from "./pm-ui"

export function useTeamDirectory(enabled = true) {
  const { actor, workspace } = usePmService()
  const key = [...pmKeys.workspace(window.location.origin, actor?.id ?? "anonymous", workspace?.id ?? "none"), "teams", "directory"]
  return usePrivateQuery<TeamDirectory>(key, allowed(workspace, "access.manage") ? "access.manage" : "domain.read", undefined, (client, workspaceId, signal) => client.getTeamDirectory(workspaceId, { signal }), enabled)
}

export function useTeamWorkload(enabled = true) {
  const { actor, workspace } = usePmService()
  const key = [...pmKeys.workspace(window.location.origin, actor?.id ?? "anonymous", workspace?.id ?? "none"), "teams", "workload"]
  return usePrivateQuery<TeamWorkload>(key, allowed(workspace, "access.manage") ? "access.manage" : "directory.read", undefined, (client, workspaceId, signal) => client.getTeamWorkload(workspaceId, { signal }), enabled)
}
