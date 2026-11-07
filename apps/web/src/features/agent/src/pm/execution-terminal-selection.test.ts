import assert from "node:assert/strict";
import test from "node:test";
import { terminalBelongsToSessionView } from "./execution-terminal-selection.ts";

test("Workspace terminal remains visible across Session changes", () => {
  const workspace = { scope: "workspace" as const, threadId: null };
  assert.equal(terminalBelongsToSessionView(workspace, "session-a"), true);
  assert.equal(terminalBelongsToSessionView(workspace, "session-b"), true);
  assert.equal(terminalBelongsToSessionView(workspace), true);
});

test("Session A terminal detaches from Session B before any selection effect", () => {
  const terminals = [
    { id: "workspace-pty", scope: "workspace" as const, threadId: null },
    { id: "session-a-pty", scope: "session" as const, threadId: "session-a" },
    { id: "session-b-pty", scope: "session" as const, threadId: "session-b" },
  ];
  const inB = terminals.filter(terminal => terminalBelongsToSessionView(terminal, "session-b"));
  assert.deepEqual(inB.map(terminal => terminal.id), ["workspace-pty", "session-b-pty"]);
  assert.equal(inB.find(terminal => terminal.id === "session-a-pty"), undefined);
  assert.equal(terminalBelongsToSessionView(terminals[1]!), false);
  assert.deepEqual(terminals.map(terminal => terminal.threadId), [null, "session-a", "session-b"]);
});
