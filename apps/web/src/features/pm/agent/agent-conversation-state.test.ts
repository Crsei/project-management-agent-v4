import assert from "node:assert/strict"
import test from "node:test"
import { agentConversationParams, nextAgentConversation, type AgentConversationLocation } from "./agent-conversation-state.ts"

const taskEntry: AgentConversationLocation = { threadId: null, projectId: "PRJ-001", taskId: "TASK-001", returnTo: "/pm/workspace/issues?inspect=TASK-001", newChat: true }

test("creating the task-origin conversation preserves its target and return path", () => {
  const created = nextAgentConversation(taskEntry, { type: "created", threadId: "thread-a" })
  assert.equal(created.taskId, "TASK-001")
  assert.equal(created.projectId, "PRJ-001")
  assert.equal(created.returnTo, taskEntry.returnTo)
  assert.equal(created.newChat, false)
  assert.deepEqual(Object.fromEntries(agentConversationParams(created)), { thread: "thread-a", project: "PRJ-001", task: "TASK-001", returnTo: taskEntry.returnTo })
})

test("switching history clears another conversation's task without resetting the current one", () => {
  const current = nextAgentConversation(taskEntry, { type: "created", threadId: "thread-a" })
  assert.equal(nextAgentConversation(current, { type: "history", threadId: "thread-a" }), current)
  const history = nextAgentConversation(current, { type: "history", threadId: "thread-b" })
  assert.equal(history.taskId, null)
  assert.equal(history.threadId, "thread-b")
  assert.equal(agentConversationParams(history).has("task"), false)
})

test("a new conversation clears the old target and remains explicitly new after expansion", () => {
  const current = nextAgentConversation(taskEntry, { type: "created", threadId: "thread-a" })
  const fresh = nextAgentConversation(current, { type: "new" })
  assert.equal(fresh.taskId, null)
  assert.equal(fresh.threadId, null)
  assert.equal(fresh.newChat, true)
  const query = agentConversationParams(fresh)
  assert.equal(query.get("new"), "1")
  assert.equal(query.has("thread"), false)
  assert.equal(query.has("task"), false)
})

test("choosing or clearing a task never selects an unrelated previous thread", () => {
  const blank = { ...taskEntry, taskId: null, projectId: null, newChat: false }
  const selected = nextAgentConversation(blank, { type: "task", taskId: "TASK-002" })
  assert.equal(selected.threadId, null)
  assert.equal(selected.newChat, true)
  const cleared = nextAgentConversation(selected, { type: "task", taskId: null })
  assert.equal(cleared.taskId, null)
  assert.equal(agentConversationParams(cleared).get("new"), "1")
})
