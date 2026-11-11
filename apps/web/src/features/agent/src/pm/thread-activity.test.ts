import assert from "node:assert/strict";
import test from "node:test";
import { threadActivityPresentation, type ThreadActivity } from "./thread-activity.ts";

const english = (_zh: string, en: string) => en;

test("sidebar and details share distinct authoritative activity labels and priorities", () => {
  const expected: [ThreadActivity["status"], string, number, boolean][] = [
    ["idle", "Idle", 0, false],
    ["queued", "Queued", 2, true],
    ["running", "Running", 2, true],
    ["waiting_approval", "Awaiting approval", 3, true],
    ["waiting_input", "Awaiting input", 3, true],
    ["failed", "Failed", 1, false],
    ["cancelled", "Cancelled", 1, false],
    ["interrupted", "Interrupted", 1, false],
  ];
  for (const [status, label, priority, active] of expected) {
    const presentation = threadActivityPresentation({ status, generationId: "generation" }, english);
    assert.deepEqual([presentation.status, presentation.label, presentation.priority, presentation.active], [status, label, priority, active]);
  }
  assert.equal(threadActivityPresentation(undefined, english).status, "idle");
});

test("waiting outranks execution; terminal activity never retains a waiting or running presentation", () => {
  const approval = threadActivityPresentation({ status: "waiting_approval" }, english);
  const input = threadActivityPresentation({ status: "waiting_input" }, english);
  const running = threadActivityPresentation({ status: "running" }, english);
  assert.ok(approval.priority > running.priority);
  assert.ok(input.priority > running.priority);
  assert.equal(approval.tone, "warning");
  for (const status of ["failed", "cancelled", "interrupted", "idle"] as const) {
    const closed = threadActivityPresentation({ status }, english);
    assert.equal(closed.active, false);
    assert.notEqual(closed.tone, "active");
    assert.notEqual(closed.tone, "warning");
    assert.notEqual(closed.label, input.label);
  }
});

test("activity localization changes presentation only, never title or execution environment", () => {
  const thread = { title: "User-owned title", executionEnvironment: { agentWorkspaceName: "Folder named Running", executionPath: "/allowed/source" }, sidebar: { activity: { status: "waiting_input" as const, generationId: "g" } } };
  const original = structuredClone(thread);
  assert.equal(threadActivityPresentation(thread.sidebar.activity, english).label, "Awaiting input");
  assert.equal(threadActivityPresentation(thread.sidebar.activity, zh => zh).label, "等待回答");
  assert.deepEqual(thread, original);
});
