import assert from "node:assert/strict";
import test from "node:test";
import type { PmToolCallRecord } from "@agent-workspace/contracts/pm-tools";
import { pmToolChanges } from "./pm-tool-changes.ts";

const base: PmToolCallRecord = {
  operationId: "operation-1", name: "pm_update_task", status: "succeeded",
  threadId: "thread-1", messageId: "message-1", generationId: "generation-1", workspaceId: "workspace-1",
  createdAt: "2026-10-29T00:00:00Z", finishedAt: "2026-10-29T00:00:01Z", error: null,
  result: {
    kind: "task", nextCursor: null, truncated: false, sources: [],
    items: [{ id: "TASK-001", projectId: "PRJ-001", entity: "work_item", title: "Updated task", revision: "revision-2", version: 2, status: null }],
    receipt: { kind: "core", operationId: "operation-1", commandId: "command-1", action: "update", targetId: "TASK-001", revision: "revision-2" },
  },
};

test("sidebar uses persisted write results and never projects reads as changes", () => {
  const [change] = pmToolChanges([base, { ...base, operationId: "read-1", name: "pm_read" }]);
  assert.equal(change.id, "operation-1");
  assert.equal(change.state, "applied");
  assert.equal(change.targetId, "TASK-001");
  assert.equal(change.targetTitle, "Updated task");
  assert.equal(change.commandId, "command-1");
  assert.equal(pmToolChanges([{ ...base, name: "pm_read" }]).length, 0);
});

test("unknown and failed writes retain their actual state without invented targets", () => {
  const changes = pmToolChanges([
    { ...base, operationId: "unknown", status: "unknown", result: null, finishedAt: null },
    { ...base, operationId: "failed", status: "failed", result: null, error: { code: "revision_conflict", message: "Conflict" } },
  ]);
  assert.deepEqual(changes.map(change => change.state), ["unknown", "failed"]);
  assert.equal(changes[0].targetId, null);
  assert.equal(changes[1].error?.code, "revision_conflict");
});

