import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { chatOnlyExecutionSelection, executionEnvironmentSchema, executionSelectionSchema, type AgentWorkspace, type ExecutionSelection } from "../../../../packages/agent-contracts/src/execution.ts";
import { browseAgentDirectories, getAgentWorkspace, listAgentWorkspaces, openAgentWorkspace, resolveAgentWorkspaceExecution, updateAgentWorkspace } from "./agent-workspaces.ts";
import { DurableError } from "./durable/errors.ts";
import { closeStore, readRecord, writeRecord } from "./durable/store.ts";

let directory: string;
let allowed: string;
let repository: string;
const keys = ["AGENT_WORKSPACE_DATA_DIR", "AGENT_WORKSPACE_ALLOWED_ROOTS", "AGENT_WORKSPACE_PROJECT_ROOT", "HOME", "USERPROFILE", "PM_API_URL"] as const;
let previous: Record<string, string | undefined>;
let originalFetch: typeof fetch;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "agent-workspaces-"));
  allowed = path.join(directory, "allowed");
  repository = path.join(allowed, "repository");
  await mkdir(repository, { recursive: true });
  previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.AGENT_WORKSPACE_DATA_DIR = path.join(directory, "store");
  process.env.AGENT_WORKSPACE_ALLOWED_ROOTS = JSON.stringify([allowed]);
  process.env.PM_API_URL = "http://127.0.0.1:1";
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Ordinary Agent directories must never contact PM."); };
});

afterEach(async () => {
  closeStore();
  globalThis.fetch = originalFetch;
  for (const key of keys) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
  await rm(directory, { recursive: true, force: true });
});

function selection(workspace: AgentWorkspace): ExecutionSelection {
  return { version: 2, agentWorkspaceId: workspace.id, agentWorkspaceRevision: workspace.revision };
}

function rejectsCode(operation: () => unknown, code: string): void {
  assert.throws(operation, error => error instanceof DurableError && error.code === code);
}

test("v2 contracts require paired directory identity and never accept the retired multi-root shape", () => {
  assert.deepEqual(executionSelectionSchema.parse(chatOnlyExecutionSelection()), { version: 2, agentWorkspaceId: null, agentWorkspaceRevision: null });
  assert.equal(executionSelectionSchema.safeParse({ version: 2, agentWorkspaceId: "directory", agentWorkspaceRevision: null }).success, false);
  assert.equal(executionSelectionSchema.safeParse({ version: 1, codeWorkspaceId: null, codeWorkspaceRevision: null, rootIds: [], primaryRootId: null }).success, false);
  assert.equal(executionSelectionSchema.safeParse({ ...chatOnlyExecutionSelection(), rootIds: [] }).success, false);
  assert.equal(executionEnvironmentSchema.safeParse({ version: 2, hostId: "local", agentWorkspaceId: null, agentWorkspaceName: null, agentWorkspaceRevision: null, sourcePath: repository, executionPath: null, worktree: null, frozen: false }).success, false);
});

test("opening canonical aliases is durable and idempotent without any PM HTTP request", async () => {
  const alias = path.join(allowed, "alias");
  await symlink(repository, alias, "dir");
  const opened = openAgentWorkspace({ path: repository });
  assert.equal(opened.name, "repository");
  assert.equal(opened.status, "available");
  assert.deepEqual(openAgentWorkspace({ path: alias, name: "Do not rename an existing record" }), opened);
  assert.deepEqual(openAgentWorkspace({ path: path.join(repository, "..", "repository") }), opened);
  assert.equal(listAgentWorkspaces().length, 1);
  assert.equal(resolveAgentWorkspaceExecution(selection(opened)).path, repository);
  closeStore();
  assert.deepEqual(getAgentWorkspace(opened.id), opened);
  assert.equal("directoryIdentity" in getAgentWorkspace(opened.id)!, false);
});

test("metadata CAS rename/archive/reopen preserves Sessions, files and recorded execution revisions", async () => {
  const opened = openAgentWorkspace({ path: repository });
  await writeFile(path.join(repository, "keep.txt"), "source remains");
  writeRecord("chat:threads", "preserved-session", { id: "preserved-session", executionSelection: selection(opened) });
  const originalEnvironment = resolveAgentWorkspaceExecution(selection(opened)).environment;
  const renamed = updateAgentWorkspace(opened.id, { expectedRevision: opened.revision, name: "Renamed" });
  assert.equal(renamed.revision, 2);
  rejectsCode(() => updateAgentWorkspace(opened.id, { expectedRevision: 1, archived: true }), "workspace_revision_conflict");
  const archived = updateAgentWorkspace(opened.id, { expectedRevision: renamed.revision, archived: true });
  assert.ok(archived.archivedAt);
  assert.equal(listAgentWorkspaces()[0]!.id, opened.id);
  const archivedExecution = resolveAgentWorkspaceExecution(selection(opened));
  assert.equal(archivedExecution.path, originalEnvironment.executionPath);
  assert.equal(archivedExecution.environment.agentWorkspaceRevision, opened.revision);
  assert.equal(archivedExecution.environment.agentWorkspaceName, "Renamed");
  rejectsCode(() => resolveAgentWorkspaceExecution({ ...selection(opened), agentWorkspaceRevision: archived.revision + 1 }), "workspace_revision_conflict");
  const reopened = openAgentWorkspace({ path: repository });
  assert.equal(reopened.id, opened.id);
  assert.equal(reopened.archivedAt, null);
  assert.equal(reopened.revision, archived.revision + 1);
  assert.equal(openAgentWorkspace({ path: repository }).revision, reopened.revision);
  assert.equal(await readFile(path.join(repository, "keep.txt"), "utf8"), "source remains");
  assert.deepEqual(readRecord("chat:threads", "preserved-session"), { id: "preserved-session", executionSelection: selection(opened) });
});

test("missing, replaced and redirected registered directories fail closed instead of rebinding", async () => {
  const opened = openAgentWorkspace({ path: repository });
  const moved = path.join(allowed, "moved-original");
  await rename(repository, moved);
  rejectsCode(() => resolveAgentWorkspaceExecution(selection(opened)), "directory_unavailable");
  assert.equal(getAgentWorkspace(opened.id)!.status, "unavailable");
  await mkdir(repository);
  rejectsCode(() => resolveAgentWorkspaceExecution(selection(opened)), "workspace_directory_changed");
  rejectsCode(() => openAgentWorkspace({ path: repository }), "workspace_directory_changed");
  await rm(repository, { recursive: true });
  await symlink(moved, repository, "dir");
  rejectsCode(() => resolveAgentWorkspaceExecution(selection(opened)), "workspace_directory_changed");
  rejectsCode(() => openAgentWorkspace({ path: repository }), "workspace_directory_changed");
  assert.equal(listAgentWorkspaces().length, 1);
});

test("allowed-root policy is canonical and rechecked for previously registered execution", async () => {
  const outside = path.join(directory, "outside");
  await mkdir(outside);
  await symlink(outside, path.join(allowed, "escape"), "dir");
  rejectsCode(() => openAgentWorkspace({ path: outside }), "directory_not_allowed");
  rejectsCode(() => openAgentWorkspace({ path: path.join(allowed, "escape") }), "directory_not_allowed");
  rejectsCode(() => openAgentWorkspace({ path: "relative/path" }), "invalid_workspace_request");
  const missing = path.join(allowed, "missing");
  rejectsCode(() => openAgentWorkspace({ path: missing }), "directory_unavailable");
  await assert.rejects(stat(missing), { code: "ENOENT" });
  assert.equal(listAgentWorkspaces().length, 0);
  const opened = openAgentWorkspace({ path: repository });
  process.env.AGENT_WORKSPACE_ALLOWED_ROOTS = JSON.stringify([outside]);
  rejectsCode(() => resolveAgentWorkspaceExecution(selection(opened)), "directory_not_allowed");
  assert.equal(getAgentWorkspace(opened.id)!.status, "unavailable");
  process.env.AGENT_WORKSPACE_ALLOWED_ROOTS = "not-json";
  rejectsCode(() => browseAgentDirectories(), "workspace_roots_invalid");
});

test("explicit project-parent roots work outside Home without trusting a legacy project-root hint", async () => {
  const home = path.join(directory, "home");
  const outside = path.join(directory, "allowed-other");
  await mkdir(home);
  await mkdir(outside);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.AGENT_WORKSPACE_PROJECT_ROOT = allowed;
  delete process.env.AGENT_WORKSPACE_ALLOWED_ROOTS;
  assert.deepEqual(browseAgentDirectories().roots, [home]);
  rejectsCode(() => openAgentWorkspace({ path: repository }), "directory_not_allowed");
  process.env.AGENT_WORKSPACE_ALLOWED_ROOTS = JSON.stringify([home, allowed]);
  const opened = openAgentWorkspace({ path: repository });
  assert.equal(opened.status, "available");
  assert.equal(resolveAgentWorkspaceExecution(selection(opened)).path, repository);
  assert.equal(browseAgentDirectories(allowed).parentPath, null);
  rejectsCode(() => openAgentWorkspace({ path: outside }), "directory_not_allowed");
  const escape = path.join(allowed, "outside-link");
  await symlink(outside, escape, process.platform === "win32" ? "junction" : "dir");
  rejectsCode(() => openAgentWorkspace({ path: escape }), "directory_not_allowed");
  assert.equal(browseAgentDirectories(allowed).directories.some(entry => entry.name === "outside-link"), false);
});

test("server browsing returns only canonical allowed directories and never climbs above an allowed root", async () => {
  const outside = path.join(directory, "outside");
  await mkdir(outside);
  await mkdir(path.join(repository, "child"));
  await writeFile(path.join(allowed, "file.txt"), "not a directory");
  await symlink(outside, path.join(allowed, "escape"), "dir");
  await symlink(repository, path.join(allowed, "alias"), "dir");
  assert.deepEqual(browseAgentDirectories(), { path: null, parentPath: null, roots: [allowed], directories: [] });
  assert.deepEqual(browseAgentDirectories(allowed), { path: allowed, parentPath: null, roots: [allowed], directories: [{ name: "alias", path: repository }, { name: "repository", path: repository }] });
  assert.deepEqual(browseAgentDirectories(repository), { path: repository, parentPath: allowed, roots: [allowed], directories: [{ name: "child", path: path.join(repository, "child") }] });
  rejectsCode(() => browseAgentDirectories(directory), "directory_not_allowed");
});

test("chat-only scratch is private, stable per session and never exposed as a public code directory", async () => {
  rejectsCode(() => resolveAgentWorkspaceExecution(chatOnlyExecutionSelection()), "chat_session_required");
  const first = resolveAgentWorkspaceExecution(chatOnlyExecutionSelection(), "session/../one");
  const other = resolveAgentWorkspaceExecution(chatOnlyExecutionSelection(), "other-session");
  assert.notEqual(first.path, other.path);
  assert.equal(path.dirname(first.path), path.join(directory, "store", "chat-scratch"));
  assert.equal((await stat(first.path)).mode & 0o777, 0o700);
  assert.equal((await stat(path.dirname(first.path))).mode & 0o777, 0o700);
  assert.equal(first.environment.sourcePath, null);
  assert.equal(first.environment.executionPath, null);
  assert.equal(first.environment.agentWorkspaceId, null);
  assert.equal(executionEnvironmentSchema.safeParse(first.environment).success, true);
  closeStore();
  assert.deepEqual(resolveAgentWorkspaceExecution(chatOnlyExecutionSelection(), "session/../one"), first);
  assert.equal(listAgentWorkspaces().length, 0);
  await rename(first.path, `${first.path}-old`);
  await mkdir(first.path, { mode: 0o700 });
  rejectsCode(() => resolveAgentWorkspaceExecution(chatOnlyExecutionSelection(), "session/../one"), "chat_scratch_changed");
});

test("restored scratch metadata never follows a backup-source absolute path", async () => {
  const original = resolveAgentWorkspaceExecution(chatOnlyExecutionSelection(), "restored-session");
  const record = readRecord("agent:scratch:v1", "restored-session");
  await writeFile(path.join(original.path, "original.txt"), "must not follow");
  closeStore();
  process.env.AGENT_WORKSPACE_DATA_DIR = path.join(directory, "restored-store");
  writeRecord("agent:scratch:v1", "restored-session", record);
  rejectsCode(() => resolveAgentWorkspaceExecution(chatOnlyExecutionSelection(), "restored-session"), "chat_scratch_unavailable");
  assert.equal(await readFile(path.join(original.path, "original.txt"), "utf8"), "must not follow");
});
