import assert from "node:assert/strict"
import test from "node:test"
import type { AgentChatMessage, AgentChatStreamEvent, AgentChatThreadDetail } from "../../../../../../packages/contracts/src/agent-chat.ts"
import { AgentChatStore } from "./agent-chat-store.ts"

const threadId = "f9ad3a38-76e3-49a8-8563-03a284919e40"
const assistantId = "276d580a-89b5-47f9-900f-60dddb84b895"
const thread = { id: threadId, title: "Real request", createdAt: "2026-10-25T00:00:00Z", updatedAt: "2026-10-25T00:00:00Z", lastMessageAt: null, messageCount: 0 }
const assistant = (status: AgentChatMessage["status"]): AgentChatMessage => ({ id: assistantId, threadId, role: "assistant", content: "Partial answer", status, errorCode: null, model: "provider-model", createdAt: thread.createdAt, updatedAt: thread.updatedAt })
function deferred<T>() { return Promise.withResolvers<T>() }

test("a failed cancellation never aborts the live subscription or invents cancelled status", async () => {
  const waiting = deferred<AgentChatStreamEvent>()
  const started = deferred<void>()
  let signal: AbortSignal | undefined
  const store = new AgentChatStore({
    getAgentThread: async () => ({ thread, messages: [] }),
    cancelAgentThread: async () => { throw new Error("cancel response lost") },
    streamAgentMessage: async function* (_workspace, _thread, _input, options) {
      signal = options?.signal
      yield { type: "assistant", message: assistant("streaming") }
      started.resolve()
      yield await waiting.promise
    },
  }, "workspace")
  try {
    await store.select(threadId)
    const sending = store.send(threadId, "Read the project", "provider-model")
    await started.promise
    await store.stop()
    assert.equal(signal?.aborted, false)
    assert.equal(store.getSnapshot().streaming, true)
    assert.equal(store.getSnapshot().messages.at(-1)?.status, "streaming")
    assert.match(String(store.getSnapshot().error), /cancel response lost/)
    waiting.resolve({ type: "done", message: assistant("complete") })
    await sending
    assert.equal(store.getSnapshot().messages.at(-1)?.status, "complete")
  } finally { store.dispose() }
})

test("cancel acknowledgement alone does not become a persisted cancelled message", async () => {
  const waiting = deferred<AgentChatStreamEvent>()
  const started = deferred<void>()
  const store = new AgentChatStore({
    getAgentThread: async () => ({ thread, messages: [assistant("streaming")] }),
    cancelAgentThread: async () => ({ cancelled: true }),
    streamAgentMessage: async function* () {
      yield { type: "assistant", message: assistant("streaming") }
      started.resolve()
      yield await waiting.promise
    },
  }, "workspace")
  try {
    const sending = store.send(threadId, "Read the project", "provider-model")
    await started.promise
    await store.stop()
    assert.equal(store.getSnapshot().messages.at(-1)?.status, "streaming")
    waiting.resolve({ type: "cancelled", message: assistant("cancelled") })
    await sending
    assert.equal(store.getSnapshot().messages.at(-1)?.status, "cancelled")
  } finally { store.dispose() }
})

test("a broken stream reconciles the original message and blocks replacement sends while unknown", async () => {
  let calls = 0
  let user: AgentChatMessage | undefined
  let detail: AgentChatThreadDetail = { thread, messages: [] }
  const store = new AgentChatStore({
    getAgentThread: async () => detail,
    cancelAgentThread: async () => ({ cancelled: false }),
    streamAgentMessage: async function* (_workspace, _thread, input) {
      calls += 1
      user = { ...assistant("complete"), id: input.messageId, role: "user", content: input.content }
      yield { type: "user", message: user }
      yield { type: "assistant", message: assistant("streaming") }
      throw new Error("connection closed before terminal")
    },
  }, "workspace")
  try {
    await store.send(threadId, "Create one task", "provider-model")
    assert.equal(store.getSnapshot().unknown, true)
    assert.equal(store.getSnapshot().messages.at(-1)?.status, "streaming")
    await store.send(threadId, "Create one task", "provider-model")
    assert.equal(calls, 1)
    detail = { thread, messages: [user!, assistant("complete")] }
    await store.reconcile()
    assert.equal(store.getSnapshot().unknown, false)
    assert.equal(store.getSnapshot().messages.at(-1)?.status, "complete")
  } finally { store.dispose() }
})

test("refresh reads persisted generation without issuing another model request", async () => {
  let sends = 0
  let detail: AgentChatThreadDetail = { thread, messages: [assistant("streaming")] }
  const store = new AgentChatStore({
    getAgentThread: async () => detail,
    cancelAgentThread: async () => ({ cancelled: true }),
    streamAgentMessage: async function* () { sends += 1; yield { type: "done", message: assistant("complete") } },
  }, "workspace")
  try {
    await store.select(threadId)
    assert.equal(store.getSnapshot().streaming, true)
    detail = { thread, messages: [assistant("cancelled")] }
    await store.reconcile()
    assert.equal(store.getSnapshot().streaming, false)
    assert.equal(store.getSnapshot().messages.at(-1)?.status, "cancelled")
    assert.equal(sends, 0)
  } finally { store.dispose() }
})

test("late reads cannot expose a previous actor or thread after disposal", async () => {
  const pending = deferred<AgentChatThreadDetail>()
  const previous = new AgentChatStore({
    getAgentThread: async () => pending.promise,
    cancelAgentThread: async () => ({ cancelled: false }),
    streamAgentMessage: async function* () { yield { type: "done", message: assistant("complete") } },
  }, "old-workspace")
  const current = new AgentChatStore({
    getAgentThread: async () => ({ thread, messages: [] }),
    cancelAgentThread: async () => ({ cancelled: false }),
    streamAgentMessage: async function* () { yield { type: "done", message: assistant("complete") } },
  }, "new-workspace")
  try {
    const reading = previous.select(threadId)
    previous.dispose()
    pending.resolve({ thread, messages: [assistant("complete")] })
    await reading
    assert.deepEqual(previous.getSnapshot().messages, [])
    assert.deepEqual(current.getSnapshot().messages, [])
  } finally { previous.dispose(); current.dispose() }
})

test("tool and source events update the same message identity and survive persisted refresh", async () => {
  const source = { kind: "task" as const, workspaceId: "349f2522-85ea-4498-abda-a3b9db534cc3", projectId: "PRJ-001", entityId: "TASK-001", title: "Native task", revision: "r2", truncated: false }
  const running = {
    id: "provider-call-1", operationId: "386d0f82-8bff-480c-aa21-40d6bf6f5e12", name: "pm_create_task", arguments: { projectId: "PRJ-001", title: "Native task" },
    status: "running" as const, startedAt: thread.createdAt, finishedAt: null,
    grantId: "18300f07-0d16-4aa3-8ec2-0a071c74304b", onBehalfOf: "9bb780af-3eb4-4314-bd36-d173712e60bb", approvalPolicy: "auto_approve" as const,
    result: null, error: null,
  }
  const succeeded = {
    ...running, status: "succeeded" as const, finishedAt: thread.updatedAt,
    result: { kind: "task" as const, items: [{ id: "TASK-001", entity: "work_item" as const, projectId: "PRJ-001", title: "Native task", revision: "r2", version: 2, status: "todo" }], sources: [source], nextCursor: null, truncated: false },
  }
  const persisted = { ...assistant("complete"), toolCalls: [succeeded], contextSources: [source] }
  const store = new AgentChatStore({
    getAgentThread: async () => ({ thread, messages: [persisted] }),
    cancelAgentThread: async () => ({ cancelled: false }),
    streamAgentMessage: async function* () {
      yield { type: "assistant", message: assistant("streaming") }
      yield { type: "tool", messageId: assistantId, toolCall: running }
      yield { type: "context", messageId: assistantId, sources: [source] }
      yield { type: "context", messageId: assistantId, sources: [source] }
      yield { type: "tool", messageId: assistantId, toolCall: succeeded }
      yield { type: "done", message: persisted }
    },
  }, source.workspaceId)
  const observed: AgentChatMessage[] = []
  store.subscribe(() => {
    const message = store.getSnapshot().messages.at(-1)
    if (message) observed.push(message)
  })
  try {
    await store.send(threadId, "Create one task", "provider-model")
    const message = store.getSnapshot().messages.at(-1)!
    assert.equal(message.id, assistantId)
    assert.equal(message.toolCalls?.length, 1)
    assert.equal(message.toolCalls?.[0]?.status, "succeeded")
    assert.deepEqual(message.contextSources, [source])
    assert.ok(observed.some(item => item.status === "streaming" && item.toolCalls?.[0]?.status === "running"))
    assert.ok(observed.some(item => item.status === "streaming" && item.toolCalls?.[0]?.status === "succeeded"))
    assert.ok(observed.some(item => item.status === "streaming" && item.contextSources?.length === 1))
    assert.ok(observed.every(item => !item.contextSources || item.contextSources.length <= 1))
    await store.reconcile()
    assert.deepEqual(store.getSnapshot().messages.at(-1)?.toolCalls, [succeeded])
  } finally { store.dispose() }
})

test("a delayed cancellation snapshot cannot overwrite a terminal stream message", async () => {
  const reading = deferred<AgentChatThreadDetail>()
  const waiting = deferred<AgentChatStreamEvent>()
  const started = deferred<void>()
  let hasRead = false
  const store = new AgentChatStore({
    getAgentThread: async () => { hasRead = true; return reading.promise },
    cancelAgentThread: async () => ({ cancelled: true }),
    streamAgentMessage: async function* () {
      yield { type: "assistant", message: assistant("streaming") }
      started.resolve()
      yield await waiting.promise
    },
  }, "workspace")
  try {
    const sending = store.send(threadId, "Read the project", "provider-model")
    await started.promise
    const stopping = store.stop()
    await Promise.resolve()
    assert.equal(hasRead, true)
    waiting.resolve({ type: "cancelled", message: assistant("cancelled") })
    await sending
    reading.resolve({ thread, messages: [assistant("streaming")] })
    await stopping
    assert.equal(store.getSnapshot().messages.at(-1)?.status, "cancelled")
    assert.equal(store.getSnapshot().streaming, false)
  } finally { store.dispose() }
})

test("unsupported reasoning is a rejected send, not an unknown operation blocking the next message", async () => {
  let calls = 0
  const store = new AgentChatStore({
    getAgentThread: async () => ({ thread, messages: [] }),
    cancelAgentThread: async () => ({ cancelled: false }),
    streamAgentMessage: async function* () {
      calls += 1
      if (calls === 1) throw Object.assign(new Error("This model does not support that reasoning effort"), { status: 400, code: "agent_reasoning_unsupported" })
      yield { type: "done", message: assistant("complete") }
    },
  }, "workspace")
  try {
    await store.select(threadId)
    await assert.rejects(store.send(threadId, "Read the project", "provider-model", "high"), /reasoning effort/)
    assert.equal(store.getSnapshot().unknown, false)
    assert.equal(store.getSnapshot().streaming, false)
    assert.deepEqual(store.getSnapshot().messages, [])
    assert.equal(store.getSnapshot().error, null, "Rejected input must not become an unreadable-history error")
    await store.send(threadId, "Read the project", "provider-model", "auto")
    assert.equal(calls, 2)
    assert.equal(store.getSnapshot().messages.at(-1)?.status, "complete")
  } finally { store.dispose() }
})
