import assert from "node:assert/strict";
import test from "node:test";
import type { AgentWorkspace, ChatGenerationView, ExecutionEnvironment, RemoteThread, ThreadSidebar } from "@agent-workspace/contracts/chat";
import { isRunBoardAttentionColumn, isRunBoardFolderScopeValid, nextRunBoardKeyboardTarget, readRunBoardFolderScope, readRunBoardSelection, runBoardActivity, runBoardGenerationFacts, runBoardStopTargetMatches, runBoardTerminalWorkspace, updateRunBoardSelection, writeRunBoardFolderScope } from "./run-board-model.ts";
import { runBoardChatHref } from "./run-board-navigation.ts";

function thread(activity: unknown, running = false): RemoteThread {
  return { remoteId: "session", status: "regular", sidebar: { activity, running } } as RemoteThread;
}

test("all authoritative activity statuses have distinct safe board classifications", () => {
  const expected: [ThreadSidebar["activity"]["status"], string, boolean][] = [
    ["queued", "queued", true], ["running", "running", true],
    ["waiting_approval", "waiting", true], ["waiting_input", "waiting", true],
    ["failed", "attention", false], ["cancelled", "attention", false],
    ["interrupted", "attention", false], ["idle", "idle", false],
  ];
  for (const [status, column, active] of expected) {
    assert.deepEqual(runBoardActivity(thread({ status, generationId: "observed" }, !active)), {
      status, column, active, generationId: "observed",
    });
  }
});

test("missing or future activity never means idle and never trusts sidebar.running", () => {
  for (const activity of [undefined, null, {}, { status: "completed" }, { status: "future", generationId: "g" }]) {
    assert.deepEqual(runBoardActivity(thread(activity, true)), {
      status: "unknown", column: "unknown", active: false, generationId: null,
    });
  }
  assert.equal(runBoardActivity({ remoteId: "old" } as RemoteThread).status, "unknown");
  assert.equal(runBoardActivity(thread({ status: "running", generationId: " " })).generationId, null);
});

test("stop identity requires one regular session's exact observed active generation", () => {
  const current = thread({ status: "running", generationId: "generation" });
  assert.equal(runBoardStopTargetMatches(current, "session", "generation"), true);
  assert.equal(runBoardStopTargetMatches(current, "other-session", "generation"), false);
  assert.equal(runBoardStopTargetMatches(current, "session", "other-generation"), false);
  assert.equal(runBoardStopTargetMatches({ ...current, status: "archived" }, "session", "generation"), false);
  for (const status of ["idle", "failed", "cancelled", "interrupted", "future"]) {
    assert.equal(runBoardStopTargetMatches(thread({ status, generationId: "generation" }, true), "session", "generation"), false);
  }
  assert.equal(runBoardStopTargetMatches(thread({ status: "running" }), "session", ""), false);
  assert.equal(runBoardStopTargetMatches(thread({ status: "running", generationId: " " }), "session", " "), false);
});

test("Chat navigation round-trips exact selection and filters; closing only removes the drawer", () => {
  const original = new URLSearchParams({ view: "sessions", q: "plan & fixes", folder: "folder:registered-id", provider: "codex", attention: "1" });
  const selectedId = "folder/session?&=# 会话";
  const opened = updateRunBoardSelection(original, { selectedId });
  const filtered = updateRunBoardSelection(opened, { query: "new search", attention: false });
  const boardHref = `/agent/runs?${filtered}`;
  const chat = new URL(runBoardChatHref({ threadId: selectedId, agentWorkspaceId: "registered-id", returnTo: boardHref }), "https://same-origin.example");
  assert.equal(chat.searchParams.get("thread"), selectedId);
  assert.equal(chat.searchParams.get("agentWorkspaceId"), "registered-id");
  assert.equal(chat.searchParams.has("newSession"), false);
  assert.equal(chat.searchParams.get("runReturn"), boardHref);
  const returned = new URL(chat.searchParams.get("runReturn")!, "https://same-origin.example");
  assert.deepEqual(readRunBoardSelection(returned.searchParams), {
    query: "new search", folder: "folder:registered-id", provider: "codex", attention: false, selectedId,
  });
  const closed = updateRunBoardSelection(returned.searchParams, { selectedId: null });
  assert.deepEqual(readRunBoardSelection(closed), {
    query: "new search", folder: "folder:registered-id", provider: "codex", attention: false, selectedId: null,
  });
  assert.equal(readRunBoardSelection(original).selectedId, null);
});

test("direct unavailable or empty session identity is retained, never replaced by a filtered session", () => {
  for (const selectedId of ["missing-session", ""]) {
    const direct = new URLSearchParams({ view: "sessions", sessionId: selectedId, q: "another title" });
    assert.equal(readRunBoardSelection(direct).selectedId, selectedId);
    const changed = updateRunBoardSelection(direct, { provider: "another-provider" });
    assert.equal(readRunBoardSelection(changed).selectedId, selectedId);
    assert.equal(readRunBoardSelection(updateRunBoardSelection(changed, { selectedId: null })).selectedId, null);
  }
});

test("terminal readiness requires a current resolved execution identity, not matching folder names", () => {
  const workspace: AgentWorkspace = {
    id: "registered-id", name: "RunLedger", path: "/registered/code", revision: 3,
    status: "available", archivedAt: null, createdAt: "", updatedAt: "",
  };
  const session = {
    ...thread({ status: "idle" }),
    executionSelection: { version: 2 as const, agentWorkspaceId: workspace.id, agentWorkspaceRevision: 1 },
  };
  const environment: ExecutionEnvironment = {
    version: 2, hostId: "local", agentWorkspaceId: workspace.id, agentWorkspaceName: "Old display name",
    agentWorkspaceRevision: 1, sourcePath: workspace.path, executionPath: "/owned/worktree",
    worktree: { deliveryId: "delivery", branch: "branch" }, frozen: true,
  };
  assert.equal(runBoardTerminalWorkspace(session, [workspace], environment), workspace);
  assert.equal(runBoardTerminalWorkspace(session, [workspace], null), null);
  assert.equal(runBoardTerminalWorkspace(session, [{ ...workspace, status: "unavailable" }], environment), null);
  assert.equal(runBoardTerminalWorkspace(session, [{ ...workspace, id: "same-name-other-folder" }], environment), null);
  assert.equal(runBoardTerminalWorkspace(session, [workspace], { ...environment, agentWorkspaceId: "other" }), null);
  assert.equal(runBoardTerminalWorkspace(session, [workspace], { ...environment, agentWorkspaceRevision: 2 }), null);
  assert.equal(runBoardTerminalWorkspace(session, [{ ...workspace, path: "/different/code" }], environment), null);
  assert.equal(runBoardTerminalWorkspace(session, [workspace], { ...environment, executionPath: null }), null);
  assert.equal(runBoardTerminalWorkspace({ ...session, executionSelection: { version: 2, agentWorkspaceId: null, agentWorkspaceRevision: null } }, [workspace], environment), null);
});

test("idle without a generation is never-started only after history is read, never completed", () => {
  const idle = thread({ status: "idle" });
  assert.equal(runBoardGenerationFacts(idle, null).state, "unknown");
  const facts = runBoardGenerationFacts(idle, { latestGeneration: null });
  assert.equal(facts.state, "never-started");
  assert.equal(facts.generation, null);
  assert.equal(facts.generationId, null);
  assert.equal(runBoardGenerationFacts(thread({ status: "failed" }), { latestGeneration: null }).state, "unknown");
});

test("ended generation facts come from exact history, preserving completed, failed, cancelled and interrupted", () => {
  for (const status of ["completed", "failed", "cancelled", "interrupted"] as const) {
    const generation: ChatGenerationView = {
      id: "generation", threadId: "session", messageId: "assistant", status,
      createdAt: "2026-11-15T01:00:00Z", providerInstanceId: "codex", modelId: "gpt-6.1-sol",
      ...(status === "failed" ? { error: "actual provider error" } : {}),
    };
    const session = thread({ status: status === "completed" ? "idle" : status, generationId: generation.id });
    const facts = runBoardGenerationFacts(session, { latestGeneration: generation });
    assert.equal(facts.state, status);
    assert.equal(facts.generation, generation);
    assert.equal(facts.generationId, generation.id);
    assert.equal(facts.consistent, true);
    assert.equal(runBoardGenerationFacts(session, null).state, "unknown");
    assert.equal(runBoardGenerationFacts(session, { latestGeneration: { ...generation, id: "older-generation" } }).state, "unknown");
    assert.equal(runBoardGenerationFacts(session, { latestGeneration: { ...generation, threadId: "other-session" } }).state, "unknown");
    assert.equal(runBoardGenerationFacts(session, { latestGeneration: generation, activeGenerationId: generation.id }).state, "unknown");
  }
});

test("a new active generation cannot inherit the old generation's successful result or stop target", () => {
  const previous: ChatGenerationView = {
    id: "previous", threadId: "session", messageId: "assistant", status: "completed",
    createdAt: "2026-11-15T01:00:00Z", providerInstanceId: "codex", modelId: "gpt-6.1-sol",
  };
  const running = thread({ status: "running", generationId: "current" });
  const outOfSync = runBoardGenerationFacts(running, { latestGeneration: previous, activeGenerationId: "current" });
  assert.equal(outOfSync.state, "unknown");
  assert.equal(outOfSync.generation, null);
  assert.equal(outOfSync.consistent, false);
  const current = { ...previous, id: "current", status: "running" as const };
  const reconciled = runBoardGenerationFacts(running, { latestGeneration: current, activeGenerationId: "current" });
  assert.equal(reconciled.state, "running");
  assert.equal(reconciled.generation, current);
  assert.equal(reconciled.consistent, true);
});

test("remembered board scope is validated and survives storage failures as a preference only", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  const workspace = { id: "folder-a", archivedAt: null } as AgentWorkspace;
  assert.equal(readRunBoardFolderScope(storage), "");
  writeRunBoardFolderScope("folder:folder-a", storage);
  assert.equal(readRunBoardFolderScope(storage), "folder:folder-a");
  assert.equal(isRunBoardFolderScopeValid("folder:folder-a", [workspace]), true);
  assert.equal(isRunBoardFolderScopeValid("folder:folder-b", [workspace]), false);
  assert.equal(isRunBoardFolderScopeValid("folder:folder-a", [{ ...workspace, archivedAt: "2026-11-01" }]), false);
  assert.equal(isRunBoardFolderScopeValid("chat-only", []), true);
  assert.equal(isRunBoardFolderScopeValid("folder:", [workspace]), false);
  values.set("pm-v4:run-board-scope", "folder:bad path");
  assert.equal(readRunBoardFolderScope(storage), "");
  values.set("pm-v4:run-board-scope", "not-a-scope");
  assert.equal(readRunBoardFolderScope(storage), "");
  writeRunBoardFolderScope("", storage);
  assert.equal(values.has("pm-v4:run-board-scope"), false);
  const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => { throw new Error("denied"); } };
  assert.equal(readRunBoardFolderScope(broken), "");
  assert.doesNotThrow(() => writeRunBoardFolderScope("folder:folder-a", broken));
});

test("keyboard movement clamps inside a column and skips empty columns", () => {
  const columns = ["queued", "running", "waiting", "attention", "idle", "unknown"] as const;
  const rows = [
    { id: "r1", column: "running" as const },
    { id: "r2", column: "running" as const },
    { id: "w1", column: "waiting" as const },
    { id: "i1", column: "idle" as const },
    { id: "i2", column: "idle" as const },
  ];
  assert.equal(nextRunBoardKeyboardTarget(rows, columns, null, "j"), "r1");
  assert.equal(nextRunBoardKeyboardTarget(rows, columns, "missing", "j"), "r1");
  assert.equal(nextRunBoardKeyboardTarget(rows, columns, "r1", "j"), "r2");
  assert.equal(nextRunBoardKeyboardTarget(rows, columns, "r2", "j"), "r2");
  assert.equal(nextRunBoardKeyboardTarget(rows, columns, "r2", "k"), "r1");
  assert.equal(nextRunBoardKeyboardTarget(rows, columns, "r1", "l"), "w1");
  assert.equal(nextRunBoardKeyboardTarget(rows, columns, "w1", "l"), "i1");
  assert.equal(nextRunBoardKeyboardTarget(rows, columns, "i2", "l"), "i2");
  assert.equal(nextRunBoardKeyboardTarget(rows, columns, "i1", "h"), "w1");
  assert.equal(nextRunBoardKeyboardTarget(rows, columns, "w1", "h"), "r1");
  assert.equal(nextRunBoardKeyboardTarget(rows, columns, "r1", "h"), "r1");
  assert.equal(nextRunBoardKeyboardTarget([], columns, null, "j"), null);
  assert.equal(nextRunBoardKeyboardTarget([{ id: "u1", column: "unknown" }], columns, null, "l"), "u1");
});

test("attention columns include waiting, failure and unknown but never running or idle", () => {
  for (const [column, expected] of [["waiting", true], ["attention", true], ["unknown", true], ["queued", false], ["running", false], ["idle", false]] as const)
    assert.equal(isRunBoardAttentionColumn(column), expected);
});
