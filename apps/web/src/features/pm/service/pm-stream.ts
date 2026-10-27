import { ApiError, type ChangeNotification, type ProjectManagementClient } from "@contracts"

export type PmStreamState = "signed-out" | "idle" | "disabled" | "connecting" | "live" | "reconnecting" | "resyncing" | "permission-denied"

type StreamCallbacks = {
  state: (state: PmStreamState) => void
  change: (event: ChangeNotification) => void
  checkpoint: () => void
  resnapshot: () => Promise<string>
  lostAccess: (error: ApiError) => void
}

/** Cursor positions, not aggregate versions, order the workspace stream. */
export async function runPmStream(client: ProjectManagementClient, workspaceId: string, projectId: string | undefined, initialCursor: string, signal: AbortSignal, callbacks: StreamCallbacks): Promise<void> {
  let cursor = initialCursor
  let failures = 0
  let needsSnapshot = false
  while (!signal.aborted) {
    callbacks.state(needsSnapshot ? "resyncing" : failures ? "reconnecting" : "connecting")
    try {
      if (needsSnapshot) {
        // Keep the old cursor until every authoritative read succeeds. A failed
        // snapshot is not a successful reconnect and must never skip the gap.
        cursor = await callbacks.resnapshot()
        signal.throwIfAborted()
        needsSnapshot = false
        failures = 0
      }
      for await (const message of client.subscribeEvents(workspaceId, { after: cursor, projectId, signal })) {
        if (signal.aborted) return
        if (message.type === "stream_error") {
          const status = message.code === "unauthenticated" ? 401 : message.code === "permission_denied" ? 403 : message.code === "not_found_or_forbidden" ? 404 : message.code === "cursor_expired" ? 410 : 503
          throw new ApiError(status, { error: { code: message.code } })
        }
        callbacks.state("live")
        failures = 0
        const nextCursor = message.type === "checkpoint" ? message.cursor : message.id
        if (!/^\d{1,19}$/.test(nextCursor)) throw new ApiError(502, { error: { code: "invalid_event_stream" } })
        if (BigInt(nextCursor) <= BigInt(cursor)) continue
        if (message.type === "checkpoint") callbacks.checkpoint()
        if (message.type === "change") callbacks.change(message.event)
        cursor = nextCursor
      }
      if (signal.aborted) return
    } catch (error) {
      if (signal.aborted) return
      if (error instanceof ApiError && (error.status === 401 || error.status === 403 || error.status === 404)) {
        callbacks.state("permission-denied")
        callbacks.lostAccess(error)
        return
      }
      if (error instanceof ApiError && (error.status === 410 || error.code === "invalid_cursor")) {
        needsSnapshot = true
        continue
      }
    }
    callbacks.state(needsSnapshot ? "resyncing" : "reconnecting")
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(failures++, 5))
    await new Promise<void>((resolve) => {
      const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve() }
      const timer = setTimeout(finish, delay)
      signal.addEventListener("abort", finish, { once: true })
      if (signal.aborted) finish()
    })
  }
}
