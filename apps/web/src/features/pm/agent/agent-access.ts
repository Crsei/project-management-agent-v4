import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { useQueryClient } from "@tanstack/react-query"
import type { AgentChatAccess, AgentChatScope, AgentChatStreamEvent } from "@contracts"
import { pmKeys } from "../service/pm-data"
import { usePmService, usePrivateQuery } from "../service/pm-service"

export type AgentAccessController = {
  threadId: string | null
  access: AgentChatAccess | undefined
  loading: boolean
  saving: boolean
  error: unknown | null
  refresh: () => Promise<void>
  enable: (scope: AgentChatScope, threadId: string) => Promise<void>
  saveScope: (scope: AgentChatScope, threadId: string) => Promise<void>
  disable: () => Promise<void>
  receive: (event: AgentChatStreamEvent) => void
}

type AccessWriteState = { error: unknown | null }
const noWriteError: AccessWriteState = { error: null }

/** Chat and native settings share this actor/membership-scoped server snapshot. */
export function useAgentThreadAccess(threadId: string | null): AgentAccessController {
  const { actor, actorEpoch, client, workspace } = usePmService()
  const queryClient = useQueryClient()
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const alive = useRef(false)
  const identity = `${actor?.id}:${actorEpoch}:${workspace?.id}:${workspace?.version}`
  const currentIdentity = useRef(identity)
  currentIdentity.current = identity
  const key = useCallback((id: string) => [...pmKeys.agentChat(window.location.origin, actor?.id ?? "anonymous", workspace?.id ?? "none"), "access", id, workspace?.version ?? null, actorEpoch], [actor?.id, actorEpoch, workspace?.id, workspace?.version])
  const writeKey = useCallback((id: string) => [...key(id), "write-error"], [key])
  const subscribe = useCallback((listener: () => void) => queryClient.getQueryCache().subscribe(listener), [queryClient])
  const getWriteState = useCallback(() => queryClient.getQueryData<AccessWriteState>(writeKey(threadId ?? "none")) ?? noWriteError, [queryClient, threadId, writeKey])
  const writeState = useSyncExternalStore(subscribe, getWriteState, getWriteState)
  const query = usePrivateQuery([...pmKeys.agentChat(window.location.origin, actor?.id ?? "anonymous", workspace?.id ?? "none"), "access", threadId ?? "none"], "domain.read", undefined, (api, workspaceId, signal) => api.getAgentThreadAccess(workspaceId, threadId!, { signal }), !!threadId)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const refresh = useCallback(async () => {
    if (!threadId) return
    const result = await query.refetch()
    if (alive.current && !result.error) queryClient.setQueryData(writeKey(threadId), noWriteError)
  }, [query.refetch, queryClient, threadId, writeKey])
  const receive = useCallback((event: AgentChatStreamEvent) => {
    if (event.type !== "capabilities" || !actor || !workspace || event.access.workspaceId !== workspace.id) return
    const access = event.access
    const snapshotIdentity = identity
    void queryClient.cancelQueries({ queryKey: key(access.threadId), exact: true }).then(() => {
      if (!alive.current || currentIdentity.current !== snapshotIdentity) return
      queryClient.setQueryData<AgentChatAccess>(key(access.threadId), previous => previous && previous.revision > access.revision ? previous : access)
    })
  }, [actor, identity, key, queryClient, workspace])
  const save = useCallback(async (enabled: boolean, id: string, scope?: AgentChatScope) => {
    if (!actor || !workspace || savingRef.current) throw new Error("agent_access_not_ready")
    const snapshotIdentity = identity
    savingRef.current = true
    setSaving(true)
    queryClient.setQueryData(writeKey(id), noWriteError)
    try {
      const previous = id === threadId && !query.error && query.data
        ? query.data : await client.getAgentThreadAccess(workspace.id, id)
      if (!alive.current || currentIdentity.current !== snapshotIdentity) throw new Error("session_changed")
      const next = await client.setAgentThreadAccess(workspace.id, id, enabled
        ? { enabled: true, expectedRevision: previous.revision, scope: scope! }
        : { enabled: false, expectedRevision: previous.revision, ...(scope ? { scope } : {}) })
      if (!alive.current || currentIdentity.current !== snapshotIdentity) return
      await queryClient.cancelQueries({ queryKey: key(id), exact: true })
      queryClient.setQueryData(key(id), next)
    } catch (error) {
      if (alive.current && currentIdentity.current === snapshotIdentity) {
        queryClient.setQueryData<AccessWriteState>(writeKey(id), { error })
        // A lost PUT response is not permission to repeat the mutation. Re-read
        // the effective binding; a failed read leaves the error visible.
        await queryClient.invalidateQueries({ queryKey: key(id), exact: true })
      }
      throw error
    } finally {
      savingRef.current = false
      if (alive.current && currentIdentity.current === snapshotIdentity) setSaving(false)
    }
  }, [actor, client, identity, key, query.data, query.error, queryClient, threadId, workspace, writeKey])
  useEffect(() => {
    if (!query.data?.enabled || !query.data.expiresAt) return
    const delay = Math.max(0, Date.parse(query.data.expiresAt) - Date.now())
    const timer = setTimeout(() => { void refresh() }, Math.min(delay + 50, 2_147_483_647))
    return () => clearTimeout(timer)
  }, [query.data?.enabled, query.data?.expiresAt, refresh])
  return {
    threadId, access: query.error || writeState.error ? undefined : query.data, loading: !!threadId && (query.isPending || query.isFetching), saving,
    error: writeState.error ?? query.error,
    refresh,
    enable: (scope, id) => save(true, id, scope),
    saveScope: (scope, id) => save(false, id, scope),
    disable: () => threadId ? save(false, threadId) : Promise.reject(new Error("agent_thread_required")),
    receive,
  }
}
