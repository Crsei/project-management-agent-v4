import assert from "node:assert/strict";
import test from "node:test";
import type { AgentWorkspace, ExecutionSelection } from "@agent-workspace/contracts/chat";
import { agentWorkspaceSelectionIssue } from "./execution-selection-state.ts";

const workspace: AgentWorkspace = { id: "folder-a", name: "same-name", path: "/server/a/same-name", revision: 1, createdAt: "2026-11-07T00:00:00Z", updatedAt: "2026-11-07T00:00:00Z", archivedAt: null, status: "available" };
const selection: ExecutionSelection = { version: 2, agentWorkspaceId: workspace.id, agentWorkspaceRevision: workspace.revision };

test("rename, close and reopen metadata do not invalidate or rewrite an existing selection", () => {
  const original = structuredClone(selection);
  assert.equal(agentWorkspaceSelectionIssue(selection, { ...workspace, name: "renamed", revision: 2 }, false), null);
  assert.equal(agentWorkspaceSelectionIssue(selection, { ...workspace, archivedAt: "2026-11-07T01:00:00Z", revision: 3 }, false), null);
  assert.equal(agentWorkspaceSelectionIssue(selection, { ...workspace, revision: 4 }, false), null);
  assert.deepEqual(selection, original);
});

test("same display names never substitute another folder identity", () => {
  assert.equal(agentWorkspaceSelectionIssue(selection, { ...workspace, id: "folder-b", path: "/server/b/same-name" }, false), "unavailable");
  assert.equal(agentWorkspaceSelectionIssue(selection, undefined, false), "unavailable");
  assert.equal(agentWorkspaceSelectionIssue(selection, { ...workspace, status: "unavailable", reason: "directory_replaced" }, false), "unavailable");
});

test("future metadata revisions fail closed without silently refreshing the selection", () => {
  const future = { ...selection, agentWorkspaceRevision: 2 };
  assert.equal(agentWorkspaceSelectionIssue(future, workspace, false), "revision-unavailable");
  assert.equal(future.agentWorkspaceRevision, 2);
});

test("chat-only availability needs no PM catalog or directory record", () => {
  const chat: ExecutionSelection = { version: 2, agentWorkspaceId: null, agentWorkspaceRevision: null };
  assert.equal(agentWorkspaceSelectionIssue(chat, undefined, true), null);
  assert.equal(agentWorkspaceSelectionIssue(chat, undefined, false), "folder-required");
});
