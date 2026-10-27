import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react"
import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData, type QueryKey, type RefetchOptions } from "@tanstack/react-query"
import { useParams } from "react-router"
import { ApiError, ProjectManagementClient, type Actor, type ArtifactVisibility, type Capabilities, type ChangeNotification, type Command, type CommandReceipt, type EntityKind, type ProjectAuditPage, type Workspace } from "@contracts"
import { PmCommandStore } from "./pm-command-store"
import { pmKeys, readAllChanges, readAllEntities, refreshPmSnapshots } from "./pm-data"
import { asPmError, isAccessError, PmCommandError, PmServiceError } from "./pm-errors"
import { runPmStream, type PmStreamState } from "./pm-stream"
import { ApiError as CoreApiError, createCoreClient } from "../markdown/api"

export { pmErrorMessage, PmCommandError, PmServiceError } from "./pm-errors"
export type { Actor, Capabilities, ChangeNotification, Command, CommandReceipt, Entity, EntityKind, Member, Workspace } from "@contracts"

export type PmService = {
  client: ProjectManagementClient
  actor: Actor | null
  actorEpoch: number
  workspaces: Workspace[]
  workspace: Workspace | null
  capabilities: Capabilities | undefined
  loading: boolean
  error: Error | null
  login: (email: string, password: string) => Promise<void>
  logout: () => Promise<void>
  clearSessionAfterPasswordReset: () => void
  refresh: () => Promise<void>
  streamState: string
  coreEvents: EventSource | null
}

type ServiceContext = PmService & {
  instance: string
  actorEpoch: number
  commands: PmCommandStore
  readFailures: Record<string, Error>
  reportReadFailure: (error: Error, key: QueryKey, epoch: number) => void
  reportCommandFailure: (error: Error, epoch: number) => void
  isCurrentSession: (epoch: number, actorId: string) => boolean
  clearReadFailure: (key: string) => void
}

const Context = createContext<ServiceContext | null>(null)

function useServiceContext(): ServiceContext {
  const context = useContext(Context)
  if (!context) throw new Error("PmServiceProvider is missing")
  return context
}

export function PmServiceProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const { workspaceSlug } = useParams<{ workspaceSlug?: string }>()
  const [instance] = useState(() => window.location.origin)
  const streamOpened = useRef<(() => void) | null>(null)
  const [client] = useState(() => new ProjectManagementClient({
    baseUrl: instance,
    auth: { type: "cookie", credentials: "same-origin" },
    fetch: async (input, init) => {
      // Capture the owning subscription before awaiting transport. The client
      // may combine its abort signal with an idle deadline; identity comparison
      // cannot identify the owner, and a late response must not wake a new one.
      const opened = streamOpened.current
      const response = await globalThis.fetch(input, init)
      if (response.ok && response.headers.get("content-type")?.startsWith("text/event-stream")) {
        opened?.()
      }
      return response
    },
  }))
  const [commands] = useState(() => new PmCommandStore(instance))
  const [actor, setActor] = useState<Actor | null>(null)
  const actorRef = useRef<Actor | null>(null)
  const [actorEpoch, setActorEpoch] = useState(0)
  const epochRef = useRef(0)
  const authSequence = useRef(0)
  const authRequest = useRef<AbortController | null>(null)
  const authChannel = useRef<BroadcastChannel | null>(null)
  const streamRequest = useRef<AbortController | null>(null)
  const [sessionLoading, setSessionLoading] = useState(true)
  const [sessionError, setSessionError] = useState<Error | null>(null)
  const [streamState, setStreamState] = useState<PmStreamState>("signed-out")
  const [coreStream, setCoreStream] = useState<{ key: string; events: EventSource } | null>(null)
  const [readFailures, setReadFailures] = useState<Record<string, Error>>({})
  const [blockedWorkspace, setBlockedWorkspace] = useState<{ id: string; version: number; error: Error } | null>(null)

  const clearPrivate = useCallback(() => {
    streamRequest.current?.abort()
    void queryClient.cancelQueries({ queryKey: pmKeys.private(instance) })
    queryClient.removeQueries({ queryKey: pmKeys.private(instance) })
    commands.clear()
    setReadFailures({})
    setBlockedWorkspace(null)
    epochRef.current += 1
    setActorEpoch(epochRef.current)
  }, [commands, instance, queryClient])

  const endSession = useCallback((error: Error | null) => {
    authSequence.current += 1
    authRequest.current?.abort()
    actorRef.current = null
    setActor(null)
    clearPrivate()
    setSessionLoading(false)
    setSessionError(error)
    setStreamState("signed-out")
  }, [clearPrivate])

  const capabilitiesQuery = useQuery({
    queryKey: ["pm-public", instance, "capabilities"],
    queryFn: ({ signal }) => client.getCapabilities({ signal }),
    retry: false,
    refetchOnWindowFocus: true,
  })
  const workspacesQuery = useQuery({
    queryKey: pmKeys.workspaces(instance, actor?.id ?? "anonymous"),
    queryFn: ({ signal }) => client.listWorkspaces({ signal }).then((result) => result.items),
    enabled: actor !== null,
    retry: false,
    refetchOnWindowFocus: true,
    // Project-scoped streams do not reveal workspace-wide membership events.
    refetchInterval: actor ? 30_000 : false,
  })
  const workspaces = actor ? workspacesQuery.data ?? [] : []
  const selectedWorkspace = workspaces.find((candidate) => candidate.id === workspaceSlug?.toLowerCase()) ?? null
  const workspace = selectedWorkspace && !(blockedWorkspace?.id === selectedWorkspace.id && blockedWorkspace.version === selectedWorkspace.version) ? selectedWorkspace : null
  const workspaceRef = useRef(workspace)
  workspaceRef.current = workspace
  const coreStreamKey = actor && workspace ? `${actor.id}:${actorEpoch}:${workspace.id}:${workspace.version}` : null

  useEffect(() => {
    if (!workspace || !coreStreamKey) return
    const events = new EventSource(`/api/v1/workspaces/${workspace.id}/core/events`)
    setCoreStream({ key: coreStreamKey, events })
    events.addEventListener('change', () => { void queryClient.invalidateQueries({ queryKey: pmKeys.private(instance) }) })
    return () => events.close()
  }, [coreStreamKey, workspace?.id, instance, queryClient])

  useEffect(() => {
    const controller = new AbortController()
    authRequest.current = controller
    const sequence = ++authSequence.current
    void client.getMe({ signal: controller.signal }).then(async ({ actor: current }) => {
      if (controller.signal.aborted || sequence !== authSequence.current) return
      let recoveryError: Error | null = null
      try { await commands.restore(current.id) } catch (error) { recoveryError = asPmError(error) }
      if (controller.signal.aborted || sequence !== authSequence.current) return
      actorRef.current = current
      setActor(current)
      setSessionError(recoveryError)
    }).catch((cause: unknown) => {
      if (controller.signal.aborted || sequence !== authSequence.current) return
      // Only a real 401 means anonymous. Network/5xx/invalid responses remain errors.
      if (cause instanceof ApiError && cause.status === 401) setSessionError(null)
      else setSessionError(asPmError(cause))
    }).finally(() => {
      if (!controller.signal.aborted && sequence === authSequence.current) setSessionLoading(false)
    })
    return () => { controller.abort(); streamRequest.current?.abort() }
  }, [client, commands])

  useEffect(() => {
    if (workspacesQuery.error instanceof ApiError && workspacesQuery.error.status === 401) endSession(workspacesQuery.error)
  }, [endSession, workspacesQuery.error])

  const previousMemberships = useRef<{ actorId: string; items: Workspace[] } | null>(null)
  useEffect(() => {
    if (!workspacesQuery.data || !actor) return
    for (const previous of previousMemberships.current?.actorId === actor.id ? previousMemberships.current.items : []) {
      const current = workspacesQuery.data.find((candidate) => candidate.id === previous.id)
      if (!current || current.version !== previous.version) {
        const key = pmKeys.workspace(instance, actor.id, previous.id)
        const filter = { queryKey: key, predicate: (query: { queryKey: QueryKey }) => !current || query.queryKey.at(-2) === previous.version }
        void queryClient.cancelQueries(filter)
        queryClient.removeQueries(filter)
        // Removing a permission must not leave a receipt or upload payload visible.
        if (!current || !previous.capabilities.every((capability) => current.capabilities.includes(capability)) || (current.projectIds !== null && (previous.projectIds === null || previous.projectIds.some((id) => !current.projectIds?.includes(id))))) commands.clear(previous.id)
      }
    }
    previousMemberships.current = { actorId: actor.id, items: workspacesQuery.data }
  }, [actor, commands, instance, queryClient, workspacesQuery.data])

  const login = useCallback(async (email: string, password: string) => {
    const sequence = ++authSequence.current
    authRequest.current?.abort()
    const controller = new AbortController()
    authRequest.current = controller
    actorRef.current = null
    setActor(null)
    clearPrivate()
    setSessionError(null)
    setSessionLoading(true)
    try {
      const result = await client.login({ email, password }, { signal: controller.signal })
      if (sequence !== authSequence.current) throw new PmServiceError("session_changed")
      try { await commands.restore(result.actor.id) } catch (error) { setSessionError(asPmError(error)) }
      if (sequence !== authSequence.current) throw new PmServiceError("session_changed")
      actorRef.current = result.actor
      setActor(result.actor)
      authChannel.current?.postMessage({ type: "changed" })
      await queryClient.fetchQuery({ queryKey: pmKeys.workspaces(instance, result.actor.id), queryFn: ({ signal }) => client.listWorkspaces({ signal }).then((response) => response.items), staleTime: 0, retry: false })
    } catch (cause) {
      const error = asPmError(cause)
      if (sequence === authSequence.current) setSessionError(error)
      throw error
    } finally {
      if (sequence === authSequence.current) setSessionLoading(false)
    }
  }, [clearPrivate, client, commands, instance, queryClient])

  const logout = useCallback(async () => {
    // Clear immediately even when the logout response is lost or the service is offline.
    authChannel.current?.postMessage({ type: "signed-out" })
    endSession(null)
    const sequence = authSequence.current
    try { await client.logout() }
    catch (cause) {
      const error = asPmError(cause)
      if (sequence === authSequence.current) setSessionError(error)
      throw error
    }
  }, [client, endSession])

  const clearSessionAfterPasswordReset = useCallback(() => {
    authChannel.current?.postMessage({ type: "changed" })
    endSession(null)
  }, [endSession])

  const refresh = useCallback(async () => {
    const sequence = authSequence.current
    setSessionError(null)
    // Keep authenticated consumers mounted during refresh, including their
    // reconciliation guards and unsaved drafts.
    setSessionLoading(actorRef.current === null)
    try {
      const { actor: current } = await client.getMe()
      if (sequence !== authSequence.current) return
      if (actorRef.current?.id !== current.id) {
        actorRef.current = null
        setActor(null)
        clearPrivate()
      }
      try { await commands.restore(current.id) } catch (error) { setSessionError(asPmError(error)) }
      if (sequence !== authSequence.current) return
      actorRef.current = current
      setActor(current)
      setBlockedWorkspace(null)
      setReadFailures({})
      await Promise.all([
        queryClient.fetchQuery({ queryKey: pmKeys.workspaces(instance, current.id), queryFn: ({ signal }) => client.listWorkspaces({ signal }).then((result) => result.items), staleTime: 0, retry: false }),
        queryClient.fetchQuery({ queryKey: ["pm-public", instance, "capabilities"], queryFn: ({ signal }) => client.getCapabilities({ signal }), staleTime: 0, retry: false }),
      ])
      if (sequence === authSequence.current) await queryClient.invalidateQueries({ queryKey: pmKeys.private(instance) }, { throwOnError: true })
    } catch (cause) {
      const error = asPmError(cause)
      if (sequence === authSequence.current) {
        if (error instanceof ApiError && error.status === 401) endSession(error)
        else setSessionError(error)
      }
      throw error
    } finally {
      if (sequence === authSequence.current) setSessionLoading(false)
    }
  }, [clearPrivate, client, commands, endSession, instance, queryClient])

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return
    const channel = new BroadcastChannel("pm-session")
    authChannel.current = channel
    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (!event.data || typeof event.data !== "object" || !("type" in event.data)) return
      if (event.data.type !== "changed" && event.data.type !== "signed-out") return
      endSession(null)
      if (event.data.type === "changed") void refresh().catch(() => {})
    }
    return () => { authChannel.current = null; channel.close() }
  }, [endSession, refresh])

  const clearReadFailure = useCallback((key: string) => {
    setReadFailures((previous) => {
      const next = { ...previous }
      delete next[key]
      return next
    })
  }, [])

  const isCurrentSession = useCallback((epoch: number, actorId: string) => epoch === epochRef.current && actorId === actorRef.current?.id, [])

  const reportReadFailure = useCallback((error: Error, key: QueryKey, epoch: number) => {
    if (epoch !== epochRef.current || !isAccessError(error)) return
    if (error.status === 401) { endSession(error); return }
    setReadFailures((previous) => ({ ...previous, [JSON.stringify(key)]: error }))
    queryClient.removeQueries({ queryKey: key, exact: true })
    const current = actorRef.current
    if (current) void queryClient.invalidateQueries({ queryKey: pmKeys.workspaces(instance, current.id) })
  }, [endSession, instance, queryClient])

  const reportCommandFailure = useCallback((error: Error, epoch: number) => {
    if (epoch !== epochRef.current) return
    const status = error instanceof ApiError || error instanceof PmCommandError ? error.status : 0
    if (status === 401) endSession(error)
    else if (status === 403 || status === 404) {
      const current = actorRef.current
      if (current) void queryClient.invalidateQueries({ queryKey: pmKeys.workspaces(instance, current.id) })
    }
  }, [endSession, instance, queryClient])

  useEffect(() => {
    const currentActorId = actor?.id
    const scope = workspaceRef.current
    if (!currentActorId) { setStreamState("signed-out"); return }
    if (!scope) { setStreamState(blockedWorkspace ? "permission-denied" : "idle"); return }
    if (!capabilitiesQuery.data?.realtime.enabled) { setStreamState("disabled"); return }
    if (!scope.capabilities.includes("domain.read")) { setStreamState("permission-denied"); return }
    // Server filters each workspace batch to authorized projects and actor-private
    // notifications while retaining the shared cursor's safe checkpoints.
    const projectId = undefined
    const controller = new AbortController()
    const coreClient = createCoreClient(scope.id)
    streamRequest.current = controller
    const state = (value: PmStreamState) => {
      if (!controller.signal.aborted) setStreamState(value)
    }
    streamOpened.current = () => state("live")
    const loseAccess = (error: ApiError) => {
      if (controller.signal.aborted) return
      if (error.status === 401) { endSession(error); return }
      setStreamState("permission-denied")
      setBlockedWorkspace({ id: scope.id, version: scope.version, error })
      controller.abort()
      const key = pmKeys.workspace(instance, currentActorId, scope.id)
      void queryClient.cancelQueries({ queryKey: key })
      queryClient.removeQueries({ queryKey: key })
      commands.clear(scope.id)
      void queryClient.invalidateQueries({ queryKey: pmKeys.workspaces(instance, currentActorId) })
    }
    let invalidationTimer: number | undefined
    const queueRefresh = () => {
      if (controller.signal.aborted || invalidationTimer !== undefined) return
      invalidationTimer = window.setTimeout(() => {
        invalidationTimer = undefined
        if (!controller.signal.aborted) void refreshPmSnapshots(queryClient, pmKeys.workspace(instance, currentActorId, scope.id))
      }, 75)
    }
    const change = (event: ChangeNotification) => {
      if (controller.signal.aborted || event.workspaceId !== scope.id) return
      if (event.aggregateKind === "membership") {
        if (event.aggregateId === currentActorId && event.aggregateVersion > scope.version) {
          // Hide the old authorization snapshot until current membership is read.
          setBlockedWorkspace({ id: scope.id, version: scope.version, error: new ApiError(403, { error: { code: "permission_denied" } }) })
          const key = pmKeys.workspace(instance, currentActorId, scope.id)
          void queryClient.cancelQueries({ queryKey: key })
          queryClient.removeQueries({ queryKey: key })
        }
        void queryClient.invalidateQueries({ queryKey: pmKeys.workspaces(instance, currentActorId) })
      }
      if (event.eventType === "WorkspaceIdentityUpdated") void queryClient.invalidateQueries({ queryKey: pmKeys.workspaces(instance, currentActorId) })
      queueRefresh()
    }
    void runPmStream(client, scope.id, projectId, scope.cursor, controller.signal, {
      state,
      change,
      checkpoint: () => {
        queueRefresh()
        void queryClient.invalidateQueries({ queryKey: pmKeys.workspaces(instance, currentActorId) })
      },
      lostAccess: loseAccess,
      resnapshot: async () => {
        const latest = await client.listWorkspaces({ signal: controller.signal })
        controller.signal.throwIfAborted()
        const authorized = latest.items.find((candidate) => candidate.id === scope.id)
        if (!authorized || !authorized.capabilities.includes("domain.read") || (projectId !== undefined && authorized.projectIds !== null && !authorized.projectIds.includes(projectId))) throw new ApiError(403, { error: { code: "permission_denied" } })
        const key = pmKeys.workspace(instance, currentActorId, scope.id)
        // Route/observer transitions may leave no active core query precisely
        // when resync starts. An empty query set is not an authority snapshot.
        const hasCoreReader = queryClient.getQueryCache().findAll({ queryKey: key, type: "active" }).some(query => query.queryKey[4] === "core")
        if (!hasCoreReader) {
          try { await coreClient.workspace(controller.signal) }
          catch (error) {
            if (error instanceof CoreApiError && [401, 403, 404].includes(error.status)) throw new ApiError(error.status, { error: { code: error.status === 401 ? "unauthenticated" : "not_found_or_forbidden" } })
            throw error
          }
        }
        // Publish the new cursor only after all required authoritative reads.
        await refreshPmSnapshots(queryClient, key, true)
        controller.signal.throwIfAborted()
        queryClient.setQueryData(pmKeys.workspaces(instance, currentActorId), latest.items)
        return authorized.cursor
      },
    })
    return () => { controller.abort(); clearTimeout(invalidationTimer); streamOpened.current = null }
  }, [actor?.id, actorEpoch, workspace?.id, workspace?.version, blockedWorkspace, capabilitiesQuery.data?.realtime.enabled, client, commands, endSession, instance, queryClient])

  const routeError = actor && workspaceSlug && !workspacesQuery.isPending && !selectedWorkspace && !workspacesQuery.error ? new ApiError(404, { error: { code: "not_found_or_forbidden" } }) : null
  const value: ServiceContext = {
    client, instance, actor, actorEpoch, commands, workspaces, workspace,
    capabilities: capabilitiesQuery.error ? undefined : capabilitiesQuery.data,
    coreEvents: coreStream?.key === coreStreamKey ? coreStream.events : null,
    loading: sessionLoading || capabilitiesQuery.isPending || (!!actor && workspacesQuery.isPending),
    error: sessionError ?? (actor ? workspacesQuery.error : null) ?? capabilitiesQuery.error ?? (blockedWorkspace && selectedWorkspace && blockedWorkspace.id === selectedWorkspace.id && blockedWorkspace.version === selectedWorkspace.version ? blockedWorkspace.error : null) ?? routeError,
    login, logout, clearSessionAfterPasswordReset, refresh, streamState, readFailures, reportReadFailure, reportCommandFailure, isCurrentSession, clearReadFailure,
  }
  return <Context.Provider value={value}>{children}</Context.Provider>
}

export function usePmService(): PmService {
  return useServiceContext()
}

export function usePrivateQuery<T>(key: QueryKey, requiredCapability: string | null, projectId: string | undefined, read: (client: ProjectManagementClient, workspaceId: string, signal: AbortSignal) => Promise<T>, enabled = true) {
  const service = useServiceContext()
  const { client, workspace, actor, actorEpoch, reportReadFailure } = service
  const queryKey = [...key, workspace?.version ?? null, actorEpoch]
  const keyId = JSON.stringify(queryKey)
  const blocked = service.readFailures[keyId]
  const query = useQuery<T, Error>({
    queryKey,
    enabled: enabled && !!actor && !!workspace && !blocked,
    retry: false,
    refetchOnWindowFocus: true,
    queryFn: async ({ signal }) => {
      if (!actor) throw new ApiError(401, { error: { code: "unauthenticated" } })
      if (!workspace) throw new ApiError(404, { error: { code: "not_found_or_forbidden" } })
      if (!service.isCurrentSession(actorEpoch, actor.id)) throw new PmServiceError("session_changed")
      if (requiredCapability !== null && !workspace.capabilities.includes(requiredCapability)) throw new ApiError(403, { error: { code: "permission_denied" } })
      if ((requiredCapability === "access.manage" && workspace.projectIds !== null) || (projectId && workspace.projectIds !== null && !workspace.projectIds.includes(projectId))) throw new ApiError(404, { error: { code: "not_found_or_forbidden" } })
      return read(client, workspace.id, signal)
    },
  })
  useEffect(() => {
    if (enabled && query.error && !blocked) reportReadFailure(query.error, JSON.parse(keyId) as QueryKey, actorEpoch)
  }, [actorEpoch, blocked, enabled, keyId, query.error, reportReadFailure])
  const refetch = useCallback((options?: RefetchOptions) => {
    service.clearReadFailure(keyId)
    return query.refetch(options)
  }, [keyId, query.refetch, service.clearReadFailure])
  return { ...query, refetch, data: !enabled || blocked || isAccessError(query.error) || !actor || !workspace ? undefined : query.data, error: enabled ? blocked ?? query.error : null, isPending: !enabled || blocked ? false : query.isPending }
}

export function usePmEntities(kind: EntityKind, projectId?: string, visibility: ArtifactVisibility = "visible") {
  const { instance, actor, workspace } = useServiceContext()
  return usePrivateQuery(pmKeys.entities(instance, actor?.id ?? "anonymous", workspace?.id ?? "none", kind, projectId, visibility), "domain.read", projectId, (client, workspaceId, signal) => readAllEntities(client, workspaceId, kind, projectId, signal, visibility))
}

export function usePmEntity(id: string, enabled = true) {
  const { instance, actor, workspace } = useServiceContext()
  return usePrivateQuery(pmKeys.entity(instance, actor?.id ?? "anonymous", workspace?.id ?? "none", id), "domain.read", undefined, (client, workspaceId, signal) => client.getEntity(workspaceId, id, { signal }), enabled && !!id)
}

export function usePmMembers() {
  const { instance, actor, workspace } = useServiceContext()
  // The actual members endpoint returns the entire authorized array, not a page.
  return usePrivateQuery(pmKeys.members(instance, actor?.id ?? "anonymous", workspace?.id ?? "none"), "access.manage", undefined, (client, workspaceId, signal) => client.listMembers(workspaceId, { signal }))
}
export function usePersonalDashboard(enabled = true) {
  const { instance, actor, workspace } = useServiceContext()
  return usePrivateQuery(pmKeys.dashboard(instance, actor?.id ?? "anonymous", workspace?.id ?? "none", "personal"), "domain.read", undefined, (client, workspaceId, signal) => client.getPersonalDashboard(workspaceId, { signal }), enabled)
}

export function useTimeDashboard() {
  const { instance, actor, workspace } = useServiceContext()
  return usePrivateQuery(pmKeys.dashboard(instance, actor?.id ?? "anonymous", workspace?.id ?? "none", "time"), "domain.read", undefined, (client, workspaceId, signal) => client.getTimeDashboard(workspaceId, { signal }))
}

export function useSprintsDashboard() {
  const { instance, actor, workspace } = useServiceContext()
  return usePrivateQuery(pmKeys.dashboard(instance, actor?.id ?? "anonymous", workspace?.id ?? "none", "sprints"), "domain.read", undefined, (client, workspaceId, signal) => client.getSprintsDashboard(workspaceId, { signal }))
}

export function usePortfolioDashboard() {
  const { instance, actor, workspace } = useServiceContext()
  return usePrivateQuery(pmKeys.dashboard(instance, actor?.id ?? "anonymous", workspace?.id ?? "none", "portfolio"), "domain.read", undefined, (client, workspaceId, signal) => client.getPortfolioDashboard(workspaceId, { signal }))
}

export function usePlanningDashboard() {
  const { instance, actor, workspace } = useServiceContext()
  return usePrivateQuery(pmKeys.dashboard(instance, actor?.id ?? "anonymous", workspace?.id ?? "none", "planning"), "domain.read", undefined, (client, workspaceId, signal) => client.getPlanningDashboard(workspaceId, { signal }))
}

export function useProjectExtras() {
  const { instance, actor, workspace } = useServiceContext()
  return usePrivateQuery(pmKeys.projectExtras(instance, actor?.id ?? "anonymous", workspace?.id ?? "none"), "domain.read", undefined, (client, workspaceId, signal) => client.getProjectExtras(workspaceId, { signal }))
}

export function useProjectDirectory() {
  const { instance, actor, workspace } = useServiceContext()
  return usePrivateQuery(pmKeys.projectDirectory(instance, actor?.id ?? "anonymous", workspace?.id ?? "none"), workspace?.capabilities.includes("domain.read") ? "domain.read" : "access.manage", undefined, (client, workspaceId, signal) => client.getProjectDirectory(workspaceId, { signal }))
}

export function useProjectAudit(projectId: string) {
  const service = useServiceContext()
  const { client, instance, workspace, actor, actorEpoch, reportReadFailure } = service
  const queryKey = [...pmKeys.projectAudit(instance, actor?.id ?? "anonymous", workspace?.id ?? "none", projectId), workspace?.version ?? null, actorEpoch]
  const keyId = JSON.stringify(queryKey)
  const blocked = service.readFailures[keyId]
  const query = useInfiniteQuery<ProjectAuditPage, Error, InfiniteData<ProjectAuditPage, string | undefined>, QueryKey, string | undefined>({
    queryKey,
    enabled: !!actor && !!workspace && !!projectId && !blocked,
    initialPageParam: undefined,
    retry: false,
    refetchOnWindowFocus: true,
    queryFn: async ({ signal, pageParam }) => {
      if (!actor) throw new ApiError(401, { error: { code: "unauthenticated" } })
      if (!workspace) throw new ApiError(404, { error: { code: "not_found_or_forbidden" } })
      if (!service.isCurrentSession(actorEpoch, actor.id)) throw new PmServiceError("session_changed")
      if (!workspace.capabilities.includes("domain.read") || !workspace.capabilities.includes("audit.read")) throw new ApiError(403, { error: { code: "permission_denied" } })
      if (workspace.projectIds !== null && !workspace.projectIds.includes(projectId)) throw new ApiError(404, { error: { code: "not_found_or_forbidden" } })
      const page = await client.getProjectAudit(workspace.id, projectId, { ...(pageParam === undefined ? {} : { cursor: pageParam }), limit: 30 }, { signal })
      if (page.projectId !== projectId || (page.nextCursor !== null && page.nextCursor === pageParam)) throw new ApiError(502, { error: { code: "invalid_response" } })
      return page
    },
    getNextPageParam: page => page.nextCursor ?? undefined,
  })
  useEffect(() => {
    if (query.error && !blocked) reportReadFailure(query.error, JSON.parse(keyId) as QueryKey, actorEpoch)
  }, [actorEpoch, blocked, keyId, query.error, reportReadFailure])
  const refetch = useCallback((options?: RefetchOptions) => {
    service.clearReadFailure(keyId)
    return query.refetch(options)
  }, [keyId, query.refetch, service.clearReadFailure])
  const authorized = !!actor && !!workspace && workspace.capabilities.includes("domain.read") && workspace.capabilities.includes("audit.read") && (workspace.projectIds === null || workspace.projectIds.includes(projectId))
  return { ...query, refetch, data: blocked || isAccessError(query.error) || !authorized ? undefined : query.data, error: blocked ?? query.error, isPending: blocked ? false : query.isPending }
}

export function usePmChanges(projectId?: string) {
  const { instance, actor, workspace } = useServiceContext()
  const query = usePrivateQuery(pmKeys.changes(instance, actor?.id ?? "anonymous", workspace?.id ?? "none", projectId), "domain.read", projectId, async (client, workspaceId, signal) => {
    return readAllChanges(client, workspaceId, projectId, signal)
  })
  return { ...query, data: query.data?.events, historyTruncated: query.data?.historyTruncated ?? false }
}

export function usePmCommand() {
  const { commands, client, actor, workspace, instance, actorEpoch, reportCommandFailure, isCurrentSession } = useServiceContext()
  const queryClient = useQueryClient()
  const scope = actor && workspace ? `${actor.id}:${workspace.id}` : null
  const getSnapshot = useCallback(() => commands.getSnapshot(scope), [commands, scope])
  const state = useSyncExternalStore(commands.subscribe, getSnapshot, getSnapshot)
  const settled = useCallback((receipt: CommandReceipt) => {
    if (!actor || !workspace) return
    // Rejections can also reveal a newer authoritative version. Only invalidate;
    // never overwrite a page's local draft or optimistically declare completion.
    void refreshPmSnapshots(queryClient, pmKeys.workspace(instance, actor.id, workspace.id))
    if (receipt.status === "committed") void queryClient.invalidateQueries({ queryKey: pmKeys.workspaces(instance, actor.id) })
  }, [actor, instance, queryClient, workspace])
  const execute = useCallback(async (command: Command): Promise<CommandReceipt> => {
    if (!actor) throw new ApiError(401, { error: { code: "unauthenticated" } })
    if (!scope || !workspace) throw new ApiError(404, { error: { code: "not_found_or_forbidden" } })
    if (!isCurrentSession(actorEpoch, actor.id)) throw new PmServiceError("session_changed")
    return commands.execute(scope, workspace.id, command, client, settled, (error) => reportCommandFailure(error, actorEpoch))
  }, [actor, actorEpoch, client, commands, isCurrentSession, reportCommandFailure, scope, settled, workspace])
  const reconcile = useCallback(async (): Promise<CommandReceipt | undefined> => {
    if (!actor) throw new ApiError(401, { error: { code: "unauthenticated" } })
    if (!scope || !workspace) throw new ApiError(404, { error: { code: "not_found_or_forbidden" } })
    if (!isCurrentSession(actorEpoch, actor.id)) throw new PmServiceError("session_changed")
    return commands.reconcile(scope, workspace.id, client, settled, (error) => reportCommandFailure(error, actorEpoch))
  }, [actor, actorEpoch, client, commands, isCurrentSession, reportCommandFailure, scope, settled, workspace])
  return useMemo(() => ({ ...state, execute, reconcile }), [execute, reconcile, state])
}
