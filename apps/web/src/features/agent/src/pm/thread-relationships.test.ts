import assert from "node:assert/strict";
import test from "node:test";
import { buildThreadRelationships } from "./thread-relationships.ts";

test("builds parent and direct forks from custom.parentThreadId only", () => {
  const result = buildThreadRelationships("child", [
    { id: "root", title: "Root session" },
    { id: "child", title: "Child session", parentThreadId: "root" },
    { id: "grandchild", title: "Grandchild", parentThreadId: "child" },
    { id: "unrelated", title: "Unrelated" },
  ]);
  assert.deepEqual(result.parent, { id: "root", relation: "parent", title: "Root session" });
  assert.deepEqual(result.children, [{ id: "grandchild", relation: "fork", title: "Grandchild" }]);
});

test("a referenced parent outside the loaded list stays openable by id", () => {
  const result = buildThreadRelationships("child", [
    { id: "child", title: "Child", parentThreadId: "missing-parent" },
  ]);
  assert.deepEqual(result.parent, { id: "missing-parent", relation: "parent", missing: true });
  assert.deepEqual(result.children, []);
});

test("self references and duplicates never invent lineage", () => {
  const result = buildThreadRelationships("self", [
    { id: "self", title: "Self", parentThreadId: "self" },
    { id: "fork", title: "Fork", parentThreadId: "self" },
    { id: "fork", title: "Duplicate", parentThreadId: "self" },
  ]);
  assert.equal(result.parent, undefined);
  assert.deepEqual(result.children, [{ id: "fork", relation: "fork", title: "Fork" }]);
});

test("blank titles fall back to the caller's id rendering", () => {
  const result = buildThreadRelationships("child", [
    { id: "root", title: "   " },
    { id: "child", title: "Child", parentThreadId: "root" },
    { id: "fork", title: " ", parentThreadId: "child" },
  ]);
  assert.deepEqual(result.parent, { id: "root", relation: "parent" });
  assert.deepEqual(result.children, [{ id: "fork", relation: "fork" }]);
});

test("an empty thread id has no relationships", () => {
  assert.deepEqual(buildThreadRelationships("", [{ id: "a", parentThreadId: "" }]), { children: [] });
});
