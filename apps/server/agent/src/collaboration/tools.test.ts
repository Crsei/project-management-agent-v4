import assert from "node:assert/strict";
import { test } from "node:test";
import { collaborationOriginalCallId, collaborationToolInputSchema, isCollaborationTool } from "./tools.ts";

test("collaboration tools preserve original native names and expose no model-owned parent authority", () => {
  const input = { agentId: "reviewer-agent", agentVersion: 2, goal: "Review the actual changes", input: "Review this fixed input." };
  assert.deepEqual(collaborationToolInputSchema.parse(input), input);
  for (const field of ["runId", "parentRunId", "generationId", "actorId", "target", "executionSelection", "headers"])
    assert.equal(collaborationToolInputSchema.safeParse({ ...input, [field]: "model-supplied-authority" }).success, false);
  assert.equal(isCollaborationTool("delegate_task"), true);
  assert.equal(isCollaborationTool("ask_agent"), true);
  assert.equal(isCollaborationTool("pm_delegate_task"), false);
  assert.equal(isCollaborationTool("pm_ask_agent"), false);
});

test("durable original call identity is generation and transport scoped, not a fresh per-request UUID", () => {
  const input = { generationId: "parent-generation", transportId: "native-mcp-transport", requestId: 12 };
  const first = collaborationOriginalCallId(input);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(collaborationOriginalCallId({ ...input }), first);
  assert.notEqual(collaborationOriginalCallId({ ...input, requestId: "12" }), first);
  assert.notEqual(collaborationOriginalCallId({ ...input, transportId: "another-transport" }), first);
  assert.notEqual(collaborationOriginalCallId({ ...input, generationId: "another-generation" }), first);
});
