import assert from "node:assert/strict";
import test from "node:test";
import type { TerminalDescriptor } from "@agent-workspace/contracts/inspector";
import { acceptTerminalDescriptor, terminalCreationReadback, type PendingTerminalCreation } from "./terminal-creation-state.ts";

const request: PendingTerminalCreation = {
  requestId: "original-request", expectedServiceId: "service-a", scope: "session",
  agentWorkspaceId: "folder-a", agentWorkspaceRevision: 1, threadId: "session-a", relativePath: "src",
};
const terminal: TerminalDescriptor = {
  id: "original-pty", requestId: request.requestId, serviceId: request.expectedServiceId,
  scope: "session", agentWorkspaceId: request.agentWorkspaceId, agentWorkspaceRevision: request.agentWorkspaceRevision,
  threadId: request.threadId!,
  startCwd: "/owned/root/src", status: "running", createdAt: "2026-11-07T00:00:00Z", lastSeq: 0, exitCode: null, signal: null,
};

test("lost creation response reconciles the original request to the same PTY", () => {
  const snapshot = structuredClone(request);
  assert.deepEqual(terminalCreationReadback(request, { serviceId: "service-a", terminals: [terminal] }), { status: "found", terminal });
  assert.deepEqual(request, snapshot);
});

test("same-service not-found permits only original request reconciliation", () => {
  assert.deepEqual(terminalCreationReadback(request, { serviceId: "service-a", terminals: [{ ...terminal, requestId: "unrelated-request" }] }), { status: "not-found" });
  assert.equal(request.requestId, "original-request");
  assert.equal(request.expectedServiceId, "service-a");
});

test("service restart never treats absence as permission to replay creation", () => {
  assert.deepEqual(terminalCreationReadback(request, { serviceId: "service-b", terminals: [] }), { status: "service-changed" });
  assert.deepEqual(terminalCreationReadback(request, { serviceId: "service-b", terminals: [terminal] }), { status: "service-changed" });
});

test("a delayed running DELETE response cannot overwrite an observed terminal exit", () => {
  const exited: TerminalDescriptor = { ...terminal, status: "exited", exitCode: 143 };
  assert.equal(acceptTerminalDescriptor(exited, terminal), exited);
  assert.equal(acceptTerminalDescriptor(terminal, exited), exited);
  const separate = { ...terminal, id: "new-pty" };
  assert.equal(acceptTerminalDescriptor(exited, separate), separate);
});

test("readback cannot bind the original request to another directory or Session", () => {
  assert.deepEqual(terminalCreationReadback(request, { serviceId: "service-a", terminals: [{ ...terminal, agentWorkspaceId: "folder-b" }] }), { status: "not-found" });
  assert.deepEqual(terminalCreationReadback(request, { serviceId: "service-a", terminals: [{ ...terminal, threadId: "session-b" }] }), { status: "not-found" });
  assert.equal(request.agentWorkspaceId, "folder-a");
  assert.equal(request.threadId, "session-a");
});
