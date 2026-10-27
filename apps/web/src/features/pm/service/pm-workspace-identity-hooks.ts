import { workspaceIdentitySchema } from "../../../../../../packages/contracts/src/workspace-identity"
import { pmKeys } from "./pm-data"
import { usePmService, usePrivateQuery } from "./pm-service"

/** Presentation identity needs current membership, not business/project read permission. */
export function useWorkspaceIdentity() {
  const { actor, workspace } = usePmService()
  const key = [...pmKeys.workspace(window.location.origin, actor?.id ?? "anonymous", workspace?.id ?? "none"), "identity"]
  return usePrivateQuery(key, null, undefined, async (client, workspaceId, signal) =>
    workspaceIdentitySchema.parse(await client.getWorkspaceIdentity(workspaceId, { signal })))
}
