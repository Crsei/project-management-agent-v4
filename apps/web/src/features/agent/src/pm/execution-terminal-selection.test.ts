import assert from "node:assert/strict";
import test from "node:test";
import type { AgentWorkspace, ExecutionEnvironment, ExecutionSelection } from "@agent-workspace/contracts/chat";
import type { TerminalDescriptor } from "@agent-workspace/contracts/inspector";
import { sessionTerminalMatches, sessionTerminalTarget, terminalBelongsToSessionView, verifiedSessionTerminalTarget } from "./execution-terminal-selection.ts";

test("Workspace terminal remains visible across Session changes", () => {
  const workspace = { ...sessionTerminal, scope: "workspace" as const, threadId: null };
  assert.equal(terminalBelongsToSessionView(workspace, { threadId: "session-a", agentWorkspaceId: "folder-a", agentWorkspaceRevision: 2 }), true);
  assert.equal(terminalBelongsToSessionView(workspace, { threadId: "session-b", agentWorkspaceId: "folder-b", agentWorkspaceRevision: 1 }), true);
  assert.equal(terminalBelongsToSessionView(workspace, null), true);
});

test("Session A terminal detaches from Session B before any selection effect", () => {
  const terminals = [
    { ...sessionTerminal, id: "workspace-pty", scope: "workspace" as const, threadId: null },
    { ...sessionTerminal, id: "session-a-pty", threadId: "session-a" },
    { ...sessionTerminal, id: "session-b-pty", threadId: "session-b" },
  ];
  const inB = terminals.filter(terminal => terminalBelongsToSessionView(terminal, { threadId: "session-b", agentWorkspaceId: workspace.id, agentWorkspaceRevision: 2 }));
  assert.deepEqual(inB.map(terminal => terminal.id), ["workspace-pty", "session-b-pty"]);
  assert.equal(inB.find(terminal => terminal.id === "session-a-pty"), undefined);
  assert.equal(terminalBelongsToSessionView(terminals[1]!, null), false);
  assert.deepEqual(terminals.map(terminal => terminal.threadId), [null, "session-a", "session-b"]);
});

const workspace: AgentWorkspace = { id: "folder-a", name: "Folder A", path: "/registered/a", revision: 3, archivedAt: null, status: "available", createdAt: "2026-11-01", updatedAt: "2026-11-01" };
const selection: ExecutionSelection = { version: 2, agentWorkspaceId: workspace.id, agentWorkspaceRevision: 2 };
const environment: ExecutionEnvironment = {
  version: 2, hostId: "local", agentWorkspaceId: workspace.id, agentWorkspaceName: workspace.name, agentWorkspaceRevision: 2,
  sourcePath: workspace.path, executionPath: "/registered/a/worktree", worktree: { deliveryId: "delivery-a", branch: "owned-branch" }, frozen: true,
};
const sessionTerminal: TerminalDescriptor = {
  id: "session-a-pty", requestId: "original-request", serviceId: "service-a", scope: "session", threadId: "session-a",
  agentWorkspaceId: workspace.id, agentWorkspaceRevision: 2, startCwd: environment.executionPath!,
  status: "running", createdAt: "2026-11-01", lastSeq: 0, exitCode: null, signal: null,
};

test("board terminal opens only the exact resolved Session PTY, never the selected Workspace PTY", () => {
  const target = verifiedSessionTerminalTarget("session-a", selection, environment, workspace, workspace.id);
  assert.deepEqual(target, { threadId: "session-a", agentWorkspaceId: workspace.id, agentWorkspaceRevision: 2 });
  if (!target) throw new Error("Expected verified target");
  const candidates = [
    { ...sessionTerminal, id: "old-workspace-pty", scope: "workspace" as const, threadId: null },
    { ...sessionTerminal, id: "old-session-pty", threadId: "other-session" },
    { ...sessionTerminal, id: "old-folder-pty", agentWorkspaceId: "other-folder" },
    { ...sessionTerminal, id: "old-revision-pty", agentWorkspaceRevision: 1 },
    sessionTerminal,
  ];
  assert.deepEqual(candidates.filter(terminal => sessionTerminalMatches(terminal, target)).map(terminal => terminal.id), ["session-a-pty"]);
});

test("terminal target refuses stale, unavailable and mismatched execution identities", () => {
  assert.equal(verifiedSessionTerminalTarget("session-a", selection, environment, workspace, "other-folder"), null);
  assert.equal(verifiedSessionTerminalTarget("session-a", selection, environment, { ...workspace, status: "unavailable" }), null);
  assert.equal(verifiedSessionTerminalTarget("session-a", selection, environment, { ...workspace, revision: 1 }), null);
  assert.equal(verifiedSessionTerminalTarget("session-a", selection, { ...environment, agentWorkspaceId: "other-folder" }, workspace), null);
  assert.equal(verifiedSessionTerminalTarget("session-a", selection, { ...environment, agentWorkspaceRevision: 1 }, workspace), null);
  assert.equal(verifiedSessionTerminalTarget("session-a", selection, undefined, workspace), null);
  assert.equal(verifiedSessionTerminalTarget("session-a", undefined, environment, workspace), null);
  assert.equal(sessionTerminalTarget("session-a", { ...environment, executionPath: null }), null);
  assert.equal(sessionTerminalTarget("session-a", { ...environment, agentWorkspaceId: null, agentWorkspaceRevision: null, executionPath: null }), null);
});

test("exited Session PTYs keep their exact identity rather than being replaced or treated as provider success", () => {
  const target = sessionTerminalTarget("session-a", environment);
  if (!target) throw new Error("Expected verified Session environment");
  assert.equal(sessionTerminalMatches({ ...sessionTerminal, status: "exited", exitCode: 1 }, target), true);
  assert.equal(sessionTerminalMatches({ ...sessionTerminal, status: "exited", exitCode: 0, threadId: "other-session" }, target), false);
});

test("a resolved source from another folder cannot borrow an otherwise matching Session id", () => {
  assert.equal(verifiedSessionTerminalTarget("session-a", selection, { ...environment, sourcePath: "/registered/other" }, workspace), null);
});

test("closing an available folder still opens only its existing bound Session terminal", () => {
  const closed = { ...workspace, archivedAt: "2026-11-02" };
  const target = verifiedSessionTerminalTarget("session-a", selection, environment, closed, closed.id);
  assert.ok(target, "Metadata-only folder closure must not detach an existing bound Session");
  const candidates = [sessionTerminal, { ...sessionTerminal, id: "other-folder-pty", agentWorkspaceId: "folder-b" }];
  assert.deepEqual(candidates.filter(terminal => sessionTerminalMatches(terminal, target)).map(terminal => terminal.id), ["session-a-pty"]);
  assert.equal(verifiedSessionTerminalTarget("session-a", selection, environment, { ...closed, status: "unavailable" }, closed.id), null);
});

test("an empty Session rebound to B detaches A and reveals an explicitly created B terminal", () => {
  const targetA = sessionTerminalTarget("session-a", { ...environment, frozen: false });
  const environmentB: ExecutionEnvironment = { ...environment, frozen: false, agentWorkspaceId: "folder-b", agentWorkspaceRevision: 4, sourcePath: "/registered/b", executionPath: "/registered/b" };
  const targetB = sessionTerminalTarget("session-a", environmentB);
  assert.ok(targetA);
  assert.ok(targetB);
  const inB: TerminalDescriptor = { ...sessionTerminal, id: "explicit-b-pty", requestId: "explicit-b-request", agentWorkspaceId: targetB.agentWorkspaceId, agentWorkspaceRevision: targetB.agentWorkspaceRevision, startCwd: environmentB.executionPath! };
  const catalog = [sessionTerminal, inB];
  assert.deepEqual(catalog.filter(terminal => terminalBelongsToSessionView(terminal, targetA, targetA)).map(terminal => terminal.id), ["session-a-pty"]);
  // A stale explicit-open filter cannot hide B, even before the invalidation effect.
  assert.deepEqual(catalog.filter(terminal => terminalBelongsToSessionView(terminal, targetB, targetA)).map(terminal => terminal.id), ["explicit-b-pty"]);
  assert.deepEqual(catalog.filter(terminal => terminalBelongsToSessionView(terminal, targetB, targetB)).map(terminal => terminal.id), ["explicit-b-pty"]);
  assert.equal(terminalBelongsToSessionView(sessionTerminal, null, targetA), false);
  assert.equal(sessionTerminal.agentWorkspaceId, "folder-a");
  assert.equal(inB.id, "explicit-b-pty");
});
