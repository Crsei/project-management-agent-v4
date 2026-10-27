import assert from "node:assert/strict"
import test from "node:test"
import type { AgentChatToolCall, AgentChatToolEntity } from "../../../../../../packages/contracts/src/agent-chat.ts"
import {
  formatToolValue,
  redactToolArguments,
  toolChanges,
  toolLabel,
  toolSummary,
  toolTarget,
} from "./agent-tool-presentation.ts"

const zh = (value: string): string => value
const en = (_zh: string, value: string): string => value

const entity: AgentChatToolEntity = {
  id: "TASK-009",
  projectId: "PRJ-001",
  entity: "work_item",
  title: "旧标题",
  revision: "rev-1",
  version: 2,
  status: "todo",
  body: "旧描述",
  fields: { priority: "high", assigneeId: "user-1", startDate: "2026-10-01", dueDate: "2026-10-10", labels: ["bug"] },
}

function call(overrides: Partial<AgentChatToolCall> & Pick<AgentChatToolCall, "name" | "arguments">): AgentChatToolCall {
  return {
    id: "call-1",
    operationId: "386d0f82-8bff-480c-aa21-40d6bf6f5e12",
    status: "succeeded",
    startedAt: "2026-10-27T00:00:00.000Z",
    finishedAt: "2026-10-27T00:00:00.120Z",
    grantId: "18300f07-0d16-4aa3-8ec2-0a071c74304b",
    onBehalfOf: "9bb780af-3eb4-4314-bd36-d173712e60bb",
    approvalPolicy: "auto_approve",
    result: null,
    error: null,
    ...overrides,
  }
}

const update = call({
  name: "pm_update_task",
  arguments: { id: "TASK-009", revision: "rev-1", title: "新标题", description: "新描述", assigneeId: null, priority: null, startDate: null, dueDate: null, labels: null },
  result: { kind: "task", items: [{ ...entity, title: "新标题" }], nextCursor: null, truncated: false, sources: [] },
})

test("field changes use the earlier real read for before values", () => {
  const changes = toolChanges(update, entity)
  assert.deepEqual(changes.map(change => change.field), ["title", "description"])
  const [title, description] = changes
  assert.equal(title.before, "旧标题")
  assert.equal(title.after, "新标题")
  assert.equal(title.knownBefore, true)
  assert.equal(title.verified, true)
  assert.equal(description.before, "旧描述")
  assert.equal(description.after, "新描述")
  assert.equal(description.knownBefore, true)
  assert.equal(description.verified, false)
})

test("a missing earlier read leaves before unknown instead of guessing", () => {
  const [title, description] = toolChanges(update)
  assert.equal(title.knownBefore, false)
  assert.equal(title.before, undefined)
  assert.equal(description.knownBefore, false)
})

test("a partial earlier body page is not used as the description before value", () => {
  const partial: AgentChatToolEntity = { ...entity, nextBodyOffset: 120 }
  const description = toolChanges(update, partial).find(change => change.field === "description")
  assert.equal(description?.knownBefore, false)
})

test("unchanged fields are omitted when the real prior value matches", () => {
  const unchanged = call({
    name: "pm_update_task",
    arguments: { id: "TASK-009", revision: "rev-1", title: "旧标题", description: null, assigneeId: null, priority: null, startDate: null, dueDate: null, labels: null },
    result: { kind: "task", items: [entity], nextCursor: null, truncated: false, sources: [] },
  })
  assert.deepEqual(toolChanges(unchanged, entity), [])
})

test("document saves only claim a before value from a complete earlier read", () => {
  const save = call({ name: "pm_save_document", arguments: { id: "DOC-1", revision: "rev-1", body: "新正文" } })
  const complete: AgentChatToolEntity = { ...entity, id: "DOC-1", entity: "document", body: "旧正文", bodyOffset: 0, nextBodyOffset: null }
  assert.equal(toolChanges(save, complete)[0]?.before, "旧正文")
  assert.equal(toolChanges(save, complete)[0]?.knownBefore, true)
  const partial: AgentChatToolEntity = { ...complete, nextBodyOffset: 120 }
  assert.equal(toolChanges(save, partial)[0]?.knownBefore, false)
  assert.equal(toolChanges(save)[0]?.knownBefore, false)
})

test("summaries name the changed fields", () => {
  assert.equal(toolSummary(update, toolChanges(update, entity), zh), "标题、描述已更新 · 2 个字段")
  assert.equal(toolSummary(update, toolChanges(update, entity), en), "Title, Description updated · 2 fields")
})

test("targets and labels distinguish read, update, create and search", () => {
  const read = call({ name: "pm_read", arguments: { id: "TASK-009", bodyOffset: 0, bodyLimit: 400 }, result: { kind: "task", items: [entity], nextCursor: null, truncated: false, sources: [] } })
  assert.deepEqual(toolTarget(read), { id: "TASK-009", title: "旧标题", object: "task" })
  assert.equal(toolLabel(read, toolTarget(read), zh), "读取任务")

  const target = toolTarget(update)
  assert.equal(target.id, "TASK-009")
  assert.equal(target.object, "task")
  assert.equal(toolLabel(update, target, zh), "更新任务")
  assert.equal(toolLabel(update, target, en), "Update task")

  const create = call({ name: "pm_create_task", arguments: { projectId: "PRJ-001", title: "新任务" } })
  assert.deepEqual(toolTarget(create), { id: null, title: "新任务", object: "task" })
  assert.equal(toolLabel(create, toolTarget(create), zh), "创建任务")

  const query = call({ name: "pm_query", arguments: { entity: null, projectId: null, query: "登录", after: null, limit: 20 } })
  assert.deepEqual(toolTarget(query), { id: "登录", title: null, object: "search" })
  assert.equal(toolLabel(query, toolTarget(query), zh), "搜索工作项")
  assert.equal(toolLabel(query, toolTarget(query), en), "Search work items")
})

test("technical arguments are redacted and bounded", () => {
  const redacted = redactToolArguments({ password: "secret", apiKey: "key", body: "a".repeat(200), id: "TASK-009" })
  assert.equal(redacted.password, "[redacted]")
  assert.equal(redacted.apiKey, "[redacted]")
  assert.equal(redacted.id, "TASK-009")
  assert.equal(String(redacted.body).length, 161)
  assert.match(String(redacted.body), /…$/)
})

test("value previews flatten markdown and keep a bounded length", () => {
  assert.equal(formatToolValue("第一行\n\n第二行", zh), "第一行 第二行")
  assert.equal(formatToolValue("", zh), "未设置")
  assert.equal(formatToolValue([], zh), "未设置")
  assert.equal(formatToolValue(["a", "b"], zh), "a, b")
})
