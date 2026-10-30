import { ApiError, type ArtifactVisibility, type ChangeNotification, type Entity, type EntityKind, type ProjectManagementClient } from "@contracts"
import type { QueryClient, QueryKey } from "@tanstack/react-query"

export const pmKeys = {
  private: (instance: string) => ["pm", instance] as const,
  workspaces: (instance: string, actorId: string) => ["pm", instance, actorId, "workspaces"] as const,
  workspace: (instance: string, actorId: string, workspaceId: string) => ["pm", instance, actorId, workspaceId] as const,
  entities: (instance: string, actorId: string, workspaceId: string, kind: EntityKind, projectId?: string, visibility: ArtifactVisibility = "visible") => ["pm", instance, actorId, workspaceId, "entities", kind, projectId ?? null, visibility] as const,
  entity: (instance: string, actorId: string, workspaceId: string, id: string) => ["pm", instance, actorId, workspaceId, "entity", id] as const,
  members: (instance: string, actorId: string, workspaceId: string) => ["pm", instance, actorId, workspaceId, "members"] as const,
  changes: (instance: string, actorId: string, workspaceId: string, projectId?: string) => ["pm", instance, actorId, workspaceId, "changes", projectId ?? null] as const,
  dashboard: (instance: string, actorId: string, workspaceId: string, module: "personal" | "time" | "sprints" | "portfolio" | "planning") => ["pm", instance, actorId, workspaceId, "dashboard", module] as const,
  projectExtras: (instance: string, actorId: string, workspaceId: string) => ["pm", instance, actorId, workspaceId, "projects", "extras"] as const,
  projectDirectory: (instance: string, actorId: string, workspaceId: string) => ["pm", instance, actorId, workspaceId, "projects", "directory"] as const,
  projectAudit: (instance: string, actorId: string, workspaceId: string, projectId: string) => ["pm", instance, actorId, workspaceId, "projects", "audit", projectId] as const,
}

export async function refreshPmSnapshots(queryClient: QueryClient, queryKey: QueryKey, throwOnError = false) {
  // Freeze the required readers before cancellation can unmount their observers.
  const active = throwOnError ? queryClient.getQueryCache().findAll({ queryKey, type: "active" }) : []
  // Invalidating an initial pending query alone can reuse its in-flight promise.
  // Cancel first so a multi-page snapshot cannot miss an insertion behind its cursor.
  await queryClient.cancelQueries({ queryKey })
  if (!throwOnError) {
    await queryClient.invalidateQueries({ queryKey })
    return
  }
  await queryClient.invalidateQueries({ queryKey, refetchType: "none" })
  // refetchQueries swallows cancelled reads, even with throwOnError. A native
  // SSE invalidation can cancel the 410 snapshot read and falsely mark it done.
  // fetchQuery preserves that failure: only completed authoritative reads allow
  // the caller to advance its cursor. Disabled queries remain untouched.
  await Promise.all(active.map(query => queryClient.fetchQuery({ ...query.options, queryKey: query.queryKey, staleTime: 0 })))
}

export async function readAllEntities(client: ProjectManagementClient, workspaceId: string, kind: EntityKind, projectId: string | undefined, signal: AbortSignal, visibility: ArtifactVisibility = "visible"): Promise<Entity[]> {
  const entities = new Map<string, Entity>()
  const cursors = new Set<string>()
  let after: string | undefined
  do {
    signal.throwIfAborted()
    const page = await client.listEntities(workspaceId, { kind, projectId, after, limit: 100, visibility }, { signal })
    for (const entity of page.items) entities.set(entity.id, entity)
    if (page.nextCursor !== null && cursors.has(page.nextCursor)) throw new ApiError(502, { error: { code: "invalid_response" } })
    after = page.nextCursor ?? undefined
    if (after) cursors.add(after)
  } while (after)
  return [...entities.values()]
}

function expiredHead(error: unknown): bigint | undefined {
  if (!(error instanceof ApiError) || error.code !== "cursor_expired") return
  const body = error.body as { error?: { details?: { head?: unknown } } }
  const head = body.error?.details?.head
  if (typeof head === "string" && /^\d{1,19}$/.test(head)) return BigInt(head)
}

export type ActivitySnapshot = { events: ChangeNotification[]; historyTruncated: boolean; cursor: string }

/** The API exposes invalidation metadata, not unrestricted audit payloads. */
export async function readAllChanges(client: ProjectManagementClient, workspaceId: string, projectId: string | undefined, signal: AbortSignal): Promise<ActivitySnapshot> {
  let after = "0"
  let historyTruncated = false
  let first
  try {
    first = await client.getChanges(workspaceId, { after, projectId }, { signal })
  } catch (error) {
    const head = expiredHead(error)
    if (head === undefined) throw error
    historyTruncated = true
    // The existing contract returns head but not the oldest retained cursor. Find
    // the first readable cursor rather than silently dropping all retained events.
    let low = 0n
    let high = head
    while (low < high) {
      signal.throwIfAborted()
      const middle = (low + high) / 2n
      try {
        await client.getChanges(workspaceId, { after: String(middle), projectId }, { signal })
        high = middle
      } catch (probeError) {
        if (expiredHead(probeError) === undefined) throw probeError
        low = middle + 1n
      }
    }
    after = String(low)
    first = await client.getChanges(workspaceId, { after, projectId }, { signal })
  }
  const events = new Map<string, ChangeNotification>()
  let page = first
  // Stop at the initial high-water mark. Newer events arrive through invalidation,
  // so a busy workspace cannot keep this finite history query running forever.
  const head = BigInt(first.head)
  while (true) {
    signal.throwIfAborted()
    for (const entry of page.events) if (BigInt(entry.cursor) <= head) events.set(entry.event.eventId, entry.event)
    if (BigInt(page.cursor) >= head) return { events: [...events.values()], historyTruncated, cursor: String(head) }
    if (BigInt(page.cursor) <= BigInt(after)) throw new ApiError(502, { error: { code: "invalid_response" } })
    after = page.cursor
    page = await client.getChanges(workspaceId, { after, projectId }, { signal })
  }
}
