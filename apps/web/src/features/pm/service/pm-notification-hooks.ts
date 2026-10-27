import { useEffect, useRef, useState } from "react"
import { ApiError, type Command, type ProjectManagementClient } from "@contracts"
import type { NotificationInboxItem, NotificationOrigin, NotificationInboxPage } from "../../../../../../packages/domain/src/notifications.ts"
import { pmKeys } from "./pm-data"
import { usePmCommand, usePmService, usePrivateQuery } from "./pm-service"

type InboxSnapshot = { items: NotificationInboxItem[]; processing: NotificationInboxPage["processing"] }

/** A finite snapshot of actual deliveries; scope changes discard the entire snapshot. */
async function readInbox(client: ProjectManagementClient, workspaceId: string, signal: AbortSignal, origin: NotificationOrigin): Promise<InboxSnapshot> {
  let page = await client.getNotificationInbox(workspaceId, { origin }, { signal })
  const head = page.head
  const membershipVersion = page.membershipVersion
  const items = new Map<string, NotificationInboxItem>()
  let processing = page.processing
  while (true) {
    signal.throwIfAborted()
    if (page.head !== head || page.membershipVersion !== membershipVersion) throw new ApiError(404, { error: { code: "not_found_or_forbidden" } })
    if (page.processing.status !== "current") processing = page.processing
    for (const item of page.items) items.set(item.event.eventId, item)
    if (BigInt(page.cursor) >= BigInt(head)) return { items: [...items.values()], processing }
    const after = page.cursor
    page = await client.getNotificationInbox(workspaceId, { origin, after, through: head }, { signal })
    if (BigInt(page.cursor) <= BigInt(after)) throw new ApiError(502, { error: { code: "invalid_response" } })
  }
}

export function useNotificationInbox(origin: NotificationOrigin) {
  const { actor, workspace } = usePmService()
  const key = [...pmKeys.workspace(window.location.origin, actor?.id ?? "anonymous", workspace?.id ?? "none"), "notification-inbox", origin]
  const query = usePrivateQuery(key, "domain.read", undefined, (client, workspaceId, signal) => readInbox(client, workspaceId, signal, origin))
  const refresh = query.refetch
  const enabled = !!actor && !!workspace && !query.error
  useEffect(() => {
    if (!enabled) return
    // Reuses the provider SSE; polling also exposes importer/routing backlog recovery.
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh()
    }, 30_000)
    return () => window.clearInterval(timer)
  }, [enabled, refresh])
  return { ...query, data: query.data?.items, processing: query.data?.processing }
}

type PendingStateChange = { command: Command }
type ChangeQueue = { scope: string; items: PendingStateChange[]; ids: Set<string>; running: boolean }

/** The controlled View can dispatch page-read actions in a loop; journal each command serially. */
export function useNotificationStateCommands() {
  const command = usePmCommand()
  const { actor, actorEpoch, workspace } = usePmService()
  const scope = `${actor?.id ?? "anonymous"}:${actorEpoch}:${workspace?.id ?? "none"}:${workspace?.version ?? 0}`
  const currentScope = useRef(scope)
  const queue = useRef<ChangeQueue | null>(null)
  const [queueScope, setQueueScope] = useState<string | null>(null)
  currentScope.current = scope
  useEffect(() => {
    currentScope.current = scope
    return () => { currentScope.current = "unmounted" }
  }, [scope])

  const enqueue = (item: NotificationInboxItem, change: { read: boolean } | { archived: boolean }) => {
    if (command.pending || command.unknownCommand || !actor || !workspace) return
    let batch = queue.current
    if (!batch || batch.scope !== scope) {
      batch = { scope, items: [], ids: new Set(), running: false }
      queue.current = batch
    }
    if (batch.ids.has(item.event.eventId)) return
    batch.ids.add(item.event.eventId)
    const target = { commandId: crypto.randomUUID(), targetId: item.event.eventId, expectedVersions: { [item.event.eventId]: item.state.version } }
    batch.items.push({ command: "read" in change
      ? { ...target, commandType: "SetNotificationRead", payload: change }
      : { ...target, commandType: "SetNotificationArchived", payload: change } })
    if (batch.running) return
    batch.running = true
    setQueueScope(scope)
    const active = batch
    void (async () => {
      // Collect the synchronous page-read loop before starting the shared command coordinator.
      await Promise.resolve()
      try {
        while (active.items.length && currentScope.current === active.scope) {
          const next = active.items.shift()!
          await command.execute(next.command)
        }
      } catch {
        // The shared command notice exposes rejection/unknown and original receipt recovery.
        // Never send the remaining commands after an unknown or failed result.
        active.items.length = 0
      } finally {
        if (queue.current === active) {
          queue.current = null
          if (currentScope.current === active.scope) setQueueScope(null)
        }
      }
    })()
  }
  return { enqueue, locked: command.pending || !!command.unknownCommand || queueScope === scope }
}
