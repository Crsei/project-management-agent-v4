import assert from "node:assert/strict";
import test from "node:test";
import type { CollaborationRun, RunResultReference } from "@agent-workspace/contracts/collaboration";
import { definitionAssignedToProject, frozenRunDefinition, issueWorkThreadHref, runCancellationTarget, runMatchesFilters, runOutputReferences, runTerminalWorkspaceId, selectedRunOutputReference } from "./model.ts";

test("cancellation preserves exact observed revision and generation and never treats unknown as idle", () => {
  const run = { status: "running" as const, revision: 7, generationId: "original-generation", cancellation: null };
  assert.deepEqual(runCancellationTarget(run), { revision: 7, generationId: "original-generation" });
  assert.deepEqual(runCancellationTarget({ ...run, status: "queued", generationId: null }), { revision: 7, generationId: null });
  assert.deepEqual(runCancellationTarget({ ...run, status: "waiting" }), { revision: 7, generationId: "original-generation" });
  for (const status of ["succeeded", "failed", "cancelled", "interrupted", "unknown"] as const) assert.equal(runCancellationTarget({ ...run, status }), null);
  assert.equal(runCancellationTarget({ ...run, cancellation: { requestedAt: "2026-11-15T00:00:00Z", requestedBy: "actor", observedAt: null } }), null);
});

test("copied empty project assignments are unassigned, never unrestricted authority", () => {
  assert.equal(definitionAssignedToProject({ state: "active", config: { allowedProjectIds: [] } }, "PRJ-001"), false);
  assert.equal(definitionAssignedToProject({ state: "active", config: { allowedProjectIds: ["PRJ-001"] } }, "PRJ-001"), true);
  assert.equal(definitionAssignedToProject({ state: "disabled", config: { allowedProjectIds: ["PRJ-001"] } }, "PRJ-001"), false);
  assert.equal(definitionAssignedToProject({ state: "archived", config: { allowedProjectIds: ["PRJ-001"] } }, "PRJ-001"), false);
  assert.equal(definitionAssignedToProject({ state: "active", config: { allowedProjectIds: ["PRJ-001"] } }, "PRJ-002"), false);
});

test("definition choice freezes explicit immutable versions without provider fallback", () => {
  assert.deepEqual(frozenRunDefinition("agent", "developer", 3), { kind: "agent", agentId: "developer", agentVersion: 3 });
  assert.deepEqual(frozenRunDefinition("team", "review-team", 5), { kind: "team", teamId: "review-team", teamVersion: 5 });
});

test("work discussion links target the original PM Issue and its same comment section", () => {
  assert.equal(issueWorkThreadHref({ workspaceId: "workspace", projectId: "PRJ-001", taskId: "TASK-002" }), "/pm/workspace/projects/PRJ-001/entities/TASK-002#task-discussion-TASK-002");
});

test("business filters use actual Team identity, immutable Agent names and actual task IDs", () => {
  const run = { id: "root", goal: "Review implementation", status: "waiting", target: { taskId: "TASK-002" }, definition: { kind: "team", teamId: "team", teamVersion: 2 }, agentVersions: [{ config: { name: "Developer" } }], teamVersion: { config: { name: "Review crew" } } } as CollaborationRun;
  assert.equal(runMatchesFilters(run, { query: "developer", status: "waiting", definitionId: "team" }), true);
  assert.equal(runMatchesFilters(run, { query: "TASK-002", status: "", definitionId: "" }), true);
  assert.equal(runMatchesFilters(run, { query: "", status: "succeeded", definitionId: "team" }), false);
  assert.equal(runMatchesFilters(run, { query: "", status: "waiting", definitionId: "not-team" }), false);
});

test("original Session terminals require the verified Run directory and matching registered selection", () => {
  const run = {
    threadId: "original-thread",
    directoryIdentity: { path: "/actual/run-folder", device: "12", inode: "34" },
    executionSelection: { version: 2 as const, agentWorkspaceId: "registered-folder", agentWorkspaceRevision: 4 },
    executionEnvironment: {
      version: 2 as const, hostId: "local" as const, agentWorkspaceId: "registered-folder", agentWorkspaceName: "Run folder",
      agentWorkspaceRevision: 4, sourcePath: "/actual/run-folder", executionPath: "/actual/run-folder", worktree: null, frozen: true,
    },
  };
  assert.equal(runTerminalWorkspaceId(run), "registered-folder");
  assert.equal(runTerminalWorkspaceId({ ...run, threadId: null }), null);
  assert.equal(runTerminalWorkspaceId({ ...run, directoryIdentity: null }), null);
  assert.equal(runTerminalWorkspaceId({ ...run, executionEnvironment: null }), null);
  assert.equal(runTerminalWorkspaceId({ ...run, executionSelection: { version: 2, agentWorkspaceId: null, agentWorkspaceRevision: null } }), null);
  assert.equal(runTerminalWorkspaceId({ ...run, executionEnvironment: { ...run.executionEnvironment, agentWorkspaceId: "previously-open-folder" } }), null);
  assert.equal(runTerminalWorkspaceId({ ...run, executionEnvironment: { ...run.executionEnvironment, agentWorkspaceRevision: 5 } }), null);
  assert.equal(runTerminalWorkspaceId({ ...run, executionEnvironment: { ...run.executionEnvironment, executionPath: "/other-folder" } }), null);
  assert.equal(runTerminalWorkspaceId({ ...run, directoryIdentity: { ...run.directoryIdentity, inode: "" } }), null);
});

test("latest own generation stays the default while original parent and child output identities remain selectable", () => {
  const result = (generationId: string, threadId: string): RunResultReference => ({
    generationId, threadId, messageId: null, outputItemIds: [], summary: null, summarySource: null,
  });
  const old = result("old-generation", "original-thread");
  const current = result("current-generation", "original-thread");
  const child = result("child-generation", "child-thread");
  const references = runOutputReferences({ generationId: current.generationId, threadId: current.threadId, resultRefs: [old, current, child] });
  assert.deepEqual(references, [
    { generationId: current.generationId, threadId: current.threadId }, old, child,
  ]);
  assert.deepEqual(selectedRunOutputReference(references, ""), { generationId: current.generationId, threadId: current.threadId });
  assert.equal(selectedRunOutputReference(references, old.generationId), old);
  assert.equal(selectedRunOutputReference(references, child.generationId), child);
  assert.equal(selectedRunOutputReference(references, "removed-original-generation"), undefined);
  assert.equal(selectedRunOutputReference([], ""), undefined);
  assert.deepEqual(runOutputReferences({ generationId: "executing-generation", threadId: "original-thread", resultRefs: [old] }), [
    { generationId: "executing-generation", threadId: "original-thread" }, old,
  ]);
  assert.deepEqual(runOutputReferences({ generationId: null, threadId: null, resultRefs: [child] }), [child]);
});
