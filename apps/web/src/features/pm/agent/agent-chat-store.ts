import type { AgentChatMessage, AgentChatReasoningEffort, AgentChatStreamEvent, AgentChatThreadDetail, ProjectManagementClient } from "@contracts"

export type AgentChatSnapshot = {
  threadId: string | null
  messages: AgentChatMessage[]
  loading: boolean
  streaming: boolean
  stopping: boolean
  reconciling: boolean
  unknown: boolean
  error: unknown | null
}

type ChatTransport = Pick<ProjectManagementClient, "getAgentThread" | "streamAgentMessage" | "cancelAgentThread">
const initial = (): AgentChatSnapshot => ({ threadId: null, messages: [], loading: false, streaming: false, stopping: false, reconciling: false, unknown: false, error: null })
const isUuid = (value: string | null): value is string => !!value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)

/** One authoritative message store feeds assistant-ui, including persisted tool snapshots. */
export class AgentChatStore {
  private state = initial()
  private listeners = new Set<() => void>()
  private subscription: AbortController | null = null
  private reader: AbortController | null = null
  private poll: ReturnType<typeof setTimeout> | null = null
  private generation = 0
  private activeAssistant: string | null = null
  private pendingUser: string | null = null
  private disposed = false

  private client: ChatTransport
  private workspaceId: string
  private onEvent: (event: AgentChatStreamEvent) => void
  private onSettled: () => void
  constructor(client: ChatTransport, workspaceId: string, onEvent: (event: AgentChatStreamEvent) => void = () => {}, onSettled: () => void = () => {}) {
    this.client = client
    this.workspaceId = workspaceId
    this.onEvent = onEvent
    this.onSettled = onSettled
  }

  getSnapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private update(patch: Partial<AgentChatSnapshot>) {
    if (this.disposed) return
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
  private replace(message: AgentChatMessage, pendingId?: string) {
    const found = this.state.messages.some(item => item.id === message.id || item.id === pendingId)
    this.update({ messages: found ? this.state.messages.map(item => item.id === message.id || item.id === pendingId ? message : item) : [...this.state.messages, message] })
  }
  private clearPoll() { clearTimeout(this.poll ?? undefined); this.poll = null }
  private abortReader() { this.reader?.abort(); this.reader = null }
  private scheduleReconcile() {
    this.clearPoll()
    if (!this.disposed && (this.state.unknown || this.state.messages.some(message => message.status === "streaming"))) {
      this.poll = setTimeout(() => { void this.reconcile() }, 1500)
    }
  }

  select = async (threadId: string | null) => {
    if (this.state.threadId === threadId) return
    this.generation += 1
    this.subscription?.abort()
    this.subscription = null
    this.abortReader()
    this.clearPoll()
    this.pendingUser = null
    this.activeAssistant = null
    this.update({ ...initial(), threadId, loading: !!threadId })
    if (threadId) await this.reconcile(true)
  }

  private applyDetail(detail: AgentChatThreadDetail) {
    const messages = detail.messages
    // A request with an uncertain response is not disproved by an early snapshot
    // that does not yet contain its original user-message identity.
    const pendingIndex = this.pendingUser ? messages.findIndex(message => message.id === this.pendingUser) : -1
    const matchingAssistant = this.activeAssistant && isUuid(this.activeAssistant)
      ? messages.find(message => message.id === this.activeAssistant)
      : pendingIndex >= 0 ? messages.slice(pendingIndex + 1).find(message => message.role === "assistant") : undefined
    const unresolved = this.pendingUser !== null && (!matchingAssistant || matchingAssistant.status === "streaming")
    const running = messages.some(message => message.role === "assistant" && message.status === "streaming")
    if (this.subscription && (running || unresolved)) {
      // A snapshot read may lag the live reader. Never replace streamed text or
      // tool deltas with an earlier still-running snapshot.
      this.update({ loading: false })
      return
    }
    if (this.subscription) this.subscription.abort()
    if (!unresolved) { this.pendingUser = null; this.activeAssistant = null }
    this.update({ messages: unresolved && !matchingAssistant ? this.state.messages : messages, unknown: unresolved, streaming: running, loading: false, error: null, ...(!running && !unresolved ? { stopping: false } : {}) })
  }

  reconcile = async (initialLoad = false) => {
    if (!this.state.threadId || this.reader || this.disposed) return
    const generation = this.generation
    const wasActive = this.state.streaming || this.state.unknown || this.state.messages.some(message => message.toolCalls?.some(call => call.status === "unknown" || call.status === "running"))
    const controller = new AbortController()
    this.reader = controller
    this.update({ reconciling: true, ...(initialLoad ? { loading: true } : {}) })
    try {
      const detail = await this.client.getAgentThread(this.workspaceId, this.state.threadId, { signal: controller.signal })
      if (this.disposed || generation !== this.generation || controller.signal.aborted) return
      this.applyDetail(detail)
      if (wasActive && !this.state.streaming && !this.state.unknown) this.onSettled()
    } catch (error) {
      if (!this.disposed && generation === this.generation && !controller.signal.aborted) this.update({ error, loading: false, unknown: !initialLoad || this.state.unknown })
    } finally {
      if (this.reader === controller) this.reader = null
      if (!this.disposed && generation === this.generation) { this.update({ reconciling: false }); this.scheduleReconcile() }
    }
  }

  send = async (threadId: string, content: string, model: string | null, reasoningEffort: AgentChatReasoningEffort = "auto") => {
    if (this.disposed || this.state.streaming || this.state.unknown || this.subscription) return
    const generation = this.generation
    const controller = new AbortController()
    const messageId = crypto.randomUUID()
    const placeholderId = `pending:${crypto.randomUUID()}`
    const now = new Date().toISOString()
    const user: AgentChatMessage = { id: messageId, threadId, role: "user", content, status: "complete", errorCode: null, model: null, createdAt: now, updatedAt: now }
    const assistant: AgentChatMessage = { ...user, id: placeholderId, role: "assistant", content: "", status: "streaming", model }
    this.clearPoll()
    this.abortReader()
    this.subscription = controller
    this.pendingUser = messageId
    this.activeAssistant = placeholderId
    this.update({ threadId, messages: [...this.state.messages, user, assistant], streaming: true, error: null, loading: false, stopping: false })
    let terminal = false
    try {
      for await (const event of this.client.streamAgentMessage(this.workspaceId, threadId, { messageId, content, reasoningEffort }, { signal: controller.signal })) {
        if (this.disposed || generation !== this.generation || controller.signal.aborted) return
        this.onEvent(event)
        if (event.type === "user") this.replace(event.message)
        else if (event.type === "assistant") { this.activeAssistant = event.message.id; this.replace(event.message, placeholderId) }
        else if (event.type === "delta") this.update({ messages: this.state.messages.map(message => message.id === event.messageId ? { ...message, content: message.content + event.delta } : message) })
        else if (event.type === "context") this.update({ messages: this.state.messages.map(message => message.id === event.messageId ? { ...message, contextSources: [...new Map([...(message.contextSources ?? []), ...event.sources].map(source => [`${source.kind}:${source.entityId}:${source.revision}`, source])).values()] } : message) })
        else if (event.type === "tool") this.update({ messages: this.state.messages.map(message => message.id === event.messageId ? { ...message, toolCalls: (message.toolCalls ?? []).some(call => call.id === event.toolCall.id) ? (message.toolCalls ?? []).map(call => call.id === event.toolCall.id ? event.toolCall : call) : [...(message.toolCalls ?? []), event.toolCall] } : message) })
        else if (event.type === "done" || event.type === "cancelled") {
          terminal = true
          this.abortReader()
          this.replace(event.message, placeholderId)
          this.pendingUser = null
          this.activeAssistant = null
          this.update({ streaming: false, unknown: false, stopping: false })
        } else if (event.type === "error") {
          this.update({ error: new Error(`${event.code}: ${event.message}`), unknown: true })
        }
      }
      if (!terminal) this.update({ unknown: true })
    } catch (error) {
      if (!this.disposed && generation === this.generation && !controller.signal.aborted) {
        // This validation response is issued before messages or model work exist.
        // Unlike a broken stream, there is no pending operation to reconcile.
        if (error instanceof Error && "status" in error && error.status === 400 && "code" in error && error.code === "agent_reasoning_unsupported") {
          terminal = true
          this.pendingUser = null
          this.activeAssistant = null
          this.update({ messages: this.state.messages.filter(message => message.id !== messageId && message.id !== placeholderId), error: null, unknown: false, streaming: false })
          throw error
        } else this.update({ error, unknown: true })
      }
    } finally {
      if (this.subscription === controller) this.subscription = null
      if (!this.disposed && generation === this.generation) {
        // Neither a network error nor cancel acknowledgement is a persisted
        // terminal message. Preserve the subscription on cancel failures and
        // reconcile the original message before allowing another send.
        this.update({ stopping: false })
        if (terminal) this.onSettled()
        if (!terminal) await this.reconcile()
      }
    }
  }

  stop = async () => {
    if (!this.state.threadId || this.state.stopping || (!this.state.streaming && !this.state.unknown)) return
    const generation = this.generation
    const messageId = this.activeAssistant ?? this.state.messages.findLast(message => message.role === "assistant" && message.status === "streaming")?.id ?? null
    this.update({ stopping: true })
    try {
      await this.client.cancelAgentThread(this.workspaceId, this.state.threadId, isUuid(messageId) ? { messageId } : {})
      if (this.disposed || generation !== this.generation) return
      // cancelled:true acknowledges a request, not a committed terminal result.
      // Keep a live SSE reader and confirm through the authoritative snapshot.
      await this.reconcile()
    } catch (error) {
      if (!this.disposed && generation === this.generation) this.update({ error })
    } finally {
      if (!this.disposed && generation === this.generation) this.update({ stopping: false })
    }
  }

  activate = () => {
    if (!this.disposed) return
    this.disposed = false
    this.update(initial())
  }

  dispose = () => {
    this.disposed = true
    this.generation += 1
    this.subscription?.abort()
    this.subscription = null
    this.abortReader()
    this.clearPoll()
    this.listeners.clear()
  }
}
