const lastWorkspaceKeyPrefix = "pm.last-workspace.v1"
const workspaceIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function lastWorkspaceKey(origin: string, actorId: string): string {
  return `${lastWorkspaceKeyPrefix}:${origin}:${actorId}`
}

/** Restoring a workspace never crosses an account boundary or accepts a
 * damaged preference as an authorization claim. The route still re-checks the
 * current workspace list before navigating. */
export function readLastWorkspaceId(storage: Pick<Storage, "getItem">, origin: string, actorId: string): string | null {
  try {
    const value = storage.getItem(lastWorkspaceKey(origin, actorId))
    return value && workspaceIdPattern.test(value) ? value.toLowerCase() : null
  } catch {
    return null
  }
}

export function rememberLastWorkspaceId(storage: Pick<Storage, "setItem">, origin: string, actorId: string, workspaceId: string): void {
  if (!workspaceIdPattern.test(workspaceId)) return
  try {
    storage.setItem(lastWorkspaceKey(origin, actorId), workspaceId.toLowerCase())
  } catch {
    // Workspace selection remains usable when browser storage is unavailable.
  }
}
