import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { AgentChatToolReceipt } from "@agent-workspace/contracts/pm-tool-result";
import type { PmChangeSet } from "@agent-workspace/contracts/pm-changes";
import type { PmToolCallRecord } from "@agent-workspace/contracts/pm-tools";
// The workspace resolves this package's "development" condition for typechecking but its
// built dist for `node --test`; test the schema source so an unbuilt artifact cannot mask a regression.
import { pmToolCallRecordSchema } from "../../../../packages/agent-contracts/src/pm-tools.ts";
import { projectPmToolChange, pmToolRoutes } from "./pm-tools.ts";
import { closeStore, writeRecord } from "./durable/store.ts";
import { ensureThread } from "./durable/threads.ts";

const workspaceId = randomUUID();
const threadId = "changes-thread";
const createdAt = "2026-10-01T10:00:00.000Z";
const finishedAt = "2026-10-01T10:00:05.000Z";

const taskItem = {
  id: "TASK-1", projectId: "PRJ-1", entity: "work_item" as const, title: "Ship the change view",
  revision: "rev-7", version: 4, status: "todo",
};
const taskSource = {
  kind: "task" as const, workspaceId, projectId: "PRJ-1", entityId: "TASK-1",
  title: "Ship the change view", revision: "rev-7", truncated: false,
};
const fileArea = { path: null, status: "unconfigured" as const, revision: 0, source: null, canManage: false };

function receipt(operationId: string, action: string, targetId: string | null): AgentChatToolReceipt {
  return { kind: "command", operationId, commandId: `command-${operationId}`, action, targetId, revision: "rev-7" };
}

function callRecord(name: string, status: PmToolCallRecord["status"], extra: Partial<PmToolCallRecord> = {}): PmToolCallRecord {
  return {
    operationId: randomUUID(), name, status, result: null, error: null,
    threadId, messageId: "message-1", generationId: "generation-1", workspaceId,
    createdAt, finishedAt: status === "succeeded" || status === "failed" ? finishedAt : null,
    ...extra,
  };
}

function taskResult(operationId: string): PmToolCallRecord["result"] {
  return {
    kind: "task", items: [taskItem], nextCursor: null, truncated: false,
    sources: [taskSource], receipt: receipt(operationId, "UpdateTask", "TASK-1"),
  };
}

test("running, failed and unknown calls never claim an applied change", () => {
  const runningArguments = { projectId: "PRJ-1", title: "New task" };
  const running = callRecord("pm_create_task", "running");
  const runningChange = projectPmToolChange(running, runningArguments);
  assert.deepEqual(runningChange, {
    id: running.operationId, kind: "create", state: "running", targetId: null, targetTitle: null, projectId: null,
    summary: "创建任务 · New task", receiptId: null, commandId: null, error: null, createdAt,
  });
  assert.ok(runningChange && !("fields" in runningChange));
  assert.ok(runningChange && !("updatedAt" in runningChange));

  const failed = callRecord("pm_update_task", "failed", { error: { code: "revision_conflict", message: "Stale revision" } });
  const failedChange = projectPmToolChange(failed);
  assert.ok(failedChange);
  assert.equal(failedChange.state, "failed");
  assert.equal(failedChange.kind, "update");
  assert.equal(failedChange.targetId, null);
  assert.deepEqual(failedChange.error, { code: "revision_conflict", message: "Stale revision" });
  assert.equal(failedChange.updatedAt, finishedAt);
  assert.equal("fields" in failedChange, false);

  const unknown = callRecord("pm_save_document", "unknown", { error: { code: "outcome_unknown", message: "Interrupted" } });
  const unknownChange = projectPmToolChange(unknown);
  assert.ok(unknownChange);
  assert.equal(unknownChange.state, "unknown");
  assert.equal("updatedAt" in unknownChange, false);
});

test("succeeded create and update calls project identity and receipt without fabricated fields", () => {
  const createOperation = randomUUID();
  const createChange = projectPmToolChange(callRecord("pm_create_task", "succeeded", { operationId: createOperation, result: taskResult(createOperation) }));
  assert.ok(createChange);
  assert.equal(createChange.kind, "create");
  assert.equal(createChange.state, "applied");
  assert.equal(createChange.targetId, "TASK-1");
  assert.equal(createChange.targetTitle, "Ship the change view");
  assert.equal(createChange.projectId, "PRJ-1");
  assert.equal(createChange.receiptId, createOperation);
  assert.equal(createChange.commandId, `command-${createOperation}`);
  assert.equal("fields" in createChange, false);
  // A result source revision has no slot in the change contract and must not be smuggled in.
  assert.equal(JSON.stringify(createChange).includes("rev-7"), false);

  const updateOperation = randomUUID();
  const updateChange = projectPmToolChange(callRecord("pm_update_task", "succeeded", { operationId: updateOperation, result: taskResult(updateOperation) }));
  assert.ok(updateChange);
  assert.equal(updateChange.kind, "update");
  assert.equal(updateChange.state, "applied");
  assert.equal(updateChange.targetId, "TASK-1");
  assert.equal(updateChange.summary, "更新任务 · TASK-1");
  assert.equal(updateChange.updatedAt, finishedAt);
});

test("comment and relation calls map to their kinds without inventing titles", () => {
  const commentOperation = randomUUID();
  const commentChange = projectPmToolChange(callRecord("pm_create_comment", "succeeded", {
    operationId: commentOperation,
    result: {
      kind: "comment",
      items: [{ id: "COMMENT-1", taskId: "TASK-1", projectId: "PRJ-1", content: "Looks good", version: 1, deletedAt: null }],
      nextCursor: null, truncated: false, sources: [taskSource],
      receipt: receipt(commentOperation, "CreateTaskComment", "COMMENT-1"),
    },
  }));
  assert.ok(commentChange);
  assert.equal(commentChange.kind, "comment");
  assert.equal(commentChange.state, "applied");
  assert.equal(commentChange.targetId, "COMMENT-1");
  assert.equal(commentChange.projectId, "PRJ-1");
  assert.equal(commentChange.targetTitle, null);

  const relationOperation = randomUUID();
  const relationChange = projectPmToolChange(callRecord("pm_add_relation", "succeeded", {
    operationId: relationOperation,
    result: {
      kind: "relation",
      items: [{ sourceId: "TASK-1", targetId: "TASK-2", relation: "blocks", sourceRevision: "rev-7", targetRevision: "rev-8" }],
      nextCursor: null, truncated: false, sources: [taskSource],
      receipt: receipt(relationOperation, "AddRelation", null),
    },
  }));
  assert.ok(relationChange);
  assert.equal(relationChange.kind, "relation");
  assert.equal(relationChange.targetId, "TASK-1");
  assert.equal(relationChange.targetTitle, null);
  assert.equal(relationChange.projectId, null);
  assert.equal(relationChange.summary, "添加关系 · TASK-1");
  assert.equal("fields" in relationChange, false);

  assert.equal(projectPmToolChange(callRecord("pm_read", "succeeded")), null);
});

test("only producer-supplied fields are exposed and empty item lists fall back to grounded sources", () => {
  const operationId = randomUUID();
  const supplied: PmChangeSet = {
    id: operationId, kind: "update", state: "applied", targetId: "TASK-1", targetTitle: "Ship the change view",
    projectId: "PRJ-1", summary: "Update task", createdAt,
    fields: [{ field: "title", label: "Title", before: "Old", after: "Ship the change view" }],
  };
  const withFields = projectPmToolChange(callRecord("pm_update_task", "succeeded", { operationId, result: taskResult(operationId), changeSet: supplied }));
  assert.deepEqual(withFields?.fields, supplied.fields);

  const sourcedChange = projectPmToolChange(callRecord("pm_update_task", "succeeded", {
    result: { kind: "task", items: [], nextCursor: null, truncated: false, sources: [taskSource] },
  }));
  assert.ok(sourcedChange);
  assert.equal(sourcedChange.targetId, "TASK-1");
  assert.equal(sourcedChange.targetTitle, "Ship the change view");
  assert.equal("fields" in sourcedChange, false);
});

test("the record contract keeps older records valid and rejects malformed change details", () => {
  const legacy = callRecord("pm_update_task", "succeeded", { result: taskResult(randomUUID()) });
  const parsedLegacy = pmToolCallRecordSchema.parse(legacy);
  assert.equal(parsedLegacy.arguments, undefined);
  assert.equal(parsedLegacy.changeSet, undefined);

  const changeSet: PmChangeSet = {
    id: legacy.operationId, kind: "update", state: "applied", targetId: "TASK-1", targetTitle: null,
    projectId: "PRJ-1", summary: "更新任务 · TASK-1", createdAt,
  };
  const parsed = pmToolCallRecordSchema.parse({ ...legacy, arguments: { id: "TASK-1" }, changeSet });
  assert.deepEqual(parsed.arguments, { id: "TASK-1" });
  assert.deepEqual(parsed.changeSet, changeSet);
  assert.throws(() => pmToolCallRecordSchema.parse({ ...legacy, changeSet: { ...changeSet, revision: "rev-7" } }));
});

test("thread endpoints expose bounded arguments and isolated change sets", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pm-tool-changes-"));
  const previousData = process.env.AGENT_WORKSPACE_DATA_DIR;
  const previousFetch = globalThis.fetch;
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
  const thread = "changes-route-thread", other = "changes-route-other";
  const scope = { workspaceId, projectId: null };
  const headers = { cookie: "pm_v4_session=fixture" };
  try {
    ensureThread(thread, "Changes", scope);
    ensureThread(other, "Other", scope);
    globalThis.fetch = (async (input: string | URL | Request) =>
      new URL(input instanceof Request ? input.url : String(input)).pathname === "/api/v1/agent-contexts"
        ? Response.json({ workspaces: [{ id: workspaceId, name: "Workspace", fileArea, projects: [] }] })
        : new Response("{}", { status: 404 })) as typeof fetch;

    const operationId = randomUUID();
    const argumentsValue = { projectId: "PRJ-1", title: "Route task" };
    writeRecord("pm-tool-calls", operationId, {
      record: callRecord("pm_create_task", "running", { operationId, threadId: thread }),
      request: { operationId, name: "pm_create_task", arguments: argumentsValue, scope: { kind: "workspace", projectIds: [] }, threadId: thread, messageId: "m", generationId: "g" },
    });
    const bulkyId = randomUUID();
    writeRecord("pm-tool-calls", bulkyId, {
      record: callRecord("pm_save_document", "failed", { operationId: bulkyId, threadId: thread, error: { code: "rejected", message: "No" } }),
      request: { operationId: bulkyId, name: "pm_save_document", arguments: { body: "x".repeat(20_000) }, scope: { kind: "workspace", projectIds: [] }, threadId: thread, messageId: "m", generationId: "g" },
    });
    const foreignId = randomUUID();
    writeRecord("pm-tool-calls", foreignId, {
      record: callRecord("pm_update_task", "succeeded", { operationId: foreignId, threadId: other, result: taskResult(foreignId) }),
      request: { operationId: foreignId, name: "pm_update_task", arguments: { id: "TASK-1" }, scope: { kind: "workspace", projectIds: [] }, threadId: other, messageId: "m", generationId: "g" },
    });

    const calls = await pmToolRoutes.request(`http://localhost/pm-tools/threads/${thread}/calls`, { headers });
    assert.equal(calls.status, 200);
    const callsBody = await calls.json() as { items: Array<Record<string, unknown>> };
    assert.equal(callsBody.items.length, 2);
    assert.deepEqual(callsBody.items[0].arguments, argumentsValue);
    assert.equal(Object.hasOwn(callsBody.items[1], "arguments"), false);

    const changes = await pmToolRoutes.request(`http://localhost/pm-tools/threads/${thread}/changes`, { headers });
    assert.equal(changes.status, 200);
    const body = await changes.json() as { items: PmChangeSet[] };
    assert.deepEqual(body.items.map((item) => [item.id, item.kind, item.state, item.summary]), [
      [operationId, "create", "running", "创建任务 · Route task"],
      [bulkyId, "update", "failed", "保存文档"],
    ]);
    assert.equal(body.items.every((item) => !("fields" in item)), true);

    const foreign = await pmToolRoutes.request(`http://localhost/pm-tools/threads/${other}/changes`, { headers });
    const foreignBody = await foreign.json() as { items: PmChangeSet[] };
    assert.deepEqual(foreignBody.items.map((item) => item.id), [foreignId]);

    assert.equal((await pmToolRoutes.request("http://localhost/pm-tools/threads/absent/changes", { headers })).status, 404);
    assert.equal((await pmToolRoutes.request("http://localhost/pm-tools/threads/absent/calls", { headers })).status, 404);

    globalThis.fetch = (async () => Response.json({ workspaces: [] })) as typeof fetch;
    assert.equal((await pmToolRoutes.request(`http://localhost/pm-tools/threads/${thread}/changes`, { headers })).status, 403);
    assert.equal((await pmToolRoutes.request(`http://localhost/pm-tools/threads/${thread}/calls`, { headers })).status, 403);
  } finally {
    globalThis.fetch = previousFetch;
    closeStore();
    if (previousData === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR;
    else process.env.AGENT_WORKSPACE_DATA_DIR = previousData;
    await rm(directory, { recursive: true, force: true });
  }
});
