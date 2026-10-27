import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentProps, type ReactNode } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Link } from "react-router"
import { TriangleAlert } from "lucide-react"
import { AssistantRuntimeProvider, useAuiState, useExternalStoreRuntime, type AssistantRuntime, type ExternalStoreThreadListAdapter, type ThreadMessageLike } from "@assistant-ui/react"
import type { AgentChatMessage, AgentChatReasoningEffort, AgentChatScope, AgentChatStreamEvent } from "@contracts"
import { useI18n } from "@/lib/i18n-provider"
import { pmKeys } from "../service/pm-data"
import { usePmEntities, usePmService } from "../service/pm-service"
import { useText } from "../service/pm-ui"
import { safeWorkspaceReturn } from "../markdown/task-collection-model"
import { AgentSidebar } from "./agent-sidebar"
import { AgentThread } from "./agent-thread"
import { AgentChatStore } from "./agent-chat-store"
import { agentErrorText, useAgentChatQueries } from "./agent-chat-queries"
import { useAgentThreadAccess } from "./agent-access"
import { AgentContextPicker, AgentPermissionPicker } from "./agent-context"
import { convertAgentMessage } from "./agent-message"
import { AgentReasoningPicker } from "./agent-reasoning"
import { AgentTaskPicker, useAgentTaskSelection } from "./agent-task-picker"
import { agentTaskMessage } from "./agent-task-context"
import { nextAgentConversation, type AgentConversationLocation } from "./agent-conversation-state"
import styles from "./agent-chat.module.css"

export type AgentConversationHandoff = {
  identity: string
  threadId: string | null
  taskId: string | null
  draft: string
  reasoningEffort: AgentChatReasoningEffort
}
type ConversationHeader = { title: string; busy: boolean; onNewChat: () => void; onOpenHistory: () => void; onExpand: () => void }
type Props = {
  location: AgentConversationLocation
  onNavigate: (location: AgentConversationLocation) => void
  root: string
  compact?: boolean
  initialHandoff?: AgentConversationHandoff
  renderHeader?: (controls: ConversationHeader) => ReactNode
  entryNotice?: ReactNode
  onExpand?: (location: AgentConversationLocation, handoff: AgentConversationHandoff) => void
}

function ComposerContextPicker(props: ComponentProps<typeof AgentContextPicker>) {
  const hasComposerDraft = useAuiState(state => state.composer.text.trim().length > 0)
  return <AgentContextPicker {...props} hasComposerDraft={hasComposerDraft} />
}

/** Both surfaces remount private state before a different session can render it. */
export function AgentConversation(props: Props) {
  const { workspace, actor, actorEpoch } = usePmService()
  const t = useText()
  if (!workspace || !actor) return <p role="alert" className="p-6">{t("请先登录并选择有权访问的工作区。", "Sign in and select an accessible workspace first.")}</p>
  if (!workspace.capabilities.includes("domain.read")) return <p role="alert" className="p-6">{t("当前无权读取工作区。", "You no longer have access to this workspace.")}</p>
  const identity = `${actor.id}:${actorEpoch}:${workspace.id}:${workspace.version}`
  return <AgentConversationContent key={identity} {...props} identity={identity} />
}

function AgentConversationContent({ location, onNavigate, root, compact = false, initialHandoff, renderHeader, entryNotice, onExpand, identity }: Props & { identity: string }) {
  const { client, workspace, actor } = usePmService()
  const { locale } = useI18n()
  const en = locale === "en"
  const t = useText()
  const queryClient = useQueryClient()
  const { threadId: selectedId, projectId, taskId, returnTo } = location
  const locationRef = useRef(location)
  locationRef.current = location
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [actionError, setActionError] = useState<unknown>(null)
  const alive = useRef(false)
  const creatingRef = useRef<{ id: string; promise: Promise<string> } | null>(null)
  const runtimeRef = useRef<AssistantRuntime | null>(null)
  const validHandoff = initialHandoff?.identity === identity && initialHandoff.threadId === selectedId && initialHandoff.taskId === taskId ? initialHandoff : undefined
  const pendingComposerDraft = useRef<{ threadId: string | null; text: string } | null>(validHandoff ? { threadId: selectedId, text: validHandoff.draft } : null)
  const [selectedEffort, setSelectedEffort] = useState<AgentChatReasoningEffort>(validHandoff?.reasoningEffort ?? "auto")
  const { status: statusQuery, threads: threadsQuery } = useAgentChatQueries()
  const reasoningEffort = statusQuery.data?.reasoning?.efforts.includes(selectedEffort) ? selectedEffort : "auto"
  const projects = usePmEntities("project")
  const initialScope = useMemo<AgentChatScope | null>(() => {
    if (!projects.data || projects.error || projects.isPending || projects.isFetching) return null
    const entry = projects.data.find(project => project.id === projectId && project.data.archived !== true && !project.data.archivedAt)
    if (entry) return { kind: "projects", projectIds: [entry.id] }
    if (projectId) return null
    return workspace?.projectIds === null ? { kind: "workspace", projectIds: [] } : null
  }, [projectId, projects.data, projects.error, projects.isFetching, projects.isPending, workspace?.projectIds])
  const access = useAgentThreadAccess(selectedId)
  const taskScope = useMemo<AgentChatScope | null>(() => {
    if (selectedId) return access.loading || access.error ? null : access.access?.scope ?? null
    if (!initialScope) return null
    return initialScope.kind === "workspace" ? { kind: "workspace", projectIds: projects.data?.filter(project => project.data.archived !== true && !project.data.archivedAt).map(project => project.id) ?? [] } : initialScope
  }, [access.access?.scope, access.error, access.loading, initialScope, projects.data, selectedId])
  const selection = useAgentTaskSelection(taskId, taskScope)
  const eventRef = useRef<(event: AgentChatStreamEvent) => void>(() => {})
  eventRef.current = access.receive
  const refreshThreads = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: pmKeys.agentChat(window.location.origin, actor!.id, workspace!.id) })
    void queryClient.invalidateQueries({ queryKey: pmKeys.workspace(window.location.origin, actor!.id, workspace!.id), predicate: query => !query.queryKey.includes("agent-chat") })
  }, [actor, queryClient, workspace])
  const [store] = useState(() => new AgentChatStore(client, workspace!.id, event => eventRef.current(event), refreshThreads))
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const messages = snapshot.threadId === selectedId ? snapshot.messages : []
  const modelReady = statusQuery.data?.enabled === true
  const threads = threadsQuery.data?.items ?? []
  const selectedThread = threads.find(thread => thread.id === selectedId)
  const autoSelect = !compact && !selectedId && !location.newChat && !projectId && !taskId
  const loadingThread = snapshot.loading || snapshot.threadId !== selectedId || (autoSelect && !threadsQuery.error && (threadsQuery.isPending || threads.length > 0))
  const busy = creating || access.saving || snapshot.streaming || snapshot.unknown
  const contextUnavailable = !selectedId && (projects.isPending || projects.isFetching || !!projects.error || (!!projectId && !initialScope))
  const sendBlocked = busy || loadingThread || contextUnavailable || selection.blocked

  useEffect(() => {
    alive.current = true
    store.activate()
    return () => { alive.current = false; store.dispose() }
  }, [store])
  useEffect(() => { void store.select(selectedId) }, [selectedId, store])
  useEffect(() => {
    if (!selectedId || access.loading || access.error || !access.access) return
    const scope = access.access.scope
    const activeProjectId = scope.kind === "projects" && scope.projectIds.length === 1 ? scope.projectIds[0]! : null
    if (activeProjectId !== projectId) onNavigate({ ...location, projectId: activeProjectId })
  }, [access.access, access.error, access.loading, location, onNavigate, projectId, selectedId])
  useEffect(() => {
    if (!autoSelect || threadsQuery.error) return
    const first = threadsQuery.data?.items[0]
    if (first) onNavigate(nextAgentConversation(location, { type: "history", threadId: first.id }))
  }, [autoSelect, location, onNavigate, threadsQuery.data, threadsQuery.error])

  const selectThread = useCallback((id: string) => {
    if (busy || id === selectedId) return
    pendingComposerDraft.current = null
    setActionError(null)
    onNavigate(nextAgentConversation(location, { type: "history", threadId: id }))
    setSidebarOpen(false)
  }, [busy, location, onNavigate, selectedId])
  const newChat = useCallback(() => {
    if (busy) return
    pendingComposerDraft.current = null
    runtimeRef.current?.thread.composer.setText("")
    setActionError(null)
    onNavigate(nextAgentConversation(location, { type: "new" }))
    setSidebarOpen(false)
  }, [busy, location, onNavigate])

  const ensureThread = useCallback(async (title?: string, preserveDraft = true): Promise<string> => {
    if (selectedId) return selectedId
    if (creatingRef.current) return creatingRef.current.promise
    if (projects.isPending || projects.isFetching || projects.error) throw projects.error ?? new Error("agent_context_not_ready")
    setCreating(true)
    setActionError(null)
    const entryLocation = locationRef.current
    const id = crypto.randomUUID()
    if (preserveDraft) pendingComposerDraft.current = { threadId: id, text: runtimeRef.current?.thread.composer.getState().text ?? "" }
    const stillHere = () => alive.current && locationRef.current === entryLocation
    const request = (async () => {
      try {
        await client.createAgentThread(workspace!.id, { id, ...(title ? { title } : {}) })
        if (!stillHere()) throw new Error("session_changed")
        // Persist the default scope, never a permission grant or source snapshot.
        if (initialScope) await access.saveScope(initialScope, id)
      } finally {
        // Even a lost create/context response keeps the original identity for
        // reconciliation. Retrying a send cannot silently create another thread.
        if (stillHere()) {
          onNavigate(nextAgentConversation(entryLocation, { type: "created", threadId: id }))
          await store.select(id)
          refreshThreads()
        }
      }
      if (!alive.current || store.getSnapshot().threadId !== id) throw new Error("session_changed")
      return id
    })().catch((error: unknown) => {
      const current = locationRef.current
      if (alive.current && (current === entryLocation || (current.threadId === id && current.taskId === entryLocation.taskId && current.projectId === entryLocation.projectId))) setActionError(error)
      throw error
    }).finally(() => {
      creatingRef.current = null
      if (alive.current) setCreating(false)
    })
    creatingRef.current = { id, promise: request }
    return request
  }, [access.saveScope, client, initialScope, projects.error, projects.isFetching, projects.isPending, refreshThreads, selectedId, onNavigate, store, workspace])

  const sendText = useCallback(async (raw: string) => {
    const text = raw.trim()
    if (!text || sendBlocked || !modelReady) return
    const entryLocation = locationRef.current
    const content = agentTaskMessage(text, selection.selected)
    let targetId = entryLocation.threadId
    setActionError(null)
    try {
      const request = ensureThread(text.slice(0, 60), false)
      targetId ??= creatingRef.current?.id ?? null
      const id = await request
      const current = locationRef.current
      if (!alive.current || (current !== entryLocation && (current.threadId !== id || current.taskId !== entryLocation.taskId || current.projectId !== entryLocation.projectId))) throw new Error("session_changed")
      await store.send(id, content, statusQuery.data?.model ?? null, reasoningEffort)
    } catch (error) {
      const current = locationRef.current
      if (alive.current && (current === entryLocation || (targetId !== null && current.threadId === targetId && current.taskId === entryLocation.taskId && current.projectId === entryLocation.projectId))) {
        setActionError(error)
        pendingComposerDraft.current = { threadId: targetId, text: raw }
        runtimeRef.current?.thread.composer.setText(raw)
      }
    }
  }, [ensureThread, modelReady, reasoningEffort, selection.selected, sendBlocked, statusQuery.data?.model, store])
  const deleteThread = useCallback(async (id: string) => {
    if (busy) return
    const entryLocation = locationRef.current
    try {
      await client.deleteAgentThread(workspace!.id, id)
      if (!alive.current || locationRef.current !== entryLocation) return
      if (selectedId === id) {
        pendingComposerDraft.current = null
        await store.select(null)
        onNavigate(nextAgentConversation(entryLocation, { type: "new" }))
      }
      refreshThreads()
    } catch (error) { if (alive.current) setActionError(error); throw error }
  }, [busy, client, refreshThreads, selectedId, onNavigate, store, workspace])

  const threadListAdapter = useMemo<ExternalStoreThreadListAdapter>(() => ({
    threadId: selectedId ?? undefined,
    isLoading: threadsQuery.isPending,
    threads: threads.map(thread => ({ status: "regular" as const, id: thread.id, title: thread.title, custom: { updatedAt: thread.updatedAt } })),
    onSwitchToThread: selectThread,
    onSwitchToNewThread: newChat,
    onDelete: deleteThread,
  }), [deleteThread, newChat, selectThread, selectedId, threads, threadsQuery.isPending])
  const convertMessage = useCallback((message: AgentChatMessage): ThreadMessageLike => convertAgentMessage(message), [])
  const runtime = useExternalStoreRuntime<AgentChatMessage>({
    messages, convertMessage, isLoading: loadingThread, isRunning: snapshot.streaming || snapshot.unknown,
    isDisabled: !modelReady || loadingThread || creating || snapshot.unknown || (!!selectedId && !!snapshot.error && messages.length === 0),
    isSendDisabled: !modelReady || sendBlocked,
    onNew: async message => { await sendText(message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n")) },
    onCancel: store.stop,
    adapters: { threadList: threadListAdapter },
  })
  runtimeRef.current = runtime
  useEffect(() => {
    const restore = () => {
      const pending = pendingComposerDraft.current
      if (!pending || (pending.threadId && runtime.threads.getState().mainThreadId !== pending.threadId)) return
      if (pending.threadId !== locationRef.current.threadId) return
      pendingComposerDraft.current = null
      runtime.thread.composer.setText(pending.text)
    }
    restore()
    return runtime.threads.subscribe(restore)
  }, [runtime, selectedId])

  const notices = <>
    {statusQuery.error && <div className={styles.noticeError} role="alert"><span>{agentErrorText(statusQuery.error, en)}</span><button type="button" className={styles.stopButton} onClick={() => void statusQuery.refetch()}>{t("重试读取", "Retry")}</button></div>}
    {!selectedId && projects.error && <div className={styles.noticeError} role="alert"><span>{agentErrorText(projects.error, en)}</span><button type="button" className={styles.stopButton} onClick={() => void projects.refetch()}>{t("重新读取项目上下文", "Reload project context")}</button></div>}
    {!selectedId && projectId && !projects.isPending && !projects.isFetching && !projects.error && !initialScope && <div className={styles.noticeError} role="alert">{t("入口项目不可用，请重新选择项目范围。", "The entry project is unavailable. Choose another project scope.")}</div>}
    {statusQuery.data && !modelReady && <div className={styles.notice} role="status"><TriangleAlert size={15} aria-hidden="true" /><p>{t("Agent 模型尚未配置；需由管理员在服务端配置。密钥不会保存到浏览器。", "The Agent model is not configured. An administrator must configure it on the server; keys are never stored in the browser.")}</p></div>}
    {!!(snapshot.error || actionError) && <div className={styles.noticeError} role="alert"><span>{agentErrorText(actionError ?? snapshot.error, en)}</span>{selectedId && <button type="button" className={styles.stopButton} disabled={snapshot.reconciling} onClick={() => { setActionError(null); void store.reconcile() }}>{t("核对原消息", "Reconcile original message")}</button>}</div>}
    {snapshot.unknown && <div className={styles.notice} role="status">{t("结果尚未确认，正在读取持久消息；不会自动重发。停止生成不会撤销已提交的业务修改。", "The result is not confirmed. Checking persisted messages without resending. Stopping generation does not undo committed business changes.")}</div>}
    {snapshot.stopping && <div className={styles.notice} role="status">{t("已请求停止，等待服务端持久状态确认…", "Stop requested; waiting for persisted confirmation…")}</div>}
  </>
  const controls = <>
    <AgentPermissionPicker access={access} ensureThread={ensureThread} initialScope={initialScope} busy={busy || loadingThread} />
    <ComposerContextPicker access={access} ensureThread={ensureThread} initialProjectId={projectId} busy={busy || loadingThread} />
    <AgentTaskPicker taskId={taskId} onTaskChange={id => { if (!busy && !loadingThread) onNavigate(nextAgentConversation(location, { type: "task", taskId: id })) }} selection={selection} disabled={busy || loadingThread} />
    <AgentReasoningPicker status={statusQuery.data} value={reasoningEffort} onChange={setSelectedEffort} busy={busy || loadingThread} />
  </>
  return <AssistantRuntimeProvider runtime={runtime}>
    <div className={styles.conversation}>
      {renderHeader?.({ title: selectedThread?.title ?? t("新对话", "New conversation"), busy, onNewChat: newChat, onOpenHistory: () => setSidebarOpen(true), onExpand: () => onExpand?.(locationRef.current, { identity, threadId: selectedId, taskId, draft: runtime.thread.composer.getState().text, reasoningEffort: selectedEffort }) })}
      {entryNotice}
      <div className={`${styles.workspace}${compact ? ` ${styles.compactWorkspace}` : ""}`}>
        {sidebarOpen && <button type="button" className={styles.sidebarOverlay} onClick={() => setSidebarOpen(false)} aria-label={t("收起侧栏", "Close sidebar")} />}
        <AgentSidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} model={statusQuery.data?.model ?? null} modelReady={modelReady} statusPending={statusQuery.isPending} error={threadsQuery.error ? agentErrorText(threadsQuery.error, en) : null} onRetry={() => void threadsQuery.refetch()} busy={busy} />
        <AgentThread
          compact={compact}
          title={selectedThread?.title ?? (loadingThread ? t("加载对话…", "Loading conversation…") : t("新对话", "New conversation"))}
          model={statusQuery.data?.model ?? null}
          modelReady={modelReady}
          messageCount={messages.length ? Math.max(messages.length, selectedThread?.messageCount ?? 0) : selectedThread?.messageCount ?? null}
          context={returnTo ? <Link className={styles.contextReturn} to={safeWorkspaceReturn(returnTo, root, `${root}/issues`)}>{t("返回任务列表", "Back to tasks")}</Link> : undefined}
          notices={notices}
          contextPicker={controls}
          blocked={busy}
          reconciling={snapshot.reconciling}
          onReconcile={store.reconcile}
          onNewChat={newChat}
          onOpenSidebar={() => setSidebarOpen(true)}
        />
      </div>
    </div>
  </AssistantRuntimeProvider>
}
