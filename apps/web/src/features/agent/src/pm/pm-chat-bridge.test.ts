import assert from "node:assert/strict";
import test from "node:test";
import type { PmReferenceInput } from "@agent-workspace/contracts/pm-references";
import { clearPmReferences, getPmReferences, setPmReferences } from "./pm-chat-bridge.ts";

const reference: PmReferenceInput = { workspaceId: "11111111-1111-4111-8111-111111111111", projectId: "PRJ-001", kind: "issue", id: "TASK-001", revision: null };

test("one message retains independent targets even when entity IDs collide", () => {
  const other = { ...reference, workspaceId: "22222222-2222-4222-8222-222222222222", projectId: "PRJ-002" };
  setPmReferences("session-a", [reference, other]);
  assert.deepEqual(getPmReferences("session-a"), [reference, other]);
  assert.deepEqual(getPmReferences("session-b"), []);
  clearPmReferences("session-a");
});

test("a detached composer cannot clear or send another Session's references", () => {
  setPmReferences("session-a", [reference]);
  setPmReferences("session-b", [{ ...reference, projectId: "PRJ-002" }]);
  clearPmReferences("session-a");
  assert.deepEqual(getPmReferences("session-a"), []);
  assert.equal(getPmReferences("session-b")[0]?.projectId, "PRJ-002");
  clearPmReferences("session-b");
  assert.deepEqual(getPmReferences("session-b"), []);
});
