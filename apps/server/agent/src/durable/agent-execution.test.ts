import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, mock, test } from "node:test";
import { chatOnlyExecutionSelection, type ExecutionEnvironment, type ExecutionSelection } from "@agent-workspace/contracts/chat";
import { openAgentWorkspace, updateAgentWorkspace } from "../agent-workspaces.ts";
import { resolveAgentExecution, sameExecutionIdentity } from "./agent-execution.ts";
import { agentWorkspaceEnvironment, chatOnlyEnvironment } from "./execution.testkit.ts";
import { closeStore } from "./store.ts";

const originalDirectory = process.env.AGENT_WORKSPACE_DATA_DIR;
const originalAllowed = process.env.AGENT_WORKSPACE_ALLOWED_ROOTS;
let directory: string;
let networkCalls: number;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "agent-execution-"));
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
  process.env.AGENT_WORKSPACE_ALLOWED_ROOTS = JSON.stringify([directory]);
  networkCalls = 0;
  mock.method(globalThis, "fetch", async () => {
    networkCalls++;
    throw new Error("PM is unavailable; directory execution must remain local.");
  });
});

afterEach(async () => {
  mock.restoreAll();
  closeStore();
  if (originalDirectory === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR;
  else process.env.AGENT_WORKSPACE_DATA_DIR = originalDirectory;
  if (originalAllowed === undefined) delete process.env.AGENT_WORKSPACE_ALLOWED_ROOTS;
  else process.env.AGENT_WORKSPACE_ALLOWED_ROOTS = originalAllowed;
  await rm(directory, { recursive: true, force: true });
});

async function workspace(name: string) {
  const path = join(directory, name);
  await mkdir(path);
  const opened = openAgentWorkspace({ path, name });
  const selection: ExecutionSelection = { version: 2, agentWorkspaceId: opened.id, agentWorkspaceRevision: opened.revision };
  return { path, opened, selection };
}

test("execution identity requires complete evidence but ignores display metadata and freezing", () => {
  const environment = agentWorkspaceEnvironment("/source");
  assert.equal(sameExecutionIdentity(undefined, undefined), false);
  assert.equal(sameExecutionIdentity(environment, undefined), false);
  assert.equal(sameExecutionIdentity(undefined, environment), false);
  assert.equal(sameExecutionIdentity(environment, { ...environment, agentWorkspaceName: "Renamed", frozen: true }), true);
  assert.equal(sameExecutionIdentity(chatOnlyEnvironment(), chatOnlyEnvironment(true)), true);
  const changes: Partial<ExecutionEnvironment>[] = [
    { agentWorkspaceId: "another-workspace" },
    { agentWorkspaceRevision: 2 },
    { sourcePath: "/another-source" },
    { executionPath: "/another-execution" },
    { worktree: { deliveryId: "delivery", branch: "branch" } },
  ];
  for (const change of changes) assert.equal(sameExecutionIdentity(environment, { ...environment, ...change }), false);
  const worktree = { ...environment, executionPath: "/worktree", worktree: { deliveryId: "delivery", branch: "branch" } };
  assert.equal(sameExecutionIdentity(worktree, { ...worktree, frozen: true }), true);
  assert.equal(sameExecutionIdentity(worktree, { ...worktree, worktree: { deliveryId: "another-delivery", branch: "branch" } }), false);
  assert.equal(sameExecutionIdentity(worktree, { ...worktree, worktree: { deliveryId: "delivery", branch: "another-branch" } }), false);
});

test("independent directories resolve locally and retain their immutable identity across metadata changes", async () => {
  const one = await workspace("one");
  const two = await workspace("two");
  const first = await resolveAgentExecution(one.selection, "one-session");
  const second = await resolveAgentExecution(two.selection, "two-session");
  assert.equal(first.path, one.path);
  assert.equal(first.environment.executionPath, one.path);
  assert.equal(first.environment.sourcePath, one.path);
  assert.equal(first.environment.agentWorkspaceId, one.opened.id);
  assert.equal(first.environment.worktree, null);
  assert.equal(second.path, two.path);
  assert.equal(sameExecutionIdentity(first.environment, second.environment), false);
  const renamed = updateAgentWorkspace(one.opened.id, { expectedRevision: one.opened.revision, name: "Renamed" });
  updateAgentWorkspace(one.opened.id, { expectedRevision: renamed.revision, archived: true });
  const unchanged = await resolveAgentExecution(one.selection, "one-session");
  assert.equal(unchanged.path, first.path);
  assert.equal(unchanged.environment.agentWorkspaceName, "Renamed");
  assert.equal(sameExecutionIdentity(first.environment, unchanged.environment), true);
  await assert.rejects(resolveAgentExecution({ ...one.selection, agentWorkspaceRevision: 999 }, "one-session"), { code: "workspace_revision_conflict" });
  assert.equal(networkCalls, 0);
});

test("chat-only scratch is private, session-owned and absent from the public environment", async () => {
  const selection = chatOnlyExecutionSelection();
  await assert.rejects(resolveAgentExecution(selection), { code: "chat_session_required" });
  const first = await resolveAgentExecution(selection, "first");
  const second = await resolveAgentExecution(selection, "second");
  assert.notEqual(first.path, second.path);
  assert.deepEqual(first.environment, chatOnlyEnvironment());
  assert.equal((await stat(first.path)).mode & 0o077, 0);
  closeStore();
  assert.equal((await resolveAgentExecution(selection, "first")).path, first.path);
  await rm(first.path, { recursive: true });
  await assert.rejects(resolveAgentExecution(selection, "first"), { code: "chat_scratch_unavailable" });
  await assert.rejects(stat(first.path), { code: "ENOENT" });
  assert.equal(networkCalls, 0);
});

for (const replacement of [false, true]) {
  test(`a ${replacement ? "replaced" : "missing"} registered directory fails closed without creating or adopting a fallback`, async () => {
    const selected = await workspace("selected");
    await rename(selected.path, join(directory, "original-directory"));
    if (replacement) await mkdir(selected.path);
    await assert.rejects(resolveAgentExecution(selected.selection, "session"), {
      code: replacement ? "workspace_directory_changed" : "directory_unavailable",
    });
    if (!replacement) await assert.rejects(stat(selected.path), { code: "ENOENT" });
    assert.equal(networkCalls, 0);
  });
}

test("caller cancellation is checked before and after local directory resolution", async () => {
  const selected = await workspace("selected");
  const before = new AbortController();
  before.abort(new Error("cancelled before resolution"));
  await assert.rejects(resolveAgentExecution(selected.selection, "session", before.signal), /cancelled before resolution/);
  const after = new AbortController();
  const resolving = resolveAgentExecution(selected.selection, "session", after.signal);
  after.abort(new Error("cancelled during resolution"));
  await assert.rejects(resolving, /cancelled during resolution/);
  assert.equal(networkCalls, 0);
});
