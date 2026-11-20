import assert from "node:assert/strict";
import test from "node:test";
import {
  automationBinding,
  automationPageHref,
  automationStatusTone,
  executionsForThread,
} from "./thread-automations-model.ts";

const executions = [
  { id: "e1", definitionId: "d1", status: "completed", threadId: "pm-automation:e1" },
  { id: "e2", definitionId: "d1", status: "failed", threadId: "pm-automation:e1" },
  { id: "e3", definitionId: "d2", status: "running", threadId: "pm-automation:e2" },
  { id: "e1", definitionId: "d1", status: "completed", threadId: "pm-automation:e1" },
  { id: "e4", definitionId: "d2", status: "queued", threadId: null },
];

test("binds only string automation ids from thread custom", () => {
  assert.deepEqual(automationBinding({ automationExecutionId: "exec", automationDefinitionId: "def" }), {
    executionId: "exec",
    definitionId: "def",
  });
  assert.deepEqual(automationBinding({ automationExecutionId: 1, automationDefinitionId: "  " }), {});
  assert.deepEqual(automationBinding(undefined), {});
});

test("filters executions to the exact thread and drops duplicates", () => {
  assert.deepEqual(
    executionsForThread(executions, "pm-automation:e1").map(item => item.id),
    ["e1", "e2"],
  );
  assert.deepEqual(executionsForThread(executions, "other"), []);
  assert.deepEqual(executionsForThread(executions, ""), []);
});

test("automation links carry workspace, project, run and returnTo into existing routes", () => {
  assert.equal(
    automationPageHref({
      workspaceId: "ws 1",
      projectId: "PRJ-1",
      definitionId: "def/1",
      executionId: "run 1",
      returnTo: "/agent/workspace?thread=a&x=1",
    }),
    "/agent/automations/history?workspace=ws+1&project=PRJ-1&run=run+1&returnTo=%2Fagent%2Fworkspace%3Fthread%3Da%26x%3D1",
  );
  assert.equal(
    automationPageHref({ workspaceId: "ws", definitionId: "def/1" }),
    "/agent/automations/detail/def%2F1?workspace=ws",
  );
  assert.equal(automationPageHref({ workspaceId: "ws" }), "/agent/automations?workspace=ws");
});

test("execution status maps to a presentation tone", () => {
  assert.equal(automationStatusTone("failed"), "error");
  assert.equal(automationStatusTone("outcome_unknown"), "error");
  assert.equal(automationStatusTone("running"), "active");
  assert.equal(automationStatusTone("queued"), "active");
  assert.equal(automationStatusTone("cancelled"), "muted");
  assert.equal(automationStatusTone("completed"), "default");
});
