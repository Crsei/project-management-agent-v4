import assert from "node:assert/strict";
import test from "node:test";
import type { PmReferenceInput } from "@agent-workspace/contracts/pm-references";
import { capturePmReferences, clearPmReferences, consumePmReferences, getPmReferences, setPmReferences, subscribePmReferenceConsumption } from "./pm-chat-bridge.ts";

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

test("durable acceptance consumes only the sent selection and preserves later additions", () => {
  const other = { ...reference, id: "TASK-002", revision: "r2" };
  setPmReferences("accepted", [reference]);
  const snapshot = capturePmReferences("accepted");
  setPmReferences("accepted", [reference, other]);
  let consumed: readonly PmReferenceInput[] = [];
  const unsubscribe = subscribePmReferenceConsumption("accepted", values => { consumed = values; });
  consumePmReferences(snapshot);
  assert.deepEqual(getPmReferences("accepted"), [other]);
  assert.deepEqual(consumed, [reference]);
  consumePmReferences(snapshot);
  assert.deepEqual(getPmReferences("accepted"), [other]);
  unsubscribe();
  clearPmReferences("accepted");
});

test("late acceptance cannot remove an explicitly reselected or revised reference", () => {
  setPmReferences("reselected", [reference]);
  const snapshot = capturePmReferences("reselected");
  setPmReferences("reselected", []);
  setPmReferences("reselected", [reference]);
  consumePmReferences(snapshot);
  assert.deepEqual(getPmReferences("reselected"), [reference]);
  const beforeRevision = capturePmReferences("reselected");
  const revised = { ...reference, revision: "new-revision" };
  setPmReferences("reselected", [revised]);
  consumePmReferences(beforeRevision);
  assert.deepEqual(getPmReferences("reselected"), [revised]);
  clearPmReferences("reselected");
});

test("capture freezes outgoing references before asynchronous settings and isolates composers", () => {
  const input = { ...reference, revision: "original" };
  setPmReferences("frozen-a", [input]);
  const snapshot = capturePmReferences("frozen-a");
  input.revision = "mutated";
  setPmReferences("frozen-b", [{ ...reference, projectId: "PRJ-002" }]);
  assert.equal(snapshot.references[0]?.revision, "original");
  assert.equal(getPmReferences("frozen-a")[0]?.revision, "original");
  consumePmReferences(snapshot);
  assert.equal(getPmReferences("frozen-b")[0]?.projectId, "PRJ-002");
  clearPmReferences("frozen-a");
  clearPmReferences("frozen-b");
});
